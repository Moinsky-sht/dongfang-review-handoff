/**
 * Apply verified UTF-16 text ranges to a DOCX working copy.
 * All patches in a call address the input version. Unchanged ZIP entries and run
 * properties are copied verbatim. Replacement text inherits the first run's
 * formatting; later covered text nodes are emptied without removing their runs.
 * Fields, revisions and structural markers are never rebuilt or guessed across.
 */
import { createHash } from 'node:crypto';
import { openZip } from './zip.js';
import { writeZip } from './zip-write.js';
import { parseXml } from './xml.js';
import { paragraphText, parseDocxBuffer } from './docx.js';

const TARGET_PART = {
  body: 'word/document.xml',
  footnote: 'word/footnotes.xml',
  endnote: 'word/endnotes.xml',
};
const REVISIONS = new Set(['w:ins', 'w:del', 'w:moveFrom', 'w:moveTo']);
const SKIP_AFTER = new Set(['w:del', 'w:moveFrom']);
const FIGURES = new Set(['w:drawing', 'w:pict', 'w:object']);
const MARKERS = new Set([
  'w:footnoteReference', 'w:endnoteReference', 'w:commentRangeStart',
  'w:commentRangeEnd', 'w:commentReference', 'w:annotationRef',
  'w:bookmarkStart', 'w:bookmarkEnd', 'w:fldChar',
]);
const XML_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/;

function validText(text) {
  if (XML_CONTROL.test(text)) return false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch >= 0xd800 && ch <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (ch >= 0xdc00 && ch <= 0xdfff) return false;
  }
  return true;
}

function splitsSurrogate(text, at) {
  return at > 0 && at < text.length
    && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]);
}

/** Resolve application indexes through identities freshly parsed from this buffer. */
function partParagraphs(root, logical, partName) {
  const physical = root.descendants('w:p');
  return logical.map((paragraph, index) => {
    const ordinal = paragraph.sourceXmlParagraphOrdinal;
    const node = Number.isInteger(ordinal) && ordinal >= 0 ? physical[ordinal] : null;
    if (!node || paragraph.index !== index || paragraph.part !== partName
      || paragraph.id !== `${partName}:${index}` || paragraph.sourceXmlNodeId !== `${partName}:xml-p:${ordinal}`
      || paragraphText(node, 'after') !== paragraph.text) return null;
    return node;
  });
}

function checkedIdentity(patch, paragraph, partName, actualHash) {
  if (patch.textView != null && patch.textView !== 'after') return 'unsupported_text_view';
  if (patch.owner != null && !['after', 'application-paragraph-index'].includes(patch.owner)) return 'unsupported_source_owner';
  if (patch.offsetUnit != null && patch.offsetUnit !== 'utf16'
    || patch.rangeUnit != null && patch.rangeUnit !== 'utf16') return 'unsupported_offset_unit';
  if (patch.paragraphIndexOwner != null && patch.paragraphIndexOwner !== 'application-paragraph-index') return 'unsupported_index_owner';
  if (['ambiguous', 'unmapped', 'unresolved'].includes(patch.resolutionStatus)) return 'unresolved_source_range';
  if (patch.pid != null && patch.pid !== paragraph.id
    || patch.part != null && ![partName, `word/${partName}`].includes(patch.part)
    || patch.noteId != null && String(patch.noteId) !== paragraph.noteId
    || patch.sourceXmlParagraphOrdinal != null && patch.sourceXmlParagraphOrdinal !== paragraph.sourceXmlParagraphOrdinal
    || patch.sourceXmlNodeId != null && patch.sourceXmlNodeId !== paragraph.sourceXmlNodeId) return 'source_identity_mismatch';
  if ([patch.workSha256, patch.sourcePackageSha256].some((value) => value != null && value !== actualHash)) return 'work_hash_mismatch';
  for (const version of [patch.workVersionId, patch.versionId].filter((value) => value != null)) {
    const hash = /:v\d+-([a-f0-9]{64})$/.exec(version)?.[1];
    if (!hash) return 'source_version_unverified';
    if (hash !== actualHash) return 'work_hash_mismatch';
  }
  return null;
}

