/**
 * 问题锚点：为每条审阅问题算出**正文里那一段文字**，供界面下划线高亮与点击跳转。
 *
 * ── 要解决什么 ────────────────────────────────────────────────────
 * 需求是「每个问题都要定位到至少是标点符号、最多是一整个段落，并且像 Word
 * 批注那样自动给问题部分加下划线」。要做到这一点，必须知道**问题文字在
 * 原文中的确切区间**，而现有数据里没有这个区间：
 *
 *   · `quote` 字段**不是问题文字**。`scanner-format.js` 的 `snippet()` 返回的是
 *     `text.slice(index - 20, index + len)` —— 匹配位置**前 20 字的上下文**。
 *     直接拿它去正文里找，命中的是「问题 + 前面 20 字」，
 *     下划线会多划一截，跳转位置也会偏。
 *   · 模型类问题（`group: 'model'`）只有 `paragraphIndex` + `quote`，**没有 offset**。
 *   · 规则类问题多数有 `autoFix.{find, replace, offset}`（精确），
 *     但**不是全部** —— 只报不改的规则（如 FMT-008 层级跳级）只有 `offset`。
 *
 * ── 锚点判据优先级（精确 → 粗略）────────────────────────────────
 *   1. `anchor` 的源身份 + 字面范围       → 验证后保留明确范围
 *   2. `autoFix.find` + `autoFix.offset`   → **精确**：问题就是 find 这段
 *   3. `offset`（无 find）                 → 标点级：从 offset 起取标点本身，
 *                                            否则延伸到小句边界
 *   4. `quote`                             → 空白容错检索，只有唯一候选才定位
 *   5. 兜底                                → 整段导航
 *
 * 产出的 `text` 保证满足需求的下限与上限：**至少 1 个字符（标点级）**，
 * **至多整段**。
 */

import { splitSentences } from './scanner-language.js';

/** 目标容器：段落 / 脚注 / 尾注 */
function resolveTarget(issue, doc) {
  if (Number.isInteger(issue.paragraphIndex) && doc?.paragraphs?.[issue.paragraphIndex]) {
    return { kind: 'paragraph', index: issue.paragraphIndex, node: doc.paragraphs[issue.paragraphIndex], text: doc.paragraphs[issue.paragraphIndex].text || '' };
  }
  if (Number.isInteger(issue.footnoteIndex) && doc?.footnotes?.[issue.footnoteIndex]) {
    return { kind: 'footnote', index: issue.footnoteIndex, node: doc.footnotes[issue.footnoteIndex], text: doc.footnotes[issue.footnoteIndex].text || '' };
  }
  if (Number.isInteger(issue.endnoteIndex) && doc?.endnotes?.[issue.endnoteIndex]) {
    return { kind: 'endnote', index: issue.endnoteIndex, node: doc.endnotes[issue.endnoteIndex], text: doc.endnotes[issue.endnoteIndex].text || '' };
  }
  return null;
}

/**
 * 整篇级 / 表级问题的锚点。
 *
 * 有一类问题**天生没有段落位置**，但它们同样出现在右侧清单里，
 * 需求要求「清单上的问题都要可点击跳转」—— 所以不能返回 `null`
 * 让前端点了没反应，而要给出一个**可跳转的目标**：
 *
 *   · `location: 'document'`（FMT-001 缺摘要、FMT-031 缺基金项目…）
 *     → 锚到整篇：前端滚回文首并提示「该问题针对整篇文档」
 *   · `location: 'table:N'`（FMT-033 表格类问题）
 *     → 锚到第 N 个表格，前端滚动到该表格
 *
 * 实测 `samples/test.docx` 上这类共 3 条（15 条中的 20%），
 * 在长稿上比例更低，但漏掉它们会让「全部可点击」不成立。
 */
function fallbackAnchor(issue) {
  const loc = String(issue.location || '');
  if (loc === 'document') {
    return { target: 'document', index: 0, start: 0, end: 0, text: '', precision: 'document' };
  }
  const m = /^table:(\d+)$/.exec(loc);
  if (m) {
    return { target: 'table', index: Number(m[1]), start: 0, end: 0, text: '', precision: 'table' };
  }
  return null;
}

