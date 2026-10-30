/**
 * 标题分级器：把「各级标题」的识别从**纯文本正则**升级为**多信号融合**。
 *
 * ── 为什么必须重做 ────────────────────────────────────────────────
 * 原实现（`scanner-format.js` 的 `classifyParagraphs()`）只用一条文本正则：
 *   短行(<60字) 且以 `一、` / `（一）` / `1.` / `（1）` / `①` 开头 → 标题
 *
 * 这条判据有三个硬伤，且都是**结构性**的：
 *   1. **完全不看 OOXML**。`w:pStyle` 与 `w:outlineLvl` 在 `docx.js` 里
 *      早就解析出来了（`properties.style` / `properties.outline`），
 *      样式级的 `w:outlineLvl` 也解析进了 `doc.styles.byId[*].outline`，
 *      但**全代码库零处消费**。于是「样式为 Heading 1–9、不带编号」的标题
 *      —— 也就是 Word 用户最常规的写法 —— **100% 漏检**。
 *   2. **`A.` / `a.` 两种编号形式根本没有正则**。规则库
 *      `journal.headingLevels` 声明了 7 种形态，`headingLevelPatterns` 只实现 5 种。
 *   3. **`t.length > 60` 直接跳过**，长标题一律漏检。
 *
 * 另外全项目存在**三套互不一致**的标题正则（规则库 / `ark.js:485` 分窗 /
 * `tools/dump-structure.mjs`），各覆盖 5 / 3 / 3 级。本模块作为**唯一真源**，
 * 三处都改为调用它。
 *
 * ── 判据优先级（高 → 低）─────────────────────────────────────────
 *   `style`      样式级大纲级别（含 `w:basedOn` 继承链）或样式名 Heading N/标题 N
 *   `outline`    段落级 `w:outlineLvl`
 *   `numbering`  `numPr` → `numbering.xml` 的 `numFmt` + `lvlText` 推出的层级
 *   `text`       文本编号正则（兜底，覆盖没有样式也没有大纲级别的稿子）
 *   `format`     格式启发（居中 / 大于正文 / 加粗 + 独立短行）
 *
 * 前四种是**强信号**，命中即采信；`format` 是**弱信号**，只在前四种全部
 * 无结论时才使用，并且必须同时满足「短行 + 不是正文段特征」，以免把
 * 居中引文、加粗强调句误判成标题。
 *
 * ── 与既有行为的关系 ─────────────────────────────────────────────
 * 本模块**不改变角色分配**（`title`/`abstract`/`keywords`/… 仍由
 * `classifyParagraphs()` 决定），只负责回答「这一段是不是标题、是第几级」。
 * 原有的「带句号但像正文则不算标题」的窄化逻辑保留在调用方。
 *
 * ── 一个**故意没做**的改动：把「加粗短行」升级为标题判据 ──────────
 * 确实有稿件的标题既无编号、也无 `w:outlineLvl`，只有 `bold:true`
 * （实测 `bold` 在真标题上是 true、正文是 false，其余属性完全相同），
 * 于是看起来"加一条 `bold && 短行 → 标题` 就能补上"。
 *
 * 实测后**否决**（`tools/measure-bold-headings.mjs`，632 篇）：
 * 「短行 + 加粗 + 尚未被判为标题」的候选共 **2024 段、分布在 461 篇
 * （占语料 73%）**；剔除明显噪声特征（符号开头/问句结尾/访谈问答/
 * 英文元数据）后仍有 **1685 段、391 篇**。而这 1685 段里绝大多数
 * **根本不是标题**：
 *   · 图表题注 —— `图1：美国白人人口净增长率（%），1800—2020年`、`图1`
 *   · 关键词行 —— `关键词：阿尔都塞；《怎么办》`
 *   · **篇名本身** —— `作为经济基础的国家：对历史唯物主义的再认识`
 *   · 微博截图文字 —— `家庭幸福··恋爱6次，如今单身＋组织粉丝"杀入"某社区`
 * 且居中对齐**分不开**真标题与图表题注（两者都是 `jc=center` + 加粗 + 短行）。
 *
 * 也就是说这条判据会在 62% 的稿件上凭空造出上千个假标题 ——
 * 为了补 19 篇（约 3%）的漏检而污染 391 篇，是明确的负收益。
 * 要做就得叠一串守卫（排除题注 / 关键词 / 篇名 / 截图文字…），
 * 每个守卫都是一处新的误报面，不值得。
 *
 * 那些"完全识别不出标题"的稿件里，相当一部分是 `-现场` 圆桌速记
 * （`丁耘-阿尔杜塞在中国工作坊发言内容整理-现场`），它们**本来就没有标题**，
 * 报零标题是正确结果，不是漏检。
 */

