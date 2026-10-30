/** Word comments preserve note text; note sources target verified MainDocument reference runs. */
import { createHash } from 'node:crypto';
import { openZip } from './zip.js';
import { writeZip } from './zip-write.js';
import { parseXml } from './xml.js';
import { paragraphText, parseDocxBuffer } from './docx.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const COMMENTS_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const COMMENTS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const PART = { paragraph: 'word/document.xml', footnote: 'word/footnotes.xml', endnote: 'word/endnotes.xml' };
const SKIP = new Set(['w:del', 'w:moveFrom', 'w:drawing', 'w:pict', 'w:object', 'mc:Fallback', 'w:pPr', 'w:rPr']);
const PROTECTED = new Set(['w:ins', 'w:moveTo', 'w:fldSimple', 'w:sdt', 'w:customXml']);
const REASONS = {
  unsupported_source_target: '该问题没有可验证的正文、脚注或尾注来源',
  conflicting_source_target: '问题的来源类型或下标相互冲突，未猜测导出位置',
  missing_source_part: '当前稿件没有问题来源部件', missing_source_paragraph: '当前稿件没有问题来源段落',
  invalid_source_range: '来源字符范围无效或切断字符', stale_source_range: '当前来源范围文字已变化，未重新搜索或猜测',
  ambiguous_source_range: '原文出现多次，缺少可验证的字符范围', source_identity_mismatch: '来源注号、段落或部件身份不一致',
  source_version_mismatch: '问题范围不属于本次导出的工作版本', source_version_unverified: '问题声明了版本身份，但导出未提供可核验的当前版本',
  needs_relocation: '该问题范围已失效，需要重新定位后导出', work_hash_mismatch: '当前 DOCX 字节与声明的工作版本散列不一致',
  separator_note: '分隔符不是真正的脚注或尾注，未添加批注', ambiguous_note_id: '同类注释有重复注号，无法证明引用归属',
  orphan_note: '当前正文没有该注释的可见引用，未添加批注',
  unsupported_reference_structure: '正文注释引用位于不支持的结构中，或同一 run 混有文字；未伪称精确引用批注',
  unsupported_package: 'DOCX 包、批注关系或内容类型不支持安全追加', signed_document: '带数字签名的稿件不能在本流程改写',
  unsupported_text_view: '批注来源不属于接受修订后的文本视图',
  unsupported_source_owner: '批注声明的来源 owner 不属于当前应用的 after 段落',
  unsupported_offset_unit: '批注来源未使用 UTF-16 偏移单位',
  unsupported_index_owner: '批注来源下标不属于应用段落列表',
  unresolved_source_range: '批注来源字符范围未唯一确定，未重新猜测位置',
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const issueKey = (it) => it?.issueKey || `${it?.ruleId || ''}|${it?.location || ''}|${it?.quote || ''}`;
const nodeEnd = (node) => node.selfClosing ? node.openEnd : Number.isInteger(node.sourceEnd) ? node.sourceEnd : null;
function sourcePart(zip, kind, doc) {
  const xml = zip.readText(PART[kind]); if (!xml) return null;
  const root = parseXml(xml); const items = []; const idCounts = new Map();
  // XML permits whitespace in closing tags. Use their actual source extent,
  // never a computed tag-name length, before inserting outside a run or pPr.
  for (const node of root.descendants()) if (Number.isInteger(node.closeStart)) {
    const end = xml.indexOf('>', node.closeStart);
    if (end >= 0) node.sourceEnd = end + 1;
  }
  if (kind === 'paragraph') {
    const body = root.descendants('w:body')[0]; if (!body) return null;
  } else for (const container of root.descendants(`w:${kind}`)) {
    const noteId = container.attr('w:id');
    idCounts.set(noteId, (idCounts.get(noteId) || 0) + 1);
  }
  const basename = PART[kind].slice(5); const physical = root.descendants('w:p');
  for (const [index, paragraph] of (doc.parts[basename]?.paragraphs || []).entries()) {
    const ordinal = paragraph.sourceXmlParagraphOrdinal;
    const node = Number.isInteger(ordinal) && ordinal >= 0 ? physical[ordinal] : null;
    const mapped = node && paragraph.index === index && paragraph.part === basename
      && paragraph.id === `${basename}:${index}` && paragraph.sourceXmlNodeId === `${basename}:xml-p:${ordinal}`
      && paragraphText(node, 'after') === paragraph.text;
    items.push({ node: mapped ? node : null, paragraph, noteId: paragraph.noteId, noteType: paragraph.noteType || '' });
  }
  return { xml, root, items, idCounts };
}
function ancestorHas(node, names) {
  for (let parent = node.parent; parent; parent = parent.parent) if (names.has(parent.name)) return true;
  return false;
}
/** A note reference occupies a visible UTF-16 boundary, not a text character. */
function visibleReferences(main) {
  const indexByNode = new Map(main.items.map(({ node }, index) => [node, index]));
  const body = main.root.descendants('w:body')[0]; const references = [];
  const field = { depth: 0, separate: false };
  for (const para of body.descendants('w:p')) {
    if (ancestorHas(para, SKIP)) continue;
    let text = ''; const here = []; let malformedField = false;
    const walk = (node) => {
      for (const child of node.children) {
        if (SKIP.has(child.name) || child.name === 'w:commentReference' || child.name === 'w:annotationRef') continue;
        if (child.name === 'w:fldChar') {
          const type = child.attr('w:fldCharType');
          if (type === 'begin') { field.depth += 1; field.separate = false; }
          else if (type === 'separate') field.separate = true;
          else if (type === 'end') { if (!field.depth) malformedField = true; field.depth = Math.max(0, field.depth - 1); field.separate = false; }
          continue;
        }
        if (child.name === 'w:instrText') continue;
        const visible = !(field.depth > 0 && !field.separate);
        if (child.name === 'w:t' || child.name === 'w:delText') { if (visible) text += child.allText(); continue; }
        if (child.name === 'w:footnoteReference' || child.name === 'w:endnoteReference') {
          if (visible) {
            const run = child.parent; const index = indexByNode.get(para);
            const safe = run?.name === 'w:r' && run.parent === para && !ancestorHas(child, PROTECTED)
              && field.depth === 0 && Number.isInteger(index) && Number.isInteger(nodeEnd(run))
              && run.children.filter((n) => n.name !== 'w:rPr').length === 1;
            here.push({ kind: child.name === 'w:footnoteReference' ? 'footnote' : 'endnote', noteId: child.attr('w:id'),
              paragraph: Number.isInteger(index) ? main.items[index].paragraph : null,
              node: child, run, paragraphIndex: index ?? null, offset: text.length, safe });
          }
          continue;
        }
        if (child.name === 'w:tab' || child.name === 'w:noBreakHyphen') {
          if (visible) text += child.name === 'w:tab' ? '\t' : '-';
          continue;
        }
        if (child.name === 'w:br' || child.name === 'w:cr' || child.name === 'w:sym') {
          // Match the parser's current raw view. These characters are retained
          // even in an instruction prefix; references in fields remain unsafe.
          text += child.name === 'w:sym' ? '□' : '\n';
          continue;
        }
        walk(child);
      }
    };
    walk(para);
    const parity = text === paragraphText(para, 'after');
    for (const entry of here) { entry.safe &&= parity && !malformedField; references.push(entry); }
  }
  const counts = new Map();
  for (const entry of references) { const key = `${entry.kind}:${entry.noteId}`; entry.occurrence = counts.get(key) || 0; counts.set(key, entry.occurrence + 1); }
  return references;
}
function referenceDTO(entry) {
  return { part: PART.paragraph, paragraphIndex: entry.paragraphIndex, pid: entry.paragraphIndex == null ? null : `document.xml:${entry.paragraphIndex}`,
    sourceXmlParagraphOrdinal: entry.paragraph?.sourceXmlParagraphOrdinal ?? null,
    sourceXmlNodeId: entry.paragraph?.sourceXmlNodeId ?? null,
    textView: 'after', offsetUnit: 'utf16', paragraphIndexOwner: 'application-paragraph-index',
    reference: { kind: entry.kind, noteId: entry.noteId, occurrence: entry.occurrence, offset: entry.offset, offsetUnit: 'utf16-boundary', occupiesText: false },
    xmlRange: { start: entry.run?.openStart ?? null, end: entry.run ? nodeEnd(entry.run) : null,
      referenceStart: entry.node.openStart, referenceEnd: nodeEnd(entry.node), unit: 'xml-utf16', basis: 'input-word/document.xml' }, precision: 'note-reference' };
}
function splitSurrogate(text, offset) { return offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]); }
function checkedSource(it, anchor, parts, workVersionId, workSha256) {
  const kind = anchor?.target; const index = anchor?.index;
  const base = { target: kind, index, part: PART[kind] || null, noteId: null, pid: PART[kind] ? `${PART[kind].slice(5)}:${index}` : null,
    start: anchor?.start ?? null, end: anchor?.end ?? null, text: anchor?.text ?? null, precision: anchor?.precision || null, workVersionId, workSha256,
    sourcePackageSha256: workSha256,
    ...(anchor?.sourceReviewedPackageSha256 != null ? { sourceReviewedPackageSha256: anchor.sourceReviewedPackageSha256 } : {}),
    sourceXmlParagraphOrdinal: null, sourceXmlNodeId: null,
    textView: 'after', offsetUnit: 'utf16', paragraphIndexOwner: 'application-paragraph-index' };
  if (!Object.hasOwn(PART, kind) || !Number.isInteger(index) || index < 0) return { source: base, reasonCode: 'unsupported_source_target' };
  const part = parts[kind]; if (!part) return { source: base, reasonCode: 'missing_source_part' };
  const item = part.items[index]; if (!item) return { source: base, reasonCode: 'missing_source_paragraph' };
  if (!item.node) return { source: base, reasonCode: 'source_identity_mismatch' };
  base.sourceXmlParagraphOrdinal = item.paragraph.sourceXmlParagraphOrdinal;
  base.sourceXmlNodeId = item.paragraph.sourceXmlNodeId;
  base.noteId = item.noteId ?? null;
  // A grouped issue's source identities belong to its individual anchors. The
  // issue and auto-fix may still declare shared view, units and package binding.
  const claims = [anchor, it, it?.autoFix].filter((claim) => claim && typeof claim === 'object');
  if (claims.some((claim) => claim.textView != null && claim.textView !== 'after')) return { source: base, reasonCode: 'unsupported_text_view' };
  if (claims.some((claim) => claim.owner != null && !['after', 'application-paragraph-index'].includes(claim.owner))) return { source: base, reasonCode: 'unsupported_source_owner' };
  if (claims.some((claim) => claim.offsetUnit != null && claim.offsetUnit !== 'utf16'
    || claim.rangeUnit != null && claim.rangeUnit !== 'utf16')) return { source: base, reasonCode: 'unsupported_offset_unit' };
  if (claims.some((claim) => claim.paragraphIndexOwner != null && claim.paragraphIndexOwner !== 'application-paragraph-index')) return { source: base, reasonCode: 'unsupported_index_owner' };
  if (claims.some((claim) => ['ambiguous', 'unmapped', 'unresolved'].includes(claim.resolutionStatus))) return { source: base, reasonCode: 'unresolved_source_range' };
  if (claims.some((claim) => [claim.workSha256, claim.sourcePackageSha256].some((value) => value != null && value !== workSha256))) return { source: base, reasonCode: 'work_hash_mismatch' };
  const versions = claims.flatMap((claim) => [claim.workVersionId, claim.versionId]).filter((value) => value != null);
  if (versions.some((value) => { const hash = /:v\d+-([a-f0-9]{64})$/.exec(value)?.[1]; return hash && hash !== workSha256; })) return { source: base, reasonCode: 'work_hash_mismatch' };
  if (versions.length && !workVersionId) return { source: base, reasonCode: 'source_version_unverified' };
  if (versions.some((value) => value !== workVersionId)) return { source: base, reasonCode: 'source_version_mismatch' };
  const singleSource = !Array.isArray(it?.anchors) || it.anchors.length <= 1;
  const issueMatches = singleSource || it?.[`${kind}Index`] === index;
  const fixTarget = it?.autoFix?.target === 'body' ? 'paragraph' : it?.autoFix?.target;
  const fixMatches = issueMatches && (fixTarget == null || fixTarget === kind)
    && (it?.autoFix?.index == null || it.autoFix.index === index);
  const identities = [anchor, issueMatches && it, fixMatches && it?.autoFix].filter(Boolean);
  if (identities.some((identity) => identity.noteId != null && String(identity.noteId) !== item.noteId
    || identity.pid != null && identity.pid !== base.pid
    || identity.part != null && ![PART[kind], PART[kind].slice(5)].includes(identity.part)
    || identity.sourceXmlParagraphOrdinal != null && identity.sourceXmlParagraphOrdinal !== base.sourceXmlParagraphOrdinal
    || identity.sourceXmlNodeId != null && identity.sourceXmlNodeId !== base.sourceXmlNodeId)) return { source: base, reasonCode: 'source_identity_mismatch' };
  if (kind !== 'paragraph') {
    if (/separator/i.test(item.noteType) || Number(item.noteId) < 0) return { source: base, reasonCode: 'separator_note' };
    if (item.noteId == null || !/^-?\d+$/.test(item.noteId)) return { source: base, reasonCode: 'source_identity_mismatch' };
    if (part.idCounts.get(item.noteId) !== 1) return { source: base, reasonCode: 'ambiguous_note_id' };
  }
  const text = paragraphText(item.node, 'after'); base.paragraphSha256 = sha(text);
  let { start, end } = anchor; let expected = anchor.text;
  if (start == null && end == null) {
    // Old body callers supplied paragraph indexes and context snippets, not
    // character ranges. Retain their stated paragraph precision. Old note
    // callers may supply normalized offsets; only unique exact text proves a
    // source range when no explicit current-version anchor was supplied.
    expected = kind === 'paragraph' && anchor.legacyIndexOnly ? '' : it?.autoFix?.find || it?.quote || '';
    const offset = it?.autoFix?.offset ?? it?.offset;
    if (expected && Number.isInteger(offset) && text.slice(offset, offset + expected.length) === expected) { start = offset; end = start + expected.length; base.rangeProof = 'verified-text-at-offset'; }
    else if (expected) {
      start = text.indexOf(expected);
      if (start >= 0 && text.indexOf(expected, start + 1) >= 0) return { source: base, reasonCode: 'ambiguous_source_range' };
      if (start < 0) return { source: base, reasonCode: 'stale_source_range' };
      end = start + expected.length; base.rangeProof = 'unique-exact-text'; base.precision = it?.autoFix?.find ? 'exact' : 'quote';
    } else { start = 0; end = text.length; expected = text; base.precision = 'paragraph'; base.rangeProof = 'legacy-paragraph'; }
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length || kind !== 'paragraph' && end === start
    || typeof expected !== 'string' || expected.length !== end - start || splitSurrogate(text, start) || splitSurrogate(text, end)) return { source: base, reasonCode: 'invalid_source_range' };
  base.start = start; base.end = end; base.text = expected; base.rangeUnit = 'utf16';
  if (text.slice(start, end) !== expected) return { source: base, reasonCode: 'stale_source_range' };
  return { source: base, item };
}
function commentXml(id, it, source, author, date) {
  const lines = [`【${[it.ruleId, it.severity, it.category || it.title].filter(Boolean).join('｜')}】${it.title || ''}`.trim()];
  if (source.target !== 'paragraph') {
    lines.push(`来源：${source.target === 'footnote' ? '脚注' : '尾注'} ID ${source.noteId}，${source.pid}，UTF-16 [${source.start},${source.end})`);
    lines.push('放置：正文中该注号的实际引用。Word 不显示注内范围批注，此批注不覆盖注内字符。');
  }
  if (source.text) lines.push(`原文：${source.text}`);
  if (it.message || it.detail) lines.push(`问题：${it.message || it.detail}`);
  if (it.suggestion || it.fix) lines.push(`建议：${it.suggestion || it.fix}`);
  if (it.basis) lines.push(`依据：${it.basis}`);
  return `<w:comment xmlns:w="${W_NS}" w:id="${id}" w:author="${esc(author)}" w:date="${esc(date)}" w:initials="${esc(author.slice(0, 2))}">${lines.map((line) => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join('')}</w:comment>`;
}
function appendRoot(xml, localName, fragment) {
  const root = parseXml(xml).children[0];
  if (!root || root.name.split(':').pop() !== localName) throw new Error('unsupported_package');
  if (root.selfClosing) return xml.slice(0, root.openStart) + xml.slice(root.openStart, root.openEnd).replace(/\/\s*>$/, '>') + fragment + `</${root.name}>` + xml.slice(root.openEnd);
  if (!Number.isInteger(root.closeStart)) throw new Error('unsupported_package');
  return xml.slice(0, root.closeStart) + fragment + xml.slice(root.closeStart);
}
function elementName(root, local) { return root.name.includes(':') ? `${root.name.split(':')[0]}:${local}` : local; }
function packageMetadata(zip) {
  const comments = zip.readText('word/comments.xml');
  const rels = zip.readText('word/_rels/document.xml.rels') || `<Relationships xmlns="${REL_NS}"></Relationships>`;
  const root = parseXml(rels).children[0];
  if (!root || root.name.split(':').pop() !== 'Relationships') throw new Error('unsupported_package');
  const relationships = root.children.filter((node) => node.name.split(':').pop() === 'Relationship');
  const ids = relationships.map((node) => node.attr('Id'));
  if (new Set(ids).size !== ids.length) throw new Error('unsupported_package');
  const existing = relationships.filter((node) => node.attr('Type') === COMMENTS_REL);
  if (existing.length > 1 || existing.some((node) => node.attr('Target') !== 'comments.xml' || node.attr('TargetMode') === 'External')) throw new Error('unsupported_package');
  let newRels = rels;
  if (!existing.length) {
    let number = 1; while (ids.includes(`rIdComments${number}`)) number += 1;
    newRels = appendRoot(rels, 'Relationships', `<${elementName(root, 'Relationship')} Id="rIdComments${number}" Type="${COMMENTS_REL}" Target="comments.xml"/>`);
  }
  const ct = zip.readText('[Content_Types].xml'); const ctRoot = ct && parseXml(ct).children[0];
  if (!ctRoot || ctRoot.name.split(':').pop() !== 'Types') throw new Error('unsupported_package');
  const overrides = ctRoot.children.filter((node) => node.name.split(':').pop() === 'Override' && node.attr('PartName') === '/word/comments.xml');
  if (overrides.length > 1 || overrides.some((node) => node.attr('ContentType') !== COMMENTS_CT)) throw new Error('unsupported_package');
  const newCt = overrides.length ? ct : appendRoot(ct, 'Types', `<${elementName(ctRoot, 'Override')} PartName="/word/comments.xml" ContentType="${COMMENTS_CT}"/>`);
  let nextId = 1;
  if (comments) {
    const cRoot = parseXml(comments).children[0];
    if (cRoot?.name !== 'w:comments') throw new Error('unsupported_package');
    const commentIds = new Set();
    for (const node of cRoot.children.filter((node) => node.name === 'w:comment')) {
      const value = Number(node.attr('w:id'));
      if (!Number.isSafeInteger(value) || value < 0 || commentIds.has(value)) throw new Error('unsupported_package');
      commentIds.add(value);
      nextId = Math.max(nextId, value + 1);
    }
  }
  // Existing unpaired markers still reserve their IDs; adding a new comment
  // must not make an old marker appear to belong to the new source range.
  for (const path of Object.values(PART)) {
    const xml = zip.readText(path); if (!xml) continue;
    const part = parseXml(xml);
    for (const tag of ['w:commentRangeStart', 'w:commentRangeEnd', 'w:commentReference']) for (const node of part.descendants(tag)) {
      const value = Number(node.attr('w:id'));
      if (Number.isSafeInteger(value) && value >= 0) nextId = Math.max(nextId, value + 1);
    }
  }
  return { comments, rels: newRels, ct: newCt, nextId };
}
function spliceEvents(xml, events) {
  const positions = new Map();
  for (const event of events) { if (!positions.has(event.pos)) positions.set(event.pos, []); positions.get(event.pos).push(event); }
  for (const [pos, list] of [...positions].sort(([a], [b]) => b - a)) {
    list.sort((a, b) => a.type === b.type ? a.type === 'start' ? a.id - b.id : b.id - a.id : a.type === 'end' ? -1 : 1);
    xml = xml.slice(0, pos) + list.map((event) => event.text).join('') + xml.slice(pos);
  }
  return xml;
}
/** added counts comments; addedIssues counts issues. byPart retains requested source counts. */
export function buildCommentedDocx({ buffer, issues, author = '《东方学刊》审稿智能体', date = new Date().toISOString(), workVersionId = null, workSha256 = null }) {
  if (!Array.isArray(issues)) throw new TypeError('issues must be an array');
  const zip = openZip(buffer); const actualHash = sha(buffer);
  const byPart = { paragraph: 0, footnote: 0, endnote: 0 };
  for (const it of issues) for (const kind of Object.keys(PART)) if (Number.isInteger(it?.[`${kind}Index`])) { byPart[kind] += 1; break; }
  const placements = []; const skippedDetails = []; const events = []; const newComments = [];
  const result = () => ({ buffer, added: newComments.length, addedIssues: new Set(placements.map((p) => p.issueIndex)).size,
    skipped: skippedDetails.length, byPart, actualByPart: { paragraph: newComments.length, footnote: 0, endnote: 0 },
    placementSchemaVersion: 1, placements, skippedDetails });
  const reject = (it, issueIndex, reasonCode, source = null, targets = []) => skippedDetails.push({ issueIndex, issueKey: issueKey(it), source, targets, reasonCode, reason: REASONS[reasonCode] });
  let packageReason = new Set(zip.names).size !== zip.names.length || zip.totalUncompressed > 300 * 1024 * 1024 ? 'unsupported_package'
    : zip.names.some((name) => name.startsWith('_xmlsignatures/')) ? 'signed_document' : null;
  const versionHash = /:v\d+-([a-f0-9]{64})$/.exec(workVersionId || '')?.[1];
  if (workSha256 != null && workSha256 !== actualHash || versionHash && versionHash !== actualHash) packageReason = 'work_hash_mismatch';
  let metadata;
  try { metadata = packageMetadata(zip); } catch { packageReason ||= 'unsupported_package'; }
  if (packageReason) { issues.forEach((it, index) => reject(it, index, packageReason)); return result(); }
  const doc = parseDocxBuffer(buffer);
  const parts = Object.fromEntries(Object.keys(PART).map((kind) => [kind, sourcePart(zip, kind, doc)]));
  const references = parts.paragraph ? visibleReferences(parts.paragraph) : [];
  let nextId = metadata.nextId;
  issues.forEach((it, issueIndex) => {
    if (!it || it.needsRelocation) { reject(it, issueIndex, 'needs_relocation'); return; }
    const scopes = Object.keys(PART).filter((kind) => Number.isInteger(it[`${kind}Index`]));
    if (scopes.length > 1) { reject(it, issueIndex, 'conflicting_source_target'); return; }
    let anchors = Array.isArray(it.commentAnchors) && it.commentAnchors.length ? it.commentAnchors : Array.isArray(it.anchors) && it.anchors.length ? it.anchors : it.anchor ? [it.anchor] : scopes.length ? [{ target: scopes[0], index: it[`${scopes[0]}Index`], legacyIndexOnly: true }] : [];
    if (!anchors.length) { reject(it, issueIndex, 'unsupported_source_target'); return; }
    if (anchors.length === 1 && scopes.length && (anchors[0]?.target !== scopes[0] || anchors[0]?.index !== it[`${scopes[0]}Index`])) { reject(it, issueIndex, 'conflicting_source_target'); return; }
    anchors = anchors.filter((anchor, index) => anchors.findIndex((other) => JSON.stringify(other) === JSON.stringify(anchor)) === index);
    const planned = [];
    for (const anchor of anchors) {
      const checked = checkedSource(it, anchor, parts, workVersionId, actualHash);
      if (checked.reasonCode) { reject(it, issueIndex, checked.reasonCode, checked.source); return; }
      const { source, item } = checked;
      let targets;
      if (source.target === 'paragraph') {
        const node = item.node; const pPr = node.el('w:pPr'); const start = pPr ? nodeEnd(pPr) : node.openEnd;
        if (!Number.isInteger(start) || !Number.isInteger(node.closeStart)) { reject(it, issueIndex, 'unsupported_source_target', source); return; }
        targets = [{ part: PART.paragraph, paragraphIndex: source.index, pid: source.pid,
          sourceXmlParagraphOrdinal: source.sourceXmlParagraphOrdinal, sourceXmlNodeId: source.sourceXmlNodeId,
          textView: 'after', offsetUnit: 'utf16', paragraphIndexOwner: 'application-paragraph-index',
          xmlRange: { start, end: node.closeStart, unit: 'xml-utf16', basis: 'input-word/document.xml' }, precision: 'paragraph' }];
      } else {
        const found = references.filter((entry) => entry.kind === source.target && entry.noteId === source.noteId);
        targets = found.map(referenceDTO);
        if (!found.length) { reject(it, issueIndex, 'orphan_note', source); return; }
        if (found.some((entry) => !entry.safe)) { reject(it, issueIndex, 'unsupported_reference_structure', source, targets); return; }
      }
      planned.push({ source, targets });
    }
    for (const plan of planned) {
      for (const target of plan.targets) {
        const id = nextId++; target.commentId = String(id);
        newComments.push(commentXml(id, it, plan.source, author, date));
        events.push({ pos: target.xmlRange.start, type: 'start', id, text: `<w:commentRangeStart w:id="${id}"/>` },
          { pos: target.xmlRange.end, type: 'end', id, text: `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>` });
      }
      const noteSource = plan.source.target !== 'paragraph';
      placements.push({ issueIndex, issueKey: issueKey(it), source: plan.source, targets: plan.targets,
        precision: noteSource ? 'reference-target' : 'paragraph', degradation: noteSource
          ? { code: 'word-note-comments-unsupported', message: 'Word 忽略脚注、尾注内的批注标记；批注放置在正文真实注号引用，未声称覆盖注内字符范围。' }
          : { code: 'paragraph-level-word-comment', message: '正文 Word 批注使用段落范围，来源字符范围单独保留。' } });
    }
  });
  if (!newComments.length) return result();
  const commentsXml = metadata.comments ? appendRoot(metadata.comments, 'comments', newComments.join(''))
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W_NS}">${newComments.join('')}</w:comments>`;
  const replaced = new Map([['word/document.xml', spliceEvents(parts.paragraph.xml, events)], ['word/comments.xml', commentsXml],
    ['[Content_Types].xml', metadata.ct], ['word/_rels/document.xml.rels', metadata.rels]]);
  const entries = zip.names.map((name) => ({ name, data: replaced.has(name) ? Buffer.from(replaced.get(name), 'utf8') : zip.read(name) }));
  for (const [name, xml] of replaced) if (!zip.has(name)) entries.push({ name, data: Buffer.from(xml, 'utf8') });
  const final = result(); final.buffer = writeZip(entries); return final;
}
