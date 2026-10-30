/**
 * DOCX 只读解析引擎。
 * 提取：段落（含修订前后文本）、批注、修订痕迹、脚注/尾注、样式、表格、字体与字号。
 * 原始稿件永不写回。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { openZip, isOle2 } from './zip.js';
import { parseXml, XmlNode } from './xml.js';

const W = 'w:';

function localName(n) {
  return n.includes(':') ? n.split(':').pop() : n;
}

/** 判断节点是否位于某类祖先之内（修订/批注范围） */
function hasAncestor(node, names) {
  let p = node.parent;
  while (p) {
    if (names.has(p.name)) return p;
    p = p.parent;
  }
  return null;
}

const RUN_SKIP_AFTER = new Set(['w:del', 'w:moveFrom']);
const RUN_SKIP_BEFORE = new Set(['w:ins', 'w:moveTo']);

/**
 * 取一个 `w:t` 所属 run 的上下标属性。
 *
 * `w:vertAlign` 是 **run 级**属性，而 `runFormat()` 算的是**段落级**摘要
 * （取第一个有 rPr 的 run 当主来源）—— 所以正文段落里夹着的那一个上标
 * 根本不会体现为 `info.superscript`。实测：`info.superscript` 解析出来后
 * **全项目零处使用**，等于读进来就丢掉了。
 * 要判断「哪个字是上标」必须逐 run 看，这个函数就是那个粒度。
 */
function vertAlignOf(tNode) {
  const r = tNode.parent;
  if (!r) return '';
  const va = r.el('w:rPr')?.el('w:vertAlign')?.val;
  if (va === 'superscript') return 'superscript';
  if (va === 'subscript') return 'subscript';
  return '';
}

/**
 * 从域指令里解析域类型。
 *
 * 指令形如 `HYPERLINK "https://…"`、`ADDIN EN.CITE <EndNote>…`、`PAGE \* MERGEFORMAT`。
 * 取开头的词即可，但 `ADDIN EN.CITE` 是**两段式**，要一起取，
 * 否则 140 条 EndNote 引文域会被归成笼统的 `ADDIN`，失去区分度。
 *
 * 前提：传入的 `instr` 必须是**一个域内拼接完整**的指令 ——
 * 按单个 `w:instrText` 元素取会得到碎片（见 `fieldStack` 的注释）。
 */
function fieldTypeOf(instr) {
  const m = instr.match(/^([A-Za-z]+)(?:\s+(EN\.[A-Z]+))?/);
  if (!m) return 'UNKNOWN';
  return (m[1] + (m[2] ? ' ' + m[2] : '')).toUpperCase();
}

/**
 * 读 run 的高亮色。
 *
 * ── 为什么高亮值得抽取（实测结论，不是猜的）──
 * `w:highlight` 覆盖 **541 篇 / 632（85.6%）**，是本语料覆盖面最广的特殊格式。
 * 逐篇量过颜色分布与覆盖率后确认它是**责编标记**，不是模板残留：
 *   · 颜色分层：yellow 513 篇 / 41116 处，cyan 232 / 5082，magenta 72 / 951，
 *     green 32 / 228，red 25 / 1555 —— 不同颜色分不同类别
 *   · 覆盖率：418 篇 < 5%（局部标几处），只有 5 篇 ≥ 50%（整篇套了底纹）
 *   · 内容就是编辑意图：`[cyan]«待问»`（待问作者）、`[cyan]«雷»`（人名）、
 *     `[cyan]«泆»`（单字纠错）
 * 所以它是**编辑已标出的问题位置**，是审稿时最该看的信息之一。
 *
 * ⚠️ `w:val="none"` 是「显式取消高亮」，**不是高亮**。
 * 实测 42 篇 / 12270 处是这个值 —— 早期普查把它算成"有高亮"，
 * 使覆盖率虚高（62980 次 vs 真实的 49157 次），这里必须排除。
 */
const HIGHLIGHT_NONE = new Set(['none', '']);
function highlightOf(tNode) {
  const v = tNode.parent.el('w:rPr')?.el('w:highlight')?.val;
  if (!v || HIGHLIGHT_NONE.has(v)) return null;
  return v;
}

/**
 * 收集一个图/文本框/嵌入对象里的**非正文内容**。
 *
 * 需求原话是「识别并结构化抽取……而**不是当成普通文字**或直接丢失」，
 * 所以图内文字收进 `collect.textboxes` 这个独立结构，而不是拼进段落文本。
 * 它随后挂到宿主段落上（`p.textboxes` / `p.figures`），
 * 这样：① 规则可以按需取用（比如查图注、查图内文字是否与正文矛盾）；
 * ② 界面可以显示「此处有 1 张图，图内文字 N 字」；
 * ③ 正文语言规则**不会**在图上乱命中。
 *
 * 同时数出图片与公式：这两类此前**完全没解析**（源码零处引用），
 * 实测图片出现在 147 篇（23.3%）、公式 4 篇。
 */
function collectFigures(node, collect) {
  // 图内文字（文本框）。嵌套调用不传 collect，避免递归套娃
  for (const tb of node.descendants('w:txbxContent')) {
    const t = paragraphText(tb, 'after');
    if (t.trim()) collect.textboxes.push(t);
  }
  const count = (name) => node.descendants(name).length;
  /**
   * 图片**关系 id** 与显示尺寸。仅数出「有几张图」是不够的 ——
   * docx-preview 根本不渲染 `w:drawing`，所以要让图片真正出现在阅读器里，
   * 必须拿到 `r:embed` / `r:id`，再用 `word/_rels/*.rels` 解析出
   * `word/media/*` 的条目名，前端才能把字节喂到 `<img>`。
   *   `a:blip`      → `r:embed`（标准内嵌图片）
   *   `v:imagedata` → `r:id`   （VML 旧格式图片）
   *
   * ⚠️ 跳过 `mc:Fallback` 子树：那是 `mc:Choice` 的**旧版降级副本**，
   * 与 Choice 指向同一张图。收进来会让同一张图重复渲染（见文件头说明）。
   */
  const rIds = [];
  const extents = [];
  const walkFig = (n) => {
    for (const c of n.children) {
      if (c.name === 'mc:Fallback') continue;
      if (c.name === 'a:blip') {
        const id = c.attr('r:embed') || c.attr('r:link');
        if (id) rIds.push(id);
      } else if (c.name === 'v:imagedata') {
        const id = c.attr('r:id');
        if (id) rIds.push(id);
      } else if (c.name === 'wp:extent') {
        extents.push({ cx: Number(c.attr('cx')) || 0, cy: Number(c.attr('cy')) || 0 });
      }
      walkFig(c);
    }
  };
  walkFig(node);
  collect.figures.push({
    kind: node.name === 'w:pict' ? 'pict' : node.name === 'w:object' ? 'object' : 'drawing',
    images: count('a:blip') + count('v:imagedata'),
    equations: count('m:oMath') + count('m:oMathPara'),
    textboxes: count('w:txbxContent'),
    rIds,
    extents,
  });
}

