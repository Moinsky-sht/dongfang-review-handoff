/**
 * 量出全语料的「事实排版规范」——各角色的主流字号 / 加粗 / 字体 / 行距 / 段间距。
 *
 * 用途：格式规范化（清洗后的文档要"标题字号固定、各部分固定、间距规范"）需要一个
 * **目标值**。代码里没有机器可读的规范数值（规范在 `00-体例与规范` 的 PDF 里），
 * 所以先量出 632 份真实稿件里**各角色的主流排版**，作为规范化的目标依据。
 *
 * ⚠️ 这是**语料事实**，不等于期刊的印刷规范——但它反映作者实际遵循的模板，
 * 是可核对、可修正的起点。
 *
 * 只读：不写文档、不改规则库，只落一份统计到 data/verify/format-baseline.json。
 *
 * 用法：node tools/measure-format-baseline.mjs [--docs=200]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocx } from '../src/docx.js';
import { classifyParagraphs } from '../src/scanner-format.js';
import { loadCorpusList } from './lib/corpus.mjs';
import { DSH_ROOT } from './paths.mjs';

const argOf = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? Number(h.split('=')[1]) : d; };
const LIMIT = argOf('docs', 200);

const { list } = loadCorpusList({ docxOnly: true });
const stride = Math.max(1, Math.floor(list.length / LIMIT));
const picked = [];
for (let i = 0; i < list.length && picked.length < LIMIT; i += stride) picked.push(list[i]);

const ROLES = ['title', 'author', 'authorBio', 'abstract', 'keywords', 'heading', 'body', 'funding', 'meta'];
const tally = {};
for (const r of ROLES) tally[r] = { n: 0, bold: 0, size: new Map(), font: new Map(), line: new Map(), before: new Map(), after: new Map() };

const add = (map, k) => { if (k === '' || k == null) k = '（未设置）'; map.set(k, (map.get(k) || 0) + 1); };
const lineKey = (p) => {
  const line = p.properties?.lineRaw;
  const rule = p.properties?.lineRule;
  if (!line) return '';
  if (rule === 'auto' || rule === '') return `auto:${line}（${(Number(line) / 240).toFixed(2)} 倍）`;
  return `${rule}:${line}`;
};

let ok = 0;
let failed = 0;
for (const item of picked) {
  let doc;
  try { doc = parseDocx(item.full); } catch { failed += 1; continue; }
  ok += 1;
  let classified;
  try { classified = classifyParagraphs(doc); } catch { continue; }
  if (classified.nonManuscript) continue;
  const roles = classified.roles;
  doc.paragraphs.forEach((p, i) => {
    const role = roles[i];
    const t = tally[role];
    if (!t) return;
    const text = (p.text || '').trim();
    if (!text) return;
    t.n += 1;
    if (p.format?.bold) t.bold += 1;
    add(t.size, p.format?.sizeHalfPt != null ? String(p.format.sizeHalfPt) : '');
    add(t.font, p.format?.eastAsia || '');
    add(t.line, lineKey(p));
    add(t.before, p.properties?.beforeRaw || '');
    add(t.after, p.properties?.afterRaw || '');
  });
}

const mode = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

console.log(`抽样 ${picked.length} 篇（成功解析 ${ok} / 失败 ${failed}）\n`);
console.log('角色'.padEnd(12) + '段数'.padStart(7) + '  加粗%   主流字号(半磅→pt)      主流字体            主流行距                主流段前/段后');
for (const r of ROLES) {
  const t = tally[r];
  if (!t.n) continue;
  const sz = mode(t.size);
  const szStr = sz.map(([k, c]) => `${k}${k !== '（未设置）' ? `(${Number(k) / 2}pt)` : ''}×${c}`).join(' ');
  const fontStr = mode(t.font).map(([k, c]) => `${k}×${c}`).join(' ');
  const lineStr = mode(t.line).map(([k, c]) => `${k}×${c}`).join(' ');
  const spStr = mode(t.before).concat(mode(t.after)).map(([k, c]) => `${k}×${c}`).join(' ');
  console.log(r.padEnd(12) + String(t.n).padStart(7) + `  ${String((t.bold / t.n * 100).toFixed(0)).padStart(4)}%   `
    + szStr.padEnd(22) + fontStr.padEnd(20) + lineStr.padEnd(24) + spStr);
}

const payload = {
  generatedAt: new Date().toISOString(),
  sampled: picked.length,
  parsed: ok,
  failed,
  roles: Object.fromEntries(ROLES.map((r) => [r, {
    paragraphs: tally[r].n,
    boldPct: tally[r].n ? +(tally[r].bold / tally[r].n * 100).toFixed(1) : null,
    topSize: mode(tally[r].size),
    topFont: mode(tally[r].font),
    topLine: mode(tally[r].line),
    topBefore: mode(tally[r].before),
    topAfter: mode(tally[r].after),
  }])),
};
writeFileSync(join(DSH_ROOT, 'data', 'verify', 'format-baseline.json'), JSON.stringify(payload, null, 2));
console.log('\n产物：data/verify/format-baseline.json');
