/**
 * Run the unchanged verify-all gate against an owned service and fresh stores.
 * Requires an explicit --ready after the coordinating agent has frozen source.
 * node tools/run-isolated-regression.mjs --run=data/optimization/runs/<run> --ready
 * This controller never replaces or stops an existing service. Browser checks
 * requiring an existing tab are explicitly blocked, not represented as passing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const runArg = argv.find((arg) => arg.startsWith('--run='))?.slice(6);
const attempt = Number(argv.find((arg) => arg.startsWith('--attempt='))?.slice(10) || 1);
if (!runArg || !argv.includes('--ready') || !Number.isInteger(attempt) || attempt < 1 || attempt > 99
    || argv.some((arg) => arg !== '--ready' && !arg.startsWith('--run=') && !arg.startsWith('--attempt='))) {
  throw new Error('After source is ready, use --run=data/optimization/runs/<run> --ready. No service has been started.');
}
const RUN = resolve(ROOT, runArg);
const runScope = relative(join(ROOT, 'data', 'optimization', 'runs'), RUN);
if (!runScope || runScope.startsWith('..') || isAbsolute(runScope) || !existsSync(RUN)) {
  throw new Error('Select an existing run beneath data/optimization/runs.');
}
if (existsSync(join(RUN, 'complete.json'))) {
  throw new Error('Sealed verification run cannot receive new regression evidence. Select a fresh unsealed run.');
}
const PORT = 3340;
const BASE = `http://127.0.0.1:${PORT}`;
const label = `regression-full-${String(attempt).padStart(2, '0')}`;
const TESTS = join(RUN, 'tests');
const OUT = join(TESTS, `${label}.json`);
if (existsSync(OUT)) throw new Error('Evidence already exists; this controller never overwrites a previous run.');
const token = randomUUID();
const STORAGE = join(TESTS, `${label}-storage-${token}`);
const ROOTS = Object.fromEntries(['sessions', 'versions', 'workspaces', 'audit', 'legacy', 'ingestion', 'jobs', 'arkExecutions', 'reviewPlans'].map((kind) => [kind, join(STORAGE, kind)]));
const EVENTS = join(STORAGE, 'controller-events');
const GUARD = join(STORAGE, 'isolation-preload.cjs');
const COPIES = join(TESTS, `${label}-verify`);
const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.json', '.md']);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const report = {
  schemaVersion: 1, runId: token, generatedAt: new Date().toISOString(), base: BASE,
  command: 'node tools/verify-all.mjs', storage: STORAGE, roots: ROOTS,
  policy: { paidModelCallsPermitted: false, externalNetworkPermitted: false,
    existingServicePorts: [3210, 3211, 3212], browserPermitted: false,
    gateSourceUnmodified: true, credentialsRecorded: false, requestContentRecorded: false,
    isolatedStoreRootCount: 9, documentWorkerLimit: 2 },
  checks: [], processes: [], copiedArtifacts: [], cleanup: [],
};
const check = (name, ok, detail = null) => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
let app = null, gate = null, provider = null, providerBase = null;
let interrupted = false, finalizing = false;
const providerSockets = new Set();
const providerRequests = [];
const children = new Set();
const removedEnvironmentNames = [];
let sourceBefore = null, verifyBefore = null;

async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function sourceManifest() {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name).toLowerCase()) && !entry.name.startsWith('.')) files.push(path);
    }
  }
  for (const name of ['src', 'public', 'tools', 'rules']) if (existsSync(join(ROOT, name))) await walk(join(ROOT, name));
  for (const name of ['server.mjs', 'package.json']) if (existsSync(join(ROOT, name))) files.push(join(ROOT, name));
  files.sort();
  const entries = await Promise.all(files.map(async (path) => ({ path: relative(ROOT, path).replace(/\\/g, '/'), sha256: hash(await readFile(path)) })));
  for (const path of ['src/review-server.js', 'src/review-runtime.js', 'src/job-store.js'])
    if (!entries.some((entry) => entry.path === path)) throw new Error(`Required review module is missing from source fingerprints: ${path}`);
  return { sha256: hash(JSON.stringify(entries)), files: entries };
}
async function verifyManifest() {
  const directory = join(ROOT, 'data', 'verify');
  if (!existsSync(directory)) return new Map();
  const entries = await readdir(directory, { withFileTypes: true });
  const found = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:json|md|csv|txt|log|png)$/i.test(entry.name)) continue;
    const bytes = await readFile(join(directory, entry.name));
    found.set(entry.name, { sha256: hash(bytes), bytes: bytes.length });
  }
  return found;
}
function cleanEnvironment() {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/(?:ARK|OPENAI|DOUBAO|VOLC|ANTHROPIC|AZURE_OPENAI|GEMINI|DEEPSEEK|API_KEY|ACCESS_TOKEN|SECRET|CREDENTIAL)/i.test(name)
        || /^DSH_/i.test(name) || /PROXY/i.test(name)
        || /^(?:NODE_OPTIONS|NODE_USE_ENV_PROXY|BASE|BASE_URL|MODEL|PORT|HOST)$/i.test(name)) {
      removedEnvironmentNames.push(name); continue;
    }
    environment[name] = value;
  }
  return Object.assign(environment, {
    BASE, BASE_URL: BASE, HOST: '127.0.0.1', PORT: String(PORT),
    DSH_SESSION_ROOT: ROOTS.sessions, DSH_WORKING_VERSION_ROOT: ROOTS.versions,
    DSH_WORKSPACE_ROOT: ROOTS.workspaces, DSH_AUDIT_ROOT: ROOTS.audit, DSH_LEGACY_ROOT: ROOTS.legacy,
    DSH_INGESTION_ROOT: ROOTS.ingestion, DSH_JOB_ROOT: ROOTS.jobs, DSH_REVIEW_WORKERS: '2',
    DSH_ARK_EXECUTION_ROOT:ROOTS.arkExecutions,DSH_REVIEW_PLAN_ROOT:ROOTS.reviewPlans,DSH_ARK_POOL_ID:'software-regression',DSH_ARK_POOL_CONCURRENCY:'2',
    DSH_VERIFICATION_EVIDENCE_DIR: join(TESTS, `${label}-admission`),
    // These are read-only corpus inputs resolved from this repository, never inherited roots.
    DSH_ACADEMIC_ROOT: resolve(ROOT, '..'), DSH_CORPUS_ROOT: resolve(ROOT, '..', '发给皓天的一审文件'),
    DSH_STANDARDS_ROOT: resolve(ROOT, '..', '00-体例与规范'),
    ARK_BASE_URL: providerBase, ARK_API_KEY: 'local-regression-no-paid-key', ARK_MODEL: 'software-only-refused',
    ARK_CONTEXT: '0', ARK_CASES: '0', ARK_CONSISTENCY: '0', ARK_PREFIX_CACHE: '0',
    NODE_OPTIONS: `--require "${GUARD.replace(/\\/g, '/')}"`,
  });
}

/** Guard code is created only inside this run; no existing tool or gate is edited. */
function preloadSource() {
  const configuration = { base: BASE, port: PORT, eventDirectory: EVENTS, guard: GUARD, providerBase, roots: ROOTS };
  return String.raw`'use strict';
const config = ${JSON.stringify(configuration)};
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const eventFile = path.join(config.eventDirectory, process.pid + '.jsonl');
let sequence = 0;
function record(type, value = {}) {
  fs.appendFileSync(eventFile, JSON.stringify({type, pid:process.pid, at:new Date().toISOString(), sequence:sequence++, ...value}) + '\n');
}
const loopback = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host || '').toLowerCase());
const protectedPort = (port) => [3210,3211,3212].includes(Number(port));
function denied(message, details) { record('blocked', details); const error = new Error(message); error.code = 'ISOLATED_REGRESSION_BLOCKED'; return error; }
const nativeFetch = globalThis.fetch;
globalThis.fetch = function(input, init) {
  let url;
  try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url); }
  catch { return Promise.reject(denied('Isolation denied an invalid fetch URL', {surface:'fetch'})); }
  if (url.protocol !== 'http:' || !loopback(url.hostname)) return Promise.reject(denied('Isolation denied external fetch', {surface:'fetch', protocol:url.protocol, host:url.hostname}));
  const method = String(init?.method || input?.method || 'GET').toUpperCase();
  if (protectedPort(url.port)) {
    record('redirect', {surface:'fetch', fromPort:Number(url.port), toPort:config.port, method, path:url.pathname});
    url.hostname = '127.0.0.1'; url.port = String(config.port);
    input = typeof input === 'string' || input instanceof URL ? url.href : new Request(url, input);
  }
  if (/(?:responses|chat\/completions)$/.test(url.pathname)) record('local-provider-request', {method, path:url.pathname, port:Number(url.port)});
  // Raw socket enforcement below also guards automatic redirect destinations.
  return nativeFetch(input, init);
};
const nativeConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const options = typeof first === 'object' && first !== null ? first : {port:first, host:typeof normalized[1] === 'string' ? normalized[1] : 'localhost'};
  if (!options.path) {
    const host = options.host || options.hostname || 'localhost';
    if (!loopback(host) || protectedPort(options.port)) throw denied('Isolation denied an unowned or external socket', {surface:'socket', host:String(host), port:Number(options.port) || null});
  }
  return nativeConnect.apply(this, args);
};
const nativeListen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  const first = args[0];
  const options = typeof first === 'object' && first !== null ? first : {port:first, host:typeof args[1] === 'string' ? args[1] : null};
  if (protectedPort(options.port)) throw denied('Isolation denied listening on an existing app port', {surface:'listen', port:Number(options.port)});
  return nativeListen.apply(this, args);
};
function childOptions(command, args, options = {}) {
  const binary = path.basename(String(command)).toLowerCase();
  const script = Array.isArray(args) ? args.find((arg) => typeof arg === 'string' && /\.(?:mjs|cjs|js)$/.test(arg)) : null;
  if (script && path.basename(script) === 'verify-render.mjs' && !args.includes('--check')) {
    record('browser-not-run', {task:'verify-render', reason:'Existing browser tabs are outside the isolated controller'});
    const error = new Error('ISOLATED_BROWSER_NOT_RUN: verify-render requires a separately owned browser tab');
    error.code = 'ISOLATED_BROWSER_NOT_RUN'; error.status = 97; error.stdout = ''; error.stderr = error.message; throw error;
  }
  if (!['node','node.exe','powershell','powershell.exe'].includes(binary)) throw denied('Isolation denied an external executable', {surface:'child-process', binary});
  const environment = {...(options.env || process.env)};
  for (const name of Object.keys(environment)) {
    if (/(?:OPENAI|DOUBAO|VOLC|ANTHROPIC|AZURE_OPENAI|GEMINI|DEEPSEEK|PROXY)/i.test(name)
        || /^(?:NODE_OPTIONS|NODE_USE_ENV_PROXY)$/i.test(name)
        || /(?:API_KEY|ACCESS_TOKEN|SECRET|CREDENTIAL)/i.test(name) && name !== 'ARK_API_KEY') delete environment[name];
  }
  let localProvider = false;
  try { const url = new URL(environment.ARK_BASE_URL); localProvider = url.protocol === 'http:' && loopback(url.hostname) && !protectedPort(url.port); } catch {}
  if (!localProvider || !/^local[-_]/.test(environment.ARK_API_KEY || '')) {
    environment.ARK_BASE_URL = config.providerBase; environment.ARK_API_KEY = 'local-regression-no-paid-key';
  }
  const isolatedRoots = {DSH_SESSION_ROOT:config.roots.sessions,DSH_WORKING_VERSION_ROOT:config.roots.versions,DSH_WORKSPACE_ROOT:config.roots.workspaces,DSH_AUDIT_ROOT:config.roots.audit,DSH_LEGACY_ROOT:config.roots.legacy,DSH_INGESTION_ROOT:config.roots.ingestion,DSH_JOB_ROOT:config.roots.jobs,DSH_ARK_EXECUTION_ROOT:config.roots.arkExecutions,DSH_REVIEW_PLAN_ROOT:config.roots.reviewPlans};
  for (const [name, root] of Object.entries(isolatedRoots)) if (!environment[name]) environment[name] = root;
  if (!environment.DSH_REVIEW_WORKERS) environment.DSH_REVIEW_WORKERS = '2';
  record('child-store-roots', {script:script ? path.basename(script) : 'inline-or-helper',
    roots:Object.fromEntries(Object.keys(isolatedRoots).map((name)=>[name,environment[name]]))});
  if (binary === 'node' || binary === 'node.exe') environment.NODE_OPTIONS = '--require "' + config.guard.replace(/\\/g, '/') + '"';
  return {options:{...options, env:environment, windowsHide:true}, binary, script:script ? path.basename(script) : 'inline-or-helper'};
}
function track(child, info) {
  if (child.pid) record('child-start', {childPid:child.pid,binary:info.binary,script:info.script});
  child.once('exit', (code, signal) => record('child-exit', {childPid:child.pid,code,signal}));
  return child;
}
const nativeSpawn = cp.spawn;
cp.spawn = function(command, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  const info = childOptions(command,args,options);
  return track(nativeSpawn(command,args,info.options),info);
};
const nativeExecFile = cp.execFile;
cp.execFile = function(command, args, options, callback) {
  if (!Array.isArray(args)) { callback = typeof options === 'function' ? options : typeof args === 'function' ? args : callback; options = typeof args === 'object' ? args : {}; args = []; }
  else if (typeof options === 'function') { callback = options; options = {}; }
  const info = childOptions(command,args,options);
  return track(nativeExecFile(command,args,info.options,callback),info);
};
cp.execFile[Symbol.for('nodejs.util.promisify.custom')] = function(command,args,options) {
  let child;
  const promise = new Promise((done,fail) => {child = cp.execFile(command,args,options,(error,stdout,stderr)=>{if(error){error.stdout=stdout;error.stderr=stderr;fail(error);}else done({stdout,stderr});});});
  promise.child = child; return promise;
};
const nativeExecFileSync = cp.execFileSync;
cp.execFileSync = function(command,args,options) {const info=childOptions(command,args,options);return nativeExecFileSync(command,args,info.options);};
const nativeSpawnSync = cp.spawnSync;
cp.spawnSync = function(command,args,options) {const info=childOptions(command,args,options);return nativeSpawnSync(command,args,info.options);};
cp.exec = cp.execSync = function() {throw denied('Isolation denied shell execution', {surface:'shell'});};
const nativeFork = cp.fork;
cp.fork = function(modulePath,args,options) {if(!Array.isArray(args)){options=args;args=[];}const info=childOptions(process.execPath,[modulePath,...args],options);return track(nativeFork(modulePath,args,info.options),info);};
syncBuiltinESMExports();
record('guard-loaded', {script:path.basename(process.argv[1] || 'inline-node'), credentials:'local-only', network:'loopback-only',
  jobRoot:process.env.DSH_JOB_ROOT || null});
`;
}

