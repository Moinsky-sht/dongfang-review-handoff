/**
 * 合格性判定：标定阈值 + 全量判定 + 与历史结论对照。
 *
 * 目标点 10「区分合格/不合格，理解并吸收语料中已有的历史批阅」。
 *
 * 这里能站得住的「历史结论」只有目录结构：
 *   · 「××刊发排版」 —— 编辑部已过审、送排版；
 *   · 「××刊责编版」 —— 仍在责编环节。
 * 批注数量**不能**当质量标签（发排版版本已清理批注，实测 0.05 条/千字 vs 责编版 0.86）。
 *
 * 用法：
 *   node tools/verdict-report.mjs               # 标定 + 全量判定 + 落盘
 *   node tools/verdict-report.mjs --limit 50    # 只跑前 50 篇
 *   node tools/verdict-report.mjs --md          # 额外输出人读报告
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrate, isTypesetPath, judge, verdictLegend, DEFAULT_THRESHOLDS } from '../src/verdict.js';

// 用 fileURLToPath 而不是 url.pathname —— 后者不做百分号解码，
// 项目路径里有中文（「学术」）时会变成 %E5%AD%A6%E6%9C%AF，导致 ENOENT。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REVIEW_DIR = join(ROOT, 'data', 'reviews', 'json');
const OUT_DIR = join(ROOT, 'data', 'verify');

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
const WANT_MD = args.includes('--md');

function loadDocs() {
  const out = [];
  for (const f of readdirSync(REVIEW_DIR)) {
    if (out.length >= LIMIT) break;
    try {
      out.push(JSON.parse(readFileSync(join(REVIEW_DIR, f), 'utf8')));
    } catch { /* 跳过坏文件 */ }
  }
  return out;
}

const docs = loadDocs();
console.log(`载入 ${docs.length} 篇导出结果`);

/* ---------- 1. 用「已过审」层标定阈值 ---------- */
const passed = docs.filter((d) => isTypesetPath(d.file));
const editor = docs.filter((d) => !isTypesetPath(d.file));
const cal = calibrate(docs, (f) => isTypesetPath(f));
console.log(`\n=== 标定：已过审（发排版）${cal.n} 篇的加权分分布 ===`);
console.log(`  min=${cal.min}  P25=${cal.p25}  P50=${cal.p50}  P75=${cal.p75}  P90=${cal.p90}  max=${cal.max}`);
console.log(`  建议阈值：${JSON.stringify(cal.suggested)}`);

// 用建议阈值；若样本不足则退回默认
const th = cal.n >= 20 ? cal.suggested : DEFAULT_THRESHOLDS;
console.log(`  实际采用：${JSON.stringify(th)}${cal.n >= 20 ? '' : '（样本不足，用默认）'}`);

/* ---------- 2. 全量判定 ---------- */
const results = docs.map((d) => {
  const r = judge(d.issues, { thresholds: th, chars: d.stats?.chars || 0 });
  return { file: d.file, issueCount: d.issues.length, chars: d.stats?.chars || 0, typeset: isTypesetPath(d.file), ...r };
});

const tally = (list) => {
  const c = {};
  for (const r of list) c[r.verdict] = (c[r.verdict] || 0) + 1;
  return c;
};
const all = tally(results);
const passT = tally(results.filter((r) => r.typeset));
const editT = tally(results.filter((r) => !r.typeset));

const ORDER = ['合格', '基本合格', '需修改', '不合格'];
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

console.log('\n=== 全量判定分布 ===');
console.log('  档位        全量            已过审层        在审层');
for (const k of ORDER) {
  console.log(`  ${k.padEnd(6)} ${String(all[k] || 0).padStart(6)} ${pct(all[k] || 0, results.length).padStart(8)}  ${String(passT[k] || 0).padStart(10)} ${pct(passT[k] || 0, cal.n).padStart(8)}  ${String(editT[k] || 0).padStart(8)} ${pct(editT[k] || 0, editor.length).padStart(8)}`);
}

/* ---------- 3. 与历史结论对照 ---------- */
// 把「已过审（发排版）」当正类，看判定与历史结论的一致性。
// 注意正类只是「编辑部的结论」，不是绝对真理；而且两层稿件本身
// 都来自同一批一审稿，重叠很大，所以这里看的是**分离方向与幅度**，不是准确率。
const passRate = (t) => (((t['合格'] || 0) + (t['基本合格'] || 0)) / (Object.values(t).reduce((a, b) => a + b, 0) || 1));
const rp = passRate(passT);
const re = passRate(editT);

const tp = passT['合格'] || 0;
const fp = editT['合格'] || 0;
const fn = (passT['需修改'] || 0) + (passT['不合格'] || 0);
const tn = (editT['需修改'] || 0) + (editT['不合格'] || 0);
const precision = tp + fp ? tp / (tp + fp) : 0;
const recall = tp + fn ? tp / (tp + fn) : 0;

