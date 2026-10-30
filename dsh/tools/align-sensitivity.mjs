/**
 * 前端对齐常数的敏感性分析（需求 C）。
 *
 * 被审的四个常数（public/app.js）：
 *   `CHUNK = 6`（分块长度）、`0.6`（命中比例门槛）
 *   `PARA_MATCH_MIN = 8`（正文最低分）、`WINDOW = 16`（前向窗口）
 *
 * ── 方法 ──
 * 用**真实 DOM 文本**（从浏览器 dump 出来的 `#docHost` 段落，含
 * `docx-preview` 内联的脚注引用数字），对照解析器给出的段落文本，
 * 逐个常数做扫描，看对齐结果怎么变。
 *
 * 不用模拟 DOM —— 模拟会把我对"差异从哪来"的假设当成事实，
 * 而真实 DOM 文本才能暴露真实差异。
 *
 * ── 正确性判据 ──
 *   ① 覆盖度：多少正文 DOM 段落被分配了下标
 *   ② 单调性：分配的下标在 DOM 顺序上必须不递减（算法自身的不变量），
 *      出现回退说明游标被带偏 —— 那正是"点问题跳错位置"的成因
 *   ③ 无歧义一致率：DOM 文本与某段解析文本**完全相同**时，
 *      分配的下标必须就是那一段（这是可验证的硬真值）
 *
 * 用法：node tools/align-sensitivity.mjs
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { CORPUS_ROOT } from './paths.mjs';

const WZ = join(CORPUS_ROOT, '13-2026年秋', '2026秋季刊发排版',
  '02-文化-吴子枫-无产阶级专政、共产主义战略和\u201c葛兰西难题\u201d【0801发文脉】.docx');

/* ── 待分析的稿件：每份都要有真实 DOM dump + 对应 docx ── */
const CASES = [
  { label: 'test.docx（18 脚注，单点插入为主）', dom: 'tools/.dom-res.json', docx: 'samples/test.docx' },
  { label: '02-文化-吴子枫（110 脚注，多点插入）', dom: 'tools/.dom-wz.json', docx: WZ },
];

const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * 从 dump 文件里取出 DOM 段落。
 * 浏览器原始回执里结果是资源型（只有 resourceId），所以本脚本只认
 * **已展开**的 `{paras:[...]}`。展开步骤见脚本末尾的说明。
 */
function loadDom(p) {
  const raw = fs.readFileSync(p, 'utf8');
  let j;
  try { j = JSON.parse(raw.slice(raw.indexOf('{'))); } catch { throw new Error(`无法解析 ${p}`); }
  if (Array.isArray(j.paras)) return j;
  if (j.result?.value?.paras) return j.result.value;
  throw new Error(`${p} 里找不到 paras —— 该 dump 是资源型回执，需先用 tabbit resource 展开`);
}

/* ── 复刻 app.js 的打分与对齐，常数参数化 ── */
function makeMatcher(CHUNK, RATIO) {
  const chunkScore = (a, b) => {
    if (!a || !b) return 0;
    let pos = 0, hit = 0;
    for (let i = 0; i < a.length; i += CHUNK) {
      const piece = a.slice(i, i + CHUNK);
      const at = b.indexOf(piece, pos);
      if (at >= 0) { hit += piece.length; pos = at + piece.length; }
    }
    return hit;
  };
  return function paraMatchScore(a, b) {
    if (!a || !b) return 0;
    if (a === b) return a.length + 1000;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    let score = 0;
    if (longer.includes(shorter)) score = shorter.length + 500;
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
    if (pre > score) score = pre;
    const hit = chunkScore(shorter, longer);
    if (hit / Math.max(1, shorter.length) >= RATIO) score = Math.max(score, hit + 300);
    return score;
  };
}

