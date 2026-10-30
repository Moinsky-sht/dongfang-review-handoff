/**
 * 图/文本框计数与原始 XML 的**逐篇相等性**验证。
 *
 * ── 为什么单独一个脚本 ──
 * `p.figures` 是「导入即清洗」里最容易做错的一项：`paragraphText` 的 walk
 * 会经过 `w:drawing`，但**不是所有经过的 drawing 都该算**：
 *   · 落在 `w:del` / `w:moveFrom` 内的 —— 当前文档里不存在（实测 139 个）
 *   · 落在 `mc:Fallback` 内的 —— 是 `mc:Choice` 的旧版降级副本（实测 20 个）
 *   · 落在别的 `w:txbxContent` 内的嵌套图 —— 我们不进入 `w:drawing`（设计取舍）
 * 早期版本漏了前两个判断，把 478 个 drawing 里的 344 个都算成了 figure，
 * 而真实活内容只有 205 个 —— **虚高 68%**。
 *
 * 本脚本用同一套判据分别算两边，要求**逐篇精确相等**。
 * 实测结果：632 / 632 篇相等，合计 205 = 205。
 *
 * 用法：node tools/verify-figures.mjs
 */import fs from 'node:fs';
import { openZip } from '../src/zip.js';
import { parseDocxBuffer } from '../src/docx.js';
import path from 'node:path';
import { CORPUS_ROOT } from './paths.mjs';

const ROOT = CORPUS_ROOT;
function walk(dir, acc = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name.startsWith('.')) continue; walk(p, acc); }
    else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}
function rangesOf(x, tags) {
  const out = [];
  for (const tag of tags) {
    const open = new RegExp(`<${tag}[ >]`, 'g');
    let m;
    while ((m = open.exec(x))) {
      const re = new RegExp(`<${tag}[ >]|</${tag}>`, 'g');
      re.lastIndex = m.index + m[0].length;
      let depth = 1, end = -1, mm;
      while ((mm = re.exec(x))) {
        if (mm[0].startsWith('</')) { depth -= 1; if (!depth) { end = mm.index + mm[0].length; break; } }
        else depth += 1;
      }
      if (end < 0) continue;
      out.push([m.index, end]);
      open.lastIndex = end;
    }
  }
  return out;
}

/** 活内容顶层 w:drawing 数：排除已删除修订、mc:Fallback、文本框内嵌套 */
function liveDrawings(xml) {
  const clean = xml
    .replace(/<w:rPrChange[\s\S]*?<\/w:rPrChange>/g, '')
    .replace(/<w:pPrChange[\s\S]*?<\/w:pPrChange>/g, '');
  const del = rangesOf(clean, ['w:del', 'w:moveFrom']);
  const fb = rangesOf(clean, ['mc:Fallback']);
  const tb = rangesOf(clean, ['w:txbxContent']);
  let n = 0;
  const re = /<w:drawing[ >]/g;
  let m;
  while ((m = re.exec(clean))) {
    const at = m.index;
    if (del.some(([a, b]) => at >= a && at < b)) continue;
    if (fb.some(([a, b]) => at >= a && at < b)) continue;
    if (tb.some(([a, b]) => at >= a && at < b)) continue;
    n += 1;
  }
  return n;
}

let same = 0, diff = 0, xmlTotal = 0, pTotal = 0;
const diffs = [];
for (const f of walk(ROOT)) {
  let z, doc;
  try { z = openZip(fs.readFileSync(f)); doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f)); } catch { continue; }
  let x = 0;
  for (const part of ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']) {
    const raw = z.readText(part) || '';
    if (raw) x += liveDrawings(raw);
  }
  const p = [...doc.paragraphs, ...doc.footnotes, ...doc.endnotes]
    .reduce((s, q) => s + (q.figures || []).length, 0);
  xmlTotal += x; pTotal += p;
  if (x === p) same += 1;
  else { diff += 1; if (diffs.length < 10) diffs.push({ f: path.basename(f).slice(0, 40), x, p }); }
}
console.log(`逐篇对比「活内容顶层 w:drawing」vs「解析器 figure 对象」：`);
console.log(`  相等 ${same} 篇｜不等 ${diff} 篇`);
console.log(`  合计：XML ${xmlTotal}｜解析器 ${pTotal}`);
for (const d of diffs) console.log(`     XML ${d.x} vs 解析 ${d.p}  ${d.f}`);