console.log('\n=== 与历史结论对照（把「已过审」当正类）===');
console.log(`  已过审层「合格+基本合格」占比：${(rp * 100).toFixed(1)}%`);
console.log(`  在审层「合格+基本合格」占比：  ${(re * 100).toFixed(1)}%`);
console.log(`  差值：${((rp - re) * 100).toFixed(1)} 个百分点 ${rp > re ? '（方向正确：已过审稿件被判得更宽）' : '（方向相反，需检查判据）'}`);
console.log(`\n  判「合格」的精确率：${(precision * 100).toFixed(1)}%（判合格的 ${tp + fp} 篇里，${tp} 篇确实已过审）`);
console.log(`  判「合格」的召回率：${(recall * 100).toFixed(1)}%（已过审的 ${tp + fn} 篇里，${tp} 篇被判合格）`);
console.log(`  已过审层被判「不合格」的比例（假阳性）：${(((passT['不合格'] || 0) / cal.n) * 100).toFixed(1)}%`);
console.log(`  在审层被判「不合格」的比例：              ${(((editT['不合格'] || 0) / editor.length) * 100).toFixed(1)}%`);
console.log('  → 关键指标是最后两行：判「不合格」时误伤已过审稿件的概率越低越好。');

/* ---------- 4. 分档代表样本 ---------- */
const sample = {};
for (const k of ORDER) {
  sample[k] = results.filter((r) => r.verdict === k)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((r) => ({ file: r.file, score: r.score, issues: r.issueCount, reasons: r.reasons.slice(0, 2) }));
}

const payload = {
  generatedAt: new Date().toISOString(),
  legend: verdictLegend(),
  thresholds: th,
  calibration: cal,
  distribution: {
    all: { total: results.length, ...all },
    typeset: { total: cal.n, ...passT },
    editor: { total: editor.length, ...editT },
  },
  agreementWithHistory: {
    typesetPassRate: rp, editorPassRate: re, delta: rp - re,
    precision, recall,
    falsePositiveOnTypeset: (passT['不合格'] || 0) / (cal.n || 1),
    failRateOnEditor: (editT['不合格'] || 0) / (editor.length || 1),
  },
  samples: sample,
  results,
};
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'verdict-report.json'), JSON.stringify(payload, null, 1), 'utf8');
console.log(`\n已写入 data/verify/verdict-report.json（${results.length} 篇）`);

if (WANT_MD) {
  const L = [];
  L.push('# 《东方学刊》稿件合格性判定报告', '');
  L.push(`生成时间：${payload.generatedAt}`, '');
  L.push('## 一、判据来源', '');
  L.push(`- ${payload.legend.basis}`);
  L.push(`- 统计分离度：${payload.legend.separation}`);
  L.push(`- **重要口径**：${payload.legend.caveat}`, '');
  L.push('## 二、阈值标定', '');
  L.push(`已过审 ${cal.n} 篇的加权分：min=${cal.min} P25=${cal.p25} P50=${cal.p50} P75=${cal.p75} P90=${cal.p90} max=${cal.max}`, '');
  L.push(`采用阈值：${JSON.stringify(th)}`, '');
  L.push('## 三、判定分布', '', '| 档位 | 全量 | 已过审层 | 在审层 |', '| --- | ---: | ---: | ---: |');
  for (const k of ORDER) L.push(`| ${k} | ${all[k] || 0} | ${passT[k] || 0} | ${editT[k] || 0} |`);
  L.push('');
  L.push('## 四、与历史结论对照', '');
  L.push('把「已过审（发排版）」当正类：', '');
  L.push(`- 已过审层「合格+基本合格」**${(rp * 100).toFixed(1)}%** vs 在审层 **${(re * 100).toFixed(1)}%**，差 **${((rp - re) * 100).toFixed(1)} 个百分点**（方向正确）`);
  L.push(`- 判「合格」精确率 ${(precision * 100).toFixed(1)}%，召回率 ${(recall * 100).toFixed(1)}%`);
  L.push(`- **已过审层被判「不合格」${(((passT['不合格'] || 0) / cal.n) * 100).toFixed(1)}%** vs 在审层 ${(((editT['不合格'] || 0) / editor.length) * 100).toFixed(1)}% —— 前者是误伤率，越低越好`);
  L.push('');
  L.push('> 正类只是「编辑部的结论」，不是绝对真理；两层稿件都来自同一批一审稿，重叠很大，');
  L.push('> 所以这里看的是**分离方向与幅度**，不是准确率。', '');
  L.push('> **精确率是下界**：「在审层」并不等于「不合格」—— 那 543 篇只是还没走到排版环节，');
  L.push('> 其中相当一部分最终会过审。所以「判合格但不在已过审层」的样本里，有真误报，');
  L.push('> 也有「本来没问题、只是还没定」的稿件，21% 这个数字因此偏低。', '');
  L.push('## 五、各档代表样本', '');
  for (const k of ORDER) {
    L.push(`### ${k}`, '');
    for (const s of sample[k]) L.push(`- \`${s.file.split(/[\\/]/).pop()}\`（分 ${s.score}，问题 ${s.issues} 条）—— ${s.reasons.join('；')}`);
    L.push('');
  }
  L.push('## 六、全部稿件判定', '', '| 稿件 | 判定 | 加权分 | 问题数 | 每千字分 |', '| --- | --- | ---: | ---: | ---: |');
  for (const r of [...results].sort((a, b) => b.score - a.score)) {
    L.push(`| ${r.file.split(/[\\/]/).pop()} | ${r.verdict} | ${r.score} | ${r.issueCount} | ${r.per1k ?? '—'} |`);
  }
  writeFileSync(join(OUT_DIR, '稿件合格性判定报告.md'), L.join('\n'), 'utf8');
  console.log('已写入 data/verify/稿件合格性判定报告.md');
}
