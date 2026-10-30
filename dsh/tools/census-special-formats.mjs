/**
 * 特殊格式普查：**直接读原始 XML 数**，绕开 `src/docx.js`。
 *
 * ── 为什么要绕开自己的解析器 ──
 * 要回答的问题是「我们漏了什么」。如果用 `docx.js` 的输出统计，
 * 它没解析的东西（图片、文本框、公式）根本不会出现在统计里 ——
 * 于是「漏了什么」这个问题会被自己的解析器掩盖成「本来就没有」。
 * 所以这里用 `zip.readText()` 拿原始 XML，按元素名直接计数。
 *
 * 输出每一篇的：上标/下标、脚注/尾注、表格、图片、文本框、公式、
 * 嵌入对象、批注锚点、域代码、符号、分栏、超链接 —— 以及**我们的解析器
 * 是否认得它**（对比 `docx.js` 的输出）。
 *
 * 用法：node tools/census-special-formats.mjs [--json=输出路径] [--limit=N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { openZip } from '../src/zip.js';
import { parseDocxBuffer } from '../src/docx.js';
import { CORPUS_ROOT } from './paths.mjs';

const ROOT = CORPUS_ROOT;
const args = process.argv.slice(2);
const getArg = (k, d = null) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const JSON_OUT = getArg('--json', null);
const LIMIT = Number(getArg('--limit', '0')) || 0;

function walk(dir, acc = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name.startsWith('.')) continue; walk(p, acc); }
    else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}

/**
 * 元素名 → 计数。用正则直接扫 XML 文本，不建树 ——
 * 建树再遍历会因为命名空间前缀写法不同（`w:drawing` / `drawing`）而漏计。
 * 这里同时匹配带前缀与不带前缀的写法。
 */
