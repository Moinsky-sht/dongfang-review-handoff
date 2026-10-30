/**
 * 从未触发的「自动」规则 · 合成用例验证
 * ---------------------------------------------------------------
 * 规则覆盖测试发现：632 份真实稿件里有 8 条标为「规则引擎可自动检测」
 * 的规则一次都没触发。这有两种可能：
 *   (a) 真实语料里确实没有这类问题 → 规则是好的，只是样本没覆盖
 *   (b) 规则实现有问题（判据写反、条件永远不成立）→ 规则是坏的
 *
 * 本脚本给每条规则构造「确定违规」的最小样本，看规则能否报出来，
 * 从而把 (a) 和 (b) 区分开。
 *
 * 用法：node tools/never-fired-probe.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const src = (f) => readFileSync(join(ROOT, 'src', f), 'utf8');

/* ---------- 合成 doc 工厂 ---------- */
function mkDoc(paragraphs, opts = {}) {
  const paras = paragraphs.map((t, i) => ({
    id: `document.xml:${i}`,
    part: 'document.xml',
    index: i,
    text: t,
    before: t,
    changed: false,
    properties: opts.props?.[i] || {},
    format: opts.fmt?.[i] || {},
    commentIds: [],
    inTable: false,
    charCount: [...t].length,
  }));
  return {
    label: opts.label || 'test.docx',
    core: {},
    parts: { 'document.xml': { paragraphs: paras, revisions: [], blocks: [] } },
    paragraphs: paras,
    footnotes: [], endnotes: [], comments: [], styles: { byId: {} }, numbering: {},
    tables: [], blocks: [], revisions: [], footnoteRefs: [],
    stats: { paragraphs: paras.length, chars: paras.reduce((s, p) => s + p.charCount, 0), comments: 0, insertions: 0, deletions: 0, tables: 0, footnotes: 0, endnotes: 0 },
  };
}

const { scanFormat, loadFormatRules } = await import('../src/scanner-format.js');
const { scanLanguage, loadLanguageRules } = await import('../src/scanner-language.js');
const { scanCitation, loadCitationRules } = await import('../src/scanner-citation.js');
const { ruleWillRun } = await import('../src/implemented-rules.js');

/**
 * 规则号 → 规则对象 / 所属引擎。
 * 用来把「用例本身写错了（规则号不存在）」与「规则真的没实现」
 * 从「判据失效」里区分出来 —— 否则探针会把陈旧用例报成产品缺陷。
 */
const groupOf = (id) => (id.startsWith('CIT-') ? 'citation' : id.startsWith('LANG-') ? 'language' : 'format');
const ruleById = new Map();
for (const r of loadFormatRules().rules) ruleById.set(r.id, r);
for (const r of loadLanguageRules().rules) ruleById.set(r.id, r);
for (const r of loadCitationRules().rules) ruleById.set(r.id, r);

const run = (doc) => {
  const f = scanFormat(doc); const l = scanLanguage(doc); const c = scanCitation(doc);
  return [...f.issues, ...l.issues, ...c.issues];
};
const ids = (issues) => [...new Set(issues.map((i) => i.ruleId))];

/* ---------- 用例 ---------- */
const cases = [];

/* FMT-010 标题末尾不加句号 */
cases.push({
  rule: 'FMT-010',
  desc: '一级标题末尾带句号',
  doc: () => mkDoc(['一、研究背景。', '正文一段足够长的内容用于占位。'], { props: [{ outline: 1 }, {}] }),
});

/* FMTB-014 关键词不得用空泛词 */
cases.push({
  rule: 'FMTB-014',
  desc: '关键词含「历史贡献」「当代启示」等空泛词',
  doc: () => mkDoc(['[关键词] 国家两重性；历史贡献；当代启示']),
});

/* FMTB-032 专有名词与量词全文统一 */
cases.push({
  rule: 'FMTB-032',
  desc: '同一概念两种表述（马克思主义／马克思主意 之类）',
  doc: () => mkDoc([
    '本文讨论马克思主义的基本问题。',
    '马克思主义的立场方法值得重视。',
    '这里再次提到马克思主义。',
    '马克思主义是核心概念。',
  ]),
});

/* FMTB-006 专题栏目不设内容提要 */
cases.push({
  rule: 'FMTB-006',
  desc: '文件名含「专题」且正文有 [内容提要]',
  doc: () => mkDoc(['[内容提要] 这是提要。', '[关键词] 甲；乙；丙', '一、引言'], { label: '01-张三-某专题研究-专题.docx' }),
});

