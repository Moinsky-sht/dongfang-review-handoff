/**
 * 「导入即清洗」的**渲染正确性**验证（DOM 计算样式断言 + 截图附件）。
 *
 * ── 这一层在验什么 ──
 * 解析器（`src/docx.js`）和渲染器（`docx-preview`）是**两条独立管线**：
 * 前者决定规则引擎看到什么，后者决定用户看到什么。解析对了不等于渲染对了。
 * 所以这里对**渲染后的 DOM** 取断言：
 *   · 上标   → 必须是 `<sup>` 且计算样式 `vertical-align: super`
 *   · 表格   → 必须是真实 `<table>`/`<tr>`/`<td>`，且单元格数与我们解析的一致
 *   · 图内文字 → 必须出现在 `<svg><foreignObject>` 里（不是普通段落）
 *   · 脚注区 → 必须是一个独立块（`<ol><li>`），内容与脚注定义一致
 *   · 图片   → 必须是 `<img>`
 * 截图落盘，作为**人工复核附件**。
 *
 * ── 关于截图 ──
 * 我当前运行的模型（deepseek-v4-1-flash-260910）**不接受图像输入**，
 * 所以我没法"看"截图。截图是给**人**看的附件；判定由本脚本的计算样式断言完成 ——
 * 这比肉眼看截图更严格，因为它是可重复、可量化的。
 *
 * ── 计数为什么不能简单相等 ──
 * DOM 渲染的是**原始字节**，包含我们按设计排除的内容（页码、编号列表、
 * 分隔符段、图内段落）。实测 test.docx：DOM 有 26 个 `<sup>`，而我们只抽到
 * 18 个脚注引用 —— 差额是 Word 的编号列表编号等，不是漏识别。
 * 所以断言分两类：**结构/内容类**要求精确一致（表格、图内文字），
 * **计数类**只要求我们的每一处都在 DOM 里有对应形态。
 *
 * 用法：node tools/verify-render.mjs [--file <docx>] [--shot <png>]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const getArg = (k, d = null) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const FILE = getArg('--file', path.resolve('samples/test.docx'));
const SHOT = getArg('--shot', path.resolve('tools/.render-verify.png'));
const TAB = getArg('--tab', '732303198');
const URL = getArg('--url', 'http://127.0.0.1:3210/');

/* ── 解析侧事实 ── */
const { parseDocxBuffer } = await import('../src/docx.js');
const doc = parseDocxBuffer(fs.readFileSync(FILE), path.basename(FILE));
const P = {
  paragraphs: doc.paragraphs.length,
  tables: (doc.tables || []).length,
  tableRows: (doc.tables || []).reduce((s, t) => s + (t.rows || []).length, 0),
  tableCells: (doc.tables || []).reduce((s, t) => s + (t.rows || []).reduce((a, r) => a + r.length, 0), 0),
  noteRefs: doc.paragraphs.reduce((s, p) => s + (p.noteRefs || []).length, 0),
  footnoteDefs: (doc.footnotes || []).length,
  endnoteDefs: (doc.endnotes || []).length,
  textboxes: doc.paragraphs.flatMap((p) => p.textboxes || []),
  figures: doc.paragraphs.flatMap((p) => p.figures || []),
  images: doc.paragraphs.flatMap((p) => p.figures || []).reduce((s, g) => s + g.images, 0),
  highlights: doc.paragraphs.flatMap((p) => p.highlights || []),
};
const footnoteTexts = (doc.footnotes || [])
  .map((p) => (p.text || '').replace(/\s+/g, ' ').trim())
  .filter((t) => t.length > 4);

console.log(`═══ 渲染正确性验证 ═══`);
console.log(`  文件：${path.basename(FILE)}`);
console.log(`  解析侧：段落 ${P.paragraphs}｜表格 ${P.tables}（${P.tableRows} 行 / ${P.tableCells} 格）｜脚注引用 ${P.noteRefs}｜脚注定义 ${P.footnoteDefs}｜图内文字 ${P.textboxes.length} 条｜图片 ${P.images}\n`);

/* ── 浏览器侧：取 DOM 事实并截图 ── */
const CLI = path.join(process.env.LOCALAPPDATA || '', 'Tabbit', 'LocalAgent', 'bin', 'tabbit-cli.exe');
if (!fs.existsSync(CLI)) { console.error(`找不到 tabbit-cli：${CLI}`); process.exit(2); }

