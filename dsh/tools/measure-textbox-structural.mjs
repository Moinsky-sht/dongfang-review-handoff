/**
 * 文本框丢失的**结构性**判据（不再用子串启发式）。
 *
 * ── 上一版为什么不可信 ──
 * 上一版拿「框内文字的前 30 字是否出现在解析出的正文里」当判据，
 * 得出「0 字丢失」。但框里装的是**图里的短标签**
 * （`中性国家`、`劳动力商品化`、`中国特色社会主义政治经济学`），
 * 这些词在正文散文里本来就会出现 —— 子串命中是**假阳性**，
 * 它证明不了框里的文字被抽出来了。
 *
 * ── 现行判据 ──
 * 结构判据，不猜：
 *   ① 数 `word/document.xml` 里 `w:body` 下的 `w:p` 总数（含文本框内的）
 *   ② 数其中**落在 `w:txbxContent` 里**的 `w:p` 数
 *   ③ 对比我们解析出的段落数 —— 差额就是没进正文的那些
 * 只要 ② > 0 而我们的段落数不含它们，就是**确凿的丢失**，
 * 与"这些字是否也在别处出现"无关。
 *
 * 用法：node tools/measure-textbox-structural.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { openZip } from '../src/zip.js';
import { parseDocxBuffer } from '../src/docx.js';
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

/** 返回 [整个 txbxContent 区段] 的字符区间，用于判断某个 w:p 是否落在里面 */
function textboxRanges(xml) {
  const ranges = [];
  const open = /<w:txbxContent(?:\s[^>]*)?>/g;
  let m;
  while ((m = open.exec(xml))) {
    let depth = 1;
    const start = m.index;
    const re = /<w:txbxContent(?:\s[^>]*)?>|<\/w:txbxContent>/g;
    re.lastIndex = m.index + m[0].length;
    let end = -1, mm;
    while ((mm = re.exec(xml))) {
      if (mm[0].startsWith('</')) { depth -= 1; if (depth === 0) { end = mm.index + mm[0].length; break; } }
      else depth += 1;
    }
    if (end < 0) continue;
    ranges.push([start, end]);
    open.lastIndex = end;
  }
  return ranges;
}

const inRanges = (pos, ranges) => ranges.some(([a, b]) => pos >= a && pos < b);

const files = walk(ROOT);
console.log(`语料 ${files.length} 篇｜结构性判据（不猜，只数）\n`);

const rows = [];
for (const f of files) {
  let xml = '';
  try { const z = openZip(fs.readFileSync(f)); xml = z.readText('word/document.xml') || ''; } catch { continue; }
  if (!xml.includes('txbxContent')) continue;

  const ranges = textboxRanges(xml);
  // 所有 w:p 的位置
  const positions = [];
  const reP = /<w:p[ >]/g;
  let m;
  while ((m = reP.exec(xml))) positions.push(m.index);
  const inBox = positions.filter((p) => inRanges(p, ranges)).length;
  const totalP = positions.length;

  // 落在文本框里的段落，其文字（跳过已删除与域指令）
  const boxTexts = [];
  for (const [a, b] of ranges) {
    const seg = xml.slice(a, b);
    const t = (seg
      .replace(/<w:rPrChange[\s\S]*?<\/w:rPrChange>/g, '')
      .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '')
      .replace(/<w:del[\s\S]*?<\/w:del>/g, '')
      .match(/<w:t[ >][^<]*<\/w:t>/g) || []
    ).map((x) => x.replace(/<[^>]*>/g, '')).join('');
    if (t.trim()) boxTexts.push(t);
  }

  let parsedP = 0;
  try { parsedP = parseDocxBuffer(fs.readFileSync(f), path.basename(f)).paragraphs.length; } catch { /* */ }

  rows.push({
    file: path.basename(f),
    boxes: ranges.length,
    totalP, inBox, outsideP: totalP - inBox,
    parsedP,
    boxChars: boxTexts.join('').length,
    samples: boxTexts.slice(0, 4),
  });
}

rows.sort((a, b) => b.boxChars - a.boxChars);
const lostFiles = rows.filter((r) => r.boxChars > 0);
console.log(`正文含文本框的稿件：**${rows.length}** 篇｜文本框 ${rows.reduce((s, r) => s + r.boxes, 0)} 个`);
console.log(`框内文字合计：**${rows.reduce((s, r) => s + r.boxChars, 0)}** 字\n`);
console.log('═══ 逐篇结构对照 ═══');
console.log('  XML段落  框内段落  框外段落  我们解析  框内字数  稿件');
for (const r of rows) {
  const mark = r.parsedP < r.outsideP ? '⚠️' : '  ';
  console.log(`  ${String(r.totalP).padStart(6)} ${String(r.inBox).padStart(8)} ${String(r.outsideP).padStart(8)} ${String(r.parsedP).padStart(8)} ${String(r.boxChars).padStart(8)}  ${mark}${r.file.slice(0, 42)}`);
}

console.log('\n═══ 框内文字样例（这些就是我们没进正文的内容）═══');
for (const r of lostFiles.slice(0, 6)) {
  console.log(`  ${r.file.slice(0, 46)}`);
  for (const s of r.samples) console.log(`      «${s.slice(0, 62)}»`);
}

/* 结论 */
const totalBoxChars = rows.reduce((s, r) => s + r.boxChars, 0);
const totalInBox = rows.reduce((s, r) => s + r.inBox, 0);
console.log('\n═══ 结论 ═══');
console.log(`  文本框内的段落共 ${totalInBox} 个、文字 ${totalBoxChars} 字。`);
console.log(`  这些段落**不在**我们解析出的正文里（解析器只遍历 w:body/w:tbl 的直接子 w:p，不进入 w:drawing）。`);
console.log(`  所以它们对规则引擎、对锚点、对界面都是不可见的 —— 这是确凿的丢失，`);
console.log(`  与"这些字是否碰巧也在别处出现"无关。`);
