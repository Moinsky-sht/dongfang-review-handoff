/**
 * 稿件合格性判定（目标点 10：区分合格/不合格）。
 *
 * 设计依据 —— 语料自带一个天然对照实验：
 *   632 份稿件按所在目录分成两层，
 *     · 「××刊发排版」89 份 —— 已经过审、进入排版；
 *     · 「××刊责编版」469 份 —— 仍在责编环节。
 *   两层的问题密度实测有**统计显著**差异（Welch t = −2.55，df = 130.3）：
 *     排版 17.9 条/篇  vs  责编 21.7 条/篇（低 17.5%）
 *   但「高严重度」条数**不显著**（t = −1.40）。
 *
 * 这个结果决定了本模块的形态：**做分级判定，不做二元分类器**。
 * 差异是真的，但重叠很大（sd 都在 13 左右），硬套「合格/不合格」会把
 * 大量合格稿判死。所以这里输出四档，并且**每条结论都带可核对的理由**，
 * 让编辑自己决定，而不是给一个假装权威的是/否。
 *
 * 另一条重要口径（避免误读历史批注）：
 *   「发排版」那批的批注密度只有 0.05 条/千字，责编版是 0.86 条/千字（t = −18.6），
 *   且有批注的比例 4% vs 80%。这**不是**「过审稿更干净」的证据 ——
 *   发排版版是**修订已接受、批注已清理**的版本，批注本来就被删掉了。
 *   所以历史批注密度**只能用于「理解编辑关注点」，不能当作稿件质量的度量**。
 */

import { loadFormatRules } from './scanner-format.js';

/** 四档判定 */
export const VERDICTS = {
  PASS: '合格',
  PASS_MINOR: '基本合格',
  REVISE: '需修改',
  FAIL: '不合格',
};

/** 严重度权重：判定分数用 */
const SEV_WEIGHT = { 高: 3, 中: 2, 低: 1 };

/**
 * 一票否决项。
 *
 * **这里是空的，而且是被数据逼空的**，过程值得记下来：
 * 最初把 FMT-001（构成要素缺失）设为一票否决 —— 理由听起来很硬：
 * 缺了作者/提要/关键词的稿子不该算「合格」。
 * 但实测发现 **已过审（发排版）的 89 篇里有 73 篇（82%）也会触发 FMT-001**。
 * 一个否决项如果把 82% 的已过审稿件都毙掉，它就不是否决项，是噪声。
 *
 * 原因也清楚：FMT-001 把「题目、作者、内容提要、关键词、简短引言、正文、作者简介」
 * 七个要素**打包成一条**，缺任何一个都报。而提要与作者简介在原始投稿里
 * 本来就常常没有（要靠编辑部补），这不是「稿件不合格」。
 *
 * 所以判定逻辑改为：**不看有没有触发某条规则，只看加权分**。
 * 阈值本身已经用已过审层的分布标定过了，不需要再加一票否决。
 * 保留这个 Set 是为了将来真有「一票否决」级的规则（如学术不端）时能挂上去。
 */
const BLOCKING_RULES = new Set();

/** 结构性缺陷：不否决，但会明显拉低判定 */
const STRUCTURAL_RULES = new Set([
  'FMT-036', // 缺作者简介
  'FMT-004', // 摘要与引言重复
  'CIT-001', // 引文无页码
  'CIT-012', // 西文文献缺页码
]);

/**
 * 计算判定分数。
 *
 * 分数越低越好。文档级问题（缺要素）比逐处问题更重：
 * 逐处问题是「改几处就好」，文档级问题是「整篇结构缺一块」。
 */