function runCase(cs) {
  const dom = loadDom(cs.dom);
  /**
   * ⚠️ 必须分离「正文段落」与「脚注段落」两个总体。
   * 第一版把 80 条 DOM 段落混在一起算覆盖度，得出 63.8% —— 是假象：
   * 脚注区段落本来就不该匹配正文（它们走 `data-findex` 那条全局路径），
   * 混在一起算会把脚注段落记成"正文对不上"。
   */
  const domBody = dom.paras.filter((p) => p.fi === null || p.fi === undefined);
  const domNote = dom.paras.filter((p) => p.fi !== null && p.fi !== undefined);
  const doc = parseDocxBuffer(fs.readFileSync(cs.docx), 'x.docx');
  const paras = (doc.paragraphs || []).map((p) => normText(p.text));
  const notes = (doc.footnotes || []).map((p) => normText(p.text));

  console.log(`\n${'═'.repeat(74)}`);
  console.log(`═══ ${cs.label}`);
  console.log(`  DOM ${dom.paras.length} 条 = 正文 ${domBody.length} + 脚注 ${domNote.length}`
    + `｜解析器 正文 ${paras.length} + 脚注 ${notes.length}`);
  console.log('═'.repeat(74));

  /** 跑一遍对齐，返回每个正文 DOM 段落分配到的下标 */
  function align({ CHUNK = 6, RATIO = 0.6, MIN = 8, WINDOW = 16 } = {}) {
    const score = makeMatcher(CHUNK, RATIO);
    let pi = 0;
    const out = [];
    for (const item of domBody) {
      const t = normText(item.t);
      if (!t) { out.push({ t, k: -1 }); continue; }
      let bestK = -1, bestScore = 0;
      const end = Math.min(paras.length, pi + WINDOW);
      for (let k = pi; k < end; k += 1) {
        const s = score(paras[k], t);
        if (s > bestScore) { bestScore = s; bestK = k; }
      }
      if (bestScore >= MIN) { out.push({ t, k: bestK }); pi = bestK + 1; }
      else out.push({ t, k: -1 });
    }
    return out;
  }

  function evaluate(opts) {
    const res = align(opts);
    const assigned = res.filter((r) => r.k >= 0);
    let inversions = 0;
    for (let i = 1; i < assigned.length; i += 1) {
      if (assigned[i].k < assigned[i - 1].k) inversions += 1;
    }
    let unambig = 0, unambigOk = 0;
    for (const r of res) {
      const matches = [];
      for (let k = 0; k < paras.length; k += 1) if (paras[k] === r.t) matches.push(k);
      if (matches.length !== 1) continue;
      unambig += 1;
      if (r.k === matches[0]) unambigOk += 1;
    }
    let agreeWithBrowser = 0, browserTotal = 0;
    res.forEach((r, i) => {
      const bpi = domBody[i]?.pi;
      if (bpi === null || bpi === undefined) return;
      browserTotal += 1;
      if (String(r.k) === String(bpi)) agreeWithBrowser += 1;
    });
    return {
      coverage: assigned.length,
      coveragePct: Math.round((assigned.length / res.length) * 1000) / 10,
      inversions, unambig, unambigOk,
      unambigPct: unambig ? Math.round((unambigOk / unambig) * 1000) / 10 : null,
      agreeWithBrowser, browserTotal,
    };
  }

  const fmt = (r) => `覆盖 ${String(r.coverage).padStart(3)}（${String(r.coveragePct).padStart(5)}%）`
    + `｜回退 ${r.inversions}｜无歧义一致 ${r.unambigOk}/${r.unambig}（${r.unambigPct}%）`;

  console.log('── 基线（现行 CHUNK=6 RATIO=0.6 MIN=8 WINDOW=16）──');
  const base = evaluate({});
  console.log('  ' + fmt(base));
  console.log(`  与浏览器实际结果一致 ${base.agreeWithBrowser}/${base.browserTotal}`
    + `${base.agreeWithBrowser === base.browserTotal ? '（离线复刻忠实，可拿它做扫描）' : '（⚠️ 复刻与实现有出入，结论需谨慎）'}\n`);

  const sweep = (name, key, values, f) => {
    console.log(`── 扫描 ${name} ──`);
    for (const v of values) {
      console.log(`  ${key}=${String(f ? f(v) : v).padStart(2)}  ` + fmt(evaluate({ [key]: v })));
    }
    console.log('');
  };
  sweep('CHUNK（分块长度）', 'CHUNK', [3, 4, 5, 6, 8, 10, 12, 16]);
  sweep('RATIO（命中比例门槛）', 'RATIO', [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], (v) => v.toFixed(1));
  sweep('PARA_MATCH_MIN（正文最低分）', 'MIN', [2, 4, 6, 8, 10, 12, 16]);
  sweep('WINDOW（前向窗口）', 'WINDOW', [1, 2, 4, 8, 12, 16, 20, 24, 32, 64]);
}

for (const cs of CASES) {
  try { runCase(cs); } catch (e) { console.log(`\n跳过 ${cs.label}：${e.message}`); }
}

console.log(`
说明：DOM dump 的取得方式（浏览器真实渲染结果，不是模拟）——
  1. 在应用页面上传稿件，等 #docHost 渲染完成
  2. 提取 [...#docHost.querySelectorAll("p")] 的 textContent / data-pindex / data-findex
  3. 结果是资源型时用 \`tabbit resource --resource <id>\` 展开后存成 {paras:[...]}
`);
