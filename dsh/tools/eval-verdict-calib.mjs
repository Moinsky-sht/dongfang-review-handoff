/**
 * 判定口径的**决定性实验**：开模型后，分数还分得开「已过审」和「在审」两层吗？
 *
 * ── 为什么要做这个实验，而不是直接重标定阈值 ────────────────────
 * `verdict.js` 的阈值是按**纯规则引擎**的分布标定的，依据是一个真实存在的
 * 对照实验：「××刊发排版」（已过审）vs「××刊责编版」（在审），
 * 总问题数 Welch t = −2.55（显著）。
 *
 * 但 `judge(deduped, ...)` 拿到的是**规则 + 模型**合并后的列表。
 * 实测 6 篇采样（三层次各 2 篇）**全部判「不合格」**，分数 195–727，
 * 而阈值是 82；模型问题占 84–94%。
 *
 * 于是有两条路，必须先分清楚走哪条：
 *   (1) 模型问题**仍然**能分开两层 → 只是阈值标错了分布 → 在模型分布上重标定
 *   (2) 模型问题**分不开**两层（噪声） → 把它算进判定本身就没有依据 →
 *       判定应回到规则口径，模型问题另行呈现
 * 这个脚本就是去量 (1) 还是 (2)。**不先量就重标定，等于给一个
 * 没有分离度的信号配一个看起来很科学的阈值。**
 *
 * 产出：每层分数分布、规则口径与模型口径各自的 Welch t、以及按已过审层
 * 百分位给出的建议阈值。结果增量落盘，中断不丢。
 *
 * 用法：node tools/eval-verdict-calib.mjs [每层篇数] [并发数]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { fullReview } from '../src/review.js';
import { ACADEMIC_ROOT } from './paths.mjs';

const ROOT = ACADEMIC_ROOT;
const PER = Number(process.argv[2] || 10);
const CONC = Number(process.argv[3] || 3);
const CACHE = 'tools/.verdict-calib2.json';

function walk(dir, acc = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.docx?$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}
/**
 * 与 `tools/eval-corpus.mjs` **同一套**分类。
 *
 * ⚠️ 这里原本用「在整条路径上做子串匹配」的旧口径（`/一审文件/` 先判），
 * 有两个真实错误（见 eval-corpus.mjs 的详细说明）：
 *   · `06-2024年冬\一审文件，发排版`（发排定稿）被归进 HOLDB；
 *   · 文件名带「发排」的责编版在审稿被归进 TUNE。
 * 标定阈值时若把在审稿当已过审稿，分离度会被低估 —— 结论会失真。
 * 所以标定脚本必须跟评测台用同一个分类器，不能各写一套。
 *
 * ── 换分类器后**不需要重跑**（已实测确认）──
 * 标定样本是 25 篇（10 TUNE / 10 HOLDA / 5 HOLDB），缓存在
 * `tools/.verdict-calib2.json`。按文件名回查真实路径后用新分类器复核：
 *   · 24/25 类别不变（9 TUNE、10 HOLDA、5 HOLDB 全部保持原类别）；
 *   · 余下 1 条（`【0527可发文脉】陈子烨…`）在语料里有**两个路径** ——
 *     发排版与责编版各一份，归 TUNE 仍然成立。
 * 因此记录的 t 值（ruleScore −2.21「有分离度」、allScore −0.47
 * 「分离度不足」）继续有效。重跑一次需约 25 篇 × 145 秒 ≈ 2 小时模型调用，
 * 在没有类别变化的证据下不值得。
 */
const HOLDOUT_ISSUE = /^06-2024年冬/;
const STAGE_DIRS = [
  { re: /带痕迹/, set: 'HOLDB' },
  { re: /发排/, set: 'TUNE' },
  { re: /责编版|毛条样|编务版/, set: 'HOLDA' },
];
function classify(p) {
  const rel = path.relative(ROOT, p).replace(/^发给皓天的一审文件\\/, '');
  const segs = rel.split(path.sep).slice(0, -1);
  if (segs.some((s) => HOLDOUT_ISSUE.test(s))) return 'HOLDB';
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    for (const s of STAGE_DIRS) if (s.re.test(segs[i])) return s.set;
  }
  return null;
}

const buckets = { TUNE: [], HOLDA: [], HOLDB: [] };
for (const p of walk(ROOT)) { const c = classify(p); if (c) buckets[c].push(p); }

/** 按篇幅分层抽样：分数按千字归一，篇幅是主要影响因子，必须覆盖各档 */
function sample(files, k) {
  const sized = [];
  for (const f of files) {
    try {
      const doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f));
      const c = doc.stats?.chars || 0;
      if (c >= 3000) sized.push({ f, c });
    } catch { /* 解析失败跳过 */ }
  }
  sized.sort((a, b) => a.c - b.c);
  const out = [];
  for (let i = 0; i < k; i += 1) {
    const idx = Math.floor(((i + 0.5) / k) * sized.length);
    if (sized[idx]) out.push(sized[idx]);
  }
  return out;
}

const targets = [
  ...sample(buckets.TUNE, PER).map((x) => ({ ...x, set: 'TUNE' })),
  ...sample(buckets.HOLDA, PER).map((x) => ({ ...x, set: 'HOLDA' })),
  ...sample(buckets.HOLDB, Math.max(2, Math.round(PER / 2))).map((x) => ({ ...x, set: 'HOLDB' })),
];

