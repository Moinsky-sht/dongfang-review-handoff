/**
 * 标题识别批量校验：对一批**已发排定稿**跑分级器，输出每篇的标题清单，
 * 供人工核对准确率（定稿的标题是权威正确的，可作事实上的 gold）。
 *
 * 用法：node tools/heading-audit.mjs <目录或文件...>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { classifyParagraphs } from '../src/scanner-format.js';

const OLD = /^[一二三四五六七八九十]+[、．.]|^[（(][一二三四五六七八九十]+[）)]|^\d+[．.]|^[（(]\d+[）)]|^[①②③④⑤⑥⑦⑧⑨⑩]/;

function collect(target) {
  const st = statSync(target);
  if (st.isFile()) return [target];
  return readdirSync(target)
    .filter((f) => /\.docx$/i.test(f) && !f.startsWith('~$'))
    .map((f) => join(target, f));
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('用法：node tools/heading-audit.mjs <目录或文件...>');
  process.exit(2);
}
const files = targets.flatMap(collect);

let totOld = 0;
let totNew = 0;
let totParas = 0;
const srcAgg = {};
const lvlAgg = {};

for (const f of files) {
  let doc;
  try {
    doc = parseDocxBuffer(readFileSync(f), basename(f));
  } catch (e) {
    console.log(`\n### ${basename(f)}\n  解析失败：${e.message}`);
    continue;
  }
  /**
   * 走**真实流水线**（`classifyParagraphs`）而不是单独调分级器。
   *
   * 差别很关键：`classifyParagraphs` 会先判出篇名/署名/提要等前置区角色，
   * 再把这些段排除在标题之外，并清掉分级器误标的篇名。
   * 单独调 `classifyHeadings` 会把篇名（比正文大、居中加粗）算成标题，
   * 审计结果就会虚高，且掩盖「篇名 vs 章节标题」这个真实难点。
   */
  const res = classifyParagraphs(doc);
  /**
   * 标题清单必须从**段落的最终值**读，不能读 `res.headingResult.headings`。
   *
   * 原因：`headingResult` 是 `classifyHeadings()` 返回的快照，而
   * `classifyParagraphs()` 之后还会做两步校正 —— 前置区清理（摘掉篇名）
   * 与**层级结构校正**（无编号标题按结构上提）。快照里是校正前的层级，
   * 直接拿它做审计会得出「文件 12 的标题全是 2 级」这种**已经修好**的错误结论。
   */
  const headings = [];
  doc.paragraphs.forEach((p, i) => {
    if (!p._headingLevel) return;
    headings.push({
      index: i,
      level: Number(String(p._headingLevel).replace('level', '')) || 0,
      source: p._headingSource || '',
      text: (p.text || '').trim(),
    });
  });
  const oldHits = [];
  doc.paragraphs.forEach((p, i) => {
    const t = (p.text || '').trim();
    if (!t || t.length > 60) return;
    if (OLD.test(t)) oldHits.push(i);
  });
  totOld += oldHits.length;
  totNew += headings.length;
  totParas += doc.paragraphs.length;
  for (const h of headings) srcAgg[h.source] = (srcAgg[h.source] || 0) + 1;
  for (const h of headings) lvlAgg[h.level] = (lvlAgg[h.level] || 0) + 1;

  console.log(`\n### ${basename(f).slice(0, 70)}`);
  console.log(`  段落 ${doc.paragraphs.length}  旧判据 ${oldHits.length} 条  新分级器 ${headings.length} 条  正文基准字号 ${res.headingResult.bodySizeHalfPt ?? '-'}`);
  for (const h of headings) {
    const flag = oldHits.includes(h.index) ? ' ' : '+'; // + = 旧判据漏检
    console.log(`   ${flag} L${h.level} ${h.source.padEnd(9)} [${h.index}] ${h.text.slice(0, 56)}`);
  }
}

console.log('\n════════ 汇总 ════════');
console.log(`文件数 ${files.length}  段落合计 ${totParas}`);
console.log(`旧判据合计 ${totOld} 条   新分级器合计 ${totNew} 条   新增 ${totNew - totOld} 条（+${totOld ? (((totNew - totOld) / totOld) * 100).toFixed(0) : '-'}%）`);
console.log('判据来源分布：', JSON.stringify(srcAgg));
console.log('层级分布：', JSON.stringify(lvlAgg));
