/** Server queue UI contracts. Actual status acceptance and queue rendering in a VM; no services or model calls. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const sourcePath = resolve(ROOT, flag('source') || 'public/app.js');
const source = readFileSync(sourcePath, 'utf8');
const html = readFileSync(resolve(ROOT, 'public/index.html'), 'utf8');
const out = flag('out') ? resolve(ROOT, flag('out')) : null;
if (out && existsSync(out)) throw new Error('Evidence exists; choose a fresh --out');
function guardOutput(){if(!out)return;const within=root=>{const r=relative(root,out);return !!r&&!isAbsolute(r)&&r!=='..'&&!r.startsWith('..\\')&&!r.startsWith('../');};assert(within(join(ROOT,'data/verify'))||within(join(ROOT,'data/optimization/runs')),'Output must be managed verification evidence');for(let p=dirname(out);;p=dirname(p)){assert(!existsSync(join(p,'complete.json')),'Sealed evidence refused');if(existsSync(p)){const s=lstatSync(p);assert(s.isDirectory()&&!s.isSymbolicLink()&&resolve(realpathSync(p)).toLowerCase()===p.toLowerCase(),'Evidence alias refused');}if(p===dirname(p))break;}assert(!existsSync(out),'Evidence cannot be overwritten');}
guardOutput();
const checks = [];
const observations = [];
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const version = (id = 'A') => ({ id: `${id}-v0`, revision: 0 });
const doc = (id = 'A') => ({ label: id, meta: {}, paragraphs: [{ text: id }], footnotes: [], endnotes: [] });
const result = (id = 'A', run = 'r-A', versionId = `${id}-v0`) => ({ reviewRunId: run, workVersionId: versionId,
  issues: [{ issueKey: `${id}-issue`, ruleId: 'FMT', location: 'paragraph:0', quote: id }], summary: { total: 1 } });
const status = (id = 'A', phase = 'running', run = `r-${id}`) => ({ id, status: phase, reviewRunId: run,
  reviewJobId: `j-${id}`, workVersionId: `${id}-v0`, workVersion: version(id), history: { epoch: 0 },
  running: phase === 'running', waiting: phase === 'queued', progress: { phase: 'model', current: 1, total: 3 },
  result: ['completed', 'partial'].includes(phase) ? result(id, run) : null, hasResult: ['completed', 'partial'].includes(phase), cancelled: phase === 'cancelled' });
const session = (id = 'A', phase = 'ready') => ({ exists: true, id, name: `${id}.docx`, doc: doc(id), workVersion: version(id), history: { epoch: 0 },
  running: phase === 'running', waiting: phase === 'queued', reviewRunId: `r-${id}`, result: phase === 'completed' ? result(id) : null });
const workspace = (phase = 'running', revision = 1) => ({ id: 'wtest', revision, activeSessionId: 'A',
  entries: ['A', 'B'].map((id) => ({ id, entryId: `e-${id}`, name: `${id}.docx`, status: id === 'A' ? 'reviewing' : 'ready',
    reviewRunId: `r-${id}`, workVersion: version(id), hasResult: false, running: id === 'A' && phase === 'running' })),
  queue: { runId: 'q-run', state: phase, cancelRequested: ['cancelling', 'cancelled'].includes(phase), cursorSessionId: 'A', options: { useModel: false },
    counts: { total: 2, queued: 1, running: phase === 'running' ? 1 : 0, completed: 0, partial: 0, failed: 0, cancelled: 0, interrupted: 0, excluded: 0 },
    items: [{ id: 'j-A', sessionId: 'A', versionId: 'A-v0', status: 'running' }, { id: 'j-B', sessionId: 'B', versionId: 'B-v0', status: 'queued' }] } });
const json = (value, ok = true, code = ok ? 200 : 500) => ({ ok, status: code, json: async () => value });
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
function harness({ supported = true } = {}) {
  const elements = new Map(), timers = new Map(), calls = [];
  let timerId = 0;
  const makeElement = () => {
    const classes = new Set();
    return { dataset: {}, style: {}, innerHTML: '', textContent: '', childNodes: [], value: '', checked: false, disabled: false,
      events: new Map(), classList: { add(...names) { names.forEach((n) => classes.add(n)); }, remove(...names) { names.forEach((n) => classes.delete(n)); },
        toggle(name, force) { const enabled = force === undefined ? !classes.has(name) : force; if (enabled) classes.add(name); else classes.delete(name); }, contains: (n) => classes.has(n) },
      querySelector: () => null, querySelectorAll(selector) { if (selector !== '.q-item') return [];
        this.rows = [...this.innerHTML.matchAll(/data-qi="(\d+)"/g)].map((m) => { const row = makeElement(); row.dataset.qi = m[1]; return row; }); return this.rows; },
      addEventListener(name, fn) { this.events.set(name, fn); }, replaceChildren() {}, appendChild() {}, focus() {} };
  };
  const sandbox = { URLSearchParams, location: { search: '?workspace=wtest' },
    window: { matchMedia: () => ({ matches: false }) },
    document: { querySelector: (id) => { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
      querySelectorAll: () => [], createElement: makeElement, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval: () => ++timerId, clearInterval() {}, fetch: () => { throw new Error('Unexpected fetch'); } };
  const noops = ['renderDocInfo', 'renderMarkupIssues', 'renderMarkupStats', 'highlightIssuesInDoc', 'markHeadingLevels', 'wireCitations',
    'updateApplyBtn', 'setProgressBar', 'hideProgressBar', 'switchView', 'mountSettings'];
  runInNewContext(source + `\n${noops.map((name) => `${name} = () => {};`).join('\n')}
    renderDocument = async () => {}; timer.run = () => {}; timer.stop = () => {};
    globalThis.progress = []; setProgress = (items) => { progress = items; };
    globalThis.api = { state, boot, reviewQueue, requestReviewQueue, pauseReviewQueue, cancelReviewQueue, refreshReviewQueue, restoreWorkspace,
      adoptWorkspace, activateItem, runReview, resumeReview, cancelCurrentReview, reviewOptionsSnapshot,
      startQueueObserver, stopQueueObserver, startReviewObserver, stopReviewObserver, showModernReviewStatus, matchingReviewStatus,
      renderQueue, queueTimer: () => queueObserverTimer, reviewTimer: () => reviewObserverTimer,
      binding: () => reviewObserverBinding,
      ...(typeof inspectReviewGaps==='function'?{inspectReviewGaps,resumeMissingReviewTasks,reviewGapAction,getGapInspection:currentReviewGapInspection}: {}) };
    consumeStream = () => { throw new Error('Modern UI must not start GET review-stream'); };
  `, sandbox, { filename: 'public/app.js' });
  Object.assign(sandbox.api.state, { workspaceId: 'wtest', workspaceSupported: true, ingestionSupported: true, queueSupported: supported,
    workspace: workspace('paused'), queue: [], sessionId: 'A', doc: doc(), workVersion: version(), history: { epoch: 0 }, clean: { status: 'cleaned' } });
  const server = { workspace: workspace('paused'), statuses: new Map([['A', status()], ['B', status('B')]]), sessions: new Map([['A', session()], ['B', session('B')]]), hook: null };
  sandbox.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null }; calls.push(call);
    if (server.hook) { const custom = await server.hook(call); if (custom !== undefined) return custom; }
    if (call.url === '/api/health') return json({ reviewQueueProtocol: 1, ingestionProtocol: 1, rules: { format: 1, language: 1, citation: 1 }, models: [] });
    if (call.url === '/api/review-queue' && call.method === 'POST') {
      server.workspace = { ...server.workspace, revision: server.workspace.revision + 1, queue: { ...server.workspace.queue,
        state: call.body.action === 'pause' ? 'pausing' : call.body.action === 'cancel' ? 'cancelling' : 'running',
        cancelRequested: call.body.action === 'cancel' || server.workspace.queue.cancelRequested } };
      return json({ workspace: server.workspace, queue: server.workspace.queue,
        command: { action: call.body.action, operationId: call.body.operationId, runId: server.workspace.queue.runId, replayed: false } });
    }
    if (call.url.startsWith('/api/review-queue?') || call.url.startsWith('/api/workspace?')) return json({ workspace: server.workspace, queue: server.workspace.queue });
    if (call.url === '/api/workspace') { server.workspace = { ...server.workspace, revision: server.workspace.revision + 1, activeSessionId: call.body.sessionId }; return json({ workspace: server.workspace }); }
    if (call.url.startsWith('/api/session-file')) { const id = new URLSearchParams(call.url.split('?')[1]).get('id'); return { ok: true, headers: { get: () => `${id}-v0` }, arrayBuffer: async () => new Uint8Array([id.charCodeAt(0)]).buffer }; }
    if (call.url.startsWith('/api/session?')) return json(server.sessions.get(new URLSearchParams(call.url.split('?')[1]).get('id')));
    if (call.url.startsWith('/api/review-status')) return json(server.statuses.get(new URLSearchParams(call.url.split('?')[1]).get('id')));
    if (call.url === '/api/review') return json({ accepted: true, ...server.statuses.get(call.body.id) });
    if (call.url === '/api/cancel-review') { server.statuses.set(call.body.id, status(call.body.id, 'cancelled')); return json({ accepted: true, cancelled: true, cancelRequested: true, status: 'cancelled', publicationCommitted: false }); }
    throw new Error(`Unexpected request ${call.method} ${call.url}`);
  };
  return { api: sandbox.api, sandbox, elements, calls, timers, server,
    async fire(id) { const scheduled = timers.get(id); assert.ok(scheduled, 'observer timer must exist'); timers.delete(id); await scheduled.fn(); await flush(); } };
}
// The live queue was eventually correct. These controls close the evidenced
// synchronous result/async workspace refresh window; they do not assert that
// the durable queue or a historical partial run was wrong.
const terminalOptions = { model: 'local-rules-only', useModel: false, useRecheck: false, useContext: false,
  useCases: false, verdictWithModel: false, ruleMode: 'all', focus: [] };
const terminalResult = (phase = 'completed') => ({ ...result('A', 'r-current'), sessionId: 'A',
  reviewOptions: terminalOptions, reviewCoverage: { schemaVersion: 1, purpose: 'verification', options: terminalOptions,
    currentWorkVersionId: 'A-v0', reviewedVersionId: 'A-v0', currentWorkChanged: false,
    executionStatus: phase === 'partial' ? 'partial' : 'completed', fullTextCoverage: 'not_requested', qualityStatus: 'unverified',
    steps: { rules: { status: 'completed' }, model: { status: phase === 'partial' ? 'failed' : 'disabled' },
      recheck: { status: 'disabled' }, context: { status: 'disabled' }, cases: { status: 'disabled' }, consistency: { status: 'disabled' } } } });
const terminalStatus = (phase = 'completed') => ({ ...status('A', phase, 'r-current'),
  reviewJobId: 'j-current', result: ['completed', 'partial'].includes(phase) ? terminalResult(phase) : null,
  progress: { phase: phase === 'completed' ? 'done' : phase, done: 1, total: 1 },
  error: phase === 'failed' ? 'local execution failed' : null });
function terminalHarness() {
  const h = harness();
  h.api.state.queue = [{ id: 'A', name: 'A.docx', workVersion: version(), reviewRunId: 'r-prior', status: 'partial',
    result: result('A', 'r-prior'), opts: { useModel: true }, error: 'prior incomplete model step', hasResult: true },
    { id: 'B', name: 'B.docx', workVersion: version('B'), reviewRunId: 'r-B', status: 'ready', result: null }];
  h.api.state.reviewRunId = 'r-current'; h.api.state.streaming = true;
  h.api.renderQueue();
  const binding = { workspaceId: 'wtest', workspaceSerial: h.api.state.workspaceSerial, sessionId: 'A',
    activationSerial: h.api.state.activationSerial, versionId: 'A-v0', runId: 'r-current', jobId: 'j-current' };
  return { ...h, binding };
}
function rowMarkup(h, index = 0) {
  const rows = [...(h.elements.get('#queueList')?.innerHTML || '').matchAll(/<div class="q-item[^\"]*"[^>]*data-qi="(\d+)"[^>]*>([\s\S]*?)<\/div>/g)];
  const row = rows.find((match) => Number(match[1]) === index);
  assert.ok(row, `actual renderQueue must render row ${index}`);
  return row[2];
}
function assertRowUnchanged(h, before, markup) {
  assert.deepEqual(plain(h.api.state.queue), before, 'rejected response must not replace any queue row');
  assert.equal(h.elements.get('#queueList').innerHTML, markup, 'rejected response must not repaint accepted queue facts');
}
async function check(name, fn) {
  try { await fn(); checks.push({ name, ok: true }); console.log(`✓ ${name}`); }
  catch (error) { checks.push({ name, ok: false, error: { message: error.message, stack: error.stack } }); console.log(`✗ ${name}: ${error.message}`); }
}
await check('能力未知禁止新任务，刷新恢复只发只读请求', async () => {
  const h = harness({ supported: null });
  await h.api.reviewQueue(); await h.api.runReview(); h.api.state.queueRunning = true;
  await h.api.pauseReviewQueue(); await h.api.cancelReviewQueue(); assert.equal(h.calls.length, 0);
  await h.api.restoreWorkspace(); assert.ok(h.calls.length > 0); assert.ok(h.calls.every((c) => c.method === 'GET'));
});
await check('健康成功缺字段才兼容旧服务，未知版本或失败保持能力未知', async () => {
  for (const value of ['absent', 2, '1', 'failure']) {
    const h = harness(); h.server.hook = (c) => c.url !== '/api/health' ? undefined : value === 'failure' ? json({}, false)
      : json({ ...(value === 'absent' ? {} : { reviewQueueProtocol: value }), rules: { format: 1, language: 1, citation: 1 }, models: [] });
    await h.api.boot(); assert.equal(h.api.state.queueSupported, value === 'absent' ? false : null);
  }
});
await check('批量只提交一次服务器任务，模型关闭快照禁用所有模型子功能', async () => {
  const h = harness(); h.api.state.issues = [result().issues[0]];
  for (const id of ['#selfVerify', '#useContext', '#useCases']) h.sandbox.document.querySelector(id).checked = true;
  await h.api.reviewQueue(); await h.api.reviewQueue();
  const writes = h.calls.filter((c) => c.method === 'POST'); assert.equal(writes.length, 1);
  assert.equal(writes[0].url, '/api/review-queue'); assert.equal(writes[0].body.action, 'resume'); assert.equal(writes[0].body.runId, 'q-run');
  assert.ok(writes[0].body.operationId); assert.equal(writes[0].body.options.useModel, false);
  for (const field of ['useRecheck', 'useContext', 'useCases']) assert.equal(writes[0].body.options[field], false);
  assert.equal(h.api.state.sessionId, 'A'); assert.equal(h.api.state.issues.length, 0, 'new server run must clear obsolete issues without switching manuscripts');
  assert.equal(h.calls.filter((c) => c.url.includes('/api/review-stream')).length, 0);
});
await check('关闭页面后新页面恢复服务器运行，不提交或自动切后台游标', async () => {
  const first = harness(); await first.api.reviewQueue(); first.api.stopQueueObserver();
  const next = harness(); next.server.workspace = { ...first.server.workspace, activeSessionId: 'B' }; next.server.sessions.set('B', session('B'));
  await next.api.restoreWorkspace(); assert.equal(next.api.state.queueRunning, true); assert.equal(next.api.state.sessionId, 'B');
  assert.ok(next.calls.every((c) => c.method === 'GET')); assert.ok(next.api.queueTimer());
  next.server.workspace = { ...next.server.workspace, revision: 3, queue: { ...next.server.workspace.queue, cursorSessionId: 'A', counts: { total: 2, completed: 1 } } };
  await next.fire(next.api.queueTimer()); assert.equal(next.api.state.sessionId, 'B');
});
await check('暂停只停止后续，当前完成后仍有待审稿则保持暂停', async () => {
  const h = harness(); h.server.workspace = workspace(); h.api.adoptWorkspace(h.server.workspace);
  await h.api.pauseReviewQueue(); assert.equal(h.api.state.workspace.queue.state, 'pausing');
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 1); assert.equal(h.calls[0].body.action, 'pause');
  assert.ok(h.calls.every((c) => !c.url.includes('cancel-review')));
  h.server.workspace = { ...workspace('paused', 3), entries: [{ ...workspace().entries[0], status: 'complete', hasResult: true }, workspace().entries[1]],
    queue: { ...workspace('paused').queue, counts: { total: 2, completed: 1, queued: 1 } } };
  await h.fire(h.api.queueTimer()); assert.equal(h.api.state.workspace.queue.state, 'paused'); assert.equal(h.api.queueTimer(), null);
  assert.doesNotMatch(h.elements.get('#queueList').innerHTML, /本轮完整完成/);
});
await check('取消本轮保留权威记录，失败不显示已取消且可刷新确认', async () => {
  const h = harness(); h.api.adoptWorkspace(workspace()); h.server.workspace = workspace();
  h.server.hook = (c) => c.url === '/api/review-queue' ? json({ error: 'disk unavailable' }, false) : undefined;
  assert.equal(await h.api.cancelReviewQueue(), false); assert.equal(h.api.state.workspace.queue.state, 'running');
  assert.match(h.elements.get('#queueList').innerHTML, /结果未确认|刷新进度确认/); assert.doesNotMatch(h.elements.get('#toast').textContent, /取消已保存/);
  h.server.hook = null; await h.api.cancelReviewQueue(); assert.equal(h.api.state.workspace.queue.state, 'cancelling');
  assert.equal(h.api.state.queueRunning, true); assert.ok(h.api.queueTimer());
  assert.match(h.elements.get('#queueList').innerHTML, /正在取消本轮/);
  assert.equal(h.elements.get('#btnCancelQueue').textContent, '取消中…'); assert.equal(h.elements.get('#btnCancelQueue').disabled, true);
  assert.doesNotMatch(h.elements.get('#toast').textContent, /本轮取消已保存/);
  h.server.workspace = { ...h.server.workspace, queue: { ...h.server.workspace.queue, state: 'cancelled' } };
  await h.fire(h.api.queueTimer()); assert.equal(h.api.state.workspace.queue.state, 'cancelled'); assert.equal(h.api.queueTimer(), null);
  assert.equal(h.api.state.queue.length, 2); assert.match(h.elements.get('#queueList').innerHTML, /取消记录已保存/);
  await h.api.refreshReviewQueue(); assert.equal(h.api.state.workspace.queue.state, 'cancelled');
  assert.match(html, /id="btnCancelQueue"/); assert.match(html, /id="btnRefreshQueue"/);
});
await check('运行时列表可切稿且立即清空旧问题，旧状态完成响应不得夺稿', async () => {
  const h = harness(); await h.api.runReview(); await flush();
  const pending = deferred(); h.server.hook = (c) => c.url.includes('/api/review-status') ? pending.promise : undefined;
  const oldTimer = h.api.reviewTimer(); const oldTick = h.fire(oldTimer);
  h.api.state.issues = result().issues; h.api.state.activeIssueKey = 'A-issue'; h.api.renderQueue();
  h.elements.get('#queueList').rows[1].events.get('click')({ target: { closest: () => null } });
  assert.equal(h.api.state.sessionId, 'B'); assert.equal(h.api.state.issues.length, 0); assert.equal(h.api.state.activeIssueKey, null);
  await flush(); pending.resolve(json(status('A', 'completed'))); await oldTick;
  assert.equal(h.api.state.sessionId, 'B'); assert.equal(h.api.state.issues.length, 0);
});
await check('同稿旧运行或旧版本状态不覆盖当前结果，工作台倒序及跨台响应丢弃', async () => {
  const h = harness(); const binding = { workspaceId: 'wtest', workspaceSerial: 0, sessionId: 'A', activationSerial: 0, versionId: 'A-v0', runId: 'new-run', jobId: 'j-A' };
  h.api.state.issues = [{ issueKey: 'keep' }];
  assert.equal(h.api.showModernReviewStatus(binding, status('A', 'completed', 'old-run')), false);
  assert.equal(h.api.showModernReviewStatus(binding, { ...status('A', 'completed', 'new-run'), workVersionId: 'A-v-1' }), false);
  assert.equal(h.api.state.issues[0].issueKey, 'keep');
  h.api.adoptWorkspace(workspace('running', 8)); h.api.adoptWorkspace(workspace('cancelled', 3)); assert.equal(h.api.state.workspace.revision, 8);
  const pending = deferred(); h.server.hook = () => pending.promise; const refreshing = h.api.refreshReviewQueue();
  h.api.state.workspaceId = 'wother'; h.api.state.workspaceSerial += 1;
  pending.resolve(json({ workspace: workspace('cancelled', 10) })); assert.equal(await refreshing, false); assert.equal(h.api.state.workspace.revision, 8);
});
await check('单篇提交带基础版本和幂等身份，取消捕获点击稿件且迟到回执不夺稿', async () => {
  const h = harness(); await h.api.runReview(); await flush();
  const submit = h.calls.find((c) => c.url === '/api/review'); assert.ok(submit.body.operationId);
  assert.equal(submit.body.baseVersionId, 'A-v0'); assert.equal(submit.body.baseMutationEpoch, 0); assert.equal(submit.body.async, true);
  assert.ok(h.calls.some((c) => c.url.includes('/api/review-status?id=A&runId=r-A')));
  const pending = deferred(); h.server.hook = (c) => c.url === '/api/cancel-review' ? pending.promise : undefined;
  const cancelling = h.api.cancelCurrentReview(); const call = h.calls.find((c) => c.url === '/api/cancel-review');
  assert.equal(call.body.id, 'A'); assert.equal(call.body.reviewRunId, 'r-A'); assert.equal(call.body.workVersionId, 'A-v0');
  await h.api.activateItem({ id: 'B' }, { persist: false }); pending.resolve(json({ accepted: true, cancelled: true })); await cancelling;
  assert.equal(h.api.state.sessionId, 'B'); assert.equal(h.api.state.issues.length, 0);
});
await check('partial/取消/中断刷新可见，partial结果显示须补审且不能称完整完成', async () => {
  const h = harness(); const binding = { workspaceId: 'wtest', workspaceSerial: 0, sessionId: 'A', activationSerial: 0, versionId: 'A-v0', runId: 'r-A', jobId: 'j-A' };
  assert.equal(h.api.showModernReviewStatus(binding, status('A', 'partial')), true);
  assert.equal(h.api.state.issues.length, 1); assert.match(h.elements.get('#toast').textContent, /部分完成.*补审/);
  h.server.workspace = { ...workspace('partial', 9), entries: ['partial', 'cancelled', 'interrupted'].map((phase, i) => ({ id: `S${i}`, name: phase, status: phase })) };
  await h.api.refreshReviewQueue(); const visible = h.elements.get('#queueList').innerHTML;
  assert.match(visible, /部分完成/); assert.match(visible, /已中止/); assert.match(visible, /已中断/); assert.doesNotMatch(visible, /完整完成/);
});
await check('观察器无重入，关闭本页观察只移除计时器且绝不取消后台', async () => {
  const h = harness(); await h.api.reviewQueue(); const pending = deferred();
  h.server.hook = (c) => c.url.startsWith('/api/review-queue?') ? pending.promise : undefined;
  const polling = h.fire(h.api.queueTimer()); assert.equal(h.api.queueTimer(), null);
  const before = h.calls.length; h.api.stopQueueObserver(); h.api.stopReviewObserver(); assert.equal(h.calls.length, before);
  pending.resolve(json({ workspace: workspace('running', 3) })); await polling;
  assert.equal(h.api.queueTimer(), null); assert.equal(h.calls.filter((c) => c.method === 'POST').length, 1);
});
await check('新批量使用start，选中待审稿被调度后只读接管且不改变选择', async () => {
  const h = harness(); h.api.state.workspace.queue.state = 'ready'; h.server.workspace = workspace('ready');
  h.api.state.sessionId = 'B'; h.api.state.workVersion = version('B'); h.api.state.doc = doc('B');
  h.server.statuses.set('B', status('B', 'queued'));
  await h.api.reviewQueue(); await flush();
  assert.equal(h.calls.find((c) => c.url === '/api/review-queue').body.action, 'start');
  assert.equal(h.api.state.sessionId, 'B'); assert.equal(h.api.state.reviewWaiting, true);
  assert.equal(h.api.state.streaming, true); assert.equal(h.elements.get('#btnReview').disabled, true);
  const oldPosts = h.calls.filter((c) => c.method === 'POST').length;
  h.server.statuses.set('B', status('B', 'running')); await h.fire(h.api.reviewTimer());
  assert.equal(h.api.state.reviewWaiting, false); assert.equal(h.api.state.sessionId, 'B');
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, oldPosts);
});
await check('单篇取消失败保留正在审阅事实，断线重试沿用完全相同操作身份', async () => {
  const h = harness(); await h.api.runReview(); await flush();
  let attempts = 0; h.server.hook = (c) => c.url === '/api/cancel-review' ? (++attempts === 1 ? Promise.reject(new Error('connection lost')) : json({ error: 'cannot save' }, false)) : undefined;
  assert.equal(await h.api.cancelCurrentReview(), false);
  const requests = h.calls.filter((c) => c.url === '/api/cancel-review'); assert.equal(requests.length, 2);
  assert.deepEqual(plain(requests[0].body), plain(requests[1].body)); assert.ok(requests[0].body.operationId);
  assert.equal(h.api.state.streaming, true); assert.match(h.sandbox.progress[0].text, /取消结果未确认.*刷新/);
  assert.doesNotMatch(h.elements.get('#toast').textContent, /请求已保存/);
});
await check('取消回执确认后，较早发起的队列读取不能退回运行状态', async () => {
  const h = harness(); h.api.adoptWorkspace(workspace()); h.server.workspace = workspace();
  const pending = deferred(); h.server.hook = (c) => c.url.startsWith('/api/review-queue?') ? pending.promise : undefined;
  const reading = h.api.refreshReviewQueue(); await h.api.cancelReviewQueue();
  pending.resolve(json({ workspace: workspace('running', 8) })); assert.equal(await reading, false);
  assert.equal(h.api.state.workspace.queue.state, 'cancelling');
});
await check('提交审阅响应晚到不绑定已切换稿件，服务器任务仍不被取消', async () => {
  const h = harness(); const pending = deferred();
  h.server.hook = (c) => c.url === '/api/review' ? pending.promise : undefined;
  const starting = h.api.runReview(); await flush(); await h.api.activateItem({ id: 'B' }, { persist: false });
  pending.resolve(json({ accepted: true, ...status() })); await starting;
  assert.equal(h.api.state.sessionId, 'B'); assert.equal(h.api.binding(), null);
  assert.ok(h.calls.every((c) => c.url !== '/api/cancel-review')); assert.equal(h.api.state.issues.length, 0);
});
await check('同版本新运行不能复用旧运行的缓存问题，失效事实始终清空缓存', () => {
  const h = harness(); h.api.state.queue = [{ id: 'A', reviewRunId: 'old-run', workVersion: version(), result: result('A', 'old-run') }];
  h.api.adoptWorkspace({ ...workspace('partial', 2), entries: [{ id: 'A', status: 'partial', hasResult: true, reviewRunId: 'new-run', workVersion: version() }] });
  assert.equal(h.api.state.queue[0].result, null);
  h.api.state.queue[0].result = result('A', 'new-run');
  h.api.adoptWorkspace({ ...workspace('running', 3), entries: [{ id: 'A', status: 'reviewing', hasResult: false, reviewRunId: 'new-run', workVersion: version() }] });
  assert.equal(h.api.state.queue[0].result, null);
});
await check('暂停/继续/取消携带点击批次，旧批命令409与迟到响应不能覆盖新批', async () => {
  for (const action of ['pause', 'resume', 'cancel']) {
    const h = harness(); h.api.adoptWorkspace(workspace(action === 'resume' ? 'paused' : 'running'));
    const pending = deferred(); h.server.hook = (c) => c.url === '/api/review-queue' ? pending.promise : undefined;
    const command = h.api.requestReviewQueue(action); await flush();
    const request = h.calls.find((c) => c.url === '/api/review-queue');
    assert.equal(request.body.runId, 'q-run'); assert.equal(request.body.action, action); assert.ok(request.body.operationId);
    const latest = { ...workspace('running', 10), queue: { ...workspace().queue, runId: 'q-new' } };
    h.api.adoptWorkspace(latest); pending.resolve(json({ workspace: latest, queue: latest.queue, error: '所选批次已变化，操作未执行' }, false, 409));
    assert.equal(await command, false); assert.equal(h.api.state.workspace.queue.runId, 'q-new'); assert.equal(h.api.state.workspace.queue.state, 'running');
    assert.equal(h.api.state.queueRunning, true); assert.doesNotMatch(h.elements.get('#toast').textContent, /取消已保存|暂停后续|任务已保存/);
  }
});
await check('早批start同号重放保留command原身份，但显示当前最新批次事实', async () => {
  const h = harness(); h.api.state.workspace.queue.state = 'ready';
  const latest = { ...workspace('running', 12), queue: { ...workspace().queue, runId: 'q-latest' } };
  h.server.hook = (c) => c.url === '/api/review-queue' ? json({ workspace: latest, queue: latest.queue,
    command: { action: 'start', operationId: c.body.operationId, runId: 'q-original', replayed: true } }) : undefined;
  assert.equal(await h.api.reviewQueue(), true); assert.equal(h.api.state.workspace.queue.runId, 'q-latest');
  assert.equal(h.api.state.queueRunning, true); assert.match(h.elements.get('#toast').textContent, /较早批次.*当前/); assert.ok(h.api.queueTimer());
});
await check('批次控制断线重试保持runId与operationId，身份不符回执不得宣称成功', async () => {
  const h = harness(); let requests = 0;
  h.server.hook = (c) => c.url !== '/api/review-queue' ? undefined : ++requests === 1 ? Promise.reject(new Error('lost response'))
    : json({ workspace: workspace('running', 8), queue: workspace().queue, command: { action: c.body.action, operationId: 'wrong-operation', runId: c.body.runId } });
  assert.equal(await h.api.pauseReviewQueue(), false);
  const calls = h.calls.filter((c) => c.url === '/api/review-queue'); assert.equal(calls.length, 2);
  assert.deepEqual(plain(calls[0].body), plain(calls[1].body)); assert.equal(calls[0].body.runId, 'q-run');
  assert.match(h.api.state.queueError, /未确认.*操作身份/); assert.doesNotMatch(h.elements.get('#toast').textContent, /已暂停后续/);
});
await check('刷新恢复cancelling仍持续只读观察，到取消终态才结束', async () => {
  const h = harness(); h.server.workspace = workspace('cancelling');
  await h.api.restoreWorkspace(); assert.equal(h.api.state.queueRunning, true); assert.ok(h.api.queueTimer());
  assert.equal(h.elements.get('#btnReviewQueue').disabled, true); assert.equal(h.elements.get('#btnPauseQueue').disabled, true);
  const before = h.calls.filter((c) => c.method === 'POST').length;
  h.server.workspace = { ...workspace('cancelled', 9), queue: { ...workspace('cancelled').queue, counts: { total: 2, cancelled: 2 } } };
  await h.fire(h.api.queueTimer()); assert.equal(h.api.state.queueRunning, false); assert.equal(h.api.queueTimer(), null);
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, before); assert.match(h.elements.get('#queueList').innerHTML, /取消记录已保存/);
});
await check('旧持久暂停计划无服务器批次时显式创建新批，不发无身份resume', async () => {
  const h = harness(); h.api.state.workspace.queue = { state: 'paused', options: {} };
  await h.api.reviewQueue(); const request = h.calls.find((c) => c.url === '/api/review-queue');
  assert.equal(request.body.action, 'start'); assert.equal(request.body.runId, undefined);
});
await check('整批中断终态明确重新审阅未完成稿，创建新批而不假续原批', async () => {
  const h = harness(); h.api.adoptWorkspace(workspace('interrupted')); h.server.workspace = workspace('interrupted');
  assert.equal(h.elements.get('#btnReviewQueue').textContent, '重新审阅未完成稿');
  await h.api.reviewQueue(); const request = h.calls.find((c) => c.url === '/api/review-queue');
  assert.equal(request.body.action, 'start'); assert.equal(request.body.runId, undefined);
});
await check('单篇保存结果阶段或已结束的取消未被受理，不显示取消已保存', async () => {
  for (const phase of ['publishing', 'completed']) {
    const h = harness(); await h.api.runReview(); await flush(); h.server.statuses.set('A', status('A', phase));
    h.server.hook = (c) => c.url === '/api/cancel-review' ? json({ accepted: false, cancelled: false, cancelRequested: false,
      status: phase, publicationCommitted: phase === 'publishing' }) : undefined;
    assert.equal(await h.api.cancelCurrentReview(), false);
    assert.match(h.elements.get('#toast').textContent, phase === 'publishing' ? /结果正在提交，未执行取消/ : /任务已结束，未执行取消/);
    assert.doesNotMatch(h.elements.get('#toast').textContent, /取消请求已保存|取消记录已保存/);
    assert.equal(h.api.state.streaming, phase === 'publishing');
  }
});
await check('批量已完整结束时取消命令是明确空操作，不能称本轮已取消', async () => {
  const h = harness(); h.api.adoptWorkspace(workspace()); const completed = workspace('completed', 7);
  h.server.hook = (c) => c.url === '/api/review-queue' ? json({ workspace: completed, queue: completed.queue,
    command: { action: 'cancel', operationId: c.body.operationId, runId: c.body.runId, replayed: false } }) : undefined;
  assert.equal(await h.api.cancelReviewQueue(), false); assert.equal(h.api.state.workspace.queue.state, 'completed');
  assert.match(h.elements.get('#toast').textContent, /任务已结束，未执行取消/); assert.doesNotMatch(h.elements.get('#toast').textContent, /取消已保存/);
});
await check('服务恢复失败的明确未知能力不会降级旧协议或创建任务', async () => {
  const h = harness(); h.server.hook = (c) => c.url === '/api/health' ? json({ reviewQueueProtocol: null, reviewRecovery: { state: 'error' },
    rules: { format: 1, language: 1, citation: 1 }, models: [] }) : c.url.startsWith('/api/workspace?') ? json({ error: '审阅任务恢复失败' }, false, 503) : undefined;
  await h.api.boot(); assert.equal(h.api.state.queueSupported, null); assert.match(h.api.state.workspaceError, /恢复失败/);
  await h.api.reviewQueue(); await h.api.runReview(); assert.ok(h.calls.every((c) => c.method === 'GET'));
});
await check('批量回包已是快速终态时只读恢复新状态，清除旧建议和判定', async () => {
  const h = harness(); h.api.state.workspace.queue.state = 'ready';
  h.api.state.issues = result('A', 'old-run').issues; h.api.state.summary = { total: 1 };
  h.api.state.verdict = { label: '旧合格' }; h.api.state.recheck = { old: true }; h.api.state.humanDecisions.set('old-issue', { action: 'accept' });
  h.sandbox.document.querySelector('#btnReport').disabled = false;
  const failed = { ...workspace('failed', 8), entries: [{ ...workspace().entries[0], status: 'failed', hasResult: false }],
    queue: { ...workspace('failed').queue, counts: { total: 1, failed: 1 }, items: [{ id: 'j-A', sessionId: 'A', versionId: 'A-v0', status: 'failed' }] } };
  h.server.statuses.set('A', { ...status('A', 'failed'), human: { workVersionId: 'A-v0', reviewRunId: null, revision: 0, decisions: {}, marks: [] } });
  h.server.hook = (c) => c.url === '/api/review-queue' ? json({ workspace: failed, queue: failed.queue,
    command: { action: c.body.action, operationId: c.body.operationId, runId: 'q-run', replayed: false } }) : undefined;
  await h.api.reviewQueue(); assert.equal(h.api.state.issues.length, 0); assert.equal(h.api.state.verdict, null);
  assert.equal(h.api.state.recheck, null); assert.equal(h.api.state.humanDecisions.size, 0);
  assert.equal(h.elements.get('#btnReport').disabled, true); assert.equal(h.api.queueTimer(), null);
  assert.match(h.elements.get('#toast').textContent, /审阅失败/); assert.doesNotMatch(h.elements.get('#toast').textContent, /仍会继续/);
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 1); assert.ok(h.calls.some((c) => c.url.startsWith('/api/review-status')));
});
await check('批量结束后迟到暂停命令是空操作，不宣称后续已经暂停', async () => {
  const h = harness(); h.api.adoptWorkspace(workspace()); const completed = workspace('completed', 7);
  h.server.hook = (c) => c.url === '/api/review-queue' ? json({ workspace: completed, queue: completed.queue,
    command: { action: 'pause', operationId: c.body.operationId, runId: c.body.runId, replayed: false } }) : undefined;
  assert.equal(await h.api.pauseReviewQueue(), false); assert.equal(h.api.state.workspace.queue.state, 'completed');
  assert.match(h.elements.get('#toast').textContent, /任务已结束，未执行暂停/); assert.doesNotMatch(h.elements.get('#toast').textContent, /已暂停后续/);
});
await check('同版本新运行完成时左侧立即由旧partial更新，不等待工作台读取', () => {
  const h = terminalHarness(); const priorBatch = plain(h.api.state.workspace.queue), otherRow = plain(h.api.state.queue[1]);
  assert.match(rowMarkup(h), /部分完成/);
  const incoming = terminalStatus();
  assert.equal(h.api.showModernReviewStatus(h.binding, incoming), true);
  assert.equal(h.calls.length, 0, 'synchronous acceptance must not wait on fetch');
  assert.equal(h.api.state.queue[0].status, 'complete'); assert.equal(h.api.state.queue[0].reviewRunId, 'r-current');
  assert.deepEqual(plain(h.api.state.queue[0].result), plain(incoming.result));
  assert.deepEqual(plain(h.api.state.queue[0].opts), terminalOptions, 'options must come from the accepted result, including disabled model steps');
  assert.equal(h.api.state.queue[0].error, null, 'prior partial error must not leak into the new run');
  assert.match(rowMarkup(h), /所选步骤已结束/); assert.doesNotMatch(rowMarkup(h), /部分完成|须重审|prior incomplete/);
  assert.deepEqual(plain(h.api.state.queue[1]), otherRow); assert.deepEqual(plain(h.api.state.workspace.queue), priorBatch,
    'row projection must not rewrite authoritative batch counts or historical runs');
});
await check('真实观察器先接收终态，工作台GET仍悬挂时队列已经显示当前完成', async () => {
  const h = terminalHarness(); const pendingWorkspace = deferred();
  h.server.statuses.set('A', terminalStatus());
  h.server.hook = (call) => call.url.startsWith('/api/workspace?') ? pendingWorkspace.promise : undefined;
  h.api.startReviewObserver(h.binding); await flush();
  assert.ok(h.calls.some((call) => call.url.startsWith('/api/review-status')));
  assert.ok(h.calls.some((call) => call.url.startsWith('/api/workspace?')), 'background authoritative refresh must still run');
  const immediate = { status: h.api.state.queue[0].status, reviewRunId: h.api.state.queue[0].reviewRunId, markup: rowMarkup(h) };
  const next = { ...workspace('completed', 5), entries: [
    { id: 'A', name: 'A.docx', status: 'complete', reviewRunId: 'r-current', workVersion: version(), hasResult: true },
    { id: 'B', name: 'B.docx', status: 'ready', workVersion: version('B'), hasResult: false } ] };
  pendingWorkspace.resolve(json({ workspace: next })); await flush();
  assert.equal(h.api.state.workspace.revision, 5); assert.equal(h.api.state.queue[0].reviewRunId, 'r-current');
  assert.equal(h.api.state.queue[0].status, 'complete');
  observations.push({ scenario: 'terminal status before delayed workspace GET', immediate,
    afterWorkspaceRefresh: { status: h.api.state.queue[0].status, reviewRunId: h.api.state.queue[0].reviewRunId } });
  assert.equal(immediate.status, 'complete'); assert.match(immediate.markup, /所选步骤已结束/);
});
await check('同稿同版本旧resume读取晚返回，不能覆盖已接管的新run观察器', async () => {
  const h = terminalHarness(), pending = deferred();
  h.server.hook = (call) => call.url === '/api/review-status?id=A' ? pending.promise : undefined;
  const resuming = h.api.resumeReview({ silent: true }); await flush();
  assert.equal(h.calls.filter((call) => call.url === '/api/review-status?id=A').length, 1);
  h.api.startReviewObserver(h.binding, terminalStatus());
  const before = plain(h.api.state.queue), markup = h.elements.get('#queueList').innerHTML;
  assert.equal(h.api.binding().runId, 'r-current');
  pending.resolve(json({ ...status('A', 'partial', 'r-prior'), reviewJobId: 'j-prior' }));
  assert.equal(await resuming, false); assert.equal(h.api.binding().runId, 'r-current');
  assert.equal(h.api.state.reviewRunId, 'r-current'); assertRowUnchanged(h, before, markup);
  assert.ok(h.calls.every((call) => call.method === 'GET'), 'read-only recovery must not start or cancel either run');
});
for (const [phase, label] of [['partial', /部分完成/], ['failed', /审阅失败/], ['cancelled', /已中止/], ['interrupted', /已中断/]]) {
  await check(`${phase}终态同步保留实际状态，不被提升成完成`, () => {
    const h = terminalHarness(), incoming = terminalStatus(phase);
    assert.equal(h.api.showModernReviewStatus(h.binding, incoming), true);
    assert.equal(h.api.state.queue[0].status, phase); assert.equal(h.api.state.queue[0].reviewRunId, 'r-current');
    assert.deepEqual(plain(h.api.state.queue[0].result), plain(incoming.result));
    assert.equal(h.api.state.queue[0].error, incoming.error);
    assert.match(rowMarkup(h), label); assert.doesNotMatch(rowMarkup(h), /所选步骤已结束/); assert.equal(h.calls.length, 0);
  });
}
const statusRejects = [
  ['同版本旧run', (h, incoming) => { incoming.reviewRunId = 'r-prior'; }],
  ['错稿', (h, incoming) => { incoming.id = 'B'; }],
  ['错version', (h, incoming) => { incoming.workVersionId = 'A-v1'; }],
  ['错job', (h, incoming) => { incoming.reviewJobId = 'j-other'; }],
  ['跨workspace', (h) => { h.api.state.workspaceId = 'wother'; }],
  ['旧workspace activation', (h) => { h.api.state.workspaceSerial += 1; }],
  ['切稿activation', (h) => { h.api.state.activationSerial += 1; }],
  ['当前稿已切换', (h) => { h.api.state.sessionId = 'B'; }],
  ['当前工作version已改变', (h) => { h.api.state.workVersion = { id: 'A-v1', revision: 1 }; }],
];
for (const [name, mutate] of statusRejects) {
  await check(`${name}终态响应不得夺取已接受的队列行`, () => {
    const h = terminalHarness(), incoming = terminalStatus(); mutate(h, incoming);
    const before = plain(h.api.state.queue), markup = h.elements.get('#queueList').innerHTML;
    assert.equal(h.api.showModernReviewStatus(h.binding, incoming), false); assertRowUnchanged(h, before, markup);
    assert.equal(h.calls.length, 0);
  });
}
for (const [name, mutate] of [
  ['nested旧run', (incoming) => { incoming.result.reviewRunId = 'r-prior'; }],
  ['nested错version', (incoming) => { incoming.result.workVersionId = 'A-v1'; }],
  ['nested错session', (incoming) => { incoming.result.sessionId = 'B'; }],
  ['nested覆盖错工作version', (incoming) => { incoming.result.reviewCoverage.currentWorkVersionId = 'A-v1'; }],
]) {
  await check(`${name}结果未通过接收guard时不发布队列完成`, () => {
    const h = terminalHarness(), incoming = terminalStatus(); mutate(incoming);
    const before = plain(h.api.state.queue), markup = h.elements.get('#queueList').innerHTML;
    assert.equal(h.api.showModernReviewStatus(h.binding, incoming), false); assertRowUnchanged(h, before, markup);
  });
}
await check('当前结果不得更新列表中另一个工作版本的行', () => {
  const h = terminalHarness(); h.api.state.queue[0].workVersion = { id: 'A-v1', revision: 1 }; h.api.renderQueue();
  const before = plain(h.api.state.queue), markup = h.elements.get('#queueList').innerHTML;
  assert.equal(h.api.showModernReviewStatus(h.binding, terminalStatus()), true); assertRowUnchanged(h, before, markup);
});
function activeWorkspacePacket(active = 'reviewing', overrides = {}) {
  const entry = { id: 'A', name: 'A.docx', status: active, workVersion: version(), workVersionId: 'A-v0',
    history: { epoch: 0 }, reviewRunId: 'r-current', reviewJobId: 'j-current', hasResult: false,
    running: active !== 'queued', waiting: active === 'queued', error: 'older active packet', ...overrides };
  return { ...workspace('running', 1), entries: [entry, { id: 'B', name: 'B.docx', status: 'ready', workVersion: version('B') }] };
}
for (const active of ['queued', 'reviewing']) {
  for (const terminal of ['completed', 'partial', 'failed', 'cancelled', 'interrupted']) {
    await check(`已校验${terminal}终态不被同revision/run/version/epoch旧${active}packet退回`, () => {
      const h = terminalHarness(), accepted = terminalStatus(terminal);
      assert.equal(h.api.showModernReviewStatus(h.binding, accepted), true);
      const packet = activeWorkspacePacket(active), before = h.api.state.queue[0];
      const confirmed = { status: before.status, reviewRunId: before.reviewRunId, result: plain(before.result),
        hasResult: before.hasResult, error: before.error, running: before.running, waiting: before.waiting };
      h.api.adoptWorkspace(packet);
      const actual = h.api.state.queue[0];
      assert.equal(actual.status, terminal === 'completed' ? 'complete' : terminal);
      for (const key of ['reviewRunId', 'hasResult', 'error', 'running', 'waiting']) assert.equal(actual[key], confirmed[key]);
      assert.deepEqual(plain(actual.result), confirmed.result, 'confirmed result cache must survive only this proven older active packet');
      assert.deepEqual(plain(h.api.state.workspace.queue), plain(packet.queue), 'the batch view must still adopt its server metadata');
      assert.equal(h.api.state.workspace.revision, packet.revision); assert.equal(h.calls.length, 0);
      assert.doesNotMatch(rowMarkup(h), /等待审阅|审阅中|older active packet/);
    });
  }
}
for (const [name, overrides] of [
  ['新run', { reviewRunId: 'r-next', reviewJobId: 'j-next' }],
  ['新version', { workVersion: { id: 'A-v1', revision: 1 }, workVersionId: 'A-v1' }],
  ['新history epoch', { history: { epoch: 1 } }],
  ['未证实history epoch', { history: null }],
]) {
  await check(`${name}的进行中packet必须采用，不泛凭缓存终态阻止新事实`, () => {
    const h = terminalHarness(); assert.equal(h.api.showModernReviewStatus(h.binding, terminalStatus()), true);
    const packet = activeWorkspacePacket('queued', overrides); h.api.adoptWorkspace(packet);
    assert.equal(h.api.state.queue[0].status, 'queued'); assert.equal(h.api.state.queue[0].reviewRunId, packet.entries[0].reviewRunId);
    assert.equal(h.api.state.queue[0].workVersion.id, packet.entries[0].workVersion.id);
    assert.equal(h.api.state.queue[0].result, null); assert.equal(h.api.state.queue[0].error, 'older active packet');
    assert.match(rowMarkup(h), /等待审阅/); assert.equal(h.calls.length, 0);
  });
}
await check('仅缓存complete而未经终态接收的行，不能阻止权威进行中packet', () => {
  const h = terminalHarness(); Object.assign(h.api.state.queue[0], { status: 'complete', reviewRunId: 'r-current', history: { epoch: 0 },
    result: terminalResult(), hasResult: true, error: null }); h.api.renderQueue();
  h.api.adoptWorkspace(activeWorkspacePacket('queued'));
  assert.equal(h.api.state.queue[0].status, 'queued'); assert.equal(h.api.state.queue[0].result, null); assert.match(rowMarkup(h), /等待审阅/);
});
const gapRun='r'+'1'.repeat(64),nextGapRun='r'+'2'.repeat(64),gapWork={id:'A-v0',revision:0,sha256:'a'.repeat(64),sourceSha256:'b'.repeat(64)};
function gapHarness({visual=false,unknown=false}={}){
 const h=harness(),options={useModel:true,useRecheck:false,useContext:false,useCases:false,ruleMode:'all'},gap={target:'paragraph',index:0,part:'document.xml',pid:'p-A',sourceXmlNodeId:'document.xml:xml-p:0',sourceXmlParagraphOrdinal:0,sourcePackageSha256:gapWork.sha256,sourceVersionId:gapWork.id,objectKind:'figure',objectPath:'paragraph:0/figures/0',reason:'unparsed_visual_content',status:'pending'};
 const proof={schemaVersion:1,status:visual?'complete':'partial',manifestSha256:'c'.repeat(64),basis:'confirmed-primary-source-ranges',scope:'parsed-after-text-body-table-footnote-endnote',totals:{expectedNodes:1,completedNodes:visual?1:0,expectedUtf16:5,coveredUtf16:visual?5:2,pendingUtf16:visual?0:3,expectedTasks:2,completedTasks:visual?2:1},sourceCoverageGaps:visual?[]:[{target:'paragraph',index:0,rawStart:2,rawEnd:5,reason:'primary-not-completed'}]};
 const cov={schemaVersion:1,purpose:'verification',options,steps:{rules:{status:'completed'},model:{status:'partial'},context:{status:'disabled'},cases:{status:'disabled'},recheck:{status:'disabled'},consistency:{status:'disabled'}},executionStatus:'partial',fullTextCoverage:'partial',sourceCoverage:proof,sourceCoverageGaps:visual?[gap]:proof.sourceCoverageGaps,qualityStatus:'unverified',reviewedVersionId:gapWork.id,currentWorkVersionId:gapWork.id,currentWorkChanged:false};
 const r={...result('A',gapRun),reviewOptions:options,reviewCoverage:cov,sessionId:'A'},s={...status('A','partial',gapRun),reviewJobId:gapRun,workVersion:gapWork,result:r},sessionA={...session('A'),reviewRunId:gapRun,workVersion:gapWork,result:r,hasResult:true,doc:{...doc(),sourcePackageSha256:gapWork.sha256,paragraphs:[{id:'p-A',text:'ABCDE',part:'document.xml',sourceXmlNodeId:'document.xml:xml-p:0',sourceXmlParagraphOrdinal:0,sourcePackageSha256:gapWork.sha256}]}};
 const execution={id:'A',reviewRunId:gapRun,workVersionId:gapWork.id,execution:{requests:{blockedUnknownCount:unknown?1:0},plan:{schemaVersion:1,jobRunId:gapRun,planFingerprint:'d'.repeat(64),identity:{binding:{versionId:gapWork.id,workSha256:gapWork.sha256,sourceSha256:gapWork.sourceSha256,mutationEpoch:0}},config:{useContext:false,useCases:false,ruleMode:'all'},unknownSent:unknown?1:0,units:[0,1].map(i=>({unitId:'window:'+(i+1),parentUnitId:null,required:true,status:i===0||visual?'completed':'failed',source:{primaryRanges:[{target:'paragraph',index:0,rawStart:i?2:0,rawEnd:i?5:2}]},outputReceipt:{status:i===0||visual?'completed':'failed',inputSha256:'e'.repeat(64),outputSha256:'f'.repeat(64)}}))}}};
 h.server.sessions.set('A',sessionA);h.server.statuses.set('A',s);h.server.workspace={...workspace('paused'),entries:[{id:'A',name:'A.docx',status:'partial',reviewRunId:gapRun,reviewJobId:gapRun,workVersion:gapWork,history:{epoch:0},hasResult:true},workspace().entries[1]]};h.api.adoptWorkspace(h.server.workspace);Object.assign(h.api.state,{reviewRunId:gapRun,workVersion:gapWork,history:{epoch:0},streaming:false,queueRunning:false});
 h.server.hook=async call=>{if(call.url.startsWith('/api/review-execution?'))return json(execution);if(call.url==='/api/review-resume'){
   const next={...status('A','queued',nextGapRun),reviewJobId:nextGapRun,workVersion:gapWork};h.server.statuses.set('A',next);h.server.sessions.set('A',{...sessionA,reviewRunId:nextGapRun,result:null});h.server.workspace={...h.server.workspace,revision:2,entries:[{...h.server.workspace.entries[0],reviewRunId:nextGapRun,reviewJobId:nextGapRun,status:'queued',hasResult:false},h.server.workspace.entries[1]]};return json({accepted:true,resumedFromRunId:gapRun,...next},true,202);
 }};return{...h,execution,coverage:cov,status:s};
}
async function spinUntil(predicate){for(let i=0;i<80;i++){if(predicate())return;await flush();}throw Error('Software event did not reach its expected state');}
function fireGapClick(h,selector){h.api.renderQueue();const row=h.elements.get('#queueList').rows[0];row.events.get('click')({target:{closest:name=>name===selector?{}:null}});}
await check('未激活partial行真实点击只GET核对，不能自动提交整份或补审',async()=>{const h=gapHarness();assert.equal(typeof h.api.inspectReviewGaps,'function');assert.match(rowMarkup(h),/查看未完成项/);assert.doesNotMatch(rowMarkup(h),/重审整份|仅补审未完成文字任务/);fireGapClick(h,'.q-inspect-gaps');await spinUntil(()=>h.api.getGapInspection());assert(h.calls.length>0);assert(h.calls.every(c=>c.method==='GET'));assert.match(rowMarkup(h),/仅补审未完成文字任务/);assert(h.api.getGapInspection().action.canResumeText);});
await check('显式补审click携带原run/version/epoch与同号操作，当前控件不进入POST',async()=>{const h=gapHarness();await h.api.inspectReviewGaps('A');h.sandbox.document.querySelector('#useModel').checked=false;h.sandbox.document.querySelector('#useContext').checked=true;fireGapClick(h,'.q-resume-missing');fireGapClick(h,'.q-resume-missing');await spinUntil(()=>h.api.binding()?.runId===nextGapRun);const writes=h.calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].url,'/api/review-resume');assert.deepEqual(Object.keys(writes[0].body).sort(),['id','fromRunId','baseVersionId','baseMutationEpoch','operationId','mode'].sort());assert.equal(writes[0].body.fromRunId,gapRun);assert.equal(writes[0].body.baseVersionId,gapWork.id);assert.equal(writes[0].body.baseMutationEpoch,0);assert.equal(writes[0].body.mode,'missing-only');assert(writes[0].body.operationId);assert.equal(h.api.binding().jobId,nextGapRun);assert(h.calls.every(c=>c.url!=='/api/review'&&!c.url.startsWith('/api/review-stream')));});
await check('图片only实际查看和补审点击均不POST，不显示重审整份可修复图片',async()=>{const h=gapHarness({visual:true});await h.api.inspectReviewGaps('A');assert.equal(h.api.getGapInspection().action.visualOnly,true);assert.equal(await h.api.resumeMissingReviewTasks('A'),false);assert(h.calls.every(c=>c.method==='GET'));assert.doesNotMatch(rowMarkup(h),/q-resume-missing|重审整份/);assert.match(h.elements.get('#toast').textContent,/文字主任务已完成.*人工处理.*不会重审整份/);});
await check('unknown-sent实际补审调用仅核对记录，人工提示且零POST',async()=>{const h=gapHarness({unknown:true});assert.equal(await h.api.resumeMissingReviewTasks('A'),false);assert.equal(h.api.getGapInspection().action.code,'unknown-sent');assert.match(h.elements.get('#toast').textContent,/人工核对.*不会自动重发/);assert(h.calls.every(c=>c.method==='GET'));});
await check('补审网络重试保持同一操作身份，失败不降级整份重审',async()=>{const h=gapHarness(),base=h.server.hook;let attempts=0;h.server.hook=call=>call.url==='/api/review-resume'?++attempts===1?Promise.reject(Error('software disconnect')):json({code:'REVIEW_RESUME_CONFIG_CONFLICT',error:'原设置已变化'},false,409):base(call);assert.equal(await h.api.resumeMissingReviewTasks('A'),false);const posts=h.calls.filter(c=>c.method==='POST');assert.equal(posts.length,2);assert.deepEqual(plain(posts[0].body),plain(posts[1].body));assert(posts.every(c=>c.url==='/api/review-resume'));assert.equal(h.api.state.reviewRunId,gapRun);assert.equal(h.api.state.issues[0].issueKey,'A-issue');});
await check('检查点GET晚到切稿不能发布旧补审按钮或自动POST',async()=>{const h=gapHarness(),pending=deferred(),base=h.server.hook;h.server.hook=call=>call.url.startsWith('/api/review-execution?')?pending.promise:base(call);const inspecting=h.api.inspectReviewGaps('A');await spinUntil(()=>h.calls.some(c=>c.url.startsWith('/api/review-execution?')));await h.api.activateItem({id:'B'}, {persist:false});pending.resolve(json(h.execution));assert.equal(await inspecting,null);assert.equal(h.api.state.sessionId,'B');assert.equal(h.api.getGapInspection(),null);assert(h.calls.every(c=>c.method==='GET'));});
await check('补审POST晚到切稿不接管新稿或取消已授权后台任务',async()=>{const h=gapHarness(),pending=deferred(),base=h.server.hook;h.server.hook=call=>call.url==='/api/review-resume'?pending.promise:base(call);const submitting=h.api.resumeMissingReviewTasks('A');await spinUntil(()=>h.calls.some(c=>c.url==='/api/review-resume'));await h.api.activateItem({id:'B'}, {persist:false});pending.resolve(json({accepted:true,resumedFromRunId:gapRun,...status('A','queued',nextGapRun)},true,202));assert.equal(await submitting,false);assert.equal(h.api.state.sessionId,'B');assert.equal(h.api.binding(),null);assert(h.calls.every(c=>c.url!=='/api/cancel-review'&&c.url!=='/api/review'));});
await check('未知请求暂停原因与核对后继续可见，刷新展示不发送模型任务',async()=>{
 const h=harness(),paused=workspace('paused');paused.queue.pauseReason={code:'ARK_EXECUTION_BLOCKED',message:'software account is blocked',unknownSentCount:2};h.api.adoptWorkspace(paused);
 assert.match(h.elements.get('#queueList').innerHTML,/暂停原因：有 2 笔模型请求结果尚未确认/);assert.equal(h.elements.get('#btnReviewQueue').textContent,'核对后继续');assert.equal(h.calls.length,0);
 paused.queue.pauseReason={code:'SOFTWARE_REASON',message:'<script>software unsafe text</script>'};h.api.adoptWorkspace(paused);assert.match(h.elements.get('#queueList').innerHTML,/&lt;script&gt;/);assert.doesNotMatch(h.elements.get('#queueList').innerHTML,/<script>/);
});
await check('账户阻塞明确拒绝继续时保留暂停，不误报操作结果未知；核对完成后可正常继续',async()=>{
 const h=harness(),paused=workspace('paused'),reason={code:'ARK_EXECUTION_BLOCKED',message:'software blocked unknown requests',unknownSentCount:2};paused.queue.pauseReason=reason;h.server.workspace=paused;h.api.adoptWorkspace(paused);
 h.server.hook=c=>c.url==='/api/review-queue'?json({error:reason.message},false,409):undefined;
 assert.equal(await h.api.requestReviewQueue('resume'),false);assert.equal(h.api.state.workspace.queue.state,'paused');assert.match(h.api.state.queueError,/队列保持暂停/);assert.doesNotMatch(h.api.state.queueError,/操作结果未确认/);assert.equal(h.calls.filter(c=>c.method==='POST').length,1);assert(h.calls.filter(c=>c.method==='POST').every(c=>c.url==='/api/review-queue'));
 h.server.hook=null;h.server.workspace=workspace('paused',8);h.api.adoptWorkspace(h.server.workspace);assert.equal(h.elements.get('#btnReviewQueue').textContent,'继续批量审阅');assert.equal(await h.api.requestReviewQueue('resume'),true);assert.equal(h.api.state.workspace.queue.state,'running');
});
await check('其他409及网络失败保持操作结果未确认，不套用历史账户阻塞原因',async()=>{
 for(const network of [false,true]){const h=harness(),paused=workspace('paused');paused.queue.pauseReason={code:'ARK_EXECUTION_BLOCKED',message:'old software pause reason',unknownSentCount:2};h.api.adoptWorkspace(paused);h.server.hook=c=>c.url!=='/api/review-queue'?undefined:network?Promise.reject(Error('software lost reply')):json({error:'different software conflict'},false,409);assert.equal(await h.api.requestReviewQueue('resume'),false);assert.match(h.api.state.queueError,/操作结果未确认/);assert.equal(h.api.state.workspace.queue.state,'paused');}
});
await check('配置变更拒绝继续时采用服务器暂停原因，保留稿件并提示新建完整审阅',async()=>{
 const h=harness(),paused=workspace('paused'),updated=workspace('paused',8);
 const reason={code:'REVIEW_QUEUE_CONFIG_CHANGED',message:'有 2 份待审稿件的审核程序或配置已变化，请结束旧批次后新建完整审阅',affectedJobCount:2};
 updated.queue.pauseReason=reason;h.api.adoptWorkspace(paused);
 h.server.hook=c=>c.url==='/api/review-queue'?json({workspace:updated,error:reason.message,code:reason.code},false,409):undefined;
 assert.equal(await h.api.requestReviewQueue('resume'),false);assert.equal(h.api.state.workspace.queue.state,'paused');
 assert.deepEqual(h.api.state.workspace.queue.pauseReason,reason);assert.match(h.api.state.queueError,/队列保持暂停/);
 assert.match(h.elements.get('#queueList').innerHTML,/新建完整审阅/);assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
});
await check('不同错误身份不借配置暂停原因宣称恢复已被明确拒绝',async()=>{
 const h=harness(),paused=workspace('paused'),reason={code:'REVIEW_QUEUE_CONFIG_CHANGED',message:'software exact message'};
 paused.queue.pauseReason=reason;h.api.adoptWorkspace(paused);
 h.server.hook=c=>c.url==='/api/review-queue'?json({error:reason.message,code:'OTHER_CONFLICT'},false,409):undefined;
 assert.equal(await h.api.requestReviewQueue('resume'),false);assert.match(h.api.state.queueError,/操作结果未确认/);
});
const failed = checks.filter((c) => !c.ok);
const evidence = { generatedAt: new Date().toISOString(), sourcePath, sourceSha256: createHash('sha256').update(source).digest('hex'),
  testSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  realArkCalls: 0, servicesStarted: 0, contract: 'Close the synchronous terminal-result/async workspace-refresh display window; eventual durable queue correctness was already observed.',
  actualFunctions: ['showModernReviewStatus', 'matchingReviewStatus', 'finishReview', 'renderQueue', 'startReviewObserver', 'refreshWorkspace'],
  observations, checks, passed: checks.length - failed.length, failed: failed.length };
if (out) { guardOutput(); mkdirSync(dirname(out), { recursive: true }); guardOutput(); writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n',{flag:'wx'}); }
console.log(`服务器队列前端回归：${evidence.passed}/${checks.length} 项通过，${failed.length} 项失败（服务 0，模型 0）`);
if (failed.length) process.exitCode = 1;
