/** Atomic session manifests. DOCX bytes live only in immutable working versions. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, open, rename, unlink, realpath, lstat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.DSH_SESSION_ROOT || fileURLToPath(new URL('../data/sessions/', import.meta.url)));
const TRANSIENT = new Set([
  'buffer', 'originalBuffer', 'doc', '_zip', '_zipSrc', 'controller', 'reviewController',
  'applyingFixes', '_storeRevision', 'resumeTimer', 'reviewTimer', 'progressTimer',
  'streamTimer', 'evictionTimer', '_timers', '_activeReviewJob',
]);
const pending = new Map();
const activeOwnLocks = new Map();
const finishedOwnLocks = new Map();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const validId = (id) => typeof id === 'string' && /^s[a-z0-9]+$/.test(id);

function storeError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}
async function replaceManifest(temporary,target,faultHooks){
  const delays=[20,40,80,160,320];
  for(let attempt=0;;attempt++){
    try{
      await faultHooks?.beforeRenameAttempt?.({temporary,target,attempt});
      await rename(temporary,target);return;
    }catch(error){
      if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=delays.length)throw error;
      await new Promise(done=>setTimeout(done,delays[attempt]));
    }
  }
}

function assertId(sessionId) {
  if (!validId(sessionId)) throw storeError('SESSION_ID_INVALID', '会话存储身份无效');
}

function assertSnapshotIdentity(snapshot, sessionId) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot instanceof Map) {
    throw storeError('SESSION_SNAPSHOT_INVALID', '会话快照必须是对象');
  }
  if (snapshot.id != null && snapshot.id !== sessionId) throw storeError('SESSION_IDENTITY_MISMATCH', '会话快照不属于该会话');
  const version = snapshot.workVersion;
  const match = typeof version?.id === 'string' && /^([a-z0-9]+):v(\d{6,})-([a-f0-9]{64})$/.exec(version.id);
  const revision = match ? Number(match[2]) : NaN;
  if (!match || match[1] !== sessionId || !Number.isSafeInteger(revision)
    || version.id !== `${sessionId}:v${String(revision).padStart(6, '0')}-${match[3]}`
    || (version.sessionId != null && version.sessionId !== sessionId)) {
    throw storeError('SESSION_IDENTITY_MISMATCH', '工作版本引用不属于该会话或身份无效');
  }
}

/** All objects/arrays are typed nodes, so a normal object can never forge a Map. */
function encode(value, ancestors = new Set()) {
  if (value === undefined) return ['undefined'];
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN'];
    if (!Number.isFinite(value)) return ['number', value > 0 ? 'Infinity' : '-Infinity'];
    if (Object.is(value, -0)) return ['number', '-0'];
    return value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw storeError('SESSION_UNSERIALIZABLE', '会话快照含不可持久化内容或循环引用');
  ancestors.add(value);
  try {
    if (value instanceof Map) return ['map', [...value].map(([key, item]) => [encode(key, ancestors), encode(item, ancestors)])];
    if (Array.isArray(value)) return ['array', Array.from(value, (item) => encode(item, ancestors))];
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw storeError('SESSION_UNSERIALIZABLE', '会话快照含运行时对象');
    return ['object', Object.entries(value).map(([key, item]) => [key, encode(item, ancestors)])];
  } finally { ancestors.delete(value); }
}

function decode(node) {
  if (node === null || ['string', 'boolean', 'number'].includes(typeof node)) return node;
  if (!Array.isArray(node) || typeof node[0] !== 'string') throw storeError('SESSION_CORRUPT', '会话快照编码损坏');
  const [type, values] = node;
  if (type === 'undefined' && node.length === 1) return undefined;
  if (type === 'number' && node.length === 2 && ['NaN', 'Infinity', '-Infinity', '-0'].includes(values)) {
    return values === 'NaN' ? NaN : values === 'Infinity' ? Infinity : values === '-Infinity' ? -Infinity : -0;
  }
  if (node.length !== 2 || !Array.isArray(values)) throw storeError('SESSION_CORRUPT', '会话快照编码结构损坏');
  if (type === 'array') return values.map(decode);
  if (type === 'object') {
    const object = {};
    for (const entry of values) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || Object.hasOwn(object, entry[0])) {
        throw storeError('SESSION_CORRUPT', '会话快照对象字段损坏');
      }
      Object.defineProperty(object, entry[0], { value: decode(entry[1]), enumerable: true, writable: true, configurable: true });
    }
    return object;
  }
  if (type === 'map') {
    const map = new Map();
    for (const entry of values) {
      if (!Array.isArray(entry) || entry.length !== 2) throw storeError('SESSION_CORRUPT', '会话快照 Map 条目损坏');
      const key = decode(entry[0]);
      if (map.has(key)) throw storeError('SESSION_CORRUPT', '会话快照 Map 键重复');
      map.set(key, decode(entry[1]));
    }
    return map;
  }
  throw storeError('SESSION_CORRUPT', '会话快照编码类型未知');
}

