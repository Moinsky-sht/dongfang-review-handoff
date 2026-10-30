/**
 * 断句审计：把**全语料**的句子用 `splitSentences()` 切出来，统计「切错」的模式。
 *
 * 目的不是再写一套断句，而是先拿到**证据**：现在的断句到底错在哪、错多少。
 * 关注四类可疑切分：
 *   ① 段首是小写拉丁字母（`lowerStart`）—— 多半是把英文句中的缩写
 *      （et al. / No. / pp. / cf. / ed.）当成了句末，切出了半截。
 *   ② 段首是**收尾标点/引号**（`closeStart`）—— 说明句末标点在引号内，
 *      收尾引号被甩到了下一段（`。”` / `？」` 这种）。
 *   ③ 整段只有标点、没有文字（`punctOnly`）。
 *   ④ 段落里含换行（`\n`，来自 `w:br`）却没被切开的句子。
 *
 * 用法：node tools/audit-sentences.mjs [--examples=20]
 */
import fs from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { splitSentences } from '../src/scanner-language.js';
import { CORPUS_ROOT } from './paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d; };
const N_EX = argOf('--examples', 20);

function walk(dir, acc = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name.startsWith('.')) continue; walk(p, acc); }
    else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}

const CLOSE = new Set(['。', '，', '、', '；', '：', '！', '？', '）', '」', '』', '”', '’', '】', '》', '.', ',', '!', '?', ';', ':', ')', ']', '}']);
const LATIN_ABBR = /\b(?:et\s+al|No|Nos|pp|p|cf|ed|eds|vol|vols|ch|fig|Figs|vs|etc|Mr|Mrs|Ms|Dr|St|Jr|Sr|al)\.$/i;

const stat = {
  docs: 0, paragraphs: 0, segments: 0,
  lowerStart: 0, closeStart: 0, punctOnly: 0,
  paraWithNewline: 0, semicolonCount: 0, ellipsisCount: 0,
  emptySeg: 0,
};
const examples = { lowerStart: [], closeStart: [], newline: [] };
const abbrCounter = new Map();

function note(store, obj) { if (store.length < N_EX) store.push(obj); }

for (const f of walk(CORPUS_ROOT)) {
  let doc;
  try { doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f)); } catch { continue; }
  stat.docs += 1;
  const texts = [];
  for (const p of doc.paragraphs) if (p.text.trim()) texts.push(p.text);
  for (const p of doc.footnotes) if (p.text.trim()) texts.push(p.text);
  for (const t of texts) {
    stat.paragraphs += 1;
    if (t.includes('\n')) {
      stat.paraWithNewline += 1;
      const parts = t.split('\n').filter((x) => x.trim());
      if (parts.length > 1 && !/[。！？；]/.test(t)) note(examples.newline, { f: path.basename(f), text: t.slice(0, 100) });
    }
    stat.semicolonCount += (t.match(/；/g) || []).length;
    stat.ellipsisCount += (t.match(/……/g) || []).length;
    const segs = splitSentences(t);
    let prevSeg = '';
    for (const s of segs) {
      const trimmed = s.trim();
      if (!trimmed) { stat.emptySeg += 1; prevSeg = trimmed; continue; }
      stat.segments += 1;
      const first = trimmed[0];
      // ① 小写拉丁字母打头
      if (/[a-z]/.test(first)) {
        stat.lowerStart += 1;
        note(examples.lowerStart, { f: path.basename(f), prev: prevSeg.slice(-34), seg: trimmed.slice(0, 70) });
      }
      // ② 收尾标点/引号打头
      if (CLOSE.has(first)) {
        stat.closeStart += 1;
        note(examples.closeStart, { f: path.basename(f), prev: prevSeg.slice(-34), seg: trimmed.slice(0, 70) });
      }
      // ③ 纯标点
      if (!/[0-9A-Za-z\u3400-\u9FFF]/.test(trimmed)) stat.punctOnly += 1;
      prevSeg = trimmed;
    }
  }
}

const payload = { generatedAt: new Date().toISOString(), ...stat, examples };
fs.mkdirSync(join(ROOT, 'data', 'verify'), { recursive: true });
fs.writeFileSync(join(ROOT, 'data', 'verify', 'audit-sentences.json'), JSON.stringify(payload, null, 2), 'utf8');

const pct = (n) => `${((n / (stat.segments || 1)) * 100).toFixed(2)}%`;
console.log('═══ 断句审计（全语料） ═══');
console.log(`稿件 ${stat.docs} 篇｜段落/脚注 ${stat.paragraphs} 个｜切出句子 ${stat.segments} 句`);
console.log(`① 段首小写拉丁字母（疑似英文缩写误切）：${stat.lowerStart} 句（${pct(stat.lowerStart)}）`);
console.log(`② 段首是收尾标点/引号（句末标点在引号内）：${stat.closeStart} 句（${pct(stat.closeStart)}）`);
console.log(`③ 纯标点句：${stat.punctOnly} 句｜空句：${stat.emptySeg}`);
console.log(`④ 含换行却没切开的段落：${stat.paraWithNewline} 个`);
console.log(`分号「；」出现：${stat.semicolonCount} 次｜省略号「……」出现：${stat.ellipsisCount} 次`);
for (const key of ['lowerStart', 'closeStart']) {
  console.log(`\n—— ${key} 样例（前一段尾部 → 本段开头）——`);
  for (const e of examples[key]) console.log(`  [${e.f}] …${JSON.stringify(e.prev)} ⟶ ${JSON.stringify(e.seg)}`);
}
console.log(`\n明细：data/verify/audit-sentences.json`);