/* FMTB-021 调研栏目不设摘要 */
cases.push({
  rule: 'FMTB-021',
  desc: '文件名含「调研」且正文有 [内容提要]',
  doc: () => mkDoc(['[内容提要] 这是提要。', '[关键词] 甲；乙；丙'], { label: '01-张三-某调研-调研.docx' }),
});

/* FMTB-022 书评不设摘要 */
cases.push({
  rule: 'FMTB-022',
  desc: '文件名含「书评」且正文有 [内容提要]',
  doc: () => mkDoc(['[内容提要] 这是提要。', '[关键词] 甲；乙；丙'], { label: '01-张三-评某书-书评.docx' }),
});

/* CIT-031 图表「数据来源/资料来源」只给网站或数据库名 —— 无法核查
 * ⚠️ 原用例误标为 CIT-017。CIT-017 是「中日文书籍/篇名用书名号」，
 * 与「图表资料来源」无关；这里按 CIT-031 的真实判据（整段只给网站/库名）重写。 */
cases.push({
  rule: 'CIT-031',
  desc: '数据来源只给数据库名「中国知网」',
  doc: () => mkDoc(['表1 各年数据', '数据来源：中国知网。']),
});
cases.push({
  rule: 'CIT-031',
  desc: '资料来源只给「谷歌学术」',
  doc: () => mkDoc(['图1 各年趋势', '资料来源：谷歌学术。']),
});

/* FMTB-018 图表不得用颜色区分（已在正文自动检测） */
cases.push({
  rule: 'FMTB-018',
  desc: '正文提到「图例」「红色」「蓝色」',
  doc: () => mkDoc(['图1 中红色柱表示东部，蓝色柱表示西部，图例见右上角。']),
});

/* ---------- 执行 ---------- */
console.log('从未触发的「自动」规则 · 合成用例验证\n');
console.log('规则        用例                                          结果');
console.log('─'.repeat(100));

const verdicts = [];
for (const c of cases) {
  let got;
  try {
    got = ids(run(c.doc()));
  } catch (e) {
    console.log(`${c.rule.padEnd(11)} ${c.desc.padEnd(44)} 抛错: ${e.message}`);
    verdicts.push({ rule: c.rule, desc: c.desc, fired: false, error: e.message });
    continue;
  }
  const fired = got.includes(c.rule);
  console.log(`${c.rule.padEnd(11)} ${c.desc.padEnd(44)} ${fired ? '✓ 报出' : '✗ 未报出'}   其它: ${got.filter((g) => g !== c.rule).join(',') || '无'}`);
  verdicts.push({ rule: c.rule, desc: c.desc, fired });
}

console.log('\n═══ 判定 ═══');
const byRule = new Map();
for (const v of verdicts) {
  if (!byRule.has(v.rule)) byRule.set(v.rule, []);
  byRule.get(v.rule).push(v);
}
/**
 * 四类结果分开：
 *   working        判据有效（至少一个违规样本报出）
 *   broken         规则有实现但样本报不出 → 判据可能失效（真缺陷信号）
 *   notImplemented 规则库显式标 manual / 未实现 → 预期不报，不算缺陷
 *   unknown        用例里的规则号在规则库里根本不存在 → 用例陈旧，先修用例
 */
const working = []; const broken = []; const unknown = []; const notImplemented = [];
for (const [rule, vs] of byRule) {
  const r = ruleById.get(rule);
  if (!r) { console.log(`  ⚠ ${rule}：规则号不在任何规则库里 → 用例陈旧或标错，先修用例`); unknown.push(rule); continue; }
  if (!ruleWillRun(r, groupOf(rule))) {
    console.log(`  – ${rule}：未实现/已改判（${r.detect?.type || '无 detect'}），预期不报，非判据失效`);
    notImplemented.push(rule); continue;
  }
  if (vs.some((v) => v.fired)) { console.log(`  ✓ ${rule}：判据有效（至少一个违规样本能报出）`); working.push(rule); }
  else { console.log(`  ✗ ${rule}：构造的违规样本一个都没报出 → 判据可能失效`); broken.push(rule); }
}
if (unknown.length) console.log(`\n⚠ ${unknown.length} 条用例的规则号不存在，需修正用例：${unknown.join('、')}`);

const out = {
  generatedAt: new Date().toISOString(),
  cases: verdicts,
  rulesWithWorkingDetection: working,
  rulesWithNoDetection: broken,
  rulesUnknownId: unknown,
  rulesNotImplemented: notImplemented,
};
const outPath = join(ROOT, 'data', 'verify', 'never-fired-probe.json');
const { writeFileSync } = await import('node:fs');
writeFileSync(outPath, JSON.stringify(out, null, 1), 'utf8');
console.log(`\n明细已写入 ${outPath}`);
