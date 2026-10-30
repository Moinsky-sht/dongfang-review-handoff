/**
 * LANG-020「重复论述」窗口 W 标定（第 31 轮）。
 *
 * 这个脚本是 LANG-020 **改交模型**的判据来源，留作可复现的证据：
 * 复刻原机械判据（跨段落 24+ 字 n-gram 重复），扫不同窗口 W，
 * 用「编辑痕迹」群体（有修订/批注 vs 无）算 Δ痕迹。
 *
 * 实测结论：W 从 24 扫到 56，**任何取值下 Δ痕迹都是负的**（-5.0 ~ -10.3），
 * 说明「逐字重复」在编辑未动过的稿件上反而更常见，并不指向编辑认为的
 * 「重复论述」。故该机械判据被删除，规则改由模型做语义判断。
 *
 * 用法：node tools/lang020-window-sweep.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { CORPUS_ROOT } from './paths.mjs';

function walk(dir, acc = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name.startsWith('.')) continue; walk(p, acc); }
    else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}

/** 复刻原 LANG-020：返回该稿的「重复段落对」数 */
function dups(paras, W) {
  const grams = new Map();
  paras.forEach((t, pi) => {
    const s = (t || '').replace(/\s/g, '');
    for (let i = 0; i + W <= s.length; i += 6) {
      const g = s.slice(i, i + W);
      if (!grams.has(g)) grams.set(g, []);
      grams.get(g).push(pi);
    }
  });
  const pairs = new Set();
  for (const idxs of grams.values()) {
    const uniq = [...new Set(idxs)];
    if (uniq.length > 1) pairs.add(uniq.slice(0, 2).join('-'));
  }
  return pairs.size;
}

const docs = [];
for (const f of walk(CORPUS_ROOT)) {
  let doc; try { doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f)); } catch { continue; }
  const name = path.basename(f);
  docs.push({
    paras: doc.paragraphs.map((p) => p.text),
    traced: (doc.revisions || []).length > 0 || (doc.comments || []).length > 0,
    approved: /发排版/.test(name),
  });
}
const G = {
  traced: docs.filter((d) => d.traced).length, untraced: docs.filter((d) => !d.traced).length,
  approved: docs.filter((d) => d.approved).length, other: docs.filter((d) => !d.approved).length,
};
const pct = (n, d) => (d ? (n / d) * 100 : 0);
console.log(`traced ${G.traced} / untraced ${G.untraced}｜approved ${G.approved} / other ${G.other}`);
console.log('W   命中篇  dTrace dLayer | traced/untraced% | approved/other%');
for (const W of [24, 28, 32, 36, 40, 48, 56]) {
  const c = { t: 0, u: 0, a: 0, o: 0, docs: 0, hits: 0 };
  for (const d of docs) {
    const n = dups(d.paras, W);
    if (!n) continue;
    c.docs += 1; c.hits += n;
    if (d.traced) c.t++; else c.u++;
    if (d.approved) c.a++; else c.o++;
  }
  const rt = pct(c.t, G.traced), ru = pct(c.u, G.untraced), ra = pct(c.a, G.approved), ro = pct(c.o, G.other);
  console.log(`${String(W).padEnd(4)}${String(c.docs).padStart(5)} ${(rt - ru).toFixed(1).padStart(6)} ${(ro - ra).toFixed(1).padStart(6)} | ${rt.toFixed(1)}/${ru.toFixed(1)} | ${ra.toFixed(1)}/${ro.toFixed(1)}`);
}
