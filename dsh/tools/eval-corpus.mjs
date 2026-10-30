/**
 * 语料评测台：对一集稿件算出**可跨轮对比**的指标，落盘成 JSON 供 diff。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 前几轮的每一处修改都是在同一批《东方学刊》发排定稿上
 * 调参**并**验证的 —— 没有留出集。这是过拟合的标准姿势：
 * 数字一直在变好，但没人知道换个分布还成不成立。
 *
 * ⚠️ 那批稿件的规模一度被记成「103 份」，**这个数字是错的**。
 * 它来自在整条路径上做子串匹配的旧分类器：把 14 个**文件名里带「发排」**
 * 的责编版在审稿也扫进了发排集。真正的发排定稿是 **89 篇**
 * （8 个发排版目录）。凡引用「103 份发排定稿」的注释都应改按 89 理解。
 *
 * 这个脚本的作用是**造一把独立的尺子**：
 *   · 三集严格分开，指标分别算、分别记录，任何修改必须两侧都不退化
 *   · 只跑**规则引擎**（`deterministicReview`），不调模型 ——
 *     模型输出同稿多次运行有 ±3% 抖动，做不了回归基线
 *   · 输出纯 JSON，跨轮 diff 靠它，不靠人眼
 *
 * ── 三集怎么分 ──────────────────────────────────────────────────
 * 语料 632 份按目录天然分阶段，但**不能简单按「发排 vs 责编」分**：
 * 实测 `07-2025年春\2025春季刊发排版\01-xxx.docx` 与
 * `07-2025年春\2025春季刊责编版\01-xxx.docx` 是**同一篇文章**的
 * 两个生产阶段（文件名成对出现）。拿责编版当留出集，仍然是同一批作者、
 * 同一批选题、同一套体例 —— 分布没变，等于自己考自己。
 *
 * 所以分三集，独立度递增：
 *   TUNE  「××刊发排版」            —— 前几轮调参用的，**已污染**
 *   HOLDA 「××刊责编版 / 毛条样」    —— 同刊异阶段，文章重叠，弱独立
 *   HOLDB 「××一审文件，带痕迹版」   —— 一审阶段、带修订痕迹、
 *                                     2024 年冬（最早一期），**真独立**
 *
 * 用法：
 *   node tools/eval-corpus.mjs --set tune
 *   node tools/eval-corpus.mjs --set all --out tools/.eval-baseline.json
 *   node tools/eval-corpus.mjs --set holdb --compare tools/.eval-baseline.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { deterministicReview, detectMeta, rolesOf } from '../src/review.js';
import { attachAnchors } from '../src/anchors.js';
import { judge, DEFAULT_THRESHOLDS } from '../src/verdict.js';
import { ACADEMIC_ROOT } from './paths.mjs';

const ROOT = ACADEMIC_ROOT;
const args = process.argv.slice(2);
const getArg = (k, d = null) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const SET = getArg('--set', 'all');
const OUT = getArg('--out', null);
const COMPARE = getArg('--compare', null);

/** 递归收集 docx（跳过 Word 锁文件与临时文件） */
function walk(dir, acc = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    /**
     * 跳过自己造出来的临时夹具目录。
     * `tools/.adv` 是 `tools/adversarial.mjs` 生成的 15 个畸形稿件，
     * 不排除的话会被当成语料走一遍（未归类文件从 6 涨到 21），
     * 污染「未归类」这个计数指标 —— 语料集必须只含真实稿件。
     *
     * ⚠️ 过滤用 `/\.docx?$/i`（`x?` 让 x 可选），会**连 `.doc` 一起收**。
     * 语料里 632 个 `.docx` 全部可解析；另有 **27 个真正的 `.doc`**
     * （OLE2 复合文档，扩展名就是 `.doc`）被解析器正确拒绝，
     * 提示「这是旧版 Word 格式…请另存为 .docx 后重新导入」。
     * 所以输出里的「未能解析 27」**不是解析 bug**，是正确拒绝旧格式 ——
     * 不要把它当成待修的问题去追。
     * 只想统计 `.docx` 时用 `/\.docx$/i`（`tools/measure-window-delta.mjs`
     * 与 `tools/measure-bold-headings.mjs` 就是这么过滤的，得 632 篇）。
     */
    if (e.isDirectory()) {
      if (e.name === '.adv' || e.name === 'node_modules' || e.name.startsWith('.git')) continue;
      walk(p, acc);
    } else if (/\.docx?$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);  }
  return acc;
}