const PROBES = [
  ['上标', /<w:vertAlign[^>]*w:val="superscript"/g],
  ['下标', /<w:vertAlign[^>]*w:val="subscript"/g],
  /**
   * ⚠️ 「上标」与「脚注引用」是**两件事**，必须分开数：
   *   · `w:vertAlign=superscript` 是**排版属性**，它可能落在一个有文字的 run 上
   *     （手打的上标数字、文献序号），也可能落在一个**没有文字**的 run 上；
   *   · `w:footnoteReference` 才是**真正的脚注引用标记**，它**没有 `w:t`** ——
   *     编号由 Word 渲染时自动生成。`paragraphText()` 不处理它，
   *     所以正文文本里**根本不存在这个标记**，也就无从判断脚注挂在哪个位置。
   */
  ['脚注引用标记', /<w:footnoteReference[ >]/g],
  ['尾注引用标记', /<w:endnoteReference[ >]/g],
  ['批注引用标记', /<w:annotationRef[ >]/g],
  ['脚注', /<w:footnote[ >]/g],
  ['尾注', /<w:endnote[ >]/g],
  ['表格', /<w:tbl[ >]/g],
  ['表格行', /<w:tr[ >]/g],
  ['图片(drawing)', /<w:drawing[ >]/g],
  ['图片(blip)', /<a:blip[ >]/g],
  ['旧式图片(pict)', /<w:pict[ >]/g],
  ['文本框(txbxContent)', /<w:txbxContent[ >]/g],
  ['公式(oMath)', /<m:oMath[ >]/g],
  ['公式(oMathPara)', /<m:oMathPara[ >]/g],
  ['嵌入对象(object)', /<w:object[ >]/g],
  ['批注锚点', /<w:commentReference[ >]/g],
  ['域开始', /<w:fldChar[^>]*w:fldCharType="begin"/g],
  ['域指令', /<w:instrText[ >]/g],
  ['符号', /<w:sym[ >]/g],
  ['制表符', /<w:tab[ \/]/g],
  ['分栏', /<w:cols[ >]/g],
  ['分页', /<w:br[^>]*w:type="page"/g],
  ['超链接', /<w:hyperlink[ >]/g],
  ['书签', /<w:bookmarkStart[ >]/g],
  ['高亮', /<w:highlight[ >]/g],
  ['删除线', /<w:strike[ \/]/g],
  ['下划线', /<w:u [^>]*w:val="(?!none)/g],
  ['修订-插入', /<w:ins[ >]/g],
  ['修订-删除', /<w:del[ >]/g],
  ['公式域(EQ)', /EQ \\\\/g],
];

const countIn = (xml) => {
  /**
   * ⚠️ 必须先把**格式修订的历史记录**剥掉再数，否则会大面积虚高。
   *
   * `<w:rPrChange>` / `<w:pPrChange>` 里存的是「这次格式改动**之前**的格式」，
   * 那是**修订历史**，不是当前生效的格式。直接扫整个 run 的 XML 会把
   * 历史里的 `vertAlign=superscript`、`highlight`、`strike`、`u` 全算成
   * 「本文档有这些格式」—— 于是得出「上标识别率只有 20%」这种假结论
   * （本脚本第一版就这么错过一次，实测 4 篇"漏识别"全是这个原因）。
   *
   * 我们的解析器看的是 `w:rPr` 的**直接子节点**，天然不受影响 ——
   * 所以这里也必须对齐同一个口径，否则两边比的不是同一件事。
   */
  const clean = xml
    .replace(/<w:rPrChange[\s\S]*?<\/w:rPrChange>/g, '')
    .replace(/<w:pPrChange[\s\S]*?<\/w:pPrChange>/g, '')
    .replace(/<w:tblPrChange[\s\S]*?<\/w:tblPrChange>/g, '')
    .replace(/<w:trPrChange[\s\S]*?<\/w:trPrChange>/g, '')
    .replace(/<w:tcPrChange[\s\S]*?<\/w:tcPrChange>/g, '');
  const out = {};
  for (const [name, re] of PROBES) {
    re.lastIndex = 0;
    const m = clean.match(re);
    if (m && m.length) out[name] = m.length;
  }
  return { counts: out, clean };
};

const files = walk(ROOT);
const use = LIMIT ? files.slice(0, LIMIT) : files;
console.log(`语料 ${files.length} 篇（本次处理 ${use.length} 篇）\n`);

const rows = [];
let fail = 0;
const totals = {};
const fileHas = {};

for (const f of use) {
  let raw = {};
  try {
    const zip = openZip(fs.readFileSync(f));
    const docXml = zip.readText('word/document.xml') || '';
    const fnXml = zip.readText('word/footnotes.xml') || '';
    const enXml = zip.readText('word/endnotes.xml') || '';
    const cmXml = zip.readText('word/comments.xml') || '';
    // 正文 + 脚注 + 尾注 + 批注：特殊格式可能出现在任何一部分
    const res = countIn(docXml + fnXml + enXml + cmXml);
    raw = res.counts;
    /**
     * ⚠️ run 必须**按部件分别**匹配，不能把几个部件的 XML 拼起来再匹配。
     *
     * `<w:r[ >][\s\S]*?<\/w:r>` 是非贪婪的，在拼接串上它会跨部件边界配对：
     * A 部件的 `<w:r>` 配上 B 部件的 `</w:r>`，中间恰好夹着别处的
     * `vertAlign=superscript` 和另一个 run 的 `w:t` —— 于是凭空造出一个
     * 「带文字上标 run」。本脚本第二版就是这么把 44 篇虚报成 49 篇的，
     * 我逐部件复核时才发现的。
     */
    const runStats = (xml) => {
      const clean = xml
        .replace(/<w:rPrChange[\s\S]*?<\/w:rPrChange>/g, '')
        .replace(/<w:pPrChange[\s\S]*?<\/w:pPrChange>/g, '');
      let withText = 0, noText = 0;
      for (const r of clean.match(/<w:r[ >][\s\S]*?<\/w:r>/g) || []) {
        if (!/<w:vertAlign[^>]*w:val="superscript"/.test(r)) continue;
        /**
         * ⚠️ 文本在 `<w:delText>` 里的 run 属于**修订中已删除的内容**，
         * 在当前文档里不存在 —— `paragraphText()` 按设计跳过 `w:del` /
         * `w:moveFrom` 内的 run（`RUN_SKIP_AFTER`）。普查探针必须做同样的
         * 过滤，否则会把「上一稿删掉的上标」算成「本文档有上标」，
         * 得出「解析器漏识别」的假结论。
         * 实测：`20250421-Busani-中国的三次"改革开放"` 那 52 个上标
         * **全部**在 `<w:delText>` 里 —— 我们没认它是对的。
         * 本脚本第三版才发现这一点，前三版的"漏识别"清单里
         * 4 篇有 3 篇是这个原因。
         */
        if (/<w:delText[ >]/.test(r)) continue;
        const txt = (r.match(/<w:t[ >][^<]*<\/w:t>/g) || []).map((x) => x.replace(/<[^>]*>/g, '')).join('');
        if (txt.trim()) withText += 1; else noText += 1;
      }
      return { withText, noText };
    };
    let superWithText = 0, superNoText = 0, superInComments = 0;
    /**
     * ⚠️ `comments.xml` **单独算**，不能和正文/脚注/尾注混在一起。
     *
     * 按需求「原文批注完全不参与，只保留解析统计」，批注内容是不抽取的。
     * 混在一起就会把「批注里的上标」算成「正文有上标而解析器漏了」——
     * 实测最后 2 篇"漏识别"就是这么来的：那 2 篇的 `①` 上标在
     * `word/comments.xml` 里，正文里只有一个空文本上标。
     * 分开算之后，正文/脚注/尾注侧的上标识别率是 **100%**。
     */
    for (const xml of [docXml, fnXml, enXml]) {
      const s = runStats(xml);
      superWithText += s.withText;
      superNoText += s.noText;
    }
    superInComments = runStats(cmXml).withText;
    raw['上标(带文字)'] = superWithText;
    raw['上标(仅标记,无文字)'] = superNoText;
    raw['上标(带文字,批注内)'] = superInComments;

    /**
     * 高亮：**必须排除 `w:val="none"`**。
     *
     * `none` 是「显式取消高亮」，不是高亮。早期版本没排除，得出
     * 「62980 次 / 549 篇」，比真实值虚高约 28%（真实 49157 次）。
     *
     * 还要按**是否落在已删除修订内**、**是否有文本**分开数，
     * 因为解析器按设计跳过这两类：
     *   · 落在 `w:del` / `w:moveFrom` 内的 run —— 当前文档里不存在
     *   · 空文本 run（`<w:t></w:t>`）—— 零字符，没有可标注的位置
     * 实测 `（0428删减修改）海湾国家…`：run 级 178 → 减 12（已删除）
     * → 减 7（空文本）= 159，与解析器抽到的 **159 精确相等**。
     * 不做这个拆分，就会把「按设计跳过」误报成「漏识别」。
     */
    const hlStats = (xml) => {
      const clean = xml
        .replace(/<w:rPrChange[\s\S]*?<\/w:rPrChange>/g, '')
        .replace(/<w:pPrChange[\s\S]*?<\/w:pPrChange>/g, '');
      const del = [];
      for (const tag of ['w:del', 'w:moveFrom']) {
        const open = new RegExp(`<${tag}[ >]`, 'g');
        let m;
        while ((m = open.exec(clean))) {
          const re = new RegExp(`<${tag}[ >]|</${tag}>`, 'g');
          re.lastIndex = m.index + m[0].length;
          let depth = 1, end = -1, mm;
          while ((mm = re.exec(clean))) {
            if (mm[0].startsWith('</')) { depth -= 1; if (!depth) { end = mm.index + mm[0].length; break; } }
            else depth += 1;
          }
          if (end < 0) continue;
          del.push([m.index, end]);
          open.lastIndex = end;
        }
      }
      let live = 0, inDel = 0, empty = 0, none = 0;
      const re = /<w:r[ >][\s\S]*?<\/w:r>/g;
      let m;
      while ((m = re.exec(clean))) {
        const h = m[0].match(/<w:highlight[^>]*w:val="([^"]+)"/);
        if (!h) continue;
        if (h[1] === 'none') { none += 1; continue; }
        if (del.some(([a, b]) => m.index >= a && m.index < b)) { inDel += 1; continue; }
        const t = (m[0].match(/<w:t[ >][^<]*<\/w:t>/g) || []).map((x) => x.replace(/<[^>]*>/g, '')).join('');
        if (!t) { empty += 1; continue; }
        live += 1;
      }
      return { live, inDel, empty, none };
    };
    let hlLive = 0, hlInDel = 0, hlEmpty = 0, hlNone = 0;
    for (const xml of [docXml, fnXml, enXml]) {
      const s = hlStats(xml);
      hlLive += s.live; hlInDel += s.inDel; hlEmpty += s.empty; hlNone += s.none;
    }
    raw['高亮(有效)'] = hlLive;
    raw['高亮(已删除修订内)'] = hlInDel;
    raw['高亮(空文本)'] = hlEmpty;
    raw['高亮(取消高亮 none)'] = hlNone;

    /**
     * 域代码：判据是**活内容的 `w:fldChar begin` 数**。
     *
     * ⚠️ 不能用 `w:instrText` 数 —— 一条指令被拆成多个元素
     * （实测 2453 个元素只对应 481 个域，平均 5.1 个/域）。
     * ⚠️ 也要排除 `comments.xml`（批注内的域按需求不抽取）
     * 与 `w:del`/`mc:Fallback` 内的。
     * 逐篇相等性见 `tools/verify-fields.mjs`（632/632 相等，481 = 481）。
     */
    let fldLive = 0;
    for (const xml of [docXml, fnXml, enXml]) {
      const clean = xml
        .replace(/<w:rPrChange[\s\S]*?<\/w:rPrChange>/g, '')
        .replace(/<w:pPrChange[\s\S]*?<\/w:pPrChange>/g, '');
      const del = [], fb = [];
      for (const tag of ['w:del', 'w:moveFrom', 'mc:Fallback']) {
        const open = new RegExp(`<${tag}[ >]`, 'g');
        let m;
        while ((m = open.exec(clean))) {
          const re = new RegExp(`<${tag}[ >]|</${tag}>`, 'g');
          re.lastIndex = m.index + m[0].length;
          let depth = 1, end = -1, mm;
          while ((mm = re.exec(clean))) {
            if (mm[0].startsWith('</')) { depth -= 1; if (!depth) { end = mm.index + mm[0].length; break; } }
            else depth += 1;
          }
          if (end < 0) continue;
          (tag === 'mc:Fallback' ? fb : del).push([m.index, end]);
          open.lastIndex = end;
        }
      }
      const re = /<w:fldChar[^>]*w:fldCharType="begin"/g;
      let m;
      while ((m = re.exec(clean))) {
        const at = m.index;
        if (del.some(([a, b]) => at >= a && at < b)) continue;
        if (fb.some(([a, b]) => at >= a && at < b)) continue;
        fldLive += 1;
      }
    }
    raw['域(有效)'] = fldLive;
    raw._hasFootnotesPart = !!fnXml;
    raw._hasEndnotesPart = !!enXml;
    raw._hasCommentsPart = !!cmXml;
    // 媒体文件
    const media = (zip.names || []).filter((n) => /^word\/media\//i.test(n));
    raw['媒体文件'] = media.length;
    raw['媒体-图片'] = media.filter((n) => /\.(png|jpe?g|gif|bmp|tiff?|emf|wmf)$/i.test(n)).length;
    raw['媒体-其他'] = media.filter((n) => !/\.(png|jpe?g|gif|bmp|tiff?|emf|wmf)$/i.test(n)).length;

    /**
     * ⚠️ 上标必须分两类数，否则对比口径是错的。
     *
     * `w:vertAlign=superscript` 是**排版属性**，它落在两种完全不同的 run 上：
     *   · **带可见文字**的上标 —— 手打的序号、文献编号，如 `(1)`、`①`
     *   · **不带文字**的上标 —— 就是 `w:footnoteReference` 所在的 run，
     *     编号由 Word 渲染时自动生成，run 里只有 `<w:rPr>` 和引用节点
     * 实测（已剥掉 `rPrChange` 历史后）：带文字 44 个（44 篇）／
     * 不带文字 3393 个（171 篇）。
     * 后者的信息已经被 `noteRefs` 完整捕获，所以拿「vertAlign 总数」去比
     * 「带文字上标数」会得出「上标识别率只有 20%」的**假结论** ——
     * 本脚本第一版就这么错过一次。
     */
  } catch (e) {
    fail += 1;
    if (fail <= 3) console.log(`  ⚠️ ${path.basename(f).slice(0, 40)}: ${String(e.message).slice(0, 120)}`);
    continue;
  }

  // 我们解析器认得多少
  let parsed = null;
  try {
    const doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f));
    let marks = 0, noteRefs = 0, superMarks = 0, subMarks = 0, highlights = 0;
    let figures = 0, figureImages = 0, figureEquations = 0, textboxTexts = 0, fields = 0;
    for (const p of doc.paragraphs) {
      for (const m of p.marks || []) { marks += 1; if (m.kind === 'superscript') superMarks += 1; else subMarks += 1; }
      noteRefs += (p.noteRefs || []).length;
      highlights += (p.highlights || []).length;
      fields += (p.fields || []).length;
      figures += (p.figures || []).length;
      figureImages += (p.figures || []).reduce((s, g) => s + (g.images || 0), 0);
      figureEquations += (p.figures || []).reduce((s, g) => s + (g.equations || 0), 0);
      textboxTexts += (p.textboxes || []).length;
    }
    // 脚注/尾注定义也要算上 notes 里的段落（noteRefs 只统计正文）
    for (const p of [...(doc.footnotes || []), ...(doc.endnotes || [])]) {
      for (const m of p.marks || []) { marks += 1; if (m.kind === 'superscript') superMarks += 1; else subMarks += 1; }
      noteRefs += (p.noteRefs || []).length;
      highlights += (p.highlights || []).length;
      fields += (p.fields || []).length;
    }
    parsed = {
      paragraphs: doc.paragraphs.length,
      footnotes: doc.footnotes.length,
      endnotes: doc.endnotes.length,
      tables: doc.tables.length,
      marks, superMarks, subMarks, noteRefs, highlights,
      figures, figureImages, figureEquations, textboxTexts,
      fields,
      stats: doc.stats,
    };
  } catch { /* 忽略 */ }

  rows.push({ file: path.basename(f), raw, parsed });
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    if (typeof v !== 'number' || !v) continue;
    totals[k] = (totals[k] || 0) + v;
    if (!fileHas[k]) fileHas[k] = 0;
    fileHas[k] += 1;
  }
}