async function reservePort() {
  const probe = createNetServer();
  await new Promise((done, fail) => { probe.once('error', fail); probe.listen(PORT, '127.0.0.1', done); });
  await new Promise((done, fail) => probe.close((error) => error ? fail(error) : done()));
  check('Port 3340 was unused; no existing service was accessed or replaced', true);
}
async function startProvider() {
  provider = createHttpServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    providerRequests.push({ at: new Date().toISOString(), method: request.method, path: url.pathname });
    request.resume();
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'ISOLATED_MODEL_CALL_FORBIDDEN', type: 'software-test' } }));
  });
  provider.on('connection', (socket) => { providerSockets.add(socket); socket.once('close', () => providerSockets.delete(socket)); });
  await new Promise((done, fail) => { provider.once('error', fail); provider.listen(0, '127.0.0.1', done); });
  providerBase = `http://127.0.0.1:${provider.address().port}/api/v3`;
  report.provider = { base: providerBase, policy: 'Reject every request with HTTP 403; record only time, method and path', requestCount: 0 };
}
function startChild(script, environment, name) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  report.processes.push({ event: 'start', name, pid: child.pid, at: new Date().toISOString() });
  child.once('exit', (code, signal) => { report.processes.push({ event: 'exit', name, pid: child.pid, code, signal, at: new Date().toISOString() }); });
  return child;
}
async function guardSelfcheck(environment) {
  const code = "const cp=require('node:child_process'); (async()=>{let n=0;try{await fetch('https://example.invalid/no-network')}catch(e){if(e.code==='ISOLATED_REGRESSION_BLOCKED')n++;}try{cp.execFileSync(process.execPath,['verify-render.mjs'])}catch(e){if(e.code==='ISOLATED_BROWSER_NOT_RUN')n++;}try{require('node:net').connect({port:3210,host:'127.0.0.1'})}catch(e){if(e.code==='ISOLATED_REGRESSION_BLOCKED')n++;}try{cp.execFileSync(process.execPath,['--check','tools/verify-render.mjs']);n++;}catch{}process.exitCode=n===4?0:1;})();";
  const result = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: environment, windowsHide: true, encoding: 'utf8', timeout: 10000 });
  check('Isolation selfcheck blocks external fetch, protected socket and browser execution while allowing syntax checks', result.status === 0,
    { exitCode: result.status, error: result.error?.code || null, diagnostic: result.status === 0 ? null : String(result.stderr || '').slice(0, 1600) });
  if (result.status !== 0) throw new Error('Isolation guard selfcheck failed; no app or regression gate has been started.');
}
async function startApp(environment) {
  const stdoutPath = join(STORAGE, 'app-final-stdout.log'); const stderrPath = join(STORAGE, 'app-final-stderr.log');
  await writeFile(stdoutPath, '', { flag: 'wx' }); await writeFile(stderrPath, '', { flag: 'wx' });
  report.applicationLogs = { stdout: relative(ROOT, stdoutPath), stderr: relative(ROOT, stderrPath), retainedThroughExit: true };
  app = startChild(join(ROOT, 'server.mjs'), environment, 'owned-app');
  let ready = false, launchError = null;
  const log = [];
  app.stdout.on('data', (bytes) => { appendFileSync(stdoutPath, bytes); const text = bytes.toString(); if (!ready) log.push(text); if (text.includes(BASE)) ready = true; });
  app.stderr.on('data', (bytes) => { appendFileSync(stderrPath, bytes); if (!ready) log.push(bytes.toString()); });
  app.once('error', (error) => { launchError = error; });
  const deadline = Date.now() + 30000;
  try {
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Interrupted before readiness');
    if (launchError) throw launchError;
    if (app.exitCode !== null || app.signalCode !== null) throw new Error('Owned app exited before readiness');
    if (ready) {
      try {
        const response = await new Promise((done, fail) => {
          const request = httpRequest({ hostname: '127.0.0.1', port: PORT, path: '/api/health', method: 'GET', timeout: 2000 }, (reply) => {
            const chunks = []; reply.on('data', (chunk) => chunks.push(chunk));
            reply.once('end', () => done({ status: reply.statusCode, bytes: Buffer.concat(chunks) })); reply.once('error', fail);
          });
          request.once('error', fail); request.once('timeout', () => request.destroy(new Error('Owned health timed out'))); request.end();
        });
        if (response.status === 200) {
          const bytes = response.bytes;
          const health = JSON.parse(bytes.toString());
          report.serviceIdentity = { pid: app.pid, sourceRoot: ROOT, serverSourceSha256: hash(await readFile(join(ROOT, 'server.mjs'))),
            reviewModulesSha256: Object.fromEntries(sourceBefore.files.filter((entry) => ['src/review-server.js', 'src/review-runtime.js', 'src/job-store.js'].includes(entry.path)).map((entry) => [entry.path, entry.sha256])),
            emittedOwnAddress: true, healthStatus: response.status, healthSha256: hash(bytes), healthKeys: Object.keys(health),
            providerBase, roots: ROOTS };
          check('Owned app ready with captured PID, source SHA and isolated store roots', true);
          return;
        }
      } catch { /* Await only the child that emitted its own address. */ }
    }
    await sleep(100);
  }
  throw new Error('Owned app did not become ready within 30 seconds');
  } finally {
    await writeFile(join(STORAGE, 'app-start.log'), log.join(''), { flag: 'wx' });
    report.serviceStartLog = relative(RUN, join(STORAGE, 'app-start.log')).replace(/\\/g, '/');
  }
}
async function runGate(environment) {
  gate = startChild(join(ROOT, 'tools', 'verify-all.mjs'), environment, 'verify-all');
  const stdout = [], stderr = [];
  gate.stdout.on('data', (bytes) => { stdout.push(bytes); process.stdout.write(bytes); });
  gate.stderr.on('data', (bytes) => { stderr.push(bytes); process.stderr.write(bytes); });
  const started = Date.now();
  const code = await bounded(new Promise((done, fail) => { gate.once('error', fail); gate.once('close', (exitCode) => done(exitCode)); }), 3600000, 'Full gate exceeded its one-hour controller timeout');
  await writeFile(join(TESTS, `${label}-stdout.log`), Buffer.concat(stdout), { flag: 'wx' });
  await writeFile(join(TESTS, `${label}-stderr.log`), Buffer.concat(stderr), { flag: 'wx' });
  report.gate = { exitCode: code, ms: Date.now() - started };
  const payload = JSON.parse(await readFile(join(ROOT, 'data', 'verify', 'verify-all.json'), 'utf8'));
  if (!payload.generatedAt || Date.parse(payload.generatedAt) < started || !payload.serverUp) throw new Error('Gate output is stale or HTTP group was skipped');
  report.gate.result = payload;
  check('All declared verify-all groups ran, including HTTP', ['core', 'heavy', 'post', 'http'].every((name) => payload.groups.includes(name))
    && payload.serverUp && !payload.suites.some((suite) => suite.skipped));
  check('Original verify-all gate exit code is zero', code === 0, { failing: payload.failing, tolerantFailing: payload.tolerantFailing });
}
async function readEvents() {
  const events = [];
  if (!existsSync(EVENTS)) return events;
  for (const name of await readdir(EVENTS)) {
    if (!name.endsWith('.jsonl')) continue;
    for (const line of (await readFile(join(EVENTS, name), 'utf8')).split('\n').filter(Boolean)) {
      try { events.push(JSON.parse(line)); } catch { report.cleanup.push({ error: 'Malformed controller event', file: name }); }
    }
  }
  return events.sort((a, b) => a.at.localeCompare(b.at) || a.pid - b.pid || a.sequence - b.sequence);
}
async function copyEvidence() {
  const after = await verifyManifest();
  await mkdir(COPIES, { recursive: true });
  for (const [name, current] of after) {
    if (verifyBefore?.get(name)?.sha256 === current.sha256) continue;
    const bytes = await readFile(join(ROOT, 'data', 'verify', name));
    await writeFile(join(COPIES, name), bytes, { flag: 'wx' });
    report.copiedArtifacts.push({ source: `data/verify/${name}`, copy: relative(RUN, join(COPIES, name)).replace(/\\/g, '/'), ...current });
  }
}
async function stopOwned(child, name) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  if (process.platform === 'win32') {
    // The PID comes only from a still-live ChildProcess created above, never a
    // port lookup, app inventory or an arbitrary existing process.
    const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    report.cleanup.push({ name, pid: child.pid, action: 'owned-process-tree-stop', exitCode: killed.status,
      error: killed.status === 0 ? null : String(killed.stderr || killed.error?.code || '').slice(0, 600) });
    if (killed.status !== 0 && child.exitCode === null && child.signalCode === null) {
      const sent = child.kill('SIGKILL');
      report.cleanup.push({ name, pid: child.pid, action: 'owned-child-kill-fallback', signalSent: sent });
    }
  } else child.kill('SIGKILL');
  await bounded(exited, 10000, `Owned child ${name} did not stop`);
}
async function finalize() {
  if (finalizing) return; finalizing = true;
  for (const [child, name] of [[gate, 'verify-all'], [app, 'owned-app']]) {
    try { await stopOwned(child, name); } catch (error) { report.cleanup.push({ name, error: error.message }); }
  }
  if (provider) {
    for (const socket of providerSockets) socket.destroy();
    await new Promise((done) => provider.close(done));
    report.cleanup.push({ name: 'owned-local-refusing-provider', action: 'closed' });
  }
  const events = await readEvents();
  report.isolation = {
    credentialsRemovedByName: [...new Set(removedEnvironmentNames)].sort(), inheritedCredentialValuesRecorded: false,
    guardLoadCount: events.filter((event) => event.type === 'guard-loaded').length,
    redirects: events.filter((event) => event.type === 'redirect'),
    blocked: events.filter((event) => event.type === 'blocked'),
    browserNotRun: events.filter((event) => event.type === 'browser-not-run'),
    localProviderRequests: events.filter((event) => event.type === 'local-provider-request'),
    childStoreRoots: events.filter((event) => event.type === 'child-store-roots'),
    eventsDirectory: relative(RUN, EVENTS).replace(/\\/g, '/'),
  };
  report.provider = { ...report.provider, requestCount: providerRequests.length, requests: providerRequests };
  const starts = events.filter((event) => event.type === 'child-start');
  const ended = new Set(events.filter((event) => event.type === 'child-exit').map((event) => event.childPid));
  const unended = starts.filter((event) => !ended.has(event.childPid));
  const possiblyAlive = unended.filter((event) => { try { process.kill(event.childPid, 0); return true; } catch { return false; } });
  report.cleanup.push({ name: 'guarded-descendants', spawned: starts.length, missingExitEvents: unended.map((event) => event.childPid),
    potentiallyStillAlive: possiblyAlive.map((event) => ({ pid: event.childPid, script: event.script })) });
  check('Owned app and gate stopped; no guarded descendant remains alive', [...children].every((child) => child.exitCode !== null || child.signalCode !== null) && possiblyAlive.length === 0);
  check('Main refusal provider received zero unexpected model calls', providerRequests.length === 0, { localRequestCount: providerRequests.length });
  if (sourceBefore) {
    const sourceAfter = await sourceManifest();
    report.source = { before: sourceBefore, afterSha256: sourceAfter.sha256, unchanged: sourceBefore.sha256 === sourceAfter.sha256 };
    check('Source stayed unchanged throughout the gate', report.source.unchanged);
  }
  if (verifyBefore) { try { await copyEvidence(); } catch (error) { report.copyError = error.message; check('Fresh gate artifacts copied without overwriting evidence', false, error.message); } }
  report.interrupted = interrupted; report.finishedAt = new Date().toISOString();
  report.ok = !report.error && !interrupted && report.checks.every((entry) => entry.ok);
  report.limitations = ['Existing browser-tab rendering check was intentionally blocked. Its original tolerant failure remains visible and is not a pass.',
    'This gate uses deterministic rules and local software fixtures. It does not measure paid-model manuscript quality.'];
  await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Evidence: ${relative(ROOT, OUT)}`);
  process.exitCode = report.ok ? 0 : 1;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true;
  // Stop the still-owned process tree before its parent PID can disappear.
  void stopOwned(gate, 'interrupted-verify-all').catch((error) => report.cleanup.push({ error: error.message }));
});

try {
  await mkdir(TESTS, { recursive: true });
  for (const path of [...Object.values(ROOTS), EVENTS]) await mkdir(path, { recursive: true });
  if (existsSync(COPIES)) throw new Error('Copied evidence directory already exists; no previous evidence will be overwritten.');
  sourceBefore = await sourceManifest(); verifyBefore = await verifyManifest();
  await reservePort(); await startProvider();
  await writeFile(GUARD, preloadSource(), { flag: 'wx' });
  const environment = cleanEnvironment();
  await guardSelfcheck(environment); await startApp(environment); await runGate(environment);
} catch (error) {
  report.error = { name: error.name, code: error.code || null, message: error.message };
  console.error(`Isolated regression failed: ${error.message}`);
} finally {
  await finalize();
}