export function scoreIssues(issues) {
  let score = 0;
  const bySeverity = { 高: 0, 中: 0, 低: 0 };
  const byGroup = { format: 0, language: 0, citation: 0, model: 0 };
  const blocking = [];
  let docLevel = 0;

  for (const it of issues) {
    const sev = it.severity || '中';
    const w = SEV_WEIGHT[sev] ?? 2;
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;
    if (byGroup[it.group] !== undefined) byGroup[it.group] += 1;

    // 文档级问题按「一次算重些」，逐处问题按条计
    const isDoc = it.location === 'document';
    if (isDoc) docLevel += 1;
    const mult = isDoc ? 2 : 1;
    // 同类归并过的问题（occurrenceCount）代表全文 N 处，计入权重但设上限，
    // 避免一篇稿子因为同一个毛病重复几十次而被判死。
    const occMult = it.occurrenceCount ? Math.min(2, 1 + Math.log10(it.occurrenceCount)) : 1;
    score += w * mult * occMult;

    if (BLOCKING_RULES.has(it.ruleId)) blocking.push(it);
  }

  return { score: Math.round(score * 10) / 10, bySeverity, byGroup, blocking, docLevel };
}

/**
 * 分级阈值。
 *
 * 阈值**不是拍的**，是按「发排版（已过审）」那 89 份的分数分布定的。
 *
 * 标定过程里踩过一个坑，记在这里：最初用已过审层的 P75 当「合格」上限，
 * 结果全量 89.2% 被判「不合格」——因为这个阈值比全语料的中位数（45.6）
 * 还高，等于要求「比一半稿件都干净才算合格」。
 * 已过审层的分布（P50=35、P75=53.6、P90=82）与全语料分布重叠很大，
 * 说明**分数本身不足以把两层的个体分开**（这与 t 检验的结论一致：
 * 总问题数差异显著但 sd 都在 13 左右）。
 *
 * 所以改成：**「合格」锚在已过审层的中位数**（含义是「问题密度与典型已过审稿件相当」），
 * 「不合格」主要交给**一票否决项**（构成要素缺失）而不是分数，
 * 分数只在明显离群时才判「不合格」。
 */
export const DEFAULT_THRESHOLDS = { pass: 35, passMinor: 53.6, revise: 82 };

/**
 * 判定单篇稿件。
 *
 * @param {object[]} issues 该稿件全部问题（规则引擎 + 模型）
 * @param {object} [opts]
 * @param {{pass:number,passMinor:number,revise:number}} [opts.thresholds]
 * @param {number} [opts.chars] 全文字数，用于按千字归一
 * @returns {{verdict:string, score:number, reasons:string[], blocking:string[], metrics:object}}
 */
