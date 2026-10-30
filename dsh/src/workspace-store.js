/** Durable workspace facts. Runtime sessions, files and controllers stay elsewhere. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename, unlink, realpath, lstat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.DSH_WORKSPACE_ROOT || fileURLToPath(new URL('../data/workspaces/', import.meta.url)));
const pending = new Map();
const activeOwnLocks = new Map();
const finishedOwnLocks = new Map();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const validId = (id) => typeof id === 'string' && /^w[a-z0-9_-]{1,80}$/.test(id);

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function assertId(workspaceId) {
  if (!validId(workspaceId)) throw failure('WORKSPACE_ID_INVALID', '工作台身份无效');
}

/** Capture plain JSON data without invoking accessors or copying runtime objects. */
function jsonCopy(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw failure('WORKSPACE_NOT_JSON', '工作台含非 JSON 内容或循环引用');
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    throw failure('WORKSPACE_NOT_JSON', '工作台不能包含运行时对象');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) throw failure('WORKSPACE_NOT_JSON', '工作台不能包含 Symbol 字段');
  ancestors.add(value);
  try {
    const out = Array.isArray(value) ? [] : {};
    if (Array.isArray(value)) {
      if (keys.some((key) => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
        throw failure('WORKSPACE_NOT_JSON', '工作台数组不能附带对象字段');
      }
      for (let i = 0; i < value.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure('WORKSPACE_NOT_JSON', '工作台数组含空位或访问器');
        out.push(jsonCopy(descriptor.value, ancestors));
      }
    } else {
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure('WORKSPACE_NOT_JSON', '工作台字段必须是普通 JSON 数据');
        Object.defineProperty(out, key, { value: jsonCopy(descriptor.value, ancestors), enumerable: true, writable: true, configurable: true });
      }
    }
    return out;
  } finally { ancestors.delete(value); }
}

function assertWorkspace(workspace, workspaceId) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace) || workspace.id !== workspaceId) {
    throw failure('WORKSPACE_IDENTITY_MISMATCH', '工作台内容不属于该身份');
  }
}

async function directoryFor(storageRoot, workspaceId, create = false) {
  assertId(workspaceId);
  if (create) await mkdir(resolve(storageRoot), { recursive: true });
  const root = await realpath(resolve(storageRoot));
  const directory = join(root, workspaceId);
  if (create) await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || relative(root, await realpath(directory)) !== workspaceId) {
    throw failure('WORKSPACE_PATH_INVALID', '工作台存储目录无效');
  }
  return directory;
}

function manifestOf(state) {
  return { schemaVersion: state.schemaVersion, workspaceId: state.workspaceId, revision: state.revision,
    savedAt: state.savedAt, payloadSha256: state.payloadSha256, manifestSha256: state.manifestSha256 };
}

function manifestHash(state) {
  return hash(JSON.stringify({ schemaVersion: state.schemaVersion, workspaceId: state.workspaceId,
    revision: state.revision, savedAt: state.savedAt, payloadSha256: state.payloadSha256 }));
}

async function readState(directory, workspaceId) {
  const path = join(directory, 'state.json');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw failure('WORKSPACE_PATH_INVALID', '工作台记录文件类型无效');
  let state;
  try { state = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw failure('WORKSPACE_CORRUPT', '工作台记录 JSON 缺损或不可读取', error);
  }
  if (state?.schemaVersion !== 1 || state.workspaceId !== workspaceId || !Number.isSafeInteger(state.revision)
    || state.revision < 0 || typeof state.savedAt !== 'string' || !Object.hasOwn(state, 'payload')
    || !/^[a-f0-9]{64}$/.test(state.payloadSha256 || '') || !/^[a-f0-9]{64}$/.test(state.manifestSha256 || '')) {
    throw failure('WORKSPACE_IDENTITY_MISMATCH', '工作台记录身份、格式或序号不一致');
  }
  if (state.payloadSha256 !== hash(JSON.stringify(state.payload)) || state.manifestSha256 !== manifestHash(state)) {
    throw failure('WORKSPACE_HASH_MISMATCH', '工作台记录校验失败');
  }
  const workspace = jsonCopy(state.payload);
  assertWorkspace(workspace, workspaceId);
  return { workspace, manifest: manifestOf(state) };
}

async function readLock(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw failure('WORKSPACE_PATH_INVALID', '工作台存储锁类型无效');
  let owner;
  try { owner = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw failure('WORKSPACE_BUSY', '工作台存储锁未完成或损坏', error); }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !owner.token) {
    throw failure('WORKSPACE_BUSY', '工作台存储锁身份无效');
  }
  return owner;
}

