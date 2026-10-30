/** Durable physical Ark attempts and a shared, configured project-account FIFO pool. */
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, lstat, realpath, readFile, readdir, open, rename, link, unlink} from 'node:fs/promises';
import {resolve, join, dirname, parse, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createJobOwner, isJobOwnerAlive} from './job-store.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const pending = new Map(), finishedTickets = new Set();
const terminal = new Set(['confirmed', 'failed', 'unknown_sent', 'abandoned']);
const active = new Set(['sending', 'unknown_sent']);
const idPattern = /^a[a-f0-9]{32}$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const secretKey = /^(?:authorization|api_?key|access_?token|secret|credential)$/i;
const fail = (code, message, status = 500, cause) => Object.assign(new Error(message, cause ? {cause} : undefined), {code, status});
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
function json(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value) || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw fail('ARK_EXECUTION_NOT_JSON', 'Ark 请求与来源绑定必须是普通 JSON', 400);
  ancestors.add(value);
  try {
    const out = Array.isArray(value) ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || secretKey.test(key))
        throw fail('ARK_EXECUTION_NOT_JSON', 'Ark 记录不能包含访问器、隐藏字段或凭据', 400);
      Object.defineProperty(out, key, {value: json(descriptor.value, ancestors), enumerable: true, configurable: true, writable: true});
    }
    if (Array.isArray(value) && (out.length !== value.length || Array.from({length: value.length}, (_, i) => i).some(i => !Object.hasOwn(value, i))))
      throw fail('ARK_EXECUTION_NOT_JSON', 'Ark 请求数组不能包含空位', 400);
    return out;
  } finally { ancestors.delete(value); }
}
function rootsOf(args = {}) {
  const scope = args.scope || {};
  const storageRoot = resolve(args.storageRoot || scope.executionRoot || process.env.DSH_ARK_EXECUTION_ROOT || fileURLToPath(new URL('../data/ark-executions/', import.meta.url)));
  const poolId = args.poolId || scope.poolId || scope.accountPoolId || process.env.DSH_ARK_POOL_ID || 'project-account';
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(poolId)) throw fail('ARK_POOL_ID_INVALID', 'Ark 项目账户池身份无效', 400);
  if (args.poolId && scope.poolId && args.poolId !== scope.poolId) throw fail('ARK_POOL_ID_CONFLICT', 'Ark 请求与账户池绑定不一致', 409);
  return {storageRoot, poolId, poolRoot: join(storageRoot, 'pools', poolId)};
}
async function safeDirectory(path, create = false, writing = false) {
  const absolute = resolve(path); let cursor = parse(absolute).root;
  for (const part of relative(cursor, absolute).split(sep).filter(Boolean)) {
    if (writing && await exists(join(cursor, 'complete.json'))) throw fail('ARK_STORE_SEALED', '不能写入已封存证据目录', 409);
    cursor = join(cursor, part); let info;
    try { info = await lstat(cursor); }
    catch (error) { if (!create || error.code !== 'ENOENT') throw error; try { await mkdir(cursor); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; } info = await lstat(cursor); }
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('ARK_STORE_ALIAS', 'Ark 存储必须使用真实目录，不能使用路径别名', 400);
  }
  if (writing && await exists(join(absolute, 'complete.json'))) throw fail('ARK_STORE_SEALED', '不能写入已封存证据目录', 409);
  if (resolve(await realpath(absolute)) !== absolute) throw fail('ARK_STORE_ALIAS', 'Ark 存储路径身份不一致', 400);
  return absolute;
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function bytes(path) { await safeDirectory(dirname(path)); const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw fail('ARK_STORE_ALIAS', 'Ark 记录必须是普通文件', 400); return readFile(path); }
async function optional(path) { try { return await bytes(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function syncDirectory(path) { let handle; try { handle = await open(path, 'r'); await handle.sync(); } catch (error) { if (!['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error; } finally { await handle?.close(); } }
async function synced(path, value) { const handle = await open(path, 'wx'); try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); } }
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function replace(temporary, target) { const delays = [20, 40, 80, 160, 320]; for (let i = 0; ; i++) { try { await rename(temporary, target); return; } catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || i >= delays.length) throw error; await sleep(delays[i]); } } }
async function atomic(path, value) {
  await safeDirectory(dirname(path), true, true); await optional(path); const temporary = `${path}.${randomUUID()}.tmp`;
  try { await synced(temporary, value); await replace(temporary, path); await syncDirectory(dirname(path)); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function immutable(path, value) {
  await safeDirectory(dirname(path), true, true); const previous = await optional(path);
  if (previous) { if (!previous.equals(Buffer.from(value))) throw fail('ARK_IMMUTABLE_CONFLICT', 'Ark 不可变记录内容冲突', 409); return; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await synced(temporary, value); try { await link(temporary, path); } catch (error) { if (error.code !== 'EEXIST' || !(await bytes(path)).equals(Buffer.from(value))) throw error; } await syncDirectory(dirname(path)); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function ownerValid(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !uuidPattern.test(owner.instanceId || '') || owner.birthIdentity !== null && typeof owner.birthIdentity !== 'string')
    throw fail('ARK_OWNER_INVALID', 'Ark 请求进程身份无效', 400);
}
async function tickets(root) {
  const rows = [];
  for (const name of await readdir(root)) {
    if (!name.endsWith('.lock')) continue;
    const path = join(root, name); let raw; try { raw = await bytes(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    let row; try { row = JSON.parse(raw); } catch (error) { throw fail('ARK_LOCK_CORRUPT', 'Ark 锁票据损坏', 500, error); }
    if (row.schemaVersion !== 1 || !uuidPattern.test(row.token || '') || `${row.token}.lock` !== name || typeof row.choosing !== 'boolean' || !Number.isSafeInteger(row.ticket) || row.ticket < (row.choosing ? 0 : 1)) throw fail('ARK_LOCK_CORRUPT', 'Ark 锁票据身份损坏');
    ownerValid(row.owner);
    const released = await optional(join(root, `${row.token}.released.json`));
    if (released) { const receipt = JSON.parse(released); if (receipt.token !== row.token || receipt.released !== true || receipt.pid !== row.owner.pid) throw fail('ARK_LOCK_CORRUPT', 'Ark 锁释放凭证损坏'); continue; }
    if (!finishedTickets.has(path) && await isJobOwnerAlive(row.owner)) rows.push(row);
  }
  return rows;
}
/** Fully published choosing/ticket records; no heartbeat or TTL can steal a live owner. */
export async function withArkExecutionStoreLock(args, action) {
  const roots = rootsOf(args), key = join(roots.poolRoot, '.locks');
  const before = pending.get(key) || Promise.resolve();
  const operation = before.catch(() => {}).then(async () => {
    await safeDirectory(key, true, true); const owner = await createJobOwner(), token = randomUUID();
    const path = join(key, `${token}.lock`), releasePath = join(key, `${token}.released.json`);
    const row = {schemaVersion: 1, token, owner, choosing: true, ticket: 0}; let published = false;
    try {
      await immutable(path, JSON.stringify(row)); published = true;
      row.ticket = 1 + Math.max(0, ...(await tickets(key)).map(item => item.ticket)); row.choosing = false;
      if (!Number.isSafeInteger(row.ticket)) throw fail('ARK_LOCK_CORRUPT', 'Ark 锁序号越界'); await atomic(path, JSON.stringify(row));
      const started = Date.now();
      while ((await tickets(key)).some(item => item.token !== token && (item.choosing || item.ticket < row.ticket || item.ticket === row.ticket && item.token < token))) {
        if (Date.now() - started > 15000) throw fail('ARK_STORE_BUSY', '另一个进程正在更新 Ark 请求记录，请稍后重试', 409); await sleep(25);
      }
      return await action();
    } finally {
      finishedTickets.add(path);
      try { if (published) await immutable(releasePath, JSON.stringify({token, pid: owner.pid, released: true})); await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; }); finishedTickets.delete(path); await unlink(releasePath).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      catch (error) { if (error.code === 'ENOENT') finishedTickets.delete(path); else throw error; }
    }
  });
  pending.set(key, operation); try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
}
const statePath = roots => join(roots.poolRoot, 'state.json');
const attemptPath = (roots, id, name) => join(roots.poolRoot, 'attempts', id, name);
function checkState(state, roots) {
  if (!state || state.schemaVersion !== 1 || state.poolId !== roots.poolId || !Number.isSafeInteger(state.revision) || !Number.isSafeInteger(state.nextSeq) || state.nextSeq < 1
      || !Number.isInteger(state.policy?.concurrency) || state.policy.concurrency < 1 || state.policy.concurrency > 32 || !Number.isFinite(state.notBefore) || !state.attempts)
    throw fail('ARK_LEDGER_CORRUPT', 'Ark 请求池账本损坏');
  if (state.policies !== undefined && (!state.policies || typeof state.policies !== 'object' || Array.isArray(state.policies)))
    throw fail('ARK_LEDGER_CORRUPT', 'Ark 请求池并发变更索引损坏');
  const sequences = new Set();
  for (const [id, attempt] of Object.entries(state.attempts)) {
    if (!idPattern.test(id) || attempt.id !== id || !['queued', 'sending', ...terminal].includes(attempt.status) || !Number.isSafeInteger(attempt.seq) || attempt.seq < 1 || attempt.seq >= state.nextSeq || sequences.has(attempt.seq)
        || !/^[a-f0-9]{64}$/.test(attempt.bodySha256 || '') || !/^[a-f0-9]{64}$/.test(attempt.requestFingerprint || '') || !uuidPattern.test(attempt.leaseToken || '')) throw fail('ARK_LEDGER_CORRUPT', 'Ark 物理请求身份或阶段损坏');
    ownerValid(attempt.owner); sequences.add(attempt.seq);
    if (attempt.status === 'abandoned') checkAbandonmentLink(attempt, state);
    if (terminal.has(attempt.status) && (!attempt.receipt || attempt.receipt.attemptId !== id || attempt.receipt.status !== (attempt.status === 'abandoned' ? 'unknown_sent' : attempt.status)
        || attempt.receipt.bodySha256 !== attempt.bodySha256 || attempt.receipt.requestFingerprint !== attempt.requestFingerprint || attempt.receipt.leaseToken !== attempt.leaseToken)) throw fail('ARK_LEDGER_CORRUPT', 'Ark 终态缺少绑定回执');
  }
  return state;
}
async function readState(roots) {
  const raw = await optional(statePath(roots)); if (!raw) return null; let wrapped;
  try { wrapped = JSON.parse(raw); } catch (error) { throw fail('ARK_LEDGER_CORRUPT', 'Ark 请求池 JSON 损坏', 500, error); }
  if (wrapped.schemaVersion !== 1 || wrapped.sha256 !== hash(JSON.stringify(wrapped.state))) throw fail('ARK_LEDGER_HASH_MISMATCH', 'Ark 请求池校验失败');
  // 注意：verifyAbandonments 是异步的，必须先 await 再交给 verifyPolicies ——
  // 否则 verifyPolicies 拿到的是 Promise（自身没有任何键），整段校验会被静默跳过。
  const checked = checkState(wrapped.state, roots);
  const verified = await verifyAbandonments(roots, checked);
  return verifyPolicies(roots, verified);
}
async function commit(state, roots) { state.revision++; state.updatedAt = now(); checkState(state, roots); await atomic(statePath(roots), JSON.stringify({schemaVersion: 1, sha256: hash(JSON.stringify(state)), state}) + '\n'); }
function configuredPolicy(args = {}) {
  const value = args.policy?.concurrency ?? (process.env.DSH_ARK_POOL_CONCURRENCY ? Number(process.env.DSH_ARK_POOL_CONCURRENCY) : 2);
  if (!Number.isInteger(value) || value < 1 || value > 32) throw fail('ARK_POLICY_INVALID', '本项目 Ark 请求并发必须为 1–32', 400);
  return {concurrency: value, limitScope: 'configured-project-account'};
}
export async function initializeArkExecutionStore(args = {}) {
  const roots = rootsOf(args), policy = configuredPolicy(args);
  return withArkExecutionStoreLock(roots, async () => {
    let state = await readState(roots);
    if (state) {
      if ((args.policy?.concurrency != null || process.env.DSH_ARK_POOL_CONCURRENCY) && state.policy.concurrency !== policy.concurrency) throw fail('ARK_POLICY_CONFLICT', '已登记的 Ark 项目请求上限与当前配置不同', 409);
    } else {
      const attempts = join(roots.poolRoot, 'attempts');
      if (await exists(attempts) && (await readdir(attempts)).length) throw fail('ARK_LEDGER_CORRUPT', '已有物理请求目录缺少账本，拒绝重新初始化');
      state = {schemaVersion: 1, poolId: roots.poolId, policy, revision: 0, nextSeq: 1, notBefore: 0, attempts: {}, createdAt: now(), updatedAt: now()}; await commit(state, roots);
    }
    return {schemaVersion: 1, poolId: roots.poolId, policy: {...state.policy}, revision: state.revision};
  });
}
function persistedScope(scope = {}) { const entries = Object.entries(scope).filter(([key]) => !['requestReceipts', 'allRequestReceipts', 'executionRoot', 'planRoot', 'poolId', 'accountPoolId'].includes(key) && scope[key] !== undefined); return json(Object.fromEntries(entries)); }
const metadataScope = scope => {
 const metadata=Object.fromEntries(['jobRunId', 'sessionId', 'operationId', 'operationKind', 'purpose', 'verificationRunId', 'planId', 'planFingerprint', 'unitId', 'parentUnitId', 'windowId', 'parentWindowId', 'ruleId', 'binding', 'sourceVersionId', 'sourceSha256', 'workSha256', 'taskId'].filter(key => Object.hasOwn(scope, key)).map(key => [key, scope[key]]));
 const model=scope.modelResolution,modelId=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/,endpoint=/^ep-\d{14}-[a-z0-9]{1,64}$/;
 if(model?.schemaVersion===1&&typeof model.requestedModel==='string'&&modelId.test(model.requestedModel)&&typeof model.resolvedModel==='string'&&endpoint.test(model.resolvedModel)&&/^[a-f0-9]{64}$/.test(model.configFingerprint||''))
  metadata.modelResolution={schemaVersion:1,requestedModel:model.requestedModel,resolvedModel:model.resolvedModel,configFingerprint:model.configFingerprint};
 return metadata;
};
function assertId(id) { if (!idPattern.test(id || '')) throw fail('ARK_ATTEMPT_ID_INVALID', 'Ark 物理请求身份无效', 400); }
function own(attempt, token) { if (attempt.leaseToken !== token || attempt.owner.pid !== process.pid) throw fail('ARK_ATTEMPT_FENCED', 'Ark 物理请求领取身份不一致', 409); }
function usageOf(raw, consumeResult) {
  let parsed = null, found = consumeResult?.usage || null, responseId = consumeResult?.id || consumeResult?.response?.id || null;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { for (const line of raw.toString('utf8').split(/\r?\n/)) { if (!line.startsWith('data:')) continue; try { const item = JSON.parse(line.slice(5).trim()); if (item.response?.usage || item.usage) found = item.response?.usage || item.usage; responseId ||= item.response?.id || item.id || null; } catch { /* Non-JSON SSE data is not usage proof. */ } } }
  found = found || parsed?.usage || parsed?.response?.usage || null; responseId ||= parsed?.id || parsed?.response?.id || null;
  const valid = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const normalized = {input_tokens: valid(found?.input_tokens ?? found?.prompt_tokens), output_tokens: valid(found?.output_tokens ?? found?.completion_tokens),
    cached_tokens: valid(found?.input_tokens_details?.cached_tokens ?? found?.prompt_tokens_details?.cached_tokens ?? found?.cached_tokens), total_tokens: valid(found?.total_tokens)};
  return {usageState: Object.values(normalized).some(value => value !== null) ? 'known' : 'unknown', usage: normalized,
    usageRaw: found ? json(found) : null, responseId: typeof responseId === 'string' ? responseId.slice(0, 240) : null};
}
const emptyUsage = state => ({usageState: state, usage: {input_tokens: null, output_tokens: null, cached_tokens: null, total_tokens: null}, usageRaw: null, responseId: null});
function retryAfterMs(response) { const value = response.headers?.get?.('retry-after'); if (!value) return null; const seconds = Number(value); const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - Date.now(); return Number.isFinite(delay) && delay >= 0 ? Math.round(delay) : null; }
function makeReceipt(attempt, fields) { return {schemaVersion: 1, attemptId: attempt.id, poolId: attempt.poolId, seq: attempt.seq,
  leaseToken: attempt.leaseToken,
  logicalRequestId: attempt.logicalRequestId, retryOf: attempt.retryOf, stage: attempt.stage, scope: attempt.scope,
  bodySha256: attempt.bodySha256, requestFingerprint: attempt.requestFingerprint, model: attempt.model,
  queuedAt: attempt.queuedAt, sendingAt: attempt.sendingAt || null, finishedAt: now(), httpStatus: null, providerRequestId: null,
  rawResponseSha256: null, rawResponseBytes: 0, bodyComplete: false, ...emptyUsage('unknown'), ...fields}; }
async function finalize(roots, id, token, receipt, hook) {
  const serialized = JSON.stringify(receipt) + '\n'; await immutable(attemptPath(roots, id, 'receipt.json'), serialized);
  await hook?.({receipt});
  return withArkExecutionStoreLock(roots, async () => {
    const state = await readState(roots), attempt = state.attempts[id]; own(attempt, token);
    if (terminal.has(attempt.status)) { if (canonical(attempt.receipt) !== canonical(receipt)) throw fail('ARK_IMMUTABLE_CONFLICT', 'Ark 终态回执冲突', 409); return attempt.receipt; }
    attempt.status = receipt.status; attempt.receipt = receipt; attempt.receiptSha256 = hash(serialized); attempt.finishedAt = receipt.finishedAt;
    if (receipt.retryAfterMs != null) state.notBefore = Math.max(state.notBefore, Date.now() + receipt.retryAfterMs);
    await commit(state, roots); return structuredClone(receipt);
  });
}
async function recoverIn(state, roots) {
  let changed = false;
  for (const attempt of Object.values(state.attempts)) {
    if (terminal.has(attempt.status)) continue;
    const persisted = await optional(attemptPath(roots, attempt.id, 'receipt.json'));
    if (persisted) {
      const receipt = JSON.parse(persisted);
      if (receipt.attemptId !== attempt.id || receipt.bodySha256 !== attempt.bodySha256 || receipt.requestFingerprint !== attempt.requestFingerprint || receipt.leaseToken !== attempt.leaseToken || receipt.poolId !== state.poolId || !terminal.has(receipt.status)) throw fail('ARK_RECEIPT_CORRUPT', 'Ark 回执与物理请求绑定不一致');
      attempt.status = receipt.status; attempt.receipt = receipt; attempt.receiptSha256 = hash(persisted); attempt.finishedAt = receipt.finishedAt;
      if (receipt.retryAfterMs != null) state.notBefore = Math.max(state.notBefore, Date.parse(receipt.finishedAt) + receipt.retryAfterMs);
      changed = true; continue;
    }
    if (await isJobOwnerAlive(attempt.owner)) continue;
    const receipt = makeReceipt(attempt, {status: attempt.status === 'queued' ? 'failed' : 'unknown_sent',
      ...emptyUsage(attempt.status === 'queued' ? 'not_sent' : 'unknown'), error: {code: attempt.status === 'queued' ? 'ARK_OWNER_EXITED_BEFORE_SEND' : 'ARK_ATTEMPT_UNKNOWN_SENT', message: '请求所属进程已退出；未确认发送结果不得自动重发'}});
    const raw = JSON.stringify(receipt) + '\n'; await immutable(attemptPath(roots, attempt.id, 'receipt.json'), raw);
    attempt.status = receipt.status; attempt.receipt = receipt; attempt.receiptSha256 = hash(raw); attempt.finishedAt = receipt.finishedAt; changed = true;
  }
  return changed;
}
export async function recoverArkExecutions(args = {}) { await initializeArkExecutionStore(args); const roots = rootsOf(args); return withArkExecutionStoreLock(roots, async () => { const state = await readState(roots); if (await recoverIn(state, roots)) await commit(state, roots); return summary(state); }); }
export async function noteArkCooldown(delayMs, args = {}) {
  if (!Number.isFinite(delayMs) || delayMs < 0) throw fail('ARK_COOLDOWN_INVALID', 'Ark 共享退避时间无效', 400);
  await initializeArkExecutionStore(args); const roots = rootsOf(args);
  return withArkExecutionStoreLock(roots, async () => { const state = await readState(roots); state.notBefore = Math.max(state.notBefore, Date.now() + Math.ceil(delayMs)); await commit(state, roots); return {poolId: state.poolId, notBefore: state.notBefore}; });
}
function aborted(signal) { const reason = signal?.reason; return reason instanceof Error ? reason : Object.assign(new Error(typeof reason === 'string' ? reason : 'Ark request aborted'), {name: 'AbortError'}); }
// DOMException.code and frozen provider errors cannot be annotated in place.
function attemptError(cause, fields = {}) {
  const error = new Error(cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'Ark attempt failed', {cause});
  if (typeof cause?.name === 'string') error.name = cause.name;
  if (typeof cause?.code === 'string') error.code = cause.code;
  if (Number.isFinite(cause?.status)) error.status = cause.status;
  return Object.assign(error, fields);
}
function deadlineBudget(value, field) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw fail('ARK_DEADLINE_INVALID', `${field} must be a positive bounded millisecond integer`, 400);
  return value;
}
async function abortable(promise, signal) {
  if (signal?.aborted) throw aborted(signal);
  let listener;
  try { return await Promise.race([promise, new Promise((_, reject) => { listener = () => reject(aborted(signal)); signal?.addEventListener('abort', listener, {once: true}); })]); }
  finally { signal?.removeEventListener('abort', listener); }
}
async function wait(ms, signal) {
  if (signal?.aborted) throw aborted(signal); let timer, listener;
  try { await new Promise((done, reject) => { timer = setTimeout(done, ms); listener = () => reject(aborted(signal)); signal?.addEventListener('abort', listener, {once: true}); }); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', listener); }
}
/** One call records one physical send. Retry is a new call and a new FIFO ticket. */
export async function executeArkAttempt(args) {
  if (typeof args.transport !== 'function' || typeof args.consumeResponse !== 'function') throw fail('ARK_TRANSPORT_INVALID', 'Ark 传输与完整响应消费者缺失', 400);
  const queueTimeoutMs = deadlineBudget(args.queueTimeoutMs, 'queueTimeoutMs'), responseTimeoutMs = deadlineBudget(args.responseTimeoutMs, 'responseTimeoutMs');
  const roots = rootsOf(args), body = json(args.body), scope = persistedScope(args.scope), bodyBytes = Buffer.from(JSON.stringify(body));
  const logicalRequestId = args.logicalRequestId || `l${randomUUID()}`;
  if (typeof logicalRequestId !== 'string' || !logicalRequestId || logicalRequestId.length > 500 || /[\x00-\x1f]/.test(logicalRequestId)) throw fail('ARK_REQUEST_ID_INVALID', 'Ark 逻辑请求身份无效', 400);
  if (args.retryOf != null) assertId(args.retryOf);
  await initializeArkExecutionStore(args); const owner = await createJobOwner(), id = 'a' + randomUUID().replaceAll('-', ''), token = randomUUID();
  let attempt = await withArkExecutionStoreLock(roots, async () => {
    const state = await readState(roots); if (await recoverIn(state, roots)) await commit(state, roots);
    const requestFingerprint = hash(canonical({poolId: roots.poolId, body, scope, stage: args.stage || scope.stage || 'responses'}));
    const row = {id, poolId: roots.poolId, seq: state.nextSeq++, status: 'queued', owner, leaseToken: token,
      logicalRequestId, retryOf: args.retryOf || null, stage: args.stage || scope.stage || 'responses', scope: metadataScope(scope),
      model: typeof body.model === 'string' ? body.model : null, bodySha256: hash(bodyBytes), requestFingerprint, queuedAt: now(), queueTimeoutMs, responseTimeoutMs};
    const request = {schemaVersion: 1, attemptId: id, poolId: roots.poolId, status: 'queued', seq: row.seq, queuedAt: row.queuedAt, owner, leaseToken: token,
      bodySha256: row.bodySha256, requestFingerprint, logicalRequestId, retryOf: row.retryOf, stage: row.stage, scope, body, queueTimeoutMs, responseTimeoutMs};
    const requestBytes = JSON.stringify(request) + '\n'; row.requestSha256 = hash(requestBytes);
    await immutable(attemptPath(roots, id, 'body.json'), bodyBytes);
    await immutable(attemptPath(roots, id, 'request.json'), requestBytes);
    state.attempts[id] = row; await commit(state, roots); return structuredClone(row);
  });
  let sending = false, response = null, raw = Buffer.alloc(0), complete = false, rawPersisted = false, consumerError = null, responseTimer = null, cancelListener = null, responseController = null;
  const queueDeadline = queueTimeoutMs === null ? null : Date.parse(attempt.queuedAt) + queueTimeoutMs;
  const checkQueued = () => { if (args.signal?.aborted) throw aborted(args.signal); if (queueDeadline !== null && Date.now() >= queueDeadline) throw fail('ARK_QUEUE_TIMEOUT', 'Ark 排队期限已到，此请求未发送', 408); };
  try {
    await args.faultHooks?.afterQueued?.({attempt});
    for (;;) {
      checkQueued();
      const claim = await withArkExecutionStoreLock(roots, async () => {
        const state = await readState(roots); const changed = await recoverIn(state, roots); const current = state.attempts[id]; own(current, token);
        if (current.status !== 'queued') throw fail('ARK_ATTEMPT_FENCED', 'Ark 请求已不在待发送阶段', 409);
        const first = Object.values(state.attempts).filter(item => item.status === 'queued').sort((a, b) => a.seq - b.seq)[0];
        const slots = Object.values(state.attempts).filter(item => active.has(item.status)).length;
        if (Object.values(state.attempts).filter(item => item.status === 'unknown_sent').length >= state.policy.concurrency) {
          if (changed) await commit(state, roots);
          throw fail('ARK_EXECUTION_BLOCKED', 'Ark 项目请求池已被未确认发送占满，须人工核对后再执行', 409);
        }
        if (first?.id !== id || slots >= state.policy.concurrency || state.notBefore > Date.now()) { if (changed) await commit(state, roots); return {wait: Math.min(250, Math.max(50, state.notBefore - Date.now()))}; }
        checkQueued();
        await args.faultHooks?.beforeSending?.({attempt: current});
        checkQueued();
        current.status = 'sending'; current.sendingAt = now(); await commit(state, roots);
        attempt = structuredClone(current); sending = true;
        await immutable(attemptPath(roots, id, 'sending.json'), JSON.stringify({attemptId: id, leaseToken: token, owner, sendingAt: current.sendingAt}) + '\n');
        return {attempt: structuredClone(current)};
      });
      if (claim.attempt) { attempt = claim.attempt; sending = true; break; }
      await wait(queueDeadline === null ? claim.wait : Math.min(claim.wait, Math.max(1, queueDeadline - Date.now())), args.signal);
    }
    // Response time starts at the durable sending transition, never while queued.
    responseController = new AbortController();
    cancelListener = () => responseController.abort(aborted(args.signal));
    args.signal?.addEventListener('abort', cancelListener, {once: true});
    if (args.signal?.aborted) cancelListener();
    if (responseTimeoutMs !== null) {
      const remaining = Date.parse(attempt.sendingAt) + responseTimeoutMs - Date.now();
      const timeout = () => responseController.abort(fail('ARK_RESPONSE_TIMEOUT', 'Ark 实际发送后的响应期限已到，发送结果未知', 408));
      if (remaining <= 0) timeout(); else responseTimer = setTimeout(timeout, remaining);
    }
    const responseSignal = responseController.signal;
    await abortable(Promise.resolve().then(() => args.faultHooks?.afterSending?.({attempt})), responseSignal);
    if (responseSignal.aborted) throw aborted(responseSignal);
    response = await abortable(Promise.resolve().then(() => args.transport({body, signal: responseSignal, attemptId: id})), responseSignal);
    if (!response || typeof response.status !== 'number' || typeof response.headers?.get !== 'function') throw fail('ARK_RESPONSE_INVALID', 'Ark 传输未返回可验证响应');
    const chunks = [];
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const cancel = () => { reader.cancel(aborted(responseSignal)).catch(() => {}); };
      responseSignal.addEventListener('abort', cancel, {once: true});
      try {
        for (;;) {
          if (responseSignal.aborted) throw aborted(responseSignal);
          const part = await abortable(reader.read(), responseSignal); if (responseSignal.aborted) throw aborted(responseSignal);
          if (part.done) break; const chunk = Buffer.from(part.value); chunks.push(chunk); await args.onRawChunk?.(chunk);
        }
        raw = Buffer.concat(chunks);
      }
      catch (error) { raw = Buffer.concat(chunks); await reader.cancel(error).catch(() => {}); throw error; }
      finally { responseSignal.removeEventListener('abort', cancel); reader.releaseLock(); }
    } else raw = Buffer.from(await abortable(response.arrayBuffer(), responseSignal));
    complete = true;
    clearTimeout(responseTimer); responseTimer = null;
    await immutable(attemptPath(roots, id, 'raw-response.bin'), raw);
    rawPersisted = true;
    await args.faultHooks?.afterRawPersisted?.({attempt, rawResponseSha256: hash(raw)});
    const buffered = new Response([204, 205, 304].includes(response.status) ? null : raw, {status: response.status, statusText: response.statusText, headers: response.headers});
    let consumeResult;
    try { consumeResult = await args.consumeResponse(buffered, {rawBody: raw, rawText: raw.toString('utf8'), attemptId: id}); }
    catch (error) { consumerError = error; }
    const receipt = makeReceipt(attempt, {status: response.status >= 200 && response.status < 300 && !consumerError ? 'confirmed' : 'failed',
      httpStatus: response.status, bodyComplete: true, rawResponseSha256: hash(raw), rawResponseBytes: raw.length,
      providerRequestId: response.headers.get('x-request-id') || response.headers.get('request-id') || response.headers.get('x-tt-logid') || null,
      retryAfterMs: response.status === 429 || response.status >= 500 ? retryAfterMs(response) : null,
      ...usageOf(raw, consumeResult), ...(consumerError ? {error: {code: 'ARK_CONSUMER_FAILED', message: '响应已完整保存，但消费或解析失败'}} : {})});
    const published = await finalize(roots, id, token, receipt, args.faultHooks?.afterReceiptPersisted);
    if (consumerError) throw attemptError(consumerError, {code: typeof consumerError.code === 'string' ? consumerError.code : 'ARK_CONSUMER_FAILED', arkAttemptReceipt: published, safeToRetry: false});
    return {consumeResult, receipt: published};
  } catch (error) {
    if (error?.arkAttemptReceipt) throw error;
    const persisted = await optional(attemptPath(roots, id, 'receipt.json')).catch(() => null);
    if (persisted) throw attemptError(error, {arkAttemptReceipt: JSON.parse(persisted), code: 'ARK_ATTEMPT_COMMIT_FAILED', safeToRetry: false});
    if (raw.length && !complete) { try { await immutable(attemptPath(roots, id, 'raw-response.bin'), raw); rawPersisted = true; } catch { /* An unavailable raw artifact must not get a receipt SHA reference. */ } }
    const receipt = makeReceipt(attempt, {status: sending ? 'unknown_sent' : 'failed', ...emptyUsage(sending ? 'unknown' : 'not_sent'),
      httpStatus: response?.status || null, bodyComplete: false, rawResponseSha256: rawPersisted ? hash(raw) : null, rawResponseBytes: rawPersisted ? raw.length : 0,
      error: {code: sending ? 'ARK_ATTEMPT_UNKNOWN_SENT' : error?.code === 'ARK_QUEUE_TIMEOUT' ? error.code : args.signal?.aborted ? 'ARK_ABORTED_BEFORE_SEND' : error?.code === 'ARK_EXECUTION_BLOCKED' ? error.code : 'ARK_NOT_SENT',
        ...(error?.code === 'ARK_RESPONSE_TIMEOUT' ? {reasonCode: error.code, timeoutPhase: 'response'} : error?.code === 'ARK_QUEUE_TIMEOUT' ? {timeoutPhase: 'queue'} : {}),
        message: sending ? '发送后结果未确认，保留未知在途名额且禁止自动重发' : error?.code === 'ARK_EXECUTION_BLOCKED' ? '未知发送占满请求池，此请求未发送' : '未发送此请求'}});
    const wrapped = attemptError(error, {code: sending ? 'ARK_ATTEMPT_UNKNOWN_SENT' : typeof error?.code === 'string' ? error.code : receipt.error.code, safeToRetry: false});
    try { wrapped.arkAttemptReceipt = await finalize(roots, id, token, receipt); } catch (cause) { wrapped.persistenceError = cause?.code || 'ARK_PERSISTENCE_FAILED'; }
    throw wrapped;
  } finally {
    clearTimeout(responseTimer); args.signal?.removeEventListener('abort', cancelListener);
  }
}
function summary(state, jobRunId) {
  const all = Object.values(state.attempts).sort((a, b) => a.seq - b.seq), attempts = all.filter(row => !jobRunId || row.scope.jobRunId === jobRunId);
  const counts = {queued: 0, sending: 0, confirmed: 0, failed: 0, unknown_sent: 0, abandoned: 0, notSent: 0};
  const usageTotals = {input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0}, knownFieldCounts = Object.fromEntries(Object.keys(usageTotals).map(key => [key, 0]));
  let unknownUsageAttempts = 0;
  for (const row of attempts) {
    counts[row.status]++;
    if (row.receipt?.usageState === 'not_sent') counts.notSent++;
    else if (row.receipt?.usageState === 'unknown' || row.status === 'sending') unknownUsageAttempts++;
    for (const key of Object.keys(usageTotals)) if (Number.isSafeInteger(row.receipt?.usage?.[key])) { usageTotals[key] += row.receipt.usage[key]; knownFieldCounts[key]++; }
  }
  return {schemaVersion: 1, initialized: true, poolId: state.poolId, revision: state.revision, policy: {...state.policy}, notBefore: state.notBefore,
    activeCount: all.filter(row => active.has(row.status)).length, blockedUnknownCount: all.filter(row => row.status === 'unknown_sent').length,
    attemptCount: attempts.length, physicalSendCount: attempts.filter(row => row.sendingAt).length, counts, usageTotals, knownFieldCounts, unknownUsageAttempts,
    attempts: structuredClone(attempts)};
}
/** Metadata-only: no payload or raw-response files are read and no recovery mutates GET. */
export async function readArkExecutionSummary(args = {}) { const roots = rootsOf(args), state = await readState(roots); return state ? summary(state, args.jobRunId) : {schemaVersion: 1, initialized: false, poolId: roots.poolId, attemptCount: 0, attempts: []}; }
export async function readArkAttempt(args) {
  assertId(args.attemptId); const roots = rootsOf(args), state = await readState(roots), attempt = state?.attempts[args.attemptId];
  if (!attempt) throw fail('ARK_ATTEMPT_NOT_FOUND', 'Ark 物理请求不存在', 404);
  const requestBytes = await bytes(attemptPath(roots, attempt.id, 'request.json')), request = JSON.parse(requestBytes), body = await bytes(attemptPath(roots, attempt.id, 'body.json'));
  if (hash(requestBytes) !== attempt.requestSha256 || hash(body) !== attempt.bodySha256 || request.bodySha256 !== attempt.bodySha256 || request.requestFingerprint !== attempt.requestFingerprint || hash(canonical({poolId: roots.poolId, body: request.body, scope: request.scope, stage: request.stage})) !== attempt.requestFingerprint)
    throw fail('ARK_REQUEST_HASH_MISMATCH', 'Ark 请求内容校验失败');
  const receiptBytes = await optional(attemptPath(roots, attempt.id, 'receipt.json')), receipt = receiptBytes ? JSON.parse(receiptBytes) : null;
  if (receipt && (receipt.attemptId !== attempt.id || receipt.bodySha256 !== attempt.bodySha256 || attempt.receiptSha256 && hash(receiptBytes) !== attempt.receiptSha256)) throw fail('ARK_RECEIPT_CORRUPT', 'Ark 回执校验失败');
  let rawResponse = null;
  if (args.includeRaw !== false && receipt?.rawResponseSha256) { rawResponse = await bytes(attemptPath(roots, attempt.id, 'raw-response.bin')); if (hash(rawResponse) !== receipt.rawResponseSha256) throw fail('ARK_RESPONSE_HASH_MISMATCH', 'Ark 原始响应校验失败'); }
  return {attempt: structuredClone(attempt), request, receipt, rawResponse};
}

/**
 * 账户池并发上限的**留痕变更**。
 *
 * 为什么需要：上限决定「多少笔未知发送就会堵死整个池」。上限 2 时，一次中止留下的
 * 两笔未知就能让后续每次审阅都被 ARK_EXECUTION_BLOCKED 拒绝（2026-10-13 反复发生）。
 * 但静默改上限会削弱这条安全约束，所以只提供这一条显式通道：
 *   真人授权证据 + 不可变事件文件 + 账本原子提交 + CAS 版本比较；
 * 环境变量或 `policy` 参数与已登记值不一致时，initializeArkExecutionStore 仍然
 * 抛 ARK_POLICY_CONFLICT —— 改动只能从这里发生。
 */
const HUMAN_POLICY_STATEMENT = '我确认变更本项目 Ark 请求并发上限';
function policyChangeInput(args) {
  const policy = json(args.policy), auth = json(args.humanAuthorization);
  if (!policy || Array.isArray(policy) || Object.keys(policy).some(key => !['concurrency', 'reason'].includes(key))
      || !Number.isInteger(policy.concurrency) || policy.concurrency < 1 || policy.concurrency > 32
      || typeof policy.reason !== 'string' || !policy.reason.trim() || policy.reason.length > 500 || /[\u0000-\u001f]/.test(policy.reason))
    throw fail('ARK_POLICY_CHANGE_INVALID', '并发上限变更必须给出 1–32 的整数与不超过 500 字的变更理由', 400);
  if (!uuidPattern.test(args.operationId || '') || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0
      || !/^[a-f0-9]{64}$/.test(args.expectedLedgerSha256 || ''))
    throw fail('ARK_POLICY_CHANGE_INVALID', '并发上限变更缺少操作身份、稳定账本版本或原字节摘要', 400);
  if (!auth || Array.isArray(auth) || Object.keys(auth).some(key => !['schemaVersion', 'actorType', 'statement', 'evidenceRef', 'evidenceSha256'].includes(key))
      || auth.schemaVersion !== 1 || auth.actorType !== 'human' || auth.statement !== HUMAN_POLICY_STATEMENT
      || typeof auth.evidenceRef !== 'string' || !auth.evidenceRef || auth.evidenceRef.length > 1000 || /[\u0000-\u001f]/.test(auth.evidenceRef)
      || !/^[a-f0-9]{64}$/.test(auth.evidenceSha256 || ''))
    throw fail('ARK_HUMAN_AUTHORIZATION_INVALID', '须记录真人明确授权变更请求并发上限的原始证据', 400);
  // 归一化后的请求要能被 policyChangeInput 再次校验（事件重放时会这么做），
  // 所以 reason 留在 policy 里，而不是提到外层。
  return {schemaVersion: 1, operationId: args.operationId, policy: {concurrency: policy.concurrency, reason: policy.reason.trim()},
    expectedRevision: args.expectedRevision, expectedLedgerSha256: args.expectedLedgerSha256, humanAuthorization: auth};
}
function checkPolicyLink(indexed, ref) {
  if (!ref || ref.schemaVersion !== 1 || !uuidPattern.test(ref.operationId || '') || ref.eventFile !== `policies/${ref.operationId}.json`
      || !/^[a-f0-9]{64}$/.test(ref.eventSha256 || '') || !/^[a-f0-9]{64}$/.test(ref.requestFingerprint || '') || !indexed
      || indexed.eventFile !== ref.eventFile || indexed.eventSha256 !== ref.eventSha256 || indexed.requestFingerprint !== ref.requestFingerprint)
    throw fail('ARK_POLICY_CORRUPT', '并发上限变更缺少不可变事件绑定');
}
async function policyEvent(roots, ref) {
  const raw = await bytes(join(roots.poolRoot, ref.eventFile));
  if (hash(raw) !== ref.eventSha256) throw fail('ARK_POLICY_CORRUPT', '并发上限变更事件摘要不匹配');
  let event; try { event = JSON.parse(raw); } catch (cause) { throw fail('ARK_POLICY_CORRUPT', '并发上限变更事件损坏', 500, cause); }
  if (event.schemaVersion !== 1 || event.kind !== 'human-policy-change-project-account-concurrency' || event.poolId !== roots.poolId
      || event.operationId !== ref.operationId || event.requestFingerprint !== ref.requestFingerprint
      || hash(canonical(event.request)) !== event.requestFingerprint || !Number.isInteger(event.afterConcurrency)
      || !Number.isInteger(event.previousConcurrency) || event.originalPolicyUnchanged !== false)
    throw fail('ARK_POLICY_CORRUPT', '并发上限变更事件身份不一致');
  const input = policyChangeInput({...event.request});
  if (canonical(input) !== canonical(event.request) || event.expectedAfterRevision !== input.expectedRevision + 1
      || event.afterConcurrency !== input.policy.concurrency || typeof event.createdAt !== 'string')
    throw fail('ARK_POLICY_CORRUPT', '并发上限变更事件授权或版本边界不一致');
  return event;
}
/** 当前生效上限必须等于**最后一次**留痕变更的目标值：手改账本字段会在读取时被发现。 */
async function verifyPolicies(roots, state) {
  const entries = Object.entries(state.policies || {});
  if (!entries.length) return state;
  let latest = null;
  for (const [operationId, indexed] of entries) {
    const ref = {schemaVersion: 1, operationId, eventFile: indexed.eventFile, eventSha256: indexed.eventSha256, requestFingerprint: indexed.requestFingerprint};
    checkPolicyLink(indexed, ref);
    const event = await policyEvent(roots, ref);
    if (indexed.concurrency !== event.afterConcurrency || indexed.previousConcurrency !== event.previousConcurrency
        || state.revision < event.expectedAfterRevision)
      throw fail('ARK_POLICY_CORRUPT', '并发上限变更事件与账本提交不一致');
    if (!latest || event.expectedAfterRevision > latest.expectedAfterRevision) latest = event;
  }
  if (latest.afterConcurrency !== state.policy.concurrency)
    throw fail('ARK_POLICY_CORRUPT', '当前并发上限与最后一次留痕变更不一致');
  return state;
}
export async function setArkPoolConcurrency(args) {
  const input = policyChangeInput(args), roots = rootsOf(args), requestFingerprint = hash(canonical(input));
  return withArkExecutionStoreLock(roots, async () => {
    const ledgerBytes = await bytes(statePath(roots)), state = await readState(roots);
    if (!state) throw fail('ARK_ATTEMPT_NOT_FOUND', '目标账户池不存在', 404);
    const file = `policies/${input.operationId}.json`, previous = await optional(join(roots.poolRoot, file));
    let event;
    if (previous) {
      try { event = JSON.parse(previous); } catch (cause) { throw fail('ARK_POLICY_CORRUPT', '并发上限变更事件损坏', 500, cause); }
      if (event.poolId !== roots.poolId || event.operationId !== input.operationId || event.requestFingerprint !== requestFingerprint || canonical(event.request) !== canonical(input))
        throw fail('ARK_POLICY_CHANGE_OPERATION_CONFLICT', '同一操作不能更换并发上限或授权证据', 409);
      if (state.policies?.[input.operationId] && state.policy.concurrency === event.afterConcurrency) {
        await policyEvent(roots, {schemaVersion: 1, operationId: input.operationId, eventFile: file, eventSha256: hash(previous), requestFingerprint});
        return {schemaVersion: 1, replayed: true, poolId: roots.poolId, operationId: input.operationId, previousConcurrency: event.previousConcurrency,
          concurrency: event.afterConcurrency, revision: state.revision, ledgerSha256: hash(ledgerBytes)};
      }
    }
    if (state.revision !== input.expectedRevision || hash(ledgerBytes) !== input.expectedLedgerSha256)
      throw fail('ARK_POLICY_CHANGE_STALE', '账户池记录已变化，并发上限变更未执行', 409);
    const inFlight = Object.values(state.attempts).filter(item => item.status === 'sending' || item.status === 'queued').length;
    if (inFlight) throw fail('ARK_POLICY_CHANGE_BUSY', '仍有请求在途或排队，此时不能变更并发上限', 409);
    const previousConcurrency = state.policy.concurrency;
    if (input.policy.concurrency === previousConcurrency)
      throw fail('ARK_POLICY_CHANGE_INVALID', '目标并发上限与当前一致，无需变更', 409);
    if (event && (event.expectedAfterRevision !== state.revision + 1 || event.previousConcurrency !== previousConcurrency
        || canonical(event.request) !== canonical(input)))
      throw fail('ARK_POLICY_CORRUPT', '待提交的并发上限变更事件与原有请求不一致');
    event ||= {schemaVersion: 1, kind: 'human-policy-change-project-account-concurrency', poolId: roots.poolId, operationId: input.operationId,
      request: input, requestFingerprint, createdAt: now(), expectedAfterRevision: state.revision + 1,
      previousConcurrency, afterConcurrency: input.policy.concurrency, originalPolicyUnchanged: false};
    const eventBytes = previous || Buffer.from(JSON.stringify(event) + '\n');
    const ref = {schemaVersion: 1, operationId: input.operationId, eventFile: file, eventSha256: hash(eventBytes), requestFingerprint};
    await immutable(join(roots.poolRoot, file), eventBytes);
    await args.faultHooks?.afterPolicyChangeEventPersisted?.({event: structuredClone(event)});
    state.policies ||= {};
    state.policies[input.operationId] = {...ref, concurrency: event.afterConcurrency, previousConcurrency: event.previousConcurrency};
    state.policy = {...state.policy, concurrency: event.afterConcurrency};
    await args.faultHooks?.beforePolicyChangeLedgerCommit?.();
    await commit(state, roots);
    return {schemaVersion: 1, replayed: false, poolId: roots.poolId, operationId: input.operationId, previousConcurrency,
      concurrency: event.afterConcurrency, event: ref, revision: state.revision, ledgerSha256: hash(await bytes(statePath(roots)))};
  });
}
const HUMAN_ABANDON_STATEMENT = '确认放弃旧结果，允许重新审核';
function abandonmentInput(args) {
  const ids = json(args.attemptIds), auth = json(args.humanAuthorization);
  if (!Array.isArray(ids) || !ids.length || ids.length > 32 || new Set(ids).size !== ids.length || ids.some(id => !idPattern.test(id)))
    throw fail('ARK_ABANDON_INPUT_INVALID', '人工放弃必须明确列出不重复的物理请求身份', 400);
  if (!uuidPattern.test(args.operationId || '') || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || !/^[a-f0-9]{64}$/.test(args.expectedLedgerSha256 || ''))
    throw fail('ARK_ABANDON_INPUT_INVALID', '人工放弃缺少操作身份、稳定账本版本或原字节摘要', 400);
  if (!auth || Array.isArray(auth) || Object.keys(auth).some(k => !['schemaVersion','actorType','statement','evidenceRef','evidenceSha256'].includes(k)) || auth.schemaVersion !== 1 || auth.actorType !== 'human'
      || auth.statement !== HUMAN_ABANDON_STATEMENT || typeof auth.evidenceRef !== 'string' || !auth.evidenceRef || auth.evidenceRef.length > 1000 || /[\u0000-\u001f]/.test(auth.evidenceRef) || !/^[a-f0-9]{64}$/.test(auth.evidenceSha256 || ''))
    throw fail('ARK_HUMAN_AUTHORIZATION_INVALID', '须记录真人明确放弃旧结果并允许重新审核的原始授权证据', 400);
  return {schemaVersion: 1, operationId: args.operationId, attemptIds: [...ids].sort(), expectedRevision: args.expectedRevision, expectedLedgerSha256: args.expectedLedgerSha256, humanAuthorization: auth};
}
function checkAbandonmentLink(attempt, state) {
  const ref = attempt.abandonment, indexed = state.abandonments?.[ref?.operationId];
  if (!ref || ref.schemaVersion !== 1 || !uuidPattern.test(ref.operationId || '') || ref.eventFile !== `abandonments/${ref.operationId}.json`
      || !/^[a-f0-9]{64}$/.test(ref.eventSha256 || '') || !/^[a-f0-9]{64}$/.test(ref.requestFingerprint || '') || !indexed
      || indexed.eventFile !== ref.eventFile || indexed.eventSha256 !== ref.eventSha256 || indexed.requestFingerprint !== ref.requestFingerprint || !indexed.attemptIds.includes(attempt.id))
    throw fail('ARK_ABANDONMENT_CORRUPT', '人工放弃终态缺少不可变事件绑定');
}
async function abandonmentEvent(roots, ref) {
  const raw = await bytes(join(roots.poolRoot, ref.eventFile));
  if (hash(raw) !== ref.eventSha256) throw fail('ARK_ABANDONMENT_CORRUPT', '人工放弃事件摘要不匹配');
  let event; try { event = JSON.parse(raw); } catch (cause) { throw fail('ARK_ABANDONMENT_CORRUPT', '人工放弃事件损坏', 500, cause); }
  if (event.schemaVersion !== 1 || event.kind !== 'human-abandon-unknown-results' || event.poolId !== roots.poolId || event.operationId !== ref.operationId
      || event.requestFingerprint !== ref.requestFingerprint || hash(canonical(event.request)) !== event.requestFingerprint || !Array.isArray(event.attempts))
    throw fail('ARK_ABANDONMENT_CORRUPT', '人工放弃事件身份不一致');
  const input = abandonmentInput({...event.request});
  if (canonical(input) !== canonical(event.request) || event.expectedAfterRevision !== input.expectedRevision + 1 || typeof event.createdAt !== 'string')
    throw fail('ARK_ABANDONMENT_CORRUPT', '人工放弃事件授权或版本边界不一致');
  return event;
}
async function verifyAbandonments(roots, state) {
  const seen = new Map();
  for (const attempt of Object.values(state.attempts)) {
    if (attempt.status !== 'abandoned') continue;
    checkAbandonmentLink(attempt, state); const ref = attempt.abandonment;
    if (!seen.has(ref.operationId)) seen.set(ref.operationId, await abandonmentEvent(roots, ref));
    const event = seen.get(ref.operationId), indexed = state.abandonments[ref.operationId];
    if (canonical(indexed.attemptIds) !== canonical(event.request.attemptIds) || state.revision < event.expectedAfterRevision
        || event.attempts.length !== event.request.attemptIds.length || new Set(event.attempts.map(a => a.attemptId)).size !== event.attempts.length)
      throw fail('ARK_ABANDONMENT_CORRUPT', '人工放弃事件与原子账本提交不一致');
    for (const row of event.attempts) {
      const actual = state.attempts[row.attemptId];
      if (!actual || actual.status !== 'abandoned' || actual.abandonment?.operationId !== event.operationId || actual.abandonment?.eventSha256 !== ref.eventSha256
          || row.beforeStatus !== 'unknown_sent' || row.afterStatus !== 'abandoned' || row.remoteCompletion !== 'unconfirmed'
          || row.bodySha256 !== actual.bodySha256 || row.requestFingerprint !== actual.requestFingerprint || row.requestSha256 !== actual.requestSha256 || row.originalReceiptSha256 !== actual.receiptSha256
          || actual.receipt?.status !== 'unknown_sent') throw fail('ARK_ABANDONMENT_CORRUPT', '人工放弃批次必须完整绑定原始未知回执');
    }
  }
  return state;
}
/** Explicit human abandonment releases only specified unknown slots; it never confirms a response or retries a request.
 * Immutable original receipt/body files remain unchanged. Decision first + one locked atomic ledger commit.
 * A crash before commit retains all unknown slots; only the same explicit operation can complete its pending decision.
 */
export async function abandonUnknownArkAttempts(args) {
  const input = abandonmentInput(args), roots = rootsOf(args), requestFingerprint = hash(canonical(input));
  return withArkExecutionStoreLock(roots, async () => {
    const ledgerBytes = await bytes(statePath(roots)), state = await readState(roots);
    if (!state) throw fail('ARK_ATTEMPT_NOT_FOUND', '人工放弃账户池不存在', 404);
    const file = `abandonments/${input.operationId}.json`, previous = await optional(join(roots.poolRoot, file));
    let event;
    if (previous) {
      try { event = JSON.parse(previous); } catch (cause) { throw fail('ARK_ABANDONMENT_CORRUPT', '人工放弃事件损坏', 500, cause); }
      if (event.poolId !== roots.poolId || event.operationId !== input.operationId || event.requestFingerprint !== requestFingerprint || canonical(event.request) !== canonical(input))
        throw fail('ARK_ABANDON_OPERATION_CONFLICT', '同一人工操作不能更换请求或授权证据', 409);
      const selected = input.attemptIds.map(id => state.attempts[id]);
      if (selected.every(a => a?.status === 'abandoned' && a.abandonment?.operationId === input.operationId)) {
        const ref = selected[0].abandonment; await abandonmentEvent(roots, ref);
        return {schemaVersion: 1, replayed: true, poolId: roots.poolId, operationId: input.operationId, attemptIds: input.attemptIds, status: 'abandoned', event: structuredClone(ref), revision: state.revision, ledgerSha256: hash(ledgerBytes), remoteCompletion: 'unconfirmed', automaticRetryAllowed: false};
      }
    }
    if (state.revision !== input.expectedRevision || hash(ledgerBytes) !== input.expectedLedgerSha256)
      throw fail('ARK_ABANDON_STALE', '账户池记录已变化，人工放弃未执行', 409);
    const attempts = [];
    for (const id of input.attemptIds) {
      const attempt = state.attempts[id];
      if (!attempt) throw fail('ARK_ATTEMPT_NOT_FOUND', '指定物理请求不存在', 404);
      if (attempt.status !== 'unknown_sent' || attempt.receipt?.status !== 'unknown_sent')
        throw fail('ARK_ABANDON_STATUS_INVALID', '只能人工放弃结果未知的终态请求；进行中或已确认请求不可放弃', 409);
      const saved = await readArkAttempt({...roots, attemptId: id, includeRaw: false});
      if (!saved.receipt || saved.attempt.receiptSha256 !== attempt.receiptSha256 || canonical(saved.receipt) !== canonical(attempt.receipt))
        throw fail('ARK_RECEIPT_CORRUPT', '原始未知回执不一致');
      attempts.push({attemptId: id, beforeStatus: 'unknown_sent', afterStatus: 'abandoned', remoteCompletion: 'unconfirmed', requestSha256: attempt.requestSha256, bodySha256: attempt.bodySha256, requestFingerprint: attempt.requestFingerprint, originalReceiptSha256: attempt.receiptSha256, originalUsageState: attempt.receipt.usageState, originalBodyComplete: attempt.receipt.bodyComplete});
    }
    if (event && (event.expectedAfterRevision !== state.revision + 1 || canonical(event.attempts) !== canonical(attempts)))
      throw fail('ARK_ABANDONMENT_CORRUPT', '待提交的人工放弃事件与原请求不一致');
    event ||= {schemaVersion: 1, kind: 'human-abandon-unknown-results', poolId: roots.poolId, operationId: input.operationId, request: input, requestFingerprint, createdAt: now(), expectedAfterRevision: state.revision + 1, attempts, originalPhysicalEvidenceOverwritten: false, remoteCompletion: 'unconfirmed', automaticRetryAllowed: false};
    const eventBytes = previous || Buffer.from(JSON.stringify(event) + '\n'), ref = {schemaVersion: 1, operationId: input.operationId, eventFile: file, eventSha256: hash(eventBytes), requestFingerprint};
    await immutable(join(roots.poolRoot, file), eventBytes); await args.faultHooks?.afterAbandonmentDecisionPersisted?.({event: structuredClone(event)});
    state.abandonments ||= {}; state.abandonments[input.operationId] = {...ref, attemptIds: input.attemptIds};
    for (const id of input.attemptIds) Object.assign(state.attempts[id], {status: 'abandoned', abandonment: {...ref}});
    await args.faultHooks?.beforeAbandonmentLedgerCommit?.(); await commit(state, roots);
    return {schemaVersion: 1, replayed: false, poolId: roots.poolId, operationId: input.operationId, attemptIds: input.attemptIds, status: 'abandoned', event: ref, revision: state.revision, ledgerSha256: hash(await bytes(statePath(roots))), remoteCompletion: 'unconfirmed', automaticRetryAllowed: false};
  });
}
