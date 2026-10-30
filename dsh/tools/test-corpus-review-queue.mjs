/** Real manifest DOCX, real review adapter, rules only. Software execution evidence only. */
import assert from 'node:assert/strict';
import fsPromises, {readFile, writeFile, appendFile, readdir, mkdir, stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve, join, dirname, basename, relative, isAbsolute, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const limit = Number(flag('limit', 0)); const batchSize = Number(flag('batch-size', 32));
const timeoutMs = Number(flag('timeout-ms', 180000));
assert.ok(Number.isSafeInteger(limit) && limit >= 0 && Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= 128);
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000);
const run = JSON.parse(await readFile(join(PROJECT, 'tmp/review-queue-current-run.json'), 'utf8'));
const attemptId = `corpus-review-queue-${Date.now()}-${randomUUID().slice(0, 8)}`;
const attemptDirectory = resolve(run.runDirectory, 'tests', attemptId);
assert.equal(existsSync(attemptDirectory), false, 'Each attempt must have a fresh evidence directory');
await mkdir(attemptDirectory);
const OUT = join(attemptDirectory, 'report.json'); const ROWS = join(attemptDirectory, 'assets.jsonl');
const STORAGE = join(attemptDirectory, 'storage');
const ENV_ROOTS = {DSH_JOB_ROOT: 'jobs', DSH_SESSION_ROOT: 'sessions', DSH_WORKING_VERSION_ROOT: 'versions',
  DSH_WORKSPACE_ROOT: 'workspaces', DSH_AUDIT_ROOT: 'audit', DSH_LEGACY_ROOT: 'legacy', DSH_INGESTION_ROOT: 'ingestions'};
const roots = Object.fromEntries(Object.values(ENV_ROOTS).map((name) => [name, join(STORAGE, name)]));
const removedEnvironmentNames = [];
for (const key of Object.keys(process.env)) if (/^DSH_/i.test(key) || /(?:ARK|OPENAI|DOUBAO|VOLC|ANTHROPIC|GEMINI|API_KEY|ACCESS_TOKEN|SECRET|CREDENTIAL|PROXY)/i.test(key)
  || /^(?:NODE_OPTIONS|NODE_USE_ENV_PROXY)$/i.test(key)) { removedEnvironmentNames.push(key); delete process.env[key]; }
