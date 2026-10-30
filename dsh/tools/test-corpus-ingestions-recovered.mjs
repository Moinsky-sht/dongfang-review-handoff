/** Read-only supplement for files that failed a prior corpus ingestion run and were recovered.
 * Preserves the failed first-run report. Same-operation terminal replays must write nothing.
 * node tools/test-corpus-ingestions-recovered.mjs --first-run=<failed JSON> --out=<fresh JSON>
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import fsPromises, { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { beginIngestion, submitIngestion, resumeIngestion, loadIngestion, recoverIngestions } from '../src/ingestion-store.js';
import { loadWorkingVersion } from '../src/working-version.js';
import { loadSessionSnapshot } from '../src/session-store.js';
import { loadWorkspace } from '../src/workspace-store.js';
import { parseDocxBuffer } from '../src/docx.js';
import { cleanDocx } from '../src/docx-clean.js';
import { DSH_ROOT } from './paths.mjs';

globalThis.fetch = () => { throw new Error('Network access is forbidden in the recovered-ingestion supplement'); };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const within = (root, path) => { const part = relative(resolve(root), resolve(path)); return part !== '' && !part.startsWith('..' + sep) && part !== '..' && !isAbsolute(part); };
const vector = (doc) => Object.fromEntries(['paragraphs', 'footnotes', 'endnotes'].map((key) => [key, (doc[key] || []).map((item) => item.text || '')]));
const flag = (name) => process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!flag('first-run') || !flag('out')) throw new Error('Specify --first-run and a fresh --out');
const FIRST = resolve(DSH_ROOT, flag('first-run')); const OUT = resolve(DSH_ROOT, flag('out'));
if (existsSync(OUT) || existsSync(`${OUT}.jsonl`)) throw new Error('Supplement evidence exists; refusing overwrite');
const priorBytes = await readFile(FIRST); const prior = JSON.parse(priorBytes.toString('utf8'));
if (prior.ok || !prior.failed || !prior.roots || !prior.results?.length) throw new Error('The input must be a failed first-run corpus ingestion report');
const roots = prior.roots; const failed = prior.results.filter((row) => row.status !== 'passed');
const report = { startedAt: new Date().toISOString(), firstRunPath: FIRST, firstRunSha256: hash(priorBytes), firstRunRemainsFailed: true,
  firstRunFacts: { total: prior.total, passed: prior.passed, failed: prior.failed, globalFailed: prior.globalFailed, ok: prior.ok },
  evidenceKind: 'Supplement after original first-run failures; does not replace first-pass acceptance', roots,
  modelCalls: 0, realArkCalls: 0, paidModelCalls: 0, servicesStarted: 0, sourceWrites: 0, checks: [], recoveredFiles: [] };
const check = (name, value, details = undefined) => report.checks.push({ name, ok: !!value, ...(details ? { details } : {}) });
const sourceFiles = ['tools/test-corpus-ingestions-recovered.mjs', 'tools/test-corpus-ingestions.mjs', 'src/ingestion-store.js',
  'src/working-version.js', 'src/session-store.js', 'src/workspace-store.js', 'src/fix-history.js', 'src/docx-clean.js', 'src/docx-clean-xml.js', 'src/docx.js'];
const fingerprints = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async (name) => [name, hash(await readFile(resolve(DSH_ROOT, name)))])));
async function archives(paths) {
  const result = [];
  const walk = async (root, path, label) => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(root, file, label);
      else if (entry.isFile()) { const bytes = await readFile(file); result.push({ root: label, path: relative(root, file).split(sep).join('/'), bytes: bytes.length, sha256: hash(bytes) }); }
      else throw new Error('Unexpected link or special file in archive');
    }
  };
  for (const [label, path] of Object.entries(paths)) await walk(path, path, label);
  return result;
}
try {
  report.fingerprints = await fingerprints();
  const manifestBytes = await readFile(prior.manifestPath); const manifest = JSON.parse(manifestBytes.toString('utf8'));
  check('inputManifestUnchangedFromFirstRun', hash(manifestBytes) === prior.manifestSha256);
  const docx = manifest.filter((item) => /\.docx$/i.test(item.path));
  for (const failedRow of failed) {
    const item = docx[failedRow.index];
    const row = { index: failedRow.index, path: failedRow.path, ingestionId: failedRow.ingestionId, firstRunFailures: failedRow.failures, checks: {} };
    const localCheck = (name, value) => { row.checks[name] = !!value; check(`file-${row.index}:${name}`, value); };
    try {
      const fullPath = resolve(prior.corpusRoot, item.path);
      if (item.path !== row.path || !within(prior.corpusRoot, fullPath)) throw new Error('The failed row is not the same manifest source');
      const input = await readFile(fullPath); const actualSha256 = hash(input); const cleaned = cleanDocx(input);
      localCheck('originalSourceStillExactlyMatchesManifest', actualSha256 === item.sha256 && actualSha256 === failedRow.actualSourceSha256);
      const record = await loadIngestion({ ...roots, ingestionId: row.ingestionId });
      row.sessionId = record.sessionId; row.initialVersionId = record.workVersion?.id;
      localCheck('sameOriginalIngestionIsNowCompleted', record.status === 'completed' && record.operationId === failedRow.identity.operationId
        && record.workspaceId === failedRow.identity.workspaceId && record.source?.sha256 === actualSha256);
      const [sourceArchive, sourceManifestBytes, work, session] = await Promise.all([
        readFile(join(roots.storageRoot, row.ingestionId, 'source', 'original.docx')),
        readFile(join(roots.storageRoot, row.ingestionId, 'source', 'manifest.json')),
        loadWorkingVersion({ sessionId: record.sessionId, versionId: record.workVersion.id, storageRoot: roots.versionRoot }),
        loadSessionSnapshot({ sessionId: record.sessionId, storageRoot: roots.sessionRoot })]);
      const sourceManifest = JSON.parse(sourceManifestBytes.toString('utf8'));
      localCheck('sourceArchiveAndItsManifestRemainExact', sourceArchive.equals(input) && sourceManifest.ingestionId === row.ingestionId
        && sourceManifest.sha256 === actualSha256 && sourceManifest.size === input.length);
      localCheck('initialImmutableWorkingVersionExactlyMatchesClean', work.buffer.equals(cleaned.buffer) && work.originalBuffer.equals(input)
        && work.version.revision === 0 && work.version.parentId === null && work.version.sha256 === hash(cleaned.buffer) && work.version.sourceSha256 === actualSha256);
      localCheck('bodyFootnoteEndnoteTextVectorsExact', equal(vector(parseDocxBuffer(work.buffer, record.name)), vector(parseDocxBuffer(cleaned.buffer, record.name)))
        && equal(vector(parseDocxBuffer(input, record.name)), vector(parseDocxBuffer(cleaned.buffer, record.name))));
      localCheck('sessionAndReceiptMatchRecoveredIngestion', session.snapshot.ingestionId === row.ingestionId && session.snapshot.workVersion.id === work.version.id
        && session.snapshot.ingestion?.initialVersionId === work.version.id && session.snapshot.ingestion?.sourceSha256 === actualSha256
        && record.receipt.status === 200 && record.receipt.sessionId === record.sessionId && record.receipt.workVersionId === work.version.id);
      localCheck('recoveredSessionHasNoCurrentOrHistoricalReview', session.snapshot.result === null && session.snapshot.reviewRunning === false
        && session.snapshot.reviewRecords.length === 0 && session.snapshot.reviewProgress.phase === 'unreviewed');
      const paths = { ingestion: join(roots.storageRoot, row.ingestionId), session: join(roots.sessionRoot, row.sessionId), version: join(roots.versionRoot, row.sessionId) };
      const before = await archives(paths);
      const workspaceBefore = await loadWorkspace({ workspaceId: prior.workspaceId, storageRoot: roots.workspaceRoot });
      const repeats = [await submitIngestion({ ...roots, ...failedRow.identity, buffer: input }),
        await beginIngestion({ ...roots, ...failedRow.identity }), await resumeIngestion({ ...roots, ingestionId: row.ingestionId })];
      const after = await archives(paths);
      const workspaceAfter = await loadWorkspace({ workspaceId: prior.workspaceId, storageRoot: roots.workspaceRoot });
      localCheck('sameOperationTerminalReplaysReturnSameReceiptAndSession', repeats.every((result) => result.record.ingestionId === row.ingestionId
        && result.record.sessionId === row.sessionId && result.record.workVersion.id === row.initialVersionId && equal(result.receipt, record.receipt)
        && result.sessionManifest.manifestSha256 === session.manifest.manifestSha256));
      localCheck('terminalReplaysWriteNoArchiveVersionSessionOrWorkspace', equal(before, after)
        && workspaceBefore.manifest.manifestSha256 === workspaceAfter.manifest.manifestSha256);
      localCheck('originalPathStillUnchangedAfterReplays', hash(await readFile(fullPath)) === item.sha256);
      row.archivedFileHashes = after; row.sessionManifestSha256 = session.manifest.manifestSha256;
      row.sourceSha256 = actualSha256; row.workSha256 = work.version.sha256; row.receipt = record.receipt;
      row.ok = Object.values(row.checks).every(Boolean);
    } catch (error) { row.ok = false; row.error = { code: error.code, message: error.message, stack: error.stack }; check(`file-${row.index}:verificationCompletes`, false, row.error); }
    report.recoveredFiles.push(row);
  }
  const workspace = await loadWorkspace({ workspaceId: prior.workspaceId, storageRoot: roots.workspaceRoot });
  check('all632QueueEntriesAreSameIdentitiesInOriginalManifestOrder', workspace.workspace.entries.length === prior.total
    && equal(workspace.workspace.entries.map((entry) => entry.ingestionId), prior.results.map((row) => row.ingestionId)));
  check('all632QueueEntriesNowHaveDistinctCompletedSessions', new Set(workspace.workspace.entries.map((entry) => entry.id)).size === prior.total
    && workspace.workspace.entries.every((entry) => entry.id && entry.ingestionStatus === 'completed'));
  check('all632CurrentSessionsHaveUnreviewedEvidence', prior.results.every((row) => row.status === 'passed' ? row.checks.noCurrentReviewOrHistoricalReviewInvented
    : report.recoveredFiles.find((recovered) => recovered.index === row.index)?.checks.recoveredSessionHasNoCurrentOrHistoricalReview));
  const ingestionHashesBefore = await Promise.all(prior.results.map(async (row) => hash(await readFile(join(roots.storageRoot, row.ingestionId, 'state.json')))));
  const counters = { total: 0, ingestionStates: 0, sourceArchives: 0, workingVersions: 0, sessions: 0, workspaces: 0, docxBytes: 0, other: 0 };
  const originalReadFile = fsPromises.readFile;
  fsPromises.readFile = async (...args) => {
    const path = resolve(args[0] instanceof URL ? fileURLToPath(args[0]) : String(args[0])); counters.total += 1;
    if (/\.docx$/i.test(path)) counters.docxBytes += 1;
    if (within(roots.versionRoot, path)) counters.workingVersions += 1;
    else if (within(roots.sessionRoot, path)) counters.sessions += 1;
    else if (within(roots.workspaceRoot, path)) counters.workspaces += 1;
    else if (within(roots.storageRoot, path) && /[\\/]source[\\/]/.test(path)) counters.sourceArchives += 1;
    else if (within(roots.storageRoot, path) && /[\\/]i[a-f0-9]{64}[\\/]state\.json$/.test(path)) counters.ingestionStates += 1;
    else counters.other += 1;
    return originalReadFile(...args);
  };
  syncBuiltinESMExports();
  let recovery;
  try { recovery = await recoverIngestions({ ...roots, workspaceId: prior.workspaceId, skipActive: true }); }
  finally { fsPromises.readFile = originalReadFile; syncBuiltinESMExports(); }
  report.terminalRecoveryReadCounters = counters;
  check('all632TerminalRecordsAreSkippedWithoutHydratingSnapshot', recovery.length === prior.total && recovery.every((result) => result.skippedTerminal === true
    && result.result?.record?.status === 'completed' && result.result.snapshot === null && result.result.sessionManifest === null && result.result.workspaceManifest === null));
  check('terminalRecoveryReadsOnly632IngestionStates', counters.total === prior.total && counters.ingestionStates === prior.total
    && counters.sourceArchives === 0 && counters.workingVersions === 0 && counters.sessions === 0 && counters.workspaces === 0 && counters.docxBytes === 0 && counters.other === 0);
  const ingestionHashesAfter = await Promise.all(prior.results.map(async (row) => hash(await readFile(join(roots.storageRoot, row.ingestionId, 'state.json')))));
  const workspaceAfter = await loadWorkspace({ workspaceId: prior.workspaceId, storageRoot: roots.workspaceRoot });
  check('terminalRecoveryWritesNoIngestionOrWorkspaceRecord', equal(ingestionHashesBefore, ingestionHashesAfter)
    && workspace.manifest.manifestSha256 === workspaceAfter.manifest.manifestSha256);
  report.currentWorkspace = { manifestSha256: workspaceAfter.manifest.manifestSha256, revision: workspaceAfter.manifest.revision, entries: workspaceAfter.workspace.entries.length };
  check('firstRunEvidenceIsUnchangedAndStillFailed', hash(await readFile(FIRST)) === report.firstRunSha256 && prior.ok === false);
  check('originalFirstRunJSONLIsUnchanged', hash(await readFile(prior.log)) === prior.jsonlSha256);
  report.fingerprintsAfter = await fingerprints();
  report.sourcesStableDuringSupplement = equal(report.fingerprints, report.fingerprintsAfter);
} catch (error) { report.error = { code: error.code, message: error.message, stack: error.stack }; check('readOnlySupplementCompletes', false, report.error); }
report.passed = report.checks.filter((item) => item.ok).length; report.failed = report.checks.filter((item) => !item.ok).length;
report.ok = report.failed === 0; report.finishedAt = new Date().toISOString();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(`${OUT}.jsonl`, report.recoveredFiles.map((row) => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' });
report.jsonlSha256 = hash(readFileSync(`${OUT}.jsonl`));
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(`Recovered supplement: ${report.passed}/${report.checks.length} checks; first run remains ${prior.passed}/${prior.total} first-pass. ${OUT}`);
process.exitCode = report.ok ? 0 : 1;
