/**
 * 规则方向性核查（rule direction audit）
 * ---------------------------------------------------------------
 * 为什么需要这个脚本
 * ------------------
 * 第 28 轮确立了一条裁决标准，用来判断「一条规则到底在抓缺陷还是在抓正常写作」：
 *
 *   一条真规则，在**编辑已认可的稿件**上的命中率必须**低于**在编辑动手改过的稿件上。
 *
 * 已认可 = 文件名含「发排版」（编辑已排版刊发，没认为有问题）。
 * 但已过审层只有 14 篇，比例的标准误约 13 个百分点 —— 单靠它噪声太大。
 *
 * 所以本脚本引入**第二个、样本量大得多的方向判据**：编辑痕迹。
 * 语料里 427 篇有修订记录（26.9 万处）、434 篇有批注（8998 条），
 * 448 篇（70.9%）带任一编辑痕迹。编辑**动手改过的**稿件，就是编辑认为有问题的稿件。
 *
 *   若一条规则抓的是真缺陷，它在「有编辑痕迹」的稿件上命中率应**明显更高**；
 *   若两个群体命中率差不多（Δ≈0）甚至反向，它抓的多半是**所有稿件都有的正常写作特征**。
 *
 * 两个判据互为补充：分层判据样本小但语义强，痕迹判据样本大但语义稍弱。
 * 两者都反向 = 强烈怀疑；两者都正向 = 判据站得住。
 *
 * 用法：node tools/rule-direction.mjs [--md]
 * 产出：data/verify/rule-direction.json（+ 可选 data/verify/规则方向性.md）
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { CORPUS_ROOT: RESOLVED_CORPUS_ROOT } = await import('./paths.mjs');
const { mapCorpus } = await import('./lib/corpus.mjs');

/** 语料根目录：统一由 `paths.mjs` 解析（可移植），DSH_CORPUS_ROOT 可覆盖 */
const CORPUS_ROOT = process.env.DSH_CORPUS_ROOT || RESOLVED_CORPUS_ROOT;

