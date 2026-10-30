/**
 * 把一份稿件的真实批注逐条列出，并标注智能体是否在对应位置/方面有发现。
 * 用法：node tools/comment-audit.mjs --pick=8
 */
import { parseDocx } from '../src/docx.js';
import { deterministicReview } from '../src/review.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
let file = args.find((a) => !a.startsWith('--'));
const pickOpt = args.find((a) => a.startsWith('--pick='));
const shaOpt = args.find((a) => a.startsWith('--sha='));
if (!file && (pickOpt || shaOpt)) {
  const ROOT = resolve('..', '发给皓天的一审文件');
  const manifest = JSON.parse(readFileSync(resolve('data/corpus/manifest.json'), 'utf8'));
  if (shaOpt) file = join(ROOT, manifest.find((m) => m.sha256 === shaOpt.slice(6)).path);
  else {
    const list = manifest.map((m) => ({ ...m, full: join(ROOT, m.path) }))
      .filter((m) => m.comments >= 25 && existsSync(m.full)).sort((a, b) => b.comments - a.comments);
    file = list[Number(pickOpt.slice(7))].full;
  }
}
const doc = parseDocx(resolve(file));
const det = deterministicReview(doc);

const issueByPara = new Map();
for (const it of det.issues) {
  if (it.paragraphIndex === undefined) continue;
  if (!issueByPara.has(it.paragraphIndex)) issueByPara.set(it.paragraphIndex, []);
  issueByPara.get(it.paragraphIndex).push(it);
}

console.log(`稿件：${file.split(/[\\/]/).pop()}`);
console.log(`批注 ${doc.comments.length} 条 · 段落 ${doc.paragraphs.length} · 智能体问题 ${det.issues.length} 条\n`);

let covered = 0;
let uncovered = 0;
const uncoveredTexts = [];

doc.comments.forEach((c, i) => {
  const text = (c.text || '').trim();
  if (!text) return;
  const pid = c.paragraphIndex ?? c.paraIndex ?? null;
  const para = pid !== null ? doc.paragraphs.find((p) => p.index === pid) : null;
  const hits = pid !== null ? (issueByPara.get(pid) || []) : [];
  const mark = hits.length ? '✓' : '✗';
  if (hits.length) covered += 1; else { uncovered += 1; uncoveredTexts.push(text); }
  console.log(`${mark} [批注${i}] 段落${pid ?? '?'}`);
  console.log(`    批注：${text.replace(/\n/g, ' ').slice(0, 160)}`);
  if (para?.text) console.log(`    原文：${para.text.replace(/\n/g, ' ').slice(0, 140)}`);
  if (hits.length) console.log(`    智能体：${hits.map((h) => `${h.ruleId}(${h.title})`).join('；').slice(0, 160)}`);
  console.log('');
});

console.log(`\n═══ 批注位置覆盖：${covered}/${covered + uncovered} = ${((covered / (covered + uncovered)) * 100).toFixed(0)}% ═══`);
console.log(`\n未被覆盖的批注（前 40 条，即规则库的改进方向）：`);
for (const t of uncoveredTexts.slice(0, 40)) console.log(`  · ${t.replace(/\n/g, ' ').slice(0, 150)}`);
