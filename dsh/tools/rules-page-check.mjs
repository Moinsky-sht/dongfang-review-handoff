#!/usr/bin/env node
/**
 * 规则管理页面校验（目标点 12：规则管理优化）。
 *
 * ## 为什么要有这个脚本
 *
 * 「规则管理」是审稿人理解规则的唯一入口。后端算得再对，
 * 只要页面显示的和实际行为不一致，规则管理就是骗人的。
 * 本项目已经在这上面栽过两次：
 *
 *   · **元信息漂移**：`CIT-008` 规则库写「只有标号而无文献信息」，
 *     代码实际判「页码区间使用短横线」；`CIT-018`/`CIT-019` 同类问题。
 *     → 由 `tools/rule-metadata-consistency.mjs` 守（后端口径）。
 *   · **状态被覆盖**：规则库里写好的 `status: 'auto-未触发'` 被
 *     `withStatus()` 无条件重算盖掉，页面声称「规则引擎自动检测」，
 *     而它全语料一次都没跑出过结果。
 *     → 由**本脚本**守（页面口径）。
 *
 * 本脚本真的开浏览器，检查：分档 chip 是否齐全、计数是否与 API 一致、
 * 「未触发」筛选是否真能筛出那几条、状态说明是否真的显示出来。
 *
 * ## 用法
 *
 *   node tools/rules-page-check.mjs
 *   node tools/rules-page-check.mjs --url http://127.0.0.1:3210
 *
 * 需要 Tabbit 浏览器。没有浏览器时脚本会明确报「跳过」，而不是假装通过 ——
 * 假通过比不通过更危险。
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'verify');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = argOf('--url', 'http://127.0.0.1:3210/');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });

/* ---- 后端口径：先拿 API 的真实数字，作为页面断言的基准 ---- */
let api = null;
try {
  const r = await fetch(new URL('/api/rules', URL_));
  api = await r.json();
} catch (e) {
  t('前置 · /api/rules 可达', false, e.message);
}
if (api) {
  const all = [...(api.format?.rules || []), ...(api.language?.rules || []), ...(api.citation?.rules || [])];
  const dormant = all.filter((x) => x.status === 'auto-未触发');
  t('API · 存在 auto-未触发 规则', dormant.length > 0, `${dormant.length} 条`);
  t('API · statusSummary.dormant 与实际条数一致',
    (api.statusSummary?.dormant ?? 0) === dormant.length,
    `summary=${api.statusSummary?.dormant} 实际=${dormant.length}`);
  t('API · 每条未触发规则都带原因说明',
    dormant.every((x) => typeof x.statusNote === 'string' && x.statusNote.length > 20));
  // statusNote 会直接渲染成纯文本，不能残留 markdown 强调标记
  t('API · 状态说明不含 markdown 标记（页面是纯文本渲染）',
    all.every((x) => !/\*\*|^#|`/.test(String(x.statusNote || ''))),
    (all.find((x) => /\*\*|`/.test(String(x.statusNote || ''))) || {}).id || '');
  api._dormantIds = dormant.map((x) => x.id).sort();
  api._total = all.length;
  api._counts = api.statusSummary || {};
}

/* ---- 前端口径：开浏览器真的点一遍 ---- */
function findTabbit() {
  const p = join(process.env.LOCALAPPDATA || '', 'Tabbit', 'LocalAgent', 'bin', 'tabbit-cli.exe');
  return existsSync(p) ? p : null;
}

function driverSource() {
  return `
const bad = [];
page.on("pageerror", e => bad.push("pageerror: " + String(e.message)));
page.on("console", m => { if (m.type() === "error") bad.push("console: " + m.text().slice(0,140)); });
page.on("response", r => { if (r.status() >= 400) bad.push("HTTP " + r.status() + " " + r.url()); });
const out = {};
await page.setViewportSize({width:1680, height:1000});
await page.goto(${JSON.stringify(URL_)}, {waitUntil:"domcontentloaded"});
await page.waitForTimeout(2500);
// 切到「规则」页签。注意不能按文字模糊匹配 —— 批阅视图里也有个叫「模型」的 chip，
// 早期用 /规则管理|规则库/ 找不到，用 /规则/ 才对。
await page.evaluate(() => {
  const b = [...document.querySelectorAll(".tab")].find(x => /^规则/.test((x.textContent||"").trim()));
  if (b) b.click();
});
await page.waitForTimeout(2200);
out.page = await page.evaluate(() => ({
  tags: [...document.querySelectorAll(".rules-stats .tag")].map(e => e.textContent.trim()),
  statusChips: [...document.querySelectorAll("#rulesStatus .chip")].map(e => e.textContent.trim()),
  dormantTagText: document.querySelector(".tag-dormant")?.textContent.trim() || null,
  dormantTagBorder: document.querySelector(".tag-dormant") ? getComputedStyle(document.querySelector(".tag-dormant")).borderStyle : null,
  totalRows: document.querySelectorAll(".rules-list > *").length,
  noHScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
}));
// 点「未触发」，看是否真能筛出那几条
await page.evaluate(() => {
  const c = [...document.querySelectorAll("#rulesStatus .chip")].find(x => /未触发/.test(x.textContent||""));
  if (c) c.click();
});
await page.waitForTimeout(1200);
out.filtered = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".rules-list > *")];
  return {
    rowCount: rows.length,
    ids: rows.map(r => (r.textContent.match(/(FMT|LANG|CIT)[A-Z]?-\\d+/) || [""])[0]).filter(Boolean).sort(),
  };
});
// 展开第一条，确认「状态说明」真的渲染出来
await page.evaluate(() => document.querySelector(".rules-list .rule-card-head")?.click());
await page.waitForTimeout(700);
out.noteShown = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".detail-block")].find(x => /状态说明/.test(x.textContent||""));
  return b ? b.textContent.replace(/\\s+/g," ").trim().slice(0,200) : null;
});
// 回「全部」，确认行数恢复
await page.evaluate(() => {
  const c = [...document.querySelectorAll("#rulesStatus .chip")].find(x => /^全部/.test(x.textContent||""));
  if (c) c.click();
});
await page.waitForTimeout(1000);
out.restored = await page.evaluate(() => document.querySelectorAll(".rules-list > *").length);
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
  const tmp = join(OUT, '_rules-page-driver.mjs');
  const tmpOut = join(OUT, '_rules-page-driver.out');
  writeFileSync(tmp, driverSource(), 'utf8');
  // request-id 必须每次唯一，否则 CLI 会重放上一次结果而不重新执行
  const reqId = `rules-page-check-${Date.now()}`;
  const cmdline = `"${cli}" nodejs --task dsh-ui --request-id ${reqId} --timeout-ms 120000 < "${tmp}" > "${tmpOut}" 2>&1`;
  // 先删输出文件：驱动失败时 CLI 可能不写文件，否则会读到上一次的旧结果
  try { rmSync(tmpOut, { force: true }); } catch { /* 删不掉就靠时间戳兜底 */ }
  spawnSync(cmdline, { shell: true, encoding: 'utf8', timeout: 200000, maxBuffer: 32 * 1024 * 1024 });
  let raw = '';
  try { raw = readFileSync(tmpOut, 'utf8'); } catch { raw = ''; }
  // 只从最后一个 {"result": 起解析（驱动源码里也可能出现这个字面量）
  const at = raw.lastIndexOf('{"result":');
  try {
    const parsed = JSON.parse(at >= 0 ? raw.slice(at) : raw.trim());
    dyn = parsed?.result?.value ?? parsed?.value ?? null;
  } catch { dyn = null; }
  if (!dyn) t('动态 · 浏览器采集成功', false, `无法解析驱动输出（${raw.length} 字节）：${raw.slice(0, 200).replace(/\s+/g, ' ')}`);
}

