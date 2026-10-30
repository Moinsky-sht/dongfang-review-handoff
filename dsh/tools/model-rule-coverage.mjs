#!/usr/bin/env node
/**
 * 模型规则覆盖率（目标点 6）：20 条「交模型语义判断」的规则，
 * 到底有哪些**真的在模型审阅里被命中过**。
 *
 * ## 为什么要单独做这个
 *
 * 目标点 6 要求「把语料中每一篇文章都跑一遍，覆盖全部批改规则」。
 * 规则引擎那 88 条是 632/632 篇全跑的（`batch-verify`），有据可查；
 * 但**模型规则这 20 条只跑过 1 篇**（`model-batch.json`），
 * 于是「覆盖全部批改规则」这句话在后半截是空的。
 *
 * 全量跑不现实：模型审阅实测 **560—890 秒/篇**，632 篇约 98 小时。
 * 所以本工具做**分层抽样**，并把结果如实表述为
 * 「N 篇分层样本上的覆盖率」，而**不是**含糊成「全量跑过」。
 *
 * ## 分层依据
 *
 * 按**段落数**分层，因为模型审阅耗时几乎与段落数成正比
 * （窗口按 10 段切分，一篇 100 段的稿子要 10 次请求）。
 * 同时保证覆盖不同季次/栏目，避免样本全是同一类稿子。
 *
 * ## 用法
 *
 *   node tools/model-rule-coverage.mjs --count=8
 *   node tools/model-rule-coverage.mjs --count=8 --port=3210
 *   node tools/model-rule-coverage.mjs --rules-only   # 只列规则，不跑模型
 *
 * 结果落盘 `data/verify/model-rule-coverage.json` + `.md`。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'verify');
const CORPUS = resolve(ROOT, '..', '发给皓天的一审文件');
const args = process.argv.slice(2);
const flag = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const COUNT = Number(flag('count', 8)) || 8;
const PORT = flag('port', '3210');
const BASE = flag('url', `http://127.0.0.1:${PORT}`);
const RULES_ONLY = args.includes('--rules-only');
// 模型审阅 560—890 秒/份，给足超时
const TIMEOUT_MS = Number(flag('timeout', 2400000)) || 2400000;

/* ---------- 一、取出 20 条模型规则 ---------- */
const health = await (await fetch(`${BASE}/api/rules`)).json();
const allRules = [
  ...(health.format?.rules || []),
  ...(health.language?.rules || []),
  ...(health.citation?.rules || []),
];
const modelRules = allRules.filter((r) => r.status === 'model');
console.log(`规则库 ${allRules.length} 条，其中「交模型语义判断」${modelRules.length} 条：`);
for (const r of modelRules) console.log(`  ${r.id.padEnd(10)} ${String(r.title || '').slice(0, 44)}`);