/**
 * **最后**的兜底：实在算不出段落位置时，锚到整篇。
 *
 * 需求 3 要求「右侧清单上的问题都要可点击跳转」。早期版本在
 * 目标段落为空、或 `paragraphIndex` 越界时直接返回 `null` ——
 * 前端拿不到锚点，那一行点下去什么也不发生，需求 3 就不成立。
 * 实测 `samples/test.docx` 开着模型审阅时，模型把 FMTB-029
 * （文献著录信息完整性）指向 `paragraph:1`，而第 1 段是**标题后的空行**
 * （`text` 为空），于是产生 1 条 `precision:'none'`。
 *
 * 锚到整篇后，前端会滚回文首并提示「该问题针对整篇文档」——
 * 位置不如逐段精确，但**行是可点击的**，符合需求 3 的下限。
 */
function documentAnchor() {
  return { target: 'document', index: 0, start: 0, end: 0, text: '', precision: 'document' };
}

/**
 * 目标段落为空时，找**最近的非空**同类型容器。
 *
 * 为什么要退到邻段而不是直接报「无位置」：模型指向空段不是错误判断，
 * 而是它给的定位粒度就到「这一段」——而这一段恰好是空行。
 * 紧邻的非空段就是它真正在说的内容（标题后的空行 → 标题/摘要），
 * 指过去比不给位置有用得多。
 *
 * ── 半径 3 的依据（需求 C：魔法常数必须给跨语料证据）──
 * 这个半径约束的是「跨过空行区能走多远」。决定它的量是**空段连续长度**，
 * 实测（`tools/audit-constants.mjs`，632 篇）：
 *   n=6544  min=1  P50=1  P90=2  P99=15  max=65
 *   长度 ≤3 的空段区占 **94.7%**，>3 的占 5.3%
 * 所以半径 3 覆盖了绝大多数情形（空行就是空行，邻段即内容），
 * 同时挡住了病态的长空行区（分页/大段留白，最长 65 段）——
 * 那种情况下「最近的非空段」离目标太远，指过去反而可能指到别的语义单元，
 * 此时退回文档级锚点（`documentAnchor`）比指错更诚实。
 *
 * ⚠️ 注意这个数字**不能**从「锚点到最近非空段的距离」取证：
 * 实测规则引擎指向空段的样本是 **0 个**（该分支是为模型而加的），
 * 那个总体在规则侧是空的，量它会得出"0 样本"的假结论。
 */
function nearestNonEmpty(t, doc) {
  const list = t.kind === 'paragraph' ? doc?.paragraphs
    : t.kind === 'footnote' ? doc?.footnotes
      : doc?.endnotes;
  if (!Array.isArray(list)) return null;
  for (let d = 1; d <= 3; d += 1) {
    for (const i of [t.index + d, t.index - d]) {
      if (i < 0 || i >= list.length) continue;
      const txt = list[i]?.text || '';
      if (txt) return { index: i, text: txt, node: list[i] };
    }
  }
  return null;
}

