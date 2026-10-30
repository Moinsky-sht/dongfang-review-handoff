/**
 * 批量导出 632 篇稿件的完整批改结果
 * =================================================================
 * 目的（对应长周期路线图 2.2）
 * ---------------------------
 * 把每一篇稿件的**完整**批改结果落盘，便于：
 *   1. 人工逐篇回看哪些规则批得不对（配合 tools/rule-fp-ledger.mjs 的误报台账）
 *   2. 统计规则命中分布、按稿件看问题密度
 *   3. 作为「审阅质量」的可复现证据（不依赖网页，纯文件）
 *
 * 每篇输出两个文件：
 *   <out>/json/<安全文件名>.json   结构化完整结果（含每条的原文、位置、建议、依据、可否自动改写）
 *   <out>/md/<安全文件名>.md       人读报告
 *
 * 另输出汇总：
 *   <out>/汇总.json                全语料统计（按规则、按稿件、按严重度）
 *   <out>/汇总.md                  人读汇总
 *   <out>/索引.md                  逐篇问题数索引，便于挑样复核
 *
 * 用法：
 *   node tools/export-all-reviews.mjs [--limit N] [--out DIR] [--no-md]
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocx, detectMeta } from '../src/review.js';
import { scanFormat } from '../src/scanner-format.js';
import { scanLanguage } from '../src/scanner-language.js';
import { scanCitation } from '../src/scanner-citation.js';
import { judge } from '../src/verdict.js';

// 判定阈值：由 tools/verdict-report.mjs 用「已过审（发排版）」89 份的分数分布标定
// （P50=35 / P75=53.6 / P90=82）。改了规则库后应重跑该工具重新标定。
const VERDICT_TH = { pass: 35, passMinor: 53.6, revise: 82 };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = Number(argOf('--limit', 0)) || 0;
const OUT = join(ROOT, argOf('--out', 'data/reviews'));
const NO_MD = argv.includes('--no-md');

/** Windows 文件名里不能出现的字符 → 下划线 */
const rawSafeName = (rel) => rel.replace(/\.docx$/i, '')
  .replace(/[\\/:*?"<>|]/g, '_')
  .replace(/\s+/g, ' ')
  .slice(0, 120);

/**
 * 生成唯一文件名。
 *
 * 直接截断到 120 字符会撞名：语料里同一篇稿件的多个版本只靠**末尾**的后缀区分
 * （如「…-专题.docx」与「…-专题【0818一审】.docx」），截断后两者变成同一个名字，
 * 后写的会静默覆盖先写的。实测 632 篇里有 **12 组共 27 篇**撞名，
 * 导出后只剩 617 个文件，丢了 15 篇。
 *
 * 处理：先截断，若已用过则在末尾追加 6 位路径哈希，保证唯一且可追溯。
 */
const usedNames = new Set();
const safeName = (rel) => {
  let n = rawSafeName(rel);
  if (!usedNames.has(n)) { usedNames.add(n); return n; }
  // 用整条相对路径的哈希区分（FNV-1a，短且稳定）
  let h = 0x811c9dc5;
  for (let i = 0; i < rel.length; i += 1) {
    h ^= rel.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const suffix = h.toString(16).padStart(8, '0').slice(0, 6);
  n = `${rawSafeName(rel).slice(0, 110)}__${suffix}`;
  let k = 2;
  let base = n;
  while (usedNames.has(n)) { n = `${base}_${k}`; k += 1; }
  usedNames.add(n);
  return n;
};

const cov = JSON.parse(readFileSync(join(ROOT, 'data', 'verify', 'rule-coverage.json'), 'utf8'));
const corpusRoot = cov.corpusRoot;
let perDoc = cov.perDoc || [];
if (LIMIT) perDoc = perDoc.slice(0, LIMIT);

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'json'), { recursive: true });
if (!NO_MD) mkdirSync(join(OUT, 'md'), { recursive: true });

console.log(`导出 ${perDoc.length} 篇 → ${OUT}\n`);

const SEV_ORDER = { 高: 0, 中: 1, 低: 2 };
const byRule = new Map();
const index = [];
let ok = 0;
let failed = 0;
let totalIssues = 0;
const t0 = Date.now();

for (const d of perDoc) {
  const rel = String(d.path || d.file || '');
  let doc;
  try {
    doc = await parseDocx(join(corpusRoot, rel));
  } catch (e) {
    failed += 1;
    index.push({ file: rel, error: String(e.message).slice(0, 120) });
    continue;
  }

  let issues = [];
  for (const [group, fn] of [['format', scanFormat], ['language', scanLanguage], ['citation', scanCitation]]) {
    try {
      for (const it of fn(doc).issues) issues.push({ ...it, group: it.group || group });
    } catch (e) {
      issues.push({ ruleId: 'INTERNAL', group, severity: '高', title: '扫描器异常', message: String(e.message).slice(0, 200), location: 'document' });
    }
  }
  issues.sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));

  let meta = {};
  try { meta = detectMeta(doc) || {}; } catch { /* 元信息识别失败不影响导出 */ }

  const counts = { 高: 0, 中: 0, 低: 0 };
  const ruleCount = {};
  for (const it of issues) {
    counts[it.severity] = (counts[it.severity] || 0) + 1;
    ruleCount[it.ruleId] = (ruleCount[it.ruleId] || 0) + 1;
    if (!byRule.has(it.ruleId)) {
      byRule.set(it.ruleId, { ruleId: it.ruleId, group: it.group, title: it.title, hits: 0, docs: 0, fixable: 0, severity: it.severity });
    }
    const s = byRule.get(it.ruleId);
    s.hits += 1;
    if (it.autoFix?.find) s.fixable += 1;
  }
  for (const id of Object.keys(ruleCount)) byRule.get(id).docs += 1;

  totalIssues += issues.length;
  ok += 1;

  const base = safeName(rel);
  const payload = {
    file: rel,
    meta,
    stats: {
      paragraphs: doc.stats?.paragraphs,
      chars: doc.stats?.chars,
      footnotes: doc.stats?.footnotes,
      endnotes: doc.stats?.endnotes,
      comments: doc.stats?.comments,
      tables: doc.stats?.tables,
    },
    issueCount: issues.length,
    severityCounts: counts,
    ruleCounts: ruleCount,
    // 合格性判定（目标点 10）：阈值用已过审语料标定，见 tools/verdict-report.mjs
    verdict: judge(issues, { thresholds: VERDICT_TH, chars: doc.stats?.chars || 0 }),
    issues: issues.map((it) => ({
      ruleId: it.ruleId,
      group: it.group,
      severity: it.severity,
      title: it.title,
      message: it.message,
      suggestion: it.suggestion,
      basis: it.basis,
      location: it.location,
      paragraphIndex: it.paragraphIndex,
      footnoteIndex: it.footnoteIndex,
      endnoteIndex: it.endnoteIndex,
      quote: it.quote,
      occurrenceCount: it.occurrenceCount,
      fixable: !!it.autoFix?.find,
      fix: it.autoFix?.find ? { find: it.autoFix.find, replace: it.autoFix.replace } : null,
    })),
  };
  writeFileSync(join(OUT, 'json', `${base}.json`), JSON.stringify(payload, null, 1), 'utf8');

  if (!NO_MD) {
    const md = [];
    md.push(`# 审阅结果：${rel}`, '');
    md.push(`- 栏目：${meta.column || '—'}　作者：${meta.author || '—'}`);
    md.push(`- 段落 ${doc.stats?.paragraphs ?? '—'}　字数 ${doc.stats?.chars ?? '—'}　`
      + `脚注 ${doc.stats?.footnotes ?? 0}　尾注 ${doc.stats?.endnotes ?? 0}　批注 ${doc.stats?.comments ?? 0}`);
    md.push(`- 问题合计 **${issues.length}** 条（高 ${counts.高 || 0} / 中 ${counts.中 || 0} / 低 ${counts.低 || 0}）`);
    md.push('');
    md.push(`## 合格性判定：**${payload.verdict.verdict}**`, '');
    md.push(`加权分 **${payload.verdict.score}**${payload.verdict.per1k !== null ? `（每千字 ${payload.verdict.per1k} 分）` : ''}`, '');
    md.push('判定理由：');
    for (const r of payload.verdict.reasons) md.push(`- ${r}`);
    md.push('');
    md.push('> 判定口径：阈值由语料中「已过审（发排版）」89 份的分数分布标定（合格 ≤ 35，基本合格 ≤ 53.6，需修改 ≤ 82）。');
    md.push('> 两层稿件重叠较大，判定用于**排序与提示**，不代替编辑决策。', '');
    md.push('## 问题清单', '');
    let n = 0;
    for (const it of issues) {
      n += 1;
      md.push(`### ${n}. [${it.severity}] ${it.ruleId} ${it.title || ''}`, '');
      md.push(`- 位置：\`${it.location}\``);
      if (it.quote) md.push(`- 原文：${it.quote.replace(/\n/g, ' ').slice(0, 300)}`);
      md.push(`- 问题：${it.message || ''}`);
      if (it.suggestion) md.push(`- 建议：${it.suggestion}`);
      if (it.basis) md.push(`- 依据：${it.basis}`);
      if (it.occurrenceCount) md.push(`- 同类合计：${it.occurrenceCount} 处`);
      if (it.autoFix?.find) md.push(`- 可自动改写：\`${it.autoFix.find}\` → \`${it.autoFix.replace}\``);
      md.push('');
    }
    writeFileSync(join(OUT, 'md', `${base}.md`), md.join('\n'), 'utf8');
  }

  index.push({
    file: rel,
    issues: issues.length,
    high: counts.高 || 0,
    mid: counts.中 || 0,
    low: counts.低 || 0,
    verdict: payload.verdict.verdict,
    verdictScore: payload.verdict.score,
    column: meta.column || '',
    author: meta.author || '',
  });

  if (ok % 100 === 0) console.log(`  … 已导出 ${ok}/${perDoc.length}（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
}

/* ---------------- 汇总 ---------------- */
const rules = [...byRule.values()].sort((a, b) => b.hits - a.hits);
// 合格性判定分布（目标点 10）
const verdictTally = {};
for (const r of index) if (r.verdict) verdictTally[r.verdict] = (verdictTally[r.verdict] || 0) + 1;
const summary = {
  generatedAt: new Date().toISOString(),
  docsExported: ok,
  docsFailed: failed,
  totalIssues,
  avgIssuesPerDoc: ok ? +(totalIssues / ok).toFixed(1) : 0,
  verdictThresholds: VERDICT_TH,
  verdictTally,
  byRule: rules,
  index,
};
writeFileSync(join(OUT, '汇总.json'), JSON.stringify(summary, null, 1), 'utf8');

const md = [];
md.push('# 全语料批改结果汇总', '');
md.push(`- 生成时间：${summary.generatedAt}`);
md.push(`- 导出稿件：**${ok}** 篇（失败 ${failed} 篇）`);
md.push(`- 问题合计：**${totalIssues}** 条，平均每篇 **${summary.avgIssuesPerDoc}** 条`);
md.push(`- 命中规则：**${rules.length}** 条`, '');
md.push('## 〇、合格性判定分布', '');
md.push('| 档位 | 篇数 | 占比 |');
md.push('| --- | ---: | ---: |');
for (const k of ['合格', '基本合格', '需修改', '不合格']) {
  const n = verdictTally[k] || 0;
  md.push(`| ${k} | ${n} | ${ok ? ((n / ok) * 100).toFixed(1) : 0}% |`);
}
md.push('');
md.push(`> 阈值 ${JSON.stringify(VERDICT_TH)}，由语料中「已过审（发排版）」89 份的分数分布标定。`);
md.push('> 详见 `data/verify/稿件合格性判定报告.md`。判定用于排序与提示，不代替编辑决策。', '');
md.push('## 一、按规则统计（命中数降序）', '');
md.push('| 规则号 | 组 | 标题 | 命中 | 涉及稿件 | 可自动改写 |');
md.push('| --- | --- | --- | ---: | ---: | ---: |');
for (const r of rules) {
  md.push(`| ${r.ruleId} | ${r.group} | ${(r.title || '').slice(0, 34)} | ${r.hits} | ${r.docs} | ${r.fixable} |`);
}
md.push('', '## 二、逐篇问题数索引（问题最多的 60 篇）', '');
md.push('| 稿件 | 问题 | 高 | 中 | 低 | 栏目 |');
md.push('| --- | ---: | ---: | ---: | ---: | --- |');
for (const r of [...index].filter((x) => !x.error).sort((a, b) => b.issues - a.issues).slice(0, 60)) {
  md.push(`| ${r.file} | ${r.issues} | ${r.high} | ${r.mid} | ${r.low} | ${r.column} |`);
}
md.push('', '## 三、全部稿件索引', '');
md.push('| 稿件 | 问题 | 高 | 中 | 低 |');
md.push('| --- | ---: | ---: | ---: | ---: |');
for (const r of index) {
  md.push(r.error ? `| ${r.file} | 失败：${r.error} | | | |` : `| ${r.file} | ${r.issues} | ${r.high} | ${r.mid} | ${r.low} |`);
}
md.push('');
writeFileSync(join(OUT, '汇总.md'), md.join('\n'), 'utf8');

console.log(`\n完成：成功 ${ok} / 失败 ${failed}，问题合计 ${totalIssues}，平均每篇 ${summary.avgIssuesPerDoc} 条，`
  + `用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`输出目录：${OUT}`);
console.log(`  json/  ${ok} 个结构化结果`);
if (!NO_MD) console.log(`  md/    ${ok} 个人读报告`);
console.log('  汇总.json / 汇总.md');
