/**
 * 质量记分卡 + 基线漂移（Phase 0 地基）。
 * =================================================================
 * 把 `verify-all.json` 与各工具落盘的 JSON 归一成**四个轴**的指标，
 * 与冻结基线 `data/verify/baseline.json` 逐项比对，输出漂移。
 *
 * 四个轴（对应总目标）
 *   speed          速度：verify-all 墙钟、batch-verify、rule-coverage 耗时
 *   accuracy       准确性：与编辑批注重合率、双向反向规则数、死规则数
 *   systematicness 系统性：断言通过数、规则存活探针、规则台账覆盖
 *   maintainability可维护性：语法门禁失败数、回归项失败数
 *
 * 用法：
 *   node tools/scorecard.mjs            # 出记分卡 + 与基线比对（信息性，不返回非 0）
 *   node tools/scorecard.mjs --gate     # 有回退则返回非 0（可当门禁）
 *   node tools/scorecard.mjs --freeze   # 把当前指标冻成新基线
 *
 * 产物：data/verify/scorecard.json、data/verify/scorecard.md
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'verify');
const argv = process.argv.slice(2);
const freeze = argv.includes('--freeze');
const gate = argv.includes('--gate');

const j = (name) => {
  try { return JSON.parse(readFileSync(join(OUT, name), 'utf8')); } catch { return null; }
};

const va = j('verify-all.json');
const batch = j('batch.json');
const cov = j('rule-coverage.json');
const live = j('rule-liveness.json');
const ass = j('rule-status-assertions.json');
const nfp = j('never-fired-probe.json');
const dir = j('rule-direction.json');
const fp = j('rule-fp-ledger.json');
const tri = j('rule-triage.json');
const rsc = j('rule-scorecard.json');
const cls = j('never-fired-classification.json');
const me = j('model-eval.json');
const rag = j('comment-rag-eval.json');

const dirRows = dir ? (Array.isArray(dir) ? dir : (dir.rules || dir.rows || [])) : [];
const reversed = dirRows.filter((r) => /反向/.test(r.verdict || ''));
const bothReversed = reversed.filter((r) => r.dTrace <= 0 && r.dLayer <= 0);
const triRows = tri ? (tri.rows || []) : [];
const triCount = (a) => triRows.filter((r) => r.action === a).length;
const rscRows = rsc ? (rsc.rows || []) : [];
const mechRows = rscRows.filter((r) => r.kind === 'mechanical');

/** 指标定义：dir = 好方向（up=越高越好）；tol = 允许波动 */
const METRICS = [
  { axis: 'speed', key: 'verifyAll秒', value: va ? +(va.wallMs / 1000).toFixed(1) : null, dir: 'down', tol: 5 },
  { axis: 'speed', key: 'batchVerify秒', value: batch ? +batch.elapsedSec : null, dir: 'down', tol: 3 },
  { axis: 'speed', key: 'ruleCoverage秒', value: cov ? +cov.elapsedSeconds : null, dir: 'down', tol: 3 },
  { axis: 'accuracy', key: '编辑批注重合率', value: fp ? +(fp.overallOverlapRate * 100).toFixed(1) : null, dir: 'up', tol: 0.5, unit: '%' },
  { axis: 'accuracy', key: '双向反向规则', value: bothReversed.length, dir: 'down', tol: 0 },
  { axis: 'accuracy', key: '反向类规则', value: reversed.length, dir: 'down', tol: 0 },
  { axis: 'systematicness', key: '零命中规则', value: nfp ? nfp.rulesWithNoDetection.length : null, dir: 'down', tol: 0 },
  { axis: 'systematicness', key: '机械规则数', value: rsc ? mechRows.length : null, dir: 'info', tol: 0 },
  { axis: 'systematicness', key: '机械规则未触发', value: rsc ? mechRows.filter((r) => !r.fired).length : null, dir: 'down', tol: 0 },
  { axis: 'accuracy', key: '规则命中总数', value: cov && cov.totals ? cov.totals.issues : null, dir: 'info', tol: 0 },
  { axis: 'accuracy', key: '判定分离度|t|(规则)', value: me ? Math.abs(me.rulesOnly.welchT) : null, dir: 'up', tol: 0.2 },
  { axis: 'accuracy', key: '判定分离度|t|(模型)', value: me ? Math.abs(me.withModel.welchT) : null, dir: 'up', tol: 0.2 },
  { axis: 'accuracy', key: '模型问题占比%', value: me ? me.modelIssueShare.mean : null, dir: 'down', tol: 1 },
  { axis: 'accuracy', key: '历史案例库条数', value: rag ? rag.index?.count : null, dir: 'info', tol: 0 },
  { axis: 'accuracy', key: '案例留一命中率@3(%)', value: rag ? rag.leaveOneOut?.hit3 : null, dir: 'up', tol: 3 },
  { axis: 'systematicness', key: '状态断言通过', value: ass ? ass.passed.length : null, dir: 'up', tol: 0 },
  { axis: 'systematicness', key: '状态断言失败', value: ass ? ass.failed.length : null, dir: 'down', tol: 0 },
  { axis: 'systematicness', key: '规则存活探针(活/总)', value: live ? live.probeAlive : null, dir: 'up', tol: 0 },
  { axis: 'systematicness', key: '真死规则', value: live ? (live.deadOnCorpus || live.deadRules || []).length : null, dir: 'down', tol: 0 },
  { axis: 'systematicness', key: '探针盲区', value: live ? (live.probeBlind || []).length : null, dir: 'down', tol: 0 },
  { axis: 'systematicness', key: '未实现规则', value: cls ? (cls.unimplemented || []).length : null, dir: 'down', tol: 0 },
  { axis: 'systematicness', key: '判据失效规则', value: cls ? (cls.detectionBroken || []).length : null, dir: 'down', tol: 0 },
  { axis: 'systematicness', key: '待复核规则(sample-review)', value: triCount('sample-review'), dir: 'down', tol: 0 },
  { axis: 'maintainability', key: '语法门禁失败文件', value: va ? va.syntax.failed.length : null, dir: 'down', tol: 0 },
  { axis: 'maintainability', key: '回归项失败', value: va ? va.failing.length : null, dir: 'down', tol: 0 },
  { axis: 'maintainability', key: '语法门禁检查文件数', value: va ? va.syntax.checked : null, dir: 'up', tol: 0 },
];

