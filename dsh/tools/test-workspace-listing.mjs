/** Real stored queue facts; current server functions; no provider or live app. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { saveSessionSnapshot, loadSessionSnapshot } from '../src/session-store.js';
import { saveWorkspace, loadWorkspace } from '../src/workspace-store.js';
import { saveWorkingVersion, loadWorkingVersion, sha256 } from '../src/working-version.js';
import { initializeFixHistory, fixHistoryStatus, rememberCompletedReview } from '../src/fix-history.js';
import { parseDocxBuffer } from '../src/docx.js';
import { cleanDocx } from '../src/docx-clean.js';
import { writeZip } from '../src/zip-write.js';
import { effectiveReviewRunId } from '../src/human-state.js';
import { reviewJobActive, publicReviewJob } from '../src/review-server.js';
import { captureReviewSource, reviewedSourceDocument } from '../src/review-source.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selectedOut = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6);
const OUT = resolve(ROOT, selectedOut || `data/verify/workspace-listing-${Date.now()}.json`);
if (existsSync(OUT)) throw new Error('Evidence exists; choose a fresh --out.');
const source = await readFile(join(ROOT, 'server.mjs'), 'utf8');
function serverFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing server function ${name}`);
  const prefix = source.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start;
  const end = source.indexOf('\n}', start);
  if (end < 0) throw new Error(`Missing function end ${name}`);
  return source.slice(prefix, end + 2);
}
const report = {
  generatedAt: new Date().toISOString(), modelCalls: 0, realArkCalls: 0, checks: [],
  coverage: 'Current strict read-only server listing in a VM with real isolated session/workspace/version stores and generated software DOCX fixtures; job metadata is a frozen response stub. No live-owner execution, HTTP timing claim, browser, manuscript judgment, or model call.',
  testSha256: sha256(await readFile(fileURLToPath(import.meta.url))), serverSha256: sha256(source),
  workspacePayloadSha256: sha256(serverFunction('workspacePayload')),
  sessionStoreSha256: sha256(await readFile(join(ROOT, 'src/session-store.js'))),
  cleanModuleSha256: sha256(await readFile(join(ROOT, 'src/docx-clean.js'))),
  cleanXmlModuleSha256: sha256(await readFile(join(ROOT, 'src/docx-clean-xml.js'))),
  reviewServerSha256: sha256(await readFile(join(ROOT, 'src/review-server.js'))),
  jobStoreSha256: sha256(await readFile(join(ROOT, 'src/job-store.js'))),
  serverHelperSha256: Object.fromEntries(['originalCommentCount', 'cleaningProof', 'inspectWorkingClean', 'rememberCleanProof', 'cleanReviewGate', 'currentResultAvailable']
    .map((name) => [name, sha256(serverFunction(name))])),
};
const scratch = await mkdtemp(join(tmpdir(), 'dsh-listing-'));
const sessionRoot = join(scratch, 'sessions');
const versionRoot = join(scratch, 'versions');
const workspaceRoot = join(scratch, 'workspaces');
const counts = { snapshotReads: 0, sessionSaves: 0, touchCalls: 0, workingLoads: 0, parses: 0, cleanInspections: 0,
  jobMetadataReads: 0, separateJobReads: 0, separateQueueReads: 0, sessionJobReads: 0 };
const controls = { allowHydration: false, failSaves: false, readBarrier: null, beforeSnapshotReturn: null, jobViewError: null };
const jobViews = new Map();
const reviewRecovery = { state: 'done', error: null };
const reviewService = {
  workspaceView: async (workspaceId) => {
    counts.jobMetadataReads += 1;
    if (controls.jobViewError) throw controls.jobViewError;
    return structuredClone(jobViews.get(workspaceId) || { queue: null, jobs: [] });
  },
  queueView: () => { counts.separateQueueReads += 1; throw new Error('listing must use one atomic metadata view'); },
};
const sessions = new Map();
const context = createContext({
  Buffer, Map, Set, Object, JSON, Promise, Date, structuredClone,
  sessions, loadingSessions: new Map(), activeMutations: new Map(), MAX_SESSIONS: 40,
  initializeFixHistory, fixHistoryStatus, rememberCompletedReview, effectiveReviewRunId,
  reviewRecovery, reviewService, reviewJobActive, publicReviewJob,
  currentWorkspaceJobs: () => { counts.separateJobReads += 1; throw new Error('listing must not combine different metadata snapshots'); },
  currentSessionJob: async (sessionId) => { counts.sessionJobReads += 1;
    return structuredClone([...jobViews.values()].flatMap((view) => view.jobs).reverse().find((job) => job.sessionId === sessionId && reviewJobActive(job)) || null); },
  cleanDocx: (buffer) => {
    counts.cleanInspections += 1;
    assert.equal(controls.allowHydration, true, 'listing must not inspect or clean DOCX bytes');
    return cleanDocx(buffer);
  },
  loadSessionSnapshot: async ({ sessionId }) => {
    counts.snapshotReads += 1;
    const saved = await loadSessionSnapshot({ sessionId, storageRoot: sessionRoot });
    const barrier = controls.readBarrier;
    if (barrier?.sessionId === sessionId && barrier.remaining > 0) {
      barrier.remaining -= 1;
      if (barrier.remaining === 0) barrier.release();
      await barrier.ready;
    }
    if (controls.beforeSnapshotReturn) { const hook = controls.beforeSnapshotReturn; controls.beforeSnapshotReturn = null; await hook(saved); }
    return saved;
  },
  saveSessionSnapshot: async (args) => {
    counts.sessionSaves += 1;
    if (controls.failSaves) throw new Error('software fixture: session storage failure');
    // VM literals have a distinct Object.prototype. In the live server these
    // objects share the store realm; clone at this test boundary to match it.
    return saveSessionSnapshot({ ...args, snapshot: structuredClone(args.snapshot), storageRoot: sessionRoot });
  },
  loadWorkingVersion: async (args) => {
    counts.workingLoads += 1;
    assert.equal(controls.allowHydration, true, 'listing must not read working DOCX bytes');
    return loadWorkingVersion({ ...args, storageRoot: versionRoot });
  },
  parseDocxBuffer: (...args) => {
    counts.parses += 1;
    assert.equal(controls.allowHydration, true, 'listing must not parse DOCX');
    return parseDocxBuffer(...args);
  },
  touchSession: () => { counts.touchCalls += 1; throw new Error('listing must not touch/hydrate a session'); },
});
Object.assign(context, { captureReviewSource, reviewedSourceDocument });
runInContext(['originalCommentCount', 'cleaningProof', 'inspectWorkingClean', 'rememberCleanProof', 'cleanReviewGate', 'restoreReviewSources', 'sessionReviewSource',
  'persistSession', 'currentResultAvailable', 'workspacePayload'].map(serverFunction).join('\n'), context);
const baseline = () => ({ ...counts });
const delta = (before) => Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value - before[key]]));
const noHydration = (observed) => {
  assert.equal(observed.touchCalls, 0); assert.equal(observed.workingLoads, 0); assert.equal(observed.parses, 0);
  assert.equal(observed.cleanInspections, 0);
  assert.equal(observed.separateJobReads, 0); assert.equal(observed.separateQueueReads, 0);
  assert.equal(observed.sessionJobReads, 0);
};
const diskFacts = async (id) => {
  const saved = await loadSessionSnapshot({ sessionId: id, storageRoot: sessionRoot });
  return { sha256: sha256(await readFile(join(sessionRoot, id, 'state.json'))), revision: saved.manifest.revision, snapshot: saved.snapshot };
};
const metadataJob = (snapshot, status, seq = 1) => ({ id: 'r' + sha256(`${snapshot.id}:${status}:${seq}`), seq, sessionId: snapshot.id,
  config: { model: 'software-only', useModel: false, useRecheck: false, useContext: false, useCases: false,
    verdictWithModel: false, ruleMode: 'all', focus: [], recipe: sha256('software-listing-recipe'), resumedFromRunId: null },
  workspaceId: 'wlisting632', batchId: null, binding: { versionId: snapshot.workVersion.id }, status, cancelRequested: false,
  progress: { phase: status === 'running' ? 'model' : status, done: status === 'completed' ? 1 : 0, total: 2 }, sessionReceipt: null });
const fixture = (text) => writeZip([
  { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
  { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
  { name: 'word/document.xml', data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>` },
]);
const originalBuffer = fixture('软件性能验收原稿文字');
const workingBuffer = fixture('软件性能验收工作稿文字');
const originalCount = cleanDocx(originalBuffer).stats.beforeAfter.before.comments;
report.fixtureHashes = { originalSha256: sha256(originalBuffer), workingSha256: sha256(workingBuffer) };
const makeSnapshot = (id, version, mode = 'ready') => {
  const completed = mode === 'complete' || mode === 'partial' || mode === 'stale';
  // Execute the actual current server validator against this exact fixture and
  // immutable version. Validate once more to capture its idempotent persisted
  // currentVerification shape; opening the same saved stream needs no rewrite.
  const wasAllowed = controls.allowHydration;
  let clean;
  try {
    controls.allowHydration = true;
    const candidate = { buffer: workingBuffer, workVersion: version, doc: { originalCommentCount: originalCount } };
    candidate.clean = context.inspectWorkingClean(candidate);
    clean = structuredClone(context.inspectWorkingClean(candidate));
  } finally { controls.allowHydration = wasAllowed; }
  assert.equal(clean.status, 'unchanged');
  assert.equal(clean.validatedVersionId, version.id);
  assert.equal(clean.workSha256, sha256(workingBuffer));
  assert.equal(clean.sourceSha256, version.sourceSha256);
  assert.equal(clean.currentVerification.sha256, version.sha256);
  return {
    id, name: 'software-only.docx', createdAt: 1, workVersion: version,
    clean, cleanRecords: { [version.id]: clean },
    history: { entries: [{ versionId: version.id, appliedFixes: [] }], cursor: 0 },
    appliedFixes: [], mutationEpoch: 0, maxVersionRevision: 0,
    reviewRunning: false, reviewController: null, interrupted: mode === 'interrupted',
    reviewRunId: completed ? 'completed-software-run' : null,
    resultRunId: completed ? mode === 'stale' ? 'previous-run' : 'completed-software-run' : null,
    resultVersionId: completed ? version.id : null,
    result: completed ? { issues: [{ ruleId: 'SOFTWARE-ONLY' }], generatedAt: 'software-only' } : null,
    reviewProgress: { phase: mode === 'partial' ? 'partial' : completed ? 'done' : 'unreviewed' },
    reviewError: mode === 'failed' ? 'software failure' : null, cancelled: mode === 'cancelled',
  };
};
async function seed(id, mode = 'ready') {
  const version = await saveWorkingVersion({ sessionId: id, name: 'software-only.docx', buffer: workingBuffer, originalBuffer, storageRoot: versionRoot });
  const snapshot = makeSnapshot(id, version, mode);
  await saveSessionSnapshot({ sessionId: id, snapshot, expectedRevision: -1, storageRoot: sessionRoot });
  return snapshot;
}
const test = async (name, fn) => {
  try { const facts = await fn(); report.checks.push({ name, ok: true, ...facts }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, ok: false, error: error.stack || String(error) }); throw error; }
};

try {
  const modes = ['complete', 'partial', 'failed', 'cancelled', 'ready', 'stale'];
  const entries = [];
  // All 632 rows have real checked JSON and immutable software DOCX versions.
  for (let start = 0; start < 632; start += 8) {
    const batch = await Promise.all(Array.from({ length: Math.min(8, 632 - start) }, async (_, offset) => {
      const index = start + offset;
      const id = `slisting${index}`;
      await seed(id, modes[index % modes.length]);
      return { id, name: 'software-only.docx', index };
    }));
    entries.push(...batch);
  }
  const stored = {};
  for (const size of [64, 632]) {
    const workspaceId = `wlisting${size}`;
    await saveWorkspace({ workspaceId, workspace: { id: workspaceId, entries: entries.slice(0, size), receipts: { private: true }, queue: { state: 'ready' } }, expectedRevision: -1, storageRoot: workspaceRoot });
    stored[size] = await loadWorkspace({ workspaceId, storageRoot: workspaceRoot });
  }
  report.storedFixtureCount = entries.length;
  for (const size of [64, 632]) {
    await test(`${size} real stored rows across two cold list refreshes never hydrate or fill the LRU`, async () => {
      const before = baseline();
      for (let pass = 0; pass < 2; pass += 1) {
        const payload = await context.workspacePayload(stored[size], { softwareEvidence: true });
        assert.equal(payload.workspace.entries.length, size);
        assert.equal(payload.workspace.revision, stored[size].manifest.revision);
        assert.equal(payload.softwareEvidence, true);
        assert.equal(Object.hasOwn(payload.workspace, 'receipts'), false);
        assert.deepEqual(Array.from(payload.workspace.entries.slice(0, 6), (item) => item.status), ['complete', 'partial', 'failed', 'cancelled', 'ready', 'ready']);
        assert.equal(payload.workspace.entries[0].issueCount, 1);
        assert.equal(payload.workspace.entries[5].hasResult, false);
        assert.equal(sessions.size, 0);
        assert.equal(context.loadingSessions.size, 0);
      }
      const observed = delta(before);
      noHydration(observed); assert.equal(observed.snapshotReads, size * 2); assert.equal(observed.sessionSaves, 0);
      assert.equal(observed.jobMetadataReads, 2, 'each list consumes exactly one frozen ledger view');
      return { size, refreshes: 2, counts: observed, hydratedCacheSize: sessions.size };
    });
  }
  await test('active owner metadata projects over durable facts while cached runtime handles remain untouched', async () => {
    const saved = await loadSessionSnapshot({ sessionId: entries[10].id, storageRoot: sessionRoot });
    const live = { ...saved.snapshot, reviewRunning: true, reviewRunId: 'live-software-run',
      reviewController: { softwareHandle: true }, reviewProgress: { phase: 'model', done: 1, total: 2 }, lastUsed: 123 };
    sessions.set(live.id, live);
    const job = metadataJob(saved.snapshot, 'running');
    jobViews.set('wlisting632', { queue: null, jobs: [job] });
    const before = baseline();
    const payload = await context.workspacePayload(stored[632]);
    const row = payload.workspace.entries.find((item) => item.id === live.id);
    assert.equal(row.status, 'reviewing'); assert.equal(row.running, true); assert.equal(row.phase, 'model');
    assert.equal(row.hasResult, false); assert.equal(live.reviewController.softwareHandle, true);
    assert.equal(row.reviewRunId, job.id); assert.equal(row.reviewJob.id, job.id);
    assert.equal(live.reviewRunId, 'live-software-run', 'listing must not mutate or substitute cached state');
    assert.equal(live.interrupted, false); assert.equal(live.lastUsed, 123);
    assert.equal(sessions.size, 1); assert.equal(sessions.get(live.id), live);
    const observed = delta(before); noHydration(observed);
    assert.equal(observed.snapshotReads, 632); assert.equal(observed.sessionSaves, 0); assert.equal(observed.jobMetadataReads, 1);
    return { counts: observed, hydratedCacheSize: sessions.size };
  });
  await test('actual clean gate excludes archived results until explicit legacy cleaning verification, without list hydration', async () => {
    const pending = await seed('slistinglegacyunverified', 'complete');
    pending.legacy = { available: true, archiveId: 'software-only' };
    pending.clean = structuredClone(context.inspectWorkingClean({ ...pending, buffer: workingBuffer }));
    assert.equal(pending.clean.status, 'legacy-unverified');
    pending.cleanRecords = { [pending.workVersion.id]: pending.clean };
    await saveSessionSnapshot({ sessionId: pending.id, snapshot: pending, expectedRevision: 0, storageRoot: sessionRoot });
    const before = baseline();
    const payload = await context.workspacePayload({ workspace: { entries: [{ id: pending.id }], receipts: {} }, manifest: { revision: 0 } });
    const row = payload.workspace.entries[0];
    assert.equal(row.status, 'ready'); assert.equal(row.hasResult, false); assert.equal(row.issueCount, null);
    assert.equal(row.clean.status, 'legacy-unverified');
    assert.equal((await loadSessionSnapshot({ sessionId: pending.id, storageRoot: sessionRoot })).snapshot.result.issues.length, 1);
    const observed = delta(before); noHydration(observed); assert.equal(observed.snapshotReads, 1); assert.equal(observed.sessionSaves, 0);
    return { counts: observed, historicalResultPreserved: true };
  });
  await test('missing owner cannot be inferred dead from a cold read: running-unverified preserves the exact snapshot', async () => {
    const pending = await seed('slistinginterrupted', 'complete');
    pending.reviewRunning = true; pending.reviewRunId = 'pending-software-run'; pending.reviewVersionId = pending.workVersion.id;
    await saveSessionSnapshot({ sessionId: pending.id, snapshot: pending, expectedRevision: 0, storageRoot: sessionRoot });
    const queue = { workspace: { id: 'wrestart', entries: [{ id: pending.id }], receipts: {} }, manifest: { revision: 7 } };
    const initial = await diskFacts(pending.id);
    const before = baseline();
    const first = await context.workspacePayload(queue);
    const row = first.workspace.entries[0];
    assert.equal(row.status, 'running-unverified', row.error); assert.equal(row.running, true); assert.equal(row.hasResult, false);
    assert.equal(row.issueCount, null); assert.equal(row.reviewJob, null); assert.equal(row.waiting, false);
    const saved = await loadSessionSnapshot({ sessionId: pending.id, storageRoot: sessionRoot });
    assert.equal(saved.manifest.revision, initial.revision); assert.equal(saved.snapshot.reviewRunning, true);
    assert.equal(saved.snapshot.interrupted, false); assert.equal(saved.snapshot.reviewRunId, 'pending-software-run');
    assert.equal(saved.snapshot.resultRunId, 'completed-software-run', 'historical completed result remains');
    assert.equal(Object.hasOwn(saved.snapshot, '_storeRevision'), false);
    const second = await context.workspacePayload(queue);
    assert.equal(second.workspace.entries[0].status, 'running-unverified');
    assert.equal((await diskFacts(pending.id)).sha256, initial.sha256);
    assert.equal(sessions.has(pending.id), false);
    const observed = delta(before); noHydration(observed); assert.equal(observed.sessionSaves, 0); assert.equal(observed.snapshotReads, 2);
    return { counts: observed, savedRevision: saved.manifest.revision };
  });
  await test('cold listing remains read-only even if a hypothetical server save would fail', async () => {
    const pending = await seed('slistingfailpersist');
    pending.reviewRunning = true; pending.reviewRunId = 'uncommitted-software-run';
    await saveSessionSnapshot({ sessionId: pending.id, snapshot: pending, expectedRevision: 0, storageRoot: sessionRoot });
    const initial = await diskFacts(pending.id);
    controls.failSaves = true;
    try {
      const before = baseline();
      const payload = await context.workspacePayload({ workspace: { entries: [{ id: pending.id }], receipts: {} }, manifest: { revision: 0 } });
      assert.equal(payload.workspace.entries[0].status, 'running-unverified');
      const saved = await loadSessionSnapshot({ sessionId: pending.id, storageRoot: sessionRoot });
      assert.equal(saved.manifest.revision, 1); assert.equal(saved.snapshot.reviewRunning, true);
      assert.equal(saved.snapshot.interrupted, false); assert.equal(sessions.has(pending.id), false);
      noHydration(delta(before)); assert.equal(delta(before).sessionSaves, 0);
      assert.equal((await diskFacts(pending.id)).sha256, initial.sha256);
      return { counts: delta(before), savedRevision: saved.manifest.revision };
    } finally { controls.failSaves = false; }
  });
  await test('two simultaneous cold reads perform zero writes and cannot fabricate an interruption', async () => {
    const pending = await seed('slistingconcurrent');
    pending.reviewRunning = true; pending.reviewRunId = 'concurrent-software-run';
    await saveSessionSnapshot({ sessionId: pending.id, snapshot: pending, expectedRevision: 0, storageRoot: sessionRoot });
    const queue = { workspace: { entries: [{ id: pending.id }], receipts: {} }, manifest: { revision: 0 } };
    const initial = await diskFacts(pending.id);
    let release;
    const ready = new Promise((resolve) => { release = resolve; });
    controls.readBarrier = { sessionId: pending.id, remaining: 2, ready, release };
    const before = baseline();
    try {
      const payloads = await Promise.all([context.workspacePayload(queue), context.workspacePayload(queue)]);
      assert.ok(payloads.every((payload) => payload.workspace.entries[0].status === 'running-unverified'));
      assert.ok(payloads.every((payload) => payload.workspace.entries[0].running === true));
      const saved = await loadSessionSnapshot({ sessionId: pending.id, storageRoot: sessionRoot });
      assert.equal(saved.manifest.revision, initial.revision, 'listing must never commit a transition');
      assert.equal(saved.snapshot.reviewRunId, 'concurrent-software-run'); assert.equal(saved.snapshot.interrupted, false);
      assert.equal((await diskFacts(pending.id)).sha256, initial.sha256);
      assert.equal(sessions.has(pending.id), false);
      const observed = delta(before); noHydration(observed);
      assert.equal(observed.sessionSaves, 0); assert.equal(observed.snapshotReads, 2); assert.equal(observed.jobMetadataReads, 2);
      return { counts: observed, savedRevision: saved.manifest.revision };
    } finally { controls.readBarrier = null; }
  });
  await test('a newer persisted run committed during an older read is never overwritten or interrupted', async () => {
    const pending = await seed('slistingnewerrun');
    pending.reviewRunning = true; pending.reviewRunId = 'older-pending-run';
    await saveSessionSnapshot({ sessionId: pending.id, snapshot: pending, expectedRevision: 0, storageRoot: sessionRoot });
    let newerHash;
    controls.beforeSnapshotReturn = async () => {
      const latest = await loadSessionSnapshot({ sessionId: pending.id, storageRoot: sessionRoot });
      latest.snapshot.reviewRunId = 'newer-pending-run';
      await saveSessionSnapshot({ sessionId: pending.id, snapshot: latest.snapshot, expectedRevision: latest.manifest.revision, storageRoot: sessionRoot });
      newerHash = (await diskFacts(pending.id)).sha256;
    };
    const before = baseline();
    try {
      const payload = await context.workspacePayload({ workspace: { entries: [{ id: pending.id }], receipts: {} }, manifest: { revision: 0 } });
      assert.equal(payload.workspace.entries[0].status, 'running-unverified');
      const latest = await loadSessionSnapshot({ sessionId: pending.id, storageRoot: sessionRoot });
      assert.equal(latest.manifest.revision, 2); assert.equal(latest.snapshot.reviewRunId, 'newer-pending-run');
      assert.equal(latest.snapshot.reviewRunning, true); assert.equal(latest.snapshot.interrupted, false);
      assert.equal((await diskFacts(pending.id)).sha256, newerHash);
      const next = await context.workspacePayload({ workspace: { entries: [{ id: pending.id }], receipts: {} }, manifest: { revision: 0 } });
      assert.equal(next.workspace.entries[0].status, 'running-unverified');
      assert.equal((await diskFacts(pending.id)).sha256, newerHash);
      noHydration(delta(before)); assert.equal(delta(before).sessionSaves, 0);
      return { counts: delta(before), savedRevision: latest.manifest.revision, unchangedNewerSha256: newerHash };
    } finally { controls.beforeSnapshotReturn = null; }
  });
  await test('queued, running and publishing owners project only frozen metadata and preserve prior results on disk', async () => {
    const workspaceId = 'wlistingowners';
    const ownerEntries = [], jobs = [], originals = new Map();
    for (const [index, state] of ['queued', 'running', 'publishing'].entries()) {
      const saved = await seed(`slistingowner${index}`, 'complete');
      const job = { ...metadataJob(saved, state, index + 1), workspaceId };
      ownerEntries.push({ id: saved.id }); jobs.push(job); originals.set(saved.id, await diskFacts(saved.id));
    }
    jobViews.set(workspaceId, { queue: null, jobs });
    const before = baseline();
    const payload = await context.workspacePayload({ workspace: { id: workspaceId, entries: ownerEntries, receipts: {}, queue: { state: 'ready' } }, manifest: { revision: 1 } });
    assert.deepEqual(Array.from(payload.workspace.entries, (entry) => entry.status), ['queued', 'reviewing', 'reviewing']);
    for (const [index, row] of payload.workspace.entries.entries()) {
      assert.equal(row.hasResult, false); assert.equal(row.issueCount, null); assert.equal(row.running, true);
      assert.equal(row.waiting, index === 0); assert.equal(row.reviewRunId, jobs[index].id); assert.equal(row.reviewJobId, jobs[index].id);
      assert.equal(row.reviewJob.status, jobs[index].status); assert.equal(row.phase, jobs[index].progress.phase);
      assert.equal((await diskFacts(row.id)).sha256, originals.get(row.id).sha256, 'metadata projection must not persist into session');
      assert.equal((await diskFacts(row.id)).snapshot.result.issues.length, 1, 'historical completed result stays durable');
    }
    const observed = delta(before); noHydration(observed); assert.equal(observed.sessionSaves, 0);
    assert.equal(observed.jobMetadataReads, 1); assert.equal(observed.snapshotReads, ownerEntries.length);
    return { counts: observed, frozenOwnerStates: jobs.map((job) => job.status) };
  });
  await test('terminal facts come from checked session snapshots and never inherit a cached live run', async () => {
    const workspaceId = 'wlistingterminals';
    const terminalEntries = [], jobs = [], originals = new Map();
    for (const [index, state] of ['completed', 'partial', 'failed', 'cancelled', 'interrupted'].entries()) {
      const saved = await seed(`slistingterminal${index}`, state === 'completed' ? 'complete' : state);
      const job = { ...metadataJob(saved, state, index + 10), workspaceId };
      saved.reviewJobId = job.id; saved.reviewRunId = job.id;
      if (['completed', 'partial'].includes(state)) saved.resultRunId = job.id;
      saved.reviewProgress = { phase: { completed: 'done', partial: 'partial', failed: 'error', cancelled: 'cancelled', interrupted: 'interrupted' }[state] };
      await saveSessionSnapshot({ sessionId: saved.id, snapshot: saved, expectedRevision: 0, storageRoot: sessionRoot });
      terminalEntries.push({ id: saved.id }); jobs.push(job); originals.set(saved.id, await diskFacts(saved.id));
    }
    jobViews.set(workspaceId, { queue: null, jobs });
    const cached = { ...originals.get(terminalEntries[0].id).snapshot, reviewRunning: true,
      reviewRunId: 'cached-stale-run', reviewController: { softwareHandle: true } };
    sessions.set(cached.id, cached);
    const before = baseline();
    try {
      const payload = await context.workspacePayload({ workspace: { id: workspaceId, entries: terminalEntries, receipts: {}, queue: { state: 'ready' } }, manifest: { revision: 0 } });
      assert.deepEqual(Array.from(payload.workspace.entries, (entry) => entry.status), ['complete', 'partial', 'failed', 'cancelled', 'interrupted']);
      for (const [index, row] of payload.workspace.entries.entries()) {
        assert.equal(row.running, false); assert.equal(row.waiting, false); assert.equal(row.reviewJob, null);
        assert.equal(row.reviewJobId, jobs[index].id); assert.equal(row.hasResult, index < 2);
        assert.equal(row.reviewRunId, effectiveReviewRunId(originals.get(row.id).snapshot));
        assert.equal((await diskFacts(row.id)).sha256, originals.get(row.id).sha256);
      }
      assert.equal(sessions.get(cached.id), cached); assert.equal(cached.reviewRunId, 'cached-stale-run');
      assert.equal(cached.reviewController.softwareHandle, true);
      const observed = delta(before); noHydration(observed); assert.equal(observed.sessionSaves, 0); assert.equal(observed.snapshotReads, terminalEntries.length);
      return { counts: observed, terminalJobIdsPreserved: true, cachedHandlePreserved: true };
    } finally { sessions.delete(cached.id); }
  });
  await test('queue summary and row owner states use one ledger view even if metadata changes during session reads', async () => {
    const workspaceId = 'wlistingatomic';
    const saved = await seed('slistingatomic', 'complete');
    const queued = { ...metadataJob(saved, 'queued'), workspaceId };
    const running = { ...queued, status: 'running', progress: { phase: 'model', done: 1, total: 2 } };
    const view = (job, state) => ({ jobs: [job], queue: { runId: 'q-atomic', state, ledgerRevision: state === 'queued' ? 1 : 2,
      counts: { total: 1, queued: state === 'queued' ? 1 : 0, running: state === 'queued' ? 0 : 1 }, items: [publicReviewJob(job)] } });
    jobViews.set(workspaceId, view(queued, 'queued'));
    controls.beforeSnapshotReturn = async () => { jobViews.set(workspaceId, view(running, 'running')); };
    const stored = { workspace: { id: workspaceId, entries: [{ id: saved.id }], receipts: {}, queue: { state: 'ready' } }, manifest: { revision: 0 } };
    const before = baseline();
    try {
      const first = await context.workspacePayload(stored);
      assert.equal(first.workspace.queue.ledgerRevision, 1); assert.equal(first.workspace.queue.counts.queued, 1);
      assert.equal(first.workspace.entries[0].status, 'queued'); assert.equal(first.workspace.queue.items[0].status, 'queued');
      const second = await context.workspacePayload(stored);
      assert.equal(second.workspace.queue.ledgerRevision, 2); assert.equal(second.workspace.queue.counts.running, 1);
      assert.equal(second.workspace.entries[0].status, 'reviewing'); assert.equal(second.workspace.queue.items[0].status, 'running');
      const observed = delta(before); noHydration(observed); assert.equal(observed.jobMetadataReads, 2); assert.equal(observed.sessionSaves, 0);
      return { counts: observed, observedLedgerRevisions: [1, 2] };
    } finally { controls.beforeSnapshotReturn = null; }
  });
  await test('review recovery failure returns explicit 503 before any list read instead of a false empty workspace', async () => {
    reviewRecovery.state = 'error'; reviewRecovery.error = { message: 'software job metadata recovery failure' };
    const before = baseline();
    try {
      await assert.rejects(context.workspacePayload(stored[632]), (error) => error.status === 503 && /恢复/.test(error.message));
      const observed = delta(before); noHydration(observed); assert.equal(observed.snapshotReads, 0);
      assert.equal(observed.jobMetadataReads, 0); assert.equal(observed.sessionSaves, 0);
      return { counts: observed, status: 503, returnedEmptyWorkspace: false };
    } finally { reviewRecovery.state = 'done'; reviewRecovery.error = null; }
  });
  await test('metadata view errors propagate instead of silently hiding owner jobs', async () => {
    controls.jobViewError = Object.assign(new Error('software metadata unavailable'), { status: 503 });
    const before = baseline();
    try {
      await assert.rejects(context.workspacePayload(stored[632]), (error) => error.status === 503 && /metadata unavailable/.test(error.message));
      const observed = delta(before); noHydration(observed); assert.equal(observed.snapshotReads, 0);
      assert.equal(observed.jobMetadataReads, 1); assert.equal(observed.sessionSaves, 0);
      return { counts: observed, status: 503, returnedEmptyWorkspace: false };
    } finally { controls.jobViewError = null; }
  });
  await test('missing directory, missing state, malformed JSON and checksum damage explicitly project unavailable rows', async () => {
    await seed('slistingmissingstate');
    await unlink(join(sessionRoot, 'slistingmissingstate', 'state.json'));
    await seed('slistingbadjson');
    await writeFile(join(sessionRoot, 'slistingbadjson', 'state.json'), '{');
    await seed('slistingbadhash');
    const hashPath = join(sessionRoot, 'slistingbadhash', 'state.json');
    const file = JSON.parse(await readFile(hashPath, 'utf8')); file.payloadSha256 = '0'.repeat(64);
    await writeFile(hashPath, JSON.stringify(file));
    const ids = ['slistingnotfound', 'slistingmissingstate', 'slistingbadjson', 'slistingbadhash'];
    const before = baseline();
    const payload = await context.workspacePayload({ workspace: { entries: [...ids.map((id) => ({ id })), { name: 'software-upload-failure' }], receipts: {} }, manifest: { revision: 1 } });
    assert.ok(payload.workspace.entries.slice(0, 4).every((entry) => entry.status === 'unavailable' && entry.error));
    assert.equal(payload.workspace.entries[4].status, 'upload-failed');
    assert.ok(ids.every((id) => !sessions.has(id))); noHydration(delta(before));
    return { counts: delta(before), unavailableRows: ids.length };
  });
  await test('opening an active manuscript still uses the actual immutable bytes and original DOCX parser', async () => {
    runInContext(['evictSessions', 'restoreStoredSession', 'touchSession'].map(serverFunction).join('\n'), context);
    controls.allowHydration = true;
    const before = baseline();
    const selected = entries[631];
    const session = await context.touchSession(selected.id);
    assert.equal(session.id, selected.id); assert.deepEqual(session.buffer, workingBuffer);
    assert.deepEqual(session.originalBuffer, originalBuffer);
    assert.equal(session.doc.paragraphs[0].text, '软件性能验收工作稿文字');
    assert.equal(session.workVersion.sha256, sha256(workingBuffer));
    assert.equal(session._storeRevision, 0); assert.equal(sessions.get(selected.id), session);
    assert.equal(context.loadingSessions.size, 0);
    const observed = delta(before); assert.equal(observed.workingLoads, 1); assert.equal(observed.parses, 2);
    assert.equal(observed.cleanInspections, 2, 'actual original-count and saved-working validators execute only on editor open');
    assert.equal(observed.snapshotReads, 1); assert.equal(observed.sessionSaves, 0);
    controls.allowHydration = false;
    // Keep touchSession disabled for the list even after actual open verification.
    context.touchSession = () => { counts.touchCalls += 1; throw new Error('listing must not touch/hydrate a session'); };
    return { counts: observed, hydratedCacheSize: sessions.size };
  });
  await test('632-row refresh with live review and opened editor preserves both handles and performs zero further DOCX restores', async () => {
    const cached = new Map(sessions); const before = baseline();
    const payload = await context.workspacePayload(stored[632]);
    assert.equal(payload.workspace.entries.length, 632); assert.equal(sessions.size, 2);
    for (const [id, session] of cached) assert.equal(sessions.get(id), session);
    assert.equal(payload.workspace.entries[10].status, 'reviewing');
    assert.equal(payload.workspace.entries[631].status, 'partial');
    const observed = delta(before); noHydration(observed);
    assert.equal(observed.snapshotReads, 632); assert.equal(observed.sessionSaves, 0); assert.equal(observed.jobMetadataReads, 1);
    return { counts: observed, hydratedCacheSize: sessions.size };
  });
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack || String(error); process.exitCode = 1;
} finally {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  // Remove only the scratch directory created by this invocation.
  const scratchRelative = relative(resolve(tmpdir()), resolve(scratch));
  if (!scratchRelative || scratchRelative.startsWith('..') || isAbsolute(scratchRelative) || !scratchRelative.startsWith('dsh-listing-')) throw new Error('Unsafe scratch cleanup path');
  await rm(scratch, { recursive: true, force: true });
  console.log(`Evidence: ${OUT}`);
}
