/** 定位候选基准稿件的实际 docx 路径 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const DIR = resolve('data/corpus/docs');
const ROOT = resolve('..', '发给皓天的一审文件');
const manifest = JSON.parse(readFileSync(resolve('data/corpus/manifest.json'), 'utf8'));
const bySha = new Map();
for (const m of manifest) bySha.set(m.sha256, m);

const rows = [];
for (const f of readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue;
  const sha = f.replace(/\.json$/, '');
  const m = bySha.get(sha);
  if (!m) continue;
  let d;
  try { d = JSON.parse(readFileSync(resolve(DIR, f), 'utf8')); } catch { continue; }
  const paras = d.paragraphs || [];
  const chars = paras.reduce((n, p) => n + [...(p.text || '')].length, 0);
  const full = join(ROOT, m.path);
  rows.push({
    sha, path: m.path, chars,
    comments: (d.comments || []).length,
    exists: existsSync(full),
    full,
    transcript: /现场|论坛|演讲|对话|答问|实录|纪要/.test(m.path),
    footnotes: (d.footnotes || []).length,
  });
}

const cands = rows
  .filter((r) => r.exists && !r.transcript && r.comments >= 25 && r.chars >= 9000 && r.chars <= 45000)
  .sort((a, b) => b.comments - a.comments);

console.log(`符合「研究论文 + 批注≥25 + 9000~45000 字」的候选：${cands.length} 份\n`);
for (const r of cands.slice(0, 15)) {
  console.log(`${String(r.comments).padStart(3)} 批注 | ${String(r.chars).padStart(5)} 字 | ${r.path.slice(0, 76)}`);
}
if (cands.length) {
  console.log('\n最佳基准：');
  console.log(cands[0].full);
}
