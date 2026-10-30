/** Real isolated HTTP cleaning/import/history acceptance; generated OPC only. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { writeZip } from '../src/zip-write.js';
import { openZip } from '../src/zip.js';
import { parseDocxBuffer } from '../src/docx.js';
import { cleanDocx, inspectDocxComments } from '../src/docx-clean.js';
import { saveWorkingVersion, sha256 } from '../src/working-version.js';
import { saveSessionSnapshot, loadSessionSnapshot } from '../src/session-store.js';
import { fullReview } from '../src/review.js';
import { importLegacyCapture } from '../src/legacy-imports.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const PORT = Number(flag('port', 3320));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || [3210, 3211, 3212].includes(PORT)) throw new Error('Use an isolated owned test port');
const BASE = `http://127.0.0.1:${PORT}`;
const token = randomUUID();
const ORIGINAL_COMMENT_COUNT = 4;
const OUT = resolve(ROOT, flag('out', `data/verify/clean-ingestion-${Date.now()}-${token.slice(0, 8)}.json`));
if (existsSync(OUT)) throw new Error('Evidence exists; choose a fresh --out.');
const STORAGE = resolve(dirname(OUT), `clean-ingestion-storage-${token}`);
const ROOTS = Object.fromEntries(['sessions', 'versions', 'workspaces', 'audit', 'legacy', 'ingestion', 'jobs'].map((kind) => [kind, join(STORAGE, kind)]));
const workspaceId = `wclean${token.replace(/-/g, '')}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const report = { generatedAt: new Date().toISOString(), base: BASE, storage: STORAGE, roots: ROOTS,
  modelCalls: 0, realArkCalls: 0, paidModelCalls: 0, localProviderCalls: 0, checks: [], processes: [],
  coverage: 'Generated valid OPC software fixtures. Actual owned HTTP process and seven isolated session/version/workspace/audit/legacy/ingestion/job roots. No browser, real manuscripts, semantic model answers or existing service processes.' };
let app = null; let fake = null; let fakeBase = null; let diskLock = null;
const check = async (name, fn) => {
  try { const facts = await fn(); report.checks.push({ name, ok: true, ...facts }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, ok: false, error: error.stack || String(error) }); throw error; }
};
async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function request(path, { body, bytes } = {}) {
  const response = await fetch(BASE + path, { method: body || bytes ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : bytes ? { 'content-type': 'application/octet-stream' } : {},
    body: body ? JSON.stringify(body) : bytes, signal: AbortSignal.timeout(25000) });
  const buffer = Buffer.from(await response.arrayBuffer()); let data = null;
  if (/json/i.test(response.headers.get('content-type') || '')) data = JSON.parse(buffer.toString('utf8'));
  return { status: response.status, data, buffer, headers: response.headers };
}
function fixture({ comments = true, unsafe = false } = {}) {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const R = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const markers = (id) => comments ? `<w:commentRangeStart w:id='${id}'/><w:r><w:commentReference w:id='${id}'/></w:r><w:commentRangeEnd w:id='${id}'/>` : '';
  const override = (name, type) => `<Override PartName='/${name}' ContentType='${type}'/>`;
  const entries = [
    { name: '[Content_Types].xml', data: `<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'><Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/><Default Extension='xml' ContentType='application/xml'/><Default Extension='png' ContentType='image/png'/>${override('word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')}${override('word/footnotes.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml')}${override('word/endnotes.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml')}${override('word/header1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml')}${comments ? override('word/comments.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml') : ''}</Types>` },
    { name: '_rels/.rels', data: `<Relationships xmlns='${R}'><Relationship Id='doc' Type='${office}officeDocument' Target='word/document.xml'/></Relationships>` },
    { name: 'word/document.xml', data: `<w:document xmlns:w='${W}' xmlns:r='${office.slice(0, -1)}'><w:body><w:p><w:r><w:t>软件清洗导入验收</w:t></w:r></w:p><w:p>${markers(0)}<w:bookmarkStart w:id='9' w:name='software'/><w:hyperlink r:id='link'><w:r><w:t>软件链接</w:t></w:r></w:hyperlink><w:r><w:t>软件正文...只验证状态，不作质量标签。</w:t><w:footnoteReference w:id='1'/><w:endnoteReference w:id='1'/></w:r><w:fldSimple w:instr=' PAGE '><w:r><w:t>1</w:t></w:r></w:fldSimple><w:ins w:id='4' w:author='软件fixture'><w:r><w:t>软件新增</w:t></w:r></w:ins><w:del w:id='5' w:author='软件fixture'><w:r><w:delText>软件删除</w:delText></w:r></w:del><w:bookmarkEnd w:id='9'/></w:p><w:sectPr><w:headerReference w:type='default' r:id='header'/></w:sectPr></w:body></w:document>` },
    { name: 'word/footnotes.xml', data: `<w:footnotes xmlns:w='${W}'><w:footnote w:id='1'><w:p>${markers(1)}<w:r><w:t>软件脚注保留文字</w:t></w:r></w:p></w:footnote></w:footnotes>` },
    { name: 'word/endnotes.xml', data: `<w:endnotes xmlns:w='${W}'><w:endnote w:id='1'><w:p>${markers(2)}<w:r><w:t>软件尾注保留文字</w:t></w:r></w:p></w:endnote></w:endnotes>` },
    { name: 'word/header1.xml', data: `<w:hdr xmlns:w='${W}'><w:p>${markers(3)}<w:r><w:t>软件页眉保留文字</w:t></w:r></w:p></w:hdr>` },
    { name: 'word/media/software.png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3QAAAABJRU5ErkJggg==', 'base64') },
    { name: 'word/_rels/document.xml.rels', data: `<Relationships xmlns='${R}'><Relationship Id='link' Type='${office}hyperlink' Target='https://example.invalid/software' TargetMode='External'/><Relationship Id='footnotes' Type='${office}footnotes' Target='footnotes.xml'/><Relationship Id='endnotes' Type='${office}endnotes' Target='endnotes.xml'/><Relationship Id='header' Type='${office}header' Target='header1.xml'/>${comments ? `<Relationship Id='comment' Type='${office}comments' Target='${unsafe ? '../../missing/comments.xml' : './comments.xml'}'/>` : ''}</Relationships>` },
  ];
  if (comments) entries.push({ name: 'word/comments.xml', data: `<w:comments xmlns:w='${W}'>${[0, 1, 2, 3].map((id) => `<w:comment w:id='${id}' w:author='软件fixture'><w:p><w:r><w:t>软件批注${id}</w:t></w:r></w:p></w:comment>`).join('')}</w:comments>` });
  return writeZip(entries);
}
const vector = (doc) => Object.fromEntries(['paragraphs', 'footnotes', 'endnotes'].map((key) => [key, doc[key].map((part) => part.text)]));
const statusVerified = (clean) => ['cleaned', 'unchanged'].includes(clean?.status);
function verifiedProof(clean, version, expectedStatus) {
  assert.ok(statusVerified(clean), JSON.stringify(clean));
  if (expectedStatus) assert.equal(clean.status, expectedStatus);
  assert.equal(clean.sourceSha256, version.sourceSha256);
  assert.equal(clean.workSha256 || clean.outputSha256, version.sha256);
  assert.equal(clean.validatedVersionId, version.id);
  assert.equal(clean.beforeAfter?.verified, true);
  for (const value of Object.values(clean.beforeAfter.after)) assert.equal(value, 0);
}
const mutation = (session, operationId = randomUUID()) => ({ id: session.id, operationId, baseVersionId: session.workVersion.id, baseMutationEpoch: session.history.epoch });
async function session(id) { const value = await request(`/api/session?id=${id}`); assert.equal(value.status, 200, JSON.stringify(value.data)); assert.equal(value.data.exists, true); return value.data; }
async function snapshot(id) { return loadSessionSnapshot({ sessionId: id, storageRoot: ROOTS.sessions }); }
async function directoryNames(root) { try { return (await readdir(root)).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
async function seedOldSnapshot(id, buffer, originalBuffer = buffer) {
  const version = await saveWorkingVersion({ sessionId: id, name: 'software-legacy.docx', buffer, originalBuffer, storageRoot: ROOTS.versions });
  const doc = parseDocxBuffer(buffer); const result = await fullReview(doc, { useModel: false, useContext: false, useCases: false, useRecheck: false });
  const resultTexts = { body: doc.paragraphs.map((part) => part.text), footnote: doc.footnotes.map((part) => part.text), endnote: doc.endnotes.map((part) => part.text) };
  const saved = { id, name: 'software-legacy.docx', workVersion: version, clean: { commentsRemoved: doc.comments.length },
    createdAt: 1, history: { entries: [{ versionId: version.id, appliedFixes: [] }], cursor: 0 }, appliedFixes: [], mutationEpoch: 0, maxVersionRevision: 0,
    result, resultRunId: 'historical-software-run', reviewRunId: 'historical-software-run', resultVersionId: version.id,
    resultTexts, reviewTexts: resultTexts, reviewVersionId: version.id, reviewRunning: false, reviewProgress: { phase: 'done' },
    reviewRecords: [{ id: 'historical-software-run', versionId: version.id, result, texts: resultTexts, options: { useModel: false } }] };
  await saveSessionSnapshot({ sessionId: id, snapshot: saved, expectedRevision: -1, storageRoot: ROOTS.sessions });
  return saved;
}
async function seedImportedLegacy(buffer) {
  const captureDirectory = join(STORAGE, 'generated-capture'); await mkdir(captureDirectory, { recursive: true });
  const view = await fullReview(parseDocxBuffer(buffer, 'software-imported-legacy.docx'), { useModel: false, useContext: false, useCases: false, useRecheck: false });
  const capture = { schemaVersion: 1, capturedAt: '2026-10-09T00:00:00.000Z',
    source: { base: 'http://127.0.0.1:3210', id: 'ssoftwarecapture', name: 'software-imported-legacy.docx' },
    fixturePurpose: 'verification', requests: { session: { status: 200, body: { result: view } },
      original: { status: 200, file: 'original.docx', sha256: sha256(buffer) },
      working: { status: 200, file: 'working.docx', sha256: sha256(buffer) } }, consistency: { vectorsEqual: true } };
  const captureBytes = Buffer.from(JSON.stringify(capture, null, 2) + '\n');
  const files = [['capture.json', captureBytes], ['original.docx', buffer], ['working.docx', buffer]];
  for (const [name, bytes] of files) await writeFile(join(captureDirectory, name), bytes, { flag: 'wx' });
  await writeFile(join(captureDirectory, 'complete.json'), JSON.stringify({ schemaVersion: 1, captureSha256: sha256(captureBytes),
    files: files.map(([name, bytes]) => ({ file: name, sha256: sha256(bytes), bytes: bytes.length })) }, null, 2) + '\n', { flag: 'wx' });
  const imported = await importLegacyCapture({ captureDirectory, legacyRoot: ROOTS.legacy, versionRoot: ROOTS.versions,
    sessionRoot: ROOTS.sessions, workspaceRoot: ROOTS.workspaces, workspaceId, oldVersionRoot: ROOTS.versions, purpose: 'verification' });
  return { imported, view, captureSha256: sha256(captureBytes), captureDirectory };
}
async function startProvider() {
  fake = httpServer((req, res) => { report.localProviderCalls += 1; req.resume(); res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'software fixture: model calls are forbidden' })); });
  await new Promise((done, reject) => { fake.once('error', reject); fake.listen(0, '127.0.0.1', done); });
  fakeBase = `http://127.0.0.1:${fake.address().port}/api/v3`;
}
async function startApp() {
  const probe = netServer(); await new Promise((done, reject) => { probe.once('error', reject); probe.listen(PORT, '127.0.0.1', done); }); await new Promise((done) => probe.close(done));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:ARK|OPENAI|DOUBAO|VOLC)/i.test(key) && !/^(?:NODE_OPTIONS|NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key) && !/^DSH_/i.test(key)));
  Object.assign(env, { PORT: String(PORT), HOST: '127.0.0.1', DSH_SESSION_ROOT: ROOTS.sessions, DSH_WORKING_VERSION_ROOT: ROOTS.versions,
    DSH_WORKSPACE_ROOT: ROOTS.workspaces, DSH_AUDIT_ROOT: ROOTS.audit, DSH_LEGACY_ROOT: ROOTS.legacy, DSH_INGESTION_ROOT: ROOTS.ingestion,
    DSH_JOB_ROOT: ROOTS.jobs, DSH_REVIEW_WORKERS: '2',
    ARK_BASE_URL: fakeBase, ARK_API_KEY: 'local-clean-fixture-no-paid-key', ARK_MODEL: 'software-only', ARK_CONTEXT: '0', ARK_CASES: '0', ARK_CONSISTENCY: '0', ARK_PREFIX_CACHE: '0' });
  const child = spawn(process.execPath, [resolve(ROOT, 'server.mjs')], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); app = child;
  let ready = false; let failure = null;
  child.stdout.on('data', (bytes) => { if (bytes.toString().includes(BASE)) ready = true; }); child.stderr.on('data', () => {}); child.once('error', (error) => { failure = error; });
  report.processes.push({ event: 'start', pid: child.pid, at: new Date().toISOString() });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (failure) throw failure; if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned app exited before readiness'); if (ready) { try { if ((await request('/api/health')).status === 200) return; } catch {} } await sleep(50); }
  throw new Error('Owned app did not become ready');
}
async function stopApp(reason) {
  if (!app) return; const child = app;
  if (child.exitCode === null && child.signalCode === null) { const ended = new Promise((done) => child.once('exit', done)); child.kill('SIGKILL'); await bounded(ended, 5000, 'Owned app did not stop'); }
  if (app === child) app = null; report.processes.push({ event: 'stop', pid: child.pid, reason, at: new Date().toISOString() });
}
async function lockState(path) {
  assert.equal(process.platform, 'win32', 'This fixture exercises actual Windows FileShare locking');
  const code = "$cleanLockPath=[Environment]::GetEnvironmentVariable('DSH_CLEAN_LOCK_PATH'); $cleanFileHandle=[System.IO.File]::Open($cleanLockPath,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); try { [Console]::WriteLine('CLEAN_LOCK_READY'); [Console]::ReadLine() | Out-Null } finally { $cleanFileHandle.Dispose() }";
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', code], { env: { ...process.env, DSH_CLEAN_LOCK_PATH: path }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); diskLock = child;
  await bounded(new Promise((done, reject) => { child.stdout.on('data', (bytes) => { if (bytes.toString().includes('CLEAN_LOCK_READY')) done(); }); child.once('error', reject); child.once('exit', (value) => { if (value !== 0) reject(new Error('State lock helper exited early')); }); }), 10000, 'State lock helper not ready');
}
async function releaseLock() {
  if (!diskLock) return; const child = diskLock; diskLock = null;
  if (child.exitCode === null && child.signalCode === null) { const ended = new Promise((done) => child.once('exit', done)); child.stdin.end('\n'); try { await bounded(ended, 5000, 'State lock release timed out'); } catch { child.kill('SIGKILL'); await bounded(ended, 5000, 'State lock helper did not stop'); } }
}

try {
  for (const root of Object.values(ROOTS)) await mkdir(root, { recursive: true });
  report.fingerprints = Object.fromEntries(await Promise.all(['server.mjs', 'src/docx-clean.js', 'src/docx-clean-xml.js', 'src/session-store.js', 'src/working-version.js', 'src/fix-history.js', 'src/legacy-imports.js', 'src/review-server.js', 'src/review-runtime.js', 'src/job-store.js', 'tools/test-clean-ingestion.mjs'].map(async (name) => [name, sha256(await readFile(resolve(ROOT, name)))])));
  const raw = fixture(); const cleaned = cleanDocx(raw).buffer; const unchanged = fixture({ comments: false }); const unsafe = fixture({ unsafe: true });
  const dirtyOld = await seedOldSnapshot('scleaningdirty', raw);
  const cleanOld = await seedOldSnapshot('scleaningcleanold', cleaned, raw);
  const unsafeOld = await seedOldSnapshot('scleaningunsafe', unsafe);
  const saveFailOld = await seedOldSnapshot('scleaningpersistfail', raw);
  const importedLegacy = await seedImportedLegacy(raw);
  report.fixtureSha256 = { raw: sha256(raw), clean: sha256(cleaned), unchanged: sha256(unchanged), unsafe: sha256(unsafe) };
  await startProvider(); await startApp();
  await check('unsafe upload is 422 failed proof without any usable new session/version', async () => {
    const beforeSessions = await directoryNames(ROOTS.sessions); const beforeVersions = await directoryNames(ROOTS.versions);
    const beforeHealth = await request('/api/health');
    const response = await request('/api/upload?name=software-unsafe.docx', { bytes: unsafe });
    assert.equal(response.status, 422); assert.equal(response.data.clean?.status, 'failed'); assert.ok(response.data.code?.startsWith('CLEAN_'));
    assert.ok(response.data.clean.reason); assert.equal(response.data.clean.sourceSha256, sha256(unsafe)); assert.equal(response.data.clean.originalCommentCount, ORIGINAL_COMMENT_COUNT);
    assert.equal(response.data.id, undefined); assert.equal(response.data.workVersion, undefined);
    assert.deepEqual(await directoryNames(ROOTS.sessions), beforeSessions); assert.deepEqual(await directoryNames(ROOTS.versions), beforeVersions);
    assert.equal((await request('/api/health')).data.sessions, beforeHealth.data.sessions);
    return { status: response.status, code: response.data.code, newUsableSessions: 0 };
  });
  let uploaded;
  await check('safe upload reparses exact cleaned work bytes and retains original comments separately', async () => {
    const response = await request('/api/upload?name=software-clean.docx', { bytes: raw }); assert.equal(response.status, 200);
    uploaded = response.data; verifiedProof(uploaded.clean, uploaded.workVersion, 'cleaned');
    assert.equal(uploaded.doc.stats.comments, 0); assert.equal(uploaded.doc.originalCommentCount, ORIGINAL_COMMENT_COUNT); assert.equal(uploaded.clean.commentsRemoved, ORIGINAL_COMMENT_COUNT);
    assert.equal(uploaded.clean.anchorsRemoved, 12); assert.equal(uploaded.workVersion.sha256, sha256(cleaned));
    const work = await request(`/api/session-file?id=${uploaded.id}`); const original = await request(`/api/session-file?id=${uploaded.id}&original=1`);
    assert.equal(work.status, 200); assert.deepEqual(work.buffer, cleaned); assert.deepEqual(original.buffer, raw);
    assert.equal(work.headers.get('x-content-sha256'), sha256(cleaned)); assert.equal(original.headers.get('x-content-sha256'), sha256(raw));
    assert.equal(inspectDocxComments(work.buffer).anchors, 0); assert.equal(parseDocxBuffer(original.buffer).comments.length, ORIGINAL_COMMENT_COUNT);
    assert.deepEqual(vector(parseDocxBuffer(work.buffer)), vector(parseDocxBuffer(raw)));
    assert.deepEqual(openZip(work.buffer).read('word/media/software.png'), openZip(raw).read('word/media/software.png'));
    return { id: uploaded.id, workSha256: uploaded.workVersion.sha256, originalSha256: uploaded.workVersion.sourceSha256 };
  });
  await check('no-target upload returns an exact original working byte stream with unchanged proof', async () => {
    const response = await request('/api/upload?name=software-unchanged.docx', { bytes: unchanged }); assert.equal(response.status, 200);
    verifiedProof(response.data.clean, response.data.workVersion, 'unchanged'); assert.equal(response.data.clean.commentsRemoved, 0);
    assert.equal(response.data.doc.stats.comments, 0); assert.equal(response.data.doc.originalCommentCount, 0);
    assert.deepEqual((await request(`/api/session-file?id=${response.data.id}`)).buffer, unchanged);
    return { id: response.data.id };
  });
  await check('session, review-status, workspace and mutation payload expose one matching verified clean state', async () => {
    const opened = await session(uploaded.id); verifiedProof(opened.clean, opened.workVersion, 'cleaned');
    const status = await request(`/api/review-status?id=${uploaded.id}`); verifiedProof(status.data.clean, status.data.workVersion, 'cleaned');
    const workspace = await request(`/api/workspace?id=${workspaceId}`); assert.equal(workspace.status, 200);
    const attached = await request('/api/workspace', { body: { id: workspaceId, operationId: randomUUID(), expectedRevision: workspace.data.workspace.revision, action: 'attach', sessionId: uploaded.id } });
    assert.equal(attached.status, 200); const row = attached.data.workspace.entries.find((entry) => entry.id === uploaded.id); verifiedProof(row.clean, row.workVersion, 'cleaned');
    const rules = await request('/api/review', { body: { id: uploaded.id, useModel: false, useContext: false, useCases: false, useRecheck: false } }); assert.equal(rules.status, 200);
    const refreshed = await session(uploaded.id);
    const noop = await request('/api/apply-fixes', { body: { ...mutation(refreshed), baseReviewRunId: refreshed.reviewRunId, accepted: [] } }); assert.equal(noop.status, 200); verifiedProof(noop.data.clean, noop.data.workVersion, 'cleaned');
  });
  await check('old snapshot lacking status is lazily verified as unchanged without reparsing original comments into working doc', async () => {
    const value = await session(cleanOld.id); verifiedProof(value.clean, value.workVersion, 'unchanged');
    assert.equal(value.doc.stats.comments, 0); assert.equal(value.doc.originalCommentCount, ORIGINAL_COMMENT_COUNT);
    assert.equal(value.workVersion.id, cleanOld.workVersion.id); assert.equal((await snapshot(value.id)).snapshot.clean.status, 'unchanged');
  });
  await check('actual legacy capture import is review-blocked, archive-readable and never promoted to a current completed run', async () => {
    const id = importedLegacy.imported.id; const before = await session(id);
    assert.equal(before.clean.status, 'legacy-unverified'); assert.equal(before.legacy.archiveId, importedLegacy.imported.archiveId);
    assert.equal(before.hasResult, false); assert.equal(before.result, null); assert.equal(before.hasHistoricalResult, true);
    assert.equal((await request('/api/review', { body: { id, useModel: false, useContext: false, useCases: false, useRecheck: false } })).status, 409);
    const archiveBefore = await request(`/api/legacy-review?id=${id}`); assert.equal(archiveBefore.status, 200);
    assert.deepEqual(archiveBefore.data.view, importedLegacy.view); assert.equal(archiveBefore.data.captureSha256, importedLegacy.captureSha256);
    const cleanedResponse = await request('/api/clean-session', { body: mutation(before) }); assert.equal(cleanedResponse.status, 200);
    verifiedProof(cleanedResponse.data.clean, cleanedResponse.data.workVersion, 'cleaned');
    const after = await session(id); assert.equal(after.hasResult, false); assert.equal(after.result, null); assert.equal(after.hasHistoricalResult, true);
    const archiveAfter = await request(`/api/legacy-review?id=${id}`); assert.deepEqual(archiveAfter.data.view, archiveBefore.data.view);
    assert.equal(archiveAfter.data.captureSha256, importedLegacy.captureSha256);
    assert.deepEqual((await request(`/api/session-file?id=${id}&original=1`)).buffer, raw);
    assert.equal(sha256(await readFile(join(importedLegacy.captureDirectory, 'capture.json'))), importedLegacy.captureSha256);
    return { id, archiveId: importedLegacy.imported.archiveId, captureSha256: importedLegacy.captureSha256 };
  });
  let dirty;
  await check('old dirty snapshot is legacy-unverified and rule review is blocked without promoting historical results', async () => {
    dirty = await session(dirtyOld.id); assert.equal(dirty.clean.status, 'legacy-unverified');
    assert.equal(dirty.hasResult, false); assert.equal(dirty.result, null); assert.equal(dirty.hasHistoricalResult, true);
    const response = await request('/api/review', { body: { id: dirty.id, useModel: false, useContext: false, useCases: false, useRecheck: false } }); assert.equal(response.status, 409);
    assert.equal((await session(dirty.id)).workVersion.id, dirty.workVersion.id);
  });
  let cleanedLegacy; let firstCleanBody;
  await check('explicit clean-session creates a real immutable version/history entry while preserving original and historical record', async () => {
    firstCleanBody = mutation(dirty);
    const savedBefore = await snapshot(dirty.id);
    const duplicates = await Promise.all([request('/api/clean-session', { body: firstCleanBody }), request('/api/clean-session', { body: firstCleanBody })]);
    assert.ok(duplicates.every((response) => response.status === 200));
    assert.equal(duplicates.filter((response) => response.data.replayed === true).length, 1);
    assert.equal(duplicates[0].data.workVersion.id, duplicates[1].data.workVersion.id);
    cleanedLegacy = duplicates[0].data;
    assert.equal((await snapshot(dirty.id)).manifest.revision, savedBefore.manifest.revision + 1, 'duplicate submission commits once');
    verifiedProof(cleanedLegacy.clean, cleanedLegacy.workVersion, 'cleaned');
    assert.notEqual(cleanedLegacy.workVersion.id, dirty.workVersion.id); assert.equal(cleanedLegacy.history.cursor, 1); assert.equal(cleanedLegacy.history.total, 1);
    assert.equal(cleanedLegacy.workVersion.sourceSha256, sha256(raw)); assert.equal(cleanedLegacy.workVersion.sha256, sha256(cleaned));
    const value = await session(dirty.id); assert.equal(value.hasResult, false); assert.equal(value.result, null); assert.equal(value.hasHistoricalResult, true);
    assert.equal(value.doc.stats.comments, 0); assert.equal(value.doc.originalCommentCount, ORIGINAL_COMMENT_COUNT);
    assert.deepEqual((await request(`/api/session-file?id=${dirty.id}`)).buffer, cleaned);
    assert.deepEqual((await request(`/api/session-file?id=${dirty.id}&original=1`)).buffer, raw);
    assert.ok((await snapshot(dirty.id)).snapshot.reviewRecords.some((record) => record.id === 'historical-software-run'));
  });
  await check('same cleanup operation replays without extra commit and stale different operations return 409', async () => {
    const before = await snapshot(dirty.id);
    const replay = await request('/api/clean-session', { body: firstCleanBody }); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true);
    assert.equal(replay.data.workVersion.id, cleanedLegacy.workVersion.id); assert.equal((await snapshot(dirty.id)).manifest.manifestSha256, before.manifest.manifestSha256);
    const reused = await request('/api/clean-session', { body: { ...firstCleanBody, baseMutationEpoch: firstCleanBody.baseMutationEpoch + 1 } }); assert.equal(reused.status, 409);
    const stale = await request('/api/clean-session', { body: { ...firstCleanBody, operationId: randomUUID() } }); assert.equal(stale.status, 409);
    assert.equal((await snapshot(dirty.id)).manifest.manifestSha256, before.manifest.manifestSha256);
  });
  await check('cleanup with no byte changes keeps version/history and stores a durable proof/receipt', async () => {
    const before = await session(cleanOld.id); const response = await request('/api/clean-session', { body: mutation(before) }); assert.equal(response.status, 200);
    verifiedProof(response.data.clean, response.data.workVersion, 'unchanged'); assert.equal(response.data.workVersion.id, before.workVersion.id);
    assert.equal(response.data.history.cursor, before.history.cursor); assert.equal(response.data.history.total, before.history.total);
    assert.equal((await snapshot(before.id)).snapshot.clean.status, 'unchanged');
  });
  await check('unsafe existing working bytes cannot create a cleaned state, receipt or version', async () => {
    const before = await session(unsafeOld.id); assert.equal(before.clean.status, 'legacy-unverified');
    const saved = await snapshot(before.id); const requestBody = mutation(before);
    const response = await request('/api/clean-session', { body: requestBody }); assert.equal(response.status, 422); assert.equal(response.data.clean.status, 'failed');
    const after = await snapshot(before.id); assert.equal(after.manifest.manifestSha256, saved.manifest.manifestSha256);
    assert.equal(after.snapshot.workVersion.id, before.workVersion.id); assert.equal(after.snapshot.mutationReceipts?.[requestBody.operationId], undefined);
    assert.deepEqual((await request(`/api/session-file?id=${before.id}`)).buffer, unsafe);
  });
  await check('real Windows state-file rename failure cannot publish cleanup and retry commits from the retained base', async () => {
    const before = await session(saveFailOld.id); const saved = await snapshot(before.id); const body = mutation(before);
    await lockState(join(ROOTS.sessions, before.id, 'state.json'));
    let response;
    try { response = await request('/api/clean-session', { body }); assert.equal(response.status, 500); }
    finally { await releaseLock(); }
    const after = await snapshot(before.id); assert.equal(after.manifest.manifestSha256, saved.manifest.manifestSha256);
    assert.equal(after.snapshot.workVersion.id, before.workVersion.id); assert.equal(after.snapshot.mutationReceipts?.[body.operationId], undefined);
    const opened = await session(before.id); assert.equal(opened.workVersion.id, before.workVersion.id); assert.equal(opened.clean.status, 'legacy-unverified');
    const retry = await request('/api/clean-session', { body }); assert.equal(retry.status, 200); verifiedProof(retry.data.clean, retry.data.workVersion, 'cleaned');
    assert.equal(retry.data.history.total, 1); assert.equal(retry.data.history.cursor, 1);
    return { failureStatus: response.status, retryStatus: retry.status };
  });
  await check('cleanup history undo reopens unverified bytes and redo restores the exact verified saved stream', async () => {
    let value = await session(dirty.id);
    const undo = await request('/api/undo-fixes', { body: mutation(value) }); assert.equal(undo.status, 200);
    assert.equal(undo.data.workVersion.id, dirty.workVersion.id); assert.equal(undo.data.clean.status, 'legacy-unverified');
    assert.equal((await request('/api/review', { body: { id: value.id, useModel: false, useContext: false, useCases: false, useRecheck: false } })).status, 409);
    assert.deepEqual((await request(`/api/session-file?id=${value.id}`)).buffer, raw);
    value = await session(dirty.id);
    const redo = await request('/api/redo-fixes', { body: mutation(value) }); assert.equal(redo.status, 200); verifiedProof(redo.data.clean, redo.data.workVersion);
    assert.equal(redo.data.workVersion.id, cleanedLegacy.workVersion.id); assert.deepEqual((await request(`/api/session-file?id=${value.id}`)).buffer, cleaned);
    assert.equal((await session(value.id)).result, null);
  });
  await check('restart restores verified proof/work bytes and keeps unsafe legacy review blocked without a model call', async () => {
    await stopApp('verify saved cleanup restart'); await startApp();
    const value = await session(dirty.id); verifiedProof(value.clean, value.workVersion);
    assert.equal(value.doc.stats.comments, 0); assert.equal(value.doc.originalCommentCount, ORIGINAL_COMMENT_COUNT); assert.equal(value.result, null); assert.equal(value.hasHistoricalResult, true);
    assert.deepEqual((await request(`/api/session-file?id=${dirty.id}`)).buffer, cleaned);
    const unsafeRestored = await session(unsafeOld.id); assert.equal(unsafeRestored.clean.status, 'legacy-unverified');
    assert.equal((await request('/api/review', { body: { id: unsafeRestored.id, useModel: false, useContext: false, useCases: false, useRecheck: false } })).status, 409);
    assert.equal(report.localProviderCalls, 0);
  });
  report.ok = true;
} catch (error) { report.ok = false; report.error = error.stack || String(error); process.exitCode = 1; }
finally {
  await releaseLock(); await stopApp('test cleanup');
  if (fake) await new Promise((done) => fake.close(done));
  report.modelCalls = report.localProviderCalls;
  await mkdir(dirname(OUT), { recursive: true }); await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Evidence: ${OUT}`);
}
