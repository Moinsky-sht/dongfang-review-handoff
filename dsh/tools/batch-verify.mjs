/**
 * 批量验证：对语料中的大量真实稿件跑完整「解析 → 三类规则扫描 → 汇总」链路。
 *
 * 目的：发现单篇测试发现不了的异常——解析崩溃、正则回溯爆炸、规则在某类稿件上
 * 刷屏式误报、极端稿件导致性能塌陷等。
 *
 * 用法：
 *   node tools/batch-verify.mjs                 # 全量（659 份）
 *   node tools/batch-verify.mjs --limit=50      # 只跑前 50 份
 *   node tools/batch-verify.mjs --sample=100    # 均匀抽样 100 份
 *   node tools/batch-verify.mjs --concurrency=6
 *   node tools/batch-verify.mjs --json=data/verify/batch.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { loadCorpusList, mapCorpus } from './lib/corpus.mjs';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const LIMIT = Number(flag('limit', 0)) || 0;
const SAMPLE = Number(flag('sample', 0)) || 0;
const CONCURRENCY = Number(flag('concurrency', 0)) || 0;
const JSON_OUT = flag('json', 'data/verify/batch.json');
const MD_OUT = flag('md', 'data/verify/batch.md');

const { list: allDocs, legacy, missing, total: manifestTotal } = loadCorpusList();
let list = allDocs;

if (SAMPLE > 0) {
  const step = Math.max(1, Math.floor(list.length / SAMPLE));
  const picked = [];
  for (let i = 0; i < list.length && picked.length < SAMPLE; i += step) picked.push(list[i]);
  list = picked;
} else if (LIMIT > 0) {
  list = list.slice(0, LIMIT);
}

const THREADS = CONCURRENCY || undefined;
console.log(`语料清单 ${manifestTotal} 份，文件存在 ${manifestTotal - missing} 份${missing ? `（缺失 ${missing}）` : ''}`);
console.log(`其中旧版 .doc（OLE2）${legacy.length} 份，本系统不支持，已单独归类`);
console.log(`本次验证 ${list.length} 份 .docx，并发 ${THREADS || '默认（按核数）'}\n`);

const tStart = Date.now();
const raw = await mapCorpus(list, 'batch', {
  threads: THREADS,
  onProgress: (done, total) => { if (done % 25 === 0 || done === total) process.stdout.write(`  进度 ${done}/${total}\r`); },
});
const elapsed = (Date.now() - tStart) / 1000;
process.stdout.write('\n');

const results = raw.map((msg, i) => {
  const item = list[i];
  const base = { index: i, name: basename(item.path), path: item.path, season: item.season, comments: item.comments };
  if (msg && msg.result) return { ...base, ...msg.result };
  return { ...base, ok: false, stage: (msg && msg.stage) || 'parse', error: msg && msg.error, stack: msg && msg.stack };
});

const ok = results.filter((r) => r?.ok);
const bad = results.filter((r) => r && !r.ok);
const errByName = {};
for (const b of bad) {
  const key = `${b.stage} | ${b.error}`;
  (errByName[key] ||= []).push(b.name);
}

/* ---- 统计 ---- */
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const nums = (arr, f) => arr.map(f).filter((x) => typeof x === 'number').sort((a, b) => a - b);
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);

const ruleTotals = {};
for (const r of ok) for (const [k, v] of r.byRule || []) ruleTotals[k] = (ruleTotals[k] || 0) + v;
const ruleHits = {};
for (const r of ok) for (const [k] of r.byRule || []) ruleHits[k] = (ruleHits[k] || 0) + 1;

const reviewMs = nums(ok, (r) => r.reviewMs);
const parseMs = nums(ok, (r) => r.parseMs);
const perMs = nums(ok, (r) => r.ms);

const worst = [...ok].sort((a, b) => b.total - a.total).slice(0, 12);
const slowest = [...ok].sort((a, b) => b.ms - a.ms).slice(0, 10);

const L = [];
L.push('# 批量验证报告', '');
L.push(`- 运行时间：${new Date().toLocaleString('zh-CN')}`);
L.push(`- 语料清单：${manifestTotal} 份；文件存在 ${manifestTotal - missing} 份${missing ? `（缺失 ${missing}）` : ''}`);
L.push(`- 其中旧版 .doc（OLE2 复合文档）**${legacy.length} 份**，本系统只支持 .docx，已单独归类（不计入崩溃）`);
L.push(`- 本次验证：**${list.length} 份 .docx**，成功 **${ok.length}**，失败 **${bad.length}**`);
L.push(`- 总耗时：${elapsed.toFixed(1)} 秒（并发 ${THREADS || '按核数'}，平均 ${(elapsed / Math.max(1, list.length) * 1000).toFixed(0)} ms/份）`);
L.push('');
L.push('## 一、稳定性');
L.push('');
L.push('| 指标 | 结果 |');
L.push('| --- | --- |');
L.push(`| 解析+扫描成功 | ${ok.length} / ${list.length}（${(ok.length / Math.max(1, list.length) * 100).toFixed(1)}%） |`);
L.push(`| 崩溃 | ${bad.length} |`);
L.push(`| 旧版 .doc 跳过 | ${legacy.length} |`);
L.push(`| 无法定位的问题条目 | ${sum(ok, (r) => r.unlocated)} |`);
L.push(`| 无原文片段的问题条目 | ${sum(ok, (r) => r.noQuote)} |`);
L.push(`| 空操作自动改写（find=replace） | ${sum(ok, (r) => r.noopFix)} |`);
L.push('');
if (legacy.length) {
  L.push('旧版 .doc 文件清单（需在 Word 中另存为 .docx 才能审阅）：');
  L.push('');
  for (const l of legacy) L.push(`- ${l.path}`);
  L.push('');
}
if (bad.length) {
  L.push('### 失败明细');
  L.push('');
  L.push('| 阶段 | 错误 | 份数 | 样例 |');
  L.push('| --- | --- | --- | --- |');
  for (const [k, v] of Object.entries(errByName).sort((a, b) => b[1].length - a[1].length)) {
    const [stage, ...rest] = k.split(' | ');
    L.push(`| ${stage} | ${rest.join(' | ').slice(0, 110)} | ${v.length} | ${v.slice(0, 2).join('；').slice(0, 70)} |`);
  }
  L.push('');
}

