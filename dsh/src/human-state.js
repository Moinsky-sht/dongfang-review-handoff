/** Durable human actions are observations, never automatic correctness labels. */
import { randomUUID } from 'node:crypto';
import { sha256 } from './working-version.js';

const normalized = (text) => String(text ?? '').replace(/\s/g, '');
const markFields = {body: 'paragraphs', footnote: 'footnotes', endnote: 'endnotes'};
const markParts = {body: 'document.xml', footnote: 'footnotes.xml', endnote: 'endnotes.xml'};
const shaPattern = /^[a-f0-9]{64}$/;
const codePointBoundary = (text, at) => at === 0 || at === text.length
  || !( /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]) );
const keyOf = (issue) => issue.issueKey || `${issue.ruleId}|${issue.location}|${issue.quote || ''}`;
const usableResult = (s) => !!s.result && !s.reviewRunning && !s.reviewError && !s.interrupted && s.resultRunId === s.reviewRunId;
export const effectiveReviewRunId = (s) => usableResult(s) ? s.resultRunId : null;
function invalid(message, status = 400) { const e = new Error(message); e.status = status; throw e; }

/** Raw offsets are current after-view UTF-16 coordinates, including every whitespace character. */
function rawMarkRange(s, mark, node) {
  if (mark.textView !== 'after' || mark.offsetUnit !== 'utf16'
    || mark.paragraphIndexOwner !== 'application-paragraph-index') invalid('圈画原始范围声明无效');
  const part = markParts[mark.target];
  if (!shaPattern.test(s.workVersion.sha256 || '') || s.doc.sourcePackageSha256 !== s.workVersion.sha256
    || node.sourcePackageSha256 !== s.workVersion.sha256 || mark.sourcePackageSha256 !== s.workVersion.sha256
    || mark.sourceVersionId !== s.workVersion.id || node.textView !== 'after' || node.offsetUnit !== 'utf16'
    || node.paragraphIndexOwner !== 'application-paragraph-index' || node.part !== part || mark.part !== part
    || node.index !== mark.index || node.id !== `${part}:${mark.index}`
    || !Number.isSafeInteger(node.sourceXmlParagraphOrdinal) || node.sourceXmlParagraphOrdinal < 0
    || node.sourceXmlNodeId !== `${part}:xml-p:${node.sourceXmlParagraphOrdinal}`
    || mark.sourceXmlNodeId !== node.sourceXmlNodeId || mark.sourceXmlParagraphOrdinal !== node.sourceXmlParagraphOrdinal
    || s.doc[markFields[mark.target]].filter(item => item.sourceXmlNodeId === node.sourceXmlNodeId).length !== 1
    || mark.pid != null && mark.pid !== node.id || mark.id != null && mark.id !== node.id
    || mark.sourceXmlTableNodeId != null && mark.sourceXmlTableNodeId !== node.sourceXmlTableNodeId) {
    invalid('圈画原始节点或工作版本身份已变化，请重新选择', 409);
  }
  if (mark.target !== 'body') {
    if (node.isNoteSeparator || /separator/i.test(node.noteType || '') || node.noteId == null
      || String(node.noteId) === '-1' || String(node.noteId) === '0'
      || typeof mark.noteId !== 'string' || mark.noteId !== String(node.noteId)
      || mark.noteType != null && mark.noteType !== (node.noteType || '')) invalid('圈画注释身份不符或节点不可选', 409);
  } else if (mark.noteId != null || mark.noteType != null && mark.noteType !== '') invalid('圈画正文不能借用注释身份', 409);
  const text = node.text;
  if (mark.end > text.length || !codePointBoundary(text, mark.start) || !codePointBoundary(text, mark.end)) {
    invalid('圈画原始范围越界或切开了完整字符，请重新选择');
  }
  const quote = text.slice(mark.start, mark.end);
  if (mark.quote !== quote || mark.text != null && mark.text !== quote
    || mark.rawStart != null && mark.rawStart !== mark.start || mark.rawEnd != null && mark.rawEnd !== mark.end) {
    invalid('圈画原文与原始范围不符，请重新选择', 409);
  }
  if (!shaPattern.test(mark.rawNodeTextSha256 || '') || mark.rawNodeTextSha256 !== sha256(Buffer.from(text))
    || mark.nodeTextSha256 != null && mark.nodeTextSha256 !== sha256(Buffer.from(normalized(text)))) invalid('圈画原始节点内容已变化', 409);
  return {offsetSpace: 'raw', rawStart: mark.start, rawEnd: mark.end,
    sourceVersionId: s.workVersion.id, sourcePackageSha256: s.workVersion.sha256,
    textView: 'after', offsetUnit: 'utf16', paragraphIndexOwner: 'application-paragraph-index',
    part, pid: node.id, sourceXmlNodeId: node.sourceXmlNodeId, sourceXmlParagraphOrdinal: node.sourceXmlParagraphOrdinal,
    sourceXmlTableNodeId: node.sourceXmlTableNodeId ?? null,
    noteId: mark.target === 'body' ? null : String(node.noteId), noteType: mark.target === 'body' ? '' : node.noteType || ''};
}

