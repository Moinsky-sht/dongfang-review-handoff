/** 清洗状态/历史审阅前端回归。使用真实响应形状的替身，不调用模型或浏览器。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
assert.match(html, /id="btnLegacyReview"/);
assert.match(html, /id="btnVerifyClean"/);
assert.match(html, /id="auditTitle"/);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const clean = (status = 'cleaned') => ({ status, commentsRemoved: 12, anchorsRemoved: 24, commentParts: 2,
  originalCommentCount: 12, sourceSha256: 'source-sha', workSha256: 'working-sha' });
const doc = (name = 'N') => ({ label: `${name}.docx`, originalCommentCount: 12, meta: { title: name },
  stats: { comments: 0 }, paragraphs: [{ text: '真实工作稿正文' }], footnotes: [], endnotes: [], headings: [] });
const session = (id = 'N', status = 'cleaned') => ({ exists: true, id, name: `${id}.docx`, doc: doc(id), clean: clean(status),
  workVersion: { id: `${id}-v0`, revision: 0, sha256: 'working-sha' }, history: { epoch: 0 }, result: null, running: false, hasResult: false, reviewRunId: null });
const json = (value, ok = true, status = ok ? 200 : 422) => ({ ok, status, json: async () => value });
const fileBytes = (id = 'N-v0') => ({ ok: true, headers: { get: () => id }, arrayBuffer: async () => new Uint8Array([1]).buffer });
function harness() {
  const elements = new Map(); const stored = new Map();
  const makeElement = () => {
    const classes = new Set();
    return { dataset: {}, style: {}, childNodes: [], innerHTML: '', textContent: '', value: '', disabled: false,
      classList: { add(...names) { names.forEach((name) => classes.add(name)); }, remove(...names) { names.forEach((name) => classes.delete(name)); },
        toggle(name, force) { const enabled = force === undefined ? !classes.has(name) : force; if (enabled) classes.add(name); else classes.delete(name); return enabled; }, contains: (name) => classes.has(name) },
      querySelector: () => null, querySelectorAll: () => [], replaceChildren(...children) { this.childNodes = children; },
      addEventListener() {}, appendChild() {}, contains: () => true, focus() {} };
  };
  const sandbox = { document: { querySelector: (id) => { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
    querySelectorAll: () => [], addEventListener() {}, createElement: makeElement },
    window: { matchMedia: () => ({ matches: false }) }, location: { search: '' }, URLSearchParams,
    localStorage: { getItem: (name) => stored.get(name) || null, setItem: (name, value) => stored.set(name, value), removeItem: (name) => stored.delete(name) },
    fetch: () => { throw new Error('Unexpected fetch'); }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} };
  const noops = ['renderDocInfo', 'renderMarkupIssues', 'renderMarkupStats', 'highlightIssuesInDoc', 'markHeadingLevels', 'wireCitations', 'updateApplyBtn', 'clearMarks',
    'indexRenderedParagraphs', 'markTitleParagraph', 'normalizeReaderFormatting', 'renderFigures', 'reapplyHumanMarks', 'initHeadingSpy', 'setProgressBar', 'hideProgressBar', 'switchView'];
  runInNewContext(source + `\n globalThis.realDocInfo = renderDocInfo;\n${noops.map((name) => `${name} = () => {};`).join('\n')}
    renderDocument = async () => {};
    globalThis.progressItems = [];
    setProgress = (items) => { progressItems = items; };
    globalThis.api = { state, cleanPresentation, currentCleanProgress, adoptDocumentProvenance, syncLegacyReviewButton,
      importFile, importFiles, activateItem, restoreSession, resumeReview, adoptWorkResponse, openLegacyReview, renderLegacyReview,
      openAuditModal, resetHumanState, toggleOriginal, verifyLegacyClean, runReview, renderDocInfo: realDocInfo };
    globalThis.setStream = (fn) => { consumeStream = fn; };
  `, sandbox, { filename: 'public/app.js' });
  const { state } = sandbox.api;
  Object.assign(state, { sessionId: 'A', doc: doc('A'), buffer: new Uint8Array([7]).buffer, workVersion: { id: 'A-v0', revision: 0 },
    history: { epoch: 0 }, clean: clean(), legacy: null, workspaceId: 'clean-fixture', workspaceSupported: false, ingestionSupported: false, queueSupported: false,
    issues: [], summary: null, queue: [], streaming: false });
  return { sandbox, api: sandbox.api, elements, stored };
}
const inputFile = { name: 'N.docx', arrayBuffer: async () => new Uint8Array([8]).buffer };
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`✓ ${name}`); }

await check('统一展示区分 cleaned/unchanged/legacy/failed，不推断缺字段为成功', () => {
  const { api } = harness();
  assert.match(api.cleanPresentation(clean()).text, /12 条批注、24 处锚点、2 个批注部件/);
  assert.match(api.cleanPresentation(clean('unchanged')).text, /无需变更/);
  assert.equal(api.cleanPresentation(clean('legacy-unverified')).cls, 'warn');
  assert.match(api.cleanPresentation({ status: 'failed', reason: '部件损坏' }).text, /清洗失败：部件损坏/);
  const old = api.cleanPresentation({ commentsRemoved: 12, anchorsRemoved: 24 });
  assert.equal(old.cls, 'warn'); assert.equal(old.text, '未提供清洗验证');
});
await check('422 清洗失败不创建会话、不取原稿或工作字节、不报成功', async () => {
  const { sandbox, api, elements } = harness(); const oldDoc = api.state.doc; const oldBuffer = api.state.buffer;
  const paths = [];
  sandbox.fetch = async (url) => { paths.push(url); return json({ error: '清洗失败', clean: { status: 'failed', reason: '删除批注校验失败', originalCommentCount: 3, sourceSha256: 'source' } }, false); };
  await api.importFile(inputFile);
  assert.equal(paths.length, 1); assert.match(paths[0], /^\/api\/upload/);
  assert.equal(api.state.sessionId, 'A'); assert.equal(api.state.doc, oldDoc); assert.equal(api.state.buffer, oldBuffer);
  assert.match(elements.get('#toast').textContent, /清洗失败/);
  assert.doesNotMatch(elements.get('#toast').textContent, /已保存|清洗已验证|已导入并清洗/);
  assert.equal(api.state.queue.length, 1);
  assert.equal(api.state.queue[0].id, undefined);
  assert.equal(api.state.queue[0].status, 'upload-failed');
  assert.equal(api.state.queue[0].queueUnsaved, true);
});
await check('即使 HTTP 200，failed 状态或缺少 session 也不能走成功路径', async () => {
  for (const payload of [{ clean: { status: 'failed', reason: 'fixture' } }, { clean: clean(), doc: doc() }]) {
    const { sandbox, api } = harness(); let paths = 0;
    sandbox.fetch = async () => { paths += 1; return json(payload); };
    await api.importFile(inputFile);
    assert.equal(paths, 1); assert.equal(api.state.sessionId, 'A');
  }
});
await check('成功导入使用真实工作稿结构和字节，原稿批注数单独保存', async () => {
  const { sandbox, api } = harness(); const uploaded = session();
  sandbox.fetch = async (url) => url.startsWith('/api/upload') ? json(uploaded)
    : url.startsWith('/api/session-file') ? fileBytes() : json(uploaded);
  await api.importFile(inputFile);
  assert.equal(api.state.doc, uploaded.doc); assert.equal(api.state.doc.originalCommentCount, 12);
  assert.equal(api.state.doc.stats.comments, 0); assert.equal(new Uint8Array(api.state.buffer)[0], 1);
  assert.equal(api.state.clean.status, 'cleaned');
  assert.ok(sandbox.progressItems.some((item) => /清洗已验证/.test(item.text)));
  assert.ok(!sandbox.progressItems.some((item) => /均已完整解析/.test(item.text)));
});
await check('工作字节下载失败时不回退上传原稿，预览失败明确显示', async () => {
  const { sandbox, api } = harness(); const uploaded = { ...session(), workVersion: null, clean: {} };
  sandbox.fetch = async (url) => url.startsWith('/api/upload') ? json(uploaded)
    : url.startsWith('/api/session-file') ? { ok: false } : json(uploaded);
  await api.importFile(inputFile);
  assert.equal(api.state.buffer, null);
  assert.ok(sandbox.progressItems.some((item) => /当前稿预览未载入/.test(item.text)));
  assert.ok(sandbox.progressItems.some((item) => item.text === '未提供清洗验证'));
});
await check('稿件卡区分原稿与当前稿批注，legacy 不被括注为已清洗', () => {
  const { api, elements } = harness();
  api.state.doc.stats.comments = 3; api.state.clean = { ...clean('legacy-unverified'), reason: '未保存验证' };
  api.renderDocInfo(); const html = elements.get('#docInfo').innerHTML;
  assert.match(html, /原稿批注：<b>12<\/b>/); assert.match(html, /当前稿批注：<b>3<\/b>/);
  assert.match(html, /历史文件清洗未验证/); assert.doesNotMatch(html, /（已清洗）|清洗已验证/);
});
const legacy = { available: true, sourceBase: 'C:\\旧保存目录', sourceSessionId: 'old-source', capturedAt: '2026-10-09T00:00:00Z',
  consistency: 'unknown', historyAvailable: true, reason: '先前记录未核对' };
await check('切稿以当前 clean/legacy 覆盖缓存，只显示历史未验证', async () => {
  const { sandbox, api, elements } = harness(); const current = { ...session('L', 'legacy-unverified'), legacy };
  sandbox.fetch = async (url) => url.startsWith('/api/session-file') ? fileBytes('L-v0') : json(current);
  await api.activateItem({ id: 'L', name: 'L.docx', clean: clean(), legacy: null }, { persist: false });
  assert.equal(api.state.clean.status, 'legacy-unverified'); assert.equal(api.state.legacy, legacy);
  assert.equal(api.state.issues.length, 0); assert.equal(api.state.summary, null);
  assert.ok(sandbox.progressItems.some((item) => /历史文件清洗未验证/.test(item.text)));
  assert.ok(!sandbox.progressItems.some((item) => /已导入并清洗|清洗已验证/.test(item.text)));
  assert.equal(elements.get('#btnLegacyReview').disabled, false);
});
await check('刷新恢复与状态接口采用同一清洗事实，缺 status 不猜成功', async () => {
  const { sandbox, api, stored } = harness(); stored.set('dsh.lastSession', 'L');
  sandbox.location.search = '?session=L';
  api.state.issues = [{ title: '另一稿的旧问题' }]; api.state.summary = { total: 1 };
  const current = { ...session('L', 'legacy-unverified'), legacy };
  sandbox.fetch = async (url) => url.startsWith('/api/session-file') ? fileBytes('L-v0') : json(current);
  await api.restoreSession(); assert.equal(api.state.clean.status, 'legacy-unverified');
  assert.equal(api.state.issues.length, 0); assert.equal(api.state.summary, null);
  sandbox.fetch = async () => json({ ...current, clean: { commentsRemoved: 12 }, workVersion: current.workVersion });
  await api.resumeReview({ silent: true });
  assert.equal(api.cleanPresentation(api.state.clean).text, '未提供清洗验证');
});
await check('原稿获取失败明确保留当前稿，不把 legacy 当前稿称为已清洗', async () => {
  const { sandbox, api, elements } = harness(); api.state.clean = clean('legacy-unverified');
  sandbox.fetch = async () => ({ ok: false });
  await api.toggleOriginal();
  assert.equal(api.state.showOriginal, false);
  assert.equal(elements.get('#toast').textContent, '原文获取失败，已保留当前稿');
  assert.doesNotMatch(elements.get('#toast').textContent, /清洗稿|已返回/);
});
await check('修改/撤销响应和队列缓存同步 clean/legacy，不伪造统计', () => {
  const { api } = harness(); api.state.queue = [{ id: 'A' }];
  const factual = { status: 'unchanged', originalCommentCount: 0, commentsRemoved: 0, anchorsRemoved: 0, commentParts: 0, sourceSha256: 'one', workSha256: 'one' };
  api.adoptWorkResponse('A', { doc: doc('A'), workVersion: { id: 'A-v0' }, history: { epoch: 1 }, clean: factual, legacy, result: null, appliedFixes: [], appliedFixDetails: [] });
  assert.equal(api.state.clean, factual); assert.equal(api.state.queue[0].clean, factual);
  assert.equal(api.state.legacy, legacy); assert.equal(api.state.queue[0].legacy, legacy);
});
await check('历史按钮仅在 historyAvailable 时出现', () => {
  const { api, elements } = harness();
  api.adoptDocumentProvenance({ legacy: { available: true, historyAvailable: false } });
  assert.equal(elements.get('#btnLegacyReview').classList.contains('hidden'), true);
  api.adoptDocumentProvenance({ legacy });
  assert.equal(elements.get('#btnLegacyReview').classList.contains('hidden'), false);
});
await check('未验证历史稿引导先验证清洗，不启动审阅或调用模型', async () => {
  const { sandbox, api, elements } = harness();
  api.state.clean = clean('legacy-unverified'); api.state.legacy = legacy;
  let calls = 0;
  sandbox.fetch = async () => { calls += 1; throw new Error('Must not start review'); };
  sandbox.setStream(() => { calls += 1; throw new Error('Must not start stream'); });
  api.syncLegacyReviewButton();
  assert.equal(elements.get('#btnVerifyClean').disabled, false);
  await api.runReview();
  assert.equal(calls, 0); assert.match(elements.get('#toast').textContent, /先点击“验证清洗”/);
  assert.equal(elements.get('#btnLegacyReview').disabled, false);
});
await check('验证清洗采用确认后的工作字节、统计与来源，仍保留历史只读入口', async () => {
  const { sandbox, api, elements } = harness();
  api.state.clean = clean('legacy-unverified'); api.state.legacy = legacy; api.state.doc.stats.comments = 3;
  const verified = { ...clean(), commentsRemoved: 3, anchorsRemoved: 6, commentParts: 1 };
  const paths = []; let body;
  sandbox.fetch = async (url, opts) => {
    paths.push(url);
    if (url === '/api/clean-session') {
      body = JSON.parse(opts.body);
      return json({ doc: doc('A'), workVersion: { id: 'A-v1', revision: 1 }, history: { epoch: 1, canUndo: true }, clean: verified, legacy,
        result: null, applied: [], skipped: [], appliedFixes: [], appliedFixDetails: [] });
    }
    return fileBytes('A-v1');
  };
  await api.verifyLegacyClean();
  assert.deepEqual(paths, ['/api/clean-session', '/api/session-file?id=A']);
  assert.equal(body.baseVersionId, 'A-v0'); assert.equal(body.baseMutationEpoch, 0); assert.ok(body.operationId);
  assert.equal(api.state.clean, verified); assert.equal(api.state.doc.stats.comments, 0);
  assert.equal(api.state.doc.originalCommentCount, 12); assert.equal(api.state.workVersion.id, 'A-v1');
  assert.equal(elements.get('#btnVerifyClean').classList.contains('hidden'), true);
  assert.equal(elements.get('#btnLegacyReview').disabled, false);
  assert.equal(api.state.issues.length, 0); assert.equal(api.state.summary, null);
});
await check('unchanged 验证仅更新清洗事实，不伪造新工作版本', async () => {
  const { sandbox, api, elements } = harness(); api.state.clean = clean('legacy-unverified');
  sandbox.fetch = async (url) => url === '/api/clean-session' ? json({ doc: doc('A'), workVersion: { id: 'A-v0', revision: 0 }, history: { epoch: 1 },
    clean: { ...clean('unchanged'), commentsRemoved: 0, anchorsRemoved: 0, commentParts: 0 }, legacy, result: null,
    applied: [], skipped: [], appliedFixes: [], appliedFixDetails: [] }) : fileBytes('A-v0');
  await api.verifyLegacyClean();
  assert.equal(api.state.workVersion.id, 'A-v0'); assert.equal(api.state.workVersion.revision, 0);
  assert.equal(api.state.clean.status, 'unchanged'); assert.equal(elements.get('#btnVerifyClean').disabled, true);
});
await check('验证失败保留未验证稿和当前字节，不宣称验证已完成', async () => {
  const { sandbox, api, elements } = harness(); api.state.clean = clean('legacy-unverified');
  const oldDoc = api.state.doc; const oldBuffer = api.state.buffer; let calls = 0;
  sandbox.fetch = async () => { calls += 1; return json({ error: '清洗验证失败：部件损坏', clean: { status: 'failed', reason: '部件损坏' } }, false); };
  await api.verifyLegacyClean();
  assert.equal(calls, 1); assert.equal(api.state.doc, oldDoc); assert.equal(api.state.buffer, oldBuffer);
  assert.equal(api.state.clean.status, 'legacy-unverified'); assert.doesNotMatch(elements.get('#toast').textContent, /验证已完成/);
});
await check('验证清洗在审阅中禁用；缺 status 的旧服务不强造验证且保留旧审阅协议', async () => {
  const { sandbox, api, elements } = harness(); api.state.clean = clean('legacy-unverified'); api.state.streaming = true;
  api.syncLegacyReviewButton(); assert.equal(elements.get('#btnVerifyClean').disabled, true);
  let fetches = 0; sandbox.fetch = async () => { fetches += 1; throw new Error('Must not verify while busy'); };
  await api.verifyLegacyClean(); assert.equal(fetches, 0);
  api.state.streaming = false; api.state.clean = {};
  api.syncLegacyReviewButton(); assert.equal(elements.get('#btnVerifyClean').classList.contains('hidden'), true);
  let streams = 0;
  sandbox.setStream(async (_url, handlers) => { streams += 1; handlers.onDone({ issues: [], summary: { total: 0 } }); });
  await api.runReview(); assert.equal(streams, 1);
});
const legacyData = { legacy, captureHashes: { original: 'captured-source', work: 'captured-work' }, view: { issues: [{ ruleId: 'OLD', title: '旧问题', quote: '旧原文', suggestion: '旧建议', autoFix: { find: '旧', replace: '新' }, anchor: { index: 0 } }], summary: { total: 1 }, usage: { input_tokens: 123, output_tokens: 45 }, recheck: { stats: { checked: 1, noReply: 0 } }, modelErrors: [{ message: '旧窗口未完成' }] } };
await check('历史审阅读取只发一个只读 GET，保留当前正文和问题状态', async () => {
  const { sandbox, api, elements } = harness(); api.state.legacy = legacy;
  const currentDoc = api.state.doc; const currentIssues = api.state.issues; const currentVersion = api.state.workVersion;
  const calls = [];
  sandbox.fetch = async (url, opts) => { calls.push({ url, opts }); return json(legacyData); };
  await api.openLegacyReview();
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/legacy-review?id=A'); assert.equal(calls[0].opts, undefined);
  assert.equal(api.state.doc, currentDoc); assert.equal(api.state.issues, currentIssues); assert.equal(api.state.workVersion, currentVersion);
  const body = elements.get('#auditBody').innerHTML;
  assert.match(body, /历史审阅记录/); assert.match(body, /旧原文/); assert.match(body, /旧建议/); assert.match(body, /输入 123 \/ 输出 45/);
  assert.match(body, /当前稿需要显式重新审阅/);
  assert.doesNotMatch(body, /data-fix-key|issue-fix|data-hit-keys|<button/);
});
await check('历史来源 mismatch/unknown 明确显示，不把保存核对当人工审阅结论', () => {
  const { api } = harness();
  const mismatched = api.renderLegacyReview({ ...legacyData, legacy: { ...legacy, consistency: 'mismatch', reason: '工作字节与旧审阅基准不同' } }, 'L');
  assert.match(mismatched, /历史来源内容不一致/); assert.match(mismatched, /工作字节与旧审阅基准不同/);
  const unknown = api.renderLegacyReview({ ...legacyData, view: { issues: [] } }, 'L');
  assert.match(unknown, /历史来源内容未验证/); assert.match(unknown, /历史未记录 Token 用量/);
  assert.doesNotMatch(unknown, /输入 0/);
});
await check('已有当前审阅结果时，历史面板不误引导再次付费重审', () => {
  const { api } = harness(); api.state.summary = { total: 1 };
  const body = api.renderLegacyReview(legacyData, 'L');
  assert.match(body, /当前稿已有本轮审阅结果/); assert.doesNotMatch(body, /当前稿需要显式重新审阅/);
});
await check('旧历史读取响应切稿后不覆盖新工作区或重新打开弹窗', async () => {
  const { sandbox, api, elements } = harness(); api.state.legacy = legacy;
  const pending = deferred(); sandbox.fetch = async () => ({ ok: true, json: () => pending.promise });
  const reading = api.openLegacyReview(); const loading = elements.get('#auditBody').innerHTML;
  api.state.sessionId = 'B'; api.state.activationSerial += 1; api.resetHumanState();
  pending.resolve(legacyData); await reading;
  assert.equal(elements.get('#auditBody').innerHTML, loading);
  assert.equal(elements.get('#auditModal').classList.contains('hidden'), true);
});
await check('历史内容按文本转义，不能把引用变成可执行界面或修改按钮', () => {
  const { api } = harness();
  const body = api.renderLegacyReview({ legacy, view: { issues: [{ title: '<script>bad</script>', quote: '<button>apply</button>', suggestion: '<img onerror=bad>' }] } }, 'L');
  assert.match(body, /&lt;script&gt;/); assert.match(body, /&lt;button&gt;/); assert.doesNotMatch(body, /<script>|<button>|<img/);
});
console.log(`清洗状态/历史审阅前端回归通过：${passed} 项（未调用真实模型）`);
