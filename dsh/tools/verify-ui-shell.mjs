/**
 * 前端外壳无头回归（Phase 5）。
 * =================================================================
 * 项目是零依赖（没有 puppeteer/playwright），所以做不了真·无头浏览器渲染。
 * 但「UI 坏掉」绝大多数属于**可在外壳层抓到**的故障：
 *   · index.html 引用的静态资源 404（改名/挪目录/漏提交）
 *   · 关键挂载点 id 被删（app.js 找不到节点，整页交互失效）
 *   · 供应商库（docx-preview / jszip）没挂上，阅读器整块不渲染
 *   · 服务没起来 / 健康检查挂了
 * 本工具用 Node 内置 fetch 拉页面与资源，断言这些不变量，
 * 做到**可复现、零依赖、秒级**——与 verify-render.mjs（需要外部浏览器标签）互补。
 *
 * 真正需要「像素/布局」的部分（渲染、字号、图片）仍由 verify-render / verify-media 覆盖。
 *
 * 用法：node tools/verify-ui-shell.mjs   （需 server.mjs 在跑）
 * 退出码：任一断言失败 → 1
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3210';

let pass = 0; let fail = 0;
const results = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; results.push(['✓', name]); }
  else { fail += 1; results.push(['✗', `${name}${detail ? ' —— ' + detail : ''}`]); }
};

const get = async (path) => {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(8000) });
  const body = await r.text();
  return { status: r.status, body, len: body.length };
};

let health = null;
try { health = await get('/api/health'); } catch (e) { ok('服务可达（/api/health）', false, e.message); }

if (health) {
  ok('GET /api/health → 200', health.status === 200, `实际 ${health.status}`);
  let hp = null;
  try { hp = JSON.parse(health.body); } catch { /* ignore */ }
  ok('/api/health 返回可解析 JSON', hp !== null);
  ok('/api/health 标记 ok', !!(hp && (hp.ok || hp.status === 'ok')), JSON.stringify(hp).slice(0, 80));

  let idx = null;
  try { idx = await get('/'); } catch (e) { ok('GET / → 200', false, e.message); }
  if (idx) {
    ok('GET / → 200', idx.status === 200, `实际 ${idx.status}`);
    ok('/ 返回 HTML 文档', /<html/i.test(idx.body) && /<\/html>/i.test(idx.body));
    ok('/ 含页面标题', /<title>.*<\/title>/i.test(idx.body));
    ok('/ 有内联 favicon（避免 /favicon.ico 404）', /rel="icon"/i.test(idx.body));

    // 关键挂载点：app.js 依赖这些 id，缺一个就有交互整块失效
    for (const id of ['docHost', 'mkIssues', 'btnImport', 'btnReview', 'viewTabs', 'rightPanel', 'leftPanel', 'selfVerify', 'useContext', 'useCases']) {
      ok(`/ 含挂载点 #${id}`, new RegExp(`id="${id}"`).test(idx.body));
    }

    // Check the resources this page actually loads. Checking a former library
    // path can pass while the new reader resource is missing from the page.
    const declared = [...idx.body.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi),
      ...idx.body.matchAll(/<link\b[^>]*\bhref="([^"]+\.css(?:\?[^"]*)?)"/gi)].map((match) => match[1]);
    const assets = [...new Set(declared.filter((path) => /^\/(?!\/)/.test(path)))];
    ok('/ 实际引用一个 docx-preview 阅读器', assets.filter((path) => /\/docx-preview[^/]*\.js(?:\?|$)|\/docx-preview\/.*\.js(?:\?|$)/.test(path)).length === 1);
    ok('/ 实际引用 JSZip', assets.some((path) => /\/jszip\/.*\.js(?:\?|$)/.test(path)));
    for (const asset of assets) {
      let a = null;
      try { a = await get(asset); } catch (e) { ok(`资源可达 ${asset}`, false, e.message); continue; }
      ok(`资源可达 ${asset} → 200`, a.status === 200, `实际 ${a.status}`);
      ok(`资源 ${asset} 非空`, a.len > 1000, `${a.len} 字节`);
    }

    // app.js 装了本轮的关键阅读器逻辑（改错了会在此红灯）
    let appJs = null;
    try { appJs = await get('/app.js'); } catch { /* 上面已报 */ }
    if (appJs) {
      for (const fn of ['renderFigures', 'figMediaUrl', 'normalizeReaderFormatting', 'selfVerify', 'useContext', 'useCases']) {
        ok(`/app.js 含 ${fn}`, appJs.body.includes(fn));
      }
    }
  }
}

console.log('前端外壳无头回归（UI shell）');
for (const [mark, name] of results) console.log(`  ${mark} ${name}`);
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
