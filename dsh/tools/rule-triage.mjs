/**
 * 规则裁决台账（第 3 轮）——把「方向性」与「编辑批注重合率」两个独立信号合到一起，
 * 给每条规则一个**可执行的处置建议**，并列出可疑命中原文供人工/本工具裁决。
 *
 * 两个信号的分工
 * --------------
 *   Δ痕迹（rule-direction）：真缺陷应 > 0（编辑动过手的稿件命中更多）。
 *     n=448/184，样本大、最稳。
 *   Δ分层（rule-direction）：真缺陷应 > 0（在审命中 > 已过审）。
 *     仅 14 篇已过审，±7pp/篇，噪声大，只作参考。
 *   重合率（rule-fp-ledger）：命中段落与编辑批注锚点的重合比例。
 *     低重合率是「可疑信号」，不是「误报」定论（见 ledger 头部说明）。
 *
 * 处置建议（**保守**：方向信号只是筛查，不是定论）
 * ------------------------------------------------
 *   keep           Δ痕迹 > 0           → 判据站得住，分层反向按噪声处理（14 篇样本太薄）
 *   small          docs < 10           → 样本不足，暂不动
 *   sample-review  Δ痕迹≤0 且 Δ分层≤0  → **抽样复核**（需看命中原文再定性）
 *
 * ⚠️ 为什么不直接给「降级/改模型」的自动结论：
 * 第 31 轮对全部 13 条「两者都反向」规则做了样本复核，结论是 —— **绝大多数是
 * 真命中**，低重合率只是因为编辑不逐条标注体例问题（ledger 头部已警告）。
 * 例如 CIT-014（转引）、LANG-003（涉及到→涉及）、CIT-008（页码用短横线）、
 * FMT-024（20世纪20年代→1920年代）的样本**都是真问题**。
 * 只有 **LANG-020** 经窗口扫描证明「任何阈值下 Δ痕迹都为负」，才真正改判为 model
 * （见 tools/lang020-window-sweep.mjs）。因此本工具只把规则排到「待复核」，
 * 降级/改模型必须**逐条看样本 + 做阈值扫描**后才能定。
 *
 * 用法：node tools/rule-triage.mjs [--json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V = join(ROOT, 'data', 'verify');

const dir = JSON.parse(readFileSync(join(V, 'rule-direction.json'), 'utf8'));
const led = JSON.parse(readFileSync(join(V, 'rule-fp-ledger.json'), 'utf8'));
const dirRows = Array.isArray(dir) ? dir : (dir.rules || dir.rows || []);
const ledById = new Map((led.rules || []).map((r) => [r.id, r]));

const rows = [];
for (const d of dirRows) {
  const l = ledById.get(d.id) || {};
  const overlapRate = l.overlapRate ?? null;
  const docs = d.docs;
  let action = 'keep';
  if (docs < 10) action = 'small';
  else if (d.dTrace > 0) action = 'keep';
  else if (d.dLayer <= 0) action = 'sample-review';   // 两者都反向 → 需抽样复核
  else action = 'keep';                                // Δ痕迹≤0 但分层正向 → 噪声
  rows.push({
    id: d.id, docs, hits: d.hits, dTrace: d.dTrace, dLayer: d.dLayer,
    overlap: l.overlap ?? null, overlapRate, verdict: d.verdict, action,
    samples: (l.samples || []).slice(0, 3),
  });
}

const order = { 'sample-review': 0, small: 1, keep: 2 };
rows.sort((a, b) => (order[a.action] - order[b.action]) || (b.docs - a.docs));

writeFileSync(join(V, 'rule-triage.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2), 'utf8');

const byAction = rows.reduce((m, r) => { m[r.action] = (m[r.action] || 0) + 1; return m; }, {});
console.log('规则裁决台账');
console.log('处置分布：' + Object.entries(byAction).map(([k, v]) => `${k} ${v}`).join('｜'));
console.log('\nID            docs  dTrace dLayer 重合率  处置         可疑样本（前 2 条）');
for (const r of rows.filter((x) => x.action !== 'keep').slice(0, 30)) {
  console.log(`${r.id.padEnd(12)} ${String(r.docs).padStart(3)} ${String(r.dTrace).padStart(6)} ${String(r.dLayer).padStart(6)} ${r.overlapRate === null ? '  n/a' : (r.overlapRate * 100).toFixed(1).padStart(5) + '%'} ${r.action.padEnd(12)}`);
  for (const s of r.samples.slice(0, 2)) console.log(`               · ${String(s.message || '').slice(0, 40)} ｜ ${String(s.quote || '').replace(/\s+/g, '').slice(0, 48)}`);
}
if (process.argv.includes('--json')) console.log('\n' + JSON.stringify(rows.filter((x) => x.action !== 'keep'), null, 2));
