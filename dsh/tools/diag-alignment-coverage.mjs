/**
 * 覆盖度诊断（第二版）。
 *
 * 第一版用「前 20 字相同」判近似，得出 165 条"解析器里找不到" —— 与事实矛盾：
 * 这些段落浏览器**明明对齐上了**（DOM 上有 data-pindex=7/11/12…）。
 * 原因是判据本身不对：DOM 文本里插了脚注引用数字，而数字可能落在前 20 字内。
 *
 * 本版改为**剥掉数字再比**（脚注引用内联渲染成上标数字，是已知差异来源），
 * 从而分清两件完全不同的事：
 *   A. 对齐失败（解析里有这段，只是没配上）→ 要修对齐
 *   B. 段落数本来就不匹配（DOM 里的 <p> 不是解析段落）→ 是解析口径差异
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { CORPUS_ROOT } from './paths.mjs';

const WZ = join(CORPUS_ROOT, '13-2026年秋', '2026秋季刊发排版',
  '02-文化-吴子枫-无产阶级专政、共产主义战略和\u201c葛兰西难题\u201d【0801发文脉】.docx');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
/** 剥掉所有 ASCII 数字：脚注引用被 docx-preview 渲染成上标数字内联进段落 */
const stripDigits = (s) => s.replace(/[0-9]/g, '');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

const dom = readJson('tools/.dom-wz.json');
const domBody = dom.paras.filter((p) => p.fi === null || p.fi === undefined);
const doc = parseDocxBuffer(fs.readFileSync(WZ), 'x.docx');
const paras = doc.paragraphs.map((p) => norm(p.text));

console.log(`解析器 doc.paragraphs = ${paras.length}（doc.stats.paragraphs = ${doc.stats.paragraphs}）`);
console.log(`DOM 正文段落 = ${domBody.length}\n`);

const idxExact = new Map();
const idxStrip = new Map();
paras.forEach((p, i) => {
  if (!idxExact.has(p)) idxExact.set(p, []);
  idxExact.get(p).push(i);
  const s = stripDigits(p);
  if (!idxStrip.has(s)) idxStrip.set(s, []);
  idxStrip.get(s).push(i);
});

let a_exact = 0, b_strip = 0, c_fail = 0;
const fails = [];
const matchedParsedIdx = new Set();
for (const d of domBody) {
  const t = norm(d.t);
  if (!t) continue;
  if (idxExact.has(t)) { a_exact += 1; idxExact.get(t).forEach((i) => matchedParsedIdx.add(i)); continue; }
  const s = stripDigits(t);
  if (idxStrip.has(s)) { b_strip += 1; idxStrip.get(s).forEach((i) => matchedParsedIdx.add(i)); continue; }
  c_fail += 1;
  if (fails.length < 10) fails.push({ pi: d.pi, t: t.slice(0, 80) });
}
console.log(`A. DOM 与解析逐字相等           ${a_exact}`);
console.log(`B. 剥掉数字后相等（=脚注引用）   ${b_strip}`);
console.log(`C. 剥数字后仍找不到             ${c_fail}`);
console.log(`   → A+B = ${a_exact + b_strip} 条 DOM 段落确实对应解析段落`);
console.log(`   → 这些覆盖了解析段落的 ${matchedParsedIdx.size}/${paras.length} 个不同下标\n`);

if (fails.length) {
  console.log('── C 类样本（剥数字后仍找不到）──');
  for (const f of fails) console.log(`  [pi=${f.pi}] ${JSON.stringify(f.t)}`);
}

/* 解析器里 DOM 完全没有的段落 */
const domStrip = new Set(domBody.map((d) => stripDigits(norm(d.t))));
const parsedMissing = [];
paras.forEach((p, i) => { if (p && !domStrip.has(stripDigits(p))) parsedMissing.push({ i, p: p.slice(0, 70) }); });
console.log(`\n解析段落里 DOM 没有的：${parsedMissing.length} 条`);
for (const m of parsedMissing.slice(0, 10)) console.log(`  [${m.i}] ${JSON.stringify(m.p)}`);

/* 未被任何 DOM 段落覆盖的解析下标 */
const uncovered = [];
for (let i = 0; i < paras.length; i += 1) if (paras[i] && !matchedParsedIdx.has(i)) uncovered.push(i);
console.log(`\n未被 DOM 覆盖的解析下标：${uncovered.length} 个`);
for (const i of uncovered.slice(0, 10)) console.log(`  [${i}] ${JSON.stringify(paras[i].slice(0, 70))}`);
