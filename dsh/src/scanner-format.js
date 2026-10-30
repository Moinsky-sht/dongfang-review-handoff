/**
 * 格式体例确定性扫描引擎。
 * 输入：parseDocx() 的结果 + rules/format-rules.json
 * 输出：结构化 issues 列表，每条带位置（段落索引/脚注索引）、原文片段、规则依据、修改建议。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { classifyHeadings, headingLevelName, normalizeHeadingLevels, looksLikeCaption, TEXT_HEADING_PATTERNS } from './headings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = resolve(__dirname, '..', 'rules', 'format-rules.json');

export function loadFormatRules() {
  return JSON.parse(readFileSync(RULES_PATH, 'utf8'));
}

/**
 * 中文语境判断：避免在网址、代码、英文句子、JSON 元数据里误报。
 *
 * 实测踩过的坑：有稿件的脚注里塞了一段期刊数据库导出的 JSON
 * （`publicationTag: AMI核心, CSSCI ... "page":"3-9"`），旧实现只看「前后 12 字里
 * 有没有汉字」，于是把 `: ` 和 `, ` 都报成「中文语境下使用半角标点」。
 * 但中文标点的合法场景是**标点两侧都是中文**；只要紧邻（可跳过空格）出现
 * ASCII 字母或数字，就说明这里在写英文/代码/数据，不该判。
 */