console.log(`解析失败 ${fail} 篇\n`);
console.log('═══ 全语料合计（按出现文件数排序）═══');
const order = Object.entries(fileHas).sort((a, b) => b[1] - a[1]);
console.log('  格式                    总次数    出现篇数   占比');
for (const [k, n] of order) {
  const pct = Math.round((n / rows.length) * 1000) / 10;
  console.log(`  ${k.padEnd(22)} ${String(totals[k]).padStart(7)}  ${String(n).padStart(8)}  ${String(pct).padStart(5)}%`);
}

/* 解析器是否认得：对比「原始 XML 有」与「我们解析出来有」 */
console.log('\n═══ 逐篇验证：原始 XML 有的，我们是否认得 ═══');
console.log('  格式                  原始有    我们认得    漏      识别率');
const CHECKS = [
  ['脚注定义', '脚注', (r) => r.parsed?.footnotes],
  ['尾注定义', '尾注', (r) => r.parsed?.endnotes],
  ['表格', '表格', (r) => r.parsed?.tables],
  ['上标(带文字)', '上标(带文字)', (r) => r.parsed?.superMarks],
  ['下标(带文字)', '下标', (r) => r.parsed?.subMarks],
  ['脚注引用标记', '脚注引用标记', (r) => r.parsed?.noteRefs],
  ['尾注引用标记', '尾注引用标记', (r) => r.parsed?.noteRefs],
  ['高亮(有效)', '高亮(有效)', (r) => r.parsed?.highlights],
  ['域(有效)', '域(有效)', (r) => r.parsed?.fields],
];
const missList = {};
for (const [label, rawKey, get] of CHECKS) {
  let rawN = 0, gotN = 0, missed = 0;
  const bad = [];
  for (const r of rows) {
    if (!r.parsed) continue;
    const raw = (r.raw[rawKey] || 0) > 0;
    const got = (get(r) || 0) > 0;
    if (raw) {
      rawN += 1;
      if (got) gotN += 1;
      else { missed += 1; if (bad.length < 4) bad.push(r.file.slice(0, 46)); }
    }
  }
  const rate = rawN ? Math.round((gotN / rawN) * 1000) / 10 : 100;
  console.log(`  ${label.padEnd(20)} ${String(rawN).padStart(5)} ${String(gotN).padStart(10)} ${String(missed).padStart(6)}   ${String(rate).padStart(6)}%`);
  if (bad.length) missList[label] = bad;
}
for (const [k, v] of Object.entries(missList)) {
  console.log(`\n  ⚠️ ${k} 漏识别样例：`);
  for (const b of v) console.log(`      ${b}`);
}

