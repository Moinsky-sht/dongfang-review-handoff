/** 工作台/人工记录前端回归。全部请求均为本地响应替身，不调用模型或浏览器。 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const sourcePath = resolve(ROOT, flag('source') || 'public/app.js');
const outputPath = flag('out') ? resolve(ROOT, flag('out')) : null;
if (outputPath && existsSync(outputPath)) throw new Error('Evidence exists; choose a fresh --out');
const source = readFileSync(sourcePath, 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const checks = [];
const startedAt = new Date().toISOString();
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function until(predicate, message) { const deadline = Date.now() + 5000; while (!predicate() && Date.now() < deadline) await delay(5); assert(predicate(), message); }
const key = 'stable-issue';
const version = (id = 'A-v0') => ({ id, revision: 0, sha256: id });
const human = (revision = 0, decisions = {}, marks = [], runId = 'r1', workVersionId = 'A-v0') => ({ revision, decisions, marks, reviewRunId: runId, workVersionId });
const result = (id = 'A') => ({ issues: [{ issueKey: key, ruleId: 'FMT', group: 'format', severity: '中', location: 'paragraph:0', quote: '重复', title: '示例' }],
  summary: { total: 1 }, anchorStats: { issues: 1 }, reviewRunId: 'r1', human: human(0, {}, [], 'r1', `${id}-v0`) });
const session = (id = 'A') => ({ exists: true, id, name: `${id}.docx`, doc: { paragraphs: [{ text: '前 重复 后 重复 末' }], footnotes: [], endnotes: [], meta: {} },
  workVersion: version(`${id}-v0`), history: { epoch: 0 }, reviewRunId: 'r1', human: human(0, {}, [], 'r1', `${id}-v0`), result: result(id), running: false });
const workspace = (entries = [{ entryId: 'eA', id: 'A', name: 'A.docx', status: 'ready', workVersion: version(), hasResult: true }], revision = 1) => ({ id: 'test', revision, entries,
  activeSessionId: entries.find((entry) => entry.id)?.id || null, queue: { state: 'paused', cursorSessionId: null, options: {} } });
const response = (value, ok = true, status = ok ? 200 : 409) => ({ ok, status, json: async () => value });
const bytes = (id = 'A-v0') => ({ ok: true, headers: { get: () => id }, arrayBuffer: async () => new Uint8Array([1]).buffer });
function harness() {
  const elements = new Map();
  const stored = new Map();
  const inserted = [];
  const makeElement = () => {
    const classes = new Set();
    return { dataset: {}, style: {}, childNodes: [], innerHTML: '', textContent: '', value: '', checked: false, disabled: false, events: new Map(),
      classList: { add(...names) { names.forEach((name) => classes.add(name)); }, remove(...names) { names.forEach((name) => classes.delete(name)); },
        toggle(name, force) { const enabled = force === undefined ? !classes.has(name) : force; if (enabled) classes.add(name); else classes.delete(name); return enabled; },
        contains: (name) => classes.has(name) }, querySelector: () => null, querySelectorAll: () => [],
      replaceChildren(...children) { this.childNodes = children; }, appendChild() {}, addEventListener(name, fn) { this.events.set(name, fn); }, focus() {}, contains: () => true };
  };
  const sandbox = { crypto: webcrypto, TextEncoder, window: { crypto: webcrypto, matchMedia: () => ({ matches: false }) }, location: { search: '?workspace=test' }, URLSearchParams, NodeFilter: { SHOW_TEXT: 4 },
    document: { querySelector: (id) => { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
      querySelectorAll: () => [], createElement: makeElement, addEventListener() {},
      createTreeWalker: (p) => { let done = false; return { currentNode: p.node, nextNode() { if (done) return false; done = true; return true; } }; },
      createRange: () => ({ start: 0, end: 0, selectNodeContents(p) { this.p = p; },
        setStart(node, offset) { this.node = node; this.start = offset; }, setEnd(node, offset) { this.node = node; this.end = offset; },
        toString() { return (this.p?.textContent || this.node?.textContent || '').slice(this.start, this.end); },
        extractContents: () => ({}), insertNode(span) { inserted.push({ start: this.start, end: this.end, span }); } }) },
    localStorage: { getItem: (name) => stored.get(name) || null, setItem: (name, value) => stored.set(name, value), removeItem: (name) => stored.delete(name) },
    fetch: () => { throw new Error('Unexpected fetch'); }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} };
  const noops = ['renderDocInfo', 'renderMarkupIssues', 'renderMarkupStats', 'highlightIssuesInDoc', 'markHeadingLevels', 'wireCitations', 'updateApplyBtn',
    'clearMarks', 'indexRenderedParagraphs', 'markTitleParagraph', 'normalizeReaderFormatting', 'renderFigures', 'initHeadingSpy', 'setProgress', 'setProgressBar', 'hideProgressBar', 'switchView', 'renderRecheck'];
  runInNewContext(source + `\n globalThis.realRenderRecheck = renderRecheck;\n${noops.map((name) => `${name} = () => {};`).join('\n')}
    renderDocument = async () => {};
    openHumanPop = () => {};
    globalThis.api = { state, restoreWorkspace, restoreSession, refreshWorkspace, updateWorkspace, adoptWorkspace, registerUploadedSession, retryRegistration,
      importFile, importFiles, recordUploadFailure: typeof recordUploadFailure === 'function' ? recordUploadFailure : undefined,
      activateItem, reviewQueue, retryQueueItem, pauseReviewQueue, reviewOptionsSnapshot, runReview, resetHumanState, adoptHumanContext, humanContext,
      saveHumanRecord, saveHumanMark, onDocMouseUp, reapplyHumanMarks, wrapTextInParagraph, humanNodeForParagraph, adoptWorkResponse,
      pending: () => pendingInfo, renderQueue, renderRecheck: realRenderRecheck,
      // Explicit physical-source fixture for the selection workflow; renderer/XML
      // creation is separately tested by test-reader-xml-identity/endnote-reader.
      bindSoftwareParagraph(p) {
        const node=state.doc.paragraphs[0], hash=${JSON.stringify(sha256(new Uint8Array([1])))};
        Object.assign(node,{id:'document.xml:0',index:0,part:'document.xml',textView:'after',offsetUnit:'utf16',paragraphIndexOwner:'application-paragraph-index',sourceXmlParagraphOrdinal:2,sourceXmlNodeId:'document.xml:xml-p:2',sourcePackageSha256:hash});
        state.doc.sourcePackageSha256=hash;state.workVersion.sha256=hash;
        const binding={sessionId:state.sessionId,versionId:state.workVersion.id,activationSerial:state.activationSerial,workspaceId:state.workspaceId,
          original:false,doc:state.doc,expectedPackageSha256:hash,versionPackageSha256:hash,packageSha256:hash,sourceProven:true,
          source:{part:node.part,sourceXmlParagraphOrdinal:node.sourceXmlParagraphOrdinal,sourceXmlNodeId:node.sourceXmlNodeId},
          sourceIndex:new Map([[node.sourceXmlNodeId,[{target:'paragraph',node,index:0}]]])};
        readerNodeBindings.set(p,binding);
      } };
    globalThis.setStream = (fn) => { consumeStream = fn; };
  `, sandbox, { filename: 'public/app.js' });
  const { state } = sandbox.api;
  Object.assign(state, { sessionId: 'A', workspaceId: 'test', workspaceSupported: true, ingestionSupported: false, queueSupported: false, workspace: workspace(), doc: session().doc,
    workVersion: version(), history: { epoch: 0 }, reviewRunId: 'r1', humanVersionId: 'A-v0', humanRevision: 0,
    streaming: false, queue: [], issues: result().issues, buffer: new Uint8Array([1]).buffer });
  return { sandbox, api: sandbox.api, elements, stored, inserted };
}
let passed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; checks.push({ name, ok: true }); console.log(`✓ ${name}`); }
  catch (error) { checks.push({ name, ok: false, error: { message: error.message, stack: error.stack } }); console.log(`✗ ${name}: ${error.message}`); }
}

await check('刷新恢复全部队列和当前权威稿件，不调用模型或自动继续', async () => {
  const { sandbox, api } = harness();
  const entries = ['ready', 'partial', 'failed', 'interrupted', 'complete', 'upload-failed'].map((status, i) => ({ entryId: `e${i}`, id: i === 5 ? undefined : i ? `S${i}` : 'A', name: `稿件${i}`, status }));
  let streams = 0;
  sandbox.setStream(() => { streams += 1; });
  sandbox.fetch = async (url) => url.startsWith('/api/workspace') ? response({ workspace: workspace(entries) })
    : url.startsWith('/api/session-file') ? bytes() : response(session());
  assert.equal(await api.restoreWorkspace(), true);
  assert.equal(api.state.queue.length, 6);
  assert.equal(api.state.queue[1].status, 'partial');
  assert.equal(api.state.sessionId, 'A');
  assert.equal(api.state.reviewRunId, 'r1');
  assert.equal(api.state.queueRunning, false);
  assert.equal(streams, 0);
});
await check('工作台 500/网络错误保留恢复失败提示，禁止创建或更新缺损台', async () => {
  for (const failure of ['500', 'network']) {
    const { sandbox, api, elements } = harness();
    let writes = 0;
    sandbox.fetch = async (_url, options) => {
      if (options) writes += 1;
      if (failure === 'network') throw new Error('fixture');
      return response({ error: 'WORKSPACE_MISSING' }, false, 500);
    };
    assert.equal(await api.refreshWorkspace(), false);
    assert.equal(api.state.workspaceSupported, true);
    assert.ok(api.state.workspaceError);
    assert.match(elements.get('#queueList').innerHTML, /工作台恢复失败/);
    assert.match(elements.get('#queueList').innerHTML, /重试恢复工作台/);
    assert.equal(await api.updateWorkspace({ action: 'attach', sessionId: 'B' }), false);
    assert.equal(writes, 0);
  }
});
await check('只有 404 才退回不支持工作台的旧服务路径', async () => {
  const { sandbox, api } = harness();
  sandbox.fetch = async () => ({ ok: false, status: 404, json: () => { throw new Error('HTML 404'); } });
  assert.equal(await api.refreshWorkspace(), false);
  assert.equal(api.state.workspaceSupported, false);
  assert.equal(api.state.workspaceError, null);
});
await check('URL 指定稿件优先于工作台当前稿', async () => {
  const { sandbox, api } = harness();
  sandbox.location.search = '?workspace=test&session=B';
  sandbox.fetch = async (url) => url.startsWith('/api/workspace') ? response({ workspace: workspace([{ id: 'A', status: 'ready' }, { id: 'B', status: 'ready' }]) })
    : url.startsWith('/api/session-file') ? bytes('B-v0') : response(session('B'));
  await api.restoreWorkspace();
  assert.equal(api.state.sessionId, 'B');
  assert.equal(api.state.workVersion.id, 'B-v0');
});
await check('服务事实覆盖旧结果缓存，partial 与失败不能显示完整完成', () => {
  const { api, elements } = harness();
  api.state.queue = [{ id: 'A', workVersion: version(), result: result(), status: 'complete' }];
  api.adoptWorkspace(workspace([{ id: 'A', name: 'A', status: 'failed', hasResult: false, workVersion: version() }, { id: 'B', name: 'B', status: 'partial' }]));
  assert.equal(api.state.queue[0].result, null);
  assert.match(elements.get('#queueList').innerHTML, /审阅失败/);
  assert.match(elements.get('#queueList').innerHTML, /部分完成，请查看未完成项/);
  assert.match(elements.get('#queueList').innerHTML, /重审整份/);
});
await check('同名稿件队列显示导入版本与当前版本号，不暴露技术标识', () => {
  const { api, elements } = harness();
  api.adoptWorkspace(workspace([
    { id: 'private-alpha', name: '同名稿件.docx', status: 'complete', workVersion: { id: 'internal-v3', revision: 3 } },
    { id: 'private-beta', name: '同名稿件.docx', status: 'ready', workVersion: { id: 'internal-v0', revision: 0 } },
  ]));
  const html = elements.get('#queueList').innerHTML;
  assert.match(html, /工作版本 3/); assert.match(html, /导入版本/);
  assert.doesNotMatch(html, /private-alpha|private-beta|internal-v3|internal-v0/);
});
await check('工作台 CAS 冲突先采用最新事实，再登记稿件', async () => {
  const { sandbox, api } = harness();
  const revisions = [];
  sandbox.fetch = async (_url, opts) => {
    revisions.push(JSON.parse(opts.body).expectedRevision);
    return revisions.length === 1 ? response({ workspace: workspace([], 2) }, false)
      : response({ workspace: workspace([{ id: 'A', name: 'A', status: 'ready' }], 3) });
  };
  assert.equal(await api.updateWorkspace({ action: 'attach', sessionId: 'A' }), true);
  assert.deepEqual(revisions, [1, 2]);
  assert.equal(api.state.workspace.revision, 3);
});
await check('登记失败明确保留 session，刷新显示待登记并可重试', async () => {
  const { sandbox, api, stored, elements } = harness();
  sandbox.fetch = async () => response({ error: 'store write failed' }, false, 500);
  assert.equal(await api.registerUploadedSession(session(), 'A.docx'), false);
  assert.equal(api.state.queue[0].status, 'unregistered');
  assert.equal(api.state.queue[0].queueUnsaved, true);
  assert.match(stored.get('dsh.pendingRegistrations:test'), /"id":"A"/);
  assert.match(elements.get('#queueList').innerHTML, /重试登记/);
  sandbox.fetch = async () => response({ workspace: workspace([{ id: 'A', name: 'A.docx', status: 'ready', workVersion: version() }], 2) });
  await api.retryRegistration('A');
  assert.equal(api.state.queue[0].queueUnsaved, false);
  assert.equal(JSON.parse(stored.get('dsh.pendingRegistrations:test')).length, 0);
});
await check('显式 partial 重试带 force=1，重新审阅整份', async () => {
  const { sandbox, api } = harness();
  api.state.queue = [{ id: 'A', status: 'partial', workVersion: version() }];
  let streams = 0;
  sandbox.fetch = async (url) => url.startsWith('/api/workspace') ? response({ workspace: workspace() })
    : url.startsWith('/api/session-file') ? bytes() : response(session());
  sandbox.setStream(async (url, handlers) => { streams += 1; assert.match(url, /force=1/); handlers.onDone(result()); });
  await api.retryQueueItem('A');
  assert.equal(streams, 1);
});
await check('关闭模型时默认勾选的自证不会请求模型复核或上下文调用', async () => {
  const { sandbox, api } = harness();
  sandbox.document.querySelector('#useModel').checked = false;
  for (const id of ['#selfVerify', '#useContext', '#useCases']) sandbox.document.querySelector(id).checked = true;
  const options = api.reviewOptionsSnapshot();
  assert.equal(options.useModel, false); assert.equal(options.useRecheck, false);
  assert.equal(options.useContext, false); assert.equal(options.useCases, false);
  sandbox.setStream(async (url, handlers) => {
    const params = new URLSearchParams(url.split('?')[1]);
    assert.equal(params.get('useModel'), 'false'); assert.equal(params.get('useRecheck'), 'false');
    assert.equal(params.get('useContext'), 'false'); assert.equal(params.get('useCases'), 'false');
    handlers.onDone(result());
  });
  await api.runReview();
});
await check('暂停队列只保存人工续跑计划，不触发审阅或中止当前稿', async () => {
  const { sandbox, api } = harness();
  api.state.queueRunning = true;
  const paths = [];
  let plan;
  sandbox.fetch = async (url, opts) => { paths.push(url); plan = JSON.parse(opts.body); return response({ workspace: workspace([], 2) }); };
  await api.pauseReviewQueue();
  assert.equal(api.state.queueStopRequested, true);
  assert.equal(plan.state, 'paused');
  assert.deepEqual(paths, ['/api/workspace']);
});
await check('批量 partial/failed 结束仍保存 paused 和首个待重审游标', async () => {
  const { sandbox, api } = harness();
  let current = workspace([{ id: 'A', name: 'A', status: 'partial' }, { id: 'B', name: 'B', status: 'failed' }]);
  const plans = [];
  sandbox.fetch = async (url, opts) => {
    if (url === '/api/workspace') { const body = JSON.parse(opts.body); plans.push(body); current = { ...current, revision: current.revision + 1, queue: { state: body.state, cursorSessionId: body.cursorSessionId } }; return response({ workspace: current }); }
    if (url.startsWith('/api/workspace')) return response({ workspace: current });
    if (url.startsWith('/api/session-file')) return bytes(url.includes('B') ? 'B-v0' : 'A-v0');
    return response(session(url.includes('B') ? 'B' : 'A'));
  };
  sandbox.setStream(async (_url, handlers) => { handlers.onDone({ ...result(api.state.sessionId), modelErrors: [{ window: 1, message: 'fixture' }] }); });
  await api.reviewQueue();
  assert.equal(plans.at(-1).state, 'paused');
  assert.equal(plans.at(-1).cursorSessionId, 'A');
});
await check('批量处理中暂停后完成当前稿，下一稿不自动调用模型', async () => {
  const { sandbox, api } = harness();
  let current = workspace([{ id: 'A', name: 'A', status: 'ready' }, { id: 'B', name: 'B', status: 'ready' }]);
  const plans = []; let streams = 0;
  sandbox.fetch = async (url, opts) => {
    if (url === '/api/workspace') {
      const body = JSON.parse(opts.body); plans.push(body);
      current = { ...current, revision: current.revision + 1, queue: { state: body.state, cursorSessionId: body.cursorSessionId } };
      return response({ workspace: current });
    }
    if (url.startsWith('/api/workspace')) return response({ workspace: current });
    if (url.startsWith('/api/session-file')) return bytes('A-v0');
    return response(session());
  };
  sandbox.setStream(async (_url, handlers) => {
    streams += 1; assert.equal(streams, 1);
    await api.pauseReviewQueue();
    current = { ...current, entries: current.entries.map((entry) => entry.id === 'A' ? { ...entry, status: 'complete' } : entry) };
    handlers.onDone(result());
  });
  await api.reviewQueue();
  assert.equal(streams, 1);
  assert.equal(plans.at(-1).state, 'paused');
  assert.equal(plans.at(-1).cursorSessionId, 'B');
});
await check('新稿切换立即清空旧人工记录；过期 session 响应不覆盖新稿', async () => {
  const { sandbox, api } = harness();
  api.state.humanDecisions.set(key, { action: 'reject' }); api.state.humanMarks = [{ id: 'old' }];
  const pending = deferred();
  sandbox.fetch = async () => ({ ok: true, json: () => pending.promise });
  const loading = api.activateItem({ id: 'B' }, { persist: false });
  assert.equal(api.state.humanDecisions.size, 0); assert.equal(api.state.humanMarks.length, 0);
  api.state.sessionId = 'C'; api.state.doc = { label: 'C' };
  pending.resolve(session('B')); await loading;
  assert.equal(api.state.sessionId, 'C'); assert.equal(api.state.doc.label, 'C');
});
await check('同稿再次激活时第一次迟到响应不能覆盖当前版本', async () => {
  const { sandbox, api } = harness();
  const old = deferred(); let reads = 0;
  const latest = { ...session(), doc: { ...session().doc, label: '最新A' }, workVersion: version('A-v1'),
    human: human(1, {}, [], 'r2', 'A-v1'), reviewRunId: 'r2' };
  sandbox.fetch = async (url) => {
    if (url.startsWith('/api/session-file')) return bytes('A-v1');
    reads += 1;
    return reads === 1 ? { ok: true, json: () => old.promise } : response(latest);
  };
  const first = api.activateItem({ id: 'A' }, { persist: false });
  await api.activateItem({ id: 'A' }, { persist: false });
  old.resolve(session()); await first;
  assert.equal(api.state.doc.label, '最新A'); assert.equal(api.state.workVersion.id, 'A-v1');
});
await check('A 详情可见时激活 B 立即关闭并清空，A 晚到保存不复活详情', async () => {
  const { sandbox, api, elements } = harness();
  const detail = sandbox.document.querySelector('#detail');
  detail.classList.remove('hidden');
  sandbox.document.querySelector('#detailTitle').textContent = 'A 的旧问题';
  sandbox.document.querySelector('#rcHumanNote').value = 'A 的存疑备注';
  api.state.activeIssueKey = key;
  const oldSave = deferred(); const nextSession = deferred();
  sandbox.fetch = async (url) => url === '/api/human-records' ? { ok: true, json: () => oldSave.promise }
    : url.startsWith('/api/session-file') ? bytes('B-v0') : { ok: true, json: () => nextSession.promise };
  const saving = api.saveHumanRecord('decision', { issueKey: key, action: 'unsure', opinion: 'A 的存疑备注' });
  const activating = api.activateItem({ id: 'B' }, { persist: false });
  assert.equal(detail.classList.contains('hidden'), true);
  assert.equal(elements.get('#detailTitle').textContent, '');
  assert.equal(elements.get('#rcHumanNote').value, '');
  assert.equal(api.state.activeIssueKey, null);
  oldSave.resolve({ workVersion: version(), reviewRunId: 'r1', human: human(1, { [key]: { action: 'unsure', opinion: 'A 的存疑备注' } }) });
  assert.equal(await saving, false);
  assert.equal(detail.classList.contains('hidden'), true);
  nextSession.resolve(session('B')); await activating;
  assert.equal(detail.classList.contains('hidden'), true);
  assert.equal(elements.get('#detailTitle').textContent, '');
  assert.equal(api.state.humanDecisions.size, 0);
});
await check('旧人工输入事件闭包不能把 A 备注写入已切换的 B', async () => {
  const { sandbox, api } = harness();
  const note = sandbox.document.querySelector('#rcHumanNote');
  const button = sandbox.document.createElement('button'); button.dataset.hd = 'unsure';
  const box = sandbox.document.querySelector('#detailRecheck');
  box.querySelector = () => note;
  box.querySelectorAll = (selector) => selector === '[data-hd]' ? [button] : [];
  api.state.activeIssueKey = key;
  api.renderRecheck(api.state.issues[0]);
  const oldChange = note.events.get('change'); const oldClick = button.events.get('click');
  let writes = 0;
  sandbox.fetch = async (url) => {
    if (url === '/api/human-records') { writes += 1; return response({}); }
    return url.startsWith('/api/session-file') ? bytes('B-v0') : response(session('B'));
  };
  await api.activateItem({ id: 'B' }, { persist: false });
  api.state.activeIssueKey = key;
  await oldChange({ target: { value: 'A 的迟到备注' } });
  await oldClick();
  assert.equal(writes, 0);
  assert.equal(api.state.humanDecisions.size, 0);
});
await check('人工决定绑定版本/run/epoch，确认响应后才显示保存', async () => {
  const { sandbox, api, elements } = harness();
  const pending = deferred(); let body;
  sandbox.fetch = async (_url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: () => pending.promise }; };
  const saving = api.saveHumanRecord('decision', { issueKey: key, action: 'reject', opinion: '待核对' });
  assert.equal(api.state.humanDecisions.size, 0);
  pending.resolve({ workVersion: version(), reviewRunId: 'r1', human: human(1, { [key]: { id: 'd1', action: 'reject', opinion: '待核对' } }) });
  assert.equal(await saving, true);
  assert.equal(body.baseVersionId, 'A-v0'); assert.equal(body.baseRunId, 'r1'); assert.equal(body.baseMutationEpoch, 0);
  assert.equal(body.expectedHumanRevision, 0); assert.ok(body.operationId);
  assert.equal(body.purpose, 'editorial'); assert.equal(body.verificationRunId, undefined);
  assert.equal(api.state.humanDecisions.get(key).action, 'reject'); assert.match(elements.get('#toast').textContent, /已保存/);
});
await check('流程验证 URL 记录 purpose 与运行号，防止污染正式人工反馈', async () => {
  const { sandbox, api } = harness();
  sandbox.location.search = '?workspace=test&verification=p0-03-fixture';
  let body;
  sandbox.fetch = async (_url, options) => { body = JSON.parse(options.body); return response({ workVersion: version(), reviewRunId: 'r1', human: human(1) }); };
  await api.saveHumanRecord('decision', { issueKey: key, action: 'unsure', opinion: '流程验证' });
  assert.equal(body.purpose, 'verification'); assert.equal(body.verificationRunId, 'p0-03-fixture');
});
await check('人工保存 409 不改 Map，也不宣称已保存', async () => {
  const { sandbox, api, elements } = harness();
  sandbox.fetch = async () => response({ error: '记录版本冲突，请刷新' }, false);
  assert.equal(await api.saveHumanRecord('decision', { issueKey: key, action: 'accept', opinion: '' }), false);
  assert.equal(api.state.humanDecisions.size, 0); assert.doesNotMatch(elements.get('#toast').textContent, /已保存/);
});
await check('人工保存响应跨稿或 ABA epoch 变化后不应用到当前记录', async () => {
  for (const change of ['session', 'epoch']) {
    const { sandbox, api } = harness(); const pending = deferred();
    sandbox.fetch = async () => ({ ok: true, json: () => pending.promise });
    const saving = api.saveHumanRecord('decision', { issueKey: key, action: 'accept', opinion: '' });
    if (change === 'session') api.state.sessionId = 'B'; else api.state.history = { epoch: 2 };
    pending.resolve({ workVersion: version(), reviewRunId: 'r1', human: human(1, { [key]: { action: 'accept' } }) });
    assert.equal(await saving, false); assert.equal(api.state.humanDecisions.size, 0);
  }
});
await check('同版本重审清除旧决定，保留该版本圈画；版本变化两者都清空', () => {
  const { api } = harness(); const mark = { id: 'm1' };
  api.state.humanDecisions.set(key, { action: 'reject' }); api.state.humanMarks = [mark];
  api.adoptHumanContext({ reviewRunId: 'r2', human: human(0, {}, [mark], 'r2') });
  assert.equal(api.state.humanDecisions.size, 0); assert.equal(api.state.humanMarks.length, 1);
  api.adoptHumanContext({ workVersion: version('A-v1'), reviewRunId: 'r2', human: human(1, {}, [], 'r2', 'A-v1') });
  assert.equal(api.state.humanMarks.length, 0); assert.equal(api.state.humanDecisions.size, 0);
});

function selectionFixture(h, text = '前 重复 后 重复 末', start = text.lastIndexOf('重复'), selected = '重复') {
  const paragraph = { dataset: { pindex: '0' }, textContent: text, querySelector: () => null,
    closest: (selector) => selector === 'p' ? paragraph : null };
  const node = { nodeType: 3, parentElement: paragraph, textContent: text }; paragraph.node = node;
  const range = { startContainer: node, endContainer: node, startOffset: start, endOffset: start + selected.length,
    commonAncestorContainer: node, toString: () => selected, cloneRange() { return this; }, getBoundingClientRect: () => ({ top: 0, left: 0 }) };
  h.sandbox.window.getSelection = () => ({ isCollapsed: false, rangeCount: 1, getRangeAt: () => range, toString: () => selected });
  h.elements.set('#docHost', { contains: candidate => candidate === paragraph || candidate === node, querySelector: () => paragraph,
    querySelectorAll: selector => selector === 'p[data-pindex="0"]' ? [paragraph] : [] });
  h.api.state.humanMode = true;
  h.api.bindSoftwareParagraph(paragraph);
  return { paragraph, node, range };
}
await check('圈画第二个重复片段异步核原文SHA后保存精确raw身份，确认前不写标注', async () => {
  const h = harness(); const { api, sandbox } = h;
  selectionFixture(h); api.onDocMouseUp();
  sandbox.document.querySelector('#hpNote').value = '核对第二处重复';
  const info = api.pending(); assert.equal(info.start, 4); assert.equal(info.end, 6);
  const pending = deferred(); let body;
  sandbox.fetch = async (_url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: () => pending.promise }; };
  const saving = api.saveHumanMark(); assert.equal(api.state.humanMarks.length, 0); assert.equal(h.inserted.length, 0);
  await until(() => !!body, 'Actual raw SHA check must complete before the fixture request');
  const text = api.state.doc.paragraphs[0].text, node = api.state.doc.paragraphs[0], start = text.lastIndexOf('重复');
  assert.equal(body.mark.offsetSpace, 'raw'); assert.equal(body.mark.start, start); assert.equal(body.mark.end, start + 2);
  assert.equal(body.mark.quote, text.slice(start, start + 2)); assert.equal(body.mark.text, body.mark.quote);
  assert.equal(body.mark.rawNodeTextSha256, sha256(text));
  assert.equal(body.mark.textView, 'after'); assert.equal(body.mark.offsetUnit, 'utf16');
  assert.equal(body.mark.paragraphIndexOwner, 'application-paragraph-index');
  assert.equal(body.mark.sourceVersionId, api.state.workVersion.id); assert.equal(body.mark.sourcePackageSha256, api.state.workVersion.sha256);
  assert.match(body.mark.sourcePackageSha256, /^[a-f0-9]{64}$/); assert.equal(body.mark.part, node.part);
  assert.equal(body.mark.sourceXmlNodeId, node.sourceXmlNodeId); assert.equal(body.mark.sourceXmlParagraphOrdinal, node.sourceXmlParagraphOrdinal);
  assert.equal(api.state.humanMarks.length, 0); assert.equal(h.inserted.length, 0);
  const mark = { id: 'm1', ...body.mark, rawStart:body.mark.start, rawEnd:body.mark.end };
  pending.resolve({ workVersion: { ...version(), sha256:api.state.workVersion.sha256 }, reviewRunId: 'r1', human: human(1, {}, [mark]) });
  await saving;
  assert.equal(api.state.humanMarks.length, 1);
  await until(() => h.inserted.length === 1, 'Committed raw mark must be verified before drawing');
  assert.equal(h.inserted[0].start, start); assert.equal(h.inserted[0].end, start + 2);
});
await check('raw原文摘要晚到时切稿、版本、epoch或工作台变化不发保存请求也不画标注', async () => {
  for (const change of ['session', 'version', 'epoch', 'activation', 'workspace']) {
    const h = harness(); selectionFixture(h); h.api.onDocMouseUp();
    h.sandbox.document.querySelector('#hpNote').value = '核对原文';
    const pendingHash = deferred(); let hashing = false, writes = 0;
    h.sandbox.crypto = { subtle: { digest: (...args) => { hashing = true; return pendingHash.promise.then(() => webcrypto.subtle.digest(...args)); } } };
    h.sandbox.fetch = async () => { writes += 1; return response({}); };
    const saving = h.api.saveHumanMark(); await until(() => hashing, 'Actual raw SHA computation must start');
    if (change === 'session') h.api.state.sessionId = 'B';
    if (change === 'version') h.api.state.workVersion = { ...h.api.state.workVersion, id:'A-v1' };
    if (change === 'epoch') h.api.state.history = { epoch: 2 };
    if (change === 'activation') h.api.state.activationSerial += 1;
    if (change === 'workspace') h.api.state.workspaceId = 'another-workspace';
    pendingHash.resolve(); await saving;
    assert.equal(writes, 0, change); assert.equal(h.api.state.humanMarks.length, 0, change); assert.equal(h.inserted.length, 0, change);
  }
});
await check('跨段、正文不一致及未知位置不能保存圈画', () => {
  for (const mismatch of ['cross', 'text', 'unknown']) {
    const h = harness(); const { paragraph, range } = selectionFixture(h);
    if (mismatch === 'cross') range.endContainer = { nodeType: 3, parentElement: { closest: () => ({}) } };
    if (mismatch === 'text') h.api.state.doc.paragraphs[0].text = '不同的正文';
    if (mismatch === 'unknown') paragraph.dataset = {};
    h.api.onDocMouseUp(); assert.equal(h.api.pending(), null);
  }
});
await check('圈画回放按已保存端点，不猜第一个重复原文', () => {
  const h = harness(); const { paragraph } = selectionFixture(h);
  assert.ok(h.api.wrapTextInParagraph(paragraph, '重复', () => ({ appendChild() {} }), { start: 4, end: 6 }));
  assert.equal(h.inserted[0].start, paragraph.textContent.lastIndexOf('重复'));
  assert.equal(h.api.wrapTextInParagraph(paragraph, '重复', () => ({}), { start: 0, end: 2 }), null);
});
await check('旧normalized标注核当前完整摘要后重算raw，忽略旧解析器cached raw范围', async () => {
  for (const corruptHash of [false, true]) {
    const h = harness(); const { paragraph } = selectionFixture(h), text = paragraph.textContent;
    const start = text.lastIndexOf('重复');
    h.api.state.humanMarks = [{ id:'legacy-normalized',target:'body',index:0,offsetSpace:'normalized',start:4,end:6,
      rawStart:start+1,rawEnd:start+3,quote:'重复',text:'重复',rawNodeTextSha256:sha256('\t'+text),
      nodeTextSha256:corruptHash?'0'.repeat(64):sha256(text.replace(/\s/g,'')) }];
    await h.api.reapplyHumanMarks();
    assert.equal(h.inserted.length, corruptHash ? 0 : 1);
    if (!corruptHash) { assert.equal(h.inserted[0].start,start); assert.equal(h.inserted[0].end,start+2); }
  }
});
await check('脚注/尾注缺XML身份即使唯一全文也拒绝人工猜测', () => {
  const { api } = harness();
  const p = { dataset: {}, textContent: '唯一尾注', node:{textContent:'唯一尾注'}, closest: () => ({}) };p.node.parentElement=p;
  api.state.doc.endnotes = [{ text: '唯一尾注' }];
  assert.equal(api.humanNodeForParagraph(p),null); assert.equal(p.dataset.eindex,undefined);
  api.state.doc.footnotes = [{ text: '唯一尾注' }];
  assert.equal(api.humanNodeForParagraph(p), null);
});
await check('旧 human 响应 revision 不回滚较新的当前记录', () => {
  const { api } = harness(); api.state.humanRevision = 2; api.state.humanDecisions.set(key, { action: 'reject' });
  api.adoptHumanContext({ workVersion: version(), reviewRunId: 'r1', human: human(1, { [key]: { action: 'accept' } }) });
  assert.equal(api.state.humanRevision, 2); assert.equal(api.state.humanDecisions.get(key).action, 'reject');
});

function emptyState(h, id = 'test') {
  Object.assign(h.api.state, { workspaceId: id, workspace: { ...workspace([], -1), id }, queue: [], sessionId: null,
    doc: null, buffer: null, workVersion: null, history: null, reviewRunId: null, workspaceError: null, streaming: false });
  h.sandbox.location.search = `?workspace=${id}`;
}
function localWorkspaceServer(h, { id = 'test', entries = [], failWrites = false, uploads = null } = {}) {
  const calls = [];
  let current = { ...workspace(entries, entries.length ? 0 : -1), id };
  h.sandbox.fetch = async (url, opts) => {
    const body = opts?.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts?.method || 'GET', body });
    if (url.startsWith('/api/upload')) return uploads ? uploads(url, opts) : response({ error: '软件上传反例：文件格式无效' }, false, 400);
    if (url === '/api/workspace' && opts?.method === 'POST') {
      if (failWrites) return response({ error: '软件登记反例：存储暂不可用' }, false, 500);
      assert.equal(body.id, id);
      assert.equal(body.expectedRevision, current.revision);
      if (body.action === 'failure') {
        // Match the actual backend entry identity contract; invalid IDs get 400.
        if (!/^e[A-Za-z0-9_-]{1,160}$/.test(body.entryId || '')) return response({ error: '导入失败记录无效' }, false, 400);
        current = { ...current, revision: current.revision + 1,
          entries: [...current.entries, { entryId: body.entryId, name: body.name, error: body.error, status: 'upload-failed' }] };
      } else if (body.action === 'attach') {
        current = { ...current, revision: current.revision + 1,
          entries: [...current.entries, { entryId: `e${body.sessionId}`, id: body.sessionId, name: `${body.sessionId}.docx`, status: 'ready', hasResult: true, workVersion: version(`${body.sessionId}-v0`) }],
          activeSessionId: current.activeSessionId || body.sessionId };
      } else throw new Error(`Unexpected fixture workspace action ${body.action}`);
      return response({ workspace: current });
    }
    if (url.startsWith('/api/workspace')) return response({ workspace: current });
    if (url.startsWith('/api/session-file')) return bytes(new URLSearchParams(url.split('?')[1]).get('id') + '-v0');
    if (url.startsWith('/api/session?')) return response(session(new URLSearchParams(url.split('?')[1]).get('id')));
    throw new Error(`Unexpected fixture request ${url}`);
  };
  return { calls, current: () => current, fetch: h.sandbox.fetch };
}
const softwareFile = (name, failRead = false) => ({ name, arrayBuffer: async () => {
  if (failRead) throw new Error('软件读取反例：文件读取失败');
  return new Uint8Array([1, 2, 3]).buffer;
} });

await check('空命名工作台不读取或自动登记全局旧会话，失败项台同样隔离', async () => {
  for (const entries of [[], [{ entryId: 'eexistingfailure', name: '坏稿.docx', error: '软件失败', status: 'upload-failed' }]]) {
    const h = harness(); emptyState(h, 'wisolated'); h.stored.set('dsh.lastSession', 'A');
    const server = localWorkspaceServer(h, { id: 'wisolated', entries }); let streams = 0;
    h.sandbox.setStream(() => { streams += 1; });
    assert.equal(await h.api.restoreWorkspace(), true);
    assert.equal(server.calls.filter((c) => c.url.startsWith('/api/session')).length, 0);
    assert.equal(server.calls.filter((c) => c.method === 'POST').length, 0);
    assert.equal(h.api.state.queue.length, entries.length);
    assert.equal(h.api.state.sessionId, null); assert.equal(h.api.state.doc, null);
    assert.equal(h.stored.get('dsh.lastSession'), 'A'); assert.equal(streams, 0);
  }
});
await check('默认 wdefault 空工作台仍可兼容恢复全局旧会话并登记', async () => {
  const h = harness(); emptyState(h, 'wdefault'); h.sandbox.location.search = ''; h.stored.set('dsh.lastSession', 'A');
  const server = localWorkspaceServer(h, { id: 'wdefault' }); let streams = 0;
  h.sandbox.setStream(() => { streams += 1; });
  assert.equal(await h.api.restoreWorkspace(), true);
  assert.equal(server.calls.filter((c) => c.body?.action === 'attach').length, 1);
  assert.equal(server.calls.find((c) => c.body?.action === 'attach').body.sessionId, 'A');
  assert.equal(h.api.state.queue.length, 1); assert.equal(h.api.state.sessionId, 'A');
  assert.equal(h.api.state.workVersion.id, 'A-v0'); assert.equal(streams, 0);
});
await check('显式 session URL 可进入空命名工作台，不选全局旧会话', async () => {
  const h = harness(); emptyState(h, 'wexplicit'); h.sandbox.location.search += '&session=B'; h.stored.set('dsh.lastSession', 'A');
  const server = localWorkspaceServer(h, { id: 'wexplicit' }); let streams = 0;
  h.sandbox.setStream(() => { streams += 1; });
  assert.equal(await h.api.restoreWorkspace(), true);
  assert.equal(server.calls.filter((c) => c.body?.action === 'attach').length, 1);
  assert.equal(server.calls.find((c) => c.body?.action === 'attach').body.sessionId, 'B');
  assert.equal(server.calls.some((c) => /[?&]id=A(?:&|$)/.test(c.url)), false);
  assert.equal(h.api.state.queue.length, 1); assert.equal(h.api.state.sessionId, 'B');
  assert.equal(h.api.state.workVersion.id, 'B-v0'); assert.equal(streams, 0);
});
await check('旧服务 restoreSession 回退也限默认工作台，显式 session 仍优先', async () => {
  for (const [id, search, expected] of [['wisolated', '?workspace=wisolated', null], ['wdefault', '', 'A'], ['wisolated', '?workspace=wisolated&session=B', 'B']]) {
    const h = harness(); emptyState(h, id); h.sandbox.location.search = search; h.stored.set('dsh.lastSession', 'A');
    const server = localWorkspaceServer(h, { id }); let streams = 0; h.sandbox.setStream(() => { streams += 1; });
    await h.api.restoreSession();
    assert.equal(h.api.state.sessionId, expected);
    assert.equal(server.calls.filter((c) => c.url.startsWith('/api/session?')).length, expected ? 1 : 0);
    assert.equal(server.calls.filter((c) => c.method === 'POST').length, 0); assert.equal(streams, 0);
  }
});
await check('单文件导入失败使用合法 entryId 登记，刷新可从服务事实恢复', async () => {
  const h = harness(); emptyState(h); const server = localWorkspaceServer(h);
  await h.api.importFile(softwareFile('单文件坏稿.docx'));
  const writes = server.calls.filter((c) => c.body?.action === 'failure');
  assert.equal(writes.length, 1); assert.match(writes[0].body.entryId, /^e[A-Za-z0-9_-]{1,160}$/);
  assert.equal(writes[0].body.name, '单文件坏稿.docx');
  assert.equal(server.current().entries.length, 1);
  assert.equal(h.api.state.queue[0].status, 'upload-failed'); assert.equal(h.api.state.queue[0].queueUnsaved, false);
  assert.equal(h.api.state.sessionId, null);
  const reloaded = harness(); emptyState(reloaded); reloaded.sandbox.fetch = server.fetch;
  assert.equal(await reloaded.api.restoreWorkspace(), true);
  assert.equal(reloaded.api.state.queue.length, 1); assert.equal(reloaded.api.state.queue[0].entryId, writes[0].body.entryId);
  assert.equal(reloaded.api.state.queue[0].queueUnsaved, false); assert.equal(reloaded.api.state.queue[0].id, undefined);
});
await check('批量 HTTP/读取失败逐条登记合法唯一身份，刷新保留全部失败', async () => {
  const h = harness(); emptyState(h); const server = localWorkspaceServer(h);
  await h.api.importFiles([softwareFile('批量坏稿甲.docx'), softwareFile('批量坏稿乙.docx', true)]);
  const writes = server.calls.filter((c) => c.body?.action === 'failure');
  assert.equal(writes.length, 2); assert.ok(writes.every((c) => /^e[A-Za-z0-9_-]{1,160}$/.test(c.body.entryId)));
  assert.equal(new Set(writes.map((c) => c.body.entryId)).size, 2);
  assert.equal(server.current().entries.length, 2); assert.equal(h.api.state.queue.length, 2);
  assert.ok(h.api.state.queue.every((entry) => entry.status === 'upload-failed' && entry.queueUnsaved === false));
  const reloaded = harness(); emptyState(reloaded); reloaded.sandbox.fetch = server.fetch;
  assert.equal(await reloaded.api.restoreWorkspace(), true); assert.equal(reloaded.api.state.queue.length, 2);
  assert.deepEqual([...reloaded.api.state.queue.map((entry) => entry.name)], ['批量坏稿甲.docx', '批量坏稿乙.docx']);
  assert.equal(server.calls.some((c) => /review|ask/.test(c.url)), false);
});
await check('单文件读取异常也登记失败，不能只留一条临时提示', async () => {
  const h = harness(); emptyState(h); const server = localWorkspaceServer(h);
  await h.api.importFile(softwareFile('单文件读取失败.docx', true));
  assert.equal(server.calls.filter((c) => c.body?.action === 'failure').length, 1);
  assert.equal(server.current().entries.length, 1); assert.equal(h.api.state.queue[0].queueUnsaved, false);
  assert.match(h.api.state.queue[0].error, /文件读取失败/);
});
await check('失败项登记失败明确显示本地待登记，并按工作台保留刷新证据', async () => {
  const h = harness(); emptyState(h); const server = localWorkspaceServer(h, { failWrites: true });
  await h.api.importFile(softwareFile('软件坏稿.docx'));
  assert.equal(server.current().entries.length, 0); assert.equal(h.api.state.queue.length, 1);
  assert.equal(h.api.state.queue[0].queueUnsaved, true); assert.equal(h.api.state.queue[0].status, 'upload-failed');
  const pending = JSON.parse(h.stored.get('dsh.pendingRegistrations:test'));
  assert.equal(pending.length, 1); assert.match(pending[0].entryId, /^e[A-Za-z0-9_-]{1,160}$/);
  const visible = h.elements.get('#queueList').innerHTML + h.elements.get('#toast').textContent;
  assert.match(visible, /未登记|待登记|本地/); assert.doesNotMatch(visible, /登记已保存/);
  const reloaded = harness(); emptyState(reloaded);
  reloaded.stored.set('dsh.pendingRegistrations:test', h.stored.get('dsh.pendingRegistrations:test'));
  reloaded.sandbox.fetch = server.fetch;
  assert.equal(await reloaded.api.restoreWorkspace(), true);
  assert.equal(reloaded.api.state.queue.length, 1); assert.equal(reloaded.api.state.queue[0].queueUnsaved, true);
  assert.match(reloaded.elements.get('#queueList').innerHTML, /未登记|待登记|本地/);
});

const failed = checks.filter((item) => !item.ok).length;
console.log(`工作台/人工记录前端回归：${passed}/${checks.length} 项通过，${failed} 项失败（未调用真实模型）`);
if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const evidence = { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), sourcePath, sourceSha256: sha256(source),
    testSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), mode: 'local-response-and-DOM-fixtures', realModelCalls: 0,
    realServiceRequests: 0, checks, summary: { total: checks.length, passed, failed } };
  writeFileSync(outputPath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
}
if (failed) process.exitCode = 1;