export function humanState(s) {
  const versionId = s.workVersion.id;
  const runId = effectiveReviewRunId(s);
  const decisions = {};
  const marks = [];
  for (const record of s.humanRecords || []) {
    if (record.binding.sessionId !== s.id || record.binding.workVersionId !== versionId) continue;
    if (record.kind === 'decision' && runId && record.binding.reviewRunId === runId) {
      Object.defineProperty(decisions, record.binding.issueKey, {value: {
        id: record.id, action: record.action, opinion: record.opinion, savedAt: record.savedAt,
      }, enumerable: true, writable: true, configurable: true});
    } else if (record.kind === 'mark') {
      // Existing normalized observations retain their original coordinate space. New raw observations
      // additionally require their immutable package, exact text and physical source node on recovery.
      if (record.mark?.offsetSpace === 'raw') {
        if (record.binding.workVersionSha256 !== s.workVersion.sha256 || record.binding.sourceSha256 !== s.workVersion.sourceSha256) continue;
        try {
          const mark = record.mark;
          const node = s.doc[markFields[mark.target]]?.[mark.index];
          if (!node || typeof node.text !== 'string' || !Number.isSafeInteger(mark.start) || !Number.isSafeInteger(mark.end)
            || mark.start < 0 || mark.end <= mark.start || typeof mark.quote !== 'string' || !mark.quote) continue;
          rawMarkRange(s, mark, node);
        } catch { continue; }
      }
      marks.push({id: record.id, ...record.mark, savedAt: record.savedAt});
    }
  }
  return {revision: s.humanRevision || 0, workVersionId: versionId, reviewRunId: runId,
    decisions, marks, historyCount: (s.humanRecords || []).length};
}