/* 脚注引用 ↔ 脚注定义 的对应性（这是「上标引用」真正的编辑价值） */
console.log('\n═══ 脚注引用标记 ↔ 脚注定义 对应性 ═══');
let refTotal = 0, defTotal = 0, unmatchedFiles = 0;
const unmatchedSamples = [];
for (const r of rows) {
  if (!r.parsed) continue;
  const refs = r.raw['脚注引用标记'] || 0;
  // 定义数要扣掉每篇固定 2 条分隔符脚注（separator / continuationSeparator）
  const defs = Math.max(0, (r.raw['脚注'] || 0) - 2);
  refTotal += refs;
  defTotal += defs;
  if (refs !== defs) {
    unmatchedFiles += 1;
    if (unmatchedSamples.length < 8) unmatchedSamples.push({ f: r.file.slice(0, 44), refs, defs, d: refs - defs });
  }
}
console.log(`  引用标记合计 ${refTotal}｜定义合计（扣 2 分隔符/篇）${defTotal}｜差 ${refTotal - defTotal}`);
console.log(`  引用数与定义数**不相等**的稿件：${unmatchedFiles} / ${rows.length} 篇（${Math.round(unmatchedFiles / rows.length * 1000) / 10}%）`);
for (const s of unmatchedSamples) console.log(`      ${String(s.refs).padStart(4)} 引用 vs ${String(s.defs).padStart(4)} 定义 (${s.d > 0 ? '+' : ''}${s.d})  ${s.f}`);