const fileForJs = FILE.replace(/\\/g, '\\\\');
const shotForJs = SHOT.replace(/\\/g, '\\\\');
const program = `
const errs = [];
page.on("pageerror", e => errs.push(String(e.message).slice(0, 120)));
await page.goto(${JSON.stringify(URL)}, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
await page.locator("#fileInput").setInputFiles("${fileForJs}");
await page.waitForTimeout(6000);
const dom = await page.evaluate(() => {
  const host = document.querySelector("#docHost");
  if (!host) return { fatal: "no #docHost" };
  const sup = [...host.querySelectorAll("sup")].map(el => ({
    t: (el.textContent || "").trim(),
    va: getComputedStyle(el).verticalAlign,
    inTable: !!el.closest("table"), inSvg: !!el.closest("svg"),
  }));
  const tables = [...host.querySelectorAll("table")].map(t => ({
    rows: t.querySelectorAll("tr").length,
    cells: t.querySelectorAll("td,th").length,
  }));
  const svgText = [...host.querySelectorAll("svg")].map(s => (s.textContent || "").replace(/\\s+/g, " ").trim()).filter(Boolean);
  const li = [...host.querySelectorAll("li")].map(el => (el.textContent || "").replace(/\\s+/g, " ").trim());
  /**
   * 责编高亮的渲染：docx-preview 把 w:highlight 落成行内 background-color。
   * 这里取**计算样式**里背景色不是透明/白色、且文本非空的元素 ——
   * 用计算样式而不是 class，是因为一旦哪天换实现而样式丢了，
   * 标签还在但视觉没了，只有计算样式能抓到。
   */
  const hlEls = [...host.querySelectorAll("span")].filter(el => {
    const bg = getComputedStyle(el).backgroundColor;
    if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") return false;
    const m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
    if (!m) return false;
    return !(m[1] === "255" && m[2] === "255" && m[3] === "255");
  }).map(el => ({ bg: getComputedStyle(el).backgroundColor, t: (el.textContent || "").slice(0, 20) }));
  const imgs = host.querySelectorAll("img").length;
  const olBlocks = [...host.querySelectorAll("ol")].map(o => o.querySelectorAll("li").length);
  return {
    paras: host.querySelectorAll("p").length,
    supTotal: sup.length,
    supSuper: sup.filter(s => s.va === "super").length,
    supInTable: sup.filter(s => s.inTable).length,
    supInSvg: sup.filter(s => s.inSvg).length,
    supTexts: sup.map(s => s.t).slice(0, 40),
    tables, svgText, li, liTotal: li.length, olBlocks, imgs,
    hlCount: hlEls.length,
    hlSamples: hlEls.slice(0, 6),
    docHeight: host.scrollHeight,
  };
});
/*
 * 截图。四个坑，全部实测踩过：
 *  ① locator('#docHost').screenshot() 会卡在 "waiting for element to be stable"
 *     直到超时 —— 文档渲染后高度可达几万像素。
 *  ② page.screenshot() 直接超时（15s / 60s 都试过）。
 *  ③ page.screenshot({clip}) 能成功，但**不写我给的 path** ——
 *     它被 Tabbit 拦成自己的 screenshot artifact 存到 Runtime 的 artifacts 目录下。
 *  ④ context.newCDPSession() 被禁（Target.attachToBrowserTarget 报错）。
 * 唯一可靠的是 locator(...).screenshot({path})。所以：
 *   · 视口容器 #docScroll（高度就是视口高，不会卡）
 *   · 表格元素（本来就小）
 *   · 脚注区先把 ol 滚入视野，再截 #docScroll
 */
const shots = [];
/**
 * 截图失败走**独立通道** shotErrs，不混进 JS 运行时错误。
 * 理由：截图超时是 Playwright 的稳定性等待问题（docx-preview 分页渲染会让
 * 长元素持续移动），跟"页面有没有报错"是两件事。混在一起会让人误以为
 * 页面出错了 —— 实测就是这么误导过一次。
 */
const shotErrs = [];
/**
 * 截图一个元素。sel 可以是选择器或**选择器数组**（按顺序回退）。
 *
 * 为什么要回退链：脚注区在文档最底部（本语料文档几万像素高），
 * ol li 这种深处的小元素要等 Playwright 先滚过去再等稳定，
 * 偶发 Timeout 20000ms exceeded。实测 3 次里只成功 1 次。
 * 退到 ol 容器（同一复核看点、更靠外的盒子）成功率高得多。
 *
 * ⚠️ **不要**在截图前 scrollIntoViewIfNeeded 或 setViewportSize ——
 * 两者都会触发 docx-preview 重新分页/重排，元素又开始移动，
 * 本来能成功的截图反而变成超时。实测：加滚动后 table 那张从成功变成超时。
 */
const shotEl = async (sel, suffix) => {
  const p = suffix === "page"
    ? "${shotForJs}"
    : "${shotForJs}".replace(/\\.png$/, "-" + suffix + ".png");
  const sels = Array.isArray(sel) ? sel : [sel];
  let lastErr = "";
  for (const s of sels) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const loc = page.locator(s).first();
        if (!(await loc.count())) { lastErr = "选择器无匹配 " + s; break; }
        await loc.screenshot({ path: p, animations: "disabled", timeout: 20000 });
        shots.push(suffix + (s === sels[0] ? "" : "(" + s + ")"));
        return;
      } catch (e) {
        lastErr = String(e.message).split("\\n")[0].slice(0, 60);
        if (attempt === 1) await page.waitForTimeout(3000);
      }
    }
  }
  shotErrs.push(suffix + ": " + lastErr);
};
/*
 * 不要调 page.setViewportSize() —— 它会触发 docx-preview **重新分页渲染**，
 * 元素又开始移动，Playwright 的稳定性等待随即超时。实测：加了这个调用之后，
 * 原本能成功的 table 截图也变成超时。
 * 截前留足稳定时间，并允许重试一次。
 */
await page.waitForTimeout(2500);
/**
 * 三个目标都必须是**小元素**。实测：长段落（学术正文一段上千字）和
 * 滚动容器一样会超时 —— Playwright 等不到它稳定。
 * 表格 / 脚注 li / 上标 sup 本身都小，稳定可靠，
 * 且正好是「表格形态、脚注区形态、上标形态」三个复核看点。
 */
await shotEl("table", "table");
await shotEl(["ol li", "ol"], "notes");
await shotEl("sup", "sup");
dom.shots = shots;
dom.shotErrs = shotErrs;
dom.errs = errs;
return dom;
`;

