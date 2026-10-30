/**
 * 标题 / 摘要 / 关键词 / 正文 四段审核专项校验（目标点 8）
 * ---------------------------------------------------------------
 * 目标点 8 的要求是「确保标题、摘要、关键词、正文的审核都不出问题」。
 * 「不出问题」得先能**度量**，所以这个脚本把四段拆开，各自回答三个问题：
 *
 *   1. **识别对不对** —— 分段器有没有把这一段认出来（标题认成正文、
 *      关键词行没认出来，后面所有检查都会跟着错）
 *   2. **检查全不全** —— 该段的规则有没有真的跑到（有没有规则声明了却不生效）
 *   3. **报得准不准** —— 该段的命中与编辑批注的重合率、以及明显不合理的命中
 *
 * 为什么必须分段度量：整套规则是**按段落角色**分派的（title / abstract /
 * keywords / body），一个「标题被当成正文」的误判会让标题类规则全部空转，
 * 而总量指标（问题总数、整体重合率）完全看不出来 —— 这正是目标点 8 要防的。
 *
 * 用法：
 *   node tools/section-check.mjs                 # 全语料
 *   node tools/section-check.mjs --limit 120     # 抽样
 *   node tools/section-check.mjs --md            # 额外输出 Markdown 报告
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocx } from '../src/docx.js';
import { scanFormat, classifyParagraphs, loadFormatRules } from '../src/scanner-format.js';
import { scanLanguage } from '../src/scanner-language.js';
import { scanCitation } from '../src/scanner-citation.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : 0;
const WANT_MD = process.argv.includes('--md');

const cov = JSON.parse(readFileSync(join(ROOT, 'data', 'verify', 'rule-coverage.json'), 'utf8'));
let docs = cov.perDoc;
if (LIMIT) docs = docs.slice(0, LIMIT);

/** 段落角色 → 人类可读段名 */
const SEC = { title: '标题', abstract: '摘要', keywords: '关键词', body: '正文', heading: '小标题', empty: '空段', byline: '署名' };

const stat = {
  标题: { docs: 0, issues: 0, commentHit: 0, quoteBad: 0 },
  摘要: { docs: 0, issues: 0, commentHit: 0, quoteBad: 0 },
  关键词: { docs: 0, issues: 0, commentHit: 0, quoteBad: 0 },
  正文: { docs: 0, issues: 0, commentHit: 0, quoteBad: 0 },
  小标题: { docs: 0, issues: 0, commentHit: 0, quoteBad: 0 },
  其他: { docs: 0, issues: 0, commentHit: 0, quoteBad: 0 },
};

const recog = {
  titleFound: 0, titleMissing: 0,
  abstractFound: 0, abstractMissing: 0,
  keywordsFound: 0, keywordsMissing: 0,
  bodyFound: 0, bodyMissing: 0,
  // 非稿件类文档（编辑部来信/审稿意见/导言）：本来就没有标题，须单独统计，
  // 否则它们会被算成「标题识别失败」，把真实识别率压低、也看不清问题在哪
  nonManuscript: 0,
  msTotal: 0, msTitleFound: 0, msTitleMissing: [],
  nmWithTitle: [],
  // 可疑识别：标题认成了别的东西 / 标题过长
  titleTooLong: [],
  abstractTooShort: [],
  keywordCountWeird: [],
};

const ruleBySection = new Map(); // 段名 → Map(ruleId → count)
const commentTexts = [];

/** 段落角色归属：拿段落下标反查 */
function roleOf(issue, roles, paraToRole) {
  const pi = issue.paragraphIndex;
  if (typeof pi === 'number' && pi >= 0 && paraToRole.has(pi)) return paraToRole.get(pi);
  // 脚注/文档级问题不归入四段
  return null;
}