for (const [key, name] of Object.entries(ENV_ROOTS)) { process.env[key] = roots[name]; await mkdir(roots[name], {recursive: true}); }
process.env.DSH_REVIEW_WORKERS = '2';
Object.assign(process.env, {ARK_CONTEXT: '0', ARK_CASES: '0', ARK_CONSISTENCY: '0', ARK_PREFIX_CACHE: '0'});
const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const plain = (value) => JSON.parse(JSON.stringify(value));
const vector = (doc) => Object.fromEntries(['paragraphs', 'footnotes', 'endnotes'].map((key) => [key, (doc[key] || []).map((item) => item.text || '')]));
const within = (root, path) => { const part = relative(resolve(root), resolve(path)); return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const report = {schemaVersion: 1, runId: run.runId, attemptId, startedAt: new Date().toISOString(), out: OUT, rows: ROWS,
  roots, environmentRoots: Object.fromEntries(Object.keys(ENV_ROOTS).map((key) => [key, process.env[key]])), documentWorkerLimit: 2,
  sourceKind: 'Every selected original manifest DOCX path, actual rules-only adapter execution',
  stage: 'software_queue_execution', semanticReviewPerformed: false, semanticQualityClaimed: false,
  realArkCalls: 0, paidModelCalls: 0, modelCalls: 0, networkAttempts: 0, serversStarted: 0,
  removedEnvironmentNames, selectedLimit: limit || null, batches: [], checks: [], failures: [], runtimeErrors: [],
  callbacks: {getSession: 0, persistSession: 0, executionStarts: 0, workingVersionLoads: 0}, metadataReadChecks: [],
  peakObservedRunningJobs: 0, workerCapacityObservations: 0};
globalThis.fetch = () => { report.networkAttempts++; throw new Error('Network/model access is forbidden in corpus queue software tests'); };
await writeFile(join(attemptDirectory, 'boot.json'), JSON.stringify({attemptId, roots, environmentRoots: report.environmentRoots,
  policy: {serversStarted: 0, modelCalls: 0, providerCredentialPresent: !!process.env.ARK_API_KEY, useModel: false,
    useRecheck: false, useContext: false, useCases: false, documentWorkerLimit: 2}}, null, 2) + '\n', {flag: 'wx'});

const sourceFiles = ['tools/test-corpus-review-queue.mjs', 'tools/paths.mjs', 'src/review-server.js', 'src/review-runtime.js', 'src/job-store.js',
  'src/review.js', 'src/ark.js', 'src/recheck.js', 'src/ingestion-store.js', 'src/session-store.js', 'src/workspace-store.js',
  'src/working-version.js', 'src/docx.js', 'src/docx-clean.js', 'src/docx-clean-xml.js', 'src/fix-history.js', 'src/anchors.js',
  'src/scanner-format.js', 'src/scanner-language.js', 'src/scanner-citation.js'];
for (const name of (await readdir(join(PROJECT, 'rules'))).sort()) if (name.endsWith('.json')) sourceFiles.push(`rules/${name}`);
const fingerprints = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async (name) => [name, hash(await readFile(join(PROJECT, name)))])));
report.fingerprints = await fingerprints();
const {CORPUS_ROOT} = await import('./paths.mjs');
const {submitIngestion} = await import('../src/ingestion-store.js');
const {loadWorkingVersion} = await import('../src/working-version.js');
const {loadSessionSnapshot, saveSessionSnapshot} = await import('../src/session-store.js');
const {loadWorkspace} = await import('../src/workspace-store.js');
const {parseDocxBuffer} = await import('../src/docx.js');
const {cleanDocx} = await import('../src/docx-clean.js');
const {createServerReviewService, reviewStoreArgs} = await import('../src/review-server.js');
const store = await import('../src/job-store.js');
const manifestPath = join(PROJECT, 'data/corpus/manifest.json'); const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString()); const allDocx = manifest.filter((item) => /\.docx$/i.test(item.path));
const selected = limit ? allDocx.slice(0, limit) : allDocx;
Object.assign(report, {manifestPath, manifestSha256: hash(manifestBytes), totalManifestDocx: allDocx.length, selected: selected.length,
  corpusRoot: resolve(CORPUS_ROOT), sourceStabilityChecked: false});