function editableTextNode(node, xml) {
  if (node.name !== 'w:t' || node.parent?.name !== 'w:r' || node.children.length
    || node.selfClosing || !Number.isInteger(node.closeStart)) return false;
  const raw = xml.slice(node.openEnd, node.closeStart);
  if (raw.includes('<') || !validText(raw)) return false;
  // Do not silently normalize invalid/unknown XML entities in the source.
  const rest = raw.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:\d+|x[0-9a-fA-F]+);/g, (entity) => {
    if (!entity.startsWith('&#')) return '';
    const code = entity.startsWith('&#x') ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
    return code > 0 && code <= 0x10ffff && validText(String.fromCodePoint(code)) ? '' : '&';
  });
  return !rest.includes('&');
}

function protectedContext(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (REVISIONS.has(p.name)) return 'unsupported_revision';
    if (p.name === 'w:fldSimple') return 'unsupported_field';
    if (p.name === 'w:sdt' || p.name === 'w:customXml') return 'unsupported_structure';
  }
  return null;
}

/**
 * Runs may share formatting-independent semantic wrappers (hyperlink, smartTag,
 * bidi wrappers, etc.). A replacement inherits its first run's parent context,
 * so it must not move text across distinct wrapper nodes, even with the same rid.
 */
function semanticContext(node) {
  const out = [];
  for (let p = node.parent; p && p.name !== 'w:p'; p = p.parent) {
    if (p.name !== 'w:r') out.push(p);
  }
  return out;
}

function sameContext(a, b) {
  return a.length === b.length && a.every((node, i) => node === b[i]);
}

/**
 * Mirror paragraphText's visible-text walk, then check exact parity at runtime.
 * Synthetic tab/break/symbol segments and hidden structural boundaries are
 * tracked but not editable. This prevents moving note references or fields.
 */
function mapParagraph(para, xml) {
  let text = '';
  let fieldDepth = 0;
  let pastSeparate = false;
  let unmatchedFieldEnd = false;
  const segments = [];
  const boundaries = [];
  const append = (value, node, reasonCode = null) => {
    if (!value) return;
    segments.push({ node, start: text.length, end: text.length + value.length, reasonCode });
    text += value;
  };
  const walk = (node, insideSkip) => {
    for (const c of node.children) {
      // Layout/property subtrees contain tab-stop declarations, not run text.
      // Skip them before they can also affect field state or structural bounds.
      if (c.name === 'w:pPr' || c.name === 'w:rPr') continue;
      const skipping = insideSkip || SKIP_AFTER.has(c.name);
      if (REVISIONS.has(c.name) || MARKERS.has(c.name) || FIGURES.has(c.name)) boundaries.push(text.length);
      if (c.name === 'w:commentReference' || c.name === 'w:annotationRef' || c.name === 'mc:Fallback') continue;
      if (FIGURES.has(c.name)) continue;
      if (c.name === 'w:fldChar') {
        const type = c.attr('w:fldCharType') || '';
        if (type === 'begin') { fieldDepth += 1; pastSeparate = false; }
        else if (type === 'separate') pastSeparate = true;
        else if (type === 'end') {
          if (fieldDepth === 0) unmatchedFieldEnd = true;
          fieldDepth = Math.max(0, fieldDepth - 1); pastSeparate = false;
        }
        continue;
      }
      if (c.name === 'w:instrText') continue;
      if (c.name === 'w:t' || c.name === 'w:delText') {
        if (!skipping && !(fieldDepth > 0 && !pastSeparate)) {
          const reason = fieldDepth > 0 ? 'unsupported_field' : protectedContext(c)
            || (!editableTextNode(c, xml) ? 'unsupported_xml_text' : null);
          append(c.allText(), c, reason);
        }
        continue;
      }
      if (c.name === 'w:footnoteReference' || c.name === 'w:endnoteReference') continue;
      if (c.name === 'w:tab') { if (!skipping && !(fieldDepth > 0 && !pastSeparate)) append('\t', c, 'unsupported_non_text'); continue; }
      if (c.name === 'w:br' || c.name === 'w:cr') { if (!skipping) append('\n', c, 'unsupported_non_text'); continue; }
      if (c.name === 'w:noBreakHyphen') { if (!skipping && !(fieldDepth > 0 && !pastSeparate)) append('-', c, 'unsupported_non_text'); continue; }
      if (c.name === 'w:sym') { if (!skipping) append('□', c, 'unsupported_non_text'); continue; }
      walk(c, skipping);
    }
  };
  walk(para, false);
  return { text, segments, boundaries, partialField: fieldDepth !== 0 || unmatchedFieldEnd,
    parity: text === paragraphText(para, 'after') };
}