function walk(dir, acc = [], depth = 0) {
  if (depth > 6) return acc;
  let items;
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const it of items) {
    const p = join(dir, it.name);
    if (it.isDirectory()) walk(p, acc, depth + 1);
    else if (it.isFile() && /\.docx$/i.test(it.name) && !it.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}

const files = walk(CORPUS_ROOT);
if (!files.length) {
  console.error(`未找到语料：${CORPUS_ROOT}`);
  process.exit(1);
}

/**
 * 每个规则累计两个群体的文档数与命中数。
 * 群体划分：
 *   traced   = 该稿件有修订记录或批注（编辑动过手）
 *   untraced = 该稿件没有任何编辑痕迹
 *   approved = 文件名含「发排版」（编辑已排版刊发）
 */
const acc = new Map();
const group = { traced: 0, untraced: 0, approved: 0, other: 0 };
let parsed = 0;
let failed = 0;

const bump = (id, field, n = 1) => {
  if (!acc.has(id)) {
    acc.set(id, {
      id,
      docsTraced: 0, hitsTraced: 0,
      docsUntraced: 0, hitsUntraced: 0,
      docsApproved: 0, hitsApproved: 0,
      docsOther: 0, hitsOther: 0,
      docsTotal: 0, hitsTotal: 0,
    });
  }
  const a = acc.get(id);
  a[field] += n;
};

const items = files.map((f) => ({ full: f, path: f }));
const raws = await mapCorpus(items, 'direction', {
  onProgress: (done, total) => { if (done % 50 === 0 || done === total) process.stdout.write(`  进度 ${done}/${total}\r`); },
});
console.log('');

for (const [i, msg] of raws.entries()) {
  if (!msg || !msg.result) { failed += 1; continue; }
  parsed += 1;

  const name = items[i].full.split(/[\\/]/).pop();
  const approved = /发排版/.test(name);
  const traced = !!msg.result.traced;

  if (approved) group.approved += 1;
  else group.other += 1;
  if (traced) group.traced += 1; else group.untraced += 1;

  for (const [id, n] of Object.entries(msg.result.ruleCounts)) {
    bump(id, 'docsTotal'); bump(id, 'hitsTotal', n);
    if (traced) { bump(id, 'docsTraced'); bump(id, 'hitsTraced', n); }
    else { bump(id, 'docsUntraced'); bump(id, 'hitsUntraced', n); }
    if (approved) { bump(id, 'docsApproved'); bump(id, 'hitsApproved', n); }
    else { bump(id, 'docsOther'); bump(id, 'hitsOther', n); }
  }
}

const pct = (n, d) => (d ? (n / d) * 100 : 0);

const rows = [...acc.values()].map((a) => {
  const rateTraced = pct(a.docsTraced, group.traced);
  const rateUntraced = pct(a.docsUntraced, group.untraced);
  const rateApproved = pct(a.docsApproved, group.approved);
  const rateOther = pct(a.docsOther, group.other);
  /**
   * Δ痕迹 = 有痕迹群体命中率 − 无痕迹群体命中率。
   * 真缺陷应 > 0；≈0 或 < 0 说明该规则不区分「编辑认为有问题」与「编辑没意见」。
   */
  const dTrace = rateTraced - rateUntraced;
  /**
   * Δ分层 = 在审命中率 − 已过审命中率。
   * 真缺陷应 > 0（在审更高）。已过审只有 14 篇，故只作参考。
   */
  const dLayer = rateOther - rateApproved;
  return {
    id: a.id,
    docs: a.docsTotal,
    hits: a.hitsTotal,
    rateTraced: +rateTraced.toFixed(1),
    rateUntraced: +rateUntraced.toFixed(1),
    dTrace: +dTrace.toFixed(1),
    rateOther: +rateOther.toFixed(1),
    rateApproved: +rateApproved.toFixed(1),
    dLayer: +dLayer.toFixed(1),
    approvedDocs: a.docsApproved,
    docsTraced: a.docsTraced,
    docsUntraced: a.docsUntraced,
  };
}).sort((x, y) => x.dTrace - y.dTrace);

/** 判定：两个判据都反向或接近零 → 怀疑；都正向 → 站得住 */
for (const r of rows) {
  /**
   * ⚠️ 判定权重必须**以 Δ分层 为主、Δ痕迹 为辅**。第 29 轮实测校准：
   *
   * 「无编辑痕迹」**不等于**「编辑认可」。实测文件名标记与痕迹的关系：
   *
   *   | 群体 | 文件名含「一审/done/定稿…」 | 不含 |
   *   |---|---:|---:|
   *   | 有痕迹 448 篇 | 85.9% | 14.1% |
   *   | 无痕迹 184 篇 | 27.2% | **72.8%** |
   *
   * 即无痕迹组绝大多数是**还没进过编辑流程的早期稿件**，本身就更容易有格式问题。
   * 于是 Δ痕迹 低可能只说明「这条规则抓的是会被编辑在早期就改掉的格式问题」——
   * **那正是它该做的事**。
   *
   * 反例（本轮的教训）：FMT-024（年代统一为阿拉伯数字）Δ痕迹 = −14.0 看着很可疑，
   * 但编辑修订证据是**压倒性正向**的：中文数字→阿拉伯数字 **92 处**，
   * 反向仅 **3 处**。若只看 Δ痕迹 就会误删一条好规则。
   *
   * 所以判定改为：
   *   · Δ分层 <= 0        → 「分层反向」：**最硬的怀疑**（已过审稿件命中率不更低）；
   *   · Δ痕迹 <= 0 且 Δ分层 <= 3 → 「双向反向」：两个判据都不支持；
   *   · Δ痕迹 低但 Δ分层 明显正向 → 「痕迹低但分层正向」：**不得据此删除**，
   *     须另找编辑修订/批注证据再定（见上面 FMT-024 的教训）。
   */
  if (r.dLayer <= 0) r.verdict = '分层反向';
  else if (r.dTrace <= 0 && r.dLayer <= 3) r.verdict = '双向反向';
  else if (r.dTrace <= 0) r.verdict = '痕迹低但分层正向';
  else if (r.dTrace <= 3) r.verdict = '痕迹无区分';
  else r.verdict = '方向正确';
}

const summary = {
  meta: {
    generatedAt: new Date().toISOString(),
    corpusRoot: CORPUS_ROOT,
    parsed,
    failed,
    groups: group,
    criterion: '真规则应在「有编辑痕迹」与「在审」稿件上命中率更高；dTrace<=0 且 dLayer<=0 为双向反向',
  },
  rules: rows,
};

const OUT_DIR = join(ROOT, 'data', 'verify');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'rule-direction.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

const md = process.argv.includes('--md');
if (md) {
  const L = [];
  L.push('# 规则方向性核查\n');
  L.push(`- 生成时间：${summary.meta.generatedAt}`);
  L.push(`- 语料：${parsed} 篇可解析（失败 ${failed}）`);
  L.push(`- 群体：有编辑痕迹 ${group.traced} 篇 / 无痕迹 ${group.untraced} 篇；已过审 ${group.approved} 篇 / 在审 ${group.other} 篇`);
  L.push('- 判据：真缺陷应在「有编辑痕迹」群体命中率更高（Δ痕迹 > 0）；在审群体应高于已过审（Δ分层 > 0）');
  L.push('');
  L.push('## 判定权重（重要）');
  L.push('');
  L.push('**以 Δ分层 为主、Δ痕迹 为辅。**「无编辑痕迹」不等于「编辑认可」——实测无痕迹组 72.8% 的文件名不含「一审/done/定稿」等处理标记（有痕迹组只有 14.1%），说明它们大多是**还没进过编辑流程的早期稿件**，本就更容易有格式问题。');
  L.push('');
  L.push('因此 Δ痕迹 低可能只说明「这条规则抓的是编辑会在早期就改掉的格式问题」——那正是它该做的事。**反例：** FMT-024（年代统一为阿拉伯数字）Δ痕迹 = −14.0，但编辑修订证据压倒性正向（中文数字→阿拉伯数字 **92 处**，反向仅 **3 处**）；只看 Δ痕迹 会误删一条好规则。');
  L.push('');
  L.push('- `分层反向`：Δ分层 ≤ 0，**最硬的怀疑**（已过审稿件命中率不更低）');
  L.push('- `双向反向`：Δ痕迹 ≤ 0 且 Δ分层 ≤ 3，两个判据都不支持');
  L.push('- `痕迹低但分层正向`：**不得据此删除**，须另找编辑修订/批注证据再定');
  L.push('- `方向正确`：两个判据都正向\n');
  L.push('| 规则 | 命中 | 有痕迹% | 无痕迹% | Δ痕迹 | 在审% | 已过审% | Δ分层 | 判定 |');
  L.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const r of rows) {
    L.push(`| ${r.id} | ${r.hits} | ${r.rateTraced} | ${r.rateUntraced} | ${r.dTrace} | ${r.rateOther} | ${r.rateApproved} | ${r.dLayer} | ${r.verdict} |`);
  }
  writeFileSync(join(OUT_DIR, '规则方向性.md'), `${L.join('\n')}\n`, 'utf8');
}

