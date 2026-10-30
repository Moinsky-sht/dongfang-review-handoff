/**
 * 规则实现核查（精确版）
 * ---------------------------------------------------------------
 * 上一版 tools/rule-impl-audit.mjs 用「正则抓 id」判断是否实现，
 * 对 scanner-citation.js 会误判（它的 CHECKS 数组与 JSON 的编号顺序不同）。
 *
 * 本脚本改用「**运行时实证**」：直接给每条规则喂一个必然违规的最小样本，
 * 看规则能否报出自己。报得出 = 有可用判据；报不出 = 死规则或判据失效。
 * 这样不依赖任何命名约定，结论可靠。
 *
 * 用法：node tools/rule-liveness.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { scanFormat } = await import('../src/scanner-format.js');
const { scanLanguage } = await import('../src/scanner-language.js');
const { scanCitation } = await import('../src/scanner-citation.js');

/* ---------- 合成 doc ---------- */
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
  return {
    label: opts.label || 'test.docx', core: {},
    parts: { 'document.xml': { paragraphs, revisions: [], blocks: [] }, 'footnotes.xml': { paragraphs: footnotes, revisions: [], blocks: [] } },
    paragraphs, footnotes, endnotes: [], comments: [], styles: { byId: {} }, numbering: {},
    tables: [], blocks: [], revisions: [], footnoteRefs: [],
    stats: { paragraphs: paragraphs.length, chars: paragraphs.reduce((s, p) => s + p.charCount, 0), comments: 0, insertions: 0, deletions: 0, tables: 0, footnotes: footnotes.length, endnotes: 0 },
  };
}

/* ---------- 语料取样：真实违规样本库 ---------- */
/**
 * 从真实语料里抽取「历史上确实被责编批改过」的段落，作为真实违规样本。
 * 这比人工编造样本更可靠。
 */
function loadRealSamples(limit = 4000) {
  const out = [];
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'comments', 'occurrences.json'), 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.occurrences || raw.items || []);
    for (const o of arr.slice(0, limit)) {
      const text = o.context || o.paragraph || o.text || '';
      if (text && text.length > 10) out.push({ text, comment: o.comment || o.note || '' });
    }
  } catch { /* 没取到就退回合成样本 */ }
  return out;
}

