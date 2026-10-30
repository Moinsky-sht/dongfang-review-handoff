/** Actual server status function over seven isolated stores; software DTOs, no server/model. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';

const SCRIPT = fileURLToPath(import.meta.url);
const PROJECT = resolve(dirname(SCRIPT), '..');
const inheritedEvidence = process.env.DSH_VERIFICATION_EVIDENCE_DIR;
const verificationRunId = process.env.DSH_VERIFICATION_RUN_ID || null;
const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const within = (base, candidate) => { const part = relative(resolve(base), resolve(candidate)); return !part.startsWith('..') && !isAbsolute(part); };
const verifyRoot = join(PROJECT, 'data/verify');
const evidenceRoot = resolve(flag('evidence-root') || inheritedEvidence || verifyRoot);
assert.ok(within(verifyRoot, evidenceRoot) || inheritedEvidence && within(inheritedEvidence, evidenceRoot), 'evidence must stay inside data/verify or the assigned DSH evidence directory');
async function assertEvidencePath(path) {
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    assert.ok(!existsSync(join(cursor, 'complete.json')), `sealed evidence ancestor cannot receive test output: ${cursor}`);
    try {
      const info = await lstat(cursor);
      assert.ok(info.isDirectory() && !info.isSymbolicLink(), `evidence ancestor must be a real directory, not an alias or symbolic link: ${cursor}`);
      assert.equal(resolve(await realpath(cursor)), cursor, `evidence ancestor must not resolve through an alias: ${cursor}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(cursor) === cursor) break;
  }
}
await assertEvidencePath(evidenceRoot);
const sourcePath = resolve(PROJECT, flag('source') || 'server.mjs');
assert.ok(within(PROJECT, sourcePath) && sourcePath.endsWith('.mjs'), 'server source must be an in-project .mjs file');
for (const key of Object.keys(process.env)) if (/^(?:DSH_|NODE_OPTIONS|NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/i.test(key)
  || /(?:ARK|OPENAI|DOUBAO|VOLC|ANTHROPIC)/i.test(key)) delete process.env[key];
await mkdir(evidenceRoot, { recursive: true });
await assertEvidencePath(evidenceRoot);
const RUN = join(evidenceRoot, `review-read-consistency-${Date.now()}-${randomUUID()}`);
assert.ok(within(evidenceRoot, RUN) && !existsSync(RUN));
await mkdir(RUN);
const ENV_ROOTS = { DSH_JOB_ROOT: 'jobs', DSH_SESSION_ROOT: 'sessions', DSH_WORKING_VERSION_ROOT: 'versions',
  DSH_WORKSPACE_ROOT: 'workspaces', DSH_AUDIT_ROOT: 'audit', DSH_LEGACY_ROOT: 'legacy', DSH_INGESTION_ROOT: 'ingestions' };
const ROOTS = Object.fromEntries(Object.entries(ENV_ROOTS).map(([key, leaf]) => { process.env[key] = join(RUN, leaf); return [leaf, process.env[key]]; }));
await Promise.all(Object.values(ROOTS).map((path) => mkdir(path)));
const storage = { storageRoot: ROOTS.jobs, sessionRoot: ROOTS.sessions, versionRoot: ROOTS.versions, workspaceRoot: ROOTS.workspaces, documentWorkerLimit: 1 };
const store = await import('../src/job-store.js');
const sessionStore = await import('../src/session-store.js');
const versions = await import('../src/working-version.js');
const history = await import('../src/fix-history.js');
const human = await import('../src/human-state.js');
const adapter = await import('../src/review-server.js');
const { writeZip } = await import('../src/zip-write.js');
const { parseDocxBuffer } = await import('../src/docx.js');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = await readFile(sourcePath, 'utf8');
function serverFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing server function ${name}`);
  const prefix = source.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start;
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `invalid server function boundary ${name}`);
  return source.slice(prefix, end + 2);
}
const report = { generatedAt: new Date().toISOString(), verificationRunId, evidenceRoot, run: RUN, roots: ROOTS, rootCount: 7,
  sourcePath, serverSha256: sha(source), testSha256: sha(await readFile(SCRIPT)),
  actualStatusFunctionSource: serverFunction('reviewStatusPayload'), statusFunctionSha256: sha(serverFunction('reviewStatusPayload')),
  jobStoreSha256: sha(await readFile(join(PROJECT, 'src/job-store.js'))),
  reviewServerSha256: sha(await readFile(join(PROJECT, 'src/review-server.js'))),
  sessionStoreSha256: sha(await readFile(join(PROJECT, 'src/session-store.js'))),
  versionStoreSha256: sha(await readFile(join(PROJECT, 'src/working-version.js'))),
  fixHistorySha256: sha(await readFile(join(PROJECT, 'src/fix-history.js'))),
  realArkCalls: 0, paidModelCalls: 0, meaningfulModelResponses: 0, serversStarted: 0, checks: [],
  coverage: 'Actual server.reviewStatusPayload in a VM; real isolated session/version/job stores, claims, staged outcomes and checked terminal publication receipts. Document/result serialization is an explicit software-only DTO. No HTTP, browser, provider or manuscript judgment.' };
await writeFile(join(RUN, 'tested-status-function.js.txt'), report.actualStatusFunctionSource + '\n', { flag: 'wx' });
const counts = { activeJobReads: 0, latestJobReads: 0, freshSessionReads: 0 };
const plain = (value) => JSON.parse(JSON.stringify(value));
async function freshSession(id) {
  const saved = await sessionStore.loadSessionSnapshot({ sessionId: id, storageRoot: ROOTS.sessions });
  const working = await versions.loadWorkingVersion({ sessionId: id, versionId: saved.snapshot.workVersion.id, storageRoot: ROOTS.versions });
  const parsed = parseDocxBuffer(working.buffer, 'software-read-consistency.docx');
  return { ...saved.snapshot, doc: { softwareFixture: true, label: 'software-read-consistency.docx',
    paragraphs: parsed.paragraphs.map((paragraph) => ({ text: paragraph.text })) }, _storeRevision: saved.manifest.revision };
}
const context = createContext({
  Buffer, Object, JSON, structuredClone,
  currentSessionJob: async (id, options) => { counts.activeJobReads += 1; return adapter.currentSessionJob(id, options); },
  latestSessionJob: async (id) => { counts.latestJobReads += 1;
    return adapter.latestSessionJob ? adapter.latestSessionJob(id) : (await store.listJobs({ ...storage, sessionId: id })).at(-1) || null; },
  touchSession: async (id, options) => { assert.equal(options?.fresh, true, 'status recovery must explicitly reload fresh facts'); counts.freshSessionReads += 1; return freshSession(id); },
  effectiveReviewRunId: human.effectiveReviewRunId, humanState: human.humanState,
  fixHistoryStatus: history.fixHistoryStatus, reviewJobActive: adapter.reviewJobActive,
  reviewJobRunning: adapter.reviewJobRunning, publicReviewJob: adapter.publicReviewJob,
  completedFixKeys: () => [],
  serializeDoc: (doc) => ({ softwareFixture: true, paragraphs: structuredClone(doc.paragraphs), label: doc.label }),
  serializeReview: (result, doc, session) => ({ softwareFixture: true, issues: structuredClone(result.issues), summary: result.summary,
    reviewRunId: human.effectiveReviewRunId(session), workVersionId: session.workVersion.id, documentLabel: doc.label }),
  fetch: () => { throw new Error('Network is forbidden in status VM'); },
});
runInContext(['cleanReviewGate', 'currentResultAvailable', 'reviewStatusPayload'].map(serverFunction).join('\n'), context, { filename: sourcePath });
await store.initializeJobStore(storage);
const owner = await store.createJobOwner();
function doc(text) { return { softwareFixture: true, label: 'software-read-consistency.docx', paragraphs: [{ text }], footnotes: [], endnotes: [] }; }
function buffer(text) { return writeZip([
  { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
  { name: 'word/document.xml', data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>` },
]); }
function softwareResult(tag) { return { softwareFixture: true, generatedAt: `software-${tag}`, summary: { total: 1 },
  issues: [{ issueKey: `software-${tag}`, ruleId: 'SOFTWARE-ONLY', location: 'paragraph:0', quote: 'software verification', message: 'software state fixture only' }] }; }
async function createFixture(tag) {
  const id = 's' + randomUUID().replaceAll('-', '');
  const originalBuffer = buffer(`software verification ${tag} v0`);
  const workVersion = await versions.saveWorkingVersion({ sessionId: id, name: 'software-read-consistency.docx', buffer: originalBuffer,
    originalBuffer, storageRoot: ROOTS.versions });
  const snapshot = { id, softwareFixture: true, workVersion, doc: doc(`software verification ${tag} v0`), mutationEpoch: 0,
    clean: { status: 'unchanged' }, reviewRunning: false, reviewRunId: null, reviewJobId: null, reviewError: null, cancelled: false,
    interrupted: false, reviewProgress: { phase: 'unreviewed' }, result: null, resultRunId: null, reviewRecords: [], humanRecords: [], humanRevision: 0 };
  history.initializeFixHistory(snapshot);
  await sessionStore.saveSessionSnapshot({ sessionId: id, snapshot, storageRoot: ROOTS.sessions, expectedRevision: -1 });
  return { id, originalBuffer, initial: await freshSession(id) };
}
async function advanceVersion(fixture) {
  const current = await freshSession(fixture.id);
  const workVersion = await versions.saveWorkingVersion({ sessionId: fixture.id, name: 'software-read-consistency.docx',
    buffer: buffer('software verification v1'), originalBuffer: fixture.originalBuffer, parent: current.workVersion, storageRoot: ROOTS.versions });
  const candidate = { ...current, workVersion, doc: doc('software verification v1'), mutationEpoch: current.mutationEpoch + 1,
    history: { entries: [...current.history.entries, { versionId: workVersion.id, appliedFixes: [] }], cursor: current.history.cursor + 1 } };
  delete candidate._storeRevision;
  await sessionStore.saveSessionSnapshot({ sessionId: fixture.id, snapshot: candidate, storageRoot: ROOTS.sessions, expectedRevision: current._storeRevision });
  return freshSession(fixture.id);
}
async function enqueue(fixture, tag) {
  const current = await freshSession(fixture.id);
  return (await store.enqueueJob({ ...storage, operationId: `software-${tag}-${randomUUID()}`, sessionId: fixture.id,
    binding: { versionId: current.workVersion.id, sourceSha256: current.workVersion.sourceSha256, workSha256: current.workVersion.sha256, mutationEpoch: current.mutationEpoch },
    config: { useModel: false, useRecheck: false, useContext: false, useCases: false }, purpose: 'software-verification' })).job;
}
async function publishCompleted(fixture, tag, { status = 'completed', onMaterialized = null } = {}) {
  assert.ok(['completed', 'partial'].includes(status));
  const job = await enqueue(fixture, tag);
  const running = await store.claimNextJob({ ...storage, owner }); assert.equal(running.id, job.id);
  const previous = await freshSession(fixture.id);
  const started = { ...previous, reviewJobId: job.id, reviewRunId: job.id, reviewVersionId: job.binding.versionId,
    reviewRunning: true, result: null, reviewError: null, cancelled: false, interrupted: false, reviewProgress: { phase: 'start' } };
  history.rememberCompletedReview(previous);
  started.reviewRecords = previous.reviewRecords; delete started._storeRevision;
  await sessionStore.saveSessionSnapshot({ sessionId: fixture.id, snapshot: started, storageRoot: ROOTS.sessions, expectedRevision: previous._storeRevision });
  const result = softwareResult(tag);
  if (status === 'partial') result.modelResult = { errors: [{ message: 'software-only provider failure' }] };
  await store.stageJobOutcome({ ...storage, jobId: job.id, leaseToken: running.lease.token, outcome: { status, result } });
  const publishing = await store.claimJobPublication({ ...storage, jobId: job.id, owner }); assert.ok(publishing.publicationLease.token);
  const current = await freshSession(fixture.id);
  const completed = { ...current, reviewRunning: false, result, resultRunId: job.id, resultVersionId: job.binding.versionId,
    reviewProgress: { phase: status === 'partial' ? 'partial' : 'done', done: 1, total: 1 }, reviewError: null };
  delete completed._storeRevision; history.rememberCompletedReview(completed);
  const manifest = await sessionStore.saveSessionSnapshot({ sessionId: fixture.id, snapshot: completed, storageRoot: ROOTS.sessions, expectedRevision: current._storeRevision });
  if (onMaterialized) await onMaterialized({ session: await freshSession(fixture.id), job: await store.loadJob({ ...storage, jobId: job.id }) });
  const terminal = await store.completeJobPublication({ ...storage, jobId: job.id, publicationToken: publishing.publicationLease.token,
    sessionReceipt: { jobRunId: job.id, versionId: job.binding.versionId, sessionRevision: manifest.revision, sessionManifestSha256: manifest.manifestSha256 } });
  assert.equal(terminal.status, status); assert.equal(terminal.sessionReceipt.sessionRevision, manifest.revision);
  return terminal;
}
async function readHashes(id) { return { session: sha(await readFile(join(ROOTS.sessions, id, 'state.json'))), ledger: sha(await readFile(join(ROOTS.jobs, 'ledger/state.json'))) }; }
async function assertActualBytes(status) {
  const saved = await versions.loadWorkingVersion({ sessionId: status.id, versionId: status.workVersion.id, storageRoot: ROOTS.versions });
  assert.equal(status.workVersionId, saved.version.id);
  assert.equal(status.workVersion.sha256, sha(saved.buffer));
  assert.equal(status.workVersion.sourceSha256, sha(saved.originalBuffer));
  if (status.doc) {
    const parsed = parseDocxBuffer(saved.buffer, 'software-read-consistency.docx');
    assert.deepEqual(plain(status.doc.paragraphs), parsed.paragraphs.map((paragraph) => ({ text: paragraph.text })), 'status document must describe exact current working bytes');
  }
  return { versionId: saved.version.id, workingSha256: sha(saved.buffer), originalSha256: sha(saved.originalBuffer), workingBytes: saved.buffer.length };
}
async function check(name, action) {
  const entry = { name, ok: false }; report.checks.push(entry);
  try { await action(entry); entry.ok = true; console.log(`PASS ${name}`); }
  catch (error) { entry.error = error.stack || String(error); console.log(`FAIL ${name}: ${error.message}`); }
}
try {
  await check('completed publication newer than run-null cache reloads result, document and current version before reporting terminal', async (entry) => {
    const fixture = await createFixture('completion-race'); const stale = structuredClone(fixture.initial);
    const terminal = await publishCompleted(fixture, 'R1'); assert.equal(terminal.sessionReceipt.sessionRevision, 2);
    const hashes = await readHashes(fixture.id), before = counts.freshSessionReads;
    const status = await context.reviewStatusPayload(stale, { includeDoc: true });
    entry.observed = plain({ status: status.status, hasResult: status.hasResult, reviewRunId: status.reviewRunId, running: status.running, waiting: status.waiting, freshReads: counts.freshSessionReads - before });
    entry.cachedRevision = stale._storeRevision; entry.completedReceiptRevision = terminal.sessionReceipt.sessionRevision;
    assert.equal(status.hasResult, true); assert.equal(status.status, 'completed'); assert.equal(status.reviewRunId, terminal.id);
    assert.equal(status.running, false); assert.equal(status.waiting, false); assert.equal(counts.freshSessionReads - before, 1);
    const fresh = await context.reviewStatusPayload(await freshSession(fixture.id), { includeDoc: true });
    assert.deepEqual(plain(status.doc), plain(fresh.doc)); assert.deepEqual(plain(status.result), plain(fresh.result)); assert.deepEqual(plain(status.workVersion), plain(fresh.workVersion));
    entry.actualBytes = await assertActualBytes(status);
    assert.deepEqual(await readHashes(fixture.id), hashes, 'status reconstruction performs no persistent writes');
  });
  for (const terminalStatus of ['completed', 'partial']) await check(`${terminalStatus} same-revision publishing projection reloads durable result and progress`, async (entry) => {
    const fixture = await createFixture(`same-revision-${terminalStatus}`);
    let projection;
    const terminal = await publishCompleted(fixture, `R-${terminalStatus}-same-revision`, {
      status: terminalStatus,
      onMaterialized: ({ session, job }) => {
        assert.equal(job.status, 'publishing');
        assert.equal(session.reviewRunning, false);
        assert.ok(session.result);
        projection = { ...session, _activeReviewJob: job, reviewRunning: true,
          reviewProgress: { phase: 'model-done', message: 'software-only derived view' } };
      },
    });
    assert.equal(projection._storeRevision, terminal.sessionReceipt.sessionRevision);
    entry.projectedRevision = projection._storeRevision;
    entry.terminalReceiptRevision = terminal.sessionReceipt.sessionRevision;
    entry.projectedPhase = projection.reviewProgress.phase;
    const hashes = await readHashes(fixture.id), before = counts.freshSessionReads;
    const status = await context.reviewStatusPayload(projection, { runId: terminal.id, includeDoc: true });
    assert.equal(status.status, terminalStatus); assert.equal(status.hasResult, true);
    assert.equal(status.running, false); assert.equal(status.waiting, false);
    assert.equal(status.reviewRunId, terminal.id); assert.equal(status.result.reviewRunId, terminal.id);
    assert.equal(status.progress.phase, terminalStatus === 'partial' ? 'partial' : 'done');
    assert.equal(counts.freshSessionReads - before, 1, 'same-revision derived view must reload once');
    const fresh = await context.reviewStatusPayload(await freshSession(fixture.id), { runId: terminal.id, includeDoc: true });
    assert.deepEqual(plain(status.doc), plain(fresh.doc)); assert.deepEqual(plain(status.result), plain(fresh.result));
    assert.deepEqual(plain(status.workVersion), plain(fresh.workVersion));
    entry.actualBytes = await assertActualBytes(status);
    entry.observed = plain({ status: status.status, hasResult: status.hasResult, reviewRunId: status.reviewRunId,
      running: status.running, waiting: status.waiting, phase: status.progress.phase, freshReads: counts.freshSessionReads - before });
    if (terminalStatus === 'completed') {
      const normalTouch = context.touchSession, boundedBefore = counts.freshSessionReads;
      context.touchSession = async () => { counts.freshSessionReads += 1; return structuredClone(projection); };
      try {
        await assert.rejects(context.reviewStatusPayload(projection, { runId: terminal.id }), { status: 503 });
        assert.equal(counts.freshSessionReads - boundedBefore, 3, 'persistent stale projection must stop at the existing retry bound');
        entry.boundedFreshReads = counts.freshSessionReads - boundedBefore;
      } finally { context.touchSession = normalTouch; }
    }
    assert.deepEqual(await readHashes(fixture.id), hashes, 'reconstructing the view never changes durable session or ledger');
  });
  await check('undo snapshot newer than the latest R2 receipt keeps restored R1 rather than selecting the newest job', async (entry) => {
    const fixture = await createFixture('history-race'); const r1 = await publishCompleted(fixture, 'R1-history');
    await advanceVersion(fixture); const r2 = await publishCompleted(fixture, 'R2-history');
    const current = await freshSession(fixture.id); current.history.cursor = 0; current.workVersion = fixture.initial.workVersion;
    current.doc = fixture.initial.doc; current.mutationEpoch += 1; history.selectReviewForHistory(current);
    const revision = current._storeRevision; delete current._storeRevision;
    await sessionStore.saveSessionSnapshot({ sessionId: fixture.id, snapshot: current, storageRoot: ROOTS.sessions, expectedRevision: revision });
    const restored = await freshSession(fixture.id); assert.ok(restored._storeRevision > r2.sessionReceipt.sessionRevision); assert.equal(restored.reviewRunId, r1.id);
    const hashes = await readHashes(fixture.id), before = counts.freshSessionReads;
    const status = await context.reviewStatusPayload(restored, { includeDoc: true });
    assert.equal(status.reviewRunId, r1.id); assert.equal(status.reviewJobId, r1.id); assert.equal(status.hasResult, true);
    assert.equal(status.result.issues[0].issueKey, 'software-R1-history'); assert.equal(status.workVersion.id, fixture.initial.workVersion.id);
    assert.equal(counts.freshSessionReads - before, 0, 'older terminal receipts do not override or reload newer undo facts');
    entry.actualBytes = await assertActualBytes(status);
    assert.deepEqual(await readHashes(fixture.id), hashes); entry.restoredRevision = restored._storeRevision; entry.latestReceiptRevision = r2.sessionReceipt.sessionRevision;
  });
  await check('newer completed version replaces stale cached document/version and remains identical to fresh status', async (entry) => {
    const fixture = await createFixture('version-race'); await advanceVersion(fixture); const terminal = await publishCompleted(fixture, 'R-version');
    const hashes = await readHashes(fixture.id); const before = counts.freshSessionReads;
    const status = await context.reviewStatusPayload(structuredClone(fixture.initial), { includeDoc: true });
    const fresh = await context.reviewStatusPayload(await freshSession(fixture.id), { includeDoc: true });
    assert.equal(status.hasResult, true); assert.equal(status.reviewRunId, terminal.id); assert.notEqual(status.workVersion.id, fixture.initial.workVersion.id);
    assert.deepEqual(plain(status.doc), plain(fresh.doc)); assert.deepEqual(plain(status.result), plain(fresh.result)); assert.deepEqual(plain(status.workVersion), plain(fresh.workVersion));
    entry.actualBytes = await assertActualBytes(status);
    assert.equal(counts.freshSessionReads - before, 1); assert.deepEqual(await readHashes(fixture.id), hashes);
  });
  await check('matching current completion receipt requires no fresh reload and includeDoc false omits document DTO', async (entry) => {
    const fixture = await createFixture('current-completion'); const terminal = await publishCompleted(fixture, 'R-current');
    const before = counts.freshSessionReads, hashes = await readHashes(fixture.id);
    const status = await context.reviewStatusPayload(await freshSession(fixture.id));
    assert.equal(status.hasResult, true); assert.equal(status.reviewRunId, terminal.id); assert.equal(Object.hasOwn(status, 'doc'), false);
    entry.actualBytes = await assertActualBytes(status);
    assert.equal(counts.freshSessionReads - before, 0); assert.deepEqual(await readHashes(fixture.id), hashes);
  });
  await check('legacy running snapshot without a job owner stays running-unverified and is never rewritten by a status read', async (entry) => {
    const fixture = await createFixture('legacy-unowned'); const current = await freshSession(fixture.id);
    current.reviewRunning = true; current.reviewRunId = 'legacy-software-run-without-owner'; current.reviewProgress = { phase: 'model' };
    delete current._storeRevision; await sessionStore.saveSessionSnapshot({ sessionId: fixture.id, snapshot: current, storageRoot: ROOTS.sessions, expectedRevision: 0 });
    const before = counts.freshSessionReads, hashes = await readHashes(fixture.id);
    const status = await context.reviewStatusPayload(await freshSession(fixture.id), { includeDoc: true });
    assert.equal(status.status, 'running-unverified'); assert.equal(status.running, true); assert.equal(status.waiting, false);
    assert.equal(status.hasResult, false); assert.equal(status.interrupted, false); assert.equal(status.reviewJobId, null);
    entry.actualBytes = await assertActualBytes(status);
    assert.equal(counts.freshSessionReads - before, 0); assert.deepEqual(await readHashes(fixture.id), hashes);
  });
  await check('queued job is waiting true, running false and has no completed result', async (entry) => {
    const fixture = await createFixture('queued'); const job = await enqueue(fixture, 'queued');
    const before = counts.freshSessionReads, hashes = await readHashes(fixture.id);
    const status = await context.reviewStatusPayload(structuredClone(fixture.initial), { includeDoc: true });
    assert.equal(status.status, 'queued'); assert.equal(status.waiting, true); assert.equal(status.running, false);
    assert.equal(status.hasResult, false); assert.equal(status.result, null); assert.equal(status.reviewRunId, job.id);
    assert.equal(status.reviewJobId, job.id); assert.equal(status.workVersionId, fixture.initial.workVersion.id);
    entry.actualBytes = await assertActualBytes(status);
    assert.equal(counts.freshSessionReads - before, 0); assert.deepEqual(await readHashes(fixture.id), hashes);
  });
} catch (error) { report.setupFailure = error.stack || String(error); }
finally {
  report.counts = counts; report.ok = !report.setupFailure && report.checks.every((entry) => entry.ok);
  report.passed = report.checks.filter((entry) => entry.ok).length; report.failed = report.checks.filter((entry) => !entry.ok).length;
  await writeFile(join(RUN, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Evidence: ${join(RUN, 'report.json')}`);
  console.log(`Read consistency: ${report.passed}/${report.checks.length}; servers 0; models 0.`);
  if (!report.ok) process.exitCode = 1;
}