/** 中文/英文标点（用于判定「问题就是标点本身」） */
const PUNCT_RE = /[、，。；：！？…—－·（）()《》〈〉「」『』“”‘’【】\[\]{}<>,;:!?."'`~@#$%^&*+=|\\/\-_]/;

/** 小句边界标点：用于把锚点扩到「一个可读的片段」而不是一两个字 */
const CLAUSE_RE = /[、，。；：！？,;:!?]/;

/**
 * 从 `start` 起取一个标点级的锚点。
 *
 * 若 `start` 处本身就是标点，锚点就是**这个标点**（连续同类标点一并取，
 * 如 `……`、`——`）—— 这是需求允许的最小粒度。
 * 否则延伸到下一个小句边界（含边界标点），上限 `maxLen` 字。
 */
function punctuationAnchor(text, start, maxLen = 40) {
  if (start < 0 || start >= text.length) return null;
  if (PUNCT_RE.test(text[start])) {
    let end = start + 1;
    // 连续同类标点（省略号、破折号、感叹号连用）整体取出
    while (end < text.length && text[end] === text[start]) end += 1;
    return { start, end };
  }
  const limit = Math.min(text.length, start + maxLen);
  for (let i = start; i < limit; i += 1) {
    if (CLAUSE_RE.test(text[i])) return { start, end: i + 1 };
  }
  return { start, end: limit };
}

/**
 * 空白容错的子串检索。
 *
 * 为什么需要：`findLocation()` 比对时把两边空白都去掉了
 * （`text.replace(/\s/g,'')`），而模型回的 `quote` 常常与原文的
 * 换行/空格不完全一致。要在**原始文本**上拿到偏移，就得自己走一遍
 * 逐字符比对，跳过空白。
 *
 * @returns {{start:number,end:number}|null} 命中区间（原始文本下标）
 */
export function findWhitespaceTolerant(haystack, needle) {
  const nd = String(needle || '').replace(/\s+/g, '');
  if (!nd) return null;
  const hs = String(haystack || '');
  // 先试精确匹配（最快路径）
  const exact = hs.indexOf(needle);
  if (exact >= 0) return { start: exact, end: exact + needle.length };
  // 再走空白容错匹配
  let hi = 0;
  let ni = 0;
  let start = -1;
  while (hi < hs.length && ni < nd.length) {
    const hc = hs[hi];
    if (/\s/.test(hc)) { hi += 1; continue; }
    if (hc === nd[ni]) {
      if (start < 0) start = hi;
      hi += 1;
      ni += 1;
      continue;
    }
    // 失配：从 start 的下一个非空白字符重新开始
    if (start >= 0) {
      let next = start + 1;
      while (next < hs.length && /\s/.test(hs[next])) next += 1;
      hi = next;
      ni = 0;
      start = -1;
      continue;
    }
    hi += 1;
  }
  if (ni === nd.length && start >= 0) return { start, end: hi };
  return null;
}

/** Every candidate maps back to the original after-view UTF-16 coordinates. */
export function findTextCandidates(haystack, needle) {
  const hs = String(haystack || ''), nd = String(needle || '').replace(/\s/g, '');
  if (!nd) return [];
  let normalized = '';
  const owners = [];
  for (let i = 0; i < hs.length; i += 1) {
    if (/\s/.test(hs[i])) continue;
    normalized += hs[i]; owners.push(i);
  }
  const candidates = [];
  for (let at = normalized.indexOf(nd); at >= 0; at = normalized.indexOf(nd, at + 1)) {
    const start = owners[at], end = owners[at + nd.length - 1] + 1;
    candidates.push({ start, end, text: hs.slice(start, end),
      comparisonView: hs.slice(start, end) === String(needle) ? 'literal' : 'whitespace-normalized',
      textView: 'after', offsetUnit: 'utf16' });
  }
  return candidates;
}

function sourceIdentity(target, doc) {
  const node = target.node || {};
  return { pid: node.id ?? null, part: node.part ?? null, noteId: node.noteId ?? null,
    sourceXmlNodeId: node.sourceXmlNodeId ?? null,
    sourceXmlParagraphOrdinal: node.sourceXmlParagraphOrdinal ?? null,
    paragraphIndexOwner: 'application-paragraph-index', textView: 'after', offsetUnit: 'utf16',
    sourcePackageSha256: doc?.sourcePackageSha256 ?? null,
    sourceVersionId: doc?.sourceVersionId ?? null,
    sourceIdentityAvailable: !!node.sourceXmlNodeId && Number.isInteger(node.sourceXmlParagraphOrdinal) };
}

function identityFailure(issue, target, doc, extra = []) {
  const node = target.node || {};
  for (const value of [issue, issue.autoFix, ...extra]) {
    if (!value) continue;
    for (const key of ['pid', 'sourceXmlNodeId', 'sourceXmlParagraphOrdinal', 'noteId',
      ...(target.kind === 'table' ? ['sourceXmlTableOrdinal'] : [])]) {
      if (value[key] == null) continue;
      const actual = key === 'pid' ? node.id : node[key];
      if (actual == null) return 'source_identity_unverified';
      if (String(value[key]) !== String(actual)) return 'source_identity_mismatch';
    }
    if (value.part != null && ![node.part, node.part && 'word/' + node.part].includes(value.part)) return 'source_identity_mismatch';
    for (const key of ['workSha256', 'sourcePackageSha256']) {
      if (value[key] != null && value[key] !== doc?.sourcePackageSha256) return 'source_package_mismatch';
    }
  }
  return null;
}

function splitsSurrogate(text, at) {
  return at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]);
}