L.push('## 二、性能');
L.push('');
L.push('| 阶段 | 中位数 | P90 | P99 | 最大值 |');
L.push('| --- | --- | --- | --- | --- |');
L.push(`| 解析 | ${pct(parseMs, 0.5)} ms | ${pct(parseMs, 0.9)} ms | ${pct(parseMs, 0.99)} ms | ${parseMs[parseMs.length - 1] || 0} ms |`);
L.push(`| 规则扫描 | ${pct(reviewMs, 0.5)} ms | ${pct(reviewMs, 0.9)} ms | ${pct(reviewMs, 0.99)} ms | ${reviewMs[reviewMs.length - 1] || 0} ms |`);
L.push(`| 全流程 | ${pct(perMs, 0.5)} ms | ${pct(perMs, 0.9)} ms | ${pct(perMs, 0.99)} ms | ${perMs[perMs.length - 1] || 0} ms |`);
L.push('');
L.push('最慢 10 份：');
L.push('');
L.push('| 稿件 | 段落 | 全流程 | 扫描 | 问题数 |');
L.push('| --- | --- | --- | --- | --- |');
for (const r of slowest) L.push(`| ${r.name.slice(0, 46)} | ${r.paragraphs} | ${r.ms} ms | ${r.reviewMs} ms | ${r.total} |`);
L.push('');

L.push('## 三、问题产出分布');
L.push('');
const totals = nums(ok, (r) => r.total);
L.push(`- 每份问题数：中位数 **${pct(totals, 0.5)}**，P90 ${pct(totals, 0.9)}，P99 ${pct(totals, 0.99)}，最大 ${totals[totals.length - 1] || 0}`);
L.push(`- 每份字数：中位数 ${pct(nums(ok, (r) => r.chars), 0.5)}，最大 ${nums(ok, (r) => r.chars).slice(-1)[0] || 0}`);
L.push(`- 合计问题：格式 ${sum(ok, (r) => r.format)} / 语言 ${sum(ok, (r) => r.language)} / 引文 ${sum(ok, (r) => r.citation)}`);
L.push('');
L.push('问题最多的 12 份（可能的刷屏式误报，需人工抽查）：');
L.push('');
L.push('| 稿件 | 段落 | 合计 | 格式 | 语言 | 引文 | 主要规则 |');
L.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of worst) {
  L.push(`| ${r.name.slice(0, 40)} | ${r.paragraphs} | ${r.total} | ${r.format} | ${r.language} | ${r.citation} | ${(r.byRule || []).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ')} |`);
}
L.push('');

L.push('## 四、各规则命中情况');
L.push('');
L.push('| 规则 | 命中总次数 | 命中稿件数 | 命中率 | 平均每命中稿 |');
L.push('| --- | --- | --- | --- | --- |');
for (const [k, v] of Object.entries(ruleTotals).sort((a, b) => b[1] - a[1])) {
  const h = ruleHits[k] || 1;
  L.push(`| ${k} | ${v} | ${h} | ${(h / Math.max(1, ok.length) * 100).toFixed(1)}% | ${(v / h).toFixed(1)} |`);
}
L.push('');
L.push('从未命中的规则（可能是死规则或条件过严）：');
L.push('');
const neverHit = [];
{
  const allRuleIds = new Set();
  const cfg = JSON.parse(readFileSync(resolve('rules/format-rules.json'), 'utf8'));
  for (const r of cfg.rules) allRuleIds.add(r.id);
  const lcfg = JSON.parse(readFileSync(resolve('rules/language-rules.json'), 'utf8'));
  for (const r of lcfg.rules) allRuleIds.add(r.id);
  const ccfg = JSON.parse(readFileSync(resolve('rules/citation-rules.json'), 'utf8'));
  for (const r of ccfg.rules) allRuleIds.add(r.id);
  for (const id of [...allRuleIds].sort()) if (!ruleTotals[id]) neverHit.push(id);
}
L.push(neverHit.length ? neverHit.join('、') : '（无）');
L.push('');

mkdirSync(dirname(resolve(MD_OUT)), { recursive: true });
writeFileSync(resolve(MD_OUT), L.join('\n'), 'utf8');
mkdirSync(dirname(resolve(JSON_OUT)), { recursive: true });
writeFileSync(resolve(JSON_OUT), JSON.stringify({
  ranAt: new Date().toISOString(),
  total: list.length,
  ok: ok.length,
  failed: bad.length,
  elapsedSec: Number(elapsed.toFixed(1)),
  failures: bad.map((b) => ({ name: b.name, stage: b.stage, error: b.error, stack: b.stack })),
  ruleTotals,
  ruleHits,
  neverHit,
  results: results.filter(Boolean),
}, null, 2), 'utf8');

console.log(`\n\n验证完成：成功 ${ok.length} / 失败 ${bad.length}，耗时 ${elapsed.toFixed(1)} 秒`);
console.log(`报告：${MD_OUT}`);
console.log(`数据：${JSON_OUT}`);
if (bad.length) {
  console.log('\n失败样例：');
  for (const b of bad.slice(0, 10)) console.log(`  [${b.stage}] ${b.name.slice(0, 50)} → ${b.error}`);
}
