/**
 * 自检：验证解析器、规则引擎的核心行为。
 * 运行：node tools/selftest.mjs
 */
import { parseXml } from '../src/xml.js';
import { openZip, readZipEntries } from '../src/zip.js';
import { loadFormatRules, classifyParagraphs, scanFormat } from '../src/scanner-format.js';
import { loadLanguageRules, splitSentences, scanLanguage } from '../src/scanner-language.js';
import { loadCitationRules, hasPage, isMultiWorkNote } from '../src/scanner-citation.js';
import { parseDocx } from '../src/docx.js';
import { computeAnchor } from '../src/anchors.js';
import { judge } from '../src/verdict.js';
import { ARK_TEMPERATURE, buildWindowPrompt, cachedTokensOf, prefixCacheEnabled, PREFIX_CACHE_MIN_CHARS, buildDigestSource, formatDocDigest, buildConsistencyPrompt, CONSISTENCY_INSTRUCTIONS, consistencyEnabled } from '../src/ark.js';
import { recheckConcurrency } from '../src/recheck.js';
import { isTextHeading, HEADING_LEVEL_FORMS, TEXT_HEADING_PATTERNS } from '../src/headings.js';
import { tokenize, normalizeForIndex, isUsefulComment, makeRetriever } from '../src/comment-cases.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS_ROOT } from './paths.mjs';

/**
 * `dsh/` 目录（脚本自身往上两级）—— **所有本地路径都锚在这里，不锚 cwd**。
 * 原来若干处用 `resolve(process.cwd())`，隐含要求"调用者正好在 dsh/ 下"；
 * 从别处调用会去找 `学术/samples/test.docx` 之类不存在的位置，
 * 报出来是"文件不存在"，看起来像数据丢失，其实是路径算错。
 */