/**
 * 解析 `.rels` 关系表：`Id → { type, target, mode }`。
 * 图片关系类型固定为 `.../relationships/image`，`Target` 形如 `media/image1.png`
 * （相对于 `word/` 目录）。
 */
function parseRels(xmlText) {
  const map = new Map();
  if (!xmlText) return map;
  const root = parseXml(xmlText);
  for (const r of root.descendants('Relationship')) {
    const id = r.attr('Id');
    if (!id) continue;
    map.set(id, { type: r.attr('Type') || '', target: r.attr('Target') || '', mode: r.attr('TargetMode') || '' });
  }
  return map;
}

/**
 * 把 Target 归一成 ZIP 内条目名。
 * `media/image1.png` → `word/media/image1.png`（关系表的相对基准是 `word/`）；
 * 已是绝对路径（`/word/...`）或已带目录前缀的原样返回。
 */
function mediaEntryPath(target) {
  let t = String(target || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (t.startsWith('/')) return t.slice(1);
  if (t.startsWith('word/')) return t;
  if (t.startsWith('../')) return t.replace(/^\.\.\//, '');
  return `word/${t}`;
}

/**
 * 把 figure 上的 `rIds` 解析成可直接取用的媒体条目：
 *   `{ rid, path, ext, external }`
 * `path` 是 ZIP 内条目名，前端据此走 `/api/session-media` 取字节；
 * `external` 为外链图片（`TargetMode="External"`，`path` 即原始 URL）。
 * 解析不出关系（`rIds` 为空 / 关系缺失）时 `media` 为空数组，前端会跳过。
 */
function resolveFigureMedia(figures, rels) {
  for (const f of figures) {
    const list = [];
    for (const rid of (f.rIds || [])) {
      const r = rels && rels.get(rid);
      if (!r) continue;
      const isImage = /\/image\b/.test(r.type) || /(^|\/)media\//.test(r.target);
      if (!isImage) continue;
      if (r.mode === 'External') {
        list.push({ rid, path: r.target, ext: '', external: true });
        continue;
      }
      const path = mediaEntryPath(r.target);
      list.push({ rid, path, ext: (path.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase(), external: false });
    }
    f.media = list;
  }
  return figures;
}

/**
 * 抽取段落文本。
 * @param {XmlNode} p
 * @param {'after'|'before'} mode after=接受修订后的文本；before=修订前的原文
 * @param {object} [collect] 传入则在同一遍遍历里顺带收集特殊格式的位置信息。
 *   两件事必须**同一遍遍历**完成：分两遍走会因跳过规则/域代码状态的细微差别
 *   导致偏移对不上，而偏移一旦错位，锚点和下划线就会标到错误的字上。
 *   - `collect.marks`  ← 上标/下标区间 `{ kind, text, offset }`
 *   - `collect.noteRefs` ← 脚注/尾注引用标记 `{ kind, id, offset }`
 */
function paragraphText(p, mode, collect = null) {
  const skip = mode === 'before' ? RUN_SKIP_BEFORE : RUN_SKIP_AFTER;
  let out = '';
  /**
   * 域代码（field）状态。
   *
   * Word 的域由三个标记围起来：
   *   <w:fldChar w:fldCharType="begin"/>   域开始
   *   <w:instrText>…</w:instrText>         域的**指令**（读者看不见）
   *   <w:fldChar w:fldCharType="separate"/> 指令与结果的**分界**
   *   <w:t>…</w:t>                         域的**缓存结果**（读者看得见）
   *   <w:fldChar w:fldCharType="end"/>     域结束
   *
   * 第 23 轮实测：EndNote/Zotero 的 `ADDIN EN.CITE` / `ADDIN ZOTERO_ITEM`
   * 会把整段 XML 塞进 `w:instrText`。原实现把 `w:instrText` 和 `w:t` 一视同仁地
   * 拼进文本，于是脚注文本里混进上千个 `<Author>`、`<style>`、`<DisplayText>`
   * 之类的标签 —— 全语料半角尖括号 4676 处里有 4278 处是这么来的（22 篇、140 个域）。
   * 这些是**隐藏的域指令**，读者看不到，任何规则都不该在它上面命中。
   *
   * 修法：指令一律跳过；`separate` 之后的缓存结果照常保留
   * （那才是读者看到的内容）。域可嵌套，故用深度计数。
   */
  let fieldDepth = 0;
  let pastSeparate = false;
  /**
   * 域指令缓冲区（按嵌套层级压栈）。
   *
   * ⚠️ `w:instrText` 的内容**被拆散在多个 run 里** —— 一条
   * `HYPERLINK "https://…"` 会分成 `HYPERLINK "` + `https://…` + `"` 三个元素。
   * 按单个元素取"域类型"得到的是碎片：实测 632 篇里出现了
   * `TRIEVED`（来自 `retrieved"`）、`MEZHDUNARODNAYA`（俄文刊名）、
   * `CSL`/`STYLE`/`YLE`（来自 `csl-citation.json`）这类假类型，
   * 而真正的 `HYPERLINK`（91 篇 / 341 条）和 `ADDIN EN.CITE`
   * （22 篇 / 140 条，**EndNote 引文域**，指令里含完整文献元数据）反而被埋掉。
   * 所以必须先在**一个域的 begin..end 范围内拼接**，再解析类型。
   */
  const fieldStack = [];
  const walk = (node, insideSkip) => {
    for (const c of node.children) {
      let skipping = insideSkip;
      if (skip.has(c.name)) skipping = true;
      // Paragraph/run properties describe layout; their tab-stop declarations
      // are not visible run characters and must not enter either text view.
      if (c.name === 'w:pPr' || c.name === 'w:rPr') continue;
      // 批注引用标记不进入正文
      if (c.name === 'w:commentReference' || c.name === 'w:annotationRef') continue;
      /**
       * `mc:AlternateContent` 是 OOXML 的「新旧版本二选一」包装：
       *   <mc:Choice Requires="wps">…新版画布…</mc:Choice>
       *   <mc:Fallback>…旧版降级画布…</mc:Fallback>
       * **两份内容是一样的**，只是给不同版本的 Word 用。渲染器只取 Choice，
       * 所以这里也必须只走 Choice —— 否则同一段图内文字会被拼进段落文本**两遍**。
       * 实测：`02-吴子枫` 的图标签在段落文本里正好重复两次，就是这个原因。
       */
      if (c.name === 'mc:Fallback') continue;
      /**
       * 图/文本框/嵌入对象：**不进入段落正文**。
       *
       * 这三类内部都可能有 `w:p` / `w:t`（尤其是 `w:drawing` 里的
       * `w:txbxContent`），而 walk 原本会一路递归进去，把**图里的标签**
       * 拼进宿主段落的文本。后果不是"多了一点字"，是段落文本被彻底污染：
       *   实测 `02-吴子枫` 段43 的 text 长度 146，内容**全部**是图标签拼接
       *   ——「资本主义从资本主义向共产主义的过渡（=社会主义或无产阶级专政）
       *   共产主义-------------阶级斗争---------------------…」
       * 于是语言规则在这段垃圾文本上命中、字数统计失真、
       * 与 DOM 的对齐也错位（DOM 渲染的是图，没有这些字）。
       *
       * 图内文字**不是丢掉**，而是收进独立结构（见 `collect.textboxes`）——
       * 需求原话就是「不要当成普通文字」。
       *
       * ⚠️ 必须同时判断 `skipping` 与域隐藏区间。
       * 漏了这两个判断会把**已删除修订里**的图也算进来 ——
       * 实测 `w:drawing` 478 个里有 139 个落在 `w:del` / `w:moveFrom` 内，
       * 那些图在当前文档里不存在，算进来就是虚高。
       */
      if (c.name === 'w:drawing' || c.name === 'w:pict' || c.name === 'w:object') {
        if (collect && !skipping && !(fieldDepth > 0 && !pastSeparate)) collectFigures(c, collect);
        continue;
      }
      if (c.name === 'w:fldChar') {
        const type = c.attr ? (c.attr('w:fldCharType') || '') : '';
        if (type === 'begin') {
          fieldDepth += 1; pastSeparate = false;
          fieldStack.push({ instr: '', offset: out.length, recorded: false });
        } else if (type === 'separate') {
          pastSeparate = true;
          // 指令到此结束，此刻才知道域的真实类型
          const cur = fieldStack[fieldStack.length - 1];
          if (cur && collect && !cur.recorded) {
            const instr = cur.instr.replace(/\s+/g, ' ').trim();
            if (instr) { collect.fields.push({ type: fieldTypeOf(instr), instr, offset: cur.offset }); cur.recorded = true; }
          }
        } else if (type === 'end') {
          fieldDepth = Math.max(0, fieldDepth - 1); pastSeparate = false;
          const cur = fieldStack.pop();
          /**
           * 有的域**没有 `separate`**（`begin` 直接到 `end`，即"无结果的域"）。
           * 只在 `separate` 时记录会漏掉它们 —— 实测 7 篇 / 12 个域
           * （`03-政治-冯准-中国反贫困模式…` 2 个、`07-邹冠男-世界领导力…` 1 个等）。
           * 所以在 `end` 时补记一次。判据是 `fldChar begin` 数，见
           * `tools/verify-fields.mjs` 的逐篇相等性检查。
           */
          if (cur && collect && !cur.recorded) {
            const instr = cur.instr.replace(/\s+/g, ' ').trim();
            if (instr) collect.fields.push({ type: fieldTypeOf(instr), instr, offset: cur.offset });
          }
        }
        continue;
      }
      /**
       * 域指令（隐藏）：**不进入文本**，但要**收进结构化字段**。
       *
       * 两种域有真实编辑价值，不能一律丢掉：
       *   · `HYPERLINK`（91 篇 / 341 条）—— 链接目标，可检查链接是否失效
       *   · `ADDIN EN.CITE`（22 篇 / 140 条）—— **EndNote 引文域**，
       *     指令里带完整文献元数据（作者、年份、标题）
       * 而 `PAGE` / `NUMPAGES` 之类属于版式，记录类型即可。
       */
      if (c.name === 'w:instrText') {
        const cur = fieldStack[fieldStack.length - 1];
        if (cur) cur.instr += c.allText();
        continue;
      }
      if (c.name === 'w:t' || c.name === 'w:delText') {
        // 域内、且还没到 separate 的文本同样是隐藏指令的一部分
        if (!skipping && !(fieldDepth > 0 && !pastSeparate)) {
          const s = c.allText();
          /**
           * 上标/下标区间。`out.length` 就是该 run 文本在段落文本里的起点 ——
           * 用 UTF-16 长度计，与 `text` 的索引口径一致（中文在 BMP 内，
           * 一个字算 1；星号补充平面字符算 2，但 `text` 的索引也是同样算法，
           * 所以两边始终对齐）。
           */
          if (collect && s) {
            const va = vertAlignOf(c);
            if (va) collect.marks.push({ kind: va, text: s, offset: out.length });
            /**
             * 高亮：**单独一个数组**，不混进 `marks`。
             * `marks` 的语义是「上标/下标」（渲染形态），高亮的语义是
             * 「责编标了这一处」（编辑意图）—— 混在一起会让
             * 渲染断言（vertical-align）把高亮也算进去。
             */
            const hl = highlightOf(c);
            if (hl) collect.highlights.push({ color: hl, text: s, offset: out.length });
          }
          out += s;
        }
        continue;
      }
      /**
       * 脚注/尾注**引用标记**。
       *
       * ⚠️ 这里此前是**直接漏掉**的：`w:footnoteReference` 没有 `w:t`
       * （编号由 Word 渲染时自动生成），所以 `paragraphText` 对它一无所知，
       * 正文文本里就不存在这个标记 —— 于是「脚注挂在哪个字后面」这个信息
       * 在整个系统里是缺失的。实测语料里这样的标记有 **26023 个、覆盖 576 篇
       * （91.1%）**，是出现最广的特殊格式之一。
       *
       * 这里**只记录位置，不往 `text` 里塞占位符**：`text` 是所有规则、
       * 锚点、DOM 对齐的共同基准，往里加字符会同时移动全项目的偏移量。
       * 位置信息放在 `noteRefs` 里，需要它的地方单独取。
       */
      if (c.name === 'w:footnoteReference' || c.name === 'w:endnoteReference') {
        if (collect && !skipping) {
          collect.noteRefs.push({
            kind: c.name === 'w:footnoteReference' ? 'footnote' : 'endnote',
            id: c.attr ? (c.attr('w:id') || '') : '',
            offset: out.length,
          });
        }
        continue;
      }
      if (c.name === 'w:annotationRef') continue;
      if (c.name === 'w:tab' || c.name === 'w:noBreakHyphen') {
        if (!skipping && !(fieldDepth > 0 && !pastSeparate)) {
          const kind = c.name.slice(2), rawText = kind === 'tab' ? '\t' : '-';
          collect?.characters?.push({ node: c, kind, rawStart: out.length, rawEnd: out.length + 1,
            rawText, displayText: kind === 'tab' ? '\u2003' : '\u2011' });
          out += rawText;
        }
        continue;
      }
      if (c.name === 'w:br' || c.name === 'w:cr') { if (!skipping) out += '\n'; continue; }
      if (c.name === 'w:sym') { if (!skipping) out += '□'; continue; }
      walk(c, skipping);
    }
  };
  walk(p, false);
  return out;
}

/** 取段落属性 */
function paragraphProps(p) {
  const pPr = p.el('w:pPr');
  const style = pPr?.el('w:pStyle')?.val || '';
  const jc = pPr?.el('w:jc')?.val || '';
  const outline = pPr?.el('w:outlineLvl')?.val ?? '';
  const numPr = pPr?.el('w:numPr');
  const numId = numPr?.el('w:numId')?.val || '';
  const ilvl = numPr?.el('w:ilvl')?.val || '';
  /**
   * ⚠️ 第 30 轮修：`w:firstLineChars` 与 `w:firstLine` **是两个不同单位**，
   * 原实现用 `||` 把它们混成一个值，导致判据比较的是不同量纲。
   *
   *   · `w:firstLineChars="200"` —— 单位是**百分之一字符**，200 = 2 字符
   *   · `w:firstLine="480"`      —— 单位是 **twip**（1/20 磅），12pt 正文下 480 = 2 字符
   *
   * Word 常见写法是两者同时出现且互相等价：
   *   `<w:ind w:firstLineChars="200" w:firstLine="480"/>`
   * 但**只写 twips 一种**同样完全合规（实测已刊发定稿里
   * `<w:ind w:firstLine="510"/>`、`480`、`420` 都出现）。原实现因为
   * `firstLineChars` 缺失就回退取 `firstLine`，于是把 510 当成「5.1 字符」，
   * 与 `OK_CHARS = {200,201,240}` 比较必然不等 → 判为「非两字符」误报。
   *
   * 现在两个值**分开保留**，并把单位也带出来，由判据各自按自己的量纲判断。
   */
  const indEl = pPr?.el('w:ind');
  const firstLineChars = indEl?.attr('w:firstLineChars') || '';
  const firstLineTwips = indEl?.attr('w:firstLine') || '';
  const indFirstLine = firstLineChars || firstLineTwips || '';
  const indUnit = firstLineChars ? 'chars' : (firstLineTwips ? 'twips' : '');
  /**
   * 段落间距 / 行距（`w:spacing`）。
   *
   * 此前完全没抽，于是「段间距没规范」「行距不一致」这类问题**既测不出也改不了**。
   * 取值口径：
   *   · `w:line` + `w:lineRule`：行距。`lineRule=auto` 时 `line` 是 1/240 行
   *     （`240`=单倍、`360`=1.5 倍、`480`=双倍）；`lineRule=exact/atLeast` 时
   *     是 twip 的绝对行高。
   *   · `w:before` / `w:after`：段前/段后间距（twip）；也接受 `beforeLines/afterLines`
   *     （单位 1/100 行）。
   * 保留原始字符串，由使用方各自按 `lineRule` 解释量纲。
   */
  const spEl = pPr?.el('w:spacing');
  const lineRaw = spEl?.attr('w:line') ?? '';
  const lineRule = spEl?.attr('w:lineRule') ?? '';
  const beforeRaw = spEl?.attr('w:before') ?? spEl?.attr('w:beforeLines') ?? '';
  const afterRaw = spEl?.attr('w:after') ?? spEl?.attr('w:afterLines') ?? '';
  const snapToGrid = pPr?.el('w:snapToGrid');
  const textAlignLast = pPr?.el('w:textAlignment');
  /**
   * 段落级大纲级别的**数值**形式。
   *
   * `w:outlineLvl/@w:val` 是 0 基（`0` = 一级标题，`8` = 正文级），
   * 而本项目的 `level1`…`level5` 是 1 基。这里直接给出 1 基的 `outlineLevel`，
   * 并**区分「未设置」与「设为正文级」**：`outline` 用 `?? ''` 时两者都得到 `''`，
   * 无法分辨，而 `outlineLevel` 对未设置返回 `null`、对 `w:val="9"`/`"8"` 返回 `null`
   * （Word 用 9 表示正文级）。
   */
  const outlineLevel = (() => {
    if (outline === '' || outline === null || outline === undefined) return null;
    const n = Number(outline);
    if (!Number.isFinite(n)) return null;
    return n >= 0 && n <= 8 ? n + 1 : null;
  })();
  return {
    style, jc, outline, outlineLevel, numId, ilvl,
    numIdNum: numId === '' ? null : Number(numId),
    ilvlNum: ilvl === '' ? null : Number(ilvl),
    indFirstLine, indUnit, firstLineChars, firstLineTwips,
    lineRaw, lineRule, beforeRaw, afterRaw,
    snapToGrid: !!snapToGrid, textAlignLast: !!textAlignLast,
    xml: pPr ? serialize(pPr) : '',
  };
}

/**
 * 取段落中首个有内容的 run 的字体信息。
 *
 * ⚠️ 第 31 轮修：原实现在遇到「有文本但没有 `w:rPr`」的 run 时直接
 * `seen = true; break;`（旧第 134 行），于是**整个段落级 `w:pPr/w:rPr` 回退分支
 * 永远不会执行**（`seen` 已被置真）。后果是：Word 里把字号/加粗写在
 * **段落级 rPr** 的标题（本刊稿件里很常见）在 `format` 上表现为
 * `sizeHalfPt = null`、`bold = false`，与正文段完全无法区分 —— 标题识别
 * 因此失去了最重要的格式信号。
 *
 * 现在改为：
 *   1. 先找**第一个带 `w:rPr` 的有文本 run** 作为主来源；
 *   2. 主来源缺失的字段，用**段落级 `w:pPr/w:rPr`** 补齐；
 *   3. 再缺失的，用后续任一有文本 run 的值补齐。
 * 不再因为某个 run 没有 `w:rPr` 就放弃整段。
 */
function readRPr(rPr, info) {
  if (!rPr) return;
  const fonts = rPr.el('w:rFonts');
  if (fonts) {
    if (!info.ascii) info.ascii = fonts.attr('w:ascii') || fonts.attr('w:hAnsi') || '';
    if (!info.eastAsia) info.eastAsia = fonts.attr('w:eastAsia') || '';
  }
  const sz = rPr.el('w:sz')?.val;
  if (sz && info.sizeHalfPt === null) info.sizeHalfPt = Number(sz);
  const b = rPr.el('w:b');
  if (b && !info.bold) info.bold = b.val !== '0';
  const i = rPr.el('w:i');
  if (i && !info.italic) info.italic = i.val !== '0';
  const va = rPr.el('w:vertAlign')?.val;
  if (va) {
    if (va === 'superscript') info.superscript = true;
    if (va === 'subscript') info.subscript = true;
  }
  if (!info.color) info.color = rPr.el('w:color')?.val || '';
}

function runFormat(p) {
  const runs = p.descendants('w:r');
  const info = { ascii: '', eastAsia: '', sizeHalfPt: null, bold: false, italic: false, superscript: false, subscript: false, color: '' };
  const textRuns = [];
  for (const r of runs) {
    if (hasAncestor(r, RUN_SKIP_AFTER)) continue;
    const t = r.descendants('w:t').map((n) => n.allText()).join('');
    if (!t.trim()) continue;
    textRuns.push(r);
  }
  // 1) 第一个带 rPr 的有文本 run 作主来源
  const primary = textRuns.find((r) => r.el('w:rPr'));
  if (primary) readRPr(primary.el('w:rPr'), info);
  // 2) 段落级 rPr 补齐（不再被 break 跳过）
  readRPr(p.el('w:pPr')?.el('w:rPr'), info);
  // 3) 仍缺失则用后续 run 补齐
  for (const r of textRuns) {
    if (r === primary) continue;
    readRPr(r.el('w:rPr'), info);
    if (info.sizeHalfPt !== null && info.eastAsia && info.bold) break;
  }
  return info;
}

function serialize(node) {
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
  const inner = node.children.map(serialize).join('') + node.text;
  return `<${node.name}${attrs}>${inner}</${node.name}>`;
}

/** 段落是否含有批注锚点 */
function commentAnchors(p) {
  const ids = new Set();
  for (const c of p.descendants('w:commentRangeStart')) if (c.attr('w:id')) ids.add(c.attr('w:id'));
  for (const c of p.descendants('w:commentReference')) if (c.attr('w:id')) ids.add(c.attr('w:id'));
  return [...ids];
}

/** 提取段内修订痕迹 */
function revisionsOf(p, partName, pIndex) {
  const out = [];
  const collect = (node, kind) => {
    const items = p.descendants(node);
    for (const it of items) {
      const texts = [];
      for (const t of it.descendants()) {
        if (t.name === 'w:t' || t.name === 'w:delText') texts.push(t.allText());
      }
      out.push({
        part: partName,
        paragraphIndex: pIndex,
        kind,
        author: it.attr('w:author') || '',
        date: it.attr('w:date') || '',
        text: texts.join(''),
      });
    }
  };
  collect('w:ins', 'insert');
  collect('w:del', 'delete');
  collect('w:moveFrom', 'moveFrom');
  collect('w:moveTo', 'moveTo');
  return out;
}

function parsePart(xmlText, partName, rels = null) {
  const root = parseXml(xmlText);
  // Application paragraph indexes omit figure text and are not XML ordinals.
  // Preserve both identities so writers and the reader can prove the same node.
  const physicalParagraphs = root.descendants('w:p');
  const physicalOrdinals = new Map(physicalParagraphs.map((node, ordinal) => [node, ordinal]));
  const physicalTableOrdinals = new Map(root.descendants('w:tbl').map((node, ordinal) => [node, ordinal]));
  const physicalCharacterOrdinals = Object.fromEntries(['tab', 'noBreakHyphen'].map(kind =>
    [kind, new Map(root.descendants('w:' + kind).map((node, ordinal) => [node, ordinal]))]));
  const tableIdentity = node => ({ part: partName, sourceXmlTableOrdinal: physicalTableOrdinals.get(node),
    sourceXmlNodeId: `${partName}:xml-tbl:${physicalTableOrdinals.get(node)}` });
  const body = root.descendants('w:body')[0] || root;
  const paragraphs = [];
  const revisions = [];
  const blocks = []; // 文档顺序的块列表：{ type: 'para'|'table', data }
  let pIndex = 0;

  /**
   * 把一段 w:p 收集成段落对象。
   * noteMeta 用于脚注/尾注：{ id, type }，同时给出 isNoteSeparator，
   * 这样上层不必再去猜 paragraph.id 与 OOXML w:id 的对应关系。
   */
  const pushPara = (node, { inTable = false, tableIdx = null, noteMeta = null } = {}) => {
    /**
     * 同一遍遍历同时拿到文本与特殊格式位置（见 `paragraphText` 的说明）。
     * `before` 不收集 —— 修订前文本只用于差异比对，不需要格式位置。
     */
    const collect = { marks: [], noteRefs: [], highlights: [], fields: [], textboxes: [], figures: [], characters: [] };
    const text = paragraphText(node, 'after', collect);
    const before = paragraphText(node, 'before');
    const pObj = {
      id: `${partName}:${pIndex}`,
      part: partName,
      index: pIndex,
      sourceXmlParagraphOrdinal: physicalOrdinals.get(node),
      sourceXmlNodeId: `${partName}:xml-p:${physicalOrdinals.get(node)}`,
      paragraphIndexOwner: 'application-paragraph-index',
      textView: 'after',
      offsetUnit: 'utf16',
      sourceCharacters: collect.characters.map(({ node: character, ...range }) => ({
        schemaVersion: 1, ...range, part: partName,
        paragraphNodeId: `${partName}:xml-p:${physicalOrdinals.get(node)}`,
        sourceXmlParagraphOrdinal: physicalOrdinals.get(node),
        characterNodeId: `${partName}:xml-${range.kind}:${physicalCharacterOrdinals[range.kind].get(character)}`,
        sourceXmlCharacterOrdinal: physicalCharacterOrdinals[range.kind].get(character),
        textView: 'after', offsetUnit: 'utf16',
      })),
      text, before, changed: before !== text,
      properties: paragraphProps(node),
      format: runFormat(node),
      commentIds: commentAnchors(node),
      /**
       * 上标/下标区间（逐 run，带段内偏移）。
       * `format.superscript` 是**段落级**摘要，正文段落里夹一个上标时它是 false，
       * 所以判「哪个字是上标」必须用这个逐 run 的列表。
       */
      marks: collect.marks,
      /**
       * 脚注/尾注**引用标记**（带段内偏移）。
       * 实测 26023 个、覆盖 576 篇（91.1%）。此前完全没被抽取。
       */
      noteRefs: collect.noteRefs,
      /**
       * 责编高亮标记：`{ color, text, offset }`。
       * 覆盖面 541 篇（85.6%），是**编辑已标出的问题位置**。
       * 与 `marks` 分开，因为语义不同（编辑意图 vs 渲染形态）。见 `highlightOf`。
       */
      highlights: collect.highlights,
      /**
       * 域代码：`{ type, instr, offset }`。
       * 有编辑价值的两类：`HYPERLINK`（91 篇 / 341 条，可查链接失效）、
       * `ADDIN EN.CITE`（22 篇 / 140 条，**EndNote 引文域**，含文献元数据）。
       * 指令本身**不进入 `text`**（读者看不到），只在这里留结构化记录。
       */
      fields: collect.fields,
      /**
       * 图内文字（文本框里的文字）。**不进 `text`**，理由见 `collectFigures`。
       * 实测 14 篇正文含文本框、238 个框、3668 字。
       */
      textboxes: collect.textboxes,
      /**
       * 本段所含的图/文本框/嵌入对象：
       * `{ kind, images, equations, textboxes, rIds, extents, media }`。
       * 图片与公式此前完全没解析（实测图片 147 篇 / 23.3%、公式 4 篇）。
       * `media` 由 `resolveFigureMedia` 依据 `rels` 解析出 ZIP 内条目名，
       * 供阅读器真正把图片渲染出来（docx-preview 不渲染 drawing）。
       */
      figures: resolveFigureMedia(collect.figures, rels),
      inTable,
      charCount: [...text].length,
    };
    if (inTable) {
      pObj.tableIdx = tableIdx;
      for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) if (ancestor.name === 'w:tbl') {
        pObj.sourceXmlTableNodeId = tableIdentity(ancestor).sourceXmlNodeId; break;
      }
    }
    if (noteMeta) {
      pObj.noteId = noteMeta.id ?? null;
      pObj.noteType = noteMeta.type ?? '';
      // 分隔符注释（separator / continuationSeparator）不是真正的注释
      pObj.isNoteSeparator = /separator/i.test(noteMeta.type || '');
    }
    paragraphs.push(pObj);
    revisions.push(...revisionsOf(node, partName, pIndex).map((revision) => ({ ...revision,
      sourceXmlParagraphOrdinal: pObj.sourceXmlParagraphOrdinal, sourceXmlNodeId: pObj.sourceXmlNodeId })));
    pIndex += 1;
    return pObj;
  };

  const tableParagraphs = (table) => table.descendants('w:p').filter((node) => {
    for (let ancestor = node.parent; ancestor && ancestor !== table; ancestor = ancestor.parent) {
      if (['w:txbxContent', 'w:pict', 'w:drawing', 'w:object', 'mc:Fallback'].includes(ancestor.name)) return false;
    }
    return true;
  });

  // 脚注/尾注文件的结构是 <w:footnotes><w:footnote>…<w:p>…</w:footnote></w:footnotes>，
  // 段落被包在 note 容器里，不是 body 的直接子节点。
  // 旧实现只遍历 body.children，导致 doc.footnotes / doc.endnotes 永远为空
  // （尾注稿件因此完全扫不出问题）。这里先处理 note 容器。
  const noteTag = partName === 'endnotes.xml' ? 'w:endnote' : partName === 'footnotes.xml' ? 'w:footnote' : null;
  if (noteTag) {
    for (const container of root.descendants(noteTag)) {
      const noteMeta = { id: container.attr('w:id'), type: container.attr('w:type') || '' };
      for (const child of container.children) {
        if (child.name === 'w:p') {
          pushPara(child, { noteMeta });
          blocks.push({ type: 'para', idx: pIndex - 1 });
        } else if (child.name === 'w:tbl') {
          const tableIdx = paragraphs.length;
          for (const tp of tableParagraphs(child)) pushPara(tp, { inTable: true, tableIdx, noteMeta });
          blocks.push({ type: 'table', idx: tableIdx, rows: [], ...tableIdentity(child) });
        }
      }
    }
    return { paragraphs, revisions, blocks };
  }

  // 按文档顺序遍历 body 子节点
  for (const child of body.children) {
    if (child.name === 'w:p') {
      pushPara(child);
      blocks.push({ type: 'para', idx: pIndex - 1 });
    } else if (child.name === 'w:tbl') {
      const tableIdx = paragraphs.length; // 记录表格后第一个段落的位置
      // 先收集表内段落（保持 pIndex 连续）
      for (const tp of tableParagraphs(child)) pushPara(tp, { inTable: true, tableIdx });
      // 提取表格结构
      const tableRows = child.els('w:tr').map((tr) =>
        tr.els('w:tc').map((tc) => ({
          text: paragraphText(tc, 'after'),
          colspan: Number(tc.el('w:tcPr')?.el('w:gridSpan')?.val || 1),
          rowspan: Number(tc.el('w:tcPr')?.el('w:vMerge')?.val === 'restart' ? 2 : (tc.el('w:tcPr')?.el('w:vMerge') ? 1 : 1)),
          width: tc.el('w:tcPr')?.el('w:tcW')?.attr('w:w') || '',
        }))
      );
      blocks.push({ type: 'table', idx: tableIdx, rows: tableRows, ...tableIdentity(child) });
    }
    // w:sectPr, w:bookmarkStart etc. 忽略
  }

  return { paragraphs, revisions, blocks };
}

function parseComments(xmlText) {
  if (!xmlText) return [];
  const root = parseXml(xmlText);
  return root.descendants('w:comment').map((c) => ({
    id: c.attr('w:id'),
    author: c.attr('w:author') || '',
    initials: c.attr('w:initials') || '',
    date: c.attr('w:date') || '',
    text: c.descendants('w:p').map((p) => paragraphText(p, 'after')).join('\n').trim(),
  }));
}

function parseStyles(xmlText) {
  if (!xmlText) return { byId: {} };
  const root = parseXml(xmlText);
  const byId = {};
  for (const s of root.descendants('w:style')) {
    const id = s.attr('w:styleId');
    if (!id) continue;
    const rPr = s.el('w:rPr');
    const pPr = s.el('w:pPr');
    const fonts = rPr?.el('w:rFonts');
    byId[id] = {
      type: s.attr('w:type') || '',
      name: s.el('w:name')?.val || '',
      /**
       * ⚠️ 第 31 轮补：`w:basedOn` 是**样式继承链**。
       *
       * 本刊稿件的标题常用自定义样式（如 `a3` / `Char` / `标题1`），
       * 这些样式自身不写 `w:outlineLvl`，而是「基于 Heading 1」——
       * 大纲级别要从父样式继承。原实现不解析 `w:basedOn`，
       * 于是这类标题的样式级大纲级别永远取不到。
       */
      basedOn: s.el('w:basedOn')?.val || '',
      ascii: fonts?.attr('w:ascii') || '',
      eastAsia: fonts?.attr('w:eastAsia') || '',
      sizeHalfPt: rPr?.el('w:sz')?.val ? Number(rPr.el('w:sz').val) : null,
      bold: !!rPr?.el('w:b') && rPr.el('w:b').val !== '0',
      jc: pPr?.el('w:jc')?.val || '',
      outline: pPr?.el('w:outlineLvl')?.val ?? '',
      /**
       * ⚠️ 第 30 轮补：样式级首行缩进**必须与段落级分开保留**，且两种单位都要取。
       *
       * 背景：段落的缩进可以**继承自段落样式**（`w:pStyle` 指向的样式在 styles.xml 里
       * 定义了 `w:ind`），此时段落自身没有 `w:ind` 属性。原实现只看段落级属性，
       * 于是把「继承样式的正常缩进」判成「未设置首行缩进」。
       *
       * 实测实例：`03-文化-秦博、刁涵-老挝路权…【0723一审done，可返回给秦老师】`
       * 的正文段用 `style="a6"`，而 `a6`（"Normal (Web)"）在 styles.xml 里写着
       * `w:firstLineChars="200"` —— 完全合规，却被报了 37 处。
       */
      indentFirstLineChars: pPr?.el('w:ind')?.attr('w:firstLineChars') || '',
      indentFirstLineTwips: pPr?.el('w:ind')?.attr('w:firstLine') || '',
    };
  }
  return { byId };
}

function parseNumbering(xmlText) {
  if (!xmlText) return { numToAbstract: {}, abstract: {} };
  const root = parseXml(xmlText);
  const numToAbstract = {};
  for (const n of root.descendants('w:num')) {
    const id = n.attr('w:numId');
    const a = n.el('w:abstractNumId')?.val;
    if (id) numToAbstract[id] = a || '';
  }
  const abstract = {};
  for (const a of root.descendants('w:abstractNum')) {
    const id = a.attr('w:abstractNumId');
    if (!id) continue;
    const levels = {};
    for (const lvl of a.els('w:lvl')) {
      const ilvl = lvl.attr('w:ilvl');
      levels[ilvl] = {
        format: lvl.el('w:numFmt')?.val || '',
        text: lvl.el('w:lvlText')?.val || '',
      };
    }
    abstract[id] = { levels };
  }
  return { numToAbstract, abstract };
}

/**
 * 解析一个 .docx 文件。
 * @param {string} filePath
 */
export function parseDocx(filePath) {
  const buf = readFileSync(filePath);
  return parseDocxBuffer(buf, filePath);
}

export function parseDocxBuffer(buf, label = '') {
  // 先按文件头识别旧版 Word（OLE2 复合文档）。
  // 必须在解析 ZIP 之前判断：这类文件内部可能偶然出现 ZIP 签名，
  // 导致先报出「缺少 word/document.xml」这种让人无从下手的错误。
  if (isOle2(buf)) {
    throw new Error('这是旧版 Word 格式（OLE2 复合文档），本系统只支持 .docx。请在 Word 中「另存为 → Word 文档（*.docx）」后重新导入。');
  }
  const zip = openZip(buf);
  if (zip.totalUncompressed > 300 * 1024 * 1024) throw new Error('文档解压后超过 300MB，拒绝处理');
  const docXml = zip.readText('word/document.xml');
  if (!docXml) {
    const looksLikeZip = buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;
    throw new Error(looksLikeZip
      ? '这个文件是 ZIP 容器，但里面没有 Word 正文（word/document.xml）。可能是 .zip 压缩包或非 Word 文档，请确认导入的是 Word 的 .docx 文件。'
      : '不是有效的 .docx：缺少 word/document.xml');
  }

  // 关系表：图片 rId → word/media/* 条目名（阅读器取图靠它，见 resolveFigureMedia）
  const relsFor = (part) => parseRels(zip.readText(`word/_rels/${part}.rels`));

  const main = parsePart(docXml, 'document.xml', relsFor('document.xml'));
  const parts = { 'document.xml': main };

  const footnotes = zip.readText('word/footnotes.xml');
  if (footnotes) parts['footnotes.xml'] = parsePart(footnotes, 'footnotes.xml', relsFor('footnotes.xml'));
  const endnotes = zip.readText('word/endnotes.xml');
  if (endnotes) parts['endnotes.xml'] = parsePart(endnotes, 'endnotes.xml', relsFor('endnotes.xml'));

  // parsePart assigns noteId/type from the owning note while collecting each
  // actual paragraph. Recounting every descendant w:p here also counts textbox
  // paragraphs excluded by that traversal and shifts later notes to wrong IDs.

  for (const name of zip.names) {
    const m = /^word\/(header|footer)\d*\.xml$/.exec(name);
    if (m) {
      const key = name.replace('word/', '');
      parts[key] = parsePart(zip.readText(name), key, relsFor(key));
    }
  }

  const comments = parseComments(zip.readText('word/comments.xml'));
  const styles = parseStyles(zip.readText('word/styles.xml'));
  const numbering = parseNumbering(zip.readText('word/numbering.xml'));

  const coreXml = zip.readText('docProps/core.xml');
  let core = {};
  if (coreXml) {
    const root = parseXml(coreXml);
    for (const tag of ['dc:title', 'dc:creator', 'cp:lastModifiedBy', 'dcterms:created', 'dcterms:modified', 'dc:subject']) {
      const n = root.descendants(tag)[0];
      if (n) core[tag] = n.allText().trim();
    }
  }

  // 正文脚注标记：正文里的 w:footnoteReference 顺序
  const footnoteRefs = [];
  {
    const root = parseXml(docXml);
    for (const r of root.descendants('w:footnoteReference')) {
      const id = r.attr('w:id');
      if (id !== undefined) footnoteRefs.push(id);
    }
  }

  const allParagraphs = Object.values(parts).flatMap((p) => p.paragraphs);
  const allRevisions = Object.values(parts).flatMap((p) => p.revisions);
  const sourcePackageSha256 = createHash('sha256').update(buf).digest('hex');
  for (const p of allParagraphs) p.sourcePackageSha256 = sourcePackageSha256;
  for (const part of Object.values(parts)) for (const block of part.blocks) {
    if (block.type === 'table') block.sourcePackageSha256 = sourcePackageSha256;
  }

  // 把每条批注挂到它锚定的段落上，便于「批注—段落」对照与验收统计
  {
    const byId = new Map();
    for (const p of allParagraphs) {
      for (const cid of p.commentIds || []) {
        if (!byId.has(cid)) byId.set(cid, p);
      }
    }
    for (const c of comments) {
      const anchor = byId.get(c.id);
      if (anchor) {
        c.paragraphIndex = anchor.index;
        c.part = anchor.part;
        c.anchorText = anchor.text;
      } else {
        c.paragraphIndex = null;
        c.anchorText = '';
      }
    }
  }

  const realNote = (p) => p.text.trim() && !p.isNoteSeparator;
  return {
    label,
    sourcePackageSha256,
    core,
    parts,
    paragraphs: main.paragraphs,
    footnotes: parts['footnotes.xml']?.paragraphs || [],
    endnotes: parts['endnotes.xml']?.paragraphs || [],
    comments,
    styles,
    numbering,
    tables: (main.blocks || []).filter((b) => b.type === 'table').map((b) => ({
      part: b.part, sourceXmlTableOrdinal: b.sourceXmlTableOrdinal, sourceXmlNodeId: b.sourceXmlNodeId,
      sourcePackageSha256, rows: b.rows.map((r) => r.map((c) => c.text)) })),
    blocks: main.blocks,
    revisions: allRevisions,
    footnoteRefs,
    stats: {
      paragraphs: allParagraphs.length,
      chars: allParagraphs.reduce((s, p) => s + p.charCount, 0),
      comments: comments.length,
      insertions: allRevisions.filter((r) => r.kind === 'insert').length,
      deletions: allRevisions.filter((r) => r.kind === 'delete').length,
      tables: (main.blocks || []).filter((b) => b.type === 'table').length,
      // 图（含文本框 / 嵌入对象）计数：供「格式识别」面板一眼核对识别结果
      figures: allParagraphs.reduce((s, p) => s + ((p.figures && p.figures.length) || 0), 0),
      /**
       * 真正解析出条目名的**内嵌图片**数（`figures[].media`）。
       * 与 `figures`（图/文本框对象数）不同：一个 drawing 可能含多张图，
       * 也可能只有公式/图表（无位图）。阅读器渲染图片靠这个数。
       */
      images: allParagraphs.reduce((s, p) => s + (p.figures || []).reduce((a, f) => a + ((f.media && f.media.length) || 0), 0), 0),
      // 只数真正的脚注/尾注，排除 separator / continuationSeparator 与空条目
      footnotes: (parts['footnotes.xml']?.paragraphs || []).filter(realNote).length,
      endnotes: (parts['endnotes.xml']?.paragraphs || []).filter(realNote).length,
    },
  };
}

export { paragraphText, hasAncestor, serialize };