/** 已完成的结果（增量续跑） */
let done = [];
if (fs.existsSync(CACHE)) {
  try { done = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { done = []; }
}
const doneKeys = new Set(done.map((r) => r.file + '|' + r.set));
const todo = targets.filter((t) => !doneKeys.has(path.basename(t.f) + '|' + t.set));
console.log(`目标 ${targets.length} 篇｜已完成 ${done.length} 篇｜本次待跑 ${todo.length} 篇｜并发 ${CONC}`);

async function runOne(t) {
  const t0 = Date.now();
  try {
    const doc = parseDocxBuffer(fs.readFileSync(t.f), path.basename(t.f));
    const res = await fullReview(doc, { model: 'deepseek-v4-1-flash-260910', useRecheck: false });
    const det = res.deterministic;
    const ruleIssues = [...det.format.issues, ...det.language.issues, ...det.citation.issues];
    // 规则口径：只对规则问题打分；模型口径：对合并列表打分
    const ruleScore = ruleIssues.reduce((a, i) => a + ({ 高: 3, 中: 2, 低: 1 }[i.severity] || 0), 0);
    const allScore = res.verdict.score;
    const rec = {
      set: t.set,
      file: path.basename(t.f),
      chars: t.c,
      ruleIssues: ruleIssues.length,
      modelIssues: res.issues.length - ruleIssues.length,
      allIssues: res.issues.length,
      ruleScore,
      allScore,
      rulePer1k: t.c ? Math.round((ruleScore / t.c) * 1000 * 100) / 100 : null,
      allPer1k: t.c ? Math.round((allScore / t.c) * 1000 * 100) / 100 : null,
      verdict: res.verdict.verdict,
      sec: Math.round((Date.now() - t0) / 1000),
    };
    done.push(rec);
    fs.writeFileSync(CACHE, JSON.stringify(done, null, 1));
    console.log(`  [${t.set}] ${rec.file.slice(0, 30)} 字数${rec.chars} 规则${rec.ruleIssues}/${rec.ruleScore}分 模型+${rec.modelIssues} → 总${rec.allScore}分 ${rec.verdict} (${rec.sec}s)`);
    return rec;
  } catch (e) {
    const rec = { set: t.set, file: path.basename(t.f), chars: t.c, error: String(e.message).slice(0, 160) };
    done.push(rec);
    fs.writeFileSync(CACHE, JSON.stringify(done, null, 1));
    console.log(`  [${t.set}] ${rec.file.slice(0, 30)} 失败: ${String(e.message).slice(0, 90)}`);
    return rec;
  }
}

/** 简单并发池 */
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, async () => {
  while (cursor < todo.length) {
    const i = cursor; cursor += 1;
    await runOne(todo[i]);
  }
}));

/* ── 分析 ── */
const ok = done.filter((r) => !r.error);
const q = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
/** Welch t 检验（不假设方差齐性） */
function welch(a, b) {
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const varOf = (x) => {
    const m = mean(x);
    return x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1);
  };
  if (a.length < 2 || b.length < 2) return null;
  const va = varOf(a); const vb = varOf(b);
  const se = Math.sqrt(va / a.length + vb / b.length);
  if (!se) return null;
  return Math.round(((mean(a) - mean(b)) / se) * 100) / 100;
}

console.log('\n════════ 结果 ════════');
for (const metric of ['ruleScore', 'allScore', 'rulePer1k', 'allPer1k']) {
  const tune = ok.filter((r) => r.set === 'TUNE').map((r) => r[metric]).filter((x) => x !== null);
  const holda = ok.filter((r) => r.set === 'HOLDA').map((r) => r[metric]).filter((x) => x !== null);
  const holdb = ok.filter((r) => r.set === 'HOLDB').map((r) => r[metric]).filter((x) => x !== null);
  const t = welch(tune, holda);
  console.log(`\n── ${metric} ──`);
  console.log(`  TUNE (n=${tune.length})  P25=${q(tune, 0.25)} P50=${q(tune, 0.5)} P75=${q(tune, 0.75)} P90=${q(tune, 0.9)} max=${Math.max(...tune)}`);
  console.log(`  HOLDA(n=${holda.length}) P25=${q(holda, 0.25)} P50=${q(holda, 0.5)} P75=${q(holda, 0.75)} P90=${q(holda, 0.9)} max=${Math.max(...holda)}`);
  if (holdb.length) console.log(`  HOLDB(n=${holdb.length}) P50=${q(holdb, 0.5)} P90=${q(holdb, 0.9)}`);
  console.log(`  Welch t (TUNE vs HOLDA) = ${t}   ${Math.abs(t ?? 0) >= 2 ? '← 有分离度' : '← 分离度不足'}`);
  if (metric === 'ruleScore' || metric === 'allScore') {
    console.log(`  若按 TUNE 百分位定阈值：pass=${q(tune, 0.5)} passMinor=${q(tune, 0.75)} revise=${q(tune, 0.9)}`);
  }
}
const verdicts = {};
for (const r of ok) { verdicts[r.set] = verdicts[r.set] || {}; verdicts[r.set][r.verdict] = (verdicts[r.set][r.verdict] || 0) + 1; }
console.log('\n判定分布 ' + JSON.stringify(verdicts, null, 1));
console.log(`\n完成 ${ok.length} 篇｜失败 ${done.length - ok.length} 篇｜累计 ${(done.reduce((s, r) => s + (r.sec || 0), 0) / 60).toFixed(1)} 分钟模型时间`);