/**
 * 分集。判据是**路径**，不看文件内容 —— 目录结构就是编辑部的结论。
 *
 * ⚠️ 必须先剥掉顶层目录名 `发给皓天的一审文件`。
 * 这个顶层目录名里就含「一审文件」四个字，直接用 `/一审文件/` 匹配路径
 * 会把**全部 632 篇**都归进 HOLDB —— 第一版就是这么错的，
 * 三集里 TUNE/HOLDA 都是 0 篇、HOLDB 632 篇。
 * 真正的一审层是子目录 `06-2024年冬\一审文件，带痕迹版`。
 *
 * ── 第三版（现行）：加「整期留出」规则，并改用**内容指纹**验证重叠 ──
 * 第二版按最内层阶段目录判定后，`06-2024年冬\一审文件，发排版`（9 篇）归 TUNE、
 * `06-2024年冬\一审文件，带痕迹版`（64 篇）归 HOLDB。可这是**同一期**的
 * 两个阶段 —— 按内容指纹实测（`tools/check-holdout-overlap.mjs`）：
 *   · TUNE ∩ HOLDB = **48 对**，全部来自那 9 篇发排版与 64 篇带痕迹版之间，
 *     同文不同修订阶段（12-gram Jaccard 最高 1.00）；
 *   · 其余 **81 篇 TUNE 与 HOLDB 零重叠**。
 * 也就是说留出集被这 9 篇污染了 —— 调参时见过的文章又出现在留出集里。
 * 因此加一条**优先级最高**的规则：`06-2024年冬` **整期留出**，不参与调参。
 * 修正后 TUNE 80 / HOLDA 506 / HOLDB 73，内容指纹实测重叠 **0 对**。
 *
 * ⚠️ 教训：判断「留出集是否独立」**不能靠文件名**。语料里同一篇文章在不同
 * 阶段的名字完全对不上（`1专题01-瑙姆金论文翻译.docx` vs
 * `20241012瑙姆金论文翻译2024学刊冬季刊专题1【20211022一审】.docx`），
 * 按文件名比对会得出「零重叠」的**假结论** —— 本文件的第一版就这么错过。
 *
 * 阶段判据（只看目录名，由内向外找最内层阶段目录）：
 *   含「带痕迹」            → HOLDB  一审带痕迹版，与调参集零重叠
 *   含「发排」              → TUNE   发排定稿（调参语料）
 *   含「责编版|毛条样|编务版」→ HOLDA  在审阶段（与 TUNE 同期文章，不独立）
 */
/** 整期留出的期号目录（优先级最高，见上方说明） */
const HOLDOUT_ISSUE = /^06-2024年冬/;

const STAGE_DIRS = [
  { re: /带痕迹/, set: 'HOLDB' },
  { re: /发排/, set: 'TUNE' },
  { re: /责编版|毛条样|编务版/, set: 'HOLDA' },
];
function classify(p) {
  const rel = path.relative(ROOT, p).replace(/^发给皓天的一审文件\\/, '');
  const segs = rel.split(path.sep).slice(0, -1);   // 去掉文件名，只看目录
  // ① 整期留出：这一期的任何阶段都不进调参集
  if (segs.some((s) => HOLDOUT_ISSUE.test(s))) return 'HOLDB';
  // ② 否则按最内层的阶段目录
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    for (const s of STAGE_DIRS) {
      if (s.re.test(segs[i])) return s.set;
    }
  }
  return null;
}

const all = walk(ROOT);
const buckets = { TUNE: [], HOLDA: [], HOLDB: [] };
let unclassified = 0;
for (const p of all) {
  const c = classify(p);
  if (c) buckets[c].push(p);
  else unclassified += 1;
}

/**
 * 标题分级器的异常判据 —— 与 `tools/heading-audit-all.mjs` **同一套**。
 * 两处各写一套会让「异常数」这个指标失去可比性，所以这里照抄那份的实现。
 */
const looksLikeProseLine = (t) => {
  if (t.length > 45) return '过长';
  if (/[。！；]$/.test(t) && t.length > 18) return '句末标点';
  return null;
};
/** 像署名行：汉字之间夹空格（本刊署名写法 `罗  楠`），不认「2–4 字纯汉字」 */
const looksLikeAuthor = (t) => {
  if (!/^[\u4e00-\u9fa5]+([\s\u3000]+[\u4e00-\u9fa5]+)+$/.test(t)) return null;
  const s = t.replace(/[\s\u3000]+/g, '');
  if (s.length < 2 || s.length > 5) return null;
  if (/^(引言|结语|余论|结论|导论|绪论|摘要|注释|参考文献|后记|致谢)$/.test(s)) return null;
  return '像人名行';
};
const looksLikeCaption = (t) => (/^\s*(表|图|附表|附图)\s*[0-9一二三四五六七八九十]/.test(t) ? '像题注' : null);