if (dyn && api) {
  t('动态 · 浏览器采集成功', true);
  t('动态 · 控制台 0 错误 0 404', (dyn.bad || []).length === 0, (dyn.bad || []).join(' | ').slice(0, 200));
  t('动态 · 规则页签能打开（有规则行）', (dyn.page?.totalRows ?? 0) > 0, `行数 ${dyn.page?.totalRows}`);
  t('动态 · 无横向滚动条', dyn.page?.noHScroll === true);

  // 分档 chip 必须齐全：少一档，那类规则在筛选时无处可去
  const chips = dyn.page?.statusChips || [];
  const wantChips = ['全部', '规则引擎', '未触发', '模型判断', '人工复核'];
  for (const w of wantChips) {
    t(`动态 · 分档 chip「${w}」存在`, chips.some((c) => c.startsWith(w)), chips.join(' / '));
  }
  t('动态 · 「未触发」标签可见', dyn.page?.dormantTagText !== null, String(dyn.page?.dormantTagText));
  t('动态 · 「未触发」标签用虚线边框区别', dyn.page?.dormantTagBorder === 'dashed', String(dyn.page?.dormantTagBorder));

  // 计数必须与 API 一致（页面不能自己编数字）
  const chipNum = (k) => {
    const c = chips.find((x) => x.startsWith(k));
    const m = c && c.match(/(\d+)/);
    return m ? Number(m[1]) : null;
  };
  t('动态 · 「未触发」计数与 API 一致',
    chipNum('未触发') === (api._counts.dormant ?? 0),
    `页面=${chipNum('未触发')} API=${api._counts.dormant}`);
  t('动态 · 「全部」计数与 API 一致',
    chipNum('全部') === api._total,
    `页面=${chipNum('全部')} API=${api._total}`);

  // 筛选必须真的筛得出来，而且筛出来的就是那几条
  t('动态 · 「未触发」筛选行数与 API 一致',
    (dyn.filtered?.rowCount ?? -1) === (api._dormantIds || []).length,
    `页面=${dyn.filtered?.rowCount} API=${(api._dormantIds || []).length}`);
  t('动态 · 「未触发」筛出的正是那几条规则',
    JSON.stringify(dyn.filtered?.ids || []) === JSON.stringify(api._dormantIds || []),
    `页面=${JSON.stringify(dyn.filtered?.ids)} API=${JSON.stringify(api._dormantIds)}`);

  t('动态 · 展开后「状态说明」真的渲染出来',
    typeof dyn.noteShown === 'string' && dyn.noteShown.includes('判据有效'),
    String(dyn.noteShown).slice(0, 80));
  t('动态 · 切回「全部」行数恢复',
    (dyn.restored ?? 0) === api._total,
    `页面=${dyn.restored} API=${api._total}`);
}

