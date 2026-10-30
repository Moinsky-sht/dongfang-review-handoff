/**
 * Kill/restart a genuinely running review with an unanswered local Ark stand-in.
 * No paid API, semantic model response, real manuscript or existing app process.
 * node tools/test-review-restart.mjs --port=3297 --out=<fresh evidence JSON>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { writeZip } from '../src/zip-write.js';
import { loadSessionSnapshot } from '../src/session-store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const PORT = Number(flag('port', 3297));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || [3210, 3211, 3212].includes(PORT)) throw new Error('Use an isolated test port, never 3210/3211/3212');
const BASE = `http://127.0.0.1:${PORT}`;
const runId = randomUUID();
const OUT = resolve(ROOT, flag('out', `data/verify/review-restart-${Date.now()}-${runId.slice(0, 8)}.json`));
if (existsSync(OUT)) throw new Error('Evidence already exists. Select a fresh --out; previous evidence is never overwritten.');
const STORAGE = resolve(dirname(OUT), `review-restart-storage-${runId}`);
// The app now also owns an Ark physical-request store and a review-plan store.
// Both must live inside this run's storage, otherwise an intentionally killed
// in-flight request leaks an unknown_sent slot into the real project pool and
// permanently blocks every later model review.
const ROOTS = Object.fromEntries(['sessions', 'versions', 'workspaces', 'audit', 'legacy', 'ingestion', 'jobs',
  'ark-executions', 'review-plans'].map((kind) => [kind, join(STORAGE, kind)]));
const SESSIONS = ROOTS.sessions;
const VERSIONS = ROOTS.versions;
const NAME = `review-restart-software-${runId}.docx`;
const FAKE_KEY = 'local-restart-fixture-no-paid-key';
const FAKE_MODEL = 'local-restart-software-fixture';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function bounded(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
}
const report = { generatedAt: new Date().toISOString(), base: BASE, storage: STORAGE, roots: ROOTS,
  realArkCalls: 0, paidModelCalls: 0, meaningfulModelResponses: 0,
  providerPolicy: 'Loopback stand-in only; inherited provider credentials and Node preloads removed.',
  checks: [], processes: [], stages: [], localRequests: [] };
const check = (ok, name, details = {}) => {
  report.checks.push({ name, ok: !!ok, ...details });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};
let child = null;
let fake = null;
let fakeBase;
let streamAbort = null;
let streamTask = null;
const fakeSockets = new Set();
const ownReports = new Set();
let notifyArrival;
const arrived = new Promise((done) => { notifyArrival = done; });

function softwareFixture() {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const text = '软件重启验收正文...这是用于验证程序状态的人工生成测试文本，不作为稿件质量判断。'.repeat(8);
  return writeZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<w:document xmlns:w="${w}"><w:body><w:p><w:r><w:t>软件重启验收</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>` },
  ]);
}

async function request(path, { body, bytes } = {}) {
  const res = await fetch(BASE + path, {
    method: body || bytes ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : bytes ? { 'content-type': 'application/octet-stream' } : {},
    body: body ? JSON.stringify(body) : bytes,
    signal: AbortSignal.timeout(20000),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  let data = null;
  if (/json/i.test(res.headers.get('content-type') || '')) {
    try { data = JSON.parse(buffer.toString('utf8')); } catch { /* Assertion below records a malformed reply. */ }
  }
  if (path === '/api/report' && data?.savedTo) ownReports.add(resolve(data.savedTo));
  return { status: res.status, ok: res.ok, data, buffer };
}

async function unusedPort() {
  const probe = netServer();
  await new Promise((done, reject) => {
    probe.once('error', reject);
    probe.listen(PORT, '127.0.0.1', done);
  });
  await new Promise((done) => probe.close(done));
}

async function startFake() {
  fake = httpServer((req, res) => {
    let bytes = 0;
    req.on('data', (part) => { bytes += part.length; });
    req.on('end', () => {
      const entry = { path: req.url, method: req.method, bytes, arrivedAt: new Date().toISOString(),
        fakeCredentialMatched: req.headers.authorization === `Bearer ${FAKE_KEY}`, closedAt: null };
      report.localRequests.push(entry);
      res.once('close', () => { entry.closedAt = new Date().toISOString(); });
      notifyArrival(entry);
      // Intentionally never send headers or a semantic response. The real review
      // remains in flight until its owned app process is abruptly terminated.
    });
  });
  fake.on('connection', (socket) => { fakeSockets.add(socket); socket.once('close', () => fakeSockets.delete(socket)); });
  await new Promise((done, reject) => { fake.once('error', reject); fake.listen(0, '127.0.0.1', done); });
  fakeBase = `http://127.0.0.1:${fake.address().port}/api/v3`;
  report.fakeBase = fakeBase;
}

