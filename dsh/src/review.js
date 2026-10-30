/**
 * 审稿流水线：把 DOCX 解析、三类确定性规则扫描、可选的模型深度审阅串起来。
 */
import { parseDocx, parseDocxBuffer } from './docx.js';
import { scanFormat, classifyParagraphs } from './scanner-format.js';
import { scanLanguage } from './scanner-language.js';
import { scanCitation } from './scanner-citation.js';
import { modelReview, DEFAULT_MODEL, arkConfigured } from './ark.js';
import {getArkScope,withArkScope,createLocalArkScope} from './ark-execution-context.js';
import {createHash} from 'node:crypto';
import { judge, DEFAULT_THRESHOLDS } from './verdict.js';
import { recheckFixes, verdictLabel, fixTextOf, applyModelVerdicts } from './recheck.js';
import { finalizeReviewCoverage, buildReviewCoverage } from './review-coverage.js';
import { sumTokenUsage } from './token-usage.js';
import { issueIdentity } from './issue-identity.js';

/**
 * 合格性判定阈值。
 * 由 tools/verdict-report.mjs 用「已过审（发排版）」89 份的分数分布标定
 * （P50=35 / P75=53.6 / P90=82）。规则库改动后应重跑该工具重新标定。
 */
export const VERDICT_THRESHOLDS = { ...DEFAULT_THRESHOLDS };

export { parseDocx, parseDocxBuffer };

/** 从文档里识别标题与栏目 */
/**
 * 从文件名解析栏目与作者。
 *
 * 文件名惯例是「NN-作者-标题-栏目.docx」，但栏目常常缺失，
 * 且标题里也可能出现「文化」这类词，所以不能靠位置硬取：
 *   旧实现 /(\d{2})-([^-]+)-/ 取的是第 2 段，而第 2 段是作者，
 *   结果 659 份稿件里只有 42 份碰巧正确（文件名恰好以栏目开头时）。
 * 现在改为：先按分隔符切出栏目候选段，再用期刊栏目白名单校验。
 */
const COLUMN_WHITELIST = ['特稿', '专题', '政治', '经济', '文化', '现场', '书评', '译文'];