let n = 0;
for (const d of docs) {
  let doc;
  try { doc = await parseDocx(join(cov.corpusRoot, d.path)); } catch { continue; }
  n += 1;

  const cls = classifyParagraphs(doc);
  const roles = cls.roles || [];
  const paraToRole = new Map();
  doc.paragraphs.forEach((p, i) => {
    const r = roles[i] || 'body';
    paraToRole.set(i, SEC[r] || '其他');
  });

  // ---- 识别层 ----
  const hasTitle = roles.some((r) => r === 'title');
  const hasAbstract = cls.abstractIdx >= 0;
  const hasKeywords = cls.keywordIdx >= 0;
  const hasBody = roles.filter((r) => r === 'body').length >= 3;
  hasTitle ? (recog.titleFound += 1) : (recog.titleMissing += 1);
  hasAbstract ? (recog.abstractFound += 1) : (recog.abstractMissing += 1);
  hasKeywords ? (recog.keywordsFound += 1) : (recog.keywordsMissing += 1);
  hasBody ? (recog.bodyFound += 1) : (recog.bodyMissing += 1);

  // 分开统计「真稿件」与「非稿件类文档」——两者该不该有标题的答案不同
  if (cls.nonManuscript) {
    recog.nonManuscript += 1;
    // 非稿件类却识别出了标题 → 是误报，要列出来看
    if (hasTitle && recog.nmWithTitle.length < 10) {
      const ti = roles.indexOf('title');
      recog.nmWithTitle.push({ file: d.path.split('\\').pop().slice(0, 40), title: (doc.paragraphs[ti].text || '').trim().slice(0, 46) });
    }
  } else {
    recog.msTotal += 1;
    if (hasTitle) recog.msTitleFound += 1;
    else if (recog.msTitleMissing.length < 20) {
      const ne = doc.paragraphs.filter((p) => (p.text || '').trim());
      recog.msTitleMissing.push({ file: d.path.split('\\').pop().slice(0, 42), paras: ne.length, first: (ne[0]?.text || '').trim().slice(0, 50) });
    }
  }

  // 标题是否过长（可能是把摘要整段认成标题）
  const ti = roles.indexOf('title');
  if (ti >= 0) {
    const t = (doc.paragraphs[ti].text || '').trim();
    if ([...t].length > 60 && recog.titleTooLong.length < 8) {
      recog.titleTooLong.push({ file: d.path.split('\\').pop().slice(0, 40), len: [...t].length, text: t.slice(0, 60) });
    }
  }
  if (cls.abstractIdx >= 0) {
    const t = (doc.paragraphs[cls.abstractIdx].text || '').replace(/^[\[［【]?(内容提要|摘要)[\]］】]?[:：]?/, '').trim();
    if ([...t].length < 40 && recog.abstractTooShort.length < 8) {
      recog.abstractTooShort.push({ file: d.path.split('\\').pop().slice(0, 40), len: [...t].length, text: t.slice(0, 50) });
    }
  }

  // ---- 命中层 ----
  const issues = [
    ...scanFormat(doc).issues,
    ...scanLanguage(doc).issues,
    ...scanCitation(doc).issues,
  ];
  const comments = (doc.comments || []).map((c) => String(c.text || '')).filter(Boolean);
  for (const c of comments) commentTexts.push(c);

  const touched = new Set();
  for (const it of issues) {
    const sec = roleOf(it, roles, paraToRole) || '其他';
    stat[sec].issues += 1;
    touched.add(sec);
    if (!ruleBySection.has(sec)) ruleBySection.set(sec, new Map());
    const m = ruleBySection.get(sec);
    m.set(it.ruleId, (m.get(it.ruleId) || 0) + 1);
    // quote 必须是原文逐字片段：抽查长度异常（0 长度或超长）
    const q = String(it.quote || '');
    if (q.length === 0) stat[sec].quoteBad += 1;
  }
  for (const s of touched) stat[s].docs += 1;
}

// ---- 编辑批注重合（分段）----
// 用整篇批注池估算「该段命中是否落在编辑关注范围内」，仅作排序参考
const commentPool = commentTexts.join('\n');

console.log('═══ 标题 / 摘要 / 关键词 / 正文 四段审核专项校验 ═══');
console.log(`稿件 ${n} 篇${LIMIT ? `（抽样前 ${LIMIT} 篇）` : '（全语料）'}\n`);