/** Same lock/CAS/ended-own-lock protocol as session-store; no live lock expiry. */
async function acquire(directory) {
  const path = join(directory, 'state.lock');
  const recoveryPath = join(directory, 'state.recover.lock');
  const token = randomUUID();
  try {
    await lstat(recoveryPath);
    throw failure('WORKSPACE_BUSY', '另一个进程正在恢复工作台存储锁');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const take = async () => {
    const file = await open(path, 'wx');
    activeOwnLocks.set(path, token);
    finishedOwnLocks.delete(path);
    try {
      await file.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, token }));
      await file.sync();
    } catch (error) {
      finishedOwnLocks.set(path, token);
      activeOwnLocks.delete(path);
      throw error;
    } finally { await file.close(); }
  };
  try { await take(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readLock(path);
    let dead = false;
    try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
    const endedOwn = owner.pid === process.pid && finishedOwnLocks.get(path) === owner.token
      && activeOwnLocks.get(path) !== owner.token;
    if (!dead && !endedOwn) throw failure('WORKSPACE_BUSY', '另一个保存操作正在使用工作台');
    let recovery;
    try { recovery = await open(recoveryPath, 'wx'); }
    catch (error) { throw failure('WORKSPACE_BUSY', '另一个进程正在恢复工作台存储锁', error); }
    try {
      await recovery.writeFile(JSON.stringify({ pid: process.pid, token })); await recovery.sync();
      const current = await readLock(path);
      if (current.pid !== owner.pid || current.token !== owner.token) throw failure('WORKSPACE_BUSY', '工作台存储锁已变化');
      if (endedOwn && (finishedOwnLocks.get(path) !== current.token || activeOwnLocks.get(path) === current.token)) {
        throw failure('WORKSPACE_BUSY', '工作台锁仍属于活跃保存操作');
      }
      await unlink(path);
      try { await take(); } catch (error) { throw failure('WORKSPACE_BUSY', '工作台锁已被其他进程取得', error); }
    } finally {
      try { await recovery.close(); await unlink(recoveryPath); }
      catch (error) {
        if (activeOwnLocks.get(path) === token) { activeOwnLocks.delete(path); finishedOwnLocks.set(path, token); }
        throw error;
      }
    }
  }
  return async () => {
    try {
      let current;
      try { current = await readLock(path); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (current.pid !== process.pid || current.token !== token) throw failure('WORKSPACE_LOCK_CHANGED', '工作台存储锁身份已变化');
      await unlink(path);
      finishedOwnLocks.delete(path);
    } catch (error) {
      finishedOwnLocks.set(path, token);
      throw error;
    } finally { if (activeOwnLocks.get(path) === token) activeOwnLocks.delete(path); }
  };
}

/** Windows scanners/readers may briefly deny atomic replacement. Keep the lock and CAS. */
async function replaceState(temporary, target) {
  const delays = [20, 40, 80, 160, 320];
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(temporary, target); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function saveCaptured({ workspaceId, payload, expectedRevision, storageRoot, faultHooks }) {
  const directory = await directoryFor(storageRoot, workspaceId, true);
  const release = await acquire(directory);
  let temporary; let committedManifest; let operationError;
  try {
    let previous = null;
    try { previous = await readState(directory, workspaceId); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const currentRevision = previous?.manifest.revision ?? -1;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      const error = failure('WORKSPACE_REVISION_CONFLICT', '工作台已变化，拒绝覆盖较新记录');
      error.currentRevision = currentRevision;
      throw error;
    }
    if (!Number.isSafeInteger(currentRevision + 1)) throw failure('WORKSPACE_REVISION_INVALID', '工作台记录序号超出安全范围');
    const state = { schemaVersion: 1, workspaceId, revision: currentRevision + 1,
      savedAt: new Date().toISOString(), payloadSha256: hash(JSON.stringify(payload)), payload };
    state.manifestSha256 = manifestHash(state);
    temporary = join(directory, `state.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx');
    try { await file.writeFile(`${JSON.stringify(state, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    // Same-directory Windows replacement; never unlink the previous state first.
    await replaceState(temporary, join(directory, 'state.json'));
    temporary = null;
    const checked = await readState(directory, workspaceId);
    if (checked.manifest.manifestSha256 !== state.manifestSha256) throw failure('WORKSPACE_HASH_MISMATCH', '提交后工作台记录校验不一致');
    committedManifest = checked.manifest;
    if (faultHooks?.afterRename) await faultHooks.afterRename({ directory, manifest: { ...committedManifest } });
    return committedManifest;
  } catch (error) {
    if (committedManifest) error.committedManifest = committedManifest;
    operationError = error;
    throw error;
  } finally {
    let cleanupError;
    try { if (temporary) await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') cleanupError = error; }
    try { await release(); } catch (error) { cleanupError ||= error; }
    if (cleanupError && !operationError) {
      if (committedManifest) cleanupError.committedManifest = committedManifest;
      throw cleanupError;
    }
  }
}

/** Plain JSON snapshot captured before waiting; first revision 0, missing CAS -1. */
export async function saveWorkspace({ workspaceId, workspace, expectedRevision, storageRoot = ROOT, faultHooks }) {
  assertId(workspaceId);
  const payload = jsonCopy(workspace);
  assertWorkspace(payload, workspaceId);
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < -1)) {
    throw failure('WORKSPACE_REVISION_INVALID', '工作台预期序号无效');
  }
  const queueKey = join(resolve(storageRoot), workspaceId, 'state.json');
  const before = pending.get(queueKey) || Promise.resolve();
  const operation = before.catch(() => {}).then(() => saveCaptured({ workspaceId, payload, expectedRevision, storageRoot, faultHooks }));
  pending.set(queueKey, operation);
  try { return await operation; }
  finally { if (pending.get(queueKey) === operation) pending.delete(queueKey); }
}

export async function loadWorkspace({ workspaceId, storageRoot = ROOT }) {
  assertId(workspaceId);
  let directory;
  try {
    directory = await directoryFor(storageRoot, workspaceId);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const missing = failure('WORKSPACE_NOT_FOUND', '工作台存储目录不存在', error);
    missing.missingPart = 'directory';
    throw missing;
  }
  try {
    return await readState(directory, workspaceId);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const missing = failure('WORKSPACE_MISSING', '已有工作台的记录文件缺失，不能按新工作台恢复', error);
    missing.missingPart = 'state';
    throw missing;
  }
}
