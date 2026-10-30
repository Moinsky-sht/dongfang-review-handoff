/**
 * 规则覆盖全量测试
 * ---------------------------------------------------------------
 * 目的：把「每条规则是否真的会被触发」从叙述变成可复现证据。
 *
 * 做法：遍历语料库全部 .docx，逐篇跑三套确定性扫描器，统计
 *   1. 每条规则在多少篇稿件里触发、总共触发多少次
 *   2. 哪些规则在 659 份稿件里一次都没触发（=未被验证的规则）
 *   3. 每篇稿件的批改结果（问题条数、按引擎/规则分布）
 *
 * 说明：只对**可解析的 .docx** 统计。27 份旧版 .doc（OLE2 复合文档）无法解析，
 * 由 batch-verify 单独归类并给出「请另存为 .docx」的提示，这里不再重复计为失败。
 * 遍历走 `tools/lib/corpus.mjs`（manifest + 多核并行），与 batch-verify 同一套清单逻辑。
 *
 * 输出：
 *   data/verify/rule-coverage.json   机器可读明细
 *   data/verify/规则覆盖报告.md       人读报告
 *
 * 用法：node tools/rule-coverage.mjs [--limit N] [--out 目录]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpusList, mapCorpus } from './lib/corpus.mjs';
import { CORPUS_ROOT } from './paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const LIMIT = Number(argOf('limit', 0)) || 0;
const OUT_DIR = argOf('out', join(ROOT, 'data', 'verify'));

/* ---------- 规则清单（含未实现的人工规则） ---------- */
function loadAllRuleIds() {
  const out = [];
  for (const [group, file] of [['format', 'format-rules.json'], ['language', 'language-rules.json'], ['citation', 'citation-rules.json']]) {
    const obj = JSON.parse(readFileSync(join(ROOT, 'rules', file), 'utf8'));
    for (const r of obj.rules || []) {
      out.push({ id: r.id, group, title: r.title, severity: r.severity, detectType: r.detect?.type || null, status: r.status || null });
    }
  }
  return out;
}

/* ---------- 主流程 ---------- */
const { list: corpusList } = loadCorpusList({ docxOnly: true, dropLegacy: false });
const targets = LIMIT ? corpusList.slice(0, LIMIT) : corpusList;

console.log(`规则覆盖测试：${targets.length} 篇稿件`);

const ruleIds = loadAllRuleIds();
console.log(`规则清单：${ruleIds.length} 条\n`);

const hitCount = new Map();     // ruleId -> 总触发次数
const hitDocs = new Map();      // ruleId -> 触发的稿件数
const perDoc = [];
const errors = [];
const engineTotals = { format: 0, language: 0, citation: 0 };

const t0 = Date.now();
const raws = await mapCorpus(targets, 'coverage', {
  onProgress: (done, total) => {
    if (done % 50 === 0 || done === total) {
      const el = ((Date.now() - t0) / 1000).toFixed(0);
      process.stdout.write(`  进度 ${done}/${total}  (${el}s)\r`);
    }
  },
});
console.log('');

for (const [i, msg] of raws.entries()) {
  const rel = targets[i].path;
  const name = rel.split(/[\\/]/).pop();
  if (!msg || !msg.result) {
    errors.push({ file: name, error: (msg && msg.error) ? msg.error : '未知错误' });
    continue;
  }
  const r = msg.result;
  engineTotals.format += r.format;
  engineTotals.language += r.language;
  engineTotals.citation += r.citation;

  for (const [id, n] of Object.entries(r.ruleCounts)) {
    hitCount.set(id, (hitCount.get(id) || 0) + n);
    hitDocs.set(id, (hitDocs.get(id) || 0) + 1);
  }
  perDoc.push({
    // 同时留全路径与文件名：全路径用于后续复现验证，文件名用于报告可读性
    path: rel,
    file: name,
    paragraphs: r.paragraphs,
    chars: r.chars,
    footnotes: r.footnotes,
    comments: r.comments,
    issues: r.issues,
    format: r.format,
    language: r.language,
    citation: r.citation,
    rules: r.rules,
  });
}
const elapsed = (Date.now() - t0) / 1000;
console.log(`\n完成：${perDoc.length} 篇成功，${errors.length} 篇失败，用时 ${elapsed.toFixed(1)}s`);

/* ---------- 汇总 ---------- */
const never = ruleIds.filter((r) => !hitDocs.has(r.id));
const fired = ruleIds.filter((r) => hitDocs.has(r.id));
const byGroup = {};
for (const r of ruleIds) {
  byGroup[r.group] ??= { total: 0, fired: 0, never: 0 };
  byGroup[r.group].total++;
  if (hitDocs.has(r.id)) byGroup[r.group].fired++; else byGroup[r.group].never++;
}
const totalIssues = perDoc.reduce((s, d) => s + d.issues, 0);
const sorted = [...perDoc].sort((a, b) => a.issues - b.issues);
const median = sorted.length ? sorted[Math.floor(sorted.length / 2)].issues : 0;

