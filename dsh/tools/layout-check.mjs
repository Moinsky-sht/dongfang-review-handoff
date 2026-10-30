#!/usr/bin/env node
/**
 * 左右两侧排布校验（目标点 3：左右两侧排布都更清楚、清爽）。
 *
 * 目标点 3 是个**视觉诉求**，最容易变成「我觉得清爽了」这种叙述性汇报。
 * 所以把它翻译成一组可断言的**布局不变量**，用真实浏览器量出来：
 *
 *   · 顶栏控件数不能多（主操作与设置不能混在一起）
 *   · 设置控件必须有且只有一份，且在正确的容器里（不能出现同 id 两份）
 *   · 左栏卡片高度必须贴近内容高度（不能出现几百像素的白板）
 *   · 右栏「问题清单 + 批阅详情」必须同时可见且都够高（点一条看一条）
 *   · 任何宽度下都不能出横向滚动条
 *   · 断点两侧（桌面 / 抽屉）设置控件都要可达 —— 不能出现「被藏起来又没地方找」
 *
 * 用法：
 *   node tools/layout-check.mjs            # 默认连本机 3210
 *   node tools/layout-check.mjs --port 3210
 *   node tools/layout-check.mjs --url http://127.0.0.1:3210
 *
 * 需要浏览器。本机通过 Tabbit 的 Playwright 运行时执行：
 * 本脚本自身只负责**断言与落盘**，页面驱动由 --driver 指定的
 * 脚本片段完成（见 runDriver）。没有浏览器时脚本会明确报「跳过」，
 * 而不是假装通过 —— 假通过比不通过更危险。
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CORPUS_ROOT } from './paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'verify');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = argOf('--port', '3210');
const URL_ = argOf('--url', `http://127.0.0.1:${PORT}/`);
const DOCX = argOf('--docx', join(CORPUS_ROOT, '06-2024年冬', '一审文件，带痕迹版', '现场', '陈晓航@【现场】1125作者返回.docx'));

const results = [];
const t = (name, pass, detail) => { results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) }); };

/* ---------- 一、静态断言：不依赖浏览器，直接读源码 ---------- */
/**
 * 这部分**不需要浏览器**，所以在任何环境都能跑。
 * 它守的是「结构契约」：设置控件在 HTML 里只有一份、顶栏主操作齐备。
 * 一旦有人在 HTML 里复制出第二个 #model，这里立刻红。
 */
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const countId = (id) => (html.match(new RegExp(`id="${id}"`, 'g')) || []).length;

t('静态 · #model 只有一份', countId('model') === 1, `实得 ${countId('model')} 份`);
t('静态 · #useModel 只有一份', countId('useModel') === 1, `实得 ${countId('useModel')} 份`);
t('静态 · #ruleMode 只有一份', countId('ruleMode') === 1, `实得 ${countId('ruleMode')} 份`);
t('静态 · 设置卡容器存在', /id="settingsSlot"/.test(html));
t('静态 · 设置兜底容器存在（卡片缺失时控件不回丢）', /id="settingsOrigin"/.test(html));
for (const id of ['btnImport', 'btnReview', 'btnReport']) {
  t(`静态 · 主操作 ${id} 在顶栏`, new RegExp(`id="${id}"`).test(html));
}
t('静态 · 顶栏不再直接摆 #model（应只在兜底容器内）',
  /id="settingsOrigin"[\s\S]*?id="model"[\s\S]*?<\/span>/.test(html));
t('静态 · 左栏卡片数 ≤ 4（不再堆叠多板块）',
  (html.match(/<section class="card/g) || []).length + (html.match(/<details class="card/g) || []).length <= 4,
  `实得 ${(html.match(/<section class="card/g) || []).length + (html.match(/<details class="card/g) || []).length} 块`);

const css = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');
const appjs = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
/**
 * 设置控件**不再随断点搬家**，所以 app.js 里不该再有任何断点判断。
 *
 * 这条断言是「反向」的，因为原来那条（JS 断点必须等于 CSS 断点）
 * 守的是一个**错误的**设计：按断点把控件在顶栏/设置卡之间搬来搬去。
 * 那个设计造成过两次故障，最严重的一次是手机上「模型深度审阅」开关
 * 被 CSS 藏掉、设置卡又被 JS 藏掉，**根本无法开启模型审阅**。
 * 现在控件永远住在设置卡里，断点判断本身就是 bug 的来源。
 */
