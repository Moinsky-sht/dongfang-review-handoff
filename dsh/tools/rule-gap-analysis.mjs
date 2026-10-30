#!/usr/bin/env node
/**
 * 规则库缺口分析（目标点 6/7/12）：模型报了、但规则库里没有对应规则的问题。
 *
 * ## 为什么需要它
 *
 * 8 篇分层模型抽样得出一个关键数字：模型报了 **1397** 条问题，其中
 * **480 条（34.4%）不属于任何已声明规则**（`ruleId` 形如 `ARK-分类名`）。
 *
 * 但那个工具**只存了计数，没存分类名** —— 于是「规则库缺什么」这个问题
 * 当时问不出来。本工具补上这一环：把自拟分类**原样收集并聚合**，
 * 按出现频次排序，直接给出补规则的优先级。
 *
 * ## 判定口径
 *
 * 模型返回的每条 issue 分三类去向：
 *   1. `ruleId` 是本次交给模型的规则号  → 挂到已声明规则（规则库覆盖到了）
 *   2. `ruleId` 是规则库里存在、但没交给模型的号 → **越界引用**（分类可能错）
 *   3. 其余（含空、含 `ARK-`）           → **自拟分类 = 规则库缺口**
 *
 * 第 3 类就是本工具要聚合的对象。同时记录模型给的 `category` 与 `title`，
 * 因为「模型自己起的分类名」比规则号更能说明缺的是哪一类规则。
 *
 * ## 用法
 *
 *   node tools/rule-gap-analysis.mjs --count=4      # 跑 4 篇（约 40 分钟）
 *   node tools/rule-gap-analysis.mjs --reuse        # 复用落盘结果重新聚合
 *
 * 落盘 `data/verify/rule-gap-analysis.json` + `规则库缺口分析.md`。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'verify');
const CORPUS = resolve(ROOT, '..', '发给皓天的一审文件');
const args = process.argv.slice(2);
const flag = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const COUNT = Number(flag('count', 4)) || 4;
const PORT = flag('port', '3210');
const BASE = flag('url', `http://127.0.0.1:${PORT}`);
const REUSE = args.includes('--reuse');
const TIMEOUT_MS = Number(flag('timeout', 2400000)) || 2400000;

/* ---------- 规则集合 ---------- */
const rr = await (await fetch(`${BASE}/api/rules`)).json();
const allRules = [...(rr.format?.rules || []), ...(rr.language?.rules || []), ...(rr.citation?.rules || [])];
const modelRules = allRules.filter((r) => r.status === 'model');
const modelIds = new Set(modelRules.map((r) => r.id));
const allIds = new Set(allRules.map((r) => r.id));
console.log(`规则库 ${allRules.length} 条，其中模型规则 ${modelRules.length} 条`);

/* ---------- 选稿：按段落数分层，与 model-rule-coverage 一致 ---------- */
const manifest = JSON.parse(readFileSync(join(ROOT, 'data/corpus/manifest.json'), 'utf8'));
const docs = Object.values(manifest).filter((m) => (m.path || '').endsWith('.docx') && existsSync(join(CORPUS, m.path)));
const strata = [
  { name: '短稿(≤60段)', test: (p) => p <= 60 },
  { name: '中稿(61—120段)', test: (p) => p > 60 && p <= 120 },
  { name: '长稿(>120段)', test: (p) => p > 120 },
];
const picks = [];
for (const st of strata) {
  const pool = docs.filter((m) => st.test(m.paragraphs || 0));
  if (!pool.length) continue;
  const need = Math.max(1, Math.round(COUNT * (pool.length / docs.length)));
  const step = Math.max(1, Math.floor(pool.length / need));
  const taken = [];
  for (let i = 0; i < pool.length && taken.length < need; i += step) taken.push(pool[i]);
  picks.push(...taken.map((m) => ({ ...m, stratum: st.name })));
}
console.log(`分层抽样：语料 ${docs.length} 篇 → 选 ${picks.length} 篇`);

