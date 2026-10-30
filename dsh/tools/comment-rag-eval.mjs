/**
 * 历史批注案例库 · 检索评测（证据落盘，不烧模型额度）。
 *
 * ⚠️ 诚实边界：本脚本**测不了「检索得对不对」的绝对精度** —— 判断一条历史批注
 * 与当前段落「相关」需要人的语义判断，脚本给不了。所以这里只出三类**客观**证据：
 *   1. 规模与成本：入库条数、索引体积、加载耗时、单次检索延迟；
 *   2. 覆盖率：真实稿件窗口里，有多少能检到 ≥1 条案例（按不同 minMatch 阈值扫描）；
 *   3. 留一近似命中：拿某条批注自己的锚定段去检索（排除同文件），
 *      看能否检到另一条**近乎同一段落**的历史批注（Jaccard≥0.5）——这是**下界**，
 *      因为独一无二的段落本来就没有近似可比。
 * 外加若干**抽样打印**，供人眼核对（这部分是定性，不是指标）。
 *
 * 用法：node tools/comment-rag-eval.mjs [--docs=12] [--samples=5]
 */
import { writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocx } from '../src/docx.js';
import { buildWindows } from '../src/ark.js';
import { loadCaseIndex, makeRetriever, DEFAULT_INDEX_PATH, tokenize } from '../src/comment-cases.js';
import { loadCorpusList } from './lib/corpus.mjs';
import { DSH_ROOT } from './paths.mjs';

const argOf = (name, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : d;
};
const DOCS = argOf('docs', 12);
const SAMPLES = argOf('samples', 5);

const t0 = Date.now();
const index = loadCaseIndex(DEFAULT_INDEX_PATH);
if (!index) { console.log('未找到索引，请先运行 node tools/build-comment-index.mjs'); process.exit(1); }
const loadMs = Date.now() - t0;
const retriever = makeRetriever(index);
const bytes = statSync(DEFAULT_INDEX_PATH).size;

console.log('═══ 历史批注案例库 · 检索评测 ═══');
console.log(`入库批注      ${index.count} 条｜覆盖稿件 ${index.files.length} 份`);
console.log(`索引体积      ${(bytes / 1024 / 1024).toFixed(2)} MB｜加载耗时 ${loadMs} ms｜平均文档长度 ${index.avgLen} bigram`);
console.log('');

/* ---------- 1) 覆盖率 + 延迟：真实稿件窗口 ---------- */
const { list } = loadCorpusList({ docxOnly: true });
const pickN = Math.min(DOCS, list.length);
const stride = Math.max(1, Math.floor(list.length / pickN));
const picked = [];
for (let i = 0; i < list.length && picked.length < pickN; i += stride) picked.push(list[i]);

const thresholds = [4, 6, 8, 10, 15, 20];
const hitCount = Object.fromEntries(thresholds.map((m) => [m, 0]));
let totalWindows = 0;
let totalCases = 0;
let queryMsTotal = 0;
const top1Scores = [];
const samplePrint = [];