export function judge(issues, opts = {}) {
  const th = opts.thresholds || DEFAULT_THRESHOLDS;
  const chars = opts.chars || 0;
  /**
   * ⚠️ `issues` 必须是**规则引擎**的问题列表，不能混入模型问题。
   *
   * ── 为什么（这是一次实测出来的、代价很大的错）──────────────────
   * 原来的调用是 `judge(deduped, …)`，而 `deduped` 是「规则 + 模型」合并后的
   * 列表。阈值 `{pass:35, passMinor:53.6, revise:82}` 却是按**纯规则**的
   * 分布标定的（依据是语料自带的对照实验：「××刊发排版」已过审 vs
   * 「××刊责编版」在审，总问题数 Welch t = −2.55）。
   * 阈值与它实际度量的分布不是同一个 —— 于是**只要开模型，
   * 判定就恒为「不合格」**。
   *
   * 实测（`tools/eval-verdict-calib.mjs`，三层次各抽样、跨文件并发，
   * 25 篇全部跑通，累计 88.7 分钟模型时间）：
   *
   *   口径            TUNE(已发排,n=10) P50   HOLDA(在审,n=10) P50   Welch t
   *   ─────────────────────────────────────────────────────────────────────
   *   规则分                     19                    48            **−2.21** ← 有分离度
   *   规则+模型分               328                   386             **−0.47** ← 无分离度
   *
   *   判定分布：TUNE 不合格 10/10｜HOLDA 不合格 10/10｜HOLDB 不合格 5/5
   *   其中 TUNE 那 10 篇是**编辑已接受、已付印的发排定稿**。
   *
   * 也就是说：模型问题数**根本分不开「已过审」和「在审」两层**
   * （t=−0.47 远未达显著），把它算进判定等于给一个没有分离度的信号
   * 配一个看起来很科学的阈值。所以：
   *   · 判定分数**只用规则问题**（唯一有实测分离度、且阈值按其标定的总体）
   *   · 模型问题通过 `opts.modelIssues` 传入，**单独统计与呈现**，
   *     明确标注不参与判定 —— 不隐藏，但也不冒充判定依据
   */
  const s = scoreIssues(issues);
  // 按千字归一的分数，消除篇幅影响（长稿天然问题多）
  const per1k = chars > 0 ? Math.round((s.score / chars) * 1000 * 100) / 100 : null;

  const reasons = [];
  let verdict;

  if (s.blocking.length) {
    verdict = VERDICTS.FAIL;
    const missing = s.blocking.map((i) => (i.message || '').replace(/^稿件缺少规范要求的要素：/, ''));
    reasons.push(`构成要素缺失（${missing.join('；')}）——属一票否决项，补齐前不具备送审条件`);
  } else if (s.score <= th.pass) {
    verdict = VERDICTS.PASS;
    reasons.push(`问题加权分 ${s.score}，不高于已过审稿件的常见水平（阈值 ${th.pass}）`);
  } else if (s.score <= th.passMinor) {
    verdict = VERDICTS.PASS_MINOR;
    reasons.push(`问题加权分 ${s.score}，略高于已过审稿件常见水平，但无结构性缺陷`);
  } else if (s.score <= th.revise) {
    verdict = VERDICTS.REVISE;
    reasons.push(`问题加权分 ${s.score}，超过「基本合格」阈值 ${th.passMinor}，需修改后再审`);
  } else {
    verdict = VERDICTS.FAIL;
    reasons.push(`问题加权分 ${s.score}，超过 ${th.revise}，问题密度显著偏高`);
  }

  // 补充分项理由（只列最突出的两项，避免理由堆砌）
  const hi = s.bySeverity['高'] || 0;
  if (hi > 0) reasons.push(`高严重度问题 ${hi} 条`);
  const grpName = { format: '格式体例', language: '语言词汇', citation: '引文注释', model: '模型语义' };
  const top = Object.entries(s.byGroup).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (top.length) reasons.push(`问题集中在：${top.map(([k, v]) => `${grpName[k] || k} ${v} 条`).join('、')}`);
  if (s.docLevel > 0) reasons.push(`其中文档级问题 ${s.docLevel} 条（非逐处问题，需整篇处理）`);
  if (per1k !== null) reasons.push(`折合每千字 ${per1k} 分（全文约 ${chars} 字）`);

  /**
   * 模型问题单独成块。有 `count`/`score`/`per1k`，但**不参与上面的判定**，
   * 并在 `note` 里写明原因，避免读者误以为它是判定依据。
   */
  const modelIssues = Array.isArray(opts.modelIssues) ? opts.modelIssues : [];
  let model = null;
  if (modelIssues.length) {
    const ms = scoreIssues(modelIssues);
    model = {
      count: modelIssues.length,
      score: ms.score,
      per1k: chars > 0 ? Math.round((ms.score / chars) * 1000 * 100) / 100 : null,
      bySeverity: ms.bySeverity,
      /**
       * `note` 要同时讲清**两件独立的事**，否则读者会用错模型意见：
       *   ① 不参与判定 —— 它分不开「已过审」与「在审」两层（Welch t=−0.47）；
       *   ② 条目不可复现 —— 同稿跑 4 轮，模型问题数只差 9%~15%，
       *      但**具体条目几乎全换**：4 轮并集 434 条里出现在全部 4 轮的
       *      只有 9 条（2.1%）；即使只按「规则号+段落位置」比，也只有 4.2%；
       *      放宽到「只看用了哪条规则」也才 27.1%。
       * 所以模型给的是**一批待人工确认的线索**，不是一份确定的缺陷清单 ——
       * 重跑一次得到不同条目是**预期行为**，不是故障。
       * 实测脚本：`tools/model-stability.mjs` + `tools/model-stability-grain.mjs`。
       */
      note: '模型审阅意见，供参考，不参与合格判定 —— 实测模型问题数分不开「已过审」与「在审」两层（Welch t=−0.47），不满足判定所需的分离度；'
        + '且同稿重复运行条目不可复现（4 轮并集 434 条中仅 2.1% 在每轮都出现，按「规则号+段落位置」比也只有 4.2%），'
        + '属待人工确认的线索而非确定缺陷清单，重跑得到不同条目是预期行为',
    };
    reasons.push(`另有模型审阅意见 ${modelIssues.length} 条（供参考，不参与判定）`);
  }

  return {
    verdict,
    score: s.score,
    per1k,
    reasons,
    blocking: s.blocking.map((i) => i.ruleId),
    metrics: { bySeverity: s.bySeverity, byGroup: s.byGroup, docLevel: s.docLevel, total: issues.length },
    basis: '规则引擎问题加权分（阈值按「发排定稿 vs 责编在审」对照实验标定，Welch t=−2.21）',
    model,
  };
}