async function startApp() {
  await unusedPort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(?:ARK|OPENAI|DOUBAO|VOLC)/i.test(key) && !/^(?:NODE_OPTIONS|NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key) && !/^DSH_/i.test(key)));
  Object.assign(env, { PORT: String(PORT), HOST: '127.0.0.1',
    DSH_WORKING_VERSION_ROOT: VERSIONS, DSH_SESSION_ROOT: SESSIONS,
    DSH_WORKSPACE_ROOT: ROOTS.workspaces, DSH_AUDIT_ROOT: ROOTS.audit, DSH_LEGACY_ROOT: ROOTS.legacy, DSH_INGESTION_ROOT: ROOTS.ingestion,
    DSH_JOB_ROOT: ROOTS.jobs, DSH_REVIEW_WORKERS: '2',
    DSH_ARK_EXECUTION_ROOT: ROOTS['ark-executions'], DSH_REVIEW_PLAN_ROOT: ROOTS['review-plans'],
    ARK_BASE_URL: fakeBase, ARK_API_KEY: FAKE_KEY, ARK_MODEL: FAKE_MODEL,
    ARK_CONTEXT: '0', ARK_CASES: '0', ARK_CONSISTENCY: '0', ARK_PREFIX_CACHE: '0' });
  const owned = spawn(process.execPath, [resolve(ROOT, 'server.mjs')], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = owned;
  let readyLog = false; let launchError = null;
  owned.stdout.on('data', (data) => { if (data.toString().includes(`http://127.0.0.1:${PORT}`)) readyLog = true; });
  owned.stderr.on('data', () => {});
  owned.once('error', (error) => { launchError = error; });
  report.processes.push({ event: 'start', pid: owned.pid, at: new Date().toISOString() });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (owned.exitCode !== null) throw new Error(`Owned app exited before ready: ${owned.exitCode}`);
    if (readyLog) {
      try { if ((await request('/api/health')).ok) return; } catch { /* Wait for own listener only. */ }
    }
    await sleep(50);
  }
  throw new Error('Owned app did not become ready');
}

async function stopApp(reason) {
  if (!child) return;
  const owned = child;
  if (owned.exitCode === null) {
    const exited = new Promise((done) => owned.once('exit', done));
    owned.kill('SIGKILL');
    await bounded(exited, 5000, 'Owned child did not exit after termination');
    if (owned.exitCode === null && owned.signalCode === null) throw new Error('Owned child did not exit after termination');
  }
  if (child === owned) child = null;
  report.processes.push({ event: 'stop', reason, pid: owned.pid, at: new Date().toISOString(),
    exitCode: owned.exitCode, signal: owned.signalCode });
}

async function openPendingStream(id) {
  streamAbort = new AbortController();
  const query = new URLSearchParams({ id, detach: '1', useModel: 'true', useContext: 'false',
    useCases: 'false', useRecheck: 'false', model: FAKE_MODEL, ruleMode: 'all' });
  const res = await fetch(`${BASE}/api/review-stream?${query}`, { signal: streamAbort.signal });
  check(res.ok && /event-stream/i.test(res.headers.get('content-type') || ''), 'detached live review stream opens');
  if (!res.body) throw new Error('Review stream body is missing');
  const events = {};
  report.streamEvents = events;
  streamTask = (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const packet = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const event = /^event:\s*(\S+)/m.exec(packet)?.[1];
          if (event) events[event] = (events[event] || 0) + 1;
        }
      }
    } catch (error) { report.streamClosedByCrash = true; report.streamCloseType = error.name; }
    finally { reader.releaseLock(); }
  })();
}