/* ---- 落盘 ---- */
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
const stamp = new Date().toISOString();
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'rules-page-check.json'),
  JSON.stringify({ generatedAt: stamp, url: URL_, total: results.length, pass, fail, results, dynamic: dyn }, null, 2), 'utf8');

const md = [
  '# 规则管理页面校验（目标点 12）', '',
  `- 生成时间：${stamp}`,
  `- 目标页面：${URL_}`,
  `- 断言：**${pass} 通过 / ${fail} 失败**（共 ${results.length} 条）`, '',
  '| # | 断言 | 结果 | 实测 |', '| ---: | --- | :---: | --- |',
  ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.pass ? '✅' : '❌'} | ${r.detail || ''} |`),
  '',
  '## 为什么守这些', '',
  '后端算得再对，页面显示的和实际行为不一致，规则管理就是骗人的。',
  '本项目已栽过两次：元信息漂移（`CIT-008`/`CIT-018`/`CIT-019` 标题与代码不符）、',
  '状态被覆盖（规则库写好的 `auto-未触发` 被 `withStatus()` 盖掉，',
  '页面声称「规则引擎自动检测」而它全语料一次都没跑出过结果）。', '',
];
writeFileSync(join(OUT, '规则管理页面校验.md'), md.join('\n'), 'utf8');

console.log('═══ 规则管理页面校验（目标点 12） ═══');
console.log(`目标页面 ${URL_}`);
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? `（${r.detail}）` : ''}`);
console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
console.log(`明细已写入 ${join(OUT, 'rules-page-check.json')}`);
console.log(`报告已写入 ${join(OUT, '规则管理页面校验.md')}`);
process.exit(fail ? 1 : 0);