export function buildHumanRecord(s, body) {
  if (body.baseVersionId !== s.workVersion.id || body.baseMutationEpoch !== (s.mutationEpoch || 0)) invalid('工作稿或修改历史已变化，请刷新后核对', 409);
  if (!Number.isSafeInteger(body.expectedHumanRevision) || body.expectedHumanRevision !== (s.humanRevision || 0)) invalid('人工记录已变化，请刷新后核对', 409);
  if (body.baseRunId !== effectiveReviewRunId(s)) invalid('审阅运行已变化，请刷新后核对', 409);
  if (body.purpose != null && !['editorial', 'verification'].includes(body.purpose)) invalid('人工记录用途无效');
  if (body.verificationRunId != null && (typeof body.verificationRunId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.verificationRunId))) invalid('验证批次身份无效');
  const record = {id: `h${randomUUID()}`, operationId: body.operationId, kind: body.kind,
    purpose: body.purpose || 'editorial', verificationRunId: body.purpose === 'verification' ? body.verificationRunId || null : null,
    savedAt: new Date().toISOString(), binding: {sessionId: s.id, sourceSha256: s.workVersion.sourceSha256,
      workVersionId: s.workVersion.id, workVersionSha256: s.workVersion.sha256,
      reviewRunId: effectiveReviewRunId(s), mutationEpoch: s.mutationEpoch || 0}};
  if (body.kind === 'decision') {
    if (!usableResult(s)) invalid('当前没有可处置的完成审阅，请先审阅', 409);
    if (typeof body.issueKey !== 'string' || !s.result.issues.some((issue) => keyOf(issue) === body.issueKey)) invalid('问题不属于本次审阅', 409);
    if (!['accept', 'reject', 'unsure', ''].includes(body.action)) invalid('人工处置类型无效');
    if (typeof body.opinion !== 'string' || body.opinion.length > 4000) invalid('人工意见超出允许长度');
    record.binding.issueKey = body.issueKey;
    record.action = body.action;
    record.opinion = body.opinion;
    return record;
  }
  if (body.kind !== 'mark') invalid('人工记录类型无效');
  const mark = body.mark;
  if (!mark || !Object.hasOwn(markFields, mark.target) || !Number.isSafeInteger(mark.index) || mark.index < 0) invalid('圈画节点身份无效');
  const node = s.doc[markFields[mark.target]]?.[mark.index];
  const text = node?.text;
  if (typeof text !== 'string') invalid('圈画节点不存在', 409);
  if (!['normalized', 'raw'].includes(mark.offsetSpace) || !Number.isSafeInteger(mark.start) || !Number.isSafeInteger(mark.end)
    || mark.start < 0 || mark.end <= mark.start || typeof mark.quote !== 'string' || !mark.quote || mark.quote.length > 8000) invalid('圈画范围无效');
  const plain = normalized(text);
  let range;
  if (mark.offsetSpace === 'raw') range = rawMarkRange(s, mark, node);
  else {
    if (!codePointBoundary(plain, mark.start) || !codePointBoundary(plain, mark.end)) invalid('圈画范围切开了完整字符，请重新选择');
    if (mark.end > plain.length || plain.slice(mark.start, mark.end) !== normalized(mark.quote)) invalid('圈画原文与指定范围不符，请重新选择', 409);
    const positions = [];
    for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) positions.push(i);
    range = {offsetSpace: 'normalized', rawStart: positions[mark.start], rawEnd: positions[mark.end - 1] + 1};
    if (mark.nodeTextSha256 && mark.nodeTextSha256 !== sha256(Buffer.from(plain))) invalid('圈画节点内容已变化', 409);
  }
  const strings = ['category', 'severity', 'note', 'ruleId', 'nature'];
  for (const field of strings) if (mark[field] != null && (typeof mark[field] !== 'string' || mark[field].length > (field === 'note' ? 4000 : 100))) invalid('圈画属性无效');
  record.mark = {target: mark.target, index: mark.index, start: mark.start, end: mark.end,
    ...range, quote: text.slice(range.rawStart, range.rawEnd), text: text.slice(range.rawStart, range.rawEnd),
    nodeTextSha256: sha256(Buffer.from(plain)), rawNodeTextSha256: sha256(Buffer.from(text)),
    category: mark.category || '其他', severity: mark.severity || '中', note: mark.note || '',
    ruleId: mark.ruleId || '', nature: mark.nature || '其他',
    paragraphIndex: mark.target === 'body' ? mark.index : null, location: `${mark.target}:${mark.index}`};
  return record;
}

export function humanAuditEntry(s, record) {
  const issue = record.kind === 'decision' ? s.result.issues.find((item) => keyOf(item) === record.binding.issueKey) : null;
  return {kind: record.kind === 'mark' ? 'human-mark' : record.action ? 'human-decision' : 'human-comment',
    sessionId: s.id, manuscript: s.name, taskId: record.binding.reviewRunId || '',
    paragraphIndex: record.mark?.paragraphIndex ?? null, location: issue?.location || record.mark?.location || '',
    quote: issue?.quote || record.mark?.quote || '', ruleId: issue?.ruleId || record.mark?.ruleId || '',
    ruleTitle: issue?.title || '', severity: issue?.severity || record.mark?.severity || '',
    humanAction: record.kind === 'mark' ? 'mark' : record.action, humanOpinion: record.opinion || record.mark?.note || '',
    attributes: record.mark ? {category: record.mark.category, nature: record.mark.nature} : {},
    provenance: {...record.binding, humanRecordId: record.id, operationId: record.operationId,
      purpose: record.purpose, verificationRunId: record.verificationRunId,
      start: record.mark?.start, end: record.mark?.end, offsetSpace: record.mark?.offsetSpace,
      rawStart: record.mark?.rawStart, rawEnd: record.mark?.rawEnd, rawNodeTextSha256: record.mark?.rawNodeTextSha256,
      sourceVersionId: record.mark?.sourceVersionId, sourcePackageSha256: record.mark?.sourcePackageSha256,
      sourceXmlNodeId: record.mark?.sourceXmlNodeId, sourceXmlParagraphOrdinal: record.mark?.sourceXmlParagraphOrdinal,
      sourceXmlTableNodeId: record.mark?.sourceXmlTableNodeId, paragraphIndexOwner: record.mark?.paragraphIndexOwner,
      textView: record.mark?.textView, offsetUnit: record.mark?.offsetUnit, part: record.mark?.part,
      noteId: record.mark?.noteId, noteType: record.mark?.noteType}};
}