/* ---------- 逐篇跑模型，收集自拟分类明细 ---------- */
const runs = [];
if (REUSE) {
  const prev = JSON.parse(readFileSync(join(OUT, 'rule-gap-analysis.json'), 'utf8'));
  runs.push(...(prev.runs || []));
  console.log(`--reuse：读入上次 ${runs.length} 篇结果`);
} else {
for (const [i, p] of picks.entries()) {
  const rec = { name: basename(p.path), stratum: p.stratum, paragraphs: p.paragraphs || 0, gaps: [], overflow: [] };
  const t0 = Date.now();
  try {
    const buf = readFileSync(join(CORPUS, p.path));
    const up = await (await fetch(`${BASE}/api/upload?name=${encodeURIComponent(basename(p.path))}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf,
    })).json();
    if (!up.id) { rec.error = '上传失败'; runs.push(rec); continue; }
    await (await fetch(`${BASE}/api/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: up.id, useModel: true, useRecheck: false, async: true }),
    })).json();
    let st = null;
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      st = await (await fetch(`${BASE}/api/review-status?id=${up.id}`)).json();
      if (!st.running) break;
    }
    if (!st || st.running) { rec.error = '超时未完成'; runs.push(rec); continue; }
    if (st.error) { rec.error = `审阅报错：${st.error}`; runs.push(rec); continue; }
    const r = st.result;
    if (!r) { rec.error = '无结果'; runs.push(rec); continue; }

    rec.ruleIssues = r.summary?.ruleBased ?? 0;
    rec.modelIssues = r.summary?.modelBased ?? 0;
    /**
     * 收集自拟分类与越界引用的**明细**（不只是计数）。
     *
     * 这是本工具存在的理由：上一个工具只存了 `syntheticRuleIds: 480`，
     * 于是「缺的是哪一类规则」问不出来。分类名 + 标题 + 摘录三者一起存，
     * 才能人工判断「这是一条新规则，还是已有规则该扩判据」。
     */
    for (const it of r.issues || []) {
      if (it.group !== 'model') continue;
      const id = String(it.ruleId || '');
      const entry = {
        category: String(it.category || '').trim(),
        title: String(it.title || '').trim().slice(0, 60),
        quote: String(it.quote || '').trim().slice(0, 50),
        severity: it.severity || '',
      };
      if (allIds.has(id)) {
        if (!modelIds.has(id)) rec.overflow.push({ ...entry, reportedId: id });
        continue; // 挂到已声明规则的，不算缺口
      }
      rec.gaps.push(entry);
    }
    rec.modelErrors = (r.modelErrors || []).length;
  } catch (err) {
    rec.error = `异常：${err.message}`;
  }
  rec.sec = Number(((Date.now() - t0) / 1000).toFixed(1));
  runs.push(rec);
  console.log(`  ${i + 1}/${picks.length} ${rec.error ? '✗' : '✓'} ${rec.name.slice(0, 36)} — ${rec.sec}s`
    + (rec.error ? `  ${rec.error}` : `  规则 ${rec.ruleIssues} + 模型 ${rec.modelIssues}；**缺口 ${rec.gaps.length} 条**，越界 ${rec.overflow.length} 条`));
}
}

/* ---------- 聚合：按分类名与标题归并 ---------- */
const ok = runs.filter((r) => !r.error);
const totalGaps = ok.reduce((s, r) => s + r.gaps.length, 0);
const totalModel = ok.reduce((s, r) => s + (r.modelIssues || 0), 0);

/** 按模型自拟的分类名聚合 */
const byCategory = new Map();
/** 按标题聚合（标题更能说明具体是哪条规则） */
const byTitle = new Map();
for (const r of ok) {
  for (const g of r.gaps) {
    const c = g.category || '（无分类）';
    byCategory.set(c, (byCategory.get(c) || 0) + 1);
    const t = g.title || '（无标题）';
    if (!byTitle.has(t)) byTitle.set(t, { n: 0, category: c, samples: [] });
    const e = byTitle.get(t);
    e.n += 1;
    if (e.samples.length < 3 && g.quote) e.samples.push(g.quote);
  }
}
const catSorted = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
const titleSorted = [...byTitle.entries()].sort((a, b) => b[1].n - a[1].n);