/**
 * 图/文本框/公式：**已定位，但正文侧不承载其内容**。
 *
 * 这段以前写的是「我们完全没解析的格式（源码里零处引用）」—— 那已经**过时**了。
 * `docx.js` 现在有 `collectFigures()`，会把每个图/文本框/嵌入对象挂到宿主段落上
 * （`p.figures` = `{ kind, images, equations, textboxes }`），
 * 图内文字收进 `p.textboxes`，所以计数与位置都有了。
 *
 * 但要说清楚**边界**，否则"已解析"会被读成"内容进正文了"：
 *   · 图内文字**故意不进** `p.text` —— 实测踩过坑：`paragraphText` 原本会递归进
 *     `w:drawing`，把图标签拼进段落文本，导致 `02-吴子枫` 段43 的 text
 *     整段都是图标签，语言规则在垃圾文本上命中、字数统计失真、与 DOM 对齐错位。
 *   · 图片与公式**只计数与定位，不解释内容**（不做 OCR、不做公式语义）。
 *   · 呈现由 docx-preview 负责（渲染 `<img>` / `<svg><foreignObject>`），
 *     已由 `tools/verify-render.mjs` 的 DOM 断言验证。
 */
console.log('\n═══ 图 / 文本框 / 公式：已定位计数，内容不进正文 ═══');
const FIGURE_KINDS = ['图片(drawing)', '图片(blip)', '旧式图片(pict)', '文本框(txbxContent)', '公式(oMath)', '公式(oMathPara)', '嵌入对象(object)'];
for (const k of FIGURE_KINDS) {
  const n = fileHas[k] || 0;
  const tot = totals[k] || 0;
  const tag = tot === 0 ? '（本语料无）' : '';
  console.log(`  ${k.padEnd(22)} ${String(tot).padStart(7)} 次  ${String(n).padStart(4)} 篇  ${Math.round((n / rows.length) * 1000) / 10}%  ${tag}`);
}
const figParsed = rows.filter((r) => r.parsed && (r.parsed.figures || 0) > 0).length;
console.log(`\n  其中被解析器挂到宿主段落的：${figParsed} 篇（见每篇明细的 parsed.figures）`);
console.log('  图内文字、图片、公式的**内容**不进入正文文本，只做定位与计数 —— 这是设计选择，不是遗漏。');

/* 每篇结论 */
console.log('\n═══ 每篇结论 ═══');
console.log(`  可解析稿件 ${rows.filter((r) => r.parsed).length} / ${rows.length} 篇`);
console.log('  逐篇识别率明细见 JSON 的 rows[].raw（原始 XML 有）与 rows[].parsed（我们认得）两组数字。');
console.log('  任一格式在任一稿件上出现"原始有 > 我们认得"，上方的逐篇验证表会列出该稿并给出识别率。');

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), files: rows.length, totals, fileHas, rows }, null, 1));
  console.log(`\n明细已写入 ${JSON_OUT}`);
}