t('静态 · app.js 不再按断点搬家设置控件（唯一归宿是设置卡）',
  !/matchMedia\('\(max-width: 1024px\)'\)/.test(appjs));
// 手机上绝不能把模型开关 display:none —— 那会让功能彻底消失
t('静态 · 手机断点未用 display:none 藏掉 .switch',
  !/\.topbar-actions \.switch\{display:none\}/.test(css));
t('静态 · 左栏卡片按内容高度（不再 flex:1 撑满）',
  /#leftPanel \.card\{flex:0 0 auto\}/.test(css));
t('静态 · 问题清单有最小高度（详情展开时不至于被压没）',
  /\.rp-list\{[^}]*min-height:\d+px/.test(css));

/* ---------- 二、动态断言：需要浏览器 ---------- */
/**
 * 通过 Tabbit CLI 驱动真实浏览器。
 * 找不到 CLI 或浏览器时**明确记为跳过**，不算通过。
 */
function findTabbit() {
  const p = join(process.env.LOCALAPPDATA || '', 'Tabbit', 'LocalAgent', 'bin', 'tabbit-cli.exe');
  return existsSync(p) ? p : null;
}

/** 生成浏览器内执行的驱动脚本；它只**采集**，不断言 */
function driverSource() {
  return `
const bad = [];
page.on("pageerror", e => bad.push("pageerror: " + String(e.message)));
page.on("console", m => { if (m.type() === "error") bad.push("console: " + m.text().slice(0,140)); });
page.on("response", r => { if (r.status() >= 400) bad.push("HTTP " + r.status() + " " + r.url()); });
const out = { bad: [], desktop: {}, drawer: {}, mobile: {} };
const vis = (s) => { const e = document.querySelector(s); if (!e) return 0; const r = e.getBoundingClientRect(); return r.height > 0 ? Math.round(r.height) : 0; };
/**
 * 打开左栏抽屉（并把「审阅设置」卡展开），否则在窄屏下量到的
 * 只是「浮层关着」这个正确状态，而不是「控件能不能用」。
 *
 * ⚠️ 这里**直接置状态，不模拟点击**。
 *
 * 踩过的坑：原先点 #btnLeft 再等 600ms。max-width:1024px 的抽屉是靠
 * .left-panel.open 把 left 从负值推到 0 的，而点击是走
 * setPanelCollapsed() → 读 localStorage → 切 class 的完整链路，
 * 中间还夹着 resize 事件；在 1024px 这一档实测**间歇性失效**
 * （同一份代码 900px 稳定通过、1024px 偶发量到 0 宽）。
 * 量一个「开关动画跑到一半」的中间态，得到的失败是**假失败**。
 *
 * 现在改成显式对齐到「抽屉已打开」这个终态，并**轮询确认真的可见**，
 * 把时序不确定性彻底去掉。
 */
const openLeftPanel = async () => {
  await page.evaluate(() => {
    const lp = document.querySelector("#leftPanel");
    if (lp) { lp.classList.remove("collapsed"); lp.classList.add("open"); }
    const rp = document.querySelector("#rightPanel");
    if (rp) rp.classList.remove("open");
    const layout = document.querySelector("#layout");
    if (layout) layout.classList.remove("left-collapsed");
    const card = document.querySelector("#settingsCard");
    if (card && !card.open) card.open = true;
  });
  // 等抽屉真的滑到位（宽度 > 0），最多 3 秒；不靠固定 sleep 赌时序
  for (let i = 0; i < 30; i += 1) {
    const w = await page.evaluate(() => document.querySelector("#leftPanel")?.getBoundingClientRect().width || 0);
    if (w > 0) break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(350); // 让 transition 收尾，避免量到动画中间值
};
const snap = () => page.evaluate(() => {
  const vis = (s) => { const e = document.querySelector(s); if (!e) return 0; const r = e.getBoundingClientRect(); return r.height > 0 ? Math.round(r.height) : 0; };
  const tb = document.querySelector(".topbar-actions");
  const tbv = [...tb.children].filter(e => e.getBoundingClientRect().width > 0);
  const cards = [...document.querySelectorAll("#leftPanel .card")];
  const pb = document.querySelector("#progress");
  return {
    topbarControls: tbv.length,
    topbarIds: tbv.map(e => e.id || e.tagName.toLowerCase()),
    settingsInSlot: !!document.querySelector("#settingsSlot #model"),
    settingsInTopbar: !!document.querySelector(".topbar-actions #model"),
    settingsCardHidden: document.querySelector("#settingsCard")?.classList.contains("hidden"),
    modelVisible: document.querySelector("#model").getBoundingClientRect().width > 0,
    ruleModeVisible: document.querySelector("#ruleMode").getBoundingClientRect().width > 0,
    cards: cards.map(e => ({ t: (e.querySelector("h2") || e.querySelector("summary h2"))?.textContent || "", h: Math.round(e.getBoundingClientRect().height) })),
    progressContentH: pb ? Math.max(pb.scrollHeight, ...[...pb.children].map(c => Math.round(c.getBoundingClientRect().height))) : 0,
    listH: vis("#mkIssues"),
    detailH: vis("#detail"),
    issues: document.querySelectorAll("#mkIssues .mk-issue").length,
    noHScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
  };
});
await page.setViewportSize({width:1680, height:1000});
await page.goto(${JSON.stringify(URL_)}, {waitUntil:"domcontentloaded"});
await page.waitForTimeout(2200);
// 跑一次真实审阅，让右栏有内容可量
try {
  await page.setInputFiles("#fileInput", ${JSON.stringify(DOCX)});
  await page.waitForTimeout(6500);
  await page.evaluate(() => { const c = document.querySelector("#useModel"); if (c && c.checked) c.click(); });
  await page.click("#btnReview");
  await page.waitForTimeout(6000);
  await page.evaluate(() => document.querySelector("#mkIssues .mk-issue")?.click());
  await page.waitForTimeout(700);
} catch (e) { out.reviewError = String(e.message).slice(0,160); }
out.desktop[1680] = await snap();
/**
 * 其余宽度用**只改视口、不重新导航**的方式量。
 *
 * 踩过的坑：第一版这里每次都 page.goto 带时间戳重新加载，
 * 结果重新加载后**之前点开的批阅详情没了**（detail 高度 0），
 * 于是「清单与详情同时可见」在 1100/1280/1920 三个宽度上全部假红。
 * 布局断言要量的是**同一个交互现场**在不同宽度下的表现，
 * 不能每次把现场清掉再量。
 *
 * 而抽屉态（≤1024px）左右栏本来就是收起的浮层，清单与详情高度为 0
 * 是**正确行为**，所以那两个断言只对桌面宽度生效（见下面的断言分支）。
 */
for (const w of [1920, 1280, 1100]) {
  await page.setViewportSize({width:w, height:1000});
  await page.waitForTimeout(900);
  out.desktop[w] = await snap();
}
// 抽屉区（CSS 1024 断点）：设置控件现在**永远**住在左栏设置卡里，
// 而抽屉态下左栏是收起的浮层 —— 所以必须**把左栏打开再量**，
// 否则量到的是「浮层关着」这个正确状态，而不是「控件能不能用」。
for (const w of [1024, 900]) {
  await page.setViewportSize({width:w, height:900});
  await page.waitForTimeout(900);
  await openLeftPanel();
  out.drawer[w] = await snap();
}
// 手机
await page.setViewportSize({width:390, height:844});
await page.waitForTimeout(900);
await openLeftPanel();
out.mobile[390] = await snap();
out.bad = [...new Set(bad)];
return out;
`;
}

const cli = findTabbit();
let dyn = null;
if (!cli) {
  t('动态 · 浏览器可用', false, '未找到 Tabbit CLI —— 动态断言跳过（不计为通过）');
} else {
  mkdirSync(OUT, { recursive: true });
  const tmp = join(OUT, '_layout-driver.mjs');
  const tmpOut = join(OUT, '_layout-driver.out');
  writeFileSync(tmp, driverSource(), 'utf8');
  /**
   * 用 `cmd.exe /c ... < file > out` 把驱动脚本喂给 CLI，结果重定向到文件再读。
   *
   * 这里踩过一个坑：直接 `spawnSync('cmd.exe', ['/d','/c', 整条带引号的命令])`
   * 会报「文件名、目录名或卷标语法不正确」—— 因为 spawnSync 不走 shell，
   * 整条命令被当成**一个**可执行文件名。必须把整条命令行作为**单个字符串**
   * 交给 cmd.exe（`shell: true` 的效果），且重定向符由 cmd 自己解释。
   * 读文件而不是抓 stdout，是为了绕开「程序间管道」在某些受限环境下的限制。
   */
  /**
   * `--request-id` 必须**每次唯一**。
   *
   * 这是踩得最深的一个坑：最初写成固定的 `--request-id layout-check`，
   * 于是第二次以后 CLI 直接**重放第一次的结果**（返回体里
   * `task.reused: true`），根本不重新执行驱动脚本。
   * 表现极具误导性：改了 CSS、改了 app.js，脚本却一直报同样的 4 条失败，
   * 让人以为是前端没生效 —— 实际上是在读一份几分钟前的旧快照。
   * 所以带上时间戳，保证每次都是真跑。
   */
  const reqId = `layout-check-${Date.now()}`;
  const cmdline = `"${cli}" nodejs --task dsh-ui --request-id ${reqId} --timeout-ms 170000 < "${tmp}" > "${tmpOut}" 2>&1`;
  /**
   * 每次运行前先删掉输出文件，**并检查它是否真的被写出来**。
   *
   * 这一步是必须的：驱动脚本超时/失败时 CLI 可能不写文件，
   * 于是我们会读到**上一次**的旧结果，并把它当成本次的实测值 ——
   * 表现就是「明明改了代码，脚本却报同样的错」。实测就这么被坑了
   * 两轮：CSS 已经修好，layout-check 却一直报抽屉态控件消失。
   */
  try { rmSync(tmpOut, { force: true }); } catch { /* 删不掉就靠 mtime 兜底 */ }
  spawnSync(cmdline, { shell: true, encoding: 'utf8', timeout: 260000, maxBuffer: 32 * 1024 * 1024 });
  let raw = '';
  try { raw = readFileSync(tmpOut, 'utf8'); } catch { raw = ''; }
  /**
   * 只从**最后一个** `{"result":` 起解析。
   *
   * 坑：驱动脚本的源码里本身含有 `{"result":` 这个字面量
   * （就在上一段的注释里），而 `raw` 里包含 CLI 回显的内容，
   * 用 `match(/\{"result":[\s\S]*\}$/m)` 会**匹配到源码里的那一个**，
   * 解析出一堆没有 value 的垃圾，`dyn` 就成了 null 或错对象。
   * 所以改用 lastIndexOf：真正的 JSON 一定在最后。
   */
  const at = raw.lastIndexOf('{"result":');
  try {
    const parsed = JSON.parse(at >= 0 ? raw.slice(at) : raw.trim());
    dyn = parsed?.result?.value ?? parsed?.value ?? null;
  } catch { dyn = null; }
  if (process.env.LAYOUT_CHECK_DEBUG) {
    console.error(`[debug] 输出文件 ${tmpOut} 读到 ${raw.length} 字节，含 diag1024=${raw.includes('diag1024')}，解析=${dyn ? Object.keys(dyn).join(',') : 'null'}`);
  }
  if (!dyn) t('动态 · 浏览器采集成功', false, `无法解析驱动输出（${raw.length} 字节）：${raw.slice(0, 240).replace(/\s+/g, ' ')}`);
}

if (dyn) {
  t('动态 · 采集成功', true);
  t('动态 · 控制台 0 错误 0 404', (dyn.bad || []).length === 0, (dyn.bad || []).join(' | ').slice(0, 200));
  t('动态 · 真实审阅跑通（右栏有问题可量）', (dyn.desktop?.[1680]?.issues ?? 0) > 0,
    `问题数 ${dyn.desktop?.[1680]?.issues}`);

  for (const [w, s] of Object.entries(dyn.desktop || {})) {
    const tag = `动态 · ${w}px`;
    t(`${tag} · 顶栏控件 ≤ 5`, s.topbarControls <= 5, `实得 ${s.topbarControls}：${(s.topbarIds || []).join(',')}`);
    t(`${tag} · 设置控件在左栏设置卡内`, s.settingsInSlot === true);
    t(`${tag} · 设置控件不在顶栏`, s.settingsInTopbar === false);
    t(`${tag} · 设置卡可见`, s.settingsCardHidden === false);
    t(`${tag} · 三个设置控件都可见`, s.modelVisible && s.ruleModeVisible,
      `model=${s.modelVisible} ruleMode=${s.ruleModeVisible}`);
    const prog = (s.cards || []).find((c) => c.t === '进度');
    t(`${tag} · 进度卡高度贴近内容（不出现白板）`, prog && prog.h <= Math.max(s.progressContentH + 60, 140),
      `卡高 ${prog?.h} 内容高 ${s.progressContentH}`);
    t(`${tag} · 左栏卡片都 ≥ 30px（没有被挤没）`, (s.cards || []).every((c) => c.h >= 30),
      (s.cards || []).map((c) => `${c.t}=${c.h}`).join(' '));
    t(`${tag} · 清单与详情同时可见`, s.listH >= 150 && s.detailH >= 150, `list=${s.listH} detail=${s.detailH}`);
    t(`${tag} · 无横向滚动`, s.noHScroll === true);
  }
  for (const [w, s] of Object.entries(dyn.drawer || {})) {
    const tag = `动态 · 抽屉 ${w}px`;
    // 设置控件的唯一归宿是左栏设置卡；抽屉态下左栏是浮层，打开左栏即可用。
    t(`${tag} · 设置控件仍在左栏设置卡内（不随断点搬家）`, s.settingsInSlot === true);
    t(`${tag} · 设置卡未被隐藏`, s.settingsCardHidden === false);
    t(`${tag} · 三个设置控件仍可见（功能没消失）`, s.modelVisible && s.ruleModeVisible,
      `model=${s.modelVisible} ruleMode=${s.ruleModeVisible}`);
    t(`${tag} · 无横向滚动`, s.noHScroll === true);
  }
  for (const [w, s] of Object.entries(dyn.mobile || {})) {
    const tag = `动态 · 手机 ${w}px`;
    t(`${tag} · 无横向滚动`, s.noHScroll === true);
    /**
     * 手机端必须**真的能用**，不能只要求「DOM 里存在」。
     *
     * 这里曾经放过的故障：`@media (max-width:640px)` 里有
     * `.topbar-actions .switch{display:none}`，而「模型深度审阅」开关
     * 当时只住在顶栏 → 手机上开关被 CSS 藏了，设置卡又被 JS 藏了，
     * **根本无法开启模型审阅**。
     * 所以手机端断言必须是「在设置卡内 + 卡片可见 + 控件有实际尺寸」。
     */
    t(`${tag} · 设置控件在左栏设置卡内`, s.settingsInSlot === true);
    t(`${tag} · 设置卡未被隐藏`, s.settingsCardHidden === false);
    t(`${tag} · 模型开关有实际尺寸（没被 CSS 藏掉）`, s.modelVisible === true, `model=${s.modelVisible}`);
    t(`${tag} · 规则匹配下拉有实际尺寸`, s.ruleModeVisible === true, `ruleMode=${s.ruleModeVisible}`);
  }
}

/* ---------- 汇总与落盘 ---------- */
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
const stamp = new Date().toISOString();

const payload = { generatedAt: stamp, url: URL_, total: results.length, pass, fail, results, dynamic: dyn };
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'layout-check.json'), JSON.stringify(payload, null, 2), 'utf8');

const md = [
  '# 左右两侧排布校验（目标点 3）', '',
  `- 生成时间：${stamp}`,
  `- 目标页面：${URL_}`,
  `- 断言：**${pass} 通过 / ${fail} 失败**（共 ${results.length} 条）`, '',
  '| # | 断言 | 结果 | 实测 |', '| ---: | --- | :---: | --- |',
  ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.pass ? '✅' : '❌'} | ${r.detail || ''} |`),
  '',
];
writeFileSync(join(OUT, '左右两侧排布校验.md'), md.join('\n'), 'utf8');

console.log(`═══ 左右两侧排布校验（目标点 3） ═══`);
console.log(`目标页面 ${URL_}`);
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? `（${r.detail}）` : ''}`);
console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
console.log(`明细已写入 ${join(OUT, 'layout-check.json')}`);
console.log(`报告已写入 ${join(OUT, '左右两侧排布校验.md')}`);
process.exit(fail ? 1 : 0);