const baselinePath = join(OUT, 'baseline.json');
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
const baseByKey = new Map((baseline?.metrics || []).map((m) => [m.key, m.value]));

const rows = METRICS.map((m) => {
  const b = baseByKey.has(m.key) ? baseByKey.get(m.key) : null;
  let delta = (m.value === null || b === null) ? null : +(m.value - b).toFixed(3);
  let drift = 'n/a';
  if (delta !== null && m.dir !== 'info') {
    const worse = m.dir === 'up' ? delta < -m.tol : delta > m.tol;
    const better = m.dir === 'up' ? delta > m.tol : delta < -m.tol;
    drift = worse ? 'regress' : better ? 'improve' : 'same';
  }
  return { ...m, baseline: b, delta, drift };
});

const regressions = rows.filter((r) => r.drift === 'regress');
const payload = { generatedAt: new Date().toISOString(), baselineAt: baseline?.generatedAt || null, metrics: rows, regressions: regressions.map((r) => r.key) };
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'scorecard.json'), JSON.stringify(payload, null, 2), 'utf8');

if (freeze) {
  writeFileSync(baselinePath, JSON.stringify({ generatedAt: new Date().toISOString(), metrics: rows.map(({ axis, key, value, dir, unit }) => ({ axis, key, value, dir, unit })) }, null, 2), 'utf8');
}

const md = [
  '# 质量记分卡', '',
  `生成时间：${payload.generatedAt}${baseline ? `｜基线：${baseline.generatedAt}` : '｜（尚无基线，用 --freeze 冻结）'}`, '',
  '| 轴 | 指标 | 当前 | 基线 | Δ | 漂移 |',
  '| --- | --- | ---: | ---: | ---: | --- |',
  ...rows.map((r) => `| ${r.axis} | ${r.key} | ${r.value ?? '—'}${r.unit || ''} | ${r.baseline ?? '—'}${r.unit || ''} | ${r.delta === null ? '—' : (r.delta > 0 ? '+' : '') + r.delta} | ${r.drift === 'regress' ? '🔴 回退' : r.drift === 'improve' ? '🟢 改善' : r.drift === 'same' ? '⚪ 持平' : '—'} |`),
  '', regressions.length ? `> 🔴 回退项：${regressions.map((r) => r.key).join('、')}` : '> 无回退项（或尚无基线）', '',
];
writeFileSync(join(OUT, 'scorecard.md'), md.join('\n'), 'utf8');

console.log('═══ 质量记分卡 ═══');
console.log(`基线：${baseline ? baseline.generatedAt : '（无，本次可 --freeze 冻结）'}`);
const icon = { regress: '🔴', improve: '🟢', same: '⚪', 'n/a': '  ' };
for (const r of rows) {
  console.log(`${icon[r.drift] || '  '} ${r.axis.padEnd(16)} ${r.key.padEnd(24)} ${String(r.value ?? '—').padStart(8)}${r.unit || ''}  基线 ${String(r.baseline ?? '—').padStart(8)}${r.delta !== null ? `  Δ${r.delta > 0 ? '+' : ''}${r.delta}` : ''}`);
}
if (freeze) console.log('\n✅ 已把当前指标冻结为新基线：data/verify/baseline.json');
if (regressions.length) console.log(`\n🔴 回退 ${regressions.length} 项：${regressions.map((r) => r.key).join('、')}`);
else console.log('\n无回退项。');
console.log('产物：data/verify/scorecard.json、scorecard.md');

if (gate && regressions.length) process.exitCode = 1;