const REASONS = {
  invalid_patch: '修改参数无效', duplicate_patch_id: '同一批修改的 patchId 重复',
  missing_part: '稿件没有该正文或注释部件', missing_paragraph: '目标段落不存在',
  stale_range: '当前范围的原文已变化，拒绝猜测修改位置',
  missing_text: '没有找到待修改原文', ambiguous_text: '原文存在多处，必须提供准确偏移',
  overlapping_range: '修改范围与同批其他修改重叠', unsupported_revision: '修改范围位于修订中',
  unsupported_field: '修改范围位于 Word 域中', unsupported_structure: '修改范围位于不支持的内容控件中',
  unsupported_non_text: '修改范围跨越换行、制表或符号结构',
  unsupported_boundary: '修改范围跨越注释、书签、图片或修订边界',
  unsupported_context: '修改范围跨越超链接或其他语义包装边界',
  unsupported_xml_text: '文字节点含不支持或无效的 XML 结构',
  mapping_mismatch: '源节点映射与解析器文字不一致', verification_failed: '修改后重新解析校验未通过',
  signed_document: '带数字签名的稿件不能在本流程改写',
  unsupported_package: 'ZIP 部件重复或解压体积超过解析器限制',
  unsupported_text_view: '修改范围不属于接受修订后的文本视图',
  unsupported_source_owner: '修改声明的来源 owner 不属于当前应用的 after 段落',
  unsupported_offset_unit: '修改范围未使用 UTF-16 偏移单位',
  unsupported_index_owner: '修改下标不属于应用段落列表',
  unresolved_source_range: '来源字符范围未唯一确定，拒绝猜测修改位置',
  source_identity_mismatch: '修改声明的段落、部件或物理节点身份不一致',
  work_hash_mismatch: '修改声明的工作稿散列与当前 DOCX 字节不一致',
  source_version_unverified: '修改声明的版本没有可核验的工作稿散列',
};

