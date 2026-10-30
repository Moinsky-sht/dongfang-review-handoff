/** Durable ingestion UI contract regression. VM and fetch fixtures only; no browser, manuscript, or model calls. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name) => process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const sourcePath = resolve(root, flag('source') || 'public/app.js');
const outputPath = flag('out') ? resolve(root, flag('out')) : null;
if (outputPath && existsSync(outputPath)) throw new Error('Evidence exists; choose a fresh --out');
const source = readFileSync(sourcePath, 'utf8');
const startedAt = new Date().toISOString();
const checks = [];
const deferred = () => { let resolvePromise; const promise = new Promise((resolve) => { resolvePromise = resolve; }); return { promise, resolve: resolvePromise }; };
const json = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const buffer = (values = [4, 5, 6]) => new Uint8Array(values).buffer;
const file = (name = 'fixture.docx', values = [4, 5, 6]) => ({ name, size: values.length, arrayBuffer: async () => buffer(values) });
const session = (id, name = `${id}.docx`) => ({ exists: true, id, name,
  doc: { label: name, paragraphs: [{ text: 'Engineering fixture' }], footnotes: [], endnotes: [], headings: [], meta: {}, stats: {} },
  workVersion: { id: `${id}-v0`, revision: 0 }, history: { epoch: 0 }, clean: { status: 'unchanged' }, running: false, result: null });
const raw = (id = 'i1', phase = 'awaiting-file', extra = {}) => ({ id, workspaceId: 'test', operationId: `op-${id}`,
  entryId: `e-${id}`, name: 'fixture.docx', size: 3, purpose: 'editorial', status: phase,
  sourceStored: phase !== 'awaiting-file' && phase !== 'failed', canResume: !['awaiting-file', 'completed', 'failed'].includes(phase),
  needsFile: phase === 'awaiting-file', ...extra });
const entry = (ingestion, extra = {}) => ({ entryId: ingestion.entryId, ingestionId: ingestion.id, operationId: ingestion.operationId,
  name: ingestion.name, size: ingestion.size, purpose: ingestion.purpose, verificationRunId: ingestion.verificationRunId,
  canResume: ingestion.canResume, sourceStored: ingestion.sourceStored, needsFile: ingestion.needsFile,
  status: ingestion.status === 'failed' ? 'upload-failed' : ingestion.status === 'completed' ? 'ready' : ingestion.canResume ? 'upload-saving' : 'upload-pending', ...extra });

function harness({ supported = true } = {}) {
  const elements = new Map(); const stored = new Map();
  const makeElement = () => {
    const classes = new Set();
    return { dataset: {}, style: {}, childNodes: [], innerHTML: '', textContent: '', value: '', checked: false,
      disabled: false, events: new Map(), clicks: 0,
      classList: { add(...names) { names.forEach((name) => classes.add(name)); }, remove(...names) { names.forEach((name) => classes.delete(name)); },
        toggle(name, force) { const enabled = force === undefined ? !classes.has(name) : force; if (enabled) classes.add(name); else classes.delete(name); return enabled; }, contains: (name) => classes.has(name) },
      querySelector: () => null, querySelectorAll: () => [], replaceChildren(...children) { this.childNodes = children; }, appendChild() {},
      addEventListener(name, fn) { this.events.set(name, fn); }, click() { this.clicks += 1; }, focus() {}, contains: () => true };
  };
  const document = { querySelector: (selector) => { if (!elements.has(selector)) elements.set(selector, makeElement()); return elements.get(selector); },
    querySelectorAll: () => [], addEventListener() {}, createElement: makeElement };
  const sandbox = { document, window: { matchMedia: () => ({ matches: false }) }, location: { search: '?workspace=test' }, URLSearchParams,
    localStorage: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
    fetch: () => { throw new Error('Unexpected request'); }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} };
  const noops = ['renderDocInfo', 'renderMarkupIssues', 'renderMarkupStats', 'highlightIssuesInDoc', 'markHeadingLevels', 'wireCitations', 'updateApplyBtn',
    'clearMarks', 'indexRenderedParagraphs', 'markTitleParagraph', 'normalizeReaderFormatting', 'renderFigures', 'initHeadingSpy', 'setProgress',
    'setProgressBar', 'hideProgressBar', 'switchView', 'mountSettings'];
  runInNewContext(source + `\n${noops.map((name) => `${name} = () => {};`).join('\n')}
    renderDocument = async () => {};
    globalThis.api = { state, boot, importFile, importFiles, restoreWorkspace, refreshWorkspace, adoptWorkspace, renderQueue,
      createIngestion, saveIngestion, readIngestion, retryIngestion, chooseIngestionFile, selectIngestionFile, workspaceContext,
      matchingIngestion, adoptIngestionResponse, ingestionFiles, ingestionRequests, pendingSelection: () => pendingIngestionSelection };
  `, sandbox, { filename: sourcePath });
  Object.assign(sandbox.api.state, { workspaceId: 'test', workspaceSupported: true, ingestionSupported: supported,
    workspace: { id: 'test', revision: 0, entries: [], queue: {} }, queue: [], sessionId: null });
  return { sandbox, api: sandbox.api, elements, stored };
}

function fixture(h) {
  const ingestions = new Map(); const sessions = new Map(); const workspaces = new Map(); const calls = [];
  let sequence = 0;
  let hook = null;
  const workspace = (id = 'test') => {
    if (!workspaces.has(id)) workspaces.set(id, { id, revision: 0, entries: [], activeSessionId: null, queue: {} });
    const current = workspaces.get(id);
    return { ...current, entries: current.entries.map((item) => ({ ...item })) };
  };
  const persist = (ingestion, saved = null) => {
    const current = workspaces.get(ingestion.workspaceId) || (workspace(ingestion.workspaceId), workspaces.get(ingestion.workspaceId));
    const found = current.entries.findIndex((item) => item.ingestionId === ingestion.id);
    const item = entry(ingestion, saved ? { id: saved.id, workVersion: saved.workVersion, clean: saved.clean } : {});
    if (found < 0) current.entries.push(item); else current.entries[found] = item;
    current.revision += 1;
    return workspace(ingestion.workspaceId);
  };
  const payload = (ingestion) => {
    const saved = sessions.get(ingestion.id);
    return { ingestion: { ...ingestion }, workspaceRegistered: true, workspace: workspace(ingestion.workspaceId),
      ...(ingestion.status === 'completed' && saved ? { ...saved, registered: true } : {}) };
  };
  const complete = (ingestion) => {
    Object.assign(ingestion, { status: 'completed', sourceStored: true, canResume: false, needsFile: false });
    const saved = session(`s-${ingestion.id}`, ingestion.name);
    sessions.set(ingestion.id, saved); persist(ingestion, saved);
    return payload(ingestion);
  };
  const add = (ingestion) => { ingestions.set(ingestion.id, ingestion); persist(ingestion); return ingestion; };
  h.sandbox.fetch = async (url, options) => {
    const call = { url, options, method: options?.method || 'GET', body: typeof options?.body === 'string' ? JSON.parse(options.body) : options?.body };
    calls.push(call);
    assert.doesNotMatch(url, /\/api\/(?:review|ask|audit|human-records|apply-fixes|clean-session)/, 'Import recovery must not invoke review/model/mutation endpoints');
    if (hook) { const value = await hook(call); if (value !== undefined) return value; }
    if (url === '/api/health') return json({ ingestionProtocol: 1, rules: { format: 1, language: 1, citation: 1 }, models: [], arkConfigured: false });
    if (url === '/api/ingestions') {
      const body = call.body;
      let ingestion = [...ingestions.values()].find((item) => item.workspaceId === body.workspaceId && item.operationId === body.operationId);
      if (!ingestion) ingestion = add(raw(`i${++sequence}`, 'awaiting-file', { ...body }));
      return json(payload(ingestion));
    }
    if (url.startsWith('/api/ingestion?')) return json(payload(ingestions.get(new URLSearchParams(url.split('?')[1]).get('id'))));
    if (url.startsWith('/api/upload?')) {
      const ingestion = ingestions.get(options.headers['X-Ingestion-Id']);
      assert.equal(options.headers['X-Upload-Operation'], ingestion.operationId);
      assert.equal(options.headers['X-Workspace-Id'], ingestion.workspaceId);
      return json(complete(ingestion));
    }
    if (url === '/api/resume-ingestion') return json(complete(ingestions.get(call.body.id)));
    if (url.startsWith('/api/workspace?')) return json({ workspace: workspace(new URLSearchParams(url.split('?')[1]).get('id')) });
    if (url === '/api/workspace') {
      assert.notEqual(call.body.action, 'attach', 'Supported service must not separately attach uploaded sessions');
      assert.notEqual(call.body.action, 'failure', 'Supported service must not separately record an ingestion failure');
      const current = workspaces.get(call.body.id);
      current.activeSessionId = call.body.sessionId || null; current.revision += 1;
      return json({ workspace: workspace(call.body.id) });
    }
    if (url.startsWith('/api/session?')) return json([...sessions.values()].find((item) => item.id === new URLSearchParams(url.split('?')[1]).get('id')));
    if (url.startsWith('/api/session-file?')) {
      const id = new URLSearchParams(url.split('?')[1]).get('id');
      return { ok: true, headers: { get: () => `${id}-v0` }, arrayBuffer: async () => buffer([8]) };
    }
    throw new Error(`Unsupported fixture request: ${url}`);
  };
  return { calls, ingestions, sessions, workspace, payload, persist, complete, add, setHook: (fn) => { hook = fn; } };
}

async function check(name, fn) {
  try { await fn(); checks.push({ name, ok: true }); console.log(`✓ ${name}`); }
  catch (error) { checks.push({ name, ok: false, error: { message: error.message, stack: error.stack } }); console.log(`✗ ${name}: ${error.message}`); }
}

await check('明确健康能力才开启新链，旧health仍使用原上传入口', async () => {
  for (const support of [undefined, 1, '1', 2]) {
    const h = harness({ supported: false }); const server = fixture(h);
    server.setHook((call) => call.url === '/api/health' ? json({ ...(support === undefined ? {} : { ingestionProtocol: support }),
      rules: { format: 1, language: 1, citation: 1 }, models: [], arkConfigured: false }) : undefined);
    await h.api.boot();
    assert.equal(h.api.state.ingestionSupported, support === 1 ? true : support === undefined ? false : null);
  }
  const h = harness({ supported: false }); h.api.state.workspaceSupported = false;
  const calls = [];
  h.sandbox.fetch = async (url) => { calls.push(url); return json({ error: 'Fixture rejection' }, 422); };
  await h.api.importFile(file());
  assert.equal(calls.length, 1); assert.match(calls[0], /^\/api\/upload/);
  assert.equal(h.api.state.queue[0].status, 'upload-failed');
});

await check('尚未启动健康确认时能力未知，单篇和批量均禁止创建上传或登记', async () => {
  const h = harness({ supported: null }); const server = fixture(h);
  await h.api.importFile(file()); await h.api.importFiles([file('one.docx'), file('two.docx')]);
  assert.equal(h.api.state.ingestionSupported, null); assert.equal(server.calls.length, 0); assert.equal(h.api.state.queue.length, 0);
  assert.match(h.elements.get('#toast').textContent, /尚未确认.*刷新页面.*重试/);
});

await check('健康请求失败、HTTP非成功或坏JSON不会误判为旧服务，所有导入均保持禁用', async () => {
  for (const mode of ['network', 'http', 'json', 'shape']) {
    const h = harness({ supported: true }); const server = fixture(h);
    server.setHook((call) => {
      if (call.url !== '/api/health') return undefined;
      if (mode === 'network') throw new Error('Offline health');
      if (mode === 'json') return {ok: true, json: async () => { throw new Error('Broken health JSON'); }};
      if (mode === 'shape') return json({error: 'Not a health response'});
      return json({ingestionProtocol: 1, rules: {format: 1, language: 1, citation: 1}, models: []}, 503);
    });
    await h.api.boot();
    const before = server.calls.length;
    await h.api.importFile(file()); await h.api.importFiles([file('one.docx'), file('two.docx')]);
    assert.equal(h.api.state.ingestionSupported, null); assert.equal(server.calls.length, before);
    assert.equal(server.calls.filter((call) => call.method === 'POST').length, 0);
    assert.match(h.elements.get('#toast').textContent, /尚未确认.*重新连接/);
  }
});

await check('未知服务版本不能进入旧链，重新确认新版后才走同一工作台持久导入', async () => {
  for (const version of [2, '1', null, 0]) {
    const h = harness({ supported: null }); const server = fixture(h);
    server.setHook((call) => call.url === '/api/health' ? json({ingestionProtocol: version, rules: {format: 1, language: 1, citation: 1}, models: []}) : undefined);
    await h.api.boot(); const before = server.calls.length;
    await h.api.importFiles([file()]); assert.equal(h.api.state.ingestionSupported, null); assert.equal(server.calls.length, before);
    server.setHook(null); await h.api.boot(); await h.api.importFile(file());
    assert.equal(h.api.state.ingestionSupported, true); assert.equal(h.api.state.queue.length, 1);
    assert.equal(server.calls.filter((call) => call.url === '/api/ingestions').length, 1);
    assert.equal(server.calls.find((call) => call.url === '/api/ingestions').body.workspaceId, 'test');
    assert.equal(server.calls.filter((call) => call.body?.action === 'attach' || call.body?.action === 'failure').length, 0);
  }
});

await check('只有成功的旧health缺能力字段才确认兼容旧上传入口', async () => {
  const h = harness({ supported: null }); const server = fixture(h);
  server.setHook((call) => call.url === '/api/health' ? json({rules: {format: 1, language: 1, citation: 1}, models: [], arkConfigured: false}) : undefined);
  await h.api.boot(); assert.equal(h.api.state.ingestionSupported, false);
  server.setHook((call) => call.url.startsWith('/api/upload') ? json({error: 'Legacy fixture refusal'}, 422)
    : call.url === '/api/workspace' && call.body?.action === 'failure' ? json({workspace: server.workspace('test')}) : undefined);
  await h.api.importFile(file());
  assert.equal(server.calls.filter((call) => call.url.startsWith('/api/upload')).length, 1);
  assert.equal(server.calls.filter((call) => call.url === '/api/ingestions').length, 0);
  assert.equal(server.calls.find((call) => call.url.startsWith('/api/upload')).options.headers, undefined);
});

await check('既有pending在健康能力未知时只查询原状态，不创建别的操作或续存', async () => {
  const h = harness({ supported: null }); const server = fixture(h); server.add(raw('pending', 'source-stored'));
  await h.api.restoreWorkspace(); const before = server.calls.length; const item = h.api.state.queue[0];
  await h.api.retryIngestion(item);
  const attempted = server.calls.slice(before);
  assert.equal(attempted.length, 1); assert.match(attempted[0].url, /^\/api\/ingestion\?id=pending$/);
  assert.equal(attempted[0].method, 'GET'); assert.equal(h.api.state.queue.length, 1);
  assert.equal(h.api.state.queue[0].operationId, 'op-pending'); assert.equal(server.ingestions.size, 1);
  assert.match(h.elements.get('#toast').textContent, /尚未确认.*重试/);
  server.setHook(null); await h.api.boot(); await h.api.retryIngestion(h.api.state.queue[0]);
  assert.equal(h.api.state.queue[0].status, 'ready');
  assert.equal(server.calls.filter((call) => call.url === '/api/ingestions').length, 0);
  assert.equal(server.calls.filter((call) => call.url === '/api/resume-ingestion').length, 1);
});

await check('健康确认未完成时导入等待，不抢先走旧链', async () => {
  const h = harness({ supported: false }); const server = fixture(h); const health = deferred();
  server.setHook((call) => call.url === '/api/health' ? health.promise : undefined);
  const booting = h.api.boot(); const importing = h.api.importFile(file());
  assert.equal(server.calls.length, 1);
  health.resolve(json({ ingestionProtocol: 1, rules: { format: 1, language: 1, citation: 1 }, models: [], arkConfigured: false }));
  await booting; await importing;
  assert.ok(server.calls.some((call) => call.url === '/api/ingestions'));
});

await check('单篇先持久意图再传bytes，验证目的、身份headers、完成原子登记', async () => {
  const h = harness(); const server = fixture(h); h.sandbox.location.search = '?workspace=test&verification=verify-engineering';
  await h.api.importFile(file());
  assert.equal(server.calls[0].url, '/api/ingestions');
  assert.equal(server.calls[0].body.purpose, 'verification'); assert.equal(server.calls[0].body.verificationRunId, 'verify-engineering');
  assert.equal(server.calls[0].body.size, 3);
  const upload = server.calls.find((call) => call.url.startsWith('/api/upload'));
  assert.equal(upload.options.headers['X-Upload-Operation'], server.calls[0].body.operationId);
  assert.ok(upload.options.headers['X-Ingestion-Id']); assert.equal(h.api.state.queue.length, 1);
  assert.equal(h.api.state.queue[0].queueUnsaved, false); assert.equal(h.api.state.sessionId, 's-i1');
});

await check('批量每篇独立意图与操作号，每篇只建一行且不二次attach', async () => {
  const h = harness(); const server = fixture(h);
  await h.api.importFiles([file('one.docx'), file('two.docx')]);
  const intents = server.calls.filter((call) => call.url === '/api/ingestions');
  assert.equal(intents.length, 2); assert.notEqual(intents[0].body.operationId, intents[1].body.operationId);
  assert.equal(h.api.state.queue.length, 2); assert.ok(h.api.state.queue.every((item) => item.status === 'ready'));
  assert.equal(h.api.state.sessionId, 's-i1');
});

await check('三篇批量先按选择顺序确认全部意图，之后才读取任何File或上传body', async () => {
  const h = harness(); const server = fixture(h); const timeline = [];
  const files = ['one.docx', 'two.docx', 'three.docx'].map((name) => ({ name, size: 3, arrayBuffer: async () => {
    timeline.push(`read:${name}`); return buffer();
  } }));
  server.setHook((call) => { if (call.url === '/api/ingestions') timeline.push(`intent:${call.body.name}`);
    else if (call.url.startsWith('/api/upload')) timeline.push(`upload:${new URLSearchParams(call.url.split('?')[1]).get('name')}`); });
  await h.api.importFiles(files);
  assert.deepEqual(timeline.slice(0, 3), ['intent:one.docx', 'intent:two.docx', 'intent:three.docx']);
  assert.equal(timeline.indexOf('read:one.docx'), 3);
  assert.ok(timeline.indexOf('upload:one.docx') > timeline.indexOf('intent:three.docx'));
  assert.deepEqual(server.workspace().entries.map((item) => item.name), ['one.docx', 'two.docx', 'three.docx']);
  assert.equal(server.ingestions.size, 3); assert.equal(server.sessions.size, 3);
});

await check('首篇保存中关闭页面时其余两篇意图已持久，reload明确待重新选择且不读旧File', async () => {
  const h = harness(); const server = fixture(h); const delayed = deferred(); const read = [];
  const files = ['one.docx', 'two.docx', 'three.docx'].map((name) => ({ name, size: 3, arrayBuffer: async () => { read.push(name); return buffer(); } }));
  server.setHook((call) => call.url.startsWith('/api/upload') ? delayed.promise : undefined);
  const importing = h.api.importFiles(files);
  while (!server.calls.some((call) => call.url.startsWith('/api/upload'))) await Promise.resolve();
  assert.equal(server.ingestions.size, 3); assert.deepEqual(read, ['one.docx']);
  assert.deepEqual(server.workspace().entries.map((item) => item.name), ['one.docx', 'two.docx', 'three.docx']);
  const first = server.ingestions.get('i1');
  Object.assign(first, { status: 'source-stored', sourceStored: true, canResume: true, needsFile: false }); server.persist(first);
  h.api.state.workspaceSerial += 1; // The old page's continuation has been abandoned.
  delayed.resolve(json({ ...server.payload(first), error: 'Fixture saved-source interruption' }, 500)); await importing;
  assert.equal(server.calls.filter((call) => call.url.startsWith('/api/upload')).length, 1);
  assert.deepEqual(read, ['one.docx']);
  const restored = harness(); const restoredCalls = [];
  restored.sandbox.fetch = async (url, options) => {
    restoredCalls.push({ url, method: options?.method || 'GET' });
    if (url.startsWith('/api/workspace?')) return json({ workspace: server.workspace() });
    if (url.startsWith('/api/ingestion?')) return json(server.payload(server.ingestions.get(new URLSearchParams(url.split('?')[1]).get('id'))));
    throw new Error('Reload must not save a file or start a review automatically');
  };
  await restored.api.restoreWorkspace();
  assert.equal(restored.api.state.queue.length, 3); assert.equal(restored.api.ingestionFiles.size, 0);
  assert.equal(restored.api.state.queue[0].canResume, true);
  assert.ok(restored.api.state.queue.slice(1).every((item) => item.status === 'upload-pending' && item.needsFile && !item.id));
  await restored.api.retryIngestion(restored.api.state.queue[1]);
  assert.ok(restoredCalls.every((call) => call.method === 'GET'));
  assert.match(restored.elements.get('#toast').textContent, /重新选择文件/);
  assert.equal(server.ingestions.size, 3);
});

await check('批量File body读取失败仍保留全部已登记待文件身份，不伪记失败或丢后续行', async () => {
  const h = harness(); const server = fixture(h); const readers = [];
  const files = ['one.docx', 'two.docx', 'three.docx'].map((name) => ({ name, size: 3, arrayBuffer: async () => {
    readers.push({ name, intentCount: server.ingestions.size }); throw new Error('Fixture body is unavailable');
  } }));
  await h.api.importFiles(files);
  assert.ok(readers.length >= 3); assert.ok(readers.every((item) => item.intentCount === 3));
  assert.equal(server.calls.filter((call) => call.url.startsWith('/api/upload')).length, 0);
  assert.equal(server.calls.filter((call) => call.url === '/api/ingestions').length, 3);
  assert.equal(h.api.state.queue.length, 3);
  assert.deepEqual(Array.from(h.api.state.queue, (item) => item.name), ['one.docx', 'two.docx', 'three.docx']);
  assert.ok(h.api.state.queue.every((item) => item.status === 'upload-pending' && item.needsFile && !item.id && !item.queueUnsaved));
  assert.equal(new Set(h.api.state.queue.map((item) => item.operationId)).size, 3);
});

await check('批量某篇意图未确认时只保存已确认文件，提示缺失登记且不假造一行', async () => {
  const h = harness(); const server = fixture(h); const reads = []; const notices = [];
  Object.defineProperty(h.sandbox.document.querySelector('#toast'), 'textContent', { get: () => notices.at(-1) || '', set: (value) => notices.push(value) });
  server.setHook((call) => call.url === '/api/ingestions' && call.body.name === 'two.docx' ? json({ error: 'Fixture intent not registered' }, 422) : undefined);
  await h.api.importFiles(['one.docx', 'two.docx', 'three.docx'].map((name) => ({ name, size: 3, arrayBuffer: async () => { reads.push(name); return buffer(); } })));
  assert.deepEqual(reads, ['one.docx', 'three.docx']); assert.equal(server.ingestions.size, 2);
  assert.ok(!h.api.state.queue.some((item) => item.name === 'two.docx'));
  assert.ok(notices.some((message) => /two\.docx.*登记尚未确认/.test(message)));
  assert.match(notices.at(-1), /2\/3.*1 篇导入登记尚未确认.*刷新/);
  const failedIntents = server.calls.filter((call) => call.url === '/api/ingestions' && call.body.name === 'two.docx');
  assert.equal(failedIntents.length, 2); assert.equal(failedIntents[0].options.body, failedIntents[1].options.body);
});

await check('批量metadata登记中途切换工作台停止旧context，不读body或污染新队列', async () => {
  const h = harness(); const server = fixture(h); const delayed = deferred(); const reads = []; let waiting = false;
  server.setHook((call) => {
    if (call.url !== '/api/ingestions' || call.body.name !== 'two.docx') return undefined;
    server.add(raw('late', 'awaiting-file', { ...call.body })); waiting = true; return delayed.promise;
  });
  const importing = h.api.importFiles(['one.docx', 'two.docx', 'three.docx'].map((name) => ({ name, size: 3, arrayBuffer: async () => { reads.push(name); return buffer(); } })));
  while (!waiting) await Promise.resolve();
  h.api.state.workspaceId = 'other'; h.api.state.workspaceSerial += 1;
  h.api.state.workspace = { id: 'other', revision: 0, entries: [] }; h.api.state.queue = []; h.api.state.sessionId = 'other-session';
  delayed.resolve(json(server.payload(server.ingestions.get('late')))); await importing;
  assert.equal(server.calls.filter((call) => call.url === '/api/ingestions').length, 2);
  assert.equal(server.calls.filter((call) => call.url.startsWith('/api/upload')).length, 0); assert.deepEqual(reads, []);
  assert.equal(h.api.state.queue.length, 0); assert.equal(h.api.state.sessionId, 'other-session');
  assert.deepEqual(server.workspace('test').entries.map((item) => item.name), ['one.docx', 'two.docx']);
});

await check('同工作台metadata登记期间切稿保留全部导入，但完成后不夺回当前稿', async () => {
  const h = harness(); const server = fixture(h); let changed = false;
  server.setHook((call) => {
    if (call.url === '/api/ingestions' && call.body.name === 'two.docx' && !changed) {
      changed = true; h.api.state.sessionId = 'selected-elsewhere'; h.api.state.activationSerial += 1;
    }
  });
  await h.api.importFiles([file('one.docx'), file('two.docx'), file('three.docx')]);
  assert.equal(server.ingestions.size, 3); assert.equal(server.sessions.size, 3); assert.equal(h.api.state.queue.length, 3);
  assert.equal(h.api.state.sessionId, 'selected-elsewhere');
  assert.equal(server.calls.filter((call) => call.url.startsWith('/api/session?')).length, 0);
});

await check('新链File替身缺size时从本人bytes算safe size，并复用同buffer上传', async () => {
  const h = harness(); const server = fixture(h); let reads = 0;
  await h.api.importFile({ name: 'fixture.docx', arrayBuffer: async () => { reads += 1; return buffer(); } });
  assert.equal(server.calls[0].body.size, 3); assert.equal(reads, 1); assert.equal(h.api.state.queue[0].status, 'ready');
});

await check('意图响应丢失重放完全同body与operation，不再建行', async () => {
  const h = harness(); const server = fixture(h); let first = true;
  server.setHook((call) => {
    if (call.url !== '/api/ingestions' || !first) return undefined;
    first = false; server.add(raw('lost', 'awaiting-file', { ...call.body })); throw new Error('Lost intent response');
  });
  await h.api.importFile(file());
  const intents = server.calls.filter((call) => call.url === '/api/ingestions');
  assert.equal(intents.length, 2); assert.equal(intents[0].options.body, intents[1].options.body);
  assert.equal(server.ingestions.size, 1); assert.equal(h.api.state.queue.length, 1); assert.equal(h.api.state.sessionId, 's-lost');
});

await check('上传完成响应丢失先查询完成事实，不重传、不重复会话或失败行', async () => {
  const h = harness(); const server = fixture(h);
  server.setHook((call) => {
    if (!call.url.startsWith('/api/upload')) return undefined;
    server.complete(server.ingestions.get(call.options.headers['X-Ingestion-Id'])); throw new Error('Lost completed response');
  });
  await h.api.importFile(file());
  assert.equal(server.calls.filter((call) => call.url.startsWith('/api/upload')).length, 1);
  assert.ok(server.calls.some((call) => call.url.startsWith('/api/ingestion?')));
  assert.equal(h.api.state.queue.length, 1); assert.equal(h.api.state.queue[0].status, 'ready');
});

await check('尚未存bytes的网络重试先查状态，再复用同buffer和三个身份headers', async () => {
  const h = harness(); const server = fixture(h); let first = true;
  server.setHook((call) => { if (!call.url.startsWith('/api/upload') || !first) return undefined; first = false; throw new Error('No response'); });
  await h.api.importFile(file());
  const uploads = server.calls.filter((call) => call.url.startsWith('/api/upload'));
  assert.equal(uploads.length, 2); assert.equal(uploads[0].options.body, uploads[1].options.body);
  assert.deepEqual(uploads[0].options.headers, uploads[1].options.headers);
  const firstAt = server.calls.indexOf(uploads[0]); assert.match(server.calls[firstAt + 1].url, /^\/api\/ingestion\?/);
  assert.equal(server.sessions.size, 1);
});

await check('bytes已存而响应丢失走resume，续存请求再次丢失可查回完成', async () => {
  const h = harness(); const server = fixture(h);
  server.setHook((call) => {
    if (call.url.startsWith('/api/upload')) {
      const ingestion = server.ingestions.get(call.options.headers['X-Ingestion-Id']);
      Object.assign(ingestion, { status: 'source-stored', sourceStored: true, canResume: true, needsFile: false });
      server.persist(ingestion); throw new Error('Lost saved-source response');
    }
    if (call.url === '/api/resume-ingestion') { server.complete(server.ingestions.get(call.body.id)); throw new Error('Lost resumed response'); }
  });
  await h.api.importFile(file());
  assert.equal(server.calls.filter((call) => call.url.startsWith('/api/upload')).length, 1);
  assert.equal(server.calls.filter((call) => call.url === '/api/resume-ingestion').length, 1);
  assert.equal(h.api.state.queue[0].status, 'ready');
});

await check('网络和状态查询都失败保留服务器pending，不假记失败或新建行', async () => {
  const h = harness(); const server = fixture(h);
  server.setHook((call) => { if (call.url.startsWith('/api/upload') || call.url.startsWith('/api/ingestion?')) throw new Error('Offline'); });
  await h.api.importFile(file());
  assert.equal(h.api.state.queue.length, 1); assert.equal(h.api.state.queue[0].status, 'upload-pending');
  assert.equal(h.api.state.queue[0].queueUnsaved, false);
  assert.match(h.elements.get('#queueList').innerHTML, /重新选择文件|确认保存状态/);
  assert.doesNotMatch(h.elements.get('#queueList').innerHTML, /ingestion|operationId|协议|仅保存在本地/);
  assert.equal(server.calls.filter((call) => call.url === '/api/ingestions').length, 1);
});

await check('reload恢复pending/saving/failed，未自动续存或调用审阅', async () => {
  const h = harness(); const server = fixture(h);
  server.add(raw('pending')); server.add(raw('saving', 'version-saved')); server.add(raw('bad', 'failed'));
  await h.api.restoreWorkspace();
  assert.equal(h.api.state.queue.length, 3); assert.equal(server.calls.length, 1);
  assert.ok(h.api.state.queue.every((item) => !item.id));
  const html = h.elements.get('#queueList').innerHTML;
  assert.match(html, /需重新选择文件/); assert.match(html, /继续保存/); assert.match(html, /导入失败/);
  assert.doesNotMatch(html, /重审整份|重试登记|仅保存在本地|协议/);
});

await check('reload后pending无File只读核对并明确重新选择，不发upload/resume', async () => {
  const h = harness(); const server = fixture(h); server.add(raw('pending'));
  await h.api.restoreWorkspace(); await h.api.retryIngestion(h.api.state.queue[0]);
  assert.equal(server.calls.filter((call) => call.url.startsWith('/api/ingestion?')).length, 1);
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 0);
  assert.match(h.elements.get('#toast').textContent, /尚未保存原始文件.*重新选择文件/);
});

await check('pending重新选择绑定原ingestion和operation，同一行继续上传', async () => {
  const h = harness(); const server = fixture(h); server.add(raw('pending'));
  await h.api.restoreWorkspace(); const item = h.api.state.queue[0];
  h.api.chooseIngestionFile(item); await h.api.selectIngestionFile([file()]);
  const upload = server.calls.find((call) => call.url.startsWith('/api/upload'));
  assert.equal(upload.options.headers['X-Ingestion-Id'], 'pending'); assert.equal(upload.options.headers['X-Upload-Operation'], 'op-pending');
  assert.equal(server.calls.filter((call) => call.url === '/api/ingestions').length, 0); assert.equal(h.api.state.queue.length, 1);
});

await check('reload后raw已保存继续保存不需要File，仅query+resume', async () => {
  for (const phase of ['source-stored', 'version-saved', 'session-saved', 'workspace-attached']) {
    const h = harness(); const server = fixture(h); server.add(raw('saving', phase));
    await h.api.restoreWorkspace(); await h.api.retryIngestion(h.api.state.queue[0]);
    assert.equal(server.calls.filter((call) => call.url === '/api/resume-ingestion').length, 1);
    assert.equal(server.calls.filter((call) => call.url.startsWith('/api/upload')).length, 0);
    assert.equal(h.api.state.queue[0].status, 'ready');
  }
});

await check('存盘失败保留canResume行，手动续存完成，不另外登记失败', async () => {
  const h = harness(); const server = fixture(h);
  server.setHook((call) => {
    if (!call.url.startsWith('/api/upload')) return undefined;
    const ingestion = server.ingestions.get(call.options.headers['X-Ingestion-Id']);
    Object.assign(ingestion, { status: 'version-saved', sourceStored: true, canResume: true, needsFile: false });
    server.persist(ingestion); return json({ ...server.payload(ingestion), error: 'Fixture disk write failure' }, 500);
  });
  await h.api.importFile(file());
  assert.equal(h.api.state.queue[0].status, 'upload-saving'); assert.equal(server.sessions.size, 0);
  await h.api.retryIngestion(h.api.state.queue[0]);
  assert.equal(h.api.state.queue.length, 1); assert.equal(h.api.state.queue[0].status, 'ready');
});

await check('422持久失败仅保留官方失败行，不能resume或假报成功', async () => {
  const h = harness(); const server = fixture(h);
  server.setHook((call) => {
    if (!call.url.startsWith('/api/upload')) return undefined;
    const ingestion = server.ingestions.get(call.options.headers['X-Ingestion-Id']);
    Object.assign(ingestion, { status: 'failed', sourceStored: true, canResume: false, needsFile: false });
    server.persist(ingestion); return json({ ...server.payload(ingestion), error: 'Invalid fixture document', clean: { status: 'failed', reason: 'Fixture validation' } }, 422);
  });
  await h.api.importFile(file()); await h.api.retryIngestion(h.api.state.queue[0]);
  assert.equal(h.api.state.queue.length, 1); assert.equal(h.api.state.queue[0].status, 'upload-failed'); assert.equal(h.api.state.sessionId, null);
  assert.equal(server.calls.filter((call) => call.url === '/api/resume-ingestion').length, 0);
  assert.match(h.elements.get('#queueList').innerHTML, /重新导入/); assert.doesNotMatch(h.elements.get('#toast').textContent, /已保存并登记/);
});

await check('不同名称或同名不同bytes不能复用pending操作，无请求也无重复行', async () => {
  const h = harness(); const server = fixture(h); server.add(raw('pending'));
  await h.api.restoreWorkspace(); const item = h.api.state.queue[0];
  h.api.chooseIngestionFile(item); await h.api.selectIngestionFile([file('other.docx')]);
  const before = server.calls.length;
  assert.match(h.elements.get('#toast').textContent, /不符/);
  h.api.ingestionFiles.set('test:pending', { ...h.api.workspaceContext(), ingestionId: 'pending', operationId: 'op-pending', name: item.name, size: 3,
    file: file(), buffer: buffer() });
  h.api.chooseIngestionFile(item); await h.api.selectIngestionFile([file('fixture.docx', [7, 8, 9])]);
  assert.equal(server.calls.length, before); assert.match(h.elements.get('#toast').textContent, /内容已改变/);
  assert.equal(h.api.state.queue.length, 1);
});

await check('服务器同operation不同body拒绝保留同一行，不伪造failed或创建新意图', async () => {
  const h = harness(); const server = fixture(h); server.add(raw('pending'));
  await h.api.restoreWorkspace(); const item = h.api.state.queue[0];
  server.setHook((call) => call.url.startsWith('/api/upload') ? json({ ...server.payload(server.ingestions.get('pending')), error: 'Operation body conflict' }, 409) : undefined);
  h.api.chooseIngestionFile(item); await h.api.selectIngestionFile([file()]);
  assert.equal(h.api.state.queue.length, 1); assert.equal(h.api.state.queue[0].status, 'upload-pending');
  assert.equal(server.calls.filter((call) => call.url === '/api/ingestions').length, 0);
  assert.match(h.elements.get('#toast').textContent, /conflict/);
});

await check('跨工作台迟到响应不能污染当前队列或激活稿件', async () => {
  const h = harness(); const server = fixture(h); const delayed = deferred();
  server.setHook((call) => call.url.startsWith('/api/upload') ? delayed.promise : undefined);
  const importing = h.api.importFile(file());
  while (!server.calls.some((call) => call.url.startsWith('/api/upload'))) await Promise.resolve();
  h.api.state.workspaceId = 'other'; h.api.state.workspaceSerial += 1;
  h.api.state.workspace = { id: 'other', revision: 0, entries: [] }; h.api.state.queue = []; h.api.state.sessionId = 'other-session';
  delayed.resolve(json(server.complete(server.ingestions.get('i1')))); await importing;
  assert.equal(h.api.state.workspaceId, 'other'); assert.equal(h.api.state.sessionId, 'other-session'); assert.equal(h.api.state.queue.length, 0);
  assert.equal(server.calls.filter((call) => call.url.startsWith('/api/session?')).length, 0);
});

await check('workspace ABA变化后旧文件选择绑定失效，不上传到同名新上下文', async () => {
  const h = harness(); const server = fixture(h); server.add(raw('pending'));
  await h.api.restoreWorkspace(); h.api.chooseIngestionFile(h.api.state.queue[0]);
  h.api.state.workspaceId = 'other'; h.api.state.workspaceSerial += 1;
  h.api.state.workspaceId = 'test'; h.api.state.workspaceSerial += 1;
  await h.api.selectIngestionFile([file()]);
  assert.equal(server.calls.length, 1); assert.match(h.elements.get('#toast').textContent, /工作台已切换/);
});

await check('同工作台切稿后的完成响应可更新所属行，不能覆盖当前稿件', async () => {
  const h = harness(); const server = fixture(h); const delayed = deferred();
  server.setHook((call) => call.url.startsWith('/api/upload') ? delayed.promise : undefined);
  const importing = h.api.importFile(file());
  while (!server.calls.some((call) => call.url.startsWith('/api/upload'))) await Promise.resolve();
  h.api.state.sessionId = 'selected-elsewhere'; h.api.state.activationSerial += 1;
  delayed.resolve(json(server.complete(server.ingestions.get('i1')))); await importing;
  assert.equal(h.api.state.sessionId, 'selected-elsewhere'); assert.equal(h.api.state.queue[0].id, 's-i1');
  assert.equal(server.calls.filter((call) => call.url.startsWith('/api/session?')).length, 0);
});

await check('错误ingestion身份返回不能采用别的稿件结果', async () => {
  const h = harness(); const server = fixture(h);
  server.setHook((call) => call.url.startsWith('/api/upload') || call.url.startsWith('/api/ingestion?')
    ? json({ ...session('wrong'), registered: true, ingestion: raw('wrong', 'completed', { operationId: 'different', sourceStored: true }) }) : undefined);
  await h.api.importFile(file());
  assert.equal(h.api.state.sessionId, null); assert.equal(h.api.state.queue.length, 1);
  assert.equal(h.api.state.queue[0].ingestionId, 'i1'); assert.equal(h.api.state.queue[0].id, undefined);
});

await check('同操作号的name/size/purpose不符响应不能被采用', () => {
  const h = harness();
  const owner = { ...h.api.workspaceContext(), ingestionId: 'i1', operationId: 'op-i1', name: 'fixture.docx', size: 3, purpose: 'editorial' };
  for (const changed of [{ name: 'different.docx' }, { size: 7 }, { purpose: 'verification', verificationRunId: 'other-run' }]) {
    assert.equal(h.api.matchingIngestion(owner, { ingestion: raw('i1', 'awaiting-file', changed) }), false);
  }
});

await check('读取File失败后仍是durable pending，重新选择可换可读File继续同操作', async () => {
  const h = harness(); const server = fixture(h);
  await h.api.importFile({ name: 'fixture.docx', size: 3, arrayBuffer: async () => { throw new Error('Fixture cannot read'); } });
  assert.equal(h.api.state.queue[0].status, 'upload-pending');
  h.api.chooseIngestionFile(h.api.state.queue[0]); await h.api.selectIngestionFile([file()]);
  assert.equal(h.api.state.queue.length, 1); assert.equal(h.api.state.queue[0].status, 'ready');
  assert.equal(server.calls.filter((call) => call.url === '/api/ingestions').length, 1);
});

await check('旧pending快照不能回滚已完成行，旧完成字节不能覆盖后续人工工作版本', () => {
  const h = harness(); const server = fixture(h); const ingestion = server.add(raw('i1'));
  const completed = server.complete(ingestion);
  const owner = { ...h.api.workspaceContext(), ingestionId: 'i1', operationId: 'op-i1', name: 'fixture.docx', size: 3, purpose: 'editorial' };
  h.api.adoptIngestionResponse(owner, completed);
  const item = h.api.state.queue[0];
  item.history = { epoch: 5 }; item.workVersion = { id: 'later-v4', revision: 4 }; item.doc = { label: 'Later engineering version' };
  const laterDoc = item.doc;
  h.api.state.workspace.revision = 10;
  assert.equal(h.api.adoptIngestionResponse(owner, { ingestion: raw('i1'), workspace: { id: 'test', revision: 1, entries: [entry(raw('i1'))] } }), false);
  assert.equal(item.status, 'ready'); assert.equal(item.id, 's-i1');
  h.api.adoptIngestionResponse(owner, completed);
  assert.equal(item.doc, laterDoc); assert.equal(item.history.epoch, 5); assert.equal(item.workVersion.id, 'later-v4');
});

const report = { startedAt, finishedAt: new Date().toISOString(), sourcePath,
  sourceSha256: createHash('sha256').update(source).digest('hex'), total: checks.length,
  testSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  passed: checks.filter((item) => item.ok).length, failed: checks.filter((item) => !item.ok).length,
  noRealNetwork: true, noBrowser: true, noPaidModel: true, checks };
if (outputPath) { mkdirSync(dirname(outputPath), { recursive: true }); writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n'); }
console.log(`Ingestion UI regression: ${report.passed}/${report.total}; VM fixtures only, no paid models.`);
if (report.failed) process.exitCode = 1;
