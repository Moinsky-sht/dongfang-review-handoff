/** Durable document jobs. The ledger owns scheduling; typed outboxes own results. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath, readFile, readdir, open, rename, link, unlink } from 'node:fs/promises';
import { resolve, join, parse, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadSessionSnapshot, saveSessionSnapshot } from './session-store.js';
import { loadWorkingVersion } from './working-version.js';

const defaults = {storageRoot: process.env.DSH_JOB_ROOT || fileURLToPath(new URL('../data/review-jobs/', import.meta.url)),
  sessionRoot: process.env.DSH_SESSION_ROOT || fileURLToPath(new URL('../data/sessions/', import.meta.url)),
  workspaceRoot: process.env.DSH_WORKSPACE_ROOT || fileURLToPath(new URL('../data/workspaces/', import.meta.url)),
  versionRoot: process.env.DSH_WORKING_VERSION_ROOT || fileURLToPath(new URL('../data/working-versions/', import.meta.url))};
const digest = (value) => createHash('sha256').update(value).digest('hex');
const executeFile = promisify(execFile);
const pending = new Map(); const finishedTickets = new Set();
const terminalStatuses = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const statuses = new Set(['queued', 'running', 'publishing', ...terminalStatuses]);
const validUuid = (value) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value || '');
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const rootsOf = (args = {}) => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, resolve(args[key] || args.roots?.[key] || value)]));
function fail(code, message, status = 500, cause) { return Object.assign(new Error(message, cause ? {cause} : undefined), {code, status}); }
function assertJobId(id) { if (!/^r[a-f0-9]{64}$/.test(id || '')) throw fail('JOB_ID_INVALID', '审阅任务身份无效', 400); }
function assertBatchId(id) { if (!/^q[a-f0-9]{64}$/.test(id || '')) throw fail('JOB_BATCH_ID_INVALID', '批量任务身份无效', 400); }
function idOf(args) { const id = args.jobId || args.jobRunId; assertJobId(id); return id; }
function json(value) {
  const visit = (item, ancestors = new Set()) => {
    if (item === null || ['string', 'boolean'].includes(typeof item) || typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || ancestors.has(item) || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw fail('JOB_NOT_JSON', '任务配置必须是普通 JSON 数据', 400);
    ancestors.add(item);
    try {
      const out = Array.isArray(item) ? [] : {};
      if (Array.isArray(item)) {
        const keys = Reflect.ownKeys(item);
        if (keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)))
          throw fail('JOB_NOT_JSON', '任务配置数组不能附带对象字段', 400);
        for (let index = 0; index < item.length; index++) if (!Object.hasOwn(item, index)) throw fail('JOB_NOT_JSON', '任务配置数组不能含空位', 400);
      }
      for (const key of Reflect.ownKeys(item)) {
        if (Array.isArray(item) && key === 'length') continue;
        const entry = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== 'string' || !entry.enumerable || !Object.hasOwn(entry, 'value')) throw fail('JOB_NOT_JSON', '任务配置包含访问器或隐藏字段', 400);
        Object.defineProperty(out, key, {value: visit(entry.value, ancestors), enumerable: true, configurable: true, writable: true});
      }
      if (Array.isArray(item) && out.length !== item.length) throw fail('JOB_NOT_JSON', '任务配置数组不能含空位', 400);
      return out;
    } finally { ancestors.delete(item); }
  };
  return visit(value);
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
async function directory(path, create = false) {
  const absolute = resolve(path); let cursor = parse(absolute).root;
  for (const part of relative(cursor, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, part); let info;
    try { info = await lstat(cursor); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      try { await mkdir(cursor); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      info = await lstat(cursor);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('JOB_PATH_INVALID', '任务存储目录不是安全的真实目录');
  }
  if (resolve(await realpath(absolute)) !== absolute) throw fail('JOB_PATH_INVALID', '任务存储路径身份不一致');
  return absolute;
}
async function bytes(path) {
  await directory(parse(path).dir); const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw fail('JOB_PATH_INVALID', '任务存储文件不是安全的普通文件');
  return readFile(path);
}
async function optional(path) { try { return await bytes(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function syncDirectory(path) {
  let file; try { file = await open(path, 'r'); await file.sync(); }
  catch (error) { if (!['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
  finally { await file?.close(); }
}
async function synced(path, value) { const file = await open(path, 'wx'); try { await file.writeFile(value); await file.sync(); } finally { await file.close(); } }
async function replace(temporary, target) {
  const delays = [20, 40, 80, 160, 320];
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, target); return; }
    catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= delays.length) throw error; await sleep(delays[attempt]); }
  }
}
async function atomic(path, value, hook) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await optional(path); await synced(temporary, value); if (hook) await hook({path, temporary}); await replace(temporary, path); await syncDirectory(parse(path).dir); }
  finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}
async function immutable(path, value) {
  const previous = await optional(path);
  if (previous) { if (!previous.equals(Buffer.from(value))) throw fail('JOB_IMMUTABLE_CONFLICT', '任务不可变记录已存在且内容不同', 409); return; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await synced(temporary, value);
    try { await link(temporary, path); } catch (error) { if (error.code !== 'EEXIST' || !(await bytes(path)).equals(Buffer.from(value))) throw error; }
    await syncDirectory(parse(path).dir);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}
/** OS creation identity distinguishes a dead process from a reused PID. Unknown stays live. */
async function birthIdentity(pid) {
  try {
    if (process.platform === 'win32') {
      const command = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; if ($null -ne $p) { $p.CreationDate.ToUniversalTime().Ticks.ToString() }`;
      const result = await executeFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], {windowsHide: true, timeout: 5000, maxBuffer: 16384});
      const value = result.stdout.trim(); return /^\d{10,}$/.test(value) ? `windows:${value}` : null;
    }
    if (process.platform === 'linux') {
      const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
      const value = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      return /^\d+$/.test(value || '') ? `linux:${boot.trim()}:${value}` : null;
    }
  } catch { /* An inaccessible creation identity is not proof of death. */ }
  return null;
}
let ownOwner; let ownOwnerPromise; const observedBirths = new Map();
export async function createJobOwner() {
  ownOwnerPromise ||= (async () => (ownOwner = {pid: process.pid, instanceId: randomUUID(), birthIdentity: await birthIdentity(process.pid)}))();
  await ownOwnerPromise;
  return {...ownOwner};
}
async function localOwner(supplied) {
  const owner = await createJobOwner();
  if (supplied && stable(supplied) !== stable(owner)) throw fail('JOB_OWNER_INVALID', '领取者必须使用当前真实进程身份', 400);
  return owner;
}
function assertOwner(owner, own = false) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !validUuid(owner.instanceId)
    || owner.birthIdentity !== null && typeof owner.birthIdentity !== 'string' || own && owner.pid !== process.pid)
    throw fail('JOB_OWNER_INVALID', '任务进程身份无效', 400);
}
async function alive(owner) {
  assertOwner(owner);
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; return true; }
  if (!owner.birthIdentity) return true;
  if (owner.pid === process.pid && ownOwner?.birthIdentity) return owner.birthIdentity === ownOwner.birthIdentity;
  let observed = observedBirths.get(owner.pid);
  if (!observed || Date.now() - observed.at > 1000) {
    observed = {value: await birthIdentity(owner.pid), at: Date.now()}; observedBirths.set(owner.pid, observed);
  }
  const current = observed.value;
  return !current || current === owner.birthIdentity;
}
/** Shared stores use the same conservative OS birth identity check, never a TTL. */
export async function isJobOwnerAlive(owner) { return alive(owner); }
/** Fully published bakery tickets avoid empty-lock recovery races; live owners never expire. */
async function scanTickets(root) {
  const rows = [];
  for (const item of await readdir(root)) {
    if (!item.endsWith('.lock')) continue;
    let row;
    try { row = JSON.parse((await bytes(join(root, item))).toString()); }
    catch (error) { if (error.code === 'ENOENT') continue; throw fail('JOB_LOCK_CORRUPT', '任务锁记录损坏', 500, error); }
    if (row.schemaVersion !== 1 || !validUuid(row.token) || `${row.token}.lock` !== item || typeof row.choosing !== 'boolean'
      || !Number.isSafeInteger(row.ticket) || row.ticket < (row.choosing ? 0 : 1)) throw fail('JOB_LOCK_CORRUPT', '任务锁身份损坏');
    assertOwner(row.owner);
    const released = await optional(join(root, `${row.token}.released.json`));
    if (released) {
      const receipt = JSON.parse(released.toString());
      if (receipt.token !== row.token || receipt.released !== true || receipt.pid !== row.owner.pid) throw fail('JOB_LOCK_CORRUPT', '任务锁释放凭证损坏');
      continue;
    }
    if (!finishedTickets.has(join(root, item)) && await alive(row.owner)) rows.push(row);
  }
  return rows;
}
async function exclusive(roots, action) {
  const key = join(roots.storageRoot, '.locks'); const before = pending.get(key) || Promise.resolve();
  const operation = before.catch(() => {}).then(async () => {
    await directory(key, true); const owner = await createJobOwner(); const token = randomUUID(); const path = join(key, `${token}.lock`);
    const releasePath = join(key, `${token}.released.json`); const row = {schemaVersion: 1, owner, token, choosing: true, ticket: 0}; let published = false;
    try {
      await immutable(path, JSON.stringify(row)); published = true;
      row.ticket = 1 + Math.max(0, ...(await scanTickets(key)).map((item) => item.ticket)); row.choosing = false;
      if (!Number.isSafeInteger(row.ticket)) throw fail('JOB_LOCK_CORRUPT', '任务锁序号越界');
      await atomic(path, JSON.stringify(row)); const started = Date.now();
      while ((await scanTickets(key)).some((item) => item.token !== token && (item.choosing || item.ticket < row.ticket || item.ticket === row.ticket && item.token < token))) {
        if (Date.now() - started > 10000) throw fail('JOB_BUSY', '另一个进程正在更新任务，请稍后重试', 409); await sleep(20);
      }
      return await action();
    } finally {
      finishedTickets.add(path);
      try {
        if (published) await immutable(releasePath, JSON.stringify({pid: owner.pid, token, released: true}));
        await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error; }); finishedTickets.delete(path);
        await unlink(releasePath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      } catch (error) { if (error.code === 'ENOENT') finishedTickets.delete(path); else throw error; }
    }
  });
  pending.set(key, operation); try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
}
function context(roots) {
  return Object.fromEntries(['sessionRoot', 'workspaceRoot', 'versionRoot'].map((key) => {
    const path = relative(roots.storageRoot, roots[key]) || '.';
    return [key, {kind: isAbsolute(path) ? 'absolute' : 'relative', path: path.split(sep).join('/')}];
  }));
}
const statePath = (roots) => join(roots.storageRoot, 'ledger', 'state.json');
function assertContext(state, roots) { if (stable(state.storageContext) !== stable(context(roots))) throw fail('JOB_STORAGE_CONFLICT', '任务与会话、工作台或版本存储位置关系不一致', 409); }
function checkState(state) {
  if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Number.isSafeInteger(state.nextSeq)
    || state.nextSeq < 1 || !Number.isInteger(state.documentWorkerLimit) || state.documentWorkerLimit < 1 || state.documentWorkerLimit > 8
    || !state.jobs || !state.batches || !state.operationReceipts) throw fail('JOB_CORRUPT', '任务账本格式或序号损坏');
  const sequences = new Set();
  for (const [id, job] of Object.entries(state.jobs)) {
    assertJobId(id);
    if (job.id !== id || job.jobRunId !== id || !statuses.has(job.status) || !Number.isSafeInteger(job.seq) || job.seq < 1 || job.seq >= state.nextSeq
      || sequences.has(job.seq) || job.requestFingerprint !== digest(stable(job.request)) || job.request.sessionId !== job.sessionId
      || stable(job.binding) !== stable(job.request.binding) || stable(job.config) !== stable(job.request.config)
      || typeof job.cancelRequested !== 'boolean' || !Number.isSafeInteger(job.eventSeq) || job.eventSeq < 0 || !Array.isArray(job.eventReceipts))
      throw fail('JOB_CORRUPT', '任务身份或请求校验不一致');
    sequences.add(job.seq); assertBinding(job.sessionId, job.binding);
    if (job.lease) { assertOwner(job.lease.owner); if (!validUuid(job.lease.token)) throw fail('JOB_CORRUPT', '任务领取身份损坏'); }
    if (job.status === 'running' && !job.lease || job.status === 'publishing' && !job.outcomeReceipt || terminalStatuses.has(job.status) && !job.sessionReceipt)
      throw fail('JOB_CORRUPT', '任务阶段缺少提交凭证');
    if (job.publicationLease) { assertOwner(job.publicationLease.owner); if (!validUuid(job.publicationLease.token)) throw fail('JOB_CORRUPT', '任务发布身份损坏'); }
  }
  for (const [id, batch] of Object.entries(state.batches)) {
    assertBatchId(id);
    if (batch.id !== id || !Array.isArray(batch.jobIds) || batch.jobIds.some((jobId) => state.jobs[jobId]?.batchId !== id)
      || new Set(batch.jobIds).size !== batch.jobIds.length) throw fail('JOB_CORRUPT', '批量任务身份损坏');
  }
  return state;
}
async function readLedger(roots) {
  let raw;
  try { raw = await bytes(statePath(roots)); }
  catch (error) { if (error.code === 'ENOENT') throw fail('JOB_STORE_MISSING', '任务账本不存在或记录文件缺失', 404, error); throw error; }
  let wrapped;
  try { wrapped = JSON.parse(raw.toString()); } catch (error) { throw fail('JOB_CORRUPT', '任务账本 JSON 损坏', 500, error); }
  if (wrapped.schemaVersion !== 1 || wrapped.sha256 !== digest(JSON.stringify(wrapped.state))) throw fail('JOB_HASH_MISMATCH', '任务账本校验失败');
  const state = checkState(wrapped.state); assertContext(state, roots); return state;
}
async function commit(state, roots, hooks) {
  state.revision++; state.updatedAt = now(); checkState(state);
  await atomic(statePath(roots), JSON.stringify({schemaVersion: 1, sha256: digest(JSON.stringify(state)), state}) + '\n', hooks?.beforeLedgerRename);
  try { if (hooks?.afterLedgerCommit) await hooks.afterLedgerCommit({revision: state.revision, state: structuredClone(state)}); }
  catch (error) { error.committedRevision = state.revision; throw error; }
}
export async function initializeJobStore(args = {}) {
  const roots = rootsOf(args); const limit = args.documentWorkerLimit ?? 2;
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw fail('JOB_POLICY_INVALID', '全局稿件并发必须为 1–8', 400);
  return exclusive(roots, async () => {
    try {
      const state = await readLedger(roots);
      if (args.documentWorkerLimit !== undefined && state.documentWorkerLimit !== limit) throw fail('JOB_POLICY_CONFLICT', '已登记的全局稿件并发与本进程配置不一致', 409);
      return {schemaVersion: 1, revision: state.revision, documentWorkerLimit: state.documentWorkerLimit};
    } catch (error) {
      if (error.code !== 'JOB_STORE_MISSING') throw error;
      try { await directory(join(roots.storageRoot, 'ledger')); throw fail('JOB_CORRUPT', '已有任务账本目录缺少记录，拒绝重新初始化'); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      const state = {schemaVersion: 1, revision: 0, nextSeq: 1, documentWorkerLimit: limit, storageContext: context(roots),
        jobs: {}, batches: {}, operationReceipts: {}, createdAt: now(), updatedAt: now()};
      const staging = join(roots.storageRoot, `.ledger-${randomUUID()}`); await directory(staging, true);
      await synced(join(staging, 'state.json'), JSON.stringify({schemaVersion: 1, sha256: digest(JSON.stringify(state)), state}) + '\n');
      await syncDirectory(staging); await rename(staging, join(roots.storageRoot, 'ledger')); await syncDirectory(roots.storageRoot);
      return {schemaVersion: 1, revision: 0, documentWorkerLimit: limit};
    }
  });
}
async function mutate(args, action) { const roots = rootsOf(args); return exclusive(roots, async () => { const state = await readLedger(roots); return action(state, roots); }); }
function assertBinding(sessionId, binding) {
  if (!/^s[a-z0-9]+$/.test(sessionId || '') || !binding || !binding.versionId?.startsWith(`${sessionId}:v`)
    || !/^s[a-z0-9]+:v\d{6,}-[a-f0-9]{64}$/.test(binding.versionId) || !/^[a-f0-9]{64}$/.test(binding.workSha256 || '')
    || !binding.versionId.endsWith(`-${binding.workSha256}`) || !/^[a-f0-9]{64}$/.test(binding.sourceSha256 || '')
    || !Number.isSafeInteger(binding.mutationEpoch) || binding.mutationEpoch < 0) throw fail('JOB_BINDING_INVALID', '审阅任务的稿件、版本或修改序号无效', 400);
}
function requestOf(args) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(args.operationId || '') || args.workspaceId != null && !/^w[a-z0-9_-]{1,80}$/.test(args.workspaceId))
    throw fail('JOB_IDENTITY_INVALID', '审阅操作或工作台身份无效', 400);
  const binding = json(args.binding); assertBinding(args.sessionId, binding);
  return {operationId: args.operationId, workspaceId: args.workspaceId ?? null, sessionId: args.sessionId, binding, config: json(args.config || {}),
    purpose: args.purpose || 'editorial', accountId: args.accountId || null, verificationRunId: args.verificationRunId || null};
}
const operationKey = (request) => `${request.workspaceId || request.sessionId}\0${request.operationId}`;
function newJob(state, request, batchId = null) {
  const key = operationKey(request); const fingerprint = digest(stable(request)); const id = 'r' + digest(key);
  const receipt = state.operationReceipts[key];
  if (receipt) {
    if (receipt.kind !== 'job' || receipt.fingerprint !== fingerprint) throw fail('JOB_OPERATION_CONFLICT', '同一审阅操作不能更换稿件版本或配置', 409);
    return {job: state.jobs[receipt.id], replayed: true};
  }
  const busy = Object.values(state.jobs).find((job) => job.sessionId === request.sessionId && ['queued', 'running', 'publishing'].includes(job.status));
  if (busy) { const error = fail('JOB_SESSION_BUSY', '此稿件已有未终结的审阅任务', 409); error.jobId = busy.id; throw error; }
  const job = {id, jobRunId: id, operationId: request.operationId, sessionId: request.sessionId, workspaceId: request.workspaceId, batchId,
    seq: state.nextSeq++, request, requestFingerprint: fingerprint, binding: request.binding, config: request.config, purpose: request.purpose,
    verificationRunId: request.verificationRunId, status: 'queued', cancelRequested: false, lease: null, publicationLease: null,
    progress: {phase: 'queued', done: 0, total: 0, message: '等待审阅'}, eventSeq: 0, eventReceipts: [], outcomeReceipt: null, sessionReceipt: null,
    createdAt: now(), updatedAt: now()};
  state.jobs[id] = job; state.operationReceipts[key] = {kind: 'job', id, fingerprint}; return {job, replayed: false};
}
export async function enqueueJob(args) { const request = requestOf(args); return mutate(args, async (state, roots) => { const result = newJob(state, request); if (!result.replayed) await commit(state, roots, args.faultHooks); return structuredClone(result); }); }
/** Operator-only replacement: original requests/results never change; new batch stays paused. */
export async function supersedePausedBatchTransport(args){
 const approval=json(args.approval),items=json(args.jobs);
 if(!/^[A-Za-z0-9_-]{1,180}$/.test(args.operationId||'')||!/^w[a-z0-9_-]{1,80}$/.test(args.workspaceId||'')||approval?.schemaVersion!==1||approval.kind!=='review-transport-rebase-approval'||approval.humanAuthorization?.actorType!=='human'||!approval.humanAuthorization.statement||!approval.humanAuthorization.evidenceRef||!/^[a-f0-9]{64}$/.test(approval.humanAuthorization.evidenceSha256||'')||!Number.isSafeInteger(args.expectedRevision)||!/^[a-f0-9]{64}$/.test(args.expectedLedgerSha256||'')||!Array.isArray(items))throw fail('JOB_TRANSPORT_REBASE_INVALID','迁移缺少固定人工批准、完整稿件分母和账本CAS',400);
 const plan=await import('./review-plan-store.js'),{reviewTransportProjection,verifyReviewTransportSourcePins}=plan;await verifyReviewTransportSourcePins(approval);
 const ark=await import('./ark-execution-store.js'),summary=await ark.readArkExecutionSummary({storageRoot:args.executionRoot,poolId:args.poolId});
 if(summary.blockedUnknownCount||summary.counts?.sending||summary.counts?.queued)throw fail('ARK_EXECUTION_BLOCKED','实际请求池尚未安全终止',409);
 if(!approval.abandonment?.attemptIds?.length)throw fail('JOB_TRANSPORT_REBASE_INVALID','必须绑定明确的人工放弃事件',400);
 for(const id of approval.abandonment.attemptIds){const saved=await ark.readArkAttempt({storageRoot:args.executionRoot,poolId:args.poolId,attemptId:id,includeRaw:false});if(saved.attempt.status!=='abandoned'||saved.attempt.abandonment?.operationId!==approval.abandonment.operationId||saved.attempt.abandonment?.eventSha256!==approval.abandonment.eventSha256||saved.receipt?.status!=='unknown_sent'||saved.receipt.bodyComplete!==false)throw fail('JOB_TRANSPORT_REBASE_INVALID','未知请求不是匹配批准的人工放弃终态',409);const raw=await bytes(join(args.executionRoot,'pools',args.poolId,saved.attempt.abandonment.eventFile));if(digest(raw)!==approval.abandonment.eventSha256||stable(JSON.parse(raw).request.humanAuthorization)!==stable(approval.humanAuthorization))throw fail('JOB_TRANSPORT_REBASE_INVALID','迁移人类授权与放弃原始事件不同',409);}
 return mutate(args,async(state,roots)=>{
  const key=`${args.workspaceId}\0${args.operationId}`,newBatchId='q'+digest(key),receiptPath=join(roots.storageRoot,'transport-rebases',args.operationId+'.json');
  const commandFingerprint=digest(stable({batchId:args.batchId,workspaceId:args.workspaceId,operationId:args.operationId,items,approval}));
  if(state.transportRebases?.[key]){const receipt=state.transportRebases[key];if(receipt.commandFingerprint!==commandFingerprint)throw fail('JOB_OPERATION_CONFLICT','迁移操作不能改变已批准输入',409);if(digest(await bytes(receipt.receiptPath))!==receipt.receiptSha256)throw fail('JOB_HASH_MISMATCH','迁移完成凭证已经损坏',409);return{batch:structuredClone(state.batches[receipt.newBatchId]),receipt,replayed:true};}
  if(state.revision!==args.expectedRevision||digest(await bytes(statePath(roots)))!==args.expectedLedgerSha256)throw fail('JOB_TRANSPORT_REBASE_CAS_CONFLICT','迁移账本版本已变化',409);
  const oldBatch=batchIn(state,args.batchId);if(!oldBatch.paused||oldBatch.finishedAt||oldBatch.cancelRequested||oldBatch.workspaceId!==args.workspaceId||items.length!==oldBatch.jobIds.length||state.batches[newBatchId])throw fail('JOB_TRANSPORT_REBASE_INVALID','只允许替代完整的静止暂停批次',409);
  const originals=oldBatch.jobIds.map(id=>state.jobs[id]),sessions=[];
  for(let i=0;i<originals.length;i++){
   const old=originals[i],item=items[i];if(!item||item.oldJobRunId!==old.id||item.sessionId!==old.sessionId||item.purpose!==old.purpose||(item.verificationRunId??null)!==old.verificationRunId||(item.accountId??null)!==(old.request.accountId??null)||stable(item.binding)!==stable(old.binding)||!['queued',...terminalStatuses].includes(old.status)||old.lease||old.publicationLease||old.config.recipe!==approval.fromRecipe||item.config?.recipe!==approval.toRecipe)throw fail('JOB_TRANSPORT_REBASE_INVALID','完整有序原任务或运行配置不同',409);
   const options=config=>{const out={...config};for(const k of ['recipe','effectiveExecution','resumedFromRunId','transportRebase'])delete out[k];return out;};
   if(stable(options(old.config))!==stable(options(item.config))||stable(reviewTransportProjection(old.config.effectiveExecution,'effective'))!==stable(reviewTransportProjection(item.config.effectiveExecution,'effective'))||item.config.effectiveExecution?.responseTimeoutMs!==300000||item.config.effectiveExecution?.queueTimeoutMs!==null)throw fail('JOB_TRANSPORT_REBASE_SEMANTIC_CONFLICT','仅期限字段可改变，模型与其他设置必须完全一致',409);
   if(item.config.resumedFromRunId!=null&&(old.status==='queued'||item.config.resumedFromRunId!==old.id))throw fail('JOB_TRANSPORT_REBASE_INVALID','复用来源只能是对应已终结原运行',409);
   const stored=await loadSessionSnapshot({sessionId:old.sessionId,storageRoot:roots.sessionRoot}),s=stored.snapshot;
   if(s.workVersion?.id!==old.binding.versionId||s.workVersion.sha256!==old.binding.workSha256||s.workVersion.sourceSha256!==old.binding.sourceSha256||(s.mutationEpoch||0)!==old.binding.mutationEpoch||s.reviewRunning||s.applyingFixes)throw fail('JOB_TRANSPORT_REBASE_SOURCE_CONFLICT','当前工作稿或修改历史已经改变',409);
   const version=await loadWorkingVersion({sessionId:old.sessionId,versionId:old.binding.versionId,storageRoot:roots.versionRoot});if(digest(version.buffer)!==old.binding.workSha256||digest(version.originalBuffer)!==old.binding.sourceSha256)throw fail('JOB_TRANSPORT_REBASE_SOURCE_CONFLICT','原稿或工作稿实际字节不同',409);
   if(typeof args.planRoot!=='string')throw fail('JOB_TRANSPORT_REBASE_INVALID','完整预检缺少独立来源计划根',400);
   const scope={jobRunId:old.id,sessionId:old.sessionId,workspaceId:old.workspaceId,purpose:old.purpose,verificationRunId:old.verificationRunId,binding:old.binding,recipe:old.config.recipe,endpointIdentity:old.config.effectiveExecution?.endpointIdentity||null,planRoot:args.planRoot,executionRoot:args.executionRoot,poolId:args.poolId};
   const coverage=await plan.readReviewPlanCoverage({scope});if(coverage&&item.config.resumedFromRunId!==old.id)throw fail('JOB_TRANSPORT_REBASE_INVALID','已有来源计划必须显式保留对应原运行',409);
   if(coverage){for(const unit of coverage.units.filter(u=>u.status==='completed')){if(unit.parentUnitId&&coverage.units.find(p=>p.unitId===unit.parentUnitId)?.status!=='completed')throw fail('JOB_TRANSPORT_REBASE_INVALID','未完成父项含已知子项，须单独受支持的对应映射',409);await plan.verifyReviewTransportCheckpoint({scope,unitId:unit.unitId});}}
   if(old.status==='queued'&&(old.eventSeq!==0||await readOutcome(old,roots,false)))throw fail('JOB_TRANSPORT_REBASE_INVALID','已执行或已有outbox的任务不能按未开始替代',409);
   sessions.push({sessionId:old.sessionId,manifestSha256:stored.manifest.manifestSha256,sessionRevision:stored.manifest.revision});
  }
  const entries=originals.map((old,i)=>({oldJobRunId:old.id,newJobRunId:'r'+digest(`${args.workspaceId}\0${args.operationId}-${i}`),sessionId:old.sessionId,binding:old.binding,oldConfig:old.config,newConfig:items[i].config,...sessions[i]}));
  let audit={...approval,kind:'review-transport-rebase-receipt',operationId:args.operationId,oldBatchId:oldBatch.id,newBatchId,commandFingerprint,oldLedgerRevision:state.revision,entries,createdAt:now()};const existingAudit=await optional(receiptPath);if(existingAudit){const old=JSON.parse(existingAudit);if(stable({...old,createdAt:null})!==stable({...audit,createdAt:null}))throw fail('JOB_TRANSPORT_REBASE_CAS_CONFLICT','先前未提交迁移证据与当前预检不同',409);audit=old;}const auditBytes=Buffer.from(JSON.stringify(audit)+'\n'),auditSha256=digest(auditBytes);
  const ref={operationId:args.operationId,path:receiptPath,sha256:auditSha256};
  for(const saved of sessions){const current=await loadSessionSnapshot({sessionId:saved.sessionId,storageRoot:roots.sessionRoot});if(current.manifest.manifestSha256!==saved.manifestSha256)throw fail('JOB_TRANSPORT_REBASE_SOURCE_CONFLICT','预检后稿件记录已变化',409);}
  await directory(join(roots.storageRoot,'transport-rebases'),true);await immutable(receiptPath,auditBytes);
  for(let i=0;i<originals.length;i++)if(originals[i].status==='queued'){
   const old=originals[i],reference={storageKind:'transport-rebase',operationId:args.operationId},staged={...old,outcomeReceipt:reference},outcome={status:'cancelled',result:null,error:'人工批准运输配置迁移：原未执行任务已被独立新运行替代'},saved=await writeOutcome(staged,outcome,roots,args.faultHooks);if(stable(saved.outcome)!==stable(outcome))throw fail('JOB_OUTCOME_CONFLICT','未提交迁移outbox内容不同',409);old.outcomeReceipt={...saved.receipt,...reference};
   await appendEventsIn(old,[{type:'cancelled',data:{message:'旧未执行任务已被批准的新运行替代',supersededBy:entries[i].newJobRunId}}],roots);
   Object.assign(old,{status:'cancelled',cancelRequested:true,progress:{phase:'cancelled',done:0,total:1,message:'原未执行任务已被批准的新运行替代'},finishedAt:now(),updatedAt:now(),sessionReceipt:{jobRunId:old.id,versionId:old.binding.versionId,unpublished:true,reason:'transport-rebase-superseded-before-execution',sessionRevision:sessions[i].sessionRevision,sessionManifestSha256:sessions[i].manifestSha256}});
  }
  oldBatch.cancelRequested=true;oldBatch.paused=true;oldBatch.supersededBy=newBatchId;refreshBatch(state,originals[0]);
  const requests=items.map((item,i)=>requestOf({...item,operationId:`${args.operationId}-${i}`,workspaceId:args.workspaceId,config:{...item.config,transportRebase:ref}}));
  const jobs=requests.map(request=>{const accepted=newJob(state,request,newBatchId);if(accepted.replayed)throw fail('JOB_OPERATION_CONFLICT','新迁移子操作已存在',409);return accepted.job;});
  const excluded=oldBatch.excluded||[],fingerprint=digest(stable({workspaceId:args.workspaceId,operationId:args.operationId,requests,excluded}));
  const batch={id:newBatchId,batchId:newBatchId,operationId:args.operationId,workspaceId:args.workspaceId,jobIds:jobs.map(j=>j.id),requestFingerprint:fingerprint,excluded,paused:true,cancelRequested:false,status:'paused',pauseReason:{code:'REVIEW_TRANSPORT_REBASE_AWAITING_FINAL_RESUME',message:'新运行已独立建立并暂停；须人工最终确认后继续'},createdAt:now(),updatedAt:now(),supersedes:oldBatch.id};
  state.batches[newBatchId]=batch;state.operationReceipts[key]={kind:'batch',id:newBatchId,fingerprint};state.transportRebases??={};const receipt={newBatchId,oldBatchId:oldBatch.id,commandFingerprint,receiptPath,receiptSha256:auditSha256};state.transportRebases[key]=receipt;
  await commit(state,roots,args.faultHooks);return{batch:structuredClone(batch),receipt,replayed:false};
 });
}
export async function startBatch(args) {
  if (!/^w[a-z0-9_-]{1,80}$/.test(args.workspaceId || '') || !/^[A-Za-z0-9_-]{1,200}$/.test(args.operationId || '') || !Array.isArray(args.jobs) || !args.jobs.length)
    throw fail('JOB_BATCH_INVALID', '批量任务需要工作台、操作身份和有序稿件列表', 400);
  const requests = args.jobs.map((item, index) => requestOf({...args, ...item, workspaceId: args.workspaceId,
    operationId: item.operationId || `${args.operationId}-${index}`, config: item.config || args.config || {}}));
  if (requests.some((request) => request.operationId === args.operationId)) throw fail('JOB_BATCH_INVALID', '批量任务和子任务必须使用不同的操作身份', 400);
  const excluded = json(args.excluded || []);
  if (!Array.isArray(excluded) || excluded.some((item) => !item || typeof item.entryId !== 'string' || !item.entryId
    || typeof item.name !== 'string' || !item.name || typeof item.reason !== 'string' || !item.reason))
    throw fail('JOB_BATCH_INVALID', '批量任务的未入队稿件需要条目身份、名称和明确原因', 400);
  const fingerprint = digest(stable({workspaceId: args.workspaceId, operationId: args.operationId, requests, excluded})); const key = `${args.workspaceId}\0${args.operationId}`;
  return mutate(args, async (state, roots) => {
    const receipt = state.operationReceipts[key];
    if (receipt) {
      if (receipt.kind !== 'batch' || receipt.fingerprint !== fingerprint) throw fail('JOB_OPERATION_CONFLICT', '同一批量操作不能改变稿件顺序、版本或配置', 409);
      const batch = state.batches[receipt.id]; return structuredClone({batch, jobs: batch.jobIds.map((id) => state.jobs[id]), replayed: true});
    }
    if (Object.values(state.batches).some((batch) => batch.workspaceId === args.workspaceId && batch.jobIds.some((id) => !terminalStatuses.has(state.jobs[id].status))))
      throw fail('JOB_BATCH_BUSY', '此工作台已有未终结的批量任务', 409);
    const id = 'q' + digest(key); const jobs = requests.map((request) => {
      const result = newJob(state, request, id);
      if (result.replayed && result.job.batchId !== id) throw fail('JOB_OPERATION_CONFLICT', '已有审阅操作不能改属于另一批量任务', 409);
      return result.job;
    });
    const batch = {id, batchId: id, operationId: args.operationId, workspaceId: args.workspaceId, requestFingerprint: fingerprint,
      jobIds: jobs.map((job) => job.id), excluded, paused: false, cancelRequested: false, status: 'running', createdAt: now(), updatedAt: now()};
    state.batches[id] = batch; state.operationReceipts[key] = {kind: 'batch', id, fingerprint}; await commit(state, roots, args.faultHooks);
    return structuredClone({batch, jobs, replayed: false});
  });
}
function jobIn(state, id) { const job = state.jobs[id]; if (!job) throw fail('JOB_NOT_FOUND', '审阅任务不存在', 404); return job; }
function batchIn(state, id) { assertBatchId(id); const batch = state.batches[id]; if (!batch) throw fail('JOB_BATCH_NOT_FOUND', '批量任务不存在', 404); return batch; }
export async function loadJob(args) { return structuredClone(jobIn(await readLedger(rootsOf(args)), idOf(args))); }
export async function listJobs(args = {}) {
  return structuredClone(Object.values((await readLedger(rootsOf(args))).jobs).filter((job) => (!args.sessionId || job.sessionId === args.sessionId)
    && (!args.workspaceId || job.workspaceId === args.workspaceId) && (!args.batchId || job.batchId === args.batchId)
    && (!args.status || job.status === args.status)).sort((a, b) => a.seq - b.seq));
}
/** One immutable ledger read supplies batch state and job counts together. */
export async function loadReviewQueueSnapshot(args) {
  const sessionIds = args.sessionIds === undefined ? [] : json(args.sessionIds);
  if (!Array.isArray(sessionIds) || sessionIds.some(id => typeof id !== 'string' || !/^s[a-z0-9]+$/.test(id)))
    throw fail('JOB_SESSION_IDS_INVALID', '工作台引用会话必须是合法会话身份的数组', 400);
  const referenced = new Set(sessionIds);
  const state = await readLedger(rootsOf(args));
  // A session can be attached to another workspace after import. Its live run
  // remains a session fact even when the run was created in the original one.
  // References broaden visible job facts; they never select another batch.
  const jobs = Object.values(state.jobs).filter(job => job.workspaceId === args.workspaceId || referenced.has(job.sessionId)).sort((a,b) => a.seq-b.seq);
  const batch = args.batchId ? batchIn(state,args.batchId) : Object.values(state.batches)
    .filter(item => item.workspaceId === args.workspaceId)
    .sort((a,b) => state.jobs[b.jobIds[0]].seq-state.jobs[a.jobIds[0]].seq)[0] || null;
  if(batch && batch.workspaceId !== args.workspaceId) throw fail('JOB_BATCH_NOT_FOUND','批量任务不属于该工作台',404);
  return structuredClone({revision:state.revision,workspaceId:args.workspaceId,batch,jobs});
}
export async function loadBatch(args) { return structuredClone(batchIn(await readLedger(rootsOf(args)), args.batchId)); }
export async function latestBatchForWorkspace(args) {
  const state = await readLedger(rootsOf(args)); return structuredClone(Object.values(state.batches).filter((batch) => batch.workspaceId === args.workspaceId)
    .sort((a, b) => state.jobs[b.jobIds[0]].seq - state.jobs[a.jobIds[0]].seq)[0] || null);
}
function ownLease(job, token, status = 'running') {
  if (job.status !== status || !job.lease || job.lease.token !== token) throw fail('JOB_LEASE_CONFLICT', '任务状态或领取凭证已变化', 409);
}
export async function claimNextJob(args) {
  const exclusions = args.excludedJobIds === undefined ? [] : args.excludedJobIds;
  if (!Array.isArray(exclusions) || exclusions.some((id) => typeof id !== 'string' || !/^r[a-f0-9]{64}$/.test(id))
    || new Set(exclusions).size !== exclusions.length)
    throw fail('JOB_CLAIM_EXCLUSIONS_INVALID', '领取任务的暂缓身份列表无效', 400);
  const excluded = new Set(exclusions);
  const owner = await localOwner(args.owner);
  return mutate(args, async (state, roots) => {
    const active = Object.values(state.jobs).filter((job) => ['running', 'publishing'].includes(job.status) && job.lease);
    if (active.length >= state.documentWorkerLimit) return null;
    let job; let repaired = false;
    for (const item of Object.values(state.jobs).sort((a, b) => a.seq - b.seq)) {
      if (item.status !== 'queued' || excluded.has(item.id)) continue;
      const saved = await readOutcome(item, roots, false);
      if (saved) { publishing(item, saved); repaired = true; continue; }
      if (!item.cancelRequested && !active.some((other) => other.sessionId === item.sessionId)
        && (!item.batchId || !state.batches[item.batchId].paused && !state.batches[item.batchId].cancelRequested)) { job = item; break; }
    }
    if (!job) { if (repaired) await commit(state, roots, args.faultHooks); return null; }
    job.status = 'running'; job.lease = {owner: {...owner}, token: randomUUID(), acquiredAt: now(), touchedAt: now()};
    job.startedAt = now(); job.updatedAt = now(); job.progress = {phase: 'start', done: 0, total: 0, message: '开始审阅'};
    await commit(state, roots, args.faultHooks); return structuredClone(job);
  });
}
export async function renewJobLease(args) { return mutate(args, async (state, roots) => { const job = jobIn(state, idOf(args)); ownLease(job, args.leaseToken);
  if (args.owner && stable(args.owner) !== stable(job.lease.owner)) throw fail('JOB_LEASE_CONFLICT', '任务进程身份不一致', 409);
  job.lease.touchedAt = now(); await commit(state, roots, args.faultHooks); return structuredClone(job); }); }
export async function updateJobProgress(args) { const progress = json(args.progress); return mutate(args, async (state, roots) => { const job = jobIn(state, idOf(args)); ownLease(job, args.leaseToken);
  job.progress = progress; job.updatedAt = now(); await commit(state, roots, args.faultHooks); return structuredClone(job); }); }
export async function appendJobEvents(args) {
  const events = json(args.events); if (!Array.isArray(events)) throw fail('JOB_EVENTS_INVALID', '任务事件必须为数组', 400);
  if (!events.length) return [];
  return mutate(args, async (state, roots) => {
    const job = jobIn(state, idOf(args)); ownLease(job, args.leaseToken);
    const added = await appendEventsIn(job, events, roots);
    await commit(state, roots, args.faultHooks); return structuredClone(added);
  });
}
async function appendEventsIn(job, events, roots) {
  const added = events.map((event, index) => ({...event, seq: job.eventSeq + index + 1, jobRunId: job.id, versionId: job.binding.versionId}));
  if (added.some((event) => typeof event.type !== 'string' || !event.type)) throw fail('JOB_EVENTS_INVALID', '任务事件类型无效', 400);
  const directoryPath = join(roots.storageRoot, 'events', job.id); await directory(directoryPath, true);
  const payload = JSON.stringify(added); const payloadHash = digest(payload);
  // An event file committed before a failed ledger rename is an unreferenced
  // immutable artifact. Content-addressing lets failure publication use the
  // same next sequence without colliding with that abandoned event batch.
  const name = `${added[0].seq}-${added.at(-1).seq}-${payloadHash}.json`;
  await immutable(join(directoryPath, name), payload + '\n');
  job.eventReceipts.push({name, first: added[0].seq, last: added.at(-1).seq, sha256: payloadHash}); job.eventSeq = added.at(-1).seq;
  const progress = [...added].reverse().find((event) => event.type === 'progress');
  if (progress) job.progress = progress.data;
  return added;
}
export async function readJobEvents(args) {
  const roots = rootsOf(args); const job = jobIn(await readLedger(roots), idOf(args)); const afterSeq = args.afterSeq ?? 0; const limit = args.limit ?? 500;
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1) throw fail('JOB_EVENT_CURSOR_INVALID', '任务事件游标无效', 400);
  const events = [];
  for (const receipt of job.eventReceipts.filter((item) => item.last > afterSeq)) {
    if (!/^\d+-\d+-[a-f0-9]{64}\.json$/.test(receipt.name)) throw fail('JOB_CORRUPT', '任务事件文件身份损坏');
    const rows = JSON.parse((await bytes(join(roots.storageRoot, 'events', job.id, receipt.name))).toString());
    if (digest(JSON.stringify(rows)) !== receipt.sha256 || rows.length !== receipt.last - receipt.first + 1
      || rows.some((item, index) => item.seq !== receipt.first + index || item.jobRunId !== job.id || item.versionId !== job.binding.versionId)) throw fail('JOB_HASH_MISMATCH', '任务事件身份或校验失败');
    events.push(...rows.filter((item) => item.seq > afterSeq)); if (events.length >= limit) break;
  }
  return events.slice(0, limit);
}
function outcomeRoot(roots, job) { const ref=job.outcomeReceipt;if(ref?.storageKind==='transport-rebase'){if(!/^[A-Za-z0-9_-]{1,200}$/.test(ref.operationId||''))throw fail('JOB_OUTCOME_CONFLICT','迁移结果目录身份无效',409);return join(roots.storageRoot,'transport-rebase-outcomes',ref.operationId,job.id);}return join(roots.storageRoot, 'outcomes', job.id); }
async function readOutcome(job, roots, required = true) {
  const root = outcomeRoot(roots, job);
  try {
    await directory(root); await directory(join(root, job.sessionId)); await bytes(join(root, job.sessionId, 'state.json'));
    const stored = await loadSessionSnapshot({sessionId: job.sessionId, storageRoot: root}); const snapshot = stored.snapshot;
    if (snapshot.reviewJobId !== job.id || snapshot.leaseToken !== (job.lease?.token ?? job.outcomeReceipt?.leaseToken ?? null)
      || snapshot.requestFingerprint !== job.requestFingerprint || snapshot.workVersion.id !== job.binding.versionId
      || !terminalStatuses.has(snapshot.outcome?.status)) throw fail('JOB_OUTCOME_CONFLICT', '任务结果与领取、请求或版本身份不一致', 409);
    if (job.outcomeReceipt && job.outcomeReceipt.manifestSha256 !== stored.manifest.manifestSha256 && !(job.status==='queued'&&job.outcomeReceipt.storageKind==='transport-rebase'&&!job.outcomeReceipt.manifestSha256)) throw fail('JOB_HASH_MISMATCH', '任务结果提交凭证不一致');
    return {outcome: snapshot.outcome, receipt: {manifestSha256: stored.manifest.manifestSha256, leaseToken: snapshot.leaseToken,
      status: snapshot.outcome.status, jobRunId: job.id, versionId: job.binding.versionId}};
  } catch (error) { if (!required && (error.code === 'ENOENT' || error.code === 'SESSION_NOT_FOUND' || error.code === 'SESSION_MISSING')) return null; throw error; }
}
async function writeOutcome(job, outcome, roots, hooks) {
  if (!terminalStatuses.has(outcome?.status)) throw fail('JOB_OUTCOME_INVALID', '任务结果必须指定明确终态', 400);
  const existing = await readOutcome(job, roots, false); if (existing) return existing;
  const root = outcomeRoot(roots, job); await directory(root, true);
  const snapshot = {id: job.sessionId, workVersion: {id: job.binding.versionId, sessionId: job.sessionId}, reviewJobId: job.id,
    leaseToken: job.lease?.token || null, requestFingerprint: job.requestFingerprint, outcome};
  const manifest = await saveSessionSnapshot({sessionId: job.sessionId, snapshot, storageRoot: root, expectedRevision: -1});
  if (hooks?.afterOutcomeCommit) await hooks.afterOutcomeCommit({jobId: job.id, manifest});
  return {outcome, receipt: {manifestSha256: manifest.manifestSha256, leaseToken: snapshot.leaseToken, status: outcome.status, jobRunId: job.id, versionId: job.binding.versionId}};
}
function publishing(job, saved) { job.status = 'publishing'; job.outcomeReceipt = saved.receipt; job.publicationLease = null; job.updatedAt = now(); }
export async function stageJobOutcome(args) {
  return mutate(args, async (state, roots) => {
    const job = jobIn(state, idOf(args));
    if (job.status === 'publishing' && job.outcomeReceipt?.leaseToken === args.leaseToken) return structuredClone(job);
    ownLease(job, args.leaseToken);
    const outcome = job.cancelRequested ? {status: 'cancelled', error: '此次审阅已取消'} : args.outcome;
    const saved = await writeOutcome(job, outcome, roots, args.faultHooks); publishing(job, saved); await commit(state, roots, args.faultHooks); return structuredClone(job);
  });
}
export async function loadJobOutcome(args) { const roots = rootsOf(args); const job = jobIn(await readLedger(roots), idOf(args)); return (await readOutcome(job, roots)).outcome; }
export async function claimJobPublication(args) {
  const owner = await localOwner(args.owner);
  return mutate(args, async (state, roots) => {
    const candidates = args.jobId || args.jobRunId ? [jobIn(state, idOf(args))] : Object.values(state.jobs).sort((a, b) => a.seq - b.seq);
    for (const job of candidates) {
      if (job.status !== 'publishing') continue;
      if (job.publicationLease && await alive(job.publicationLease.owner)) continue;
      await readOutcome(job, roots); job.publicationLease = {owner: {...owner}, token: randomUUID(), acquiredAt: now()};
      await commit(state, roots, args.faultHooks); return structuredClone(job);
    }
    return null;
  });
}
function publicationToken(args) { return args.publicationToken || args.leaseToken; }
function ownPublication(job, token) { if (job.status !== 'publishing' || job.publicationLease?.token !== token) throw fail('JOB_PUBLICATION_CONFLICT', '任务发布凭证已变化', 409); }
function refreshBatch(state, job) {
  if (!job.batchId) return; const batch = state.batches[job.batchId]; const jobs = batch.jobIds.map((id) => state.jobs[id]);
  batch.updatedAt = now();
  if (jobs.every((item) => terminalStatuses.has(item.status))) {
    batch.status = jobs.every((item) => item.status === 'completed') ? (batch.excluded?.length ? 'partial' : 'completed') : batch.cancelRequested ? 'cancelled'
      : jobs.some((item) => item.status === 'interrupted') ? 'interrupted' : jobs.some((item) => item.status === 'failed') ? 'failed' : 'partial';
    batch.finishedAt = now();
  } else batch.status = batch.cancelRequested ? 'cancelling' : batch.paused ? 'paused' : 'running';
}
export async function completeJobPublication(args) {
  const supplied = args.sessionReceipt || args.receipt || {};
  // Full terminalData belongs to the per-job event artifact. Never copy it (or
  // any other callback payload) into the globally rewritten scheduling ledger.
  const receiptKeys = ['jobRunId', 'versionId', 'sessionRevision', 'sessionManifestSha256', 'unpublished', 'reason', 'currentVersionId', 'error'];
  const receipt = {};
  for (const key of receiptKeys) {
    const entry = Object.getOwnPropertyDescriptor(supplied, key);
    if (!entry) continue;
    if (!Object.hasOwn(entry, 'value')) throw fail('JOB_NOT_JSON', '会话发布凭证不能包含访问器', 400);
    const valid = key === 'sessionRevision' ? Number.isSafeInteger(entry.value) && entry.value >= 0
      : key === 'unpublished' ? typeof entry.value === 'boolean' : typeof entry.value === 'string';
    if (!valid) throw fail('JOB_PUBLICATION_CONFLICT', '会话发布凭证的元数据类型无效', 409);
    if (key !== 'error' && typeof entry.value === 'string' && entry.value.length > 4096)
      throw fail('JOB_PUBLICATION_CONFLICT', '会话发布凭证的元数据过长', 409);
    receipt[key] = key === 'error' ? entry.value.slice(0, 1024) : entry.value;
  }
  const epochEntry = Object.getOwnPropertyDescriptor(supplied, 'currentMutationEpoch');
  if (epochEntry && (!Object.hasOwn(epochEntry, 'value') || !Number.isSafeInteger(epochEntry.value) || epochEntry.value < 0))
    throw fail('JOB_PUBLICATION_CONFLICT', '会话发布凭证的当前修改序号无效', 409);
  return mutate(args, async (state, roots) => {
    const job = jobIn(state, idOf(args));
    if (terminalStatuses.has(job.status)) { if (stable(job.sessionReceipt) !== stable(receipt)) throw fail('JOB_PUBLICATION_CONFLICT', '已完成任务不能更换会话发布凭证', 409); return structuredClone(job); }
    ownPublication(job, publicationToken(args)); const saved = await readOutcome(job, roots);
    if (receipt.jobRunId !== job.id || receipt.versionId !== job.binding.versionId) throw fail('JOB_PUBLICATION_CONFLICT', '会话发布凭证与任务或版本不一致', 409);
    await directory(roots.sessionRoot); await directory(join(roots.sessionRoot, job.sessionId));
    await bytes(join(roots.sessionRoot, job.sessionId, 'state.json'));
    const session = await loadSessionSnapshot({sessionId: job.sessionId, storageRoot: roots.sessionRoot});
    if (receipt.unpublished === true) {
      const epoch = session.snapshot.mutationEpoch ?? session.snapshot.history?.epoch ?? 0;
      const configurationRejected = saved.outcome.status === 'failed' && saved.outcome.rejection === 'config-conflict'
        && receipt.reason === 'config-conflict' && job.eventSeq === 0 && epochEntry && epochEntry.value === epoch;
      const versionRejected = receipt.reason === 'version-conflict'
        && (saved.outcome.status !== 'failed' || saved.outcome.rejection === 'version-conflict')
        && (session.snapshot.workVersion.id !== job.binding.versionId || epoch !== job.binding.mutationEpoch);
      if (!['failed', 'cancelled', 'interrupted'].includes(saved.outcome.status) || saved.outcome.result != null
        || !configurationRejected && !versionRejected
        || receipt.currentVersionId !== session.snapshot.workVersion.id || receipt.sessionRevision !== session.manifest.revision
        || receipt.sessionManifestSha256 !== session.manifest.manifestSha256
        || epochEntry && epochEntry.value !== epoch)
        throw fail('JOB_PUBLICATION_CONFLICT', '未发布凭证不能证明当前稿与冻结任务发生了版本冲突', 409);
    } else if ((session.snapshot.reviewJobId || session.snapshot.reviewRunId) !== job.id || session.snapshot.workVersion.id !== job.binding.versionId
      || receipt.sessionRevision !== undefined && receipt.sessionRevision !== session.manifest.revision
      || receipt.sessionManifestSha256 !== undefined && receipt.sessionManifestSha256 !== session.manifest.manifestSha256
      || ['completed', 'partial'].includes(saved.outcome.status) && (!session.snapshot.result || session.snapshot.resultRunId !== job.id || session.snapshot.resultVersionId !== job.binding.versionId))
        throw fail('JOB_PUBLICATION_CONFLICT', '实际会话记录与任务完成凭证不一致', 409);
    if (args.terminalEvent) await appendEventsIn(job, [json(args.terminalEvent)], roots);
    job.status = saved.outcome.status; job.sessionReceipt = receipt; job.finishedAt = now(); job.updatedAt = now(); job.lease = null; job.publicationLease = null;
    job.progress = {phase: job.status, done: job.status === 'completed' ? 1 : 0, total: 1, message: saved.outcome.error || (job.status === 'completed' ? '审阅完成' : job.status)};
    refreshBatch(state, job); await commit(state, roots, args.faultHooks); return structuredClone(job);
  });
}
export async function releaseJobPublication(args) { return mutate(args, async (state, roots) => { const job = jobIn(state, idOf(args)); ownPublication(job, publicationToken(args));
  job.publicationLease = null; await commit(state, roots, args.faultHooks); return structuredClone(job); }); }

/** Cancelled tasks which never ran need no session publication. Verify every
 * durable outcome and current manifest, then commit one bounded ledger update.
 * Live publication leases, started jobs, and results retain the normal path. */
export async function completeQueuedCancellations(args = {}) {
  const limit = args.limit ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw fail('JOB_BATCH_INVALID', '取消记录合批数量无效', 400);
  return mutate(args, async (state, roots) => {
    const completed = [];
    for (const job of Object.values(state.jobs).sort((a,b)=>a.seq-b.seq)) {
      if (completed.length >= limit) break;
      if (job.status !== 'publishing' || !job.cancelRequested || job.startedAt != null || job.lease || job.eventSeq !== 0) continue;
      if (job.publicationLease && await alive(job.publicationLease.owner)) continue;
      const saved = await readOutcome(job, roots);
      if (saved.outcome.status !== 'cancelled' || saved.outcome.result != null) continue;
      const {snapshot,manifest} = await loadSessionSnapshot({sessionId:job.sessionId,storageRoot:roots.sessionRoot});
      const receipt = {jobRunId:job.id,versionId:job.binding.versionId,unpublished:true,reason:'cancelled-before-start',
        currentVersionId:snapshot.workVersion.id,sessionRevision:manifest.revision,sessionManifestSha256:manifest.manifestSha256};
      await appendEventsIn(job,[{type:'cancelled',data:{jobId:job.id,jobRunId:job.id,sessionId:job.sessionId,
        versionId:job.binding.versionId,status:'cancelled',message:'此次审阅尚未开始，已取消'}}],roots);
      job.status='cancelled';job.sessionReceipt=receipt;job.finishedAt=now();job.updatedAt=now();job.lease=null;job.publicationLease=null;
      job.progress={phase:'cancelled',done:0,total:1,message:'此次审阅尚未开始，已取消'};
      completed.push(job.id);refreshBatch(state,job);
    }
    if (completed.length) await commit(state,roots,args.faultHooks);
    return {completed};
  });
}
async function cancelIn(state, roots, job, hooks) {
  if (terminalStatuses.has(job.status) || job.status === 'publishing') return false;
  job.cancelRequested = true; job.updatedAt = now();
  if (job.status === 'queued') publishing(job, await writeOutcome(job, {status: 'cancelled', error: '此次审阅尚未开始，已取消'}, roots, hooks));
  return true;
}
export async function cancelJob(args) { return mutate(args, async (state, roots) => { const job = jobIn(state, idOf(args)); const changed = await cancelIn(state, roots, job, args.faultHooks);
  if (changed) { refreshBatch(state, job); await commit(state, roots, args.faultHooks); } return structuredClone(job); }); }
export const requestJobCancel = cancelJob;
export async function pauseBatch(args) {
  const reason = args.reason === undefined ? null : json(args.reason);
  if (reason !== null && (!reason || Array.isArray(reason) || typeof reason !== 'object'
    || typeof reason.code !== 'string' || !reason.code || typeof reason.message !== 'string' || !reason.message))
    throw fail('JOB_PAUSE_REASON_INVALID', '暂停原因需要明确身份和说明', 400);
  return mutate(args, async (state, roots) => {
    const batch = batchIn(state, args.batchId); let changed = false;
    if (!batch.finishedAt) {
      if (!batch.paused) { batch.paused = true; batch.status = 'paused'; changed = true; }
      // Manual pauses do not erase a durable safety reason. Repeating the same
      // observation must not continually rewrite the shared ledger.
      if (reason && stable(batch.pauseReason || null) !== stable(reason)) { batch.pauseReason = reason; changed = true; }
    }
    if (changed) { batch.updatedAt = now(); await commit(state, roots, args.faultHooks); }
    return structuredClone(batch);
  });
}
export async function resumeBatch(args) { return mutate(args, async (state, roots) => { const batch = batchIn(state, args.batchId); if (batch.cancelRequested) throw fail('JOB_BATCH_CANCELLED', '已取消的批量任务不能继续', 409);
  if (batch.paused && !batch.finishedAt) { batch.paused = false; batch.pauseReason = null; batch.status = 'running'; batch.updatedAt = now(); await commit(state, roots, args.faultHooks); } return structuredClone(batch); }); }
export async function cancelBatch(args) { return mutate(args, async (state, roots) => { const batch = batchIn(state, args.batchId); if (batch.finishedAt) return structuredClone(batch);
  batch.cancelRequested = true; batch.paused = true; batch.status = 'cancelling';
  for (const id of batch.jobIds) await cancelIn(state, roots, state.jobs[id], args.faultHooks);
  refreshBatch(state, state.jobs[batch.jobIds[0]]); await commit(state, roots, args.faultHooks); return structuredClone(batch); }); }
export async function recoverJobs(args = {}) {
  return mutate(args, async (state, roots) => {
    const interrupted = []; const recovered = []; let changed = false;
    for (const job of Object.values(state.jobs).sort((a, b) => a.seq - b.seq)) {
      if (job.status === 'queued') {
        const saved = await readOutcome(job, roots, false);
        if (saved) { publishing(job, saved); recovered.push(job.id); changed = true; }
      }
      if (job.status === 'running' && !await alive(job.lease.owner)) {
        let saved = await readOutcome(job, roots, false);
        if (!saved) {
          saved = await writeOutcome(job, {status: 'interrupted', error: '任务进程已退出，此次审阅已中断；请明确发起新的审阅'}, roots, args.faultHooks);
          interrupted.push(job.id);
          if (job.batchId) { const batch = state.batches[job.batchId]; batch.paused = true; batch.status = 'paused'; batch.interruptedAt = now(); }
        }
        publishing(job, saved); job.lease = null; recovered.push(job.id); changed = true;
      }
      if (job.status === 'publishing' && job.publicationLease && !await alive(job.publicationLease.owner)) { job.publicationLease = null; changed = true; }
    }
    if (changed) await commit(state, roots, args.faultHooks);
    return {interrupted: interrupted.map((id) => structuredClone(state.jobs[id])), publishing: Object.values(state.jobs).filter((job) => job.status === 'publishing').map((job) => structuredClone(job)), recovered};
  });
}
