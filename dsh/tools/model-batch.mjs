/**
 * 模型审阅链路验证：用 async 模式跑真实模型审阅，验证
 *   上传 → 异步模型审阅（轮询进度）→ 结果完整性 → 报告
 * 全程无异常，并记录耗时与 token 用量。
 *
 * 用法：
 *   node tools/model-batch.mjs                    # 默认 3 份
 *   node tools/model-batch.mjs --count=5
 *   node tools/model-batch.mjs --model=glm-5-3-flash-260828
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3210';
const args = process.argv.slice(2);
const flag = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const COUNT = Number(flag('count', 3)) || 3;
const MODEL = flag('model', '');
const ROOT = resolve('..', '发给皓天的一审文件');
// 模型审阅实测 560—890 秒/份（随段落数增长），默认给到 30 分钟，
// 否则较长的稿件会被误判为「超时未完成」（曾用 15 分钟，范勇鹏那份 890 秒刚好超时）。
const TIMEOUT_MS = Number(flag('timeout', 1800000)) || 1800000;

const manifest = JSON.parse(readFileSync(resolve('data/corpus/manifest.json'), 'utf8'));
let picks = manifest.filter((m) => existsSync(join(ROOT, m.path)));
// 只挑体量适中的稿件，避免单次验证耗时过长；均匀分布保证覆盖不同季次
picks = picks.filter((m) => (m.paragraphs || 0) > 20 && (m.paragraphs || 0) < 200);
const step = Math.max(1, Math.floor(picks.length / COUNT));
const sel = [];
for (let i = 0; i < picks.length && sel.length < COUNT; i += step) sel.push(picks[i]);

console.log(`模型审阅链路验证：${sel.length} 份稿件，模型 ${MODEL || '（默认）'}\n`);

const results = [];
for (const [i, m] of sel.entries()) {
  const rec = { name: basename(m.path), model: MODEL || '(default)' };
  const t0 = Date.now();
  try {
    const buf = readFileSync(join(ROOT, m.path));
    const up = await (await fetch(`${BASE}/api/upload?name=${encodeURIComponent(basename(m.path))}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf,
    })).json();
    if (!up.id) { rec.error = `上传失败：${JSON.stringify(up).slice(0, 150)}`; results.push(rec); continue; }
    rec.paragraphs = up.doc?.paragraphs?.length;

    const body = { id: up.id, useModel: true, async: true };
    if (MODEL) body.model = MODEL;
    const acc = await (await fetch(`${BASE}/api/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    if (!acc.accepted) { rec.error = `异步审阅未被接受：${JSON.stringify(acc).slice(0, 150)}`; results.push(rec); continue; }

    // 轮询进度
    let st = null;
    const deadline = Date.now() + TIMEOUT_MS;
    const seen = [];
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      st = await (await fetch(`${BASE}/api/review-status?id=${up.id}`)).json();
      const msg = st.progress?.message;
      if (msg && seen[seen.length - 1] !== msg) { seen.push(msg); process.stdout.write(`    · ${String(msg).slice(0, 70)}\n`); }
      if (!st.running) break;
    }
    if (!st || st.running) { rec.error = '超时未完成'; results.push(rec); continue; }
    if (st.error) { rec.error = `审阅报错：${st.error}`; results.push(rec); continue; }
    const r = st.result;
    if (!r) { rec.error = '无结果返回'; results.push(rec); continue; }

    rec.ruleIssues = r.summary?.ruleBased ?? 0;
    rec.modelIssues = r.summary?.modelBased ?? 0;
    rec.total = r.issues?.length ?? 0;
    rec.model = r.model;
    rec.usage = r.usage;
    rec.modelErrors = r.modelErrors || [];
    // 模型问题必须能定位，否则界面上点不进去。
    // 定位判定要与 buildModelIssue 的三级定位一致：
    //   正文段落 → paragraphIndex；脚注 → footnoteIndex；都没有才是真未定位。
    const modelOnly = (r.issues || []).filter((x) => x.group === 'model');
    rec.modelUnlocated = modelOnly.filter((x) => x.paragraphIndex === undefined
      && x.footnoteIndex === undefined).length;
    rec.modelInFootnote = modelOnly.filter((x) => x.footnoteIndex !== undefined).length;
    rec.modelInParagraph = modelOnly.filter((x) => x.paragraphIndex !== undefined).length;
    // 完整性检查：分项之和必须等于总数，且模型问题不得为 0（否则说明模型链路静默失败）
    rec.checks = [];
    if (rec.ruleIssues + rec.modelIssues !== rec.total) {
      rec.checks.push(`分项之和 ${rec.ruleIssues}+${rec.modelIssues} 不等于总数 ${rec.total}`);
    }
    if (rec.modelIssues === 0) rec.checks.push('模型命中 0 条，模型链路可能静默失败');
    // 未定位的容差：模型偶尔会改写引文而不是逐字摘录，这类反查不到属正常。
    // 超过模型问题数的 5% 才说明定位逻辑有问题。
    const unlocTol = Math.max(2, Math.ceil(rec.modelIssues * 0.05));
    if (rec.modelUnlocated > unlocTol) {
      rec.checks.push(`${rec.modelUnlocated} 条模型问题未定位（容差 ${unlocTol}）`);
    }
    if (rec.checks.length) rec.error = rec.checks.join('；');

    const rp = await (await fetch(`${BASE}/api/report`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: up.id }),
    })).json();
    rec.reportChars = rp.markdown?.length || 0;
    if (!rec.reportChars) rec.error = '报告生成为空';
  } catch (err) {
    rec.error = `异常：${err.message}`;
  }
  rec.sec = Number(((Date.now() - t0) / 1000).toFixed(1));
  results.push(rec);
  console.log(`${i + 1}/${sel.length} ${rec.error ? '✗' : '✓'} ${rec.name.slice(0, 42)} — ${rec.sec}s`
    + (rec.error ? `  错误：${rec.error}` : `  规则 ${rec.ruleIssues} + 模型 ${rec.modelIssues} = ${rec.total} 条`));
}

console.log('\n═══ 汇总 ═══');
const ok = results.filter((r) => !r.error);
console.log(`成功 ${ok.length} / ${results.length}`);
for (const r of ok) {
  console.log(`  ${r.name.slice(0, 40)}: ${r.sec}s，模型 ${r.model}，规则 ${r.ruleIssues} + 模型 ${r.modelIssues} = ${r.total}，报告 ${r.reportChars} 字符`);
  if (r.usage) console.log(`     token 输入 ${r.usage.input_tokens ?? '-'} / 输出 ${r.usage.output_tokens ?? '-'}`);
  if (r.modelErrors.length) console.log(`     模型告警 ${r.modelErrors.length} 条：${r.modelErrors.slice(0, 2).map((e) => String(e.message || e).slice(0, 60)).join('；')}`);
  if (r.modelInParagraph || r.modelInFootnote) console.log(`     定位：正文段落 ${r.modelInParagraph} 条 + 脚注 ${r.modelInFootnote} 条 + 未定位 ${r.modelUnlocated} 条`);
  if (r.checks?.length) console.log(`     检查未通过：${r.checks.join('；')}`);
}
const bad = results.filter((r) => r.error);
if (bad.length) {
  console.log('\n失败：');
  for (const r of bad) console.log(`  ${r.name.slice(0, 45)} → ${r.error}`);
}
mkdirSync(resolve('data/verify'), { recursive: true });
writeFileSync(resolve('data/verify/model-batch.json'), JSON.stringify(results, null, 2), 'utf8');
console.log('\n明细：data/verify/model-batch.json');
