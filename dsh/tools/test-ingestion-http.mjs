/** Durable import HTTP acceptance. Generated OPC fixtures, owned local processes only.
 * node tools/test-ingestion-http.mjs --port=3350 --peer-port=3351 --run-id=<id> --out=<fresh.json>
 * Seven isolated roots and all failed/final evidence are retained for inspection.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { writeZip } from '../src/zip-write.js';
import { cleanDocx } from '../src/docx-clean.js';
import { parseDocxBuffer } from '../src/docx.js';
import { saveWorkingVersion, loadWorkingVersion } from '../src/working-version.js';
import { loadSessionSnapshot, saveSessionSnapshot } from '../src/session-store.js';
import { loadWorkspace } from '../src/workspace-store.js';
import { appendedFixState } from '../src/fix-history.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const flag = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

// This subprocess invokes module-only fault hooks. No test control is exposed by HTTP.
async function crashChild() {
  const config = JSON.parse(await readFile(flag('crash-config'), 'utf8'));
  const phase = flag('crash-phase');
  const { beginIngestion, submitIngestion } = await import('../src/ingestion-store.js');
  const faultHooks = { [phase]: ({record}) => {
    writeFileSync(config.marker, JSON.stringify({phase, pid: process.pid, status: record.status,
      ingestionId: record.ingestionId, sessionId: record.sessionId, at: new Date().toISOString()}) + '\n', {flag: 'wx'});
    process.kill(process.pid, 'SIGKILL');
  }};
  await beginIngestion({...config.identity, ...config.roots, faultHooks});
  await submitIngestion({...config.identity, ...config.roots, buffer: await readFile(config.source), faultHooks});
  throw new Error(`Crash hook ${phase} was never reached`);
}

async function main() {
  const PORT = Number(flag('port', 3350));
  const PEER_PORT = Number(flag('peer-port', 3351));
  const RACE_REPEATS = Number(flag('race-repeats', 1));
  const FS_DIAGNOSTIC = flag('fs-diagnostic', '0') === '1';
  for (const port of [PORT, PEER_PORT]) assert.ok(Number.isInteger(port) && port > 0 && port < 65536 && ![3210, 3211, 3212].includes(port), 'Use isolated test ports');
  assert.notEqual(PORT, PEER_PORT);
  assert.ok(Number.isSafeInteger(RACE_REPEATS) && RACE_REPEATS >= 1 && RACE_REPEATS <= 256, 'Race repetitions must be between 1 and 256');
  const token = randomUUID();
  const verificationRunId = flag('run-id', `ingestion-${token}`);
  const OUT = resolve(ROOT, flag('out', `data/verify/ingestion-http-${Date.now()}-${token}.json`));
  assert.equal(existsSync(OUT), false, 'Existing evidence must never be overwritten');
  const STORAGE = resolve(dirname(OUT), `ingestion-http-storage-${token}`);
  const FS_OBSERVER = join(STORAGE, 'fs-observer.cjs');
  const rel = relative(dirname(OUT), STORAGE);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  const ROOTS = Object.fromEntries(['sessions', 'versions', 'workspaces', 'audit', 'legacy', 'ingestions', 'jobs'].map((name) => [name, join(STORAGE, name)]));
  const moduleRoots = {storageRoot: ROOTS.ingestions, sessionRoot: ROOTS.sessions, workspaceRoot: ROOTS.workspaces, versionRoot: ROOTS.versions};
  const WORKSPACE = `whttp${token.replace(/-/g, '')}`;
  const BASE = `http://127.0.0.1:${PORT}`;
  const PEER = `http://127.0.0.1:${PEER_PORT}`;
  const report = {generatedAt: new Date().toISOString(), verificationRunId, base: BASE, peer: PEER, storage: STORAGE, roots: ROOTS,
    sourceKind: 'Generated software OPC fixtures only', realArkCalls: 0, paidModelCalls: 0, meaningfulModelResponses: 0,
    localProviderCalls: 0, raceRepeats: RACE_REPEATS, fsDiagnostic: FS_DIAGNOSTIC, appLogs: [], checks: [], processes: [], requests: [], stages: [], fingerprints: {},
    coverage: 'Actual local HTTP, broken connections, real process crashes, Windows FileShare locks, seven isolated roots; no browser or existing services.'};
  const apps = new Map();
  const crashChildren = new Set();
  let provider = null; let providerBase = null; let fileLock = null;
  const check = async (name, fn) => {
    try { const facts = await fn(); report.checks.push({name, ok: true, ...facts}); console.log(`PASS ${name}`); }
    catch (error) { report.checks.push({name, ok: false, error: error.stack || String(error)}); throw error; }
  };
  const identity = (operationId, bytes, workspaceId = WORKSPACE) => ({workspaceId, operationId, name: `software-${operationId}.docx`, size: bytes.length, purpose: 'verification', verificationRunId});
  async function request(path, {base = BASE, body, bytes, headers = {}} = {}) {
    const response = await fetch(base + path, {method: body !== undefined || bytes !== undefined ? 'POST' : 'GET',
      headers: {...(body !== undefined ? {'content-type': 'application/json'} : bytes !== undefined ? {'content-type': 'application/octet-stream'} : {}), ...headers},
      body: body !== undefined ? JSON.stringify(body) : bytes, signal: AbortSignal.timeout(30000)});
    const buffer = Buffer.from(await response.arrayBuffer());
    const data = /json/i.test(response.headers.get('content-type') || '') ? JSON.parse(buffer.toString('utf8')) : null;
    report.requests.push({method: body !== undefined || bytes !== undefined ? 'POST' : 'GET', base, path,
      status: response.status, ingestionId: data?.ingestion?.id, sessionId: data?.id,
      serverPID: apps.get(Number(new URL(base).port))?.pid,
      errorDTO: response.ok ? undefined : data, at: new Date().toISOString()});
    return {status: response.status, data, buffer, headers: response.headers};
  }
  const headersFor = (meta, ingestionId) => ({'X-Ingestion-Id': ingestionId, 'X-Upload-Operation': meta.operationId, 'X-Workspace-Id': meta.workspaceId});
  const uploadPath = (meta) => `/api/upload?name=${encodeURIComponent(meta.name)}`;
  async function intent(meta, base = BASE) {
    const response = await request('/api/ingestions', {base, body: meta});
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.ok(response.data.ingestion?.id);
    for (const key of ['workspaceId', 'operationId', 'name', 'size', 'purpose', 'verificationRunId']) assert.equal(response.data.ingestion[key], meta[key]);
    assert.equal(response.data.workspaceRegistered, true);
    return response.data;
  }
  async function ingestion(id, base = BASE) {
    const response = await request(`/api/ingestion?id=${id}`, {base});
    assert.equal(response.status, 200, JSON.stringify(response.data)); assert.equal(response.data.ingestion.id, id);
    return response.data;
  }
  async function workspace(id = WORKSPACE, base = BASE) {
    const response = await request(`/api/workspace?id=${id}`, {base});
    assert.equal(response.status, 200, JSON.stringify(response.data)); assert.equal(response.data.workspace.id, id);
    return response.data.workspace;
  }
  async function session(id, base = BASE) {
    const response = await request(`/api/session?id=${id}`, {base});
    assert.equal(response.status, 200); assert.equal(response.data.exists, true, JSON.stringify(response.data)); return response.data;
  }
  const rowFor = (workspace, ingestionId) => {
    const rows = workspace.entries.filter((entry) => entry.ingestionId === ingestionId); assert.equal(rows.length, 1); return rows[0];
  };
  const pendingProof = (data, status = 'awaiting-file') => {
    assert.equal(data.ingestion.status, status); assert.equal(data.id, undefined); assert.equal(data.workVersion, undefined);
    assert.equal(data.ingestion.sessionId, undefined); assert.equal(data.ingestion.sourceStored, false);
    assert.equal(data.ingestion.canResume, false); assert.equal(data.ingestion.needsFile, true);
  };
  const completedProof = (data, expectedSource) => {
    assert.equal(data.ingestion.status, 'completed'); assert.equal(data.registered, true); assert.ok(data.id);
    assert.equal(data.workVersion.sessionId, data.id);
    assert.equal(data.workVersion.sourceSha256, hash(expectedSource)); assert.equal(data.clean.sourceSha256, hash(expectedSource));
    assert.equal(data.clean.workSha256, data.workVersion.sha256); assert.equal(data.clean.validatedVersionId, data.workVersion.id);
    assert.equal(data.clean.beforeAfter.verified, true); assert.equal(data.clean.originalCommentCount, 1);
    for (const count of Object.values(data.clean.beforeAfter.after)) assert.equal(count, 0);
    assert.equal(data.ingestion.sourceStored, true); assert.equal(data.ingestion.canResume, false);
  };
  const stage = (name, facts) => { report.stages.push({name, ...facts, at: new Date().toISOString()}); };
  const names = async (path) => { try { return (await readdir(path)).filter((name) => !name.startsWith('.')).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  async function startProvider() {
    provider = httpServer((req, res) => { report.localProviderCalls += 1; req.resume(); res.writeHead(503, {'content-type': 'application/json'}); res.end('{"error":"Model calls forbidden by software acceptance"}'); });
    await new Promise((done, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', done); });
    providerBase = `http://127.0.0.1:${provider.address().port}/api/v3`; report.providerBase = providerBase;
  }
  function environment(port) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:ARK|OPENAI|DOUBAO|VOLC)/i.test(key)
      && !/^DSH_/i.test(key) && !/^(?:NODE_OPTIONS|NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)));
    return {...env, PORT: String(port), HOST: '127.0.0.1', DSH_SESSION_ROOT: ROOTS.sessions, DSH_WORKING_VERSION_ROOT: ROOTS.versions,
      DSH_WORKSPACE_ROOT: ROOTS.workspaces, DSH_AUDIT_ROOT: ROOTS.audit, DSH_LEGACY_ROOT: ROOTS.legacy, DSH_INGESTION_ROOT: ROOTS.ingestions,
      DSH_JOB_ROOT: ROOTS.jobs, DSH_REVIEW_WORKERS: '2',
      ARK_BASE_URL: providerBase, ARK_API_KEY: 'local-ingestion-software-no-paid-key', ARK_MODEL: 'software-only',
      ARK_CONTEXT: '0', ARK_CASES: '0', ARK_CONSISTENCY: '0', ARK_PREFIX_CACHE: '0'};
  }
  async function startApp(port = PORT) {
    assert.equal(apps.has(port), false);
    const probe = netServer(); await new Promise((done, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', done); }); await new Promise((done) => probe.close(done));
    const argv = [...(FS_DIAGNOSTIC ? ['--require', FS_OBSERVER] : []), join(ROOT, 'server.mjs')];
    const child = spawn(process.execPath, argv, {cwd: ROOT, env: environment(port), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    apps.set(port, child); let ready = false; let launchError = null; let stderr = '';
    const log = {pid: child.pid, port, stdout: '', stderr: '', fsDiagnostics: []}; report.appLogs.push(log); let stderrCarry = '';
    child.stdout.on('data', (bytes) => { const text = bytes.toString(); log.stdout = (log.stdout + text).slice(-32000); if (text.includes(`http://127.0.0.1:${port}`)) ready = true; });
    child.stderr.on('data', (bytes) => {
      const text = bytes.toString(); stderr = (stderr + text).slice(-16000); log.stderr = (log.stderr + text).slice(-64000); stderrCarry += text;
      const lines = stderrCarry.split('\n'); stderrCarry = lines.pop();
      for (const line of lines) if (line.startsWith('DSH_FS_OBSERVER ')) {
        try { log.fsDiagnostics.push(JSON.parse(line.slice('DSH_FS_OBSERVER '.length))); } catch { /* Full original stderr remains available. */ }
      }
    }); child.once('error', (error) => { launchError = error; });
    report.processes.push({event: 'start', pid: child.pid, port, at: new Date().toISOString()});
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned app ${port} exited before readiness: ${stderr}`);
      if (ready) { try { if ((await request('/api/health', {base: `http://127.0.0.1:${port}`})).status === 200) return; } catch {} }
      await pause(50);
    }
    throw new Error(`Owned app ${port} did not become ready: ${stderr}`);
  }
  async function stopApp(port = PORT, reason = 'test transition') {
    const child = apps.get(port); if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise((done) => child.once('exit', done)); child.kill('SIGKILL'); await bounded(ended, 5000, 'Owned app did not terminate');
    }
    apps.delete(port); report.processes.push({event: 'stop', pid: child.pid, port, reason, exitCode: child.exitCode, signal: child.signalCode, at: new Date().toISOString()});
  }
  async function lockWorkspace(path) {
    assert.equal(process.platform, 'win32', 'This test requires actual Windows FileShare locks');
    const code = "$ingestionLockPath=[Environment]::GetEnvironmentVariable('DSH_TEST_FILE_LOCK'); $ingestionLockHandle=[System.IO.File]::Open($ingestionLockPath,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); try { [Console]::WriteLine('INGESTION_LOCK_READY'); [Console]::ReadLine() | Out-Null } finally { $ingestionLockHandle.Dispose() }";
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', code], {env: {...environment(PORT), DSH_TEST_FILE_LOCK: path}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']}); fileLock = child;
    await bounded(new Promise((done, reject) => {
      child.stdout.on('data', (bytes) => { if (bytes.toString().includes('INGESTION_LOCK_READY')) done(); });
      child.once('error', reject); child.once('exit', (value) => { if (value !== 0) reject(new Error('Windows lock helper exited early')); });
    }), 10000, 'Windows lock helper did not become ready');
    report.processes.push({event: 'file-lock', pid: child.pid, path, at: new Date().toISOString()});
  }
  async function releaseLock() {
    const child = fileLock; if (!child) return; fileLock = null;
    if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise((done) => child.once('exit', done)); child.stdin.end('\n');
      try { await bounded(ended, 5000, 'Windows lock release timed out'); } catch { child.kill('SIGKILL'); await bounded(ended, 5000, 'Windows lock helper did not terminate'); }
    }
  }
  async function loseReply(meta, ingestionId, bytes) {
    return bounded(new Promise((done, reject) => {
      const req = httpRequest(BASE + uploadPath(meta), {method: 'POST', headers: {...headersFor(meta, ingestionId), 'content-type': 'application/octet-stream', 'content-length': bytes.length}}, (res) => {
        const fact = {type: 'response-body-discarded', statusHeaders: res.statusCode, ingestionId, actualClientSocketDestroyed: true};
        res.on('error', () => {}); res.destroy(); req.destroy(); report.requests.push(fact); done(fact);
      });
      req.once('error', reject); req.end(bytes);
    }), 30000, 'Lost-response upload did not finish');
  }
  async function interruptUpload(meta, ingestionId, bytes) {
    return bounded(new Promise((done, reject) => {
      const req = httpRequest(BASE + uploadPath(meta), {method: 'POST', headers: {...headersFor(meta, ingestionId), 'content-type': 'application/octet-stream', 'content-length': bytes.length}});
      req.on('error', () => {}); req.once('socket', (socket) => socket.once('connect', () => {
        req.flushHeaders(); req.write(bytes.subarray(0, Math.min(37, bytes.length - 1)), () => {
          req.destroy(); report.requests.push({type: 'request-body-interrupted', ingestionId, intendedBytes: bytes.length, sentBytes: 37, actualClientSocketDestroyed: true}); done();
        });
      }));
      req.once('response', () => reject(new Error('Truncated request unexpectedly completed')));
    }), 10000, 'Truncated upload did not disconnect');
  }
  async function crashAt(phase, expectedStatus, bytes) {
    const meta = identity(`crash-${phase}`, bytes, `wcrash${token.replace(/-/g, '')}`);
    const folder = join(STORAGE, 'crashes', phase); await mkdir(folder, {recursive: true});
    const source = join(folder, 'source.docx'); const marker = join(folder, 'kill-marker.json'); const config = join(folder, 'config.json');
    await writeFile(source, bytes, {flag: 'wx'}); await writeFile(config, JSON.stringify({identity: meta, roots: moduleRoots, source, marker}), {flag: 'wx'});
    const child = spawn(process.execPath, [SELF, `--crash-config=${config}`, `--crash-phase=${phase}`], {cwd: ROOT, env: environment(PORT), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    crashChildren.add(child); child.once('exit', () => crashChildren.delete(child));
    let stderr = ''; child.stderr.on('data', (value) => { stderr += value.toString(); });
    await bounded(new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); }), 30000, `Crash child ${phase} did not terminate`);
    assert.ok(child.signalCode === 'SIGKILL' || child.exitCode !== 0, 'Fault child must terminate abnormally');
    assert.equal(existsSync(marker), true, `Crash hook not reached: ${stderr}`);
    const killed = JSON.parse(await readFile(marker, 'utf8')); assert.equal(killed.phase, phase); assert.equal(killed.status, expectedStatus);
    const {loadIngestion} = await import('../src/ingestion-store.js');
    const durable = await loadIngestion({ingestionId: killed.ingestionId, storageRoot: ROOTS.ingestions}); assert.equal(durable.status, expectedStatus);
    const rawWorkspace = await loadWorkspace({workspaceId: meta.workspaceId, storageRoot: ROOTS.workspaces});
    const row = rowFor(rawWorkspace.workspace, killed.ingestionId); const beforeSession = await requestNoServerGuard(killed.sessionId);
    report.processes.push({event: 'actual-stage-kill', pid: child.pid, phase, status: durable.status, exitCode: child.exitCode, signal: child.signalCode});
    stage(`crashed-${phase}`, {marker: killed, journalStatus: durable.status, rawRowHasSession: !!row.id, sessionSnapshotExists: beforeSession});
    // An attached row can already contain its private session id. Freeze the
    // journal commit during startup to prove that this row is still unusable.
    if (expectedStatus === 'workspace-attached') await lockWorkspace(join(ROOTS.ingestions, killed.ingestionId, 'state.json'));
    await startApp();
    let current = await ingestion(killed.ingestionId);
    if (expectedStatus === 'workspace-attached') {
      try {
        assert.equal(current.ingestion.status, 'workspace-attached'); assert.equal(current.ingestion.canResume, true);
        assert.equal(current.id, undefined); assert.equal(current.ingestion.sessionId, undefined);
        const projected = rowFor(await workspace(meta.workspaceId), killed.ingestionId);
        assert.equal(projected.status, 'upload-saving'); assert.ok(!projected.id);
        const hidden = await request(`/api/session?id=${killed.sessionId}`); assert.equal(hidden.data.exists, false);
        const blocked = await request(`/api/session-file?id=${killed.sessionId}`); assert.equal(blocked.status, 404);
        stage(`terminal-gate-${phase}`, {ingestion: current.ingestion, rawRowHasSession: !!row.id, projected});
      } finally { await releaseLock(); }
      const resumed = await request('/api/resume-ingestion', {body: {id: killed.ingestionId}}); assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
      current = resumed.data;
    }
    if (phase === 'afterIntent') {
      pendingProof(current); assert.equal(rowFor(await workspace(meta.workspaceId), killed.ingestionId).status, 'upload-pending');
      const resumed = await request('/api/resume-ingestion', {body: {id: killed.ingestionId}}); assert.equal(resumed.status, 409); pendingProof(resumed.data);
      const uploaded = await request(uploadPath(meta), {bytes, headers: headersFor(meta, killed.ingestionId)}); assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data)); completedProof(uploaded.data, bytes);
    } else {
      assert.equal(current.ingestion.status, 'completed'); assert.equal(current.registered, true);
      const recovered = await request('/api/resume-ingestion', {body: {id: killed.ingestionId}}); assert.equal(recovered.status, 200); completedProof(recovered.data, bytes);
      assert.equal(recovered.data.id, killed.sessionId); assert.equal(rowFor(await workspace(meta.workspaceId), killed.ingestionId).id, killed.sessionId);
    }
    await stopApp(PORT, `verified crash ${phase}`);
    return {phase, durableStatusBeforeRestart: durable.status, sourceKnown: !!durable.source, sessionSnapshotBeforeRestart: beforeSession, actualProcessKilled: true};
  }
  async function requestNoServerGuard(id) {
    try { await loadSessionSnapshot({sessionId: id, storageRoot: ROOTS.sessions}); return true; }
    catch (error) { if (['SESSION_NOT_FOUND', 'SESSION_MISSING'].includes(error.code)) return false; throw error; }
  }

  try {
    for (const path of Object.values(ROOTS)) await mkdir(path, {recursive: true});
    if (FS_DIAGNOSTIC) {
      const observer = fsObserverSource(); await writeFile(FS_OBSERVER, observer, {flag: 'wx'});
      report.fsObserver = {path: FS_OBSERVER, sha256: hash(observer), policy: 'Observe own storage permission errors and rethrow the same original error; no retries or result changes.'};
    }
    for (const name of ['server.mjs', 'src/ingestion-store.js', 'src/working-version.js', 'src/session-store.js', 'src/workspace-store.js', 'src/docx-clean.js', 'src/review-server.js', 'src/review-runtime.js', 'src/job-store.js', 'tools/test-ingestion-http.mjs']) report.fingerprints[name] = hash(await readFile(join(ROOT, name)));
    // Valid ZIP comments differ without changing either document semantics or size.
    // The conflict is over immutable source bytes, independent of cleaning validity.
    const bytes = withZipComment(fixture(), 'A0'); const other = withZipComment(fixture(), 'A1');
    assert.equal(bytes.length, other.length); const unsafe = fixture({unsafe: true});
    report.fixtureSha256 = {source: hash(bytes), cleaned: hash(cleanDocx(bytes).buffer), sameSizeDifferentSource: hash(other), unsafe: hash(unsafe)};
    await startProvider(); await startApp();
    let durableIntent; let completed;
    await check('intent is a durable unique queue placeholder before any document bytes', async () => {
      const meta = {...identity('pending-disconnected', bytes), name: '软件导入%验收.docx'}; durableIntent = {meta, data: await intent(meta)};
      pendingProof(durableIntent.data); const row = rowFor(await workspace(), durableIntent.data.ingestion.id);
      assert.equal(row.status, 'upload-pending'); assert.ok(!row.id);
      const repeat = await intent(meta); assert.equal(repeat.ingestion.id, durableIntent.data.ingestion.id); assert.equal(repeat.ingestion.entryId, row.entryId);
      const {loadIngestion} = await import('../src/ingestion-store.js');
      const stored = await loadIngestion({ingestionId: repeat.ingestion.id, storageRoot: ROOTS.ingestions});
      assert.equal(stored.placeholderRegistered, true); assert.equal(stored.source, null); assert.equal(stored.status, 'awaiting-file');
      stage('intent-durable', {ingestion: repeat.ingestion, row}); return {ingestionId: repeat.ingestion.id, entryId: row.entryId};
    });
    await check('truncated real HTTP upload survives restart as awaiting-file and requires the original file', async () => {
      const {meta, data} = durableIntent; await interruptUpload(meta, data.ingestion.id, bytes); await pause(100);
      await stopApp(PORT, 'restart after truncated body'); await startApp();
      pendingProof(await ingestion(data.ingestion.id)); const resumed = await request('/api/resume-ingestion', {body: {id: data.ingestion.id}});
      assert.equal(resumed.status, 409); pendingProof(resumed.data);
      const uploaded = await request(uploadPath(meta), {bytes, headers: headersFor(meta, data.ingestion.id)});
      assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data)); completedProof(uploaded.data, bytes); completed = uploaded.data;
      assert.equal(rowFor(await workspace(), data.ingestion.id).id, completed.id);
      const source = await request(`/api/session-file?id=${completed.id}&original=1`); assert.equal(source.status, 200); assert.deepEqual(source.buffer, bytes);
      const working = await request(`/api/session-file?id=${completed.id}`); assert.equal(working.status, 200); assert.equal(hash(working.buffer), completed.workVersion.sha256);
      assert.equal(parseDocxBuffer(working.buffer).comments.length, 0); return {sessionId: completed.id, sourceSha256: hash(bytes), workSha256: hash(working.buffer)};
    });
    await check('lost HTTP response read and same-source retry reuse one complete session and queue row', async () => {
      const meta = identity('lost-reply', bytes); const begun = await intent(meta); const transport = await loseReply(meta, begun.ingestion.id, bytes);
      assert.equal(transport.statusHeaders, 200); const read = await ingestion(begun.ingestion.id); completedProof(read, bytes);
      const replay = await request(uploadPath(meta), {bytes, headers: headersFor(meta, begun.ingestion.id)}); assert.equal(replay.status, 200); completedProof(replay.data, bytes);
      assert.equal(replay.data.id, read.id); assert.equal(replay.data.workVersion.id, read.workVersion.id); assert.equal(rowFor(await workspace(), begun.ingestion.id).id, read.id);
      const dirs = await names(ROOTS.sessions); assert.equal(dirs.filter((name) => name === read.id).length, 1); return {...transport, sessionId: read.id};
    });
    await check('same operation rejects changed metadata, changed bytes and mismatched upload headers', async () => {
      const {meta, data} = durableIntent;
      for (const patch of [{name: 'another.docx'}, {size: meta.size + 1}, {purpose: 'editorial'}, {verificationRunId: 'another-run'}]) {
        const conflict = await request('/api/ingestions', {body: {...meta, ...patch}}); assert.equal(conflict.status, 409, JSON.stringify(conflict.data));
      }
      const bodyConflict = await request(uploadPath(meta), {bytes: other, headers: headersFor(meta, data.ingestion.id)}); assert.equal(bodyConflict.status, 409);
      const wrongWorkspace = await request(uploadPath(meta), {bytes, headers: {...headersFor(meta, data.ingestion.id), 'X-Workspace-Id': 'wother'}}); assert.equal(wrongWorkspace.status, 409);
      const wrongOperation = await request(uploadPath(meta), {bytes, headers: {...headersFor(meta, data.ingestion.id), 'X-Upload-Operation': 'another-op'}}); assert.equal(wrongOperation.status, 409);
      const unchanged = await ingestion(data.ingestion.id); assert.equal(unchanged.id, completed.id); assert.equal(unchanged.workVersion.id, completed.workVersion.id);
      return {metadataConflicts: 4, byteConflict: true, headerConflicts: 2};
    });
    await check('unsafe source is durably failed without a usable session and remains failed after restart', async () => {
      const meta = identity('invalid-cleaning', unsafe); const begun = await intent(meta); const beforeSessions = await names(ROOTS.sessions); const beforeVersions = await names(ROOTS.versions);
      const response = await request(uploadPath(meta), {bytes: unsafe, headers: headersFor(meta, begun.ingestion.id)});
      assert.equal(response.status, 422); assert.equal(response.data.ingestion.status, 'failed'); assert.equal(response.data.clean.status, 'failed');
      assert.equal(response.data.id, undefined); assert.equal(response.data.workVersion, undefined); assert.equal(response.data.ingestion.sessionId, undefined);
      assert.equal(response.data.ingestion.canResume, false); assert.equal(rowFor(await workspace(), begun.ingestion.id).status, 'upload-failed');
      assert.deepEqual(await names(ROOTS.sessions), beforeSessions); assert.deepEqual(await names(ROOTS.versions), beforeVersions);
      await stopApp(PORT, 'restart validation failure'); await startApp(); const failed = await ingestion(begun.ingestion.id); assert.equal(failed.ingestion.status, 'failed'); assert.equal(failed.id, undefined);
      const repeated = await request(uploadPath(meta), {bytes: unsafe, headers: headersFor(meta, begun.ingestion.id)}); assert.equal(repeated.status, 422); assert.equal(repeated.data.ingestion.id, begun.ingestion.id);
      const resumed = await request('/api/resume-ingestion', {body: {id: begun.ingestion.id}}); assert.equal(resumed.status, 422); assert.equal(resumed.data.id, undefined);
      stage('validation-failed-after-restart', {ingestion: failed.ingestion, row: rowFor(await workspace(), begun.ingestion.id)}); return {ingestionId: begun.ingestion.id, noUsableSession: true};
    });
    await check('actual Windows workspace save failure retains committed session and resumes without original File', async () => {
      const meta = identity('workspace-save-lock', bytes); const begun = await intent(meta); await lockWorkspace(join(ROOTS.workspaces, meta.workspaceId, 'state.json'));
      let failed;
      try {
        const response = await request(uploadPath(meta), {bytes, headers: headersFor(meta, begun.ingestion.id)}); assert.equal(response.status, 500, JSON.stringify(response.data)); failed = response.data;
        assert.equal(failed.ingestion.status, 'session-saved'); assert.equal(failed.ingestion.sourceStored, true); assert.equal(failed.ingestion.canResume, true); assert.equal(failed.id, undefined);
        const {loadIngestion} = await import('../src/ingestion-store.js'); const raw = await loadIngestion({ingestionId: begun.ingestion.id, storageRoot: ROOTS.ingestions});
        const snapshot = await loadSessionSnapshot({sessionId: raw.sessionId, storageRoot: ROOTS.sessions}); assert.equal(snapshot.snapshot.ingestionId, raw.ingestionId);
        const hidden = await request(`/api/session?id=${raw.sessionId}`); assert.equal(hidden.data.exists, false, 'Pending session cannot be opened before workspace+terminal commit');
        const blockedFile = await request(`/api/session-file?id=${raw.sessionId}`); assert.equal(blockedFile.status, 404);
        const row = rowFor(await workspace(), begun.ingestion.id); assert.equal(row.status, 'upload-saving'); assert.ok(!row.id);
        stage('session-saved-workspace-locked', {ingestion: failed.ingestion, row, snapshotVersionId: snapshot.snapshot.workVersion.id});
      } finally { await releaseLock(); }
      const recovered = await request('/api/resume-ingestion', {body: {id: begun.ingestion.id}}); assert.equal(recovered.status, 200, JSON.stringify(recovered.data)); completedProof(recovered.data, bytes);
      assert.equal(rowFor(await workspace(), begun.ingestion.id).id, recovered.data.id); return {ingestionId: begun.ingestion.id, recoveryWithoutFile: true, committedPhaseBeforeRecovery: failed.ingestion.status};
    });
    await check('two owned app processes share identity and serialize competing source submissions', async () => {
      await startApp(PEER_PORT);
      const meta = identity('two-process-same-source', bytes); const [a, b] = await Promise.all([intent(meta), intent(meta, PEER)]); assert.equal(a.ingestion.id, b.ingestion.id);
      const uploaded = await Promise.all([request(uploadPath(meta), {bytes, headers: headersFor(meta, a.ingestion.id)}), request(uploadPath(meta), {base: PEER, bytes, headers: headersFor(meta, b.ingestion.id)})]);
      for (const response of uploaded) { assert.equal(response.status, 200, JSON.stringify(response.data)); completedProof(response.data, bytes); }
      assert.equal(uploaded[0].data.id, uploaded[1].data.id); assert.equal(rowFor(await workspace(), a.ingestion.id).id, uploaded[0].data.id);
      const {loadIngestion} = await import('../src/ingestion-store.js');
      const raceSessions = new Set(); const raceFacts = [];
      for (let round = 0; round < RACE_REPEATS; round += 1) {
        const operationId = RACE_REPEATS === 1 ? 'two-process-different-source' : `two-process-different-source-${String(round).padStart(3, '0')}`;
        const raceMeta = identity(operationId, bytes); const raceIntent = await intent(raceMeta);
        const race = await Promise.all([request(uploadPath(raceMeta), {bytes, headers: headersFor(raceMeta, raceIntent.ingestion.id)}), request(uploadPath(raceMeta), {base: PEER, bytes: other, headers: headersFor(raceMeta, raceIntent.ingestion.id)})]);
        const winner = race.find((value) => value.status === 200);
        stage('competing-source-round', {round: round + 1, operationId, ingestionId: raceIntent.ingestion.id,
          winner: winner ? {sessionId: winner.data?.id, sourceSha256: winner.data?.workVersion?.sourceSha256} : null,
          responses: race.map((value, index) => ({base: index ? PEER : BASE, serverPID: apps.get(index ? PEER_PORT : PORT)?.pid,
            status: value.status, body: value.data}))});
        assert.deepEqual(race.map((value) => value.status).sort((x, y) => x - y), [200, 409]);
        const saved = await ingestion(raceIntent.ingestion.id); assert.equal(saved.id, winner.data.id);
        const journal = await loadIngestion({ingestionId: raceIntent.ingestion.id, storageRoot: ROOTS.ingestions});
        assert.equal(journal.status, 'completed'); assert.equal(journal.sessionId, winner.data.id);
        assert.equal(journal.source.sha256, winner.data.workVersion.sourceSha256);
        assert.equal(rowFor(await workspace(), raceIntent.ingestion.id).id, winner.data.id);
        assert.equal((await names(ROOTS.sessions)).filter((id) => id === winner.data.id).length, 1);
        assert.equal(raceSessions.has(winner.data.id), false, 'Each new operation has one distinct terminal session'); raceSessions.add(winner.data.id);
        raceFacts.push({round: round + 1, ingestionId: raceIntent.ingestion.id, sessionId: winner.data.id, conflictStatuses: race.map((value) => value.status)});
        if (RACE_REPEATS > 1 && (round + 1) % 8 === 0) console.log(`PASS competing source rounds ${round + 1}/${RACE_REPEATS}`);
      }
      await stopApp(PEER_PORT, 'cross-process concurrency complete'); return {sameSessionId: uploaded[0].data.id, raceRepeats: RACE_REPEATS, raceFacts};
    });
    await check('65 imported documents and a pending row survive LRU eviction and service restart', async () => {
      const queueId = `wqueue${token.replace(/-/g, '')}`; const ids = [];
      for (let i = 0; i < 65; i += 1) {
        const meta = identity(`queue-${String(i).padStart(2, '0')}`, bytes, queueId); const begun = await intent(meta);
        const response = await request(uploadPath(meta), {bytes, headers: headersFor(meta, begun.ingestion.id)}); assert.equal(response.status, 200, JSON.stringify(response.data)); completedProof(response.data, bytes);
        ids.push({ingestionId: begun.ingestion.id, sessionId: response.data.id});
      }
      const pending = await intent(identity('queue-pending', bytes, queueId));
      const health = await request('/api/health'); assert.ok(health.data.sessions <= 40);
      const before = await workspace(queueId); assert.equal(before.entries.length, 66); assert.equal(rowFor(before, pending.ingestion.id).status, 'upload-pending');
      assert.equal((await session(ids[0].sessionId)).id, ids[0].sessionId);
      await stopApp(PORT, 'restart queue beyond LRU'); await startApp(); const after = await workspace(queueId);
      assert.equal(after.entries.length, 66); assert.equal(new Set(after.entries.map((row) => row.entryId)).size, 66);
      for (const id of ids) assert.equal(rowFor(after, id.ingestionId).id, id.sessionId);
      assert.equal((await session(ids[0].sessionId)).id, ids[0].sessionId); pendingProof(await ingestion(pending.ingestion.id));
      stage('queue-65-restarted', {workspaceId: queueId, entryCount: after.entries.length, pending: rowFor(after, pending.ingestion.id)});
      return {completed: 65, pending: 1, liveSessionCap: health.data.sessions, restoredFirstSessionId: ids[0].sessionId};
    });
    await check('legacy upload without headers atomically registers default workspace and returns its generated operation', async () => {
      const response = await request('/api/upload?name=software-legacy-upload.docx', {bytes}); assert.equal(response.status, 200, JSON.stringify(response.data)); completedProof(response.data, bytes);
      assert.equal(response.data.ingestion.workspaceId, 'wdefault'); assert.ok(response.data.ingestion.operationId);
      const row = rowFor(await workspace('wdefault'), response.data.ingestion.id); assert.equal(row.id, response.data.id);
      return {workspaceId: 'wdefault', operationId: response.data.ingestion.operationId, ingestionId: response.data.ingestion.id, sessionId: response.data.id};
    });
    await check('ingestion replay preserves a later saved version, history and human feedback', async () => {
      const opened = await session(completed.id); const text = opened.doc.paragraphs[0].text; const quote = text.replace(/\s/g, '').slice(0, 2);
      const marked = await request('/api/human-records', {body: {id: opened.id, operationId: `human-${token}`, kind: 'mark',
        baseVersionId: opened.workVersion.id, baseMutationEpoch: opened.history.epoch, expectedHumanRevision: opened.human.revision, baseRunId: null,
        purpose: 'verification', verificationRunId, mark: {target: 'body', index: 0, start: 0, end: quote.length, quote, offsetSpace: 'normalized', note: '软件导入回放不得覆盖此人工反馈'}}});
      assert.equal(marked.status, 200, JSON.stringify(marked.data)); const recordId = marked.data.recordId;
      const stored = await loadSessionSnapshot({sessionId: opened.id, storageRoot: ROOTS.sessions});
      const current = await loadWorkingVersion({sessionId: opened.id, versionId: stored.snapshot.workVersion.id, storageRoot: ROOTS.versions});
      const nextBytes = cleanDocx(fixture({text: '软件后续保存正文，导入回执不得退回初始工作稿。'})).buffer;
      const version = await saveWorkingVersion({sessionId: opened.id, name: opened.name, buffer: nextBytes, originalBuffer: current.originalBuffer, parent: current.version,
        patches: [], operation: 'software-followup-save', storageRoot: ROOTS.versions});
      const clean = {...stored.snapshot.clean, validatedVersionId: version.id, workSha256: version.sha256, outputSha256: version.sha256};
      const candidate = {...stored.snapshot, workVersion: version, ...appendedFixState(stored.snapshot, version, []), clean, cleanRecords: {...stored.snapshot.cleanRecords, [version.id]: clean}};
      await saveSessionSnapshot({sessionId: opened.id, snapshot: candidate, expectedRevision: stored.manifest.revision, storageRoot: ROOTS.sessions});
      // The app still has v0 cached; a second process has now saved v1 through
      // the actual stores. A status read must refresh to the current manifest.
      const freshStatus = await ingestion(durableIntent.data.ingestion.id); assert.equal(freshStatus.workVersion.id, version.id);
      await stopApp(PORT, 'restart with later immutable version and feedback'); await startApp(); const {meta, data} = durableIntent;
      const replay = await request(uploadPath(meta), {bytes, headers: headersFor(meta, data.ingestion.id)}); assert.equal(replay.status, 200, JSON.stringify(replay.data));
      assert.equal(replay.data.id, opened.id); assert.equal(replay.data.workVersion.id, version.id); assert.equal(replay.data.history.epoch, candidate.mutationEpoch);
      const restored = await session(opened.id); assert.equal(restored.workVersion.id, version.id); assert.equal(restored.doc.paragraphs[0].text, '软件后续保存正文，导入回执不得退回初始工作稿。');
      const human = await request(`/api/human-records?id=${opened.id}&history=1`); assert.ok(human.data.records.some((record) => record.id === recordId));
      const finalSnapshot = await loadSessionSnapshot({sessionId: opened.id, storageRoot: ROOTS.sessions}); assert.equal(finalSnapshot.snapshot.humanRecords[0].id, recordId);
      assert.equal(finalSnapshot.snapshot.workVersion.id, version.id); return {initialVersionId: opened.workVersion.id, preservedVersionId: version.id, humanRecordId: recordId};
    });
    await stopApp(PORT, 'begin actual durable-stage crash matrix');
    for (const [phase, status] of [['afterIntent', 'awaiting-file'], ['afterSourceStored', 'source-stored'], ['afterVersionSaved', 'version-saved'],
      ['afterSessionSaved', 'session-saved'], ['afterWorkspaceAttached', 'workspace-attached'], ['beforeComplete', 'workspace-attached'],
      ['afterSourceBytesBeforeRecord', 'awaiting-file'], ['afterSessionStateRenamed', 'version-saved']]) {
      await check(`actual process kill at ${phase} restores the same ingestion and session identity`, () => crashAt(phase, status, bytes));
    }
    await check('all acceptance paths made zero model requests', async () => { assert.equal(report.localProviderCalls, 0); return {localProviderCalls: 0, paidModelCalls: 0, meaningfulModelResponses: 0}; });
    await check('the verified backend and test source remained unchanged throughout this evidence run', async () => {
      report.finalFingerprints = {};
      for (const [name, initial] of Object.entries(report.fingerprints)) {
        const final = hash(await readFile(join(ROOT, name))); report.finalFingerprints[name] = final; assert.equal(final, initial, `${name} changed during acceptance`);
      }
      return {sourceFiles: Object.keys(report.fingerprints).length};
    });
    report.ok = true;
  } catch (error) { report.ok = false; report.error = error.stack || String(error); process.exitCode = 1; }
  finally {
    await releaseLock();
    for (const child of crashChildren) {
      const ended = new Promise((done) => child.once('exit', done)); child.kill('SIGKILL'); await bounded(ended, 5000, 'Owned crash child did not stop');
    }
    for (const port of [...apps.keys()]) await stopApp(port, 'acceptance cleanup');
    if (provider) { provider.closeAllConnections?.(); await bounded(new Promise((done) => provider.close(done)), 5000, 'Local provider did not close'); }
    report.completedAt = new Date().toISOString();
    await mkdir(dirname(OUT), {recursive: true}); await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    console.log(`Evidence: ${OUT}`);
  }
}