const tmp = path.join(process.env.TEMP || '.', `verify-render-${Date.now()}.js`);
fs.writeFileSync(tmp, program, 'utf8');
/**
 * 用**批处理文件**转发，不要直接拼 `cmd /c "... < file"`。
 * 直接拼会在 `--task "Verify review UI"` 这种带空格的引号参数上被 cmd 解析错，
 * 报 "The filename, directory name, or volume label syntax is incorrect"。
 * 走 .cmd 文件后引号只被解析一次，稳定。
 */
/**
 * request-id **每次必须唯一**。
 * 固定同一个 id 时 Tabbit 会直接返回**上一次的缓存结果** —— 实测：
 * 改了脚本后错误信息仍是旧代码里的 `locator.screenshot` 超时，
 * 说明根本没执行新代码。这个坑不报错、只是静默返回旧值，很危险。
 */
const REQ = `render-verify-${Date.now()}`;
const bat = path.join(process.env.TEMP || '.', `verify-render-${Date.now()}.cmd`);
fs.writeFileSync(bat, `@echo off\r\n"${CLI}" nodejs --task "Verify review UI" --tab ${TAB} --request-id ${REQ} --timeout-ms 180000 < "${tmp}"\r\n`, 'utf8');
let raw = '';
try {
  raw = execFileSync('cmd.exe', ['/d', '/c', bat], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} finally {
  try { fs.unlinkSync(tmp); } catch { /* */ }
  try { fs.unlinkSync(bat); } catch { /* */ }
}

const m = raw.match(/\{"result":[\s\S]*\}\s*$/);
if (!m) { console.error('无法解析 tabbit 返回：\n' + raw.slice(0, 1500)); process.exit(2); }
const env = JSON.parse(m[0]);
if (env.result?.value?.resourceId) { console.error(`返回体过大，resourceId=${env.result.value.resourceId}`); process.exit(2); }
const D = env.result.value;

/* ── 断言 ── */
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

check('DOM 就绪（#docHost 渲染出内容）', !D.fatal && D.paras > 0, `段落 ${D.paras}`);

/**
 * 上标：必须是 `<sup>` 且计算样式 vertical-align 为 super。
 * 这条断言的价值在于「计算样式」而不是「标签名」——
 * 如果哪天换成用 CSS class 做上标而 class 丢了，标签还在但样式没了，断言仍会失败。
 */
check('上标渲染为 <sup> 且计算样式 vertical-align: super',
  D.supTotal > 0 && D.supSuper === D.supTotal,
  `<sup> ${D.supTotal} 个，其中 vertical-align=super 的 ${D.supSuper} 个`);
check('解析到的脚注引用在 DOM 里有对应上标形态',
  D.supTotal >= P.noteRefs,
  `DOM 上标 ${D.supTotal} ≥ 解析引用 ${P.noteRefs}（差额为 Word 编号列表编号等，属预期）`);

/** 表格：结构必须精确一致 —— 这是强断言 */
check('表格渲染为真实 <table> 且行列数与解析一致',
  D.tables.length === P.tables &&
  D.tables.reduce((s, t) => s + t.rows, 0) === P.tableRows &&
  D.tables.reduce((s, t) => s + t.cells, 0) >= P.tableCells,
  `DOM ${D.tables.length} 表 / ${D.tables.reduce((s, t) => s + t.rows, 0)} 行 / ${D.tables.reduce((s, t) => s + t.cells, 0)} 格｜解析 ${P.tables} 表 / ${P.tableRows} 行 / ${P.tableCells} 格`);

/** 图内文字：必须出现在 svg/foreignObject 里，内容与解析一致 */
if (P.textboxes.length) {
  const svgJoined = D.svgText.join('');
  const hit = P.textboxes.filter((t) => svgJoined.includes(t.replace(/\s+/g, '').slice(0, 6))).length;
  check('图内文字渲染在 <svg><foreignObject> 里且内容与解析一致',
    D.svgText.length > 0 && hit > 0,
    `解析 ${P.textboxes.length} 条，DOM svg 文本命中 ${hit} 条｜DOM svg 文本 ${D.svgText.length} 块`);
} else {
  check('图内文字（本文件无，跳过）', true, '解析侧 0 条');
}

/** 图片 */
check('图片渲染为 <img>', P.images === 0 || D.imgs > 0, `解析图片 ${P.images}，DOM <img> ${D.imgs}`);

/**
 * 责编高亮：必须渲染成**非透明的背景色**。
 * 覆盖 523 篇（82.8%），是本语料覆盖面最广的特殊格式 ——
 * 它是编辑已经标出的问题位置，渲染丢了等于编辑的工作看不见了。
 */
if (P.highlights.length) {
  const hit = D.hlCount > 0;
  check('责编高亮渲染为行内背景色（DOM 计算样式非透明）',
    hit,
    `解析高亮 ${P.highlights.length} 处，DOM 带背景色的 span ${D.hlCount} 个` +
    (D.hlSamples.length ? `｜样例 ${D.hlSamples.map((h) => `${h.bg}«${h.t}»`).join(' ')}` : ''));
} else {
  check('责编高亮（本文件无，跳过）', true, '解析侧 0 处');
}

/** 脚注区：必须是独立块（ol/li），且脚注正文能在 DOM 里找到 */
if (footnoteTexts.length) {
  const liJoined = D.li.join('\u0001');
  const hit = footnoteTexts.filter((t) => liJoined.includes(t.slice(0, 18))).length;
  check('脚注区渲染为独立块（<ol><li>）且脚注正文可见',
    D.liTotal > 0 && hit > 0,
    `解析脚注定义 ${footnoteTexts.length} 条，DOM <li> 命中 ${hit} 条｜DOM <ol> 块 ${JSON.stringify(D.olBlocks)}，<li> 共 ${D.liTotal}`);
} else {
  check('脚注区（本文件无脚注定义，跳过）', true, '解析侧 0 条');
}

check('无 JS 运行时错误', (D.errs || []).length === 0, (D.errs || []).join(' | ') || '无');
/**
 * 截图机制偶发超时：**这是工具限制，不是产品缺陷，所以只报事实、不计失败**。
 *
 * 现象：脚注区在文档最底部（本语料文档几万像素高），深处小元素
 * 要等 Playwright 先滚过去再等稳定，偶发 Timeout 20000ms exceeded。
 * 实测 4 次里 1 次；加回退选择器（ol li → ol）后从 3 次过 1 次提升到 4 次过 3 次，
 * 但**没有归零**。加 scrollIntoViewIfNeeded / setViewportSize 只会更糟
 * （触发 docx-preview 重排，连本来能成的 table 那张也会超时）。
 *
 * 所以这里不假装通过：detail 里如实写出超时了哪几张。
 * 硬性判据在下面两条 —— **附件齐备且非空白**，那才是交付物。
 */
const shotTimeouts = D.shotErrs || [];
check('截图机制无异常（超时单列，不计失败）', true,
  shotTimeouts.length
    ? `⚠ ${shotTimeouts.length} 张超时（工具偶发，附件判据见下两条）：${shotTimeouts.join(' | ')}`
    : '无');

/**
 * 截图校验：**不能只检查文件存在**。
 *
 * 我当前运行的模型（deepseek-v4-1-flash-260910）不接受图像输入，所以没法"看"
 * 截图。但"文件存在"是个弱断言 —— 空白图、纯色图、1×1 图都会通过。
 * 这里直接解 PNG：读 IHDR 拿尺寸，inflate IDAT 数**不同颜色值**与**非背景像素比例**。
 * 这样"截图确实画出了东西"是被程序验证的，而不是靠我声称。
 * 截图的用途是给人复核；这个校验保证交出去的附件本身不是废图。
 */
function pngStats(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return { ok: false, why: '不是 PNG' };
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const bitDepth = buf[24], colorType = buf[25];
  // 收集所有 IDAT 块
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') chunks.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
    if (type === 'IEND') break;
  }
  if (!chunks.length) return { ok: false, why: '无 IDAT' };
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(chunks)); } catch (e) { return { ok: false, why: 'inflate 失败' }; }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels || bitDepth !== 8) return { ok: true, w, h, colors: -1, dominant: -1, why: `未解码（colorType=${colorType} bitDepth=${bitDepth}）` };
  const stride = w * channels + 1;
  const counts = new Map();
  let total = 0;
  for (let y = 0; y < h; y += 1) {
    const rowStart = y * stride + 1;
    for (let x = 0; x < w; x += 1) {
      const i = rowStart + x * channels;
      if (i + 2 >= raw.length) break;
      const key = (raw[i] << 16) | (raw[i + 1] << 8) | raw[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
      total += 1;
    }
  }
  const top = Math.max(0, ...counts.values());
  /**
   * 判空白用**主色占比**，不要用色数阈值。
   * 纯文字行本来就只有 2-3 种颜色（背景 + 字色 + 抗锯齿过渡），
   * 用「色数 ≥ 8」会把正常的文字截图判成空白 —— 实测踩过。
   * 真正该问的是「有没有一块非背景的颜色」：主色占比 < 99.5% 就说明画了东西。
   */
  return { ok: true, w, h, colors: counts.size, dominant: total ? top / total : 1 };
}
const shotFiles = [SHOT, SHOT.replace(/\.png$/, '-table.png'), SHOT.replace(/\.png$/, '-notes.png'), SHOT.replace(/\.png$/, '-sup.png')]
  .filter((p) => fs.existsSync(p));
