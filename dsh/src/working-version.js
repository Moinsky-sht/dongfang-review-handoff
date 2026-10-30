/** Immutable DOCX working versions. Session recovery is a separate boundary. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, link, unlink, realpath, lstat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.DSH_WORKING_VERSION_ROOT || fileURLToPath(new URL('../data/working-versions/', import.meta.url)));
export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function storageError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function versionIdentity(sessionId, versionId) {
  if (typeof sessionId !== 'string' || !/^s[a-z0-9]+$/.test(sessionId) || typeof versionId !== 'string') {
    throw storageError('VERSION_ID_INVALID', '工作版本会话或版本身份无效');
  }
  const match = /^([a-z0-9]+):(v(\d{6,})-([a-f0-9]{64}))$/.exec(versionId || '');
  if (!match || match[1] !== sessionId) throw storageError('VERSION_ID_INVALID', '工作版本身份无效或不属于该会话');
  const revision = Number(match[3]);
  if (!Number.isSafeInteger(revision) || match[2] !== `v${String(revision).padStart(6, '0')}-${match[4]}`) {
    throw storageError('VERSION_ID_INVALID', '工作版本序号无效');
  }
  return { stem: match[2], revision, hash: match[4] };
}

async function checkedStorageFile(root, directory, name) {
  const path = join(directory, name);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw storageError('VERSION_PATH_INVALID', '工作版本存储文件类型无效');
  const actual = await realpath(path);
  const rel = relative(root, actual);
  if (rel.startsWith('..') || isAbsolute(rel)) throw storageError('VERSION_PATH_INVALID', '工作版本文件超出存储目录');
  return readFile(path);
}

/** Read a complete immutable snapshot; filenames come only from checked identity. */
export async function loadWorkingVersion({ sessionId, versionId, storageRoot = ROOT }) {
  const { stem, revision, hash } = versionIdentity(sessionId, versionId);
  let root; let directory;
  try {
    root = await realpath(resolve(storageRoot));
    directory = join(root, sessionId);
    const info = await lstat(directory);
    const actual = await realpath(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || relative(root, actual) !== sessionId) {
      throw storageError('VERSION_PATH_INVALID', '工作版本会话目录无效');
    }
  } catch (err) {
    if (err.code?.startsWith('VERSION_')) throw err;
    throw storageError('VERSION_NOT_FOUND', '工作版本存储目录不存在或不可读取', err);
  }
  let completeBytes;
  try { completeBytes = await checkedStorageFile(root, directory, `${stem}.complete.json`); }
  catch (err) {
    if (err.code?.startsWith('VERSION_')) throw err;
    throw storageError('VERSION_INCOMPLETE', '工作版本缺少完整提交标记', err);
  }
  let complete;
  try { complete = JSON.parse(completeBytes.toString('utf8')); }
  catch (err) { throw storageError('VERSION_CORRUPT', '工作版本提交标记损坏', err); }
  if (complete?.id !== versionId || complete.sha256 !== hash || !/^[a-f0-9]{64}$/.test(complete.metadataSha256 || '')) {
    throw storageError('VERSION_IDENTITY_MISMATCH', '工作版本提交标记身份不一致');
  }
  let metadata; let buffer; let originalBuffer;
  try {
    metadata = await checkedStorageFile(root, directory, `${stem}.json`);
    buffer = await checkedStorageFile(root, directory, `${stem}.docx`);
    originalBuffer = await checkedStorageFile(root, directory, 'original.docx');
  } catch (err) {
    if (err.code?.startsWith('VERSION_')) throw err;
    throw storageError('VERSION_INCOMPLETE', '工作版本快照文件缺损或不可读取', err);
  }
  if (sha256(metadata) !== complete.metadataSha256) throw storageError('VERSION_METADATA_HASH_MISMATCH', '工作版本元数据校验失败');
  let version;
  try { version = JSON.parse(metadata.toString('utf8')); }
  catch (err) { throw storageError('VERSION_CORRUPT', '工作版本元数据格式损坏', err); }
  if (version?.schemaVersion !== 1 || version.id !== versionId || version.sessionId !== sessionId
    || version.revision !== revision || version.sha256 !== hash || !/^[a-f0-9]{64}$/.test(version.sourceSha256 || '')) {
    throw storageError('VERSION_IDENTITY_MISMATCH', '工作版本元数据身份不一致');
  }
  if (version.parentId != null) versionIdentity(sessionId, version.parentId);
  if (sha256(buffer) !== hash) throw storageError('VERSION_HASH_MISMATCH', '工作 DOCX 字节校验失败');
  if (sha256(originalBuffer) !== version.sourceSha256) throw storageError('SOURCE_HASH_MISMATCH', '原始稿件字节校验失败');
  // metadata.file is retained for existing callers; never follow that path.
  return { version, buffer, originalBuffer };
}

async function immutableFile(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx');
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, path); }
    catch (err) {
      if (err.code !== 'EEXIST' || !(await readFile(path)).equals(Buffer.from(bytes))) throw err;
    }
  } finally {
    await unlink(temporary).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  }
}

export async function saveWorkingVersion({ sessionId, name, buffer, originalBuffer, parent = null, patches = [], operation = 'import-clean', revision: requestedRevision, storageRoot = ROOT }) {
  if (!/^s[a-z0-9]+$/.test(sessionId)) throw new Error('工作版本会话身份无效');
  if (parent) {
    const identity = versionIdentity(sessionId, parent.id);
    if (identity.revision !== parent.revision || (parent.sessionId != null && parent.sessionId !== sessionId)) {
      throw storageError('VERSION_IDENTITY_MISMATCH', '父工作版本身份不一致');
    }
  }
  const revision = requestedRevision === undefined ? (parent ? parent.revision + 1 : 0) : requestedRevision;
  if (!Number.isSafeInteger(revision) || revision < 0 || (!parent && revision !== 0) || (parent && revision <= parent.revision)) {
    throw storageError('VERSION_REVISION_INVALID', '工作版本序号必须从零开始且严格大于父版本');
  }
  const directory = join(storageRoot, sessionId);
  await mkdir(directory, { recursive: true });
  const sourceSha256 = sha256(originalBuffer);
  const hash = sha256(buffer);
  const stem = `v${String(revision).padStart(6, '0')}-${hash}`;
  let version = {
    schemaVersion: 1,
    id: `${sessionId}:${stem}`,
    sessionId, name, revision, sha256: hash, sourceSha256,
    parentId: parent?.id || null,
    operation,
    createdAt: new Date().toISOString(),
    file: `data/working-versions/${sessionId}/${stem}.docx`,
    patches,
  };
  // An interrupted attempt may have written the DOCX but not its metadata.
  // Verify identical existing files and finish the commit; never overwrite one.
  const metadataPath = join(directory, `${stem}.json`);
  try {
    const existing = JSON.parse(await readFile(metadataPath, 'utf8'));
    const stable = (v) => JSON.stringify({ ...v, createdAt: null });
    if (stable(existing) !== stable(version)) throw new Error('工作版本身份冲突');
    version = existing;
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (!parent) await immutableFile(join(directory, 'original.docx'), originalBuffer);
  await immutableFile(join(directory, `${stem}.docx`), buffer);
  const metadata = `${JSON.stringify(version, null, 2)}\n`;
  await immutableFile(metadataPath, metadata);
  await immutableFile(join(directory, `${stem}.complete.json`), `${JSON.stringify({ id: version.id, sha256: hash, metadataSha256: sha256(metadata) })}\n`);
  return version;
}