/* ---------- 探针：每条规则一个必然违规样本 ---------- */
const probes = {
  /* ---- 格式 ---- */
  'FMT-010': mkDoc(['一、研究背景。', '正文内容足够长用于占位。'], { props: [{ outline: 1 }, {}] }),
  'FMT-022': mkDoc(['本文分析了 3 个案例，涉及 5 个省份。']),
  'FMT-027': mkDoc(['这是没有段首缩进的正文段落，直接顶格开始。']),
  'FMT-030': mkDoc(['这是正文。①', '脚注标号放在句号里面了。']),
  'FMT-040': mkDoc(['《论语》学而篇云云。']),
  'FMTB-014': mkDoc(['[关键词] 国家两重性；历史贡献；当代启示']),
  'FMTB-032': mkDoc(['本文讨论马克思主义。', '马克思主义的方法。', '马克思主义的立场。', '马克思主义。']),
  'FMTB-010': mkDoc(['本文讨论 20世纪90年代 的变化。']),
  'FMTB-036': mkDoc(['一、中国向何处去？还是世界向何处去？']),
  'FMTB-012': mkDoc(['正文结束。', '张三，复旦大学教授。']),
  'FMTB-006': mkDoc(['[内容提要] 提要内容。', '[关键词] 甲；乙；丙'], { label: '01-张三-某研究-专题.docx' }),
  'FMTB-021': mkDoc(['[内容提要] 提要内容。', '[关键词] 甲；乙；丙'], { label: '01-张三-某调研-调研.docx' }),
  'FMTB-022': mkDoc(['[内容提要] 提要内容。', '[关键词] 甲；乙；丙'], { label: '01-张三-评某书-书评.docx' }),
  /**
   * FMTB-018（图表不得用颜色区分）在 632 份真实语料上**一次都不触发**，
   * 而且**永远不会**触发 —— 实测语料里 `word/media/` 图片数为 **0**，
   * 即 632 篇全部没有嵌入图表，规则要检查的对象根本不存在。
   *
   * 但判据本身是有效的（探针能命中），所以这里保留探针，
   * 把「判据坏掉」和「语料里没有这种问题」两件事分开。
   * 真正的图表配色只能靠人工看图 —— 已同步到规则库的 status 说明。
   */
  'FMTB-018': mkDoc(['图1 2020—2024年各地区GDP变化，红色代表东部，蓝色代表西部。']),
  'FMTB-007': mkDoc(['下表列出各年数据。', '1 2 3 4 5']),

  /* ---- 语言 ---- */
  'LANG-001': mkDoc(['这提供了一个良性循环。']),
  'LANG-003': mkDoc(['大约 30 人左右参加了会议。']),
  'LANG-013': mkDoc(['他的做法差强人意，令人失望。']),
  'LANG-017': mkDoc(['一名老师们参加了会议。']),
  'LANG-018': mkDoc(['此说甚当，然而现代学术之规范要求我们重新审视该问题，并进行系统论证。']),
  'LANG-021': mkDoc(['比例高达 150%。']),
  'LANG-025': mkDoc(['我本人认为拙作有一定价值。']),
  'LANG-012': mkDoc(['首先，问题在于制度。']),

  /* ---- 引文 ---- */
  'CIT-001': mkDoc(['正文引用了观点。'], { footnotes: ['参见张三维：《现代中国》，北京大学出版社2010年。'] }),
  'CIT-005': mkDoc(['正文引用网络资料。'], { footnotes: ['《某篇报道》，人民网，http://example.com/a.html。'] }),
  'CIT-008': mkDoc(['正文。'], { footnotes: ['张三维：《现代中国》，北京大学出版社2010年版，第10-20页。'] }),
  'CIT-009': mkDoc(['正文。'], { footnotes: ['张三维：《现代中国》,北京大学出版社2010年版。'] }),
  'CIT-010': mkDoc(['正文。'], { footnotes: ['张三维：《现代中国》，北京大学出版社2010年版。'] }),
  'CIT-011': mkDoc(['正文。'], { footnotes: ['张三维：《现代中国》，北京大学出版社2010。'] }),
  'CIT-012': mkDoc(['正文。'], { footnotes: ['John Rawls, A Theory of Justice, Harvard University Press, 1971, 15.'] }),
  'CIT-014': mkDoc(['正文。'], { footnotes: ['转引自李四：《某文》，载《某刊》2010年第3期。'] }),
  'CIT-015': mkDoc(['正文。'], { footnotes: ['WTO 规则要求……'] }),
  'CIT-016': mkDoc(['正文。'], { footnotes: ['张三维：《现代中国》，北京大学出版社2010年版，第10页。'] }),
  /**
   * CIT-017 探针在**脚注**上，不在正文上。
   *
   * 原先这里写的是 `mkDoc(['表1 各年数据', '数据来源：'])` —— 那是
   * 「图表资料来源」的形态，属于 **CIT-031**（第 15 轮新立并实现），
   * 而不是 CIT-017「中文书名未加书名号」。也就是说旧探针**探错了规则**：
   * 它让 CIT-017 看起来是活的，实际验证的是另一条判据。
   *
   * 第 15 轮重写 CIT-017 判据后，旧探针自然失败（✗ 未报出），
   * 却因为 CIT-017 被归入「合法未触发」而被计入通过 ——
   * 探针失败被静默吞掉，比没有探针更危险。现改为真判据对应的形态。
   */
  'CIT-017': mkDoc(['正文。'], { footnotes: ['毛泽东选集，人民出版社1991年版，第47页。'] }),
  /**
   * CIT-031（图表资料来源只给网站名）的探针。
   *
   * 注意这条规则扫的是**正文段落**（图注来源不在脚注里），
   * 所以探针也必须放正文。
   */
  'CIT-031': mkDoc(['表1 各年数据', '资料来源：中国知网。']),
  'CIT-018': mkDoc(['正文。'], { footnotes: ['GDP 增长迅速。'] }),
  'CIT-019': mkDoc(['正文。'], { footnotes: ['参见《北京大学学报》2010年第3期。'] }),
  'CIT-020': mkDoc(['正文。'], { footnotes: [`${'这是一段很长的引文。'.repeat(40)}`] }),
  'CIT-021': mkDoc(['正文。'], { footnotes: ['某市档案馆藏：《内部文件》，未刊。'] }),
  'CIT-025': mkDoc(['正文。'], { footnotes: ['张三维：《现代中国》，北京大学出版社。'] }),
  // CIT-026 已改判为人工复核（第 21 轮）：候选总体 22 处、零真违规，
  // 判据本身不可自动判定，故不再有存活性探针。

  'CIT-028': mkDoc(['正文。'], { footnotes: ['参见《中华人民共和国合同法》。'] }),
  'CIT-030': mkDoc(['正文。'], { footnotes: ['张三维：《现代中国》，2010年版，北京大学出版社，第10页。'] }),
};

/* ---------- 逐条探针 ---------- */
const results = [];
for (const [ruleId, doc] of Object.entries(probes)) {
  let got = [];
  let err = null;
  try {
    const f = scanFormat(doc); const l = scanLanguage(doc); const c = scanCitation(doc);
    got = [...new Set([...f.issues, ...l.issues, ...c.issues].map((i) => i.ruleId))];
  } catch (e) { err = e.message; }
  results.push({ ruleId, fired: got.includes(ruleId), got, err });
}

