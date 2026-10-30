/**
 * 模型查验闭环评测（Phase 3）。
 * =================================================================
 * 问题：`verdict.js` 的阈值是按**纯规则引擎**的分布标定的（总问题数 Welch t=−2.55，
 * 已过审 vs 在审显著分层）。但判定实际吃的是**规则 + 模型**合并后的列表。
 * 于是必须先量一件事：**加上模型之后，分数还分不分得开「已过审」和「在审」？**
 *
 * 本工具读模型实跑的缓存（`tools/.verdict-calib2.json`，由
 * `tools/eval-verdict-calib.mjs` 生成，模型审阅约 10—15 分钟/份），
 * 对每个群体算「纯规则」与「规则+模型」两套口径的分数分布与 Welch t，
 * 量化模型层对**判定分离度**的贡献（或破坏）。
 *
 * 为什么不在回归里现跑模型：单份 10—15 分钟、且依赖外网，不适合做门禁。
 * 本工具只读缓存，秒级；要刷新缓存请显式跑 `tools/eval-verdict-calib.mjs`。
 *
 * 用法：node tools/model-eval.mjs
 * 产物：data/verify/model-eval.json、data/verify/模型闭环评测.md
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V = join(ROOT, 'data', 'verify');
const CACHE = join(ROOT, 'tools', '.verdict-calib2.json');

if (!existsSync(CACHE)) {
  console.log('模型闭环评测：未找到模型实跑缓存 tools/.verdict-calib2.json');
  console.log('跳过（生成方式：node tools/eval-verdict-calib.mjs，约 10—15 分钟/份）');
  process.exitCode = 0;
} else {
  const recs = JSON.parse(readFileSync(CACHE, 'utf8'));
  const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
  const welch = (a, b) => {
    if (a.length < 2 || b.length < 2) return null;
    const se = Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
    return se ? +((mean(a) - mean(b)) / se).toFixed(2) : null;
  };
  const bySet = (k) => recs.filter((r) => r.set === k);

  const tune = bySet('TUNE');
  const holdout = recs.filter((r) => r.set === 'HOLDA' || r.set === 'HOLDB');
  const col = (rows, key) => rows.map((r) => r[key]).filter((x) => typeof x === 'number');

  const modelShare = recs.map((r) => (r.allIssues ? r.modelIssues / r.allIssues : 0));
  const summary = {
    generatedAt: new Date().toISOString(),
    cache: 'tools/.verdict-calib2.json',
    docs: recs.length,
    sets: { TUNE: tune.length, HOLDOUT: holdout.length },
    modelIssueShare: {
      mean: +(mean(modelShare) * 100).toFixed(1),
      min: +(Math.min(...modelShare) * 100).toFixed(1),
      max: +(Math.max(...modelShare) * 100).toFixed(1),
    },
    rulesOnly: {
      tuneMeanPer1k: +mean(col(tune, 'rulePer1k')).toFixed(2),
      holdMeanPer1k: +mean(col(holdout, 'rulePer1k')).toFixed(2),
      welchT: welch(col(tune, 'rulePer1k'), col(holdout, 'rulePer1k')),
    },
    withModel: {
      tuneMeanPer1k: +mean(col(tune, 'allPer1k')).toFixed(2),
      holdMeanPer1k: +mean(col(holdout, 'allPer1k')).toFixed(2),
      welchT: welch(col(tune, 'allPer1k'), col(holdout, 'allPer1k')),
    },
    verdicts: recs.reduce((m, r) => { m[r.verdict] = (m[r.verdict] || 0) + 1; return m; }, {}),
  };
  writeFileSync(join(V, 'model-eval.json'), JSON.stringify(summary, null, 2), 'utf8');

  const md = [
    '# 模型闭环评测', '',
    `生成时间：${summary.generatedAt}｜样本 ${summary.docs} 份（TUNE ${summary.sets.TUNE}／HOLDOUT ${summary.sets.HOLDOUT}）`, '',
    `模型问题占全部问题比例：均值 **${summary.modelIssueShare.mean}%**（${summary.modelIssueShare.min}%—${summary.modelIssueShare.max}%）`, '',
    '## 判定分离度（Welch t：在审 − 已过审，期望为负）', '',
    '| 口径 | 在审 每千字 | 已过审 每千字 | Welch t |', '| --- | ---: | ---: | ---: |',
    `| 纯规则 | ${summary.rulesOnly.tuneMeanPer1k} | ${summary.rulesOnly.holdMeanPer1k} | ${summary.rulesOnly.welchT} |`,
    `| 规则+模型 | ${summary.withModel.tuneMeanPer1k} | ${summary.withModel.holdMeanPer1k} | ${summary.withModel.welchT} |`, '',
    `判定分布：${Object.entries(summary.verdicts).map(([k, v]) => `${k} ${v}`).join('｜')}`, '',
  ];
  writeFileSync(join(V, '模型闭环评测.md'), md.join('\n'), 'utf8');

  console.log('模型闭环评测');
  console.log(`样本 ${summary.docs} 份｜模型问题占比 ${summary.modelIssueShare.mean}%（${summary.modelIssueShare.min}%—${summary.modelIssueShare.max}%）`);
  console.log(`纯规则 Welch t = ${summary.rulesOnly.welchT}；规则+模型 Welch t = ${summary.withModel.welchT}`);
  console.log(`判定分布：${Object.entries(summary.verdicts).map(([k, v]) => `${k} ${v}`).join('｜')}`);
  console.log('产物：data/verify/model-eval.json、data/verify/模型闭环评测.md');
}
