/** Isolated workspace/human HTTP acceptance. Software fixtures only.
 * node tools/test-workspace-human.mjs --port=3310 --out=<fresh JSON evidence>
 * Rules supply all completed results. A never-answering loopback provider is
 * used only to prove a genuinely running task survives a real process crash as
 * interrupted, without a paid request or semantic response.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { writeZip } from '../src/zip-write.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const PORT = Number(flag('port', 3310));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || [3210, 3211, 3212].includes(PORT)) throw new Error('Use an isolated test port; never an existing main service');
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_ID = randomUUID();
const OUT = resolve(ROOT, flag('out', `data/verify/workspace-human-${Date.now()}-${TEST_ID.slice(0, 8)}.json`));
if (existsSync(OUT)) throw new Error('Choose a fresh --out; prior evidence cannot be overwritten');
const STORAGE = resolve(dirname(OUT), `workspace-human-storage-${TEST_ID}`);
const ROOTS = Object.fromEntries(['sessions', 'versions', 'workspaces', 'audit', 'legacy', 'ingestion', 'jobs', 'arkExecutions', 'reviewPlans'].map((kind) => [kind, join(STORAGE, kind)]));
const WORKSPACE_ID = `w${TEST_ID.replace(/-/g, '')}`;
const FAKE_KEY = 'local-workspace-software-only-no-paid-key';
const FAKE_MODEL = 'local-workspace-software-fixture';
const hash = (x) => createHash('sha256').update(x).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyOf = (x) => x.issueKey || `${x.ruleId}|${x.location}|${x.quote || ''}`;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const report = { generatedAt: new Date().toISOString(), base: BASE, storage: STORAGE, roots: ROOTS, workspaceId: WORKSPACE_ID, verificationRunId: TEST_ID,
  sourceKind: 'Generated software fixtures only', realArkCalls: 0, paidModelCalls: 0, meaningfulModelResponses: 0,
  checks: [], stages: [], processes: [], localRequests: [] };
const check = (ok, name, details = {}) => { report.checks.push({ name, ok: !!ok, ...details }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
const must = (ok, name, details = {}) => { check(ok, name, details); if (!ok) throw new Error(name); };
let app = null, fake = null, fakeBase = null, streamAbort = null, streamTask = null;
let notifyFake;
const fakeArrived = new Promise((done) => { notifyFake = done; });
const fakeSockets = new Set();
async function bounded(promise, timeout, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(message)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function request(path, { body, bytes } = {}) {
  const response = await fetch(BASE + path, { method: body || bytes ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : bytes ? { 'content-type': 'application/octet-stream' } : {},
    body: body ? JSON.stringify(body) : bytes, signal: AbortSignal.timeout(30000) });
  const buffer = Buffer.from(await response.arrayBuffer());
  let data = null;
  if (/json/i.test(response.headers.get('content-type') || '')) { try { data = JSON.parse(buffer.toString('utf8')); } catch { /* Validate status below. */ } }
  return { status: response.status, ok: response.ok, data, buffer };
}
function fixture() {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const text = '软件重复目标 软件重复目标。软件验收甲...软件验收乙、即第二项。';
  const bytes = writeZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<w:document xmlns:w="${w}"><w:body><w:p><w:r><w:t>软件工作台验收</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>` },
  ]);
  return { bytes, text };
}
async function startFake() {
  fake = httpServer((req, res) => {
    let count = 0;
    req.on('data', (bytes) => { count += bytes.length; });
    req.on('end', () => {
      const record = { path: req.url, method: req.method, bytes: count, arrivedAt: new Date().toISOString(), fakeCredentialMatched: req.headers.authorization === `Bearer ${FAKE_KEY}` };
      report.localRequests.push(record); notifyFake(record);
      // No response: no semantic inference is produced or evaluated.
    });
  });
  fake.on('connection', (socket) => { fakeSockets.add(socket); socket.once('close', () => fakeSockets.delete(socket)); });
  await new Promise((done, fail) => { fake.once('error', fail); fake.listen(0, '127.0.0.1', done); });
  fakeBase = `http://127.0.0.1:${fake.address().port}/api/v3`;
  report.fakeBase = fakeBase;
}
async function startApp() {
  const probe = netServer();
  await new Promise((done, fail) => { probe.once('error', fail); probe.listen(PORT, '127.0.0.1', done); });
  await new Promise((done) => probe.close(done));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(?:ARK|OPENAI|DOUBAO|VOLC)/i.test(key) && !/^(?:NODE_OPTIONS|NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key) && !/^DSH_/i.test(key)));
  Object.assign(env, { PORT: String(PORT), HOST: '127.0.0.1',
    DSH_WORKING_VERSION_ROOT: ROOTS.versions, DSH_SESSION_ROOT: ROOTS.sessions,
    DSH_WORKSPACE_ROOT: ROOTS.workspaces, DSH_AUDIT_ROOT: ROOTS.audit, DSH_LEGACY_ROOT: ROOTS.legacy, DSH_INGESTION_ROOT: ROOTS.ingestion,
    DSH_JOB_ROOT: ROOTS.jobs, DSH_REVIEW_WORKERS: '2',
    DSH_ARK_EXECUTION_ROOT: ROOTS.arkExecutions, DSH_REVIEW_PLAN_ROOT: ROOTS.reviewPlans,
    ARK_BASE_URL: fakeBase, ARK_API_KEY: FAKE_KEY, ARK_MODEL: FAKE_MODEL,
    ARK_CONTEXT: '0', ARK_CASES: '0', ARK_CONSISTENCY: '0', ARK_PREFIX_CACHE: '0' });
  app = spawn(process.execPath, [resolve(ROOT, 'server.mjs')], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const owned = app;
  let ready = false, launchError = null;
  owned.stdout.on('data', (bytes) => { if (bytes.toString().includes(BASE)) ready = true; });
  owned.stderr.on('data', () => {});
  owned.once('error', (error) => { launchError = error; });
  report.processes.push({ event: 'start', pid: owned.pid, at: new Date().toISOString() });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (owned.exitCode !== null || owned.signalCode !== null) throw new Error('Owned app exited before readiness');
    if (ready) { try { if ((await request('/api/health')).ok) return; } catch { /* Await owned listener. */ } }
    await wait(50);
  }
  throw new Error('Owned app readiness timed out');
}
async function stopApp(reason) {
  if (!app) return;
  const owned = app;
  if (owned.exitCode === null && owned.signalCode === null) {
    const ended = new Promise((done) => owned.once('exit', done));
    owned.kill('SIGKILL'); await bounded(ended, 5000, 'Owned process failed to stop');
  }
  if (app === owned) app = null;
  report.processes.push({ event: 'stop', reason, pid: owned.pid, at: new Date().toISOString(), exitCode: owned.exitCode, signal: owned.signalCode });
}
async function getSession(id) { const value = await request(`/api/session?id=${id}`); must(value.ok && value.data?.exists, 'session is available', { id }); return value.data; }
async function human(id) { const value = await request(`/api/human-records?id=${id}&history=1`); must(value.ok && value.data?.human, 'human state is available', { id }); return value.data; }
async function workspace(label) {
  const value = await request(`/api/workspace?id=${WORKSPACE_ID}`);
  must(value.ok && value.data?.workspace, 'workspace is available', { label });
  report.stages.push({ label, workspace: value.data.workspace });
  return value.data.workspace;
}
async function mutateWorkspace(current, fields, operationId = randomUUID()) {
  const body = { id: WORKSPACE_ID, expectedRevision: current.revision, operationId, ...fields };
  const response = await request('/api/workspace', { body });
  return { response, body, workspace: response.data?.workspace };
}
function humanBody(state, fields, operationId = randomUUID()) {
  return { id: state.id, operationId, baseVersionId: state.workVersion.id, baseMutationEpoch: state.history.epoch,
    baseRunId: state.reviewRunId ?? null, expectedHumanRevision: state.human.revision,
    purpose: 'verification', verificationRunId: TEST_ID, ...fields };
}
async function mutateHuman(state, fields, operationId = randomUUID()) {
  const body = humanBody(state, fields, operationId);
  const response = await request('/api/human-records', { body });
  return { body, response };
}
async function upload(bytes, name) {
  const value = await request(`/api/upload?name=${encodeURIComponent(name)}`, { bytes });
  must(value.ok && !!value.data?.id, 'software fixture upload succeeds', { name, status: value.status });
  return value.data;
}
async function review(id) {
  const value = await request('/api/review', { body: { id, useModel: false } });
  must(value.ok && Array.isArray(value.data?.issues), 'completed review uses rules only', { id });
  return getSession(id);
}
async function historyMutation(id, action) {
  const s = await getSession(id);
  const value = await request(`/api/${action}-fixes`, { body: { id, baseVersionId: s.workVersion.id, baseMutationEpoch: s.history.epoch, operationId: randomUUID() } });
  must(value.ok, `${action} is available`, { status: value.status });
  return human(id);
}
function isolatedPath(...segments) {
  const file = resolve(STORAGE, ...segments);
  const rel = relative(STORAGE, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Fixture file move is outside the owned isolated storage');
  return file;
}
async function run() {
  await startFake(); await startApp();
  for (const [label, file] of [['test', fileURLToPath(import.meta.url)], ['server', join(ROOT, 'server.mjs')], ['sessionStore', join(ROOT, 'src/session-store.js')], ['workspaceStore', join(ROOT, 'src/workspace-store.js')], ['humanRecords', join(ROOT, 'src/human-state.js')], ['audit', join(ROOT, 'src/audit.js')], ['reviewServer', join(ROOT, 'src/review-server.js')], ['reviewRuntime', join(ROOT, 'src/review-runtime.js')], ['jobStore', join(ROOT, 'src/job-store.js')]]) {
    if (existsSync(file)) report[`${label}Sha256`] = hash(readFileSync(file));
  }
  const sample = fixture(); report.sourceSha256 = hash(sample.bytes);
  const a = await upload(sample.bytes, 'workspace-human-A.docx');
  const b = await upload(sample.bytes, 'workspace-human-B.docx');
  must(a.id !== b.id && a.workVersion.sourceSha256 === b.workVersion.sourceSha256, 'identical content retains distinct manuscript identities');
  let sa = await review(a.id), sb = await review(b.id);
  const issueA = sa.result.issues.find((x) => x.ruleId === 'FMT-019' && x.autoFix?.find);
  const issueB = sb.result.issues.find((x) => x.ruleId === 'FMT-019' && x.autoFix?.find);
  must(issueA && issueB && keyOf(issueA) === keyOf(issueB), 'two manuscripts supply the exact same issue key');
  const issueKey = keyOf(issueA);
  let ws = await workspace('empty-workspace');
  check(ws.revision === -1 && ws.entries.length === 0, 'missing workspace has an explicit empty revision');
  let m = await mutateWorkspace(ws, { action: 'attach', sessionId: a.id, name: 'spoofed-name', status: 'ready', hasResult: false });
  must(m.response.ok && m.workspace, 'attach first manuscript'); ws = m.workspace;
  m = await mutateWorkspace(ws, { action: 'attach', sessionId: b.id }); must(m.response.ok, 'attach second manuscript'); ws = m.workspace;
  const identities = ws.entries.map((x) => x.id);
  check(equal(identities, [a.id, b.id]) && new Set(ws.entries.map((x) => x.entryId)).size === 2, 'workspace order and entry identities match uploads');
  ws = await workspace('attached-server-facts');
  check(ws.entries[0].name === 'workspace-human-A.docx' && ws.entries[0].hasResult === true && ws.entries[0].status === 'complete', 'attached entry facts come from the session, never client claims');
  const beforeDuplicateCount = ws.entries.length;
  m = await mutateWorkspace(ws, { action: 'attach', sessionId: a.id }); must(m.response.ok, 'repeat attachment is accepted'); ws = m.workspace;
  check(ws.entries.length === beforeDuplicateCount && ws.entries.filter((x) => x.id === a.id).length === 1, 'repeated session attachment never duplicates the queue');

  let ha = await human(a.id), hb = await human(b.id);
  const sharedOperation = randomUUID();
  const da = await mutateHuman(ha, { kind: 'decision', issueKey, action: 'accept', opinion: 'software-A' }, sharedOperation);
  const db = await mutateHuman(hb, { kind: 'decision', issueKey, action: 'reject', opinion: 'software-B' }, sharedOperation);
  must(da.response.ok && db.response.ok, 'the same operation ID is isolated by manuscript identity');
  const purposeCollision = await request('/api/human-records', { body: { ...da.body, purpose: 'editorial' } });
  check(purposeCollision.status === 409, 'one human operation ID cannot be replayed under another record purpose');
  ha = await human(a.id); hb = await human(b.id);
  check(ha.human.decisions[issueKey]?.action === 'accept' && hb.human.decisions[issueKey]?.action === 'reject', 'same-key decisions stay separate across manuscripts');
  check(ha.human.workVersionId === a.workVersion.id && ha.human.reviewRunId === sa.reviewRunId && hb.human.reviewRunId === sb.reviewRunId, 'decisions are bound to the exact version and review run');
  const quote = '重复目标', normalized = sample.text.replace(/\s+/g, '');
  const first = normalized.indexOf(quote), second = normalized.indexOf(quote, first + quote.length);
  const rawFirst = sample.text.indexOf(quote), rawSecond = sample.text.indexOf(quote, rawFirst + quote.length);
  const mark = { target: 'body', index: 1, start: second, end: second + quote.length, offsetSpace: 'normalized', quote, category: '软件验收', severity: '中', note: 'software-second-occurrence', ruleId: 'SOFTWARE', nature: 'software' };
  const markBody = humanBody(ha, { kind: 'mark', mark }, randomUUID());
  const markReplies = await Promise.all([request('/api/human-records', { body: markBody }), request('/api/human-records', { body: markBody })]);
  ha = await human(a.id);
  check(markReplies.every((x) => x.ok) && ha.human.marks.length === 1 && ha.human.revision === markBody.expectedHumanRevision + 1, 'concurrent same-ID mark retries commit exactly one record');
  const savedMark = ha.human.marks[0];
  check(savedMark?.start === second && savedMark?.rawStart === rawSecond && savedMark?.rawEnd === rawSecond + quote.length && savedMark?.quote === quote, 'mark maps the second identical quote to its exact raw range');
  const unreviewed = await upload(sample.bytes, 'software-unreviewed-mark.docx');
  let unreviewedHuman = await human(unreviewed.id);
  const unreviewedMark = await mutateHuman(unreviewedHuman, { kind: 'mark', mark, baseRunId: null });
  must(unreviewedMark.response.ok, 'an unreviewed version accepts an explicit mark with a null review run');
  unreviewedHuman = await human(unreviewed.id);
  check(unreviewedHuman.reviewRunId === null && unreviewedHuman.human.marks.length === 1 && unreviewedHuman.records[0]?.binding.reviewRunId === null, 'unreviewed mark does not invent a completed review identity');
  const unavailableDecision = await mutateHuman(unreviewedHuman, { kind: 'decision', issueKey, action: 'accept', opinion: 'unreviewed-must-reject', baseRunId: null });
  check(unavailableDecision.response.status === 409, 'unreviewed manuscript cannot receive a completed-issue decision');
  hb = await human(b.id); check(hb.human.marks.length === 0, 'marks do not leak to the other manuscript');
  const badRange = await mutateHuman(ha, { kind: 'mark', mark: { ...mark, start: 0, end: quote.length } });
  check(badRange.response.status === 409, 'wrong normalized range is rejected without first-occurrence guessing', { status: badRange.response.status });
  const markCollision = await request('/api/human-records', { body: { ...markBody, mark: { ...mark, note: 'changed-same-operation' } } });
  check(markCollision.status === 409, 'one human operation ID cannot mean two different payloads');
  const staleRevision = await request('/api/human-records', { body: { ...da.body, operationId: randomUUID(), action: 'unsure' } });
  check(staleRevision.status === 409, 'stale human revision is rejected');
  ha = await human(a.id);
  const parallel = [humanBody(ha, { kind: 'decision', issueKey, action: 'accept', opinion: 'concurrent-one' }), humanBody(ha, { kind: 'decision', issueKey, action: 'unsure', opinion: 'concurrent-two' })];
  const parallelReplies = await Promise.all(parallel.map((body) => request('/api/human-records', { body })));
  check(parallelReplies.filter((x) => x.ok).length === 1 && parallelReplies.filter((x) => x.status === 409).length === 1, 'different human operations at one revision cannot overwrite each other');
  ha = await human(a.id);
  const finalDecision = await mutateHuman(ha, { kind: 'decision', issueKey, action: 'unsure', opinion: 'software-A-final-baseline' });
  must(finalDecision.response.ok, 'retry after explicit human revision refresh succeeds');
  ha = await human(a.id);
  const humanBaseline = structuredClone(ha.human);
  const originalWorking = await request(`/api/session-file?id=${a.id}`);
  sa = await getSession(a.id);
  const fix = await request('/api/apply-fixes', { body: { id: a.id, accepted: [issueKey], baseVersionId: sa.workVersion.id, baseMutationEpoch: sa.history.epoch, baseReviewRunId: sa.reviewRunId, operationId: randomUUID() } });
  must(fix.ok && fix.data?.applied?.length, 'real working-byte change creates another human scope');
  let changedHuman = await human(a.id);
  check(changedHuman.human.marks.length === 0 && Object.keys(changedHuman.human.decisions).length === 0, 'new working version does not inherit unverified old decisions or marks');
  const oldVersion = await request('/api/human-records', { body: { ...finalDecision.body, operationId: randomUUID(), expectedHumanRevision: changedHuman.human.revision } });
  check(oldVersion.status === 409, 'old version and epoch cannot write human records');
  ha = await historyMutation(a.id, 'undo');
  const undoneBytes = await request(`/api/session-file?id=${a.id}`);
  check(hash(undoneBytes.buffer) === hash(originalWorking.buffer) && ha.human.marks[0]?.id === savedMark.id && ha.human.decisions[issueKey]?.opinion === humanBaseline.decisions[issueKey].opinion, 'undo restores exact earlier bytes, marks and decisions');
  changedHuman = await historyMutation(a.id, 'redo');
  check(changedHuman.human.marks.length === 0 && Object.keys(changedHuman.human.decisions).length === 0, 'redo restores the later version scope without leaked human state');
  ha = await historyMutation(a.id, 'undo');
  const beforeNewRun = await getSession(a.id);
  const oldRun = beforeNewRun.reviewRunId;
  sa = await review(a.id); ha = await human(a.id);
  check(sa.reviewRunId !== oldRun && ha.human.marks[0]?.id === savedMark.id && Object.keys(ha.human.decisions).length === 0, 'same-version rerun preserves marks but separates decision runs');
  const oldRunRequest = humanBody(ha, { kind: 'decision', issueKey, action: 'accept', baseRunId: oldRun });
  const staleRun = await request('/api/human-records', { body: oldRunRequest });
  check(staleRun.status === 409, 'old review run cannot decide a current issue');
  const latestIssue = sa.result.issues.find((x) => x.ruleId === 'FMT-019' && x.autoFix?.find);
  must(latestIssue, 'rerun has a current mechanical issue');
  const latestDecision = await mutateHuman(ha, { kind: 'decision', issueKey: keyOf(latestIssue), action: 'unsure', opinion: 'software-current-run' });
  must(latestDecision.response.ok, 'current-run decision is accepted', { status: latestDecision.response.status, requested: latestDecision.body, response: latestDecision.response.data });
  ha = await human(a.id); hb = await human(b.id);
  report.stages.push({ label: 'human-current-and-history', a: ha, b: hb });
  check(ha.records?.length > ha.human.marks.length && ha.human.historyCount > 0, 'historical records remain available separately from current view');
  const sessionHuman = await getSession(a.id);
  const statusHuman = await request(`/api/review-status?id=${a.id}`);
  check(equal(sessionHuman.human, ha.human) && equal(statusHuman.data?.human, ha.human), 'session and review-status publish the same human view');

  ws = await workspace('before-large-queue');
  const expectedOrder = ws.entries.map((x) => x.id || x.entryId);
  for (let n = 0; n < 41; n++) {
    const extra = await upload(sample.bytes, `software-queue-${n}.docx`);
    m = await mutateWorkspace(ws, { action: 'attach', sessionId: extra.id }); must(m.response.ok && m.workspace, 'attach cache-eviction fixture', { n }); ws = m.workspace;
    expectedOrder.push(extra.id);
  }
  ws = await workspace('after-large-queue');
  check(equal(ws.entries.map((x) => x.id || x.entryId), expectedOrder) && ws.entries.length > 40, 'persistent queue retains every ordered identity beyond the memory limit');
  const health = await request('/api/health'); check(health.data?.sessions <= 40, 'memory sessions are only a bounded cache');
  const recoveredHuman = await human(a.id);
  check(equal(recoveredHuman.human, ha.human), 'human records survive cache eviction');
  m = await mutateWorkspace(ws, { action: 'activate', sessionId: b.id }); must(m.response.ok, 'activate manuscript B'); ws = m.workspace;
  m = await mutateWorkspace(ws, { action: 'queue', state: 'paused', cursorSessionId: a.id, options: { useModel: false, mode: 'rules', concurrency: 2 } }); must(m.response.ok, 'persist paused queue plan and cursor'); ws = m.workspace;
  check(ws.activeSessionId === b.id && ws.queue.cursorSessionId === a.id, 'reading identity and queue cursor are independent');
  const failedEntryId = `e${randomUUID().replace(/-/g, '')}`;
  m = await mutateWorkspace(ws, { action: 'failure', entryId: failedEntryId, name: 'software-invalid-upload.docx', error: 'software fixture admission failed' }); must(m.response.ok, 'record an explicit failed upload'); ws = m.workspace;
  const failedEntry = ws.entries.find((x) => x.entryId === failedEntryId);
  check(failedEntry && ['upload-failed', 'failed'].includes(failedEntry.status) && !failedEntry.hasResult, 'failed queue entry never masquerades as a completed review');
  const beforeFalseCompletion = structuredClone(ws);
  const falseCompletion = await mutateWorkspace(ws, { action: 'queue', state: 'completed', cursorSessionId: a.id, options: { useModel: false } });
  ws = await workspace('rejected-ready-and-upload-failed-completion');
  check(falseCompletion.response.status === 409 && ws.revision === beforeFalseCompletion.revision && equal(ws.queue, beforeFalseCompletion.queue), 'ready or upload-failed entries cannot be relabeled as a completed queue', { status: falseCompletion.response.status, observedIncompleteStatuses: [...new Set(beforeFalseCompletion.entries.filter((x) => x.status !== 'complete').map((x) => x.status))] });
  const completeWorkspaceId = `${WORKSPACE_ID}complete`;
  const completedAttach = await request('/api/workspace', { body: { id: completeWorkspaceId, action: 'attach', sessionId: b.id, expectedRevision: -1, operationId: randomUUID() } });
  must(completedAttach.ok && completedAttach.data?.workspace?.entries?.length === 1 && completedAttach.data.workspace.entries[0].status === 'complete', 'separate workspace contains only a verified complete session');
  const completedPlan = await request('/api/workspace', { body: { id: completeWorkspaceId, action: 'queue', state: 'completed', cursorSessionId: b.id, options: { useModel: false }, expectedRevision: completedAttach.data.workspace.revision, operationId: randomUUID() } });
  check(completedPlan.ok && completedPlan.data?.workspace?.queue?.state === 'completed' && completedPlan.data.workspace.entries.every((x) => x.status === 'complete'), 'completed queue plan remains available when every session is actually complete');
  report.stages.push({ label: 'valid-fully-complete-workspace', workspace: completedPlan.data?.workspace ?? null });
  const badAdmission = await mutateWorkspace(ws, { action: 'attach', sessionId: 'sdoesnotexist' });
  check(!badAdmission.response.ok && (await workspace('after-invalid-admission')).revision === ws.revision, 'nonexistent session cannot forge a completed queue entry');
  const staleWs = await mutateWorkspace({ ...ws, revision: ws.revision - 1 }, { action: 'activate', sessionId: a.id });
  check(staleWs.response.status === 409, 'stale workspace revision is rejected');
  const c = await upload(sample.bytes, 'software-concurrent-C.docx'), d = await upload(sample.bytes, 'software-concurrent-D.docx');
  const attachBodies = [c, d].map((s) => ({ id: WORKSPACE_ID, expectedRevision: ws.revision, operationId: randomUUID(), action: 'attach', sessionId: s.id }));
  const attachReplies = await Promise.all(attachBodies.map((body) => request('/api/workspace', { body })));
  check(attachReplies.filter((x) => x.ok).length === 1 && attachReplies.filter((x) => x.status === 409).length === 1, 'workspace CAS protects concurrent different attachments');
  ws = await workspace('after-concurrent-attachment');
  const loser = attachReplies.findIndex((x) => !x.ok);
  if (loser >= 0) { m = await mutateWorkspace(ws, { action: 'attach', sessionId: attachBodies[loser].sessionId }); must(m.response.ok, 'losing attachment succeeds after explicit revision refresh'); ws = m.workspace; }
  check(ws.entries.filter((x) => x.id === c.id).length === 1 && ws.entries.filter((x) => x.id === d.id).length === 1, 'concurrent queue writes retain both manuscripts without duplicates');
  const queueOperation = { id: WORKSPACE_ID, expectedRevision: ws.revision, operationId: randomUUID(), action: 'activate', sessionId: a.id };
  const queueReplies = await Promise.all([request('/api/workspace', { body: queueOperation }), request('/api/workspace', { body: queueOperation })]);
  const beforeSameIdRevision = ws.revision; ws = await workspace('after-same-operation');
  check(queueReplies.every((x) => x.ok) && ws.revision === beforeSameIdRevision + 1 && ws.activeSessionId === a.id, 'concurrent same-ID queue retries commit only one mutation');
  const queueCollision = await request('/api/workspace', { body: { ...queueOperation, sessionId: b.id } });
  check(queueCollision.status === 409, 'one workspace operation ID cannot change payload');
  check(report.localRequests.length === 0, 'all completed matrix cases made no provider request');
  const beforeRestart = structuredClone(ws);
  await stopApp('intentional workspace restart'); await startApp();
  ws = await workspace('after-real-workspace-restart');
  check(equal(ws.entries.map((x) => [x.entryId, x.id || null]), beforeRestart.entries.map((x) => [x.entryId, x.id || null])) && ws.activeSessionId === beforeRestart.activeSessionId && equal(ws.queue, beforeRestart.queue) && ws.revision === beforeRestart.revision, 'true restart restores full order, active identity, cursor and queue options');
  ha = await human(a.id); hb = await human(b.id);
  check(equal(ha.human, recoveredHuman.human) && hb.human.decisions[issueKey]?.opinion === 'software-B', 'restart preserves isolated version/run-bound human records');
  const replayHuman = await request('/api/human-records', { body: latestDecision.body });
  check(replayHuman.ok && replayHuman.data?.replayed === true && replayHuman.data?.human?.revision === ha.human.revision, 'human operation receipts survive process restart');
  const replayQueue = await request('/api/workspace', { body: queueOperation });
  check(replayQueue.ok && replayQueue.data?.workspace?.revision === ws.revision, 'workspace operation receipts return current state after restart');
  check(report.localRequests.length === 0, 'queue recovery never automatically starts provider work');
  const sourceAfter = await request(`/api/session-file?id=${a.id}&original=1`);
  check(sourceAfter.ok && hash(sourceAfter.buffer) === hash(sample.bytes), 'human records and queue operations never change original bytes');

  const statePath = isolatedPath('workspaces', WORKSPACE_ID, 'state.json');
  const backupPath = isolatedPath('workspaces', WORKSPACE_ID, `state.missing-fixture-${randomUUID()}.backup`);
  const unexpectedPath = isolatedPath('workspaces', WORKSPACE_ID, `state.unexpected-bootstrap-${randomUUID()}.json`);
  const previousStateHash = hash(readFileSync(statePath));
  const previousWorkspace = structuredClone(ws);
  renameSync(statePath, backupPath);
  try {
    const missingGet = await request(`/api/workspace?id=${WORKSPACE_ID}`);
    const missingPost = await request('/api/workspace', { body: { id: WORKSPACE_ID, expectedRevision: ws.revision, operationId: randomUUID(), action: 'activate', sessionId: b.id } });
    report.stages.push({ label: 'existing-workspace-state-missing', statePath, backupPath, previousStateHash, getStatus: missingGet.status, getReply: missingGet.data, postStatus: missingPost.status, postReply: missingPost.data, stateRecreated: existsSync(statePath) });
    check(missingGet.status === 500 && !missingGet.data?.workspace, 'missing state in an existing workspace cannot appear as a new empty workspace');
    check(missingPost.status === 500 && !existsSync(statePath) && hash(readFileSync(backupPath)) === previousStateHash, 'mutation cannot overwrite or bootstrap an unreadable existing workspace');
  } finally {
    // Preserve any incorrect new file as evidence, then restore only this owned
    // test workspace's original state. No app or source directory is moved.
    if (existsSync(statePath)) renameSync(statePath, unexpectedPath);
    renameSync(backupPath, statePath);
  }
  ws = await workspace('restored-workspace-state-file');
  check(hash(readFileSync(statePath)) === previousStateHash && ws.revision === previousWorkspace.revision && equal(ws.entries.map((x) => [x.entryId, x.id || null]), previousWorkspace.entries.map((x) => [x.entryId, x.id || null])) && equal(ws.queue, previousWorkspace.queue), 'restoring the exact state file makes the original ordered queue usable again');

  const streamParams = new URLSearchParams({ id: a.id, force: '1', detach: '1', useModel: 'true', useContext: 'false', useCases: 'false', useRecheck: 'false', model: FAKE_MODEL, ruleMode: 'all' });
  streamAbort = new AbortController();
  const stream = await fetch(`${BASE}/api/review-stream?${streamParams}`, { signal: streamAbort.signal });
  must(stream.ok && /event-stream/i.test(stream.headers.get('content-type') || ''), 'owned live task stream opens');
  streamTask = (async () => { try { for await (const _ of stream.body) { /* Drain without evaluating prose. */ } } catch (error) { report.streamClosedByCrash = error.name; } })();
  const localArrival = await bounded(fakeArrived, 20000, 'Local pending provider request did not arrive');
  must(localArrival.fakeCredentialMatched, 'pending task uses only the local fake credential');
  ws = await workspace('genuinely-running-task');
  const runningEntry = ws.entries.find((x) => x.id === a.id);
  check(runningEntry?.status === 'reviewing' && runningEntry?.running === true && !runningEntry.hasResult, 'queue shows the live current run instead of historical completion');
  const interruptedRunId=runningEntry?.reviewRunId;
  const requestsAtCrash = report.localRequests.length;
  await stopApp('intentional in-flight crash'); await startApp();
  const recoveryDeadline=Date.now()+15000;
  while(Date.now()<recoveryDeadline){
    const recovering=await request(`/api/review-status?id=${a.id}&runId=${encodeURIComponent(interruptedRunId||'')}`);
    if(recovering.data?.reviewRunId===interruptedRunId&&recovering.data?.status==='interrupted'&&!recovering.data?.running)break;
    await wait(25);
  }
  ws = await workspace('after-real-task-interruption');
  const interrupted = ws.entries.find((x) => x.id === a.id), unaffected = ws.entries.find((x) => x.id === b.id);
  check(interrupted?.status === 'interrupted' && !interrupted.hasResult && !interrupted.running && !!interrupted.error, 'interrupted queue entry is explicit and never counted complete');
  const beforeInterruptedCompletion = structuredClone(ws);
  const interruptedCompletion = await mutateWorkspace(ws, { action: 'queue', state: 'completed', cursorSessionId: a.id, options: { useModel: false } });
  ws = await workspace('rejected-interrupted-completion');
  check(interruptedCompletion.response.status === 409 && ws.revision === beforeInterruptedCompletion.revision && equal(ws.queue, beforeInterruptedCompletion.queue), 'interrupted run cannot become a completed queue plan', { status: interruptedCompletion.response.status, observedIncompleteStatuses: [...new Set(beforeInterruptedCompletion.entries.filter((x) => x.status !== 'complete').map((x) => x.status))] });
  check(unaffected?.status === 'complete' && unaffected.hasResult, 'one interrupted manuscript cannot invalidate another completed manuscript');
  check(equal(ws.queue, beforeRestart.queue), 'interruption preserves the paused cursor and plan');
  await wait(100);
  check(report.localRequests.length === requestsAtCrash, 'restart and queue polling do not retry provider requests');
  const interruptedHuman = await human(a.id);
  check(interruptedHuman.human.marks[0]?.id === savedMark.id && Object.keys(interruptedHuman.human.decisions).length === 0 && interruptedHuman.human.historyCount > 0, 'interruption retains marks/history without pretending old decisions belong to an unfinished run');
  const oldCompletionDecision = await request('/api/human-records', { body: { ...latestDecision.body, operationId: randomUUID(), expectedHumanRevision: interruptedHuman.human.revision, baseVersionId: interruptedHuman.workVersion.id, baseMutationEpoch: interruptedHuman.history.epoch } });
  check(oldCompletionDecision.status === 409, 'historical completion cannot decide an unfinished current run');
  await review(a.id); ws = await workspace('after-explicit-rules-rerun');
  check(ws.entries.find((x) => x.id === a.id)?.status === 'complete' && report.localRequests.length === requestsAtCrash, 'only an explicit new rules completion restores queue completion');
  const auditA = await request(`/api/audit?id=${a.id}`), auditB = await request(`/api/audit?id=${b.id}`);
  check(auditA.ok && auditB.ok && auditA.data?.entries?.every((x) => x.sessionId === a.id) && auditB.data?.entries?.every((x) => x.sessionId === b.id), 'audit queries preserve manuscript isolation');
  const allHumanA = await human(a.id), allHumanB = await human(b.id);
  const auditMatches = (events, records) => {
    const humanEvents = events.filter((entry) => ['human-mark', 'human-decision', 'human-comment'].includes(entry.kind));
    return humanEvents.length === records.length && new Set(humanEvents.map((entry) => entry.provenance?.humanRecordId)).size === records.length
      && records.every((record) => {
        const event = humanEvents.find((entry) => entry.provenance?.humanRecordId === record.id);
        return event?.provenance?.workVersionId === record.binding.workVersionId && event.provenance.reviewRunId === record.binding.reviewRunId
          && event.provenance.sourceSha256 === record.binding.sourceSha256 && event.provenance.operationId === record.operationId
          && event.provenance.purpose === 'verification' && event.provenance.verificationRunId === TEST_ID;
      });
  };
  check(auditA.ok && auditB.ok && auditMatches(auditA.data.entries, allHumanA.records) && auditMatches(auditB.data.entries, allHumanB.records), 'audit records each committed human action once with exact source/version/run bindings');
  const allHumanUnreviewed = await human(unreviewed.id);
  check([...allHumanA.records, ...allHumanB.records, ...allHumanUnreviewed.records].every((record) => record.purpose === 'verification' && record.verificationRunId === TEST_ID), 'software feedback remains explicitly tagged as verification rather than editorial evidence');
  report.stages.push({ label: 'isolated-audit-records', a: auditA.data, b: auditB.data });
  report.localFakeRequests = report.localRequests.length;
  check(report.localFakeRequests === 1, 'entire matrix uses one unanswered local fixture request and zero semantic provider outputs');
}
try { await run(); }
catch (error) { report.error = error.stack || String(error); check(false, 'workspace/human acceptance completes', { error: error.message }); }
finally {
  if (streamAbort) streamAbort.abort();
  await stopApp('controller cleanup').catch((error) => { report.cleanupError = error.message; });
  for (const socket of fakeSockets) socket.destroy();
  if (fake) await new Promise((done) => fake.close(done));
  if (streamTask) await bounded(streamTask, 2000, 'Stream cleanup timeout').catch(() => {});
  report.passed = report.checks.filter((x) => x.ok).length; report.failed = report.checks.filter((x) => !x.ok).length;
  report.finishedAt = new Date().toISOString();
  mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
}
console.log(`Workspace/human acceptance: ${report.passed} passed / ${report.failed} failed. ${OUT}`);
process.exitCode = report.failed ? 1 : 0;