/** 层级编号 → 规则库使用的 `levelN` 名称 */
export function headingLevelName(level) {
  return level ? `level${level}` : '';
}

/** 规则库声明的 7 种编号形态，顺序即层级顺序（与 `journal.headingLevels` 一致） */
export const HEADING_LEVEL_FORMS = ['一、', '（一）', '1.', '（1）', '①', 'A.', 'a.'];

/**
 * 文本编号正则 → 层级。
 *
 * 与原实现的差别：**补齐 `A.` / `a.`**（规则库已声明），并让 `（1）`
 * 与 `①` 各自独立成级（原 `ark.js` 版本把 `（一）` 与 `（1）` 合并成一级）。
 * 每级用**锚定到行首**的正则，避免正文中的「3.」被误判。
 */
const TEXT_PATTERNS = [
  { level: 1, re: /^[一二三四五六七八九十百]+[、．.](?![0-9])/ },
  { level: 2, re: /^[（(][一二三四五六七八九十百]+[）)]/ },
  { level: 3, re: /^\d+[．.](?!\d)/ },
  { level: 4, re: /^[（(]\d+[）)]/ },
  { level: 5, re: /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/ },
  { level: 6, re: /^[A-Z][．.、](?!\w)/ },
  { level: 7, re: /^[a-z][．.、](?!\w)/ },
  // 中文「第 N 节/部分」这类无编号符号的节标题
  { level: 1, re: /^第[一二三四五六七八九十百\d]+[节章部分篇]/ },
  /**
   * 独行数字标题：整段只有一个汉字数字（可带空白），如 `一` / `二`。
   *
   * 实测来源：`02-文化-吴子枫-无产阶级专政…`（已发排定稿）的章节标题
   * 就是「`一` 单独成段、居中」这种排版，全篇 5 个章节标题原本**全部漏检**，
   * 导致该稿被判成「零标题」。
   *
   * 必须**整段就是数字本身**（`^…$`），不能只判行首 —— 否则
   * 「一定要…」「二十年来…」这类正文开头会被误伤。
   * 表内排除见调用处（表格序号列里的「一」不是标题）。
   */
  { level: 1, re: /^[一二三四五六七八九十]+$/, bareNumeral: true },
];

/** 供调用方复用同一套编号形态判据（如「带句末标点的标题」补判） */
export const TEXT_HEADING_PATTERNS = TEXT_PATTERNS;

/**
 * 「这一段是不是文本编号标题」——**唯一的实现**，供全项目复用。
 *
 * ── 为什么要单独导出这个函数 ──
 * 全项目原本存在**三套互不一致**的标题正则：
 *   · `rules/format-rules.json` 的 `journal.headingLevelPatterns`（5 级）
 *   · `src/ark.js` 分窗用的内联正则（3 组）
 *   · `tools/dump-structure.mjs` 的诊断正则（3 组）
 * 本模块的注释早就写了「三处都改为调用它」，但**一直没做** ——
 * 于是分窗时认定的"标题"与界面/规则引擎认定的"标题"可以不是同一批，
 * 窗口可能切在语义单元中间。本函数就是兑现那句话。
 *
 * `maxLen` 默认不限长：早期实现在这里卡 `< 60` 字，导致长标题一律漏检
 * （已发排稿里确有超过 60 字的节标题）。长度该不该限由**调用方**按用途定：
 * 分窗关心的是"语义边界"，长标题同样应该成为边界。
 *
 * `opts.bareNumeral` 控制是否把「独行数字」（`^[一二三四五六七八九十]+$`）
 * 也算标题。默认算 —— 那是已发排稿的真实排版（见 `TEXT_PATTERNS` 里的说明）。
 * 表格序号列里调用方需要显式传 `false` 排除。
 */
export function isTextHeading(t, { maxLen = Infinity, bareNumeral = true } = {}) {
  const s = String(t || '').trim();
  if (!s) return false;
  if ([...s].length > maxLen) return false;
  for (const p of TEXT_PATTERNS) {
    if (p.bareNumeral && !bareNumeral) continue;
    if (p.re.test(s)) return { level: p.level, form: p.re.source };
  }
  return false;
}