async function sessionDirectory(storageRoot, sessionId, create = false) {
  assertId(sessionId);
  if (create) await mkdir(resolve(storageRoot), { recursive: true });
  const root = await realpath(resolve(storageRoot));
  const directory = join(root, sessionId);
  if (create) await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || relative(root, await realpath(directory)) !== sessionId) {
    throw storeError('SESSION_PATH_INVALID', '会话存储目录无效');
  }
  return directory;
}

function manifestOf(state) {
  return { schemaVersion: state.schemaVersion, sessionId: state.sessionId, revision: state.revision,
    savedAt: state.savedAt, payloadSha256: state.payloadSha256, manifestSha256: state.manifestSha256 };
}

function manifestHash(state) {
  return hash(JSON.stringify({ schemaVersion: state.schemaVersion, sessionId: state.sessionId,
    revision: state.revision, savedAt: state.savedAt, payloadSha256: state.payloadSha256 }));
}

async function readState(directory, sessionId) {
  const path = join(directory, 'state.json');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw storeError('SESSION_PATH_INVALID', '会话快照文件类型无效');
  let state;
  try { state = JSON.parse(await readFile(path, 'utf8')); }
  catch (err) {
    if (err.code === 'ENOENT') throw err;
    throw storeError('SESSION_CORRUPT', '会话快照 JSON 缺损或不可读取', err);
  }
  if (state?.schemaVersion !== 1 || state.sessionId !== sessionId || !Number.isSafeInteger(state.revision)
    || state.revision < 0 || typeof state.savedAt !== 'string' || !Object.hasOwn(state, 'payload')
    || !/^[a-f0-9]{64}$/.test(state.payloadSha256 || '') || !/^[a-f0-9]{64}$/.test(state.manifestSha256 || '')) {
    throw storeError('SESSION_IDENTITY_MISMATCH', '会话快照身份、格式或序号不一致');
  }
  if (state.payloadSha256 !== hash(JSON.stringify(state.payload)) || state.manifestSha256 !== manifestHash(state)) {
    throw storeError('SESSION_HASH_MISMATCH', '会话快照校验失败');
  }
  const snapshot = decode(state.payload);
  assertSnapshotIdentity(snapshot, sessionId);
  return { snapshot, manifest: manifestOf(state) };
}

/** Exclusive lock also protects expectedRevision across different processes. */
async function lockDirectory(directory) {
  const path = join(directory, 'state.lock');
  const recoveryPath = join(directory, 'state.recover.lock');
  const token = randomUUID();
  try {
    await lstat(recoveryPath);
    throw storeError('SESSION_BUSY', '另一个进程正在恢复会话存储锁');
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const take = async () => {
    const file = await open(path, 'wx');
    activeOwnLocks.set(path, token);
    finishedOwnLocks.delete(path);
    try { await file.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, token })); await file.sync(); }
    finally { await file.close(); }
  };
  try { await take(); }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let owner;
    try { owner = JSON.parse(await readFile(path, 'utf8')); }
    catch (cause) { throw storeError('SESSION_BUSY', '会话存储锁未完成或损坏，请检查保存状态', cause); }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') {
      throw storeError('SESSION_BUSY', '会话存储锁身份无效');
    }
    let dead = false;
    try { process.kill(owner.pid, 0); } catch (cause) { dead = cause.code === 'ESRCH'; }
    const endedOwn = owner.pid === process.pid && finishedOwnLocks.get(path) === owner.token
      && activeOwnLocks.get(path) !== owner.token;
    if (!dead && !endedOwn) throw storeError('SESSION_BUSY', '另一个进程正在保存会话快照');
    // Serialize stale recovery too, so two recovering processes cannot remove
    // each other's freshly acquired live lock. A live owner is never age-expired.
    let recovery;
    try { recovery = await open(recoveryPath, 'wx'); }
    catch (cause) { throw storeError('SESSION_BUSY', '另一个进程正在恢复会话存储锁', cause); }
    try {
      await recovery.writeFile(JSON.stringify({ pid: process.pid, token })); await recovery.sync();
      const current = JSON.parse(await readFile(path, 'utf8'));
      if (current.pid !== owner.pid || current.token !== owner.token) throw storeError('SESSION_BUSY', '会话存储锁已变化');
      if (endedOwn && (finishedOwnLocks.get(path) !== current.token || activeOwnLocks.get(path) === current.token)) {
        throw storeError('SESSION_BUSY', '会话存储锁仍属于活跃保存操作');
      }
      await unlink(path);
      try { await take(); } catch (cause) { throw storeError('SESSION_BUSY', '会话快照存储锁已被其他进程取得', cause); }
    } finally {
      await recovery.close();
      await unlink(recoveryPath);
    }
  }
  return async () => {
    try {
      let current;
      try { current = JSON.parse(await readFile(path, 'utf8')); }
      catch (err) { if (err.code === 'ENOENT') return; throw err; }
      if (current.token !== token) throw storeError('SESSION_LOCK_CHANGED', '会话存储锁身份已变化');
      await unlink(path);
      finishedOwnLocks.delete(path);
    } catch (err) {
      finishedOwnLocks.set(path, token);
      throw err;
    } finally {
      if (activeOwnLocks.get(path) === token) activeOwnLocks.delete(path);
    }
  };
}