console.log(`\n总问题数 ${totalIssues}（格式 ${engineTotals.format} / 语言 ${engineTotals.language} / 引文 ${engineTotals.citation}）`);
console.log(`每篇中位数 ${median} 条，最多 ${sorted.at(-1)?.issues ?? 0} 条`);
console.log(`\n规则触发情况：${fired.length}/${ruleIds.length} 条至少触发过一次，${never.length} 条从未触发`);
for (const [g, v] of Object.entries(byGroup)) {
  console.log(`  ${g.padEnd(9)} ${v.fired}/${v.total} 已触发，${v.never} 未触发`);
}
if (never.length) {
  console.log('\n从未触发的规则：');
  for (const r of never) console.log(`  · ${r.id} [${r.group}/${r.detectType || 'manual'}] ${r.title}`);
}

/* ---------- 落盘 ---------- */
mkdirSync(OUT_DIR, { recursive: true });
const jsonPath = join(OUT_DIR, 'rule-coverage.json');
writeFileSync(jsonPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  corpusRoot: CORPUS_ROOT,
  docsScanned: perDoc.length,
  docsFailed: errors.length,
  elapsedSeconds: Number(elapsed.toFixed(1)),
  totals: { issues: totalIssues, ...engineTotals, medianPerDoc: median, maxPerDoc: sorted.at(-1)?.issues ?? 0 },
  rules: ruleIds.map((r) => ({
    ...r,
    hits: hitCount.get(r.id) || 0,
    docs: hitDocs.get(r.id) || 0,
    fired: hitDocs.has(r.id),
  })),
  byGroup,
  neverFired: never.map((r) => r.id),
  perDoc,
  errors,
}, null, 1), 'utf8');
console.log(`\n明细已写入 ${jsonPath}`);

const md = [];
md.push('# 规则覆盖全量测试报告');
md.push('');
md.push(`生成时间：${new Date().toLocaleString('zh-CN')}`);
md.push('');
md.push('## 一、结论');
md.push('');
md.push(`- 扫描稿件：**${perDoc.length}** 篇（失败 ${errors.length} 篇），用时 ${elapsed.toFixed(1)} 秒`);
md.push(`- 累计问题：**${totalIssues}** 条（格式 ${engineTotals.format} / 语言 ${engineTotals.language} / 引文 ${engineTotals.citation}）`);
md.push(`- 每篇中位数 **${median}** 条，最多 **${sorted.at(-1)?.issues ?? 0}** 条`);
md.push(`- 规则触发：**${fired.length}/${ruleIds.length}** 条至少触发过一次，**${never.length}** 条从未触发`);
md.push('');
md.push('## 二、分组触发情况');
md.push('');
md.push('| 分组 | 规则数 | 已触发 | 未触发 | 触发率 |');
md.push('| --- | ---: | ---: | ---: | ---: |');
for (const [g, v] of Object.entries(byGroup)) {
  md.push(`| ${g} | ${v.total} | ${v.fired} | ${v.never} | ${(v.fired / v.total * 100).toFixed(0)}% |`);
}
md.push('');
md.push('## 三、触发次数排行（前 30）');
md.push('');
md.push('| 规则 | 分组 | 触发稿件数 | 触发总次数 | 标题 |');
md.push('| --- | --- | ---: | ---: | --- |');
const top = ruleIds.slice().sort((a, b) => (hitCount.get(b.id) || 0) - (hitCount.get(a.id) || 0)).slice(0, 30);
for (const r of top) {
  md.push(`| ${r.id} | ${r.group} | ${hitDocs.get(r.id) || 0} | ${hitCount.get(r.id) || 0} | ${(r.title || '').slice(0, 40)} |`);
}
md.push('');
md.push('## 四、从未触发的规则（需人工确认或补测试样本）');
md.push('');
if (!never.length) md.push('无。全部规则至少触发过一次。');
else {
  md.push('| 规则 | 分组 | 检测方式 | 标题 |');
  md.push('| --- | --- | --- | --- |');
  for (const r of never) md.push(`| ${r.id} | ${r.group} | ${r.detectType || 'manual'} | ${(r.title || '').slice(0, 50)} |`);
}
md.push('');
md.push('## 五、问题最多的 15 篇');
md.push('');
md.push('| 稿件 | 问题 | 格式 | 语言 | 引文 |');
md.push('| --- | ---: | ---: | ---: | ---: |');
for (const d of sorted.slice(-15).reverse()) {
  md.push(`| ${d.file.slice(0, 60)} | ${d.issues} | ${d.format} | ${d.language} | ${d.citation} |`);
}
if (errors.length) {
  md.push('');
  md.push('## 六、失败稿件');
  md.push('');
  for (const e of errors) md.push(`- ${e.file}：${e.error}`);
}
md.push('');
const mdPath = join(OUT_DIR, '规则覆盖报告.md');
writeFileSync(mdPath, md.join('\n'), 'utf8');
console.log(`报告已写入 ${mdPath}`);
