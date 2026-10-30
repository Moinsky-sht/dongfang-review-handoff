/** Immutable DOC-to-DOCX provenance. This is an archive, not a DOC upload adapter. */
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, link, unlink, lstat, realpath, readFile} from 'node:fs/promises';
import {resolve, join, dirname, parse, relative, sep} from 'node:path';
import {isOle2, openZip} from './zip.js';
import {parseDocxBuffer} from './docx.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const shaPattern = /^[a-f0-9]{64}$/;
const assetPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const archivePattern = /^dc-[A-Za-z0-9][A-Za-z0-9_-]{0,99}-[a-f0-9]{64}$/;
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
function fail(code, message, cause) { const error = new Error(message, cause ? {cause} : undefined); error.code = code; return error; }
function requireThat(ok, code, message) { if (!ok) throw fail(code, message); }
function plainJson(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return value;
  requireThat(value && typeof value === 'object' && !ancestors.has(value) && (Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value))), 'CONVERSION_INPUT_INVALID', '来源链必须是普通 JSON');
  ancestors.add(value);
  try {
    const out = Array.isArray(value) ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireThat(typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value') && !['__proto__', 'constructor', 'prototype'].includes(key), 'CONVERSION_INPUT_INVALID', '来源不能含访问器或保留字段');
      Object.defineProperty(out, key, {value: plainJson(descriptor.value, ancestors), enumerable: true});
    }
    requireThat(!Array.isArray(value) || out.length === value.length && Array.from({length: value.length}, (_, i) => i).every(i => Object.hasOwn(value, i)), 'CONVERSION_INPUT_INVALID', '来源链不能含空数组项');
    return out;
  } finally { ancestors.delete(value); }
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function syncDirectory(path) {
  let handle;
  try { handle = await open(path, 'r'); await handle.sync(); }
  catch (error) { if (!['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}
async function directory(path, {create = false, writing = false} = {}) {
  requireThat(typeof path === 'string' && !path.replaceAll('\\', '/').split('/').includes('..'), 'CONVERSION_PATH_INVALID', '转换路径不能含逃逸分量');
  const absolute = resolve(path); let cursor = parse(absolute).root;
  for (const part of relative(cursor, absolute).split(sep).filter(Boolean)) {
    if (writing && await exists(join(cursor, 'complete.json'))) throw fail('CONVERSION_TARGET_SEALED', '转换凭证不能写入已封存目录');
    cursor = join(cursor, part); let stat;
    try { stat = await lstat(cursor); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      try { await mkdir(cursor); await syncDirectory(dirname(cursor)); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      stat = await lstat(cursor);
    }
    requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'CONVERSION_PATH_ALIAS', '转换凭证路径必须是物理目录');
  }
  requireThat(resolve(await realpath(absolute)) === absolute, 'CONVERSION_PATH_ALIAS', '转换凭证路径身份不一致');
  if (writing && await exists(join(absolute, 'complete.json'))) throw fail('CONVERSION_TARGET_SEALED', '转换凭证不能写入已封存目录');
  return absolute;
}
const sameStat = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
async function stableRead(path, expectedSha256) {
  requireThat(typeof path === 'string' && path.length > 0, 'CONVERSION_PATH_INVALID', '转换文件路径缺失');
  requireThat(!path.replaceAll('\\', '/').split('/').includes('..'), 'CONVERSION_PATH_INVALID', '转换文件路径不能含逃逸分量');
  const absolute = resolve(path); await directory(dirname(absolute));
  const before = await lstat(absolute, {bigint: true});
  requireThat(before.isFile() && !before.isSymbolicLink() && resolve(await realpath(absolute)) === absolute, 'CONVERSION_PATH_ALIAS', '转换证据必须是物理文件');
  const handle = await open(absolute, 'r'); let bytes;
  try {
    const opened = await handle.stat({bigint: true});
    requireThat(sameStat(before, opened), 'CONVERSION_INPUT_CHANGED', '读取前文件身份已改变');
    bytes = await handle.readFile();
    requireThat(sameStat(opened, await handle.stat({bigint: true})), 'CONVERSION_INPUT_CHANGED', '读取期间文件已改变');
  } finally { await handle.close(); }
  await directory(dirname(absolute)); const after = await lstat(absolute, {bigint: true});
  requireThat(!after.isSymbolicLink() && sameStat(before, after), 'CONVERSION_INPUT_CHANGED', '读取后文件身份已改变');
  const sha256 = hash(bytes);
  if (expectedSha256 != null) requireThat(shaPattern.test(expectedSha256) && sha256 === expectedSha256, 'CONVERSION_HASH_MISMATCH', '转换文件或证据 SHA 不匹配');
  return {path: absolute, bytes, sha256, stat: after};
}
async function unchanged(input) {
  const current = await stableRead(input.path);
  requireThat(current.sha256 === input.sha256 && sameStat(current.stat, input.stat), 'CONVERSION_INPUT_CHANGED', '归档前来源或证据已改变');
}
async function immutable(path, bytes) {
  await directory(dirname(path), {create: true, writing: true});
  if (await exists(path)) { requireThat((await stableRead(path)).bytes.equals(bytes), 'CONVERSION_IMMUTABLE_CONFLICT', '已有转换凭证不能覆盖'); return; }
  const temporary = `${path}.${randomUUID()}.tmp`; const handle = await open(temporary, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await directory(dirname(path), {writing: true});
    try { await link(temporary, path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; requireThat((await stableRead(path)).bytes.equals(bytes), 'CONVERSION_IMMUTABLE_CONFLICT', '已有转换凭证内容冲突'); }
    await syncDirectory(dirname(path));
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function identityOf(args) {
  requireThat(assetPattern.test(args.assetId || '') && typeof args.originalPath === 'string' && args.originalPath.length > 0 && args.originalPath.length < 4096 && !args.originalPath.includes('\0'), 'CONVERSION_IDENTITY_INVALID', '原稿资产或来源路径无效');
  requireThat(!args.originalPath.replaceAll('\\', '/').split('/').includes('..'), 'CONVERSION_PATH_INVALID', '来源路径不能逃逸');
  const sourceChain = plainJson(args.sourceChain ?? null), member = Array.isArray(sourceChain) ? sourceChain.at(-1) : null;
  requireThat(sourceChain === null || Array.isArray(sourceChain) && sourceChain.length >= 2 && sourceChain.length <= 32, 'CONVERSION_SOURCE_CHAIN_MISMATCH', '来源链必须为原稿或明确的归档成员链');
  if (sourceChain !== null) {
    requireThat(assetPattern.test(sourceChain[0]?.assetId || '') && shaPattern.test(sourceChain[0]?.sha256 || '') && typeof sourceChain[0]?.sourcePath === 'string', 'CONVERSION_SOURCE_CHAIN_MISMATCH', '来源链缺少固定原归档身份');
    for (const step of sourceChain.slice(1)) requireThat(step?.kind === 'archive-member' && assetPattern.test(step.derivedAssetId || '') && shaPattern.test(step.contentSha256 || '') && Number.isSafeInteger(step.ordinal) && step.ordinal >= 0 && typeof step.name === 'string' && step.name.length > 0 && !step.name.replaceAll('\\', '/').split('/').includes('..'), 'CONVERSION_SOURCE_CHAIN_MISMATCH', '归档成员来源链无效');
  }
  const archiveOrdinal = args.archiveOrdinal ?? (member?.kind === 'archive-member' ? member.ordinal : 0);
  requireThat(Number.isSafeInteger(archiveOrdinal) && archiveOrdinal >= 0, 'CONVERSION_IDENTITY_INVALID', '归档序号无效');
  requireThat(shaPattern.test(args.source?.sha256 || '') && shaPattern.test(args.converted?.sha256 || ''), 'CONVERSION_INPUT_INVALID', '双方必须提供固定 SHA');
  if (member?.kind === 'archive-member') requireThat(member.derivedAssetId === args.assetId && member.contentSha256 === args.source.sha256 && member.ordinal === archiveOrdinal, 'CONVERSION_SOURCE_CHAIN_MISMATCH', '派生稿件与来源链不一致');
  if (args.assetId.startsWith('derived-')) requireThat(member?.kind === 'archive-member', 'CONVERSION_SOURCE_CHAIN_MISMATCH', '派生资产缺少归档成员来源链');
  return {assetId: args.assetId, originalPath: args.originalPath, sourceChain, archiveOrdinal, sourceSha256: args.source.sha256, convertedSha256: args.converted.sha256};
}
const archiveIdFor = identity => `dc-${identity.assetId}-${hash(canonical(identity))}`;
function selectRecord(value, recordPath = []) {
  requireThat(Array.isArray(recordPath) && recordPath.length <= 16, 'CONVERSION_EVIDENCE_INVALID', '证据记录选择路径无效');
  for (const key of recordPath) {
    requireThat((typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key) || Number.isSafeInteger(key) && key >= 0) && value && typeof value === 'object' && Object.hasOwn(value, key), 'CONVERSION_EVIDENCE_INVALID', '证据中没有指定记录');
    value = value[key];
  }
  return value;
}
function validateEvidence(bytes, ref, identity) {
  requireThat(typeof ref.kind === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(ref.kind) && typeof ref.scope === 'string' && ref.scope.trim().length > 0 && ref.scope.length <= 2000, 'CONVERSION_EVIDENCE_INVALID', '每份证据必须说明类型与实际范围');
  let json; try { json = JSON.parse(bytes.toString('utf8')); } catch (error) { throw fail('CONVERSION_EVIDENCE_INVALID', '范围证据必须是 JSON', error); }
  const record = selectRecord(json, ref.recordPath);
  requireThat(record?.assetId === identity.assetId && record.sourceSha256 === identity.sourceSha256 && record.convertedSha256 === identity.convertedSha256, 'CONVERSION_EVIDENCE_BINDING_MISMATCH', '实际证据记录不属于此资产或转换字节');
  requireThat(record.sourcePath === identity.originalPath && canonical(record.sourceChain ?? null) === canonical(identity.sourceChain) && (record.archiveOrdinal == null || record.archiveOrdinal === identity.archiveOrdinal), 'CONVERSION_EVIDENCE_BINDING_MISMATCH', '实际证据中的来源路径、成员链或序号不一致');
}
function parsedSummary(bytes) {
  try {
    requireThat(!isOle2(bytes) && bytes[0] === 0x50 && bytes[1] === 0x4b, 'CONVERSION_DOCX_INVALID', '转换结果不是 DOCX ZIP');
    const zip = openZip(bytes);
    requireThat(zip.has('[Content_Types].xml') && zip.has('word/document.xml') && zip.names.length === new Set(zip.names).size && zip.totalUncompressed <= 256 * 1024 * 1024, 'CONVERSION_DOCX_INVALID', '转换结果的 DOCX 包结构无效');
    const doc = parseDocxBuffer(bytes, 'archived-conversion.docx');
    return {parsed: true, sourcePackageSha256: doc.sourcePackageSha256, bodyParagraphs: doc.paragraphs.length, footnoteParagraphs: doc.footnotes.length, endnoteParagraphs: doc.endnotes.length, tables: doc.tables.length, comments: doc.comments.length, revisions: doc.revisions.length};
  } catch (error) { if (error.code === 'CONVERSION_DOCX_INVALID') throw error; throw fail('CONVERSION_DOCX_INVALID', '转换结果不能完整解析', error); }
}
function rootOf(storageRoot) { requireThat(typeof storageRoot === 'string' && storageRoot.length > 0, 'CONVERSION_ROOT_REQUIRED', '必须显式指定独立转换凭证根目录'); requireThat(!storageRoot.replaceAll('\\', '/').split('/').includes('..'), 'CONVERSION_PATH_INVALID', '转换凭证根不能含逃逸分量'); return resolve(storageRoot); }
const fixedState = {status: 'partial', formatReady: false, independentQuality: 'unverified', visual: 'unverified', reviewIntakeStatus: 'pending', currentDocUploadSupported: false};
function assertFixedState(value) { for (const [key, expected] of Object.entries(fixedState)) requireThat(!Object.hasOwn(value, key) || value[key] === expected, 'CONVERSION_PROMOTION_FORBIDDEN', '转换字节归档不能升级保真、接入或内容质量结论'); }

/** Archive exact immutable bytes. Evidence declarations certify binding, never full fidelity. */
export async function archiveDocConversionReceipt(args) {
  const allowed = new Set(['storageRoot', 'assetId', 'originalPath', 'sourceChain', 'archiveOrdinal', 'source', 'converted', 'evidenceRefs', 'faultHooks', ...Object.keys(fixedState)]);
  requireThat(args && typeof args === 'object' && Object.keys(args).every(key => allowed.has(key)), 'CONVERSION_INPUT_INVALID', '转换凭证含未知输入字段');
  assertFixedState(args); const identity = identityOf(args), archiveId = archiveIdFor(identity), storageRoot = rootOf(args.storageRoot);
  await directory(storageRoot, {create: true, writing: true});
  requireThat(Array.isArray(args.evidenceRefs) && args.evidenceRefs.length > 0 && args.evidenceRefs.length <= 100, 'CONVERSION_EVIDENCE_INVALID', '转换关联必须有实际范围证据');
  const source = await stableRead(args.source.path, identity.sourceSha256), converted = await stableRead(args.converted.path, identity.convertedSha256);
  requireThat(isOle2(source.bytes) && source.bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')), 'CONVERSION_DOC_INVALID', '原稿不是 OLE2 DOC 字节');
  const parser = parsedSummary(converted.bytes), evidence = [], inputs = [source, converted];
  for (let i = 0; i < args.evidenceRefs.length; i++) {
    const ref = plainJson(args.evidenceRefs[i]);
    requireThat(Object.keys(ref).every(key => ['path', 'sha256', 'kind', 'scope', 'recordPath'].includes(key)) && shaPattern.test(ref.sha256 || ''), 'CONVERSION_EVIDENCE_INVALID', '证据字段或 SHA 无效');
    const input = await stableRead(ref.path, ref.sha256); validateEvidence(input.bytes, ref, identity); inputs.push(input);
    evidence.push({file: `evidence/${String(i + 1).padStart(4, '0')}.json`, sha256: input.sha256, size: input.bytes.length, kind: ref.kind, scope: ref.scope, recordPath: ref.recordPath || [], bytes: input.bytes});
  }
  const refs = evidence.map(({bytes, ...ref}) => ref);
  const sourceManifest = {schemaVersion: 1, kind: 'doc-conversion-source-manifest', identity, source: {file: 'source.doc', sha256: source.sha256, size: source.bytes.length, format: 'ole2-doc'}, converted: {file: 'converted.docx', sha256: converted.sha256, size: converted.bytes.length, format: 'docx'}, evidenceRefs: refs};
  const receipt = {schemaVersion: 1, kind: 'doc-conversion-receipt', archiveId, ...identity, ...fixedState, proofScope: 'immutable-bytes-and-declared-source-binding', sourceManifestSha256: hash(encode(sourceManifest)), parser, evidenceRefs: refs};
  receipt.requestFingerprint = hash(canonical(receipt));
  const destination = join(storageRoot, archiveId), receiptBytes = encode(receipt);
  await args.faultHooks?.afterInputsRead?.({archiveId, directory: destination});
  for (const input of inputs) await unchanged(input);
  if (await exists(join(destination, 'receipt.complete.json'))) {
    const old = await loadDocConversionReceipt({storageRoot, archiveId});
    requireThat(old.receiptSha256 === hash(receiptBytes), 'CONVERSION_IMMUTABLE_CONFLICT', '相同转换身份已有不同证据范围，拒绝覆盖');
    return {...old, replayed: true};
  }
  const payload = [['source.doc', source.bytes], ['converted.docx', converted.bytes], ['source-manifest.json', encode(sourceManifest)], ['receipt.json', receiptBytes], ...evidence.map(ref => [ref.file, ref.bytes])];
  for (const [file, bytes] of payload) await immutable(join(destination, file), bytes);
  await args.faultHooks?.beforeCommit?.({archiveId, directory: destination});
  for (const input of inputs) await unchanged(input);
  const complete = {schemaVersion: 1, kind: 'doc-conversion-complete', archiveId, receiptSha256: hash(receiptBytes), files: payload.map(([file, bytes]) => ({file, sha256: hash(bytes), size: bytes.length}))};
  await immutable(join(destination, 'receipt.complete.json'), encode(complete));
  await syncDirectory(destination); await syncDirectory(storageRoot);
  return {...await loadDocConversionReceipt({storageRoot, archiveId}), replayed: false};
}

/** Pure read; sealed evidence remains readable. Every byte and identity is revalidated. */
export async function loadDocConversionReceipt({storageRoot, archiveId, expectedReceiptSha256} = {}) {
  requireThat(archivePattern.test(archiveId || ''), 'CONVERSION_IDENTITY_INVALID', '转换凭证身份无效');
  const root = rootOf(storageRoot), destination = join(root, archiveId); await directory(destination);
  let complete, completeInput; try { completeInput = await stableRead(join(destination, 'receipt.complete.json')); complete = JSON.parse(completeInput.bytes); }
  catch (error) { throw fail('CONVERSION_ARCHIVE_INCOMPLETE', '转换凭证未完成或已损坏', error); }
  requireThat(complete.schemaVersion === 1 && complete.kind === 'doc-conversion-complete' && complete.archiveId === archiveId && shaPattern.test(complete.receiptSha256 || '') && Array.isArray(complete.files), 'CONVERSION_ARCHIVE_CORRUPT', '转换凭证完成标记无效');
  if (expectedReceiptSha256 != null) requireThat(expectedReceiptSha256 === complete.receiptSha256 && shaPattern.test(expectedReceiptSha256), 'CONVERSION_HASH_MISMATCH', '转换凭证不匹配固定收据 SHA');
  const files = new Map();
  for (const item of complete.files) {
    requireThat(item && /^(?:source\.doc|converted\.docx|source-manifest\.json|receipt\.json|evidence\/[0-9]{4}\.json)$/.test(item.file || '') && !files.has(item.file) && shaPattern.test(item.sha256 || '') && Number.isSafeInteger(item.size) && item.size >= 0, 'CONVERSION_ARCHIVE_CORRUPT', '转换凭证文件列表无效');
    const input = await stableRead(join(destination, item.file), item.sha256); requireThat(input.bytes.length === item.size, 'CONVERSION_ARCHIVE_CORRUPT', '转换凭证文件大小不一致'); files.set(item.file, input);
  }
  let receipt, manifest;
  try { receipt = JSON.parse(files.get('receipt.json').bytes); manifest = JSON.parse(files.get('source-manifest.json').bytes); }
  catch (error) { throw fail('CONVERSION_ARCHIVE_CORRUPT', '转换凭证缺少有效来源记录', error); }
  requireThat(hash(files.get('receipt.json').bytes) === complete.receiptSha256 && receipt.schemaVersion === 1 && receipt.kind === 'doc-conversion-receipt' && receipt.archiveId === archiveId, 'CONVERSION_ARCHIVE_CORRUPT', '转换收据身份无效');
  for (const [key, expected] of Object.entries(fixedState)) requireThat(receipt[key] === expected, 'CONVERSION_PROMOTION_FORBIDDEN', '归档转换凭证不能宣称保真通过');
  const identity = identityOf({...receipt, source: {sha256: receipt.sourceSha256}, converted: {sha256: receipt.convertedSha256}});
  requireThat(archiveIdFor(identity) === archiveId && manifest.schemaVersion === 1 && manifest.kind === 'doc-conversion-source-manifest' && canonical(manifest.identity) === canonical(identity) && receipt.sourceManifestSha256 === hash(files.get('source-manifest.json').bytes), 'CONVERSION_ARCHIVE_CORRUPT', '转换凭证来源关联不一致');
  const {requestFingerprint, ...fingerprintBody} = receipt;
  requireThat(requestFingerprint === hash(canonical(fingerprintBody)) && Array.isArray(receipt.evidenceRefs) && receipt.evidenceRefs.length > 0 && canonical(manifest.evidenceRefs) === canonical(receipt.evidenceRefs), 'CONVERSION_ARCHIVE_CORRUPT', '转换凭证内容指纹不一致');
  requireThat(files.size === 4 + receipt.evidenceRefs.length && files.get('source.doc')?.sha256 === identity.sourceSha256 && files.get('converted.docx')?.sha256 === identity.convertedSha256 && manifest.source?.file === 'source.doc' && manifest.source.sha256 === identity.sourceSha256 && manifest.source.size === files.get('source.doc').bytes.length && manifest.converted?.file === 'converted.docx' && manifest.converted.sha256 === identity.convertedSha256 && manifest.converted.size === files.get('converted.docx').bytes.length, 'CONVERSION_ARCHIVE_CORRUPT', '转换凭证字节身份不一致');
  requireThat(files.get('source.doc').bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')), 'CONVERSION_DOC_INVALID', '归档原稿不是 OLE2 DOC');
  requireThat(canonical(parsedSummary(files.get('converted.docx').bytes)) === canonical(receipt.parser), 'CONVERSION_ARCHIVE_CORRUPT', '转换凭证解析记录不一致');
  for (const [i, ref] of receipt.evidenceRefs.entries()) {
    requireThat(ref.file === `evidence/${String(i + 1).padStart(4, '0')}.json` && Object.keys(ref).every(key => ['file', 'sha256', 'size', 'kind', 'scope', 'recordPath'].includes(key)), 'CONVERSION_ARCHIVE_CORRUPT', '转换凭证证据文件身份不一致');
    const item = files.get(ref.file); requireThat(item?.sha256 === ref.sha256 && item.bytes.length === ref.size, 'CONVERSION_ARCHIVE_CORRUPT', '转换凭证证据引用不一致'); validateEvidence(item.bytes, ref, identity);
  }
  for (const input of files.values()) await unchanged(input);
  await unchanged(completeInput);
  return {receipt, directory: destination, receiptSha256: complete.receiptSha256, sourcePath: join(destination, 'source.doc'), convertedPath: join(destination, 'converted.docx')};
}