function isChineseContext(text, index) {
  const around = text.slice(Math.max(0, index - 12), index + 12);
  if (/https?:\/\/|www\.|@|\.[a-z]{2,4}\//.test(around)) return false;

  // 取标点紧邻的左右非空白字符。
  //
  // 注意：必须显式判 `l >= 0` / `r < text.length` 再取字符。
  // 早期写成 `while (l >= 0 && /[ \t]/.test(text[l]))`，越界时 `text[l]` 是 undefined，
  // 而 `/[ \t]/.test(undefined)` 会先转成字符串 "undefined" —— 不含空格，故为 false，
  // 循环能正常停下；但 `text[r]` 为 `' '` 时 `/[ \t]/.test(' ')` 为 true，能继续。
  // 真正踩的坑是空串：`/[ \t]/.test('')` 为 **false**（空串匹配零宽），
  // 于是 `right` 取到了空格本身，`asciiWord.test(' ')` 为 false，
  // JSON 元数据里的 `, ` 就漏过了豁免。这里改为直接取字符并用 trim 判断。
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\u3000' || c === '\n' || c === '\r';
  let l = index - 1;
  while (l >= 0 && isSpace(text[l])) l -= 1;
  let r = index + 1;
  while (r < text.length && isSpace(text[r])) r += 1;
  const left = l >= 0 ? text[l] : '';
  const right = r < text.length ? text[r] : '';
  const asciiWord = /[A-Za-z0-9]/;

  // 左侧是 ASCII 字母/数字 → 英文词或数据字段（`Tag:`、`page:`、`2021-2022`）
  if (asciiWord.test(left)) return false;
  // 右侧是 ASCII 字母/数字 → 标点右边在写英文/数据（`AMI核心, CSSCI`）
  if (asciiWord.test(right)) return false;
  // 标点被引号夹住（JSON 的 `"page":"3-9"`）→ 数据字段，不是中文行文
  if (/["']/.test(left) || /["']/.test(right)) return false;

  // 中文标点的合法场景：标点前后都得有汉字
  if (!/[\u4e00-\u9fa5]/.test(left)) return false;
  return /[\u4e00-\u9fa5]/.test(around);
}

const CN = /[\u4e00-\u9fa5]/;

/** 定位：把字符偏移换算成段落内片段 */
function snippet(text, index, len = 60) {
  const start = Math.max(0, index - 20);
  return text.slice(start, Math.min(text.length, index + len));
}

function mkIssue(rule, loc, extra = {}) {
  return {
    ruleId: rule.id,
    category: rule.category,
    group: 'format',
    severity: rule.severity,
    title: rule.title,
    basis: rule.basis || '',
    detail: rule.detail || '',
    fix: rule.fix || '',
    autoFixable: !!rule.autoFixable,
    ...loc,
    ...extra,
  };
}

/* ---------------- 各类检查实现 ---------------- */

/** 把正文段落按「结构角色」分类 */
export function classifyParagraphs(doc) {
  const paras = doc.paragraphs;
  const roles = new Array(paras.length).fill('body');
  const journal = loadFormatRules().journal;
  let abstractIdx = -1;
  let keywordIdx = -1;

  /**
   * 这是不是**非稿件类文档**（编辑部来信 / 审稿意见 / 修改要求）。
   *
   * 语料里混着相当一批不是论文的文件：编辑部发给作者的信、
   * 专家审稿意见、修改反馈、栏目导言……它们**本来就没有标题**，
   * 但早期实现不知道，会硬从前置区里挑一行当标题，挑出来的往往是
   * `您好！`（秦测皓那篇）、`各位老师，下午好~~~` 这种问候语，
   * 然后 FMTB-036 之类的标题规则再去扫它 —— 纯噪声。
   *
   * 判据（实测语料里这几种开头覆盖了绝大多数非稿件）：
   *   · `X老师：` / `X先生：`  —— 书信抬头
   *   · `您好` / `各位老师` / `下午好`  —— 问候
   *   · 含「审稿意见」「专家意见」「修改要求」「修订要求」
   *   · `导  言` 这类栏目导言
   * 只扫前 3 段：真论文开头不会长这样。
   */
  const nonManuscript = (() => {
    const head = paras.slice(0, 3).map((p) => (p.text || '').trim()).filter(Boolean).join('\n');
    if (!head) return false;
    if (/^[\u4e00-\u9fa5]{2,4}(老师|先生|编辑|主编)\s*[:：]/m.test(head)) return true;
    if (/^(您好|各位老师|老师好|下午好|上午好|晚上好)/m.test(head)) return true;
    if (/(审稿意见|专家意见|审读意见|修改要求|修订要求|修改反馈|审稿建议)/.test(head)) return true;
    /**
     * `“Title”审稿意见` / `《Title》审稿意见` —— 英文题名用双引号时上面那条 docLike 认不到。
     * 实测 `“A State as Civilization and Political Theory”审稿意见` 就是这种。
     */
    if (/^[“"《][^”"》]{6,}[”"》]\s*(审稿意见|审读意见|意见|反馈)/.test(head)) return true;
    if (/^导\s*言$/m.test(head)) return true;
    return false;
  })();

  /**
   * 作者简介标记命中。
   *
   * 不能只判「行首」。实测语料里作者简介的常见写法有三种：
   *   · `作者系复旦大学经济学院教授`                     —— 行首
   *   · `（作者系陕西师范大学文学院教授）`               —— **被圆括号包住**（阿尔都塞工作坊那批稿件）
   *   · `【作者简介】张三，复旦大学教授`                 —— 方括号
   * 早期用 `t.startsWith(m)`，于是带括号的写法全部漏检，
   * FMT-001 / FMT-036 在 632 份稿件上把 625 份报成「缺作者简介」（98.9%），
   * 属典型「规则过严」。现在允许标记出现在**开头或紧跟左括号**的位置。
   */
  const markerHit = (t, list) => {
    const s = t.replace(/^[\s\u3000]+/, '');
    return list.find((m) => s.startsWith(m)
      || new RegExp(`^[（(\\[［【]\\s*${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(s));
  };

  /**
   * 带序数前缀的作者简介标记。
   *
   * 第 25 轮实测：语料里作者简介最主流的写法**不是**「作者系…」，
   * 而是**带序数前缀**的「第一作者系…」「第二作者系…」。普查 452 篇含简介段的稿件：
   *
   *   作者系    343 处
   *   第一作者  100 处   ← 全部漏检
   *   第二作者  100 处   ← 全部漏检
   *   第三作者    9 处
   *
   * `authorBioMarker` 列表里只有「作者系」「作者简介」等，而 `markerHit` 要求
   * **整段以标记开头**，于是「第一作者系重庆市委党校…教授」一律认不出
   * → FMT-001（七要素）报「缺作者简介」、FMT-036 报「未识别到作者简介段」。
   * 实测 8 个方旭稿件版本全部因此误报，属典型「规则过严」。
   *
   * ⚠️ 这里**必须是独立函数**，不能并进 `markerHit`。
   * 第 25 轮我先把它写进 `markerHit` 内部，结果 `markerHit(t, abstractMarker)`
   * 也会命中「作者系…」，而摘要判定（scanner-format.js:205）排在作者简介判定之前，
   * 于是**作者简介段被误判成摘要**：`abstractIdx` 指向段尾的作者简介，
   * FMT-001 反而在全部 632 篇上报「缺作者简介」—— 比修复前更糟（516 → 632）。
   * 教训：**判定必须绑定它所属的标记类别**，通用匹配函数里塞特例一定会串味。
   *
   * 判据：段首允许「第X」「通讯」「通信」这类限定词，再接作者类标记；
   * 「作者」之后必须紧跟「系/简介/单位/：/（」等标记性字符或整段结束，
   * 以免把「作者认为」「作者指出」这类正文句误判成简介。
   */
  const authorBioHit = (t) => {
    const s = t.replace(/^[\s\u3000]+/, '');
    const m = /^(?:第[一二三四五六七八九十0-9]+|通讯|通信)?\s*作者\s*(系|简介|单位|[:：，,（(]|$)/.exec(s);
    if (m) return `作者${m[1] === undefined ? '' : m[1]}`;
    return markerHit(t, journal.authorBioMarker || ['作者简介', '【作者简介】', '[作者简介]']);
  };

  /**
   * 标记**残缺**也要认（缺左括号 / 缺右括号）。
   *
   * 实测 05-魏程琳 那几篇的提要行是 `内容提要] 村级民主是实现…`
   * —— 只有右方括号、没有左方括号（作者手滑或转换丢失），
   * `markerHit` 的两种模式都要求有左括号，于是整篇认不出摘要，
   * 连带 FMT-002（提要字数）、FMTB-015（提要起头标记）等规则全部空转。
   * 实测这类稿件 11 篇。
   *
   * 判据：去掉首尾可能残缺的方括号后再比一次，且要求标记后紧跟
   * 冒号或空白（避免把 `内容提要制度` 这种正文词误判成标记）。
   */
  const markerHitLoose = (t, list) => {
    const s = t.replace(/^[\s\u3000]+/, '');
    for (const m of list) {
      /**
       * 标记内部允许夹空白：`[关 键 词]` 必须等同于 `[关键词]`。
       *
       * 实测来源：`12-周驰觐-《火种》…`（已发排定稿）的关键词行写作
       * `[关 键 词]成长小说；都市传奇；工人阶级形象` —— 标记里被排版加了空格。
       * 原来的正则是把标记当**整串**转义的，于是匹配不上：
       * 该行角色落空 → 被当成篇名的一部分，
       * 拼出「《火种》：工人成长叙事与都市传奇的双重变奏[关 键 词]成长小说；…」
       * 这样一条 44 字的假篇名。
       *
       * 改法：**逐字符转义再以 `\s*` 相连**，于是 `关键词` → `关\s*键\s*词`。
       * 对拉丁标记（`Key Words`）同样成立 —— 本来就该容忍空格差异。
       * 段落文本不含换行，`\s*` 不会跨段匹配。
       */
      const core = m.replace(/^[\[［【]|[\]］】]$/g, '');
      const esc = core.split('')
        .map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s*');
      /**
       * 标记之后的分隔符有两种合法形态：
       *   · **带右括号** → 后面可以**直接接内容**（`[关 键 词]成长小说；…`）
       *   · 不带括号     → 必须有冒号或空白（`关键词：…` / `关键词 …`）
       *
       * 原来只实现了第二种，于是 `[关 键 词]成长小说…` 这种
       * 「方括号标记紧跟内容、中间无分隔符」的写法整行落空。
       * 这也是本刊规范本身的写法（`[内容提要]`、`[关键词]` 后面直接接正文），
       * 所以这条分支必须补上。
       */
      if (new RegExp(`^[（(\\[［【]?\\s*${esc}\\s*(?:[）)\\]］】]\\s*[:：]?|[:：\\s])`).test(s)) return m;
    }
    return undefined;
  };

  for (let i = 0; i < paras.length; i += 1) {
    /**
     * 清掉 Word 域代码残留。
     *
     * 实测 07-邹冠男 那篇的标题段文本是
     *   `ADDIN CNKISM.UserStyle世界领导力重塑中的科技自信生成：谈“赢学”的技术基础…`
     * —— `ADDIN CNKISM.UserStyle` 是 CNKI 的 Word 域代码，解析后没被剥掉，
     * 粘在标题前面，于是标题识别失败（首字符不是汉字，长度也被撑长）。
     * 这不是作者写的东西，属解析残留，在这里统一清掉；
     * 同时写回 `paras[i].text`，让后续按文本定位的规则也看到干净的文本。
     */
    const rawText = paras[i].text;
    if (rawText && /^\s*ADDIN\s/i.test(rawText)) {
      const cleaned = rawText.replace(/^\s*ADDIN\s+[A-Za-z0-9_.]+\s*/i, '');
      if (cleaned !== rawText) paras[i].text = cleaned;
    }
    const t = paras[i].text.trim();
    if (!t) { roles[i] = 'empty'; continue; }
    if (markerHit(t, journal.abstractMarker) || markerHitLoose(t, journal.abstractMarker)) { roles[i] = 'abstract'; abstractIdx = i; continue; }
    /**
     * 关键词标记还有两种实测形态必须认：
     *   · `关键词`（**单独成行，没有冒号**，关键词在下一段）—— 05/07-吴畅畅 那批
     *   · `Keywords:` / `Keywords：`（英文稿）—— 瑙姆金那批、英文部分稿
     * 少认一种，那批稿件的关键词类规则（FMT-005/006/007、FMTB-014）就整批空转。
     */
    const bareKeyword = /^关键词\s*$/.test(t);
    const enKeyword = /^(key\s*words?|keywords?)\s*[:：]/i.test(t);
    if (markerHit(t, journal.keywordMarker) || markerHitLoose(t, journal.keywordMarker) || bareKeyword || enKeyword) {
      roles[i] = 'keywords'; keywordIdx = i; continue;
    }
    if (authorBioHit(t)) { roles[i] = 'authorBio'; continue; }
    if (/^(基金项目|【基金项目】|\[基金项目\])/.test(t)) { roles[i] = 'funding'; continue; }
    if (/^(责任编辑|收稿日期|DOI|中图分类号|文献标识码)/.test(t)) { roles[i] = 'meta'; continue; }
    /**
     * 独立成段的**栏目标记**：`【现场】`、`【专题】`、`［书评］`。
     *
     * 实测来源：`08-现场-周雷整理-2024思想者论坛…` 等 3 份现场稿，
     * 首段就是孤零零一个 `【现场】`。它既不是摘要也不是关键词，
     * 前面几条都不命中，于是落到标题判定里 —— 短、居中、字号大，
     * 稳稳被判成篇名，最后和真篇名拼成
     * 「【现场】2024思想者论坛…张维为：文明型国家叙事的异同及其意义」。
     *
     * 判据：**整段就是一个短方括号词组**（无其他内容）。
     * 长度限 8 字以内，避免把 `【基金项目】国家社科基金…` 这类带正文的
     * 行也吞掉 —— 那些行前面已经各自有归属，走不到这里。
     */
    if (/^[【\[［][^】\]］]{1,8}[】\]］]$/.test(t)) { roles[i] = 'meta'; continue; }
    /**
     * 投稿平台/编辑部的附注行（不是稿件内容）。
     *
     * 实测来源：`02-文化-吴子枫-无产阶级专政…`（已发排定稿）首段是
     * `文脉：这篇文章中的强调字体请保留，辛苦！` —— 「文脉」是投稿平台，
     * 这行是平台替编辑转达的要求（请保留强调字体）。它 30pt 加粗，
     * 与真篇名同号，于是被判成篇名并拼进去。
     *
     * 只认**平台名 + 冒号**这一种明确形态，不靠「请」「辛苦」这类
     * 语气词去猜 —— 正文里出现「请注意」太正常了。
     */
    if (/^(文脉|投稿平台|作者来稿|来稿)\s*[：:]/.test(t)) { roles[i] = 'meta'; continue; }
  }

  /**
   * 标题识别：改用统一的多信号分级器（`src/headings.js`）。
   *
   * ── 为什么换掉原来的实现 ──────────────────────────────────────
   * 原实现是「短行(<60字) + 命中编号正则」一条判据，有三个结构性硬伤：
   *   1. **完全不看 OOXML**：`w:pStyle` / `w:outlineLvl` 早就在 `docx.js`
   *      里解析好了，但零处消费 —— 于是「样式为 Heading 1–9、不带编号」的
   *      标题 100% 漏检，而这正是 Word 用户最常规的写法；
   *   2. `A.` / `a.` 两种编号形态规则库声明了却**没有正则**；
   *   3. `t.length > 60` 直接跳过，长标题一律漏检。
   *
   * 实测对比（13 份**已发排定稿**，`tools/heading-audit.mjs`）：
   *   旧判据 90 条 → 新分级器 107 条，且层级归属明显更准
   *   （旧版把 `一、` 开头的标题按样式判成二级，实际是一级）。
   *
   * ── 与前置区判定的先后关系 ───────────────────────────────────
   * 标题识别必须**先于**前置区（题名/作者）判定，因为后者要用
   * `firstHeading` 当前置区搜索上界。所以这里先把标题分级做完，
   * 等前置区判完再回头**清掉**被误判为标题的题名/作者段
   * （见本函数末尾的 `clearFrontMatterHeadings`）。
   */
  const nonBodyRoles = new Set(['empty', 'abstract', 'keywords', 'authorBio', 'funding', 'meta']);
  const excludeIndices = new Set();
  for (let i = 0; i < paras.length; i += 1) {
    if (nonBodyRoles.has(roles[i])) excludeIndices.add(i);
  }
  const headingResult = classifyHeadings(doc, { excludeIndices });
  for (let i = 0; i < paras.length; i += 1) {
    if (roles[i] !== 'body') continue;
    const lv = headingResult.level[i];
    if (!lv) continue;
    roles[i] = 'heading';
    paras[i]._headingLevel = headingLevelName(lv);
    paras[i]._headingSource = headingResult.source[i];
  }

  /**
   * 「带句末标点的标题」补判（FMT-010 的唯一输入）。
   *
   * 分级器把「以 。； 结尾」的段落一律当行文排除（这是对的，否则
   * `（2）Ⅱ类家庭，此类家庭一般缺乏相应地资产配置，以扣除…；` 这类
   * 正文枚举会污染 FMT-008）。但**真·带句号的标题**确实存在，
   * 早期实现因为它永远等不到而让 FMT-010 在 632 份稿件上一次都没触发。
   *
   * 判据（与原实现一致，只是从分级器里分离出来）：以编号形态开头 +
   * **无内部小句标点** + 短。命中则判为标题并打上 `_headingTrailingPunct`，
   * 交给 FMT-010 报「标题末尾不加句号」。
   */
  for (let i = 0; i < paras.length; i += 1) {
    if (roles[i] !== 'body') continue;
    const t = paras[i].text.trim();
    if (!t || t.length > 60) continue;
    if (!/[。；]$/.test(t)) continue;
    /**
     * ⚠️ 判「句内标点」必须**先去掉编号前缀**。
     *
     * `一、` / `A、` 这类编号**自带顿号**，而旧实现直接对整段测
     * `[，,、；;：:]`，于是「一、」形态的带句号标题**被自己排除掉** ——
     * 实测探针 `一、研究背景。` 一个都报不出（FMT-010 的合成用例一直失败）。
     * 改为：先匹配编号形态拿到 `rest`（余下文字），只对 `rest` 测标点与长度。
     * 标题余下部分**允许**有顿号（`政治、经济与文化`），所以 `、` 不再算句内标点；
     * 真正像正文枚举的是 `，；：`。
     */
    let lv = null;
    let rest = t;
    for (const { level, re } of TEXT_HEADING_PATTERNS) {
      const m = t.match(re);
      if (m) { lv = level; rest = t.slice(m[0].length).trim(); break; }
    }
    if (!lv) continue;
    if (/[，,；;：:]/.test(rest) || t.length > 20) continue;   // 像正文枚举 → 当正文
    roles[i] = 'heading';
    paras[i]._headingLevel = headingLevelName(lv);
    paras[i]._headingSource = 'text-trailing-punct';
    paras[i]._headingTrailingPunct = true;
  }

  // 前置区：题目、作者
  //
  // 判据必须严：早期实现只看「位置」——前置区里 `i <= 1` 一律标 title、其余标 author，
  // 于是一份只有「标题 + 一段正文」的文档会把正文段落也标成 title（实测过），
  // 依赖 body 角色的规则（如 FMT-027 段首缩进）就再也看不到正文。
  // 现在改成：先看它像不像标题/作者行，不像就退回 body。
  /**
   * 前置区的上界基准：**强标题**优先。
   *
   * ── 这里修的是一个真实的循环依赖 ─────────────────────────────
   * 标题分级要先于前置区判定（前置区要用 `firstHeading` 当上界），
   * 而分级器又会把**篇名**判成标题 —— 篇名本身常用「标题样式」或
   * 比正文更大的字号，单看与章节标题无异。
   *
   * 后果：`firstHeading` 正好落在篇名上，于是 `i < firstHeading`
   * 对篇名恒为 false，篇名永远进不了 title 分支，
   * 只能留在 heading 里冒充一条三级标题。实测 test.docx 的篇名
   * 「作为经济基础的国家：对历史唯物主义的再认识」就是这样漏的。
   *
   * ── 怎么打破 ─────────────────────────────────────────────
   * 用**强标题**当前置区上界：判据来源是 `text`/`numbering` 的标题，
   * 也就是带编号形态的（`一、`/`（一）`/`1.`/`①`…）。
   * 篇名**不可能**长成编号小标题的样子 —— 这是结构性的区分，
   * 不依赖字号/样式这类会被排版习惯影响的外观信号。
   *
   * 没有强标题时退回原来的「首个 heading」，行为不变。
   */
  const firstStrongHeading = paras.findIndex((p, i) => roles[i] === 'heading'
    && (p._headingSource === 'text' || p._headingSource === 'numbering'));
  /**
   * 没有强标题时（通篇只有样式/字号判出的标题），**跳过开头两段**再找上界。
   *
   * 理由：文档最前面的两段如果是弱标题，那几乎必然是篇名/副标题本身，
   * 而不是章节小标题。拿它当上界会让前置区退化成只有第 0 段，
   * 篇名（尤其「主标题：」+「副标题」分两段写的）就再也没机会被纠正 ——
   * 实测 07-楼庭坚 那篇正是如此：全文无编号标题，
   * `地理环境决定论的学术史实践：` 与 `梁启超“孔北老南”说发微`
   * 两段一起被当成了一级标题。
   */
  const firstHeading = firstStrongHeading >= 0
    ? firstStrongHeading
    : roles.findIndex((r, i) => r === 'heading' && i >= 2);
  const abstractPos = roles.indexOf('abstract');
  const keywordPos = roles.indexOf('keywords');
  /**
   * 前置区（题名/作者）的搜索上界。
   *
   * 关键修正：**摘要在前、标题在后**的稿件原先完全识别不出标题。
   *
   * 实测语料里前置区有两种排布：
   *   · 常规：标题 → 作者 → 摘要 → 关键词        （`limit` 取 abstractPos 是对的）
   *   · 工作坊/现场稿：摘要 → 关键词 → 空行 → **标题** → 正文
   *     （如 07/10-姚云帆 那两篇：roles = abstract,keywords,empty,empty,body,…）
   * 后者的标题落在 abstractPos 之后，被上界挡在外面，于是
   * 「标题段零命中」—— 所有标题类规则（FMT-004/010/036 等）在这类稿件上全部空转，
   * 而总量指标完全看不出来（这正是目标点 8 要防的那类缺陷）。
   *
   * 所以上界改为取「摘要、关键词、首个编号小标题」三者中**最靠后**的那个，
   * 再留 3 段余量（标题与关键词之间常夹空行）。
   */
  /**
   * 前置区搜索锚点。
   *
   * ⚠️ `firstHeading` 也是锚点之一，且必须算进去。
   *
   * 下面 `limit` 取「最靠后的锚点 + 4」，而 `frontCeil` 已经把上界夹在
   * `firstHeading + 1`。所以把首个 heading 当锚点，效果正好是
   * 「**允许检查到首个 heading 本身**，但一步也不越过它」。
   *
   * 为什么需要：有一类现场/圆桌稿的**篇名就是首个 heading**
   * （`【现场】` → `编者按：…` → 空行 ×11 → 篇名 → 章节标题），
   * 篇名之前既没有摘要也没有关键词，于是 `anchors` 为空、`limit` 退化成 6，
   * 篇名（第 17 段）根本进不了循环 —— 实测
   * `5现场-章永乐等-殖民帝国史视野下的区域国别研究与涉外法治` 就是这样，
   * 篇名留在 heading 里，194 字的编者按被兜底当成篇名。
   */
  const anchors = [abstractPos, keywordPos, firstHeading].filter((x) => x >= 0);
  /**
   * 上界要**含**紧邻首个编号小标题的那一段，但整体不得超过 8 段。
   *
   * 07/10-姚云帆 那两篇的排布是
   *   摘要(0) → 关键词(1) → 空行(2,3) → **标题(4)** → 编号小标题(5) → 正文(6)
   * 首个 heading 在 5，如果上界取 `i < firstHeading` 就把标题（4）挡在外面。
   *
   * 但也不能无限放宽：实测某篇把**文末落款**（`《东方学刊》孙程姣`、`2024年9月4日`，
   * 在第 11、12 段）当成了标题 —— 那篇首个 heading 很靠后。
   * 前置区不会超过 8 段，所以再加一道 8 段硬顶。
   *
   * ⚠️ 这个 8 段硬顶**必须只数非空段**。
   *
   * 实测来源：`5现场-章永乐等-殖民帝国史视野下的区域国别研究与涉外法治`
   * （已发排定稿）的排布是
   *   `【现场】`(0) → `编者按：…`(1–4) → **空行 ×11**(5–16) → **篇名**(17) → 章节标题(21…)
   * 前置区实际只有 5 个非空段，但按绝对下标数就是 17 段 ——
   * 硬顶取 8 直接把篇名（第 17 段）挡在搜索范围之外，
   * 于是篇名留在 heading 里，而 194 字的编者按被 `detectMeta` 的兜底当成篇名。
   *
   * 改成「非空段满 8 段才收口」：常规稿件的空行本来就不该占前置区额度，
   * 而多出来的额度被 `firstHeading + 1` 夹住，不会溢出到正文。
   */
  const frontCeil = (() => {
    const hardCap = Math.min(firstHeading >= 0 ? firstHeading + 1 : 12, paras.length);
    let seen = 0;
    for (let i = 0; i < hardCap; i += 1) {
      if (!(paras[i].text || '').trim()) continue;   // 空行不占额度
      seen += 1;
      if (seen > 8) return i;                        // 第 9 个非空段起不再算前置区
    }
    return hardCap;
  })();
  /**
   * `+ 4` 而不是 `+ 3`：循环是 `i < limit`（上界不含），
   * 07-姚云帆 那篇 关键词(1) → 空行(2,3) → 标题(4)，
   * 取 `maxAnchor + 3 = 4` 恰好把标题挡在外面（差一位）。
   * 空行余量按 3 段算，加回不含的上界就是 +4。
   */
  const limit = anchors.length
    ? Math.min(Math.max(...anchors) + 4, frontCeil)
    : Math.min(6, frontCeil);
  /**
   * 中文标题长度上限。
   *
   * 原值 40 是早期拍的。实测它把真标题挡在外面：`美国与俄罗斯在“后苏联空间”的
   * “混合战争”战略比较研究：以2014年乌克兰危机为例` 是 41 字（引号多、字数被撑起来），
   * 恰好差一位。全语料里有 12 篇真稿件因此识别不到标题。
   *
   * 用文件名（≈标题）量了长度分布：P50=31 P75=44 P90=59 —— 40 字只覆盖 72.5%。
   * 但文件名里含作者名/标注，是上界。所以上限取 60：既不挡真标题，
   * 又仍在「文件名 P90」之内。
   *
   * 放宽会不会把正文吞成标题？前置区的位置约束（见下）
   * 已经限制在「首个编号小标题之前」，正文进不来，所以是安全的。
   */
  const TITLE_MAX = 60;
  /**
   * 西文标题的长度上限单独一档。
   *
   * `TITLE_MAX = 40` 是按**中文字符**定的（中文标题信息密度高，40 字已经很长），
   * 但同样一句话用英文写会长得多：实测 150 篇前 6 段内疑似英文标题行
   * P50 = 44 字、P90 = 81 字、P95 = 101 字，≤90 字覆盖 93.3%。
   * 用 40 字去卡英文，`A State as Civilization and Political Theory`（44 字）
   * 这种标准英文标题会被直接判成正文 —— 实测 12/150 篇英文稿就是这样全军覆没。
   */
  const TITLE_MAX_LATIN = 90;
  /** 是不是拉丁字母为主的文本（英文稿/英文摘要） */
  const isLatin = (s) => {
    const letters = (s.match(/[A-Za-z]/g) || []).length;
    const total = [...s].length || 1;
    return letters / total >= 0.5;
  };
  /** 该行允许的标题长度上限 */
  const titleLimitFor = (s) => (isLatin(s) ? TITLE_MAX_LATIN : TITLE_MAX);
  /**
   * 是不是一个「人名行」。
   *
   * 中文姓名 2—4 字，可能带间隔号（少数民族名）、空格（「孟 捷」）或并列（「张三　李四」）。
   * 这一条必须先于 titleLike 判断：否则「潘亚玲」这种 3 字纯姓名行会满足
   * `t.length <= 40 && 无句末标点`，被误判成标题 —— 实测 03-潘亚玲 那篇就是这样，
   * 结果作者要素报缺失、FMT-001 假报。
   */
  const looksLikeNameLine = (s) => {
    const core = s.replace(/[\s\u3000]/g, '');
    if (!core || core.length > 12) return false;
    // 纯中文姓名（含间隔号）
    if (/^[\u4e00-\u9fa5]{2,4}([·•][\u4e00-\u9fa5]{2,6})?$/.test(core)) return true;
    /**
     * 西文姓名行。
     *
     * 实测 03-潘亚玲 那篇前置区里作者行是 `PAN Yaling`（姓全大写 + 名首字母大写），
     * 长度 10、无句末标点，被标题识别吞成 title。英文稿前置区里
     * `Ivan N. Timofeev` 这类也一样。
     * 判据：1—3 个词，每词首字母大写，允许全大写词与缩写点。
     *
     * 但**不能只靠词形**：实测这两类也会匹配上，都是误判：
     *   · `Andrey V. Vinogradov, Dr. Sc.`            —— 姓名 + 学位
     *   · `Center for Contemporary China Studies`    —— 机构名（三个首字母大写的词）
     * 所以再加两条排除：含学位/职称缩写，或含机构关键词。
     */
    if (/^([A-Z][A-Za-z'’.-]*)(\s+[A-Z][A-Za-z'’.-]*){1,2}$/.test(s.trim())
      && !/\b(Dr|Prof|Ph\.?D|Sc\.?D|M\.?A|B\.?A|Jr|Sr)\b\.?/i.test(s)
      && !/\b(Center|Centre|Institute|University|College|School|Department|Academy|Studies|Research|Faculty|Laborator|Foundation|Bureau|Oriental|Sciences|Society|Association|Council|RAS)\b/i.test(s)) return true;
    // 并列作者：2—3 个姓名用空格/顿号分隔
    const parts = s.split(/[\s\u3000、,，]+/).filter(Boolean);
    if (parts.length >= 2 && parts.length <= 4
      && parts.every((p) => /^[\u4e00-\u9fa5]{2,4}([·•][\u4e00-\u9fa5]{2,6})?$/.test(p))) return true;
    return false;
  };

  /**
   * 是不是「作者行」——姓名后紧跟单位/职称，或前面带机构。
   *
   * 实测语料里作者行的写法至少四种（都是真稿件里出现的）：
   *   · `潘亚玲`                                    纯姓名
   *   · `朱羽（上海大学文学院）`                      姓名 + 括号单位
   *   · `吴子枫（江西师范大学阿尔都塞与批评理论研究中心）`
   *   · `北京大学法学院博士研究生 朵悦`               单位职称 + 空格 + 姓名
   * 前三种只要放宽长度就能识别；第四种是「单位在前」，必须单独判，
   * 否则会被当成正文段落，FMT-001 就假报「缺作者」。
   */
  const AUTHOR_LINE_MAX = 40;
  const looksLikeAuthorLine = (s) => {
    const t = s.trim();
    if (!t) return false;
    if (/[。；]$/.test(t)) return false;
    /**
     * 「作者：单位」这种**元信息行**。
     *
     * 实测 01-孟捷 那篇前置区里有一行 `作者：复旦大学经济学院`，
     * 长度 11、无句末标点、也不匹配下面的姓名/单位模式，
     * 于是被标题识别吞成 title —— FMTB-036（标题中不使用选择性标点）
     * 会把它当标题扫，标题类统计也被污染。
     */
    if (/^(作者|作者简介|责任编辑|收稿日期|基金项目|译者)\s*[:：]/.test(t)) return true;
    /**
     * 「Key Words:」/「Keywords:」/「Abstract:」/「[内容摘要]」行同理。
     *
     * 03-潘亚玲 那篇前置区是
     *   中文标题 / 英文标题 / PAN Yaling / Key Words: American Racism, …
     * 其中 `Key Words: …` 有逗号、无句末标点，也被吞成 title。
     * 长度上限对它不适用（实测这条 83 字），所以这个判断放在长度检查**之前**。
     */
    if (/^(key\s*words?|keywords?|abstract|内容提要|内容摘要|摘要)\s*[:：]?/i.test(t)
      && /[:：\]]/.test(t)) return true;
    /**
     * 「[俄]维塔利·瑙姆金（Vitaly Naumkin）」这类**带国别标记的译者/作者行**。
     *
     * 译文稿前置区常见 `[俄]`/`[美]`/`[英]` + 姓名 + 括号外文名，
     * 实测长度 26 字，超过 AUTHOR_LINE_MAX（40 其实够，但下面的
     * 姓名/单位模式都匹配不上），所以单独判。
     */
    if (/^[\[［【][\u4e00-\u9fa5]{1,3}[\]］】]\s*[\u4e00-\u9fa5·•]{2,20}/.test(t)) return true;
    if (t.length > AUTHOR_LINE_MAX) return false;
    if (looksLikeNameLine(t)) return true;
    // 姓名 + 括号单位/职称
    if (/^[\u4e00-\u9fa5]{2,4}([·•][\u4e00-\u9fa5]{2,6})?[（(][^）)]{2,40}[）)]$/.test(t)) return true;
    // 单位/职称 + 空格 + 姓名（如「北京大学法学院博士研究生 朵悦」）
    const m = t.match(/^(.*?)[\s\u3000]+([\u4e00-\u9fa5]{2,4})$/);
    if (m && /[\u4e00-\u9fa5]/.test(m[1]) && !/[，。；：]/.test(t)) {
      // 前半段须是机构/职称语，而不是一句叙述
      if (/(大学|学院|研究院|研究所|中心|系|社|编辑部|博士|硕士|研究生|教授|副教授|讲师|研究员|助理研究员|编审|博士后|院长|主任|所长|系主任)/.test(m[1])) return true;
    }
    return false;
  };
  for (let i = 0; i < limit; i += 1) {
    const t = paras[i].text.trim();
    /**
     * 前置区判定要能**重新审视弱标题**。
     *
     * 原来这里是 `roles[i] !== 'body'` 一律跳过，于是被分级器判成标题的
     * 篇名再也没机会被纠正 —— 实测 test.docx 的篇名
     * 「作为经济基础的国家：对历史唯物主义的再认识」就是卡在这一行，
     * 一直冒充三级标题，连带污染 FMT-008 的层级序列和标题类规则。
     *
     * 放开的口子只针对**弱标题**（判据来源 style/outline/format：
     * 样式、大纲级别、字号加粗居中）—— 这些正是篇名的外观特征。
     * **强标题**（来源 text/numbering，即带 `一、`/`（一）`/`1.` 编号形态的）
     * 仍然排除：篇名不可能长成编号小标题，那是结构性区分。
     *
     * 位置约束（`i < limit`，且 limit 已被首个强标题夹住）保证了
     * 这里只会看到前置区段落，不会把正文里的标题拉进来重判。
     */
    const strongHeading = roles[i] === 'heading'
      && (paras[i]._headingSource === 'text' || paras[i]._headingSource === 'numbering');
    if (!t || strongHeading) continue;
    if (roles[i] !== 'body' && roles[i] !== 'heading') continue;
    const props = paras[i].properties || {};
    const fmt = paras[i].format || {};
    const centered = props.jc === 'center';
    const bigFont = (fmt.sizeHalfPt || 0) >= 30;
    const nameLike = looksLikeNameLine(t);
    const authorLine = looksLikeAuthorLine(t);
    // 标题：短、无句末标点，且**不是姓名行/作者行**
    const latin = isLatin(t);
    /**
     * 标题不会以冒号收尾。
     *
     * 实测 11-朵悦 那篇前置区里有 `《乡土中国·无讼》有这样一段论述：`
     * —— 长度 17、无句末标点，看着完全像标题，其实是**引出引文的正文句**。
     * 冒号结尾是「后面还有话」的信号，标题不会这样写。
     */
    const endsWithColon = /[:：]$/.test(t);
    /**
     * 「主标题：」+「副标题」分两段写的篇名。
     *
     * 上面 `endsWithColon` 的判据（冒号结尾 = 后面还有话 = 不是标题）
     * 对**引出引文的正文句**是对的，但会误伤一种真实排布：本刊不少稿件的
     * 篇名写成两段，第一段以冒号收尾、第二段是副标题 ——
     * 实测 07-楼庭坚 那篇就是
     *   `地理环境决定论的学术史实践：` / `梁启超“孔北老南”说发微`。
     *
     * 区分：冒号后面那一段**本身也像标题**（短、无句末标点、不是署名行），
     * 才是分两段的篇名；若下一段是长正文或引文，就仍是引出引文的句子。
     */
    const nextT = (paras[i + 1]?.text || '').trim();
    const splitTitle = endsWithColon && i <= 1 && !!nextT
      && nextT.length <= titleLimitFor(nextT)
      && !/[。；]$/.test(nextT)
      && !looksLikeAuthorLine(nextT)
      && !/[:：]$/.test(nextT);
    /**
     * 关键词列表行不是标题。
     *
     * 07-吴畅畅 那篇前置区漏了一行 `粉丝；政治；敌我意识；狂热；日常生活实践`
     * —— 分号分隔的并列词串，被判成 title。
     * 判据：分号 ≥3 个，且没有句末标点（标题里不会这样用分号）。
     */
    const semiCount = (t.match(/[；;]/g) || []).length;
    const keywordListLike = semiCount >= 3;
    /**
     * 带**内部小句标点**的**长**行不是标题 —— 但判据必须很窄。
     *
     * 实测某篇正文首段 `第一，时间尺度。我们大兴区域国别研究，为的是一个多长时段的事业？`
     * 长 32 字、以问号结尾（`titleLike` 只排除 `。；`），被判成 title。
     *
     * 两版都翻过车，记下来：
     *   · 第一版无条件用 `[，,、：:？?]` → 150 篇里 **64 篇标题识别不出来**。
     *     原因是中文标题用冒号是常态（`作为经济基础的国家：对历史唯物主义的再认识`），
     *     顿号也常见。把冒号/顿号当「正文信号」等于把大量真标题判死。
     *   · 第二版只按长度（>24 字）→ 仍误伤 `从“工程学社会主义”到“军事社会主义”：读阿尔都塞《怎么办？》`
     *     这类长标题。
     *
     * 现在的判据 —— 三条**同时要求「有标点信号」和「够长」**，缺一不可。
     *
     * 定这条规则的过程（两版都翻过车，记下来）：
     *   · 第一版无条件用 `[，,、：:？?]` → 全语料 64 篇标题识别不出来。
     *     中文标题用冒号、顿号是常态，把标点当「正文信号」等于把真标题判死。
     *   · 第二版只按长度（顿号 >24 字）→ 误伤
     *     `中美科技竞争背景下美国对华出口管制的演变、动因及应对`（26 字，真标题），
     *     全语料 35 篇漏识别里它占大头。
     *
     * 后来把语料里 66 条「含全角冒号、无句末标点、位于前 8 段」的行全部列出来逐个看，
     * 分布是干净的两段：
     *   真标题  总长 4—45 字，**不含句号**，冒号前一般无逗号
     *   正文/审稿意见  总长 92—923 字，含句号，逗号 4—38 个
     * 中间没有重叠。所以：
     *   1. 行内有句号 `。` → 正文（标题里绝不会出现句号）
     *   2. 总长 > 60 且冒号后有逗号/顿号 → 正文
     *   3. 总长 ≥ 60 且冒号前有逗号 → 正文
     *
     * 第 3 条的长度条件是量出来的：`文章中存在不少知识性和规范性的差错，具体类型如下：`
     * 是 25 字 —— 这条正是要挡的审稿意见引导句，但它**不够长**。
     * 而无条件的「冒号前有逗号」会把真标题
     * `从“工业党”“入关学”到“赢学”，网络键政如何超越新启蒙话语`（30 字）、
     * `双向奔赴，思政课的灵魂在于“真”字`（18 字）一并否掉。
     * 加上「≥60 字」后，真标题（≤45 字）全保留，长的正文引导句照挡。
     * 实测这条 25 字的引导句漏挡，代价只是少一个「非标题」判断，可接受。
     */
    const len = [...t].length;
    /**
     * 西文元数据行不是标题。
     *
     * 实测英文稿前置区长这样（瑙姆金那批）：
     *   Non-West Model: Is There Such a Thing as a Civilization State?
     *   Publication:  Social Sciences
     *   Topic:  Philosophy & Ideology
     *   Source: Vol. 52, No. 1 (2021), pp. 50-64
     *   Author: Vitaly Naumkin, Full Member of the Russian Academy
     *   DOI: http://dx.doi.org/10.21557/SSC.66175049
     * 放宽西文标题长度（TITLE_MAX_LATIN=90）之后，Publication/Topic/Source/Author
     * 这几行全被当成标题 —— 标题段命中里 LANG-021（` 1 (2021), pp.`）、
     * CIT-018（HYPERLINK 链接）就是这么来的，纯噪声。
     * 判据：以这些元数据关键词开头，或以 DOI/卷期页格式开头。
     */
    const latinMeta = /^(publication|topic|source|author|doi|journal|volume|vol\.|issue|abstract|keywords?|key\s*words?|received|accepted|published|copyright|issn|isbn)\b/i.test(t)
      || /^(vol\.|no\.)\s*\d/i.test(t)
      || /\bpp?\.\s*\d/.test(t);
    /**
     * 冒号要认三种写法。
     *
     * 实测金方廷那篇用的是 `∶`（U+2236 RATIO，数学比号），
     * 形近但不是全角冒号 `：`（U+FF1A）—— 只认 U+FF1A 会漏。
     */
    const COLON = /[：:∶]/;
    const beforeColon = t.split(COLON)[0];
    const afterColon = t.split(COLON).slice(1).join('：');
    /**
     * 第四条信号：`《长题名……》审稿意见`。
     *
     * 实测语料里有整篇都是审稿意见的文档，其首行是
     * `《铸牢中华民族共同体意识法治保障的地方实践：“尼江问题”及其解决的法律地理学省思》审稿意见`
     * —— 长 40 字、无句号，看着像标题，其实是**文件名式的说明行**。
     * 判据：以书名号包住长题名、且以「审稿意见/意见/反馈」收尾。
     */
    const docLike = /^《[^》]{20,}》\s*(审稿意见|审读意见|意见|反馈|修改意见)/.test(t);
    /**
     * `latinMeta` 不附加 `latin` 条件。
     *
     * 第一版写成 `latin && latinMeta`，结果 `Source: Vol. 52, No. 1 (2021), pp. 50-64`
     * 漏掉了 —— 这行字母占比不到一半（数字和标点多），`isLatin` 为 false。
     * 但 `Source:` 开头本身就足够定性，不需要再看语言比例。
     */
    const proseLike = /。/.test(t)
      || (len > 60 && /[，,、]/.test(afterColon))
      || (len >= 60 && /[，,]/.test(beforeColon))
      || docLike
      || latinMeta;
    const titleLike = t.length <= titleLimitFor(t) && !/[。；]$/.test(t) && !authorLine
      && (!endsWithColon || splitTitle) && !keywordListLike && !proseLike;
    /**
     * 位置约束用**结构**判，不用绝对下标。
     *
     * `i <= 3` 是按「标题在最前面」的常规排布定的。但语料里有第二种排布
     * ——摘要 → 关键词 → 空行 → **标题** → 正文（工作坊/现场稿，如 07/10-姚云帆）——
     * 那里标题落在第 5 段，绝对下标一卡就漏。
     *
     * 改成结构判据：**标题只可能出现在「前置区标记行之后、首个编号小标题之前」**。
     * 这既覆盖两种排布，又天然挡住正文（正文在首个 heading 之后）。
     * 前置区里已标为 abstract/keywords/authorBio/funding/meta 的段落，
     * 上面的循环已经 `continue` 掉、不会走到这里，所以不必再排除。
     */
    const beforeFirstHeading = firstHeading < 0 || i < firstHeading;
    /**
     * 例外：**篇名本身就是首个 heading** 时，允许它落在上界上。
     *
     * 上界 `firstHeading` 取的是「首个 heading 的下标」，判据是 `i < firstHeading`
     * —— 这对「篇名在首个章节标题之前」的常规排布是对的。但有一类现场/圆桌稿
     * 的排布是：
     *   `【现场】`（栏目标记）→ `编者按：…`（编者按，几百字）→ 空行 ×N → **篇名** → 章节标题
     * 此时**篇名就是首个 heading**（`i === firstHeading`），`i < firstHeading` 恒为 false，
     * 篇名于是留在 heading 里，而 194 字的编者按被 `detectMeta` 的兜底当成篇名。
     *
     * 实测来源：`5现场-章永乐等-殖民帝国史视野下的区域国别研究与涉外法治`
     * （已发排定稿），篇名段是 52pt 加粗居中，正文 24pt、其下的发言人小节 30pt。
     *
     * ── 判据 ──
     *   · 该段由弱信号 `format` 判出（不是带编号的强标题 —— 篇名不会长成 `一、`）
     *   · 居中
     *   · 比**次大的 heading** 大出 `titleSizeGapHalfPt`（默认 16 半磅 = 8pt）
     *
     * ── 关于这个阈值（需求 C：魔法常数必须给依据或可配置）──
     * 已从代码常量移入 `rules/format-rules.json` 的 `journal.titleSizeGapHalfPt`，
     * 依据与敏感度都记在配置里。要点：
     *   · 实测 632 篇中满足前三条的 162 个样本，gap 直方图为
     *     0:23 2:15 4:42 6:25 8:14 11:9 12:12 **14:2** | **16:6** 20:1 22:7
     *     —— 0–12 密集、14 骤降到谷底、16 回升，阈值落在凹陷上沿
     *   · 该分支只影响 14/632 篇；取 14/16/18 差别 ≤2 篇
     *   · 试过用「篇名是全文最大字号」替代这个阈值（非阈值判据）：
     *     它选中 180 篇、是现行 14 篇的严格超集，多出的 166 篇 gap 只有
     *     0–6 半磅（0–3pt）—— 那是**正常的章节层级差**（一级 14pt vs 二级 12pt），
     *     当篇名就错了。所以「取最大值」太宽，断层判据在做实事。
     */
    const sizeGapTitle = (() => {
      if (i !== firstHeading) return false;
      const p = paras[i];
      if (p._headingSource !== 'format') return false;
      if (p.properties?.jc !== 'center') return false;
      const mine = p.format?.sizeHalfPt;
      if (!mine) return false;
      // 配置项允许写成 { value: 16, … } 或直接写数字，两种都认
      const raw = journal?.titleSizeGapHalfPt;
      const need = Number(typeof raw === 'object' && raw !== null ? raw.value : raw);
      const gap = Number.isFinite(need) && need > 0 ? need : 16;
      let next = 0;
      for (let k = 0; k < paras.length; k += 1) {
        if (k === i || !paras[k]._headingLevel) continue;
        const s = paras[k].format?.sizeHalfPt || 0;
        if (s > next) next = s;
      }
      return mine >= next + gap;
    })();
    /**
     * 非稿件类文档不标标题。
     *
     * 编辑部来信 / 审稿意见本来就没有标题，硬挑一行只会挑出
     * `您好！` 这种问候语（实测秦测皓那篇就是），再交给标题类规则去扫。
     * 宁可不标，也不标错 —— 下游 hasTitle 检查会据此报「缺标题」，
     * 对这类文档来说是**正确**的结论。
     */
    if (nonManuscript) continue;
    /**
     * 表格里的段落既不是篇名也不是署名。
     *
     * 实测 `09-专题2-Busani-中国的三次"改革开放"…`（已发排定稿）：
     * 表格单元格里的 `指标` 被当成署名行，与真署名拼成
     * `布萨尼·恩卡韦尼刘  迪   译指标`。表格单元格都是短行、居中、
     * 无句末标点 —— 外观上与署名行无法区分，但**结构上**它在表格里，
     * 而稿件的前置区（题名/署名）不会写在表格里。
     * 标题分级器对 `format` 弱信号早就加了同样的表内排除，这里补齐。
     */
    if (paras[i].inTable) continue;
    /**
     * 表图题注不是篇名。
     *
     * 同一份稿件的 `表1 主要经济指标同比增长率`（24pt 居中）被判成 title，
     * 于是篇名变成「中国自1970年代以来的三次开放和经济改革：基于全球南方的视角
     * 表1 主要经济指标同比增长率」这样一条 49 字的假篇名。
     * 判据复用标题分级器里的 `looksLikeCaption`（`表1`/`图2`/`资料来源：`…），
     * 避免两处各写一套。
     */
    if (looksLikeCaption(t)) continue;
    if (authorLine) {
      roles[i] = 'author';
    } else if (i <= 1 && titleLike && (centered || bigFont || i === 0)) {
      roles[i] = 'title';
    } else if (titleLike && (beforeFirstHeading || sizeGapTitle) && (centered || bigFont)) {
      /**
       * 中英文都用这一条，但长度上限不同（见 TITLE_MAX_LATIN）。
       *
       * 早期实测过「放宽位置会让多出来的标题里混入正文首句」——
       * 那是因为当时用的是 `i <= 3` 这种绝对下标 + 无 heading 上界。
       * 现在加了 `beforeFirstHeading`，实测 150 篇里
       * 「一篇多个标题」从 51 篇降到与改动前持平，且不再吞正文。
       *
       * ── 为什么还要加 `(centered || bigFont)` ──
       * 位置约束（`beforeFirstHeading`）**不够**，它只是「在首个强标题之前」，
       * 而「首个强标题」的位置会随判据优先级变化。
       *
       * 实测：`11-罗楠-能动性视角下肯尼亚…`（已发排定稿）把编号信号提到
       * 样式/大纲之前后，首个强标题从第 8 段变成第 10 段，
       * 于是第 8 段的 `全球环境治理体系形成的结构性基础`（`pStyle="2"`，
       * 一条正常的一级章节标题）落进了篇名窗口，被判成**第二个篇名**，
       * 层级被前置区清理抹掉 —— 16 个标题里凭空少了一个。
       *
       * 补上外观显著性就挡住了：篇名必然是**居中或大字号**的，
       * 而该段 `jc` 为空、字号继承样式（`sizeHalfPt` 为 null）——
       * 是一条普通左对齐章节标题，不满足 `centered || bigFont`。
       *
       * 这条件不会误伤真篇名：本刊篇名一律居中或大于正文
       * （`bigFont` 取 30 半磅 = 15pt，而正文通常 21–24 半磅）。
       */
      roles[i] = 'title';
    }
    // 其余保持 body —— 前置区里的长段落本来就不是标题
  }

  /**
   * 前置区清理：把「标题分级器判成标题、但前置区已判定为篇名/署名」的段落还原。
   *
   * 为什么需要：标题分级**必须先于**前置区判定（后者要用 `firstHeading`
   * 当搜索上界），于是分级器在跑的时候还不知道哪几段是篇名。而篇名本身
   * 常常用「标题样式」或比正文更大的字号，单独看与章节标题无异 ——
   * 实测定稿里 `“诚”的寓言：……`（篇名）、以及主副标题分两段的
   * `“网左”的身份与困境：` + `当下中文互联网左翼意识形态浅析`，
   * 都会被判成一级标题，进而让 FMT-008 的层级序列从篇名就开始算。
   *
   * 这一步是**幂等**的：只把 role 已是 title/author 的段落上的 heading
   * 标记清掉，不产生新的判定。
   */
  for (let i = 0; i < paras.length; i += 1) {
    if (roles[i] !== 'title' && roles[i] !== 'author') continue;
    if (paras[i]._headingLevel === undefined) continue;
    delete paras[i]._headingLevel;
    delete paras[i]._headingSource;
    delete paras[i]._headingTrailingPunct;
  }

  /**
   * 前置区清理之后**重跑一次层级结构校正**。
   *
   * 为什么必须重跑：第一轮分级时篇名还在标题集合里（篇名用「标题」样式、
   * outlineLvl 0 → 一级），于是「全篇最小层级 = 1」，结构校正判不出
   * 「这批无编号标题其实是文档的章节骨架」。篇名摘掉之后最小层级变成 2，
   * 这时才该整体上提。
   *
   * 实测：06-姚云帆、07-楼庭坚、12-马嘉鸿 三篇定稿的章节标题全靠样式判出、
   * 层级原本是 2（因为篇名占了 1），摘掉篇名后正确落回 1 级。
   * 函数本身可重入（会先剥掉上次的后缀再判），所以重复调用是安全的。
   */
  const levelArr = [];
  const sourceArr = [];
  for (let i = 0; i < paras.length; i += 1) {
    levelArr[i] = paras[i]._headingLevel
      ? Number(String(paras[i]._headingLevel).replace('level', '')) || 0
      : 0;
    sourceArr[i] = paras[i]._headingSource || '';
  }
  normalizeHeadingLevels(levelArr, sourceArr);
  for (let i = 0; i < paras.length; i += 1) {
    if (!paras[i]._headingLevel) continue;
    paras[i]._headingLevel = `level${levelArr[i]}`;
    paras[i]._headingSource = sourceArr[i];
  }

  return { roles, abstractIdx, keywordIdx, nonManuscript, headingResult };
}

export function scanFormat(doc, options = {}) {
  const cfg = loadFormatRules();
  const journal = cfg.journal;
  const rules = new Map(cfg.rules.map((r) => [r.id, r]));
  const R = (id) => rules.get(id);
  const issues = [];
  const info = [];
  const { roles, abstractIdx, keywordIdx } = classifyParagraphs(doc);
  const paras = doc.paragraphs;

  /** 按角色索引段落下标：roleIndex.get('abstract') → [段落下标, ...] */
  const roleIndex = new Map();
  roles.forEach((r, i) => {
    if (!roleIndex.has(r)) roleIndex.set(r, []);
    roleIndex.get(r).push(i);
  });

  const bodyParas = paras.filter((_, i) => roles[i] === 'body');
  const bodyText = bodyParas.map((p) => p.text).join('\n');

  /* --- FMT-001 构成要素 --- */
  {
    /**
     * 第 29 轮修：**栏目差异必须作用于七要素检查**。
     *
     * 编辑批注原文（实测语料，11-朱羽-阿尔都塞的教益）：
     *   「外国人名不加英文备注和given name的译名就全文统一吧，
     *     【现场】栏目的格式性要求可以稍低一些。」
     *
     * 这是**编辑自己说的**：现场栏目的格式要求更低。而原实现不知道这件事 ——
     * 实测「现场/圆桌/工作坊/发言」类稿件 71 篇，FMT-001 **100.0%（71/71）**
     * 报「缺内容提要、关键词、作者简介」。这类稿件是**会议发言记录**，
     * 天然没有提要、关键词，作者简介也常无（发言人是与会学者，文末不附简介）。
     *
     * 本刊已有栏目差异机制（FMTB-006 专题 / FMTB-021 调研 / FMTB-022 书评
     * 都不设提要关键词），现场栏目属同一类，此前被漏掉。
     *
     * 判据用**文件名 + 正文体例语言**双轨：
     *   · 文件名含「现场/圆桌/工作坊/发言」—— 实测 61 篇；
     *   · 正文含会议记录体例语言（「下面请」「有请…老师」「谢谢…老师的发言」
     *     「发言内容整理」「录音整理」等）—— 实测仅 10 篇。
     * 收紧后的正文判据在真实论文上**误报 0 篇**（早期版本用 /工作坊/ 会命中
     * 王绍光《我与国家能力研究》这类**正文提到**工作坊的正常论文，故收窄为体例语言）。
     */
    const src = String(doc.label || '').replace(/\\/g, '/');
    const allText = paras.map((p) => p.text).join('\n');
    const isLive = /(现场|圆桌|工作坊|发言)/.test(src)
      || /(下面请|有请[^。]{0,12}(老师|教授|先生|女士)|谢谢[^。]{0,8}老师的发言|发言内容整理|发言稿整理|录音整理|文字整理|本刊编辑部整理|与会者发言|圆桌讨论|现场提问|现场答问|问答环节)/.test(allText);

    const missing = [];
    const hasTitle = roles.includes('title') && paras.some((p, i) => roles[i] === 'title' && p.text.trim());
    if (!hasTitle) missing.push('题目');
    if (!roles.includes('author')) missing.push('作者');
    /**
     * 现场栏目豁免：编辑明说格式要求更低，且这类稿件（会议发言记录）
     * 天然不设提要、关键词、作者简介。故只保留「题目、作者、正文」三项。
     */
    if (abstractIdx < 0 && !isLive) missing.push('内容提要');
    if (keywordIdx < 0 && !isLive) missing.push('关键词');
    if (!roles.includes('authorBio') && !isLive) missing.push('作者简介');
    info.push({
      id: 'FMT-001',
      label: '构成要素',
      value: missing.length ? `缺 ${missing.join('、')}` : (isLive ? '齐备（现场栏目，格式要求从宽）' : '齐备'),
    });
    if (missing.length) {
      issues.push(mkIssue(R('FMT-001'), { location: 'document', quote: '' }, {
        message: `稿件缺少规范要求的要素：${missing.join('、')}`,
        suggestion: `按「题目、作者、内容提要、关键词、简短引言、正文、作者简介」的次序补齐：${missing.join('、')}`,
      }));
    }
  }

  /* --- FMT-002 摘要标记：第 27 轮已删除（与 FMTB-015 100% 重复） --- */
  /**
   * 原实现：若提要段不以 `[内容提要]` 起头，报「提要标记不规范」。
   *
   * 第 27 轮删除，理由是实测的**完全重复**：632 篇里 FMT-002 报 101 篇、
   * FMTB-015 报「内容提要的起头标记不规范」**也是同样那 101 篇**，
   * 交集 101、仅 FMT-002 报 **0** 篇、仅 FMTB-015 报 **0** 篇。
   * 同一篇同一个问题报两遍。
   *
   * 与第 26 轮 FMT-005 的处置同一形态：**保留 FMTB-015**，因为它的规则文本
   * 明确承担这件事（「摘要的起头标记用方括号形式的「[内容提要]」…
   * 不使用「摘要：」等无括号形式」）且同时覆盖关键词标记。
   *
   * FMT-002 原本还带 `autoFix`（把标记自动改成 `[内容提要]`），
   * 那是它相对 FMTB-015 的唯一增量。但 autoFix 只在规则**报出问题**时才生效，
   * 而 FMTB-015 已经把问题报出来，所以自动修复能力并未丢失
   * —— 若要让该能力可用，应把 autoFix 挂到 FMTB-015 上。
   * （FMT-002 在规则库中仍保留为规则条目，供规则管理页展示其条文。）
   */

  /* --- FMT-003 摘要长度 --- */
  if (abstractIdx >= 0) {
    /**
     * 先剥掉起头标记再数字数。标记变体要一次性覆盖齐全：
     * `[内容提要]`（规范写法）、`内容摘要`/`摘要`（非规范但确实出现），
     * 以及缺右括号、带冒号等形态。否则 `[内容摘要]` 这种**只有标记、没有正文**
     * 的段落会被当成「6 字提要」误报——实测 29 篇命中里含此类假阳性。
     * 剥完为空（n === 0）时按「提要缺失」处理（见下方护栏），不报长度。
     */
    const t = paras[abstractIdx].text
      .replace(/^\s*[\[［【]?\s*(?:内容提要|内容摘要|摘\s*要)\s*[\]］】]?\s*[:：]?\s*/, '')
      .trim();
    const n = [...t].length;
    const [lo, hi] = journal.abstractCharRange;
    info.push({ id: 'FMT-003', label: '内容提要字数', value: `${n} 字` });
    /**
     * ⚠️ `n === 0`（提要段只有标记、无正文）**不报**。
     *
     * 旧实现照报「内容提要 0 字，超出 150—400 字区间」—— 这是**误导**：
     * 提要缺失不是「字数超标」，且建议「补充研究对象、方法与核心结论」像是
     * 在让作者补写一段并不存在的提要。实测这类命中的 quote 为空、
     * 与编辑批注重合率 0（见 `data/verify/规则误报台账.md`）。
     * 提要缺失归「要素完整性」与人工判断，长度规则只管非空的提要。
     */
    if (n > 0 && (n < lo || n > hi)) {
      issues.push(mkIssue(R('FMT-003'), {
        location: `paragraph:${paras[abstractIdx].index}`, paragraphIndex: abstractIdx, quote: t.slice(0, 60),
      }, {
        message: `内容提要 ${n} 字，超出 ${lo}—${hi} 字区间`,
        suggestion: n < lo ? '补充研究对象、方法与核心结论' : '压缩提要，删去与正文重复的铺陈',
      }));
    }
  }

  /* --- FMT-004 摘要与引言重复 --- */
  if (abstractIdx >= 0) {
    const a = paras[abstractIdx].text.replace(/^[\[［【]?内容提要[\]］】]?/, '');
    const introCandidates = paras.slice(abstractIdx + 1).filter((p, i) => {
      const idx = abstractIdx + 1 + i;
      return roles[idx] === 'body' && p.charCount > 80;
    }).slice(0, 3);
    const grams = (s) => new Set(Array.from({ length: Math.max(0, s.length - 5) }, (_, i) => s.slice(i, i + 6)));
    const ag = grams(a);
    for (const p of introCandidates) {
      const pg = grams(p.text);
      let inter = 0;
      for (const g of pg) if (ag.has(g)) inter += 1;
      const ratio = pg.size ? inter / pg.size : 0;
      if (ratio > 0.35) {
        issues.push(mkIssue(R('FMT-004'), {
          location: `paragraph:${p.index}`, paragraphIndex: paras.indexOf(p), quote: p.text.slice(0, 60),
        }, {
          message: `引言与内容提要重合度约 ${(ratio * 100).toFixed(0)}%，规范要求「简短引言区别于内容提要」`,
          suggestion: '重写内容提要，突出研究对象、方法与结论；引言改为切入问题',
        }));
        break;
      }
    }
  }

  /* --- FMT-005 关键词分隔符 --- */
  if (keywordIdx >= 0) {
    const t = paras[keywordIdx].text.trim();
    /**
     * ⚠️ 第 26 轮**删掉了这里的「关键词起头标记」检查** —— 它与 FMTB-015 完全重复。
     *
     * 实测 632 篇：FMT-005 报「标记不合规」97 篇，FMTB-015 报「关键词起头标记不规范」
     * 也是**同样那 97 篇**，交集 97、仅 FMT-005 报 0 篇、仅 FMTB-015 报 0 篇 ——
     * **100% 重复**，同一篇稿件同一个问题报两遍。
     *
     * 保留 FMTB-015 的理由：它的规则文本本来就明确写着这件事
     * （「关键词用「[关键词]」…不使用「摘要：」「关键词：」等无括号形式」），
     * 且同时覆盖摘要标记；FMT-005 的规则文本里「以 [关键词] 标记起头」只是定语，
     * 主语是「并以分号分隔」。所以标记归 FMTB-015，FMT-005 只留分隔符。
     *
     * 另修一处误报：分隔符检查原先把**英文关键词的逗号**也判违规
     * （`Key Words: American Racism, Demographic Crisis, Privilege`）。
     * 西文关键词用逗号是通行惯例，本刊也只要求中文关键词用全角分号
     * —— 已过审层的西文关键词同样用逗号。故只对**含汉字**的关键词行判分隔符。
     */
    const hasHan = /[\u4e00-\u9fa5]/.test(t);
    const body = t.replace(/^[\[［【]?(关键词|关键字)[\]］】]?[:：]?/, '');
    if (hasHan) {
      const seps = { '；': (body.match(/；/g) || []).length, '，': (body.match(/，/g) || []).length, ',': (body.match(/,/g) || []).length, '、': (body.match(/、/g) || []).length };
      const bad = Object.entries(seps).filter(([k, v]) => k !== '；' && v > 0);
      if (bad.length) {
        const used = bad.map(([k]) => k).join('');
        issues.push(mkIssue(R('FMT-005'), {
          location: `paragraph:${paras[keywordIdx].index}`, paragraphIndex: keywordIdx, quote: body.slice(0, 60),
        }, {
          message: `关键词使用了「${used}」作分隔符，本刊规范用全角分号「；」`,
          suggestion: '把所有分隔符统一替换为「；」',
          autoFix: { find: used, replace: '；' },
        }));
      }
    }
  }

  /* --- FMT-006 关键词数量 --- */
  if (keywordIdx >= 0) {
    /**
     * 剥掉关键词标记，只留关键词本体。
     *
     * 第 26 轮修：原判据 `/^[\[［【]?(关键词|关键字)[\]］】]?[:：]?/` **只认中文标记**，
     * 于是英文稿的 `Key Words: American Racism, …` / `Keywords: civilization-state`
     * 整个标记都留在正文里，导致两个连环误报：
     *   · FMT-006 把标记也算成一个关键词 → 数量偏多；
     *   · FMT-007 拿「Key Words: American Racism」当**一个关键词**去量长度（26 字）→
     *     报「过长（26 字），疑为整句而非名词性短语」。实测 FMT-007 的 61 篇命中里
     *     绝大多数都是这种**整串**而不是单个关键词。
     * 另有两种实测形态也要认：标记残缺的 `关键词] xxx`、单独成行的 `关键词`。
     *
     * 注意 `[:：]?` 必须限定在**标记紧邻处**，不能写成可跳空格的形式 ——
     * `关键词 国家；社会` 里的空格是分隔符，跳过去会把标记和第一个关键词粘在一起。
     */
    const stripKwMarker = (s) => s
      .replace(/^\s*(?:[\[［【]\s*(?:关键词|关键字|Key\s*Words?|Keywords?)\s*[\]］】]\s*[:：]?|(?:关键词|关键字|Key\s*Words?|Keywords?)\s*[\]］】]\s*[:：]?|(?:关键词|关键字|Key\s*Words?|Keywords?)\s*[:：]?)\s*/i, '')
      .trim();
    const t = stripKwMarker(paras[keywordIdx].text);
    /**
     * 关键词切分。
     *
     * 分隔符除了「；;，,、」，还要认空白：
     *   · **连续空白**（2 个以上）—— 实测「美国种族主义  人口危机  经济危机  规范危机」
     *     只按标点切会当成 1 个（24 字），同时误报 FMT-006（1 个，不在 3—8 内）
     *     和 FMT-007（24 字过长），实际是 4 个合规短语；
     *   · **单个空格**（第 26 轮新增）—— 实测中文稿用单空格分隔同样常见：
     *     「关键词：工程学社会主义 军事社会主义 具体处境（情况）绝对历史主义」
     *     只按连续空白切会当成 **1 个 29 字**的关键词。
     *
     * 为什么单空格对**中文**安全：中文关键词是名词性短语，内部不用空格断词
     * （实测 968 个中文关键词段，按单空格切分后最长 14 字，
     *  p99=7 字 —— 中文关键词里就没有靠空格连写的多词短语）。
     * 所以**只对含汉字的行按单空格切**，纯西文行仍只按标点和连续空白切
     * —— 西文关键词本来就含空格（`Rural people communication`），
     * 按单空格切会把它拆成 3 个词，反而误报。
     */
    const hasHan = /[\u4e00-\u9fa5]/.test(t);
    /**
     * 末尾还常带一个**收尾标点**（`…Normative Crisis.`、`…历史叙事。`）——
     * 它是关键词表的分隔标点，不是关键词的一部分，去掉再量长度，
     * 否则西文关键词会平白多算 1 个字符。
     */
    const kws = (hasHan ? t.split(/[；;，,、\s]+/) : t.split(/[；;，,、]|\s{2,}/))
      .map((s) => s.trim().replace(/[.。;；,，、]+$/, '').trim()).filter(Boolean);
    const [lo, hi] = journal.keywordCountRange;
    info.push({ id: 'FMT-006', label: '关键词数量', value: `${kws.length} 个` });
    if (kws.length < lo || kws.length > hi) {
      issues.push(mkIssue(R('FMT-006'), {
        location: `paragraph:${paras[keywordIdx].index}`, paragraphIndex: keywordIdx, quote: t.slice(0, 80),
      }, {
        message: `关键词 ${kws.length} 个，超出规范建议的 ${lo}—${hi} 个`,
        suggestion: kws.length < lo ? '补充能揭示主题的名词性短语' : '删去检索价值最低、与题名重复的词',
      }));
    }
    /**
     * FMT-007 关键词过长 —— 第 26 轮重新标定阈值。
     *
     * 原判据是**一刀切 `[...k].length > 20`**，两个毛病：
     *   ① 拿「标记 + 整串」当关键词量（见上方 `stripKwMarker` 注释）→ 整串必然超 20；
     *   ② **中英文用同一把尺子** —— 但中文关键词和西文关键词的长度分布完全不同：
     *
     *      | | n | p50 | p90 | p95 | p99 | max |
     *      |---|---:|---:|---:|---:|---:|---:|
     *      | 中文（字） | 968 | 4 | 6 | 7 | 7 | **14** |
     *      | 西文（字符）| 300 | 16 | 25 | 26 | 38 | **42** |
     *      | 西文（词） | 300 | 2 | 3 | 4 | 5 | **6** |
     *
     * 20 字对中文太松（中文关键词就没有到 20 字的），对西文太紧
     * （`Rural people communication` 26 字符、3 个词，完全正常）。
     *
     * 现阈值：中文 >14 字（=语料实测上界）、西文 >6 词或 >50 字符。
     *
     * ⚠️ 我一度还想加一条「中文关键词含句末标点即为整句」的判据，**实测是错的，已删**：
     *   · 西文关键词以句点结尾很常见 —— `Normative Crisis.`、`religion.`、
     *     `three dimensional of government debts.` 都是**西文关键词表末尾的句点**，
     *     不是句子；按「句末标点」判会把这些全部误报；
     *   · 中文关键词里出现「？」同样正常 —— `《怎么办？》` 是**书名**，
     *     书名号里的问号是书名的一部分。
     * 所以「是不是整句」**不能靠标点判断**，只能靠长度。
     *
     * 全语料按新阈值实测：中文 0 个、西文 0 个 —— 语料里没有真正的「整句关键词」，
     * 这条规则的实际作用是**挡住未来真正的整句**，而不是在现语料上刷命中。
     */
    for (const k of kws) {
      const isHan = /[\u4e00-\u9fa5]/.test(k);
      const chars = [...k].length;
      const wordCount = k.split(/\s+/).filter(Boolean).length;
      const tooLong = isHan ? chars > 14 : (wordCount > 6 || chars > 50);
      if (tooLong) {
        const why = isHan ? `${chars} 字` : `${wordCount} 词 / ${chars} 字符`;
        issues.push(mkIssue(R('FMT-007'), {
          location: `paragraph:${paras[keywordIdx].index}`, paragraphIndex: keywordIdx, quote: k,
        }, {
          message: `关键词「${k}」过长（${why}），疑为整句而非名词性短语`,
          suggestion: '压缩为名词性短语',
        }));
      }
    }
  }

  /* --- FMT-008 标题层级跳级 --- */
  {
    /**
     * 层级序列扩到 9 级。
     *
     * 原实现只列到 `level5`，而本刊规则库声明的编号形态有 7 种
     * （一、/（一）/1./（1）/①/A./a.），分级器现在如实产出到 `level7`；
     * 若不扩表，`order.indexOf('level6')` 返回 -1，会被当成
     * 「比上一级还高」从而漏报跳级，且 FMT-008 的层级序列显示成空白。
     */
    const order = ['level1', 'level2', 'level3', 'level4', 'level5', 'level6', 'level7', 'level8', 'level9'];
    const heads = [];
    for (let i = 0; i < paras.length; i += 1) {
      if (roles[i] === 'heading') heads.push({ i, level: paras[i]._headingLevel, text: paras[i].text.trim() });
    }
    let maxSeen = -1;
    for (const h of heads) {
      const lv = order.indexOf(h.level);
      if (lv < 0) continue;
      if (maxSeen >= 0 && lv > maxSeen + 1) {
        issues.push(mkIssue(R('FMT-008'), {
          location: `paragraph:${paras[h.i].index}`, paragraphIndex: h.i, quote: h.text,
        }, {
          message: `标题层级跳级：上一标题为 ${order[maxSeen]}，本级直接使用 ${h.level}`,
          suggestion: '补齐被跳过的层级，或改用上一级编号',
        }));
      }
      maxSeen = Math.max(maxSeen, lv);
    }
    /**
     * FMT-009「同级标题编号形式必须统一」**有意不实现**。
     *
     * 规则库自己把它标为 `"type": "manual"`，`reclassifiedWhy` 写明
     * 「需人判断标题层级归属，且语料中多数稿件本无编号体系」。
     * 原实现里有一句 `const byLevel = {}; for (...) (byLevel[h.level] ||= []).push(h);`
     * 建完即弃 —— 是死代码，容易让人误以为该规则已经实现。这里删除。
     */
    info.push({ id: 'FMT-008', label: '标题层级', value: heads.map((h) => h.level).join(' → ') || '未识别到编号标题' });
    info.push({
      id: 'FMT-008',
      label: '标题识别',
      value: heads.length
        ? `${heads.length} 条（判据：${[...new Set(heads.map((h) => paras[h.i]._headingSource || '?'))].join('、')}）`
        : '未识别到标题',
    });
  }

  /* --- FMTB-042 不同层级标题之间须有过渡内容 --- */
  {
    /**
     * 由历史批注「固化」而来的**确定性结构检测**。
     *
     * 批注原文（多篇、多种表述，合计数十处）：
     *   「不同层级标题间，请补充过渡段或过渡句，全文同。」
     *   「根据规范，不同级别标题间需要有内容过渡，请您在文章标题与标题一之间补充一小段引言。」
     * 判据是纯结构事实：两个不同层级标题之间只要没有任何非空正文段，就是缺过渡，
     * 不需要模型语义判断，故从「人工复核/模型」固化为规则引擎自动检测。
     */
    const rule = R('FMTB-042');
    const order = ['level1', 'level2', 'level3', 'level4', 'level5', 'level6', 'level7', 'level8', 'level9'];
    const heads = [];
    for (let i = 0; i < paras.length; i += 1) {
      if (roles[i] !== 'heading') continue;
      const text = (paras[i].text || '').trim();
      // 反向误报护栏：编辑批注「【文脉：…】【说明：…】」等方头括号标记会被分类器
      // 误判成标题行；它们不是编号标题，不参与「标题间过渡」判定。
      if (/^【/.test(text) || /^[\[［]/.test(text)) continue;
      const lv = order.indexOf(paras[i]._headingLevel);
      if (lv < 0) continue;
      heads.push({ i, lv, text });
    }
    const hasContentBetween = (from, to) => {
      for (let j = from + 1; j < to; j += 1) {
        if (roles[j] === 'empty') continue;
        if ((paras[j].text || '').trim()) return true;
      }
      return false;
    };
    for (let k = 0; k + 1 < heads.length; k += 1) {
      const a = heads[k];
      const b = heads[k + 1];
      if (b.lv <= a.lv) continue;                 // 只判「上位标题 → 更深的标题」
      if (hasContentBetween(a.i, b.i)) continue;  // 中间有正文段即视为有过渡
      issues.push(mkIssue(rule, {
        location: `paragraph:${paras[b.i].index}`, paragraphIndex: b.i, quote: b.text,
      }, {
        message: `不同层级标题之间缺少过渡内容：「${a.text.slice(0, 20)}」与其下位标题「${b.text.slice(0, 20)}」之间没有过渡段或过渡句`,
        suggestion: '在两标题之间补写一段过渡性文字（引言或承接句）',
      }));
    }
  }

  /* --- FMT-010 标题末尾标点 --- */
  for (let i = 0; i < paras.length; i += 1) {
    if (roles[i] !== 'heading') continue;
    const t = paras[i].text.trim();
    if (/[。；，]$/.test(t)) {
      issues.push(mkIssue(R('FMT-010'), {
        location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: t,
      }, {
        message: '标题末尾出现句末标点',
        suggestion: '删除末尾标点',
        autoFix: { find: t.slice(-1), replace: '' },
      }));
    }
  }

  /* --- FMT-014 半角标点 --- */
  /**
   * 按「半角字符」归并：同一种半角标点在一篇里只出一条，附全部出现位置。
   *
   * 为什么不逐处报：实测全语料 862 条，一篇稿子里同一种半角逗号能出现
   * 40 次以上（07-姚云帆那篇半角逗号 60+ 处）。逐条列出会把问题清单刷屏，
   * 把真正需要逐条判断的问题（错别字、表述）挤到看不见。
   *
   * 为什么不担心「归并了就改不全」：`server.mjs` 的 `/api/apply-fixes`
   * 已经支持展开 `occurrences` —— 勾一条 = 改全文同类 N 处。
   * （这也是 FMT-014 长期没有归并的唯一原因，现已解决。）
   */
  {
    const rule = R('FMT-014');
    const targets = [...paras.map((p, i) => ({ text: p.text, idx: i, kind: 'paragraph' }))];
    doc.footnotes.forEach((p, i) => targets.push({ text: p.text, idx: i, kind: 'footnote' }));
    const map = { ',': '，', ';': '；', '!': '！', '?': '？', ':': '：' };
    // 按半角字符分桶
    const buckets = new Map();
    for (const t of targets) {
      if (!t.text || t.text.length < 4) continue;
      for (const pat of rule.detect.patterns) {
        const re = new RegExp(pat, 'g');
        let m;
        while ((m = re.exec(t.text))) {
          // 注意下标语义：FMT-014 的模式形如 `[\u4e00-\u9fa5][,]`，
          // **匹配串以汉字开头、以标点结尾**，所以 `m.index` 指向那个汉字，
          // 标点本身在 `m.index + m[0].length - 1`。
          // 早期把 m.index 直接当标点位置传给 isChineseContext，导致它把汉字当标点、
          // 左邻取到更前一个汉字，右侧取到真正的标点 → 一律判成「中文语境」，
          // 于是 `AMI核心, CSSCI` 这类 JSON 元数据豁免失效。
          const punctAt = m.index + m[0].length - 1;
          if (!isChineseContext(t.text, punctAt)) continue;
          const ch = m[0].slice(-1);
          if (!buckets.has(ch)) buckets.set(ch, []);
          buckets.get(ch).push({
            t, punctAt, ch,
            location: `${t.kind}:${t.kind === 'footnote' ? t.idx : paras[t.idx].index}`,
            quote: snippet(t.text, punctAt),
            paragraphIndex: t.kind === 'paragraph' ? t.idx : undefined,
            footnoteIndex: t.kind === 'footnote' ? t.idx : undefined,
          });
        }
      }
    }
    for (const [ch, list] of buckets) {
      const first = list[0];
      issues.push(mkIssue(rule, {
        location: first.location,
        paragraphIndex: first.paragraphIndex,
        footnoteIndex: first.footnoteIndex,
        quote: first.quote,
        offset: first.punctAt,
        occurrenceCount: list.length,
        // 每一处都带自己的 offset，供 /api/apply-fixes 逐处落地
        occurrences: list.map((x) => ({
          location: x.location,
          paragraphIndex: x.paragraphIndex,
          footnoteIndex: x.footnoteIndex,
          quote: x.quote,
          offset: x.punctAt,
          autoFix: { find: ch, replace: map[ch] || ch, offset: x.punctAt },
        })),
      }, {
        message: `中文语境下使用了半角标点「${ch}」`,
        suggestion: `改为全角「${map[ch] || ch}」`,
        autoFix: { find: ch, replace: map[ch] || ch, offset: first.punctAt },
      }));
    }
  }

  /* --- FMT-015 「即」前顿号 --- */
  {
    const rule = R('FMT-015');
    for (let i = 0; i < paras.length; i += 1) {
      const text = paras[i].text;
      for (const pat of rule.detect.patterns) {
        const re = new RegExp(pat, 'g');
        let m;
        while ((m = re.exec(text))) {
          issues.push(mkIssue(rule, {
            location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(text, m.index, 30), offset: m.index,
          }, {
            message: `顿号使用不当：「${m[0]}」`,
            suggestion: '删除顿号，解释性连接词前不用顿号',
            autoFix: { find: '、', replace: '', offset: m.index },
          }));
        }
      }
    }
  }

  /* --- FMT-018 连续括号 --- */
  {
    const rule = R('FMT-018');
    for (let i = 0; i < paras.length; i += 1) {
      for (const pat of rule.detect.patterns) {
        const re = new RegExp(pat, 'g');
        let m;
        while ((m = re.exec(paras[i].text))) {
          issues.push(mkIssue(rule, {
            location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(paras[i].text, m.index, 40), offset: m.index,
          }, {
            message: `连续使用括号备注：${m[0].slice(0, 30)}`,
            suggestion: '合并为一个括号，或把次要信息并入正文',
          }));
        }
      }
    }
  }

  /* --- FMT-019 省略号 --- */
  {
    const rule = R('FMT-019');
    for (let i = 0; i < paras.length; i += 1) {
      const text = paras[i].text;
      for (const pat of rule.detect.patterns) {
        const re = new RegExp(pat, 'g');
        let m;
        while ((m = re.exec(text))) {
          const hit = m[0];
          if (hit.startsWith('……') && hit.length === 2) continue; // 规范形式
          issues.push(mkIssue(rule, {
            location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(text, m.index, 30), offset: m.index,
          }, {
            message: `省略号形式不规范：「${hit}」`,
            suggestion: '统一改为「……」',
            autoFix: { find: hit, replace: '……', offset: m.index },
          }));
        }
      }
    }
  }

  /* --- FMT-020 / FMT-025 年代与区间连接号 --- */
  {
    const rule20 = R('FMT-020');
    const rule25 = R('FMT-025');

    /**
     * 命中位置是否落在「不该判」的上下文里。
     *
     * FMT-020 的模式是 `[0-9]{4}\s*[-~～]\s*[0-9]{4}`，会命中所有四位年份区间，
     * 但下面这些位置的短横线**不是**连接号误用，报出来就是误报：
     *   · 书名/篇名内部 —— 《毛泽东年谱（1949-1976）》、《经济意识形态与日本产业政策 : 1931-1965年的发展主义》
     *   · 网址/引文里的英文标题 —— "...projections-2005-2050/, retrieved March 1"
     *   · 西文文献的年份区间 —— "Population Growth Rate, 1790-2020"
     * 实测这三类占了该规则命中的绝大多数（632 份稿件 843 条命中、与编辑批注重合率 1.9%）。
     */
    const inExemptContext = (text, idx, len) => {
      const before = text.slice(0, idx);
      const after = text.slice(idx + len);
      // 1) 落在书名号/引号内部
      const openBook = before.lastIndexOf('《');
      const closeBook = before.lastIndexOf('》');
      if (openBook > closeBook && after.includes('》')) return true;
      const openQuote = Math.max(before.lastIndexOf('“'), before.lastIndexOf('"'));
      const closeQuote = Math.max(before.lastIndexOf('”'), before.lastIndexOf('"', before.length - 1));
      if (openQuote > closeQuote && /[”"]/.test(after)) return true;
      // 2) 落在 URL 或西文语境里（命中前后 40 字内出现 ASCII 字母或网址特征）
      const win = text.slice(Math.max(0, idx - 40), idx + len + 40);
      if (/https?:\/\/|www\.|\.com|\.org|\.net|\/|retrieved|Retrieved/.test(win)) return true;
      if (/[A-Za-z]{3,}/.test(text.slice(Math.max(0, idx - 24), idx))
        || /^[A-Za-z]{3,}/.test(text.slice(idx + len, idx + len + 24))) return true;
      // 3) 页码区间，不是年份区间。
      //    实测漏报形态：「2015, 112(49), pp. 15078-15083.」
      //    FMT-020 的模式是四位数字 + 连接号 + 四位数字，五位页码的**前四位**
      //    正好凑成「15078-15083」→ 被当成「年代区间」报出，还给出「区间用一字线」的建议，
      //    而原文那是英文期刊的页码范围，短横线本来就是对的。
      //    模型复核也指出了这点：「原文为页码区间非年代区间，判定描述有误」。
      //    判据：命中前有 pp./p. 标记，或命中两侧数字紧邻更多数字（说明不是完整年份）。
      if (/\bpp?\.\s*[0-9,\s-]*$/.test(before.slice(-24))) return true;
      if (/[0-9]/.test(text[idx - 1] || '') || /[0-9]/.test(text[idx + len] || '')) return true;
      return false;
    };

    const scanTargets = [...paras.map((p, i) => ({ text: p.text, pi: i, kind: 'paragraph' }))];
    doc.footnotes.forEach((p, i) => scanTargets.push({ text: p.text, pi: -1, fi: i, kind: 'footnote' }));
    for (const t of scanTargets) {
      for (const [rule, pats] of [[rule25, rule25.detect.patterns], [rule20, rule20.detect.patterns]]) {
        for (const pat of pats) {
          const re = new RegExp(pat, 'g');
          let m;
          while ((m = re.exec(t.text))) {
            if (inExemptContext(t.text, m.index, m[0].length)) continue;
            const loc = t.kind === 'paragraph'
              ? { location: `paragraph:${paras[t.pi].index}`, paragraphIndex: t.pi }
              : { location: `footnote:${t.fi}`, footnoteIndex: t.fi };
            let fix;
            if (rule25 === rule) {
              // 「1750年到2000年」「1953年至1979年」→「1750—2000年」
              // 只保留一个「年」，连接词与连接号统一为一字线
              const digits = m[0].match(/[0-9]{4}/g) || [];
              const replacement = digits.length === 2 ? `${digits[0]}—${digits[1]}年` : null;
              // 若原文写法已完全合规（连接号本就是一字线、且只在末尾有「年」），则不产生无意义的改写
              if (replacement && replacement !== m[0]) {
                fix = { find: m[0], replace: replacement, offset: m.index };
              }
            }
            issues.push(mkIssue(rule, { ...loc, quote: snippet(t.text, m.index, 30), offset: m.index }, {
              message: `年代区间写法不规范：「${m[0]}」`,
              suggestion: rule25 === rule ? '统一为「1949—1955年」形式（一字线，只在末尾加「年」）' : '区间用一字线「—」，破折号用两字线「——」',
              autoFix: fix,
            }));
          }
        }
      }
    }
  }

  /* --- FMT-024 年代表述 --- */
  {
    const rule = R('FMT-024');
    const scanTargets = [...paras.map((p, i) => ({ text: p.text, pi: i, kind: 'paragraph' }))];
    doc.footnotes.forEach((p, i) => scanTargets.push({ text: p.text, pi: -1, fi: i, kind: 'footnote' }));
    // 归并：本规则是**刊例偏好**而非错误，同一篇里出现多次只报一条。
    //
    // 这个改法有实测依据 —— 语料两层对照：
    //   已过审（发排版）89 篇：「NNNN年代」2.98 处/篇 vs「N世纪XX年代」0.09 处/篇（33:1）
    //   在审（责编）543 篇：  2.35 处/篇 vs 0.30 处/篇（7.8:1）
    // 说明编辑确实会把它统一成「1990年代」，规则本身成立；
    // 但它是**文字风格统一**，不是错误，所以：
    //   1. 严重度降到「低」（原先按规则声明的「高」，导致一篇稿子靠它拉高判定分）；
    //   2. 同篇归并为一条，避免一篇里 10 处「20世纪X0年代」刷出 10 条。
    // 模型复核也印证了这点：它对这个规则给出的不同意理由全是
    // 「『20世纪80年代』本就用阿拉伯数字，符合国标」——即认为不该算错。
    const hits24 = [];
    /**
     * 命中位置是否落在**直接引文**里。
     *
     * 第 22 轮实测：「上世纪六七十年代」在语料里有 5 处出现在
     * 习近平讲话的直接引文内（「2017年，习近平指出：“上世纪六七十年代，
     * 中国军民积极支援老挝民族独立和解放事业……”」）。**引文里的字句不能改**，
     * 改了就是篡改引文 —— 所以这类必须排除。
     * 实测 17 处候选中引号内 2 处（另一处是未配对引号造成的误判）、引号外 15 处，
     * 排除后判据干净。
     */
    const inQuoted = (text, idx, len) => {
      const before = text.slice(0, idx);
      const after = text.slice(idx + len);
      const open = Math.max(before.lastIndexOf('“'), before.lastIndexOf('"'));
      const close = Math.max(before.lastIndexOf('”'), before.lastIndexOf('"', before.length - 1));
      return open > close && /[”"]/.test(after);
    };
    /**
     * 命中位置是否落在书名号《》内。
     *
     * 第 22 轮实测的关键排除：「二十一世纪」在语料里 141 处，绝大多数是
     * **书名/刊名**——《二十一世纪资本论》（皮凯蒂）、《二十一世纪》（香港）
     * 1996年8月号。这些是专有名词，改成「21世纪资本论」就是改错。
     * 不排除的话该 pattern 假阳性率接近 100%。
     */
    const inTitleMarks = (text, idx, len) => {
      const before = text.slice(0, idx);
      const after = text.slice(idx + len);
      return before.lastIndexOf('《') > before.lastIndexOf('》') && after.includes('》');
    };
    const patterns24 = [
      ...rule.detect.patterns,
      // 第 22 轮补充：带「上世纪」前缀的年代写法，以及单独的「八十年代」式写法。
      // 依据是编辑自己的修订：「上世纪八十年代」→「1980年代」、「五、六十年代」→「1950—1960年代」。
      // 原 patterns 只认「N世纪XX年代」，实测 17 处「上世纪N十年代」**零覆盖**。
      //
      // 顺序有讲究：**长的、带世纪的形态必须排在前面**。
      // 实测踩过的坑：「二十世纪二三十年代」被后面的短 pattern
      // 「[一二三四五六七八九十]{1,2}十年代」先匹配到「三十年代」，
      // 结果给出「改写为『1930年代』」——把「二三十年代」这个**区间**
      // 错当成单个十年。所以复合年代与带世纪的形态都排在前面，
      // 并且短 pattern 加后顾排除「紧跟在『世纪』之后」的位置。
      '(?<![0-9])(?<![世纪])[一二三四五六七八九十]{1,3}世纪[一二三四五六七八九十]{1,3}年代',
      '(?<![0-9])(?<![世纪])[一二三四五六七八九十]{1,3}世纪[0-9]{2}年代',
      '上世纪\\s*[0-9]{2}\\s*年代',
      '(?<![0-9])(?<![世纪])(?:上世纪\\s*)?[一二三四五六七八九十]\\s*[、，,]?\\s*[一二三四五六七八九十]\\s*十\\s*年代',
      '(?:上世纪\\s*)?[一二三四五六七八九十]{1,3}十\\s*年代',
      // 第 22 轮再补：「中文数字世纪」本身也按刊例改为阿拉伯数字
      // （「二十世纪」→「20世纪」）。依据同样是编辑修订 —— 实测 36 处
      // 中文世纪被直接改成阿拉伯世纪（「二十世纪」→「20世纪」、
      // 「十九世纪」→「19世纪」），另有编辑批注
      // 「作者所述18世纪60年代【已由一审按刊例调整为1760年代】」。
      '(?<![0-9])(?<![下])(?<![世纪])([一二三四五六七八九十]{1,3})世纪(?![纪年代])',
    ];
    for (const t of scanTargets) {
      for (const pat of patterns24) {
        const re = new RegExp(pat, 'g');
        let m;
        while ((m = re.exec(t.text))) {
          if (inQuoted(t.text, m.index, m[0].length)) continue;
          /**
           * 书名号内不得改写。
           *
           * 第 22 轮实测的**关键排除**：「二十一世纪」在语料里 141 处，
           * 绝大多数是**书名/刊名**——《二十一世纪资本论》（皮凯蒂）、
           * 《二十一世纪》（香港）1996年8月号、《共同建设二十一世纪
           * “海上丝绸之路”》。这些是专有名词，把书名改成「21世纪资本论」
           * 就是改错了。不排除的话这个 pattern 的假阳性率接近 100%。
           */
          if (inTitleMarks(t.text, m.index, m[0].length)) continue;
          // 只有确实能转换成「1990年代」形式时才报。
          // 「20世纪初」「19世纪末」本身就是规范写法（「初/末/中叶」没有对应的年代写法），
          // 之前会把它们一并报出并给出与原文相同的改写，产生大量空操作。
          const converted = convertCompoundDecade(m[0]) !== m[0]
            ? convertCompoundDecade(m[0])
            : convertCentury(m[0]) !== m[0] ? convertCentury(m[0]) : convertShangShiji(m[0]) !== m[0]
              ? convertShangShiji(m[0]) : convertCnCentury(m[0]);
          if (converted === m[0]) continue;
          hits24.push({ t, m, converted });
        }
      }
    }
    if (hits24.length) {
      const first = hits24[0];
      const loc = first.t.kind === 'paragraph'
        ? { location: `paragraph:${paras[first.t.pi].index}`, paragraphIndex: first.t.pi }
        : { location: `footnote:${first.t.fi}`, footnoteIndex: first.t.fi };
      const forms = [...new Set(hits24.map((h) => h.m[0]))].slice(0, 4);
      issues.push(mkIssue(rule, { ...loc, quote: snippet(first.t.text, first.m.index, 30), offset: first.m.index, occurrenceCount: hits24.length, severity: '低' }, {
        message: hits24.length > 1
          ? `年代表述宜按刊例统一为「1990年代」形式，全文共 ${hits24.length} 处（如 ${forms.map((f) => `「${f}」`).join('、')}）`
          : `年代表述宜按刊例统一为「1990年代」形式：「${first.m[0]}」`,
        suggestion: `改写为「${first.converted}」形式；同篇其余处一并统一`,
        autoFix: { find: first.m[0], replace: first.converted, offset: first.m.index },
      }));
    }
  }

  /* --- FMT-023 约数 --- */
  {
    const rule = R('FMT-023');
    for (let i = 0; i < paras.length; i += 1) {
      for (const pat of rule.detect.patterns) {
        const re = new RegExp(pat, 'g');
        let m;
        while ((m = re.exec(paras[i].text))) {
          issues.push(mkIssue(rule, {
            location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(paras[i].text, m.index, 30), offset: m.index,
          }, {
            message: `约数使用了阿拉伯数字：「${m[0]}」`,
            suggestion: '约数统一改用中文数字（如「三四个」「十几个」）',
          }));
        }
      }
    }
  }

  /* --- FMT-013 机构简称 --- */
  {
    const rule = R('FMT-013');
    const lexicon = rule.detect.lexicon || [];
    const seen = new Set();
    for (let i = 0; i < paras.length; i += 1) {
      for (const word of lexicon) {
        const at = paras[i].text.indexOf(word);
        if (at < 0) continue;
        const key = `${word}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push(mkIssue(rule, {
          location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(paras[i].text, at, 30), offset: at,
        }, {
          message: `使用了机构简称「${word}」，须核对是否属于官方认可的简称`,
          suggestion: '首次出现改用官方全称，其后按官方简称规范使用',
        }));
      }
    }
  }

  /* --- FMT-012 缩写首次出现 --- */
  {
    const rule = R('FMT-012');
    const abbrs = new Map();
    const abbrRe = /(?<![\u4e00-\u9fa5A-Za-z])([A-Z]{2,6})(?![\u4e00-\u9fa5A-Za-z])/g;
    const allow = new Set(['DOI', 'PDF', 'AI', 'GDP', 'CPI', 'PPP', 'SNA', 'NGO', 'TINA', 'UN', 'US', 'UK', 'EU', 'TV', 'IT', 'CEO', 'ISBN', 'ISSN']);
    /**
     * 反向误报护栏（全语料实测踩出）：
     *   1. 罗马数字不是缩写 —— 「World War II」「卷 II」里的 II/III/IV 被当成缩写报出；
     *   2. 拼音人名不是缩写 —— 「PAN Yaling」里的 PAN 是姓氏（潘亚玲），
     *      与「首字母大写+小写」的罗马词紧邻即判为人名，不再报；
     *   3. 首次出现处若缩写本身被括号包裹（「全称（A）」「（A，全称）」「A（全称）」），
     *      说明已给出全称 —— 原先只认「…（A」这一种排布，于是「A（全称）」
     *      与「名”后（A，全称）」等写法被误报（实测这类占误报大头）；
     *   4. 显式全称标记（简称/以下简称/缩写为/abbreviated as）出现即视为已定义，
     *      用于兜住「定义在别处」的英文摘要写法。
     *   注意：**不**把所有「别处出现过（A）」都当作已定义 —— 那会连
     *   「首次使用未给全称、后文才补」的真问题一并漏掉，属过度抑制。
     */
    const roman = /^[IVXLCDM]+$/;
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fullText = [
      ...paras.map((p) => p.text || ''),
      ...doc.footnotes.map((p) => p.text || ''),
      ...(doc.endnotes || []).map((p) => p.text || ''),
    ].join('\n');
    const definedByMarker = (a) => new RegExp(`(?:简称|以下简称|缩写为|abbreviated as)\\s*[（(]?\\s*${escRe(a)}\\b`).test(fullText);
    for (let i = 0; i < paras.length; i += 1) {
      const text = paras[i].text;
      let m;
      while ((m = abbrRe.exec(text))) {
        const a = m[1];
        if (allow.has(a) || roman.test(a)) continue;
        const before = text.slice(Math.max(0, m.index - 30), m.index);
        const after = text.slice(m.index + a.length, m.index + a.length + 20);
        const hasFullName = /[\u4e00-\u9fa5]{2,}[（(]$/.test(before) || /[A-Z][a-z]+(?: [A-Z][a-z]+)*[（(]$/.test(before);
        // 缩写被括号直接包裹：前有「（」或后有「）」/「（」
        const wrapped = /[（(]\s*$/.test(before) || /^\s*[（(）)]/.test(after);
        // 拼音人名：紧邻「首字母大写+小写」的罗马词（PAN Yaling / Yaling PAN）
        const pinyinName = /^\s[A-Z][a-z]{2,}/.test(after) || /[A-Z][a-z]{2,}\s$/.test(before);
        if (!abbrs.has(a)) {
          abbrs.set(a, { first: i, index: m.index, hasFullName, wrapped, pinyinName });
        }
      }
    }
    for (const [a, meta] of abbrs) {
      if (meta.hasFullName || meta.wrapped || meta.pinyinName) continue;
      if (definedByMarker(a)) continue;
      const text = paras[meta.first].text;
      issues.push(mkIssue(rule, {
        location: `paragraph:${paras[meta.first].index}`, paragraphIndex: meta.first, quote: snippet(text, meta.index, 40), offset: meta.index,
      }, {
        message: `缩写「${a}」首次出现未给出全称`,
        suggestion: `首次出现改为「中文全称（English Full Name, ${a}）」`,
      }));
    }
  }

  /* --- FMT-039 译名一致性（同一括注英文对应多个中文译名） --- */
  {
    const rule = R('FMT-039');
    const map = new Map();
    const pairRe = /([\u4e00-\u9fa5·]{2,12})[（(]([A-Za-z][A-Za-z.\- ]{2,40})[）)]/g;
    for (let i = 0; i < paras.length; i += 1) {
      let m;
      while ((m = pairRe.exec(paras[i].text))) {
        const key = m[2].trim().toLowerCase();
        const cn = m[1];
        if (!map.has(key)) map.set(key, new Map());
        const inner = map.get(key);
        inner.set(cn, (inner.get(cn) || 0) + 1);
      }
    }
    for (const [en, cnMap] of map) {
      if (cnMap.size > 1) {
        issues.push(mkIssue(rule, { location: 'document', quote: `${[...cnMap.keys()].join(' / ')}（${en}）` }, {
          message: `同一外文名出现多种译法：${[...cnMap.keys()].join('、')} → ${en}`,
          suggestion: '按权威译名统一，并在首次出现处备注原文',
        }));
      }
    }
  }

  /* --- FMT-036 作者简介 --- */
  /**
   * 第 29 轮修：**现场栏目豁免**。
   *
   * 编辑批注原文：「【现场】栏目的格式性要求可以稍低一些。」
   * 现场/圆桌/工作坊的**发言记录**里，发言人是与会学者，文末通常不附作者简介 ——
   * 这是体例差异，不是缺漏。原实现不知道，实测该类稿件 FMT-036 命中 31.0%。
   *
   * 判据与 FMT-001 一致（文件名 + 会议记录体例语言双轨），详见 FMT-001 处的说明。
   */
  {
    const src = String(doc.label || '').replace(/\\/g, '/');
    const allText = paras.map((p) => p.text).join('\n');
    const isLive = /(现场|圆桌|工作坊|发言)/.test(src)
      || /(下面请|有请[^。]{0,12}(老师|教授|先生|女士)|谢谢[^。]{0,8}老师的发言|发言内容整理|发言稿整理|录音整理|文字整理|本刊编辑部整理|与会者发言|圆桌讨论|现场提问|现场答问|问答环节)/.test(allText);
    if (!roles.includes('authorBio') && !isLive) {
      issues.push(mkIssue(R('FMT-036'), { location: 'document', quote: '' }, {
        message: '未识别到作者简介段',
        suggestion: '在正文末尾补作者简介（姓名、单位、职称、研究方向）',
      }));
    }
  }

  /* --- FMT-031 图表资料来源 --- */
  {
    const rule = R('FMT-031');
    const tableCount = doc.tables.length;
    if (tableCount > 0) {
      const allText = paras.map((p) => p.text).join('\n');
      const hasSource = /资料来源|数据来源|来源：/.test(allText);
      info.push({ id: 'FMT-031', label: '表格', value: `${tableCount} 个${hasSource ? '，已标来源' : '，未见资料来源'}` });
      if (!hasSource) {
        issues.push(mkIssue(rule, { location: 'document', quote: '' }, {
          message: `文档含 ${tableCount} 个表格，但全文未出现「资料来源/数据来源」`,
          suggestion: '在每个表格下方析出「资料来源：……」，体例同正文注释',
        }));
      }
      for (let ti = 0; ti < doc.tables.length; ti += 1) {
        const t = doc.tables[ti];
        const corner = t.rows?.[0]?.[0];
        if (corner !== undefined && String(corner).trim() === '') {
          issues.push(mkIssue(R('FMT-033'), { location: `table:${ti}`, tableIndex: ti, quote: '' }, {
            message: `表 ${ti + 1} 行列交叉的第一个方格为空`,
            suggestion: '在左上角单元格填入区分行列的栏目名',
          }));
        }
      }
    }
  }

  /* --- FMT-016 书名号：疑似书名未加书名号 --- */
  {
    const rule = R('FMT-016');
    const knownBooks = ['资本论', '毛泽东选集', '列宁选集', '马克思恩格斯选集', '论语', '红楼梦', '西游记', '水浒传', '三国演义', '金瓶梅', '人民日报', '光明日报', '读书'];
    // 「求是」等易与常用词冲突的书名，只在明确语境下判定
    const contextualBooks = [
      { word: '求是', require: /《求是》|求是杂志|求是网|在《求是》/ },
    ];
    const seen = new Set();
    const isBookish = (text, at, len) => {
      const pre = text.slice(Math.max(0, at - 6), at);
      const post = text.slice(at + len, at + len + 4);
      // 前面已有书名号开引，或后面紧跟书名号收尾
      if (pre.endsWith('《') || post.startsWith('》')) return false;
      // 前面是「载」「参见」「见」等引述动词，说明是书名语境
      if (/(载|参见|见|出自|引自|据)$/.test(pre)) return true;
      // 后面紧跟出版社/年版/第…页，说明是书名语境
      if (/^(出版社|书局|年版|年|，|,)/.test(post)) return true;
      // 单独成句或前后是标点，且不在固定词语中
      return /[，。；：、“”（）\s]/.test(post[0] || '') && /[，。；：、“”（）\s]/.test(pre.slice(-1));
    };
    for (let i = 0; i < paras.length; i += 1) {
      for (const b of knownBooks) {
        let from = 0;
        while (true) {
          const at = paras[i].text.indexOf(b, from);
          if (at < 0) break;
          from = at + b.length;
          if (!isBookish(paras[i].text, at, b.length)) continue;
          if (seen.has(b)) break;
          seen.add(b);
          issues.push(mkIssue(rule, {
            location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(paras[i].text, at, 30), offset: at,
          }, {
            message: `书名/报刊名「${b}」未使用书名号`,
            suggestion: `改为《${b}》`,
            autoFix: { find: b, replace: `《${b}》`, offset: at },
          }));
          break;
        }
      }
      for (const cb of contextualBooks) {
        if (seen.has(cb.word)) continue;
        const at = paras[i].text.indexOf(cb.word);
        if (at < 0) continue;
        if (!cb.require.test(paras[i].text)) continue;
        if (paras[i].text.slice(Math.max(0, at - 1), at) === '《') continue;
        seen.add(cb.word);
        issues.push(mkIssue(rule, {
          location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(paras[i].text, at, 30), offset: at,
        }, {
          message: `刊物名「${cb.word}」未使用书名号`,
          suggestion: `改为《${cb.word}》`,
        }));
      }
    }
  }

  /* ================================================================ */
  /*  FMTB 系列：由历史批注归纳的编辑惯例规则                          */
  /*  这批规则多数需结合语境判断，这里只实现其中可确定性检查的部分，     */
  /*  其余在规则库中作为「需人工复核」条目列出。                        */
  /* ================================================================ */

  /* --- FMTB-003 内容提要须客观陈述，不得出现「本文」「本研究」「笔者」 --- */
  {
    const rule = R('FMTB-003');
    const ab = roleIndex.get('abstract') || [];
    /**
     * 第 27 轮把判据从 `(本文|本研究|笔者|文章|本刊)` **收窄为 `(本文|本研究|笔者)`**。
     *
     * 删掉「文章」的理由是**规则自相矛盾**：本条的建议文本写的是
     * 「改为客观陈述，如「**文章指出**」「研究认为」或直接陈述结论」
     * —— 一边建议作者写「文章指出」，一边又把「文章」判为违规。
     *
     * 编辑证据也只支持第一人称类字眼，明确点名的是「本文」「笔者」「本研究」：
     *   · 「内容提要请直接陈述文章观点与结论，不使用「本文」等字眼…」
     *   · 「内容提要请以客观陈述的形式呈现…尽量不出现「本文」「本研究」等字眼。」
     *   · 「这一段风格…尽量不出现「本文」「笔者」等字眼…」
     * 三条批注**没有一条**提到「文章」——因为「文章指出」本就是客观陈述式。
     *
     * 删掉「本刊」的理由更直接：全语料 632 篇的提要段里
     * **「本刊」出现 0 次** —— 它从未命中过任何真实违规，属纯粹的过度设计，
     * 只会给未来的作者制造莫须有的报错。
     */
    const re = /(本文|本研究|笔者)/g;
    for (const i of ab) {
      const t = paras[i].text;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t))) {
        issues.push(mkIssue(rule, { location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(t, m.index), offset: m.index }, {
          message: `内容提要中使用了「${m[0]}」，提要须客观陈述，不用第一人称`,
          suggestion: '改为客观陈述，如「文章指出」「研究认为」或直接陈述结论',
        }));
      }
    }
  }

  /* --- FMTB-006 / FMTB-021 / FMTB-022 栏目差异：专题、调研、书评不设提要关键词 --- */
  {
    const rule = R('FMTB-006');
    const full = paras.map((p) => p.text).join('\n');
    const hasAbstract = (roleIndex.get('abstract') || []).length > 0;
    const hasKeywords = (roleIndex.get('keywords') || []).length > 0;
    // 栏目判定必须**同时看正文与稿件来源路径**。
    // 早期实现只在正文里找「【专题】」这类字面标记，但真实稿件几乎不会在正文里
    // 写自己的栏目名 —— 栏目写在文件名/文件夹上（如「01-特稿-张维为」）。
    // 结果 FMTB-006/021/022 在 632 份真实稿件上一次都没触发过。
    const src = String(doc.label || '').replace(/\\/g, '/');
    const isSpecial = /【专题】|^专题[:：]|专题栏目/.test(full) || /(^|[/\-－—＿])专题([/\-－—＿.]|$)/.test(src);
    const isSurvey = /【调研】|调研栏目/.test(full) || /(^|[/\-－—＿])调研([/\-－—＿.]|$)/.test(src);
    const isReview = /【书评】|书评栏目/.test(full) || /(^|[/\-－—＿])书评([/\-－—＿.]|$)/.test(src);
    if (isSpecial && (hasAbstract || hasKeywords)) {
      issues.push(mkIssue(rule, { location: 'document', quote: '' }, {
        message: '【专题】栏目不设内容提要与关键词，改在第一个二级标题前加简短引言',
        suggestion: '删去内容提要与关键词，改在首个二级标题前写一段简短引言',
      }));
    }
    if (isSurvey) {
      const rule21 = R('FMTB-021');
      if (hasAbstract || hasKeywords) {
        issues.push(mkIssue(rule21, { location: 'document', quote: '' }, {
          message: '【调研】栏目不设内容摘要和关键词，须写含背景、样本、发现的引言',
          suggestion: '删去摘要与关键词，改写为交代调查背景、样本与主要发现的引言',
        }));
      }
    }
    if (isReview) {
      const rule22 = R('FMTB-022');
      if (hasAbstract || hasKeywords) {
        issues.push(mkIssue(rule22, { location: 'document', quote: '' }, {
          message: '书评不设摘要、关键词，作者介绍置于文末',
          suggestion: '删去摘要与关键词，把作者介绍移到文末',
        }));
      }
    }
  }

  /* --- FMTB-004 所有数据必须标注计量单位 --- */
  {
    const rule = R('FMTB-004');
    const UNIT = /(%|％|万|亿|元|美元|平方公里|平方米|公里|千米|米|厘米|毫米|吨|千克|公斤|克|升|毫升|千瓦|度|岁|人|家|个|所|部|篇|项|次|年|月|日|小时|分钟|秒|倍|摄氏度|℃|美元|欧元|日元|卢布|英镑)/;
    for (let i = 0; i < paras.length; i += 1) {
      const t = paras[i].text;
      // 只检查含「达/超过/增长/占/为」等计量语境且紧跟大数字的表述
      const re = /(达到?|超过|增长|占|共计|约为|多达)\s*([0-9][0-9,.]{2,})/g;
      let m;
      while ((m = re.exec(t))) {
        const after = t.slice(m.index + m[0].length, m.index + m[0].length + 12);
        if (UNIT.test(after)) continue;
        issues.push(mkIssue(rule, { location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(t, m.index), offset: m.index }, {
          message: `数据「${m[0]}」后面未见计量单位`,
          suggestion: '补出计量单位，如「万」「亿」「平方公里」「人次」等',
        }));
      }
    }
  }

  /* --- FMTB-005 具体数据须析出数据来源 --- */
  {
    const rule = R('FMTB-005');
    const full = paras.map((p) => p.text).join('\n');
    /**
     * 第 27 轮修：来源标注的判据原先**只看正文段落**，完全没看脚注。
     *
     * 后果：实测 632 篇里本规则命中 72 篇，其中 **71 篇（98.6%）的脚注里
     * 明明有完整的文献出处**（如「参见毛泽东：《愚公移山》，载《毛泽东选集》第3卷，
     * 人民出版社1991年版，第1101—1104页。」），只有 1 篇是脚注里也没有来源的。
     * 即误报率 98.6%。
     *
     * 本刊是**页下脚注**体例（`journal.citationStyle = '页下脚注'`），
     * 正文数据在脚注里交代出处才是本刊的正常做法，而不是在正文写「资料来源：」。
     * 所以「来源标注」必须把脚注、尾注一起纳入。
     */
    const noteText = [
      ...(doc.footnotes || []).filter((p) => !p.isNoteSeparator).map((p) => String(p.text || '')),
      ...(doc.endnotes || []).map((p) => String(p.text || '')),
    ].join('\n');
    /**
     * ⚠️ 第 27 轮修的第二处（写成探针才发现）：`SRC_RE` 里的
     * `据.{0,12}(统计|测算|估算|年报|数据库)` 分支**在正常正文里必然命中** ——
     * 「**据统计**，2020年…」这种句子本身就是「需要来源」的标志，
     * 却被当成了「已有来源」，于是 `hasSourceMark` 恒为真、**整条规则永远不报**。
     * 也就是说原实现同时存在**大量误报（71/72）**和**必然漏报**两个相反方向的毛病。
     *
     * 现按「来源证据」重新定义，并做了全语料标定（含数据表述的 283 篇）：
     *
     *   | 来源证据 | 在审层 273 篇 | 已过审层 10 篇 |
     *   |---|---:|---:|
     *   | 显式来源标注（资料来源/数据来源） | 22.0% | 10.0% |
     *   | 脚注含文献特征（出版社/年鉴/年第N期/网址…） | **94.9%** | **100%** |
     *   | 完全没有脚注 | 5.1% | 0% |
     *   | 既无显式标注也无文献脚注 | **4.0%** | **0%** |
     *
     * 已过审层 100% 靠**脚注**交代来源、只有 10% 写显式标注 —— 所以脚注是主要载体，
     * 「既无显式标注也无文献脚注」才是真缺陷（语料里 4.0%）。
     */
    const explicitSrc = /资料来源|数据来源|来源[:：]\s*\S/;
    // 脚注/尾注里的**文献著录**同样构成来源交代
    const citeInNote = /出版社|年鉴|年第\s*[0-9]+\s*期|https?:|www\.|\.gov|\.org|\.com|报告|白皮书|蓝皮书|公报|汇编|统计/;
    const hasSourceMark = explicitSrc.test(full) || explicitSrc.test(noteText) || citeInNote.test(noteText);
    /**
     * 「需要来源」的信号有两个：出现具体量级数据，或出现「据统计/测算/估算」这类
     * **明确宣称有统计依据**的表述（后者本身就要求给出处）。
     */
    const bigData = /([0-9][0-9,.]{2,}\s*(亿|万)?\s*(美元|元|人|吨|平方公里))/.test(full)
      || /据[^。；\n]{0,8}(统计|测算|估算|年报|数据库)/.test(full);
    if (bigData && !hasSourceMark) {
      issues.push(mkIssue(rule, { location: 'document', quote: '' }, {
        message: '正文出现具体数据或「据统计」类表述，但全文（含脚注、尾注）未见数据来源',
        suggestion: '在表下或图下析出「资料来源：……」；正文数据也须以脚注交代出处',
      }));
    }
  }

  /* --- FMTB-013 关键词数量不超过5个 --- */
  {
    const rule = R('FMTB-013');
    const kw = roleIndex.get('keywords') || [];
    for (const i of kw) {
      const t = paras[i].text.replace(/^\[?关键词\]?[:：]?/, '');
      const parts = t.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
      if (parts.length > 5) {
        issues.push(mkIssue(rule, { location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(paras[i].text, 0, 60) }, {
          message: `关键词 ${parts.length} 个，超过 5 个`,
          suggestion: '精选 5 个以内，按相关性与重要性排序',
        }));
      }
    }
  }

  /* --- FMTB-014 关键词的功能在于可被检索，不用于概括文章脉络 --- */
  {
    const rule = R('FMTB-014');
    // 空泛词：这类词放进关键词没有任何检索价值，等于用关键词概括文章脉络。
    const VAGUE = [
      '历史贡献', '当代启示', '现实启示', '时代价值', '研究', '探析', '思考', '意义', '启示',
      '路径', '对策', '问题', '现状', '发展', '影响', '作用', '特点', '特征', '关系',
      '初探', '浅析', '略论', '述评', '综述', '反思', '展望', '挑战', '机遇',
    ];
    // 一级/二级标题里常见的「选择性标点 + 并列」结构，若关键词与标题高度重合，
    // 说明关键词是标题的逐词拆解，而不是可检索的主题词。
    const kw = roleIndex.get('keywords') || [];
    const titleText = (() => {
      const heads = roleIndex.get('heading') || [];
      const first = heads.length ? heads[0] : 0;
      // 标题区：第一个编号标题之前的非空短行
      const lines = [];
      for (let i = 0; i <= first && i < paras.length; i += 1) {
        const t = paras[i].text.trim();
        if (t && t.length >= 4 && t.length <= 60 && roles[i] !== 'keywords' && roles[i] !== 'abstract') lines.push(t);
      }
      return lines.join('');
    })();
    const titleChars = new Set([...titleText].filter((c) => /[\u4e00-\u9fa5]/.test(c)));

    for (const i of kw) {
      const body = paras[i].text.replace(/^[\s\u3000]*\[?(关键词|关键字)\]?[:：]?/, '').trim();
      const parts = body.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
      if (!parts.length) continue;

      const vagueHits = parts.filter((p) => VAGUE.some((w) => p === w || (p.length <= 6 && p.includes(w))));
      if (vagueHits.length) {
        issues.push(mkIssue(rule, {
          location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(paras[i].text, 0, 80),
        }, {
          message: `关键词「${vagueHits.join('、')}」属空泛概括词，不具检索价值`,
          suggestion: '改为能直接检索到本主题的具体概念、对象或方法（如专有名词、理论名、制度名、地域/时段限定）',
        }));
        continue;
      }

      // 关键词与标题逐词拆解：所有关键词都被标题覆盖，且数量 >= 3
      if (parts.length >= 3 && titleChars.size >= 6) {
        const covered = parts.filter((p) => {
          const cs = [...p].filter((c) => /[\u4e00-\u9fa5]/.test(c));
          if (!cs.length) return false;
          return cs.every((c) => titleChars.has(c));
        });
        if (covered.length === parts.length) {
          issues.push(mkIssue(rule, {
            location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(paras[i].text, 0, 80),
          }, {
            message: '全部关键词都能在标题中找到，属标题的逐词拆解，未提供额外的检索入口',
            suggestion: '补充标题未覆盖的理论概念、研究方法或相关主题词',
          }));
        }
      }
    }
  }

  /* --- FMT-027 正文每段段首空两格 --- */
  {
    const rule = R('FMT-027');
    if (rule) {
      // 判据：正文段落应有「首行缩进两字符」。docx 里两种写法都算合规：
      //   · 段落属性 w:ind w:firstLineChars="200"（200 = 2 字符，实测 73.9% 的正文段落用这种）
      //   · 文本里直接打全角空格（实测 3.7%）
      // 只查正文角色，跳过标题/摘要/关键词/作者简介/基金/图表题注等本来就不缩进的段落，
      // 也跳过过短的段落（<20 字），避免把独立成行的短语误判为正文。
      /**
       * ⚠️ 第 30 轮修：**两种单位必须分开判**。
       *
       * docx 里首行缩进有两种等价写法，**单位不同**：
       *   · `w:firstLineChars="200"` —— 百分之一字符，200 = 2 字符（实测正文段 73.9% 用这种）
       *   · `w:firstLine="480"`      —— twip（1/20 磅），12pt 正文下 480 = 2 字符
       *
       * 原实现用 `||` 把两者混成一个值再与 `{200,201,240}` 比较，
       * 于是**只写 twips 的合规段落被判为「非两字符」**。实测已刊发定稿里
       * `<w:ind w:firstLine="510"/>`（60 段）、`480`（42 段）、`420`（125 段）都出现 ——
       * 510 twips ÷ 240 = 2.13 字符，视觉上就是「空两格」，完全合规。
       *
       * 这直接解释了本规则的分层反向（已过审 78.6% vs 在审 74.6%）：**已刊发定稿反而被判更多**。
       *
       * 合规区间（按各自量纲）：
       *   · firstLineChars：200—260（2.00—2.60 字符，含极少数排版微调）
       *   · firstLine(twips)：400—620（10pt 正文 2 字符=420、10.5pt=480、12pt=510、
       *     小四 12pt 加微调至 620 以内）
       */
      const OK_CHARS_LO = 200;
      const OK_CHARS_HI = 260;
      const OK_TWIPS_LO = 400;
      const OK_TWIPS_HI = 620;

      /**
       * ⚠️ 第 30 轮修的第三点：缩进可以**继承自段落样式**。
       *
       * 段落的 `w:ind` 不一定写在段落上 —— 若段落用了某个样式（`w:pStyle`），
       * 而该样式在 `word/styles.xml` 里定义了首行缩进，那么段落自身**没有** `w:ind`，
       * 但渲染出来是缩进的。原实现只看段落级属性，把这类正常段落全判为
       * 「未设置首行缩进」。
       *
       * 实测实例：`03-文化-秦博、刁涵-老挝路权…【0723一审done，可返回给秦老师】`
       * 的正文段全部用 `style="a6"`，`a6`（"Normal (Web)"）在 styles.xml 里
       * 定义 `w:firstLineChars="200"` —— 完全合规，却被报了 **37 处**。
       */
      const styleById = doc.styles?.byId || {};
      /** 解析出某段落**有效**的首行缩进（段落级优先，其次样式级） */
      const effectiveIndent = (p) => {
        const pr = p.properties || {};
        const rawChars = String(pr.firstLineChars ?? '').trim();
        const rawTwips = String(pr.firstLineTwips ?? '').trim();
        if (rawChars) return { unit: 'chars', n: Number(rawChars) };
        if (rawTwips) return { unit: 'twips', n: Number(rawTwips) };
        // 回退到样式级
        const st = styleById[String(pr.style ?? '')];
        if (st) {
          const sc = String(st.indentFirstLineChars ?? '').trim();
          const stw = String(st.indentFirstLineTwips ?? '').trim();
          if (sc) return { unit: 'chars', n: Number(sc), fromStyle: true };
          if (stw) return { unit: 'twips', n: Number(stw), fromStyle: true };
        }
        // 兼容旧字段（无单位信息）：保守判为未知
        const legacy = String(pr.indFirstLine ?? '').trim();
        if (legacy && !pr.indUnit) return { unit: 'unknown', n: NaN };
        return null;
      };

      const offenders = [];
      /**
       * ⚠️ 第 30 轮修的第四点：**先排除「不是正文段」的段落**。
       *
       * 角色分类只把「前置区（标题/作者/摘要/关键词/简介）之后、首个编号小标题之前」
       * 的段落排除掉，但实测已刊发定稿里仍有一批**非正文**段落被归到 body，
       * 它们本来就不缩进，于是被判「未空两格」：
       *
       *   · 编辑给排版看的操作说明 —— 「【文脉：标题上的注释标号请用米字注，
       *     谢谢！排版时请删除本句。】」「【文脉，内容暂缺，请加米字注…】」
       *   · 英文摘要/英文题名 —— 「The Evolution, Motivation and Countermeasures…」
       *     「    Abstract: As the Sino-US strategic competition has been intensifyi…」
       *   · 关键词行（前置区识别漏掉的）—— 「[关 键 词] 特朗普2.0；美国政府；…」
       *   · 作者/与会者名录行 —— 「张维为  维塔利·瑙姆金（Vitaly Naumkin） 安德烈…」
       *     这种**用多个空格分隔**的名录行，与正文的自然段落形态明显不同
       *   · 发言小标题 —— 「安德烈·维诺格拉多夫：多极世界下的文明型国家之间的关系」
       *
       * 排除判据（都要求**同时**满足形态特征，避免误伤正常正文）：
       *   ① 整段被【】包住的编辑说明（「【文脉…】」「【请…】」）；
       *   ② 拉丁字母占比 ≥ 30% 的西文段（本刊中文正文不会这样）；
       *   ③ 用 2 个以上连续空格做分栏/名录排布的段落；
       *   ④ 短行（<40 字）且**不含句末标点**且以「：」结尾 —— 小标题/发言人头衔。
       */
      const isNonBodyShape = (t) => {
        const s = t.trim();
        if (/^【[^】]{0,80}】?/.test(s) && /文脉|排版|米字注|请删除|暂缺|请加|格式参见/.test(s)) return true;
        const letters = (s.match(/[A-Za-z]/g) || []).length;
        if ([...s].length && letters / [...s].length >= 0.3) return true;
        if (/\s{2,}/.test(s) && s.length < 200) return true;
        if ([...s].length < 40 && !/[。！？；]$/.test(s) && /[：:]$/.test(s)) return true;
        return false;
      };
      for (let i = 0; i < paras.length; i += 1) {
        if (roles[i] !== 'body') continue;
        const p = paras[i];
        const t = p.text || '';
        if (t.trim().length < 20) continue;
        if (p.inTable) continue;
        if (/^[\u3000]/.test(t)) continue;                       // 已用全角空格缩进
        if (isNonBodyShape(t)) continue;                          // 非正文形态，不判缩进
        const eff = effectiveIndent(p);
        if (!eff) {
          offenders.push({ i, t, why: '未设置首行缩进' });
        } else if (eff.unit === 'chars') {
          if (!(eff.n >= OK_CHARS_LO && eff.n <= OK_CHARS_HI)) {
            offenders.push({ i, t, why: `首行缩进 ${eff.n}（${(eff.n / 100).toFixed(2)} 字符，非两字符）` });
          }
        } else if (eff.unit === 'twips') {
          if (!(eff.n >= OK_TWIPS_LO && eff.n <= OK_TWIPS_HI)) {
            offenders.push({ i, t, why: `首行缩进 ${eff.n} twips（约 ${(eff.n / 240).toFixed(2)} 字符，非两字符）` });
          }
        } else {
          // 单位未知（旧数据或异常属性）：保守处理，不报，避免误伤
          continue;
        }
      }
      // 首行缩进是**文档级**排版属性，不是逐段落的写作问题：编辑用一次「全选→段落→
      // 首行缩进两字符」就能全文改好。若逐段落报，实测会在 515 份稿件上产生 3 400 条
      // 问题，把问题清单淹没。因此归并为**每条稿件一条**，消息里给出处数与首处位置。
      /**
       * ⚠️ 第 30 轮修的第五点（决定性的）：**按「违规比例」判定，不按「有无违规」**。
       *
       * 首行缩进是**文档级**排版属性：真不合规的稿件是**绝大多数正文段**都不缩进，
       * 而合规稿件里零星的几段不缩进，通常是引言块、独立引文、发言小标题、
       * 名录行等本来就不缩进的结构 —— 逐段判定必然把它们算成违规。
       *
       * 实测违规段落占正文段的比例（正文段 ≥5 的稿件）：
       *
       *   | 阈值 | 已过审 14 篇 | 在审 605 篇 |
       *   |---|---:|---:|
       *   | >0%（原实现） | **57.1%** | 55.9% | ❌ 反向 |
       *   | >10% | **0.0%** | **22.0%** | ✅ 完全分离 |
       *   | >20% | 0.0% | 8.6% | ✅ |
       *
       * 已过审层的比例分布 P50=0.03、P90=0.05（即最多 5%），在审层 P90=0.16。
       * 取 **>10%** 作门槛：已过审层 **0 篇**命中，在审层 133 篇命中 ——
       * 这是本轮所有改动里分离最干净的一处。
       */
      const OFFENDER_RATIO = 0.10;
      const checkedBody = paras.filter((_, i) => roles[i] === 'body').length;
      const ratio = checkedBody ? offenders.length / checkedBody : 0;
      if (offenders.length && ratio > OFFENDER_RATIO) {
        const first = offenders[0];
        issues.push(mkIssue(rule, {
          location: `paragraph:${paras[first.i].index}`, paragraphIndex: first.i, quote: snippet(first.t, 0, 40),
        }, {
          message: `正文段落段首未空两格：共 ${offenders.length} 处（占正文段 ${(ratio * 100).toFixed(0)}%，首处在第 ${paras[first.i].index} 段，${first.why}）`,
          suggestion: '全选正文 → 段落 → 特殊格式「首行缩进」设为 2 字符，全文一次改好',
        }));
      }
      info.push({ id: 'FMT-027', label: '段首缩进', value: `未空两格的正文段落 ${offenders.length} 处（占 ${(ratio * 100).toFixed(0)}%）` });
    }
  }

  /* --- FMT-022 确切数字统一使用阿拉伯数字 --- */
  {
    const rule = R('FMT-022');
    if (rule) {
      // 只查「中文数字 + 计量单位」这一种**确切数字**，例如「一万元」「二十公里」。
      // 这么窄是有实测依据的——先用宽模式在 632 篇上跑了一遍，发现三类都不是违规：
      //   · 「二三十岁」「十八九岁」        概数连用，GB/T 15835 允许用中文数字
      //   · 「百分之九十」                  习用语，非确切统计量（宽模式命中 25 处，全是这类）
      //   · 「万千瓦」「26.5万亿元」        万/亿/万亿 是**量级前缀**不是中文数字
      // 把这三类排除后，命中从 142 处降到 **3 处**，且 3 处都是「一万元」这类真违规。
      // 宁可只报 3 处真的，也不要报 142 处让编辑失去信任。
      //
      // 左边界只排除**前面紧挨着另一个中文数字**（如「一二十公里」的概数连用），
      // 不能写成「前面不能是任何汉字」——那样「总金额为**一万元**」会因为前面是「为」而漏报。
      const UNITS22 = '公里|公斤|吨|平方米|平方公里|亿元|万元|个百分点|摄氏度';
      const re22 = new RegExp(`(?<![一二三四五六七八九十百千万两])[一二三四五六七八九十百两]{1,4}(?:${UNITS22})`, 'g');
      // 固定短语白名单：这些是成语/习用语，不是确切计量，报出来是误报。
      // 「最后一公里」实测在语料里反复出现（政策话语里的固定说法）。
      const PHRASE_OK = [/最后一公里/, /最后一英里/];
      const CN2AR = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100 };
      const cnToNum = (s) => {
        let n = 0, cur = 0;
        for (const ch of s) {
          const v = CN2AR[ch];
          if (v === 10) cur = (cur || 1) * 10;
          else if (v === 100) cur = (cur || 1) * 100;
          else cur += v;
        }
        return n + cur;
      };
      for (let i = 0; i < paras.length; i += 1) {
        const t = paras[i].text || '';
        re22.lastIndex = 0;
        let m;
        while ((m = re22.exec(t))) {
          const numPart = m[0].replace(new RegExp(`(?:${UNITS22})$`), '');
          const unitPart = m[0].slice(numPart.length);
          // 概数连用要排除。三种形态都要挡住，实测都出现过：
          //   · 「两三平方公里」——模式会**整体**匹配成「两三平方公里」（before 是「有」，左边界挡不住）
          //   · 「一二十公里」——整体匹配成「一二十公里」
          //   · 「五六个平方公里」——因「个」不在单位表里，只匹配到「六平方公里」，需靠左边界挡
          // 判据：数字部分出现**两个相邻的数字字符**（「两三」「一二」）即为概数连用。
          const before = m.index > 0 ? t[m.index - 1] : '';
          if (/[一二三四五六七八九十百千万两]/.test(before)) continue;
          if (/[一二三四五六七八九两][一二三四五六七八九两]/.test(numPart)) continue;
          // 固定短语白名单（成语/习用语，非确切计量）
          if (PHRASE_OK.some((re) => re.test(t.slice(Math.max(0, m.index - 4), m.index + m[0].length + 4)))) continue;
          const asNum = cnToNum(numPart);
          issues.push(mkIssue(rule, {
            location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(t, m.index, 30), offset: m.index,
            fixText: `${asNum}${unitPart}`,
          }, {
            message: `确切数字宜用阿拉伯数字：「${m[0]}」`,
            suggestion: `改为「${asNum}${unitPart}」（概数如「二三十岁」、习用语如「百分之九十」「最后一公里」不在此列）`,
          }));
        }
      }
    }
  }

  /* --- FMTB-010 年代按刊例写作「1950—1960年代」「2010年代」 --- */
  {
    const rule = R('FMTB-010');
    if (rule) {
      // 刊例要求世纪内的十年跨度用阿拉伯数字加「年代」，不写「20世纪五六十年代」。
      //
      // 第二、三个模式要**收窄到整十年**，这是模型复核逼出来的修正：
      // 原模式 `[0-9]{4}年之后` 会把「1965年以后」「2019年之后」一并报出，
      // 而模型给出的不同意理由是「『1965年以后』是时点，改年代会篡改原意」——
      // 这个理由是对的：1965 落在 1960 年代里，但「1965年以后」≠「1960年代」。
      // 刊例条文举的例子本身就是「2010年之后」→「2010年代」，
      // 只有年份正好落在**整十年**（末位为 0）时两者才等价。
      // 所以把 `[0-9]{4}` 收成 `[0-9]{3}0`。
      const P10 = [
        { re: /[0-9]{2}世纪[一二三四五六七八九十]{1,3}十年代/g, what: '世纪+中文数十年代表述' },
        { re: /[0-9]{3}0年之后/g, what: '「××××年之后」（整十年）' },
        { re: /[0-9]{3}0年以后/g, what: '「××××年以后」（整十年）' },
      ];
      for (const { re, what } of P10) {
        for (let i = 0; i < paras.length; i += 1) {
          const t = paras[i].text || '';
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(t))) {
            issues.push(mkIssue(rule, {
              location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(t, m.index, 30), offset: m.index,
            }, {
              message: `年代表述不合刊例（${what}）：「${m[0]}」`,
              suggestion: '改为「1950—1960年代」「2010年代」这类阿拉伯数字加「年代」的写法',
            }));
          }
        }
      }
    }
  }

  /* --- FMTB-012 作者简介须置于正文后 --- */
  {
    const rule = R('FMTB-012');
    if (rule) {
      /**
       * 只报「作者系……」这一种形态，且只报它出现在**正文前段**的情况。
       *
       * 为什么要收得这么窄 —— 三种简介形态在语料里的分布（抽样 150 篇）：
       *
       *   A-单位姓名（「北京大学法学院博士研究生 朵悦」）  前段 9 / 后段 10
       *   B-姓名在前（「张三，复旦大学教授」）              前段 1 / 后段 0
       *   C-作者系…（「作者系北京大学新闻与传播学院研究员」）前段 5 / 后段 48
       *
       * A 形态出现在前段是**正常的署名行**（题名下的作者与单位），不是错位；
       * C 形态后段 48 条是**合规**的正文后简介；只有 C 形态出现在前段才是
       * 规则说的「未置于正文后」。所以判据 = C 形态 && 位置在前 75%。
       *
       * 一开始我按「(大学|学院|研究院)…(教授|研究员)」全文匹配，
       * 结果 150 篇报出 283 条，绝大多数是**正文里提到某位教授**的正常句子
       * （「复旦大学张维为教授在2010年提出…」）。加上「整段 ≤60 字」与
       * 「以作者系开头」两条约束后降到 73 条，再按形态分流才拿到这 5 条真命中。
       */
      const RE_BIO = /^(作者)?系[\u4e00-\u9fa5]{2,20}(大学|学院|研究院|研究所|党校|社会科学院|社科院)[^。]{0,40}(教授|副教授|讲师|研究员|副研究员|助理研究员|博士|博士后|编辑|编审|主任|所长|院长|博士生)/;
      const cutoff = Math.floor(paras.length * 0.75);
      for (let i = 0; i < cutoff; i += 1) {
        const t = (paras[i].text || '').trim();
        if (!t || [...t].length > 60) continue;
        if (!RE_BIO.test(t)) continue;
        issues.push(mkIssue(rule, {
          location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: t.slice(0, 80),
        }, {
          message: `作者简介出现在正文前段（第 ${i + 1} 段，全文共 ${paras.length} 段）：「${t.slice(0, 40)}」`,
          suggestion: '把作者简介移到正文末尾（也可置于篇首页下脚注），不要夹在正文中间',
        }));
      }
    }
  }

  /* --- FMT-026 计量单位与数字之间不留空格 --- */
  {
    const rule = R('FMT-026');
    if (rule) {
      /**
       * 规则原文（依据 GB/T 15835-2011）：「中文语境下数值与中文单位连写
       * （如「1018公里」「2.589亿元」）；使用国际符号时符号与数值之间留一空格
       * （如「10 km」）」。
       *
       * 所以违规形态 = **数字 + 空格 + 中文单位**。
       *
       * 单位表刻意只收**语义无歧义**的度量单位。第一版把
       * 年/月/日/人/个/家/所/篇/部/册/次/度/倍 也放进去了，结果 150 篇报 52 处，
       * 绝大多数是结构误报：「表6 家庭消费支出分级」（表序+空格+表题）、
       * 「第3 章」这类。排除后 150 篇只剩 3 处，都是真的（「支出为 13.5 亿元」）。
       */
      const UNITS26 = '公里|公斤|吨|平方米|平方公里|平方千米|立方米|亿元|万元|千元|百万元'
        + '|个百分点|摄氏度|千米|厘米|毫米|毫克|毫升|千瓦|兆瓦|公顷|美元|欧元|日元'
        + '|岁|小时|分钟|海里|英里|英尺|英寸|亩|升|克|米|元';
      const re26 = new RegExp(`[0-9]\\s+(${UNITS26})`, 'g');
      for (let i = 0; i < paras.length; i += 1) {
        const t = paras[i].text || '';
        re26.lastIndex = 0;
        let m;
        while ((m = re26.exec(t))) {
          issues.push(mkIssue(rule, {
            location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(t, m.index, 30), offset: m.index,
          }, {
            message: `数值与中文单位之间多了一个空格：「${m[0]}」`,
            suggestion: '中文单位与数值连写，去掉空格（写作「13.5亿元」）；若用国际符号则保留空格（写作「13.5 亿元」以外的「13.5 bn」形式需与全文统一）',
          }));
        }
      }
    }
  }

  /* --- FMTB-039 正文引用他人观点一律用姓名，不加单位与职称 --- */
  {
    const rule = R('FMTB-039');
    if (rule) {
      /**
       * 违规形态 = 「姓名 + 职称 + 认为/指出/提出/强调」。
       *
       * 实测 150 篇报 32 处 / 14 篇，样例都是真的：
       *   「张维为教授指出：『文明型国家』叙事就是…」
       *   「以张维为教授提出的文明型国家特征作为判断标尺…」
       * 刊例要求正文引用他人观点只写姓名，不挂单位与职称。
       *
       * 只认职称紧贴姓名（中间无标点、无「的」），避免把
       * 「张维为教授」（职称是同位语）之外的正常表述误收；
       * 也**不认「老师」** —— 语料里的「张老师」全部出现在编辑批注里
       * （「请戴老师结合…」），是编辑对作者的称呼，不是正文引用，
       * 收进来就是误报。
       */
      const re39 = /[\u4e00-\u9fa5]{2,4}(教授|副教授|研究员|副研究员|博士|院士)(认为|指出|提出|强调|主张|看来)/g;
      const scan39 = (text, loc, off) => {
        re39.lastIndex = 0;
        let m;
        while ((m = re39.exec(text))) {
          issues.push(mkIssue(rule, { ...loc, quote: snippet(text, m.index, 34), offset: m.index }, {
            message: `正文引用他人观点时挂了职称：「${m[0]}」`,
            suggestion: `改为只写姓名：「${m[1]}」前的职称删去，写成「${m[0].replace(/(教授|副教授|研究员|副研究员|博士|院士)/, '')}」；职称与单位信息如需交代，放到脚注或文末作者信息里`,
          }));
        }
      };
      for (let i = 0; i < paras.length; i += 1) {
        scan39(paras[i].text || '', { location: `paragraph:${paras[i].index}`, paragraphIndex: i });
      }
      // 脚注里的引用同样适用
      doc.footnotes.forEach((p, i) => {
        if (!p.text || p.isNoteSeparator) return;
        scan39(p.text, { location: `footnote:${i}`, footnoteIndex: i });
      });
    }
  }

  /* --- FMTB-036 标题中不使用选择性标点 --- */
  {
    const rule = R('FMTB-036');
    if (rule) {
      // **只查标题**，不查正文。
      // 规则条文明确写「标题中通常不使用选择性标点（如「/」）」，
      // 但 detect.patterns 里那两个模式（`汉字/汉字`、`汉字|汉字`）如果全文跑，
      // 会把「欧洲/加拿大」「敌/我意识」「种族/族群/祖先/偏见」这类**正文里的正常并列**
      // 全部报出来 —— 实测 632 份里 270 篇命中，而真正在标题里的只有 1 处。
      // 所以这里按条文语义收窄到 title / heading 角色。
      const P36 = [
        { re: /[\u4e00-\u9fa5]{2,10}\/[\u4e00-\u9fa5]{2,10}/g, ch: '/' },
        { re: /[\u4e00-\u9fa5]{2,10}\|[\u4e00-\u9fa5]{2,10}/g, ch: '|' },
      ];
      for (let i = 0; i < paras.length; i += 1) {
        const role = roles[i];
        if (role !== 'title' && role !== 'heading') continue;
        const t = paras[i].text || '';
        for (const { re, ch } of P36) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(t))) {
            issues.push(mkIssue(rule, {
              location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(t, m.index, 40), offset: m.index,
            }, {
              message: `标题中使用了选择性标点「${ch}」：「${m[0]}」`,
              suggestion: '换用一个能涵括并列项的上级概念，避免在标题里做二选一',
            }));
          }
        }
      }
    }
  }

  /* --- FMTB-015 摘要与关键词的起头标记 --- */
  {
    const rule = R('FMTB-015');
    /**
     * 机械改写：把行首的提要/关键词标记规整为「[内容提要]」「[关键词]」。
     * 覆盖「摘要：」「内容摘要」「[内容摘要]」「【内容摘要】」等一切变体；
     * 无任何标记（纯正文起头）时不自动改写——那需要判断该段就是提要，
     * 交给人工，避免误加标记。英文关键词（Key Words:）也不自动改成中文。
     */
    for (const i of roleIndex.get('abstract') || []) {
      const text = paras[i].text;
      if (!/^\s*\[内容提要\]/.test(text)) {
        const m = /^\s*[\[［【]?\s*(?:内容提要|内容摘要|摘要)\s*[\]］】]?\s*[:：]?\s*/.exec(text);
        const autoFix = m && m[0] ? { find: m[0], replace: '[内容提要]', offset: 0 } : undefined;
        issues.push(mkIssue(rule, { location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(paras[i].text, 0, 40) }, {
          message: '内容提要的起头标记不规范',
          suggestion: '改为「[内容提要]」形式（方头方括号，不用「摘要」「内容摘要」）',
          autoFix,
        }));
      }
    }
    for (const i of roleIndex.get('keywords') || []) {
      const text = paras[i].text;
      if (!/^\s*\[关键词\]/.test(text)) {
        const m = /^\s*[\[［【]?\s*(?:关键词|关键字)\s*[\]］】]?\s*[:：]?\s*/.exec(text);
        const autoFix = m && m[0] ? { find: m[0], replace: '[关键词]', offset: 0 } : undefined;
        issues.push(mkIssue(rule, { location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(paras[i].text, 0, 40) }, {
          message: '关键词的起头标记不规范',
          suggestion: '改为「[关键词]」形式（方头方括号）',
          autoFix,
        }));
      }
    }
  }

  /* --- FMTB-023 作者简介一个身份即可，最多不超过两个 --- */
  {
    const rule = R('FMTB-023');
    for (const i of roleIndex.get('authorBio') || []) {
      const t = paras[i].text;
      const titles = t.match(/(教授|副教授|研究员|副研究员|讲师|博士|博士生|硕士生|研究生|院长|副院长|所长|副所长|主任|副主任|编审|博士后|访问学者|特聘教授|助理教授)/g) || [];
      if (titles.length > 2) {
        issues.push(mkIssue(rule, { location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(t, 0, 70) }, {
          message: `作者简介列出 ${titles.length} 个身份（${[...new Set(titles)].join('、')}），过多`,
          suggestion: '一个身份即可，最多不超过两个',
        }));
      }
    }
  }

  /* --- FMTB-031 百分比、占比、比例须说明分母与计算口径 --- */
  {
    const rule = R('FMTB-031');
    for (let i = 0; i < paras.length; i += 1) {
      const t = paras[i].text;
      const re = /(占|占比|比例|比重)[^，。；]{0,10}?([0-9]+(\.[0-9]+)?\s*[%％])/g;
      let m;
      while ((m = re.exec(t))) {
        const ctx = t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 20);
        // 已交代分母（「占……的」「其中……中」）或紧跟来源的不报
        if (/(的|中|总数|合计|总额|总量|样本|受访|调查)[^，。；]{0,10}$/.test(t.slice(Math.max(0, m.index - 12), m.index))) continue;
        // 分母写在**模式内部**的情况也要挡掉：matched 文本形如「占美国人口的61.6%」
        // 或「占美国所有新移民的近85%」—— 「的」后面接的就是分母的数值，规则要的
        // 分母信息已经给全了。实测这一形态占「实际报出」量的 **41%**（129 处里 53 处），
        // 是这条规则最大的误报来源。模型复核也反复指出这一点
        // （「已明示分母为美国人口，无须补」「原文已写明『占美国成年人口的70%』」）。
        //
        // 判据：matched 文本里出现「的」，且其后（允许「近/约/超过」等修饰词）
        // 直接就是数字。注意**不能**写成「的 + 汉字 + 数字」—— 那样会漏掉
        // 「占美国人口的61.6%」这种最常见的形态（「的」后面紧接数字），
        // 第一版就是这么写错的，结果只挡住了 16 处。
        if (/的[^，。；0-9]{0,4}[0-9]/.test(m[0])) continue;
        issues.push(mkIssue(rule, { location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: ctx.slice(0, 70), offset: m.index }, {
          message: `百分比「${m[2]}」未交代分母与计算口径`,
          suggestion: '补出分母与计算口径，如「占全国总量的×%」',
        }));
      }
    }
  }

  /* --- FMTB-026 年份起止用一字线（与 FMT-025 呼应，此处只报减号形式） --- */
  {
    const rule = R('FMTB-026');
    const targets = [...paras.map((p, i) => ({ text: p.text, pi: i, fi: -1 }))];
    doc.footnotes.forEach((p, i) => targets.push({ text: p.text, pi: -1, fi: i }));
    for (const t of targets) {
      const re = /([0-9]{4})\s*[-–]\s*([0-9]{4})/g;
      let m;
      while ((m = re.exec(t.text))) {
        // 西文文献著录中的年份区间用 en dash（1945–1952）是规范写法，不报
        const around = t.text.slice(Math.max(0, m.index - 40), m.index + 40);
        if (!CN.test(around)) continue;
        if (/[A-Za-z]{3,}/.test(around)) continue;
        /**
         * 非年份的数字区间不算「年份起止」（全语料实测）：页码「第3116-3117页」、
         * 金额「5700-6000元」都被报成了年份。两个判据：
         *   1. 两个数都须落在合理年份区间 [1600, 2100]；
         *   2. 前有「第」或后有「页」说明是页码区间（归 CIT-008 管），不报年份。
         * 实测 238 条命中里 24 条（10.1%）是这类误报。
         */
        const y1 = Number(m[1]); const y2 = Number(m[2]);
        if (y1 < 1600 || y1 > 2100 || y2 < 1600 || y2 > 2100) continue;
        const pre2 = t.text.slice(Math.max(0, m.index - 2), m.index);
        const post2 = t.text.slice(m.index + m[0].length, m.index + m[0].length + 2);
        if (/第$/.test(pre2) || /^页/.test(post2)) continue;
        const loc = t.pi >= 0
          ? { location: `paragraph:${paras[t.pi].index}`, paragraphIndex: t.pi }
          : { location: `footnote:${t.fi}`, footnoteIndex: t.fi };
        issues.push(mkIssue(rule, { ...loc, quote: snippet(t.text, m.index, 30), offset: m.index }, {
          message: `年份起止用了减号/半字线：「${m[0]}」`,
          suggestion: '改用一字线（起止号）「—」，如「1949—1955」',
          autoFix: { find: m[0], replace: m[0].replace(/\s*[-–]\s*/, '—'), offset: m.index },
        }));
      }
    }
  }

  /* --- FMTB-018 本刊黑白印刷，图表不得用颜色区分 --- */
  {
    const rule = R('FMTB-018');
    const full = paras.map((p) => p.text).join('\n');
    if (/(图|表)[0-9]{1,2}[^。]{0,40}(红色|蓝色|绿色|黄色|橙色|紫色|彩色|红、蓝|不同颜色)/.test(full)) {
      const m = /(图|表)[0-9]{1,2}[^。]{0,40}(红色|蓝色|绿色|黄色|橙色|紫色|彩色|红、蓝|不同颜色)/.exec(full);
      issues.push(mkIssue(rule, { location: 'document', quote: m[0].slice(0, 60) }, {
        message: '图表说明中用颜色区分，本刊黑白印刷无法辨识',
        suggestion: '改用黑灰配色、不同图案或形状区分，并在图例中说明',
      }));
    }
  }

  /* --- FMTB-041 正文残留整理者／编务工作标记 ---
   *
   * 形态来自实测：632 篇语料里 `【】` 共出现 605 次、208 种内容，
   * 其中 **47 种、124 次**是整理者/编务留下的**日期+时段**工作标记：
   *   【1014中午】【0929，下班】【0108下班至此】【0725傍晚至此】【0202晚餐前】
   * 这类内容绝不能出现在刊发稿里（是编务流水记录，不是稿件内容）。
   *
   * 判据必须**要求日期成分**，否则会误报：
   *   · 【摘要】【关键词】是合法结构标记（34 次，实测全部排除）；
   *   · 单独的时段词（如「晚」「早」）在中文里是正常用字，不能单凭它判定。
   * 因此正则要求「数字日期（可带分隔符）+ 可选逗号 + 时段词」。
   *
   * 实测命中 124 次 / 47 种形态，逐条核对**全部属实**，无误报。
   *
   * 未纳入本规则的相邻形态（各自独立、判据不同，避免混在一起降低精度）：
   *   · 【说明：…】编务给作者的说明（42 种）—— 多数是**应当**保留的沟通内容；
   *   · 【待…】【请…把关】—— 属审稿意见，不是残留标记；
   *   · 【（中美？）】译者疑问标记 —— 另有形态，样本过少未建规则。
   */
  {
    const rule = R('FMTB-041');
    /**
     * 日期 + 时段的工作标记。
     * 日期允许 3—4 位（如 `1014`、`0108`）或带分隔符的完整日期；
     * 时段词收全实测形态：上午/中午/下午/晚上/傍晚/凌晨/下班/上班/晚/早/晨/夜。
     * 尾部允许「至此/到此/晚餐前」等编务措辞（`[^】]{0,8}`）。
     */
    const MARK = /【\s*(?:[0-9]{4}[-.\/])?[0-9]{1,4}\s*[，,]?\s*(?:上午|中午|下午|晚上|傍晚|凌晨|下班|上班|晚餐前|晚|早|晨|夜)[^】]{0,8}】/;
    const hits = [];
    for (let i = 0; i < paras.length; i += 1) {
      const t = String(paras[i].text || '');
      /**
       * 必须用 `g` + `exec` 循环取**全部**匹配。
       *
       * 踩过的坑：最初写成 `MARK.exec(t)` 只取第一个匹配，于是
       * 「本段有【1014中午】和【1022下午】两处标记」只报 1 处 ——
       * 而 `occurrenceCount` 与 `occurrences` 正是「勾一条改全文同类」
       * 的依据，漏一处就等于那处永远改不掉。
       * 这与 FMT-014 的做法一致（那里也是 `new RegExp(pat,'g')` + while）。
       */
      const re = new RegExp(MARK.source, 'g');
      let m;
      while ((m = re.exec(t))) {
        hits.push({ i, quote: m[0], offset: m.index });
        if (m[0].length === 0) re.lastIndex += 1; // 防零宽匹配死循环
      }
    }
    if (hits.length) {
      /**
       * 这里给 `autoFix` 而不是只写 `autoFixable: true`。
       *
       * `autoFixable` 只是规则库里的**声明**，`/api/apply-fixes` 真正执行的是
       * `it.autoFix.{find,replace,offset}` —— 只写声明不产出 autoFix，
       * 界面上会显示「可自动改写」但点下去得到
       * 「该规则不支持自动改写」。删除残留标记是**唯一**不需要判断语境的
       * 修法（删掉即可），所以这条应当真的可自动改写。
       */
      const first = hits[0];
      issues.push(mkIssue(rule, {
        location: `paragraph:${paras[first.i].index}`,
        paragraphIndex: first.i,
        quote: first.quote,
      }, {
        message: hits.length > 1
          ? `${rule.title}（全文共 ${hits.length} 处，此处为首处）`
          : rule.title,
        suggestion: '删除该标记；编务进度请记录在流程系统，不要留在稿件正文里',
        autoFix: { find: first.quote, replace: '', offset: first.offset },
        occurrenceCount: hits.length,
        /**
         * ⚠️ 每一处必须带**自己的** `autoFix.offset`。
         *
         * `/api/apply-fixes` 把归并条目按 `occurrences` 展开成逐处条目，
         * 展开时取 `o.autoFix || raw.autoFix` —— 也就是说，occurrence 上
         * 若没有自己的 autoFix，就会**回退到父条目的 autoFix**，
         * 而父条目的 offset 是**首处**的偏移。
         * 后果：第 2 处及以后全部用首处偏移去替换，落到别的文字上，
         * 被静默记为「未产生变化」——用户勾一条以为全改了，实际只改了第一处。
         * 实测确认：`applied=1 skipped=[{reason:'未产生变化'}]`。
         */
        occurrences: hits.map((h) => ({
          location: `paragraph:${paras[h.i].index}`,
          paragraphIndex: h.i,
          quote: h.quote,
          offset: h.offset,
          autoFix: { find: h.quote, replace: '', offset: h.offset },
        })),
      }));
    }
  }

  /* --- 统计汇总 --- */
  const summary = {
    total: issues.length,
    bySeverity: countBy(issues, (i) => i.severity),
    byCategory: countBy(issues, (i) => i.category),
    byRule: countBy(issues, (i) => i.ruleId),
  };
  return { issues, info, summary, rulesApplied: cfg.rules.length };
}