async function saveCaptured({ sessionId, payload, expectedRevision, storageRoot, faultHooks }) {
  const directory = await sessionDirectory(storageRoot, sessionId, true);
  const release = await lockDirectory(directory);
  let temporary;
  let committedManifest;
  let operationError;
  try {
    let previous = null;
    try { previous = await readState(directory, sessionId); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const currentRevision = previous?.manifest.revision ?? -1;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      const error = storeError('SESSION_REVISION_CONFLICT', '会话快照已变化，拒绝覆盖较新状态');
      error.currentRevision = currentRevision;
      throw error;
    }
    const state = { schemaVersion: 1, sessionId, revision: currentRevision + 1,
      savedAt: new Date().toISOString(), payloadSha256: hash(JSON.stringify(payload)), payload };
    state.manifestSha256 = manifestHash(state);
    temporary = join(directory, `state.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx');
    try { await file.writeFile(`${JSON.stringify(state, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    // Same-directory rename replaces the existing file atomically on Windows.
    // Never delete the previous state to work around sharing/permission errors.
    await replaceManifest(temporary, join(directory, 'state.json'),faultHooks);
    temporary = null;
    const checked = await readState(directory, sessionId);
    if (checked.manifest.manifestSha256 !== state.manifestSha256) throw storeError('SESSION_HASH_MISMATCH', '提交后会话快照校验不一致');
    committedManifest = checked.manifest;
    // Narrow trusted test hook for the rename-to-release crash boundary.
    if (faultHooks?.afterRename) await faultHooks.afterRename({ directory, manifest: { ...committedManifest } });
    return committedManifest;
  } catch (err) {
    if (committedManifest) err.committedManifest = committedManifest;
    operationError = err;
    throw err;
  } finally {
    let cleanupError;
    try { if (temporary) await unlink(temporary); }
    catch (err) { if (err.code !== 'ENOENT') cleanupError = err; }
    try { await release(); } catch (err) { cleanupError ||= err; }
    if (cleanupError && !operationError) {
      if (committedManifest) cleanupError.committedManifest = committedManifest;
      throw cleanupError;
    }
  }
}

/** Capture pure state now, then serialize saves per path and enforce optional CAS. */
export async function saveSessionSnapshot({ sessionId, snapshot, expectedRevision, storageRoot = ROOT, faultHooks }) {
  assertId(sessionId);
  assertSnapshotIdentity(snapshot, sessionId);
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < -1)) {
    throw storeError('SESSION_REVISION_INVALID', '会话快照预期序号无效');
  }
  const persistent = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (!TRANSIENT.has(key)) Object.defineProperty(persistent, key, { value, enumerable: true });
  }
  const payload = encode(persistent);
  const queueKey = join(resolve(storageRoot), sessionId, 'state.json');
  const before = pending.get(queueKey) || Promise.resolve();
  const operation = before.catch(() => {}).then(() => saveCaptured({ sessionId, payload, expectedRevision, storageRoot, faultHooks }));
  pending.set(queueKey, operation);
  try { return await operation; }
  finally { if (pending.get(queueKey) === operation) pending.delete(queueKey); }
}

export async function loadSessionSnapshot({ sessionId, storageRoot = ROOT }) {
  assertId(sessionId);
  let directory;
  try {
    directory = await sessionDirectory(storageRoot, sessionId);
  } catch (err) {
    if (err.code === 'ENOENT') throw storeError('SESSION_NOT_FOUND', '会话存储目录不存在', err);
    throw err;
  }
  try {
    return await readState(directory, sessionId);
  } catch (err) {
    if (err.code === 'ENOENT') throw storeError('SESSION_MISSING', '会话快照文件缺损或尚未保存', err);
    throw err;
  }
}

/** Complete checked manifests only; corruption is never silently skipped. */
export async function listSessionSnapshots({ storageRoot = ROOT } = {}) {
  let entries;
  try { entries = await readdir(resolve(storageRoot), { withFileTypes: true }); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const results = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!validId(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const { manifest } = await loadSessionSnapshot({ sessionId: entry.name, storageRoot });
    results.push(manifest);
  }
  return results;
}
