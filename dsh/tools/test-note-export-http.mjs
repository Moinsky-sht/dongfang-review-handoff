/** Owned HTTP export/receipt acceptance; explicit software review DTOs, no models. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';

const SCRIPT = fileURLToPath(import.meta.url); const PROJECT = resolve(dirname(SCRIPT), '..');
const inheritedEvidence = process.env.DSH_VERIFICATION_EVIDENCE_DIR;
const verificationRunId = process.env.DSH_VERIFICATION_RUN_ID || null;
const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const port = Number(flag('port') || 3390);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536 && ![3210, 3211, 3212].includes(port));
const BASE = `http://127.0.0.1:${port}`;
const within = (base, path) => { const rel = relative(resolve(base), resolve(path)); return !rel.startsWith('..') && !isAbsolute(rel); };
const pointer = JSON.parse(await readFile(join(PROJECT, 'tmp/endnote-current-run.json'), 'utf8'));
const currentRun = resolve(pointer.runDirectory); const verifyRoot = join(PROJECT, 'data/verify');
const projectRunRoot = join(PROJECT, 'data/optimization/runs');
const assignedRunEvidence = inheritedEvidence && resolve(inheritedEvidence) !== projectRunRoot
  && within(projectRunRoot, inheritedEvidence) ? resolve(inheritedEvidence) : null;
const evidenceRoot = resolve(flag('evidence-root') || inheritedEvidence || join(verifyRoot, 'note-export-http'));
assert.ok(within(verifyRoot, evidenceRoot) || within(currentRun, evidenceRoot)
  || assignedRunEvidence && within(assignedRunEvidence, evidenceRoot), 'evidence must stay in data/verify, the sample run, or an assigned project run');
async function guardEvidence(path) {
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    assert.ok(!existsSync(join(cursor, 'complete.json')), `sealed evidence ancestor: ${cursor}`);
    try {
      const info = await lstat(cursor); assert.ok(info.isDirectory() && !info.isSymbolicLink());
      assert.equal(resolve(await realpath(cursor)), cursor, 'evidence cannot traverse aliases');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(cursor) === cursor) break;
  }
}
await guardEvidence(evidenceRoot);
for (const key of Object.keys(process.env)) if (/^(?:DSH_|NODE_OPTIONS|NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/i.test(key)
  || /(?:ARK|OPENAI|DOUBAO|VOLC|ANTHROPIC)/i.test(key)) delete process.env[key];
await mkdir(evidenceRoot, { recursive: true });
const RUN = join(evidenceRoot, `note-export-http-${Date.now()}-${randomUUID()}`); await mkdir(RUN);
const ENV_ROOTS = { DSH_SESSION_ROOT: 'sessions', DSH_WORKING_VERSION_ROOT: 'versions', DSH_WORKSPACE_ROOT: 'workspaces',
  DSH_AUDIT_ROOT: 'audit', DSH_LEGACY_ROOT: 'legacy', DSH_INGESTION_ROOT: 'ingestions', DSH_JOB_ROOT: 'jobs' };
const ROOTS = Object.fromEntries(Object.entries(ENV_ROOTS).map(([key, leaf]) => { process.env[key] = join(RUN, leaf); return [leaf, process.env[key]]; }));
await Promise.all(Object.values(ROOTS).map((path) => mkdir(path)));
await mkdir(join(RUN, 'outputs')); await mkdir(join(RUN, 'responses'));
const sessionStore = await import('../src/session-store.js');
const { loadWorkingVersion } = await import('../src/working-version.js');
const { rememberCompletedReview, selectReviewForHistory } = await import('../src/fix-history.js');
const { parseDocxBuffer } = await import('../src/docx.js');
const { writeZip } = await import('../src/zip-write.js');
const { openZip } = await import('../src/zip.js');
const { parseXml } = await import('../src/xml.js');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SOURCE_FILES = ['server.mjs', 'src/docx-comments.js', 'src/docx.js', 'src/anchors.js', 'src/working-anchors.js', 'src/review-source.js',
  'src/fix-history.js', 'src/session-store.js', 'src/working-version.js', 'src/audit.js', 'src/review-server.js', 'src/review-runtime.js', 'src/job-store.js'];
const hashes = async () => Object.fromEntries(await Promise.all(SOURCE_FILES.map(async (path) => [path, sha(await readFile(join(PROJECT, path)))])));
const report = { generatedAt: new Date().toISOString(), verificationRunId, run: RUN, evidenceRoot, roots: ROOTS, rootCount: 7, base: BASE,
  realArkCalls: 0, paidModelCalls: 0, meaningfulModelResponses: 0, manuscriptContentJudgment: false,
  nativeWordApplicationVerified: false, softwareFixturesExplicit: true, sourceHashes: await hashes(), testSha256: sha(await readFile(SCRIPT)),
  checks: [], requests: [], processes: [], providerRequests: [], seededSoftwareReviews: [], cleanup: [] };
const FAKE_KEY = 'local-note-export-http-software-key';
const sockets = new Set(); let provider; let providerBase; let app = null; let requestSequence = 0;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(action, message, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await action(); if (result) return result; await sleep(60); }
  throw new Error(`Timed out: ${message}`);
}
async function request(path, { body, bytes, expected = 200, binary = false, evidence = false } = {}) {
  const started = Date.now(); const method = body !== undefined || bytes ? 'POST' : 'GET';
  const response = await fetch(BASE + path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : bytes ? { 'content-type': 'application/octet-stream' } : {},
    body: body !== undefined ? JSON.stringify(body) : bytes, signal: AbortSignal.timeout(45000) });
  const raw = Buffer.from(await response.arrayBuffer()); let data = null;
  if (!binary || response.status !== 200) { try { data = JSON.parse(raw.toString('utf8')); } catch { data = { raw: raw.toString('utf8').slice(0, 1000) }; } }
  const record = { sequence: ++requestSequence, path, method, status: response.status, elapsedMs: Date.now() - started,
    responseSha256: sha(raw), bytes: raw.length, error: response.status >= 400 ? data : null };
  report.requests.push(record);
  if (evidence && data) { record.evidence = join(RUN, 'responses', `${record.sequence}.json`); await writeFile(record.evidence, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' }); }
  assert.equal(response.status, expected, JSON.stringify(data));
  return { data, buffer: raw, headers: response.headers, status: response.status };
}
const json = async (path, opts) => (await request(path, opts)).data;
async function startProvider() {
  provider = httpServer((req, res) => {
    report.providerRequests.push({ method: req.method, path: req.url }); req.resume();
    res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'software test refuses model requests' }));
  });
  provider.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((done, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', done); });
  providerBase = `http://127.0.0.1:${provider.address().port}/api/v3`; report.providerBase = providerBase;
}
function appEnvironment() {
  return { ...process.env, HOST: '127.0.0.1', PORT: String(port), ARK_API_KEY: FAKE_KEY, ARK_BASE_URL: providerBase,
    ARK_MODEL: 'note-export-http-software-model', ARK_CONTEXT: '0', ARK_CASES: '0', ARK_CONSISTENCY: '0', ARK_PREFIX_CACHE: '0', DSH_REVIEW_WORKERS: '1' };
}
async function startApp() {
  const probe = netServer(); await new Promise((done, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', done); });
  await new Promise((done) => probe.close(done));
  const child = spawn(process.execPath, [join(PROJECT, 'server.mjs')], { cwd: PROJECT, env: appEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { pid: child.pid, port, startedAt: new Date().toISOString(), stoppedAt: null, stdout: '', stderr: '' };
  report.processes.push(record); app = { child, record };
  child.stdout.on('data', (data) => record.stdout += data); child.stderr.on('data', (data) => record.stderr += data);
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Owned server exited ${child.exitCode}: ${record.stderr}`);
    try { return (await request('/api/health')).data; } catch { return null; }
  }, 'owned server ready', 25000);
}
async function stopApp(reason) {
  if (!app) return; const owned = app; app = null;
  if (owned.child.exitCode === null && owned.child.signalCode === null) {
    const exited = new Promise((done) => owned.child.once('exit', done)); owned.child.kill('SIGKILL');
    let timer; try { await Promise.race([exited, new Promise((done, reject) => timer = setTimeout(() => reject(new Error('Owned server did not stop')), 7000))]); } finally { clearTimeout(timer); }
  }
  owned.record.stoppedAt = new Date().toISOString(); owned.record.stopReason = reason; owned.record.exitCode = owned.child.exitCode; owned.record.signalCode = owned.child.signalCode;
  report.cleanup.push({ pid: owned.child.pid, owned: true, stopped: owned.child.exitCode !== null || owned.child.signalCode !== null, reason });
}
async function check(name, action) {
  const started = Date.now(); try { const detail = await action(); report.checks.push({ name, ok: true, elapsedMs: Date.now() - started, detail }); }
  catch (error) { report.checks.push({ name, ok: false, elapsedMs: Date.now() - started, error: error.message, stack: error.stack?.split('\n').slice(0, 6) }); }
}
const keyOf = (it) => `${it.ruleId}|${it.location}|${it.quote || ''}`;
const rules = { useModel: false, useRecheck: false, useContext: false, useCases: false };
async function upload(buffer, name, workspace) {
  const uploaded = await json(`/api/upload?name=${encodeURIComponent(name)}&workspace=${workspace}`, { bytes: buffer });
  const accepted = await json('/api/review', { body: { id: uploaded.id, ...rules, async: true, operationId: randomUUID(), purpose: 'verification' }, expected: 202 });
  assert.equal(accepted.accepted, true);
  await until(async () => {
    const status = await json(`/api/review-status?id=${uploaded.id}&runId=${accepted.reviewRunId}`);
    return !status.running && !status.waiting && status.hasResult && status.status === 'completed' ? status : null;
  }, 'actual rules-only review completed');
  return uploaded;
}
async function seedSoftwareIssues(id, makeIssues) {
  const stored = await sessionStore.loadSessionSnapshot({ sessionId: id, storageRoot: ROOTS.sessions }); const snapshot = stored.snapshot;
  const version = await loadWorkingVersion({ sessionId: id, versionId: snapshot.workVersion.id, storageRoot: ROOTS.versions });
  const doc = parseDocxBuffer(version.buffer); const result = structuredClone(snapshot.result); const softwareRunId = `rsoftware${randomUUID().replace(/-/g, '')}`;
  assert.ok(result && result.issues); result.issues = makeIssues(doc); result.generatedAt = new Date().toISOString();
  result.meta = { ...result.meta, softwareFixture: true, purpose: 'verification', statement: 'Generated coordinate probes, not manuscript judgments' };
  const texts = { body: doc.paragraphs.map((p) => p.text), footnote: doc.footnotes.map((p) => p.text), endnote: doc.endnotes.map((p) => p.text) };
  Object.assign(snapshot, { result, resultRunId: softwareRunId, reviewRunId: softwareRunId, resultVersionId: snapshot.workVersion.id,
    reviewVersionId: snapshot.workVersion.id, resultTexts: texts, reviewTexts: texts, resultOptions: { ...rules, purpose: 'verification' },
    reviewRunning: false, reviewError: null, interrupted: false, cancelled: false, reviewProgress: { phase: 'done', done: 1, total: 1, message: '软件坐标夹具' } });
  rememberCompletedReview(snapshot); selectReviewForHistory(snapshot);
  const manifest = await sessionStore.saveSessionSnapshot({ sessionId: id, snapshot, expectedRevision: stored.manifest.revision, storageRoot: ROOTS.sessions });
  const view = await json(`/api/session?id=${id}`, { evidence: true });
  assert.equal(view.reviewRunId, softwareRunId); assert.equal(view.result.reviewRunId, softwareRunId); assert.equal(view.hasResult, true);
  assert.equal(view.workVersion.id, snapshot.workVersion.id); assert.equal(view.result.issues.length, result.issues.length);
  assert.equal(view.result.sourceBinding.verified, true, 'legacy text-only seed must recover from its actual immutable version');
  assert.equal(view.result.sourceBinding.sourcePackageSha256, sha(version.buffer));
  report.seededSoftwareReviews.push({ sessionId: id, softwareRunId, sessionRevision: manifest.revision, versionId: snapshot.workVersion.id,
    workingSha256: sha(version.buffer), sourceSha256: snapshot.workVersion.sourceSha256, issueCount: result.issues.length, purpose: 'verification' });
  return { id, runId: softwareRunId, view, workingBuffer: version.buffer, doc, issues: result.issues };
}
const makeProbe = (target, index, find, offset, ruleId = 'SOFTWARE-ONLY-NOTE-PROBE') => ({ ruleId, group: 'software', severity: '中', title: '软件范围探针',
  location: `${target}:${index}`, [`${target}Index`]: index, quote: find, autoFixable: false, autoFix: { find, replace: find, offset },
  message: '仅验证程序范围对应，不判断稿件内容' });
function assertNotesPreserved(before, after) {
  const a = openZip(before); const b = openZip(after);
  for (const name of a.names) if (!['word/document.xml', 'word/comments.xml', '[Content_Types].xml', 'word/_rels/document.xml.rels'].includes(name)) assert.deepEqual(b.read(name), a.read(name), `untargeted bytes changed: ${name}`);
  const oldDoc = parseDocxBuffer(before); const newDoc = parseDocxBuffer(after);
  for (const list of ['paragraphs', 'footnotes', 'endnotes']) assert.deepEqual(newDoc[list].map((p) => p.text), oldDoc[list].map((p) => p.text));
}
async function exportDocx(context, extra = {}, { purpose = 'verification' } = {}) {
  const body = { id: context.id, baseVersionId: context.view.workVersion.id, baseReviewRunId: context.runId, ...extra };
  if (purpose) body.provenance = { purpose };
  const response = await request('/api/export-docx', { body, binary: true });
  assert.match(response.headers.get('content-type'), /wordprocessingml/);
  const exportId = response.headers.get('x-export-id'); const receipt = await json(`/api/export-placement?id=${context.id}&exportId=${exportId}`, { evidence: true });
  assert.equal(receipt.exportId, exportId); assert.equal(receipt.sessionId, context.id); assert.equal(receipt.reviewRunId, context.runId);
  assert.equal(receipt.workVersion.id, context.view.workVersion.id); assert.equal(receipt.workVersion.sha256, sha(context.workingBuffer));
  assert.equal(receipt.sourceSha256, context.view.workVersion.sourceSha256); assert.equal(receipt.outputSha256, sha(response.buffer)); assert.equal(receipt.outputBytes, response.buffer.length);
  const headers = { 'x-comments-added': receipt.added, 'x-comments-skipped': receipt.skipped, 'x-comments-added-issues': receipt.addedIssues,
    'x-comments-note-sources': receipt.noteSources, 'x-export-placement-schema': 1, 'x-content-sha256': sha(response.buffer),
    'x-work-sha256': sha(context.workingBuffer), 'x-work-version': context.view.workVersion.id, 'x-review-run': context.runId };
  for (const [key, value] of Object.entries(headers)) assert.equal(response.headers.get(key), String(value), key);
  assert.equal(receipt.placementSchemaVersion, 1); assert.equal(receipt.added, receipt.placements.reduce((n, p) => n + p.targets.length, 0));
  assertNotesPreserved(context.workingBuffer, response.buffer);
  await writeFile(join(RUN, 'outputs', `${exportId}.docx`), response.buffer, { flag: 'wx' });
  return { receipt, buffer: response.buffer };
}
function fixture() {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const p = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const ref = (kind, id) => `<w:r><w:${kind}Reference w:id="${id}"/></w:r>`;
  return writeZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rFoot" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rEnd" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>正文同文</w:t></w:r>${ref('footnote', 7)}${ref('endnote', 7)}${ref('endnote', 9)}</w:p><w:sectPr/></w:body></w:document>` },
    { name: 'word/footnotes.xml', data: `<w:footnotes xmlns:w="${W}"><w:footnote w:id="7">${p('脚注同文')}</w:footnote></w:footnotes>` },
    { name: 'word/endnotes.xml', data: `<w:endnotes xmlns:w="${W}"><w:endnote w:id="7">${p('注内唯一文字')}</w:endnote><w:endnote w:id="9">${p('尾注同文')}</w:endnote><w:endnote w:id="17">${p('孤儿文字')}</w:endnote></w:endnotes>` },
    { name: 'custom/untargeted.bin', data: Buffer.from([0, 1, 2, 255]) },
  ]);
}
function bodyRangeFixture() {
  const base = openZip(fixture());
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const p = text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const table = '<w:tbl><w:tr><w:tc>' + p('SAME / SAME') + '</w:tc></w:tr></w:tbl>';
  const xml = `<w:document xmlns:w="${W}" xmlns:v="urn:schemas-microsoft-com:vml"><w:body><w:p><w:r><w:t>HOST</w:t><w:pict><v:shape id="software-box"><v:textbox><w:txbxContent>${p('SAME')}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>${p('                    SAME / SAME')}${table}<w:p><w:del><w:r><w:delText>foo</w:delText></w:r></w:del><w:r><w:t>foo</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;
  return writeZip(base.names.map(name => ({ name, data: name === 'word/document.xml' ? xml : base.read(name) })));
}
let realContext; let softwareContext; let selectedGroup; let changedContext;
try {
  await startProvider(); await startApp();
  await check('body source identities, occurrence-owned ranges and unsupported-view rejection survive genuine HTTP modification/export', async () => {
    const source = bodyRangeFixture(); const sourceSha256 = sha(source);
    const uploaded = await upload(source, '软件正文范围夹具.docx', 'wbodyrangecontract');
    const context = await seedSoftwareIssues(uploaded.id, () => [
      { ...makeProbe('paragraph', 1, 'SAME', 20, 'SOFTWARE-BODY-FIRST'), autoFix: { find: 'SAME', replace: 'FIRST', offset: 20 } },
      { ...makeProbe('paragraph', 2, 'SAME', 0, 'SOFTWARE-BODY-GROUP'), autoFix: { find: 'SAME', replace: 'GROUP', offset: 0 },
        occurrences: [{ paragraphIndex: 1, offset: 27 }, { paragraphIndex: 2, offset: 7 }] },
      { ...makeProbe('paragraph', 3, 'foo', 0, 'SOFTWARE-BEFORE'), textView: 'before', autoFix: { find: 'foo', replace: 'BAD', offset: 0 } },
      { ...makeProbe('paragraph', 1, 'SAME', 20, 'SOFTWARE-WRONG-NODE'), sourceXmlNodeId: 'document.xml:xml-p:1', autoFix: { find: 'SAME', replace: 'BAD', offset: 20 } },
      { ...makeProbe('paragraph', 2, 'SAME', undefined, 'SOFTWARE-AMBIGUOUS'), autoFix: { find: 'SAME', replace: 'BAD' } },
      { ...makeProbe('paragraph', 1, 'SAME', 20, 'SOFTWARE-WRONG-PACKAGE'), sourcePackageSha256: '0'.repeat(64), autoFix: { find: 'SAME', replace: 'BAD', offset: 20 } },
      { ...makeProbe('paragraph', 1, 'SAME', 20, 'SOFTWARE-WRONG-VERSION'), sourceVersionId: 'another-version', autoFix: { find: 'SAME', replace: 'BAD', offset: 20 } },
      { ...makeProbe('paragraph', 3, 'foo', 0, 'SOFTWARE-FIX-BEFORE-OWNER'), autoFix: { find: 'foo', replace: 'BAD', offset: 0, owner: 'before' } },
    ]);
    assert.equal(context.view.doc.paragraphs[1].sourceXmlParagraphOrdinal, 2);
    assert.equal(context.view.result.issues[0].anchor.sourceXmlNodeId, 'document.xml:xml-p:2');
    assert.equal(context.view.result.issues[0].anchor.sourceVersionId, context.view.workVersion.id);
    assert.equal(context.view.result.issues[4].anchor.resolutionStatus, 'ambiguous');
    const exported = await exportDocx(context, { accepted: [keyOf(context.issues[0]), keyOf(context.issues[1])] });
    assert.equal(exported.receipt.added, 3);
    assert(exported.receipt.placements.every(placement => placement.source.sourcePackageSha256 === sha(context.workingBuffer)));
    const applied = await json('/api/apply-fixes', { body: { id: context.id, accepted: context.issues.map(keyOf), operationId: randomUUID(),
      baseVersionId: context.view.workVersion.id, baseMutationEpoch: context.view.history.epoch, baseReviewRunId: context.runId, purpose: 'verification' } });
    assert.equal(applied.applied.length, 3);
    assert.deepEqual(new Set(applied.skipped.map(item => item.reasonCode)), new Set(['unsupported_source_contract', 'source_identity_mismatch', 'ambiguous_source_range']));
    const current = await json(`/api/session?id=${context.id}`, { evidence: true });
    assert.deepEqual(current.doc.paragraphs.map(node => node.text), ['HOST', '                    FIRST / GROUP', 'SAME / GROUP', 'foo']);
    const saved = await loadWorkingVersion({ sessionId: context.id, versionId: current.workVersion.id, storageRoot: ROOTS.versions });
    assert.equal(sha(saved.originalBuffer), sourceSha256);
    const physical = parseXml(openZip(saved.buffer).readText('word/document.xml')).descendants('w:p');
    assert.equal(physical[1].descendants('w:t').map(node => node.allText()).join(''), 'SAME', 'textbox must not be the body edit target');
    const firstAnchor = current.result.issues[0].anchor;
    assert.equal(firstAnchor.text, 'FIRST'); assert.equal(firstAnchor.sourcePackageSha256, current.workVersion.sha256);
    assert.equal(firstAnchor.sourceVersionId, current.workVersion.id); assert.equal(firstAnchor.sourceReviewedVersionId, context.view.workVersion.id);
    const restartedResult = current.result.sourceBinding;
    return { sourceSha256, sourceBinding: restartedResult, applied, exportReceipt: exported.receipt, originalPreserved: true,
      exactBodyAndTableEdits: true, textboxPreserved: true, businessQualityJudged: false };
  });
  await check('a structurally plausible corrupt source sidecar remains unmapped after saved-byte verification and cannot modify/export a guessed target', async () => {
    const uploaded = await upload(bodyRangeFixture(), '软件来源损坏夹具.docx', 'wsourcecorruption');
    const context = await seedSoftwareIssues(uploaded.id, () => [{ ...makeProbe('paragraph', 1, 'SAME', 20, 'SOFTWARE-SOURCE-CORRUPT'),
      autoFix: { find: 'SAME', replace: 'BAD', offset: 20 } }]);
    const stored = await sessionStore.loadSessionSnapshot({ sessionId: context.id, storageRoot: ROOTS.sessions });
    const snapshot = stored.snapshot; const texts = structuredClone(snapshot.resultTexts);
    texts.sourceNodes.body[1].sourceXmlParagraphOrdinal = 1; texts.sourceNodes.body[1].sourceXmlNodeId = 'document.xml:xml-p:1';
    snapshot.resultTexts = texts;
    for (const record of snapshot.reviewRecords) if (record.id === context.runId) record.texts = texts;
    await sessionStore.saveSessionSnapshot({ sessionId: context.id, snapshot, expectedRevision: stored.manifest.revision, storageRoot: ROOTS.sessions });
    const view = await json(`/api/session?id=${context.id}`, { evidence: true });
    assert.equal(view.result.sourceBinding.verified, false); assert.equal(view.result.sourceBinding.reason, 'review_source_saved_node_mismatch');
    assert.equal(view.result.issues[0].needsRelocation, true); assert.deepEqual(view.result.issues[0].anchors, []);
    const applied = await json('/api/apply-fixes', { body: { id: context.id, accepted: context.issues.map(keyOf), operationId: randomUUID(),
      baseVersionId: view.workVersion.id, baseMutationEpoch: view.history.epoch, baseReviewRunId: context.runId, purpose: 'verification' } });
    assert.equal(applied.applied.length, 0); assert.equal(applied.skipped[0].reasonCode, 'review_source_saved_node_mismatch');
    assert.equal(applied.workVersion.id, view.workVersion.id);
    const exported = await exportDocx({ ...context, view }, { accepted: context.issues.map(keyOf) });
    assert.equal(exported.receipt.added, 0); assert.equal(exported.receipt.skipped, 1); assert.equal(exported.receipt.skippedDetails[0].reasonCode, 'needs_relocation');
    return { sourceBinding: view.result.sourceBinding, applied, exportReceipt: exported.receipt, workingBytesPreserved: exported.buffer.equals(context.workingBuffer) };
  });
  await check('real 43 note coordinate probes export unchanged notes with durable range/reference receipts', async () => {
    const meta = JSON.parse(await readFile(join(currentRun, 'run.json'), 'utf8')); const source = await readFile(meta.realSample.path);
    assert.equal(sha(source), meta.realSample.sha256);
    const uploaded = await upload(source, '真实43尾注软件坐标夹具.docx', 'wnotehttpreal');
    realContext = await seedSoftwareIssues(uploaded.id, (doc) => doc.endnotes.map((p, index) => ({ p, index })).filter(({ p }) => !p.isNoteSeparator)
      .map(({ p, index }) => makeProbe('endnote', index, p.text.slice(2, 3), 2, 'SOFTWARE-ONLY-43-ENDNOTE')));
    for (const list of ['paragraphs', 'footnotes', 'endnotes']) {
      const expected = realContext.doc[list].map((p) => ({ id: p.id, part: p.part, index: p.index, noteId: p.noteId, noteType: p.noteType, inTable: p.inTable, tableIdx: p.tableIdx ?? null }));
      const actual = realContext.view.doc[list].map((p) => ({ id: p.id, part: p.part, index: p.index, noteId: p.noteId, noteType: p.noteType, inTable: p.inTable, tableIdx: p.tableIdx ?? null }));
      assert.deepEqual(actual, expected, `GET session ${list} identities match current DOCX parser`);
    }
    const exported = await exportDocx(realContext, { accepted: realContext.issues.map(keyOf) });
    assert.equal(exported.receipt.requestedIssues, 43); assert.equal(exported.receipt.added, 43); assert.equal(exported.receipt.addedIssues, 43); assert.equal(exported.receipt.skipped, 0);
    assert.equal(exported.receipt.noteSources, 43); assert.equal(exported.receipt.selection, 'selected');
    for (const placement of exported.receipt.placements) { assert.equal(placement.precision, 'reference-target'); assert.equal(placement.source.start, 2); assert.equal(placement.source.end, 3); }
    assert.equal(sha(await readFile(meta.realSample.path)), meta.realSample.sha256);
    return { exportId: exported.receipt.exportId, sourceSha256: meta.realSample.sha256, receipt: exported.receipt };
  });
  await check('default export and accepted grouped body/foot/end sources use all current mapped anchors', async () => {
    const uploaded = await upload(fixture(), 'synthetic-cross-part-notes.docx', 'wnotehttpfixture');
    softwareContext = await seedSoftwareIssues(uploaded.id, () => {
      const grouped = { ...makeProbe('paragraph', 0, '同文', 2, 'SOFTWARE-ONLY-GROUP'), occurrences: [
        { location: 'paragraph:0', paragraphIndex: 0, autoFix: { find: '同文', offset: 2, replace: '同文' } },
        { location: 'footnote:0', footnoteIndex: 0, autoFix: { find: '同文', offset: 2, replace: '同文' } },
        { location: 'endnote:1', endnoteIndex: 1, autoFix: { find: '同文', offset: 2, replace: '同文' } },
      ] };
      const fix = makeProbe('endnote', 0, '唯一', 2, 'SOFTWARE-ONLY-FIX'); fix.autoFixable = true; fix.autoFix.replace = '〔已改〕';
      return [grouped, fix, makeProbe('endnote', 0, '一文字', 3, 'SOFTWARE-ONLY-OVERLAP'), makeProbe('endnote', 2, '文字', 2, 'SOFTWARE-ONLY-ORPHAN')];
    });
    const all = await exportDocx(softwareContext, {}, { purpose: null });
    assert.equal(all.receipt.selection, 'all'); assert.equal(all.receipt.requestedIssues, 4); assert.equal(all.receipt.added, 5); assert.equal(all.receipt.addedIssues, 3); assert.equal(all.receipt.skipped, 1);
    assert.equal(all.receipt.skippedDetails[0].reasonCode, 'orphan_note');
    const grouped = softwareContext.issues[0]; selectedGroup = await exportDocx(softwareContext, { accepted: [keyOf(grouped)] });
    const receipt = selectedGroup.receipt;
    assert.equal(receipt.requestedIssues, 1); assert.equal(receipt.added, 3); assert.equal(receipt.addedIssues, 1); assert.equal(receipt.skipped, 0); assert.equal(receipt.noteSources, 2);
    assert.deepEqual(receipt.placements.map((p) => p.source.target), ['paragraph', 'footnote', 'endnote']);
    assert.deepEqual(receipt.placements.map((p) => p.source.noteId), [null, '7', '9']);
    assert.deepEqual(receipt.selectedIssueKeys, [keyOf(grouped)]);
    const xml = parseXml(openZip(selectedGroup.buffer).readText('word/document.xml'));
    assert.equal(xml.descendants('w:commentRangeStart').length, 3); assert.equal(xml.descendants('w:commentRangeEnd').length, 3); assert.equal(xml.descendants('w:commentReference').length, 3);
    const empty = await exportDocx(softwareContext, { accepted: [] }); assert.equal(empty.receipt.added, 0); assert.equal(empty.receipt.requestedIssues, 0); assert.deepEqual(empty.buffer, softwareContext.workingBuffer);
    return { defaultReceipt: all.receipt, selectedReceipt: receipt, emptyReceipt: empty.receipt };
  });
  await check('receipt identities reject malformed, absent and wrong-session lookups', async () => {
    assert.ok(softwareContext && selectedGroup && realContext);
    await request(`/api/export-placement?id=${softwareContext.id}&exportId=invalid`, { expected: 400 });
    await request(`/api/export-placement?id=${softwareContext.id}&exportId=${randomUUID()}`, { expected: 404 });
    await request(`/api/export-placement?id=${realContext.id}&exportId=${selectedGroup.receipt.exportId}`, { expected: 404 });
    await request(`/api/export-placement?id=sdoesnotexist&exportId=${selectedGroup.receipt.exportId}`, { expected: 404 });
    return { exportId: selectedGroup.receipt.exportId, ownerSession: softwareContext.id };
  });
  await check('browser top-level verification purpose and run identity persist on the genuine export audit receipt', async () => {
    const browserVerificationRunId = verificationRunId || pointer.runId;
    const requestShape = { purpose: 'verification', verificationRunId: browserVerificationRunId, accepted: [keyOf(softwareContext.issues[0])] };
    // The actual browser sends purpose at the top level, without provenance.
    // Keep the preceding nested-provenance requests as legacy-contract proof.
    const exported = await exportDocx(softwareContext, requestShape, { purpose: null });
    const audit = await json(`/api/audit?id=${softwareContext.id}&kind=export`, { evidence: true });
    const entry = audit.entries.find((item) => item.attributes?.receipt?.exportId === exported.receipt.exportId);
    assert.ok(entry, 'the exact genuine receipt is retained in the full audit trail');
    assert.equal(entry.provenance.origin, 'server-export'); assert.equal(entry.provenance.purpose, 'verification');
    assert.equal(entry.provenance.verificationRunId, browserVerificationRunId);
    assert.deepEqual(entry.attributes.receipt, exported.receipt);
    assert.equal(exported.receipt.added, 3); assert.equal(exported.receipt.addedIssues, 1);
    return { requestShape, nestedProvenanceSent: false, receipt: exported.receipt, audit: entry };
  });
  await check('export audit purpose stays explicit and verification receipts remain visible but excluded from summary', async () => {
    const log = await json(`/api/audit?id=${softwareContext.id}&kind=export`, { evidence: true }); const summary = await json('/api/audit-summary', { evidence: true });
    assert.equal(log.entries.length, 4); assert.equal(log.entries.filter((entry) => entry.provenance.purpose === 'editorial').length, 1);
    assert.equal(log.entries.filter((entry) => entry.provenance.purpose === 'verification').length, 3);
    const nestedReceipt = log.entries.find((entry) => entry.attributes?.receipt?.exportId === selectedGroup.receipt.exportId);
    assert.equal(nestedReceipt?.provenance.purpose, 'verification', 'legacy nested provenance remains honored');
    assert.ok(log.entries.every((entry) => entry.provenance.origin === 'server-export' && entry.humanAction === 'export-commented-docx' && entry.attributes.receipt.exportId));
    const localLog = (await readFile(join(ROOTS.audit, 'audit-log.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(summary.loggedTotal, localLog.length); assert.equal(summary.excludedVerification, localLog.filter((entry) => entry.provenance?.purpose === 'verification').length);
    assert.equal(summary.total, localLog.filter((entry) => entry.provenance?.purpose !== 'verification').length);
    return { entries: log.entries, summary };
  });
  await check('client audit entries cannot forge or replace a genuine server export receipt', async () => {
    const forgedId = randomUUID(); const entries = [
      { kind: 'export', humanAction: 'export-commented-docx', attributes: { receipt: { exportId: forgedId, sessionId: softwareContext.id, added: 999 } }, provenance: { origin: 'server-export', purpose: 'verification' } },
      { kind: 'export', humanAction: 'export-commented-docx', attributes: { receipt: { ...selectedGroup.receipt, added: 999 } }, provenance: { origin: 'server-export', purpose: 'verification' } },
    ];
    const posted = await json('/api/audit', { body: { id: softwareContext.id, entries }, evidence: true });
    assert.equal(posted.recorded, 2); assert.ok(posted.entries.every((entry) => entry.provenance.origin === 'client-audit' && entry.provenance.purpose === 'verification'));
    await request(`/api/export-placement?id=${softwareContext.id}&exportId=${forgedId}`, { expected: 404, evidence: true });
    const genuine = await json(`/api/export-placement?id=${softwareContext.id}&exportId=${selectedGroup.receipt.exportId}`, { evidence: true });
    assert.deepEqual(genuine, selectedGroup.receipt);
    const full = await json(`/api/audit?id=${softwareContext.id}&kind=export`);
    assert.ok(full.entries.some((entry) => entry.provenance.origin === 'client-audit' && entry.attributes.receipt.exportId === forgedId));
    return { forgedId, genuineId: genuine.exportId, posted: posted.entries, genuine };
  });
  await check('durable receipts survive owned server restart without rerunning review or changing identity', async () => {
    assert.ok(selectedGroup); const id = selectedGroup.receipt.exportId; const before = report.providerRequests.length;
    await stopApp('receipt restart test'); await startApp();
    const restored = await json(`/api/export-placement?id=${softwareContext.id}&exportId=${id}`, { evidence: true });
    assert.deepEqual(restored, selectedGroup.receipt); assert.equal(report.providerRequests.length, before);
    const view = await json(`/api/session?id=${softwareContext.id}`, { evidence: true });
    assert.equal(view.reviewRunId, softwareContext.runId); assert.equal(view.result.reviewRunId, softwareContext.runId); assert.equal(view.workVersion.id, softwareContext.view.workVersion.id);
    return { restored };
  });
  await check('current mapped fixes export changed source text while overlapping invalidated ranges are skipped', async () => {
    const before = softwareContext.view; const fix = softwareContext.issues.find((it) => it.ruleId === 'SOFTWARE-ONLY-FIX');
    const applied = await json('/api/apply-fixes', { body: { id: softwareContext.id, accepted: [keyOf(fix)], operationId: randomUUID(), baseVersionId: before.workVersion.id,
      baseMutationEpoch: before.history.epoch, baseReviewRunId: softwareContext.runId, provenance: { purpose: 'verification' } }, evidence: true });
    assert.equal(applied.applied.length, 1); assert.notEqual(applied.workVersion.id, before.workVersion.id);
    const view = await json(`/api/session?id=${softwareContext.id}`, { evidence: true });
    const working = await request(`/api/export-working-docx?id=${softwareContext.id}`, { binary: true });
    assert.equal(sha(working.buffer), view.workVersion.sha256); assert.equal(view.reviewRunId, softwareContext.runId);
    changedContext = { ...softwareContext, view, workingBuffer: working.buffer };
    const fresh = await exportDocx(changedContext, { accepted: [keyOf(fix)] });
    assert.equal(fresh.receipt.added, 1); assert.equal(fresh.receipt.placements[0].source.text, '〔已改〕'); assert.equal(fresh.receipt.placements[0].source.workVersionId, view.workVersion.id);
    assert.equal(fresh.receipt.resultVersionId, before.workVersion.id);
    const overlap = softwareContext.issues.find((it) => it.ruleId === 'SOFTWARE-ONLY-OVERLAP');
    const mapped = view.result.issues.find((it) => keyOf(it) === keyOf(overlap)); assert.equal(mapped.needsRelocation, true); assert.deepEqual(mapped.anchors, []);
    const skipped = await exportDocx(changedContext, { accepted: [keyOf(overlap)] });
    assert.equal(skipped.receipt.added, 0); assert.equal(skipped.receipt.skipped, 1); assert.equal(skipped.receipt.skippedDetails[0].reasonCode, 'needs_relocation'); assert.deepEqual(skipped.buffer, working.buffer);
    return { apply: applied, fresh: fresh.receipt, skipped: skipped.receipt };
  });
  await check('stale version/run guards return 409 before writing any export record', async () => {
    assert.ok(changedContext); const before = await json(`/api/audit?id=${softwareContext.id}&kind=export`);
    for (const extra of [{ baseVersionId: softwareContext.view.workVersion.id }, { baseReviewRunId: `rwrong${randomUUID().replace(/-/g, '')}` }, { baseReviewRunId: null }]) {
      const error = await json('/api/export-docx', { body: { id: changedContext.id, baseVersionId: changedContext.view.workVersion.id, baseReviewRunId: changedContext.runId, ...extra }, expected: 409, evidence: true });
      assert.equal(error.code, 'EXPORT_CONTEXT_STALE');
    }
    const after = await json(`/api/audit?id=${softwareContext.id}&kind=export`); assert.equal(after.entries.length, before.entries.length);
    return { countBefore: before.entries.length, countAfter: after.entries.length };
  });
  assert.equal(report.providerRequests.length, 0, 'rules/fixture export must not call even the owned refusing provider');
} catch (error) { report.failure = error.stack; }
finally {
  await stopApp('test cleanup').catch((error) => report.cleanupError = error.stack);
  for (const socket of sockets) socket.destroy(); if (provider) await new Promise((done) => provider.close(done));
  report.finishedAt = new Date().toISOString(); report.finalSourceHashes = await hashes(); report.sourceChanged = JSON.stringify(report.sourceHashes) !== JSON.stringify(report.finalSourceHashes);
  report.finalTestSha256 = sha(await readFile(SCRIPT)); report.testChanged = report.testSha256 !== report.finalTestSha256;
  report.expectedCheckCount = 11;
  report.ok = !report.failure && !report.cleanupError && report.checks.length === report.expectedCheckCount && report.checks.every((check) => check.ok) && !report.sourceChanged && !report.testChanged && report.providerRequests.length === 0 && report.cleanup.every((item) => item.stopped);
  await guardEvidence(RUN); await writeFile(join(RUN, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  for (const record of report.processes) await writeFile(join(RUN, `app-${record.pid}.log`), record.stdout + '\nSTDERR\n' + record.stderr, { flag: 'wx' });
  console.log(JSON.stringify({ report: join(RUN, 'report.json'), passed: report.checks.filter((check) => check.ok).length, failed: report.checks.filter((check) => !check.ok).length,
    ok: report.ok, sourceChanged: report.sourceChanged, realArkCalls: 0, providerRequests: report.providerRequests.length }));
  process.exitCode = report.ok ? 0 : 1;
}
