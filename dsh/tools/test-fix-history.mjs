/** HTTP history acceptance, including a real server-process restart. No model API.
 * --capture-old --base=http://127.0.0.1:3211 --out=tmp/p0-02-old-history-repro.json
 * --spawn-server --port=3292 --out=data/verify/fix-history.json
 * BASE_URL/--base selects an already-running server; only --spawn-server may kill
 * a process, and then only the child process created by this controller.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeZip } from '../src/zip-write.js';
import { parseDocxBuffer } from '../src/docx.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const OLD = args.includes('--capture-old');
const CONTROL = args.includes('--spawn-server');
const PORT = Number(flag('port', 3292));
const BASE = flag('base', CONTROL ? `http://127.0.0.1:${PORT}` : process.env.BASE_URL || process.env.BASE || 'http://127.0.0.1:3212').replace(/\/$/, '');
const OUT = resolve(ROOT, flag('out', OLD ? 'tmp/p0-02-old-history-repro.json' : 'data/verify/fix-history.json'));
const STORAGE = resolve(dirname(OUT), `history-controller-storage-${randomUUID()}`);
const ROOTS = Object.fromEntries(['sessions', 'versions', 'workspaces', 'audit', 'legacy', 'ingestion', 'jobs'].map((kind) => [kind, resolve(STORAGE, kind)]));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyOf = (x) => `${x.ruleId}|${x.location}|${x.quote || ''}`;
const vector = (doc) => Object.fromEntries(['paragraphs', 'footnotes', 'endnotes'].map((key) => [key, (doc?.[key] || []).map((p) => p.text || '')]));
const report = { generatedAt: new Date().toISOString(), base: BASE, mode: OLD ? 'old-endpoint-reproduction' : 'history-acceptance', modelCalls: 0, controllerOnlyUsesRules: true, storage: CONTROL ? STORAGE : null, roots: CONTROL ? ROOTS : null, checks: [], steps: [], processes: [] };
const check = (ok, name, extra = {}) => { report.checks.push({ name, ok: !!ok, ...extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
let child = null;
async function request(path, body, bytes) {
  const r = await fetch(BASE + path, {
    method: body || bytes ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : bytes ? { 'content-type': 'application/octet-stream' } : {},
    body: body ? JSON.stringify(body) : bytes,
    signal: AbortSignal.timeout(120000),
  });
  const buffer = Buffer.from(await r.arrayBuffer());
  let data = null;
  if (/json/i.test(r.headers.get('content-type') || '')) { try { data = JSON.parse(buffer.toString('utf8')); } catch { /* Check status separately. */ } }
  return { ok: r.ok, status: r.status, buffer, data, headers: Object.fromEntries(r.headers) };
}
function sample() {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const text = '软件验收甲...软件验收乙、即第二项。软件验收丙...软件验收丁,结束。';
  return writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<?xml version="1.0"?><w:document xmlns:w="${w}"><w:body><w:p><w:r><w:t>软件历史验收</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>` },
  ]);
}
async function startServer() {
  if (!CONTROL) return;
  try { const running = await request('/api/health'); if (running.ok) throw new Error(`Controller refuses to replace an existing service on ${BASE}`); }
  catch (error) { if (error.message.startsWith('Controller refuses')) throw error; }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:ARK|OPENAI|DOUBAO|VOLC)/i.test(key) && !/^(?:NODE_OPTIONS|NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key) && !/^DSH_/i.test(key)));
  Object.assign(env, { PORT: String(PORT), HOST: '127.0.0.1', DSH_WORKING_VERSION_ROOT: ROOTS.versions, DSH_SESSION_ROOT: ROOTS.sessions,
    DSH_WORKSPACE_ROOT: ROOTS.workspaces, DSH_AUDIT_ROOT: ROOTS.audit, DSH_LEGACY_ROOT: ROOTS.legacy, DSH_INGESTION_ROOT: ROOTS.ingestion,
    DSH_JOB_ROOT: ROOTS.jobs, DSH_REVIEW_WORKERS: '2' });
  child = spawn(process.execPath, [resolve(ROOT, 'server.mjs')], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  report.processes.push({ event: 'start', pid: child.pid, at: new Date().toISOString() });
  let launchError = null;
  child.once('error', (error) => { launchError = error; });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Controller child exited: ${child.exitCode}`);
    try { if ((await request('/api/health')).ok) return; } catch { /* Wait for child readiness. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Controller child did not become ready');
}
async function stopServer() {
  if (!child) return;
  const owned = child; child = null;
  const exited = new Promise((done) => owned.once('exit', done));
  owned.kill();
  await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))]);
  report.processes.push({ event: 'stop', pid: owned.pid, at: new Date().toISOString(), exitCode: owned.exitCode });
}
async function state(id, label) {
  const session = await request(`/api/session?id=${id}`);
  const file = await request(`/api/session-file?id=${id}`);
  const value = { session: session.data, buffer: file.buffer, sha256: hash(file.buffer), text: file.ok && !file.data ? vector(parseDocxBuffer(file.buffer, label)) : null };
  report.steps.push({ label, status: session.status, workVersion: session.data?.workVersion ?? null, history: session.data?.history ?? null, workingSha256: value.sha256, text: value.text, appliedFixes: session.data?.appliedFixes ?? [] });
  check(session.ok && session.data?.exists && file.ok, `${label}: session and working DOCX exist`);
  check(equal(vector(session.data?.doc), value.text), `${label}: session structure agrees with real bytes`);
  return value;
}
async function action(route, current, operationId = randomUUID()) {
  const body = { id: current.session.id, baseVersionId: current.session.workVersion.id, baseMutationEpoch: current.session.history?.epoch, operationId };
  const response = await request(route, body);
  report.steps.push({ label: route, status: response.status, operationId, baseVersionId: body.baseVersionId, baseMutationEpoch: body.baseMutationEpoch, replayed: response.data?.replayed ?? false, history: response.data?.history ?? null });
  return { response, body };
}
async function apply(id, current, accepted, label) {
  const response = await request('/api/apply-fixes', { id, accepted, baseVersionId: current.session.workVersion.id, baseMutationEpoch: current.session.history?.epoch, baseReviewRunId: current.session.reviewRunId, operationId: randomUUID() });
  check(response.ok && response.data?.applied?.length > 0, label, { status: response.status, applied: response.data?.applied?.length ?? 0, skipped: response.data?.skipped || [] });
  return state(id, label);
}
try {
  await startServer();
  const source = OLD ? readFileSync(resolve(ROOT, 'samples/test.docx')) : sample();
  report.sourceSha256 = hash(source);
  report.testSha256 = hash(readFileSync(fileURLToPath(import.meta.url)));
  report.writerSha256 = hash(readFileSync(resolve(ROOT, 'src/docx-patches.js')));
  report.storageModuleSha256 = hash(readFileSync(resolve(ROOT, 'src/working-version.js')));
  report.serverSha256 = hash(readFileSync(resolve(ROOT, 'server.mjs')));
  report.reviewModulesSha256 = Object.fromEntries(['src/review-server.js', 'src/review-runtime.js', 'src/job-store.js'].map((name) => [name, hash(readFileSync(resolve(ROOT, name)))]));
  const upload = await request('/api/upload?name=history-software-fixture.docx', null, source);
  check(upload.ok && !!upload.data?.id, 'upload software fixture');
  if (!upload.data?.id) throw new Error('Upload did not provide a session');
  const id = upload.data.id;
  report.sessionId = id;
  const reviewed = await request('/api/review', { id, useModel: false });
  check(reviewed.ok && Array.isArray(reviewed.data?.issues), 'review uses deterministic rules only');
  if (OLD) {
    for (const route of ['/api/undo-fixes', '/api/redo-fixes']) {
      const missing = await request(route, { id, baseVersionId: upload.data?.workVersion?.id, operationId: randomUUID() });
      report.steps.push({ route, status: missing.status, response: missing.data });
      check(missing.status === 404, `${route}: old service has no route`, { observed: missing.status });
    }
  } else {
    const v0 = await state(id, 'imported');
    check(v0.session.history?.canUndo === false && v0.session.history?.canRedo === false, 'initial history has no undo/redo');
    const ellipses = (v0.session.result?.issues || reviewed.data.issues).filter((x) => x.ruleId === 'FMT-019' && x.autoFix?.find);
    check(ellipses.length === 2 && ellipses.every((x) => x.paragraphIndex === ellipses[0].paragraphIndex), 'fixture has two patches in the same paragraph');
    if (ellipses.length !== 2) throw new Error('Fixture requires two FMT-019 changes');
    const v1 = await apply(id, v0, ellipses.map(keyOf), 'apply first group: both ellipses');
    check(v1.text.paragraphs[1] === '软件验收甲……软件验收乙、即第二项。软件验收丙……软件验收丁,结束。', 'first group applies both exact text ranges');
    const second = v1.session.result?.issues?.find((x) => x.ruleId === 'FMT-015' && x.autoFix?.find && !x.resolved);
    check(!!second, 'next group retains a valid issue after earlier offsets shift');
    if (!second) throw new Error('Fixture has no rebased FMT-015 issue');
    const v2 = await apply(id, v1, [keyOf(second)], 'apply second group in the same paragraph');
    check(v2.text.paragraphs[1] === '软件验收甲……软件验收乙即第二项。软件验收丙……软件验收丁,结束。', 'second group uses updated offsets without losing the first group');
    const undo = await action('/api/undo-fixes', v2);
    check(undo.response.ok, 'undo latest group');
    const undo1 = await state(id, 'undo-group-two');
    check(undo1.sha256 === v1.sha256, 'undo restores exact previous DOCX bytes');
    check(undo1.session.history?.canRedo === true, 'undo exposes redo');
    const duplicateUndo = await request('/api/undo-fixes', undo.body);
    const afterDuplicate = await state(id, 'replayed-undo');
    check(duplicateUndo.ok && duplicateUndo.data?.replayed === true && afterDuplicate.sha256 === undo1.sha256, 'repeated operationId replays current state without another undo');
    const stale = await request('/api/undo-fixes', { id, baseVersionId: v2.session.workVersion.id, operationId: randomUUID() });
    check(stale.status === 409, 'new operation with stale version is rejected', { status: stale.status });
    const undoAgain = await action('/api/undo-fixes', undo1);
    check(undoAgain.response.ok, 'undo the first group');
    const undone = await state(id, 'undo-to-import');
    check(undone.sha256 === v0.sha256, 'undo all groups restores the imported working bytes exactly');
    check(undone.session.history?.canUndo === false, 'undo history stops at import');
    const aba = await request('/api/redo-fixes', { id, baseVersionId: v0.session.workVersion.id, baseMutationEpoch: v0.session.history.epoch, operationId: randomUUID() });
    const afterAba = await state(id, 'rejected-aba-request');
    check(aba.status === 409 && afterAba.sha256 === undone.sha256 && afterAba.session.history?.epoch === undone.session.history?.epoch, 'old epoch cannot mutate a version reached again by undo', { status: aba.status });
    const redo1 = await action('/api/redo-fixes', undone);
    check(redo1.response.ok, 'redo first group');
    const redone1 = await state(id, 'redo-group-one');
    check(redone1.sha256 === v1.sha256, 'redo first group recovers exact hash');
    const redo2 = await action('/api/redo-fixes', redone1);
    check(redo2.response.ok, 'redo second group');
    const redone2 = await state(id, 'redo-group-two');
    check(redone2.sha256 === v2.sha256 && redone2.session.history?.canRedo === false, 'redo final group recovers exact hash and ends redo');
    const newReview = await request('/api/review', { id, useModel: false });
    check(newReview.ok && !newReview.data?.issues?.some((x) => x.ruleId === 'FMT-015'), 'review of the fully fixed version has no old deleted punctuation issue');
    const reviewedCurrent = await state(id, 'new-review-on-fixed-version');
    await action('/api/undo-fixes', reviewedCurrent);
    const branchBase = await state(id, 'branch-base');
    const restoredEarlierIssue = branchBase.session.result?.issues?.find((x) => x.ruleId === 'FMT-015' && x.autoFix?.find && !x.resolved);
    const expectedEarlierOffset = branchBase.text.paragraphs[1].indexOf('、即');
    check(!!restoredEarlierIssue && restoredEarlierIssue.anchor?.target === 'paragraph' && restoredEarlierIssue.anchor.index === 1 && restoredEarlierIssue.anchor.start === expectedEarlierOffset && restoredEarlierIssue.anchor.text === '、' && !restoredEarlierIssue.needsRelocation, 'undo restores the earlier review context and exact earlier punctuation range', { sourceAutoFix: restoredEarlierIssue?.autoFix ?? null, currentAnchor: restoredEarlierIssue?.anchor ?? null, expectedCurrentOffset: expectedEarlierOffset });
    const branchIssue = branchBase.session.result?.issues?.find((x) => x.ruleId === 'FMT-014' && x.autoFix?.find && !x.resolved);
    check(!!branchIssue, 'fixture provides a distinct branch modification');
    if (!branchIssue) throw new Error('Fixture has no branch change');
    const branch = await apply(id, branchBase, [keyOf(branchIssue)], 'new modification after undo');
    check(branch.sha256 !== v2.sha256 && branch.session.history?.canRedo === false, 'branch clears abandoned redo and preserves its own working bytes');
    check(branch.text.paragraphs[1] === '软件验收甲……软件验收乙、即第二项。软件验收丙……软件验收丁，结束。', 'branch changes only the selected punctuation');
    const unavailableRedo = await action('/api/redo-fixes', branch);
    const stableBranch = await state(id, 'redo-after-branch');
    check(stableBranch.sha256 === branch.sha256 && stableBranch.session.history?.canRedo === false, 'unavailable redo never restores the abandoned branch', { status: unavailableRedo.response.status });
    const lateReplay = await request('/api/undo-fixes', undo.body);
    const afterLateReplay = await state(id, 'late-operation-replay');
    check(lateReplay.ok && lateReplay.data?.replayed === true && afterLateReplay.sha256 === branch.sha256, 'an older operation receipt returns current branch state');
    const status = await request(`/api/review-status?id=${id}`);
    check(status.ok && equal(status.data?.history, branch.session.history), 'review-status exposes the same history as session', { status: status.status, observedHistory: status.data?.history ?? null });
    const workingExport = await request(`/api/export-working-docx?id=${id}`);
    check(workingExport.ok && hash(workingExport.buffer) === branch.sha256, 'working export uses exact branch bytes');
    const commented = await request('/api/export-docx', { id });
    check(commented.ok && equal(vector(parseDocxBuffer(commented.buffer, 'history-comments.docx')), branch.text), 'commented export reopens with current branch text');
    const original = await request(`/api/session-file?id=${id}&original=1`);
    check(original.ok && hash(original.buffer) === hash(source), 'original upload bytes remain unchanged through history operations');
    if (CONTROL) {
      for (let n = 0; n < 41; n++) {
        const extra = await request(`/api/upload?name=eviction-software-${n}.docx`, null, source);
        if (!extra.ok || !extra.data?.id) throw new Error(`Eviction probe upload ${n} failed`);
      }
      const health = await request('/api/health');
      check(health.ok && health.data?.sessions <= 40, 'fixture uploads exercise the bounded session cache', { sessions: health.data?.sessions ?? null });
      const evicted = await state(id, 'after-session-cache-eviction');
      check(evicted.sha256 === branch.sha256 && equal(evicted.session.history, branch.session.history) && equal(evicted.session.appliedFixes, branch.session.appliedFixes), 'cache eviction lazily restores exact history and working bytes');
      await stopServer();
      await startServer();
      const restarted = await state(id, 'after-real-server-restart');
      check(restarted.sha256 === branch.sha256 && restarted.session.workVersion?.id === branch.session.workVersion.id, 'true process restart restores exact working version');
      check(equal(restarted.session.history, branch.session.history) && equal(restarted.session.appliedFixes, branch.session.appliedFixes) && !!restarted.session.result?.issues, 'restart restores history, review results and applied fixes');
      const replayAfterRestart = await request('/api/undo-fixes', undo.body);
      const restartReplayState = await state(id, 'receipt-after-restart');
      check(replayAfterRestart.ok && replayAfterRestart.data?.replayed === true && restartReplayState.sha256 === branch.sha256, 'operation receipts survive process restart');
      const afterRestartUndo = await action('/api/undo-fixes', restartReplayState);
      check(afterRestartUndo.response.ok, 'undo remains operational after restart');
      const afterRestartUndone = await state(id, 'undo-after-restart');
      check(afterRestartUndone.sha256 === branchBase.sha256, 'undo after restart restores exact branch parent bytes');
    } else {
      report.restartTest = 'not_run; use --spawn-server for the required real process restart acceptance';
      check(false, 'true process restart controller enabled');
    }
  }
} catch (error) {
  report.error = error.stack || String(error);
  check(false, 'history acceptance completes', { error: error.message });
} finally {
  await stopServer();
  report.passed = report.checks.filter((x) => x.ok).length;
  report.failed = report.checks.filter((x) => !x.ok).length;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
}
console.log(`History acceptance: ${report.passed} passed / ${report.failed} failed. ${OUT}`);
process.exitCode = report.failed ? 1 : 0;
