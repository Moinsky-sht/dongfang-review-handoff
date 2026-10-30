/**
 * 未触发规则逐条定性
 * ---------------------------------------------------------------
 * 对每条「在 632 份真实语料上一次都没触发」的规则，判定它属于哪一类：
 *
 *   A. 未实现      —— 规则库声明了，但任何扫描器里都没有对应检查代码。
 *                     这类不能计入「规则引擎自动检测」。
 *   B. 判据失效    —— 有实现，但构造的违规样本也报不出来（判据写反/条件不可达）。
 *   C. 合法未触发  —— 有实现，构造样本能报出，只是真实语料里没有这种情形。
 *
 * 判定顺序：先看实现是否存在（A），再喂构造样本（B/C）。
 *
 * 用法：node tools/classify-never-fired.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { scanFormat } = await import('../src/scanner-format.js');
const { scanLanguage } = await import('../src/scanner-language.js');
const { scanCitation } = await import('../src/scanner-citation.js');

/* ---------- 1) 判定「是否真的会执行」—— 复用 server 的同一套推导，避免两处口径不一 ---------- */
import { ruleWillRun } from '../src/implemented-rules.js';

/* ---------- 2) 构造 doc 工厂 ---------- */
function mkDoc(paras, opts = {}) {
  const paragraphs = paras.map((t, i) => ({
    id: `document.xml:${i}`, part: 'document.xml', index: i,
    text: t, before: t, changed: false,
    properties: opts.props?.[i] || {}, format: opts.fmt?.[i] || {},
    commentIds: [], inTable: false, charCount: [...t].length,
  }));
  const footnotes = (opts.footnotes || []).map((t, i) => ({
    id: `footnotes.xml:${i}`, part: 'footnotes.xml', index: i,
    text: t, before: t, changed: false, properties: {}, format: {},
    commentIds: [], inTable: false, charCount: [...t].length,
    noteId: String(i + 1), noteType: '', isNoteSeparator: false,
  }));
  const endnotes = (opts.endnotes || []).map((t, i) => ({
    id: `endnotes.xml:${i}`, part: 'endnotes.xml', index: i,
    text: t, before: t, changed: false, properties: {}, format: {},
    commentIds: [], inTable: false, charCount: [...t].length,
    noteId: String(i + 1), noteType: '', isNoteSeparator: false,
  }));
  const tables = opts.tables || [];
  return {
    label: opts.label || 'test.docx', core: {},
    parts: {
      'document.xml': { paragraphs, revisions: [], blocks: [] },
      'footnotes.xml': { paragraphs: footnotes, revisions: [], blocks: [] },
      'endnotes.xml': { paragraphs: endnotes, revisions: [], blocks: [] },
    },
    paragraphs, footnotes, endnotes, comments: [], styles: { byId: {} }, numbering: {},
    tables, blocks: [], revisions: [], footnoteRefs: [],
    stats: { paragraphs: paragraphs.length, chars: paragraphs.reduce((s, p) => s + p.charCount, 0), comments: 0, insertions: 0, deletions: 0, tables: tables.length, footnotes: footnotes.length, endnotes: endnotes.length },
  };
}
const runIds = (doc) => {
  const ids = new Set();
  for (const f of [scanFormat, scanLanguage, scanCitation]) {
    try { for (const it of f(doc).issues) ids.add(it.ruleId); } catch { /* 忽略 */ }
  }
  return ids;
};

/* ---------- 3) 每条未触发规则的构造违规样本 ---------- */
/* 只覆盖「不依赖段落属性/表格结构」的规则；其余规则即便构造样本也报不出，
   不能据此判定「判据失效」，会另行标注为「样本不可构造」。 */