const rulesOnly = (id) => request('/api/review', { body: { id, useModel: false, useContext: false, useCases: false, useRecheck: false } });
try {
  await startFake();
  await startApp();
  const source = softwareFixture();
  report.sourceSha256 = hash(source);
  report.sourceKind = 'Generated software fixture only';
  report.testSha256 = hash(readFileSync(fileURLToPath(import.meta.url)));
  report.serverSha256 = hash(readFileSync(resolve(ROOT, 'server.mjs')));
  report.reviewModulesSha256 = Object.fromEntries(['src/review-server.js', 'src/review-runtime.js', 'src/job-store.js'].map((name) => [name, hash(readFileSync(resolve(ROOT, name)))]));
  report.storeSha256 = hash(readFileSync(resolve(ROOT, 'src/session-store.js')));
  const uploaded = await request(`/api/upload?name=${encodeURIComponent(NAME)}`, { bytes: source });
  check(uploaded.ok && !!uploaded.data?.id, 'isolated software fixture is uploaded');
  if (!uploaded.data?.id) throw new Error('Upload did not produce an owned session');
  const id = uploaded.data.id;
  report.sessionId = id;
  const baseline = await rulesOnly(id);
  check(baseline.ok && Array.isArray(baseline.data?.issues), 'first completed review uses rules only');
  const oldFix = baseline.data?.issues?.find((issue) => issue.autoFix?.find && issue.autoFix.find !== issue.autoFix.replace);
  check(!!oldFix, 'completed baseline supplies a real mechanical fix for stale-result rejection');
  const before = await request(`/api/session?id=${id}`);
  const initialFile = await request(`/api/session-file?id=${id}`);
  const original = await request(`/api/session-file?id=${id}&original=1`);
  const savedBefore = await loadSessionSnapshot({ sessionId: id, storageRoot: SESSIONS });
  const completedRunId = savedBefore.snapshot.resultRunId;
  report.completedRunId = completedRunId;
  check(before.data?.hasResult === true && !!before.data?.result, 'completed baseline result is available before the new run');
  check(report.localRequests.length === 0, 'rules baseline made no local or paid model request');
  check(!!completedRunId && savedBefore.snapshot.reviewRecords?.some((record) => record.id === completedRunId), 'first completed review is durably archived');
  check(original.ok && hash(original.buffer) === hash(source), 'fixture original bytes are preserved');

  await openPendingStream(id);
  const receipt = await bounded(arrived, 15000, 'Local Ark request did not arrive');
  check(receipt.path === '/api/v3/responses' && receipt.method === 'POST' && receipt.fakeCredentialMatched, 'review reached the loopback Ark stand-in with only its fake key');
  const live = await request(`/api/review-status?id=${id}`);
  const savedLive = await loadSessionSnapshot({ sessionId: id, storageRoot: SESSIONS });
  const interruptedRunId = savedLive.snapshot.reviewRunId;
  report.interruptedRunId = interruptedRunId;
  report.stages.push({ label: 'genuinely-running', running: live.data?.running, phase: live.data?.progress?.phase,
    hasResult: live.data?.hasResult, hasHistoricalResult: live.data?.hasHistoricalResult,
    pendingFakeSockets: fakeSockets.size, manifestRevision: savedLive.manifest.revision });
  check(live.data?.running === true && fakeSockets.size > 0 && !receipt.closedAt && child?.exitCode === null, 'running flag is backed by a live owned process and unanswered model connection');
  check(savedLive.snapshot.reviewRunning === true && !!interruptedRunId && interruptedRunId !== completedRunId, 'in-flight run identity is persisted separately from the completed baseline');
  check(!report.streamEvents?.done, 'pending local model request never produced a completed review');
  const requestsAtCrash = report.localRequests.length;
  await stopApp('intentional in-flight crash');
  if (streamTask) await bounded(streamTask, 1000, 'Crashed review stream did not end').catch(() => {});
  await startApp();
  // Recovery confirms a dead owner first, then materializes its durable outbox.
  // Observe the actual run until publication commits; a GET must never perform
  // the interruption itself or mistake a publishing task for a finished one.
  const recoveryDeadline=Date.now()+15000;
  while(Date.now()<recoveryDeadline){
    const recovered=await request(`/api/review-status?id=${id}&runId=${encodeURIComponent(interruptedRunId)}`);
    if(recovered.data?.status==='interrupted'&&!recovered.data?.running)break;
    await sleep(25);
  }
  const restored = await request(`/api/session?id=${id}`);
  const status = await request(`/api/review-status?id=${id}`);
  report.stages.push({ label: 'restored-after-real-process-crash', sessionStatus: restored.status, running: restored.data?.running,
    interrupted: restored.data?.interrupted, error: restored.data?.error, hasResult: restored.data?.hasResult,
    hasHistoricalResult: restored.data?.hasHistoricalResult, resultIsNull: restored.data?.result === null,
    statusRunning: status.data?.running, statusHasResult: status.data?.hasResult });
  check(restored.ok && restored.data?.exists && restored.data?.running === false && status.data?.running === false, 'process restart ends the in-flight running state');
  check(restored.data?.interrupted === true && status.data?.interrupted === true && /重启|中断/.test(restored.data?.error || '') && /重启|中断/.test(status.data?.error || ''), 'both session and status explicitly report restart interruption');
  check(restored.data?.result === null && status.data?.result === null && restored.data?.hasResult === false && status.data?.hasResult === false, 'old review cannot masquerade as the interrupted current result');
  check(restored.data?.hasHistoricalResult === true && status.data?.hasHistoricalResult === true, 'historical completed evidence remains visible as historical');
  const savedRestored = await loadSessionSnapshot({ sessionId: id, storageRoot: SESSIONS });
  check(savedRestored.snapshot.reviewRecords?.some((record) => record.id === completedRunId)
    && !savedRestored.snapshot.reviewRecords?.some((record) => record.id === interruptedRunId), 'old completion survives but interrupted run is not archived as a success');
  check(savedRestored.snapshot.reviewRunning === false && savedRestored.snapshot.interrupted === true, 'interrupted terminal state itself is durable');
  const working = await request(`/api/export-working-docx?id=${id}`);
  check(working.ok && hash(working.buffer) === hash(initialFile.buffer), 'interruption still permits exact working DOCX export');
  const interruptedReport = await request('/api/report', { body: { id } });
  const interruptedComments = await request('/api/export-docx', { body: { id } });
  check(interruptedReport.status === 409 && interruptedComments.status === 409, 'report and commented export reject the unfinished run');
  const staleApply = await request('/api/apply-fixes', { body: {
    id, accepted: oldFix ? [`${oldFix.ruleId}|${oldFix.location}|${oldFix.quote || ''}`] : [],
    baseVersionId: restored.data?.workVersion?.id, baseMutationEpoch: restored.data?.history?.epoch, baseReviewRunId: completedRunId, operationId: randomUUID(),
  } });
  const afterRejectedApply = await request(`/api/session-file?id=${id}`);
  check(staleApply.status === 409 && afterRejectedApply.ok && hash(afterRejectedApply.buffer) === hash(initialFile.buffer),
    'old completed fix cannot modify the interrupted run or its working bytes');
  for (let n = 0; n < 6; n += 1) {
    await sleep(250);
    const poll = await request(`/api/review-status?id=${id}`);
    if (poll.data?.running !== false) throw new Error('Restart resumed the model run automatically');
  }
  check(report.localRequests.length === requestsAtCrash, 'restart and polling never automatically retry the model API');

  const rerun = await rulesOnly(id);
  const available = await request(`/api/session?id=${id}`);
  const availableStatus = await request(`/api/review-status?id=${id}`);
  check(rerun.ok && available.data?.hasResult === true && !!available.data?.result && available.data?.interrupted === false
    && availableStatus.data?.hasResult === true && !!availableStatus.data?.result, 'explicit rules review creates a new usable completion');
  const savedRerun = await loadSessionSnapshot({ sessionId: id, storageRoot: SESSIONS });
  check(savedRerun.snapshot.resultRunId === savedRerun.snapshot.reviewRunId && savedRerun.snapshot.resultRunId !== interruptedRunId
    && savedRerun.snapshot.reviewRecords?.some((record) => record.id === completedRunId)
    && !savedRerun.snapshot.reviewRecords?.some((record) => record.id === interruptedRunId), 'rerun completion has its own identity and preserves clean history');
  const usableReport = await request('/api/report', { body: { id } });
  const usableComments = await request('/api/export-docx', { body: { id } });
  check(usableReport.ok && usableComments.ok, 'new completion restores report and commented export availability');
  check(report.localRequests.length === requestsAtCrash && report.localRequests.every((entry) => entry.fakeCredentialMatched), 'entire fixture used only local fake requests and no semantic model response');
  report.requestCountAtCrash = requestsAtCrash;
  report.requestCountAfterRerun = report.localRequests.length;
} catch (error) {
  report.error = error.stack || String(error);
  check(false, 'restart acceptance completes', { error: error.message });
} finally {
  streamAbort?.abort();
  try { await stopApp('controller cleanup'); }
  catch (error) { report.cleanupError = error.message; check(false, 'owned app cleanup'); }
  if (fake) {
    const closed = new Promise((done) => fake.close(done));
    for (const socket of fakeSockets) socket.destroy();
    await closed;
  }
  if (streamTask) await bounded(streamTask, 1000, 'Review stream cleanup did not finish').catch(() => {});
  const expectedReport = resolve(ROOT, 'reports', NAME.replace(/\.docx$/, '') + '_审校报告.md');
  for (const ownPath of ownReports) {
    if (ownPath === expectedReport && existsSync(ownPath)) unlinkSync(ownPath);
    else report.unexpectedReportPath = ownPath;
  }
  report.localFakeRequests = report.localRequests.length;
  report.passed = report.checks.filter((entry) => entry.ok).length;
  report.failed = report.checks.filter((entry) => !entry.ok).length;
  report.finishedAt = new Date().toISOString();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(`Review restart: ${report.passed} passed / ${report.failed} failed; real Ark calls 0. ${OUT}`);
process.exitCode = report.failed ? 1 : 0;
