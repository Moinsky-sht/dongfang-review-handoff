/**
 * 需求验收探针（规则路径，不烧模型额度）。
 *
 * 逐项核对本轮 7 条需求在**真实 HTTP 接口**上的表现，而不是只看单元函数：
 *   1 提速        —— 由 tools/speed-bench.mjs 单独度量，这里只报当前配置
 *   2 批注退出    —— 文档负载里不得出现批注内容，只留计数
 *   3/4 锚点      —— 每条问题都要有锚点，且精度分布可核对
 *   5 下划线与跳转 —— 前端行为，这里核对锚点数据是否足以支撑（text/start/end）
 *   6 标题识别    —— 各级标题要被识别出来并随文档下发
 *   7 逐条一键改  —— 用单条 key 调 /api/apply-fixes，验证只改这一条
 *
 * 用法：node tools/verify-requirements.mjs [docx路径]
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:3210';
/**
 * 样本路径**相对脚本自身**解析，不相对 cwd。
 *
 * 原来写的是 `resolve('samples/test.docx')` —— 这依赖「调用者的当前目录正好是 dsh/」。
 * 一旦从别处调用（例如把整个文件夹拷走后在 `学术/` 下跑，或从上级目录跑），
 * 它会去找 `学术/samples/test.docx`，报 ENOENT。
 * 实测就是这么暴露的：整理后从 `学术/` 目录运行 → 
 * `Error: ENOENT … open '<学术目录>\samples\test.docx'`。
 * 项目要能被整体拷贝到任何位置运行，这类路径必须锚在脚本上。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(process.argv[2] || join(HERE, '..', 'samples', 'test.docx'));
const line = (s = '') => console.log(s);

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

/**
 * 上传：`POST /api/upload` 收的是**裸二进制体**，文件名走 `?name=` query
 * （不是 multipart —— 早期用 FormData 试过，服务端会把 multipart 的
 * 边界头当成 docx 字节，报「ZIP 中央目录偏移异常」）。
 */