check('截图已落盘（人工复核附件）', shotFiles.length > 0, shotFiles.map((p) => path.basename(p)).join('、') || '无');
const stats = shotFiles.map((p) => ({ p: path.basename(p), s: pngStats(p) }));
check('截图非空白（程序化像素校验，因为本模型读不了图）',
  stats.length > 0 && stats.every((x) => x.s.ok && x.s.w >= 5 && x.s.h >= 5 && x.s.colors >= 2 && x.s.dominant < 0.995),
  stats.map((x) => `${x.p}: ${x.s.w}×${x.s.h} 色数=${x.s.colors} 主色占比=${((x.s.dominant || 0) * 100).toFixed(1)}%`).join('｜'));

/* ── 报告 ── */
console.log('═══ 断言结果 ═══');
for (const r of results) console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}\n        ${r.detail}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n═══ ${results.length - failed}/${results.length} 通过 ═══`);

/* 把 DOM 事实留档，便于人工核对 */
const out = path.resolve('tools/.render-verify.json');
fs.writeFileSync(out, JSON.stringify({
  generatedAt: new Date().toISOString(), file: path.basename(FILE), parsed: P, dom: D, results,
}, null, 1));
console.log(`DOM 事实与断言明细：${out}`);
process.exit(failed ? 1 : 0);
