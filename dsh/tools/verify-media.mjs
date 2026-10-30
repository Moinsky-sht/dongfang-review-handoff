/**
 * 图片抽取与「阅读器取图」链路的验证。
 *
 * ── 背景 ──
 * docx-preview **不渲染** `w:drawing`，含图稿件在阅读器里图片是空的。
 * 修法是：解析层把每个 figure 的 `r:embed` / `r:id` 经 `word/_rels/*.rels`
 * 解析成 `word/media/*` 条目名（`figures[].media`），前端再逐张走
 * `/api/session-media` 取字节补进 DOM。
 *
 * 本脚本验证这条链路的**两段**：
 *   ① 解析层：一篇稿里「有图的 figure 对象」必须**全部**解析出 media 条目
 *      （`images > 0` 但 `media` 为空 = 有图却拿不到字节，属于硬失败）。
 *   ② 取图端点：上传一篇真稿 → 用真实 media 路径取图 → 必须 200 且返回
 *      非空图片字节；路径穿越 / 不存在的条目必须被拒绝。
 *
 * 用法：node tools/verify-media.mjs   （需要先启动 server.mjs）
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { CORPUS_ROOT } from './paths.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:3210';

function walk(dir, acc = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name.startsWith('.')) continue; walk(p, acc); }
    else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log('  \u2713 ' + m); };
const bad = (m) => { fail += 1; console.log('  \u2717 ' + m); };

// ── ① 解析层：逐篇核对「有图必有 media 条目」──
let docs = 0; let figsWithImg = 0; let mediaEntries = 0; let unresolved = 0;
const samples = [];
for (const f of walk(CORPUS_ROOT)) {
  let doc;
  try { doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f)); } catch { continue; }
  let has = false;
  for (const p of doc.paragraphs) {
    for (const g of (p.figures || [])) {
      if ((g.images || 0) <= 0) continue;
      has = true;
      figsWithImg += 1;
      const n = (g.media || []).length;
      mediaEntries += n;
      if (!n) unresolved += 1;
    }
  }
  if (has) {
    docs += 1;
    if (samples.length < 3 && doc.stats.images > 0) samples.push(f);
  }
}
console.log(`\n① 解析层：有图稿件 ${docs} 篇｜有图 figure 对象 ${figsWithImg} 个｜解析出 media 条目 ${mediaEntries} 个`);
if (unresolved === 0) ok('所有含图 figure 都解析出了 media 条目（未解析 0）');
else bad(`有 ${unresolved} 个含图 figure 未解析出 media 条目`);

// ── ② 取图端点：真稿上传 → 真路径取图 ──
let reachable = true;
try {
  const h = await fetch(BASE + '/api/health');
  if (!h.ok) throw new Error('health ' + h.status);
} catch (e) {
  reachable = false;
  console.log(`\n② 取图端点：跳过（服务未启动：${e.message}）`);
}
if (reachable && samples.length) {
  const file = samples[0];
  const buf = fs.readFileSync(file);
  const up = await fetch(BASE + '/api/upload?name=' + encodeURIComponent(path.basename(file)), {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
  });
  const data = await up.json();
  if (!up.ok) bad('上传失败：' + (data.error || up.status));
  else {
    const id = data.id;
    const st = data.doc?.stats || {};
    const media = [];
    for (const p of (data.doc?.paragraphs || [])) {
      for (const g of (p.figures || [])) for (const m of (g.media || [])) if (m && m.path) media.push(m);
    }
    console.log(`   样稿：${path.basename(file)}｜stats.images=${st.images}｜下发 media ${media.length} 个`);
    if (media.length && st.images === media.length) ok('会话负载下发的 media 数量与 stats.images 一致');
    else bad(`stats.images=${st.images} 与下发 media ${media.length} 不一致`);

    const m0 = media[0];
    if (m0) {
      const r = await fetch(`${BASE}/api/session-media?id=${encodeURIComponent(id)}&name=${encodeURIComponent(m0.path)}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || '';
      if (r.ok && bytes.length > 0 && /^image\//.test(ct)) ok(`取图成功：${m0.path} → ${ct} ${bytes.length} 字节`);
      else bad(`取图失败：${m0.path} → ${r.status} ${ct} ${bytes.length} 字节`);
    } else {
      bad('样稿未下发任何 media 条目，无法测试取图端点');
    }

    const trav = await fetch(`${BASE}/api/session-media?id=${encodeURIComponent(id)}&name=${encodeURIComponent('../package.json')}`);
    if (trav.status === 400) ok('路径穿越（../package.json）被拒绝 400');
    else bad(`路径穿越未被拒绝，返回 ${trav.status}`);

    const miss = await fetch(`${BASE}/api/session-media?id=${encodeURIComponent(id)}&name=${encodeURIComponent('word/media/__nope__.png')}`);
    if (miss.status === 404) ok('不存在的条目返回 404');
    else bad(`不存在的条目应 404，实际 ${miss.status}`);
  }
}

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
// 不用 process.exit()：Windows 上若还有未关闭的 keep-alive 连接，
// 强制退出会触发 libuv 断言（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)）。
process.exitCode = fail ? 1 : 0;
