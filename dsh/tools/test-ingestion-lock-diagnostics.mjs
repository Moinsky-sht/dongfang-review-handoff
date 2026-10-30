/** Actual frozen lock functions in independent VM actors over seven real roots. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute, parse, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { spawn } from 'node:child_process';

const SCRIPT = fileURLToPath(import.meta.url); const PROJECT = resolve(dirname(SCRIPT), '..');
const inheritedEvidence = process.env.DSH_VERIFICATION_EVIDENCE_DIR;
const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const within = (base, path) => { const part = relative(resolve(base), resolve(path)); return !part.startsWith('..') && !isAbsolute(part); };
const pointer = JSON.parse(await fs.readFile(join(PROJECT, 'tmp/endnote-current-run.json'), 'utf8'));
const projectRunRoot = join(PROJECT, 'data/optimization/runs');
const assignedRunEvidence = inheritedEvidence && resolve(inheritedEvidence) !== projectRunRoot
  && within(projectRunRoot, inheritedEvidence) ? resolve(inheritedEvidence) : null;
const evidenceRoot = resolve(flag('evidence-root') || inheritedEvidence || join(PROJECT, 'data/verify/ingestion-locks'));
assert.ok(within(join(PROJECT, 'data/verify'), evidenceRoot) || within(pointer.runDirectory, evidenceRoot)
  || assignedRunEvidence && within(assignedRunEvidence, evidenceRoot), 'evidence must stay in data/verify, the sample run, or an assigned project run');
async function guard(path) {
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    assert.ok(!existsSync(join(cursor, 'complete.json')), `sealed evidence ancestor: ${cursor}`);
    try { const info = await fs.lstat(cursor); assert.ok(info.isDirectory() && !info.isSymbolicLink()); assert.equal(resolve(await fs.realpath(cursor)), cursor); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(cursor) === cursor) break;
  }
}
await guard(evidenceRoot);
for (const key of Object.keys(process.env)) if (/^(?:DSH_|NODE_OPTIONS|NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/i.test(key)
  || /(?:ARK|OPENAI|DOUBAO|VOLC|ANTHROPIC)/i.test(key)) delete process.env[key];
globalThis.fetch = () => { throw new Error('No network access in software lock tests'); };
await fs.mkdir(evidenceRoot, { recursive: true });
const RUN = join(evidenceRoot, `ingestion-lock-diagnostics-${Date.now()}-${randomUUID()}`); await fs.mkdir(RUN);
const rootNames = ['ingestions', 'sessions', 'versions', 'workspaces', 'audit', 'legacy', 'jobs'];
const ROOTS = Object.fromEntries(rootNames.map((name) => [name, join(RUN, name)]));
await Promise.all(Object.values(ROOTS).map((path) => fs.mkdir(path)));
const envRoots = { DSH_INGESTION_ROOT: ROOTS.ingestions, DSH_SESSION_ROOT: ROOTS.sessions, DSH_WORKING_VERSION_ROOT: ROOTS.versions,
  DSH_WORKSPACE_ROOT: ROOTS.workspaces, DSH_AUDIT_ROOT: ROOTS.audit, DSH_LEGACY_ROOT: ROOTS.legacy, DSH_JOB_ROOT: ROOTS.jobs };
Object.assign(process.env, envRoots);
const SOURCE = join(PROJECT, 'src/ingestion-store.js'); const CORPUS_TOOL = join(PROJECT, 'tools/test-corpus-ingestions.mjs');
const source = await fs.readFile(SOURCE, 'utf8'); const corpusTool = await fs.readFile(CORPUS_TOOL, 'utf8');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
await fs.writeFile(join(RUN, 'ingestion-store.source.js'), source, { flag: 'wx' });
const vmSource = source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(SOURCE).href))
  + '\nglobalThis.lockLibrary = {exclusive, scanLocks, immutable, atomic, identity, storageContext, loadIngestion};';
const report = { generatedAt: new Date().toISOString(), run: RUN, evidenceRoot, rootCount: 7, roots: ROOTS,
  moduleSha256: sha(source), corpusToolSha256: sha(corpusTool), testSha256: sha(await fs.readFile(SCRIPT)),
  actualSourceExecutedInVM: true, realFilesystem: true, softwareErrnoInjection: true, modelCalls: 0, realArkCalls: 0,
  serversStarted: 0, networkAttempts: 0, originalCorpusCause: 'unknown; retained actual 631/632 report does not serialize Error.cause',
  publicationProtocol: 'fully written/synced/closed temp linked as ticket; ticket update temp+rename; no observed half-written public ticket', checks: [] };
const TOKEN_A = '00000000-0000-4000-8000-000000000001'; const TOKEN_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const deferred = () => { let resolve; const promise = new Promise((done) => resolve = done); return { promise, resolve }; };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function bound(promise, label, ms = 5000) { let timer; try { return await Promise.race([promise, new Promise((done, reject) => timer = setTimeout(() => reject(new Error(`Timeout ${label}`)), ms))]); } finally { clearTimeout(timer); } }
function diagnostic(error, depth = 0) {
  if (!error || depth > 5) return null;
  return { code: error.code || null, message: error.message, fsCode: error.fsCode ?? null, syscall: error.syscall ?? null,
    path: error.path ?? null, attempts: error.attempts ?? null, phase: error.phase ?? null, cause: diagnostic(error.cause, depth + 1) };
}
async function fresh(tag) {
  const parent = join(RUN, tag); await fs.mkdir(parent);
  const paths = Object.fromEntries(rootNames.map((name) => [name, join(parent, name)])); await Promise.all(Object.values(paths).map((path) => fs.mkdir(path)));
  const lock = join(paths.ingestions, '.locks', 'workspaces', 'wsoftware'); await fs.mkdir(lock, { recursive: true });
  return { paths, lock, storage: { storageRoot: paths.ingestions, sessionRoot: paths.sessions, workspaceRoot: paths.workspaces, versionRoot: paths.versions } };
}
function actor(config, token, changes = {}) {
  let calls = 0;
  const env = { ...process.env, DSH_INGESTION_ROOT: config.paths.ingestions, DSH_SESSION_ROOT: config.paths.sessions,
    DSH_WORKING_VERSION_ROOT: config.paths.versions, DSH_WORKSPACE_ROOT: config.paths.workspaces, DSH_AUDIT_ROOT: config.paths.audit,
    DSH_LEGACY_ROOT: config.paths.legacy, DSH_JOB_ROOT: config.paths.jobs };
  const context = createContext({ ...fs, ...changes, resolve, join, parse, relative, sep, isAbsolute, fileURLToPath, URL, Buffer,
    createHash, randomUUID: () => calls++ === 0 ? token : randomUUID(), setTimeout, clearTimeout,
    process: { pid: process.pid, platform: process.platform, env, kill: process.kill.bind(process) } });
  runInContext(vmSource, context, { filename: SOURCE }); return context.lockLibrary;
}
async function capture(promise) { try { return { ok: true, value: await promise }; } catch (error) { return { ok: false, error: diagnostic(error), rawError: error }; } }
const corpusErrorsOf = (() => {
  const context = createContext({});
  const functionStart = corpusTool.indexOf('function errorsOf(');
  let text;
  if (functionStart >= 0) { const end = corpusTool.indexOf('\n}', functionStart); assert.ok(end > functionStart); text = corpusTool.slice(functionStart, end + 2); }
  else { const start = corpusTool.indexOf('const errorsOf ='); assert.ok(start >= 0); text = corpusTool.slice(start, corpusTool.indexOf('\n', start)); }
  runInContext(text + '\nglobalThis.serialize = errorsOf;', context); return context.serialize;
})();
async function check(name, action) {
  const started = Date.now(); const detail = {};
  try { await action(detail); report.checks.push({ name, ok: true, elapsedMs: Date.now() - started, detail }); }
  catch (error) { report.checks.push({ name, ok: false, elapsedMs: Date.now() - started, detail, error: error.message, stack: error.stack?.split('\n').slice(0, 6) }); }
}
await check('initial publication exposes only complete tickets, never the open temporary writer', async (detail) => {
  const config = await fresh('publication'); const opened = deferred(); const finishWrite = deferred(); const entered = deferred(); const release = deferred();
  let temporary;
  const a = actor(config, TOKEN_A, { open: async (path, ...args) => {
    const handle = await fs.open(path, ...args);
    if (String(path).startsWith(join(config.lock, TOKEN_A + '.lock.')) && String(path).endsWith('.tmp')) {
      temporary = path; return { writeFile: async (bytes) => { opened.resolve(); await finishWrite.promise; return handle.writeFile(bytes); }, sync: () => handle.sync(), close: () => handle.close() };
    }
    return handle;
  } });
  const operation = capture(a.exclusive(config.lock, async () => { entered.resolve(); await release.promise; }));
  try {
    await bound(opened.promise, 'temporary opened'); const b = actor(config, TOKEN_B);
    const before = await b.scanLocks(config.lock); detail.before = before; detail.temporarySize = (await fs.stat(temporary)).size;
    assert.equal(before.length, 0); assert.equal(detail.temporarySize, 0);
    finishWrite.resolve(); await bound(entered.promise, 'owner entered');
    const visible = await b.scanLocks(config.lock); detail.visible = visible;
    assert.equal(visible.length, 1); assert.equal(visible[0].token, TOKEN_A); assert.equal(visible[0].choosing, false);
  } finally { finishWrite.resolve(); release.resolve(); detail.owner = await bound(operation, 'publisher cleanup'); }
});
await check('ticket replacement preserves choosing barrier and priority without premature admission', async (detail) => {
  const config = await fresh('choosing'); const renaming = deferred(); const completeRename = deferred(); const enteredA = deferred(); const releaseA = deferred();
  let enteredB = false;
  const a = actor(config, TOKEN_A, { rename: async (from, to) => { if (to === join(config.lock, TOKEN_A + '.lock')) { renaming.resolve(); await completeRename.promise; } return fs.rename(from, to); } });
  const opA = capture(a.exclusive(config.lock, async () => { enteredA.resolve(); await releaseA.promise; }));
  let opB;
  try {
    await bound(renaming.promise, 'ticket update held'); const b = actor(config, TOKEN_B); const choosing = await b.scanLocks(config.lock);
    detail.choosing = choosing; assert.equal(choosing[0].choosing, true); assert.equal(choosing[0].ticket, 0);
    opB = capture(b.exclusive(config.lock, async () => { enteredB = true; })); await sleep(50); assert.equal(enteredB, false);
    completeRename.resolve(); await bound(enteredA.promise, 'first owner enters'); await sleep(30); assert.equal(enteredB, false);
    releaseA.resolve(); detail.peer = await bound(opB, 'peer after release'); assert.equal(detail.peer.ok, true); assert.equal(enteredB, true);
  } finally { completeRename.resolve(); releaseA.resolve(); await bound(opA, 'first owner cleanup'); if (opB) await bound(opB, 'peer cleanup'); }
});
async function ioScenario(code, { persistent = false, unknown = false } = {}, detail) {
  const config = await fresh(`${persistent ? 'persistent' : unknown ? 'unknown' : 'transient'}-${code}`);
  const entered = deferred(); const release = deferred(); const secondRead = deferred(); let enteredB = false; let reads = 0;
  const path = join(config.lock, TOKEN_A + '.lock'); const a = actor(config, TOKEN_A);
  const opA = capture(a.exclusive(config.lock, async () => { entered.resolve(); await release.promise; }));
  await bound(entered.promise, 'held legitimate owner'); const bytesBefore = await fs.readFile(path); detail.validOwner = JSON.parse(bytesBefore);
  const b = actor(config, TOKEN_B, { readFile: async (target, ...args) => {
    if (target === path) {
      reads += 1; if (reads === 2) secondRead.resolve();
      if (persistent || unknown || reads === 1) throw Object.assign(new Error(`software ${code} reading a complete live ticket`), { code, syscall: 'open', path });
    }
    return fs.readFile(target, ...args);
  } });
  const opB = capture(b.exclusive(config.lock, async () => { enteredB = true; }));
  try {
    if (!persistent && !unknown) {
      const observed = await Promise.race([secondRead.promise.then(() => 'retried'), opB.then(() => 'settled')]);
      detail.retryObservation = observed; detail.peerAdmittedBeforeRelease = enteredB; assert.equal(enteredB, false);
      release.resolve(); const result = await bound(opB, 'transient recovery'); detail.result = { ...result, rawError: undefined }; detail.reads = reads;
      assert.equal(result.ok, true, 'identified transient lock read must recover while preserving the held owner'); assert.equal(enteredB, true); assert.ok(reads >= 2);
    } else {
      const result = await bound(opB, 'bounded read failure'); detail.result = { ...result, rawError: undefined }; detail.reads = reads;
      detail.ownerUnchanged = bytesBefore.equals(await fs.readFile(path)); detail.publicError = result.rawError ? corpusErrorsOf(result.rawError) : null;
      assert.equal(result.ok, false); assert.equal(enteredB, false); assert.equal(detail.ownerUnchanged, true);
      assert.equal(result.error.code, 'INGESTION_LOCK_READ_FAILED', 'a filesystem read rejection is not proof of corrupt JSON');
      assert.equal(result.error.fsCode, code); assert.equal(result.error.syscall, 'open'); assert.equal(result.error.path, path);
      assert.equal(result.error.attempts, reads); assert.ok(reads <= 6);
      if (unknown) assert.equal(reads, 1, 'unidentified IO is never retried'); else assert.ok(reads > 1);
      assert.equal(detail.publicError.fsCode, code); assert.equal(detail.publicError.syscall, 'open'); assert.equal(detail.publicError.path, path);
      assert.equal(detail.publicError.attempts, reads); assert.equal(detail.publicError.cause.code, code);
    }
  } finally { release.resolve(); await bound(opA, 'held owner cleanup'); await bound(opB, 'peer cleanup'); }
}
for (const code of ['EPERM', 'EACCES', 'EBUSY']) await check(`transient ${code} on a legitimate live ticket safely resumes`, (detail) => ioScenario(code, {}, detail));
for (const code of ['EPERM', 'EACCES', 'EBUSY']) await check(`persistent ${code} fails with bounded diagnostic cause and no admission`, (detail) => ioScenario(code, { persistent: true }, detail));
for (const code of ['EIO', 'EINVAL']) await check(`unknown ${code} is not retried or classified as corrupt data`, (detail) => ioScenario(code, { unknown: true }, detail));
const deadProcess = await new Promise((done, reject) => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, env: { ...process.env }, stdio: 'ignore' });
  child.once('error', reject); child.once('exit', (code) => { assert.equal(code, 0); done(child.pid); });
});
await check('valid dead owner is recoverable while corrupt JSON/identity/dead-owner/release stay fail-closed', async (detail) => {
  const config = await fresh('corruption'); const owner = actor(config, TOKEN_A); const path = join(config.lock, TOKEN_A + '.lock');
  const row = { schemaVersion: 1, pid: deadProcess, token: TOKEN_A, choosing: false, ticket: 1 };
  await owner.immutable(path, JSON.stringify(row)); assert.equal((await owner.scanLocks(config.lock)).length, 0);
  detail.deadPid = deadProcess; detail.cases = [];
  for (const [name, value] of [['partial-json', '{'], ['wrong-ticket-type', JSON.stringify({ ...row, ticket: '1' })], ['dead-owner-wrong-token', JSON.stringify({ ...row, token: TOKEN_B })]]) {
    await fs.writeFile(path, value); const result = await capture(owner.scanLocks(config.lock)); detail.cases.push({ name, result: { ...result, rawError: undefined } });
    assert.equal(result.error?.code, 'INGESTION_LOCK_CORRUPT');
  }
  await fs.writeFile(path, JSON.stringify(row)); detail.releaseCases = [];
  for (const [name, value] of [['null', 'null'], ['false', 'false'], ['wrong-token', JSON.stringify({ schemaVersion: 1, pid: deadProcess, token: TOKEN_B, released: true })]]) {
    await fs.writeFile(join(config.lock, TOKEN_A + '.released.json'), value);
    const release = await capture(owner.scanLocks(config.lock)); detail.releaseCases.push({ name, result: { ...release, rawError: undefined } });
    assert.equal(release.error?.code, 'INGESTION_LOCK_CORRUPT', 'an existing invalid release receipt is corruption even for a dead owner');
  }
});
await check('deleted ticket ENOENT is a scan race, not corruption or a read-error retry', async (detail) => {
  const config = await fresh('deleted'); const path = join(config.lock, TOKEN_A + '.lock');
  const writer = actor(config, TOKEN_A); await writer.immutable(path, JSON.stringify({ schemaVersion: 1, pid: deadProcess, token: TOKEN_A, choosing: false, ticket: 1 }));
  let deleted = false;
  const reader = actor(config, TOKEN_B, { readdir: async (...args) => { const entries = await fs.readdir(...args); if (!deleted) { await fs.unlink(path); deleted = true; } return entries; } });
  const rows = await reader.scanLocks(config.lock); assert.equal(rows.length, 0); detail.rows = rows; detail.deleted = deleted;
});
await check('state hash corruption remains distinct from filesystem lock-read recovery', async (detail) => {
  const config = await fresh('state-hash'); const owner = actor(config, TOKEN_A);
  const proposed = owner.identity({ workspaceId: 'wsoftware', operationId: 'state-hash', name: 'generated-software.docx', size: 0, purpose: 'verification', verificationRunId: 'software-lock-check' });
  const record = { schemaVersion: 1, ...proposed, storageContext: owner.storageContext(config.storage), status: 'awaiting-file', source: null,
    workVersion: null, clean: null, receipt: null, placeholderRegistered: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const directory = join(config.paths.ingestions, proposed.ingestionId); await fs.mkdir(directory);
  const path = join(directory, 'state.json'); await fs.writeFile(path, JSON.stringify({ schemaVersion: 1, sha256: sha(JSON.stringify(record)), record }));
  const valid = await owner.loadIngestion({ ingestionId: proposed.ingestionId, storageRoot: config.paths.ingestions }); assert.equal(valid.status, 'awaiting-file');
  await fs.writeFile(path, JSON.stringify({ schemaVersion: 1, sha256: '0'.repeat(64), record }));
  const invalid = await capture(owner.loadIngestion({ ingestionId: proposed.ingestionId, storageRoot: config.paths.ingestions })); detail.result = { ...invalid, rawError: undefined };
  assert.equal(invalid.error?.code, 'INGESTION_CORRUPT');
});
const actualFailure = join(pointer.runDirectory, 'tests/regression-full-01-admission/test-corpus-ingestions.json');
if (existsSync(actualFailure)) {
  const originalReportBytes = await fs.readFile(actualFailure); const actual = JSON.parse(originalReportBytes);
  const failed = actual.results.find((row) => row.index === 93 && row.status === 'failed');
  if (failed) {
    const originalPath = join(actual.corpusRoot, failed.path); const archivedPath = join(actual.roots.storageRoot, failed.ingestionId, 'source/original.docx');
    const original = await fs.readFile(originalPath); const archived = await fs.readFile(archivedPath);
    report.originalFailureReadonlyAudit = { report: actualFailure, reportSha256: sha(originalReportBytes), index: 93, total: actual.total, passed: actual.passed, failed: actual.failed,
      error: failed.failures[0].error, bottomCauseRecorded: Boolean(failed.failures[0].error.cause), sourceSha256: sha(original), archivedSha256: sha(archived),
      expectedSha256: failed.expectedSourceSha256, bytesEqual: original.equals(archived), originalAndArchivePreserved: sha(original) === failed.expectedSourceSha256 && original.equals(archived),
      originalStoreReadOnly: true, originalFailureCause: 'unknown; this new injected-errno proof does not attribute the original failure to an errno' };
    assert.ok(report.originalFailureReadonlyAudit.originalAndArchivePreserved);
  }
}
report.finishedAt = new Date().toISOString(); report.finalModuleSha256 = sha(await fs.readFile(SOURCE)); report.finalCorpusToolSha256 = sha(await fs.readFile(CORPUS_TOOL));
report.sourceChanged = report.moduleSha256 !== report.finalModuleSha256 || report.corpusToolSha256 !== report.finalCorpusToolSha256;
report.passed = report.checks.filter((check) => check.ok).length; report.failed = report.checks.length - report.passed; report.ok = report.failed === 0 && !report.sourceChanged;
await guard(RUN); await fs.writeFile(join(RUN, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ report: join(RUN, 'report.json'), passed: report.passed, failed: report.failed, ok: report.ok, sourceChanged: report.sourceChanged, realArkCalls: 0 }));
process.exitCode = report.ok ? 0 : 1;
