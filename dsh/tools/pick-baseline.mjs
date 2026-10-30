/** 在语料中挑选「历史批注最丰富」的稿件，作为验收基准（通过 manifest 关联原始路径） */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve('data/corpus/docs');
const manifest = JSON.parse(readFileSync(resolve('data/corpus/manifest.json'), 'utf8'));
const bySha = new Map();
for (const m of manifest) bySha.set(m.sha256, m);

const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const rows = [];
for (const f of files) {
  const sha = f.replace(/\.json$/, '');
  let d;
  try { d = JSON.parse(readFileSync(resolve(DIR, f), 'utf8')); } catch { continue; }
  const m = bySha.get(sha) || {};
  const paras = d.paragraphs || [];
  const comments = d.comments || [];
  const changed = paras.filter((p) => p.changed).length;
  const chars = paras.reduce((n, p) => n + [...(p.text || '')].length, 0);
  rows.push({
    sha,
    path: m.path || '(未在 manifest 中)',
    season: m.season || '',
    chars,
    paragraphs: paras.length,
    comments: comments.length,
    changed,
    revisions: (d.revisions || []).length,
    footnotes: (d.footnotes || []).length,
    score: comments.length * 3 + changed,
  });
}

rows.sort((a, b) => b.score - a.score);
console.log(`共 ${rows.length} 份稿件（manifest ${manifest.length} 条）\n`);
console.log('批注  修订段  脚注   字数  稿件');
for (const r of rows.slice(0, 25)) {
  console.log(`${String(r.comments).padStart(4)}  ${String(r.changed).padStart(5)}  ${String(r.footnotes).padStart(4)}  ${String(r.chars).padStart(5)}  ${r.path.slice(0, 68)}`);
}
console.log(`\n批注总数 ${rows.reduce((n, r) => n + r.comments, 0)} · 修订段总数 ${rows.reduce((n, r) => n + r.changed, 0)}`);

// 找出「批注多 + 修订多」的最佳验收基准
const best = rows.filter((r) => r.comments >= 40 && r.changed >= 20 && r.chars > 8000).slice(0, 6);
console.log('\n【推荐验收基准（批注≥40 且 修订段≥20 且 字数>8000）】');
for (const r of best) console.log(`  ${r.comments} 批注 / ${r.changed} 修订段 / ${r.chars} 字\n    ${r.path}`);
