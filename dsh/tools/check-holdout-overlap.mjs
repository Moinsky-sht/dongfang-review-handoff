/**
 * 留出集与调参集是否**真的零重叠** —— 必须按内容判定，不能按文件名。
 *
 * ── 为什么文件名判据是错的 ──
 * 语料里同一篇文章在不同生产阶段的文件名**完全对不上**：
 *   `1专题01-瑙姆金论文翻译.docx`            （发排版）
 *   `20241012瑙姆金论文翻译2024学刊冬季刊专题1【20211022一审】.docx`（一审带痕迹版）
 * 按「去掉序号/日期/括号后取前 N 字」比对会得出**零重叠的假结论** ——
 * 本脚本的前身就这么错过一次，而它当时还"确认"了留出集独立。
 *
 * ── 现行判据 ──
 * 用**正文内容指纹**：取解析后的篇名 + 若干段正文，做字符级 12-gram，
 * 两篇稿件的 12-gram 集合 Jaccard 相似度 ≥ 阈值即判为同一篇文章。
 * 同一篇文章的不同修订版正文绝大部分相同，所以这个判据能认出来；
 * 不同文章即使同栏目、同作者群，12-gram 重合也极低。
 *
 * 用法：node tools/check-holdout-overlap.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { ACADEMIC_ROOT } from './paths.mjs';

const ROOT = ACADEMIC_ROOT;

function walk(dir, acc = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.adv' || e.name === 'node_modules' || e.name.startsWith('.git')) continue;
      walk(p, acc);
    } else if (/\.docx?$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}

/** 与 eval-corpus.mjs 同一套阶段判据（整期留出优先，再按最内层阶段目录） */
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

const N = 12;
function grams(text) {
  const t = String(text || '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + N <= t.length; i += 1) out.add(t.slice(i, i + N));
  return out;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (big.has(g)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const files = walk(path.join(ROOT, '发给皓天的一审文件'));
const buckets = { TUNE: [], HOLDA: [], HOLDB: [] };
for (const p of files) { const c = classify(p); if (c) buckets[c].push(p); }

/** 阈值：同一篇文章的不同修订版实测远高于 0.5；不同文章远低于 0.1 */
const THRESH = 0.25;

/**
 * 计算三集两两重叠。供 `tools/verify-requirements.mjs` 调用，
 * 也可直接 `node tools/check-holdout-overlap.mjs` 查看明细。
 * @returns {{counts:object, pairs:object, verdicts:object}}
 */
export function overlapReport({ verbose = false } = {}) {
  const prints = {};
  for (const [set, list] of Object.entries(buckets)) {
    prints[set] = [];
    for (const p of list) {
      try {
        const doc = parseDocxBuffer(fs.readFileSync(p), path.basename(p));
        // 正文前 6000 字足够判同一篇文章；尾部差异大（修订痕迹），少取
        const text = (doc.paragraphs || []).map((x) => x.text || '').join('\n').slice(0, 6000);
        prints[set].push({ p, g: grams(text) });
      } catch { /* .doc 等跳过 */ }
    }
    if (verbose) console.log(`  ${set}: ${prints[set].length} 篇有指纹（共 ${list.length} 个文件）`);
  }
  const counts = {};
  const pairs = {};
  for (const [x, y] of [['TUNE', 'HOLDB'], ['TUNE', 'HOLDA'], ['HOLDA', 'HOLDB']]) {
    let hits = 0;
    const samples = [];
    for (const a of prints[x]) {
      for (const b of prints[y]) {
        const j = jaccard(a.g, b.g);
        if (j >= THRESH) {
          hits += 1;
          if (samples.length < 6) samples.push({ j: Math.round(j * 1000) / 1000, a: path.basename(a.p), b: path.basename(b.p) });
        }
      }
    }
    counts[`${x}∩${y}`] = hits;
    pairs[`${x}∩${y}`] = samples;
  }
  return {
    counts,
    pairs,
    files: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    fingerprinted: Object.fromEntries(Object.entries(prints).map(([k, v]) => [k, v.length])),
  };
}

// 直接运行时打印明细
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('check-holdout-overlap.mjs')) {
  console.log('正在解析并计算内容指纹…');
  const r = overlapReport({ verbose: true });
  console.log(`\n判据：正文 ${N}-gram Jaccard ≥ ${THRESH} 视为同一篇文章\n`);
  for (const [k, hits] of Object.entries(r.counts)) {
    const [x] = k.split('∩');
    const pct = Math.round((hits / Math.max(1, r.fingerprinted[x])) * 1000) / 10;
    console.log(`${k.replace('∩', ' ∩ ')}：**${hits}** 对（占 ${x} 的 ${pct}%）`);
    for (const pr of r.pairs[k]) console.log(`    ${pr.j}  ${pr.a.slice(0, 44)}\n            ${pr.b.slice(0, 44)}`);
    console.log('');
  }
  const okHoldout = r.counts['TUNE∩HOLDB'] === 0;
  console.log(okHoldout
    ? '✅ 留出集 HOLDB 与调参集 TUNE **零重叠**（按内容判定）'
    : `❌ 留出集被污染：TUNE ∩ HOLDB = ${r.counts['TUNE∩HOLDB']} 对`);
}