assert.equal(allDocx.length, 632, 'Full DOCX path denominator must remain the frozen 632');
const ingestionArgs = {storageRoot: roots.ingestions, sessionRoot: roots.sessions, workspaceRoot: roots.workspaces, versionRoot: roots.versions};
const options = {useModel: false, useRecheck: false, useContext: false, useCases: false, verdictWithModel: false, ruleMode: 'all', model: 'software-rules-only', focus: []};
const starts = new Map(); const loadedProvenance = new Map(); let service;
let savedRows = 0; let finishedRows = 0;
function check(name, value, detail) { report.checks.push({name, ok: !!value, ...(detail ? {detail} : {})}); if (!value) report.failures.push({check: name, detail}); }
function rowCheck(row, name, value, detail) { row.checks[name] = !!value; if (!value) row.failures.push({check: name, ...(detail ? {detail} : {})}); }
async function getSession(id) {
  report.callbacks.getSession++;
  const stored = await loadSessionSnapshot({sessionId: id, storageRoot: roots.sessions});
  const saved = await loadWorkingVersion({sessionId: id, versionId: stored.snapshot.workVersion.id, storageRoot: roots.versions});
  report.callbacks.workingVersionLoads++;
  assert.equal(saved.version.sha256, stored.snapshot.workVersion.sha256);
  assert.equal(saved.version.sourceSha256, stored.snapshot.workVersion.sourceSha256);
  const s = {...stored.snapshot, _storeRevision: stored.manifest.revision, workVersion: saved.version,
    buffer: saved.buffer, originalBuffer: saved.originalBuffer, doc: parseDocxBuffer(saved.buffer, stored.snapshot.name)};
  s.doc._softwareQueueProvenance = {versionId: saved.version.id, sourceSha256: saved.version.sourceSha256};
  loadedProvenance.set(id, {versionId: saved.version.id, sourceSha256: saved.version.sourceSha256}); return s;
}
async function persistSession(s) {
  report.callbacks.persistSession++;
  if (s.reviewRunning && s.reviewJobId) {
    starts.set(s.reviewJobId, (starts.get(s.reviewJobId) || 0) + 1); report.callbacks.executionStarts++;
    const jobs = await store.listJobs(reviewStoreArgs); const running = jobs.filter((job) => ['running', 'publishing'].includes(job.status) && job.lease);
    report.workerCapacityObservations++; report.peakObservedRunningJobs = Math.max(report.peakObservedRunningJobs, running.length);
    assert.ok(running.length <= 2, 'The shared document worker capacity must never exceed two');
  }
  const manifest = await saveSessionSnapshot({sessionId: s.id, snapshot: s, expectedRevision: s._storeRevision, storageRoot: roots.sessions});
  s._storeRevision = manifest.revision; return manifest;
}
async function metadataQueueView(workspaceId, batchId) {
  const original = fsPromises.readFile; const deniedPaths = []; const attemptedPaths = []; const beforeLoads = report.callbacks.workingVersionLoads;
  fsPromises.readFile = async (path, ...args) => {
    const name = String(path); attemptedPaths.push(name);
    if (/\.docx$/i.test(name) || within(join(roots.jobs, 'outcomes'), name)) { deniedPaths.push(name); throw new Error('Metadata queueView attempted document/outcome I/O'); }
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  let queue;
  try { queue = await service.queueView(workspaceId, {batchId}); }
  finally { fsPromises.readFile = original; syncBuiltinESMExports(); }
  const fact = {workspaceId, batchId, readCount: attemptedPaths.length, deniedPaths,
    documentHydrationDelta: report.callbacks.workingVersionLoads - beforeLoads, jobRootRead: attemptedPaths.some((name) => within(roots.jobs, name))};
  report.metadataReadChecks.push(fact); assert.equal(deniedPaths.length, 0); assert.equal(fact.documentHydrationDelta, 0); return queue;
}
async function terminalJob(jobId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await store.loadJob({...reviewStoreArgs, jobId});
    if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job;
    await sleep(100);
  }
  throw Object.assign(new Error(`Task did not reach a terminal state within ${timeoutMs}ms`), {code: 'CORPUS_QUEUE_TIMEOUT', jobId});
}
async function artifactHashes(job) {
  const paths = {ledger: join(roots.jobs, 'ledger/state.json'), session: join(roots.sessions, job.sessionId, 'state.json'),
    outcome: join(roots.jobs, 'outcomes', job.id, job.sessionId, 'state.json')};
  const result = {};
  for (const [key, path] of Object.entries(paths)) result[key] = hash(await readFile(path));
  result.events = {};
  for (const receipt of job.eventReceipts) result.events[receipt.name] = hash(await readFile(join(roots.jobs, 'events', job.id, receipt.name)));
  return result;
}
async function inspectJob(row, job) {
  row.jobId = job.id; row.batchId = job.batchId; row.terminalStatus = job.status; row.eventSeq = job.eventSeq;
  rowCheck(row, 'jobCompletedSoftwareRules', job.status === 'completed', {status: job.status});
  rowCheck(row, 'sourceVersionRunBinding', job.sessionId === row.sessionId && job.binding.sourceSha256 === row.sourceSha256
    && job.binding.versionId === row.versionId && job.binding.workSha256 === row.workSha256 && job.binding.mutationEpoch === 0);
  rowCheck(row, 'allModelOptionsDisabled', ['useModel', 'useRecheck', 'useContext', 'useCases'].every((key) => job.config[key] === false));
  rowCheck(row, 'oneActualExecution', starts.get(job.id) === 1, {starts: starts.get(job.id)});
  const outcome = await store.loadJobOutcome({...reviewStoreArgs, jobId: job.id});
  const session = await loadSessionSnapshot({sessionId: row.sessionId, storageRoot: roots.sessions});
  rowCheck(row, 'outcomeAndSessionSameRun', outcome.status === job.status && session.snapshot.reviewJobId === job.id
    && session.snapshot.reviewRunId === job.id && session.snapshot.resultRunId === job.id && session.snapshot.resultVersionId === row.versionId);
  rowCheck(row, 'persistedResultExactlyMatchesOutbox', equal(session.snapshot.result, outcome.result));
  rowCheck(row, 'noModelResultOrSelfVerificationInvented', outcome.result?.modelResult === null && outcome.result?.recheck === null);
  // A deliberately named software witness exercises typed Map preservation
  // without fabricating model verdicts or changing the real rule result.
  const outcomeMap = outcome.texts?.softwareTypedProbe; const sessionMap = session.snapshot.resultTexts?.softwareTypedProbe;
  rowCheck(row, 'typedMapSoftwareWitnessPreserved', outcomeMap instanceof Map && sessionMap instanceof Map
    && equal(outcomeMap.get('provenance'), {versionId: row.versionId, sourceSha256: row.sourceSha256})
    && equal(sessionMap.get('provenance'), outcomeMap.get('provenance')));
  const records = session.snapshot.reviewRecords.filter((record) => record.id === job.id);
  rowCheck(row, 'oneCompletedHistoricalRecord', records.length === 1 && records[0].versionId === row.versionId);
  const events = await store.readJobEvents({...reviewStoreArgs, jobId: job.id, afterSeq: 0, limit: Number.MAX_SAFE_INTEGER});
  const terminal = events.filter((event) => ['done', 'error', 'cancelled'].includes(event.type));
  rowCheck(row, 'monotonicIdentityBoundEventSequence', events.length === job.eventSeq
    && events.every((event, index) => event.seq === index + 1 && event.jobRunId === job.id && event.versionId === row.versionId));
  rowCheck(row, 'singleFinalDoneEvent', terminal.length === 1 && terminal[0].type === 'done' && terminal[0].seq === job.eventSeq
    && terminal[0].data.jobRunId === job.id && terminal[0].data.versionId === row.versionId);
  rowCheck(row, 'terminalIssueListMatchesActualResult', equal(terminal[0]?.data.issues, outcome.result?.issues));
  rowCheck(row, 'sessionReceiptIsMetadataOnly', !Object.hasOwn(job.sessionReceipt, 'terminalData') && !Object.hasOwn(job.sessionReceipt, 'result'));
  rowCheck(row, 'originalDiskHashUnchanged', hash(await readFile(row.fullPath)) === row.sourceSha256);
  row.sessionManifestSha256 = session.manifest.manifestSha256; row.resultIssueCount = outcome.result?.issues?.length ?? null;
  row.resultSha256 = hash(JSON.stringify(outcome.result)); row.modelCalls = 0; row.semanticQualityClaimed = false;
  return job;
}

