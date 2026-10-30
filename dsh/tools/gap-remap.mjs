/**
 * 缺口复核：模型报的「无对应规则」问题，现有规则真的抓不到吗？
 *
 * ── 为什么需要这个工具 ──
 *
 * `rule-gap-analysis.mjs` 的判定很机械：模型给的问题如果 `ruleId` 不在
 * 规则库 id 集合里，就算「缺口」。它自己也在注释里承认存的是
 * 「category / title / quote，才能人工判断『这是一条新规则，还是已有规则
 * 该扩判据』」—— 也就是说**它把判断留给了人**。
 *
 * 于是「39% 缺口」这个数字一直是**未经复核**的：模型漏标规则号，
 * 和规则库真的缺这一类，在它眼里长得一模一样。
 *
 * 本工具做那步复核：把每条缺口的 `quote` 单独喂给三个确定性扫描器，
 * 看有没有**已实现的规则**能在该文本上命中。
 *
 *   · 命中了  → 该缺口**已被现有规则覆盖**，属于模型漏标规则号，
 *              应从缺口统计里剔除（否则会虚报规则库的缺口）。
 *   · 没命中  → 真缺口，值得考虑新增规则或扩判据。
 *
 * 注意这是**下界估计**：扫描器在单句上跑，缺少全文上下文
 * （如「同篇归并」「首次出现」这类判据依赖上下文），所以
 * 「命中了」是可靠证据，「没命中」不等于一定没覆盖。
 * 报告里对这点明确标注，不夸大结论。
 *
 * 用法：
 *   node tools/gap-remap.mjs            # 复用 rule-gap-analysis.json
 *   node tools/gap-remap.mjs --md       # 同时落盘 markdown
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFormat } from '../src/scanner-format.js';
import { scanLanguage } from '../src/scanner-language.js';
import { scanCitation } from '../src/scanner-citation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'data', 'verify');
mkdirSync(OUT, { recursive: true });

const SRC = join(OUT, 'rule-gap-analysis.json');
if (!existsSync(SRC)) {
  console.error(`缺少 ${SRC}，先跑 tools/rule-gap-analysis.mjs`);
  process.exit(1);
}
const gap = JSON.parse(readFileSync(SRC, 'utf8'));

/** 造一个最小 doc：quote 作为正文段落，同时作为脚注内容各试一次 */
function mkDoc(text) {
  return {
    label: 'gap-probe.docx',
    paragraphs: [{ index: 0, text, style: '', jc: '', outline: null }],
    footnotes: [], endnotes: [], footnoteRefs: [], comments: [], tables: [],
  };
}
function mkDocFootnote(text) {
  return {
    label: 'gap-probe-fn.docx',
    paragraphs: [{ index: 0, text: '正文。', style: '', jc: '', outline: null }],
    footnotes: [{ index: 0, text, noteId: 1, isNoteSeparator: false }],
    endnotes: [], footnoteRefs: [1], comments: [], tables: [],
  };
}

/**
 * **必须排除文档级规则**。
 *
 * 踩过的坑：探针 doc 只有一个段落，于是 FMT-001（七要素齐备）与
 * FMT-036 在任何文本上都命中 —— 包括空串和「今天天气很好。」。
 * 结果第一版工具报「196 条缺口 100% 已被现有规则覆盖」，看似完美，
 * 实际是**探针本身不合格**导致的恒真：这两条规则检查的是整篇文档的
 * 结构完整性，与 quote 内容无关。
 *
 * 第二版又漏了 FMT-027：它检查「正文每段段首空两格」，靠的是
 * **段落属性** `w:ind w:firstLineChars`，探针没设这个属性就一律命中；
 * 而且代码里明确把它**归并为每条稿件一条**（注释：「首行缩进是文档级
 * 排版属性，不是逐段落的写作问题」）。它同样是文档级的，与 quote 内容无关。
 *
 * 教训：**排除表要按「这条规则的判据是否依赖文档级属性」来定，
 * 而不是按「它看起来像不像文档级」**。判据依赖段落/文档属性、
 * 或做全文统计与归并的规则，在单句探针上一律不可用。
 * 每次加新规则都要重跑下面的自检。
 */
const DOC_LEVEL = new Set([
  'FMT-001', // 稿件须齐备七要素 —— 检查整篇有没有题目/提要/关键词/正文/作者简介
  'FMT-036', // 文档级结构检查
  'FMT-027', // 正文每段段首空两格 —— 依赖段落属性 indFirstLine，且归并为每篇一条
]);