function fixture({unsafe = false, text = '软件导入验收正文。'} = {}) {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const R = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const O = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  return writeZip([
    {name: '[Content_Types].xml', data: `<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'><Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/><Default Extension='xml' ContentType='application/xml'/><Override PartName='/word/document.xml' ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'/><Override PartName='/word/comments.xml' ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'/></Types>`},
    {name: '_rels/.rels', data: `<Relationships xmlns='${R}'><Relationship Id='doc' Type='${O}officeDocument' Target='word/document.xml'/></Relationships>`},
    {name: 'word/document.xml', data: `<w:document xmlns:w='${W}'><w:body><w:p><w:commentRangeStart w:id='0'/><w:r><w:t>${text}</w:t></w:r><w:commentRangeEnd w:id='0'/><w:r><w:commentReference w:id='0'/></w:r></w:p><w:sectPr/></w:body></w:document>`},
    {name: 'word/_rels/document.xml.rels', data: `<Relationships xmlns='${R}'><Relationship Id='comment' Type='${O}comments' Target='${unsafe ? '../../escape/comments.xml' : 'comments.xml'}'/></Relationships>`},
    {name: 'word/comments.xml', data: `<w:comments xmlns:w='${W}'><w:comment w:id='0' w:author='软件fixture'><w:p><w:r><w:t>软件原始批注</w:t></w:r></w:p></w:comment></w:comments>`},
  ]);
}