function unsupportedRangeOwner(issue, extra = []) {
  for (const value of [issue, issue.autoFix, ...extra]) {
    if (!value) continue;
    if (value.textView != null && value.textView !== 'after') return 'unsupported_text_view';
    if (value.offsetUnit != null && value.offsetUnit !== 'utf16') return 'unsupported_offset_unit';
    if (value.paragraphIndexOwner != null && value.paragraphIndexOwner !== 'application-paragraph-index') return 'unsupported_index_owner';
    if (value.owner != null && !['after', 'application-paragraph-index'].includes(value.owner)) return 'unsupported_source_owner';
  }
  return null;
}

function versionFailure(issue, doc, extra = []) {
  for (const value of [issue, issue.autoFix, ...extra]) {
    if (!value) continue;
    for (const key of ['sourceVersionId', 'workVersionId', 'versionId']) {
      if (value[key] == null) continue;
      if (doc?.sourceVersionId == null) return 'source_version_unverified';
      if (value[key] !== doc.sourceVersionId) return 'source_version_mismatch';
    }
  }
  return null;
}

function explicitTargetFailure(issue, anchor, target) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return 'invalid_explicit_anchor';
  if (!target || anchor.target !== target.kind || anchor.index !== target.index) return 'conflicting_source_target';
  for (const [kind, key] of [['paragraph', 'paragraphIndex'], ['footnote', 'footnoteIndex'], ['endnote', 'endnoteIndex']]) {
    if (issue[key] != null && (kind !== target.kind || issue[key] !== target.index)) return 'conflicting_source_target';
  }
  const location = /^(paragraph|footnote|endnote|table):(\d+)$/.exec(String(issue.location || ''));
  if (location && (location[1] !== target.kind || Number(location[2]) !== target.index)) return 'conflicting_source_target';
  if (issue.location === 'document') return 'conflicting_source_target';
  return null;
}

/**
 * 计算单条问题的锚点。
 *
 * @param {object} issue 审阅问题（含 paragraphIndex/footnoteIndex/quote/offset/autoFix）
 * @param {object} doc   `parseDocxBuffer` 的产物
 * @returns {{
 *   target:'paragraph'|'footnote'|'endnote', index:number,
 *   start:number, end:number, text:string,
 *   precision:'exact'|'punctuation'|'quote'|'paragraph'
 * }|null}
 */