const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  ✗ ${name}  ${detail}`); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

console.log('\n═══ 自检 ═══\n');

/* ---------- 1. XML 解析 ---------- */
console.log('[1] XML 解析器');
{
  const root = parseXml('<a x="1"><b>文字&amp;符号</b><c/><d><e>深</e></d></a>');
  const a = root.children[0];
  eq(a.name, 'a', '根元素名');
  eq(a.attr('x'), '1', '属性读取');
  eq(a.el('b').allText(), '文字&符号', '实体解码');
  eq(a.descendants('e').length, 1, '后代查询');
  eq(a.el('c').children.length, 0, '自闭合标签');
  const selfClose = parseXml('<w:p><w:br/><w:t>甲</w:t></w:p>');
  eq(selfClose.descendants('w:t')[0].allText(), '甲', '自闭合后不吞兄弟节点');
  const cdata = parseXml('<a><![CDATA[<raw>]]></a>');
  eq(cdata.children[0].allText(), '<raw>', 'CDATA 处理');
  const comment = parseXml('<a><!-- 注释 --><b>乙</b></a>');
  eq(comment.children[0].children.length, 1, '注释跳过');
}

/* ---------- 2. ZIP 读取 ---------- */
console.log('\n[2] ZIP 读取器');
{
  const sample = findSampleDocx();
  if (sample) {
    const buf = readFileSync(sample);
    const entries = readZipEntries(buf);
    ok(entries.length > 3, `解析中央目录（${entries.length} 个条目）`);
    const zip = openZip(buf);
    ok(zip.has('word/document.xml'), '存在 word/document.xml');
    const doc = zip.readText('word/document.xml');
    ok(doc.includes('<w:document'), 'deflate 解压正确');
    ok(zip.read('nonexistent.xml') === null, '缺失条目返回 null');
  } else {
    console.log('  - 跳过（未找到样本 docx）');
  }
}

/* ---------- 4. 规则库结构 ---------- */
console.log('\n[4] 规则库');
{
  const fmt = loadFormatRules();
  const lang = loadLanguageRules();
  const cit = loadCitationRules();
  ok(fmt.rules.length >= 30, `格式规则 ${fmt.rules.length} 条 ≥ 30`);
  ok(lang.rules.length >= 25, `语言规则 ${lang.rules.length} 条 ≥ 25`);
  ok(cit.rules.length >= 20, `引文规则 ${cit.rules.length} 条 ≥ 20`);

  // id 唯一
  for (const [name, cfg] of [['格式', fmt], ['语言', lang], ['引文', cit]]) {
    const ids = cfg.rules.map((r) => r.id);
    ok(new Set(ids).size === ids.length, `${name}规则 id 唯一`);
  }
  // 正则全部可编译
  let bad = [];
  for (const cfg of [fmt, lang, cit]) {
    for (const r of cfg.rules) {
      for (const p of r.detect?.patterns || []) {
        if (typeof p !== 'string') continue;
        try { new RegExp(p); } catch (e) { bad.push(`${r.id}: ${p}`); }
      }
    }
  }
  eq(bad, [], '全部正则表达式可编译');
  // 每条规则有依据与严重度
  for (const cfg of [fmt, lang, cit]) {
    const missing = cfg.rules.filter((r) => !r.severity).map((r) => r.id);
    eq(missing, [], `${cfg.rules.length} 条规则均有严重度`);
  }
  // 期刊体例常量
  eq(fmt.journal.abstractPreferredMarker, '[内容提要]', '内容提要标记');
  eq(fmt.journal.keywordPreferredMarker, '[关键词]', '关键词标记');
  eq(fmt.journal.keywordSeparator, '；', '关键词分隔符');
}

/* ---------- 5. 段落角色分类 ---------- */
console.log('\n[5] 段落角色分类');
{
  const fakeDoc = {
    paragraphs: [
      { index: 0, text: '文明型国家理论创新', properties: { jc: 'center' }, format: { sizeHalfPt: 24 } },
      { index: 1, text: '张维为', properties: { jc: 'center' }, format: {} },
      { index: 2, text: '[内容提要] 本文讨论……', properties: {}, format: {} },
      { index: 3, text: '[关键词] 文明型国家；现代化', properties: {}, format: {} },
      { index: 4, text: '一、问题的提出', properties: {}, format: {} },
      { index: 5, text: '正文段落内容。', properties: {}, format: {} },
      { index: 6, text: '（一）子标题', properties: {}, format: {} },
      { index: 7, text: '作者简介：张维为，复旦大学教授。', properties: {}, format: {} },
    ],
  };
  const { roles, abstractIdx, keywordIdx } = classifyParagraphs(fakeDoc);
  eq(roles[2], 'abstract', '识别内容提要');
  eq(roles[3], 'keywords', '识别关键词');
  eq(roles[4], 'heading', '识别一级标题');
  eq(roles[6], 'heading', '识别二级标题');
  eq(roles[7], 'authorBio', '识别作者简介');
  eq(abstractIdx, 2, '提要位置');
  eq(keywordIdx, 3, '关键词位置');
}

/* ---------- 6. 端到端解析 ---------- */
console.log('\n[6] 端到端 DOCX 解析');
{
  const sample = findSampleDocx();
  if (sample) {
    const doc = parseDocx(sample);
    ok(doc.stats.paragraphs > 10, `段落数 ${doc.stats.paragraphs}`);
    ok(doc.stats.chars > 500, `字数 ${doc.stats.chars}`);
    ok(doc.paragraphs.some((p) => p.text.trim()), '段落有文本');
    ok(Array.isArray(doc.footnotes), '脚注数组存在');
    ok(Array.isArray(doc.comments), '批注数组存在');
    ok(Array.isArray(doc.revisions), '修订数组存在');
    // 修订前后文本不同说明痕迹解析生效
    const changed = doc.paragraphs.filter((p) => p.changed).length;
    console.log(`  · 含修订痕迹的段落：${changed}`);
  } else {
    console.log('  - 跳过（未找到样本 docx）');
  }
}

/* ---------- 7. 语料产物 ---------- */
console.log('\n[7] 语料产物');
{
  /**
   * 语料产物路径锚在**脚本自身**，不锚 cwd。
   * 原来用 `resolve(process.cwd())`，要求调用者正好在 `dsh/` 目录下 ——
   * 从别处调用会全部报"不存在"，看起来像数据丢了，其实是路径算错。
   */
  const base = SELF_ROOT;
  const checks = [
    ['data/comments/occurrences.json', '批注上下文'],
    ['data/comments/occurrence-stats.json', '批注统计'],
    ['data/corpus/revision-pairs.json', '修订对照'],
    ['data/comments/topics.json', '主题统计'],
  ];
  for (const [p, name] of checks) {
    const full = resolve(base, p);
    const exists = existsSync(full);
    ok(exists, `${name} 存在（${p}）`);
    if (exists) {
      const size = readFileSync(full).length;
      ok(size > 100, `${name} 非空（${(size / 1024).toFixed(0)} KB）`);
    }
  }
}

/* ---- 句子切分：中文与西文都要正确切开 ---- */
/**
 * 这组检查是**回归护栏**。
 *
 * 背景：`splitSentences()` 原先只按 `。！？；` 切句，完全不认半角句号，
 * 导致整段英文摘要被当成**一个句子**，于是 LANG-010「欧化长句」报出
 * 「句子长度 2150 字，建议拆分」—— 中文长句规则去拆英文摘要。
 * 这个缺陷在语料上安静地存在了很久，是模型复核才把它揪出来的。
 * 所以在这里钉死：句子切分的行为一旦回退，selftest 立刻失败。
 */
{
  const T = [
    ['中文三句', '这是第一句。这是第二句！第三句？', 3],
    ['英文摘要', 'Abstract: In the U.S., the White has been seen as self-evident. This paper argues that race matters. It concludes otherwise.', 3],
    ['小数点不切', '圆周率是 3.14 左右。这个数很重要。', 2],
    ['U.S. 不切', '参见 U.S. Census Bureau 的数据。该数据表明趋势。', 2],
    ['No.5 不切', '见 No.5 文件。另见附录。', 2],
    ['中英混排', '本文讨论 race 问题。It argues that identity is fluid. 结论如下。', 3],
    /**
     * 以下 5 条守的是「断句修正」（第 31 轮：全语料断句审计揪出的四类错误）。
     *   · 收尾引号被甩到下一句（实测 6329 句 / 2.90%）
     *   · 省略号不切句
     *   · 小写结尾缩写（et al. / trans.）被误切（实测 311 句）
     *   · 网址/文件名里的点被误切
     *   · 手工换行（w:br）不切句（实测 74 段）
     */
    ['引号收尾不甩尾', '他说：“这样很好。”然后走了。', 2],
    ['省略号切句', '他沉默着……然后开口了。', 2],
    ['et al. 不切', 'Smith et al. 2020 found this. Next sentence here.', 2],
    ['trans. 不切', 'by Corpet and Matheron, trans. New York: Verso. Next one.', 2],
    ['网址不切', '见 http://www.gov.cn/a.htm 的文件。另见附录。', 2],
    ['换行切句', '第一行没有标点\n第二行也没有标点', 2],
    // 书名号内的句末标点（《怎么办？》/《我们是谁？》）不能当句末
    ['书名号内问号不切', '他读过《怎么办？》这本书。然后他走了。', 2],
    ['书名号内句号不切', '见《我们是谁？》。另见附录。', 2],
    // 句末年份的句号必须切（旧实现误当小数点，两句并一句）
    ['句末年份要切', 'He argued in 2020. The next came later.', 2],
    ['et. al. 不切', 'by Newall et. al., Verso. Next one.', 2],
  ];
  for (const [name, text, want] of T) {
    const got = splitSentences(text).length;
    ok(got === want, `句子切分 · ${name}（期望 ${want} 句，实得 ${got}）`);
  }
}

/* ---- 前置区分段：标题/摘要/关键词的角色判定 ---- */
/**
 * 这组检查同样是**回归护栏**（目标点 8）。
 *
 * 背景：`classifyParagraphs()` 的标题识别原先用
 *   `limit = abstractPos >= 0 ? abstractPos : …` 当搜索上界，
 * 于是「摘要 → 关键词 → 空行 → **标题**」这种排布（工作坊/现场稿，
 * 如 07/10-姚云帆）的标题落在上界之外，**整篇识别不出标题**。
 * 后果是标题类规则（FMT-010/016、FMTB-036 等）在这批稿件上全部空转，
 * 而总量指标完全看不出来 —— 这正是目标点 8 要防的那类缺陷。
 * 实测全语料真稿件标题识别率因此只有 70.7%（446/631），修好后是 97.9%。
 *
 * 这里用**构造的文档**把关键行为钉死，不依赖语料文件。
 */
{
  /**
   * 构造文档夹具。
   *
   * `fmts` 可选：按段落下标补 `properties`/`format`。
   * 篇名判定要求「居中或大字号」（`centered || bigFont`），
   * 而真实稿件里篇名必然带这类外观属性 —— 构造夹具时必须能还原，
   * 否则测的就不是真实场景。
   */
  const mk = (texts, fmts = {}) => ({
    paragraphs: texts.map((t, i) => ({
      index: i,
      text: t,
      properties: fmts[i]?.properties || {},
      format: fmts[i]?.format || {},
    })),
    footnotes: [], endnotes: [], comments: [], tables: [], revisions: [],
  });
  const roleOf = (doc, i) => classifyParagraphs(doc).roles[i];

  // 常规排布：标题在最前
  const A = mk(['作为经济基础的国家：对历史唯物主义的再认识', '孟捷', '内容提要：本文讨论…', '关键词：国家；经济']);
  ok(roleOf(A, 0) === 'title', '分段 · 常规排布首段判为标题');
  ok(roleOf(A, 1) === 'author', '分段 · 姓名行判为作者');
  ok(roleOf(A, 2) === 'abstract', '分段 · 「内容提要：」判为摘要');
  ok(roleOf(A, 3) === 'keywords', '分段 · 「关键词：」判为关键词');

  // 摘要在前、标题在关键词之后 —— 这就是原先漏掉的那批
  // 标题段带 `jc:'center'`：真实稿件（07-姚云帆-从"工程学社会主义"到…-现场）
  // 该段实测就是居中的，夹具还原这一点才与真实场景一致。
  const B_TEXTS = ['摘要：阿尔都塞坚持实践的物质性…', '关键词：工程学社会主义 军事社会主义', '', '', '从“工程学社会主义”到“军事社会主义”：读阿尔都塞《怎么办？》', '1.略述阿尔都塞的写作意图', '正文段落。'];
  const B = mk(B_TEXTS, { 4: { properties: { jc: 'center' } } });
  ok(roleOf(B, 4) === 'title', '分段 · 摘要在前时，关键词之后的标题仍能识别（原缺陷）');
  ok(roleOf(B, 5) === 'heading', '分段 · 编号短行判为小标题');

  /**
   * 同一位置、但**没有外观显著性**（不居中、不比正文大）时，不判篇名。
   *
   * 这是后来补的约束：位置判据（`beforeFirstHeading`）单独不够用 ——
   * 「首个强标题」的位置会随判据优先级变化。实测
   * `11-罗楠-能动性视角下肯尼亚…` 把编号信号提前后，首个强标题从第 8 段
   * 变成第 10 段，第 8 段那条**普通左对齐章节标题**
   * （`全球环境治理体系形成的结构性基础`）就落进篇名窗口被误判成篇名，
   * 层级被前置区清理抹掉，16 个标题里凭空少了一个。
   */
  const B2 = mk(B_TEXTS);
  ok(roleOf(B2, 4) !== 'title', '分段 · 关键词之后的短行若不居中也不大字号，不判篇名');

  // 关键词的三种实测形态
  const C = mk(['标题', '关键词', '国家两重性；经济基础', 'Keywords: civilization-state, China']);
  ok(roleOf(C, 1) === 'keywords', '分段 · 裸「关键词」单独成行判为关键词');
  const D = mk(['标题', '内容提要] 村级民主是实现…', '关键词：民主']);
  ok(roleOf(D, 1) === 'abstract', '分段 · 缺左括号的「内容提要]」判为摘要（原缺陷）');
  const E = mk(['标题', 'Keywords: civilization-state, China', '正文。']);
  ok(roleOf(E, 1) === 'keywords', '分段 · 英文「Keywords:」判为关键词（原缺陷）');

  // 元数据行不能被当成标题
  const F = mk(['Non-West Model: Is There Such a Thing as a Civilization State?', 'Publication:  Social Sciences', 'Source: Vol. 52, No. 1 (2021), pp. 50-64', 'Author: Vitaly Naumkin', 'DOI: http://dx.doi.org/10.21557/SSC']);
  ok(roleOf(F, 0) === 'title', '分段 · 西文长标题能识别（TITLE_MAX_LATIN）');
  ok(roleOf(F, 1) !== 'title' && roleOf(F, 2) !== 'title' && roleOf(F, 3) !== 'title' && roleOf(F, 4) !== 'title',
    '分段 · Publication/Source/Author/DOI 元数据行不判为标题');

  // 非稿件类文档不硬挑标题
  const G = mk(['秦老师：', '您好！读了您的文章收益良多。', '不过，我也存在几点困惑。']);
  ok(classifyParagraphs(G).nonManuscript === true, '分段 · 编辑部来信被识别为非稿件');
  ok(!classifyParagraphs(G).roles.includes('title'), '分段 · 非稿件类文档不标标题（避免把「您好！」当标题）');
}

/* ---- 作者简介标记：序数前缀 + 防过严反向护栏（目标点 8/9）---- */
/**
 * 第 25 轮的回归护栏。
 *
 * 语料普查 452 篇含简介段的稿件：`作者系` 343 处、**`第一作者` 100 处**、
 * **`第二作者` 100 处**、`第三作者` 9 处。而 `authorBioMarker` 表里只有「作者系」等，
 * `markerHit` 又要求整段以标记开头 → 这 209 处全部漏检，FMT-001 报 516 篇、
 * FMT-036 报 590 篇（编辑批注重合 0）。修好后降到 453 / 137。
 *
 * 同时钉死两件事：
 *   ① 序数前缀必须认（否则 FMT-001/FMT-036 复发）；
 *   ② **`作者认为…` 这类正文句不得认成简介段** —— 这是我第一版修复的反向教训：
 *      当时把特例写进了通用 `markerHit`，导致 `markerHit(t, abstractMarker)`
 *      也命中「作者系…」，而摘要判定排在简介判定之前，**简介段被判成摘要**，
 *      FMT-001 反而在全部 632 篇上报错（比不改更糟）。
 *      所以这里既要正向探针，也要反向探针。
 */
{
  const mk = (texts) => ({
    paragraphs: texts.map((t, i) => ({
      index: i, text: t, properties: {}, format: {},
    })),
    footnotes: [], endnotes: [], comments: [], tables: [], revisions: [],
  });
  const bioDoc = (bio) => mk([
    '毛泽东对中医药事业的历史贡献',
    '方旭 徐文',
    '[内容提要] 本文讨论毛泽东与中医药事业的历史贡献，兼论当代启示。',
    '[关键词] 毛泽东；中医；中药',
    '中医药学是中华民族数千年来同疾病作斗争的智慧结晶，是自成体系的医学科学。在中医药学的发展史上，以春秋战国时期扁鹊提出的原则为标志，历代医家不断丰富其内容，形成了独特的理论体系与诊疗方法，值得深入研究与系统总结。',
    bio,
  ]);
  // 正向：三种主流形态都要认成 authorBio，且 FMT-001 / FMT-036 不得再报缺简介
  for (const [bio, label] of [
    ['第一作者系重庆市委党校应急管理培训中心教授', '序数前缀·第一作者系'],
    ['第二作者系重庆市委党校马克思主义理论专业硕士研究生', '序数前缀·第二作者系'],
    ['作者系云南大学国际关系研究院研究员', '作者系'],
    ['作者简介：方旭（1984—），男，湖南衡阳人', '作者简介'],
    ['通讯作者系复旦大学教授', '通讯作者系'],
  ]) {
    const doc = bioDoc(bio);
    ok(classifyParagraphs(doc).roles[5] === 'authorBio', `分段 · ${label} 判为作者简介`);
    const ids = (scanFormat(doc).issues || []).map((x) => x.ruleId);
    ok(!ids.includes('FMT-001'), `分段 · ${label} 时 FMT-001 不再报缺要素`);
    ok(!ids.includes('FMT-036'), `分段 · ${label} 时 FMT-036 不再报缺作者简介`);
  }
  // 反向：正文里的「作者认为/作者指出」不得被当成简介段
  for (const [text, label] of [
    ['作者认为，这一现象值得注意。', '作者认为'],
    ['作者指出，问题的关键在于制度。', '作者指出'],
    ['作者强调，这一点常被忽略。', '作者强调'],
  ]) {
    ok(classifyParagraphs(mk([text])).roles[0] === 'body', `分段 · 「${label}…」不误判为作者简介`);
  }
  // 反向：简介段不得被摘要判定抢走（第一版修复的实际故障）
  ok(classifyParagraphs(mk(['作者系云南大学国际关系研究院研究员'])).roles[0] !== 'abstract',
    '分段 · 作者简介段不被误判为摘要（通用 markerHit 串味护栏）');
}

/* ---- 关键词规则：标记剥离 / 中英分尺 / 分隔符（目标点 8/9）---- */
/**
 * 第 26 轮的回归护栏。
 *
 * 修前实测：FMT-005 127 处、FMT-006 17 处、FMT-007 **126 处**。
 * FMT-007 的 126 处**全是误报** —— 两个来源：
 *   ① 标记没剥掉，`Key Words: American Racism` 被当成**一个关键词**量长度（26 字）；
 *   ② 中英文用同一把 20 字尺子，但西文关键词本来就长
 *      （`Rural people communication` 26 字符、3 个词，完全正常）。
 * 修后：FMT-005 → 6、FMT-006 → 11、FMT-007 → **0**。
 *
 * 同时钉死两条**我试过但实测是错的**判据，防止以后有人再想加：
 *   · 「西文关键词以句点结尾 = 整句」→ `Normative Crisis.`、`religion.` 都是
 *     西文关键词表末尾的句点，不是句子；
 *   · 「中文关键词含「？」= 整句」→ `《怎么办？》` 是**书名**。
 * 所以「是不是整句」只能靠**长度**判，不能靠标点。
 */
{
  const mkKw = (texts) => ({
    label: 'kw.docx',
    paragraphs: texts.map((t, i) => ({ index: i, text: t, properties: {}, format: {} })),
    footnotes: [], endnotes: [], comments: [], tables: [], revisions: [],
  });
  const head = [
    '标题', '作者',
    '[内容提要] 本文讨论相关问题，涉及多个方面的内容与机制，具有一定的学术价值与现实意义，值得进一步研究。',
  ];
  const kwProbe = (kw) => {
    const ids = (scanFormat(mkKw([...head, kw])).issues || []).map((x) => x.ruleId);
    return { sep: ids.filter((x) => x === 'FMT-005').length, len: ids.filter((x) => x === 'FMT-007').length };
  };
  // 不报：合规的中文 / 双空格 / 单空格 / 西文（含逗号、含空格、以句点结尾）/ 书名带问号 / 11 字长短语
  for (const [kw, label] of [
    ['[关键词] 毛泽东；中医；中药', '规范中文'],
    ['【关键词】毛泽东  中医药  历史贡献  当代启示', '双空格分隔'],
    ['关键词：工程学社会主义 军事社会主义 具体处境（情况）绝对历史主义', '单空格分隔'],
    ['Key Words: American Racism, Demographic Crisis, Privilege', '西文逗号分隔'],
    ['Keywords: civilization-state, China, guanxi, India, dharma, Eurasianism', '西文多词'],
    ['Keywords: Going to the countryside; Moving to the city; Rural people communication', '西文含空格'],
    ['Keywords: Normative Crisis.', '西文以句点结尾（不是整句）'],
    ['Keywords: three dimensional of government debts.', '西文长短语+句点'],
    ['[关键词] 《怎么办？》；阿尔都塞；意识形态', '书名带问号（不是整句）'],
    ['[关键词] 铸牢中华民族共同体意识；法治保障；地方实践', '11 字长名词短语'],
    ['关键词] 村级民主；村民自治；基层治理', '标记残缺'],
  ]) {
    const { sep, len } = kwProbe(kw);
    ok(sep === 0 && len === 0, `关键词 · ${label} 不报分隔符与长度`);
  }
  // 报：中文逗号分隔（真违规）、超长整句
  ok(kwProbe('关键词：中国式现代化，政治经济学，历史唯物主义，孟捷').sep === 1,
    '关键词 · 中文逗号分隔报 FMT-005');
  ok(kwProbe('[关键词] 这是一个明显超过十四个字并且没有句末标点的冗长整句表述').len === 1,
    '关键词 · 超长整句报 FMT-007');
  // 标记归 FMTB-015，FMT-005 不再重复报（第 26 轮去重）
  {
    const ids = (scanFormat(mkKw([...head, '关键词：中国式现代化，政治经济学，历史唯物主义，孟捷'])).issues || []).map((x) => x.ruleId);
    ok(ids.includes('FMTB-015'), '关键词 · 起头标记不规范由 FMTB-015 报出');
  }
}

/* ---- 摘要规则：去重 / 自相矛盾判据 / 来源判据漏看脚注（目标点 7/8/9）---- */
/**
 * 第 27 轮的回归护栏。修前实测：FMT-002 101 处、FMTB-003 28 处、FMTB-005 72 处。
 *
 * ① FMT-002 与 FMTB-015 在 632 篇上 **100% 重复**（同为 101 篇，互不独有）→ 删除 FMT-002 实现；
 * ② FMTB-003 原判据含「文章」，**与本条自身的建议文本矛盾**
 *    （建议写「文章指出」却判「文章」违规）；且编辑批注只点名「本文」「笔者」「本研究」。
 *    另「本刊」在 632 篇提要段中出现 **0 次** → 两者都删；
 * ③ FMTB-005 的来源判据**只看正文段落、完全没看脚注**，而本刊是页下脚注体例
 *    → 72 篇里 71 篇（98.6%）脚注中明明有出处。
 */
{
  const mkAb = (texts) => ({
    label: 'ab.docx',
    paragraphs: texts.map((t, i) => ({ index: i, text: t, properties: {}, format: {} })),
    footnotes: [], endnotes: [], comments: [], tables: [], revisions: [],
  });
  const abIds = (texts) => (scanFormat(mkAb(texts)).issues || []).map((x) => x.ruleId);
  const absBody = '[内容提要] 文章指出，本议题涉及多个层面的机制与结构，具有一定的学术价值与现实意义，值得进一步研究。';

  // ① 提要标记不合规时由 FMTB-015 报出，FMT-002 不再重复
  {
    const ids = abIds(['标题', '作者', '摘要：本文讨论相关问题，涉及多个方面的内容与机制，具有一定的学术价值与现实意义，值得进一步研究。', '[关键词] 甲；乙；丙']);
    ok(ids.includes('FMTB-015'), '摘要 · 起头标记不规范由 FMTB-015 报出');
    ok(!ids.includes('FMT-002'), '摘要 · FMT-002 不再与 FMTB-015 重复报出');
  }
  // ② 「文章指出」不得被判为第一人称（规则自身建议的写法）
  ok(!abIds(['标题', '作者', absBody, '[关键词] 甲；乙；丙']).includes('FMTB-003'),
    '摘要 · 「文章指出」不判 FMTB-003（规则自身建议的写法）');
  ok(!abIds(['标题', '作者', '[内容提要] 本刊近期刊发的相关研究指出，该议题具有重要价值与现实意义，值得进一步深入探讨。', '[关键词] 甲；乙；丙']).includes('FMTB-003'),
    '摘要 · 「本刊」不判 FMTB-003（全语料 0 命中，纯过度设计）');
  // 真违规仍要报
  for (const [t, label] of [
    ['[内容提要] 本文以1949年后的群众教育运动为例，论证了文化翻身在构建主体性意识中的核心作用。', '本文'],
    ['[内容提要] 笔者概述了自己近年来围绕该问题的思考，并做了一点新的补充论证。', '笔者'],
    ['[内容提要] 本研究采用比较方法，分析了多个案例的共性特征与差异表现。', '本研究'],
  ]) {
    ok(abIds(['标题', '作者', t, '[关键词] 甲；乙；丙']).includes('FMTB-003'), `摘要 · 第一人称「${label}」报 FMTB-003`);
  }
  // ③ 来源判据必须看脚注：正文有数据 + 脚注有文献 → 不报 FMTB-005
  const mkData = (notes, bodyText) => ({
    label: 'd.docx',
    paragraphs: [
      { index: 0, text: '标题', properties: {}, format: {} },
      { index: 1, text: '作者', properties: {}, format: {} },
      { index: 2, text: '[内容提要] 文章指出，本议题涉及多个层面的机制与结构，具有一定的学术价值。', properties: {}, format: {} },
      { index: 3, text: '[关键词] 甲；乙；丙', properties: {}, format: {} },
      { index: 4, text: bodyText || '据统计，2020年该领域投入达到 1234 亿元，增长显著，值得关注。', properties: {}, format: {} },
    ],
    footnotes: notes.map((t, i) => ({ index: i, text: t, noteId: i + 1, isNoteSeparator: false })),
    endnotes: [], comments: [], tables: [], revisions: [],
  });
  const has5 = (doc) => (scanFormat(doc).issues || []).some((x) => x.ruleId === 'FMTB-005');
  ok(!has5(mkData(['国家统计局：《中国统计年鉴2021》，中国统计出版社2021年版，第45页。'])),
    '数据来源 · 脚注中有文献著录时不报 FMTB-005（原判据漏看脚注）');
  ok(!has5(mkData(['资料来源：世界银行数据库，2021年。'])),
    '数据来源 · 脚注中有「资料来源」时不报 FMTB-005');
  ok(!has5(mkData([], '资料来源：国家统计局。2020年该领域投入达到 1234 亿元，增长显著。')),
    '数据来源 · 正文写了显式来源时不报 FMTB-005');
  ok(has5(mkData([])), '数据来源 · 正文有数据且脚注无出处时报 FMTB-005');
  ok(has5(mkData(['参见前文论述。'])), '数据来源 · 脚注与来源无关时仍报 FMTB-005');
  /**
   * 「据统计」本身是**需要来源**的标志，不能被当成「已有来源」。
   * 原判据把它当来源证据，于是 `hasSourceMark` 恒为真、规则**永远不报**。
   */
  ok(has5(mkData([], '据统计，该领域近年增长显著，值得关注。')),
    '数据来源 · 「据统计」无出处时报 FMTB-005（原判据必然漏报）');
}

/* ---- 引文页码判据：多段页码与并列著录（目标点 7/9）---- */
/**
 * 这组是**误报回归护栏**。
 *
 * 背景：CIT-001「文献著录缺少具体页码」在 632 篇语料上命中 591 条，
 * 其中 51 条（8.6%）是误报，两个来源：
 *   ① `hasPage()` 只认**单段**页码，于是 `第47—56、97—108页`、
 *      `第304、332页` 这些**已经给了页码**的著录被报成「未见页码」；
 *   ② 分号并列著录多份文献时（`…2023年版；Charles Tilly, Coercion…`），
 *      `(年版|年|出版社)[，,]?\s*$` 形态在**分号处**误命中 ——
 *      它只看「这段是否以年份结尾」，而整条脚注是以第二本书结尾的。
 * 修好后误报降到 2 条（0.4%）。这里把关键行为钉死。
 */
{
  const T = [
    ['单页', '邢义田：《治国安邦》，中华书局，2011年版，第304页。', true],
    ['单区间', '第47—56页', true],
    ['多段区间', '《毛泽东选集》第一卷，人民出版社1991年版，第47—56、97—108页。', true],
    ['顿号多单页', '邢义田：《治国安邦：法制、行政与军事》，北京：中华书局，2011年版，第304、332页。', true],
    ['三段', '第47—56、97—108、200页', true],
    ['西文 pp.', 'Charles Tilly, Coercion, Capital, pp. 47-56', true],
    ['只有章节', '孟捷：《作为方法的中国特色社会主义政治经济学》，复旦大学出版社2023年，第十章。', false],
    ['书名里的年份区间不是页码', '高柏：《经济意识形态与日本产业政策 : 1931-1965年的发展主义》，上海人民出版社 2008年。', false],
  ];
  for (const [name, text, want] of T) {
    const got = hasPage(text);
    ok(got === want, `引文页码 · ${name}（期望 ${want}，实得 ${got}）`);
  }
  // 并列著录：分号两侧各是一条文献 → 不该按「缺页码」报
  ok(isMultiWorkNote('参见[德]桑巴特：《战争与资本主义》，上海人民出版社2023年版；Charles Tilly, Coercion, Capital, and European States') === true,
    '引文页码 · 分号并列中西文两条文献判为多文献脚注');
  ok(isMultiWorkNote('参见孟捷：《作为方法的中国特色社会主义政治经济学》，复旦大学出版社2023年。') === false,
    '引文页码 · 单条文献不会被误判为多文献脚注');
}

/* ---- CIT-008 页码区间：年份区间 ≠ 页码区间（目标点 7/9）---- */
/**
 * 这组是**过度严格回归护栏**，守的是本轮修掉的一个 42.7% 误报。
 *
 * 背景：CIT-008 判「页码区间要用一字线『—』」，但它的判据是
 * `/第 N - N 页/` **或** `/[0-9]{4}[-~～][0-9]{4}/`。后一个「裸四位年份区间」
 * 分支把三类**完全正常**的写法判成违规：
 *   · 英文文献的年份区间（西文按自身惯例用连字符）
 *   · 中文书名内部的年份，如《毛泽东年谱（1949-1976）》
 *   · 网址里的日期路径，如 chinawriter.com.cn/n1/2022/0927/…
 * 全语料 1230 命中里 525 条（42.7%）是这三类。
 * 模型复核对网址类的异议率是 3/3 ——「网址无页码区间，规则不适用」。
 *
 * 修法：只判**中文语境下的页码区间**（有汉字 + 非网址 + 有「页」）。
 * 幸存 705 条抽样全部属实（「第84-85页」这类）。
 */
{
  const { scanCitation: sc } = await import('../src/scanner-citation.js');
  const mkNote = (text) => ({
    paragraphs: [{ index: 0, text: '正文。', properties: {}, format: {} }],
    footnotes: [{ index: 0, text, isNoteSeparator: false }],
    // 扫描器结尾会读 `doc.footnoteRefs.length` 统计正文标记数，缺了会抛
    // 「Cannot read properties of undefined」—— mock 必须补齐这个字段。
    footnoteRefs: [{ id: 1, index: 0 }],
    endnotes: [], comments: [], tables: [], revisions: [], core: {}, label: 'x.docx',
  });
  const citHits = (text) => {
    try { return sc(mkNote(text)).issues.filter((i) => i.ruleId === 'CIT-008').length; }
    catch { return -1; }
  };

  // 应当命中：中文页码区间用了短横线/波浪线
  ok(citHits('布哈林：《布哈林文选》中册，人民出版社1983年，第84-85页。') > 0,
    'CIT-008 · 中文页码区间用短横线应命中');
  ok(citHits('《毛泽东选集》第一卷，第325～326页。') > 0,
    'CIT-008 · 中文页码区间用波浪线应命中');
  // 不应命中：一字线本来就是对的
  ok(citHits('陈夏生、李朝明：《产业集群企业间知识共享研究》，《技术经济与管理研究》2009年第1期，第51—53页。') === 0,
    'CIT-008 · 已用一字线的页码区间不报');
  // 不应命中：三类误报（这是本次修复的核心）
  ok(citHits('Jeffrey S. Passel and D’Vera Cohn, “U.S. Population Projections: 2005-2050” (2008), Pew Research Center.') === 0,
    'CIT-008 · 英文文献年份区间不报（西文用连字符是惯例）');
  ok(citHits('《毛泽东年谱（1949-1976）》第三卷，中央文献出版社2013年，第345页。') === 0,
    'CIT-008 · 中文书名内部的年份区间不报');
  ok(citHits('《钢的城》：讲述钢铁企业淬炼新生的中国故事（2022年9月27日），中国作家网，http://www.chinawriter.com.cn/n1/2022/0927/c404027-32535310.html。') === 0,
    'CIT-008 · 网址日期路径不报（模型复核对这类异议率 3/3）');
  ok(citHits('高柏：《经济意识形态与日本产业政策 : 1931-1965年的发展主义》，安佳译，上海人民出版社2008年。') === 0,
    'CIT-008 · 书名副题里的年份区间不报');
}

/* ---- LANG-010 翻译腔判据：不能把正常汉语当欧化（目标点 9）---- */
/**
 * 这组是**过度严格回归护栏**。
 *
 * 背景：LANG-010 标题写的是「欧化长句与翻译腔：句子过长、层层套叠」，
 * 但它原本的 5 条 regex 里有两条打的是**正常汉语**：
 *   · `[^，。；]{2,20}的存在(性|是)` —— 语料里 30 处命中，26 处是
 *     「中国的存在是与所在区域的左翼还是右翼结合？」这类正常主谓句
 *     （「是」就是系动词），只有 4 处是真的「存在性」名词化；
 *   · `进行[^，。；]{2,10}的(研究|分析|探讨…)` —— 64 处命中里绝大多数是
 *     「进行更为深入的研究」「进行了精彩的分析」，都是地道汉语，不是翻译腔。
 * 两条合计贡献了这条规则 238 条「中」严重度命中中的 186 条（78%）。
 * 删掉后降到 52 条，且**剩余全部是真的翻译腔**。
 *
 * 下面把「该抓的」和「不该抓的」两边都钉死 —— 只钉一边容易修过头。
 */
{
  const r = loadLanguageRules().rules.find((x) => x.id === 'LANG-010');
  const pats = (r?.detect?.patterns || []).map((p) => new RegExp(p));
  const anyHit = (s) => pats.some((re) => re.test(s));

  // 该抓的真翻译腔
  const SHOULD = [
    ['存在性名词化', '旨在填补自身的存在性匮乏'],
    ['被…所…冗余', '重建的“赢”叙事需要被社会所普遍接受'],
    ['作为…的…来说（套叠）', '作为国家财政制度的重要组成部分来说，这项改革意义重大'],
  ];
  for (const [name, s] of SHOULD) {
    ok(anyHit(s), `翻译腔 · 应命中「${name}」`);
  }
  // 不该抓的正常汉语
  const SHOULD_NOT = [
    ['系动词「是」', '中国的存在是与所在区域的左翼还是右翼结合？'],
    ['进行…研究（地道汉语）', '为此，我们需要对本文已经涉及的三个维度的问题进行更为深入的研究。'],
    ['进行…分析（地道汉语）', '阿尔都塞对法国共产党人知识分子为什么会陷入那种状况进行了精彩的分析。'],
  ];
  for (const [name, s] of SHOULD_NOT) {
    ok(!anyHit(s), `翻译腔 · 不应命中正常汉语「${name}」`);
  }
}

/* ---- LANG-010 严重度分档：分档点必须与语料标定一致（目标点 9）---- */
/**
 * 这组守的是「分档点不能被随手改掉」。
 *
 * 分档点来自 `tools/long-sentence-calibration.mjs` 从 27 190 条修订对里
 * 挑出的**编辑真的把长句拆开**的修订（第 31 轮：分句改用 semicolon:false 后
 * 从 391 处增到 516 处）：被拆句子长度 min=151 P25=163 P50=186 P75=211。
 * 于是 186（P50）与 211（P75）成为低/中/高的分界。
 * 一旦有人改了这三个数却忘了重跑标定，这里会红。
 */
{
  const doc = {
    paragraphs: [
      // 151—185 → 低（注意 splitSentences 把句末「。」算进长度，故 160 字 → 161）
      { index: 0, text: '甲'.repeat(160) + '。', properties: {}, format: {} },
      // 186—210 → 中
      { index: 1, text: '乙'.repeat(190) + '。', properties: {}, format: {} },
      // ≥211 → 高
      { index: 2, text: '丙'.repeat(260) + '。', properties: {}, format: {} },
      /**
       * 触发门槛是 **≥6 句 >150 字**（见 src/scanner-language.js 的 EXCESS_MIN；
       * 第 31 轮由 3 提到 6）。这里补足到 6 句，让这组探针只测「分档点」、
       * 不受门槛边界影响 —— 否则只能靠 260 字的极端句触发，测不到低/中分档。
       */
      { index: 3, text: '丁'.repeat(155) + '。', properties: {}, format: {} },
      { index: 4, text: '戊'.repeat(170) + '。', properties: {}, format: {} },
      { index: 5, text: '己'.repeat(165) + '。', properties: {}, format: {} },
    ],
    footnotes: [], endnotes: [], comments: [], tables: [], revisions: [],
  };
  const hits = scanLanguage(doc).issues.filter((i) => i.ruleId === 'LANG-010');
  const byLen = new Map(hits.map((i) => [Number(/句子长度 (\d+) 字/.exec(i.message)?.[1]), i.severity]));
  ok(byLen.get(161) === '低', `长句分档 · 161 字判「低」（实得 ${byLen.get(161)}）`);
  ok(byLen.get(191) === '中', `长句分档 · 191 字判「中」（实得 ${byLen.get(191)}）`);
  ok(byLen.get(261) === '高', `长句分档 · 261 字判「高」（实得 ${byLen.get(261)}）`);
  // 阈值以下不该报
  const short = {
    paragraphs: [{ index: 0, text: '丁'.repeat(140) + '。', properties: {}, format: {} }],
    footnotes: [], endnotes: [], comments: [], tables: [], revisions: [],
  };
  ok(scanLanguage(short).issues.filter((i) => i.ruleId === 'LANG-010').length === 0,
    '长句分档 · 140 字（低于阈值）不报');
  // 分档边界必须与语料标定一致（186 = 编辑拆句中位数，211 = P75）
  /**
   * 注意：LANG-010 有「≥6 句 >150 字」的触发门槛（第 31 轮由 3 提到 6），
   * 单句不再报出。故探针必须**同时给出 6 句 >150 字**（其中一句是待测长度），
   * 否则拿不到 severity、边界检查会因 undefined 而假红。
   */
  const bound = (n) => scanLanguage({
    paragraphs: [
      { index: 0, text: '戊'.repeat(n - 1) + '。', properties: {}, format: {} },
      { index: 1, text: '己'.repeat(160) + '。', properties: {}, format: {} },
      { index: 2, text: '庚'.repeat(160) + '。', properties: {}, format: {} },
      { index: 3, text: '辛'.repeat(160) + '。', properties: {}, format: {} },
      { index: 4, text: '壬'.repeat(160) + '。', properties: {}, format: {} },
      { index: 5, text: '癸'.repeat(160) + '。', properties: {}, format: {} },
    ],
    footnotes: [], endnotes: [], comments: [], tables: [], revisions: [],
  }).issues.filter((i) => i.ruleId === 'LANG-010')
    .map((i) => [Number(/句子长度 (\d+) 字/.exec(i.message)?.[1]), i.severity])
    .find(([len]) => len === n)?.[1];
  ok(bound(185) === '低' && bound(186) === '中', `长句分档 · 低/中 边界恰在 186（185→${bound(185)}，186→${bound(186)}）`);
  ok(bound(210) === '中' && bound(211) === '高', `长句分档 · 中/高 边界恰在 211（210→${bound(210)}，211→${bound(211)}）`);

  /**
   * 触发门槛本身也要钉住。
   *
   * 原实现「有 1 句 >150 字就报」，实测在已过审（发排版）稿件上命中 **85.7%**、
   * 在审 73.6% —— 已刊发定稿反而被判更多，方向反了。
   * 第 31 轮分句改用 semicolon:false 后，用 tools/_gate-calib.mjs 扫描门槛组合，
   * 取「≥6 句 >150 字」使 Δ痕迹（+13.8）与 Δ分层（+6.8）都为正。
   */
  const nLong = (k, len = 160) => scanLanguage({
    paragraphs: Array.from({ length: k }, (_, i) => ({
      index: i, text: '辛'.repeat(len - 1) + '。', properties: {}, format: {},
    })),
    footnotes: [], endnotes: [], comments: [], tables: [], revisions: [],
  }).issues.filter((i) => i.ruleId === 'LANG-010').length;
  ok(nLong(5) === 0, `长句门槛 · 仅 5 句 >150 字不报（实得 ${nLong(5)}）`);
  ok(nLong(6) > 0, `长句门槛 · 6 句 >150 字报出（实得 ${nLong(6)}）`);
  ok(nLong(1, 260) > 0, '长句门槛 · 单句 >250 字仍报出（极端长句直接触发）');
}

/* ---- 休眠规则：判据必须有效，且状态不能被覆盖（目标点 12）---- */
/**
 * 这组守两件事：
 *
 * ① **判据有效**。`FMTB-018`（图表不得用颜色区分）与 `FMTB-021`（【调研】
 *    栏目不设摘要关键词）在 632 份语料上**一次都没触发过**。查清了原因：
 *    · `FMTB-018`：实测语料 `word/media/` 图片数为 **0**，632 篇全部没有
 *      嵌入图表，规则要检查的对象不存在；
 *    · `FMTB-021`：语料里**没有【调研】栏目稿件**（路径与正文均无标记）。
 *    两条规则都不是坏掉的，只是没有触发条件 —— 用合成探针钉住判据。
 *
 * ② **状态不被覆盖**。`server.mjs` 的 `withStatus()` 原先无条件重算
 *    `status`/`statusNote`，把规则库里写好的 `status: 'auto-未触发'` +
 *    原因说明整个盖掉，页面于是声称「规则引擎自动检测」——
 *    而它全语料一次都没跑出过结果。正是 withStatus 当初要修的那类「页面说谎」。
 */
{
  const mk = (paras, label) => ({
    paragraphs: paras.map((t, i) => ({ index: i, text: t, properties: {}, format: {} })),
    footnotes: [], endnotes: [], comments: [], tables: [], revisions: [],
    core: {}, label,
  });
  const hit = (doc, id) => scanFormat(doc).issues.filter((i) => i.ruleId === id).length;

  ok(hit(mk(['图1 各地区GDP变化，红色代表东部，蓝色代表西部。']), 'FMTB-018') > 0,
    '休眠规则 · FMTB-018 图注含颜色词时能命中（判据有效）');
  ok(hit(mk(['【调研】基层治理调查', '[内容提要] 提要内容。', '[关键词] 甲；乙'], 'x\\调研\\p.docx'), 'FMTB-021') > 0,
    '休眠规则 · FMTB-021 调研栏目带摘要关键词时能命中（判据有效）');

  // 规则库里两条必须带 status 与原因说明
  const fmt = loadFormatRules().rules;
  for (const id of ['FMTB-018', 'FMTB-021']) {
    const r = fmt.find((x) => x.id === id);
    ok(r?.status === 'auto-未触发', `休眠规则 · ${id} 标注 status=auto-未触发`);
    ok(typeof r?.statusNote === 'string' && r.statusNote.length > 20, `休眠规则 · ${id} 带原因说明`);
  }
}

/* ---- 截断 JSON 抢救：残缺结果不能伪装成成功（目标点 13）---- */
/**
 * 这组守的是本轮发现的一个**隐蔽故障**：模型复核跑了，但大部分条目其实没复核到。
 *
 * 故障链条：
 *   ① 推理模型在复核任务上会随机把 1.2 万—1.5 万 token 花在推理链上，
 *      正文 JSON 被**两头截断**（既丢开头的 `{"results": [`，又断在元素中间）；
 *   ② `parseJsonLoose` 有「补回被截掉的开头」兜底，但那个兜底只处理
 *      「只截头」的情况，头尾都截时返回 null；
 *   ③ 于是整批条目被判为「模型未返回该条结论」→ 记 `unsure`；
 *   ④ 而 `unsure` 在报告和页面上看起来是「模型判断过但拿不准」——
 *      用户**无法分辨它其实根本没被复核**。
 *
 * 实测同一份 19 条问题的稿子、同一份代码，三次跑出 58% / 42% / 100% 的回收率；
 * 单条单独问也只有 47%。修法有两层：
 *   · `extractCompleteObjects()`：头尾都截时，逐个抠出**已完整输出**的元素；
 *   · `recheckBatch()` 的 compact 重试：漏回的条目用极简提示词再问一次。
 * 修完三份稿件合计回收 **32/32 = 100%**。
 */
{
  const { parseJsonLoose, extractCompleteObjects } = await import('../src/ark.js');

  // 头尾都被截的真实形态：开头丢了 `{"results": [`，结尾断在最后一个元素中间
  // 注意：样本里**只有前 2 个元素是完整的**，第 3 个在字符串中间断掉。
  // 所以正确结果就是 2 —— 一开始我把期望写成 3，是我想错了，不是代码错了。
  const bothTruncated = `results": [
    {"i": 0, "verdict": "agree", "reason": "理由零"},
    {"i": 1, "verdict": "disagree", "reason": "理由一"},
    {"i": 2, "verdict": "unsure", "reason": "这一条还没写完就被截断`;
  const r1 = parseJsonLoose(bothTruncated);
  ok(Array.isArray(r1?.results) && r1.results.length === 2,
    `截断JSON · 头尾都截时抠出 2 条完整元素（实得 ${r1?.results?.length ?? 'null'}）`);
  ok(r1?.results?.[1]?.i === 1 && r1?.results?.[1]?.verdict === 'disagree',
    '截断JSON · 完整元素内容正确');

  // 未写完的元素必须被丢弃，不能猜内容
  ok(!JSON.stringify(r1).includes('还没写完'), '截断JSON · 未写完的元素被丢弃而不是猜测');

  // 正常 JSON 不受影响（兜底不能破坏正常路径）
  const r2 = parseJsonLoose('{"results":[{"i":0,"verdict":"agree"}]}');
  ok(r2?.results?.length === 1, '截断JSON · 正常 JSON 仍正常解析');
  // 纯数组片段
  const r3 = parseJsonLoose('[{"i":0},{"i":1}]');
  ok(Array.isArray(r3) && r3.length === 2, '截断JSON · 纯数组仍正常解析');
  // 元素内含转义引号时配平不能算错
  const r4 = extractCompleteObjects('[{"reason":"他说\\"好\\""},{"reason":"第二个"}]');
  ok(r4.length === 2 && r4[0].reason === '他说"好"', '截断JSON · 元素内转义引号不影响配平');
  // 嵌套对象
  const r5 = extractCompleteObjects('[{"a":{"b":1}},{"c":2}]');
  ok(r5.length === 2 && r5[0].a.b === 1, '截断JSON · 嵌套对象能正确配平');
}

/* ---- 模型越界引用规则号（目标点 12/13）---- */
/**
 * 这组守的是本轮在模型规则覆盖率抽样里发现的一个**页面说谎**。
 *
 * `buildModelIssue()` 原先只校验 ruleId 的**格式**（`/^[A-Z]+B?-\d{3}$/`），
 * 不校验**归属**。于是模型可以「越界引用」：实测 8 篇分层样本里有 3 篇报出了
 * `LANG-017`（量词与名词搭配不当）、`LANG-018`（文言与白话混杂）、`LANG-015`、
 * `FMT-024` —— 这些在规则库里**都真实存在**，但 `status` 是 `auto`（规则引擎检测），
 * **根本不在**交给模型的那 20 条提示词式规则里。
 * （`LANG-020` 原先也是这类例子；第 31 轮它已按语料标定改判为 `model`，
 *  不再属于「越界」。）
 *
 * 后果：规则管理页按规则号归并，于是这些 `auto` 规则会显示
 * 「模型判断命中 N 条」，而规则引擎本身一次都没报过 ——
 * 页面把「模型凭印象引用的规则」当成了「这条规则真的命中了」。
 * 这与「元信息漂移」「状态被覆盖」是同一类病：**页面显示的能力必须等于实际能力**。
 *
 * 修法：越界引用按「模型没填规则号」处理（走 `ARK-分类名`），
 * 并汇总到 `outOfScopeRuleIds` 让它可观测。
 */
{
  const { resolveModelRuleId } = await import('../src/ark.js');
  const allowed = new Set(['LANG-002', 'LANG-011', 'FMTB-001', 'FMT-011']);

  // 在集合内 → 采纳
  const a = resolveModelRuleId('LANG-002', allowed);
  ok(a.id === 'LANG-002' && !a.outOfScope, '越界引用 · 集合内的规则号被采纳');
  // 格式合法但不在集合内 → 拦下并标记
  const b = resolveModelRuleId('LANG-017', allowed);
  ok(b.id === null && b.outOfScope === true, '越界引用 · 格式合法但不在集合内 → 拦下并标记 outOfScope');
  // 格式不合法 → 按没填处理，不算越界
  const c = resolveModelRuleId('随便写的分类', allowed);
  ok(c.id === null && c.outOfScope === false, '越界引用 · 格式不合法按「没填规则号」处理');
  const d = resolveModelRuleId('', allowed);
  ok(d.id === null && d.outOfScope === false, '越界引用 · 空规则号按「没填」处理');
  const e = resolveModelRuleId(undefined, allowed);
  ok(e.id === null && e.outOfScope === false, '越界引用 · 缺失规则号按「没填」处理');
  // 没传集合时不做归属校验（保持向后兼容）
  const f = resolveModelRuleId('LANG-017', null);
  ok(f.id === 'LANG-017' && !f.outOfScope, '越界引用 · 未传集合时不校验归属（向后兼容）');
  // 真实案例：这些都是 auto 规则，必须被拦（LANG-020 第 31 轮已改判为 model，不再属此列）
  for (const id of ['LANG-017', 'LANG-018', 'LANG-015', 'FMT-024']) {
    const r = resolveModelRuleId(id, allowed);
    ok(r.id === null && r.outOfScope === true, `越界引用 · 实测越界号 ${id} 被拦下`);
  }
}

/* ---- 流程性规则不该算作「模型规则」（目标点 6/11/12）---- */
/**
 * 这组守的是「模型规则覆盖率」这个**指标的定义**。
 *
 * 背景：8 篇分层模型抽样跑完，20 条模型规则命中过 18 条，零命中的正好是
 * `FMTB-030` 与 `FMTB-038`。查清了原因，两条都不是「模型跑得不够」：
 *   · `FMTB-030`「正文引用的数据必须能从所引图表中读出来」——
 *     语料 `word/media/` 图片数为 **0**（632 篇全部没有嵌入图表），
 *     规则要检查的对象不存在；图表单元格文本在 docx 里也不是可检索文本。
 *   · `FMTB-038`「英文摘要待校阅清样阶段按清样中文摘要撰写」——
 *     这是**流程性提示**，不是稿件的文本缺陷：初审阶段本就不该改动英文摘要，
 *     因此不存在可判的违规文本特征。
 *
 * 把这两类事项混进「模型规则」，会让覆盖率**天然达不到 100%** ——
 * 是指标定义问题。所以改判为 `manual`（人工复核要点），
 * 并保留 `reclassifiedFrom: 'model'` + 理由，让页面能说清**为什么**改判。
 */
{
  const fmt = loadFormatRules().rules;
  for (const id of ['FMTB-030', 'FMTB-038']) {
    const r = fmt.find((x) => x.id === id);
    ok(r?.detect?.type === 'manual', `流程性规则 · ${id} 已改判为 manual`);
    ok(r?.detect?.reclassifiedFrom === 'model',
      `流程性规则 · ${id} 保留 reclassifiedFrom=model（改判可追溯）`);
    ok(typeof r?.detect?.reclassifiedWhy === 'string' && r.detect.reclassifiedWhy.length > 30,
      `流程性规则 · ${id} 带改判理由`);
    // 理由必须说清是「没有检查对象」或「流程性」，不能是空话
    ok(/流程性|图片数|不存在|清样/.test(String(r?.detect?.reclassifiedWhy || '')),
      `流程性规则 · ${id} 改判理由说明了具体原因`);
  }
  /**
   * 状态说明会直接渲染到页面，不能残留 markdown 强调标记。
   *
   * 判据必须贴合 **markdown 强调的真实语法**，不能只查「出现过 `**`」。
   * 踩过的坑：语料里的编辑批注本身就用 `***` 当占位符，例如
   * CIT-005 的 evidence[0].comment：
   *   「***（作者名、博主名、机构名等著作权所有者名称），“*******”（文章名、帖名）…
   *     最后访问日期：****年*月*日」
   * 那是**编辑要作者填写的空位**。用朴素的 `\*\*[^*]+\*\*` 去测，
   * 会跨过这些空位把两个无关的 `**` 配成一对，误报成「markdown 残留」，
   * 逼人去改一条真实批注。
   *
   * markdown 的强调定界符**内侧不能是空白**（`**文字**` 成立，
   * `** 文字 **` 不成立），且定界符不能是 `***`。据此写判据：
   * 开定界符后紧跟非空白非星号，闭定界符前是非空白。
   * 反引号同理（行内代码不能以空白起止）。
   */
  const mdEmphasis = (s) =>
    /(^|[^*\s])\*\*(?![*\s])[^*\n]*(?<![\s*])\*\*([^*\s]|$)/.test(s)
    || /`(?![`\s])[^`\n]*(?<![\s`])`/.test(s);
  let mdBad = 0;
  for (const r of fmt) {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'string' && mdEmphasis(v)) mdBad += 1;
    }
    for (const [k, v] of Object.entries(r.detect || {})) {
      if (typeof v === 'string' && mdEmphasis(v)) mdBad += 1;
    }
  }
  ok(mdBad === 0, `规则库 · 无 markdown 成对强调残留（页面纯文本渲染），实得 ${mdBad}`);

  // 三个规则库统一检查全部字段（引文库的 evidence 含编辑原始批注，用同一判据）
  {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT2 = join(dirname(fileURLToPath(import.meta.url)), '..');
    const bad = [];
    for (const f of ['format-rules.json', 'language-rules.json', 'citation-rules.json']) {
      const rules = JSON.parse(readFileSync(join(ROOT2, 'rules', f), 'utf8')).rules;
      for (const r of rules) {
        const walk = (o, path) => {
          if (typeof o === 'string') { if (mdEmphasis(o)) bad.push(`${r.id}.${path}`); return; }
          if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
          if (o && typeof o === 'object') { for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k); }
        };
        walk(r, '');
      }
    }
    ok(bad.length === 0,
      `三个规则库 · 全部字段无 markdown 成对强调残留，实得 ${bad.length}${bad.length ? `：${bad.slice(0, 3).join('、')}` : ''}`);
  }
}

/* ---- CIT-031 图表资料来源只给网站名（目标点 7/11）---- */
/**
 * 这组守的是「规则声明必须与实现一致」，以及**判据必须按实测标定**。
 *
 * 背景：`CIT-017` 原先的 title 写「中文著作名未用书名号」，而 rule/patterns
 * 写的却是「图表资料来源须完整可溯」—— 声明与实现完全不是同一条规则。
 * 第 15 轮按代码实际行为重写了 CIT-017，另立 CIT-031 并真正实现图表来源检查。
 *
 * 判据标定过程（为什么不是「须含机构名+文件名+网址+日期」）：
 * 语料 632 篇共 186 条来源段，其中**只有 16.1% 含网址、12.9% 含日期**。
 * 照原判据实现会命中 84% 的来源段，而绝大多数是**合规**写法
 * （「根据中国汽车行业协会官方数据整理」「笔者根据国家统计局发布的
 * 多种统计资料估算所得」）—— 典型的「把正确写法也报出来」。
 * 真正能干净分开的违规形态是**只给一个网站或数据库名称**：命中 10 条 / 5.4%，
 * 逐条核对全部属实。
 */
{
  const cit = loadCitationRules().rules;
  const r31 = cit.find((x) => x.id === 'CIT-031');
  ok(Boolean(r31), 'CIT-031 · 规则库已登记');
  ok(r31?.detect?.type === 'regex', 'CIT-031 · 声明为格式式（regex）');

  // 判据行为：只给网站/数据库名 → 违规
  const SRC_LABEL = /^[（(]?\s*(数据来源|资料来源|来源)\s*[：:]\s*/;
  const GENERIC_ONLY = /^(谷歌学术(搜索)?|中国知网|知网|万方|维普|维基百科|百度百科|百度|必应|搜狗|雅虎|Google(\s*Scholar)?|CNKI|Wikipedia|Web\s*of\s*Science|Scopus|JSTOR|网络|互联网|相关资料|公开资料|官方网站)\s*[。.．]?$/;
  const isViolation = (t) => {
    const m = String(t).match(SRC_LABEL);
    if (!m) return false;
    return GENERIC_ONLY.test(String(t).slice(m[0].length).trim());
  };
  for (const t of ['资料来源：谷歌学术搜索。', '资料来源：中国知网。', '数据来源：知网', '资料来源：CNKI', '资料来源：网络']) {
    ok(isViolation(t), `CIT-031 · 只给网站/数据库名判为违规：${t.slice(0, 18)}`);
  }
  // 合规写法必须**不**报 —— 这几条正是原判据会误报的
  for (const t of [
    '数据来源：同图6.',
    '数据来源：根据中国汽车行业协会官方数据整理。',
    '数据来源：笔者根据国家统计局发布的多种统计资料估算所得。',
    '资料来源：笔者自制，Federal Reserve Economic Data, https://fred.stlouisfed.org',
    '数据来源：中国知网《经济研究》2020年第3期。',
    '资料来源：谷歌学术搜索“industrial policy”检索结果。',
  ]) {
    ok(!isViolation(t), `CIT-031 · 合规写法不报：${t.slice(0, 22)}`);
  }

  // CIT-017 的声明漂移已修：title 必须描述书名号，不能再写「图表资料来源」
  const r17 = cit.find((x) => x.id === 'CIT-017');
  ok(/书名号/.test(String(r17?.title || '')), 'CIT-017 · title 描述的是书名号（声明漂移已修）');
  ok(!/资料来源|数据来源/.test(String(r17?.rule || '')),
    'CIT-017 · rule 不再描述「图表资料来源」（已移交 CIT-031）');
}

/* ---- CIT-003 经典著作须标版本（目标点 7）---- */
/**
 * 这组守的是一条**规则文本要求了、实现却没做**的漏报，以及它顺带暴露的误报。
 *
 * 漏报：CIT-003 的规则文本写着「须同时标明**卷次、版本**与页码」，
 * 但旧 test 只查「卷次 + 页码」，**完全不看版本**。
 * 后果不是小漏报：632 篇里 1033 条经典著作脚注、其中 844 条「卷+页」齐全，
 * 而这 844 条里 **215 条缺版本**，旧 test 因为不看版本，全部判为合规、一条没报。
 * 旁证：模型在缺口分析里对同一篇稿件报出 15 条「经典著作缺版本」。
 *
 * 误报（修漏报时暴露出来的）：旧页码判据 `/第\s*[0-9]+\s*页/` 有两个漏洞 ——
 *   ① 匹配不了**页码区间**（「第101-106页」「第113—114页」全不匹配），
 *      而区间恰恰是本刊规范要求的写法（CIT-001 明确要求用一字线）——
 *      等于「照着规范写反而被报错」；
 *   ② 强制要求「第」字，而「，664页」是常见著录写法。
 * 另外「第4册」不算「第4卷」，用册不用卷的著录会被误判缺卷次。
 */
{
  const { scanCitation } = await import('../src/scanner-citation.js');
  const mkNote = (text) => ({ index: 0, text, isNoteSeparator: false });
  const runNotes = (texts) => scanCitation({
    paragraphs: [], footnotes: texts.map(mkNote), endnotes: [], footnoteRefs: [{ id: 1, index: 0 }],
  }).issues.filter((x) => x.ruleId === 'CIT-003');
  const hitCount = (texts) => runNotes(texts).reduce((s, x) => s + (x.occurrenceCount || 1), 0);

  // ① 缺版本必须报（这正是旧实现全漏的一类）
  ok(hitCount(['《毛泽东选集》第一卷，第325-326页。']) === 1,
    'CIT-003 · 有卷有页但缺版本 → 报（旧实现漏报）');
  ok(hitCount(['《列宁选集》第二卷，第563页。']) === 1,
    'CIT-003 · 单页且缺版本 → 报');
  // ② 带版本不报
  ok(hitCount(['《毛泽东选集》第一卷，人民出版社1991年版，第47页。']) === 0,
    'CIT-003 · 卷+页+版本齐全 → 不报');
  ok(hitCount(['《列宁全集》第55卷，人民出版社2017年，第183页。']) === 0,
    'CIT-003 · 有出版社+年份（无「版」字）视为已标版本 → 不报');
  // ③ 页码区间不能被当成缺页码（旧实现的误报源）
  for (const p of ['第101-106页', '第113—114页', '第325—326页', '第47—56、97—108页', '第188～190页']) {
    ok(hitCount([`《毛泽东选集》第一卷，人民出版社1991年版，${p}。`]) === 0,
      `CIT-003 · 页码区间「${p}」视为已标页码 → 不报`);
  }
  // ④ 「第4册」等同于卷次
  ok(hitCount(['《中共中央文件选集（一九二八）》第4册，中共中央党校出版社1989年版，第664页。']) === 0,
    'CIT-003 · 「第4册」计作卷次 → 不报');
  // ⑤ 「，664页」不带「第」也算页码
  ok(hitCount(['《中共中央文件选集》第4册，中共中央党校出版社1989年版，664页。']) === 0,
    'CIT-003 · 「664页」不带「第」字也算页码 → 不报');
  // ⑥ 跨脚注：同一著作首次写全版本、其后简写 → 全部不报（正常著录惯例）
  //    实测依据：115 篇含 ≥2 条经典著作脚注的稿件里，39 篇部分带版本，
  //    其中 37 篇的版本是从该著作首次出现就写上的（如「1100111」），
  //    符合「首次写全、其后简写」的惯例。
  ok(hitCount([
    '《毛泽东选集》第一卷，人民出版社1991年版，第47页。',
    '《毛泽东选集》第一卷，第88页。',
  ]) === 0, 'CIT-003 · 同一著作首次已带版本，其后简写不报（首次写全惯例）');
  // ⑦ 首次就缺版本 → 报（此时后面的版本不能倒过来豁免前面）
  ok(hitCount([
    '《毛泽东选集》第一卷，第88页。',
    '《毛泽东选集》第一卷，人民出版社1991年版，第47页。',
  ]) === 1, 'CIT-003 · 首次缺版本 → 报（顺序敏感）');
  // ⑧ 跨著作：A 著作带版本不能让 B 著作的缺失被豁免
  ok(hitCount([
    '《毛泽东选集》第一卷，人民出版社1991年版，第47页。',
    '《邓小平文选》第三卷，第311页。',
  ]) === 1, 'CIT-003 · 版本按**著作**分别判断，A 有版本不豁免 B');
}

/* ---- CIT-017 判据重写（目标点 7/11）---- */
/**
 * 这组守的是一条**探针探错了规则**、以及判据被自己的前置条件挡死的问题。
 *
 * 问题一：判据被 `isNarrativeNote` 全部挡掉。
 * CIT-017 原式前置 `!isNarrativeNote(t)`，而 `isNarrativeNote` 的定义是
 * 「去书名号与括号后中文仍多于 40 字」。真正的目标形态
 * 「毛泽东选集，人民出版社1991年版，第47页。」去掉书名号与括号后正好 40+ 字，
 * 于是**恰好被当成叙述性注释排除** —— 规则在 632 篇语料与合成探针上**均 0 命中**。
 *
 * 问题二：正则被英文著录误匹配。
 * 原式允许段首出现任意非引号字符，于是「关于派生性依赖理论，参见
 * Martha Albertson Fineman, The Autonomy Myth: A Theory of Dependency,」
 * 也能命中 —— 因为「Autonomy」含「论」字，而 `[^“”]{0,12}` 碰不到后面的拉丁字母。
 * 实测这条英文著录被匹配了 10 次，是本规则**唯一**的"命中"。
 *
 * 问题三（最隐蔽）：旧探针 `mkDoc(['表1 各年数据','数据来源：'])` 探的是
 * 「图表资料来源」形态，那属于 CIT-031，**不是** CIT-017。
 * 重写判据后旧探针失败（✗ 未报出），却因 CIT-017 被归入「合法未触发」
 * 而被计入通过 —— **探针失败被静默吞掉**，比没有探针更危险。
 */
{
  const { scanCitation } = await import('../src/scanner-citation.js');
  const run = (footnotes) => scanCitation({
    paragraphs: [], footnotes: footnotes.map((t) => ({ index: 0, text: t, isNoteSeparator: false })),
    endnotes: [], footnoteRefs: [{ id: 1, index: 0 }],
  }).issues.filter((x) => x.ruleId === 'CIT-017').length;

  // 真判据形态必须命中（旧判据在这里是 0，被 isNarrativeNote 挡掉）
  ok(run(['毛泽东选集，人民出版社1991年版，第47页。']) === 1,
    'CIT-017 · 「毛泽东选集，…」缺书名号 → 命中（旧判据被 isNarrativeNote 挡掉）');
  ok(run(['毛泽东文集，第24页。']) === 1, 'CIT-017 · 「毛泽东文集，…」缺书名号 → 命中');
  // 已加书名号的不报
  ok(run(['《毛泽东选集》第一卷，人民出版社1991年版，第47页。']) === 0,
    'CIT-017 · 已加书名号 → 不报');
  // 英文著录不得误匹配（旧判据会因「Autonomy」含「论」而命中）
  ok(run(['关于派生性依赖理论，参见Martha Albertson Fineman, The Autonomy Myth: A Theory of Dependency, 2004。']) === 0,
    'CIT-017 · 英文著录不误匹配（旧判据因「Autonomy」含「论」而命中）');
  // 含网址的不报
  ok(run(['毛泽东选集，见 http://example.com/a.html。']) === 0, 'CIT-017 · 含网址 → 不报');
}

/* ---- 已知死判据不得复活（目标点 7/11/12）---- */
/**
 * 这组守的是**死判据**：声明在规则库里、却永远不会产生任何命中的 pattern。
 *
 * 第 20 轮实测到两个实例：
 *
 *   · FMT-024 的 `[0-9]{1,2}世纪[末初]` —— 代码用
 *     `convertCentury(m[0]) === m[0] → continue` **显式过滤**该形态
 *     （「20世纪初」「19世纪末」本身即规范写法，没有对应的「1990年代」式
 *     改写），该 pattern 命中多少次就被丢弃多少次，是死判据。
 *
 *   · FMT-020 的 `[0-9]+\s*--\s*[0-9]+` —— 豁免逻辑只对四位年份区间
 *     做了正确处理，该 pattern 从不产生有效命中。
 *
 * 死判据的危害不是「多报」，而是**误导**：读规则库的人会以为规则覆盖了
 * 「20世纪初」，实际不会；也会以为覆盖了破折号，实际也不会。
 *
 * ── 为什么这里只做「已知死判据」的定点断言，而不是通用检测 ──
 *
 * 试过写一个通用检测器（从正则**合成**一个必然能匹配它的字符串，再验证
 * 是否命中）。结论是**这条路不可靠**，实测反复误报：
 *   · `[,]` 合成出「a」—— 因为候选字符只在字母/数字里挑，标点被漏掉；
 *   · `[0-9]{4}` 合成出「0」—— 因为量词被跳过而不是按最小次数复制；
 *   · `[\s]*` 合成出「s」—— 因为把 `\s` 的转义字符当字面字符输出；
 *   · `(?=…)` 断言丢弃后，后面的否定类又取到与断言冲突的字符。
 * 一路修到误报从 95 降到 14，仍有 14 条**有效** pattern 被误判。
 * 一个误报率这么高的检测器比没有更糟：它会训练人忽略失败。
 *
 * 所以改为定点断言：把**已确认**的死判据写在这里，若被重新加回就失败。
 * 通用检测留给「语料命中量 + 人工核对」，不做自动合成。
 */
{
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

  /** 已确认的死判据：[规则号, 该 pattern 的特征片段, 为什么是死的] */
  const KNOWN_DEAD = [
    ['FMT-024', '世纪[末初]', '代码 convertCentury(m[0]) === m[0] 显式过滤「20世纪初/19世纪末」，永不产生命中'],
    ['FMT-020', '--', '豁免逻辑只正确处理四位年份区间，两位数字+双连字符从不产生有效命中'],
  ];

  const files = ['format-rules.json', 'language-rules.json', 'citation-rules.json'];
  const revived = [];
  for (const [id, frag] of KNOWN_DEAD) {
    for (const f of files) {
      const rules = JSON.parse(readFileSync(join(ROOT, 'rules', f), 'utf8')).rules;
      const r = rules.find((x) => x.id === id);
      if (!r) continue;
      for (const p of r.detect?.patterns || []) {
        if (p.includes(frag)) revived.push(`${id} 重新加入了死判据「${p}」`);
      }
    }
  }
  ok(revived.length === 0,
    `无死判据复活 · 已确认的 ${KNOWN_DEAD.length} 条死判据未被重新加入${revived.length ? `（${revived.join('；')}）` : ''}`);

  /**
   * 这里**刻意不检查**「声明了 patterns 的规则是否都会执行」。
   *
   * 试过，是假警报：manual / model 类规则的 `detect.patterns` 本来就是
   * 「描述用的例子」与检索线索，扫描器从不读取它们 —— 这不是缺陷，
   * 而是设计。server.mjs 的 withStatus 注释里已明确记载：
   * 「格式体例规则里带 detect.patterns 的很多只是描述用的例子，
   *   扫描器并没有读取它们（例如 FMT-040、FMTB-010、FMTB-012 全文从未命中）」。
   * 把它当成「摆设判据」报警，会让人去删掉这些有用的说明性线索。
   * 「哪些规则真的会跑」由 withStatus + ruleWillRun 负责，不在这里重复判。
   */
}

/* ---- 引文规则库与代码实际行为必须对齐（目标点 7/11/12）---- */
/**
 * 这组守的是一个**页面在说谎**的问题。
 *
 * 引文引擎的判据**只在 `src/scanner-citation.js` 的 CHECKS 数组里执行**，
 * 而规则管理页面显示的标题/规则文本来自 `rules/citation-rules.json`。
 * 两处各写一份、原先**没有任何测试校验**，于是长期错位：
 *
 *   · CIT-003 页面写「党和国家领导人文献未引权威一手来源」，
 *     代码实际判「马克思主义经典著作未标明版本」；
 *   · CIT-004 页面写「外国人名译名不规范」，
 *     代码实际判「党和国家领导人文献未引权威一手来源」；
 *   · CIT-009 页面写「只有标号而无文献信息」（与 CIT-002 重复），
 *     代码实际判「脚注中文部分出现半角标点」；
 *   · CIT-010/013/014/016 同类错位。
 *
 * 后果很具体：审稿人按页面理解规则会**理解错**，而且按页面去核对
 * 某条问题属于哪条规则时会得到错误结论。第 19 轮已把 18 条对齐，
 * 并加这条断言防止再次漂移。
 */
{
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(join(ROOT, 'src', 'scanner-citation.js'), 'utf8');
  const rules = JSON.parse(readFileSync(join(ROOT, 'rules', 'citation-rules.json'), 'utf8')).rules;

  // 抽出 CHECKS 里每条 id 的 rule 文本
  const checkRule = new Map();
  for (const b of src.split(/\n  \{\n/)) {
    const id = (b.match(/^\s*id:\s*'(CIT-\d+)'/) || [])[1];
    if (!id) continue;
    const rule = (b.match(/rule:\s*'((?:[^'\\]|\\.)*)'/) || [])[1];
    if (rule) checkRule.set(id, rule);
  }

  const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[。，、；：]/g, '');
  const drifted = [];
  for (const r of rules) {
    const impl = checkRule.get(r.id);
    if (!impl) continue; // 内联实现的规则另有来源，此处只查 CHECKS 驱动的
    if (norm(r.rule) !== norm(impl)) drifted.push(r.id);
  }
  ok(drifted.length === 0,
    `引文规则 · 规则库 rule 文本与 CHECKS 实现一致（漂移 ${drifted.length} 条${drifted.length ? `：${drifted.join('、')}` : ''}）`);

  /**
   * 标题必须**唯一标识**一条规则。
   *
   * 这里刻意**不做**「标题核心词必须出现在实现判据里」的字面匹配 ——
   * 试过，是坏判据：标题「文献著录缺少具体页码」与实现
   * 「该条脚注为文献著录但未见页码」完全同义，但字面核心词对不上，
   * 会误报 11 条。标题与实现是**语义**对应，不是字符串包含，
   * 无法用启发式可靠判断。
   *
   * 可靠且有意义的不变式是：标题唯一。历史上 CIT-002 与 CIT-009
   * 标题**完全相同**（都写「只有标号而无文献信息，或出处无法辨识」），
   * 而实际是两条不同规则 —— 这正是错位的症状。
   * 真正保证标题与实现一致的机制是上面的 rule 文本比对 + 人工对齐，
   * 本条只兜住「两条规则共用一个标题」这种明显症状。
   */
  const seenTitles = new Map();
  const dupTitles = [];
  for (const r of rules) {
    const t = norm(r.title);
    if (seenTitles.has(t)) dupTitles.push(`${r.id} 与 ${seenTitles.get(t)} 共用标题「${r.title}」`);
    else seenTitles.set(t, r.id);
  }
  ok(dupTitles.length === 0,
    `引文规则 · 标题唯一（重复 ${dupTitles.length} 处${dupTitles.length ? `：${dupTitles.join('；')}` : ''}）`);

  // 不执行的 patterns 不得留在引文规则里冒充判据
  const fakePatterns = rules.filter((r) => checkRule.has(r.id) && (r.detect?.patterns || []).length > 0);
  ok(fakePatterns.length === 0,
    `引文规则 · CHECKS 驱动的规则不留不执行的 patterns（残留 ${fakePatterns.length} 条${fakePatterns.length ? `：${fakePatterns.map((r) => r.id).join('、')}` : ''}）`);
}

/* ---- LANG-003 赘余扩充与「正常汉语结构不得误报」（目标点 9/11）---- */
/**
 * 这组守的核心是**不要给几乎全语料扣分**。
 *
 * 第 18 轮按语料实测给 LANG-003 补了 6 个固定赘余搭配，但**刻意排除**了
 * 两类模型标注为「欧化」、实际是正常汉语的高频结构：
 *
 * ① 「作为……的……」——实测 **4224 次 / 604 篇**（占 632 篇语料的 96%）。
 * ② 「进行……的……」——实测 **1473 次 / 410 篇**。
 *
 * 模型在缺口分析里把「进行一场理论的迂回」「作为西方世界核心的美国」
 * 标为欧化结构。但「进行+定语+名词」和「作为+定语+的+名词」在汉语学术
 * 写作中完全正当 —— 把它们做成规则，等于给几乎所有稿件扣分，
 * 正是「审核尺度不能卡太严」要防的事。这两条断言就是防线。
 *
 * 另「可能将」（62 次）在主语不同指时正当（「批评者可能将…归因于」），
 * 「共有…个」经核对全部是「共有541个公共图书馆」这类正常表述，均不报。
 */
{
  const { scanLanguage } = await import('../src/scanner-language.js');
  const probe = (texts) => {
    const doc = {
      paragraphs: texts.map((t, i) => ({ index: i, text: t, style: '', jc: '', outline: null })),
      footnotes: [], endnotes: [], footnoteRefs: [], comments: [], tables: [],
      label: '01-张三-某研究-专题.docx',
    };
    return (scanLanguage(doc).issues || []).filter((x) => x.ruleId === 'LANG-003').length;
  };
  // 该报的固定赘余搭配
  const shouldHit = [
    ['我的个人看法比较简单。', '我的个人看法'],
    ['我个人认为这条路走不通。', '我个人认为'],
    ['乃至形形色色的各种后马克思主义。', '形形色色的各种'],
    ['今年恰逢中国研究院成立10周年之际。', '恰逢…之际'],
    ['但没有联合国机构总部的存在。', '没有…的存在'],
    ['首先第一步就是控制国家机器。', '首先第一步'],
  ];
  for (const [t, label] of shouldHit) ok(probe([t]) === 1, `LANG-003 · 「${label}」→ 报（赘余）`);

  // 正常汉语结构，刻意不报（这是防线：报出来会给几乎全语料扣分）
  const shouldNotHit = [
    ['作为经济基础的国家，其作用不可忽视。', '作为…的…（4224次/604篇）'],
    ['对公共品本身进行适当的分类是必要的。', '进行…的…（1473次/410篇）'],
    ['批评者可能将成功归因于政治特征。', '可能将（主语不同指时正当）'],
    ['到1962年，全国共有541个公共图书馆。', '共有…个（正常表述）'],
    ['首先，第一，要解决理论问题。', '首先，第一（带逗号的正常列举）'],
    ['本书讨论形形色色的社会现象。', '形形色色（单独使用正常）'],
  ];
  for (const [t, label] of shouldNotHit) ok(probe([t]) === 0, `LANG-003 · ${label} → 刻意不报`);
}

/* ---- LANG-008 口语化判据扩充与「刻意不报」（目标点 9/11）---- */
/**
 * 这组同时守两件事：**该报的要报**，以及**刻意不报的不能报**。
 *
 * 第 17 轮按语料实测给 LANG-008 补了 11 个无歧义口语形态
 * （打个比方、退一万步、话又说回来、话虽如此、说句实话、这么说吧、
 * 不出意外的话、十有八九、说白了、蠢货、蛮好），新增命中 39 次 / 39 篇。
 *
 * 但**刻意排除**了两类歧义形态，理由必须固化成断言，
 * 否则以后有人「顺手补全」就会把尺度做坏：
 *
 * ① 「恐怕」——实测 64 次 / 54 篇，是汉语**书面**推量副词。
 *    学术论证里「恐怕仍不够充分」是正常用法，不是口语化。
 * ② 「简直是」——实测 17 次，其中「简直是座标准的宫殿」是
 *    历史叙述的正当修辞，仅「这简直是一种咄咄怪事」属主观评价，
 *    无法机械区分。
 * ③ 「很大程度上」「一定程度上」——1326 次 / 441 篇，是学术汉语常规表述。
 * ④ 「我认为」「我们发现」——316 次，是学术论著标识论证立场的惯例。
 */
{
  const { scanLanguage } = await import('../src/scanner-language.js');
  const probe = (texts) => {
    const doc = {
      paragraphs: texts.map((t, i) => ({ index: i, text: t, style: '', jc: '', outline: null })),
      footnotes: [], endnotes: [], footnoteRefs: [], comments: [], tables: [],
      label: '01-张三-某研究-专题.docx',
    };
    return (scanLanguage(doc).issues || []).filter((x) => x.ruleId === 'LANG-008').length;
  };
  // 该报的
  const shouldHit = [
    ['退一万步，即便该假设成立。', '退一万步'],
    ['打个比方，一战结束时欧洲各国刚签约。', '打个比方'],
    ['不出意外的话，今年应该能出版。', '不出意外的话'],
    ['十有八九会失败。', '十有八九'],
    ['说白了，这是权力问题。', '说白了'],
    ['他就是个蠢货。', '蠢货'],
    ['第一部分就蛮好提上来。', '蛮好'],
  ];
  for (const [t, label] of shouldHit) ok(probe([t]) === 1, `LANG-008 · 「${label}」→ 报（新增形态）`);
  // 刻意不报的
  const shouldNotHit = [
    ['然而这些假设恐怕仍不够充分。', '恐怕（书面推量副词）'],
    ['简直是座标准的宫殿，使军民大惊失色。', '简直是（历史叙述正当修辞）'],
    ['内生性作用的范围在很大程度上由外生性作用规定。', '很大程度上（学术常规表述）'],
    ['因此，我认为，阿尔都塞的意义不在于此。', '我认为（学术惯例）'],
    ['这个问题非常重要，须优先解决。', '非常重要（书面强调）'],
  ];
  for (const [t, label] of shouldNotHit) ok(probe([t]) === 0, `LANG-008 · ${label} → 刻意不报`);
}

/* ---- 归并条目的 autoFix 必须逐处带偏移（目标点 5/13）---- */
/**
 * 这组守的是一个**静默漏改**：用户勾一条以为全改了，实际只改了第一处。
 *
 * `/api/apply-fixes` 把归并条目（带 `occurrences`）展开成逐处条目，
 * 展开时取 `o.autoFix || raw.autoFix`。也就是说 occurrence 上若没有
 * **自己的** autoFix，就会**回退到父条目的 autoFix** —— 而父条目的
 * offset 是**首处**的偏移。于是第 2 处及以后全部用首处偏移去替换，
 * 落到别的文字上，被静默记为「未产生变化」。
 *
 * 实测确认过：`applied=1 skipped=[{reason:'未产生变化'}]`（应为 2 处）。
 *
 * 这条不变式是**通用**的：任何「既产出 autoFix、又做同类归并」的规则
 * 都必须让每处 occurrence 带上自己的 offset 与 autoFix。
 * FMT-014 是最初唯一做对的一条，其余靠这条断言兜住。
 */
{
  const { loadFormatRules, scanFormat } = await import('../src/scanner-format.js');
  const rules = loadFormatRules().rules;
  /** 造一篇含多处同类问题的稿件，跑扫描器后检查不变式 */
  const mkDoc = (paras) => ({
    paragraphs: paras.map((t, i) => ({ index: i, text: t, style: '', jc: '', outline: null })),
    footnotes: [], endnotes: [], footnoteRefs: [], comments: [], tables: [],
    label: '01-张三-某研究-专题.docx',
  });
  const checkInvariant = (issues, ruleId) => {
    const bad = [];
    for (const it of issues) {
      if (ruleId && it.ruleId !== ruleId) continue;
      if (!it.occurrences || it.occurrences.length < 2) continue;
      if (!it.autoFix) continue; // 不产出 autoFix 的规则不受影响
      for (const o of it.occurrences) {
        if (!o.autoFix) bad.push(`${it.ruleId}: occurrence 缺 autoFix（会回退到首处偏移）`);
      }
      /**
       * 偏移只在**同一段落内**才要求互不相同。
       *
       * 踩过的坑：一开始断言「所有 occurrence 的 offset 互不相同」，
       * 结果 FMTB-041 被判失败 —— 因为它命中「【1014中午】」在段落 2、
       * 「【1022下午】」在段落 3，两处各自都是该段落的第 0 个字符，
       * offset 都是 0。**offset 是段落内偏移，跨段落本来就可以相同**。
       * 真正要防的是「同一段落内多处都拿首处偏移」。
       */
      const byPara = new Map();
      for (const o of it.occurrences) {
        const k = o.paragraphIndex ?? o.footnoteIndex ?? o.endnoteIndex ?? 'doc';
        if (!byPara.has(k)) byPara.set(k, []);
        byPara.get(k).push(o);
      }
      for (const [k, list] of byPara) {
        if (list.length < 2) continue;
        const offs = list.map((o) => o.autoFix?.offset);
        if (new Set(offs).size !== offs.length) {
          bad.push(`${it.ruleId}: 同段落 ${k} 内 ${list.length} 处偏移重复（${offs.join(',')}）`);
        }
      }
    }
    return [...new Set(bad)];
  };

  // 通用不变式：全量规则扫一篇「多处半角标点 + 多处工作标记」的稿件
  const doc = mkDoc([
    '第一段有半角逗号, 还有半角分号;',
    '第二段也有半角逗号, 再来一个半角分号;',
    '【1014中午】',
    '【1022下午】',
  ]);
  const all = scanFormat(doc).issues;
  const violations = checkInvariant(all);
  ok(violations.length === 0,
    `归并 autoFix · 每处 occurrence 都带自己的偏移与 autoFix（实得 ${violations.length} 处违规）`);

  // FMTB-041 必须真的产出 autoFix（否则界面上「可自动改写」是假的）
  const m41 = all.filter((x) => x.ruleId === 'FMTB-041');
  ok(m41.length > 0, 'FMTB-041 · 残留工作标记被检出');
  ok(m41.every((x) => x.autoFix && typeof x.autoFix.find === 'string'),
    'FMTB-041 · 产出 autoFix（不只是声明 autoFixable）');
  ok(m41.some((x) => (x.occurrenceCount || 1) >= 2), 'FMTB-041 · 多处标记归并为一条并带 occurrenceCount');
  const multi41 = m41.find((x) => (x.occurrenceCount || 1) >= 2);
  if (multi41) {
    ok(multi41.occurrences.every((o) => o.autoFix && typeof o.autoFix.find === 'string'),
      'FMTB-041 · 每处 occurrence 都带自己的 autoFix（不只是父条目）');
    ok(multi41.occurrences.every((o) => o.autoFix.find === o.quote),
      'FMTB-041 · occurrence 的 autoFix.find 等于该处 quote（删的是自己那处）');
  }
  // 同段落内多处命中时，偏移必须互不相同（这才是「回退到首处」会漏改的场景）
  const samePara = scanFormat(mkDoc(['本段有【1014中午】和【1022下午】两处标记。'])).issues
    .filter((x) => x.ruleId === 'FMTB-041');
  if (samePara.length) {
    const it = samePara[0];
    const offs = (it.occurrences || []).map((o) => o.autoFix?.offset);
    ok(it.occurrenceCount === 2 && offs.length === 2 && new Set(offs).size === 2,
      `FMTB-041 · 同段落两处偏移互不相同（${offs.join(',')}）`);
  }
  // 合法结构标记不得被判为残留工作标记
  const legit = scanFormat(mkDoc(['【摘要】本文讨论……', '【关键词】甲；乙；丙'])).issues
    .filter((x) => x.ruleId === 'FMTB-041');
  ok(legit.length === 0, 'FMTB-041 · 【摘要】【关键词】等合法结构标记不误报');
  // 单独时段词不误报（「晚」「早」在中文里是正常用字）
  const bare = scanFormat(mkDoc(['【晚】这个字单独出现不算工作标记。'])).issues
    .filter((x) => x.ruleId === 'FMTB-041');
  ok(bare.length === 0, 'FMTB-041 · 无日期的单独时段词不误报');
}

/* ---- 规则账一致性：页面显示的能力必须等于实际能力 ---- */
/**
 * 这组检查是**防漂移护栏**（目标点 11）。
 *
 * 背景：`/api/rules` 的 `modelRules` 原先只从 language-rules.json 里筛，
 * 得到 9 条；而 ark.js 的 `promptStyleRules()`（真正决定注入什么的那段）
 * 会跨三个规则文件收集，实际注入 20 条。于是规则管理页写着
 * 「交模型判断 20 条」，模型却只收到 9 条 —— **页面在说谎**。
 *
 * 这类「显示与实现脱节」的缺陷不会让任何测试变红，只会让对外宣称的能力虚高，
 * 所以在这里钉死三条不变量：
 *   1. promptStyleRules() 的条数 == 三个规则文件里 type==='model' 的条数
 *   2. 每条 model 规则的 id 都能在规则库里找到（不是凭空造的号）
 *   3. 每条规则都有 detect.type（否则三类归档会留空档）
 */
{
  const { promptStyleRules } = await import('../src/ark.js');
  const loaders = [loadFormatRules, loadLanguageRules, loadCitationRules];
  const rules = promptStyleRules();
  const declared = new Set();
  const ids = new Set();
  const unclassified = [];
  for (const loader of loaders) {
    for (const r of loader().rules) {
      ids.add(r.id);
      if (r.detect?.type === 'model') declared.add(r.id);
      if (!r.detect?.type) unclassified.push(r.id);
    }
  }
  ok(rules.length === declared.size,
    `提示词式规则数一致（实际注入 ${rules.length} 条 / 规则库声明 ${declared.size} 条）`);
  const bogus = rules.filter((r) => !ids.has(r.id)).map((r) => r.id);
  ok(bogus.length === 0, `提示词式规则号都真实存在${bogus.length ? `（异常：${bogus.join(',')}）` : ''}`);
  ok(unclassified.length === 0,
    `所有规则都有 detect.type${unclassified.length ? `（缺：${unclassified.slice(0, 8).join(',')}）` : ''}`);
}

/* ---- LANG-007 / LANG-015：判据不成立时删实现、留条目（目标点 7/9/11）---- */
/**
 * 第 28 轮的护栏。两条规则的原判据都**分层方向反了**——已过审（发排版）稿件的
 * 命中率不低于在审稿件，说明它们命中的是正常学术写作而非缺陷。
 *
 * LANG-007（概念混用）：已过审 42.9% vs 在审 26.4%。
 *   词表把**不同概念**当易混词并列，如「民族国家/文明国家/文明型国家」——
 *   一篇研究「文明型国家」的论文必然要拿「民族国家」作对比项。
 *
 * LANG-015（术语不统一）：其「同一外文名对应多种译名」部分因**贪婪捕获**把译名
 *   前面的虚词动词一起吞进来，实测捕获「和以大穆夫提」（应为大穆夫提）、
 *   「为首的欧莱玛」（应为欧莱玛），于是同一译名因前后文不同被算成「多种译名」。
 *
 * 处置：两处实现删除，规则条目保留（LANG-007 改 manual），机构名检查保留。
 * 这组探针钉死三件事：
 *   ① LANG-007 不再自动报出（防止有人把它「修回来」）；
 *   ② LANG-015 的机构名检查仍然有效（删错东西会立刻变红）；
 *   ③ 两条规则的 detect.type 与实现状态一致。
 */
{
  const mkLang = (texts) => ({
    label: 'l.docx',
    paragraphs: [
      { index: 0, text: '标题', properties: {}, format: {} },
      ...texts.map((t, i) => ({ index: i + 1, text: t, properties: {}, format: {} })),
    ],
    footnotes: [], endnotes: [], comments: [], tables: [], revisions: [],
  });
  const langIds = (texts) => (scanLanguage(mkLang(texts)).issues || []).map((x) => x.ruleId);

  // ① LANG-007 必须不再报出 —— 即使词表里的概念全部同时出现
  const allGroups = [
    '全球南方相关论述在此展开，涉及发展中国家与第三世界的历史经验。',
    '民族国家与文明国家、文明型国家的概念辨析是本节重点。',
    '债务与赤字的关系需要厘清，国家治理与治理国家的差别亦须辨明。',
    '人类命运共同体与命运共同体的提法在文中均有出现。',
  ];
  ok(!langIds(allGroups).includes('LANG-007'),
    'LANG-007 · 概念组同时出现不再自动报出（分层方向反了，已改人工复核）');

  // ② LANG-015 机构名检查必须仍然有效
  ok(langIds(['中共中央发布了相关文件。', '党中央高度重视此项工作。']).includes('LANG-015'),
    'LANG-015 · 机构全称与简称同时出现仍报出');
  ok(!langIds(['中共中央发布了相关文件。']).includes('LANG-015'),
    'LANG-015 · 仅用全称时不报出');

  // ③ LANG-015 的坏译名检查必须不再报出（同一译名 + 前后文不同，不得算作多种译名）
  ok(!langIds(['笔者根据美国联邦调查局（FBI）的报告作出判断。', '美国联邦调查局（FBI）随后公布了结论。']).includes('LANG-015'),
    'LANG-015 · 同一译名因前后文不同不再误报「多种译名」');

  // ④ 状态与实现一致：LANG-007 为 manual，LANG-015 仍会执行
  {
    const lr = loadLanguageRules().rules;
    const r7 = lr.find((r) => r.id === 'LANG-007');
    const r15 = lr.find((r) => r.id === 'LANG-015');
    ok(r7?.detect?.type === 'manual', `LANG-007 的 detect.type 为 manual（实得 ${r7?.detect?.type}）`);
    ok(r15?.detect?.type !== 'model' && r15?.detect?.type !== 'manual',
      `LANG-015 仍为自动检测类（实得 ${r15?.detect?.type}）`);
  }
}

/* ---- 现场栏目格式从宽：编辑明说「格式性要求可以稍低一些」（目标点 8/9/10）---- */
/**
 * 第 29 轮的护栏。
 *
 * 编辑批注原文（实测语料 11-朱羽-阿尔都塞的教益）：
 *   「外国人名不加英文备注和given name的译名就全文统一吧，
 *     【现场】栏目的格式性要求可以稍低一些。」
 *
 * 这是**编辑自己说的**。而原实现不知道这件事：实测「现场/圆桌/工作坊/发言」类稿件
 * 71 篇，FMT-001（七要素）**100.0%（71/71）**报「缺内容提要、关键词、作者简介」，
 * FMT-036（作者简介）31.0%。这类稿件是**会议发言记录**，天然没有提要、关键词，
 * 发言人是与会学者，文末也不附作者简介 —— 是体例差异，不是缺漏。
 *
 * 本刊本就有栏目差异机制（FMTB-006 专题 / FMTB-021 调研 / FMTB-022 书评都不设提要关键词），
 * 现场栏目属同一类，此前被漏掉。
 *
 * 判据用**文件名 + 正文体例语言**双轨。收紧后的正文判据在真实论文上**误报 0 篇**
 * ——早期版本用 /工作坊/ 会命中王绍光《我与国家能力研究》这类**正文提到**工作坊的
 * 正常论文，故收窄为「会议记录体例语言」。
 */
{
  const mkLive = (label, texts) => ({
    label,
    paragraphs: [
      { index: 0, text: '阿尔都塞在中国：关于马克思主义研究怎么办的思考', properties: {}, format: {} },
      { index: 1, text: '朱羽', properties: {}, format: {} },
      ...texts.map((t, i) => ({ index: i + 2, text: t, properties: {}, format: {} })),
    ],
    footnotes: [], endnotes: [], comments: [], tables: [], revisions: [],
  });
  const idsOf = (doc) => (scanFormat(doc).issues || []).map((x) => x.ruleId);
  const bodyText = '这是正文内容，讨论阿尔都塞的意识形态理论与再生产概念，涉及多个层面的分析。';

  // ① 文件名含「现场」→ 缺提要/关键词/简介不报 FMT-001 与 FMT-036
  {
    const ids = idsOf(mkLive('11-朱羽-阿尔都塞的教益-现场.docx', [bodyText]));
    ok(!ids.includes('FMT-001'), '现场栏目 · 文件名含「现场」时不报 FMT-001（缺提要关键词简介属体例）');
    ok(!ids.includes('FMT-036'), '现场栏目 · 文件名含「现场」时不报 FMT-036（发言人不附简介）');
  }
  // ② 正文含会议记录体例语言 → 同样豁免
  {
    const ids = idsOf(mkLive('某工作坊记录.docx', ['下面请丁耘老师讲几句。', '谢谢朱羽老师的发言。']));
    ok(!ids.includes('FMT-036'), '现场栏目 · 正文含会议记录体例语言时豁免 FMT-036');
  }
  // ③ 正常论文**不得**被豁免（回归保护）
  {
    const ids = idsOf(mkLive('01-特稿-王绍光-我与国家能力研究.docx',
      ['我在工作坊上曾经提到过这个研究的缘起，后来写成文章。', bodyText]));
    ok(ids.includes('FMT-001'), '现场栏目 · 正文仅**提到**工作坊的正常论文仍报 FMT-001（不得误豁免）');
    ok(ids.includes('FMT-036'), '现场栏目 · 正文仅**提到**工作坊的正常论文仍报 FMT-036');
  }
  // ④ 现场稿件真的缺题目/作者时仍要报（豁免只针对提要/关键词/简介）
  {
    const doc = {
      label: '现场记录.docx',
      paragraphs: [{ index: 0, text: bodyText, properties: {}, format: {} }],
      footnotes: [], endnotes: [], comments: [], tables: [], revisions: [],
    };
    ok(idsOf(doc).includes('FMT-001'), '现场栏目 · 仍检查题目与作者（豁免不含这两项）');
  }
}

/* ---- 首行缩进：两种单位 + 样式继承 + 违规比例门槛（目标点 8/9）---- */
/**
 * 第 30 轮的护栏。FMT-027 原实现有**四层**缺陷，逐层修完才把方向扳正
 * （已过审 78.6% → **0%**，在审 74.6% → 19.7%，命中 472 → 122 篇）：
 *
 * ① **单位混淆**：`w:firstLineChars`（百分之一字符，200=2 字符）与
 *    `w:firstLine`（twip，12pt 下 480=2 字符）被 `||` 混成一个值，
 *    再与 `{200,201,240}` 比较 —— 只写 twips 的合规段落全被判违规。
 *    实测已刊发定稿里 `firstLine="510"`（60 段）、`480`（42 段）、`420`（125 段）都有。
 * ② **漏看样式继承**：段落缩进可继承自 `w:pStyle` 指向的样式。
 *    实测 `style="a6"`（"Normal (Web)"）在 styles.xml 里写着 `firstLineChars="200"`，
 *    该稿件因此被报 37 处。
 * ③ **非正文段落**：编辑操作说明「【文脉：…请删除本句。】」、英文摘要、
 *    关键词行、用多空格排布的名录行被归为 body，它们本来就不缩进。
 * ④ **按「有无违规」判定**（决定性）：缩进是**文档级**属性，真不合规的稿件是
 *    **绝大多数**正文段都不缩进；合规稿件里零星几段不缩进多是引言块、独立引文。
 *    实测违规比例 >10% 时：已过审 **0%**、在审 **22.0%**（完全分离）；
 *    而 >0% 时已过审 57.1% vs 在审 55.9%（反向）。
 */
{
  const mkInd = (paras, styles) => ({
    label: 'ind.docx',
    paragraphs: paras.map((p, i) => ({
      index: i, text: p.text, inTable: false,
      properties: {
        style: p.style || '',
        firstLineChars: p.chars ?? '',
        firstLineTwips: p.twips ?? '',
        indFirstLine: p.chars ?? p.twips ?? '',
        indUnit: p.chars ? 'chars' : (p.twips ? 'twips' : ''),
      },
      format: {},
    })),
    footnotes: [], endnotes: [], comments: [], tables: [], revisions: [],
    styles: { byId: styles || {} },
  });
  const long = (n) => '这是正文段落的内容，用于测试首行缩进判定是否准确，' + '填充文字'.repeat(Math.ceil(n / 4));
  const fires27 = (doc) => (scanFormat(doc).issues || []).some((x) => x.ruleId === 'FMT-027');

  // ① 两种单位都算合规
  const many = (n, mk) => Array.from({ length: n }, (_, i) => mk(i));
  ok(!fires27(mkInd([
    { text: '标题', style: 'Heading' },
    ...many(8, () => ({ text: long(60), chars: '200' })),
  ])), '缩进 · firstLineChars=200 判为合规');
  ok(!fires27(mkInd([
    { text: '标题', style: 'Heading' },
    ...many(8, () => ({ text: long(60), twips: '480' })),
  ])), '缩进 · firstLine=480 twips 判为合规（单位换算，原实现误报）');
  ok(!fires27(mkInd([
    { text: '标题', style: 'Heading' },
    ...many(8, () => ({ text: long(60), twips: '510' })),
  ])), '缩进 · firstLine=510 twips 判为合规（已刊发定稿的常见值）');

  // ② 样式继承
  ok(!fires27(mkInd([
    { text: '标题', style: 'Heading' },
    ...many(8, () => ({ text: long(60), style: 'a6' })),
  ], { a6: { indentFirstLineChars: '200' } })),
  '缩进 · 缩进继承自段落样式时判为合规（原实现误报 37 处）');

  // ③ 真不合规仍要报（多数正文段都不缩进）
  ok(fires27(mkInd([
    { text: '标题', style: 'Heading' },
    ...many(10, () => ({ text: long(60) })),
  ])), '缩进 · 多数正文段未缩进时报 FMT-027');

  // ④ 零星几段不缩进**不得**报（比例门槛）
  ok(!fires27(mkInd([
    { text: '标题', style: 'Heading' },
    ...many(10, () => ({ text: long(60), chars: '200' })),
    { text: long(60) },
  ])), '缩进 · 仅个别段落未缩进时不报（违规比例门槛）');

  // ⑤ 非正文形态不参与判定
  ok(!fires27(mkInd([
    { text: '标题', style: 'Heading' },
    ...many(10, () => ({ text: long(60), chars: '200' })),
    { text: '【文脉：标题上的注释标号请用米字注，谢谢！排版时请删除本句。】' },
  ])), '缩进 · 编辑操作说明「【文脉：…】」不参与缩进判定');
}

/* ---- CIT-012 判据不可判：删实现、留条文（目标点 7/11）---- */
/**
 * 第 31 轮的护栏。
 *
 * CIT-012（西文文献缺 p./pp. 页码）历经多次收窄仍不成立：
 *   · 早期把美联社、《纽约时报》等新闻类著录全报成缺页码（632 篇上 1495 条、重合 0.3%）；
 *   · 第 31 轮又加「按期卷号定位的期刊论文」与「档案/政府公文集」两类例外
 *     （命中 360 → 312）；
 *   · 但剩余 312 处里 119 处（38.1%）是**专著形态** —— 整本专著被引用本来就不标页码；
 *     已过审层命中是整份政府出版物（编辑已排版刊发、未要求补页码），
 *     已过审 35.7% vs 在审 21.7%，**方向反了**；
 *   · 编辑修订证据弱：补 p./pp. 仅 9 处、删 4 处（对比 FMT-024 的 92:3）。
 *
 * 区分「引整本专著」与「引书中某段」需要理解引用意图，规则做不到。
 *
 * 本组钉死三件事：
 *   ① CIT-012 不再报出（含专著、期刊卷期、政府公文集三种形态）；
 *   ② `ruleWillRun` 必须尊重 `detect.type === 'manual'`（第 31 轮踩过坑：
 *      源码注释里残留规则号字面量会让页面继续声称「自动检测」）；
 *   ③ 规则条目本身仍在（不是删规则，是删实现）。
 */
{
  const { ruleWillRun } = await import('../src/implemented-rules.js');
  const { scanCitation } = await import('../src/scanner-citation.js');
  const mkCit = (notes) => ({
    label: 'c.docx',
    paragraphs: [
      { index: 0, text: '标题', properties: {}, format: {} },
      { index: 1, text: '作者', properties: {}, format: {} },
      { index: 2, text: '正文内容，讨论相关议题并给出论述。', properties: {}, format: {} },
    ],
    footnotes: notes.map((t, i) => ({ index: i, text: t, noteId: i + 1, isNoteSeparator: false })),
    endnotes: [], comments: [], tables: [], revisions: [], footnoteRefs: [],
  });
  const citIds = (notes) => (scanCitation(mkCit(notes)).issues || []).map((x) => x.ruleId);

  for (const [label, note] of [
    ['专著', 'Niall Ferguson, Civilization: The Six Killer Apps of Western Power, London: Penguin Books, 2011.'],
    ['期刊卷期', 'David Brady, “Poverty, Not the Poor”, Science Advances, 2023, Vol. 9, No. 34.'],
    ['政府公文集', 'U.S. Department of State, Foreign Relations of the United States, 1964–1968, Vol. XXVIII.'],
    ['整份政府出版物', 'Great Britain Colonial Office, Malayan Union and Singapore: Statement of Policy on Future Constitution, 1946.'],
  ]) {
    ok(!citIds([note]).includes('CIT-012'), `CIT-012 · ${label}形态不再报出（判据不可判，已改人工复核）`);
  }

  // ② ruleWillRun 必须尊重 manual 声明
  {
    const manualRule = { id: 'CIT-012', detect: { type: 'manual' } };
    ok(ruleWillRun(manualRule, 'citation') === false,
      'CIT-012 · ruleWillRun 尊重 detect.type=manual（防源码残留字面量让页面说谎）');
    const autoRule = { id: 'FMT-001', detect: { type: 'regex' } };
    ok(ruleWillRun(autoRule, 'format') === true, 'ruleWillRun · 正常自动规则仍判为会执行');
  }

  // ③ 规则条目仍在（不是删规则）
  {
    const cr = loadCitationRules().rules;
    const r12 = cr.find((r) => r.id === 'CIT-012');
    ok(!!r12, 'CIT-012 · 规则条目仍保留（供人工复核与规则管理页展示）');
    ok(r12?.detect?.type === 'manual', `CIT-012 · detect.type 为 manual（实得 ${r12?.detect?.type}）`);
  }
}

/**
 * 锚点边界：目标段落为**空段**或下标越界时，也必须给出可跳转的锚点。
 *
 * 需求 3 是「右侧清单上的问题都要可点击跳转」—— 只要 `computeAnchor`
 * 返回 `null`，前端那一行点下去就什么也不发生，需求直接不成立。
 *
 * 实测缺陷：开着模型审阅跑 `samples/test.docx` 时，模型把 FMTB-029
 * （文献著录信息完整性）指向 `paragraph:1`，而第 1 段是**标题后的空行**
 * （`text` 为空）。旧代码 `if (!text) return fallbackAnchor(issue) || null`
 * 里，`location='paragraph:1'` 既不匹配 `document` 也不匹配 `table:N`，
 * 于是返回 `null`，界面显示「无法定位 1 条」。
 */
{
  const mkDoc = () => ({
    paragraphs: [
      { index: 0, text: '作为经济基础的国家：对历史唯物主义的再认识' },
      { index: 1, text: '' },                     // 标题后的空行
      { index: 2, text: '孟 捷' },
      { index: 3, text: '' },
      { index: 4, text: '摘要：国家具有两重性……' },
    ],
    footnotes: [{ text: '' }, { text: '参见某某书，某某出版社，1978年，第71页。' }],
    endnotes: [], comments: [], tables: [], revisions: [],
  });
  const doc = mkDoc();

  const empty = computeAnchor({ location: 'paragraph:1', paragraphIndex: 1, quote: '' }, doc);
  ok(!!empty, '锚点 · 空段也返回锚点（不返回 null）');
  ok(empty?.precision === 'paragraph', `锚点 · 空段退化为整段级（实得 ${empty?.precision}）`);
  ok(empty?.index === 2 && empty?.text === '孟 捷',
    `锚点 · 空段退到最近的非空段（实得 idx=${empty?.index} text=${JSON.stringify(empty?.text)}）`);

  const oob = computeAnchor({ location: 'paragraph:9999', paragraphIndex: 9999, quote: 'x' }, doc);
  ok(!!oob, '锚点 · 下标越界也返回锚点（不返回 null）');
  ok(oob?.precision === 'document', `锚点 · 越界退到整篇级（实得 ${oob?.precision}）`);

  const emptyNote = computeAnchor({ location: 'footnote:0', footnoteIndex: 0, quote: '' }, doc);
  ok(emptyNote?.index === 1 && emptyNote?.target === 'footnote',
    `锚点 · 空脚注退到最近的非空脚注（实得 target=${emptyNote?.target} idx=${emptyNote?.index}）`);

  // 正常段落不能被这套兜底影响
  const normal = computeAnchor({ location: 'paragraph:4', paragraphIndex: 4, quote: '国家具有两重性' }, doc);
  ok(normal?.precision === 'quote' && normal?.index === 4,
    `锚点 · 正常段落的 quote 检索不受影响（实得 ${normal?.precision} idx=${normal?.index}）`);
}

/**
 * 解析层必须过滤非法控制字符 —— 两条进入路径都要堵。
 *
 * 实测缺陷（`tools/adversarial.mjs`）：一份含 `\x00\x01\x02\x1f` 的稿件，
 * 篇名被抽成 `"正常\u0000文字\u0001\u0002带\u001f控制字符"`，
 * 这些字符会一路进 JSON、界面和导出报告。
 *
 * 两条路径：
 *   ① 源码里直接写裸控制字符
 *   ② **数字字符引用** `&#x0;` —— 源码里干净，解码后才产生控制字符
 * ②更隐蔽：XML 1.0 本来禁止这些字符，但字符引用会被 `decodeEntities`
 * 正常解码出来，等于绕过了"源码里不该有"的假设。
 */
{
  const entity = parseXml('<a>&#x0;前&#1;中&#x1f;后&#x7f;尾</a>');
  ok(entity.allText() === '前中后尾',
    `XML · 数字字符引用注入的控制字符被剥除（实得 ${JSON.stringify(entity.allText())}）`);
  const raw = parseXml('<a>裸\x00控制\x01字符</a>');
  ok(raw.allText() === '裸控制字符',
    `XML · 裸控制字符被剥除（实得 ${JSON.stringify(raw.allText())}）`);
  const keep = parseXml('<a>保留\t制表\n换行</a>');
  ok(keep.allText() === '保留\t制表\n换行',
    `XML · 制表符与换行符必须保留（实得 ${JSON.stringify(keep.allText())}）`);
  /**
   * 属性值同样要过滤 —— `docx.js` 的样式名、编号格式、`w:val` 都走属性，
   * 控制字符进了属性一样会污染下游。
   * 注意 `parseXml` 返回的是 `#root` **包装节点**（不是根元素），
   * 属性挂在子元素上，所以要 `el('a')` 再取。
   */
  const attr = parseXml('<a b="x&#x0;y">t</a>').el('a');
  ok(attr?.attr('b') === 'xy',
    `XML · 属性值同样过滤（实得 ${JSON.stringify(attr?.attr('b'))}）`);
}

/**
 * 魔法常数必须真的走配置（需求 C）。
 *
 * 光把数字搬进 JSON 不算完成 —— 必须证明**代码真的在读它**，
 * 否则只是把硬编码换了个地方存。
 */
{
  const cfg = loadFormatRules();
  const raw = cfg?.journal?.titleSizeGapHalfPt;
  const val = typeof raw === 'object' && raw !== null ? raw.value : raw;
  ok(Number.isFinite(Number(val)) && Number(val) > 0,
    `配置 · journal.titleSizeGapHalfPt 存在且为正数（实得 ${JSON.stringify(val)}）`);
  ok(typeof raw === 'object' && raw !== null && raw.evidence && raw.sensitivity,
    '配置 · 该阈值带 evidence 与 sensitivity 字段（依据可追溯）');
}

/**
 * 判定口径不变量：**模型问题绝不能进入判定分数**。
 *
 * 这是本轮代价最大的一个缺陷。原来 `judge(deduped)` 吃的是「规则+模型」，
 * 而阈值是按纯规则标定的，于是**开模型后 25/25 篇全判「不合格」**，
 * 其中 10 篇是编辑已接受、已付印的发排定稿。
 * 实测两个口径的分离度（tools/eval-verdict-calib.mjs，25 篇）：
 *   规则分     TUNE P50=19  vs HOLDA P50=48   Welch t=−2.21 ← 有分离度
 *   规则+模型  TUNE P50=328 vs HOLDA P50=386  Welch t=−0.47 ← 无分离度
 * 没有分离度的信号不能当判定依据 —— 这条断言就是为了防止它被改回去。
 */
{
  const ruleIssues = [
    { ruleId: 'FMT-001', severity: '高', group: 'format', location: 'paragraph:3' },
    { ruleId: 'LANG-002', severity: '中', group: 'language', location: 'paragraph:5' },
  ];
  // 造一批"模型意见"：数量远大于规则问题，且都是低严重度
  const modelIssues = Array.from({ length: 60 }, (_, i) => (
    { ruleId: `MDL-${i}`, severity: '低', group: 'model', location: `paragraph:${i + 10}` }
  ));
  const withoutModel = judge(ruleIssues, {});
  const withModel = judge(ruleIssues, { modelIssues });
  ok(withModel.score === withoutModel.score,
    `判定 · 传入 60 条模型意见后分数不变（${withoutModel.score} → ${withModel.score}）`);
  ok(withModel.verdict === withoutModel.verdict,
    `判定 · 传入模型意见后判定不变（${withoutModel.verdict} → ${withModel.verdict}）`);
  ok(withModel.model?.count === 60,
    `判定 · 模型意见被单独统计（实得 ${withModel.model?.count}）`);
  ok(/不参与/.test(withModel.model?.note || ''),
    '判定 · 模型块明确标注不参与判定');
  ok(withModel.metrics.total === ruleIssues.length,
    `判定 · metrics.total 只计规则问题（实得 ${withModel.metrics.total}）`);
  // 反过来：模型意见不该被无声丢弃 —— 理由里要出现
  ok(withModel.reasons.some((r) => /模型审阅意见 60 条/.test(r)),
    '判定 · 理由中提示存在模型意见（不隐藏）');
  /**
   * 需求 E：模型条目不可复现这件事必须**写在判定依据里**。
   * 光说"不参与判定"不够 —— 编辑仍可能把某一条当成确定缺陷去改，
   * 或重跑后发现条目全变了而以为程序坏了。note 必须同时讲清这两点。
   */
  ok(/不可复现|重跑/.test(withModel.model?.note || ''),
    '判定 · 模型块说明条目不可复现（不只是"不参与判定"）');
}

/**
 * 需求 E：采样温度必须显式设 0。
 * 不设的话走服务端默认（通常 1.0），同稿 4 轮的模型问题数
 * 变异系数实测 9.3%~14.6%；设 0 后降到 2.9%。
 * 这个断言防的是"有人顺手把这行删了"—— 删了不会报错，只会悄悄变差。
 */
{
  ok(ARK_TEMPERATURE === 0, `模型 · 采样温度显式设为 0（实得 ${ARK_TEMPERATURE}）`);
}

/**
 * 标题判据的**三处声明必须一致**（需求 C：禁止同一件事有多个互相矛盾的真源）。
 *
 * 全项目原本有三套互不一致的标题正则，各覆盖 5 / 3 / 3 级：
 *   · `rules/format-rules.json` 的 `journal.headingLevelPatterns`（**死配置**，
 *     全代码库零处消费，却声明了 7 种形态里的 5 种）
 *   · `src/ark.js` 分窗用的内联正则（3 组，且 `\d+[．.]` 无守卫，
 *     把 `60.95` / `4.25` 这类小数值误判成三级标题 —— 200 篇里 1752 段）
 *   · `tools/dump-structure.mjs` 的诊断正则（3 组）
 * 现已全部收敛到 `src/headings.js` 的 `isTextHeading`。
 *
 * 这条断言防的是**再次漂移**：改了三处中的任意一处而没同步，
 * 这里会直接失败，而不是等到某篇稿子的窗口切错位置才发现。
 */
{
  const j = loadFormatRules().journal;
  const forms = j.headingLevels || [];
  const pats = j.headingLevelPatterns || {};

  ok(forms.length === 7, `标题 · headingLevels 声明 7 种形态（实得 ${forms.length}）`);
  ok(HEADING_LEVEL_FORMS.length === 7, `标题 · HEADING_LEVEL_FORMS 也是 7 种（实得 ${HEADING_LEVEL_FORMS.length}）`);
  ok(JSON.stringify(forms) === JSON.stringify(HEADING_LEVEL_FORMS),
    `标题 · 规则库与代码声明的形态顺序一致（${forms.join('')}）`);

  // 每一级都要在配置里声明、在实现里有对应 pattern
  const missingCfg = [];
  const missingImpl = [];
  for (let lv = 1; lv <= 7; lv += 1) {
    if (!pats[`level${lv}`]) missingCfg.push(lv);
    if (!TEXT_HEADING_PATTERNS.some((p) => p.level === lv)) missingImpl.push(lv);
  }
  ok(missingCfg.length === 0, `标题 · headingLevelPatterns 覆盖 1–7 级（缺 ${missingCfg.join(',') || '无'}）`);
  ok(missingImpl.length === 0, `标题 · TEXT_HEADING_PATTERNS 覆盖 1–7 级（缺 ${missingImpl.join(',') || '无'}）`);

  /**
   * 行为断言：把 `headingLevels` 声明的每种形态造成一个样本标题，
   * 必须被 `isTextHeading` 认出**且层级号与声明顺序一致**。
   * 只比对字符串声明是不够的 —— 声明对了但正则写错照样是坏的。
   */
  const samples = [
    ['一、', '一、研究背景', 1],
    ['（一）', '（一）研究背景', 2],
    ['1.', '1.研究背景', 3],
    ['（1）', '（1）研究背景', 4],
    ['①', '①研究背景', 5],
    ['A.', 'A. Research Background', 6],
    ['a.', 'a. Research Background', 7],
  ];
  const bad = [];
  for (const [form, sample, want] of samples) {
    const hit = isTextHeading(sample);
    if (!hit || hit.level !== want) bad.push(`${form}→${hit ? hit.level : '未识别'}(期望${want})`);
  }
  ok(bad.length === 0, `标题 · 7 种形态都被识别且层级正确（异常：${bad.join(' ') || '无'}）`);

  /**
   * 守卫断言：小数值与多级编号不能被当成标题。
   * 这是旧内联正则的真实误报（200 篇 1752 段），必须钉住。
   */
  const notHeadings = ['60.95', '4.25', '1.2 研究背景', '2020.5.1', '3.14', '0.05'];
  const wrong = notHeadings.filter((t) => isTextHeading(t));
  ok(wrong.length === 0, `标题 · 小数值/多级编号不算标题（误判：${wrong.join(' ') || '无'}）`);

  // 反向：正常的正文开头不能被误认成标题
  const prose = ['一定要重视这个问题', '二十年来中国的发展', '3月15日召开了会议'];
  const wrongProse = prose.filter((t) => isTextHeading(t));
  ok(wrongProse.length === 0, `标题 · 正文开头不算标题（误判：${wrongProse.join(' ') || '无'}）`);
}

/**
 * 「导入即清洗」：特殊格式必须被**结构化抽取**，而不是当成普通文字或丢掉。
 *
 * 实测底数（`tools/census-special-formats.mjs`，632 篇）：
 *   脚注定义 607 篇、尾注定义 536 篇、表格 84 篇、脚注引用标记 576 篇、
 *   带文字上标 46 篇、图内文字（文本框）14 篇、图片 147 篇、公式 4 篇。
 * 这几条断言防的是「解析器把某类格式又读进来丢掉」——
 * 本项目已经发生过一次：`info.superscript` 解析出来后全项目零处使用。
 */
{
  const f = join(SELF_ROOT, 'samples', 'test.docx');
  if (existsSync(f)) {
    const doc = parseDocx(f);

    // ① 上标/下标：逐 run 抽取，带段内偏移
    const withMarks = doc.paragraphs.filter((p) => (p.marks || []).length);
    ok(Array.isArray(doc.paragraphs[0]?.marks), '清洗 · 段落带 marks 字段（上标/下标区间）');
    const badOffset = withMarks.filter((p) => p.marks.some((m) => m.offset < 0 || m.offset + m.text.length > p.text.length));
    ok(badOffset.length === 0, `清洗 · 上标偏移都落在段落文本范围内（越界 ${badOffset.length} 段）`);

    // ② 脚注/尾注引用标记：无 w:t，必须单独抽取，否则"脚注挂在哪个字后面"是缺失的
    const refs = doc.paragraphs.flatMap((p) => p.noteRefs || []);
    ok(refs.length > 0, `清洗 · 抽到脚注引用标记（${refs.length} 个）`);
    ok(refs.every((r) => r.kind === 'footnote' || r.kind === 'endnote'), '清洗 · 引用标记带 kind');
    ok(refs.every((r) => typeof r.id === 'string' && r.id !== ''), '清洗 · 引用标记带 w:id');
    /**
     * 引用标记**不该**出现在 text 里（它没有 w:t，编号由 Word 渲染时生成）。
     * 这条断言把「标记只记位置、不污染正文」这个设计钉住 ——
     * 一旦有人图省事往 text 里塞占位符，全项目的锚点偏移会同时位移。
     */
    const leak = doc.paragraphs.filter((p) => (p.noteRefs || []).length && p.text.includes('\u0001'));
    ok(leak.length === 0, '清洗 · 引用标记不往 text 里塞占位符');

    // ③ 图内文字：进独立结构，**不进 text**
    const tbTotal = doc.paragraphs.reduce((s, p) => s + (p.textboxes || []).length, 0);
    ok(Array.isArray(doc.paragraphs[0]?.textboxes), '清洗 · 段落带 textboxes 字段（图内文字）');
    if (tbTotal) {
      const tbText = doc.paragraphs.flatMap((p) => p.textboxes || []).join('');
      /**
       * 图内文字不得出现在宿主段落的 text 里。这条是**实测踩坑**得来的：
       * `paragraphText` 的 walk 原本会递归进 `w:drawing`，把图标签拼进段落文本 ——
       * `02-吴子枫` 段43 的 text 长度 146，内容**全部**是图标签拼接，
       * 于是语言规则在垃圾文本上命中、字数统计失真、与 DOM 对齐错位。
       */
      const samples = [...new Set(tbText.replace(/\s+/g, '').match(/.{8,14}/g) || [])].slice(0, 5);
      const polluted = doc.paragraphs.filter((p) => samples.some((s) => p.text.includes(s)));
      ok(polluted.length === 0, `清洗 · 图内文字不混进段落 text（污染 ${polluted.length} 段）`);
    }

    // ④ 图片与公式：至少要有计数，此前源码零处引用
    const figs = doc.paragraphs.flatMap((p) => p.figures || []);
    ok(Array.isArray(doc.paragraphs[0]?.figures), '清洗 · 段落带 figures 字段（图/文本框/嵌入对象）');
    if (figs.length) {
      ok(figs.every((g) => typeof g.images === 'number' && typeof g.equations === 'number'), '清洗 · 图对象带 images/equations 计数');
    }

    /**
     * ⑤ 责编高亮。
     *
     * 覆盖面 523 篇（82.8%）—— 是本语料覆盖面最广的特殊格式，
     * 实测确认它是**责编标记**（不同颜色分不同类别：待问 / 人名 / 单字纠错），
     * 不是模板残留。与 `marks` 分开存放，因为语义不同（编辑意图 vs 渲染形态）。
     */
    ok(Array.isArray(doc.paragraphs[0]?.highlights), '清洗 · 段落带 highlights 字段（责编高亮）');
    const hls = doc.paragraphs.flatMap((p) => p.highlights || []);
    if (hls.length) {
      /**
       * `w:val="none"` 是「显式取消高亮」，**不是高亮**。
       * 实测 42 篇 / 12270 处是这个值 —— 早期普查把它算成"有高亮"，
       * 使总数虚高约 28%。这条断言把它钉死。
       */
      ok(hls.every((h) => h.color && h.color !== 'none'), `清洗 · 高亮不含 none（实测 ${hls.length} 处）`);
      const badHl = doc.paragraphs.filter((p) => (p.highlights || []).some((h) => h.offset < 0 || h.offset + h.text.length > p.text.length));
      ok(badHl.length === 0, `清洗 · 高亮偏移都落在段落文本范围内（越界 ${badHl.length} 段）`);
      /** 高亮不得与上标混在同一个数组里 —— 否则渲染断言会把高亮算成 vertical-align */
      ok(!doc.paragraphs.some((p) => (p.marks || []).some((m) => m.kind === 'highlight')),
        '清洗 · 高亮不混进 marks（语义分离：编辑意图 vs 渲染形态）');
    }

    /**
     * ⑥ 域代码。
     *
     * 判据是 `w:fldChar w:fldCharType="begin"` 数，**不是** `w:instrText` 数 ——
     * 一条指令会被拆成多个 `w:instrText` 元素（实测 2453 个元素只对应 481 个域，
     * 平均 5.1 个/域）。早期按元素取"域类型"被骗出 `TRIEVED`、`CSL`、`YLE`
     * 这类碎片假类型，而真正的 `HYPERLINK`（91 篇 / 341 条）与
     * `ADDIN EN.CITE`（EndNote 引文域）反而被埋掉。
     * 逐篇相等性见 `tools/verify-fields.mjs`。
     */
    ok(Array.isArray(doc.paragraphs[0]?.fields), '清洗 · 段落带 fields 字段（域代码）');
    const flds = doc.paragraphs.flatMap((p) => p.fields || []);
    if (flds.length) {
      ok(flds.every((f) => f.type && typeof f.instr === 'string'), '清洗 · 域带 type 与完整指令');
      /** 类型必须是完整指令里解析出来的，不能是碎片 */
      ok(flds.every((f) => /^[A-Z][A-Z.]*( [A-Z][A-Z.]*)?$/.test(f.type)),
        `清洗 · 域类型形如完整指令（实测 ${flds.length} 个：${[...new Set(flds.map((f) => f.type))].slice(0, 4).join('/')}）`);
      /** 域指令是隐藏内容，绝不能进入段落文本 */
      ok(!doc.paragraphs.some((p) => (p.fields || []).some((f) => f.instr && p.text.includes(f.instr))),
        '清洗 · 域指令不进入段落 text（读者看不到）');
    }
  }
}

/* ---------- 第二轮自证 & 提示词前缀缓存（本轮新增能力，纯离线单测） ---------- */
console.log('[N] 第二轮自证 · 提示词前缀缓存');
{
  const docMeta = { title: '某某研究', column: '专题', chars: 8000 };
  // 用「接近真实规模」的前缀：实跑时语义规则 ~19 条、脚注常几十条，
  // 前缀远超缓存闸门；这里也放大，才好断言「长度达标」这一条。
  const rules = Array.from({ length: 8 }, (_, i) => ({
    id: `LANG-0${i + 2}`, title: `语义规则标题第${i + 2}条`, method: '判断要点：用于测试前缀长度的占位说明文字。',
  }));
  const footnotes = Array.from({ length: 8 }, (_, i) => `[脚注${i + 1}] 参见《测试文献${i + 1}》，某出版社2020年，第${i + 10}页。`);
  const w1 = [{ index: 0, text: '第一段的正文内容。' }, { index: 1, text: '第二段。' }];
  const w2 = [{ index: 2, text: '第三段的正文内容。' }, { index: 3, text: '第四段。' }];

  const p1 = buildWindowPrompt({ docMeta, footnoteText: footnotes, win: w1, modelRules: rules });
  const p2 = buildWindowPrompt({ docMeta, footnoteText: footnotes, win: w2, modelRules: rules });

  // 1) 同一篇稿子的不同窗口，前缀必须**逐字一致**（前缀缓存命中的前提）
  ok(p1.prefix === p2.prefix, '前缀缓存 · 同一稿不同窗口的前缀逐字一致');
  // 2) 完整提示词不同（因为正文不同）
  ok(p1.input !== p2.input, '前缀缓存 · 完整提示词因正文不同而不同');
  // 3) 提示词以该前缀开头（前缀必须在最前）
  ok(p1.input.startsWith(p1.prefix), '前缀缓存 · 提示词以前缀开头');
  // 4) 前缀里**不含**逐窗口变化的正文
  ok(!p1.prefix.includes('第一段的正文内容'), '前缀缓存 · 前缀不含窗口正文');
  // 5) 正文在提示词里出现
  ok(p1.input.includes('第一段的正文内容'), '前缀缓存 · 正文进入提示词');
  // 6) 稳定大块（规则）排在易变正文之前
  ok(p1.input.indexOf('须逐条匹配的语义规则') < p1.input.indexOf('第一段的正文内容'),
    '前缀缓存 · 语义规则排在正文之前');
  // 7) 验证实际有界注释内容，不能依赖展示标题或声称覆盖未输入的注释。
  const expectedNoteBlock = footnotes.join('\n').slice(0, 6000);
  ok(p1.prefix.includes(expectedNoteBlock) && p2.prefix.includes(expectedNoteBlock),
    '前缀缓存 · 完整有界注释内容属于稳定前缀');
  // 8) 前缀足够长才有资格走缓存（闸门常量）
  ok(p1.prefix.length >= PREFIX_CACHE_MIN_CHARS, `前缀缓存 · 前缀长度达标（${p1.prefix.length}≥${PREFIX_CACHE_MIN_CHARS}）`);
  // 9) 精简模式：去掉规则与脚注（压缩输出预算时不做缓存）
  const pc = buildWindowPrompt({ docMeta, footnoteText: footnotes, win: w1, modelRules: rules, compact: true });
  ok(!pc.prefix.includes('须逐条匹配的语义规则') && footnotes.every((note) => !pc.prefix.includes(note)),
    '前缀缓存 · 精简模式不塞规则与脚注');

  // cachedTokensOf 兼容多种 usage 形态
  eq(cachedTokensOf({ cached_tokens: 5 }), 5, '缓存命中数 · 顶层 cached_tokens');
  eq(cachedTokensOf({ prompt_tokens_details: { cached_tokens: 7 } }), 7, '缓存命中数 · prompt_tokens_details');
  eq(cachedTokensOf({}), 0, '缓存命中数 · 缺字段为 0');
  eq(cachedTokensOf(null), 0, '缓存命中数 · null 为 0');

  // 开关：默认开，ARK_PREFIX_CACHE=0 关
  const saved = process.env.ARK_PREFIX_CACHE;
  delete process.env.ARK_PREFIX_CACHE;
  ok(prefixCacheEnabled() === true, '前缀缓存开关 · 默认开');
  process.env.ARK_PREFIX_CACHE = '0';
  ok(prefixCacheEnabled() === false, '前缀缓存开关 · =0 时关');
  if (saved === undefined) delete process.env.ARK_PREFIX_CACHE; else process.env.ARK_PREFIX_CACHE = saved;
}

/* ---------- 全局上下文：全文纲要 + 滑窗邻段（本轮新增，纯离线单测） ---------- */
console.log('[N+1] 全局上下文 · 全文纲要 + 邻段');
{
  // buildDigestSource：抽样全篇，产出非空的节选
  const paras = Array.from({ length: 120 }, (_, i) => ({ index: i, text: `第${i + 1}段的正文内容，用于测试抽样。` }));
  const src = buildDigestSource({ paragraphs: paras });
  ok(src.includes('[段落0]'), '全文纲要 · 节选含开头段');
  ok(src.includes('[段落119]') || src.split('\n').length > 10, '全文纲要 · 节选覆盖面广（不只开头）');
  ok(src.length <= 6000, `全文纲要 · 节选不超字数预算（${src.length}）`);
  ok(buildDigestSource({ paragraphs: [] }) === '', '全文纲要 · 空文档返回空串');

  // formatDocDigest：把 JSON 纲要格式化成文本块
  const formatted = formatDocDigest({ summary: '本文讨论X。', structure: ['一、导论', '二、结论'], keyTerms: ['概念甲（指……）'], claims: ['甲导致乙'] });
  ok(formatted.includes('摘要：本文讨论X'), '全文纲要 · 格式化含摘要');
  ok(formatted.includes('结构：1) 一、导论'), '全文纲要 · 格式化含结构');
  ok(formatted.includes('核心术语：概念甲'), '全文纲要 · 格式化含术语');
  ok(formatted.includes('主要论点：甲导致乙'), '全文纲要 · 格式化含论点');
  eq(formatDocDigest(null), '', '全文纲要 · 空输入返回空串');

  // 纲要属于「稳定前缀」；邻段属于「易变区」
  const docMeta = { title: '某某研究', column: '专题', chars: 8000 };
  const rules = Array.from({ length: 8 }, (_, i) => ({ id: `LANG-0${i + 2}`, title: `语义规则标题第${i + 2}条`, method: '判断要点：占位说明。' }));
  const footnotes = Array.from({ length: 8 }, (_, i) => `[脚注${i + 1}] 参见《测试文献${i + 1}》，2020年，第${i + 10}页。`);
  const digest = '摘要：全文讨论了甲与乙的关系。\n主要论点：甲导致乙。';
  const winA = [{ index: 10, text: '当前窗口的正文甲。' }];
  const winB = [{ index: 20, text: '当前窗口的正文乙。' }];
  const prev = [{ index: 8, text: '上一窗口的末尾段。' }];
  const next = [{ index: 11, text: '下一窗口的开头段。' }];

  const a = buildWindowPrompt({ docMeta, footnoteText: footnotes, win: winA, modelRules: rules, docDigest: digest, prevTail: prev, nextHead: next });
  const b = buildWindowPrompt({ docMeta, footnoteText: footnotes, win: winB, modelRules: rules, docDigest: digest, prevTail: prev, nextHead: next });

  ok(a.prefix.includes('全文纲要'), '全局上下文 · 纲要进入提示词');
  ok(a.prefix.includes('甲与乙的关系'), '全局上下文 · 纲要内容进入前缀');
  ok(a.prefix === b.prefix, '全局上下文 · 加了纲要后前缀仍跨窗口稳定（缓存不破）');
  ok(!a.prefix.includes('当前窗口的正文甲'), '全局上下文 · 前缀不含窗口正文');
  ok(!a.prefix.includes('上一窗口的末尾段') && !a.prefix.includes('下一窗口的开头段'),
    '全局上下文 · 邻段**不进前缀**（否则缓存失效）');
  ok(a.input.includes('上一窗口的末尾段') && a.input.includes('下一窗口的开头段'),
    '全局上下文 · 邻段进入提示词（易变区）');
  ok(a.input.includes('请勿在这几段里报问题') || a.input.includes('请勿在这几段里报问题'),
    '全局上下文 · 邻段带「勿在此报问题」标注');
  ok(a.input.includes('上一窗口的末尾段') && a.input.indexOf('上一窗口的末尾段') < a.input.indexOf('当前窗口的正文甲'),
    '全局上下文 · 上一窗口尾在正文之前');
  ok(a.input.indexOf('下一窗口的开头段') > a.input.indexOf('当前窗口的正文甲'),
    '全局上下文 · 下一窗口头在正文之后');

  // 关掉全局上下文（不传 digest/邻段）时，行为回到旧版：前缀里没有纲要
  const noCtx = buildWindowPrompt({ docMeta, footnoteText: footnotes, win: winA, modelRules: rules });
  ok(!noCtx.prefix.includes('全文纲要'), '全局上下文 · 关闭时不注入纲要');
}

/* ---------- 第三轮：全篇一致性终检（本轮新增，纯离线单测） ---------- */
console.log('[N+2] 第三轮 · 全篇一致性终检');
{
  const cMeta = { title: '论某某', column: '政治', chars: 5200 };
  const digest = '摘要：本文讨论甲与乙的关系。\n结构：一、导论；二、结论\n核心术语：甲（指……）';
  const excerpt = '[段落0] 开头一段\n[段落40] 中间一段\n[段落80] 结尾一段';
  const cIssues = [
    { ruleId: 'LANG-002', title: '用词不当', quote: '某某某某', paragraphIndex: 3 },
    { ruleId: 'CIT-001', title: '引文缺出处', quote: '参见', footnoteNumber: 2 },
    { ruleId: 'FMT-010', title: '标题标点', quote: '' },
  ];

  const p = buildConsistencyPrompt({ docMeta: cMeta, docDigest: digest, docExcerpt: excerpt, issues: cIssues });
  ok(p.prefix.includes('论某某'), '全篇终检 · 提示词含稿件信息');
  ok(p.prefix.includes('全文纲要'), '全篇终检 · 提示词含全文纲要');
  ok(p.prefix.includes('甲与乙的关系'), '全篇终检 · 纲要内容进入提示词');
  ok(p.prefix.includes('全文节选'), '全篇终检 · 提示词含全文节选');
  ok(p.prefix.includes('已发现的问题清单'), '全篇终检 · 提示词含问题清单');
  ok(p.prefix.includes('共 3 条'), '全篇终检 · 清单标注问题条数');
  ok(p.prefix.includes('[段落3] LANG-002'), '全篇终检 · 段落级问题按段落号列出');
  ok(p.prefix.includes('[脚注2] CIT-001'), '全篇终检 · 脚注级问题按脚注号列出');
  ok(p.prefix.includes('[文档级] FMT-010'), '全篇终检 · 无定位问题标为文档级');
  ok(p.input.startsWith(p.prefix), '全篇终检 · 提示词以前缀开头');
  ok(p.input.includes('全篇一致性终检'), '全篇终检 · 任务指令进入提示词');

  const pEmpty = buildConsistencyPrompt({ docMeta: cMeta, docDigest: digest, issues: [] });
  ok(!pEmpty.prefix.includes('已发现的问题清单'), '全篇终检 · 无问题时不含清单块');
  const pNoDigest = buildConsistencyPrompt({ docMeta: cMeta, issues: cIssues });
  ok(!pNoDigest.prefix.includes('全文纲要'), '全篇终检 · 无纲要时不含纲要求');

  const many = Array.from({ length: 200 }, (_, i) => ({ ruleId: 'X-001', title: `t${i}`, quote: `q${i}`, paragraphIndex: i }));
  const pMany = buildConsistencyPrompt({ docMeta: cMeta, docDigest: digest, issues: many });
  ok(pMany.prefix.includes('60. ') && !pMany.prefix.includes('61. '), '全篇终检 · 问题清单按 60 条截断');

  ok(/全篇一致性终检/.test(CONSISTENCY_INSTRUCTIONS), '全篇终检 · 指令含任务名');
  ok(/JSON/.test(CONSISTENCY_INSTRUCTIONS), '全篇终检 · 指令要求输出 JSON');
  ok(/前后自相矛盾/.test(CONSISTENCY_INSTRUCTIONS), '全篇终检 · 指令覆盖跨段检查项');
  ok(!p.input.includes('本段正文'), '全篇终检 · 不注入窗口式正文块');
}

/* ---------- 历史批注案例库（RAG，本轮新增，纯离线单测） ---------- */
console.log('[N+3] 历史批注案例库 · 分词/过滤/BM25/提示词');
{
  // 分词：CJK 按字符二元组；ASCII 字母数字整体成词；标点空白全剥除
  eq(tokenize('区域国别研究'), ['区域', '域国', '国别', '别研', '研究'], 'RAG · 中文按二元组分词');
  eq(tokenize('WTO 与 GDP'), ['wto', '与', 'gdp'], 'RAG · 英文数字整体成词、标点剥除');
  eq(tokenize('单'), ['单'], 'RAG · 单字成词');
  eq(normalizeForIndex('a, b。c'), 'abc', 'RAG · 归一化去标点与空白');

  // 过滤编辑的「处理回执」（不表达审阅意见，收进案例库只会污染检索）
  ok(!isUsefulComment('已修改。'), 'RAG · 过短回执被过滤');
  ok(!isUsefulComment('同上。'), 'RAG · 「同上」被过滤');
  ok(!isUsefulComment('已按前一句调整'), 'RAG · 短回执「已按…」被过滤');
  ok(isUsefulComment('这里有错别字，请作者核改。'), 'RAG · 实质意见被保留');

  // 用内存里的小索引验证 BM25 检索行为（不依赖 5MB 的真实索引文件）
  const buildIdx = (docs) => {
    const lens = [];
    const postings = new Map();
    docs.forEach((d, i) => {
      const toks = tokenize(d.a);
      lens.push(toks.length);
      const tf = new Map();
      for (const x of toks) tf.set(x, (tf.get(x) || 0) + 1);
      for (const [x, c] of tf) { let arr = postings.get(x); if (!arr) { arr = []; postings.set(x, arr); } arr.push(i, c); }
    });
    return { docs, files: docs.map((_, i) => `f${i}`), lens, avgLen: lens.reduce((a, b) => a + b, 0) / docs.length, postings: Object.fromEntries(postings) };
  };
  const idx = buildIdx([
    { t: '区域国别研究需要处理三个问题', a: '区域国别研究需要处理三个问题', s: 'x', au: 'a', fi: 0 },
    { t: '宏观经济数据应当核对官方统计口径', a: '宏观经济数据应当核对官方统计口径', s: 'x', au: 'a', fi: 1 },
  ]);
  const rt = makeRetriever(idx);
  const r1 = rt('本文讨论区域国别研究的基本问题', { k: 3, minMatch: 2, ratio: 0, floor: 0 });
  ok(r1.length >= 1 && r1[0].comment.includes('区域国别'), 'RAG · 检索命中同主题文档');
  ok(r1.every((c) => !c.comment.includes('宏观经济')), 'RAG · 不返回无关主题');
  eq(rt('区域国别', { k: 1, minMatch: 2, ratio: 0, floor: 0 }).length, 1, 'RAG · k 生效（只取 1 条）');
  eq(rt('区域国别研究', { k: 3, minMatch: 99 }).length, 0, 'RAG · minMatch 过高时返回空');
  eq(rt('区域国别研究', { k: 3, minMatch: 2, ratio: 0, floor: 1e9 }).length, 0, 'RAG · 绝对下限过高时返回空');
  eq(rt('区域国别研究', { k: 3, minMatch: 2, ratio: 0, floor: 0, excludeFiles: new Set(['f0']) }).length, 0, 'RAG · excludeFiles 排除同文件生效');

  // 去重 + 每篇稿件上限
  const idxDup = buildIdx([
    { t: '同一句批注内容甲', a: '同一句批注内容甲', s: '', au: '', fi: 0 },
    { t: '同一句批注内容甲', a: '同一句批注内容甲', s: '', au: '', fi: 1 },
  ]);
  eq(makeRetriever(idxDup)('同一句批注内容', { k: 3, minMatch: 2, ratio: 0, floor: 0 }).length, 1, 'RAG · 相同批注去重');
  const idxDiv = buildIdx([
    { t: '意见一', a: '段落内容甲乙丙', s: '', au: '', fi: 9 },
    { t: '意见二', a: '段落内容甲乙丁', s: '', au: '', fi: 9 },
    { t: '意见三', a: '段落内容甲乙戊', s: '', au: '', fi: 9 },
  ]);
  eq(makeRetriever(idxDiv)('段落内容甲乙', { k: 3, minMatch: 2, ratio: 0, floor: 0 }).length, 2, 'RAG · 同一篇稿件最多贡献 2 条');

  // 提示词：案例进易变区，不进稳定前缀（否则前缀缓存失效）
  const rdocMeta = { title: 'T', column: 'c', chars: 100 };
  const rwin = [{ index: 0, text: '本段正文内容' }];
  const withCases = buildWindowPrompt({ docMeta: rdocMeta, win: rwin, cases: [{ comment: '历史意见甲', anchor: '当时的段落' }] });
  const noCases = buildWindowPrompt({ docMeta: rdocMeta, win: rwin, cases: [] });
  ok(withCases.input.includes('本刊历史批注参考'), 'RAG · 提示词含历史批注参考块');
  ok(withCases.input.includes('历史意见甲'), 'RAG · 案例正文进入提示词');
  ok(!withCases.prefix.includes('历史意见甲'), 'RAG · 案例不进稳定前缀（否则缓存失效）');
  ok(withCases.prefix === noCases.prefix, 'RAG · 有无案例时前缀保持一致');
  ok(!buildWindowPrompt({ docMeta: rdocMeta, win: rwin, cases: [{ comment: 'x' }], compact: true }).input.includes('本刊历史批注参考'), 'RAG · 精简模式不带案例');
}

/* ---------- 提速度量（本轮新增，纯离线单测） ---------- */
console.log('[N+4] 审核提速 · recheck 并发自适应 / 终检默认关');
{
  eq(recheckConcurrency(5), 3, 'recheck 并发 · 小稿保守保持 3');
  eq(recheckConcurrency(12), 3, 'recheck 并发 · 12 批仍为 3');
  eq(recheckConcurrency(20), 5, 'recheck 并发 · 20 批抬到 5');
  eq(recheckConcurrency(32), 8, 'recheck 并发 · 32 批抬到 8');
  eq(recheckConcurrency(100), 8, 'recheck 并发 · 上限 8 封顶');
  ok(consistencyEnabled() === false, '全篇终检 · 默认关（性价比未验证）');
}

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

function findSampleDocx() {
  // 锚在脚本自身（`dsh/tools/` → `dsh/` → `学术/` → `发给皓天的一审文件`），不锚 cwd
  const roots = [
    join(SELF_ROOT, '..', '发给皓天的一审文件'),
    CORPUS_ROOT,
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const found = walk(root, 0);
    if (found) return found;
  }
  return null;
}
function walk(dir, depth) {
  if (depth > 4) return null;
  let items;
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const it of items) {
    const full = resolve(dir, it.name);
    if (it.isFile() && /\.docx$/i.test(it.name) && !it.name.startsWith('~$')) return full;
    if (it.isDirectory()) {
      const r = walk(full, depth + 1);
      if (r) return r;
    }
  }
  return null;
}