if (RULES_ONLY) {
  writeFileSync(join(OUT, 'model-rule-coverage.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), modelRules: modelRules.map((r) => ({ id: r.id, title: r.title, group: r.group })), runs: [] }, null, 2), 'utf8');
  process.exit(0);
}

/**
 * 抽样当时的模型规则号集合 —— **必须随样本一起落盘**。
 *
 * 踩过的坑：把 `FMTB-030`/`FMTB-038` 改判为 manual 之后再跑 `--reuse`，
 * 分母从 20 悄悄变成 18，报告于是显示「命中过 18/18 = 100.0%」。
 * 数字变了，但**模型一行代码没改、一次也没重跑** ——
 * 变的只是分母。这是最容易被当成「进展」的假象。
 *
 * 所以规则集合要与 `runs` 一起冻结：重算时必须用**当时的**口径，
 * 并同时给出「当时口径」和「现在口径」两个数字，让差异的来源一目了然。
 */
const sampledRuleSet = modelRules.map((r) => ({ id: r.id, title: r.title, group: r.group }));

/* ---------- 二、分层抽样 ---------- */
const manifest = JSON.parse(readFileSync(join(ROOT, 'data/corpus/manifest.json'), 'utf8'));
const docs = Object.values(manifest).filter((m) => (m.path || '').endsWith('.docx') && existsSync(join(CORPUS, m.path)));

/**
 * 分层：段落数分箱。模型审阅成本与段落数强相关，
 * 只在「短稿」层抽样会系统性高估覆盖率（长稿有更多机会命中规则）。
 */
const strata = [
  { name: '短稿(≤60段)', test: (p) => p <= 60 },
  { name: '中稿(61—120段)', test: (p) => p > 60 && p <= 120 },
  { name: '长稿(>120段)', test: (p) => p > 120 },
];
const picks = [];
for (const st of strata) {
  const pool = docs.filter((m) => st.test(m.paragraphs || 0));
  if (!pool.length) continue;
  // 层内均匀取样（按顺序等距），保证跨季次
  const need = Math.max(1, Math.round(COUNT * (pool.length / docs.length)));
  const step = Math.max(1, Math.floor(pool.length / need));
  const taken = [];
  for (let i = 0; i < pool.length && taken.length < need; i += step) taken.push(pool[i]);
  picks.push(...taken.map((m) => ({ ...m, stratum: st.name })));
}
console.log(`\n分层抽样：语料 ${docs.length} 篇 → 选 ${picks.length} 篇`);
for (const p of picks) console.log(`  [${p.stratum}] ${(p.paragraphs || 0)}段  ${basename(p.path).slice(0, 46)}`);

/* ---------- 三、逐篇跑真实模型审阅，记录命中的规则号 ---------- */
const runs = [];
/**
 * `--reuse`：不重新跑模型，直接读上次落盘的 `runs` 重新聚合。
 *
 * 为什么需要它：一次抽样要跑 2 小时（8 篇 × 约 700 秒）。而**聚合口径**是会改的
 * （本工具第一版就把「越界引用」算成了命中，汇总出 24/20 = 120% 这种数字）。
 * 改口径不该让人再等 2 小时 —— 原始数据已经落盘，重算就行。
 */
const REUSE = args.includes('--reuse');
if (REUSE) {
  const prev = JSON.parse(readFileSync(join(OUT, 'model-rule-coverage.json'), 'utf8'));
  runs.push(...(prev.runs || []));
  /**
   * 用**落盘的**规则集合，不要用当前规则库重建。
   *
   * 这里踩过一次：改判 `FMTB-030`/`FMTB-038` 为 manual 后跑 `--reuse`，
   * 分母从 20 悄悄变成 18，报告显示「18/18 = 100%」——
   * 模型一行没改、一次没重跑，数字却「变好了」。
   * 历史样本的口径必须随样本冻结，否则改一次分类就伪造一次进展。
   */
  if (Array.isArray(prev.sampledRuleSet) && prev.sampledRuleSet.length) {
    sampledRuleSet.length = 0;
    sampledRuleSet.push(...prev.sampledRuleSet);
    console.log(`--reuse：沿用落盘的规则集合（${sampledRuleSet.length} 条），不用当前规则库重建`);
  } else {
    console.log(`--reuse：落盘文件没有 sampledRuleSet（旧版本产出），暂用当前规则库 ${sampledRuleSet.length} 条`);
  }
  console.log(`\n--reuse：读入上次 ${runs.length} 篇结果，不重新调用模型`);
} else {
for (const [i, p] of picks.entries()) {
  const rec = { name: basename(p.path), stratum: p.stratum, paragraphs: p.paragraphs || 0, hitRules: [] };
  const t0 = Date.now();
  try {
    const buf = readFileSync(join(CORPUS, p.path));
    const up = await (await fetch(`${BASE}/api/upload?name=${encodeURIComponent(basename(p.path))}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf,
    })).json();
    if (!up.id) { rec.error = `上传失败：${JSON.stringify(up).slice(0, 120)}`; runs.push(rec); continue; }

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
    rec.usage = r.usage;
    rec.modelErrors = (r.modelErrors || []).length;
    /**
     * 命中的模型规则号。
     *
     * 模型问题有三种来源，必须**分开统计**：
     *   · `group === 'model'` 且 ruleId 在本次交给模型的 20 条里 → 该规则被模型命中；
     *   · ruleId 形如 `ARK-分类名` → 模型自拟分类，**不**算命中任何已声明规则
     *     （这正是「模型报了问题但规则库没这条」的信号）；
     *   · ruleId 是规则库里**真实存在、但本次没交给模型**的号
     *     （status=auto，实测见过 LANG-017/018/020、LANG-015、FMT-024）
     *     → **越界引用**。这些号若不单独列出，会让「模型命中」虚高，
     *     并让规则管理页把 auto 规则显示成「模型判断命中」。
     */
    const allowed = new Set(modelRules.map((r) => r.id));
    const allIds = new Set(allRules.map((r) => r.id));
    const byRule = new Map();
    const outOfScope = new Map();
    let synthetic = 0;
    for (const it of r.issues || []) {
      if (it.group !== 'model') continue;
      const id = String(it.ruleId || '');
      if (/^ARK-/.test(id)) { synthetic += 1; continue; }
      if (allowed.has(id)) { byRule.set(id, (byRule.get(id) || 0) + 1); continue; }
      if (allIds.has(id)) { outOfScope.set(id, (outOfScope.get(id) || 0) + 1); continue; }
      synthetic += 1;
    }
    rec.hitRules = [...byRule.entries()].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n);
    rec.outOfScopeRules = [...outOfScope.entries()].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n);
    rec.syntheticRuleIds = synthetic;
    rec.modelUnlocated = (r.issues || []).filter((x) => x.group === 'model'
      && x.paragraphIndex === undefined && x.footnoteIndex === undefined).length;
    rec.reportChars = 0;
  } catch (err) {
    rec.error = `异常：${err.message}`;
  }
  rec.sec = Number(((Date.now() - t0) / 1000).toFixed(1));
  runs.push(rec);
  const hits = rec.hitRules.map((h) => h.id).join(',');
  const oos = (rec.outOfScopeRules || []).map((h) => h.id).join(',');
  console.log(`  ${i + 1}/${picks.length} ${rec.error ? '✗' : '✓'} ${rec.name.slice(0, 38)} — ${rec.sec}s`
    + (rec.error ? `  ${rec.error}` : `  规则 ${rec.ruleIssues} + 模型 ${rec.modelIssues}；命中模型规则：${hits || '（无）'}`
      + (oos ? `；**越界引用**：${oos}` : '')));
}
}

/* ---------- 四、汇总覆盖率 ---------- */
const ok = runs.filter((r) => !r.error);
/**
 * 聚合必须用**抽样当时的**规则集合，不能用当前规则库。
 *
 * 否则改一次规则分类，历史样本的分母就会跟着变，
 * 报告显示的数字变了而模型一次都没重跑 —— 最容易被当成进展的假象。
 * 当前规则库的集合另算一份，两个口径都报出来。
 */
const sampledIds = new Set(sampledRuleSet.map((r) => r.id));
const nowIds = new Set(modelRules.map((r) => r.id));
const allIds = new Set(allRules.map((r) => r.id));

/**
 * 再过滤一次：只有 ruleId 真的在**抽样当时**的模型规则里的才算命中。
 *
 * 为什么不能直接用 `run.hitRules`：这个工具本身也经历过一次修正 ——
 * 第一版把「规则库里存在但本次没交给模型」的号也算成了命中，
 * 于是汇总出「20 条规则命中过 24 条（120%）」这种不可能的数字。
 * 数据是对的，**聚合口径错了**。
 */
const covered = new Map();
const outOfScopeAgg = new Map();
for (const r of ok) {
  for (const h of r.hitRules || []) {
    if (sampledIds.has(h.id)) covered.set(h.id, (covered.get(h.id) || 0) + h.n);
    else if (allIds.has(h.id)) outOfScopeAgg.set(h.id, (outOfScopeAgg.get(h.id) || 0) + h.n);
  }
}
const neverHit = sampledRuleSet.filter((r) => !covered.has(r.id));
/** 当前规则库口径（改判后重算）—— 与抽样口径可能不同，必须分开报 */
const coveredNow = [...nowIds].filter((id) => covered.has(id));
const movedOut = [...sampledIds].filter((id) => !nowIds.has(id));
const summary = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  corpusDocs: docs.length,
  sampled: picks.length,
  succeeded: ok.length,
  totalSec: Number(runs.reduce((s, r) => s + (r.sec || 0), 0).toFixed(1)),
  modelRuleCount: sampledRuleSet.length,
  coveredCount: covered.size,
  neverHitCount: neverHit.length,
  /** 当前规则库口径（改判后），与抽样口径可能不同 */
  currentModelRuleCount: nowIds.size,
  currentCoveredCount: coveredNow.length,
  movedOutOfModel: movedOut,
  sampledRuleSet,
  modelIssuesTotal: ok.reduce((s, r) => s + (r.modelIssues || 0), 0),
  syntheticRuleIds: ok.reduce((s, r) => s + (r.syntheticRuleIds || 0), 0),
  outOfScopeTotal: [...outOfScopeAgg.values()].reduce((a, b) => a + b, 0),
  outOfScopeIds: [...outOfScopeAgg.keys()].sort(),
  /** 模型问题去向三分解：挂到声明规则 / 越界引用 / 自拟分类 */
  issueBreakdown: {
    toDeclaredRules: [...covered.values()].reduce((a, b) => a + b, 0),
    outOfScope: [...outOfScopeAgg.values()].reduce((a, b) => a + b, 0),
    synthetic: ok.reduce((s, r) => s + (r.syntheticRuleIds || 0), 0),
  },
  // 抽样覆盖率必须**如实**表述，不能写成「全量覆盖」
  statement: `在 ${ok.length} 篇分层样本上，抽样当时的 ${sampledRuleSet.length} 条模型规则中命中过 ${covered.size} 条（${(covered.size / sampledRuleSet.length * 100).toFixed(1)}%）；`
    + `未命中 ${neverHit.length} 条。这是抽样结果，不等于全语料覆盖 —— `
    + `全量需 ${(docs.length * 700 / 3600).toFixed(0)} 小时（按 700 秒/篇）。`
    + (movedOut.length
      ? ` 另：${movedOut.join('、')} 已改判为 manual，故按当前规则库口径为 `
        + `${coveredNow.length}/${nowIds.size}（${(coveredNow.length / nowIds.size * 100).toFixed(1)}%）——`
        + `该差异来自**改口径**，不是模型跑得更好，模型一次都没重跑。`
      : ''),
  // 逐条：抽样当时的口径为准；已改判的单独标注
  rules: sampledRuleSet.map((r) => ({
    id: r.id, title: r.title, group: r.group,
    hits: covered.get(r.id) || 0,
    stillModel: nowIds.has(r.id),
    hitIn: ok.filter((x) => x.hitRules.some((h) => h.id === r.id)).map((x) => x.name),
  })).sort((a, b) => b.hits - a.hits),
  runs,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'model-rule-coverage.json'), JSON.stringify(summary, null, 2), 'utf8');

const md = [
  '# 模型规则覆盖率（目标点 6）', '',
  `- 生成时间：${summary.generatedAt}`,
  `- 抽样：语料 ${docs.length} 篇 → 分层样本 **${ok.length}/${picks.length}** 篇跑通`,
  `- **抽样当时**的模型规则：${sampledRuleSet.length} 条，样本上命中过 **${covered.size} 条**（${(covered.size / sampledRuleSet.length * 100).toFixed(1)}%）`,
  ...(movedOut.length
    ? [`- 当前规则库口径：${nowIds.size} 条，命中过 ${coveredNow.length} 条（${(coveredNow.length / nowIds.size * 100).toFixed(1)}%）`
      + ` —— 其中 ${movedOut.join('、')} 已改判为 manual`,
      '- ⚠️ 两个口径的差异来自**改口径**（改判），不是模型跑得更好：模型一次都没重跑。']
    : []),
  `- 总耗时：${summary.totalSec}s`,
  `- 模型自拟分类（不属于任何已声明规则）：${summary.syntheticRuleIds} 条`,
  `- **越界引用**（规则库真实存在、但本次没交给模型）：${summary.outOfScopeTotal} 条`
    + (summary.outOfScopeIds.length ? `，涉及 ${summary.outOfScopeIds.join('、')}` : ''), '',
  '> ⚠️ 这是**分层抽样**结果，**不等于**全语料覆盖。',
  `> 模型审阅实测约 700 秒/篇，632 篇全量需约 ${(docs.length * 700 / 3600).toFixed(0)} 小时。`, '',
  '## 逐条命中情况', '',
  '| 规则号 | 标题 | 命中次数 | 当前分类 | 出现在 |', '| --- | --- | ---: | --- | --- |',
  ...summary.rules.map((r) => `| ${r.id} | ${String(r.title || '').slice(0, 40)} | ${r.hits} | ${r.stillModel ? 'model' : '**已改判 manual**'} | ${r.hitIn.length ? r.hitIn.map((n) => n.slice(0, 22)).join('<br>') : '**样本内未命中**'} |`),
  '', '## 逐篇明细', '',
  '| 稿件 | 分层 | 段数 | 规则 | 模型 | 命中模型规则 | 越界引用 | 自拟分类 | 未定位 | 耗时 |',
  '| --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |',
  ...runs.map((r) => `| ${r.name.slice(0, 34)} | ${r.stratum} | ${r.paragraphs} | ${r.ruleIssues ?? '—'} | ${r.modelIssues ?? '—'} | ${(r.hitRules || []).map((h) => h.id).join(', ') || '—'} | ${(r.outOfScopeRules || []).map((h) => h.id).join(', ') || '—'} | ${r.syntheticRuleIds ?? '—'} | ${r.modelUnlocated ?? '—'} | ${r.sec}s |`),
  '',
  '## 越界引用（需要修的现象）', '',
  '模型偶尔会报出规则库里真实存在、但**本次并没交给它**的规则号。',
  '这些号的 `status` 是 `auto`（规则引擎检测），规则引擎本身没报过 —— ',
  '若不拦下来，规则管理页会把「模型凭印象引用的规则」显示成「这条规则真的命中了」。', '',
  summary.outOfScopeIds.length
    ? ['| 规则号 | 标题 | status | 被越界引用次数 |', '| --- | --- | --- | ---: |',
      ...summary.outOfScopeIds.map((id) => {
        const rr = allRules.find((x) => x.id === id) || {};
        return `| ${id} | ${String(rr.title || '').slice(0, 40)} | ${rr.status || '?'} | ${outOfScopeAgg.get(id)} |`;
      }), ''].join('\n')
    : '（本次样本未出现越界引用）',
  '',
  '## 模型问题的去向（三分解）', '',
  '| 去向 | 条数 | 占比 | 含义 |', '| --- | ---: | ---: | --- |',
  `| 挂到声明的 20 条模型规则 | ${summary.issueBreakdown.toDeclaredRules} | ${(summary.issueBreakdown.toDeclaredRules / summary.modelIssuesTotal * 100).toFixed(1)}% | 规则库覆盖到了 |`,
  `| 越界引用（规则库有、没交给模型） | ${summary.issueBreakdown.outOfScope} | ${(summary.issueBreakdown.outOfScope / summary.modelIssuesTotal * 100).toFixed(1)}% | 该规则可能**分类错了** |`,
  `| 模型自拟分类（规则库没有） | ${summary.issueBreakdown.synthetic} | ${(summary.issueBreakdown.synthetic / summary.modelIssuesTotal * 100).toFixed(1)}% | 规则库**缺口** |`,
  '',
  '最后一行是重点：**规则库没有覆盖模型真正发现的问题**。',
  '自拟分类占比越高，说明规则库越不完整 —— 这是继续补规则的方向。',
  '',
];
writeFileSync(join(OUT, '模型规则覆盖率.md'), md.join('\n'), 'utf8');

console.log('\n═══ 模型规则覆盖率 ═══');
console.log(summary.statement);
console.log(`\n命中过的规则（${covered.size}）：`);
for (const r of summary.rules.filter((x) => x.hits)) console.log(`  ${r.id.padEnd(10)} ${r.hits} 次  ${String(r.title || '').slice(0, 40)}`);
console.log(`\n样本内未命中（${neverHit.length}）：`);
for (const r of neverHit) console.log(`  ${r.id.padEnd(10)} ${String(r.title || '').slice(0, 44)}`);
console.log(`\n模型自拟分类（不属于任何已声明规则）合计 ${summary.syntheticRuleIds} 条`);
console.log(`明细：data/verify/model-rule-coverage.json`);