const summary = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  sampledDocs: ok.length,
  corpusDocs: docs.length,
  totalSec: Number(runs.reduce((s, r) => s + (r.sec || 0), 0).toFixed(1)),
  modelIssuesTotal: totalModel,
  gapTotal: totalGaps,
  gapRatio: totalModel ? Number((totalGaps / totalModel * 100).toFixed(1)) : 0,
  overflowTotal: ok.reduce((s, r) => s + r.overflow.length, 0),
  modelRuleCount: modelRules.length,
  statement: `在 ${ok.length} 篇样本上，模型共报 ${totalModel} 条问题，其中 ${totalGaps} 条（${totalModel ? (totalGaps / totalModel * 100).toFixed(1) : 0}%）`
    + `**不属于规则库的任何一条规则** —— 这是规则库的缺口。`,
  byCategory: catSorted.map(([category, n]) => ({ category, n })),
  byTitle: titleSorted.map(([title, v]) => ({ title, n: v.n, category: v.category, samples: v.samples })),
  runs,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'rule-gap-analysis.json'), JSON.stringify(summary, null, 2), 'utf8');

const md = [
  '# 规则库缺口分析（目标点 6/7/12）', '',
  `- 生成时间：${summary.generatedAt}`,
  `- 样本：${ok.length} 篇（语料 ${docs.length} 篇），合计 ${summary.totalSec}s`,
  `- 模型报出问题：**${totalModel}** 条`,
  `- 其中**无对应规则**：**${totalGaps}** 条（**${summary.gapRatio}%**）`,
  `- 越界引用（规则库有、未交给模型）：${summary.overflowTotal} 条`, '',
  '> 判定：`ruleId` 不属于本次交给模型的规则号、也不在规则库里的，即为缺口。',
  '> 模型自拟的分类名与标题比规则号更能说明缺的是哪一类规则。', '',
  '## 按模型自拟分类聚合', '',
  '| 分类 | 条数 | 占比 |', '| --- | ---: | ---: |',
  ...catSorted.map(([c, n]) => `| ${c} | ${n} | ${(n / totalGaps * 100).toFixed(1)}% |`),
  '', '## 按标题聚合（补规则的候选，按频次排序）', '',
  '| 标题 | 分类 | 条数 | 原文摘录 |', '| --- | --- | ---: | --- |',
  ...titleSorted.slice(0, 40).map(([t, v]) => `| ${t} | ${v.category} | ${v.n} | ${v.samples.join(' / ').slice(0, 60)} |`),
  '', '## 逐篇明细', '',
  '| 稿件 | 分层 | 段数 | 规则 | 模型 | 缺口 | 越界 | 耗时 |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...runs.map((r) => `| ${r.name.slice(0, 34)} | ${r.stratum} | ${r.paragraphs} | ${r.ruleIssues ?? '—'} | ${r.modelIssues ?? '—'} | ${r.gaps?.length ?? '—'} | ${r.overflow?.length ?? '—'} | ${r.sec}s |`),
  '',
];
writeFileSync(join(OUT, '规则库缺口分析.md'), md.join('\n'), 'utf8');

console.log('\n═══ 规则库缺口 ═══');
console.log(summary.statement);
console.log(`\n按模型自拟分类（前 15）：`);
for (const c of catSorted.slice(0, 15)) console.log(`  ${String(c[1]).padStart(4)} 条  ${c[0]}`);
console.log(`\n按标题（前 20，补规则候选）：`);
for (const [t, v] of titleSorted.slice(0, 20)) console.log(`  ${String(v.n).padStart(4)} 条  [${v.category}] ${t.slice(0, 48)}`);
console.log(`\n明细：data/verify/rule-gap-analysis.json`);
