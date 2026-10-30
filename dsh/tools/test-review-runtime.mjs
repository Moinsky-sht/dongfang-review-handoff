/** Seven-root, fake-engine runtime tests. No server or model provider is loaded. */
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile, access} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pathToFileURL} from 'node:url';
import {randomUUID, createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

const SCRIPT = fileURLToPath(import.meta.url);
const PROJECT = resolve(dirname(SCRIPT), '..');
const evidenceArg = process.argv.find((arg) => arg.startsWith('--evidence-root='))?.slice('--evidence-root='.length);
const evidenceRoot = resolve(evidenceArg || process.env.DSH_VERIFICATION_EVIDENCE_DIR || join(PROJECT, 'data/verify/review-queue'));
const verificationRunId = process.env.DSH_VERIFICATION_RUN_ID || null;
const testRoot = join(evidenceRoot, `runtime-${Date.now()}-${randomUUID()}`);
const childConfig = process.env.DSH_RUNTIME_TEST_CONFIG && JSON.parse(process.env.DSH_RUNTIME_TEST_CONFIG);
const ROOT = childConfig?.base || testRoot;
await mkdir(ROOT, {recursive: true});
const ENV_ROOTS = {DSH_JOB_ROOT: 'jobs', DSH_SESSION_ROOT: 'sessions', DSH_WORKING_VERSION_ROOT: 'versions',
  DSH_WORKSPACE_ROOT: 'workspaces', DSH_AUDIT_ROOT: 'audit', DSH_LEGACY_ROOT: 'legacy', DSH_INGESTION_ROOT: 'ingestions'};
for (const [key, leaf] of Object.entries(ENV_ROOTS)) process.env[key] = join(ROOT, leaf);
const sourceRoot=resolve(process.argv.find(arg=>arg.startsWith('--source-root='))?.slice(14)||PROJECT);
const store = await import(pathToFileURL(join(sourceRoot,'src/job-store.js')));
const {createReviewRuntime} = await import(pathToFileURL(join(sourceRoot,'src/review-runtime.js')));
const {saveSessionSnapshot, loadSessionSnapshot} = await import('../src/session-store.js');
const {saveWorkingVersion, loadWorkingVersion} = await import('../src/working-version.js');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const terminal = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function roots(base) {
  return {storageRoot: join(base, 'jobs'), sessionRoot: join(base, 'sessions'), versionRoot: join(base, 'versions'),
    workspaceRoot: join(base, 'workspaces'), auditRoot: join(base, 'audit'), legacyRoot: join(base, 'legacy'),
    ingestionRoot: join(base, 'ingestions')};
}

async function until(action, message, timeout = 60000) {
  const end = Date.now() + timeout;
  let latest;
  while (Date.now() < end) {
    latest = await action();
    if (latest) return latest;
    await sleep(25);
  }
  throw new Error(`Timed out: ${message}`);
}

async function gateOrAbort(promise, signal) {
  if (signal.aborted) throw signal.reason || new Error('cancelled');
  let abort;
  const cancelled = new Promise((done, reject) => {
    abort = () => reject(signal.reason || new Error('cancelled'));
    signal.addEventListener('abort', abort, {once: true});
  });
  try { await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

function result(tag = 'fake') {
  return {issues: [{ruleId: 'RUNTIME-FAKE', location: '软件测试', quote: tag}],
    summary: {total: 1}, recheck: {byKey: new Map([['fake', {verdict: 'agree', reason: tag}]])},
    generatedAt: new Date().toISOString(), usage: {totalTokens: 0}};
}

async function fixture(args, label = 'one') {
  const sessionId = `s${randomUUID().replaceAll('-', '')}`;
  const buffer = Buffer.from(`runtime immutable software fixture ${label}`);
  const workVersion = await saveWorkingVersion({sessionId, name: '软件合约测试.docx', buffer,
    originalBuffer: buffer, storageRoot: args.versionRoot});
  await saveSessionSnapshot({sessionId, storageRoot: args.sessionRoot, expectedRevision: -1,
    snapshot: {id: sessionId, name: '软件合约测试.docx', workVersion, mutationEpoch: 0, reviewRunning: false,
      clean: {status: 'unchanged', validatedVersionId: workVersion.id, workSha256: workVersion.sha256,
        sourceSha256: workVersion.sourceSha256}, reviewRecords: [], result: null}});
  return {operationId: `operation-${label}`, sessionId, binding: {versionId: workVersion.id,
    sourceSha256: workVersion.sourceSha256, workSha256: workVersion.sha256, mutationEpoch: 0},
    config: {useModel: false, useRecheck: false, useContext: false, useCases: false}, purpose: 'software-verification'};
}

function publisher(args, extra = {}) {
  return async ({job, outcome, leaseToken}) => {
    if (extra.before) await extra.before({job, outcome, leaseToken});
    const saved = await loadSessionSnapshot({sessionId: job.sessionId, storageRoot: args.sessionRoot});
    const version = await loadWorkingVersion({sessionId: job.sessionId, versionId: job.binding.versionId, storageRoot: args.versionRoot});
    assert.equal(version.version.sha256, job.binding.workSha256);
    assert.equal(version.version.sourceSha256, job.binding.sourceSha256);
    assert.equal(saved.snapshot.workVersion.id, job.binding.versionId);
    assert.equal(saved.snapshot.mutationEpoch, job.binding.mutationEpoch);
    const state = saved.snapshot;
    if (state.materializedJobId !== job.id) {
      state.materializedJobId = job.id;
      state.materializedStatus = outcome.status;
      state.reviewRunId = job.id;
      state.reviewRunning = false;
      if (['completed', 'partial'].includes(outcome.status)) {
        state.result = outcome.result; state.resultRunId = job.id; state.resultVersionId = job.binding.versionId;
      }
      await saveSessionSnapshot({sessionId: job.sessionId, snapshot: state,
        storageRoot: args.sessionRoot, expectedRevision: saved.manifest.revision});
    }
    if (extra.after) await extra.after({job, outcome, leaseToken});
    return {jobRunId: job.id, versionId: job.binding.versionId, terminalData: {issues: outcome.result?.issues || [],
      summary: outcome.result?.summary || null, reviewRunId: job.id}};
  };
}

async function startChild(config) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^DSH_/i.test(key)
    && !/(?:ARK|OPENAI|ANTHROPIC).*(?:KEY|TOKEN)|^(?:NODE_OPTIONS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$/i.test(key)));
  for (const [key, leaf] of Object.entries(ENV_ROOTS)) environment[key] = join(config.base, leaf);
  environment.DSH_RUNTIME_TEST_CONFIG = JSON.stringify(config);
  const child = spawn(process.execPath, [SCRIPT, '--child'], {cwd: PROJECT, windowsHide: true,
    env: environment, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => stdout += data);
  child.stderr.on('data', (data) => stderr += data);
  const exited = new Promise((done, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => done({code, signal, stdout, stderr}));
  });
  return {child, exited, output: () => ({stdout, stderr})};
}

if (process.argv.includes('--child')) {
  const args = roots(childConfig.base);
  const runtime = await createReviewRuntime({storeArgs: args, pollMs: 250, flushMs: 5,
    execute: async ({job, signal, emit}) => {
      emit('doc', {id: job.sessionId, doc: {paragraphs: []}});
      emit('progress', {phase: 'fake-running', message: '软件执行器运行中'});
      if (childConfig.marker) await writeFile(childConfig.marker, JSON.stringify({jobId: job.id, pid: process.pid}));
      if (childConfig.mode === 'hold') {
        await new Promise((done, reject) => {
          const abort = () => reject(signal.reason || new Error('cancelled'));
          signal.addEventListener('abort', abort, {once: true});
          if (signal.aborted) abort();
        });
      }
      return {status: 'completed', result: result('child')};
    }, publish: publisher(args, {
      before: childConfig.mode === 'crash-before-publication' ? () => process.exit(85) : null,
      after: childConfig.mode === 'crash-after-publication' ? () => process.exit(86) : null,
    })});
  // Keep the child alive independently of the runtime's intentionally unref'ed timer.
  const keepAlive = setInterval(() => {}, 1000);
  await until(async () => terminal.has((await store.loadJob({...args, jobId: childConfig.jobId})).status), 'child terminal', 90000);
  clearInterval(keepAlive); await runtime.close();
} else {
  const report = {generatedAt: new Date().toISOString(), verificationRunId, evidenceRoot, base: ROOT,
    rootCount: 7, modelCalls: 0, realArkCalls: 0, sourceRoot, checks: [], moduleSha256: sha(await readFile(join(sourceRoot,'src/review-runtime.js')))};
  const runtimes = new Set(), children = new Set();
  const keepAlive = setInterval(() => {}, 1000);
  async function fresh(name) {
    const base = join(ROOT, name); await mkdir(base); const args = roots(base);
    await Promise.all(Object.values(args).map((path) => mkdir(path)));
    return {base, args};
  }
  async function runtime(options) {
    const item = await createReviewRuntime(options);
    const wait = item.waitForTerminal;
    item.waitForTerminal = async (args) => {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new Error(`Timed out waiting for ${args.jobId}`)), 60000);
      try { return await wait({...args, signal: args.signal || controller.signal}); }
      finally { clearTimeout(deadline); }
    };
    runtimes.add(item); return item;
  }
  async function check(name, action) {
    const start = Date.now();
    try { await action(); report.checks.push({name, ok: true, elapsedMs: Date.now() - start}); console.log(`PASS ${name}`); }
    catch (error) { report.checks.push({name, ok: false, error: error.stack, elapsedMs: Date.now() - start}); throw error; }
  }
  try {
    await check('before-claim pool gate leaves model batch queued and permits rule-only work across restart', async()=>{
      const {args}=await fresh('preclaim-blocked');
      const modelSpecs=[await fixture(args,'blocked-first'),await fixture(args,'blocked-second')].map(spec=>({...spec,config:{...spec.config,useModel:true}}));
      const rules=await fixture(args,'allowed-rules');
      await store.initializeJobStore(args);
      const batch=await store.startBatch({...args,workspaceId:'wblocked',operationId:'blocked-batch',jobs:modelSpecs});
      const {job:ruleJob}=await store.enqueueJob({...args,...rules});const called=[];
      const reason={code:'ARK_EXECUTION_BLOCKED',message:'Fixed software unknown send saturation',poolId:'software',unknownSentCount:2,concurrency:2};
      const beforeClaim=async({jobs})=>{const blocked=jobs.filter(job=>job.status==='queued'&&job.config.useModel);for(const id of new Set(blocked.map(job=>job.batchId).filter(Boolean)))await store.pauseBatch({...args,batchId:id,reason});return{excludedJobIds:blocked.map(job=>job.id)};};
      let rt=await runtime({storeArgs:args,autoStart:false,beforeClaim,execute:async({job})=>{called.push(job.id);return{status:'completed',result:result()};},publish:publisher(args)});
      await until(async()=>{await rt.pump();return(await store.loadJob({...args,jobId:ruleJob.id})).status==='completed';},'rule-only remains usable under model pool block');
      assert.deepEqual(called,[ruleJob.id]);assert(batch.jobs.every(job=>!called.includes(job.id)));
      const paused=await store.loadBatch({...args,batchId:batch.batch.id});assert.equal(paused.paused,true);assert.deepEqual(paused.pauseReason,reason);
      assert((await store.listJobs({...args,batchId:batch.batch.id})).every(job=>job.status==='queued'&&job.lease===null));
      const revision=(await store.loadReviewQueueSnapshot({...args,workspaceId:'wblocked'})).revision;await rt.pump();await rt.pump();
      assert.equal((await store.loadReviewQueueSnapshot({...args,workspaceId:'wblocked'})).revision,revision,'Stable saturation observations must not rewrite the ledger');await rt.close();
      rt=await runtime({storeArgs:args,autoStart:false,execute:async()=>{throw Error('Restart may not run a durably paused model batch');},publish:publisher(args)});
      await rt.pump();assert((await store.listJobs({...args,batchId:batch.batch.id})).every(job=>job.status==='queued'));
      assert.deepEqual((await store.loadBatch({...args,batchId:batch.batch.id})).pauseReason,reason);await rt.close();
    });
    await check('failed canonical pool admission closes before any job claim or executor call',async()=>{
      const {args}=await fresh('preclaim-error'),spec=await fixture(args);await store.initializeJobStore(args);const {job}=await store.enqueueJob({...args,...spec});let calls=0;
      const rt=await runtime({storeArgs:args,autoStart:false,beforeClaim:async()=>{throw Object.assign(Error('Fixed canonical pool read failure'),{code:'ARK_LEDGER_HASH_MISMATCH'});},execute:async()=>{calls++;return{status:'completed',result:result()};},publish:publisher(args)});
      await assert.rejects(rt.pump(),{code:'ARK_LEDGER_HASH_MISMATCH'});assert.equal(calls,0);const stored=await store.loadJob({...args,jobId:job.id});assert.equal(stored.status,'queued');assert.equal(stored.lease,null);await rt.close();
    });
    await check('durable replay, disconnected view, batched events and typed Map outcome', async () => {
      const {args} = await fresh('replay'); const spec = await fixture(args);
      let calls = 0, release; const gate = new Promise((done) => release = done);
      const rt = await runtime({storeArgs: args, pollMs: 25, flushMs: 5, eventBatchSize: 8,
        execute: async ({job, emit, signal}) => {
          calls += 1; emit('doc', {id: job.sessionId});
          for (let n = 0; n < 75; n += 1) emit('issue', {issue: {ruleId: `FAKE-${n}`}});
          emit('progress', {phase: 'blocked', message: 'waiting'}); await gateOrAbort(gate, signal);
          return {status: 'completed', result: result()};
        }, publish: publisher(args)});
      const {job} = await rt.enqueue(spec); const events = [];
      const detach = await rt.observe({jobId: job.id, onEvent: (event) => events.push(event)});
      await until(() => events.length >= 77, 'saved issue prefix');
      rt.closeLocalView(detach); const savedPrefix = events.at(-1).seq;
      release(); const done = await rt.waitForTerminal({jobId: job.id}); assert.equal(done.status, 'completed');
      assert.equal(calls, 1); const replay = [];
      const stop = await rt.observe({jobId: job.id, afterSeq: savedPrefix, onEvent: (event) => replay.push(event)});
      assert.equal(replay.filter((event) => event.type === 'done').length, 1);
      assert.ok(replay.every((event) => event.seq > savedPrefix && event.jobRunId === job.id)); stop();
      const outcome = await rt.getOutcome({jobId: job.id}); assert.ok(outcome.result.recheck.byKey instanceof Map);
      const state = await loadSessionSnapshot({sessionId: spec.sessionId, storageRoot: args.sessionRoot});
      assert.ok(state.snapshot.result.recheck.byKey instanceof Map);
      const all = await rt.readEvents({jobId: job.id}); assert.equal(all.length, 78);
      assert.deepEqual(all.map((event) => event.seq), Array.from({length: 78}, (_, n) => n + 1));
      await rt.close();
    });

    for (const phase of ['publishing', 'completed']) await check(`renewal crossing its own ${phase} outbox is a proven completion race`, async () => {
      const {args} = await fresh(`renewal-${phase}`); const spec = await fixture(args);
      let releaseExecute, releaseRenew, releasePublish, renewing = false, aborted = false, conflict = null, renewalToken;
      const executeGate = new Promise((done) => releaseExecute = done);
      const renewGate = new Promise((done) => releaseRenew = done);
      const publishGate = new Promise((done) => releasePublish = done);
      const barrier = {...store, renewJobLease: async (value) => {
        renewing = true; renewalToken = value.leaseToken; await renewGate;
        try { return await store.renewJobLease(value); }
        catch (error) { conflict = error.code; throw error; }
      }};
      const rt = await runtime({storeArgs: args, store: barrier, pollMs: 25,
        execute: async ({signal}) => {
          signal.addEventListener('abort', () => { aborted = true; }, {once: true});
          await gateOrAbort(executeGate, signal); return {status: 'completed', result: result('completion-race')};
        }, publish: publisher(args, {before: phase === 'publishing' ? () => publishGate : null})});
      try {
        const {job} = await rt.enqueue(spec); await until(() => renewing, 'renewal reaches deterministic barrier');
        releaseExecute(); await until(async () => (await store.loadJob({...args, jobId: job.id})).status === phase, `own outbox reaches ${phase}`);
        releaseRenew(); await rt.pump();
        assert.equal(conflict, 'JOB_LEASE_CONFLICT', 'barrier must actually cross the renewal CAS');
        assert.equal(aborted, false, 'proven own completion must not abort the executor');
        assert.equal(rt.errors.filter((error) => error.phase === 'lease').length, 0);
        releasePublish(); const done = await rt.waitForTerminal({jobId: job.id}); assert.equal(done.status, 'completed');
        const saved = await store.loadJob({...args, jobId: job.id});
        assert.equal(saved.outcomeReceipt.leaseToken, renewalToken);
      } finally { releaseExecute(); releaseRenew(); releasePublish(); await rt.close(); }
    });

    await check('wrong-token renewal while still running aborts and reports a real lease conflict', async () => {
      const {args} = await fresh('renewal-lost'); const spec = await fixture(args); let aborted = false, reason = null;
      const rejected = {...store, renewJobLease: (value) => store.renewJobLease({...value, leaseToken: randomUUID()})};
      const rt = await runtime({storeArgs: args, store: rejected, pollMs: 25,
        execute: async ({signal}) => {
          await new Promise((done, reject) => signal.addEventListener('abort', () => {
            aborted = true; reason = signal.reason?.code; reject(signal.reason);
          }, {once: true}));
          return {status: 'completed', result: result('must-not-complete')};
        }, publish: publisher(args)});
      const {job} = await rt.enqueue(spec); const done = await rt.waitForTerminal({jobId: job.id});
      assert.equal(aborted, true); assert.equal(reason, 'REVIEW_LEASE_LOST');
      assert.ok(rt.errors.some((error) => error.phase === 'lease' && error.code === 'JOB_LEASE_CONFLICT'));
      assert.equal(done.status, 'cancelled');
      assert.notEqual((await store.loadJobOutcome({...args, jobId: job.id})).status, 'completed');
      await rt.close();
    });

    await check('real peer remains running; another process cancels before done', async () => {
      const {base, args} = await fresh('peer-cancel'); const spec = await fixture(args);
      await store.initializeJobStore({...args, documentWorkerLimit: 1});
      const {job} = await store.enqueueJob({...args, ...spec});
      const marker = join(base, 'running.json'); const child = await startChild({base, jobId: job.id, mode: 'hold', marker}); children.add(child);
      await until(async () => { try { await access(marker); return true; } catch { return false; } }, 'peer executing');
      let duplicate = 0; const peer = await runtime({storeArgs: args, pollMs: 250,
        execute: async () => { duplicate += 1; throw new Error('peer cannot execute a live run'); }, publish: publisher(args)});
      await peer.pump(); const live = await peer.getJob({jobId: job.id});
      assert.equal(live.status, 'running'); assert.equal(duplicate, 0);
      const requested = await peer.cancel({jobId: job.id}); assert.equal(requested.cancelRequested, true);
      assert.equal((await store.loadJob({...args, jobId: job.id})).cancelRequested, true);
      const done = await peer.waitForTerminal({jobId: job.id}); assert.equal(done.status, 'cancelled');
      const exited = await child.exited; children.delete(child); assert.equal(exited.code, 0, exited.stderr);
      assert.equal(duplicate, 0); await peer.close();
    });

    await check('global cap and per-session FIFO hold across the shared runtime scheduler', async () => {
      const {args} = await fresh('fifo-cap'); const one = await fixture(args, 'one');
      const two = await fixture(args, 'two'); const three = await fixture(args, 'three');
      const gates = new Map(), starts = []; let active = 0, maximum = 0;
      for (const spec of [one, two, three]) {
        let release; const promise = new Promise((done) => release = done); gates.set(spec.operationId, {promise, release});
      }
      const rt = await runtime({storeArgs: {...args, documentWorkerLimit: 2}, pollMs: 25,
        execute: async ({job, signal}) => {
          starts.push(job.operationId); active += 1; maximum = Math.max(maximum, active);
          await gateOrAbort(gates.get(job.operationId).promise, signal); active -= 1;
          return {status: 'completed', result: result(job.operationId)};
        }, publish: publisher(args)});
      const a = await rt.enqueue(one), b = await rt.enqueue(two), c = await rt.enqueue(three);
      await assert.rejects(rt.enqueue({...one, operationId: 'overlapping-session-run'}), {code: 'JOB_SESSION_BUSY'});
      await until(() => starts.length === 2, 'two eligible documents start');
      assert.deepEqual(starts, ['operation-one', 'operation-two']);
      assert.equal((await rt.getJob({jobId: c.job.id})).status, 'queued');
      gates.get(one.operationId).release(); await rt.waitForTerminal({jobId: a.job.id});
      await until(() => starts.includes(three.operationId), 'FIFO next document after materialization');
      gates.get(two.operationId).release(); gates.get(three.operationId).release();
      await rt.waitForTerminal({jobId: b.job.id}); await rt.waitForTerminal({jobId: c.job.id});
      assert.equal(maximum, 2); assert.equal(starts.length, 3); await rt.close();
    });

    await check('durable cancellation beats a late successful engine return', async () => {
      const {args} = await fresh('late-done'); const spec = await fixture(args); let release, began = false;
      const gate = new Promise((done) => release = done);
      const rt = await runtime({storeArgs: args, pollMs: 25,
        execute: async () => { began = true; await gate; return {status: 'completed', result: result()}; },
        publish: publisher(args)});
      const {job} = await rt.enqueue(spec); await until(() => began, 'late engine starts');
      await rt.cancel({jobId: job.id}); release(); const done = await rt.waitForTerminal({jobId: job.id});
      assert.equal(done.status, 'cancelled');
      assert.equal((await rt.getOutcome({jobId: job.id})).status, 'cancelled');
      assert.deepEqual((await rt.readEvents({jobId: job.id})).map((event) => event.type), ['cancelled']);
      await rt.close();
    });

    await check('persisted batch pause survives a new runtime and gates the next document', async () => {
      const {args} = await fresh('batch-pause'); const one = await fixture(args, 'one'), two = await fixture(args, 'two');
      await store.initializeJobStore({...args, documentWorkerLimit: 1});
      const proposal = {...args, operationId: 'batch-operation', workspaceId: 'wfixture', jobs: [one, two]};
      const batch = await store.startBatch(proposal); await store.pauseBatch({...args, batchId: batch.batch.id});
      const started = []; let release; const gate = new Promise((done) => release = done);
      const rt = await runtime({storeArgs: args, pollMs: 25,
        execute: async ({job, signal}) => {
          started.push(job.id); if (job.id === batch.jobs[0].id) await gateOrAbort(gate, signal);
          return {status: 'completed', result: result()};
        }, publish: publisher(args)});
      await rt.pump(); assert.equal(started.length, 0);
      assert.equal((await rt.startBatch(proposal)).replayed, true);
      await rt.resumeBatch({batchId: batch.batch.id}); await until(() => started.length === 1, 'resumed first batch document');
      await rt.pauseBatch({batchId: batch.batch.id}); release();
      await rt.waitForTerminal({jobId: batch.jobs[0].id}); await rt.pump();
      assert.equal((await rt.getJob({jobId: batch.jobs[1].id})).status, 'queued'); assert.equal(started.length, 1);
      await rt.resumeBatch({batchId: batch.batch.id}); await rt.waitForTerminal({jobId: batch.jobs[1].id});
      assert.equal(started.length, 2); assert.equal((await store.loadBatch({...args, batchId: batch.batch.id})).status, 'completed');
      await rt.close();
    });

    for (const mode of ['crash-before-publication', 'crash-after-publication']) await check(`${mode} replays outbox without executing again`, async () => {
      const {base, args} = await fresh(mode); const spec = await fixture(args);
      await store.initializeJobStore(args); const {job} = await store.enqueueJob({...args, ...spec});
      const child = await startChild({base, jobId: job.id, mode}); children.add(child);
      const exited = await child.exited; children.delete(child);
      assert.equal(exited.code, mode === 'crash-before-publication' ? 85 : 86, exited.stderr);
      assert.equal((await store.loadJob({...args, jobId: job.id})).status, 'publishing');
      let calls = 0; const rt = await runtime({storeArgs: args, pollMs: 250,
        execute: async () => { calls += 1; throw new Error('outbox cannot rerun the engine'); }, publish: publisher(args)});
      const done = await rt.waitForTerminal({jobId: job.id}); assert.equal(done.status, 'completed'); assert.equal(calls, 0);
      const state = await loadSessionSnapshot({sessionId: spec.sessionId, storageRoot: args.sessionRoot});
      assert.equal(state.snapshot.materializedJobId, job.id);
      assert.equal(state.manifest.revision, 1, 'software publication replay must not rewrite the session');
      assert.equal((await rt.readEvents({jobId: job.id})).filter((event) => event.type === 'done').length, 1);
      await rt.close();
    });

    await check('dead execution owner becomes interrupted and never silently reruns', async () => {
      const {base, args} = await fresh('dead-owner'); const spec = await fixture(args);
      await store.initializeJobStore(args); const {job} = await store.enqueueJob({...args, ...spec});
      const marker = join(base, 'running.json'); const child = await startChild({base, jobId: job.id, mode: 'hold', marker}); children.add(child);
      await until(async () => { try { await access(marker); return true; } catch { return false; } }, 'dead-owner executing');
      child.child.kill(); await child.exited; children.delete(child);
      let calls = 0; const rt = await runtime({storeArgs: args, pollMs: 250,
        execute: async () => { calls += 1; throw new Error('interrupted cannot silently rerun'); }, publish: publisher(args)});
      const done = await rt.waitForTerminal({jobId: job.id}); assert.equal(done.status, 'interrupted'); assert.equal(calls, 0);
      await rt.close();
    });

    await check('event-save failure aborts engine and cannot publish completed', async () => {
      const {args} = await fresh('flush-failure'); const spec = await fixture(args); let aborted = false;
      const failing = {...store, appendJobEvents: async () => { throw new Error('injected event persistence failure'); }};
      const rt = await runtime({storeArgs: args, store: failing, pollMs: 25, flushMs: 0,
        execute: async ({signal, emit}) => {
          emit('progress', {phase: 'fake'});
          await new Promise((done) => { signal.addEventListener('abort', () => { aborted = true; done(); }, {once: true}); });
          return {status: 'completed', result: result()};
        }, publish: publisher(args)});
      const {job} = await rt.enqueue(spec); const done = await rt.waitForTerminal({jobId: job.id});
      assert.equal(done.status, 'failed'); assert.equal(aborted, true);
      assert.match((await rt.getOutcome({jobId: job.id})).error, /进度记录保存失败/);
      assert.equal((await rt.readEvents({jobId: job.id})).filter((event) => event.type === 'done').length, 0);
      await rt.close();
    });

    await check('invalid publication receipt leaves recoverable publishing and emits no terminal', async () => {
      const {args} = await fresh('receipt-failure'); const spec = await fixture(args); let allow = false;
      const rt = await runtime({storeArgs: args, pollMs: 25,
        execute: async () => ({status: 'partial', result: result()}),
        publish: async (value) => allow ? publisher(args)(value) : ({jobRunId: 'wrong', versionId: value.job.binding.versionId})});
      const {job} = await rt.enqueue(spec);
      await until(() => rt.errors.some((error) => error.code === 'REVIEW_PUBLICATION_RECEIPT'), 'invalid receipt rejected');
      assert.equal((await rt.getJob({jobId: job.id})).status, 'publishing');
      assert.equal((await rt.readEvents({jobId: job.id})).filter((event) => ['done', 'error', 'cancelled'].includes(event.type)).length, 0);
      allow = true; await rt.pump(); const done = await rt.waitForTerminal({jobId: job.id}); assert.equal(done.status, 'partial');
      await rt.close();
    });
  } finally {
    for (const child of children) { child.child.kill(); await child.exited.catch(() => {}); }
    for (const rt of runtimes) await rt.close().catch(() => {});
    clearInterval(keepAlive);
    report.finishedAt = new Date().toISOString(); report.ok = report.checks.every((item) => item.ok);
    report.testSha256 = sha(await readFile(SCRIPT));
    await writeFile(join(ROOT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`REPORT ${join(ROOT, 'report.json')}`);
  }
}