function withZipComment(bytes, text) {
  const comment = Buffer.from(text); const value = Buffer.from(bytes);
  assert.equal(value.readUInt32LE(value.length - 22), 0x06054b50);
  value.writeUInt16LE(comment.length, value.length - 2); return Buffer.concat([value, comment]);
}

function fsObserverSource() {
  return `const fsp = require('node:fs/promises');
const {syncBuiltinESMExports} = require('node:module');
const {resolve, relative, isAbsolute} = require('node:path');
const {fileURLToPath} = require('node:url');
const root = resolve(__dirname);
const location = value => typeof value === 'string' ? resolve(value) : value instanceof URL ? resolve(fileURLToPath(value)) : null;
const owned = value => {const path = location(value); if (!path) return false; const rel = relative(root, path); return !rel.startsWith('..') && !isAbsolute(rel);};
const details = (error, depth = 0) => !error || depth > 3 ? undefined : {code:error.code, errno:error.errno, syscall:error.syscall, path:error.path, dest:error.dest, message:error.message, stack:error.stack, cause:details(error.cause, depth + 1)};
for (const method of ['rename', 'readFile', 'unlink', 'lstat', 'realpath']) {
  const original = fsp[method];
  fsp[method] = async function(...args) {
    try {return await original.apply(this, args);}
    catch (error) {
      try {
        if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code) && (owned(args[0]) || method === 'rename' && owned(args[1])))
          process.stderr.write('DSH_FS_OBSERVER ' + JSON.stringify({pid:process.pid, method, path:location(args[0]), dest:method === 'rename' ? location(args[1]) : undefined, at:new Date().toISOString(), error:details(error)}) + '\\n');
      } catch { /* Diagnostics must never replace the original rejection. */ }
      throw error;
    }
  };
}
syncBuiltinESMExports();
`;
}

if (flag('crash-phase')) await crashChild(); else await main();
