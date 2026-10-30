/**
 * `w:highlight` 到底是什么 —— 549 篇（86.9%）都有，是本语料覆盖面最广的特殊格式。
 *
 * ── 为什么要查 ──
 * 62980 次 / 549 篇，比脚注（607 篇）只少一点。这么大的覆盖面只有两种可能：
 *   ① 是**责编标记**（一审时用高亮标出要改的地方）—— 那它就是编辑意图的直接载体，
 *      规则引擎和界面都应该看得见；
 *   ② 是**模板/底纹残留**（比如全文套了某个带高亮的样式）—— 那就没信息量，
 *      当成噪声忽略即可。
 * 两者处理方式完全相反，所以必须先量清楚，不能猜。
 *
 * 本脚本按**颜色值**、**是否在正文/表格/脚注**、**高亮文字内容**三个维度拆开，
 * 并统计「高亮覆盖率」（高亮字符数 / 全文字符数）来区分 ① 和 ②。
 *
 * 用法：node tools/investigate-highlight.mjs [--limit 40]
 */
import fs from 'node:fs';
import path from 'node:path';
import { openZip } from '../src/zip.js';
import { CORPUS_ROOT } from './paths.mjs';

const ROOT = CORPUS_ROOT;
const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIMIT = Number(getArg('--limit', 40));

function walk(dir, acc = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name.startsWith('.')) continue; walk(p, acc); }
    else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}

/** 剥掉格式修订历史，否则会把"以前是高亮"算成"现在是高亮" */
const strip = (xml) => xml
  .replace(/<w:rPrChange[\s\S]*?<\/w:rPrChange>/g, '')
  .replace(/<w:pPrChange[\s\S]*?<\/w:pPrChange>/g, '')
  .replace(/<w:tblPrChange[\s\S]*?<\/w:tblPrChange>/g, '')
  .replace(/<w:trPrChange[\s\S]*?<\/w:trPrChange>/g, '')
  .replace(/<w:tcPrChange[\s\S]*?<\/w:tcPrChange>/g, '');

const files = walk(ROOT);
console.log(`语料 ${files.length} 篇\n`);

const colorTotals = new Map();   // 颜色 → 出现篇数
const colorRuns = new Map();     // 颜色 → run 总数
const rows = [];
let filesWithHl = 0;

for (const f of files) {
  let z;
  try { z = openZip(fs.readFileSync(f)); } catch { continue; }
  const parts = {
    正文: strip(z.readText('word/document.xml') || ''),
    脚注: strip(z.readText('word/footnotes.xml') || ''),
    尾注: strip(z.readText('word/endnotes.xml') || ''),
  };
  const colors = new Map();
  let hlChars = 0, allChars = 0;
  const samples = [];

  for (const [where, xml] of Object.entries(parts)) {
    if (!xml) continue;
    for (const r of xml.match(/<w:r[ >][\s\S]*?<\/w:r>/g) || []) {
      const t = (r.match(/<w:t[ >][^<]*<\/w:t>/g) || []).map((x) => x.replace(/<[^>]*>/g, '')).join('');
      allChars += t.length;
      const m = r.match(/<w:highlight[^>]*w:val="([^"]+)"/);
      if (!m) continue;
      colors.set(m[1], (colors.get(m[1]) || 0) + 1);
      hlChars += t.length;
      if (samples.length < 6 && t.trim()) samples.push({ where, color: m[1], t: t.trim().slice(0, 46) });
    }
  }
  // 表格里的高亮（单独看：表格底纹常被误当高亮）
  const tblHl = (parts.正文.match(/<w:shd[^>]*w:fill="(?!auto|FFFFFF)/g) || []).length;

  if (!colors.size) continue;
  filesWithHl += 1;
  for (const [c, n] of colors) {
    colorTotals.set(c, (colorTotals.get(c) || 0) + 1);
    colorRuns.set(c, (colorRuns.get(c) || 0) + n);
  }
  rows.push({
    file: path.basename(f),
    colors: [...colors.entries()].sort((a, b) => b[1] - a[1]),
    hlChars, allChars,
    coverage: allChars ? hlChars / allChars : 0,
    tblShd: tblHl,
    samples,
  });
}

console.log(`含高亮的稿件：**${filesWithHl} / ${files.length}** 篇（${(filesWithHl / files.length * 100).toFixed(1)}%）\n`);

console.log('═══ 高亮颜色分布 ═══');
console.log('  颜色            出现篇数   run 总数');
for (const [c, n] of [...colorTotals.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.padEnd(16)} ${String(n).padStart(6)} ${String(colorRuns.get(c)).padStart(9)}`);
}

console.log('\n═══ 高亮覆盖率（高亮字符 / 全文可读字符）═══');
console.log('  覆盖率区间      稿件数');
const buckets = [[0, 0.005], [0.005, 0.02], [0.02, 0.05], [0.05, 0.2], [0.2, 0.5], [0.5, 1.01]];
for (const [a, b] of buckets) {
  const n = rows.filter((r) => r.coverage >= a && r.coverage < b).length;
  console.log(`  ${(a * 100).toFixed(1)}% - ${(b * 100).toFixed(0)}%`.padEnd(18) + String(n).padStart(6));
}
const hiCov = rows.filter((r) => r.coverage >= 0.5);
console.log(`\n  覆盖率 ≥50% 的稿件：**${hiCov.length}** 篇 —— 这些是「整篇套了高亮」，属模板/底纹性质`);
console.log(`  覆盖率 <5% 的稿件：**${rows.filter((r) => r.coverage < 0.05).length}** 篇 —— 这些是「局部标了几处」，属编辑标记性质`);

console.log('\n═══ 高亮内容样例（按覆盖率从低到高，看它标的是什么）═══');
const sorted = [...rows].sort((a, b) => a.coverage - b.coverage);
for (const r of sorted.slice(0, 8)) {
  console.log(`\n  ${(r.coverage * 100).toFixed(2)}%  ${r.file.slice(0, 48)}`);
  console.log(`        颜色 ${r.colors.map(([c, n]) => `${c}×${n}`).join(' ')}｜表格底纹 ${r.tblShd}`);
  for (const s of r.samples.slice(0, 3)) console.log(`        [${s.where}/${s.color}] «${s.t}»`);
}

console.log('\n═══ 覆盖率最高的几篇（应是模板性质）═══');
for (const r of sorted.slice(-5)) {
  console.log(`  ${(r.coverage * 100).toFixed(1)}%  ${r.file.slice(0, 48)}  颜色 ${r.colors.map(([c, n]) => `${c}×${n}`).join(' ')}`);
  for (const s of r.samples.slice(0, 2)) console.log(`        [${s.where}/${s.color}] «${s.t}»`);
}