/**
 * `numbering.xml` 的 `numFmt` + `lvlText` → 层级。
 *
 * 这是 Word 里**最权威**的层级链：`numPr` 指向 `numId`，`numId` 指向
 * `abstractNum`，`abstractNum` 的第 `ilvl` 层定义了编号格式。
 * 此前 `doc.numbering` 解析出来但**零处读取**，这条链完全没接上。
 *
 * 层级一律按**本刊声明的编号形态**（`journal.headingLevels` =
 * 一、/（一）/1./（1）/①/A./a.）映射，不按 `ilvl` 数值 ——
 * `ilvl` 是作者在 Word 里随手选的，与刊物体例无关。
 *
 * ⚠️ 一个**已知的、经过考虑**的取舍：`lvlText="%1."`（即 `1.`）映射到**三级**。
 * 实测 `01-专题1-范勇鹏-新封建加速主义与历史终结`（已发排定稿）在
 * `一、封建问题的经典讨论` 之下直接用 `1.` 编号的小节，于是层级序列是
 * 一级 → 三级，被 FMT-008 报「层级跳级」。
 *
 * 保留这个映射而不是「按结构压成二级」，理由：
 *   · 本刊体例文本明确把 `1.` 定义为第三级，这是**可核对的成文规范**；
 *     按结构猜会把这个规范悄悄改掉，规则库与实现对不上。
 *   · 已发排定稿全量扫描里（当时记作「103 份」，实为 89 篇 ——
 *     旧分类器把 14 个文件名带「发排」的责编版在审稿也算了进来），
 *     只有这 1 份出现该跳级 ——
 *     如果 `1.` 挂在 `一、` 下是刊物的普遍做法，应该大面积出现。
 *   · 审稿系统的职责是把这类不统一**报出来给责编判断**，而不是替刊物
 *     把它抹平。若编辑部确认这是通行写法，应改 `rules/format-rules.json`
 *     的 `journal.headingLevels`，而不是在这里特判。
 */
