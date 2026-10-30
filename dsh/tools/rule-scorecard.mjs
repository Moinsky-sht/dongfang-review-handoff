/**
 * 规则记分卡（Phase 2）——把每条规则的**全部证据**汇到一张表。
 * =================================================================
 * 为什么需要它
 * ------------
 * 规则质量的信号散落在六个产物里：命中（coverage）、方向（direction）、
 * 与编辑批注的重合（fp-ledger）、探针存活（liveness / never-fired-probe）、
 * 裁决建议（triage）、状态断言（status-assertions）。要判一条规则好不好、
 * 该不该动，得同时看这几路信号——本工具把它们**按规则号 join 成一行**，
 * 输出人读 md + 机器可读 json，并把"机械 / 模型 / 人工"的口径拆清。
 *
 * 口径（detectType）
 * ------------------
 *   mechanical  regex / list / structure / … —— 规则引擎可直接判的
 *   model       detect.type = model —— 交给大模型
 *   manual      detect.type = manual —— 只能人工核对
 *
 * 只读各工具落盘的 json，不重新扫语料，秒级。
 *
 * 用法：node tools/rule-scorecard.mjs
 * 产物：data/verify/rule-scorecard.json、data/verify/规则记分卡.md
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V = join(ROOT, 'data', 'verify');
const j = (name) => { const p = join(V, name); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };

/* ---- 规则库（权威清单） ---- */
const defs = [];
for (const [group, file] of [['format', 'format-rules.json'], ['language', 'language-rules.json'], ['citation', 'citation-rules.json']]) {
  for (const r of JSON.parse(readFileSync(join(ROOT, 'rules', file), 'utf8')).rules || []) {
    defs.push({ id: r.id, group, title: r.title, severity: r.severity || null, detectType: r.detect?.type || null, status: r.status || null });
  }
}

/* ---- 各路信号 ---- */
const cov = j('rule-coverage.json');
const dir = j('rule-direction.json');
const led = j('rule-fp-ledger.json');
const live = j('rule-liveness.json');
const nfp = j('never-fired-probe.json');
const tri = j('rule-triage.json');
const ass = j('rule-status-assertions.json');

const byId = (arr, key = 'id') => new Map((arr || []).map((r) => [r[key], r]));
const covById = byId(cov?.rules);
const dirById = byId(dir?.rules || dir?.rows);
const ledById = byId(led?.rules);
const triById = byId(tri?.rows);
const liveById = byId((live?.results || []).map((r) => ({ ...r, id: r.ruleId })));
const noDetect = new Set(nfp?.rulesWithNoDetection || []);
const deadProbe = new Set(live?.deadRules || []);

const kindOf = (d) => (d.detectType === 'model' || d.status === 'model') ? 'model'
  : (d.detectType === 'manual' || d.status === 'manual') ? 'manual'
    : 'mechanical';

const rows = defs.map((d) => {
  const c = covById.get(d.id) || {};
  const di = dirById.get(d.id) || {};
  const l = ledById.get(d.id) || {};
  const t = triById.get(d.id) || {};
  const lv = liveById.get(d.id) || {};
  return {
    id: d.id,
    group: d.group,
    kind: kindOf(d),
    detectType: d.detectType,
    severity: d.severity,
    title: d.title,
    corpusDocs: c.docs ?? 0,
    corpusHits: c.hits ?? 0,
    fired: !!c.fired,
    dTrace: di.dTrace ?? null,
    dLayer: di.dLayer ?? null,
    directionVerdict: di.verdict ?? null,
    overlapRate: l.overlapRate ?? null,
    probeAlive: liveById.has(d.id) ? !!lv.fired : null,
    probeDead: deadProbe.has(d.id),
    noDetection: noDetect.has(d.id),
    action: t.action ?? 'keep',
  };
});

/* ---- 汇总 ---- */
const countBy = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const kindCounts = countBy(rows, (r) => r.kind);
const groupCounts = countBy(rows, (r) => r.group);
const actionCounts = countBy(rows, (r) => r.action);

const summary = {
  generatedAt: new Date().toISOString(),
  totalRules: rows.length,
  kindCounts,
  groupCounts,
  actionCounts,
  firedRules: rows.filter((r) => r.fired).length,
  neverFiredRules: rows.filter((r) => !r.fired).length,
  probeDeadRules: rows.filter((r) => r.probeDead).length,
  directionBothReversed: rows.filter((r) => r.directionVerdict && /反向/.test(r.directionVerdict)).length,
  statusAssertions: ass ? { passed: (ass.passed || []).length, failed: (ass.failed || []).length } : null,
};

writeFileSync(join(V, 'rule-scorecard.json'), JSON.stringify({ summary, rows }, null, 2), 'utf8');

/* ---- 人读报告 ---- */
const fmtPct = (x) => (x === null || x === undefined) ? '—' : (x * 100).toFixed(0) + '%';
const md = [];
md.push('# 规则记分卡', '');
md.push(`生成时间：${summary.generatedAt}`, '');
md.push(`规则总数 **${summary.totalRules}**｜机械 ${kindCounts.mechanical || 0}／模型 ${kindCounts.model || 0}／人工 ${kindCounts.manual || 0}`);
md.push(`触发过 **${summary.firedRules}**｜从未触发 **${summary.neverFiredRules}**｜探针判定死亡 **${summary.probeDeadRules}**｜方向双向反向 **${summary.directionBothReversed}**`);
md.push(`处置分布：${Object.entries(actionCounts).map(([k, v]) => `${k} ${v}`).join('｜')}`, '');
md.push('## 需关注（非 keep）', '');
md.push('| 规则 | 组 | 类型 | 稿件 | 命中 | Δ痕迹 | Δ分层 | 重合率 | 方向 | 处置 |');
md.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
const watch = rows.filter((r) => r.action !== 'keep').sort((a, b) => (b.corpusDocs - a.corpusDocs));
for (const r of watch) {
  md.push(`| ${r.id} | ${r.group} | ${r.detectType || '—'} | ${r.corpusDocs} | ${r.corpusHits} | ${r.dTrace ?? '—'} | ${r.dLayer ?? '—'} | ${fmtPct(r.overlapRate)} | ${r.directionVerdict || '—'} | ${r.action} |`);
}
md.push('');
md.push('## 从未触发（死规则候选）', '');
const neverFired = rows.filter((r) => !r.fired);
md.push(neverFired.length
  ? neverFired.map((r) => `- ${r.id}（${r.group}/${r.kind}）：${r.title}`).join('\n')
  : '（无）');
md.push('');
writeFileSync(join(V, '规则记分卡.md'), md.join('\n'), 'utf8');

console.log('规则记分卡');
console.log(`规则 ${summary.totalRules}（机械 ${kindCounts.mechanical || 0}／模型 ${kindCounts.model || 0}／人工 ${kindCounts.manual || 0}）`);
console.log(`触发 ${summary.firedRules}｜未触发 ${summary.neverFiredRules}｜探针死亡 ${summary.probeDeadRules}｜双向反向 ${summary.directionBothReversed}`);
console.log(`处置：${Object.entries(actionCounts).map(([k, v]) => `${k} ${v}`).join('｜')}`);
console.log('产物：data/verify/rule-scorecard.json、data/verify/规则记分卡.md');