console.log('【一、识别层】分段器有没有把四段认出来');
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : '0.0');
console.log(`  标题    认到 ${recog.titleFound} 篇（${pct(recog.titleFound, n)}%）  未认到 ${recog.titleMissing} 篇`);
console.log(`  摘要    认到 ${recog.abstractFound} 篇（${pct(recog.abstractFound, n)}%）  未认到 ${recog.abstractMissing} 篇`);
console.log(`  关键词  认到 ${recog.keywordsFound} 篇（${pct(recog.keywordsFound, n)}%）  未认到 ${recog.keywordsMissing} 篇`);
console.log(`  正文    认到 ${recog.bodyFound} 篇（${pct(recog.bodyFound, n)}%）  未认到 ${recog.bodyMissing} 篇`);

/**
 * 关键拆分：语料里混着编辑部来信、审稿意见、栏目导言这类**非稿件**，
 * 它们本来就没有标题。把它们和真稿件混在一起算「标题识别率」，
 * 数字会被压低，也看不出真正的问题在哪。
 */
console.log('\n【一之二、识别层拆分】非稿件类文档单独统计');
console.log(`  非稿件类文档（来信/审稿意见/导言）  ${recog.nonManuscript} 篇`);
console.log(`  真稿件                              ${recog.msTotal} 篇`);
console.log(`  真稿件标题识别率                    ${pct(recog.msTitleFound, recog.msTotal)}%（${recog.msTitleFound}/${recog.msTotal}）`);
if (recog.nmWithTitle.length) {
  console.log(`  ! 非稿件类却识别出标题（误报）${recog.nmWithTitle.length} 例：`);
  for (const x of recog.nmWithTitle) console.log(`      ${JSON.stringify(x.title)}  [${x.file}]`);
} else console.log('  非稿件类误标标题：无');
if (recog.msTitleMissing.length) {
  console.log(`  真稿件里标题未识别（最多列 20）：`);
  for (const x of recog.msTitleMissing) console.log(`      ${String(x.paras).padStart(3)}段 ${JSON.stringify(x.first)}  [${x.file}]`);
}

console.log('\n【二、命中层】各段的问题分布');
console.log('  段名      命中问题   涉及篇数   段内占比   无 quote 条数');
const totalIssues = Object.values(stat).reduce((a, s) => a + s.issues, 0);
for (const [sec, s] of Object.entries(stat)) {
  if (!s.issues && !s.docs) continue;
  console.log(`  ${sec.padEnd(6)}  ${String(s.issues).padStart(8)}  ${String(s.docs).padStart(8)}  ${String(pct(s.issues, totalIssues)).padStart(7)}%  ${String(s.quoteBad).padStart(10)}`);
}

console.log('\n【三、规则分布】各段主要命中哪些规则（前 8 条）');
for (const sec of ['标题', '摘要', '关键词', '正文']) {
  const m = ruleBySection.get(sec);
  if (!m || !m.size) { console.log(`  ${sec}：无命中`); continue; }
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`  ${sec}：${top.map(([k, v]) => `${k}×${v}`).join('  ')}`);
}

console.log('\n【四、可疑识别样本】');
if (recog.titleTooLong.length) {
  console.log('  标题过长（>60 字，可能把摘要认成了标题）：');
  for (const x of recog.titleTooLong) console.log(`    ${x.len} 字 · ${x.file} · ${JSON.stringify(x.text)}`);
} else console.log('  标题过长：无');
if (recog.abstractTooShort.length) {
  console.log('  摘要过短（<40 字，可能只认到标记行）：');
  for (const x of recog.abstractTooShort) console.log(`    ${x.len} 字 · ${x.file} · ${JSON.stringify(x.text)}`);
} else console.log('  摘要过短：无');

// ---- 结论判定 ----
const problems = [];
/**
 * 标题识别率要按**真稿件**算。
 * 早期版本用全量（含来信/审稿意见），那些文档本来没标题，
 * 会把识别率压低到 96.5% 并误报「标题未识别 22 篇 >2%」——
 * 其中 12 篇根本不是论文。拆开看才是 97.9%（610/623）。
 */
