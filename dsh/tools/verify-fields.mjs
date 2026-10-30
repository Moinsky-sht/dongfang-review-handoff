/**
 * 域代码计数与原始 XML 的**逐篇相等性**验证。
 *
 * 判据：活内容里的 `w:fldChar w:fldCharType="begin"` 数
 * （排除 `w:del`/`w:moveFrom` 内的、排除 `mc:Fallback` 内的）
 * 应当等于解析器抽出的 `p.fields` 总数。
 *
 * 注意 `w:instrText` 的数量**不能**当判据 —— 一条指令会被拆成多个
 * `w:instrText` 元素（实测 2453 个元素只对应 469 个域，平均 5.2 个/域）。
 * 早期按元素取"域类型"就是被这个骗了，得出 `TRIEVED`、`CSL`、`YLE`
 * 这类假类型。
 *
 * 用法：node tools/verify-fields.mjs
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

let same = 0, diff = 0, xmlTotal = 0, pTotal = 0;
const diffs = [];
for (const f of walk(ROOT)) {
  let z, doc;
  try { z = openZip(fs.readFileSync(f)); doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f)); } catch { continue; }
  let x = 0;
  for (const part of ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']) {
    const raw = z.readText(part) || '';
    if (!raw) continue;
    const xml = raw.replace(/<w:rPrChange[\s\S]*?<\/w:rPrChange>/g, '').replace(/<w:pPrChange[\s\S]*?<\/w:pPrChange>/g, '');
    const del = rangesOf(xml, ['w:del', 'w:moveFrom']);
    const fb = rangesOf(xml, ['mc:Fallback']);
    // 活内容里的 fldChar begin
    const re = /<w:fldChar[^>]*w:fldCharType="begin"/g;
    let m;
    while ((m = re.exec(xml))) {
      const at = m.index;
      if (del.some(([a, b]) => at >= a && at < b)) continue;
      if (fb.some(([a, b]) => at >= a && at < b)) continue;
      x += 1;
    }
  }
  const p = [...doc.paragraphs, ...doc.footnotes, ...doc.endnotes].reduce((s, q) => s + (q.fields || []).length, 0);
  xmlTotal += x; pTotal += p;
  if (x === p) same += 1;
  else { diff += 1; if (diffs.length < 12) diffs.push({ f: path.basename(f).slice(0, 38), x, p }); }
}
console.log(`逐篇对比「活内容 fldChar begin」vs「解析器 fields」：`);
console.log(`  相等 ${same} 篇｜不等 ${diff} 篇`);
console.log(`  合计：XML ${xmlTotal}｜解析器 ${pTotal}`);
for (const d of diffs) console.log(`     XML ${d.x} vs 解析 ${d.p}  ${d.f}`);