export function computeAnchor(issue, doc) {
  // Request-scope source rejection must survive every downstream consumer.
  // A quote search cannot turn a rejected or ambiguous model declaration into
  // a guessed first paragraph, even if other fields still name that paragraph.
  if (issue.modelSourceResolution) {
    const resolution = issue.modelSourceResolution;
    if (!['resolved', 'document'].includes(resolution.status)
      || resolution.status === 'resolved' && !issue.anchor) {
      return { target: 'document', index: 0, start: 0, end: 0, text: '', precision: 'none',
        resolutionStatus: resolution.status === 'ambiguous' ? 'ambiguous' : 'unmapped',
        resolutionReason: resolution.status === 'resolved' ? 'missing_model_source_anchor'
          : resolution.reasonCode || 'unverified_model_source',
        rangeProof: 'model-exposed-source-resolution', sourceIdentityAvailable: false,
        candidateRanges: Array.isArray(resolution.candidates) ? resolution.candidates : [],
        textView: 'after', offsetUnit: 'utf16' };
    }
  }
  const explicit = issue.anchor;
  const hasExplicit = explicit != null;
  // An anchor may supply the only concrete target, but cannot override a
  // separately declared application index (including an invalid one).
  const hasDeclaredIndex = ['paragraphIndex', 'footnoteIndex', 'endnoteIndex'].some((key) => issue[key] != null);
  const explicitTarget = hasExplicit && explicit && ['paragraph', 'footnote', 'endnote'].includes(explicit.target)
    && Number.isInteger(explicit.index) ? { [explicit.target + 'Index']: explicit.index } : null;
  const t = resolveTarget(issue, doc) || (!hasDeclaredIndex && explicitTarget ? resolveTarget(explicitTarget, doc) : null);
  const rejectExplicit = (reason, navigation) => ({ ...(navigation || fallbackAnchor(issue) || documentAnchor()),
    resolutionStatus: 'unmapped', resolutionReason: reason, rangeProof: 'rejected-explicit-anchor',
    rejectedExplicitAnchor: explicit && typeof explicit === 'object' ? { ...explicit } : explicit });
  // 整篇级 / 表级问题：给出可跳转的兜底目标，而不是让前端点了没反应
  if (!t) {
    if (!hasExplicit) return fallbackAnchor(issue) || documentAnchor();
    const fallback = fallbackAnchor(issue);
    // Structural navigation has no character range; keep that distinction.
    if (fallback && explicit?.target === fallback.target && explicit?.index === fallback.index
      && explicit.start === 0 && explicit.end === 0 && explicit.text === '') {
      const failure = unsupportedRangeOwner(issue, [explicit]) || versionFailure(issue, doc, [explicit]);
      if (failure) return rejectExplicit(failure, fallback);
      const identity = identityFailure(issue, { kind: fallback.target, node: fallback.target === 'table' ? doc?.tables?.[fallback.index] : {} }, doc, [explicit]);
      if (identity) return rejectExplicit(identity, fallback);
      if (explicit.resolutionStatus != null && !['resolved', 'paragraph'].includes(explicit.resolutionStatus)) return rejectExplicit('unresolved_source_range', fallback);
      if (explicit.precision != null && explicit.precision !== fallback.precision) return rejectExplicit('unsupported_range_precision', fallback);
      return fallback;
    }
    return rejectExplicit('conflicting_source_target');
  }
  const text = t.text;
  /**
   * 目标容器存在但**文本为空**（典型：模型指向标题后的空行）。
   * 退到最近的非空同类型段落，让那一行仍然点得动、划得出下划线。
   */
  if (!text) {
    if (hasExplicit) return rejectExplicit(explicitTargetFailure(issue, explicit, t)
      || unsupportedRangeOwner(issue, [explicit]) || identityFailure(issue, t, doc, [explicit])
      || versionFailure(issue, doc, [explicit]) || 'invalid_explicit_range',
    { target: t.kind, index: t.index, start: 0, end: 0, text: '', precision: 'paragraph', ...sourceIdentity(t, doc) });
    const near = nearestNonEmpty(t, doc);
    if (near) {
      return {
        target: t.kind, index: near.index, start: 0, end: near.text.length,
        text: near.text, precision: 'paragraph', ...sourceIdentity({ ...t, ...near }, doc),
        resolutionStatus: 'unmapped', resolutionReason: 'empty_source_paragraph', rangeProof: 'nearby-paragraph-navigation',
      };
    }
    return fallbackAnchor(issue) || documentAnchor();
  }

  const pack = (range, precision, proof = {}) => {
    if (!range) return null;
    let { start, end } = range;
    start = Math.max(0, Math.min(start, text.length));
    end = Math.max(start + 1, Math.min(end, text.length));
    // 需求上限：锚点不得超过整段
    end = Math.min(end, text.length);
    return { target: t.kind, index: t.index, start, end, text: text.slice(start, end), precision,
      ...sourceIdentity(t, doc), resolutionStatus: 'resolved', ...proof };
  };

  const coarse = (reason, status = 'unmapped', candidateRanges = []) => pack({ start: 0, end: text.length }, 'paragraph',
    { resolutionStatus: status, resolutionReason: reason, rangeProof: 'paragraph-navigation', candidateRanges });
  if (hasExplicit) {
    const failure = explicitTargetFailure(issue, explicit, t)
      || unsupportedRangeOwner(issue, [explicit]) || identityFailure(issue, t, doc, [explicit])
      || versionFailure(issue, doc, [explicit]);
    if (failure) return rejectExplicit(failure, coarse(failure));
    if (explicit.resolutionStatus != null && !['resolved', 'paragraph'].includes(explicit.resolutionStatus)) {
      return rejectExplicit('unresolved_source_range', coarse('unresolved_source_range'));
    }
    const { start, end } = explicit;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length
      || typeof explicit.text !== 'string' || explicit.text.length !== end - start
      || splitsSurrogate(text, start) || splitsSurrogate(text, end)) {
      return rejectExplicit('invalid_explicit_range', coarse('invalid_explicit_range'));
    }
    if (text.slice(start, end) !== explicit.text) return rejectExplicit('stale_explicit_range', coarse('stale_explicit_range'));
    const precision = explicit.precision ?? 'exact';
    if (!['exact', 'punctuation', 'quote', 'paragraph'].includes(precision)) {
      return rejectExplicit('unsupported_range_precision', coarse('unsupported_range_precision'));
    }
    return pack({ start, end }, precision, { rangeProof: 'verified-explicit-anchor', comparisonView: 'literal',
      ...(explicit.resolutionStatus === 'paragraph' ? { resolutionStatus: 'paragraph' } : {}) });
  }
  const ownerFailure = unsupportedRangeOwner(issue);
  if (ownerFailure) return coarse(ownerFailure);
  const identity = identityFailure(issue, t, doc);
  if (identity) return coarse(identity);

  // 1) 精确：autoFix.find + autoFix.offset
  const find = issue.autoFix?.find;
  const fxOffset = issue.autoFix?.offset ?? issue.offset;
  if (find) {
    if (fxOffset != null) {
      if (!Number.isInteger(fxOffset) || fxOffset < 0 || splitsSurrogate(text, fxOffset) || splitsSurrogate(text, fxOffset + find.length)) return coarse('invalid_offset');
      if (text.slice(fxOffset, fxOffset + find.length) !== find) return coarse('stale_offset');
      return pack({ start: fxOffset, end: fxOffset + find.length }, 'exact', { rangeProof: 'verified-text-at-offset', comparisonView: 'literal' });
    }
    const hits = findTextCandidates(text, find);
    if (hits.length > 1) return coarse('ambiguous_text', 'ambiguous', hits);
    if (hits.length === 1) return pack(hits[0], hits[0].comparisonView === 'literal' ? 'exact' : 'quote',
      { rangeProof: hits[0].comparisonView === 'literal' ? 'unique-exact-text' : 'unique-whitespace-aligned', comparisonView: hits[0].comparisonView });
  }

  // 2) 只有 offset：标点级锚点
  const off = typeof fxOffset === 'number' ? fxOffset : issue.offset;
  if (Number.isInteger(off) && off >= 0 && off < text.length) {
    const r = punctuationAnchor(text, off);
    if (r) return pack(r, 'punctuation', { rangeProof: 'verified-offset-clause', comparisonView: 'literal' });
  }
  if (off != null) return coarse('invalid_offset');

  // 3) 用 quote 反查
  if (issue.quote) {
    const hits = findTextCandidates(text, issue.quote);
    if (hits.length > 1) return coarse('ambiguous_text', 'ambiguous', hits);
    if (hits.length === 1) return pack(hits[0], 'quote', { rangeProof: hits[0].comparisonView === 'literal'
      ? 'unique-exact-text' : 'unique-whitespace-aligned', comparisonView: hits[0].comparisonView });
  }

  // 4) 兜底：整段（需求允许的上限）
  return pack({ start: 0, end: text.length }, 'paragraph', { resolutionStatus: 'paragraph', rangeProof: 'paragraph-navigation' });
}

