/** All manifest DOCX: ordered intent, raw checkpoint/resume, immutable bytes, and idempotent replay.
 * Direct modules and six fresh local roots only. No server, browser, review, or model invocation.
 * node tools/test-corpus-ingestions.mjs --threads=4 --out=<fresh evidence JSON>
 * --limit=2 is for a small debug run. The full run uses every .docx manifest entry.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import fsPromises, { readFile, readdir, stat, statfs, mkdir } from 'node:fs/promises';
import { resolve, dirname, join, basename, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { beginIngestion, submitIngestion, resumeIngestion, loadIngestion, recoverIngestions } from '../src/ingestion-store.js';
import { loadWorkingVersion } from '../src/working-version.js';
import { loadSessionSnapshot } from '../src/session-store.js';
import { loadWorkspace } from '../src/workspace-store.js';
import { parseDocxBuffer } from '../src/docx.js';
import { cleanDocx } from '../src/docx-clean.js';
import { CORPUS_ROOT, DSH_ROOT } from './paths.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const vector = (doc) => Object.fromEntries(['paragraphs', 'footnotes', 'endnotes'].map((key) => [key, (doc[key] || []).map((item) => item.text || '')]));
const within = (root, path) => { const part = relative(resolve(root), resolve(path)); return part !== '' && !part.startsWith('..' + sep) && part !== '..' && !isAbsolute(part); };
function errorsOf(error, depth = 0) {
  if (error == null) return null;
  if (typeof error !== 'object') return {message: String(error)};
  return { code: error.code || null, message: error.message, stack: error.stack,
    fsCode: error.fsCode ?? null, errno: error.errno ?? null, syscall: error.syscall ?? null,
    path: error.path ?? null, attempts: error.attempts ?? null, phase: error.phase ?? null,
    cause: depth < 5 ? errorsOf(error.cause, depth + 1) : error.cause == null ? null : {truncated: true} };
}
globalThis.fetch = () => { throw new Error('Network access is forbidden in corpus ingestion tests'); };

async function directoryHashes(paths) {
  const values = [];
  const walk = async (root, path, label) => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(root, file, label);
      else if (entry.isFile()) {
        const bytes = await readFile(file);
        values.push({ root: label, path: relative(root, file).split(sep).join('/'), bytes: bytes.length, sha256: hash(bytes) });
      } else throw new Error('Unexpected link or special file in an isolated archive');
    }
  };
  for (const [label, path] of Object.entries(paths)) await walk(path, path, label);
  return values;
}

function expectedContext(roots) {
  const context = { schemaVersion: 1 };
  for (const key of ['sessionRoot', 'workspaceRoot', 'versionRoot']) {
    const path = relative(roots.storageRoot, roots[key]) || '.';
    context[key] = { kind: isAbsolute(path) ? 'absolute' : 'relative', path: path.split(sep).join('/') };
  }
  return context;
}

async function runOne(job, roots) {
  const startedAt = Date.now();
  const row = { index: job.index, path: job.item.path, expectedSourceSha256: job.item.sha256, size: job.size,
    identity: job.identity, status: 'failed', checks: {}, stages: [], failures: [], modelCalls: 0, realArkCalls: 0, servicesStarted: 0 };
  const check = (name, value, details = undefined) => {
    row.checks[name] = !!value;
    if (!value) row.failures.push({ check: name, ...(details ? { details } : {}) });
  };
  const stage = async (name, action) => {
    try { const result = await action(); row.stages.push({ name, ok: true }); return result; }
    catch (error) { row.stages.push({ name, ok: false, error: errorsOf(error) }); row.failures.push({ stage: name, error: errorsOf(error) }); return null; }
  };
  if (job.beginError) row.failures.push({ stage: 'ordered-begin', error: job.beginError });
  const source = await stage('read-original', () => readFile(job.fullPath));
  if (source) {
    row.actualSourceSha256 = hash(source);
    check('sourceMatchesManifest', row.actualSourceSha256 === job.item.sha256);
    check('sourceSizeMatchesIntent', source.length === job.size);
  } else check('sourceMatchesManifest', false);
  const expectedClean = source && await stage('independent-clean-baseline', async () => cleanDocx(source));
  const baselineVector = source && await stage('parse-original-text-vectors', async () => vector(parseDocxBuffer(source, job.identity.name)));
  const cleanVector = expectedClean && await stage('parse-clean-baseline-text-vectors', async () => vector(parseDocxBuffer(expectedClean.buffer, job.identity.name)));
  if (baselineVector && cleanVector) {
    check('cleanPreservesBodyFootnoteEndnoteText', equal(baselineVector, cleanVector));
    row.sourceTextVectorSha256 = hash(JSON.stringify(baselineVector));
    row.expectedWorkingTextVectorSha256 = hash(JSON.stringify(cleanVector));
  }
  row.ingestionId = job.ingestionId;
  if (job.ingestionId) {
    try {
    const identity = job.identity;
    const expectedId = 'i' + hash(`${identity.workspaceId}\0${identity.operationId}`);
    check('deterministicIngestionIdentity', job.ingestionId === expectedId);
    check('orderedIntentUsesRegisteredStorageContext', equal(job.beginRecord?.storageContext, expectedContext(roots)));
    check('orderedIntentAwaitingFileAndRegistered', job.beginRecord?.status === 'awaiting-file' && job.beginRecord?.placeholderRegistered === true);
    let checkpoint = null;
    if (source) await stage('submit-durable-source-checkpoint', async () => {
      try {
        await submitIngestion({ ...roots, ...identity, buffer: source, faultHooks: { afterSourceStored() {
          throw Object.assign(new Error('Corpus checkpoint after durable source'), { code: 'CORPUS_SOURCE_CHECKPOINT' });
        } } });
        check('submitStoppedOnlyAtDurableSource', false);
      } catch (error) {
        if (error.code !== 'CORPUS_SOURCE_CHECKPOINT') throw error;
        checkpoint = error.record;
        check('submitStoppedOnlyAtDurableSource', checkpoint?.status === 'source-stored' && checkpoint?.ingestionId === job.ingestionId
          && checkpoint?.source?.sha256 === row.actualSourceSha256);
        row.sourceCheckpointState = checkpoint?.status;
      }
    });
    const completed = await stage('resume-stored-source-without-file', () => resumeIngestion({ ...roots, ingestionId: job.ingestionId }));
    if (completed?.record?.status === 'completed' && completed.record.workVersion) {
      row.sessionId = completed.record.sessionId; row.initialVersion = completed.record.workVersion; row.receipt = completed.receipt;
      check('completedSameIngestionAndSession', completed.record.status === 'completed' && completed.record.ingestionId === job.ingestionId
        && completed.record.sessionId === job.beginRecord.sessionId && completed.record.entryId === job.beginRecord.entryId);
      check('completedStorageContextUnchanged', equal(completed.record.storageContext, expectedContext(roots)));
      check('receiptMatchesIdentityAndInitialVersion', completed.receipt?.status === 200 && completed.receipt.ingestionId === job.ingestionId
        && completed.receipt.sessionId === row.sessionId && completed.receipt.workVersionId === row.initialVersion?.id
        && completed.receipt.sourceSha256 === row.actualSourceSha256);
      check('initialVersionIsImmutableV0', row.initialVersion?.revision === 0 && row.initialVersion.parentId === null
        && row.initialVersion.sessionId === row.sessionId && row.initialVersion.sourceSha256 === row.actualSourceSha256);
      const archived = await stage('verify-original-source-archive', async () => {
        const directory = join(roots.storageRoot, job.ingestionId, 'source');
        const [original, manifestBytes] = await Promise.all([readFile(join(directory, 'original.docx')), readFile(join(directory, 'manifest.json'))]);
        const manifest = JSON.parse(manifestBytes.toString('utf8'));
        check('sourceArchiveExactAndManifestMatches', original.equals(source) && hash(original) === row.actualSourceSha256
          && manifest.schemaVersion === 1 && manifest.ingestionId === job.ingestionId && manifest.sha256 === row.actualSourceSha256 && manifest.size === source.length);
        row.sourceArchive = { bytes: original.length, sha256: hash(original), manifestSha256: hash(manifestBytes) };
        return original;
      });
      const working = await stage('verify-initial-working-version', () => loadWorkingVersion({ sessionId: row.sessionId, versionId: row.initialVersion.id, storageRoot: roots.versionRoot }));
      if (working && expectedClean && source) {
        check('workingBytesExactlyEqualIndependentClean', working.buffer.equals(expectedClean.buffer) && working.version.sha256 === hash(expectedClean.buffer));
        check('workingOriginalBytesEqualSourceArchive', working.originalBuffer.equals(source) && !!archived && working.originalBuffer.equals(archived));
        check('recordCleanProofHashesBindInitialVersion', completed.record.clean?.validatedVersionId === row.initialVersion.id
          && completed.record.clean.sourceSha256 === row.actualSourceSha256 && completed.record.clean.workSha256 === working.version.sha256
          && completed.record.clean.status === (expectedClean.stats.changed ? 'cleaned' : 'unchanged'));
        const actualVector = await stage('parse-current-working-text-vectors', async () => vector(parseDocxBuffer(working.buffer, job.identity.name)));
        if (actualVector) {
          check('currentBodyFootnoteEndnoteVectorsExact', equal(actualVector, cleanVector));
          row.currentWorkingTextVectorSha256 = hash(JSON.stringify(actualVector));
        }
      }
      const snapshot = await stage('verify-persisted-session', () => loadSessionSnapshot({ sessionId: row.sessionId, storageRoot: roots.sessionRoot }));
      if (snapshot) {
        const saved = snapshot.snapshot;
        row.sessionManifestSha256 = snapshot.manifest.manifestSha256;
        check('sessionIdentityMatchesIngestionAndReceipt', saved.id === row.sessionId && saved.ingestionId === job.ingestionId
          && saved.workspaceId === identity.workspaceId && saved.purpose === identity.purpose && saved.verificationRunId === identity.verificationRunId
          && saved.ingestion?.operationId === identity.operationId && saved.ingestion?.sourceSha256 === row.actualSourceSha256
          && saved.ingestion?.initialVersionId === row.initialVersion.id);
        check('sessionV0HistoryAndCleanProofExact', saved.workVersion?.id === row.initialVersion.id && equal(saved.clean, completed.record.clean)
          && saved.history?.cursor === 0 && saved.history.entries.length === 1 && saved.history.entries[0].versionId === row.initialVersion.id && saved.mutationEpoch === 0);
        check('noCurrentReviewOrHistoricalReviewInvented', saved.result === null && saved.reviewRunning === false
          && saved.reviewProgress?.phase === 'unreviewed' && saved.reviewRecords.length === 0 && !saved.currentReviewRun && !saved.resultRunId);
      }
      const workspace = await stage('verify-persisted-workspace-entry', () => loadWorkspace({ workspaceId: identity.workspaceId, storageRoot: roots.workspaceRoot }));
      if (workspace) {
        const matches = workspace.workspace.entries.filter((entry) => entry.ingestionId === job.ingestionId);
        const entry = matches[0];
        check('workspaceHasExactlyOneMatchingCompletedEntry', matches.length === 1 && entry.id === row.sessionId && entry.entryId === job.beginRecord.entryId
          && entry.operationId === identity.operationId && entry.size === identity.size && entry.name === identity.name
          && entry.purpose === identity.purpose && entry.verificationRunId === identity.verificationRunId && entry.ingestionStatus === 'completed');
      }
      const archivePaths = { ingestion: join(roots.storageRoot, job.ingestionId), session: join(roots.sessionRoot, row.sessionId), version: join(roots.versionRoot, row.sessionId) };
      const before = await stage('fingerprint-archives-before-replay', () => directoryHashes(archivePaths));
      const repeated = source && await stage('same-operation-submit-replay', () => submitIngestion({ ...roots, ...identity, buffer: source }));
      const begun = await stage('same-operation-begin-replay', () => beginIngestion({ ...roots, ...identity }));
      const resumed = await stage('same-operation-resume-replay', () => resumeIngestion({ ...roots, ingestionId: job.ingestionId }));
      if (repeated && begun && resumed) check('replaysKeepExactReceiptSessionAndV0', [repeated, begun, resumed].every((result) => result.record.ingestionId === job.ingestionId
        && result.record.sessionId === row.sessionId && result.record.workVersion.id === row.initialVersion.id && equal(result.receipt, row.receipt)
        && result.sessionManifest.revision === snapshot?.manifest.revision && result.sessionManifest.manifestSha256 === snapshot?.manifest.manifestSha256));
      const after = await stage('fingerprint-archives-after-replay', () => directoryHashes(archivePaths));
      if (before && after) check('replaysNeverCreateOverwriteArchiveSessionOrVersion', equal(before, after));
      if (after) {
        row.archivedFileHashes = after;
        row.ingestionStateSha256 = after.find((file) => file.root === 'ingestion' && file.path === 'state.json')?.sha256;
        row.versionFileCount = after.filter((file) => file.root === 'version').length;
      }
      const durable = await stage('read-final-ingestion-state', () => loadIngestion({ ingestionId: job.ingestionId, storageRoot: roots.storageRoot }));
      if (durable) check('finalIngestionStateReceiptStillExact', durable.status === 'completed' && equal(durable.receipt, row.receipt)
        && durable.source?.sha256 === row.actualSourceSha256 && durable.workVersion?.id === row.initialVersion.id);
    } else if (completed) check('completedSameIngestionAndSession', false, { phase: completed.record?.status, receipt: completed.receipt });
    } catch (error) { row.failures.push({ stage: 'ingestion-file-verification', error: errorsOf(error) }); }
  } else check('orderedIntentAwaitingFileAndRegistered', false);
  const finalSource = await stage('recheck-original-path-sha', () => readFile(job.fullPath));
  if (finalSource) check('originalPathStillMatchesManifestAndInitialBytes', hash(finalSource) === job.item.sha256
    && row.actualSourceSha256 === hash(finalSource));
  row.status = row.failures.length === 0 && Object.values(row.checks).every(Boolean) ? 'passed' : 'failed';
  row.elapsedMs = Date.now() - startedAt;
  return row;
}

if (!isMainThread) {
  parentPort.on('message', async (job) => {
    try { parentPort.postMessage({ index: job.index, row: await runOne(job, workerData.roots) }); }
    catch (error) { parentPort.postMessage({ index: job.index, row: { index: job.index, path: job.item.path, status: 'failed', failures: [{ stage: 'worker-file', error: errorsOf(error) }], checks: {}, modelCalls: 0 } }); }
  });
} else {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const runId = randomUUID();
  const OUT = resolve(DSH_ROOT, flag('out', `data/verify/corpus-ingestions-${Date.now()}-${runId.slice(0, 8)}.json`));
  const LOG = `${OUT}.jsonl`;
  const storageBase = resolve(DSH_ROOT, flag('storage-root', `${OUT}.store`));
  const threads = Number(flag('threads', 4)); const limit = Number(flag('limit', 0));
  if (!Number.isInteger(threads) || threads < 1 || threads > 4 || !Number.isInteger(limit) || limit < 0) throw new Error('Use 1 to 4 workers and a nonnegative integer --limit');
  if (existsSync(OUT) || existsSync(LOG) || existsSync(storageBase)) throw new Error('Evidence or storage already exists; choose a fresh --out/storage-root');
  if (!within(dirname(OUT), storageBase)) throw new Error('The six fixture roots must be inside the output evidence directory');
  mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(LOG, '', { flag: 'wx' });
  const roots = { storageRoot: join(storageBase, 'ingestion'), sessionRoot: join(storageBase, 'sessions'), versionRoot: join(storageBase, 'versions'),
    workspaceRoot: join(storageBase, 'workspaces'), auditRoot: join(storageBase, 'audit'), legacyRoot: join(storageBase, 'legacy') };
  const sourceFiles = ['tools/test-corpus-ingestions.mjs', 'tools/paths.mjs', 'src/ingestion-store.js', 'src/working-version.js',
    'src/session-store.js', 'src/workspace-store.js', 'src/fix-history.js', 'src/docx-clean.js', 'src/docx-clean-xml.js', 'src/docx.js', 'src/zip.js', 'src/zip-write.js'];
  const fingerprint = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async (name) => [name, hash(await readFile(resolve(DSH_ROOT, name)))])));
  const manifestPath = resolve(DSH_ROOT, 'data/corpus/manifest.json');
  const manifestBytes = await readFile(manifestPath); const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const allDocx = manifest.filter((item) => /\.docx$/i.test(item.path)); const list = limit ? allDocx.slice(0, limit) : allDocx;
  const workspaceId = `wcorpus_${hash(runId).slice(0, 32)}`; const verificationRunId = `corpus-ingestions-${runId}`;
  const report = { startedAt: new Date().toISOString(), runId, out: OUT, log: LOG, manifestPath, manifestSha256: hash(manifestBytes),
    corpusRoot: resolve(CORPUS_ROOT), storageBase, roots, workspaceId, verificationRunId, threads, limit, totalManifestDocx: allDocx.length,
    selected: list.length, sourceKind: 'Original manifest DOCX, mechanical ingestion consistency only', semanticReviewPerformed: false,
    modelCalls: 0, realArkCalls: 0, paidModelCalls: 0, servicesStarted: 0, browserCalls: 0, globalChecks: [], results: [] };
  const globalCheck = (name, value, details = undefined) => { report.globalChecks.push({ name, ok: !!value, ...(details ? { details } : {}) }); };
  const jobs = []; const results = new Map(); const workers = new Set();
  try {
    report.fingerprints = await fingerprint();
    let totalBytes = 0;
    for (const [index, item] of list.entries()) {
      const fullPath = resolve(CORPUS_ROOT, item.path);
      if (!within(CORPUS_ROOT, fullPath)) throw new Error('Corpus manifest path escaped the source root');
      let size = 0; let statError = null;
      try { const info = await stat(fullPath); if (!info.isFile() || !Number.isSafeInteger(info.size)) throw new Error('Source is not a normal file with a safe size'); size = info.size; totalBytes += size; }
      catch (error) { statError = errorsOf(error); }
      const identity = { workspaceId, operationId: `corpus-${String(index).padStart(4, '0')}-${hash(item.path).slice(0, 24)}`,
        name: basename(item.path), size, purpose: 'verification', verificationRunId };
      jobs.push({ index, item, fullPath, size, identity, statError });
    }
    const space = await statfs(dirname(OUT));
    report.capacity = { sourceBytes: totalBytes, estimatedStoreBytes: totalBytes * 4, availableBytes: Number(space.bavail) * Number(space.bsize),
      extraReserveBytes: 256 * 1024 * 1024, missingOrUnreadableSources: jobs.filter((job) => job.statError).length };
    globalCheck('allManifestSourcesExistAndHaveSafeSizes', !jobs.some((job) => job.statError));
    globalCheck('spaceForFourSourceCopiesAndReserve', report.capacity.availableBytes >= report.capacity.estimatedStoreBytes + report.capacity.extraReserveBytes);
    if (!report.globalChecks.at(-1).ok) throw new Error('Not enough disk space for isolated corpus ingestion archives; no evidence or existing store will be deleted');
    await mkdir(storageBase);
    for (const path of Object.values(roots)) await mkdir(path);
    console.log(`Corpus ingestions: ${list.length}/${allDocx.length} DOCX, ${totalBytes} source bytes, ${threads} workers; zero services/models.`);
    // Each begin finishes before the next begins. Parallel completion cannot reorder these durable entries.
    for (const job of jobs) {
      if (job.statError) { job.beginError = job.statError; continue; }
      try {
        const result = await beginIngestion({ ...roots, ...job.identity });
        job.ingestionId = result.record.ingestionId; job.beginRecord = result.record;
      } catch (error) { job.beginError = errorsOf(error); }
      if ((job.index + 1) % 100 === 0 || job.index + 1 === jobs.length) console.log(`  Ordered intentions ${job.index + 1}/${jobs.length}`);
    }
    const before = await loadWorkspace({ workspaceId, storageRoot: roots.workspaceRoot });
    report.orderedIntentWorkspace = { revision: before.manifest.revision, manifestSha256: before.manifest.manifestSha256 };
    globalCheck('intentQueueExactlyMatchesManifestOrder', equal(before.workspace.entries.map((entry) => entry.ingestionId), jobs.map((job) => job.ingestionId)));
    const workerEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:ARK|OPENAI|DOUBAO|VOLC)/i.test(key)
      && !/^DSH_.*_ROOT$/i.test(key) && !/^(?:NODE_OPTIONS|NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)));
    Object.assign(workerEnv, { DSH_INGESTION_ROOT: roots.storageRoot, DSH_SESSION_ROOT: roots.sessionRoot, DSH_WORKING_VERSION_ROOT: roots.versionRoot,
      DSH_WORKSPACE_ROOT: roots.workspaceRoot, DSH_AUDIT_ROOT: roots.auditRoot, DSH_LEGACY_ROOT: roots.legacyRoot });
    let next = 0; let finished = 0;
    await Promise.all(Array.from({ length: Math.min(threads, jobs.length) }, () => new Promise((done) => {
      let current = null;
      const worker = new Worker(new URL(import.meta.url), { workerData: { roots }, env: workerEnv }); workers.add(worker);
      const save = (row) => {
        results.set(row.index, row); appendFileSync(LOG, JSON.stringify(row) + '\n', 'utf8'); finished += 1;
        if (finished % 25 === 0 || finished === jobs.length) console.log(`  File checks ${finished}/${jobs.length} (${[...results.values()].filter((item) => item.status === 'failed').length} failures)`);
      };
      const feed = () => {
        if (next >= jobs.length) { current = null; worker.terminate().then(() => { workers.delete(worker); done(); }); return; }
        current = jobs[next++]; worker.postMessage(current);
      };
      worker.on('message', ({ index, row }) => {
        if (current?.index !== index) { report.workerProtocolError = true; return; }
        save(row); current = null; feed();
      });
      worker.on('error', (error) => {
        if (current) save({ index: current.index, path: current.item.path, status: 'failed', failures: [{ stage: 'worker', error: errorsOf(error) }], checks: {}, modelCalls: 0 });
        worker.terminate().then(() => { workers.delete(worker); done(); });
      });
      feed();
    })));
    const completed = await loadWorkspace({ workspaceId, storageRoot: roots.workspaceRoot });
    report.completedWorkspace = { revision: completed.manifest.revision, manifestSha256: completed.manifest.manifestSha256,
      entryCount: completed.workspace.entries.length, activeSessionId: completed.workspace.activeSessionId };
    globalCheck('completedQueueHasEveryManifestEntryInExactOrder', completed.workspace.entries.length === list.length
      && equal(completed.workspace.entries.map((entry) => entry.ingestionId), jobs.map((job) => job.ingestionId)));
    globalCheck('completedQueueSessionIdsAreDistinctAndMatchRows', new Set(completed.workspace.entries.map((entry) => entry.id)).size === list.length
      && completed.workspace.entries.every((entry, index) => entry.id === results.get(index)?.sessionId && entry.ingestionStatus === 'completed'));
    const [ingestionDirectories, sessionDirectories, versionDirectories] = await Promise.all([readdir(roots.storageRoot), readdir(roots.sessionRoot), readdir(roots.versionRoot)]);
    globalCheck('exactlyOneIngestionSessionAndVersionDirectoryPerManifestFile', ingestionDirectories.filter((name) => /^i[a-f0-9]{64}$/.test(name)).length === list.length
      && sessionDirectories.filter((name) => /^s[a-f0-9]{64}$/.test(name)).length === list.length && versionDirectories.filter((name) => /^s[a-f0-9]{64}$/.test(name)).length === list.length);
    globalCheck('everyCurrentSessionIsUnreviewed', [...results.values()].length === list.length && [...results.values()].every((row) => row.checks.noCurrentReviewOrHistoricalReviewInvented));
    // Observe terminal recovery's actual read paths. No source/working DOCX or session hydration is allowed.
    const readCounters = { total: 0, ingestionStates: 0, sourceArchive: 0, versions: 0, sessions: 0, workspaces: 0, docxBytes: 0, other: 0 };
    const originalReadFile = fsPromises.readFile;
    fsPromises.readFile = async (...readArgs) => {
      const path = resolve(readArgs[0] instanceof URL ? fileURLToPath(readArgs[0]) : String(readArgs[0]));
      readCounters.total += 1;
      if (/\.docx$/i.test(path)) readCounters.docxBytes += 1;
      if (within(roots.versionRoot, path)) readCounters.versions += 1;
      else if (within(roots.sessionRoot, path)) readCounters.sessions += 1;
      else if (within(roots.workspaceRoot, path)) readCounters.workspaces += 1;
      else if (within(roots.storageRoot, path) && /[\\/]source[\\/]/.test(path)) readCounters.sourceArchive += 1;
      else if (within(roots.storageRoot, path) && /[\\/]i[a-f0-9]{64}[\\/]state\.json$/.test(path)) readCounters.ingestionStates += 1;
      else readCounters.other += 1;
      return originalReadFile(...readArgs);
    };
    syncBuiltinESMExports();
    let recovery;
    try { recovery = await recoverIngestions({ ...roots, workspaceId, skipActive: true }); }
    finally { fsPromises.readFile = originalReadFile; syncBuiltinESMExports(); }
    report.recoveryReadCounters = readCounters;
    report.recovery = recovery.map((item) => ({ ingestionId: item.ingestionId, skippedTerminal: item.skippedTerminal === true,
      status: item.result?.record?.status, error: item.error || null, snapshotHydrated: item.result?.snapshot != null }));
    globalCheck('recoverySkipsAllSelectedTerminalRecords', recovery.length === list.length && recovery.every((item) => item.skippedTerminal === true
      && item.result?.record?.status === 'completed' && item.result.snapshot === null && item.result.sessionManifest === null && item.result.workspaceManifest === null));
    globalCheck('terminalRecoveryReadsOnlyIntentStatesAndNoSourceWorkOrSession', readCounters.ingestionStates === list.length && readCounters.sourceArchive === 0
      && readCounters.versions === 0 && readCounters.sessions === 0 && readCounters.workspaces === 0 && readCounters.docxBytes === 0 && readCounters.other === 0);
    const recoveryHashChecks = await Promise.all(jobs.map(async (job) => {
      if (!job.ingestionId || !results.get(job.index)?.ingestionStateSha256) return false;
      return hash(await readFile(join(roots.storageRoot, job.ingestionId, 'state.json'))) === results.get(job.index).ingestionStateSha256;
    }));
    globalCheck('terminalRecoveryNeverWritesIngestionRecords', recoveryHashChecks.every(Boolean));
    const afterRecovery = await loadWorkspace({ workspaceId, storageRoot: roots.workspaceRoot });
    globalCheck('terminalRecoveryNeverWritesWorkspace', afterRecovery.manifest.manifestSha256 === completed.manifest.manifestSha256);
    const auditFiles = await readdir(roots.auditRoot); const legacyFiles = await readdir(roots.legacyRoot);
    globalCheck('verificationCreatesNoAuditOrLegacyReviewEvidence', auditFiles.length === 0 && legacyFiles.length === 0);
    report.fingerprintsAfter = await fingerprint();
    globalCheck('testCoreAndStoreSourcesStayedFrozen', equal(report.fingerprintsAfter, report.fingerprints));
    globalCheck('inputManifestStayedUnchanged', hash(await readFile(manifestPath)) === report.manifestSha256);
  } catch (error) { report.error = errorsOf(error); globalCheck('corpusIngestionAcceptanceCompletes', false, errorsOf(error)); }
  finally {
    for (const worker of workers) await worker.terminate();
    report.results = jobs.map((job) => results.get(job.index) || { index: job.index, path: job.item.path, status: 'failed', checks: {},
      failures: [{ stage: 'not-completed', error: job.beginError || job.statError || report.error || null }], modelCalls: 0 });
    for (const row of report.results) if (!results.has(row.index)) appendFileSync(LOG, JSON.stringify(row) + '\n', 'utf8');
    report.total = report.results.length; report.passed = report.results.filter((row) => row.status === 'passed').length;
    report.failed = report.results.filter((row) => row.status !== 'passed').length;
    report.globalFailed = report.globalChecks.filter((check) => !check.ok).length;
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    report.ok = report.failed === 0 && report.globalFailed === 0 && report.total === list.length;
    report.jsonlSha256 = hash(readFileSync(LOG));
    writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(`Corpus ingestion: ${report.passed}/${report.total} passed, ${report.failed} file failures, ${report.globalFailed} global failures; models/services 0. ${OUT}`);
  process.exitCode = report.ok ? 0 : 1;
}
