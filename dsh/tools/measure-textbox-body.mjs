/**
 * 只查**正文里**的文本框（`word/document.xml` 的 `w:txbxContent`），
 * 排除页眉页脚。
 *
 * ── 为什么要分开 ──
 * 上一版把 `header1-3.xml` / `footer1-3.xml` 一起统计，得出「102 篇有文本框、
 * 45 篇丢失 176 字」。逐条看内容才发现丢的全是**页码与页眉装饰**
 * （`— 1 —— 1 —`、`1616`）—— 那本来就不该进正文，规则也不该扫它。
 * 所以「文本框造成正文丢失」这个说法在当时是**不成立的**，
 * 真正要回答的是：**嵌在正文里的**文本框有没有丢字。
 *
 * 用法：node tools/measure-textbox-body.mjs
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

/** 配对计数抠出 `<w:txbxContent>` 块（可嵌套，非贪婪会提前收口） */
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

function visibleText(xml) {
  return (xml
    .replace(/<w:rPrChange[\s\S]*?<\/w:rPrChange>/g, '')
    .replace(/<w:pPrChange[\s\S]*?<\/w:pPrChange>/g, '')
    .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:del[\s\S]*?<\/w:del>/g, '')
    .match(/<w:t[ >][^<]*<\/w:t>/g) || []
  ).map((x) => x.replace(/<[^>]*>/g, '')).join('');
}

/** 该文本框是否落在正文段落流里（即 `w:drawing` 的祖先链上有 `w:body` 的直接段落） */
const files = walk(ROOT);
console.log(`语料 ${files.length} 篇｜只统计 word/document.xml 里的文本框\n`);

const rows = [];
for (const f of files) {
  let xml = '';
  try { const z = openZip(fs.readFileSync(f)); xml = z.readText('word/document.xml') || ''; } catch { continue; }
  if (!xml.includes('txbxContent')) continue;
  const boxes = textboxBlocks(xml);
  if (!boxes.length) continue;
  const texts = boxes.map(visibleText);
  const boxText = texts.join('');
  let docText = '';
  try { docText = parseDocxBuffer(fs.readFileSync(f), path.basename(f)).paragraphs.map((p) => p.text).join('\n'); } catch { /* */ }
  const flatDoc = docText.replace(/\s+/g, '');
  const perBox = texts.map((t) => {
    const probe = t.replace(/\s+/g, '').slice(0, 30);
    return { chars: t.length, captured: probe.length > 0 && flatDoc.includes(probe), sample: t.replace(/\s+/g, ' ').slice(0, 56) };
  });
  rows.push({
    file: path.basename(f),
    boxes: boxes.length,
    boxChars: boxText.length,
    lostBoxes: perBox.filter((b) => !b.captured).length,
    lostChars: perBox.filter((b) => !b.captured).reduce((s, b) => s + b.chars, 0),
    perBox,
  });
}

rows.sort((a, b) => b.lostChars - a.lostChars);
const withLoss = rows.filter((r) => r.lostChars > 0);
console.log(`正文含文本框的稿件：**${rows.length}** 篇｜文本框 ${rows.reduce((s, r) => s + r.boxes, 0)} 个｜框内文字合计 ${rows.reduce((s, r) => s + r.boxChars, 0)} 字`);
console.log(`其中**有字没抽到**的：**${withLoss.length}** 篇｜丢失合计 **${withLoss.reduce((s, r) => s + r.lostChars, 0)}** 字\n`);
console.log('═══ 逐篇明细 ═══');
console.log('  框数  框内字  丢失字  稿件');
for (const r of rows) {
  console.log(`  ${String(r.boxes).padStart(4)} ${String(r.boxChars).padStart(6)} ${String(r.lostChars).padStart(7)}  ${r.file.slice(0, 46)}`);
}
if (withLoss.length) {
  console.log('\n═══ 丢失内容逐条 ═══');
  for (const r of withLoss) {
    console.log(`\n  ${r.file.slice(0, 50)}`);
    for (const b of r.perBox.filter((x) => !x.captured)) {
      console.log(`    ${String(b.chars).padStart(4)} 字  ${JSON.stringify(b.sample)}`);
    }
  }
}