function countBy(arr, fn) {
  const m = {};
  for (const x of arr) {
    const k = fn(x) || '其他';
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

/** 20世纪90年代 -> 1990年代；二十世纪九十年代 -> 1990年代 */
function convertCentury(s) {
  const m = /([0-9]{1,2})世纪([0-9]{2})年代/.exec(s);
  if (m) {
    const century = parseInt(m[1], 10);
    const decade = m[2];
    return `${(century - 1) * 100 + parseInt(decade, 10)}年代`;
  }
  const m2 = /([0-9]{1,2})世纪([一二三四五六七八九十]+)年代/.exec(s);
  if (m2) {
    const century = parseInt(m2[1], 10);
    const d = cnNum(m2[2]);
    if (d) return `${(century - 1) * 100 + (d >= 10 ? d : d * 10)}年代`;
  }
  /**
   * 中文数字世纪 + 阿拉伯数字十年：「二十世纪80年代」→「1980年代」。
   *
   * 第 22 轮补充：这是中文/阿拉伯混用的常见写法，原实现三种模式都不认，
   * 于是完全没有覆盖。
   */
  const m4 = /([一二三四五六七八九十]{1,3})世纪([0-9]{2})年代/.exec(s);
  if (m4) {
    const century = cnNum(m4[1]);
    if (century) return `${(century - 1) * 100 + parseInt(m4[2], 10)}年代`;
  }
  /**
   * 中文数字世纪：「二十世纪九十年代」→「1990年代」。
   *
   * 第 22 轮补充：原 convertCentury 只认阿拉伯数字世纪，
   * 于是「二十世纪九十年代」**完全没有规则覆盖**（实测语料里存在）。
   */
  const m3 = /([一二三四五六七八九十]{1,3})世纪([一二三四五六七八九十]{1,3})年代/.exec(s);
  if (m3) {
    const century = cnNum(m3[1]);
    const d = cnNum(m3[2]);
    if (century && d) return `${(century - 1) * 100 + (d >= 10 ? d : d * 10)}年代`;
  }
  return s;
}

/** 中文数字（个位或「十」「二十」…）→ 数值；无法解析返回 0 */
function cnNum(s) {
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const t = String(s || '').trim();
  if (!t) return 0;
  if (t === '十') return 10;
  const m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(t);
  if (m) return (m[1] ? digits[m[1]] : 1) * 10 + (m[2] ? digits[m[2]] : 0);
  return digits[t] || 0;
}

/**
 * 「上世纪八十年代」→「1980年代」、「上世纪90年代」→「1990年代」、
 * 「上世纪六七十年代」→「1960—1970年代」。
 *
 * 依据是**编辑自己的修订**（语料实测，见第 22 轮记录）：
 *   「20世纪60年代中后期」→「1960年代中后期」
 *   「五、六十年代」      →「1950—1960年代」
 *   「八十年代」          →「1980年代」
 *   「20世纪二三十年代」  →「1920—1930年代」
 * 即：本刊统一用**四位阿拉伯数字 + 年代**，跨十年用一字线连接。
 * 无法转换时原样返回，调用方据此跳过（避免产生空操作改写）。
 */
function convertShangShiji(s) {
  const t = String(s || '').trim();
  // 「上世纪」前缀可有可无；核心是「N十年代」或「N十N十年代」
  const m = /^(上世纪)?\s*([0-9]{2}|[一二三四五六七八九十]{1,3}十)\s*年代$/.exec(t);
  if (!m) return s;
  const raw = m[2];
  const hasPrefix = Boolean(m[1]);
  // 阿拉伯两位：只在上世纪前缀下才认定（「90年代」单独出现含义不明）
  if (/^[0-9]{2}$/.test(raw)) {
    if (!hasPrefix) return s;
    return `${1900 + parseInt(raw, 10)}年代`;
  }
  // 中文数字：「八十」「六十」「二十」等
  const v = cnNum(raw);
  if (!v) return s;
  // 带「上世纪」前缀时基准是 1900；不带前缀时按「二十/三十」这类习惯写法补全到 19xx
  const year = hasPrefix ? 1900 + v : (v >= 10 ? 1900 + v : 1900 + v);
  return `${year}年代`;
}

/**
 * 「二十世纪」→「20世纪」（中文数字世纪改阿拉伯数字）。
 *
 * 依据是编辑自己的修订：语料实测 36 处中文世纪被直接改成阿拉伯世纪
 * （「二十世纪」→「20世纪」、「十九世纪」→「19世纪」），另有编辑批注
 * 「作者所述18世纪60年代【已由一审按刊例调整为1760年代】」。
 * 注意这里只处理**后面不接「年代」**的「N世纪」——接「年代」的
 * 由 convertCentury 处理成四位年份（「二十世纪九十年代」→「1990年代」）。
 */
function convertCnCentury(s) {
  const m = /^([一二三四五六七八九十]{1,3})世纪$/.exec(String(s || '').trim());
  if (!m) return s;
  const n = cnNum(m[1]);
  if (!n || n < 2) return s; // 「一世纪」不是中文世纪的常规写法，不动
  return `${n}世纪`;
}

/**
 * 「上世纪六七十年代」→「1960—1970年代」（复合年代）。
 * 单独处理是因为它含两个数字，convertShangShiji 只认单个。
 *
 * 分隔符要认三种写法：连写「六七十」、顿号「五、六十」、间隔「六、七十」。
 * 依据仍是编辑自己的修订：「五、六十年代」→「1950—1960年代」。
 */
function convertCompoundDecade(s) {
  const m = /^(上世纪)?\s*([一二三四五六七八九十])\s*[、，,]?\s*([一二三四五六七八九十])\s*十\s*年代$/.exec(String(s || '').trim());
  if (!m) return s;
  const a = cnNum(`${m[2]}十`);
  const b = cnNum(`${m[3]}十`);
  if (!a || !b) return s;
  return `${1900 + a}—${1900 + b}年代`;
}