const SCANNERS = [
  ['format', scanFormat, mkDoc],
  ['format', scanFormat, mkDocFootnote],
  ['language', scanLanguage, mkDoc],
  ['language', scanLanguage, mkDocFootnote],
  ['citation', scanCitation, mkDoc],
  ['citation', scanCitation, mkDocFootnote],
];

/**
 * 对一段文本跑全部扫描器，返回命中的规则号。
 *
 * 只认**命中的位置落在 quote 内部**的规则。
 *
 * 为什么加这条限制：`quote` 是模型给的摘录（本工具里已截到 50 字），
 * 而扫描器是在这段文本上全文跑。如果一条规则命中的是 quote 里
 * 与模型所说问题**无关**的另一个片段，把它算成「已覆盖」就是假证据。
 * 要求命中片段与 quote 有实质重叠，才能说「模型报的这个问题，
 * 现有规则确实能抓到」。
 */
function hitsFor(text) {
  const found = new Map(); // ruleId -> {group, matched}
  for (const [group, fn, mk] of SCANNERS) {
    let res;
    try { res = fn(mk(text)); } catch { continue; }
    for (const it of res?.issues || []) {
      if (!it.ruleId) continue;
      if (DOC_LEVEL.has(it.ruleId)) continue; // 文档级规则在单句探针上恒真，不参与判断
      // 命中片段必须与 quote 有重叠：matched 为空时按「整段即命中」处理
      const matched = String(it.matched || it.quote || '').trim();
      const overlaps = !matched || text.includes(matched) || matched.includes(text.slice(0, 8));
      if (!overlaps) continue;
      if (!found.has(it.ruleId)) found.set(it.ruleId, group);
    }
  }
  return found;
}

/**
 * 自检：中性文本上不得有任何命中。
 *
 * 这是上面那些恒真 bug 的防线 —— 如果探针设计或排除表又有问题，
 * 这里会先失败，而不是让复核结论悄悄变成 100%。
 *
 * 中性句要选**确实不构成任何违规**的完整句子。踩过的坑：一开始放了
 * 「（一）」和「正文。」当探针，结果 CIT-002 命中 —— 但那**不是假警报**：
 * CIT-002 检查「脚注内容过短、疑为只有标号而缺文献信息」，而探针把
 * 这段文本同时当作**脚注**喂进去了，「正文。」作为一条脚注确实违规。
 * 即「探针文本」与「探针角色」是两个维度，中性句必须两者都中性。
 */
function selfCheck() {
  const neutral = [
    '这是一句完全正常的学术中文，用于自检。',
    '今天天气很好，适合出门散步。',
    '在学术研究中，概念的界定往往决定论证的边界。',
  ];
  const bad = [];
  for (const t of neutral) {
    const h = hitsFor(t);
    if (h.size) bad.push(`${JSON.stringify(t)} → ${[...h.keys()].join('、')}`);
  }
  return bad;
}

// 收集全部缺口（按 quote 去重后复核，省时间）
const all = [];
for (const r of gap.runs || []) {
  for (const g of r.gaps || []) all.push({ ...g, doc: r.name });
}
console.log(`═══ 缺口复核 ═══`);
console.log(`缺口明细 ${all.length} 条（来自 ${(gap.runs || []).length} 篇样本）\n`);

// 先自检探针，避免再次出现「恒真导致 100%」的假结论
const sc = selfCheck();
if (sc.length) {
  console.error('❌ 探针自检失败：中性文本上出现命中，复核结论不可信');
  for (const s of sc) console.error(`   ${s}`);
  console.error('   请先修 DOC_LEVEL 排除表或探针构造，再跑复核。');
  process.exit(1);
}
console.log('探针自检通过：中性文本上零命中（文档级规则已排除）\n');

const covered = [];
const stillGap = [];
for (const g of all) {
  const q = String(g.quote || '').trim();
  if (!q) { stillGap.push({ ...g, hits: [] }); continue; }
  const hits = hitsFor(q);
  if (hits.size) covered.push({ ...g, hits: [...hits.keys()] });
  else stillGap.push({ ...g, hits: [] });
}

