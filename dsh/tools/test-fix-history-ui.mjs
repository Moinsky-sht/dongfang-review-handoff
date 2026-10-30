/** 撤销/重做前端回归。读取真实界面代码，以本地响应替身验证，无模型调用。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
assert.match(html, /id="btnUndoFixes"/);
assert.match(html, /id="btnRedoFixes"/);
assert.match(html, /撤销上一次保存/);
assert.match(html, /重做上一次撤销/);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const key = 'FMT|paragraph:0|a';
const version = (revision) => ({ id: `A-v${revision}`, revision, sha256: `sha-${revision}` });
const history = (cursor, epoch = cursor, total = 1) => ({ canUndo: cursor > 0, canRedo: cursor < total, cursor, total, epoch });
const documentAt = (cursor) => ({ meta: { title: '稿件甲' }, paragraphs: [{ text: cursor ? 'aa' : 'a' }], footnotes: [] });
const issueAt = (cursor) => ({ issueKey: key, ruleId: 'FMT', location: 'paragraph:0', quote: 'a',
  title: '修改示例', group: 'format', severity: '中', autoFix: { find: 'a', replace: 'aa', offset: cursor },
  anchor: { target: 'paragraph', index: 0, start: cursor, end: cursor + 1, text: 'a', resolutionStatus: 'resolved' } });
const patch = { key, target: 'body', index: 0, find: 'a', replace: 'aa' };
const responseAt = (cursor, epoch) => ({ reviewRunId: 'run-A', doc: documentAt(cursor), workVersion: version(cursor), history: history(cursor, epoch),
  result: { reviewRunId: 'run-A', issues: [issueAt(cursor)], anchorStats: { issues: 1, exact: 1 }, summary: { total: 1 } },
  appliedFixes: cursor ? [key] : [], appliedFixDetails: cursor ? [patch] : [], applied: [], skipped: [] });
const jsonResponse = (value, ok = true) => ({ ok, status: ok ? 200 : 409, json: async () => value });
const bytesResponse = (cursor, versionId = version(cursor).id) => ({ ok: true,
  headers: { get: (name) => name.toLowerCase() === 'x-work-version' ? versionId : null },
  arrayBuffer: async () => new Uint8Array([cursor]).buffer });

function harness() {
  const elements = new Map();
  const makeElement = () => ({ classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    textContent: '', innerHTML: '', disabled: false, childNodes: [], dataset: {}, style: {},
    querySelector: () => null, querySelectorAll: () => [], replaceChildren(...children) { this.childNodes = children; } });
  const sandbox = {
    document: { querySelector: (id) => { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
      querySelectorAll: () => [], addEventListener() {}, createElement: makeElement },
    window: { matchMedia: () => ({ matches: false }) }, fetch: () => { throw new Error('Unexpected fetch'); },
    URLSearchParams, location: { search: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  };
  const noops = ['renderDocInfo', 'renderMarkupIssues', 'renderMarkupStats', 'highlightIssuesInDoc', 'markHeadingLevels',
    'wireCitations', 'updateApplyBtn', 'clearMarks', 'indexRenderedParagraphs', 'markTitleParagraph',
    'normalizeReaderFormatting', 'renderFigures', 'reapplyHumanMarks', 'initHeadingSpy', 'renderQueue',
    'setProgress', 'switchView', 'finishReview'];
  runInNewContext(source + `\n
    globalThis.realRender = renderDocument;
    ${noops.map((name) => `${name} = () => {};`).join('\n')}
    globalThis.renderSnapshots = [];
    renderDocument = async () => { renderSnapshots.push({ version: state.workVersion, buffer: state.buffer }); };
    globalThis.api = { state, syncHistoryControls, postFixHistory, postApplyFixes, adoptWorkResponse,
      restoreSession, activateItem, resumeReview, renderDocument: realRender, applyFixRequests };
  `, sandbox, { filename: 'public/app.js' });
  const { state } = sandbox.api;
  Object.assign(state, { sessionId: 'A', reviewRunId: 'run-A', doc: documentAt(1), buffer: new Uint8Array([1]).buffer,
    workVersion: version(1), history: history(1), issues: [issueAt(1)], summary: { total: 1 },
    resolved: new Set([key]), appliedFixDetails: [patch], queue: [], showOriginal: false, streaming: false });
  sandbox.api.syncHistoryControls();
  return { sandbox, api: sandbox.api, elements };
}
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`✓ ${name}`); }

await check('撤销恢复原稿并清除已修复状态，重做恢复对应保存版本', async () => {
  const { sandbox, api, elements } = harness();
  const requests = [];
  let cursor = 1;
  let epoch = 1;
  sandbox.fetch = async (url, options) => {
    if (url === '/api/session-file?id=A') return bytesResponse(cursor);
    requests.push({ url, body: JSON.parse(options.body) });
    cursor = url === '/api/undo-fixes' ? 0 : 1;
    epoch += 1;
    return jsonResponse(responseAt(cursor, epoch));
  };
  await api.postFixHistory('undo');
  assert.equal(api.state.doc.paragraphs[0].text, 'a');
  assert.equal(api.state.resolved.size, 0);
  assert.equal(api.state.appliedFixDetails.length, 0);
  assert.equal(new Uint8Array(api.state.buffer)[0], 0);
  assert.equal(api.state.history.cursor, 0);
  assert.equal(elements.get('#btnUndoFixes').disabled, true);
  assert.equal(elements.get('#btnRedoFixes').disabled, false);
  assert.match(elements.get('#workVersionLabel').textContent, /版本 0/);
  await api.postFixHistory('redo');
  assert.equal(api.state.doc.paragraphs[0].text, 'aa');
  assert.ok(api.state.resolved.has(key));
  assert.equal(api.state.appliedFixDetails.length, 1);
  assert.equal(new Uint8Array(api.state.buffer)[0], 1);
  assert.equal(elements.get('#btnUndoFixes').disabled, false);
  assert.equal(elements.get('#btnRedoFixes').disabled, true);
  assert.equal(requests[0].body.id, 'A');
  assert.equal(requests[0].body.baseVersionId, 'A-v1');
  assert.equal(requests[0].body.baseMutationEpoch, 1);
  assert.equal(requests[1].body.baseVersionId, 'A-v0');
  assert.equal(requests[1].body.baseMutationEpoch, 2);
  assert.ok(requests[0].body.operationId);
  assert.notEqual(requests[0].body.operationId, requests[1].body.operationId);
});

await check('历史与版本更新经过公共采纳路径并同步到队列', async () => {
  const { sandbox, api } = harness();
  api.state.queue = [{ id: 'A', history: history(1), result: { issues: [issueAt(1)] } }];
  const restored = responseAt(0, 2);
  sandbox.fetch = async (url) => url === '/api/undo-fixes' ? jsonResponse(restored) : bytesResponse(0);
  await api.postFixHistory('undo');
  assert.equal(api.state.queue[0].doc, restored.doc);
  assert.equal(api.state.queue[0].result, restored.result);
  assert.equal(api.state.queue[0].history, restored.history);
  assert.equal(api.state.queue[0].workVersion, restored.workVersion);
  assert.equal(api.state.queue[0].appliedFixes.length, 0);
});

await check('普通保存也发送操作号与 epoch，并采纳新历史能力', async () => {
  const { sandbox, api, elements } = harness();
  const initialHistory = { canUndo: false, canRedo: false, cursor: 0, total: 0, epoch: 0 };
  Object.assign(api.state, { workVersion: version(0), history: initialHistory, resolved: new Set(), appliedFixDetails: [] });
  let request;
  sandbox.fetch = async (url, options) => {
    if (url === '/api/session-file?id=A') return bytesResponse(1);
    request = JSON.parse(options.body);
    return jsonResponse({ ...responseAt(1, 1), applied: [patch] });
  };
  await api.postApplyFixes([key]);
  assert.equal(request.baseVersionId, 'A-v0');
  assert.equal(request.baseMutationEpoch, 0);
  assert.equal(request.baseReviewRunId, 'run-A', '普通保存必须使用选择问题时的已完成运行');
  assert.ok(request.operationId);
  assert.equal(api.state.history.epoch, 1);
  assert.equal(elements.get('#btnUndoFixes').disabled, false);
});

await check('缺少审阅运行时普通保存不发请求且保留当前字节', async () => {
  const { sandbox, api, elements } = harness();
  api.state.reviewRunId = null;
  api.state.resolved.clear();
  const beforeDoc = api.state.doc, beforeBuffer = api.state.buffer, beforeVersion = api.state.workVersion;
  let calls = 0;
  sandbox.fetch = async () => { calls += 1; throw new Error('Missing run must not submit'); };
  await api.postApplyFixes([key]);
  assert.equal(calls, 0);
  assert.equal(api.state.doc, beforeDoc);
  assert.equal(api.state.buffer, beforeBuffer);
  assert.equal(api.state.workVersion, beforeVersion);
  assert.match(elements.get('#toast').textContent, /当前审阅记录/);
});

await check('同稿保存锁禁止双击撤销及并行修改，完成后按历史启用按钮', async () => {
  const { sandbox, api, elements } = harness();
  const body = deferred();
  let mutations = 0;
  sandbox.fetch = async (url) => {
    if (url === '/api/session-file?id=A') return bytesResponse(0);
    mutations += 1;
    return { ok: true, json: () => body.promise };
  };
  const pending = api.postFixHistory('undo');
  assert.equal(elements.get('#btnUndoFixes').disabled, true);
  assert.equal(elements.get('#btnRedoFixes').disabled, true);
  await api.postFixHistory('undo');
  await api.postApplyFixes([key]);
  body.resolve(responseAt(0, 2));
  await pending;
  await api.postFixHistory('undo');
  assert.equal(mutations, 1);
  assert.equal(api.state.history.cursor, 0);
  assert.equal(elements.get('#btnRedoFixes').disabled, false);
});

await check('网络响应丢失重试沿用同操作号，不重复撤销', async () => {
  const { sandbox, api } = harness();
  const bodies = [];
  const stored = new Map();
  let serverUndoCount = 0;
  sandbox.fetch = async (url, options) => {
    if (url === '/api/session-file?id=A') return bytesResponse(0);
    const request = JSON.parse(options.body);
    bodies.push(request);
    if (stored.has(request.operationId)) return jsonResponse(stored.get(request.operationId));
    serverUndoCount += 1;
    stored.set(request.operationId, responseAt(0, 2));
    throw new Error('Response lost after server saved');
  };
  await api.postFixHistory('undo');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].operationId, bodies[1].operationId);
  assert.equal(bodies[0].baseVersionId, bodies[1].baseVersionId);
  assert.equal(bodies[0].baseMutationEpoch, bodies[1].baseMutationEpoch);
  assert.equal(serverUndoCount, 1);
  assert.equal(api.state.history.cursor, 0);
});

await check('两个标签的旧基础版本返回 409，不挂载错误历史或字节', async () => {
  const first = harness();
  const second = harness();
  let current = version(1).id;
  let currentEpoch = 1;
  let conflict = 0;
  let byteLoads = 0;
  const server = async (url, options) => {
    if (url === '/api/session-file?id=A') { byteLoads += 1; return bytesResponse(0); }
    const body = JSON.parse(options.body);
    if (body.baseVersionId !== current || body.baseMutationEpoch !== currentEpoch) {
      conflict += 1;
      return jsonResponse({ error: '工作版本已改变，请重新加载' }, false);
    }
    current = 'A-v0'; currentEpoch = 2;
    return jsonResponse(responseAt(0, 2));
  };
  first.sandbox.fetch = server;
  second.sandbox.fetch = server;
  const secondDoc = second.api.state.doc;
  const secondBytes = second.api.state.buffer;
  await first.api.postFixHistory('undo');
  await second.api.postFixHistory('undo');
  assert.equal(conflict, 1);
  assert.equal(byteLoads, 1);
  assert.equal(second.api.state.doc, secondDoc);
  assert.equal(second.api.state.buffer, secondBytes);
  assert.ok(second.api.state.resolved.has(key));
  assert.equal(second.api.state.history.cursor, 1);
  assert.match(second.elements.get('#toast').textContent, /工作版本已改变/);
});

await check('撤销后重做回到同版本 ID，旧标签仍因 epoch 不同遭 409', async () => {
  const { sandbox, api } = harness();
  let posts = 0;
  const oldDoc = api.state.doc;
  sandbox.fetch = async (_url, options) => {
    posts += 1;
    const body = JSON.parse(options.body);
    assert.equal(body.baseVersionId, 'A-v1');
    assert.equal(body.baseMutationEpoch, 1);
    return jsonResponse({ error: '修改历史已变化（当前版本相同但操作记录不同）' }, false);
  };
  await api.postFixHistory('undo');
  assert.equal(posts, 1, 'HTTP 409 不自动重试');
  assert.equal(api.state.doc, oldDoc);
  assert.equal(api.state.history.epoch, 1);
});

await check('撤销响应晚到只更新原稿队列，不覆盖新稿工作区', async () => {
  const { sandbox, api } = harness();
  const body = deferred();
  const restored = responseAt(0, 2);
  api.state.queue = [{ id: 'A', history: history(1) }];
  sandbox.fetch = async () => ({ ok: true, json: () => body.promise });
  const pending = api.postFixHistory('undo');
  const otherDoc = { paragraphs: [{ text: '稿件乙' }] };
  const otherHistory = { canUndo: false, canRedo: false, cursor: 0, total: 0, epoch: 0 };
  Object.assign(api.state, { sessionId: 'B', doc: otherDoc, workVersion: { id: 'B-v0' }, history: otherHistory });
  body.resolve(restored);
  await pending;
  assert.equal(api.state.doc, otherDoc);
  assert.equal(api.state.history, otherHistory);
  assert.equal(api.state.workVersion.id, 'B-v0');
  assert.equal(api.state.queue[0].history, restored.history);
  assert.equal(api.state.queue[0].result, restored.result);
});

await check('历史字节下载晚到不覆盖切换后的稿件', async () => {
  const { sandbox, api } = harness();
  const bytes = deferred();
  const requested = deferred();
  sandbox.fetch = async (url) => url === '/api/undo-fixes' ? jsonResponse(responseAt(0, 2))
    : { ...bytesResponse(0), arrayBuffer: () => { requested.resolve(); return bytes.promise; } };
  const pending = api.postFixHistory('undo');
  await requested.promise;
  const otherBytes = new Uint8Array([9]).buffer;
  const otherHistory = { canUndo: true, canRedo: false, cursor: 4, total: 4, epoch: 8 };
  Object.assign(api.state, { sessionId: 'B', buffer: otherBytes, workVersion: { id: 'B-v4' }, history: otherHistory });
  bytes.resolve(new Uint8Array([0]).buffer);
  await pending;
  assert.equal(api.state.buffer, otherBytes);
  assert.equal(api.state.history, otherHistory);
  assert.equal(api.state.workVersion.id, 'B-v4');
});

await check('撤销已保存但预览失败时清除旧稿，保留权威历史', async () => {
  const { sandbox, api, elements } = harness();
  api.state.showOriginal = true;
  api.state.originalBuffer = new Uint8Array([77]).buffer;
  sandbox.fetch = async (url) => url === '/api/undo-fixes' ? jsonResponse(responseAt(0, 2)) : { ok: false };
  await api.postFixHistory('undo');
  assert.equal(api.state.buffer, null);
  assert.equal(api.state.showOriginal, false);
  assert.equal(api.state.workVersion.id, 'A-v0');
  assert.equal(api.state.history.cursor, 0);
  assert.equal(api.state.resolved.size, 0);
  assert.match(elements.get('#docHost').innerHTML, /撤销已完成.*预览获取失败/);
  assert.match(elements.get('#workVersionLabel').textContent, /版本 0/);
});

await check('历史字节的版本头不符时不显示其他标签的新字节', async () => {
  const { sandbox, api, elements } = harness();
  sandbox.fetch = async (url) => url === '/api/undo-fixes' ? jsonResponse(responseAt(0, 2)) : bytesResponse(1, 'A-v1');
  await api.postFixHistory('undo');
  assert.equal(api.state.buffer, null);
  assert.equal(api.state.workVersion.id, 'A-v0');
  assert.match(elements.get('#docHost').innerHTML, /预览获取失败/);
});

await check('缺少 history 的旧服务默认禁用撤销和重做', async () => {
  const { sandbox, api, elements } = harness();
  api.state.history = null;
  api.syncHistoryControls();
  assert.equal(elements.get('#btnUndoFixes').disabled, true);
  assert.equal(elements.get('#btnRedoFixes').disabled, true);
  let calls = 0;
  sandbox.fetch = async () => { calls += 1; throw new Error('Unsupported'); };
  await api.postFixHistory('undo');
  await api.postFixHistory('redo');
  assert.equal(calls, 0);
});

await check('缺少历史幂等协议的旧服务保存失败时不自动重复写入', async () => {
  const { sandbox, api } = harness();
  api.state.history = null;
  api.state.resolved.clear();
  let calls = 0;
  sandbox.fetch = async () => { calls += 1; throw new Error('Legacy response lost'); };
  await api.postApplyFixes([key]);
  assert.equal(calls, 1);
});

await check('审阅运行和批量运行期间禁止历史修改', async () => {
  const { sandbox, api, elements } = harness();
  let calls = 0;
  sandbox.fetch = async () => { calls += 1; throw new Error('Must not mutate while reviewing'); };
  api.state.streaming = true;
  api.syncHistoryControls();
  assert.equal(elements.get('#btnUndoFixes').disabled, true);
  await api.postFixHistory('undo');
  api.state.streaming = false; api.state.queueRunning = true;
  api.syncHistoryControls();
  assert.equal(elements.get('#btnUndoFixes').disabled, true);
  await api.postFixHistory('undo');
  assert.equal(calls, 0);
});

await check('恢复会话贯通历史，切稿采用所属稿件的历史和版本', async () => {
  const { sandbox, api, elements } = harness();
  const restored = responseAt(0, 2);
  Object.assign(api.state, { sessionId: null, buffer: null, history: null });
  sandbox.localStorage.getItem = () => 'A';
  sandbox.fetch = async (url) => url.startsWith('/api/session-file') ? bytesResponse(0)
    : jsonResponse({ exists: true, id: 'A', ...restored });
  await api.restoreSession();
  assert.equal(api.state.history, restored.history);
  assert.equal(elements.get('#btnRedoFixes').disabled, false);
  const otherHistory = { canUndo: true, canRedo: false, cursor: 3, total: 3, epoch: 5 };
  sandbox.fetch = async (url) => url.startsWith('/api/session-file') ? bytesResponse(0, 'B-v3')
    : jsonResponse({ exists: true, doc: { paragraphs: [] }, workVersion: { id: 'B-v3', revision: 3 }, history: otherHistory, result: null });
  await api.activateItem({ id: 'B', name: '稿件乙.docx', doc: { paragraphs: [] }, workVersion: { id: 'B-v0', revision: 0 }, history: history(0, 0) });
  assert.equal(api.state.history, otherHistory);
  assert.equal(api.state.workVersion.id, 'B-v3');
  assert.equal(elements.get('#btnUndoFixes').disabled, false);
  assert.equal(elements.get('#btnRedoFixes').disabled, true);
});

await check('恢复版本没有有效审阅记录时清空旧问题及导出状态', async () => {
  const { sandbox, api, elements } = harness();
  api.state.queue = [{ id: 'A', result: { issues: [issueAt(1)] }, status: '完成 1 条' }];
  api.state.activeIssueKey = key;
  const restored = { ...responseAt(0, 2), reviewRunId: null, result: null };
  sandbox.fetch = async (url) => url === '/api/undo-fixes' ? jsonResponse(restored) : bytesResponse(0);
  await api.postFixHistory('undo');
  assert.equal(api.state.issues.length, 0);
  assert.equal(api.state.summary, null);
  assert.equal(api.state.anchorStats, null);
  assert.equal(api.state.activeIssueKey, null);
  assert.equal(elements.get('#btnReport').disabled, true);
  assert.equal(elements.get('#btnDocx').disabled, true);
  assert.equal(api.state.queue[0].result, null);
  assert.equal(api.state.queue[0].status, '待重新审阅');
});

await check('切稿加载失败时不会保留上一稿的正文画面', async () => {
  const { api, elements } = harness();
  elements.set('#docHost', { innerHTML: '上一稿正文', querySelector: () => null });
  Object.assign(api.state, { sessionId: 'B', buffer: null });
  await api.renderDocument(true);
  assert.doesNotMatch(elements.get('#docHost').innerHTML, /上一稿正文/);
  assert.match(elements.get('#docHost').innerHTML, /当前稿预览尚未载入/);
});

console.log(`撤销/重做前端回归通过：${passed} 项（未调用真实模型）`);
