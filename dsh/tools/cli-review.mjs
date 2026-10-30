/**
 * 命令行审稿工具：跑通「解析 → 规则扫描 → 模型审阅 → 报告」全流程。
 *
 * 用法：
 *   node tools/cli-review.mjs <稿件.docx> [--no-model] [--model=xxx] [--out=报告.md] [--json=结果.json]
 */
import { parseDocx, fullReview, buildReport } from '../src/review.js';
import { DEFAULT_MODEL } from '../src/ark.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, basename, join } from 'node:path';

const args = process.argv.slice(2);
let file = args.find((a) => !a.startsWith('--'));

/**
 * 允许用 --sha=<sha256> 或 --pick=<序号> 指定稿件，
 * 由 manifest 解析出真实路径，避免 PowerShell 对中文文件名与长参数的破坏。
 */
const shaOpt = args.find((a) => a.startsWith('--sha='));
const pickOpt = args.find((a) => a.startsWith('--pick='));
if (!file && (shaOpt || pickOpt)) {
  const ROOT = resolve('..', '发给皓天的一审文件');
  const manifest = JSON.parse(readFileSync(resolve('data/corpus/manifest.json'), 'utf8'));
  if (shaOpt) {
    const m = manifest.find((x) => x.sha256 === shaOpt.slice(6));
    if (!m) { console.error('未找到该 sha256 对应的稿件'); process.exit(1); }
    file = join(ROOT, m.path);
  } else {
    const n = Number(pickOpt.slice(7));
    const list = manifest
      .map((m) => ({ ...m, full: join(ROOT, m.path) }))
      .filter((m) => m.comments >= 25 && existsSync(m.full))
      .sort((a, b) => b.comments - a.comments);
    if (!list[n]) { console.error(`序号越界，可选 0..${list.length - 1}`); process.exit(1); }
    file = list[n].full;
    console.log(`[pick ${n}] ${list[n].comments} 条批注 | ${list[n].path}`);
  }
}
if (!file) {
  console.error('用法：node tools/cli-review.mjs <稿件.docx|--sha=xxx|--pick=N> [--no-model] [--model=xxx]');
  process.exit(1);
}
const getOpt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const useModel = !args.includes('--no-model');
// 模型复核（目标点 13）：对每条建议修改再问一次模型是否同意，耗时更长
const useRecheck = args.includes('--recheck');
// E2：判定是否计入模型复核的降级结论（默认关，仅作对照）
const verdictWithModel = args.includes('--verdict-with-model');
const model = getOpt('model', DEFAULT_MODEL);
const outPath = getOpt('out', null);
const jsonPath = getOpt('json', null);

const t0 = Date.now();
console.log(`\n═══ 《东方学刊》审稿智能体 · 命令行审阅 ═══`);
console.log(`稿件：${file}`);
console.log(`模型：${useModel ? model : '（未启用）'}\n`);

const doc = parseDocx(resolve(file));
console.log(`[解析] 段落 ${doc.stats.paragraphs} · 脚注 ${doc.stats.footnotes} · 批注 ${doc.stats.comments} · 修订 ${doc.stats.insertions}/${doc.stats.deletions} · 表格 ${doc.stats.tables} · 约 ${doc.stats.chars} 字`);

const result = await fullReview(doc, {
  useModel,
  useRecheck,
  verdictWithModel,
  model,
  onProgress: (p) => {
    if (p.message) console.log(`[${p.phase}] ${p.message}`);
  },
});

const s = result.summary;
console.log(`\n[结果] 合计 ${s.total} 条问题（规则 ${s.ruleBased} / 模型 ${s.modelBased}）`);
console.log(`  格式体例 ${s.format} · 语言词汇 ${s.language} · 引文注释 ${s.citation}`);
console.log(`  严重度：高 ${s.bySeverity['高'] || 0} · 中 ${s.bySeverity['中'] || 0} · 低 ${s.bySeverity['低'] || 0}`);
if (result.usage) console.log(`  Token：输入 ${result.usage.input_tokens} / 输出 ${result.usage.output_tokens}`);
if (result.modelResult?.errors?.length) console.log(`  模型错误 ${result.modelResult.errors.length} 处`);

/**
 * 合格性判定与模型复核（目标点 10 / 13 / E2）。
 * E2：`verdictModel` 是与主判定**同一基线**、但计入模型复核降级后的参考判定；
 * 二者不同即说明「模型复核确实改变了结论」，默认关、仅作对照。
 */
if (result.verdict) {
  const v = result.verdict;
  console.log(`\n[判定] ${v.verdict}（加权分 ${v.score}${v.per1k != null ? `，每千字 ${v.per1k}` : ''}）`);
  for (const r of v.reasons) console.log(`  · ${r}`);
}
if (result.verdictModel) {
  const vm = result.verdictModel;
  const same = vm.verdict === result.verdict?.verdict;
  console.log(`[判定·含模型复核] ${vm.verdict}（加权分 ${vm.score}）${same ? '（与主判定一致）' : '（与主判定不同）'}`);
}
if (result.recheck) {
  const rs = result.recheck.stats;
  console.log(`[复核] 送复核 ${rs.checked}/${rs.total}：同意 ${rs.agree} / 不同意 ${rs.disagree} / 拿不准 ${rs.unsure}；跳过 ${rs.skipped}`);
  const adjusted = result.issues.filter((i) => i.severityAdjusted);
  if (adjusted.length) {
    console.log(`[复核·已降级] ${adjusted.length} 条：`);
    for (const it of adjusted.slice(0, 10)) console.log(`  · [${it.ruleId}] ${it.severityBase}→${it.severity} ${it.location}`);
  }
}

const byCat = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]);
console.log(`\n[分类]`);
for (const [k, v] of byCat) console.log(`  ${String(v).padStart(4)}  ${k}`);

console.log(`\n[高严重度问题（前 25 条）]`);
for (const it of result.issues.filter((i) => i.severity === '高').slice(0, 25)) {
  console.log(`  · [${it.ruleId}] ${it.location} ${it.title}`);
  if (it.quote) console.log(`      原文：${it.quote.replace(/\n/g, ' ').slice(0, 90)}`);
  if (it.fix) console.log(`      建议：${it.fix.slice(0, 100)}`);
}

const md = buildReport(result, doc);
const base = basename(file).replace(/\.docx?$/i, '');
const out = outPath || resolve('reports', `${base}_审校报告.md`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, md, 'utf8');
console.log(`\n[报告] ${out}`);

if (jsonPath) {
  const jp = resolve(jsonPath);
  mkdirSync(dirname(jp), { recursive: true });
  const payload = {
    meta: result.meta,
    summary: s,
    // 判定与模型复核一并落盘，便于离线核对 E2（verdict vs verdictModel）与降级明细
    verdict: result.verdict || null,
    verdictModel: result.verdictModel || null,
    recheckStats: result.recheck?.stats || null,
    issues: result.issues,
    usage: result.usage,
  };
  writeFileSync(jp, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[JSON] ${jp}`);
}
console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒\n`);
