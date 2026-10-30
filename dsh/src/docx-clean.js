/** Remove only OOXML comment parts/anchors, with exact XML span deletions. */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { openZip } from './zip.js';
import { writeZip } from './zip-write.js';
import { scanCleanXml, cleanAttr, deleteCleanSpans, cleanError } from './docx-clean-xml.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const WORD = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const ANCHORS = new Set(['commentRangeStart', 'commentRangeEnd', 'commentReference', 'annotationRef']);
const COMMENT_RELS = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/comments',
  'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
  'http://schemas.microsoft.com/office/2011/relationships/people',
  'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds',
  'http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible',
]);
const COMMENT_MIMES = new Set(['comments', 'commentsExtended', 'commentsIds', 'commentsExtensible', 'people']
  .flatMap((kind) => [`application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml`, `application/vnd.ms-word.${kind}+xml`]).map((mime) => mime.toLowerCase()));
const EXTRA_ROOTS = new Map([
  ['http://schemas.microsoft.com/office/word/2012/wordml', new Set(['commentsEx', 'people'])],
  ['http://schemas.microsoft.com/office/word/2010/11/wordml', new Set(['commentsEx', 'people'])],
  ['http://schemas.microsoft.com/office/word/2016/wordml/cid', new Set(['commentsIds'])],
  ['http://schemas.microsoft.com/office/word/2018/wordml/cex', new Set(['commentsExtensible'])],
]);
const isAnchor = (node) => WORD.has(node.ns) && ANCHORS.has(node.local);
const isCommentRoot = (node) => WORD.has(node.ns) && node.local === 'comments' || EXTRA_ROOTS.get(node.ns)?.has(node.local);
const isCommentMime = (mime) => COMMENT_MIMES.has(mime?.toLowerCase());
const relationshipPart = (part) => `${posix.dirname(part) === '.' ? '' : posix.dirname(part) + '/'}_rels/${posix.basename(part)}.rels`;
function sourcePart(rels) {
  if (rels === '_rels/.rels') return '';
  const match = /^(?:(.*)\/)?_rels\/([^/]+)\.rels$/i.exec(rels);
  if (!match) throw cleanError('CLEAN_RELATIONSHIP_PATH', '关系部件路径无效', rels);
  return `${match[1] ? match[1] + '/' : ''}${match[2]}`;
}
/** Resolve OPC relative/absolute targets and percent escapes without root escape. */
function targetPart(target, source, part, comment = false) {
  if (typeof target !== 'string' || !target) throw cleanError('CLEAN_RELATIONSHIP_TARGET', '关系目标为空', part);
  if (comment && /[?#]/.test(target)) throw cleanError('CLEAN_RELATIONSHIP_TARGET', '批注关系目标不能带查询或片段', part);
  const path = target.split(/[?#]/, 1)[0];
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes('\\')) throw cleanError('CLEAN_RELATIONSHIP_TARGET', '内部关系目标不是安全部件路径', part);
  const base = path.startsWith('/') ? [] : source ? posix.dirname(source).split('/').filter((piece) => piece !== '.') : [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch (error) { throw cleanError('CLEAN_RELATIONSHIP_TARGET', '关系目标转义无效', part, error); }
    if (/[\/\\\x00-\x1f?#]/.test(decoded)) throw cleanError('CLEAN_RELATIONSHIP_TARGET', '关系目标含不安全路径字符', part);
    if (decoded === '..') { if (!base.length) throw cleanError('CLEAN_RELATIONSHIP_TARGET', '关系目标越出文档包', part); base.pop(); }
    else if (decoded !== '.') base.push(decoded);
  }
  const result = base.join('/');
  if (!result && comment) throw cleanError('CLEAN_RELATIONSHIP_TARGET', '批注关系目标无效', part);
  return result;
}
function inspect(buffer) {
  let zip;
  try { zip = openZip(buffer); } catch (error) { throw cleanError('CLEAN_DOCX_INVALID', '无法读取 DOCX 容器', null, error); }
  // The shared reader tolerates a damaged later central entry. A cleaner must
  // refuse that partial inventory rather than repackage and silently lose it.
  let end = buffer.length - 22;
  const minimum = Math.max(0, buffer.length - 65557);
  while (end >= minimum && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < minimum || buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0
    || buffer.readUInt16LE(end + 8) !== buffer.readUInt16LE(end + 10)
    || buffer.readUInt16LE(end + 10) !== zip.names.length
    || buffer.readUInt32LE(end + 16) + buffer.readUInt32LE(end + 12) > end) {
    throw cleanError('CLEAN_PACKAGE_INVALID', 'DOCX 中央目录不完整或不支持分卷容器');
  }
  if (!zip.has('word/document.xml') || !zip.has('[Content_Types].xml')) throw cleanError('CLEAN_PACKAGE_INVALID', 'DOCX 缺少正文或内容类型声明');
  if (new Set(zip.names).size !== zip.names.length) throw cleanError('CLEAN_PACKAGE_INVALID', 'DOCX 包含重复部件名称');
  if (zip.totalUncompressed > 256 * 1024 * 1024) throw cleanError('CLEAN_PACKAGE_TOO_LARGE', 'DOCX 解压体积超过安全清洗上限');
  const names = new Set(zip.names);
  for (const name of names) if (name.startsWith('/') || name.includes('\\') || name.split('/').some((piece) => piece === '.' || piece === '..')) throw cleanError('CLEAN_PACKAGE_INVALID', 'DOCX 部件路径不规范', name);
  // OPC names compare case-insensitively. Resolve escaped URI names to their
  // physical ZIP spelling, and reject two entries competing for one identity.
  const identities = new Map();
  for (const name of names) if (!name.endsWith('/')) {
    const identity = targetPart('/' + name, '', name).toUpperCase();
    if (identities.has(identity)) throw cleanError('CLEAN_PACKAGE_AMBIGUOUS', 'DOCX 部件的规范化名称冲突', name);
    identities.set(identity, name);
  }
  const actualPart = (name) => identities.get(name.toUpperCase()) || name;
  const xmlParts = new Map();
  const partBytes = new Map();
  const readPart = (part) => {
    if (!partBytes.has(part)) {
      try { partBytes.set(part, zip.read(part)); }
      catch (error) { throw cleanError('CLEAN_ZIP_ENTRY_INVALID', 'DOCX 部件无法安全读取', part, error); }
    }
    return partBytes.get(part);
  };
  const readXml = (part) => {
    if (!xmlParts.has(part)) {
      if (!zip.has(part)) throw cleanError('CLEAN_DANGLING_COMMENT_RELATIONSHIP', '批注声明或关系目标不存在', part);
      xmlParts.set(part, scanCleanXml(readPart(part), part));
    }
    return xmlParts.get(part);
  };
  for (const name of names) if (/\.(?:xml|rels)$/i.test(name) && !name.endsWith('/')) readXml(name);
  const types = readXml('[Content_Types].xml');
  if (types.root.ns !== CT || types.root.local !== 'Types') throw cleanError('CLEAN_CONTENT_TYPES_INVALID', '内容类型声明的命名空间或根元素无效');
  const commentParts = new Set(); const typeRows = [];
  const overrides = new Set();
  for (const node of types.root.children) {
    if (node.ns !== CT || !['Override', 'Default'].includes(node.local)) throw cleanError('CLEAN_CONTENT_TYPES_INVALID', '不支持的内容类型声明', '[Content_Types].xml');
    const mime = cleanAttr(node, 'ContentType'); const rawName = cleanAttr(node, 'PartName'); const extension = cleanAttr(node, 'Extension');
    if (!mime || node.children.length) throw cleanError('CLEAN_CONTENT_TYPES_INVALID', '内容类型属性或结构无效', '[Content_Types].xml');
    if (/\.wordprocessingml\.(?:comments|people)/.test(mime) && !isCommentMime(mime)) throw cleanError('CLEAN_COMMENT_TYPE_UNSUPPORTED', '未支持的批注内容类型', '[Content_Types].xml');
    let name = null;
    if (node.local === 'Override') {
      if (!rawName?.startsWith('/')) throw cleanError('CLEAN_CONTENT_TYPES_INVALID', 'Override 部件名必须为包内绝对路径');
      name = actualPart(targetPart(rawName, '', '[Content_Types].xml', true));
      if (overrides.has(name.toUpperCase())) throw cleanError('CLEAN_CONTENT_TYPES_INVALID', '部件内容类型重复'); overrides.add(name.toUpperCase());
      if (isCommentMime(mime)) commentParts.add(name);
    } else {
      if (!extension || /[./\\]/.test(extension)) throw cleanError('CLEAN_CONTENT_TYPES_INVALID', 'Default 扩展名无效');
    }
    typeRows.push({ node, mime, name, extension });
  }
  // Overrides win independently of their declaration order.
  for (const row of typeRows) if (row.extension && isCommentMime(row.mime)) {
    for (const name of names) if (posix.extname(name).slice(1).toLowerCase() === row.extension.toLowerCase() && !overrides.has(name.toUpperCase())) commentParts.add(name);
  }
  const relations = [];
  for (const [part, scanned] of xmlParts) if (/\.rels$/i.test(part)) {
    if (scanned.root.ns !== REL || scanned.root.local !== 'Relationships') throw cleanError('CLEAN_RELATIONSHIP_INVALID', '关系根元素命名空间无效', part);
    const source = sourcePart(part); const canonicalSource = source ? targetPart('/' + source, '', part) : ''; const ids = new Set();
    for (const node of scanned.root.children) {
      if (node.ns !== REL || node.local !== 'Relationship' || node.children.length) throw cleanError('CLEAN_RELATIONSHIP_INVALID', '不支持的关系元素', part);
      const type = cleanAttr(node, 'Type'); const target = cleanAttr(node, 'Target'); const id = cleanAttr(node, 'Id'); const mode = cleanAttr(node, 'TargetMode');
      if (!type || !id || ids.has(id) || !target || mode && mode !== 'External' && mode !== 'Internal') throw cleanError('CLEAN_RELATIONSHIP_INVALID', '关系属性无效或 Id 重复', part);
      ids.add(id);
      if (/(?:schemas\.microsoft\.com|schemas\.openxmlformats\.org|purl\.oclc\.org)\/.*relationships\/(?:comments|people)/.test(type) && !COMMENT_RELS.has(type)) throw cleanError('CLEAN_COMMENT_TYPE_UNSUPPORTED', '未支持的批注关系类型', part);
      const comment = COMMENT_RELS.has(type);
      if (comment && mode === 'External') throw cleanError('CLEAN_EXTERNAL_COMMENT_RELATIONSHIP', '不能安全清洗外部批注关系', part);
      const resolved = mode === 'External' ? null : actualPart(targetPart(target, canonicalSource, part, comment));
      if (comment) commentParts.add(resolved);
      relations.push({ part, node, source, type, target: resolved, comment });
    }
  }
  for (const [part, scanned] of xmlParts) if (isCommentRoot(scanned.root)) commentParts.add(part);
  for (const part of commentParts) if (!isCommentRoot(readXml(part).root)) throw cleanError('CLEAN_COMMENT_PART_INVALID', '批注目标根元素与声明不符，拒绝删除非批注内容', part);
  const relatedParts = new Set([...commentParts].map((part) => actualPart(targetPart('/' + relationshipPart(part), '', part))).filter((part) => names.has(part)));
  const removedParts = new Set([...commentParts, ...relatedParts]);
  const anchors = [];
  for (const [part, scanned] of xmlParts) if (!removedParts.has(part)) {
    for (const node of scanned.nodes.filter(isAnchor)) {
      if (node.children.length || !node.selfClosing && scanned.xml.slice(node.openEnd, node.closeStart).trim()) throw cleanError('CLEAN_ANCHOR_INVALID', '批注锚点含非空内容，拒绝删除正文', part);
      anchors.push({ part, node });
    }
  }
  const removedRelations = relations.filter((relation) => removedParts.has(relation.part) || relation.comment || removedParts.has(relation.target));
  const removedTypes = typeRows.filter((row) => row.name ? removedParts.has(row.name) || isCommentMime(row.mime) : isCommentMime(row.mime));
  const comments = [...commentParts].reduce((total, part) => total + readXml(part).nodes.filter((node) => WORD.has(node.ns) && node.local === 'comment').length, 0);
  return { zip, readPart, xmlParts, commentParts, relatedParts, removedParts, anchors, removedRelations, removedTypes, comments };
}
const countsOf = (state) => ({ comments: state.comments, anchors: state.anchors.length, commentParts: state.commentParts.size,
  relationships: state.removedRelations.length, contentTypes: state.removedTypes.length });
/** Read-only residual inspector, also used by offline software-contract tests. */
export function inspectDocxComments(buffer) {
  const state = inspect(buffer);
  return { ...countsOf(state), parts: [...state.commentParts], relatedParts: [...state.relatedParts] };
}
/** @returns {{buffer: Buffer, stats: object}} No targets => exact original bytes. */
export function cleanDocx(buffer) {
  const sourceSha256 = hash(buffer); const before = inspect(buffer);
  const deletions = new Map();
  const add = ({ part, node }) => { if (!before.removedParts.has(part)) { if (!deletions.has(part)) deletions.set(part, []); deletions.get(part).push(node); } };
  before.anchors.forEach(add); before.removedRelations.forEach(add);
  before.removedTypes.forEach((row) => add({ part: '[Content_Types].xml', node: row.node }));
  const changed = before.removedParts.size > 0 || deletions.size > 0;
  if (changed && before.zip.names.some((name) => name.startsWith('_xmlsignatures/'))) throw cleanError('CLEAN_SIGNED_DOCUMENT', '清洗会破坏文档签名，拒绝改写签名文件');
  const replaced = new Map();
  for (const [part, nodes] of deletions) replaced.set(part, Buffer.from(deleteCleanSpans(before.xmlParts.get(part).xml, nodes, part), 'utf8'));
  const result = changed ? writeZip(before.zip.names.filter((name) => !before.removedParts.has(name))
    .map((name) => ({ name, data: replaced.get(name) || before.readPart(name) }))) : buffer;
  const after = changed ? inspect(result) : before;
  const afterCounts = countsOf(after);
  if (Object.values(afterCounts).some(Boolean)) throw cleanError('CLEAN_RESIDUAL_COMMENTS', '清洗验证发现残留批注、关系或内容类型');
  const preserved = before.zip.names.filter((name) => !before.removedParts.has(name) && !replaced.has(name));
  if (changed && !preserved.every((name) => before.readPart(name).equals(after.readPart(name)))) throw cleanError('CLEAN_PRESERVATION_FAILED', '清洗改变了非目标部件');
  return { buffer: result, stats: {
    commentsRemoved: before.comments, anchors: before.anchors.length, anchorsRemoved: before.anchors.length,
    commentParts: before.commentParts.size, commentRelationshipParts: before.relatedParts.size,
    relationships: before.removedRelations.length, contentTypes: before.removedTypes.length,
    partsTouched: [...replaced.keys()], partsRemoved: [...before.removedParts],
    sourceSha256, outputSha256: hash(result), changed, unchanged: !changed,
    beforeAfter: { before: countsOf(before), after: afterCounts, verified: true, untargetedPartsPreserved: preserved.length },
  } };
}
