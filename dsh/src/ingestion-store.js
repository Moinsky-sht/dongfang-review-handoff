/** Crash-recoverable imports. Intent, immutable source, v0, session, then workspace. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath, readFile, readdir, open, rename, link, unlink } from 'node:fs/promises';
import { resolve, join, parse, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanDocx } from './docx-clean.js';
import { parseDocxBuffer } from './docx.js';
import { saveWorkingVersion, loadWorkingVersion } from './working-version.js';
import { saveSessionSnapshot, loadSessionSnapshot } from './session-store.js';
import { saveWorkspace, loadWorkspace } from './workspace-store.js';
import { initializeFixHistory } from './fix-history.js';

const defaults = {
  storageRoot: process.env.DSH_INGESTION_ROOT || fileURLToPath(new URL('../data/ingestions/', import.meta.url)),
  sessionRoot: process.env.DSH_SESSION_ROOT || fileURLToPath(new URL('../data/sessions/', import.meta.url)),
  workspaceRoot: process.env.DSH_WORKSPACE_ROOT || fileURLToPath(new URL('../data/workspaces/', import.meta.url)),
  versionRoot: process.env.DSH_WORKING_VERSION_ROOT || fileURLToPath(new URL('../data/working-versions/', import.meta.url)),
};
const pending = new Map();
const finishedTickets = new Set();
const SKIPPED_LOCK = Symbol('active-lock');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const phases = ['awaiting-file', 'source-stored', 'version-saved', 'session-saved', 'workspace-attached', 'completed', 'failed'];
const terminal = (record) => ['completed', 'failed'].includes(record.status);
const rootsOf = (args) => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, resolve(args[key] || value)]));
const contextKeys = ['sessionRoot', 'workspaceRoot', 'versionRoot'];
function storageContext(roots) {
  const context = {schemaVersion: 1};
  for (const key of contextKeys) {
    const path = relative(roots.storageRoot, roots[key]) || '.';
    context[key] = {kind: isAbsolute(path) ? 'absolute' : 'relative', path: path.split(sep).join('/')};
  }
  return context;
}
function validContext(context) {
  return context && typeof context === 'object' && !Array.isArray(context) && context.schemaVersion === 1
    && contextKeys.every((key) => {
      const entry = context[key];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !['absolute', 'relative'].includes(entry.kind)
        || typeof entry.path !== 'string' || !entry.path || entry.path.length > 4096 || /[\\\x00-\x1f]/.test(entry.path)) return false;
      const absolute = isAbsolute(entry.path) || /^[a-z]:\//i.test(entry.path);
      return entry.kind === 'absolute' ? absolute : !absolute;
    });
}
function assertStorageContext(record, roots) {
  const expected = storageContext(roots);
  if (!validContext(record.storageContext) || contextKeys.some((key) => record.storageContext[key].kind !== expected[key].kind
    || record.storageContext[key].path !== expected[key].path))
    throw fail('INGESTION_STORAGE_CONFLICT', '当前会话、工作台或版本存储位置与此导入登记的位置关系不一致，不能跨存储恢复', 409);
}
function fail(code, message, status = 500, cause) {
  return Object.assign(new Error(message, cause ? {cause} : undefined), {code, status});
}
function identity(args) {
  const {workspaceId, operationId, name, size} = args;
  const purpose = args.purpose ?? 'editorial'; const verificationRunId = args.verificationRunId ?? null;
  if (!/^w[a-z0-9_-]{1,80}$/.test(workspaceId || '') || typeof operationId !== 'string' || !operationId || operationId.length > 200
    || typeof name !== 'string' || !name || name.length > 1024 || !Number.isSafeInteger(size) || size < 0
    || typeof purpose !== 'string' || !purpose || purpose.length > 100
    || verificationRunId !== null && (typeof verificationRunId !== 'string' || !verificationRunId || verificationRunId.length > 200))
    throw fail('INGESTION_IDENTITY_INVALID', '导入操作的工作台、操作、文件名或大小无效', 400);
  const ingestionId = 'i' + digest(`${workspaceId}\0${operationId}`);
  return {workspaceId, operationId, name, size, purpose, verificationRunId, ingestionId,
    sessionId: 's' + digest(ingestionId), entryId: 'e' + digest(ingestionId)};
}
function assertId(id) {
  if (!/^i[a-f0-9]{64}$/.test(id || '')) throw fail('INGESTION_ID_INVALID', '导入身份无效', 400);
}
function assertSame(record, proposed) {
  if (['workspaceId', 'operationId', 'name', 'size', 'purpose', 'verificationRunId'].some((key) => record[key] !== proposed[key]))
    throw fail('INGESTION_CONFLICT', '相同导入操作不能更换文件身份、大小或用途', 409);
}

/** Check every ancestor too: resolving a configured root must never follow a link. */
async function directory(path, create = false) {
  const absolute = resolve(path); let cursor = parse(absolute).root;
  for (const component of relative(cursor, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    let info;
    try { info = await lstat(cursor); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      try { await mkdir(cursor); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      info = await lstat(cursor);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('INGESTION_PATH_INVALID', '导入存储目录不是安全的真实目录');
  }
  if (resolve(await realpath(absolute)) !== absolute) throw fail('INGESTION_PATH_INVALID', '导入存储路径身份不一致');
  return absolute;
}
async function checkedFile(path) {
  await directory(parse(path).dir);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw fail('INGESTION_PATH_INVALID', '导入存储文件不是安全的普通文件');
  return readFile(path);
}
async function optionalFile(path) {
  try { return await checkedFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function syncDirectory(path) {
  let file;
  try { file = await open(path, 'r'); await file.sync(); }
  catch (error) { if (!['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
  finally { await file?.close(); }
}
async function writeSynced(path, bytes) {
  const file = await open(path, 'wx');
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function replaceAtomicFile(temporary, target) {
  const delays = [20, 40, 80, 160, 320];
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(temporary, target); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}
async function atomic(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    if (await optionalFile(path)) { /* checked before replacement */ }
    await writeSynced(temporary, bytes); await replaceAtomicFile(temporary, path); await syncDirectory(parse(path).dir);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}
async function immutable(path, bytes) {
  const existing = await optionalFile(path);
  if (existing) {
    if (!existing.equals(Buffer.from(bytes))) throw fail('INGESTION_IMMUTABLE_CONFLICT', '导入的不可变存档已存在且内容不同', 409);
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeSynced(temporary, bytes);
    try { await link(temporary, path); }
    catch (error) {
      if (error.code !== 'EEXIST' || !(await checkedFile(path)).equals(Buffer.from(bytes))) throw error;
    }
    await syncDirectory(parse(path).dir);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/** A read refusal is not proof of corrupt lock bytes and must never grant access. */
async function readLockFile(path, {optional = false, phase = 'ticket'} = {}) {
  const delays = [10, 20, 40, 80, 160];
  for (let attempts = 1; ; attempts += 1) {
    try { return {bytes: optional ? await optionalFile(path) : await checkedFile(path), attempts}; }
    catch (error) {
      // A removed ticket is a normal scan race; unsafe paths are never retried.
      if (error.code === 'ENOENT' || error.code?.startsWith('INGESTION_')) throw error;
      const transient = process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
      if (transient && attempts <= delays.length) { await sleep(delays[attempts - 1]); continue; }
      throw Object.assign(fail('INGESTION_LOCK_READ_FAILED', '导入存储锁文件读取失败，本次操作已停止', 500, error), {
        fsCode: error.code || null, syscall: error.syscall || null, path: error.path || path, attempts, phase,
      });
    }
  }
}
function corruptLock(message, path, phase, attempts, cause) {
  return Object.assign(fail('INGESTION_LOCK_CORRUPT', message, 500, cause), {path, phase, attempts});
}
async function scanLocks(key) {
  const rows = [];
  for (const entry of await readdir(key, {withFileTypes: true})) {
    if (!entry.name.endsWith('.lock')) continue;
    const path = join(key, entry.name);
    let read;
    try { read = await readLockFile(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    let row;
    try {
      row = JSON.parse(read.bytes.toString('utf8'));
    } catch (error) { throw corruptLock('导入存储锁 JSON 损坏', path, 'ticket', read.attempts, error); }
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.schemaVersion !== 1 || !Number.isSafeInteger(row.pid) || row.pid <= 0 || `${row.token}.lock` !== entry.name
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.token || '')
      || typeof row.choosing !== 'boolean' || !Number.isSafeInteger(row.ticket) || row.ticket < 0 || !row.choosing && row.ticket < 1)
      throw corruptLock('导入存储锁身份无效', path, 'ticket', read.attempts);
    const releasePath = join(key, `${row.token}.released.json`);
    const releaseRead = await readLockFile(releasePath, {optional: true, phase: 'release'});
    let released = null;
    if (releaseRead.bytes !== null) {
      try { released = JSON.parse(releaseRead.bytes.toString('utf8')); }
      catch (error) { throw corruptLock('导入存储锁释放凭证 JSON 损坏', releasePath, 'release', releaseRead.attempts, error); }
      // Present JSON null/false is an invalid receipt, not an absent one. Verify
      // before probing PID liveness so dead owners cannot hide damaged evidence.
      if (!released || typeof released !== 'object' || Array.isArray(released) || released.schemaVersion !== 1 || released.pid !== row.pid || released.token !== row.token || released.released !== true)
        throw corruptLock('导入存储锁释放凭证损坏', releasePath, 'release', releaseRead.attempts);
    }
    if (!released && alive(row.pid) && !(row.pid === process.pid && finishedTickets.has(join(key, entry.name)))) rows.push(row);
  }
  return rows;
}
/** File bakery lock: dead/released tickets are ignored, live tickets never age-expire. */
async function exclusive(lockRoot, action, {skipActive = false} = {}) {
  const key = resolve(lockRoot);
  if (skipActive && pending.has(key)) return SKIPPED_LOCK;
  const before = pending.get(key) || Promise.resolve();
  const operation = before.catch(() => {}).then(async () => {
    await directory(key, true);
    const token = randomUUID(); const path = join(key, `${token}.lock`);
    const owner = {schemaVersion: 1, pid: process.pid, token, choosing: true, ticket: 0};
    const releasePath = join(key, `${token}.released.json`);
    let published = false;
    try {
      if (skipActive && (await scanLocks(key)).length) return SKIPPED_LOCK;
      await immutable(path, JSON.stringify(owner));
      published = true;
      const rows = await scanLocks(key);
      if (skipActive && rows.some((row) => row.token !== token)) return SKIPPED_LOCK;
      owner.ticket = 1 + Math.max(0, ...rows.map((row) => row.ticket)); owner.choosing = false;
      if (!Number.isSafeInteger(owner.ticket)) throw fail('INGESTION_LOCK_CORRUPT', '导入存储锁序号越界');
      await atomic(path, JSON.stringify(owner));
      const started = Date.now();
      while ((await scanLocks(key)).some((row) => row.token !== token && (row.choosing || row.ticket > 0
        && (row.ticket < owner.ticket || row.ticket === owner.ticket && row.token < token)))) {
        if (Date.now() - started > 10000) throw fail('INGESTION_BUSY', '另一个进程正在提交导入，请稍后恢复', 409);
        await sleep(20);
      }
      return await action();
    } finally {
      // An unlink failure must not leave our own finished ticket blocking us.
      finishedTickets.add(path);
      try {
        if (published || await optionalFile(path))
          await immutable(releasePath, JSON.stringify({schemaVersion: 1, pid: process.pid, token, released: true}));
        await unlink(path); finishedTickets.delete(path);
        await unlink(releasePath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
      catch (error) { if (error.code === 'ENOENT') finishedTickets.delete(path); else throw error; }
    }
  });
  pending.set(key, operation);
  try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
}

async function saveRecord(record, roots) {
  record.updatedAt = new Date().toISOString();
  const payload = JSON.stringify(record);
  await atomic(join(roots.storageRoot, record.ingestionId, 'state.json'), JSON.stringify({schemaVersion: 1, sha256: digest(payload), record}) + '\n');
  return record;
}
export async function loadIngestion({ingestionId, storageRoot = defaults.storageRoot}) {
  assertId(ingestionId);
  let bytes;
  try { bytes = await checkedFile(join(resolve(storageRoot), ingestionId, 'state.json')); }
  catch (error) { if (error.code === 'ENOENT') throw fail('INGESTION_NOT_FOUND', '导入记录不存在或记录文件缺失', 404, error); throw error; }
  let state;
  try { state = JSON.parse(bytes.toString('utf8')); } catch (error) { throw fail('INGESTION_CORRUPT', '导入记录 JSON 损坏', 500, error); }
  const record = state?.record;
  let expected;
  try { expected = identity(record || {}); } catch (error) { throw fail('INGESTION_CORRUPT', '导入记录身份损坏', 500, error); }
  if (state.schemaVersion !== 1 || record.schemaVersion !== 1 || state.sha256 !== digest(JSON.stringify(record))
    || expected.ingestionId !== ingestionId || record.ingestionId !== ingestionId || record.sessionId !== expected.sessionId
    || record.entryId !== expected.entryId || !phases.includes(record.status)
    || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string'
    || record.source && (!/^[a-f0-9]{64}$/.test(record.source.sha256 || '') || record.source.size !== record.size)
    || typeof record.placeholderRegistered !== 'boolean'
    || Object.hasOwn(record, 'storageContext') && !validContext(record.storageContext)
    || record.status !== 'awaiting-file' && !record.source
    || ['version-saved', 'session-saved', 'workspace-attached', 'completed'].includes(record.status)
      && (record.workVersion?.id !== `${record.sessionId}:v000000-${record.workVersion?.sha256}`
        || record.workVersion.revision !== 0 || record.workVersion.sourceSha256 !== record.source?.sha256)
    || terminal(record) && (!record.receipt || record.receipt.ingestionId !== ingestionId
      || record.receipt.status !== (record.status === 'completed' ? 200 : 422)))
    throw fail('INGESTION_CORRUPT', '导入记录身份、阶段或校验不一致');
  return record;
}
/** Read-only configuration gate for public status, workspace and session restore. */
export async function verifyIngestionContext(args) {
  const roots = rootsOf(args);
  const record = await loadIngestion({ingestionId: args.ingestionId, storageRoot: roots.storageRoot});
  try { assertStorageContext(record, roots); }
  catch (error) { error.ingestionId = record.ingestionId; error.record = record; throw error; }
  return record;
}
/** Cheap availability hint only. Resume still reads and hashes every source byte. */
export async function ingestionSourceAvailable({ingestionId, storageRoot = defaults.storageRoot}) {
  const root = resolve(storageRoot);
  const record = await loadIngestion({ingestionId, storageRoot: root});
  const sourcePath = join(root, ingestionId, 'source');
  try { await directory(sourcePath); }
  catch (error) { if (error.code === 'ENOENT' && !record.source) return false; throw error; }
  let manifest;
  try { manifest = JSON.parse((await checkedFile(join(sourcePath, 'manifest.json'))).toString('utf8')); }
  catch (error) { throw fail('INGESTION_SOURCE_CORRUPT', '原始稿存档凭证损坏', 500, error); }
  const file = await lstat(join(sourcePath, 'original.docx'));
  if (!file.isFile() || file.isSymbolicLink()) throw fail('INGESTION_PATH_INVALID', '原始稿存档不是安全的普通文件');
  if (manifest.schemaVersion !== 1 || manifest.ingestionId !== ingestionId || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '')
    || manifest.size !== record.size || file.size !== manifest.size
    || record.source && (record.source.sha256 !== manifest.sha256 || record.source.size !== manifest.size))
    throw fail('INGESTION_SOURCE_CORRUPT', '原始稿存档身份或大小不一致');
  return true;
}
async function readSource(record, roots) {
  const sourcePath = join(roots.storageRoot, record.ingestionId, 'source');
  try { await directory(sourcePath); } catch (error) { if (error.code === 'ENOENT' && !record.source) return null; throw error; }
  let manifest;
  try { manifest = JSON.parse((await checkedFile(join(sourcePath, 'manifest.json'))).toString('utf8')); }
  catch (error) { throw fail('INGESTION_SOURCE_CORRUPT', '原始稿存档凭证损坏', 500, error); }
  const buffer = await checkedFile(join(sourcePath, 'original.docx'));
  if (manifest.schemaVersion !== 1 || manifest.ingestionId !== record.ingestionId || manifest.size !== record.size
    || digest(buffer) !== manifest.sha256 || buffer.length !== manifest.size
    || record.source && (record.source.sha256 !== manifest.sha256 || record.source.size !== manifest.size))
    throw fail('INGESTION_SOURCE_CORRUPT', '原始稿存档字节、身份或校验不一致');
  return {buffer, source: {sha256: manifest.sha256, size: manifest.size}};
}
async function storeSource(record, buffer, roots, faultHooks) {
  const directoryPath = join(roots.storageRoot, record.ingestionId); const target = join(directoryPath, 'source');
  const staging = join(directoryPath, `.source-${randomUUID()}`);
  await directory(staging, true);
  const source = {sha256: digest(buffer), size: buffer.length};
  await writeSynced(join(staging, 'manifest.json'), JSON.stringify({schemaVersion: 1, ingestionId: record.ingestionId, ...source}) + '\n');
  await invokeHook(faultHooks, 'afterSourceIdentityBeforeBytes', record);
  await writeSynced(join(staging, 'original.docx'), buffer);
  await syncDirectory(staging); await rename(staging, target); await syncDirectory(directoryPath);
  await invokeHook(faultHooks, 'afterSourceBytesBeforeRecord', record);
  return {buffer, source};
}

async function guardTarget(root, id, filenames = []) {
  await directory(root, true);
  try { await directory(join(root, id)); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  for (const name of filenames) await optionalFile(join(root, id, name));
  return true;
}
async function bootstrap(root, id, marker) {
  await directory(root, true);
  const staging = join(root, `.ingestion-bootstrap-${randomUUID()}`);
  await directory(staging, true);
  await writeSynced(join(staging, '.ingestion-owner.json'), JSON.stringify(marker));
  await syncDirectory(staging); await rename(staging, join(root, id)); await syncDirectory(root);
}
async function canBootstrap(root, id, record, roots, kind) {
  if (await optionalFile(join(root, id, '.ingestion-complete.json'))) return false;
  const bytes = await optionalFile(join(root, id, '.ingestion-owner.json'));
  if (!bytes) return false;
  let marker;
  try { marker = JSON.parse(bytes.toString('utf8')); } catch { return false; }
  if (marker.schemaVersion !== 1 || marker.kind !== kind || marker.id !== id) return false;
  const owner = marker.ingestionId === record.ingestionId ? record
    : await loadIngestion({ingestionId: marker.ingestionId, storageRoot: roots.storageRoot});
  assertStorageContext(owner, roots);
  return owner.workspaceId === record.workspaceId && (kind === 'workspace' ? !owner.placeholderRegistered
    : owner.sessionId === id && !['session-saved', 'workspace-attached', 'completed'].includes(owner.status));
}
function newWorkspace(record) {
  return {id: record.workspaceId, entries: [], activeSessionId: null,
    queue: {state: 'ready', cursorSessionId: null, options: null}, receipts: {}, createdAt: record.createdAt};
}
async function mutateWorkspace(record, roots, mutation) {
  return exclusive(join(roots.storageRoot, '.locks', 'workspaces', digest(roots.workspaceRoot + '\0' + record.workspaceId)), async () => {
    for (let attempt = 0; attempt < 256; attempt += 1) {
      await guardTarget(roots.workspaceRoot, record.workspaceId, ['state.json', 'state.lock', 'state.recover.lock']);
      let stored;
      try { stored = await loadWorkspace({workspaceId: record.workspaceId, storageRoot: roots.workspaceRoot}); }
      catch (error) {
        if (error.code === 'WORKSPACE_NOT_FOUND' && error.missingPart === 'directory' && !record.placeholderRegistered) {
          await bootstrap(roots.workspaceRoot, record.workspaceId, {schemaVersion: 1, kind: 'workspace', id: record.workspaceId, ingestionId: record.ingestionId});
          stored = {workspace: newWorkspace(record), manifest: {revision: -1}};
        } else if (error.code === 'WORKSPACE_MISSING' && await canBootstrap(roots.workspaceRoot, record.workspaceId, record, roots, 'workspace')) {
          stored = {workspace: newWorkspace(record), manifest: {revision: -1}};
        } else throw error;
      }
      if (!Array.isArray(stored.workspace.entries)) throw fail('INGESTION_WORKSPACE_CORRUPT', '工作台稿件列表损坏');
      const changed = mutation(stored.workspace);
      if (!changed) return stored.manifest;
      try {
        const manifest = await saveWorkspace({workspaceId: record.workspaceId, workspace: stored.workspace,
          storageRoot: roots.workspaceRoot, expectedRevision: stored.manifest.revision});
        await immutable(join(roots.workspaceRoot, record.workspaceId, '.ingestion-complete.json'), JSON.stringify({schemaVersion: 1, kind: 'workspace', id: record.workspaceId}));
        return manifest;
      } catch (error) {
        if (!['WORKSPACE_REVISION_CONFLICT', 'WORKSPACE_BUSY'].includes(error.code)) throw error;
        await sleep(20);
      }
    }
    throw fail('INGESTION_BUSY', '工作台持续变化，导入已保留，请稍后恢复', 409);
  });
}
async function placeholder(record, roots, phase = record.status) {
  return mutateWorkspace(record, roots, (workspace) => {
    const entries = workspace.entries.filter((entry) => entry.ingestionId === record.ingestionId || entry.entryId === record.entryId);
    if (entries.length > 1 || entries[0] && (entries[0].ingestionId !== record.ingestionId || entries[0].entryId !== record.entryId
      || entries[0].id && entries[0].id !== record.sessionId)) throw fail('INGESTION_WORKSPACE_CONFLICT', '导入在工作台中的登记身份冲突', 409);
    let entry = entries[0];
    if (!entry) {
      if (record.placeholderRegistered) throw fail('INGESTION_WORKSPACE_ENTRY_MISSING', '已登记的导入条目被移除，不能静默重新添加', 409);
      entry = {entryId: record.entryId, ingestionId: record.ingestionId, operationId: record.operationId, size: record.size, name: record.name, id: null,
        uploadedAt: record.createdAt, purpose: record.purpose, verificationRunId: record.verificationRunId};
      workspace.entries.push(entry);
    }
    if (phase === 'workspace-attached') {
      if (entry.id === record.sessionId) return false;
      entry.id = record.sessionId; entry.ingestionStatus = 'completed';
      if (workspace.activeSessionId == null) workspace.activeSessionId = record.sessionId;
      return true;
    }
    if (entry.id) return false;
    const error = record.receipt?.error || null;
    if (entry.ingestionStatus === phase && entry.ingestionError === error) return false;
    entry.ingestionStatus = phase; entry.ingestionError = error; return true;
  });
}
async function initialSession(record, originalDoc, roots, faultHooks) {
  const id = record.sessionId; const target = join(roots.sessionRoot, id);
  const present = await guardTarget(roots.sessionRoot, id, ['state.json', 'state.lock', 'state.recover.lock']);
  if (!present) await bootstrap(roots.sessionRoot, id, {schemaVersion: 1, kind: 'session', id, ingestionId: record.ingestionId});
  let stored;
  try { stored = await loadSessionSnapshot({sessionId: id, storageRoot: roots.sessionRoot}); }
  catch (error) {
    if (!['SESSION_MISSING', 'SESSION_NOT_FOUND'].includes(error.code)
      || !await canBootstrap(roots.sessionRoot, id, record, roots, 'session')) throw error;
  }
  if (stored) {
    const s = stored.snapshot;
    if (s.ingestionId !== record.ingestionId || s.ingestion?.sourceSha256 !== record.source.sha256
      || s.workVersion?.sourceSha256 !== record.source.sha256) throw fail('INGESTION_SESSION_CONFLICT', '已有会话不属于此导入', 409);
    return stored;
  }
  const snapshot = {id, name: record.name, ingestionId: record.ingestionId, workspaceId: record.workspaceId,
    purpose: record.purpose, verificationRunId: record.verificationRunId,
    ingestion: {ingestionId: record.ingestionId, operationId: record.operationId, sourceSha256: record.source.sha256, initialVersionId: record.workVersion.id},
    workVersion: record.workVersion, clean: record.clean, cleanRecords: {[record.workVersion.id]: record.clean},
    sourceComments: originalDoc.comments || [], createdAt: Date.parse(record.createdAt), lastUsed: Date.now(),
    reviewRunning: false, reviewProgress: {phase: 'unreviewed', done: 0, total: 0, message: '稿件已导入，请开始审阅'},
    result: null, reviewRecords: []};
  initializeFixHistory(snapshot);
  const manifest = await saveSessionSnapshot({sessionId: id, snapshot, expectedRevision: -1, storageRoot: roots.sessionRoot,
    faultHooks: {afterRename: () => invokeHook(faultHooks, 'afterSessionStateRenamed', record)}});
  await invokeHook(faultHooks, 'afterSessionCommitBeforeRecord', record);
  await immutable(join(target, '.ingestion-complete.json'), JSON.stringify({schemaVersion: 1, kind: 'session', id}));
  return {snapshot, manifest};
}
async function resultOf(record, roots, workspaceManifest = null) {
  try {
  assertStorageContext(record, roots);
  let stored = null;
  if (record.status === 'completed') {
    await guardTarget(roots.sessionRoot, record.sessionId, ['state.json']);
    stored = await loadSessionSnapshot({sessionId: record.sessionId, storageRoot: roots.sessionRoot});
    if (stored.snapshot.ingestionId !== record.ingestionId || stored.snapshot.ingestion?.sourceSha256 !== record.source.sha256)
      throw fail('INGESTION_SESSION_CONFLICT', '已完成的导入会话身份不一致', 409);
  }
  return {record, receipt: record.receipt || null, snapshot: stored?.snapshot || null,
    sessionManifest: stored?.manifest || null, workspaceManifest};
  } catch (error) { error.ingestionId = record.ingestionId; error.record = record; throw error; }
}
async function invokeHook(faultHooks, name, record) {
  if (faultHooks?.[name]) await faultHooks[name]({record: structuredClone(record), ingestionId: record.ingestionId});
}
async function beginLocked(proposed, roots, faultHooks) {
  let record;
  try { record = await loadIngestion({ingestionId: proposed.ingestionId, storageRoot: roots.storageRoot}); }
  catch (error) {
    if (error.code !== 'INGESTION_NOT_FOUND') throw error;
    let exists = false;
    try { await directory(join(roots.storageRoot, proposed.ingestionId)); exists = true; } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    if (exists) throw fail('INGESTION_CORRUPT', '已有导入目录的记录文件缺失，不能新建覆盖');
    const now = new Date().toISOString();
    record = {schemaVersion: 1, ...proposed, storageContext: storageContext(roots), status: 'awaiting-file', source: null, workVersion: null, clean: null,
      receipt: null, placeholderRegistered: false, createdAt: now, updatedAt: now};
    // Publish a whole intent directory: there is never an empty identity directory.
    const staging = join(roots.storageRoot, `.intent-${randomUUID()}`); await directory(staging, true);
    await writeSynced(join(staging, 'state.json'), JSON.stringify({schemaVersion: 1, sha256: digest(JSON.stringify(record)), record}) + '\n');
    await syncDirectory(staging); await rename(staging, join(roots.storageRoot, proposed.ingestionId)); await syncDirectory(roots.storageRoot);
  }
  assertSame(record, proposed);
  assertStorageContext(record, roots);
  if (terminal(record)) return record;
  if (!record.placeholderRegistered) {
    await placeholder(record, roots); record.placeholderRegistered = true; await saveRecord(record, roots);
    await invokeHook(faultHooks, 'afterIntent', record);
  }
  return record;
}
async function advance(record, roots, faultHooks) {
  if (terminal(record)) return resultOf(record, roots);
  const source = await readSource(record, roots);
  if (!source) throw fail('INGESTION_SOURCE_MISSING', '原始文件尚未保存，请重新选择同一文件', 409);
  if (!record.source) {
    record.source = source.source; record.status = 'source-stored'; await saveRecord(record, roots);
    await invokeHook(faultHooks, 'afterSourceStored', record);
  }
  let cleaned, originalDoc;
  try {
    cleaned = cleanDocx(source.buffer); originalDoc = parseDocxBuffer(source.buffer, record.name);
    const doc = parseDocxBuffer(cleaned.buffer, record.name);
    if (!doc || !originalDoc) throw new Error('DOCX 解析没有返回正文');
  } catch (error) {
    let originalCommentCount = cleaned?.stats.beforeAfter.before.comments ?? null;
    if (originalCommentCount === null) {
      try { originalCommentCount = parseDocxBuffer(source.buffer, record.name).comments?.length ?? 0; }
      catch { /* An unreadable source keeps the count explicitly unknown. */ }
    }
    record.receipt = {status: 422, ingestionId: record.ingestionId, error: `清洗或解析失败：${error.message}`,
      code: error.code || 'CLEAN_PARSE_FAILED', clean: {status: 'failed', reason: error.message, sourceSha256: record.source.sha256,
        originalCommentCount}};
    await placeholder(record, roots, 'failed'); record.status = 'failed'; await saveRecord(record, roots);
    return resultOf(record, roots);
  }
  const hash = digest(cleaned.buffer); const stem = `v000000-${hash}`;
  await guardTarget(roots.versionRoot, record.sessionId, ['original.docx', `${stem}.json`, `${stem}.docx`, `${stem}.complete.json`]);
  const workVersion = record.workVersion
    ? (await loadWorkingVersion({sessionId: record.sessionId, versionId: record.workVersion.id, storageRoot: roots.versionRoot})).version
    : await saveWorkingVersion({sessionId: record.sessionId, name: record.name, buffer: cleaned.buffer,
      originalBuffer: source.buffer, storageRoot: roots.versionRoot});
  const checked = await loadWorkingVersion({sessionId: record.sessionId, versionId: workVersion.id, storageRoot: roots.versionRoot});
  if (!checked.buffer.equals(cleaned.buffer) || !checked.originalBuffer.equals(source.buffer)) throw fail('INGESTION_VERSION_CONFLICT', '导入版本的保存字节不一致');
  if (record.workVersion && record.workVersion.id !== workVersion.id) throw fail('INGESTION_VERSION_CONFLICT', '导入的初始工作版本发生变化');
  record.workVersion = workVersion;
  record.clean = {...cleaned.stats, status: cleaned.stats.changed ? 'cleaned' : 'unchanged',
    cleaningInputSha256: cleaned.stats.sourceSha256, sourceSha256: workVersion.sourceSha256, workSha256: workVersion.sha256,
    outputSha256: workVersion.sha256, originalCommentCount: cleaned.stats.beforeAfter.before.comments, validatedVersionId: workVersion.id};
  if (phases.indexOf(record.status) < phases.indexOf('version-saved')) {
    record.status = 'version-saved'; await saveRecord(record, roots); await invokeHook(faultHooks, 'afterVersionSaved', record);
  }
  await initialSession(record, originalDoc, roots, faultHooks);
  if (phases.indexOf(record.status) < phases.indexOf('session-saved')) {
    record.status = 'session-saved'; await saveRecord(record, roots); await invokeHook(faultHooks, 'afterSessionSaved', record);
  }
  const workspaceManifest = await placeholder(record, roots, 'workspace-attached');
  if (record.status !== 'workspace-attached') {
    record.status = 'workspace-attached'; await saveRecord(record, roots); await invokeHook(faultHooks, 'afterWorkspaceAttached', record);
  }
  await invokeHook(faultHooks, 'beforeComplete', record);
  record.status = 'completed'; record.completedAt = new Date().toISOString();
  record.receipt = {status: 200, ingestionId: record.ingestionId, sessionId: record.sessionId,
    workVersionId: record.workVersion.id, sourceSha256: record.source.sha256, completedAt: record.completedAt};
  await saveRecord(record, roots);
  return resultOf(record, roots, workspaceManifest);
}
async function operation(args, ingestionId, action) {
  assertId(ingestionId); const roots = rootsOf(args); await directory(roots.storageRoot, true);
  try {
    const result = await exclusive(join(roots.storageRoot, '.locks', 'ingestions', ingestionId), () => action(roots), args);
    if (result !== SKIPPED_LOCK) return result;
    const record = await loadIngestion({ingestionId, storageRoot: roots.storageRoot});
    assertStorageContext(record, roots);
    return {record, receipt: record.receipt || null, snapshot: null, sessionManifest: null, workspaceManifest: null, skippedActive: true};
  }
  catch (error) {
    error.ingestionId = ingestionId;
    try { error.record = await loadIngestion({ingestionId, storageRoot: roots.storageRoot}); } catch { /* Keep the original failure. */ }
    throw error;
  }
}
async function terminalRecord(args, ingestionId, proposed) {
  const roots = rootsOf(args); let record;
  try {
  try { record = await loadIngestion({ingestionId, storageRoot: roots.storageRoot}); }
  catch (error) { if (error.code === 'INGESTION_NOT_FOUND') return null; throw error; }
  if (proposed) assertSame(record, proposed);
  assertStorageContext(record, roots);
  if (!terminal(record)) return null;
  return {record, roots};
  } catch (error) { error.ingestionId = ingestionId; if (record) error.record = record; throw error; }
}
export async function beginIngestion(args) {
  const proposed = identity(args);
  const finished = await terminalRecord(args, proposed.ingestionId, proposed);
  if (finished) return resultOf(finished.record, finished.roots);
  return operation(args, proposed.ingestionId, async (roots) => resultOf(await beginLocked(proposed, roots, args.faultHooks), roots));
}
export async function submitIngestion(args) {
  const proposed = identity(args);
  if (!Buffer.isBuffer(args.buffer) || args.buffer.length !== proposed.size) throw fail('INGESTION_FILE_SIZE', '提交的文件字节数与导入意图不一致', 409);
  const buffer = Buffer.from(args.buffer);
  const finished = await terminalRecord(args, proposed.ingestionId, proposed);
  if (finished) {
    const source = await readSource(finished.record, finished.roots);
    if (!source || !source.buffer.equals(buffer)) throw fail('INGESTION_CONFLICT', '相同导入操作不能提交不同的原始文件', 409);
    return resultOf(finished.record, finished.roots);
  }
  return operation(args, proposed.ingestionId, async (roots) => {
    const record = await beginLocked(proposed, roots, args.faultHooks);
    let source = await readSource(record, roots);
    if (source && !source.buffer.equals(buffer)) throw fail('INGESTION_CONFLICT', '相同导入操作不能提交不同的原始文件', 409);
    if (!source) {
      source = await storeSource(record, buffer, roots, args.faultHooks); record.source = source.source; record.status = 'source-stored';
      await saveRecord(record, roots); await invokeHook(args.faultHooks, 'afterSourceStored', record);
    }
    return advance(record, roots, args.faultHooks);
  });
}
export async function resumeIngestion(args) {
  assertId(args.ingestionId);
  const finished = await terminalRecord(args, args.ingestionId);
  if (finished) return resultOf(finished.record, finished.roots);
  return operation(args, args.ingestionId, async (roots) => {
    const record = await loadIngestion({ingestionId: args.ingestionId, storageRoot: roots.storageRoot});
    assertStorageContext(record, roots);
    if (!record.placeholderRegistered && !terminal(record)) {
      await placeholder(record, roots); record.placeholderRegistered = true; await saveRecord(record, roots);
      await invokeHook(args.faultHooks, 'afterIntent', record);
    }
    return advance(record, roots, args.faultHooks);
  });
}
export async function listIngestions(args = {}) {
  const roots = rootsOf(args); let entries;
  try { await directory(roots.storageRoot); entries = await readdir(roots.storageRoot, {withFileTypes: true}); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^i[a-f0-9]{64}$/.test(entry.name)) continue;
    const record = await loadIngestion({ingestionId: entry.name, storageRoot: roots.storageRoot});
    if (!args.workspaceId || record.workspaceId === args.workspaceId) records.push(record);
  }
  return records;
}
export async function recoverIngestions(args = {}) {
  const roots = rootsOf(args); let entries;
  try { await directory(roots.storageRoot); entries = await readdir(roots.storageRoot, {withFileTypes: true}); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const results = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^i[a-f0-9]{64}$/.test(entry.name)) continue;
    try {
      const record = await loadIngestion({ingestionId: entry.name, storageRoot: roots.storageRoot});
      if (args.workspaceId && record.workspaceId !== args.workspaceId) continue;
      assertStorageContext(record, roots);
      if (terminal(record)) {
        results.push({ingestionId: record.ingestionId, skippedTerminal: true,
          result: {record, receipt: record.receipt, snapshot: null, sessionManifest: null, workspaceManifest: null}});
      } else results.push({ingestionId: record.ingestionId, result: await resumeIngestion({...args, ingestionId: record.ingestionId})});
    } catch (error) { results.push({ingestionId: entry.name, error: {code: error.code, message: error.message, status: error.status}}); }
  }
  return results;
}