/** 拉丁字母占比，用于区分中/英文稿 */
const latinRatio = (s) => {
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  return s.length ? letters / s.length : 0;
};

/**
 * 「标题形态候选」：正文里有没有**本该是标题却没被判成标题**的段落。
 *
 * 这是「零标题是否算异常」的判据。原来只要 `headings === 0` 就记异常，
 * 但实测**零标题经常是正确的**：
 *   · `刘洋@【现场】.docx` 等 9 份圆桌实录 —— 通篇连续发言，没有章节
 *   · 3 段的反馈便条 —— 不是稿件
 * 把这些算成异常，会让人去追根本不存在的 bug（第一版基线上
 * HOLDB「零标题 16.4%」里有 9/12 是这类）。
 *
 * 真正该抓的漏检是：**文档里明明有标题形态的段落，却一条都没识别出来**。
 */
function headingFormCandidates(doc, level, roles) {
  const out = [];
  const numRe = /^[（(]?[一二三四五六七八九十百]+[、．.)）]|^\d+[．.]\s*\S|^第[一二三四五六七八九十百\d]+[节章部分篇]/;
  /** 前置区角色：篇名/署名/摘要/关键词/元信息 —— 这些段落本来就不是章节标题 */
  const FRONT = new Set(['title', 'author', 'abstract', 'keywords', 'meta']);
  for (let i = 0; i < doc.paragraphs.length; i += 1) {
    if (level[i]) continue;
    /**
     * ⚠️ 必须排除前置区。不排除的话，9 份 `@【现场】` 圆桌实录会被误报成
     * 「零标题但有候选」—— 它们唯一的候选就是**段 0 的篇名本身**
     * （`刘洋：区域区域告诉我，涉外法治是为什么？`，加粗短行）。
     * 篇名被当成「漏检的标题」，是纯误报。
     */
    if (roles && FRONT.has(roles[i])) continue;
    const p = doc.paragraphs[i];
    const t = (p.text || '').trim();
    if (!t || t.length > 40) continue;
    if (p.inTable) continue;
    if (numRe.test(t)) { out.push({ i, why: '编号形态', t: t.slice(0, 30) }); continue; }
    // 加粗 + 短行 + 不像行文 —— 中英文学术稿最常见的标题写法
    const bold = p.format?.bold === true;
    if (bold && !looksLikeProseLine(t) && !looksLikeAuthor(t) && !looksLikeCaption(t)) {
      out.push({ i, why: '加粗短行', t: t.slice(0, 30) });
    }
  }
  return out;
}