const PROBES = {
  'FMT-009': mkDoc(['一、甲', '二、乙', '（一）丙', '（1）丁']),
  'FMT-011': mkDoc(['本文采用 GDP 与 CPI 两个指标进行分析，此处不给出英文原文。']),
  'FMT-017': mkDoc(['参见 John Rawls, A Theory of Justice, Harvard University Press, 1971.']),
  'FMT-021': mkDoc(['他说：“这样做是不对的”。']),
  'FMT-022': mkDoc(['本文分析了三个案例，涉及五个省份，共十二个城市。']),
  'FMT-026': mkDoc(['该地区面积为 100 km2，人口为 200 万 人。']),
  'FMT-027': mkDoc(['这是没有段首缩进的正文段落，直接顶格开始。']),
  'FMT-028': mkDoc(['“这是一段独立引文，应当左右缩进两格并去掉引号。”']),
  'FMT-029': mkDoc(['正文一。', '正文二。'], { footnotes: ['第一条脚注。', '第二条脚注。'] }),
  'FMT-030': mkDoc(['这是正文句子。①', '脚注标号放在句号里面了。']),
  'FMT-032': mkDoc(['表1 各年数据', '1 2 3 4', '图1 趋势图']),
  'FMT-034': mkDoc(['表1 各年数据', '注：数据经作者整理。资料来源：国家统计局。']),
  'FMT-035': mkDoc(['图1 各年产值变化', '1 2 3 4']),
  'FMT-037': mkDoc(['[基金项目] 国家社科基金项目。']),
  'FMT-038': mkDoc(['一、完全无关的标题', '本段讨论的是另一个主题，与标题毫无关系。']),
  'FMT-040': mkDoc(['《论语》学而篇云：“学而时习之”。']),
  'FMTB-001': mkDoc(['正文引用。'], { footnotes: ['参见《毛泽东选集》，人民出版社1991年版。'] }),
  'FMTB-002': mkDoc(['[作者简介] 张三，复旦大学教授。']),
  'FMTB-007': mkDoc(['下表列出各年数据。', '1 2 3 4 5']),
  'FMTB-008': mkDoc(['[内容提要] 本文认为中国式现代化具有独特优势。', '本文认为中国式现代化具有独特优势。']),
  'FMTB-009': mkDoc(['表1 数据'], { tables: [[['', '甲', '乙'], ['丙', '1', '2']]] }),
  'FMTB-010': mkDoc(['本文讨论 20世纪90年代 与 1990年代 的变化。']),
  'FMTB-012': mkDoc(['正文结束。', '张三，复旦大学教授。']),
  'FMTB-016': mkDoc(['1 2 3 4', '表1 各年数据']),
  'FMTB-017': mkDoc(['本文使用2010年数据，另处又写作 2010 年度数据。']),
  'FMTB-018': mkDoc(['图1 各年产值变化，其中红色柱表示东部，蓝色柱表示西部。']),
  'FMTB-020': mkDoc(['表1 各年数据', '如表1所示，各年数据如下：甲为1，乙为2。']),
  'FMTB-021': mkDoc(['[内容提要] 提要。', '[关键词] 甲；乙'], { label: '01-张三-某调研-调研.docx' }),
  'FMTB-024': mkDoc(['[内容提要] 本文认为中国式现代化具有独特优势与制度基础。', '一、引言', '本文认为中国式现代化具有独特优势与制度基础。']),
  'FMTB-025': mkDoc(['表1 各年数据（单位：万人）', '1 2 3']),
  'FMTB-027': mkDoc(['1949年新中国成立，同年10月1日举行开国大典。', '1948年新中国成立。']),
  'FMTB-028': mkDoc(['图1 趋势图', '图1 趋势图（重复出现）']),
  'FMTB-029': mkDoc(['正文。'], { footnotes: ['张三：《某书》。'] }),
  'FMTB-030': mkDoc(['表1 各年数据', '如表1所示，各年数据如下：甲为1，乙为2。']),
  'FMTB-032': mkDoc(['本文讨论马克思主义。', '马克思主义的方法。', '马克思主义的立场。', '马克思主义。']),
  'FMTB-035': mkDoc(['表1 数据'], { tables: [[['', '甲'], ['丙', '1']]] }),
  'FMTB-036': mkDoc(['一、中国向何处去？还是世界向何处去？']),
  'FMTB-038': mkDoc(['[Abstract] This paper argues that modernization has unique advantages.']),
  'FMTB-039': mkDoc(['正如复旦大学教授张三所指出的那样，这一问题十分重要。']),
  // CIT-017 在扫描器里执行的是「中文著作名未用书名号」（与规则库原表述不同，见 align-citation-rules）
  'CIT-017': mkDoc(['正文引用。'], { footnotes: ['参见现代中国研究，北京大学出版社2010年版。'] }),
};

