/**
 * 文本框（`w:txbxContent`）内容损失的度量。
 *
 * ── 为什么这是**内容丢失**而不是格式丢失 ──
 * Word 的文本框把文字放在 `<w:txbxContent>` 里，而它嵌在 `<w:drawing>` /
 * `<w:pict>` 内部。我们的 `pushPara` 只遍历 `w:p` 与 `w:tbl`，从不进入
 * `w:drawing`，所以**框里的文字对规则引擎完全不可见** ——
 * 不是"格式没识别"，是"正文内容凭空少了"。
 *
 * 已知受害者：`02-吴子枫` 的 `FMT-027` 目标文本在 DOM 里找不到，
 * 就是这个原因（当时以为是 docx-preview 的限制，其实是我们没抽出来）。
 *
 * 本脚本逐篇量出：文本框里有多少字、这些字我们当前抽到没有。
 *
 * 用法：node tools/measure-textbox-loss.mjs [--json 输出路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import { openZip } from '../src/zip.js';
import { parseDocxBuffer } from '../src/docx.js';
import { CORPUS_ROOT } from './paths.mjs';

const ROOT = CORPUS_ROOT;
const args = process.argv.slice(2);
const getArg = (k, d = null) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const JSON_OUT = getArg('--json', null);

function walk(dir, acc = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name.startsWith('.')) continue; walk(p, acc); }
    else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}

/**
 * 从原始 XML 里抠出所有 `<w:txbxContent>` 块，再取其内部可见文本。
 * 用**配对计数**而不是非贪婪正则：文本框可以嵌套，非贪婪会提前收口。
 */
function textboxBlocks(xml) {
  const out = [];
  const open = /<w:txbxContent(?:\s[^>]*)?>/g;
  let m;
  while ((m = open.exec(xml))) {
    let depth = 1;
    const start = m.index + m[0].length;
    const re = /<w:txbxContent(?:\s[^>]*)?>|<\/w:txbxContent>/g;
    re.lastIndex = start;
    let end = -1, mm;
    while ((mm = re.exec(xml))) {
      if (mm[0].startsWith('</')) { depth -= 1; if (depth === 0) { end = mm.index; break; } }
      else depth += 1;
    }
    if (end < 0) continue;
    out.push(xml.slice(start, end));
    open.lastIndex = end;
  }
  return out;
}

/** 取一段 XML 里的可见文本（跳过域指令与已删除修订） */
function visibleText(xml) {
  return (xml
    .replace(/<w:rPrChange[\s\S]*?<\/w:rPrChange>/g, '')
    .replace(/<w:pPrChange[\s\S]*?<\/w:pPrChange>/g, '')
    .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:del[\s\S]*?<\/w:del>/g, '')
    .replace(/<w:delText[\s\S]*?<\/w:delText>/g, '')
    .match(/<w:t[ >][^<]*<\/w:t>/g) || []
  ).map((x) => x.replace(/<[^>]*>/g, '')).join('');
}

const files = walk(ROOT);
console.log(`语料 ${files.length} 篇\n`);

const rows = [];
for (const f of files) {
  let boxText = '', boxCount = 0, boxParas = 0;
  try {
    const z = openZip(fs.readFileSync(f));
    for (const part of ['word/document.xml', 'word/header1.xml', 'word/header2.xml', 'word/header3.xml',
      'word/footer1.xml', 'word/footer2.xml', 'word/footer3.xml']) {
      const xml = z.readText(part) || '';
      if (!xml || !xml.includes('txbxContent')) continue;
      for (const b of textboxBlocks(xml)) {
        boxCount += 1;
        const t = visibleText(b);
        boxParas += (b.match(/<w:p[ >]/g) || []).length;
        boxText += t;
      }
    }
  } catch { continue; }
  if (!boxCount) continue;

  let docChars = 0, docText = '';
  try {
    const doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f));
    docText = doc.paragraphs.map((p) => p.text).join('\n');
    docChars = docText.length;
  } catch { /* 忽略 */ }

  /**
   * 我们抽到了没有：文本框文字若已进正文，它必然出现在 docText 里。
   * 用前 40 字做子串检查（文本框内可能有换行/制表差异，故取较短的头部）。
   */
  const probe = boxText.replace(/\s+/g, '').slice(0, 40);
  const flatDoc = docText.replace(/\s+/g, '');
  const captured = probe.length > 0 && flatDoc.includes(probe);

  rows.push({
    file: path.basename(f),
    boxes: boxCount, boxParas,
    boxChars: boxText.length,
    docChars,
    captured,
    sample: boxText.replace(/\s+/g, ' ').slice(0, 70),
  });
}

rows.sort((a, b) => b.boxChars - a.boxChars);
const lost = rows.filter((r) => !r.captured);
console.log(`含文本框的稿件：**${rows.length}** 篇｜文本框合计 ${rows.reduce((s, r) => s + r.boxes, 0)} 个`);
console.log(`其中文字**没被抽到**的：**${lost.length}** 篇`);
console.log(`丢失字数合计：**${lost.reduce((s, r) => s + r.boxChars, 0)}** 字\n`);
console.log('═══ 逐篇明细（按框内字数降序）═══');
console.log('  状态    框数  框内字数  正文字数  稿件');
for (const r of rows) {
  console.log(`  ${(r.captured ? '已抽到' : '❌丢失').padEnd(6)} ${String(r.boxes).padStart(4)} ${String(r.boxChars).padStart(9)} ${String(r.docChars).padStart(9)}  ${r.file.slice(0, 44)}`);
}
if (lost.length) {
  console.log('\n═══ 丢失内容样例 ═══');
  for (const r of lost.slice(0, 6)) console.log(`  ${String(r.boxChars).padStart(5)} 字  ${JSON.stringify(r.sample)}`);
}
if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 1));
  console.log(`\n明细已写入 ${JSON_OUT}`);
}