console.log('规则存活探针（每条规则喂一个必然违规样本）\n');
console.log('规则         结果      同时报出的其它规则');
console.log('─'.repeat(90));
let alive = 0; const dead = [];
for (const r of results) {
  const mark = r.err ? '抛错' : r.fired ? '✓ 报出' : '✗ 未报出';
  if (r.fired) alive++;
  else dead.push(r);
  console.log(`${r.ruleId.padEnd(12)} ${mark.padEnd(9)} ${r.got.filter((g) => g !== r.ruleId).slice(0, 8).join(',') || '无'}${r.err ? '  ERR: ' + r.err : ''}`);
}
console.log(`\n探针命中：${alive}/${results.length}`);
if (dead.length) {
  console.log(`\n判据失效/未实现（${dead.length} 条）：`);
  for (const d of dead) console.log(`  · ${d.ruleId}`);
}

/* ---------- 真实语料交叉验证：这些规则的判据在真实文本上会不会报 ---------- */
const samples = loadRealSamples(3000);
console.log(`\n真实语料交叉验证：${samples.length} 条历史批注上下文`);
if (samples.length) {
  // 把每条批注上下文当成一段正文，跑语言扫描器，看哪些规则会报
  const realHit = new Map();
  for (const s of samples) {
    let ids = [];
    try {
      const doc = mkDoc([s.text]);
      ids = [...new Set([...scanFormat(doc).issues, ...scanLanguage(doc).issues, ...scanCitation(doc).issues].map((i) => i.ruleId))];
    } catch { /* 跳过 */ }
    for (const id of ids) realHit.set(id, (realHit.get(id) || 0) + 1);
  }
  const top = [...realHit.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log('真实文本上命中次数排行（前 25）：');
  for (const [id, n] of top) console.log(`  ${id.padEnd(12)} ${n}`);
  const neverInReal = results.filter((r) => !realHit.has(r.ruleId)).map((r) => r.ruleId);
  console.log(`\n在真实批注上下文里一次都没命中的规则（${neverInReal.length} 条）：`);
  console.log('  ' + neverInReal.join(', '));
}

/* ---------- 区分「真死」与「探针盲区」 ----------
 * 探针只覆盖「纯文本可判定」的规则，很多结构/引文类规则的合成样张构造不出来，
 * 于是被误记为「未报出」。必须再拿**真实语料命中**交叉验证：
 *   · 探针未报 + 语料 0 命中 → 真死（判据失效或未实现），要修要删；
 *   · 探针未报 + 语料有命中 → 探针盲区（规则是好的，是样张不够），属可维护性欠账。
 * 不做这一步，会把 21 条「明明在跑」的规则错报成死规则。 */
let covFired = new Map();
try {
  const cov = JSON.parse(readFileSync(join(ROOT, 'data', 'verify', 'rule-coverage.json'), 'utf8'));
  for (const r of cov.rules || []) covFired.set(r.id, !!r.fired);
} catch { /* 没有 coverage 就只按探针判 */ }
const deadOnCorpus = dead.filter((d) => !covFired.get(d.ruleId));
const probeBlind = dead.filter((d) => covFired.get(d.ruleId));
if (dead.length) {
  console.log(`\n探针未报出的 ${dead.length} 条，交叉语料后拆解：`);
  console.log(`  · 真死（探针与 632 篇语料都没报）：${deadOnCorpus.length} 条 ${deadOnCorpus.map((d) => d.ruleId).join(', ')}`);
  console.log(`  · 探针盲区（语料有命中，是样张不够）：${probeBlind.length} 条 ${probeBlind.map((d) => d.ruleId).join(', ')}`);
}

const out = {
  generatedAt: new Date().toISOString(),
  probeTotal: results.length,
  probeAlive: alive,
  deadRules: dead.map((d) => d.ruleId),
  deadOnCorpus: deadOnCorpus.map((d) => d.ruleId),
  probeBlind: probeBlind.map((d) => d.ruleId),
  results,
};
writeFileSync(join(ROOT, 'data', 'verify', 'rule-liveness.json'), JSON.stringify(out, null, 1), 'utf8');
console.log('\n明细已写入 data/verify/rule-liveness.json');

/* ==================================================================
   权威验证：在真实语料上复现
   ---------------------------------------------------------------
   合成探针只覆盖「纯文本可判定」的规则：段落缩进、字号、样式、表格
   等判据依赖段落属性，最小合成 doc 里没有这些属性，因此合成探针报
   「未报出」**不能**证明规则失效。
   真正可信的做法是拿真实稿件复现：对每条规则，取历史上真正触发过它
   的稿件，重新解析 + 扫描，看现在是否仍然触发。
   ================================================================== */
const coveragePath = join(ROOT, 'data', 'verify', 'rule-coverage.json');
if (!existsSync(coveragePath)) {
  console.log('\n未找到 rule-coverage.json，跳过真实语料复现（先跑 tools/rule-coverage.mjs）');
} else {
  const cov = JSON.parse(readFileSync(coveragePath, 'utf8'));
  const CORPUS_ROOT = cov.corpusRoot;
  // ruleId -> 触发过它的稿件相对路径
  const docsByRule = new Map();
  for (const d of cov.perDoc || []) {
    const rel = d.path || d.file;   // path 是相对语料根的全路径；file 只是文件名
    for (const rid of d.rules || []) {
      if (!docsByRule.has(rid)) docsByRule.set(rid, []);
      docsByRule.get(rid).push(rel);
    }
  }
  const neverFired = new Set(cov.neverFired || []);
  const declared = cov.rules || [];

  console.log(`\n${'═'.repeat(70)}`);
  console.log('真实语料复现验证');
  console.log(`${'═'.repeat(70)}`);
  console.log(`规则库 ${declared.length} 条；其中 ${declared.length - neverFired.size} 条在 632 份真实稿件上触发过`);
  console.log(`未触发 ${neverFired.size} 条\n`);

  // 对触发过的规则做抽样复现（每规则取最多 2 篇）。
  // 先收集所有需要的稿件（去重），多核并行解析一次，再判每条规则是否复现。
  const toCheck = declared.filter((r) => !neverFired.has(r.id));
  const reproduced = []; const failedRepro = [];

  const needed = new Set();
  for (const r of toCheck) for (const f of (docsByRule.get(r.id) || []).slice(0, 2)) needed.add(f);

  const { mapCorpus } = await import('./lib/corpus.mjs');
  const items = [...needed].map((rel) => ({ full: join(CORPUS_ROOT, rel), path: rel }));
  const raws = await mapCorpus(items, 'ruleIds');
  const idsByFile = new Map();
  for (const [i, msg] of raws.entries()) {
    idsByFile.set(items[i].path, (msg && msg.result) ? msg.result.ruleIds : null);
  }

  let checked = 0;
  for (const r of toCheck) {
    const files = (docsByRule.get(r.id) || []).slice(0, 2);
    let ok = false;
    for (const f of files) {
      const ids = idsByFile.get(f);
      if (ids && ids.includes(r.id)) { ok = true; break; }
    }
    checked++;
    if (ok) reproduced.push(r.id); else failedRepro.push(r.id);
  }
  console.log(`复现通过：${reproduced.length}/${checked}`);
  if (failedRepro.length) {
    console.log(`复现失败（${failedRepro.length} 条）：`);
    for (const id of failedRepro) console.log(`  · ${id}`);
  }

  // 未触发的规则：区分「模型规则（本就不该由规则引擎报）」与「规则引擎规则（值得怀疑）」
  const neverList = declared.filter((r) => neverFired.has(r.id));
  const neverModel = neverList.filter((r) => r.status === 'model' || r.detectType === 'model');
  const neverAuto = neverList.filter((r) => !(r.status === 'model' || r.detectType === 'model'));
  console.log(`\n未触发的 ${neverList.length} 条拆解：`);
  console.log(`  · 模型规则（设计上就交给大模型，规则引擎本就不该报）：${neverModel.length} 条`);
  for (const r of neverModel) console.log(`      ${r.id} ${r.title.slice(0, 40)}`);
  console.log(`  · 规则引擎规则（在 632 份真实稿件上一次都没报，值得逐条确认）：${neverAuto.length} 条`);
  for (const r of neverAuto) console.log(`      ${r.id.padEnd(11)} [${r.detectType || '?'}] ${r.title.slice(0, 46)}`);

  const out2 = {
    generatedAt: new Date().toISOString(),
    corpusDocs: cov.docsScanned,
    declaredRules: declared.length,
    firedOnCorpus: declared.length - neverFired.size,
    neverFiredTotal: neverList.length,
    neverFiredModel: neverModel.map((r) => r.id),
    neverFiredAuto: neverAuto.map((r) => ({ id: r.id, group: r.group, detectType: r.detectType, title: r.title })),
    reproductionPassed: reproduced,
    reproductionFailed: failedRepro,
  };
  writeFileSync(join(ROOT, 'data', 'verify', 'rule-liveness-corpus.json'), JSON.stringify(out2, null, 1), 'utf8');
  console.log('\n明细已写入 data/verify/rule-liveness-corpus.json');
}