/**
 * 用「已过审（发排版）」语料标定阈值。
 *
 * 这是「吸收历史批阅」里**能站得住**的那一半：
 * 目录结构本身就是编辑部的结论，拿它当标签比拿批注数量当标签可靠得多
 * （批注在发排版版本里已被清理，见文件头说明）。
 *
 * @param {Array<{file:string,issues:object[],stats?:object}>} docs 全部稿件
 * @param {(file:string)=>boolean} isPassed 判断某篇是否属于「已过审」层
 */
export function calibrate(docs, isPassed) {
  const scores = [];
  for (const d of docs) {
    if (!isPassed(d.file)) continue;
    scores.push(scoreIssues(d.issues).score);
  }
  scores.sort((a, b) => a - b);
  const q = (p) => (scores.length ? scores[Math.min(scores.length - 1, Math.floor(scores.length * p))] : 0);
  return {
    n: scores.length,
    min: scores[0] ?? 0,
    p25: q(0.25),
    p50: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    max: scores.at(-1) ?? 0,
    // 「合格」锚在已过审层的**中位数**：含义是「问题密度与典型已过审稿件相当」。
    // 不能用 P75 —— 实测那样会让 89% 的稿件判不合格（见 DEFAULT_THRESHOLDS 注释）。
    suggested: { pass: q(0.5), passMinor: q(0.75), revise: q(0.9) },
  };
}

/** 从稿件路径判断它是否属于「已过审、已发排版」层 */
export function isTypesetPath(p) {
  // 注意：导出的 JSON 里路径是**双反斜杠**（`05-2024年秋\\2025秋季刊发排版\\x.docx`），
  // 直接按单反斜杠切分会切不开，之前这里返回 n=0 就是这个原因。
  const s = String(p).replace(/\\+/g, '/');
  return /发排版/.test(s.split('/')[1] || '');
}

/** 判定结果的中文说明，用于报告抬头 */
export function verdictLegend() {
  const cfg = loadFormatRules();
  return {
    basis: '语料自带对照实验：「××刊发排版」（已过审）89 份 vs「××刊责编版」（在审）469 份',
    separation: '总问题数 Welch t = −2.55（显著）；高严重度 t = −1.40（不显著）→ 因此做分级判定而非二元分类',
    caveat: '发排版版本是修订已接受、批注已清理的版本，其批注密度（0.05 条/千字）不能当作「稿件更干净」的证据',
    journal: cfg?.meta?.name || '',
  };
}