/**
 * 计算一条问题可能对应的**全部**锚点。
 *
 * 归并条目（`occurrences`，如「全文 40 处半角逗号」合成一条）要逐处下划线，
 * 否则界面上只划第一处，用户会以为其余的没被发现问题。
 */
export function computeAnchors(issue, doc) {
  const out = [];
  const occ = issue.occurrences;
  if (Array.isArray(occ) && occ.length) {
    for (const [occurrenceIndex, o] of occ.entries()) {
      // An occurrence owns its part. Inheriting a parent's body/note index
      // makes resolveTarget select that earlier part even when this occurrence
      // explicitly belongs to another one (the modification path already
      // enforces this same boundary).
      const inheritedFix = issue.autoFix ? { ...issue.autoFix } : undefined;
      if (inheritedFix) delete inheritedFix.offset;
      const occurrenceFix = Object.hasOwn(o, 'autoFix') ? o.autoFix : inheritedFix;
      const merged = { ...issue, paragraphIndex: undefined, footnoteIndex: undefined, endnoteIndex: undefined,
        offset: undefined, pid: undefined, part: undefined, noteId: undefined,
        sourceXmlNodeId: undefined, sourceXmlParagraphOrdinal: undefined,
        anchor: undefined, anchors: undefined, ...o, autoFix: occurrenceFix, occurrences: undefined };
      const a = computeAnchor(merged, doc);
      if (a) out.push({ ...a, occurrence: true, occurrenceIndex });
    }
    if (out.length) return out;
  }
  const a = computeAnchor(issue, doc);
  return a ? [a] : [];
}