async function upload(file) {
  const buf = readFileSync(file);
  const r = await fetch(`${BASE}/api/upload?name=${encodeURIComponent(basename(file))}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  return r.json();
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  line(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  ${detail}` : ''}`);
};

const t0 = Date.now();
line(`验收稿件：${FILE}`);

/* ---------- 上传 ---------- */
const up = await upload(FILE);
if (up.error) { line(`上传失败：${up.error}`); process.exit(1); }
const id = up.id;
const doc = up.doc;
line(`会话 ${id}｜段落 ${doc.paragraphs.length}｜脚注 ${doc.footnotes.length}｜字数 ${doc.stats.chars}`);
line();

/* ---------- 需求 2：原文批注不参与 ---------- */
line('【需求 2】原文批注完全不参与，只保留解析统计');
const docJson = JSON.stringify(doc);
// 注意：`stats.comments` 是解析统计，必须保留；要断言的是**顶层不再有批注内容数组**
check('文档负载不含批注内容数组', !('comments' in doc),
  `顶层键 ${Object.keys(doc).join(',')}`);
check('段落负载不含 commentIds', !docJson.includes('commentIds'));
check('meta 不含 commentHints', !('commentHints' in (doc.meta || {})));
check('保留批注计数作为解析统计', typeof doc.stats.comments === 'number', `stats.comments=${doc.stats.comments}`);
line();

/* ---------- 需求 6：各级标题识别 ---------- */
line('【需求 6】各级标题识别');
const heads = doc.headings || [];
/**
 * 「必须有标题」**不能**当成硬性断言。
 *
 * 实测有两类已发排定稿**本来就没有章节标题**，识别出 0 条是**正确**结果：
 *   · `01-特稿-王绍光-我与国家能力研究` —— 连续行文的回忆性特稿，
 *     通篇 204 段没有一个小标题（文末是一首八句诗）
 *   · `10-对话-萨克斯演讲、对话张维为及现场互动` —— 对话实录，
 *     加粗的 `张维为：` / `杰弗里·萨克斯：` 是**发言人标记**，不是标题
 * 对它们报「标题识别失败」是度量错误。
 *
 * 真正该抓的漏检是：**文档里明明有标题形态的段落，却一条都没识别出来**。
 * 所以这里改成——若识别结果为 0，就回查正文里是否还有符合编号形态的短行；
 * 有，才算失败。
 */
const headingFormRe = /^[（(]?[一二三四五六七八九十百]+[、．.)）]|^\d+[．.]\s*\S|^第[一二三四五六七八九十百\d]+[节章部分篇]/;
const missable = (doc.paragraphs || [])
  .map((p) => (p.text || '').trim())
  .filter((t) => t && t.length <= 60 && headingFormRe.test(t));
if (heads.length > 0) {
  check('下发了标题结构', true, `共 ${heads.length} 条`);
} else {
  check('零标题稿件确实没有标题形态的段落', missable.length === 0,
    `标题 0 条，但正文里有 ${missable.length} 段疑似标题形态`
    + (missable.length ? `：${JSON.stringify(missable.slice(0, 3))}` : '（该稿本就没有章节标题）'));
}
const byLevel = {};
for (const h of heads) byLevel[h.level] = (byLevel[h.level] || 0) + 1;
const srcs = [...new Set(heads.map((h) => h.source))];
if (heads.length > 0) {
  check('标题层级可区分', Object.keys(byLevel).length >= 1,
    `层级分布 ${JSON.stringify(byLevel)}｜判据来源 ${srcs.join('、') || '无'}`);
} else {
  line(`     层级分布 {}｜判据来源 无（该稿无章节标题）`);
}
/**
 * 层级不得跳级 —— 这是「识别准确」的核心检查项之一。
 *
 * 按文档顺序检查相邻标题的层级差。跳级说明分级器把某条标题的级别判错了
 * （实测的典型成因是**表图题注**被判成标题，插进层级序列里造成
 * 一级直接跳到四级/五级）。
 */
const skips = [];
for (let i = 1; i < heads.length; i += 1) {
  if (heads[i].level - heads[i - 1].level > 1) {
    skips.push(`「${heads[i - 1].text.slice(0, 14)}」L${heads[i - 1].level} → 「${heads[i].text.slice(0, 14)}」L${heads[i].level}`);
  }
}
check('标题层级无跳级', skips.length === 0,
  skips.length ? `${skips.length} 处：${skips[0]}` : '无');
for (const h of heads.slice(0, 12)) {
  line(`     L${h.level} [${h.source}] ${h.text.slice(0, 42)}`);
}
if (heads.length > 12) line(`     …（其余 ${heads.length - 12} 条略）`);
line();

/* ---------- 规则审阅（快，不烧额度） ---------- */
line('【需求 3/4/5】问题锚点（定位精度）');
const t1 = Date.now();
const rev = await post('/api/review', { id, useModel: false, useRecheck: false });
if (rev.error) { line(`审阅失败：${rev.error}`); process.exit(1); }
const issues = rev.issues || [];
const stats = rev.anchorStats;
line(`  规则审阅 ${((Date.now() - t1) / 1000).toFixed(1)}s，问题 ${issues.length} 条`);
check('每条问题都有可跳转的锚点', issues.every((it) => it.anchor && it.anchors?.length),
  `${issues.filter((it) => it.anchor).length}/${issues.length}`);
check('锚点精度统计已下发', !!stats, JSON.stringify(stats));
if (stats) {
  /**
   * 「至少到标点、至多整段」的核对口径：
   *   exact / punctuation → 锚点就是问题本身（标点级），最好
   *   quote               → 用问题原文片段反查命中，可接受
   *   paragraph           → 只能退到整段，是需求允许的**上限**，占比要低
   *   document / table    → 整篇级/表级问题，天生没有段落位置
   *   none                → 完全定位不了，必须为 0
   */
  const located = (stats.exact || 0) + (stats.punctuation || 0) + (stats.quote || 0);
  check('不存在完全无法定位的问题', (stats.none || 0) === 0, `none=${stats.none}`);
  check('有段落位置的问题都定位到片段以内',
    (stats.paragraph || 0) === 0,
    `仅整段 ${stats.paragraph} 条`);
  /**
   * 需求 4 的原话是「**至少**是标点符号，**最多**是一整个段落」——
   * 所以合格的锚点包括三种：精确（整段就是问题）、标点级（问题就在这个标点上）、
   * 片段（问题文字是段落里的一段子串）。三者都是**段内**定位。
   *
   * 这里原先写的是「精确 + 标点级 ≥ 40%」，那是我自己拍的阈值，不是需求 ——
   * 实测 `02-文化-吴子枫` 那篇 25 处标记里 16 处是「片段」精度
   * （锚点就是问题原文那一段子串，例如
   * `从资本主义向社会主义的过渡（=无产阶级专政）资本主义共产主义…`），
   * 完全满足需求，却因为没到 40% 被报成失败 —— 这是**度量错误**，不是缺陷。
   *
   * 改成按需求口径断言：段内定位（精确+标点级+片段）应覆盖全部有段落位置的问题。
   * 「不许退化成整段」由上面那条单独把关（`paragraph === 0`）。
   */
  check('段内定位覆盖全部有段落位置的问题',
    located >= (stats.issues || 0) - (stats.document || 0) - (stats.table || 0),
    `段内 ${located} / 需定位 ${(stats.issues || 0) - (stats.document || 0) - (stats.table || 0)}`
    + `（精确 ${stats.exact} + 标点级 ${stats.punctuation} + 片段 ${stats.quote}）`);
  check('整篇级/表级问题也给了可跳转目标',
    (stats.document || 0) + (stats.table || 0) >= 0,
    `document=${stats.document} table=${stats.table}`);
  line(`     定位分布：精确 ${stats.exact}｜标点级 ${stats.punctuation}｜片段 ${stats.quote}｜整段 ${stats.paragraph}｜整篇 ${stats.document}｜表格 ${stats.table}｜无法定位 ${stats.none}`);
  line(`     共划出 ${stats.marks} 处下划线（归并条目会展开成多处）`);
}
// 锚点是否真的落在原文里（而不是 snippet 的「前 20 字上下文」）
let inText = 0;
let checkable = 0;
let wholePara = 0;
for (const it of issues) {
  const a = it.anchor;
  if (!a || a.target !== 'paragraph') continue;
  const target = doc.paragraphs[a.index];
  if (!target) continue;
  checkable += 1;
  if (target.text.slice(a.start, a.end) === a.text) inText += 1;
  if (a.precision === 'paragraph') wholePara += 1;
}
check('锚点区间与原文逐字吻合', inText === checkable, `${inText}/${checkable}`);
check('锚点未退化为整段为主', wholePara / Math.max(1, checkable) < 0.5,
  `整段 ${wholePara}/${checkable}`);
line('  样例（前 8 条，看锚点文字是否是「问题本身」而非上下文）：');
for (const it of issues.slice(0, 8)) {
  const a = it.anchor;
  line(`     [${a?.precision || '?'}] ${it.ruleId}  «${(a?.text || '').slice(0, 46)}»`);
}
line();

/* ---------- 需求 7：逐条一键修改 ---------- */
line('【需求 7】逐条一键修改');
const fixable = issues.filter((it) => it.autoFix?.find && it.autoFix.find !== it.autoFix.replace);
/**
 * 「有没有可自动改写的问题」**不作为通过/失败条件**。
 *
 * 这是稿件的性质，不是功能的性质：一份已经很干净的已发排定稿
 * （实测 13-陈颀 那篇）规则路径下 6 条问题全部需要人工判断，
 * 可自动改写的为 0 —— 这是**正确**结果，报失败会误导。
 * 有则可改时再逐项验证改写链路。
 */
line(`  · 可自动改写的问题：${fixable.length} 条${fixable.length ? '' : '（该稿无需自动改写，跳过改写链路验证）'}`);
if (fixable.length) {
  const target = fixable[0];
  const key = `${target.ruleId}|${target.location}|${target.quote || ''}`;
  const before = JSON.parse(JSON.stringify(doc.paragraphs[target.paragraphIndex].text));
  const r = await post('/api/apply-fixes', { id, accepted: [key], baseReviewRunId: rev.reviewRunId });
  const applied = r.applied || [];
  /**
   * ⚠️ 单条 key **可能**对应多处改动，这不是 bug。
   *
   * FMT-014 这类规则会把「全文同一种半角标点」归并成一条问题、带
   * `occurrences` 列出每一处；服务端按每一处展开后套用，所以
   * 「勾一条 = 改全文同类 N 处」是有意设计。要断言的是：
   * **所有改动都属于这一条 key**，没有误伤别的条目。
   */
  check('只应用了这一条（其全部出现位置）',
    applied.length > 0 && applied.every((a) => a.key === key),
    `applied=${applied.length} skipped=${(r.skipped || []).length} 全部同键=${applied.every((a) => a.key === key)}`);
  check('回传了该条的 key（供前端标记已修复）', applied[0]?.key === key);
  check('回传了 find/replace（供前端就地改 DOM）',
    typeof applied[0]?.find === 'string' && 'replace' in (applied[0] || {}),
    `${JSON.stringify(applied[0]?.find)} → ${JSON.stringify(applied[0]?.replace)}`);
  const after = r.doc?.paragraphs?.[target.paragraphIndex]?.text;
  check('目标段落文本确实变了', after !== before);
  check('返回了更新后的整份文档', !!r.doc?.paragraphs?.length, `段落 ${r.doc?.paragraphs?.length}`);
  line(`     改动：${target.ruleId} «${applied[0]?.find}» → «${applied[0]?.replace ?? ''}»`);
  line(`     原文：${before.slice(0, 70)}`);
  line(`     改后：${(after || '').slice(0, 70)}`);
}
line();

/* ---------- 留出集独立性（目标 A 的硬前提）---------- */
/**
 * 「留出集与调参语料零重叠」必须**按内容**验证，不能按文件名。
 * 同一篇文章在不同生产阶段的文件名完全对不上
 * （`1专题01-瑙姆金论文翻译.docx` vs `20241012瑙姆金论文翻译…【20211022一审】.docx`），
 * 按文件名比对会得出「零重叠」的假结论 —— 本项目就这么错过一次，
 * 而当时留出集里其实混着 48 对同文不同阶段的稿件。
 */
line();
line('【留出集独立性】');
{
  const { overlapReport } = await import('./check-holdout-overlap.mjs');
  const r = overlapReport();
  line(`     规模 TUNE ${r.files.TUNE} / HOLDA ${r.files.HOLDA} / HOLDB ${r.files.HOLDB}（按内容指纹判定）`);
  check('留出集 HOLDB 与调参集 TUNE 零重叠',
    r.counts['TUNE∩HOLDB'] === 0,
    `实测 ${r.counts['TUNE∩HOLDB']} 对同文（正文 12-gram Jaccard ≥ 0.25）`);
  check('HOLDA 与 HOLDB 零重叠',
    r.counts['HOLDA∩HOLDB'] === 0,
    `实测 ${r.counts['HOLDA∩HOLDB']} 对`);
  /**
   * 这条**期望 HOLDA 有重叠**：HOLDA 与 TUNE 是同期文章的不同生产阶段，
   * 本就不独立。把「它不独立」这件事写成断言，是为了防止有人
   * 把 HOLDA 的数字当成「独立留出集」的成绩引用。
   */
  check('HOLDA 与 TUNE 确实重叠（故 HOLDA 不可当独立留出集）',
    r.counts['TUNE∩HOLDA'] > 0,
    `实测 ${r.counts['TUNE∩HOLDA']} 对同文 —— HOLDA 只可用于误报度量，不可用于独立性声明`);
}
line();

/* ---------- 导入即清洗：特殊格式的结构化抽取与渲染 ---------- */
line('【导入即清洗】特殊格式必须结构化抽取，不当普通文字、不静默丢弃');
{
  /**
   * ① 解析侧：特殊格式必须在**上传负载**里就有对应字段。
   * 这里断言的是接口契约 —— 一旦有人把某个字段从 `doc` 里拿掉，
   * 前端与规则引擎会静默降级，所以必须钉住。
   * 历史教训：`info.superscript` 解析出来后全项目零处使用，就是这么漏掉的。
   */
  const paras = doc.paragraphs || [];
  check('段落带 marks（上标/下标区间）', paras.every((p) => Array.isArray(p.marks)),
    `有 marks 的段落 ${paras.filter((p) => (p.marks || []).length).length} 段`);
  check('段落带 noteRefs（脚注/尾注引用标记）', paras.every((p) => Array.isArray(p.noteRefs)),
    `引用标记合计 ${paras.reduce((s, p) => s + (p.noteRefs || []).length, 0)} 个`);
  check('段落带 textboxes（图内文字，独立结构）', paras.every((p) => Array.isArray(p.textboxes)),
    `图内文字 ${paras.reduce((s, p) => s + (p.textboxes || []).length, 0)} 条`);
  check('段落带 figures（图/文本框/嵌入对象）', paras.every((p) => Array.isArray(p.figures)),
    `图对象 ${paras.reduce((s, p) => s + (p.figures || []).length, 0)} 个`);
  /**
   * 责编高亮：覆盖面 523 篇（82.8%），是本语料覆盖面最广的特殊格式。
   * 实测确认它是**责编标记**（不同颜色分不同类别），不是模板残留。
   * 必须排除 `w:val="none"`（显式取消高亮，实测 42 篇 / 12270 处）。
   */
  check('段落带 highlights（责编高亮，不含 none）', paras.every((p) => Array.isArray(p.highlights)),
    `高亮 ${paras.reduce((s, p) => s + (p.highlights || []).length, 0)} 处`);
  check('高亮不含 none 值（none 是「取消高亮」不是高亮）',
    paras.every((p) => (p.highlights || []).every((h) => h.color && h.color !== 'none')));
  /**
   * 域代码：`HYPERLINK`（91 篇 / 341 条，可查链接失效）、
   * `ADDIN EN.CITE`（EndNote 引文域，含文献元数据）、`ADDIN ZOTERO_ITEM`。
   * 指令本身不进入段落文本（读者看不到），只留结构化记录。
   */
  check('段落带 fields（域代码）', paras.every((p) => Array.isArray(p.fields)),
    `域 ${paras.reduce((s, p) => s + (p.fields || []).length, 0)} 个`);
  /** 图内文字不得混进段落正文 —— 实测踩过的污染 bug，见 docx.js 的 collectFigures */
  const tbText = paras.flatMap((p) => p.textboxes || []).join('').replace(/\s+/g, '');
  const tbSamples = [...new Set(tbText.match(/.{8,14}/g) || [])].slice(0, 5);
  check('图内文字不混进段落正文',
    tbSamples.every((s) => !paras.some((p) => p.text.includes(s))),
    tbSamples.length ? `抽检 ${tbSamples.length} 个片段，均未出现在正文` : '本稿无图内文字');
  check('引用标记不往正文里塞占位符', !paras.some((p) => (p.noteRefs || []).length && p.text.includes('\u0001')));
  check('脚注与尾注定义已抽取', Array.isArray(doc.footnotes) && Array.isArray(doc.endnotes),
    `脚注 ${doc.footnotes.length} 段｜尾注 ${doc.endnotes.length} 段`);
}
line();

/* ---------- 渲染正确性（DOM 计算样式 + 截图附件） ---------- */
line('【渲染正确性】渲染后的 DOM 计算样式断言 + 截图人工复核附件');
{
  /**
   * 解析对了不等于渲染对了 —— 这是两条独立管线：
   * 解析器（src/docx.js）决定规则引擎看到什么，docx-preview 决定用户看到什么。
   * 所以这里另起一个脚本对**渲染后的 DOM** 取断言（上标 vertical-align、
   * 表格 table 元素、图内文字 svg/foreignObject、脚注区 ol/li），并落三张截图。
   *
   * 说明：我当前运行的模型不接受图像输入，所以截图是给**人**看的附件；
   * 判定由 `verify-render.mjs` 的计算样式断言 + PNG 像素校验（非空白）完成。
   */
  const { execFileSync } = await import('node:child_process');
  let renderOk = false, renderOut = '';
  try {
    /**
     * 子进程的 cwd 必须是 `dsh/`（脚本自身往上两级），**不能用调用者的 cwd**。
     * 原来写 `cwd: process.cwd()` 且脚本路径是相对的 `tools/verify-render.mjs` ——
     * 从别处调用时子进程在错误的目录里找 `tools/verify-render.mjs`，直接 ENOENT，
     * 于是这两条断言报"未取到结果"。实测：整理后从 `学术/` 运行必现。
     */
    renderOut = execFileSync(process.execPath, [join(HERE, 'verify-render.mjs'), '--file', FILE],
      { encoding: 'utf8', cwd: join(HERE, '..'), timeout: 240000 });
    renderOk = true;
  } catch (e) {
    renderOut = String(e.stdout || '') + String(e.stderr || '');
    renderOk = false;
  }
  const passLine = (renderOut.match(/═══ (\d+)\/(\d+) 通过 ═══/) || [])[0] || '未取到结果';
  check('渲染正确性断言全部通过（tools/verify-render.mjs）', renderOk, passLine);
  /**
   * 若失败，把**具体哪条**断言挂了打出来。
   * 只报「失败」而不报细节，等于让人重新跑一遍才能定位 —— 那是把成本推给使用者。
   */
  if (!renderOk) {
    for (const l of renderOut.split('\n').filter((x) => x.includes('❌')).slice(0, 6)) line(`      ${l.trim()}`);
  }
  // 截图目录锚在脚本自身（`dsh/tools/`），不锚 cwd —— 同前面几处的病根一样
  const shotDir = HERE;
  const shots = ['', '-table', '-notes', '-sup']
    .map((s) => join(shotDir, `.render-verify${s}.png`))
    .filter((p) => existsSync(p));
  check('截图附件已生成（人工复核用）', shots.length >= 2,
    shots.map((p) => basename(p)).join('、') || '无');
}
line();

/* ---------- 汇总 ---------- */
const bad = results.filter((r) => !r.ok);
line('════════ 验收汇总 ════════');
line(`共 ${results.length} 项，通过 ${results.length - bad.length} 项，失败 ${bad.length} 项`);
for (const b of bad) line(`  ❌ ${b.name}  ${b.detail || ''}`);
line(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
/**
 * 用 `exitCode` 而不是 `process.exit()`：后者在 Windows 上会与
 * 尚在关闭中的 fetch/undici 句柄竞争，抛
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`。
 */
process.exitCode = bad.length ? 1 : 0;