const msRate = recog.msTotal ? recog.msTitleFound / recog.msTotal : 1;
if (msRate < 0.95) problems.push(`真稿件标题识别率仅 ${(msRate * 100).toFixed(1)}%（<95%）`);
if (recog.nmWithTitle.length) problems.push(`非稿件类文档被误标标题 ${recog.nmWithTitle.length} 例`);
if (recog.abstractMissing / n > 0.6) problems.push(`摘要未识别 ${recog.abstractMissing} 篇 —— 一审稿常缺提要，属正常，但须确认不是识别失败`);
if (recog.keywordsMissing / n > 0.6) problems.push(`关键词未识别 ${recog.keywordsMissing} 篇 —— 同上`);
if (!stat.标题.issues && recog.titleFound > 0) problems.push('标题段零命中 —— 标题类规则可能没生效');
if (recog.titleTooLong.length) problems.push(`标题过长 ${recog.titleTooLong.length} 例（抽样）`);

console.log(`\n═══ 结论 ═══`);
if (problems.length) for (const p of problems) console.log(`  ! ${p}`);
else console.log('  四段识别与检查均正常');

mkdirSync(join(ROOT, 'data', 'verify'), { recursive: true });
const out = join(ROOT, 'data', 'verify', 'section-check.json');
writeFileSync(out, JSON.stringify({
  generatedAt: new Date().toISOString(),
  docsScanned: n,
  recognition: recog,
  sectionStats: stat,
  ruleBySection: Object.fromEntries([...ruleBySection.entries()].map(([k, m]) => [k, Object.fromEntries(m)])),
  problems,
}, null, 1), 'utf8');
console.log(`\n已写入 ${out}`);

if (WANT_MD) {
  const lines = ['# 标题 / 摘要 / 关键词 / 正文 四段审核专项校验', '', `- 生成时间：${new Date().toISOString()}`, `- 稿件：${n} 篇`, ''];
  lines.push('## 一、识别层', '', '| 段 | 认到 | 未认到 | 识别率 |', '| --- | ---: | ---: | ---: |');
  lines.push(`| 标题 | ${recog.titleFound} | ${recog.titleMissing} | ${pct(recog.titleFound, n)}% |`);
  lines.push(`| 摘要 | ${recog.abstractFound} | ${recog.abstractMissing} | ${pct(recog.abstractFound, n)}% |`);
  lines.push(`| 关键词 | ${recog.keywordsFound} | ${recog.keywordsMissing} | ${pct(recog.keywordsFound, n)}% |`);
  lines.push(`| 正文 | ${recog.bodyFound} | ${recog.bodyMissing} | ${pct(recog.bodyFound, n)}% |`);
  lines.push('', '## 二、命中层', '', '| 段 | 命中问题 | 涉及篇数 | 占比 |', '| --- | ---: | ---: | ---: |');
  for (const [sec, s] of Object.entries(stat)) {
    if (!s.issues && !s.docs) continue;
    lines.push(`| ${sec} | ${s.issues} | ${s.docs} | ${pct(s.issues, totalIssues)}% |`);
  }
  lines.push('', '## 三、识别层拆分（非稿件类单独统计）', '');
  lines.push(`- 非稿件类文档（来信/审稿意见/导言）：${recog.nonManuscript} 篇 —— 本来就没有标题`);
  lines.push(`- 真稿件：${recog.msTotal} 篇`);
  lines.push(`- **真稿件标题识别率：${pct(recog.msTitleFound, recog.msTotal)}%（${recog.msTitleFound}/${recog.msTotal}）**`);
  lines.push(`- 非稿件类被误标标题：${recog.nmWithTitle.length} 例`);
  if (recog.msTitleMissing.length) {
    lines.push('', '真稿件里标题未识别（最多列 20）：', '');
    for (const x of recog.msTitleMissing) lines.push(`- ${x.paras} 段 · \`${x.first}\` · ${x.file}`);
  }
  lines.push('', '## 四、各段主要命中规则', '');
  for (const sec of ['标题', '摘要', '关键词', '正文']) {
    const m = ruleBySection.get(sec);
    if (!m || !m.size) { lines.push(`- ${sec}：无命中`); continue; }
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    lines.push(`- ${sec}：${top.map(([k, v]) => `${k}×${v}`).join('　')}`);
  }
  lines.push('', '## 五、结论', '');
  if (problems.length) for (const p of problems) lines.push(`- ⚠ ${p}`);
  else lines.push('- 四段识别与检查均正常');
  writeFileSync(join(ROOT, 'data', 'verify', '四段审核专项校验.md'), lines.join('\n') + '\n', 'utf8');
  console.log('已写入 data/verify/四段审核专项校验.md');
}