function escaped(text) { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function textElement(xml, node, value) {
  let open = xml.slice(node.openStart, node.openEnd);
  if (/^\s|\s$/.test(value)) {
    if (/\bxml:space\s*=/.test(open)) open = open.replace(/\bxml:space\s*=\s*(["'])[^"']*\1/, 'xml:space="preserve"');
    else open = open.replace(/>$/, ' xml:space="preserve">');
  }
  return open + escaped(value) + xml.slice(node.closeStart, node.closeStart + '</w:t>'.length);
}

/**
 * @param {Buffer} buffer Current DOCX working version (never mutated).
 * @param {Array<{patchId:string,target:'body'|'paragraph'|'footnote'|'endnote',index:number,offset?:number,find:string,replace:string}>} patches
 * @returns {{buffer:Buffer,applied:Array,skipped:Array}}
 * applied.offset is the verified input-version UTF-16 range start. Every skipped
 * item carries reasonCode/reason. Unsupported ranges keep the original bytes.
 */
export function applyDocxPatches(buffer, patches) {
  if (!Array.isArray(patches)) throw new TypeError('patches must be an array');
  if (!patches.length) return { buffer, applied: [], skipped: [] };
  const zip = openZip(buffer);
  const rejected = new Map();
  const reject = (entry, reasonCode) => rejected.set(entry.order, { ...entry.patch, reasonCode, reason: REASONS[reasonCode] });
  const ids = new Map();
  const entries = patches.map((patch, order) => ({ patch, order }));
  for (const { patch } of entries) if (patch?.patchId) ids.set(patch.patchId, (ids.get(patch.patchId) || 0) + 1);
  if (new Set(zip.names).size !== zip.names.length || zip.totalUncompressed > 300 * 1024 * 1024) {
    for (const entry of entries) reject(entry, 'unsupported_package');
    return { buffer, applied: [], skipped: [...rejected.values()] };
  }
  if (zip.names.some((name) => name.startsWith('_xmlsignatures/'))) {
    for (const entry of entries) reject(entry, 'signed_document');
    return { buffer, applied: [], skipped: [...rejected.values()] };
  }
  const actualHash = createHash('sha256').update(buffer).digest('hex');
  const doc = parseDocxBuffer(buffer);
  const parts = new Map();
  for (const entry of entries) {
    const p = entry.patch;
    const target = p?.target === 'paragraph' ? 'body' : p?.target;
    if (!p || typeof p.patchId !== 'string' || !p.patchId || !Object.hasOwn(TARGET_PART, target)
      || !Number.isInteger(p.index) || p.index < 0 || typeof p.find !== 'string' || !p.find
      || typeof p.replace !== 'string' || p.find === p.replace || !validText(p.find) || !validText(p.replace)
      || /[\t\r\n]/.test(p.replace) || (p.offset != null && (!Number.isInteger(p.offset) || p.offset < 0))) {
      reject(entry, 'invalid_patch'); continue;
    }
    if (ids.get(p.patchId) > 1) { reject(entry, 'duplicate_patch_id'); continue; }
    const partName = TARGET_PART[target];
    if (!parts.has(partName)) {
      const xml = zip.readText(partName);
      const basename = partName.slice(5); const logical = doc.parts[basename]?.paragraphs || [];
      parts.set(partName, xml == null ? null : { xml, logical, basename,
        paras: partParagraphs(parseXml(xml), logical, basename), candidates: [], maps: new Map() });
    }
    const part = parts.get(partName);
    if (!part) { reject(entry, 'missing_part'); continue; }
    const para = part.paras[p.index];
    if (!part.logical[p.index]) { reject(entry, 'missing_paragraph'); continue; }
    if (!para) { reject(entry, 'mapping_mismatch'); continue; }
    const identityReason = checkedIdentity(p, part.logical[p.index], part.basename, actualHash);
    if (identityReason) { reject(entry, identityReason); continue; }
    if (!part.maps.has(p.index)) part.maps.set(p.index, mapParagraph(para, part.xml));
    const mapping = part.maps.get(p.index);
    if (!mapping.parity) { reject(entry, 'mapping_mismatch'); continue; }
    if (mapping.partialField) { reject(entry, 'unsupported_field'); continue; }
    let offset = p.offset;
    if (offset == null) {
      offset = mapping.text.indexOf(p.find);
      if (offset < 0) { reject(entry, 'missing_text'); continue; }
      if (mapping.text.indexOf(p.find, offset + 1) >= 0) { reject(entry, 'ambiguous_text'); continue; }
    }
    const end = offset + p.find.length;
    if (mapping.text.slice(offset, end) !== p.find || splitsSurrogate(mapping.text, offset) || splitsSurrogate(mapping.text, end)) {
      reject(entry, 'stale_range'); continue;
    }
    const segments = mapping.segments.filter((s) => s.start < end && s.end > offset);
    const unsupported = segments.find((s) => s.reasonCode);
    if (unsupported) { reject(entry, unsupported.reasonCode); continue; }
    if (!segments.length) { reject(entry, 'mapping_mismatch'); continue; }
    const context = semanticContext(segments[0].node);
    if (segments.some((s) => !sameContext(context, semanticContext(s.node)))) {
      reject(entry, 'unsupported_context'); continue;
    }
    if (mapping.boundaries.some((at) => offset < at && at < end)) { reject(entry, 'unsupported_boundary'); continue; }
    part.candidates.push({ ...entry, offset, end, segments, identity: {
      pid: part.logical[p.index].id, part: partName,
      sourceXmlParagraphOrdinal: part.logical[p.index].sourceXmlParagraphOrdinal,
      sourceXmlNodeId: part.logical[p.index].sourceXmlNodeId,
      textView: 'after', offsetUnit: 'utf16', paragraphIndexOwner: 'application-paragraph-index', workSha256: actualHash,
    } });
  }

  const replaced = new Map();
  const accepted = [];
  for (const [partName, part] of parts) {
    if (!part) continue;
    for (let i = 0; i < part.candidates.length; i += 1) {
      const a = part.candidates[i];
      for (let j = i + 1; j < part.candidates.length; j += 1) {
        const b = part.candidates[j];
        if (a.patch.index === b.patch.index && a.offset < b.end && b.offset < a.end) {
          reject(a, 'overlapping_range'); reject(b, 'overlapping_range');
        }
      }
    }
    const pending = part.candidates.filter((e) => !rejected.has(e.order));
    if (!pending.length) continue;
    pending.sort((a, b) => a.patch.index - b.patch.index || b.offset - a.offset);
    const values = new Map();
    const expected = new Map();
    for (const entry of pending) {
      const { patch, offset, end, segments } = entry;
      const previous = expected.get(patch.index) ?? part.maps.get(patch.index).text;
      expected.set(patch.index, previous.slice(0, offset) + patch.replace + previous.slice(end));
      for (let i = 0; i < segments.length; i += 1) {
        const s = segments[i];
        const value = values.get(s.node) ?? s.node.allText();
        const from = Math.max(offset, s.start) - s.start;
        const to = Math.min(end, s.end) - s.start;
        values.set(s.node, value.slice(0, from) + (i === 0 ? patch.replace : '') + value.slice(to));
      }
    }
    const edits = [...values].map(([node, value]) => ({
      start: node.openStart, end: node.closeStart + '</w:t>'.length, value: textElement(part.xml, node, value),
    })).sort((a, b) => b.start - a.start);
    let xml = part.xml;
    for (const edit of edits) xml = xml.slice(0, edit.start) + edit.value + xml.slice(edit.end);
    const verified = partParagraphs(parseXml(xml), part.logical.map((paragraph, i) => ({ ...paragraph,
      text: expected.get(i) ?? paragraph.text })), part.basename);
    const okay = verified.length === part.paras.length && verified.every((para, i) =>
      para && part.paras[i] && paragraphText(para, 'after') === (expected.get(i) ?? paragraphText(part.paras[i], 'after')));
    if (!okay) { for (const entry of pending) reject(entry, 'verification_failed'); continue; }
    replaced.set(partName, Buffer.from(xml, 'utf8'));
    accepted.push(...pending);
  }
  const applied = accepted.sort((a, b) => a.order - b.order).map(({ patch, offset, identity }) => ({ ...patch, ...identity, offset }));
  const skipped = [...rejected].sort(([a], [b]) => a - b).map(([, result]) => result);
  if (!applied.length) return { buffer, applied, skipped };
  const result = writeZip(zip.names.map((name) => ({ name, data: replaced.get(name) || zip.read(name) })));
  return { buffer: result, applied, skipped };
}