/* ---------- 4) 分类 ---------- */
const cov = JSON.parse(readFileSync(join(ROOT, 'data', 'verify', 'rule-coverage.json'), 'utf8'));
const neverIds = new Set(cov.neverFired);
const declared = [];
for (const [g, f] of [['format', 'format-rules.json'], ['language', 'language-rules.json'], ['citation', 'citation-rules.json']]) {
  const o = JSON.parse(readFileSync(join(ROOT, 'rules', f), 'utf8'));
  for (const r of (o.rules || [])) if (neverIds.has(r.id)) declared.push({ group: g, id: r.id, title: r.title, detectType: r.detect?.type || null, check: r.detect?.check || null });
}

const results = [];
for (const r of declared) {
  const implemented = ruleWillRun(r, r.group);
  let probeFired = null;
  if (PROBES[r.id]) probeFired = runIds(PROBES[r.id]).has(r.id);
  let verdict;
  if (r.detectType === 'model') verdict = 'D-模型规则（设计上不由规则引擎执行）';
  else if (r.detectType === 'manual') verdict = 'E-人工规则（声明即人工）';
  else if (!implemented) verdict = 'A-未实现';
  else if (probeFired === true) verdict = 'C-合法未触发（判据有效，语料无此情形）';
  else if (probeFired === false) verdict = 'B-判据失效（构造样本也报不出）';
  else verdict = 'F-有实现但样本不可构造（需人工确认）';
  results.push({ ...r, implemented, probeFired, verdict });
}

/* ---------- 5) 输出 ---------- */
const bucket = {};
for (const r of results) { const k = r.verdict[0]; (bucket[k] ||= []).push(r); }

console.log(`未触发规则定性（共 ${results.length} 条）\n`);
const LABEL = {
  A: 'A 未实现 —— 声明了但扫描器里没有对应检查代码',
  B: 'B 判据失效 —— 有实现，但构造的违规样本也报不出',
  C: 'C 合法未触发 —— 判据有效，只是真实语料没有这种情形',
  D: 'D 模型规则 —— 设计上就交给大模型',
  E: 'E 人工规则 —— 声明即人工复核',
  F: 'F 待人工确认 —— 有实现，但样本依赖段落属性/表格结构，构造不出',
};
for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) {
  const list = bucket[k] || [];
  console.log(`${LABEL[k]}：${list.length} 条`);
  for (const r of list) {
    const extra = r.check ? `  check=${r.check}` : '';
    console.log(`    · ${r.id.padEnd(11)} ${r.title.slice(0, 40)}${extra}`);
  }
  console.log('');
}

const out = {
  generatedAt: new Date().toISOString(),
  totalNeverFired: results.length,
  counts: Object.fromEntries(Object.entries(bucket).map(([k, v]) => [k, v.length])),
  unimplemented: (bucket.A || []).map((r) => r.id),
  detectionBroken: (bucket.B || []).map((r) => r.id),
  legitimatelySilent: (bucket.C || []).map((r) => r.id),
  modelRules: (bucket.D || []).map((r) => r.id),
  manualRules: (bucket.E || []).map((r) => r.id),
  needsHumanReview: (bucket.F || []).map((r) => r.id),
  details: results,
};
writeFileSync(join(ROOT, 'data', 'verify', 'never-fired-classification.json'), JSON.stringify(out, null, 1), 'utf8');
console.log('明细已写入 data/verify/never-fired-classification.json');
