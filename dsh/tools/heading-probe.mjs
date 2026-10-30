/**
 * 标题识别对比探针：同一份稿件，旧判据（纯文本正则）vs 新分级器（多信号融合）。
 * 只读，不写文件。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocxBuffer } from '../src/docx.js';
import { classifyHeadings } from '../src/headings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || resolve(__dirname, '..', 'samples', 'test.docx');
const doc = parseDocxBuffer(readFileSync(file), basename(file));

// 旧判据：完全复刻原实现
const OLD = /^[一二三四五六七八九十]+[、．.]|^[（(][一二三四五六七八九十]+[）)]|^\d+[．.]|^[（(]\d+[）)]|^[①②③④⑤⑥⑦⑧⑨⑩]/;
const oldHits = [];
doc.paragraphs.forEach((p, i) => {
  const t = (p.text || '').trim();
  if (!t || t.length > 60) return;
  if (OLD.test(t)) oldHits.push({ i, t });
});

const res = classifyHeadings(doc);
console.log(`稿件：${basename(file)}  段落 ${doc.paragraphs.length}`);
console.log(`正文基准字号：${res.bodySizeHalfPt} half-pt`);
console.log('');
console.log(`旧判据命中：${oldHits.length} 条`);
console.log(`新分级器命中：${res.headings.length} 条`);
console.log('');

const oldSet = new Set(oldHits.map((x) => x.i));
const newSet = new Set(res.headings.map((x) => x.index));
const added = res.headings.filter((h) => !oldSet.has(h.index));
const lost = oldHits.filter((h) => !newSet.has(h.i));

console.log(`=== 新增识别（旧判据漏检，共 ${added.length} 条）===`);
for (const h of added.slice(0, 30)) {
  const p = doc.paragraphs[h.index];
  console.log(`  [${h.index}] L${h.level} src=${h.source} style=${p.properties.style || '-'} outline=${p.properties.outline || '-'} jc=${p.properties.jc || '-'} sz=${p.format.sizeHalfPt} bold=${p.format.bold} | ${h.text.slice(0, 60)}`);
}
console.log('');
console.log(`=== 旧判据命中但新分级器未判为标题（共 ${lost.length} 条）===`);
for (const h of lost.slice(0, 20)) console.log(`  [${h.i}] | ${h.t.slice(0, 60)}`);
console.log('');
console.log('=== 层级分布 ===');
for (const [lv, n] of Object.entries(res.byLevel).sort((a, b) => a[0] - b[0])) console.log(`  L${lv}: ${n} 条`);
console.log('');
console.log('=== 按判据来源 ===');
const bySrc = {};
for (const h of res.headings) bySrc[h.source] = (bySrc[h.source] || 0) + 1;
for (const [s, n] of Object.entries(bySrc).sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n} 条`);
