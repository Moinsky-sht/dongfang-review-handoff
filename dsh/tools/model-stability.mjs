/**
 * 需求 E：模型输出稳定性量化。
 *
 * ── 要回答什么 ──
 * 1. 同一份稿件重复运行，模型问题数的波动有多大？（方差 / 变异系数）
 * 2. 更重要的：**哪些结论是稳定的**？
 *    问题数相同不代表结论相同 —— 可能是 120 条里换掉了 60 条。
 *    所以核心指标是**跨轮重合度**：出现在全部 N 轮里的是"稳定核心"，
 *    只出现一次的很可能是一次性噪声。
 * 3. 规则引擎是否完全确定（对照基线）？
 *
 * 这些数字决定界面该怎么呈现模型意见：如果稳定核心只占三成，
 * 那模型意见就只能当"线索"而不能当"结论"，且必须告诉用户。
 *
 * 用法：node tools/model-stability.mjs [每稿轮数] [并发]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { fullReview } from '../src/review.js';
import { ACADEMIC_ROOT } from './paths.mjs';

const ROUNDS = Number(process.argv[2] || 4);
const CONC = Number(process.argv[3] || 2);
/** `--only=TUNE` 只跑其中一份（复核粒度时不必重跑全部三份） */
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const OUT = 'tools/.model-stability.json';

const ROOT = ACADEMIC_ROOT;
/** 选三篇不同来源的稿件：调参集、在审集、一审集各一 */
const PICKS = [
  { set: 'TUNE', match: /^02-专题-沈辛成-思政课的灵魂/ },
  { set: 'HOLDA', match: /^07-赵君夫-关于当前我国有效需求问题/ },
  { set: 'HOLDB', match: /^1专题01-瑙姆金论文翻译\.docx$/ },
];
function walk(dir, acc = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === '.adv') continue; walk(p, acc); }
    else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}
const all = walk(ROOT);
const files = [];
for (const pk of PICKS) {
  if (ONLY && pk.set !== ONLY) continue;
  const f = all.find((x) => pk.match.test(path.basename(x)));
  if (f) files.push({ ...pk, f });
  else console.log(`未找到匹配 ${pk.match}`);
}

/**
 * 问题指纹：用「规则号 + 位置 + 引文前 20 字」标识一条问题。
 * 不能用数组下标 —— 顺序会变；也不能只用 ruleId —— 同规则会命中多处。
 */
const fp = (it) => `${it.ruleId}|${it.location}|${String(it.quote || '').slice(0, 20)}`;

const results = [];
for (const { set, f } of files) {
  const name = path.basename(f);
  console.log(`\n═══ ${set}｜${name.slice(0, 40)} ═══`);
  const doc0 = parseDocxBuffer(fs.readFileSync(f), name);
  const chars = doc0.stats?.chars || 0;

  const runs = [];
  let cursor = 0;
  const tasks = Array.from({ length: ROUNDS }, (_, i) => i);
  await Promise.all(Array.from({ length: Math.min(CONC, ROUNDS) }, async () => {
    while (cursor < tasks.length) {
      const i = tasks[cursor]; cursor += 1;
      const t0 = Date.now();
      try {
        const doc = parseDocxBuffer(fs.readFileSync(f), name);
        const res = await fullReview(doc, { model: 'deepseek-v4-1-flash-260910', useRecheck: false });
        const model = res.issues.filter((x) => x.group === 'model');
        const rule = res.issues.filter((x) => x.group !== 'model');
        runs.push({
          round: i + 1,
          modelCount: model.length,
          ruleCount: rule.length,
          modelKeys: [...new Set(model.map(fp))],
          ruleKeys: [...new Set(rule.map(fp))],
          score: res.verdict.score,
          sec: Math.round((Date.now() - t0) / 1000),
        });
        console.log(`  第 ${i + 1} 轮：模型 ${model.length} 条｜规则 ${rule.length} 条｜判定分 ${res.verdict.score}（${Math.round((Date.now() - t0) / 1000)}s）`);
      } catch (e) {
        console.log(`  第 ${i + 1} 轮失败：${String(e.message).slice(0, 90)}`);
      }
    }
  }));
  if (!runs.length) continue;
  runs.sort((a, b) => a.round - b.round);

  /* ── 分析 ── */
  const counts = runs.map((r) => r.modelCount);
  const mean = counts.reduce((s, v) => s + v, 0) / counts.length;
  const sd = Math.sqrt(counts.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, counts.length - 1));
  // 跨轮出现次数直方图
  const seen = new Map();
  for (const r of runs) for (const k of new Set(r.modelKeys)) seen.set(k, (seen.get(k) || 0) + 1);
  const freq = {};
  for (const v of seen.values()) freq[v] = (freq[v] || 0) + 1;
  const stable = [...seen.values()].filter((v) => v === runs.length).length;
  const once = [...seen.values()].filter((v) => v === 1).length;

  // 规则引擎确定性对照
  const ruleSets = runs.map((r) => r.ruleKeys.join('\u0001'));
  const ruleIdentical = new Set(ruleSets).size === 1;
  const ruleCounts = runs.map((r) => r.ruleCount);

  const rec = {
    set, file: name, chars, rounds: runs.length,
    modelCounts: counts, modelMean: Math.round(mean * 10) / 10, modelSd: Math.round(sd * 10) / 10,
    modelCvPct: mean ? Math.round((sd / mean) * 1000) / 10 : null,
    unionModel: seen.size, stableAcrossAllRuns: stable, appearedOnce: once,
    stablePct: seen.size ? Math.round((stable / seen.size) * 1000) / 10 : null,
    freqHistogram: freq,
    /**
     * 按轮保存的 key 列表 —— 必须存。
     * 只存并集统计的话，事后无法复核"不稳定"是**真的每轮说不同的事**，
     * 还是仅仅引文片段在飘（指纹含 quote，会夸大不稳定）。
     * 粒度复核见 `tools/model-stability-grain.mjs`。
     */
    modelKeysByRound: runs.map((r) => r.modelKeys),
    ruleKeysByRound: runs.map((r) => r.ruleKeys),
    ruleCounts, ruleIdenticalAcrossRuns: ruleIdentical,
    scores: runs.map((r) => r.score),
    seconds: runs.map((r) => r.sec),
  };
  results.push(rec);
  console.log(`  → 模型问题数 ${counts.join(' / ')}｜均值 ${rec.modelMean} 标准差 ${rec.modelSd}（CV ${rec.modelCvPct}%）`);
  console.log(`  → 并集 ${seen.size} 条｜N 轮都出现的稳定核心 ${stable} 条（${rec.stablePct}%）｜只出现一次 ${once} 条`);
  console.log(`  → 出现次数分布 ${JSON.stringify(freq)}`);
  console.log(`  → 规则引擎跨轮完全一致：${ruleIdentical ? '是' : '否'}（问题数 ${ruleCounts.join('/')}）`);
}
fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
console.log(`\n已写入 ${OUT}`);
const ok = results.filter((r) => r.rounds >= 2);
if (ok.length) {
  const avgCv = ok.reduce((s, r) => s + (r.modelCvPct || 0), 0) / ok.length;
  const avgStable = ok.reduce((s, r) => s + (r.stablePct || 0), 0) / ok.length;
  console.log(`\n汇总：模型问题数平均变异系数 ${Math.round(avgCv * 10) / 10}%｜稳定核心平均占比 ${Math.round(avgStable * 10) / 10}%`);
  console.log(`规则引擎跨轮一致性：${ok.every((r) => r.ruleIdenticalAcrossRuns) ? '全部稿件完全一致' : '存在不一致'}`);
}