export function levelFromNumbering(numFmt, lvlText) {
  const fmt = String(numFmt || '');
  const txt = String(lvlText || '');
  const inParen = /[（(]/.test(txt);
  const hasDot = /[．.]/.test(txt);
  const hasDun = /、/.test(txt);
  switch (fmt) {
    case 'chineseCounting':
    case 'chineseCountingThousand':
    case 'japaneseCounting':
      return inParen ? 2 : 1;
    case 'decimal':
    case 'decimalZero':
      if (inParen) return 4;
      if (hasDun) return 1;
      if (hasDot) return 3;
      return 3;
    case 'decimalEnclosedCircle':
    case 'decimalEnclosedCircleChinese':
      return 5;
    case 'upperLetter':
    case 'upperRoman':
      return 6;
    case 'lowerLetter':
    case 'lowerRoman':
      return 7;
    default:
      return null;
  }
}

/** 样式名 → 层级（英文 Heading N / 中文 标题N / 内置 styleId 如 Heading1） */
export function levelFromStyleName(name, styleId = '') {
  const s = `${name || ''} ${styleId || ''}`.trim();
  if (!s) return null;
  let m = /(?:heading|标题|標題)\s*([1-9])/i.exec(s);
  if (m) return Number(m[1]);
  // 中文「一级标题」/「二级标题」
  const cn = /([一二三四五六七八九])级(?:标题|標題)/.exec(s);
  if (cn) return '一二三四五六七八九'.indexOf(cn[1]) + 1;
  return null;
}

/**
 * 解析样式的**有效**大纲级别，沿 `w:basedOn` 链向上查找。
 *
 * 自定义标题样式（本刊稿件的 `a3`、`标题1`、`Char` 等）自身常常不写
 * `w:outlineLvl`，而是「基于 Heading 1」—— 级别要从父样式继承。
 * 原实现不解析 `w:basedOn`，这类样式永远取不到级别。
 */
export function effectiveStyleOutline(styles, styleId, seen = new Set()) {
  if (!styleId || !styles?.byId) return null;
  if (seen.has(styleId)) return null; // 防御 basedOn 成环
  seen.add(styleId);
  const st = styles.byId[styleId];
  if (!st) return null;
  if (st.outline !== '' && st.outline !== null && st.outline !== undefined) {
    const n = Number(st.outline);
    if (Number.isFinite(n) && n >= 0 && n <= 8) return n + 1;
  }
  const byName = levelFromStyleName(st.name, styleId);
  if (byName) return byName;
  return st.basedOn ? effectiveStyleOutline(styles, st.basedOn, seen) : null;
}

/** 样式的有效字符格式（沿 basedOn 链取第一个有值的） */
export function effectiveStyleFormat(styles, styleId, seen = new Set()) {
  if (!styleId || !styles?.byId) return null;
  if (seen.has(styleId)) return null;
  seen.add(styleId);
  const st = styles.byId[styleId];
  if (!st) return null;
  const out = {
    sizeHalfPt: st.sizeHalfPt ?? null,
    bold: !!st.bold,
    jc: st.jc || '',
    eastAsia: st.eastAsia || '',
  };
  if ((out.sizeHalfPt === null || !out.bold) && st.basedOn) {
    const parent = effectiveStyleFormat(styles, st.basedOn, seen);
    if (parent) {
      if (out.sizeHalfPt === null) out.sizeHalfPt = parent.sizeHalfPt;
      if (!out.bold) out.bold = parent.bold;
      if (!out.jc) out.jc = parent.jc;
      if (!out.eastAsia) out.eastAsia = parent.eastAsia;
    }
  }
  return out;
}

/** 正文段落的代表字号（取众数），用于「比正文大」这一弱信号 */
function bodySizeMode(paras, levels) {
  const counts = new Map();
  for (let i = 0; i < paras.length; i += 1) {
    if (levels[i]) continue;
    const t = (paras[i].text || '').trim();
    if (t.length < 40) continue; // 只统计长段落，避免把标题算进正文基准
    const sz = paras[i].format?.sizeHalfPt;
    if (!sz) continue;
    counts.set(sz, (counts.get(sz) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [sz, n] of counts) {
    if (n > bestN) { best = sz; bestN = n; }
  }
  return best;
}

/**
 * 「看起来像正文」的排除判据。
 *
 * ── 为什么必须加这一层 ────────────────────────────────────────────
 * 在 13 份**已发排定稿**上的实测（`tools/heading-audit.mjs`）显示，
 * 单靠「有样式 / 有编号 / 有大纲级别」会把下面这些**非标题**判成标题：
 *   · 访谈提问段 —— 段落带 `numPr`（继承自列表样式），且含两个以上问号：
 *       「美国社会的『斩杀线』究竟是如何炼成的？『斩杀线』现象背后……？」
 *   · 作者简介 —— `（作者系复旦大学中国研究院副研究员）`
 *   · 提要/导语段 —— 用了标题样式但其实是整段行文
 * 这些段落都有共同特征：**句末有句号、或含多句、或过长**。
 * 真标题不会以句号/分号/逗号收尾，也很少超过 60 字。
 *
 * 注意「？」「！」是**允许**的（如「真实性之争：『斩杀线』话语实质是什么？」），
 * 只排除句号、分号、逗号结尾与多句连缀。
 */
export function looksLikeProse(t, maxLen = 60) {
  const s = String(t || '').trim();
  if (!s) return true;
  if (/[。；，]$/.test(s)) return true;                        // 句末点号 → 行文
  if ((s.match(/[。；]/g) || []).length >= 2) return true;      // 多句 → 行文
  if ((s.match(/[。？！；]/g) || []).length >= 3) return true;   // 三个以上句末点号 → 行文
  if (s.length > maxLen) return true;                          // 过长 → 行文
  if (/^[（(][^）)]*作者系[^）)]*[）)]$/.test(s)) return true;    // 作者简介
  if (/^[（(]?(本文)?作者(系|简介)|作者系/.test(s) && s.length > 12) return true;
  return false;
}

/** 是否像「人名行」（作者署名）：2–4 个汉字，或用顿号/逗号/间隔号并列 */
export function looksLikeAuthorLine(t) {
  const s = String(t || '').replace(/[\s\u3000]/g, '');
  if (!s) return false;
  if (/^[\u4e00-\u9fa5]{2,4}([、,，·][\u4e00-\u9fa5]{2,4})*$/.test(s)) return true;
  // 「张三 李四」两名并列，或带「等」字
  if (/^[\u4e00-\u9fa5]{2,4}(等|著|译)$/.test(s)) return true;
  return false;
}

/** 表题 / 图题：是题注，不是章节标题 */
export function looksLikeCaption(t) {
  return /^\s*[表图]\s*\d+/.test(String(t || ''));
}

/**
 * 主入口：对整篇文档分级。
 *
 * @param {object} doc `parseDocxBuffer` 的产物
 * @param {object} [opts]
 * @param {number} [opts.maxTextLength=120] 文本编号信号的标题长度上限（原为 60，会漏长标题）
 * @param {boolean} [opts.useFormatHeuristic=true] 是否启用格式启发（弱信号）
 * @returns {{
 *   level: (number|null)[],      每段的层级（1 基），非标题为 null
 *   source: (string|null)[],     该层级的判据来源
 *   headings: Array<{index:number, level:number, text:string, source:string}>,
 *   byLevel: Record<number, number>,
 *   bodySizeHalfPt: number|null,
 * }}
 */
export function classifyHeadings(doc, opts = {}) {
  const {
    maxTextLength = 60,
    // 样式/大纲级别是较强信号，长标题（如带副题的标题）比文本编号常见，
    // 所以这里的行文长度上限放宽一些。
    maxStyleLength = 80,
    useFormatHeuristic = true,
    /**
     * 已由调用方判定为**非章节标题**的段落下标（篇名、作者署名、提要、
     * 关键词、作者简介、基金项目等前置区段落）。
     *
     * 为什么需要：篇名段落本身也常常用「标题样式」或比正文大的字号，
     * 单独看与章节标题无异 —— 实测定稿里 `“诚”的寓言：……`（篇名）、
     * 以及主副标题分两段的 `“网左”的身份与困境：` + `当下中文互联网……`，
     * 都会被判成一级标题。调用方（`classifyParagraphs`）已经有完整的
     * 角色判定，把它作为排除集传进来，比在这里重新猜一遍可靠得多。
     */
    excludeIndices = null,
  } = opts;
  const paras = doc?.paragraphs || [];
  const styles = doc?.styles;
  const numbering = doc?.numbering;
  const n = paras.length;
  const level = new Array(n).fill(null);
  const source = new Array(n).fill(null);

  // ── 第一轮：强信号 ──
  //
  // 判据优先级（高 → 低）：
  //   text       文本编号形态（`一、`/`（一）`/`1.`/`（1）`/`①`/`A.`/`a.`）
  //   style      样式级大纲级别（含 basedOn 继承链）或样式名 Heading N
  //   outline    段落级 `w:outlineLvl`
  //   numbering  `numPr` → numbering.xml 的 numFmt + lvlText
  //
  // ⚠️ **`text` 必须排在 `style` 前面**。实测依据：定稿
  // 「10-全球南方-孟静文」里 `一、 议题聚焦：…` 的样式大纲级别是
  // `outlineLvl=1`（→ 二级），但它按本刊约定就是**一级**标题。
  // 本刊的层级是由**编号形态**定义的（`journal.headingLevels` =
  // 一、/（一）/1./（1）/①/A./a.），所以只要段落带编号，
  // 层级就按编号形态定，不信样式的大纲级别。
  // 样式只负责回答「不带编号的标题是第几级」。
  for (let i = 0; i < n; i += 1) {
    const p = paras[i];
    const t = (p.text || '').trim();
    if (!t) continue;
    if (excludeIndices && excludeIndices.has(i)) continue;
    const pr = p.properties || {};

    // 1) 文本编号形态（层级最权威）
    let textLevel = null;
    let isBareNumeral = false;
    for (const { level: lv, re, bareNumeral } of TEXT_PATTERNS) {
      if (re.test(t)) { textLevel = lv; isBareNumeral = !!bareNumeral; break; }
    }
    /**
     * 独行数字标题（`一` / `二` / `三` 单独成段、居中）**不进表格**。
     *
     * 表格单元格里出现一个孤立的「一」是很可能的（序号列、选项列），
     * 而正文里整段只有一个汉字数字，除标题外没有别的解释。
     * 所以这一形态单独加表内排除，其余编号形态不受影响。
     */
    if (isBareNumeral && p.inTable) textLevel = null;
    /**
     * 表图题注**在任何判据下都不是标题**。
     *
     * 原来只在第二轮的弱格式信号里排除了题注，强信号（编号/样式/大纲）
     * 一律放行 —— 于是被排版加了编号或套了样式的题注就混进了标题。
     *
     * 实测（发排定稿全量扫描，旧记录写作「103 份」、实为 89 篇）：3 处「层级跳级」全部由题注造成 ——
     *   · `表1创新的类型` 判成第 5 级，紧跟在一级标题后面 → 一级直接跳到五级
     *   · `表1 中国典型工业博物馆举例` / `表2 中国典型工业博物馆与现代文明`
     *     判成第 4 级，同样造成跳级
     * 题注不是稿件的层级结构，让它们参与层级序列会污染 FMT-008（层级跳级）。
     *
     * 判据用 `looksLikeCaption`（`表1`/`图2`/`附表3`/`资料来源：`…），
     * 它要求「表/图」后面**紧跟数字或中文数字**，所以
     * `表述的边界`、`图式与结构` 这类真标题不会被误伤。
     */
    if (looksLikeCaption(t)) continue;
    if (textLevel && !looksLikeProse(t, maxTextLength)) {
      level[i] = textLevel;
      source[i] = 'text';
      continue;
    }

    /**
     * 字母 + 空格 的自定义层级标题（`A 列宁的构想`）。
     *
     * ⚠️ 这不是规则库声明的那 7 种形态之一 —— 声明的是 `A.`（**带点**）。
     * 带点的 `A.` 按本刊约定就是第 6 级（见 `TEXT_PATTERNS`），层级权威；
     * 而「字母 + 空格」是作者自定义写法，**不能**套第 6 级 ——
     * 实测 `02-文化-吴子枫`（已发排定稿）是 `三`(一级) 下面挂
     * `A 列宁的构想` / `B 斯大林的构想`，若判成第 6 级，
     * 「一级 → 六级」会触发 FMT-008 跳级误报。
     *
     * 正确做法：标记为 `letter`，层级留给第三轮**按结构**定
     * （= 前面最近一级标题的下一级），这样 `三`(1) → `A`(2) 自然成立。
     */
    if (/^[A-Za-z][\s\u3000]+\S/.test(t) && t.length <= maxTextLength && !looksLikeProse(t, maxTextLength)) {
      level[i] = 2;            // 占位，第三轮按结构改写
      source[i] = 'letter';
      continue;
    }

    /**
     * 3) numPr → numbering.xml（**排在样式与段落大纲级别之前**）
     *
     * ── 为什么必须排这么前 ──
     * 本刊的层级是由**编号形态**定义的（`journal.headingLevels` =
     * 一、/（一）/1./（1）/①/A./a.），而 `numbering.xml` 正是这套形态的
     * **机器可读编码**：`numPr` → `numId` → `abstractNum` → 第 `ilvl` 层的
     * `numFmt` + `lvlText`。`lvlText="（%1）"` 就是 `（一）`，按约定是二级。
     *
     * 段落级 `w:outlineLvl` 是**作者自己设的**，经常与所加编号不一致 ——
     * 它描述的是「作者希望它在导航窗格里显示成第几层」，不是本刊的层级。
     * 这与上面「`text` 排在 `style` 前面」是同一条原则，只是换了信号源。
     *
     * ── 实测依据（这条顺序修的是一个真实的层级丢失）──
     * `11-罗楠-能动性视角下肯尼亚…`（已发排定稿）的 17 个标题：
     *   · `全球环境治理体系形成的结构性基础` 等 5 条 → `pStyle="2"`（heading 2），无编号
     *   · `冷战局势变化：…` 等 12 条 → `pStyle="af5"` + `numPr(numId=2, ilvl=0)`
     *     + `w:outlineLvl w:val="1"`
     * 两组的 `w:outlineLvl` **都是 1（0 基）**，于是旧顺序下 17 条全被判成同一级
     * （层级全平）。而 `numId=2 → abstractNum 4 → ilvl=0, lvlText="（%1）"`
     * —— 那 12 条明明是 `（一）（二）（三）`，按约定是**二级**，
     * 5 条无编号的才是它们的一级父级。顺序改对后 5×1 级 + 12×2 级自然成立。
     *
     * ⚠️ 但**不能**因为「段落有 numPr」就认定是标题。
     * Word 的列表编号被大量用于正文（访谈问答、要点罗列），
     * 实测定稿「11-现场-章永乐等」的访谈提问段全部带 numPr。
     * 所以本信号仍要求 `levelFromNumbering()` 给出**标题式**编号形态
     * （中文数字 / 带顿号 / 带点 / 括号数字；`bullet`、`none` 一律返回 null），
     * 且文本不像行文。
     */
    if (pr.numIdNum !== null && pr.numIdNum !== undefined && numbering) {
      const abstractId = numbering.numToAbstract?.[String(pr.numIdNum)];
      const lv = abstractId !== undefined && abstractId !== ''
        ? numbering.abstract?.[abstractId]?.levels?.[String(pr.ilvlNum ?? 0)]
        : null;
      const byNum = lv ? levelFromNumbering(lv.format, lv.text) : null;
      if (byNum && !looksLikeProse(t, maxTextLength)) {
        level[i] = byNum;
        source[i] = 'numbering';
        continue;
      }
    }

    // 4) 样式级大纲级别（含 basedOn 继承链）
    const stLevel = effectiveStyleOutline(styles, pr.style);
    if (stLevel && !looksLikeProse(t, maxStyleLength)) {
      level[i] = stLevel;
      source[i] = 'style';
      continue;
    }

    // 5) 段落级 w:outlineLvl
    if (pr.outlineLevel && !looksLikeProse(t, maxStyleLength)) {
      level[i] = pr.outlineLevel;
      source[i] = 'outline';
      continue;
    }
  }

  // ── 第二轮：格式启发（弱信号，仅在前四种全无结论时用）──
  //
  // ⚠️ 弱信号是**误报的主要来源**，实测必须同时满足三个条件才采信：
  //   ① 字号**严格大于正文基准** —— 作者署名、居中引文通常与正文同号，
  //      这一步就能滤掉「姚云帆」「陈  颀」这类人名行；
  //   ② 加粗或居中（二者至少其一）；
  //   ③ 不像人名行、不像表图题注、不像行文。
  const bodySize = bodySizeMode(paras, level);
  if (useFormatHeuristic) {
    for (let i = 0; i < n; i += 1) {
      if (level[i]) continue;
      if (excludeIndices && excludeIndices.has(i)) continue;
      const p = paras[i];
      const t = (p.text || '').trim();
      if (!t || t.length > 40) continue;
      if (p.inTable) continue;                      // 表内段落不判标题
      if (looksLikeProse(t, 40)) continue;
      if (looksLikeAuthorLine(t)) continue;
      if (looksLikeCaption(t)) continue;

      const st = effectiveStyleFormat(styles, p.properties?.style);
      const size = p.format?.sizeHalfPt ?? st?.sizeHalfPt ?? null;
      const bold = p.format?.bold || st?.bold || false;
      const jc = p.properties?.jc || st?.jc || '';

      const biggerThanBody = Boolean(bodySize && size && size > bodySize);
      if (!biggerThanBody) continue;                // ① 必须比正文大
      if (!bold && jc !== 'center') continue;       // ② 加粗或居中

      // 层级按字号相对正文的增量粗分（大得越多层级越高）
      let lv = 3;
      const delta = size - bodySize;
      if (delta >= 12) lv = 1;
      else if (delta >= 6) lv = 2;
      else if (delta >= 2) lv = 3;
      else lv = 4;
      level[i] = lv;
      source[i] = 'format';
    }
  }

  // ── 第三轮：无编号标题的层级按**结构**校正 ──
  //
  // ⚠️ 这一步解决的是一个真实且高频的错误：**整篇标题全被判成同一级**。
  //
  // 原因：本刊稿件的章节标题有两类写法混用 ——
  //   · 带编号的（`一、` / `（一）`）→ 层级由编号形态定，准确
  //   · 不带编号的（只有「标题」样式）→ 只能靠 Word 的 outlineLvl
  // 而 Word 的 outlineLvl 是**相对篇名**算的：篇名常占 outlineLvl 0，
  // 于是所有章节标题都拿到 outlineLvl 1（→ 我们这边的 2 级）。
  //
  // 实测 13-陈颀 那篇定稿：13 条标题**全是 2 级**，
  // 但 `租房市场中的私营社会信用算法`（无编号）明明是
  // `（一）筛选权力的生成…` 的**父级**，应当是一级。
  // 层级全平会让 FMT-008（层级跳级）彻底失效，界面上也看不出结构。
  //
  // ── 校正规则（保守，只动无编号标题）──
  //   · 编号形态（text/numbering）的层级是**权威**，一律不动：
  //     本刊约定 `一、`=1 级、`（一）`=2 级，不能因为「文档里没有一级」
  //     就把 `（一）` 提成一级。
  //   · 无编号标题：看它**后面最近的编号标题**的层级。
  //     若两者层级**相等**，说明这个无编号标题是那批编号标题的父级，
  //     于是上提一级。不相等就不动（避免把真正的嵌套小标题提上来）。
  //   · 后面没有编号标题时，改用**前面最近**的编号标题按同样规则判断
  //     （`结语` 这类收尾章节就是这种情况）。
  //   · 全篇**一个编号标题都没有**时：这些无编号标题就是文档的章节骨架，
  //     把整体平移到最小层级 = 1（否则会得到「一篇没有一级标题的稿子」）。
  const NUMBERED = new Set(['text', 'numbering']);
  normalizeHeadingLevels(level, source, NUMBERED);

  const headings = [];
  const byLevel = {};
  for (let i = 0; i < n; i += 1) {
    if (!level[i]) continue;
    headings.push({
      index: i,
      level: level[i],
      text: (paras[i].text || '').trim(),
      source: source[i],
      wordIndex: paras[i].index ?? i,
    });
    byLevel[level[i]] = (byLevel[level[i]] || 0) + 1;
  }

  return { level, source, headings, byLevel, bodySizeHalfPt: bodySize };
}

/**
 * 无编号标题的层级按结构校正（第三轮规则，**可重入**）。
 *
 * 抽成独立函数是因为它必须能被调用**两次**：
 *   1. `classifyHeadings()` 内部调一次；
 *   2. `classifyParagraphs()` 在前置区清理（把篇名从标题里摘掉）之后**再调一次**。
 *
 * 为什么第二次是必须的：第一轮跑的时候篇名还被当成一条一级标题
 * （篇名用「标题」样式、outlineLvl 0），于是「全篇最小层级 = 1」，
 * 归一化判不出「这批无编号标题其实是文档的章节骨架」。
 * 篇名被摘掉之后最小层级变成 2，这时才该整体上提。
 *
 * 实测：06-姚云帆、07-楼庭坚、12-马嘉鸿 三篇定稿的章节标题
 * 全靠样式判出、且层级是 2 —— 篇名一摘就该是一级。
 *
 * 可重入的实现方式：先剥掉上次留下的后缀标记，再重新判定，
 * 这样重复调用不会把层级一路减到 1 以下，也不会叠加后缀。
 *
 * @param {number[]} level  段落下标 → 层级（就地修改）
 * @param {string[]} source 段落下标 → 判据来源（就地修改）
 * @param {Set<string>} numbered 哪些来源算「带编号形态」（层级权威、不动）
 */
export function normalizeHeadingLevels(level, source, numbered = new Set(['text', 'numbering'])) {
  const n = level.length;
  const headingIdx = [];
  for (let i = 0; i < n; i += 1) {
    if (!level[i]) continue;
    // 剥掉上一次的校正后缀，保证可重入
    if (source[i]) source[i] = String(source[i]).replace(/\+[a-z]+$/, '');
    headingIdx.push(i);
  }
  const numberedIdx = headingIdx.filter((i) => numbered.has(source[i]));
  const unnumberedIdx = headingIdx.filter((i) => !numbered.has(source[i]));
  if (!unnumberedIdx.length) return;

  /**
   * `letter` 类（`A 列宁的构想`）单独处理：层级 = 前面最近一级标题的下一级。
   *
   * 它不是规则库声明的那 7 种形态（声明的是带点的 `A.`），所以不能套
   * 「字母 = 第 6 级」。实测 `02-文化-吴子枫` 是 `三`(一级) 下挂
   * `A 列宁的构想`，按结构就该是二级。
   * 前面没有可参照的标题时保持占位值 2。
   */
  for (const i of unnumberedIdx.filter((k) => source[k] === 'letter')) {
    const prev = [...numberedIdx].reverse().find((k) => k < i)
      ?? [...headingIdx].reverse().find((k) => k < i && source[k] !== 'letter');
    if (prev !== undefined) {
      level[i] = Math.min(9, level[prev] + 1);
      source[i] = 'letter+structural';
    }
  }
  const rest = unnumberedIdx.filter((k) => !String(source[k]).startsWith('letter'));
  if (!rest.length) return;

  if (numberedIdx.length === 0) {
    const minLv = Math.min(...rest.map((i) => level[i]));
    if (minLv > 1) {
      for (const i of rest) {
        level[i] = Math.max(1, level[i] - (minLv - 1));
        source[i] = `${source[i]}+normalized`;
      }
    }
    return;
  }
  for (const i of rest) {
    const next = numberedIdx.find((k) => k > i);
    const prev = [...numberedIdx].reverse().find((k) => k < i);
    const ref = next !== undefined ? level[next] : (prev !== undefined ? level[prev] : null);
    if (ref === null) continue;
    // 只在「层级相等」时上提：那说明它是这批编号标题的父级
    if (level[i] === ref && level[i] > 1) {
      level[i] -= 1;
      source[i] = `${source[i]}+structural`;
    }
  }
}