/**
 * 给一整份审阅结果补齐锚点。
 *
 * 就地写回 `issue.anchors`（数组）与 `issue.anchor`（首个，便于前端简单场景）。
 * 同时统计锚点质量，便于验收「定位是否真的到了标点级」。
 */
export function attachAnchors(result, doc) {
  const stats = { exact: 0, punctuation: 0, quote: 0, paragraph: 0, document: 0, table: 0, none: 0, ambiguous: 0, unmapped: 0, issues: 0, marks: 0 };
  for (const it of result?.issues || []) {
    stats.issues += 1;
    const anchors = computeAnchors(it, doc);
    if (!anchors.length) { stats.none += 1; continue; }
    it.anchors = anchors;
    it.anchor = anchors[0];
    stats.marks += anchors.length;
    const p = anchors[0].precision;
    stats[p] = (stats[p] || 0) + 1;
    if (anchors.some((a) => a.resolutionStatus === 'ambiguous')) stats.ambiguous += 1;
    if (anchors.some((a) => a.resolutionStatus === 'unmapped')) stats.unmapped += 1;
  }
  return stats;
}

/** A comment's readable scope is separate from the exact text licensed for edits. */
export function sentenceRange(text, start, end) {
  // Reuse the tested language tokenizer (titles, abbreviations, decimals, closing quotes).
  // Its raw strings are projected monotonically, never whitespace-normalized or first-match searched.
  const spans = []; let at = 0;
  for (const sentence of splitSentences(text, { semicolon: false })) {
    const s = text.indexOf(sentence, at);
    if (s < 0) return { start, end, text: text.slice(start, end) };
    at = s + sentence.length; spans.push({ start: s, end: at });
  }
  let s = Math.min(start, spans.find(x=>x.end>start)?.start ?? start);
  const e = Math.max(end, spans.find(x=>x.end>=end)?.end ?? end);
  while (s < start && /\s/.test(text[s])) s += 1;
  return { start: s, end: e, text: text.slice(s, e) };
}

export function commentRangeScope(issue) {
  if (!['model', 'language'].includes(issue.group)) return 'phrase';
  if (issue.rangeScope === 'paragraph') return 'paragraph';
  // Legacy results have no rangeScope. Only structural language problems expand.
  if (['LANG-002', 'LANG-004', 'LANG-005', 'LANG-006', 'LANG-010', 'LANG-011', 'LANG-022'].includes(issue.ruleId)
    || /句式|句法|语序|成分残缺|主语.{0,3}(?:丢失|缺|不明)|指代不明|长句|逻辑.{0,3}(?:不成立|矛盾)/.test(`${issue.category || ''} ${issue.title || ''}`)) return 'sentence';
  return issue.rangeScope === 'sentence' ? 'sentence' : 'phrase';
}

export function attachCommentAnchors(result, doc) {
  const arrays = { paragraph: 'paragraphs', footnote: 'footnotes', endnote: 'endnotes' };
  for (const issue of result?.issues || []) {
    delete issue.commentAnchors;
    if (issue.needsRelocation) continue;
    const scope = commentRangeScope(issue);
    issue.commentAnchors = (issue.anchors || (issue.anchor ? [issue.anchor] : [])).map(a => {
      const node = doc?.[arrays[a.target]]?.[a.index], text = node?.text;
      if (scope === 'phrase' || ['ambiguous', 'unmapped', 'unresolved'].includes(a.resolutionStatus)
        || typeof text !== 'string' || !Number.isInteger(a.start) || !Number.isInteger(a.end)
        || a.start < 0 || a.end <= a.start || a.end > text.length || text.slice(a.start, a.end) !== a.text
        || a.sourcePackageSha256 != null && a.sourcePackageSha256 !== doc.sourcePackageSha256
        || a.sourceVersionId != null && a.sourceVersionId !== doc.sourceVersionId
        || a.pid != null && a.pid !== node.id
        || a.sourceXmlNodeId != null && a.sourceXmlNodeId !== node.sourceXmlNodeId) return { ...a };
      const range = scope === 'paragraph' ? { start: 0, end: text.length, text } : sentenceRange(text, a.start, a.end);
      return { ...a, ...range, commentScope: scope, evidenceRange: { start: a.start, end: a.end, text: a.text },
        rangeProof: 'verified-source-comment-boundary' };
    });
  }
  return result;
}