const byVerdict = {};
for (const r of rows) byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;

console.log(`语料 ${parsed} 篇（失败 ${failed}）`);
console.log(`群体：有编辑痕迹 ${group.traced} / 无痕迹 ${group.untraced}；已过审 ${group.approved} / 在审 ${group.other}`);
console.log(`参与统计的规则：${rows.length} 条`);
for (const [k, v] of Object.entries(byVerdict)) console.log(`  ${k}: ${v} 条`);

console.log('\n=== 最可疑的 18 条（Δ痕迹 最低）===');
console.log('  规则        命中  有痕迹%  无痕迹%  Δ痕迹  在审%  已过审%  Δ分层  判定');
for (const r of rows.slice(0, 18)) {
  console.log(`  ${r.id.padEnd(11)}${String(r.hits).padStart(5)} ${String(r.rateTraced).padStart(7)} ${String(r.rateUntraced).padStart(8)} ${String(r.dTrace).padStart(6)} ${String(r.rateOther).padStart(6)} ${String(r.rateApproved).padStart(8)} ${String(r.dLayer).padStart(7)}  ${r.verdict}`);
}
console.log('\n=== 最站得住的 8 条（Δ痕迹 最高）===');
for (const r of rows.slice(-8).reverse()) {
  console.log(`  ${r.id.padEnd(11)}${String(r.hits).padStart(5)} ${String(r.rateTraced).padStart(7)} ${String(r.rateUntraced).padStart(8)} ${String(r.dTrace).padStart(6)} ${String(r.rateOther).padStart(6)} ${String(r.rateApproved).padStart(8)} ${String(r.dLayer).padStart(7)}  ${r.verdict}`);
}
console.log(`\n明细已写入 data/verify/rule-direction.json${md ? ' 与 data/verify/规则方向性.md' : ''}`);
