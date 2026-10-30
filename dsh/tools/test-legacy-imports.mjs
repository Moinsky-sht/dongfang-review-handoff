/** Isolated legacy migration software acceptance. No service/model requests.
 * Generates small OPC fixtures; never writes manuscript paths or default stores.
 * node tools/test-legacy-imports.mjs --out=data/verify/legacy-imports.json
 * Each invocation requires a new output and creates its own five storage roots.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, lstatSync,
  renameSync, unlinkSync, symlinkSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeZip } from '../src/zip-write.js';
import { applyDocxPatches } from '../src/docx-patches.js';
import { parseDocxBuffer } from '../src/docx.js';
import { sha256, saveWorkingVersion, loadWorkingVersion } from '../src/working-version.js';
import { saveSessionSnapshot, loadSessionSnapshot } from '../src/session-store.js';
import { saveWorkspace, loadWorkspace } from '../src/workspace-store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const OUT = resolve(ROOT, flag('out', `data/verify/legacy-imports-${Date.now()}.json`));
const STORAGE = `${OUT}.store`;
if (existsSync(OUT) || existsSync(STORAGE)) throw new Error('Evidence exists; choose a fresh --out');
mkdirSync(dirname(OUT), { recursive: true });
mkdirSync(STORAGE);
const paths = Object.fromEntries(['legacy', 'versions', 'sessions', 'workspaces', 'audit', 'oldVersions', 'captures'].map((name) => [name, join(STORAGE, name)]));
for (const path of Object.values(paths)) mkdirSync(path);
// Dynamic import after explicit environment roots; all calls also pass roots.
Object.assign(process.env, { DSH_LEGACY_ROOT: paths.legacy, DSH_WORKING_VERSION_ROOT: paths.versions,
  DSH_SESSION_ROOT: paths.sessions, DSH_WORKSPACE_ROOT: paths.workspaces, DSH_AUDIT_ROOT: paths.audit });
const { readLegacyCapture, importLegacyCapture, loadLegacyReview } = await import('../src/legacy-imports.js');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const encode = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const vector = (doc) => Object.fromEntries(['paragraphs', 'footnotes', 'endnotes'].map((key) => [key, (doc[key] || []).map((p) => p.text || '')]));
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), storage: STORAGE, roots: paths,
  mode: 'generated-software-fixtures-only', modelCalls: 0, serviceRequests: 0, semanticAssessment: false,
  checks: [], cases: [], rejected: [], skipped: [], scope: [
    'Captured working bytes versus independently verified source reimport',
    'Physical version ancestry and cumulative software patches',
    'Repeated import preserves later edits and separate read-only history',
    'Capture/archive hashes, path and symlink rejection', 'Workspace registration CAS and retry',
  ] };
const check = (ok, name, extra = {}) => { report.checks.push({ name, ok: !!ok, ...extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
const recordCase = (name, data) => { report.cases.push({ name, ...data }); return data; };
const params = (captureDirectory, more = {}) => ({ captureDirectory, legacyRoot: paths.legacy,
  versionRoot: paths.versions, sessionRoot: paths.sessions, workspaceRoot: paths.workspaces,
  oldVersionRoot: paths.oldVersions, workspaceId: 'wlegacytest', purpose: 'verification', ...more });
function owned(path) {
  const rel = relative(STORAGE, resolve(path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Fixture mutation escaped isolated store');
  return path;
}
function treeHash(directory) {
  const out = [];
  const visit = (where) => {
    for (const name of readdirSync(where).sort()) {
      const path = join(where, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) out.push({ file: relative(directory, path), symlink: true });
      else if (stat.isDirectory()) visit(path);
      else out.push({ file: relative(directory, path), sha256: sha256(readFileSync(path)) });
    }
  };
  if (existsSync(directory)) visit(directory);
  return out;
}
function fixture(text = '软件迁移甲乙丙丁。') {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  return writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<?xml version="1.0"?><w:document xmlns:w="${w}"><w:body><w:p><w:r><w:t>软件迁移验收</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>` },
  ]);
}
function patchBytes(buffer, replacements, label, sourceVersionId) {
  const doc = parseDocxBuffer(buffer, 'software.docx');
  const patches = replacements.map(([find, replace], i) => ({ patchId: `${label}-${i}`, key: `${label}-${i}`,
    target: 'body', index: 1, offset: doc.paragraphs[1].text.indexOf(find), find, replace, sourceVersionId }));
  if (patches.some((p) => p.offset < 0)) throw new Error('Software fixture patch not found');
  const result = applyDocxPatches(buffer, patches);
  if (result.applied.length !== patches.length || result.skipped.length) throw new Error('Software fixture patch unexpectedly rejected');
  return { buffer: result.buffer, patches };
}
const historicalView = (label) => ({ schemaVersion: 1, softwareFixture: true, historicalLabel: label,
  issues: [{ issueKey: `software-${label}`, ruleId: 'software-only', location: '正文第2段', quote: '甲', message: '仅验证归档边界', modelBased: true }],
  modelUsed: 'synthetic-no-provider-call', usage: { inputTokens: 0, outputTokens: 0 }, modelErrors: [], autoFixes: [] });
function capture(label, options = {}) {
  const directory = join(paths.captures, label);
  mkdirSync(directory);
  const source = options.source || fixture();
  const working = options.working || source;
  const sourceOnly = !!options.sourceOnly;
  const view = options.view || historicalView(label);
  const fileBytes = new Map([['source.docx', source]]);
  if (!sourceOnly) fileBytes.set('working.docx', working);
  if (options.offline || sourceOnly) fileBytes.set('offline-review.json', encode(view));
  const cap = { schemaVersion: 1, capturedAt: '2026-10-09T00:00:00.000Z',
    source: { base: 'http://127.0.0.1:3211', id: options.id || `sfixture${label.replace(/[^a-z0-9]/g, '')}`, name: `${label}-软件验收.docx` },
    sourceFile: { path: join(directory, 'source.docx'), sha256: sha256(source), verified: true },
    sourceDoc: { file: 'source.docx', sha256: sha256(source), verified: true },
    requests: { session: { status: 200, body: sourceOnly ? { exists: false } : { exists: true, result: options.offline ? null : view, workVersion: options.workVersion || null } },
      reviewStatus: { status: 200, body: sourceOnly ? { exists: false } : { exists: true, running: false, hasResult: true } },
      original: sourceOnly ? { status: 404, file: null, sha256: null } : { status: 200, file: 'source.docx', sha256: sha256(source) },
      working: sourceOnly ? { status: 404, file: null, sha256: null } : { status: 200, file: 'working.docx', sha256: sha256(working) } },
    consistency: { stable: true, vectorsEqual: sourceOnly ? null : options.vectorsEqual ?? true, differences: [] },
    offlineReview: options.offline || sourceOnly ? { file: 'offline-review.json', sha256: sha256(fileBytes.get('offline-review.json')), sourceType: 'synthetic-software-review', bindingStatus: 'verified' } : null,
  };
  if (options.change) options.change(cap, fileBytes);
  fileBytes.set('capture.json', encode(cap));
  for (const [name, bytes] of fileBytes) writeFileSync(join(directory, name), bytes, { flag: 'wx' });
  const complete = { schemaVersion: 1, captureSha256: sha256(fileBytes.get('capture.json')),
    files: [...fileBytes].map(([file, bytes]) => ({ file, sha256: sha256(bytes), bytes: bytes.length })) };
  writeFileSync(join(directory, 'complete.json'), encode(complete), { flag: 'wx' });
  return { directory, cap, complete, source, working, view, fileBytes };
}
async function rejection(name, fn, codes = [], extra = {}) {
  try { const value = await fn(); check(false, name, { unexpected: value, ...extra }); return null; }
  catch (error) {
    const ok = !codes.length || codes.includes(error.code);
    report.rejected.push({ name, code: error.code || null, message: error.message, ...extra });
    check(ok, name, { code: error.code || null, ...extra }); return error;
  }
}
async function importCase(item, more = {}) {
  const imported = await importLegacyCapture(params(item.directory, more));
  const saved = await loadSessionSnapshot({ sessionId: imported.id, storageRoot: paths.sessions });
  const bytes = await loadWorkingVersion({ sessionId: imported.id, versionId: saved.snapshot.workVersion.id, storageRoot: paths.versions });
  recordCase(item.cap.source.id, { captureDirectory: item.directory, sourceSha256: sha256(item.source), workingSha256: sha256(item.working),
    importResult: imported, storedManifest: saved.manifest });
  return { imported, saved, bytes };
}

try {
  const source = fixture();
  const observed = patchBytes(source, [['甲', '〔甲〕']], 'captured', null);
  const full = capture('captured', { source, working: observed.buffer });
  const captureBefore = treeHash(full.directory);
  const read = await readLegacyCapture(full.directory);
  check(read.capture.source.id === full.cap.source.id && equal(read.view, full.view), 'complete capture identity and historical view are read exactly');
  const first = await importCase(full);
  check(first.bytes.buffer.equals(observed.buffer) && first.bytes.originalBuffer.equals(source), 'captured working and original bytes import exactly');
  check(first.saved.snapshot.legacy.recoveryKind === 'captured-working-file' && first.saved.snapshot.legacy.historicalWorkingAvailable,
    'captured file recovery is explicitly distinguished');
  check(first.saved.snapshot.history.entries.length === 1 && first.saved.snapshot.appliedFixes.length === 0,
    'captured working without a verified ancestry never invents older mutation steps');
  check(first.saved.snapshot.result === null && first.saved.snapshot.reviewRunId === null && first.saved.snapshot.resultRunId === null && !first.saved.snapshot.reviewRecords.length,
    'historical review never becomes a current review or run');
  check(first.saved.snapshot.clean.status === 'legacy-unverified' && !first.saved.snapshot.reviewRunning,
    'imported working file waits for explicit cleaning verification');
  check(equal(treeHash(full.directory), captureBefore), 'capture evidence and complete marker remain untouched');
  const loadedView = await loadLegacyReview({ archiveId: first.imported.archiveId, storageRoot: paths.legacy });
  check(equal(loadedView.view, full.view) && loadedView.capture.source.id === full.cap.source.id, 'archive retains independent exact historical view');
  check(readFileSync(join(paths.legacy, first.imported.archiveId, 'capture.complete.json')).equals(readFileSync(join(full.directory, 'complete.json')))
    && loadedView.manifest.files.some((f) => f.file === 'capture.complete.json' && f.sha256 === sha256(readFileSync(join(full.directory, 'complete.json')))),
    'archive seals the exact original capture completion bytes and their hash');
  loadedView.view.issues[0].message = 'only mutate caller copy';
  check(equal((await loadLegacyReview({ archiveId: first.imported.archiveId, storageRoot: paths.legacy })).view, full.view), 'reading history exposes independent caller copy');

  const only = capture('sourceonly', { sourceOnly: true });
  const second = await importCase(only);
  check(second.bytes.buffer.equals(only.source) && second.bytes.originalBuffer.equals(only.source), 'verified source-only recovery imports exact source bytes');
  check(second.saved.snapshot.legacy.recoveryKind === 'verified-source-reimport' && !second.saved.snapshot.legacy.historicalWorkingAvailable
    && second.saved.snapshot.legacy.consistency === 'unknown' && second.saved.snapshot.history.entries.length === 1,
    'source-only recovery never invents missing working changes or history');
  check(second.saved.snapshot.result === null && equal((await loadLegacyReview({ archiveId: second.imported.archiveId, storageRoot: paths.legacy })).view, only.view),
    'offline historical result is archived separately from source-only current draft');
  const mismatch = capture('mismatch', { source, working: observed.buffer, vectorsEqual: false });
  const mismatchResult = await importCase(mismatch);
  check(mismatchResult.bytes.buffer.equals(observed.buffer) && mismatchResult.saved.snapshot.legacy.consistency === 'mismatch',
    'known API-versus-file mismatch remains explicit without inferred text replay');

  const oldId = 'sfixtureancestry';
  const oldVersions = []; const oldBuffers = [source];
  let oldParent = await saveWorkingVersion({ sessionId: oldId, name: 'old-software.docx', buffer: source, originalBuffer: source,
    operation: 'software-original', storageRoot: paths.oldVersions }); oldVersions.push(oldParent);
  for (const [i, replacements] of [[['甲', '〔甲〕']], [['乙', '〔乙〕']], [['丙', '〔丙〕'], ['丁', '〔丁〕']]].entries()) {
    const patched = patchBytes(oldBuffers.at(-1), replacements, `step${i + 1}`, oldParent.id);
    oldParent = await saveWorkingVersion({ sessionId: oldId, name: 'old-software.docx', buffer: patched.buffer, originalBuffer: source,
      parent: oldParent, patches: patched.patches, operation: 'software-fix', storageRoot: paths.oldVersions });
    oldBuffers.push(patched.buffer); oldVersions.push(oldParent);
  }
  const ancestorCapture = capture('ancestry', { id: oldId, source, working: oldBuffers.at(-1), workVersion: oldVersions.at(-1) });
  const ancestry = await importCase(ancestorCapture);
  const chain = ancestry.saved.snapshot.history.entries;
  check(chain.length === 4 && ancestry.saved.snapshot.legacy.restoredHistorySteps === 3 && ancestry.saved.snapshot.workVersion.revision === 3,
    'four physical versions restore their complete ancestry');
  check(equal(chain.map((e) => e.appliedFixes.length), [0, 1, 2, 4]) && ancestry.saved.snapshot.appliedFixes.length === 4,
    'cumulative applied fixes are restored separately for every version');
  const newVersions = [];
  for (const [i, entry] of chain.entries()) {
    const saved = await loadWorkingVersion({ sessionId: ancestry.imported.id, versionId: entry.versionId, storageRoot: paths.versions });
    newVersions.push(saved.version);
    check(saved.buffer.equals(oldBuffers[i]) && saved.originalBuffer.equals(source), `ancestry version ${i} restores every observed byte`);
    check(saved.version.revision === i && saved.version.parentId === (i ? chain[i - 1].versionId : null), `ancestry version ${i} preserves physical parent order`);
    check(saved.version.sourceSha256 === sha256(source), `ancestry version ${i} keeps original source hash`);
    if (i) check(saved.version.patches.every((p) => p.sourceVersionId === chain[i - 1].versionId), `ancestry version ${i} remaps patch source-version identity`);
  }
  check(chain.slice(1).every((entry, i) => entry.appliedFixes.filter((p) => p.toVersionId === entry.versionId).every((p) => p.fromVersionId === chain[i].versionId)),
    'cumulative fixes bind physical from/to identities after migration');
  check(Object.entries(ancestry.saved.snapshot.legacy.importedVersionMap).every(([old, current], i) => old === oldVersions[i].id && current === chain[i].versionId),
    'old-to-new version map records all verified ancestors');
  const replayedBytes = applyDocxPatches(oldBuffers[2], newVersions[3].patches).buffer;
  check(equal(vector(parseDocxBuffer(replayedBytes)), vector(parseDocxBuffer(oldBuffers[3]))), 'last stored patch group independently reproduces expected text');

  const archiveBefore = treeHash(join(paths.legacy, ancestry.imported.archiveId));
  const later = patchBytes(oldBuffers[3], [['。', '！']], 'later', ancestry.saved.snapshot.workVersion.id);
  const laterVersion = await saveWorkingVersion({ sessionId: ancestry.imported.id, name: ancestry.saved.snapshot.name, buffer: later.buffer, originalBuffer: source,
    parent: ancestry.saved.snapshot.workVersion, patches: later.patches, operation: 'subsequent-software-edit', storageRoot: paths.versions });
  const editedSnapshot = structuredClone(ancestry.saved.snapshot);
  editedSnapshot.workVersion = laterVersion; editedSnapshot.mutationEpoch = 7; editedSnapshot.maxVersionRevision = laterVersion.revision;
  editedSnapshot.history.entries.push({ versionId: laterVersion.id, appliedFixes: [...editedSnapshot.appliedFixes, ...later.patches] });
  editedSnapshot.history.cursor = editedSnapshot.history.entries.length - 1; editedSnapshot.appliedFixes.push(...later.patches);
  editedSnapshot.humanRecords = [{ kind: 'software-preservation-sentinel', note: 'retain later feedback' }];
  editedSnapshot.result = { softwareFixture: true, reviewRunId: 'software-later-run', issues: [] }; editedSnapshot.reviewRunId = 'software-later-run';
  const editedManifest = await saveSessionSnapshot({ sessionId: ancestry.imported.id, snapshot: editedSnapshot, expectedRevision: ancestry.saved.manifest.revision, storageRoot: paths.sessions });
  const versionsBeforeRepeat = treeHash(join(paths.versions, ancestry.imported.id));
  const repeated = await importLegacyCapture(params(ancestorCapture.directory));
  const afterRepeat = await loadSessionSnapshot({ sessionId: ancestry.imported.id, storageRoot: paths.sessions });
  check(repeated.replayed && repeated.workVersion.id === laterVersion.id && afterRepeat.manifest.manifestSha256 === editedManifest.manifestSha256
    && equal(afterRepeat.snapshot, editedSnapshot), 'repeat import preserves all subsequent edits, feedback and new review state');
  check(equal(treeHash(join(paths.legacy, ancestry.imported.archiveId)), archiveBefore) && equal(treeHash(join(paths.versions, ancestry.imported.id)), versionsBeforeRepeat),
    'repeat import does not overwrite immutable archive or version bytes');

  const missing = capture('missingbytes', { sourceOnly: true, change(cap, bytes) { cap.sourceDoc = null; bytes.delete('source.docx'); } });
  await rejection('missing original and verified source reject current draft creation', () => importLegacyCapture(params(missing.directory)), ['LEGACY_BYTES_MISSING']);
  const missingId = `slegacy${sha256(readFileSync(join(missing.directory, 'capture.json'))).slice(0, 32)}`;
  check(!existsSync(join(paths.sessions, missingId)), 'missing-source rejection creates no current session');
  const broken = capture('capturehash');
  writeFileSync(owned(join(broken.directory, 'source.docx')), Buffer.from('corrupt fixture'));
  await rejection('corrupt complete-listed input hash rejects capture', () => readLegacyCapture(broken.directory), ['LEGACY_CAPTURE_HASH']);
  const malformed = capture('badjson'); writeFileSync(owned(join(malformed.directory, 'complete.json')), '{');
  await rejection('malformed completion JSON rejects capture', () => readLegacyCapture(malformed.directory));
  const badSource = capture('badsourcesha', { sourceOnly: true, change(cap) { cap.sourceDoc.sha256 = '0'.repeat(64); } });
  await rejection('verified-source declaration must match its actual hash', () => importLegacyCapture(params(badSource.directory)), ['LEGACY_SOURCE_HASH']);
  const missingWorking = capture('declaredmissing', { change(cap, bytes) { bytes.delete('working.docx'); } });
  await rejection('declared successful working response without captured file rejects import', () => importLegacyCapture(params(missingWorking.directory)), ['LEGACY_CAPTURE_INVALID', 'LEGACY_BYTES_MISSING', 'LEGACY_SOURCE_HASH']);
  const missingOriginal = capture('declaredmissingoriginal', { change(cap) { cap.requests.original.file = 'not-captured.docx'; } });
  await rejection('declared successful original response cannot silently use independently verified source', () => importLegacyCapture(params(missingOriginal.directory)), ['LEGACY_BYTES_MISSING']);
  const malformedHash = capture('declaredmalformedsha', { change(cap) { cap.requests.working.sha256 = 'not-a-sha256'; } });
  await rejection('successful captured response requires complete SHA256 identity', () => importLegacyCapture(params(malformedHash.directory)), ['LEGACY_BYTES_MISSING']);
  const badOriginal = capture('badoriginalsha', { change(cap) { cap.requests.original.sha256 = '0'.repeat(64); } });
  await rejection('declared original response hash must match captured original', () => importLegacyCapture(params(badOriginal.directory)), ['LEGACY_SOURCE_HASH']);
  const badWorking = capture('badworkingsha', { change(cap) { cap.requests.working.sha256 = '0'.repeat(64); } });
  await rejection('declared working response hash must match captured working', () => importLegacyCapture(params(badWorking.directory)), ['LEGACY_SOURCE_HASH']);
  const untrustedBase = capture('wrongbase', { change(cap) { cap.source.base = 'http://127.0.0.1:3212'; } });
  await rejection('new-service identity cannot masquerade as old-service capture', () => readLegacyCapture(untrustedBase.directory), ['LEGACY_CAPTURE_INVALID']);
  const offlineHash = capture('offlinehash', { sourceOnly: true, change(cap) { cap.offlineReview.sha256 = '0'.repeat(64); } });
  await rejection('offline historical result requires matching capture hash', () => readLegacyCapture(offlineHash.directory), ['LEGACY_CAPTURE_HASH']);
  const pathEscape = capture('pathescape');
  const pathComplete = JSON.parse(readFileSync(join(pathEscape.directory, 'complete.json'), 'utf8'));
  pathComplete.files.push({ file: '../outside.docx', sha256: sha256(source) });
  writeFileSync(owned(join(pathEscape.directory, 'complete.json')), encode(pathComplete));
  await rejection('capture path traversal rejects before outside read', () => readLegacyCapture(pathEscape.directory), ['LEGACY_PATH_INVALID']);
  const reserved = capture('reserved');
  const reservedComplete = JSON.parse(readFileSync(join(reserved.directory, 'complete.json'), 'utf8'));
  reservedComplete.files.push({ file: 'review.json', sha256: sha256(source) });
  writeFileSync(owned(join(reserved.directory, 'complete.json')), encode(reservedComplete));
  await rejection('capture cannot inject reserved archive view filename', () => readLegacyCapture(reserved.directory), ['LEGACY_CAPTURE_INVALID']);
  const reservedSeal = capture('reservedseal');
  const sealComplete = JSON.parse(readFileSync(join(reservedSeal.directory, 'complete.json'), 'utf8'));
  sealComplete.files.push({ file: 'capture.complete.json', sha256: sha256(source) });
  writeFileSync(owned(join(reservedSeal.directory, 'complete.json')), encode(sealComplete));
  await rejection('capture cannot substitute reserved original completion bytes', () => readLegacyCapture(reservedSeal.directory), ['LEGACY_CAPTURE_INVALID']);
  const duplicate = capture('duplicate');
  const dupComplete = JSON.parse(readFileSync(join(duplicate.directory, 'complete.json'), 'utf8')); dupComplete.files.push(dupComplete.files[0]);
  writeFileSync(owned(join(duplicate.directory, 'complete.json')), encode(dupComplete));
  await rejection('duplicate capture manifest filenames reject capture', () => readLegacyCapture(duplicate.directory), ['LEGACY_CAPTURE_INVALID']);

  const tamper = capture('tamperarchive'); const tamperResult = await importCase(tamper);
  const tamperDirectory = join(paths.legacy, tamperResult.imported.archiveId);
  writeFileSync(owned(join(tamperDirectory, 'review.json')), encode({ changed: true }));
  await rejection('corrupted archived historical view rejects on read', () => loadLegacyReview({ archiveId: tamperResult.imported.archiveId, storageRoot: paths.legacy }), ['LEGACY_ARCHIVE_HASH']);
  await rejection('repeat import refuses overwriting differing archive bytes', () => importLegacyCapture(params(tamper.directory)), ['LEGACY_IMMUTABLE_CONFLICT']);
  await rejection('archive identity path traversal rejects', () => loadLegacyReview({ archiveId: '../outside', storageRoot: paths.legacy }), ['LEGACY_ID_INVALID']);
  const forged = capture('forgedmanifest'); const forgedResult = await importCase(forged);
  const forgedPath = join(paths.legacy, forgedResult.imported.archiveId, 'archive.complete.json');
  const forgedManifest = JSON.parse(readFileSync(forgedPath, 'utf8')); forgedManifest.files.push({ file: '../outside.json', sha256: sha256(source) });
  writeFileSync(owned(forgedPath), encode(forgedManifest));
  await rejection('archive manifest cannot escape archive directory', () => loadLegacyReview({ archiveId: forgedResult.imported.archiveId, storageRoot: paths.legacy }), ['LEGACY_PATH_INVALID']);
  const changedArchiveIdentity = capture('archiveidentity'); const changedIdentityResult = await importCase(changedArchiveIdentity);
  const changedIdentityPath = join(paths.legacy, changedIdentityResult.imported.archiveId, 'archive.complete.json');
  const changedManifest = JSON.parse(readFileSync(changedIdentityPath, 'utf8')); changedManifest.id = 'l' + '0'.repeat(32);
  writeFileSync(owned(changedIdentityPath), encode(changedManifest));
  await rejection('archive completion identity mismatch rejects', () => loadLegacyReview({ archiveId: changedIdentityResult.imported.archiveId, storageRoot: paths.legacy }), ['LEGACY_ARCHIVE_INVALID']);

  const junction = join(paths.captures, 'capture-junction');
  symlinkSync(full.directory, owned(junction), process.platform === 'win32' ? 'junction' : 'dir');
  await rejection('symbolic capture directory is rejected', () => readLegacyCapture(junction), ['LEGACY_CAPTURE_INVALID']);
  const archiveJunctionRoot = join(STORAGE, 'archive-junction-root'); mkdirSync(archiveJunctionRoot);
  symlinkSync(join(paths.legacy, first.imported.archiveId), owned(join(archiveJunctionRoot, first.imported.archiveId)), process.platform === 'win32' ? 'junction' : 'dir');
  await rejection('symbolic archive directory is rejected', () => loadLegacyReview({ archiveId: first.imported.archiveId, storageRoot: archiveJunctionRoot }), ['LEGACY_PATH_INVALID']);
  const symlinkCapture = capture('symlinkfile');
  const symlinkPath = join(symlinkCapture.directory, 'source.docx'), backingPath = join(symlinkCapture.directory, 'source-backing.docx');
  renameSync(owned(symlinkPath), owned(backingPath));
  try {
    symlinkSync(backingPath, owned(symlinkPath), 'file');
    await rejection('symbolic listed capture file is rejected', () => readLegacyCapture(symlinkCapture.directory), ['LEGACY_PATH_INVALID']);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
    const reason = { name: 'symbolic listed capture file', code: error.code, reason: 'OS refused creating controlled test symlink; directory junction checks executed separately' };
    report.skipped.push(reason); console.log(`SKIP ${reason.name}: ${error.code}`);
  }
  const writeSymlinkCapture = capture('archivewritesymlink');
  const writeSymlinkArchiveId = `l${sha256(readFileSync(join(writeSymlinkCapture.directory, 'capture.json'))).slice(0, 32)}`;
  const writeSymlinkArchiveDirectory = join(paths.legacy, writeSymlinkArchiveId); mkdirSync(writeSymlinkArchiveDirectory);
  try {
    symlinkSync(join(writeSymlinkCapture.directory, 'capture.json'), owned(join(writeSymlinkArchiveDirectory, 'capture.json')), 'file');
    await rejection('import rejects pre-existing archive symlink even when target bytes match', () => importLegacyCapture(params(writeSymlinkCapture.directory)), ['LEGACY_PATH_INVALID']);
    check(!existsSync(join(paths.sessions, `slegacy${writeSymlinkArchiveId.slice(1)}`)), 'unsafe archive symlink cannot publish a new current session');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
    const reason = { name: 'pre-existing archive file symlink', code: error.code, reason: 'OS refused creating controlled test file symlink' };
    report.skipped.push(reason); console.log(`SKIP ${reason.name}: ${error.code}`);
  }

  const wrongAncestor = capture('ancestryhash', { id: oldId, source, working: observed.buffer, workVersion: oldVersions.at(-1) });
  await rejection('captured working hash must equal latest verified ancestor bytes', () => importLegacyCapture(params(wrongAncestor.directory)), ['LEGACY_HISTORY_INVALID']);
  const absentAncestor = capture('absentancestor', { source, working: observed.buffer, workVersion: { id: 'sfixtureabsentancestor:v000001-' + sha256(observed.buffer) } });
  await rejection('declared missing physical ancestor is rejected rather than invented', () => importLegacyCapture(params(absentAncestor.directory)), ['VERSION_NOT_FOUND', 'VERSION_INCOMPLETE']);

  const retryWorkspaceId = 'wregistrationretry';
  const emptyWorkspace = { id: retryWorkspaceId, entries: [], activeSessionId: null, queue: { state: 'paused', cursorSessionId: null, options: { useModel: false } }, receipts: {} };
  await saveWorkspace({ workspaceId: retryWorkspaceId, workspace: emptyWorkspace, expectedRevision: -1, storageRoot: paths.workspaces });
  const retryCapture = capture('registrationretry');
  const heldLock = join(paths.workspaces, retryWorkspaceId, 'state.lock');
  writeFileSync(owned(heldLock), encode({ schemaVersion: 1, pid: process.pid, token: randomUUID() }), { flag: 'wx' });
  await rejection('busy registration returns explicit recoverable conflict after preserving imported session', () => importLegacyCapture(params(retryCapture.directory, { workspaceId: retryWorkspaceId })), ['LEGACY_WORKSPACE_CONFLICT']);
  const retryId = `slegacy${sha256(readFileSync(join(retryCapture.directory, 'capture.json'))).slice(0, 32)}`;
  const durableAfterFailure = await loadSessionSnapshot({ sessionId: retryId, storageRoot: paths.sessions });
  check(durableAfterFailure.snapshot.result === null && durableAfterFailure.snapshot.legacy.available,
    'registration conflict preserves durable current draft and separate legacy evidence');
  unlinkSync(owned(heldLock));
  const registrationRetry = await importLegacyCapture(params(retryCapture.directory, { workspaceId: retryWorkspaceId }));
  const retryWorkspace = await loadWorkspace({ workspaceId: retryWorkspaceId, storageRoot: paths.workspaces });
  check(registrationRetry.replayed && retryWorkspace.workspace.entries.length === 1 && retryWorkspace.workspace.entries[0].id === retryId,
    'same capture retry completes missing workspace registration exactly once');
  check(retryWorkspace.workspace.queue.state === 'paused' && equal(retryWorkspace.workspace.queue.options, { useModel: false }),
    'registration retry preserves existing queue plan and options');
  const registrationBefore = retryWorkspace.manifest.manifestSha256;
  await importLegacyCapture(params(retryCapture.directory, { workspaceId: retryWorkspaceId }));
  check((await loadWorkspace({ workspaceId: retryWorkspaceId, storageRoot: paths.workspaces })).manifest.manifestSha256 === registrationBefore,
    'repeat registration does not rewrite existing entry or workspace revision');

  const concurrencyWorkspaceId = 'wconcurrentimports';
  const concurrentCaptures = Array.from({ length: 4 }, (_, i) => capture(`concurrent${i}`, { sourceOnly: true }));
  const concurrent = await Promise.allSettled(concurrentCaptures.map((c) => importLegacyCapture(params(c.directory, { workspaceId: concurrencyWorkspaceId }))));
  const failed = concurrent.filter((r) => r.status === 'rejected');
  report.concurrentImports = concurrent.map((r) => r.status === 'fulfilled' ? { status: r.status, id: r.value.id } : { status: r.status, code: r.reason.code, message: r.reason.message });
  check(!failed.length, 'parallel imports resolve workspace CAS without losing successful registration', { results: report.concurrentImports });
  const concurrentWorkspace = await loadWorkspace({ workspaceId: concurrencyWorkspaceId, storageRoot: paths.workspaces });
  const importedIds = concurrent.filter((r) => r.status === 'fulfilled').map((r) => r.value.id);
  check(concurrentWorkspace.workspace.entries.length === 4 && new Set(concurrentWorkspace.workspace.entries.map((e) => e.id)).size === 4
    && importedIds.every((id) => concurrentWorkspace.workspace.entries.some((e) => e.id === id)), 'concurrent registrations preserve all distinct session identities');
  for (const c of concurrentCaptures) await importLegacyCapture(params(c.directory, { workspaceId: concurrencyWorkspaceId }));
  const concurrentAfterRetry = await loadWorkspace({ workspaceId: concurrencyWorkspaceId, storageRoot: paths.workspaces });
  check(concurrentAfterRetry.workspace.entries.length === 4 && new Set(concurrentAfterRetry.workspace.entries.map((e) => e.id)).size === 4,
    'explicit repeat of each parallel import preserves exactly one entry per capture');
  const staleRevision = concurrentAfterRetry.manifest.revision;
  const changedWorkspace = structuredClone(concurrentAfterRetry.workspace); changedWorkspace.queue.state = 'paused';
  await saveWorkspace({ workspaceId: concurrencyWorkspaceId, workspace: changedWorkspace, expectedRevision: staleRevision, storageRoot: paths.workspaces });
  await rejection('stale workspace CAS cannot replace newer registration state', () => saveWorkspace({ workspaceId: concurrencyWorkspaceId,
    workspace: concurrentAfterRetry.workspace, expectedRevision: staleRevision, storageRoot: paths.workspaces }), ['WORKSPACE_REVISION_CONFLICT']);

  const damagedWorkspaceId = 'wdamagedregistration';
  await saveWorkspace({ workspaceId: damagedWorkspaceId, workspace: { ...emptyWorkspace, id: damagedWorkspaceId }, expectedRevision: -1, storageRoot: paths.workspaces });
  const missingWorkspacePath = join(paths.workspaces, damagedWorkspaceId, 'state.json');
  const missingWorkspaceBackup = `${missingWorkspacePath}.evidence-backup`;
  renameSync(owned(missingWorkspacePath), owned(missingWorkspaceBackup));
  const damagedCapture = capture('damagedregistration');
  await rejection('missing existing workspace state never bootstraps a replacement queue', () => importLegacyCapture(params(damagedCapture.directory, { workspaceId: damagedWorkspaceId })), ['WORKSPACE_MISSING']);
  check(!existsSync(missingWorkspacePath), 'failed registration leaves missing-state evidence untouched');
  renameSync(owned(missingWorkspaceBackup), owned(missingWorkspacePath));
  await importLegacyCapture(params(damagedCapture.directory, { workspaceId: damagedWorkspaceId }));
  check((await loadWorkspace({ workspaceId: damagedWorkspaceId, storageRoot: paths.workspaces })).workspace.entries.length === 1,
    'restoring genuine workspace record permits explicit registration retry');
} catch (error) {
  report.fatal = { code: error.code || null, message: error.message, stack: error.stack };
  check(false, 'controller completes all requested scenarios', { error: report.fatal });
} finally {
  report.finishedAt = new Date().toISOString();
  report.hashes = Object.fromEntries(['tools/test-legacy-imports.mjs', 'src/legacy-imports.js', 'src/working-version.js', 'src/session-store.js', 'src/workspace-store.js', 'src/docx-patches.js', 'src/docx.js'].map((name) => [name, sha256(readFileSync(join(ROOT, name)))]));
  report.summary = { total: report.checks.length, passed: report.checks.filter((c) => c.ok).length,
    failed: report.checks.filter((c) => !c.ok).length, skipped: report.skipped.length, rejectedProbes: report.rejected.length,
    generatedCases: report.cases.length, modelCalls: 0, serviceRequests: 0 };
  report.evidenceHashes = treeHash(STORAGE);
  writeFileSync(OUT, encode(report), { flag: 'wx' });
  writeFileSync(`${OUT}.complete.json`, encode({ schemaVersion: 1, file: OUT, sha256: sha256(readFileSync(OUT)), hashes: report.hashes, summary: report.summary }), { flag: 'wx' });
  console.log(JSON.stringify({ out: OUT, ...report.summary }));
  if (report.summary.failed) process.exitCode = 1;
}
