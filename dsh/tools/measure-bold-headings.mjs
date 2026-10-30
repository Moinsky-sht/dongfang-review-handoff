/**
 * 「加粗短行是不是标题」的度量（决定要不要加这条判据）。
 *
 * ── 背景 ──
 * 实测发现有些稿件的标题既没有编号、也没有 `w:outlineLvl`，只有 `bold:true`
 * （`bold` 在真标题上是 true、正文是 false，其余属性完全相同）。
 * 但**不能**据此就写「加粗短行 = 标题」：加粗短行里还混着
 * 微博截图文字、访谈提问（`问题1：…？`）、前置元数据（`Publication: …`）
 * 等等，naive 地加这条判据会把这些变成标题，反而退化。
 *
 * 本脚本先把**候选总体**和**混进来的东西**数清楚，
 * 再决定是否需要更窄的守卫、以及收益是否值得风险。
 *
 * 用法：node tools/measure-bold-headings.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { isTextHeading } from '../src/headings.js';
import { CORPUS_ROOT } from './paths.mjs';

const ROOT = CORPUS_ROOT;

function walk(dir, acc = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p, acc); }
    else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}

/** 该段是否已被现有判据（样式/大纲/编号/文本）认定为标题 */
function alreadyHeading(doc, p) {
  const t = (p.text || '').trim();
  if (!t) return true;
  if (p.properties?.style && /^Heading\s*\d|^标题\s*\d/i.test(p.properties.style)) return true;
  if (p.properties?.outline !== undefined && p.properties.outline !== null && p.properties.outline !== '') return true;
  if (p.properties?.numPr) return true;
  if (isTextHeading(t)) return true;
  return false;
}

/** 看起来像「混进来的非标题」的特征 */
function looksLikeNoise(t) {
  const s = t.trim();
  if (/^(问题|提问|答|回应|问)\s*\d*\s*[:：]/.test(s)) return '访谈问答';
  if (/^[A-Za-z][A-Za-z\s]{2,}:\s/.test(s) && /[:：]/.test(s)) return '英文元数据';
  if (/[？?]$/.test(s)) return '问句结尾';
  if (/^[·・＋+@#【\[（(]/.test(s)) return '符号开头';
  if (/https?:\/\/|www\./.test(s)) return '含网址';
  if (/^\d{4}[-/年]/.test(s)) return '日期开头';
  if (/^[（(]?\d+[）)]?\s*$/.test(s)) return '纯数字';
  if (/[，。；：、]/.test(s) && [...s].length > 30) return '长句带标点';
  return null;
}

const files = walk(ROOT);
console.log(`语料 ${files.length} 篇\n`);

let scanned = 0, fail = 0;
let candTotal = 0;
const filesWithCand = new Set();
const noiseKinds = {};
const cleanSamples = [];
const cleanFiles = new Set();

for (const f of files) {
  let doc;
  try { doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f)); } catch { fail += 1; continue; }
  scanned += 1;
  for (const p of doc.paragraphs) {
    const t = (p.text || '').trim();
    if (!t) continue;
    if ([...t].length > 40) continue;
    if (p.format?.bold !== true) continue;
    if (alreadyHeading(doc, p)) continue;
    candTotal += 1;
    filesWithCand.add(path.basename(f));
    const noise = looksLikeNoise(t);
    if (noise) { noiseKinds[noise] = (noiseKinds[noise] || 0) + 1; continue; }
    cleanFiles.add(path.basename(f));
    if (cleanSamples.length < 24) {
      cleanSamples.push({ t: t.slice(0, 52), jc: p.properties?.jc || '', sz: p.format?.sizeHalfPt || 0 });
    }
  }
}

console.log(`扫描 ${scanned} 篇（解析失败 ${fail}）`);
console.log(`\n「短行 + 加粗 + 尚未被判为标题」的候选段落：**${candTotal}** 条，分布在 ${filesWithCand.size} 篇`);
console.log(`其中带明显噪声特征的：`);
let noiseSum = 0;
for (const [k, v] of Object.entries(noiseKinds).sort((a, b) => b[1] - a[1])) { console.log(`    ${k.padEnd(12)} ${v}`); noiseSum += v; }
console.log(`  噪声合计 ${noiseSum}（${Math.round((noiseSum / Math.max(1, candTotal)) * 1000) / 10}%）`);
console.log(`  剩余"干净候选" ${candTotal - noiseSum} 条，分布在 ${cleanFiles.size} 篇`);

console.log('\n干净候选样例（若加判据，这些会变成标题）：');
for (const s of cleanSamples) console.log(`  jc=${String(s.jc).padEnd(8)} sz=${String(s.sz).padStart(3)}  ${JSON.stringify(s.t)}`);

console.log('\n结论判据：');
console.log('  · 若干净候选占比低、且散落在很多篇里 → 加判据的收益小、误伤面大，不该加');
console.log('  · 若干净候选集中在少数篇、且这些篇现在完全识别不出标题 → 值得加窄判据');
const zeroHeadingFiles = [];
for (const f of files.slice(0, 200)) {
  let doc; try { doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f)); } catch { continue; }
  const hasAny = doc.paragraphs.some((p) => {
    const t = (p.text || '').trim();
    if (!t) return false;
    return (p.properties?.style && /^Heading\s*\d|^标题\s*\d/i.test(p.properties.style))
      || (p.properties?.outline !== undefined && p.properties?.outline !== null && p.properties?.outline !== '')
      || isTextHeading(t);
  });
  if (!hasAny) zeroHeadingFiles.push(path.basename(f));
}
console.log(`\n（抽样前 200 篇里）完全识别不出任何标题的稿件：${zeroHeadingFiles.length} 篇`);
for (const z of zeroHeadingFiles.slice(0, 10)) console.log(`    ${z.slice(0, 56)}`);