function evalFile(file) {
  const buf = fs.readFileSync(file);
  const doc = parseDocxBuffer(buf, path.basename(file));
  const det = deterministicReview(doc);
  const result = { issues: det.issues };
  const anchorStats = attachAnchors(result, doc);
  const issues = result.issues;
  const meta = detectMeta(doc, path.basename(file));
  const cls = rolesOf(doc);

  const heads = [];
  const levelArr = [];
  for (let i = 0; i < doc.paragraphs.length; i += 1) {
    const lv = doc.paragraphs[i]._headingLevel;
    levelArr[i] = lv || 0;
    if (lv) heads.push({ i, level: lv, source: doc.paragraphs[i]._headingSource, text: (doc.paragraphs[i].text || '').trim() });
  }
  const levels = heads.map((h) => h.level);
  const anomalies = [];
  /**
   * 零标题：只有**存在标题形态候选**时才算异常。
   * 见 `headingFormCandidates` 上方说明 —— 圆桌实录、短便条本来就无标题。
   */
  const cands = heads.length === 0 ? headingFormCandidates(doc, levelArr, cls.roles) : [];
  if (heads.length === 0 && cands.length > 0) anomalies.push('零标题但有候选');
  if (heads.length > 1) {
    const uniq = [...new Set(levels)];
    if (uniq.length === 1) {
      if (uniq[0] > 1) anomalies.push('层级全平>1');
      else if (heads.length > 6) anomalies.push('层级全平且过多');
    }
    for (let i = 1; i < heads.length; i += 1) {
      if (levels[i] - levels[i - 1] > 1) { anomalies.push('层级跳级'); break; }
    }
    if (Math.min(...levels) > 1) anomalies.push('无一级标题');
  }
  for (const h of heads) {
    const r = looksLikeProseLine(h.text) || looksLikeAuthor(h.text) || looksLikeCaption(h.text);
    if (r) { anomalies.push('标题' + r); break; }
  }
  /**
   * 前置区判据必须**分文种**。
   *
   * 原来一律用「篇名 > 40 字算过长」「以 ？ 结尾算像正文」，那是中文口径：
   *   · 英文标题 62 字符（`Non-West Model: Is There Such a Thing as a
   *     Civilization State?`）**完全正常**，却被记成「篇名过长 + 像正文」
   *   · 中文疑问式标题（`刘洋：区域区域告诉我，涉外法治是为什么？`）
   *     以问号结尾也是**正常标题**，不是正文
   * 第一版基线上 HOLDB 的 25 处篇名异常里，多数是这两类误报。
   */
  const title = String(meta.title || '');
  const isLatin = latinRatio(title) > 0.5;
  const titleMax = isLatin ? 110 : 40;
  if (title.length > titleMax) anomalies.push(isLatin ? '篇名过长(英)' : '篇名过长');
  // 只有句号结尾才像正文；问号/叹号是合法的标题语气
  if (/。$/.test(title)) anomalies.push('篇名以句号结尾');

  const chars = doc.stats?.chars || 0;
  const v = judge(issues, { thresholds: DEFAULT_THRESHOLDS, chars });
  return {
    file: path.relative(ROOT, file),
    chars,
    paras: doc.paragraphs.length,
    footnotes: doc.footnotes.length,
    revisions: doc.revisions?.length || 0,
    comments: doc.comments?.length || 0,
    tables: doc.tables?.length || 0,
    title: title.slice(0, 60),
    titleLen: title.length,
    author: String(meta.author || '').slice(0, 30),
    headings: heads.length,
    headLevels: levels,
    headSources: [...new Set(heads.map((h) => h.source))],
    headingCandidates: cands.length,
    headingCandidateSamples: cands.slice(0, 3),
    anomalies,
    issues: issues.length,
    per1k: chars > 0 ? Math.round((issues.length / chars) * 1000 * 100) / 100 : null,
    bySeverity: det.summary.bySeverity,
    byGroup: det.summary.byGroup,
    anchors: anchorStats,
    verdict: v.verdict,
    score: v.score,
    scorePer1k: v.per1k,
  };
}

function aggregate(rows, parseFailed) {
  const n = rows.length;
  const sum = (f) => rows.reduce((a, r) => a + (f(r) || 0), 0);
  const cnt = (f) => rows.filter(f).length;
  const pct = (c) => (n ? Math.round((c / n) * 1000) / 10 : 0);
  const dist = (f) => {
    const o = {};
    for (const r of rows) { const k = f(r); if (k !== undefined && k !== null) o[k] = (o[k] || 0) + 1; }
    return o;
  };
  const q = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const issueCounts = rows.map((r) => r.issues);
  const anchorSum = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.anchors || {})) anchorSum[k] = (anchorSum[k] || 0) + v;
  const anom = {};
  for (const r of rows) for (const a of r.anomalies) anom[a] = (anom[a] || 0) + 1;
  const titleLens = rows.map((r) => r.titleLen).filter((x) => x > 0);
  return {
    files: n,
    parseFailed,
    charsTotal: sum((r) => r.chars),
    headingsTotal: sum((r) => r.headings),
    issuesTotal: sum((r) => r.issues),
    issuesPerFile: n ? Math.round((sum((r) => r.issues) / n) * 100) / 100 : null,
    issuesPer1k: sum((r) => r.chars) ? Math.round((sum((r) => r.issues) / sum((r) => r.chars)) * 1000 * 100) / 100 : null,
    per1kP50: q(rows.map((r) => r.per1k).filter((x) => x !== null), 0.5),
    per1kP90: q(rows.map((r) => r.per1k).filter((x) => x !== null), 0.9),
    severity: {
      高: sum((r) => r.bySeverity?.高),
      中: sum((r) => r.bySeverity?.中),
      低: sum((r) => r.bySeverity?.低),
    },
    hiSeverityPerFile: n ? Math.round((sum((r) => r.bySeverity?.高) / n) * 100) / 100 : null,
    group: {
      format: sum((r) => r.byGroup?.format),
      language: sum((r) => r.byGroup?.language),
      citation: sum((r) => r.byGroup?.citation),
    },
    verdicts: dist((r) => r.verdict),
    verdictFailPct: pct(cnt((r) => r.verdict === '不合格')),
    verdictPassPct: pct(cnt((r) => r.verdict === '合格' || r.verdict === '基本合格')),
    scoreP50: q(rows.map((r) => r.score), 0.5),
    scoreP75: q(rows.map((r) => r.score), 0.75),
    scoreP90: q(rows.map((r) => r.score), 0.9),
    anchors: anchorSum,
    anchorNonePct: anchorSum.issues ? Math.round((anchorSum.none / anchorSum.issues) * 1000) / 10 : 0,
    anchorParagraphPct: anchorSum.issues ? Math.round((anchorSum.paragraph / anchorSum.issues) * 1000) / 10 : 0,
    anomalies: anom,
    zeroHeadingPct: pct(cnt((r) => r.headings === 0)),
    zeroHeadingButCandidatePct: pct(cnt((r) => r.anomalies.includes('零标题但有候选'))),
    filesWithCandidates: cnt((r) => r.headingCandidates > 0),
    candidateParas: sum((r) => r.headingCandidates),
    anomalyFreePct: pct(cnt((r) => r.anomalies.length === 0)),
    titleLenP50: q(titleLens, 0.5),
    titleLenP90: q(titleLens, 0.9),
    revisionsTotal: sum((r) => r.revisions),
    filesWithRevisions: cnt((r) => r.revisions > 0),
    filesWithComments: cnt((r) => r.comments > 0),
  };
}