for (const item of picked) {
  let doc;
  try { doc = parseDocx(item.full); } catch { continue; }
  const windows = buildWindows(doc);
  const excludeFiles = new Set([String(item.path).replace(/\//g, '\\')]);
  for (const win of windows) {
    const q = win.map((p) => p.text).join('\n');
    if (!q.trim()) continue;
    totalWindows += 1;
    const tq = Date.now();
    const cases = retriever(q, { k: 3, excludeFiles });
    queryMsTotal += Date.now() - tq;
    totalCases += cases.length;
    const raw = retriever(q, { k: 1, minMatch: 1, ratio: 0, floor: 0 });
    if (raw.length) top1Scores.push(raw[0].score);
    for (const m of thresholds) {
      if (retriever(q, { k: 3, minMatch: m }).length) hitCount[m] += 1;
    }
    if (samplePrint.length < SAMPLES && cases.length && !samplePrint.some((s) => s.file === item.path)) {
      samplePrint.push({ file: item.path, query: q.slice(0, 90), cases: cases.slice(0, 3) });
    }
  }
}

top1Scores.sort((a, b) => a - b);
const pct = (p) => (top1Scores.length ? top1Scores[Math.floor(p * (top1Scores.length - 1))] : 0).toFixed(1);

console.log('── 覆盖率（真实稿件窗口；默认 minMatch=5 + 相对门槛）──');
console.log(`抽样稿件 ${picked.length} 篇｜窗口 ${totalWindows} 个｜平均每窗命中案例 ${(totalCases / Math.max(1, totalWindows)).toFixed(2)} 条`);
for (const m of thresholds) {
  console.log(`  minMatch≥${String(m).padStart(2)}：${(hitCount[m] / Math.max(1, totalWindows) * 100).toFixed(1)}% 的窗口能检到案例`);
}
console.log(`  top-1 分值分布：p25=${pct(0.25)} p50=${pct(0.5)} p75=${pct(0.75)} p90=${pct(0.9)}（用于说明为何用相对门槛）`);
console.log(`  单次检索平均延迟 ${(queryMsTotal / Math.max(1, totalWindows)).toFixed(1)} ms`);
console.log('');

/* ---------- 2) 留一近似命中（下界） ---------- */
const bigrams = (s) => new Set(tokenize(s));
const jac = (a, b) => { let inter = 0; for (const x of a) if (b.has(x)) inter += 1; return inter / (a.size + b.size - inter || 1); };
const N = index.count;
const M = Math.min(300, N);
const step = Math.max(1, Math.floor(N / M));
let l1 = 0;
let l3 = 0;
let tested = 0;
for (let i = 0; i < N && tested < M; i += step) {
  const d = index.docs[i];
  if (!d.a) continue;
  const qset = bigrams(d.a);
  const mine = new Set([index.files[d.fi]].filter(Boolean));
  const got = retriever(d.a, { k: 3, excludeFiles: mine });
  tested += 1;
  const near = (c) => jac(qset, bigrams(c.anchor)) >= 0.5;
  if (got.length && near(got[0])) l1 += 1;
  if (got.some(near)) l3 += 1;
}
console.log('── 留一近似命中（排除同文件；Jaccard≥0.5 记为「找到近乎同一段落」）──');
console.log(`  样本 ${tested} 条｜hit@1 ${(l1 / Math.max(1, tested) * 100).toFixed(1)}%｜hit@3 ${(l3 / Math.max(1, tested) * 100).toFixed(1)}%`);
console.log('  （这是下界：独一无二的段落本就没有近似可比，miss 不代表检索失败）');
console.log('');

/* ---------- 3) 抽样打印（人眼核对） ---------- */
console.log('── 抽样（供人工核对相关性）──');
for (const s of samplePrint) {
  console.log(`\n【待审段落】${s.query}…`);
  for (const c of s.cases) console.log(`   · 历史批注（${c.author || '—'}/${c.season || '—'}）：${c.comment.slice(0, 70)}\n     锚定原文：${c.anchor.slice(0, 60)}…`);
}

const payload = {
  generatedAt: new Date().toISOString(),
  index: { count: index.count, files: index.files.length, bytes, avgLen: index.avgLen, loadMs },
  coverage: { docs: picked.length, windows: totalWindows, avgCasesPerWindow: +(totalCases / Math.max(1, totalWindows)).toFixed(2), byMinMatch: Object.fromEntries(thresholds.map((m) => [m, +(hitCount[m] / Math.max(1, totalWindows) * 100).toFixed(1)])), avgQueryMs: +(queryMsTotal / Math.max(1, totalWindows)).toFixed(2) },
  leaveOneOut: { tested, hit1: +(l1 / Math.max(1, tested) * 100).toFixed(1), hit3: +(l3 / Math.max(1, tested) * 100).toFixed(1), note: 'Jaccard≥0.5 近似命中，下界' },
  samples: samplePrint,
};
writeFileSync(join(DSH_ROOT, 'data', 'verify', 'comment-rag-eval.json'), JSON.stringify(payload, null, 2));
console.log(`\n产物：data/verify/comment-rag-eval.json`);