/** 去掉段尾的版本标记：【…】［…］{…}（…）以及 .docx 后缀 */
function stripVersionMarks(seg) {
  return String(seg || '')
    .replace(/\.(docx|doc)$/i, '')
    .replace(/[【［\[｛{（(].*$/s, '')
    .trim();
}

/** 在一组字符串里找栏目（必须整段恰好等于栏目词，避免标题误命中） */
function findColumn(strings) {
  for (const s of strings) {
    const clean = stripVersionMarks(s);
    const hit = COLUMN_WHITELIST.find((w) => clean === w);
    if (hit) return hit;
  }
  return '';
}

/** 候选作者段是否像人名/作者列表：短、无标题标点、不是栏目词 */
function looksLikeAuthor(seg) {
  if (!seg) return false;
  const s = seg.trim();
  if (!s || s.length > 24) return false;
  if (COLUMN_WHITELIST.includes(s)) return false;   // 栏目词不是作者
  if (/[。？！：；]/.test(s)) return false;            // 标题标点
  return true;
}

function parseNameParts(base, parentDir = '') {
  const stem = String(base || '').replace(/\.(docx|doc)$/i, '');
  // 先按 - － — ＿ 切段
  let parts = stem.split(/[-－—＿]/).map((s) => s.trim()).filter(Boolean);
  // 去掉开头的序号段（01 / 1 / 2024-01 之类）
  if (parts.length && /^\d{1,4}$/.test(parts[0])) parts = parts.slice(1);
  // 栏目位置不固定：「NN-作者-标题-栏目」和「NN-栏目-标题-作者」都存在，
  // 所以先扫文件名所有段，再扫所在目录名（很多稿件把栏目放在文件夹上，
  // 例如「01-特稿-张维为\01-特稿-张维为-文明型国家…【0803尾注版】.docx」）。
  let column = findColumn(parts);
  if (!column && parentDir) {
    column = findColumn(String(parentDir).split(/[\\/]/).filter(Boolean));
  }
  // 作者：跳过栏目段，取第一个「像作者」的段。
  // 注意不能直接取 parts[0] —— 文件名可能是「NN-栏目-标题-作者」，
  // 那样会把栏目当成作者（曾出现「作者：特稿」）。
  let author = '';
  for (const seg of parts) {
    if (stripVersionMarks(seg) === column) continue;
    if (looksLikeAuthor(seg)) { author = seg.replace(/\s+/g, ' '); break; }
  }
  return { parts, column, author };
}

/**
 * 段落角色分类结果（按 doc 对象缓存）。
 *
 * `detectMeta()` 与 `scanFormat()` 都要用同一份角色判定。不缓存的话
 * `classifyParagraphs()` 会对同一份稿子跑两遍（它内部还有标题分级 +
 * 前置区判定，不是零成本）。缓存在 doc 上而不是模块级 Map，
 * 是为了跟着 doc 的生命周期走、不泄漏。
 */
function rolesOf(doc) {
  if (doc.__roles === undefined) {
    try { doc.__roles = classifyParagraphs(doc); } catch { doc.__roles = null; }
  }
  return doc.__roles;
}

/** 供 server 复用同一份缓存（`serializeDoc` 会被状态轮询反复调用） */
export { rolesOf };

/**
 * 署名段清洗：把被误并进「作者」角色的**英文摘要 / 摘要 / 关键词**段落去掉。
 *
 * 实测（632 篇）：6.0% 的稿件 `author` 超过 20 字、1.9% 超过 40 字，形态一致 ——
 * 英文摘要段（`Abstract: …`）被角色识别判成了 author，与真实署名
 * （`潘亚玲PAN Yaling` / `郭杰振  周原`）拼接在一起。这里按**语义边界**截断，
 * 只影响元信息展示，不改动角色识别本身（避免两套判据各自漂移）。
 */
function cleanAuthorParts(parts) {
  const out = [];
  for (const raw of parts) {
    let t = String(raw || '').trim();
    if (!t) continue;
    const cut = t.search(/Abstract\b|摘要[:：]?|内容提要|关键词[:：]?|作者简介|Key\s*words/i);
    if (cut >= 0) t = t.slice(0, cut).trim();
    if (!t) continue;
    // 丢弃纯英文长句（是正文句子，不是署名）
    if (/^[A-Za-z][A-Za-z0-9 ,.'’\-]{24,}$/.test(t)) continue;
    out.push(t);
  }
  return out.join('');
}

export function detectMeta(doc) {
  const paras = doc.paragraphs;
  /**
   * 篇名 / 署名**以角色识别结果为准**（`classifyParagraphs` 是单一真源）。
   *
   * ── 为什么必须改 ──
   * 这里原来自成一套启发式，与 `classifyParagraphs` 的角色判定**并行且不一致**：
   *   1. 先取「前 8 段里第一个 ≥6 字的非括号段落」当篇名；
   *   2. 再用「前 6 段里连续满足 `居中` 或 `字号 ≥30`」的段落**拼接**覆盖它。
   *
   * 第 2 步会把**连着的三样东西**全拼进去。实测
   * `02-文化-吴子枫-无产阶级专政…`（已发排定稿）得到的是：
   *   「文脉：这篇文章中的强调字体请保留，辛苦！」（投稿平台附注，30pt）
   *   +「无产阶级专政、共产主义战略和“葛兰西难题”」（真篇名，30pt 居中）
   *   +「吴子枫」（署名，28pt 居中 —— 因为条件是 `居中`，不看字号）
   * 拼成一句 43 字的假篇名，而同一份文档的角色识别**明明已经把这三段
   * 分别判成了 title / title / author**。
   *
   * 角色识别里已经处理过的坑（主副标题分两段、摘要先于标题、非稿件文档
   * 不标标题、署名行识别）这里不必再重复一遍 —— 重复实现就是两套判据
   * 各自漂移的根源。
   */
  const cls = rolesOf(doc);
  let title = '';
  let author = '';
  if (cls) {
    const titleParts = [];
    const authorParts = [];
    /**
     * **不限扫描段数** —— 这里原本写死 `limit = 30`（更早是 12），
     * 是个没有依据的魔法数，现已删除。理由不是"30 够用"，而是
     * **这个上界本身多余**：
     *
     * `title`/`author` 两个角色只在**前置区**被赋值（`classifyParagraphs`
     * 有 `beforeFirstHeading` 上界约束），正文段落一律是 `body`，
     * 所以扫到底也收不到噪声，上界不承担任何过滤职责。
     *
     * 实测（`tools/audit-constants.mjs`，632 篇解析成功）：
     *   title  角色下标  n=726  P50=0 P90=1 P99=14 **max=22**
     *   author 角色下标  n=573  P50=2 P90=4 P99=12 **max=23**
     *   最后一条 title 下标 ≥30 的稿件：**0 篇**
     * 也就是说 30 在语料上从未逼近过。留一个"看似安全"的上界，
     * 真正的作用是在将来出现更长前置区时**静默漏掉篇名**，
     * 而不是报错 —— 这种失效方式比没有上界更糟。
     *
     * 历史：12 → 30 是为 `【现场】` 圆桌稿放宽的（`编者按` 4 段 + 空行 11 段，
     * 篇名落在第 17 段）。当时是"把上限调大"，现在改为"取消上限"。
     */
    for (let i = 0; i < paras.length; i += 1) {
      const t = (paras[i].text || '').trim();
      if (!t) continue;
      if (cls.roles[i] === 'title') titleParts.push(t);
      else if (cls.roles[i] === 'author') authorParts.push(t);
    }
    title = titleParts.join('');
    author = cleanAuthorParts(authorParts);
  }
  /**
   * 兜底：角色分类整个失败时，退回原来的启发式（不再拼接）。
   *
   * ⚠️ 但**非稿件类文档**（编辑部来信、审稿意见、编者按、会议纪要）不走兜底。
   *
   * 实测来源：`5现场-章永乐等-殖民帝国史视野下的区域国别研究与涉外法治`
   * 首段是 194 字的 `编者按：2022年，区域国别学成为交叉学科门类下的一级学科…`。
   * 该文档被判为 `nonManuscript`，于是角色分类**故意不标任何标题**
   * （见 `classifyParagraphs` 里那段注释：「宁可不标，也不标错」），
   * `titleParts` 为空 → 落到这里的兜底 → 兜底按「第一个 ≥6 字的段落」取值
   * → 把整段编者按当成了篇名。
   *
   * 对这类文档，**「没有篇名」才是正确答案**，下游 `hasTitle` 检查会据此
   * 报「缺标题」，这是对的。兜底逻辑不该把它盖掉。
   */
  if (!title && !(cls && cls.nonManuscript)) {
    for (const p of paras.slice(0, 8)) {
      const t = p.text.trim();
      if (!t) continue;
      if (/^[\[［【]/.test(t)) continue;
      if (/^[\u4e00-\u9fa5·]{2,6}(\s+|　|$)/.test(t) && t.length < 20) continue; // 作者行
      if (t.length >= 6) { title = t; break; }
    }
  }
  const fullName = doc.label || '';
  const segs = fullName.split(/[\\/]/).filter(Boolean);
  const base = segs.at(-1) || '';
  const parentDir = segs.at(-2) || '';
  const { column, author: fileAuthor } = parseNameParts(base, parentDir);
  /**
   * 署名优先取**正文里的署名行**，文件名只作兜底。
   *
   * 原来的顺序是「文件名优先」，理由是 `docProps` 的 `dc:creator` 常是
   * 排版工具名。但角色识别取的不是 `dc:creator`，而是正文里真实存在的
   * 署名段 —— 它比文件名更贴近稿件本身（文件名可能带序号、日期、
   * 平台后缀，实测 `parseNameParts` 对 `x.docx` 会返回 `x` 这种垃圾值）。
   * `dc:creator` 仍然只作最后兜底。
   */
  const coreAuthor = String(doc.core['dc:creator'] || '').trim();
  const resolvedAuthor = author || fileAuthor
    || (/^[\u4e00-\u9fa5]/.test(coreAuthor) ? coreAuthor : '');
  return {
    title,
    column,
    source: fullName,
    author: resolvedAuthor,
    lastModifiedBy: doc.core['cp:lastModifiedBy'] || '',
    chars: doc.stats.chars,
    /**
     * ⚠️ 原文自带的 Word 批注**不参与审阅**，只保留计数统计。
     *
     * 原先这里产出 `commentHints`，并被 `ark.js` 写进模型提示词
     * （「本文已有的编辑批注（这些是责编人工提出的问题，请核验它们是否确实成立…）」）。
     * 已按要求移除，原因有两条：
     *
     *   1. **这批批注本身就是规则库的学习语料** —— 一审准则正是从这 598 份
     *      稿件的批注里归纳出来的。把它们再喂回模型，等于让模型「抄答案」：
     *      审出来的问题会向历史批注靠拢，而不是独立判断，也会掩盖规则的漏检。
     *   2. 界面上不需要展示它们（它们描述的是**上一轮**的问题，不是本次审阅结论）。
     *
     * `commentCount` 保留 —— 它是解析统计（稿件里有多少条批注），
     * 不是批注内容，界面用它显示稿件的解析概况。
     */
    commentCount: (doc.comments || []).length,
  };
}

/** 确定性扫描（快，无需网络） */
export function deterministicReview(doc) {
  const format = scanFormat(doc);
  const language = scanLanguage(doc);
  const citation = scanCitation(doc);
  const all = [...format.issues, ...language.issues, ...citation.issues];
  return {
    format, language, citation,
    issues: all,
    summary: {
      total: all.length,
      format: format.issues.length,
      language: language.issues.length,
      citation: citation.issues.length,
      bySeverity: countBy(all, (i) => i.severity),
      byGroup: countBy(all, (i) => i.group),
      byCategory: countBy(all, (i) => i.category),
    },
    modelRules: language.modelRules,
  };
}

/**
 * 流式完整审阅：与 fullReview 结果一致，但把问题**逐条**回调出去。
 *
 * 顺序：标题 → 正文段落 → 脚注 → 尾注（documentOrder）。
 * 规则引擎本身是瞬时的，逐条推送前会按 onIssue 的节奏让出事件循环，
 * 前端才能看到「一条一条出来」而不是一次性刷出。
 *
 * @param {object} doc
 * @param {object} opts
 * @param {(issue:object, meta:{engine:string,index:number,total:number})=>void} opts.onIssue
 */
export async function streamingReview(doc, opts = {}) {
  if(!getArkScope())return withArkScope(localReviewScope(doc,opts),()=>streamingReview(doc,opts));
  const {
    useModel = true, useRecheck = false, verdictWithModel = false, useContext = true, useCases = true, ruleMode = 'all', model = DEFAULT_MODEL, onProgress = () => {},
    onIssue = () => {}, focus = [], signal,
    // 规则引擎本身是瞬时的（整篇 45 ms），不加节奏的话前端会一次性刷出全部批注，
    // 看不出「逐条出现」。这里按总数自适应地插入间隔，把规则阶段摊到约 2.5 秒。
    ruleStreamMs = 2500,
  } = opts;
  const meta = detectMeta(doc);

  onProgress({ phase: 'rules', message: '执行格式体例、语言词汇、引文注释三类规则扫描' });
  const det = deterministicReview(doc);
  onProgress({ phase: 'rules-done', message: `规则扫描完成，命中 ${det.summary.total} 条` });

  // 规则问题先按文档顺序排好，再逐条推出
  const ruleIssues = documentOrder(doc, det.issues);
  // 间隔：把总时长摊到 ruleStreamMs，但夹在 [6, 60] ms 之间——
  // 太少则看不出流式，太多则长稿（200+ 条）会拖慢审阅本身。
  const gap = ruleIssues.length > 1
    ? Math.min(60, Math.max(6, Math.floor(ruleStreamMs / ruleIssues.length)))
    : 0;
  for (let i = 0; i < ruleIssues.length; i += 1) {
    if (signal?.aborted) throw abortReason(signal);
    onIssue(ruleIssues[i], { engine: 'rule', index: i, total: ruleIssues.length });
    if (gap) await new Promise((r) => setTimeout(r, gap));
  }
  onProgress({ phase: 'rules-streamed', message: `规则问题已全部推送（${ruleIssues.length} 条）` });

  let modelResult = null;
  if (useModel && arkConfigured() && !signal?.aborted) {
    try {
      // 模型每完成一个窗口就回吐该窗口的问题，前端随即显示，不必等整篇跑完
      modelResult = await modelReview(doc, {
        model, onProgress, focus, docMeta: meta, signal, ruleMode, useContext, useCases,
        onIssues: (list, info) => {
          for (const it of list) onIssue(it, { engine: 'model', ...info });
        },
      });
      onProgress({ phase: 'model-done', message: `模型审阅完成，命中 ${modelResult.issues.length} 条` });
    } catch (err) {
      if (signal?.aborted) throw err;
      modelResult = { issues: [], errors: [{ message: String(err.message || err) }], usage: {} };
      onProgress({ phase: 'model-error', message: `模型审阅失败：${err.message}` });
    }
  }

  const all = [...det.issues, ...(modelResult?.issues || [])];
  const deduped = documentOrder(doc, dedupeAcrossEngines(all));

  /**
   * 合格性判定（目标点 10）必须在**模型复核降级之前**算好，这是 E2 的关键。
   *
   * ⚠️ `applyModelVerdicts` 会就地降级 `deduped` 里的条目，而 `deduped` 里的
   * 规则条目与 `det.issues` 是**同一批对象**（`dedupeAcrossEngines` 原样保留
   * 引用）。若先降级再判定，模型结论会渗进主判定，破坏「纯规则口径、可对照
   * 历史标定、可复现」这一前提 —— 同一份稿子跑不跑模型会得出不同合格性。
   * 因此这里先冻结 `verdictBase`；模型降级只影响展示与 `verdictModel`。
   *
   * ⚠️ 这里传的是 `det.issues`（**纯规则**），不是 `deduped`。
   * 阈值由已过审语料标定，而标定用的就是纯规则分布；实测「规则+模型」
   * 的分数**分不开**已过审与在审两层（Welch t=−0.47 vs 纯规则的 −2.21），
   * 传 `deduped` 会让每篇稿子（含已付印定稿）都判「不合格」。
   * 完整实测数据见 `verdict.js` 的 `judge()` 注释。
   * 模型意见通过 `modelIssues` 单独呈现，不参与判定。
   *
   * ⚠️ `modelIssues` 传的是**去重后仍在列表里的**模型条目，不是
   * `modelResult.issues` 原始列表 —— 后者含与规则重复的条目，
   * 已被 `dedupeAcrossEngines` 去掉。传原始列表会让判定提示里的
   * 条数（如 146）大于右侧清单里实际可见的模型条数（如 126），
   * 用户一数就对不上。实测踩过这个不一致。
   */
  const verdictBase = judge(det.issues, {
    thresholds: VERDICT_THRESHOLDS,
    chars: doc.stats?.chars || 0,
    modelIssues: deduped.filter((i) => i.group === 'model'),
  });

  // 模型复核（目标点 13）：对每条「建议修改」再问一次模型是否同意。
  // 默认关闭 —— 它会给每篇稿子再加 2—4 次模型调用，必须由调用方显式开启。
  let recheck = null;
  if (useRecheck && arkConfigured() && !signal?.aborted) {
    try {
      recheck = await recheckFixes(deduped, { model, onProgress, signal });
      onProgress({ phase: 'recheck-done', message: `复核结论：同意 ${recheck.stats.agree} / 不同意 ${recheck.stats.disagree} / 拿不准 ${recheck.stats.unsure}` });
    } catch (err) {
      if (signal?.aborted) throw err;
      recheck = { executionStatus: 'failed', byKey: new Map(), stats: { total: deduped.length, checked: 0, agree: 0, disagree: 0, unsure: 0, skipped: deduped.length, batches: 0 }, errors: [{ message: String(err?.message || err) }] };
      onProgress({ phase: 'recheck-error', message: `模型复核失败：${err.message}` });
    }
  }

  /**
   * 把复核结论落到每条问题的优先级上：模型同意 → 保留；不同意 → 降一级并
   * 给出模型观点、标记需人工确认；拿不准 → 保留但标记需人工判断。
   * 在 `buildSummary` 之前调用，使严重度统计与降级后的优先级一致。
   * 注意：它**不改**已经冻结的 `verdictBase`。
   */
  applyModelVerdicts(deduped, recheck);

  return finalizeReviewCoverage({
    meta,
    model,
    generatedAt: new Date().toISOString(),
    issues: deduped,
    deterministic: det,
    modelResult,
    recheck,
    summary: buildSummary(deduped, det, modelResult, recheck),
    // 主判定：纯规则口径，在降级前冻结（见上方 verdictBase 注释）
    verdict: verdictBase,
    // E2：与主判定同一基线，仅把模型复核的降级计入，供对照（默认关）
    verdictModel: modelAdjustedVerdict(det.issues, doc.stats?.chars || 0, verdictWithModel),
    usage: sumTokenUsage(modelResult?.usage, recheck?.usage),
    usageBreakdown: { review: modelResult?.usage || null, recheck: recheck?.usage || null },
  }, {useModel,useRecheck,useContext:opts.useContext===undefined?useModel&&useContext:useContext,
    useCases:opts.useCases===undefined?useModel&&useCases:useCases,ruleMode,verdictWithModel,purpose:opts.purpose});
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('已中止');
}
function localReviewScope(doc,opts){
  const workSha256=doc.sourcePackageSha256||createHash('sha256').update(JSON.stringify(['paragraphs','footnotes','endnotes'].map(k=>(doc[k]||[]).map(p=>({text:p.text||'',noteId:p.noteId||null}))))).digest('hex');
  return createLocalArkScope({purpose:opts.purpose||'editorial',operationKind:'direct-manuscript-review',
    transientSource:true,resumable:false,
    binding:{sourceSha256:workSha256,workSha256,versionId:doc.sourceVersionId||'transient:'+workSha256,mutationEpoch:0}});
}

/** 统一口径的汇总（fullReview 与 streamingReview 共用，避免两处算出不同数字） */
function buildSummary(deduped, det, modelResult, recheck = null) {
  return {
    total: deduped.length,
    // 以下各项均为「去重后」口径，保证分项之和等于总数
    ruleBased: deduped.filter((i) => i.group !== 'model').length,
    modelBased: deduped.filter((i) => i.group === 'model').length,
    format: deduped.filter((i) => i.group === 'format').length,
    language: deduped.filter((i) => i.group === 'language').length,
    citation: deduped.filter((i) => i.group === 'citation').length,
    // 去重前的原始命中数，供统计参考
    raw: {
      ruleHits: det.summary.total,
      modelHits: modelResult?.issues?.length || 0,
      format: det.format.issues.length,
      language: det.language.issues.length,
      citation: det.citation.issues.length,
    },
    bySeverity: countBy(deduped, (i) => i.severity),
    byGroup: countBy(deduped, (i) => i.group),
    byCategory: countBy(deduped, (i) => i.category),
    /**
     * 第二轮自证（模型逐条核对）的统计。
     * `disagree` 即「模型判定这条不成立」的条数 —— 这是衡量自证是否真在
     * 减误报的关键数字。`noReply` 单列，避免把「没问到」伪装成「拿不准」。
     */
    selfVerify: recheck ? {
      total: recheck.stats?.total || 0,
      checked: recheck.stats?.checked || 0,
      agree: recheck.stats?.agree || 0,
      disagree: recheck.stats?.disagree || 0,
      unsure: Math.max(0, (recheck.stats?.unsure || 0) - (recheck.stats?.noReply || 0)),
      noReply: recheck.stats?.noReply || 0,
      skipped: recheck.stats?.skipped || 0,
    } : null,
  };
}

/**
 * 「含模型复核」参考判定（E2，可选，默认关）。
 *
 * 与主判定**同一基线**（都是 `det.issues` 这批规则问题），只是这些条目在
 * `applyModelVerdicts` 之后已被模型复核**降过级** —— 两版之差即「模型复核
 * 对结论的影响」本身，不再混入「跨引擎去重」等其它口径差异。
 *
 * 默认不开：主判定必须可复现、可对照历史标定；参考判定只在用户显式开启时
 * 展示，不动标定基准。
 *
 * @param {object[]} ruleIssues 纯规则问题（det.issues，已在降级后被就地修改）
 * @param {number} chars 全文字符数（判定折算每千字分数用）
 * @param {boolean} enabled 是否计算（默认关）
 */
function modelAdjustedVerdict(ruleIssues, chars, enabled) {
  if (!enabled) return null;
  return judge(ruleIssues, {
    thresholds: VERDICT_THRESHOLDS,
    chars,
  });
}

/** 完整审阅：确定性扫描 + 模型深度审阅 */
export async function fullReview(doc, opts = {}) {
  if(!getArkScope())return withArkScope(localReviewScope(doc,opts),()=>fullReview(doc,opts));
  const { useModel = true, useRecheck = false, verdictWithModel = false, useContext = true, useCases = true, ruleMode = 'all', model = DEFAULT_MODEL, onProgress = () => {}, focus = [], signal } = opts;
  const meta = detectMeta(doc);
  onProgress({ phase: 'rules', message: '执行格式体例、语言词汇、引文注释三类规则扫描' });
  const det = deterministicReview(doc);
  onProgress({ phase: 'rules-done', message: `规则扫描完成，命中 ${det.summary.total} 条` });

  let modelResult = null;
  if (useModel && arkConfigured() && !signal?.aborted) {
    try {
      // signal 透传给模型审阅，用户点「中止」时能真正停掉在途的模型请求
      modelResult = await modelReview(doc, { model, onProgress, focus, docMeta: meta, signal, ruleMode, useContext, useCases });
      onProgress({ phase: 'model-done', message: `模型审阅完成，命中 ${modelResult.issues.length} 条` });
    } catch (err) {
      if (signal?.aborted) throw err;
      modelResult = { issues: [], errors: [{ message: String(err.message || err) }], usage: {} };
      onProgress({ phase: 'model-error', message: `模型审阅失败：${err.message}` });
    }
  }

  const all = [...det.issues, ...(modelResult?.issues || [])];
  const deduped = dedupeAcrossEngines(all);

  // 合格性主判定：与流式路径同一口径，先于模型降级冻结（理由见 streamingReview）
  const verdictBase = judge(det.issues, {
    thresholds: VERDICT_THRESHOLDS,
    chars: doc.stats?.chars || 0,
    modelIssues: deduped.filter((i) => i.group === 'model'),
  });

  // 模型复核（目标点 13）：与流式路径同一口径，默认关闭
  let recheck = null;
  if (useRecheck && arkConfigured() && !signal?.aborted) {
    try {
      recheck = await recheckFixes(deduped, { model, onProgress, signal });
      onProgress({ phase: 'recheck-done', message: `复核结论：同意 ${recheck.stats.agree} / 不同意 ${recheck.stats.disagree} / 拿不准 ${recheck.stats.unsure}` });
    } catch (err) {
      if (signal?.aborted) throw err;
      recheck = { executionStatus: 'failed', byKey: new Map(), stats: { total: deduped.length, checked: 0, agree: 0, disagree: 0, unsure: 0, skipped: deduped.length, batches: 0 }, errors: [{ message: String(err?.message || err) }] };
      onProgress({ phase: 'recheck-error', message: `模型复核失败：${err.message}` });
    }
  }

  // 复核结论落到优先级（同意保留 / 不同意降级 + 留人工），不改已冻结的主判定
  applyModelVerdicts(deduped, recheck);

  return finalizeReviewCoverage({
    meta,
    model,
    generatedAt: new Date().toISOString(),
    issues: deduped,
    deterministic: det,
    modelResult,
    recheck,
    summary: buildSummary(deduped, det, modelResult, recheck),
    // 主判定：纯规则口径，在模型降级前冻结（与流式路径同一口径）
    verdict: verdictBase,
    // E2：与主判定同一基线，仅把模型复核的降级计入，供对照（默认关）
    verdictModel: modelAdjustedVerdict(det.issues, doc.stats?.chars || 0, verdictWithModel),
    usage: sumTokenUsage(modelResult?.usage, recheck?.usage),
    usageBreakdown: { review: modelResult?.usage || null, recheck: recheck?.usage || null },
  }, {useModel,useRecheck,useContext:opts.useContext===undefined?useModel&&useContext:useContext,
    useCases:opts.useCases===undefined?useModel&&useCases:useCases,ruleMode,verdictWithModel,purpose:opts.purpose});
}

/**
 * 把问题按「读者阅读顺序」排序：标题 → 正文段落 → 脚注 → 尾注。
 *
 * 流式批注要求问题从标题一直出到结尾，所以顺序不能是扫描器的内部次序，
 * 必须按它在文档里的真实位置排。
 */
export function documentOrder(doc, issues) {
  const pos = (it) => {
    if (it.paragraphIndex !== undefined && it.paragraphIndex !== null) return it.paragraphIndex;
    // 脚注与尾注排在全部正文之后；用一个远大于段落数的基数，并保留脚注/尾注内部次序
    if (it.footnoteIndex !== undefined && it.footnoteIndex !== null) return 100000 + it.footnoteIndex;
    if (it.endnoteIndex !== undefined && it.endnoteIndex !== null) return 200000 + it.endnoteIndex;
    return 300000; // 文档级判断（缺内容提要、作者简介缺失等）排在最后
  };
  return [...issues]
    .map((it, i) => ({ it, i, p: pos(it) }))
    .sort((a, b) => (a.p - b.p) || (a.i - b.i))
    .map((x) => x.it);
}

/** 规则引擎与模型结果去重：同一条规则在同一位置只保留一次；模型结果若已被规则覆盖则丢弃 */
export function dedupeAcrossEngines(list) {
  const seen = new Set();
  const out = [];
  const ordered = [...list].sort((a, b) => (a.group === 'model' ? 1 : 0) - (b.group === 'model' ? 1 : 0));
  const stable = value => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
    return value;
  };
  for (const it of ordered) {
    if ((it.modelSourceResolution || it.modelSourceDeclaration) && !it.issueKey) it.issueKey = issueIdentity(it);
    // Keep complete quotes, all owners and unresolved declarations. Equal
    // prefixes are not evidence of equal source ranges or equal judgments.
    const geometry = [it.paragraphIndex ?? null, it.footnoteIndex ?? null, it.endnoteIndex ?? null,
      it.sourceXmlNodeId ?? it.anchor?.sourceXmlNodeId ?? null,
      it.sourcePackageSha256 ?? it.anchor?.sourcePackageSha256 ?? null,
      it.anchor?.start ?? it.offset ?? it.autoFix?.offset ?? null, it.anchor?.end ?? null];
    const hasRange = geometry[5] !== null && geometry[6] !== null;
    const key = (it.modelSourceResolution || it.modelSourceDeclaration) ? it.issueKey : JSON.stringify([it.ruleId, geometry, String(it.quote || ''),
      it.title || '', it.detail || '', it.fix || '', it.proposed || '', it.severity || '',
      hasRange ? null : it.group, stable(it.modelSourceDeclaration || null),
      stable(it.modelSourceResolution || null)]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function countBy(arr, fn) {
  const m = {};
  for (const x of arr) {
    const k = fn(x) || '其他';
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

/** 生成 Markdown 审校报告 */
export function buildReport(result, doc, context = {}) {
  const { meta = {}, summary = {}, issues = [] } = result;
  const verification = (context.purpose || result.purpose) === 'verification';
  const stats = doc?.stats || {};
  const decisions = result.human?.decisions || {};
  const decisionOf = key => Object.hasOwn(decisions, key) ? decisions[key] : null;
  const actions = { accept: '采纳', reject: '不采纳', unsure: '存疑', '': '清除处置' };
  const L = [];
  L.push(`# 《东方学刊》一审审校报告`);
  L.push('');
  L.push(`- 稿件：${meta.title || '（未识别标题）'}`);
  L.push(`- 栏目：${meta.column || '（未标注）'}　字数：约 ${meta.chars} 字`);
  L.push(`- 生成时间：${new Date(result.generatedAt).toLocaleString('zh-CN')}`);
  L.push(`- 审阅模型：${result.model}`);
  L.push(`- 稿件统计：段落 ${stats.paragraphs ?? '未知'}，脚注 ${stats.footnotes ?? '未知'}，批注 ${stats.comments ?? '未知'}，修订 ${stats.insertions ?? '未知'} 插入 / ${stats.deletions ?? '未知'} 删除`);
  if (context.exportId) L.push(`- 导出身份：${context.exportId}`);
  if (context.reviewRunId || result.reviewRunId) L.push(`- 审阅运行：${context.reviewRunId || result.reviewRunId}`);
  if (context.resultVersionId || result.sourceBinding?.versionId) L.push(`- 审阅版本：${context.resultVersionId || result.sourceBinding.versionId}`);
  if (context.workVersion?.id) L.push(`- 导出工作版本：${context.workVersion.id}`);
  if (context.workVersion?.sha256) L.push(`- 工作稿 SHA256：${context.workVersion.sha256}`);
  if (context.exportedAt) L.push(`- 导出时间：${context.exportedAt}`);
  const coverage = result.reviewCoverage || buildReviewCoverage({ result,
    options: result.reviewOptions || null, purpose: context.purpose || result.purpose,
    reviewedVersionId: context.resultVersionId || result.sourceBinding?.versionId || null,
    currentWorkVersionId: context.workVersion?.id || null });
  const statusLabels = { completed: '所选步骤已结束', partial: '仍有步骤或已知范围未完成',
    failed: '未完成', disabled: '未启用', unavailable: '未能执行', unknown: '执行记录不足，待核对' };
  L.push(`- 审阅执行状态：${statusLabels[coverage.executionStatus] || statusLabels.unknown}（不表示全文覆盖或内容质量通过）`);
  for (const [key, label] of [['rules','规则检查'],['model','模型深度审阅'],['recheck','模型复核'],['context','全局上下文'],['cases','历史批注参考'],['consistency','一致性终检']]) {
    const state = coverage.steps?.[key];
    L.push(`- ${label}：${statusLabels[state?.status] || statusLabels.unknown}${state?.reason ? `；${state.reason}` : ''}`);
  }
  L.push(`- 模型全文覆盖：${coverage.fullTextCoverage === 'not_requested' ? '本次未选择' : coverage.fullTextCoverage === 'complete' && coverage.sourceCoverage?.status === 'complete' ? '已解析的正文、表格、脚注和尾注范围均有完整送审记录；内容质量仍待确认' : coverage.fullTextCoverage === 'partial' ? '已有明确缺口，须补审或人工核对' : '尚无完整来源范围证明，不能宣称全文已审'}`);
  if(coverage.sourceCoverage){const s=coverage.sourceCoverage;
    L.push(`- 原始来源字符范围：${s.totals.coveredUtf16}/${s.totals.expectedUtf16} UTF-16 单元已覆盖；另 ${s.totals.pendingUtf16} 待补审`);
    L.push(`- 主审核任务：${s.totals.completedTasks}/${s.totals.expectedTasks} 已确认；来源计划 SHA256：${s.manifestSha256}`);
  }
  L.push('- 内容质量：仍待独立确认；模型自证与人工采纳记录不直接作为质量通过证据。');
  if(result.execution?.requests?.physicalSendCount!=null){
    const requests=result.execution.requests,plan=result.execution.plan;
    L.push(`- 本运行实际模型请求：${requests.physicalSendCount} 次；未知用量请求：${requests.unknownUsageAttempts??'未核对'} 次`);
    if(requests.usageTotals&&requests.knownFieldCounts){
      const fields=[['input_tokens','输入'],['output_tokens','输出'],['cached_tokens','缓存命中（输入的子集）']];
      for(const[key,label]of fields){const unknown=Math.max(0,requests.physicalSendCount-(requests.knownFieldCounts[key]||0));
        L.push(`- ${label}用量：已确认合计 ${requests.usageTotals[key]??0} token；另 ${unknown} 次该字段未确认`);}
    }
    if(plan)L.push(`- 保存的审阅主任务：${plan.completed}/${plan.total} 已完成；含子项的 ${plan.reused} 个单元复用历史输出；未完成与来源缺口仍单独登记`);
  }
  if (coverage.currentWorkChanged || context.resultVersionId && context.workVersion?.id && context.resultVersionId !== context.workVersion.id) {
    L.push('- 当前稿已修改：以下规则分和审阅结论来自送审版本，须重新审阅当前稿。');
  }
  if (result.sourceBinding?.verified === false) L.push(`- 来源身份：尚未验证（${result.sourceBinding.reason || '缺少来源证明'}），范围须重新核对`);
  if (verification) L.push('- 用途：流程验证用途；不形成稿件内容质量结论');
  if (context.purpose === 'verification' && coverage.purpose === 'editorial') {
    L.push('- 原审阅记录用途：编辑审阅；本次导出单独标记为流程验证，原记录用途未改。');
  }
  L.push('- 人工处置记录行为与意见，不直接作为建议正确或错误标签。');
  L.push('');
  // Legacy rule thresholds remain available as a sorting reference.
  if (result.verdict && !verification) {
    const v = result.verdict;
    L.push('## 〇、规则参考');
    L.push('');
    L.push(`规则命中加权分 **${v.score}**${v.per1k !== null && v.per1k !== undefined ? `（每千字 ${v.per1k} 分）` : ''}。低分不表示稿件合格。`);
    L.push('');
    if (v.basis) L.push(`- 参考依据：${v.basis}`);
    L.push(`> 阈值 ${JSON.stringify(VERDICT_THRESHOLDS)}，由语料中「已过审（发排版）」89 份的分数分布标定。`);
    L.push('> 该分数用于排序与提示，不是独立质量结论。');
    L.push('');
  }
  L.push(`## 一、问题总览`);
  L.push('');
  L.push(`共发现 **${summary.total}** 条问题：规则引擎 ${summary.ruleBased} 条，模型语义审阅 ${summary.modelBased} 条。`);
  L.push('');
  L.push(`| 类别 | 数量 |`);
  L.push(`| --- | --- |`);
  for (const [k, v] of Object.entries(summary.byCategory || {}).sort((a, b) => b[1] - a[1])) {
    L.push(`| ${k} | ${v} |`);
  }
  L.push('');
  L.push(`| 严重度 | 数量 |`);
  L.push(`| --- | --- |`);
  for (const [k, v] of Object.entries(summary.bySeverity || {})) L.push(`| ${k} | ${v} |`);
  L.push('');

  const groups = [
    ['format', '二、格式体例问题（规则引擎）'],
    ['language', '三、语言与词汇问题（规则引擎）'],
    ['citation', '四、引文与注释问题（规则引擎）'],
    ['model', '五、模型语义审阅发现'],
  ];
  const knownGroups = new Set(groups.map(([g]) => g));
  for (const g of new Set(issues.filter(it => !knownGroups.has(it.group)).map(it => it.group))) groups.push([g, '其他来源问题']);
  // 复核结论按 issueKey 取，键的构造必须与前端 issueKey() 完全一致，
  // 否则报告里的复核结论和界面上的对不上。
  const rc = result.recheck?.byKey || null;
  let n = 0;
  for (const [g, heading] of groups) {
    const items = issues.filter((i) => i.group === g);
    if (!items.length) continue;
    L.push(`## ${heading}（${items.length} 条）`);
    L.push('');
    for (const it of items) {
      n += 1;
      L.push(`### ${n}. [${it.severity}] ${it.title}`);
      L.push('');
      const key = issueIdentity(it);
      L.push(`- 问题身份：${key}`);
      L.push(`- 审阅位置：${it.location || '未声明'}`);
      const status = it.modelSourceResolution?.status || it.anchor?.resolutionStatus || null;
      const unresolved = it.needsRelocation || ['ambiguous', 'unmapped', 'unresolved'].includes(status) || result.sourceBinding?.verified === false;
      if (unresolved) L.push(`- 当前范围：待重新定位（${it.relocationReason || it.modelSourceResolution?.reasonCode || status || '来源未验证'}），不得据此自动修改`);
      else {
        const anchors = Array.isArray(it.anchors) ? it.anchors : it.anchor ? [it.anchor] : [];
        if (!anchors.length) L.push('- 当前范围：未提供可核对范围');
        for (const a of anchors) L.push(`- 当前范围：${a.target}:${a.index ?? '—'} [${a.start ?? '—'}, ${a.end ?? '—'}) UTF-16；精度 ${a.precision || '未声明'}；文字 ${JSON.stringify(a.text ?? '')}`);
      }
      if (it.modelSourceDeclaration) L.push(`- 来源声明：${JSON.stringify(it.modelSourceDeclaration)}`);
      const humanDecision = decisionOf(key);
      if (humanDecision) L.push(`- 当前人工处置：${actions[humanDecision.action] || humanDecision.action || '未声明'}${humanDecision.opinion ? `；${humanDecision.opinion}` : ''}`);
      L.push(`- 规则：${it.ruleId}　依据：${it.basis || '—'}`);
      if (it.quote) L.push(`- 原文：${it.quote.replace(/\n/g, ' ')}`);
      if (it.detail) L.push(`- 问题：${it.detail}`);
      if (it.fix) L.push(`- 建议：${it.fix}`);
      if (it.message) L.push(`- 具体判定：${it.message}`);
      if (it.suggestion) L.push(`- 具体改法：${it.suggestion}`);
      // 模型复核结论（目标点 13）
      if (rc) {
        const r = typeof rc.get === 'function' ? rc.get(key) : Object.hasOwn(rc, key) ? rc[key] : null;
        if (r) {
          L.push(`- **模型复核：${verdictLabel(r.verdict)}** —— ${r.reason || '（未给理由）'}`);
          if (r.better) L.push(`- 模型给的更好改法：${r.better}`);
        } else {
          L.push(`- 模型复核：未复核（无可核对的改法文本）`);
        }
      }
      L.push('');
    }
  }
  const modelErrors = result.modelResult?.errors || result.modelErrors || [];
  if (modelErrors.length) {
    L.push('## 模型审阅未完成的部分', '');
    L.push(`本次有 ${modelErrors.length} 个窗口未完成，以下部分须人工补审，不能视为已通过检查。`, '');
    for (const e of modelErrors) {
      const paragraphs = (e.paragraphs || []).map((i) => Number(i) + 1).join('、');
      L.push(`- 窗口 ${e.window ?? '—'}${paragraphs ? `（正文第 ${paragraphs} 段）` : ''}：${e.message}`);
    }
    L.push('');
  }
  if (result.human?.marks?.length) {
    L.push('## 当前人工圈画', '');
    for (const mark of result.human.marks) L.push(`- ${mark.id || '未命名'}：${mark.target}:${mark.index} [${mark.start}, ${mark.end})；原文 ${JSON.stringify(mark.quote || mark.text || '')}${mark.note ? `；${mark.note}` : ''}`);
    L.push('');
  }
  // 复核总览
  if (result.recheck?.stats) {
    const s = result.recheck.stats;
    L.push(`## 六、模型复核总览`);
    L.push('');
    L.push(`对每条「建议修改」再次调用模型，判断该建议是否成立（这是**复核**，不是重新审稿）。`);
    L.push('');
    L.push(`| 复核结论 | 条数 |`);
    L.push(`| --- | ---: |`);
    L.push(`| 同意 | ${s.agree || 0} |`);
    L.push(`| 不同意 | ${s.disagree || 0} |`);
    L.push(`| 拿不准 | ${(s.unsure || 0) - (s.noReply || 0)} |`);
    L.push(`| 模型未回结论 | ${s.noReply || 0} |`);
    L.push(`| 未复核（无可核对改法） | ${s.skipped || 0} |`);
    L.push('');
    L.push(`共发出 ${s.batches || 0} 批请求，覆盖 ${s.checked || 0} 条。`);
    if (result.recheck.errors?.length) {
      L.push('');
      L.push(`⚠️ 有 ${result.recheck.errors.length} 批复核失败：`);
      for (const e of result.recheck.errors.slice(0, 5)) L.push(`- 第 ${e.batch} 批：${e.message}`);
    }
    L.push('');
    L.push('> 「不同意」表示模型认为该条建议不成立或改法有问题，**须人工重点确认**；');
    L.push('> 「拿不准」表示模型未给出明确判断，按普通条目处理。');
    L.push('');
  }
  L.push(`## ${result.recheck?.stats ? '七' : '六'}、人工复核提示`);
  L.push('');
  L.push('1. 规则引擎命中的问题建议逐条确认后再改；标点为「中」以下的条目可批量处理。');
  L.push('2. 模型审阅结果须由责任编辑复核，特别是事实核查与政治表述类条目。');
  L.push('3. 引文页码、数据来源、经典著作版本这三类问题须回原始文献核对，不可仅凭模型判断。');
  L.push('4. 作者简介、基金项目等信息缺失时，需向作者索取。');
  L.push('');
  L.push('## 问题身份与来源附录', '', '```json');
  L.push(JSON.stringify(issues.map(it => ({ issueKey: issueIdentity(it),
    modelSourceDeclaration: it.modelSourceDeclaration || null, modelSourceResolution: it.modelSourceResolution || null,
    anchors: Array.isArray(it.anchors) ? it.anchors : it.anchor ? [it.anchor] : [],
    needsRelocation: !!it.needsRelocation, humanDecision: decisionOf(issueIdentity(it)) })), null, 2));
  L.push('```', '');
  return L.join('\n');
}
