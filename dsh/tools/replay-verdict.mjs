/**
 * 用**真实代码**复算那 25 篇采样稿件的判定 —— 验证 verdict 修复是否生效。
 *
 * 关键：只跑规则引擎（`deterministicReview`），不重跑模型。
 * 判定分数本来就该只用规则问题，所以规则引擎的输出足够复算判定，
 * 不必再花 88 分钟调模型。模型部分另有 `.verdict-calib2.json` 的实测记录。
 *
 * 对照：修复前 `judge(deduped)` 对这 25 篇是 **25/25 全判「不合格」**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { deterministicReview, VERDICT_THRESHOLDS } from '../src/review.js';
import { judge } from '../src/verdict.js';
import { ACADEMIC_ROOT } from './paths.mjs';

const ROOT = ACADEMIC_ROOT;
const calib = JSON.parse(fs.readFileSync('tools/.verdict-calib2.json', 'utf8'));

/* 用采样记录里的文件名反查真实路径 */
function walk(dir, acc = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === '.adv') continue; walk(p, acc); }
    else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}
const all = walk(ROOT);
const byName = new Map();
for (const f of all) {
  const b = path.basename(f);
  if (!byName.has(b)) byName.set(b, f);
}

const rows = [];
for (const c of calib) {
  const f = byName.get(c.file);
  if (!f) { console.log(`找不到 ${c.file}`); continue; }
  let doc;
  try { doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f)); } catch (e) { console.log(`解析失败 ${c.file}`); continue; }
  const det = deterministicReview(doc);
  const v = judge(det.issues, {
    thresholds: VERDICT_THRESHOLDS,
    chars: doc.stats?.chars || 0,
    modelIssues: [],   // 复算只需要判定本身
  });
  rows.push({ set: c.set, file: c.file, oldScore: c.allScore, oldVerdict: c.verdict, newScore: v.score, newPer1k: v.per1k, newVerdict: v.verdict, ruleCount: det.issues.length });
}

console.log('\n════════ 修复前后对照 ════════');
let oldFail = 0, newFail = 0;
for (const set of ['TUNE', 'HOLDA', 'HOLDB']) {
  const g = rows.filter((r) => r.set === set);
  if (!g.length) continue;
  console.log(`\n── ${set}（${g.length} 篇）──`);
  for (const r of g) {
    const mark = r.newVerdict === '不合格' ? '✗' : '✓';
    console.log(`  ${mark} ${r.file.slice(0, 32).padEnd(34)} 修复前 ${String(r.oldScore).padStart(6)} 分 ${r.oldVerdict}  →  修复后 ${String(r.newScore).padStart(5)} 分 ${r.newVerdict}`);
  }
}
for (const r of rows) { if (r.oldVerdict === '不合格') oldFail += 1; if (r.newVerdict === '不合格') newFail += 1; }
console.log(`\n修复前「不合格」：${oldFail}/${rows.length}`);
console.log(`修复后「不合格」：${newFail}/${rows.length}`);
const tune = rows.filter((r) => r.set === 'TUNE');
console.log(`其中 TUNE（已发排定稿，${tune.length} 篇）修复后不合格：${tune.filter((r) => r.newVerdict === '不合格').length} 篇`);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const ts = tune.map((r) => r.newScore);
const hs = rows.filter((r) => r.set === 'HOLDA').map((r) => r.newScore);
console.log(`TUNE  分数 P50=${q(ts, 0.5)} P90=${q(ts, 0.9)} max=${Math.max(...ts)}`);
if (hs.length) console.log(`HOLDA 分数 P50=${q(hs, 0.5)} P90=${q(hs, 0.9)} max=${Math.max(...hs)}`);
fs.writeFileSync('tools/.verdict-replay.json', JSON.stringify(rows, null, 1));