try {
  service = await createServerReviewService({getSession, persistSession, adoptSession: () => {},
    serializeDoc: (doc) => ({name: doc.name, stats: doc.stats, ...vector(doc)}),
    serializeReview: (result, doc, session) => ({...plain(result), sessionId: session.id,
      reviewRunId: session.reviewRunId, workVersionId: session.workVersion.id, softwareVerificationOnly: true}),
    humanState: () => ({softwareVerificationOnly: true, decisions: {}, marks: []}),
    cleanGate: (s) => !['cleaned', 'unchanged'].includes(s.clean?.status),
    reviewTexts: (doc) => ({...vector(doc), softwareTypedProbe: new Map([['provenance', doc._softwareQueueProvenance]])}),
    defaultModel: options.model, onError: (error, context) => report.runtimeErrors.push({code: error.code || null, message: error.message, ...context})});
  check('serviceBootUsesSeventhIsolatedJobRootAndWorkerTwo', reviewStoreArgs.storageRoot === roots.jobs && reviewStoreArgs.documentWorkerLimit === 2);
  for (let offset = 0; offset < selected.length; offset += batchSize) {
    const batchIndex = Math.floor(offset / batchSize); const workspaceId = `w${attemptId.replace(/[^a-z0-9]/g, '')}b${batchIndex}`;
    const batchRows = []; const batchRecord = {index: batchIndex, workspaceId, offset, count: Math.min(batchSize, selected.length - offset), failures: []};
    report.batches.push(batchRecord);
    for (const [localIndex, item] of selected.slice(offset, offset + batchSize).entries()) {
      const index = offset + localIndex; const fullPath = resolve(CORPUS_ROOT, item.path);
      const row = {index, path: item.path, fullPath, stage: 'software_queue_execution', status: 'failed', checks: {}, failures: [],
        sourceSha256: item.sha256, verificationRunId: attemptId, semanticQualityClaimed: false}; batchRows.push(row);
      try {
        assert.ok(within(CORPUS_ROOT, fullPath)); const source = await readFile(fullPath); const inputStat = await stat(fullPath);
        rowCheck(row, 'sourceHashMatchesManifest', hash(source) === item.sha256); rowCheck(row, 'sourceSizeMatchesDisk', source.length === inputStat.size);
        const cleaned = cleanDocx(source); const originalVector = vector(parseDocxBuffer(source, basename(item.path)));
        rowCheck(row, 'independentCleaningPreservesTextVectors', equal(originalVector, vector(parseDocxBuffer(cleaned.buffer, basename(item.path)))));
        const accepted = await submitIngestion({...ingestionArgs, workspaceId, operationId: `source-${index}`, name: basename(item.path), size: source.length,
          purpose: 'verification', verificationRunId: attemptId, buffer: source});
        row.sessionId = accepted.record.sessionId; row.ingestionId = accepted.record.ingestionId;
        row.versionId = accepted.record.workVersion.id; row.workSha256 = accepted.record.workVersion.sha256;
        rowCheck(row, 'cleanV0AndSourceAccepted', accepted.record.status === 'completed' && accepted.record.source.sha256 === item.sha256
          && accepted.record.workVersion.revision === 0 && accepted.record.workVersion.sha256 === hash(cleaned.buffer)
          && accepted.snapshot.workVersion.id === row.versionId && accepted.snapshot.result === null);
      } catch (error) { row.failures.push({stage: 'ingestion', code: error.code || null, message: error.message, stack: error.stack}); }
    }
    const acceptedRows = batchRows.filter((row) => row.sessionId);
    if (acceptedRows.length) {
      const operationId = `batch-${batchIndex}`;
      try {
        const storedWorkspace = await loadWorkspace({workspaceId, storageRoot: roots.workspaces});
        const started = await service.controlQueue(storedWorkspace.workspace, {action: 'start', operationId, options, concurrency: 2});
        batchRecord.batchId = started.command.runId; batchRecord.startQueue = started.queue;
        const jobs = await store.listJobs({...reviewStoreArgs, batchId: batchRecord.batchId});
        assert.deepEqual(jobs.map((job) => job.sessionId), acceptedRows.map((row) => row.sessionId));
        for (const [index, job] of jobs.entries()) {
          const row = acceptedRows[index];
          try { await inspectJob(row, await terminalJob(job.id)); }
          catch (error) { row.failures.push({stage: 'execution-or-publication', code: error.code || null, message: error.message, stack: error.stack}); }
        }
        const queue = await metadataQueueView(workspaceId, batchRecord.batchId); batchRecord.finalQueue = queue;
        batchRecord.completeCountMatches = queue.counts.total === jobs.length && queue.counts.completed === jobs.length && queue.state === 'completed';
        if (!batchRecord.completeCountMatches) batchRecord.failures.push({check: 'batchCompletionTruth', queue});
        const before = Object.fromEntries(await Promise.all(jobs.map(async (job) => [job.id, await artifactHashes(await store.loadJob({...reviewStoreArgs, jobId: job.id}))])));
        const executionCount = report.callbacks.executionStarts;
        const replay = await service.controlQueue(storedWorkspace.workspace, {action: 'start', operationId, options, concurrency: 2});
        assert.equal(replay.command.replayed, true); assert.equal(replay.command.runId, batchRecord.batchId);
        await sleep(300);
        const after = Object.fromEntries(await Promise.all(jobs.map(async (job) => [job.id, await artifactHashes(await store.loadJob({...reviewStoreArgs, jobId: job.id}))])));
        batchRecord.replayArtifactsUnchanged = equal(before, after); batchRecord.replayDidNotExecute = executionCount === report.callbacks.executionStarts;
        for (const row of acceptedRows) {
          rowCheck(row, 'sameOperationReplayPreservesAllJobArtifacts', batchRecord.replayArtifactsUnchanged);
          rowCheck(row, 'sameOperationReplayNeverExecutesAgain', batchRecord.replayDidNotExecute);
          rowCheck(row, 'metadataQueueViewNeverReadsDocxOrOutcome', report.metadataReadChecks.at(-1).deniedPaths.length === 0 && report.metadataReadChecks.at(-1).documentHydrationDelta === 0);
        }
      } catch (error) { batchRecord.failures.push({stage: 'batch', code: error.code || null, message: error.message, stack: error.stack});
        for (const row of acceptedRows) row.failures.push({stage: 'batch', code: error.code || null, message: error.message}); }
    }
    for (const row of batchRows) {
      try { rowCheck(row, 'originalDiskHashUnchanged', hash(await readFile(row.fullPath)) === row.sourceSha256); }
      catch (error) { row.failures.push({stage: 'original-disk-final-read', message: error.message}); }
      row.status = row.failures.length || !Object.values(row.checks).every(Boolean) ? 'failed' : 'passed';
      if (row.status === 'passed') finishedRows++;
      await appendFile(ROWS, JSON.stringify(row) + '\n'); savedRows++;
    }
    console.log(`Corpus queue ${savedRows}/${selected.length}: software passed=${finishedRows}, failed=${savedRows - finishedRows}`);
  }
  check('allSelectedOriginalPathsHaveDurableEvidenceRows', savedRows === selected.length);
  check('manifestSourceUnchanged', hash(await readFile(manifestPath)) === report.manifestSha256);
  report.fingerprintsAfter = await fingerprints(); report.sourceStabilityChecked = true;
  check('allTestAndAdapterSourcesStayedFrozen', equal(report.fingerprints, report.fingerprintsAfter));
  check('networkAndModelAndMainServiceCallsZero', report.networkAttempts === 0 && report.modelCalls === 0 && report.serversStarted === 0);
  check('actualStartsObservedWithinWorkerTwoGlobalCapacity', report.workerCapacityObservations === selected.length && report.peakObservedRunningJobs <= 2);
} catch (error) { report.failures.push({stage: 'controller', code: error.code || null, message: error.message, stack: error.stack}); }
finally {
  if (service) await service.runtime.close();
  report.passed = finishedRows; report.failed = savedRows - finishedRows; report.unprocessed = selected.length - savedRows;
  report.finishedAt = new Date().toISOString(); report.ok = report.failures.length === 0 && report.batches.every((batch) => !batch.failures.length)
    && report.runtimeErrors.length === 0 && report.passed === selected.length && report.unprocessed === 0;
  report.limitations = ['Actual deterministic rule execution and persistence are software evidence, not semantic judgment or independent accuracy.',
    'The typed Map witness is explicitly software-only provenance; model result and model recheck remain null.',
    'No browser, HTTP server, paid provider, global asset-ledger mutation, DOC conversion or PDF/OCR is performed.'];
  await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  await writeFile(join(attemptDirectory, 'software-queue-projection.json'), JSON.stringify({runId: run.runId, attemptId,
    stage: 'software_queue_execution', semanticQualityClaimed: false, rows: ROWS, selected: selected.length, passed: report.passed,
    failed: report.failed, unprocessed: report.unprocessed, evidence: OUT}, null, 2) + '\n', {flag: 'wx'});
  console.log(`Evidence: ${OUT}`); process.exitCode = report.ok ? 0 : 1;
}