const want = SET === 'all' ? ['TUNE', 'HOLDA', 'HOLDB'] : [SET.toUpperCase()];
const report = { generatedAt: new Date().toISOString(), sets: {}, unclassified };
const t0 = Date.now();
for (const name of want) {
  const files = buckets[name] || [];
  const rows = [];
  const failed = [];
  for (const f of files) {
    try { rows.push(evalFile(f)); }
    catch (e) { failed.push({ file: path.relative(ROOT, f), error: String(e.message).slice(0, 120) }); }
  }
  report.sets[name] = { agg: aggregate(rows, failed.length), failed, rows };
  const a = report.sets[name].agg;
  console.log(`\n═══ ${name} ═══  ${a.files} 篇（未能解析 ${a.parseFailed}）`);
  console.log(`  标题合计 ${a.headingsTotal}｜零标题 ${a.zeroHeadingPct}%｜无异常 ${a.anomalyFreePct}%`);
  console.log(`  问题 ${a.issuesTotal} 条｜${a.issuesPerFile} 条/篇｜每千字 ${a.issuesPer1k}（P50 ${a.per1kP50} / P90 ${a.per1kP90}）`);
  console.log(`  高严重度 ${a.severity.高} 条｜${a.hiSeverityPerFile} 条/篇`);
  console.log(`  判定 合格 ${a.verdictPassPct}% / 不合格 ${a.verdictFailPct}%｜分 P50=${a.scoreP50} P75=${a.scoreP75} P90=${a.scoreP90}`);
  console.log(`  锚点 none ${a.anchorNonePct}%｜整段 ${a.anchorParagraphPct}%`);
  console.log(`  异常 ${JSON.stringify(a.anomalies)}`);
  console.log(`  带修订 ${a.filesWithRevisions} 篇｜带批注 ${a.filesWithComments} 篇`);
}
report.elapsedMs = Date.now() - t0;
console.log(`\n耗时 ${(report.elapsedMs / 1000).toFixed(1)}s｜未归类文件 ${unclassified} 个`);

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log('已写入 ' + OUT);
}

if (COMPARE && fs.existsSync(COMPARE)) {
  const base = JSON.parse(fs.readFileSync(COMPARE, 'utf8'));
  console.log('\n═══ 与基线对比（只看聚合指标）═══');
  const keys = ['files', 'headingsTotal', 'zeroHeadingPct', 'anomalyFreePct', 'issuesPerFile', 'issuesPer1k', 'per1kP50', 'hiSeverityPerFile', 'verdictFailPct', 'verdictPassPct', 'scoreP50', 'anchorNonePct', 'anchorParagraphPct'];
  for (const set of Object.keys(report.sets)) {
    const a = report.sets[set].agg; const b = base.sets?.[set]?.agg;
    if (!b) continue;
    console.log(`  [${set}]`);
    for (const k of keys) {
      const x = a[k]; const y = b[k];
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      const d = Math.round((x - y) * 100) / 100;
      const mark = d === 0 ? '  ' : d > 0 ? '↑ ' : '↓ ';
      if (d !== 0) console.log(`    ${mark}${k}: ${y} → ${x}  (${d > 0 ? '+' : ''}${d})`);
    }
  }
}
