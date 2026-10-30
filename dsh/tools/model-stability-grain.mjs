/**
 * 模型稳定性的**粒度复核**。
 *
 * 第一版指纹是 `ruleId|location|quote前20字`，得出"4 轮都出现的只占 ~2%"。
 * 但这个指纹可能**夸大**不稳定：模型每轮引用的原文片段（`quote`）起止点会飘，
 * 同一个问题两轮引文不同就会被记成两条不同的问题。
 *
 * 所以按三个粒度分别算重合度，看"不稳定"到底是：
 *   · 规则级就已经不同（真的每轮在说不同的事）→ 结论不可复现
 *   · 规则级相同、只有引文片段飘 → 结论方向稳定，只是取证文字在抖
 *
 * 用法：node tools/model-stability-grain.mjs
 */
import fs from 'node:fs';

const raw = fs.readFileSync('tools/.model-stability.json', 'utf8').replace(/^\uFEFF/, '');
const data = JSON.parse(raw);

const pc = (x) => `${Math.round(x * 1000) / 10}%`;

/** 把 `ruleId|location|quote` 拆开 */
function parse(k) {
  const p = String(k).split('|');
  return { ruleId: p[0], location: p[1] };
}

/** 按给定粒度重算跨轮重合度 */
function grain(perRound, keyFn, label) {
  const n = perRound.length;
  const seen = new Map();
  for (const round of perRound) for (const k of new Set(round.map(keyFn))) seen.set(k, (seen.get(k) || 0) + 1);
  const stable = [...seen.values()].filter((v) => v === n).length;
  const once = [...seen.values()].filter((v) => v === 1).length;
  const half = [...seen.values()].filter((v) => v >= Math.ceil(n / 2)).length;
  const freq = {};
  for (const v of seen.values()) freq[v] = (freq[v] || 0) + 1;
  return {
    label, union: seen.size, stable, stablePct: seen.size ? stable / seen.size : 0,
    half, halfPct: seen.size ? half / seen.size : 0, once, freq,
  };
}

console.log('模型输出稳定性的粒度复核');
console.log('（同一份稿件重复运行 N 轮，看哪些结论跨轮保持）\n');

for (const rec of data) {
  if (!rec.modelKeysByRound || rec.rounds < 2) {
    console.log(`跳过 ${rec.set}：没有按轮保存的 key（用旧版脚本跑的）`);
    continue;
  }
  const perRound = rec.modelKeysByRound;
  console.log('═'.repeat(76));
  console.log(`${rec.set}｜${rec.file.slice(0, 48)}`);
  console.log(`  模型问题数 ${rec.modelCounts.join(' / ')}｜均值 ${rec.modelMean} 标准差 ${rec.modelSd}（CV ${rec.modelCvPct}%）`);
  console.log(`  规则引擎跨轮一致：${rec.ruleIdenticalAcrossRuns ? '是' : '否'}｜判定分 ${rec.scores.join('/')}\n`);

  const grains = [
    grain(perRound, (k) => k, '① ruleId|location|quote前20字'),
    grain(perRound, (k) => `${parse(k).ruleId}|${parse(k).location}`, '② ruleId|location（忽略引文片段）'),
    grain(perRound, (k) => parse(k).ruleId, '③ ruleId（只看规则号）'),
  ];
  for (const g of grains) {
    console.log(`  ${g.label}`);
    console.log(`    并集 ${String(g.union).padStart(3)}｜全 ${rec.rounds} 轮都出现 ${String(g.stable).padStart(3)}（${pc(g.stablePct)}）`
      + `｜≥半数轮 ${String(g.half).padStart(3)}（${pc(g.halfPct)}）｜只出现一次 ${g.once}`);
  }
  console.log(`  逐轮条数 ${rec.modelCounts.join('/')}｜逐轮去重后 `
    + perRound.map((r, i) => `${i + 1}:${new Set(r).size}`).join(' '));
  console.log('');
}

console.log('读法：');
console.log('  若 ① 与 ② 都很低、③ 高 → 模型每轮都在按同样的规则找问题，');
console.log('    但**指到哪一处、引哪一段**每次都不同。');
console.log('  若三个粒度都低 → 连"该用哪条规则"都不稳定，结论不可复现。');
