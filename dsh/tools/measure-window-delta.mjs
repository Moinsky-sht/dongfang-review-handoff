/**
 * 标题正则收敛的影响度量。
 *
 * `ark.js` 的分窗逻辑原本用一条内联正则判「这一段是不是标题」，
 * 与 `headings.js` 的规范判据不一致。收敛前必须知道**代价**：
 * 判据变宽 → 更多段落算标题 → 窗口在更多位置断开 → 窗口数可能上升
 * → 模型调用次数与费用上升。
 *
 * 本脚本对全语料同时跑两套判据，报窗口数变化。
 *
 * 用法：node tools/measure-window-delta.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { isTextHeading } from '../src/headings.js';
import { CORPUS_ROOT } from './paths.mjs';

const ROOT = CORPUS_ROOT;

/** 旧判据（原样抄自 ark.js，用于对照，不要"顺手改好"——对照物必须保持原样） */
const OLD_RE = /^([一二三四五六七八九十]+[、．.]|[（(][一二三四五六七八九十\d]+[）)]|\d+[．.])/;
const oldIsHeading = (t) => OLD_RE.test(t) && [...t].length < 60;

/**
 * 复刻 `buildWindows`，把判据作为参数注入。
 * 只算窗口数与段落归属，不调模型。
 */
function windows(doc, isHeading, { windowChars = 1500, maxParasPerWindow = 10 } = {}) {
  const paras = doc.paragraphs;
  const out = [];
  let cur = [];
  let size = 0;
  const flush = () => { if (!cur.length) return; out.push(cur); cur = []; size = 0; };
  for (let i = 0; i < paras.length; i += 1) {
    const t = (paras[i].text || '').trim();
    if (!t) continue;
    const len = [...t].length;
    if (len > windowChars) {
      flush();
      out.push([{ index: i }]);
      continue;
    }
    const h = isHeading(t);
    const wouldOverflow = size + len > windowChars || cur.length >= maxParasPerWindow;
    if (wouldOverflow && cur.length) flush();
    cur.push({ index: i });
    size += len;
    if (h && size > windowChars * 0.6) flush();
  }
  flush();
  return out;
}

function walk(dir, acc = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p, acc); }
    else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}

const files = walk(ROOT);
console.log(`语料 ${files.length} 篇\n`);

let same = 0, more = 0, less = 0, fail = 0;
let oldTotal = 0, newTotal = 0;
const deltas = [];
const gainedFiles = [];

for (const f of files) {
  let doc;
  try { doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f)); } catch { fail += 1; continue; }
  const wOld = windows(doc, oldIsHeading);
  const wNew = windows(doc, (t) => !!isTextHeading(t));
  oldTotal += wOld.length;
  newTotal += wNew.length;
  const d = wNew.length - wOld.length;
  deltas.push(d);
  if (d === 0) same += 1;
  else if (d > 0) { more += 1; if (gainedFiles.length < 8) gainedFiles.push({ f: path.basename(f).slice(0, 44), old: wOld.length, neu: wNew.length }); }
  else less += 1;
}

const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return `min=${s[0]} P50=${q(0.5)} P90=${q(0.9)} P99=${q(0.99)} max=${s.at(-1)}`;
};

console.log(`解析失败 ${fail} 篇`);
console.log(`窗口总数：旧 ${oldTotal} → 新 ${newTotal}（${newTotal === oldTotal ? '持平' : ((newTotal - oldTotal) / oldTotal * 100).toFixed(1) + '%'}）`);
console.log(`逐篇差异：不变 ${same}｜变多 ${more}｜变少 ${less}`);
console.log(`差异分布 ${stat(deltas)}`);
if (gainedFiles.length) {
  console.log('\n窗口变多的样例：');
  for (const g of gainedFiles) console.log(`  ${String(g.old).padStart(3)} → ${String(g.neu).padStart(3)}  ${g.f}`);
}

/* 判据本身差在哪 */
console.log('\n── 判据差异（全语料段落级）──');
let onlyNew = 0, onlyOld = 0, both = 0;
const newSamples = [];
const oldSamples = [];
for (const f of files.slice(0, 200)) {
  let doc; try { doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f)); } catch { continue; }
  for (const p of doc.paragraphs) {
    const t = (p.text || '').trim();
    if (!t) continue;
    const o = oldIsHeading(t), n = !!isTextHeading(t);
    if (o && n) both += 1;
    else if (n && !o) { onlyNew += 1; if (newSamples.length < 10) newSamples.push(t.slice(0, 60)); }
    else if (o && !n) { onlyOld += 1; if (oldSamples.length < 12) oldSamples.push(t.slice(0, 70)); }
  }
}
console.log(`两者都判标题 ${both}｜只有新判据判标题 ${onlyNew}｜只有旧判据判标题 ${onlyOld}`);
if (newSamples.length) {
  console.log('\n新判据多认出来的（多为超长标题 —— 旧判据卡了 `<60` 字）：');
  for (const s of newSamples) console.log(`  ${JSON.stringify(s)}`);
}
if (oldSamples.length) {
  console.log('\n⚠️ 只有**旧**判据认出来的（新判据用前瞻守卫排除了）：');
  for (const s of oldSamples) console.log(`  ${JSON.stringify(s)}`);
  console.log('  说明：新判据在各级加了 `(?![0-9])` / `(?!\\d)` 守卫，');
  console.log('  专防「1.2 研究背景」「2020.5.1」这类编号或日期被当成标题。');
  console.log('  这些正是旧判据的**误报**，收敛后应减少而非增加。');
}