const pct = (n) => `${((n / all.length) * 100).toFixed(1)}%`;
console.log(`已被现有规则覆盖（模型漏标规则号）：${covered.length} 条（${pct(covered.length)}）`);
console.log(`仍无规则覆盖（真缺口下界）：        ${stillGap.length} 条（${pct(stillGap.length)}）\n`);

// 按命中规则聚合：哪些规则最常被模型漏标
const byRule = new Map();
for (const c of covered) {
  for (const id of c.hits) {
    if (!byRule.has(id)) byRule.set(id, []);
    byRule.get(id).push(c);
  }
}
const ruleSorted = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length);
console.log('模型最常漏标的规则（前 15）：');
for (const [id, list] of ruleSorted.slice(0, 15)) {
  console.log(`  ${String(list.length).padStart(3)} 次  ${id}   例：${String(list[0].quote).slice(0, 34)}`);
}

// 真缺口按类别聚合
const catMap = new Map();
for (const g of stillGap) {
  const c = g.category || '（无分类）';
  catMap.set(c, (catMap.get(c) || 0) + 1);
}
const catSorted = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
console.log('\n真缺口按类别（前 15）：');
for (const [c, n] of catSorted.slice(0, 15)) console.log(`  ${String(n).padStart(3)}  ${c}`);

const summary = {
  generatedAt: new Date().toISOString(),
  source: 'rule-gap-analysis.json',
  sampledDocs: (gap.runs || []).length,
  gapTotal: all.length,
  coveredByExistingRules: covered.length,
  coveredRatio: Number(((covered.length / all.length) * 100).toFixed(1)),
  trueGapLowerBound: stillGap.length,
  trueGapRatio: Number(((stillGap.length / all.length) * 100).toFixed(1)),
  caveat: '「仍无规则覆盖」是**下界**：扫描器在单句 quote 上跑，缺全文上下文'
    + '（同篇归并、首次出现、文档级统计等判据依赖上下文），故「命中」是可靠证据，'
    + '「未命中」不等于规则一定覆盖不到。',
  mostMissedRules: ruleSorted.slice(0, 20).map(([id, list]) => ({ ruleId: id, n: list.length })),
  trueGapByCategory: catSorted.map(([category, n]) => ({ category, n })),
  covered: covered.map((c) => ({ category: c.category, title: c.title, quote: c.quote, hits: c.hits })),
  stillGap: stillGap.map((g) => ({ category: g.category, title: g.title, quote: g.quote })),
};
writeFileSync(join(OUT, 'gap-remap.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log(`\n已写入 data/verify/gap-remap.json`);

if (process.argv.includes('--md')) {
  const L = [];
  L.push('# 缺口复核：模型报的「无对应规则」问题，现有规则真的抓不到吗？\n');
  L.push(`生成时间：${summary.generatedAt}\n`);
  L.push(`来源：\`rule-gap-analysis.json\`（${summary.sampledDocs} 篇样本）\n`);
  L.push('## 结论\n');
  L.push(`- 缺口明细合计 **${summary.gapTotal}** 条`);
  L.push(`- **已被现有规则覆盖**（模型漏标规则号）：**${summary.coveredByExistingRules}** 条（**${summary.coveredRatio}%**）`);
  L.push(`- **仍无规则覆盖**（真缺口下界）：**${summary.trueGapLowerBound}** 条（**${summary.trueGapRatio}%**）\n`);
  L.push(`> ${summary.caveat}\n`);
  L.push('## 模型最常漏标的规则\n');
  L.push('| 规则 | 漏标次数 |');
  L.push('| --- | ---: |');
  for (const m of summary.mostMissedRules) L.push(`| ${m.ruleId} | ${m.n} |`);
  L.push('\n## 真缺口按类别\n');
  L.push('| 类别 | 条数 |');
  L.push('| --- | ---: |');
  for (const c of summary.trueGapByCategory) L.push(`| ${c.category} | ${c.n} |`);
  L.push('\n## 已被覆盖的缺口明细（抽样 30 条）\n');
  L.push('| 模型给的标题 | 引文 | 命中的现有规则 |');
  L.push('| --- | --- | --- |');
  for (const c of summary.covered.slice(0, 30)) {
    L.push(`| ${c.title} | ${String(c.quote).replace(/\|/g, '\\|')} | ${c.hits.join('、')} |`);
  }
  writeFileSync(join(OUT, '缺口复核.md'), L.join('\n') + '\n', 'utf8');
  console.log('已写入 data/verify/缺口复核.md');
}
