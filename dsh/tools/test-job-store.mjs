/** Isolated durable-queue tests: library subprocesses only, no HTTP or model. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink, symlink } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {pathToFileURL} from 'node:url';
import { saveSessionSnapshot, loadSessionSnapshot } from '../src/session-store.js';

const SCRIPT = fileURLToPath(import.meta.url); const ROOT = resolve(dirname(SCRIPT), '..');
const sourceRoot=resolve(process.argv.find(arg=>arg.startsWith('--source-root='))?.slice(14)||ROOT);
const store=await import(pathToFileURL(join(sourceRoot,'src/job-store.js')));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const childMode = process.argv.find((arg) => arg.startsWith('--child='))?.slice(8);
const fixture = (tag = 'one') => {
  const sessionId = `s${tag.replace(/[^a-z0-9]/g, '')}`; const workSha256 = hash(`work-${tag}`);
  return {operationId: `review-${tag}`, workspaceId: 'wfixture', sessionId,
    binding: {versionId: `${sessionId}:v000000-${workSha256}`, workSha256, sourceSha256: hash(`source-${tag}`), mutationEpoch: 0},
    config: {useModel: false, useRecheck: false, useContext: false, useCases: false, model: 'software-only', focus: []}};
};
const bounded = async (promise, ms = 20000) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned fixture deadline exceeded')), ms); })]); } finally { clearTimeout(timer); } };

if (childMode) {
  const config = JSON.parse(process.env.DSH_JOB_TEST_CONFIG); const roots = config.roots;
  const owner = await store.createJobOwner();
  try {
    let value;
    if (childMode === 'enqueue') value = await store.enqueueJob({...roots, ...config.spec});
    else if (childMode === 'claim' || childMode === 'claim-hold') value = await store.claimNextJob({...roots, owner});
    else if (childMode === 'claim-crash') value = await store.claimNextJob({...roots, owner, faultHooks: {[config.hook]: () => process.exit(91)}});
    else if (childMode === 'stage-crash') {
      const job = await store.claimNextJob({...roots, owner});
      value = await store.stageJobOutcome({...roots, jobId: job.id, leaseToken: job.lease.token,
        outcome: {status: 'completed', result: {recheck: {byKey: new Map([['fixture', {ok: true}]])}, issues: []}},
        faultHooks: {[config.hook]: () => process.exit(91)}});
    } else throw new Error('Unknown child mode');
    if (process.send) process.send({value, owner});
    else console.log(JSON.stringify({value, owner}));
    if (childMode === 'claim-hold' && value) process.stdin.resume();
  } catch (error) { if (process.send) process.send({error: {code: error.code, message: error.message}}); process.exitCode = 1; }
} else {
  const base = await mkdtemp(join(tmpdir(), 'dsh-job-store-'));
  const report = {generatedAt: new Date().toISOString(), base, realArkCalls: 0, paidModelCalls: 0, modelCalls: 0,
    serversStarted: 0, sourceRoot, checks: [], sourceSha256: hash(await readFile(join(sourceRoot,'src/job-store.js'))),
    testSha256: hash(await readFile(SCRIPT))};
  const owned = new Set();
  const fresh = async (tag, limit = 2) => {
    const root = join(base, tag); await mkdir(root);
    const roots = {storageRoot: join(root, 'jobs'), sessionRoot: join(root, 'sessions'), workspaceRoot: join(root, 'workspaces'),
      versionRoot: join(root, 'versions'), auditRoot: join(root, 'audit'), legacyRoot: join(root, 'legacy'), ingestionRoot: join(root, 'ingestion')};
    for (const path of Object.values(roots)) await mkdir(path);
    await store.initializeJobStore({...roots, documentWorkerLimit: limit}); return roots;
  };
  const runChild = (mode, config) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:ARK|OPENAI|DOUBAO|VOLC)/i.test(key) && key !== 'NODE_OPTIONS'));
    env.DSH_JOB_TEST_CONFIG = JSON.stringify(config);
    const child = spawn(process.execPath, [SCRIPT, `--child=${mode}`], {cwd: ROOT, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc']});
    owned.add(child); let stderr = ''; child.stderr.on('data', (data) => stderr += data);
    const exited = new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code) => { owned.delete(child); done({code, stderr}); }); });
    const ready = new Promise((done, reject) => { child.once('message', done); child.once('error', reject); child.once('exit', (code) => { if (code !== 0) reject(new Error(`Child exited ${code}: ${stderr}`)); }); });
    ready.catch(() => {}); // Crash fixtures intentionally await exit rather than a message.
    return {child, ready, exited};
  };
  const stop = async (entry) => { if (entry.child.exitCode === null) entry.child.kill('SIGKILL'); return bounded(entry.exited, 5000); };
  const enqueue = (roots, tag, extra = {}) => store.enqueueJob({...roots, ...fixture(tag), ...extra});
  const claim = (roots) => store.claimNextJob({...roots});
  const ledgerPath = (roots) => join(roots.storageRoot, 'ledger', 'state.json');
  const mutateFixtureLedger = async (roots, action) => {
    const wrapped = JSON.parse(await readFile(ledgerPath(roots), 'utf8')); action(wrapped.state);
    wrapped.sha256 = hash(JSON.stringify(wrapped.state)); await writeFile(ledgerPath(roots), JSON.stringify(wrapped) + '\n');
  };
  const publish = async (roots, target, terminalEvent) => {
    const job = await store.claimJobPublication({...roots, jobId: target.id}); assert.ok(job);
    const outcome = await store.loadJobOutcome({...roots, jobId: job.id});
    let previous;
    try { previous = await loadSessionSnapshot({sessionId: job.sessionId, storageRoot: roots.sessionRoot}); } catch (error) { if (error.code !== 'SESSION_NOT_FOUND') throw error; }
    const snapshot = {id: job.sessionId, workVersion: {id: job.binding.versionId, sessionId: job.sessionId}, reviewJobId: job.id,
      reviewRunId: job.id, reviewRunning: false, reviewError: outcome.error || null,
      result: outcome.result || null, resultRunId: ['completed', 'partial'].includes(outcome.status) ? job.id : null,
      resultVersionId: ['completed', 'partial'].includes(outcome.status) ? job.binding.versionId : null};
    const manifest = await saveSessionSnapshot({sessionId: job.sessionId, snapshot, expectedRevision: previous?.manifest.revision ?? -1, storageRoot: roots.sessionRoot});
    const receipt = {jobRunId: job.id, versionId: job.binding.versionId, sessionRevision: manifest.revision, sessionManifestSha256: manifest.manifestSha256};
    return store.completeJobPublication({...roots, jobId: job.id, publicationToken: job.publicationLease.token, sessionReceipt: receipt, terminalEvent});
  };
  const finish = async (roots, job, outcome = {status: 'completed', result: {issues: []}}) => {
    const staged = await store.stageJobOutcome({...roots, jobId: job.id, leaseToken: job.lease.token, outcome});
    return publish(roots, staged, {type: outcome.status === 'completed' ? 'done' : 'error', data: {status: outcome.status}});
  };
  const test = async (name, action) => {
    const started = Date.now();
    try { await action(); report.checks.push({name, ok: true, elapsedMs: Date.now() - started}); console.log(`PASS ${name}`); }
    catch (error) { report.checks.push({name, ok: false, error: error.stack, elapsedMs: Date.now() - started}); throw error; }
  };
  try {
    await test('bounded queued cancellation settlement preserves all session bytes and terminal receipts', async () => {
      const roots=await fresh('bulk-cancel');const jobs=[];
      for(let i=0;i<20;i++){const job=(await enqueue(roots,'bulk'+i)).job;jobs.push(job);
        await saveSessionSnapshot({sessionId:job.sessionId,storageRoot:roots.sessionRoot,expectedRevision:-1,snapshot:{id:job.sessionId,workVersion:{id:job.binding.versionId},preserved:'original '+i}});
        await store.cancelJob({...roots,jobId:job.id});}
      const bytes=new Map(await Promise.all(jobs.map(async j=>[j.id,await readFile(join(roots.sessionRoot,j.sessionId,'state.json'))])));
      const first=await store.completeQueuedCancellations({...roots,limit:7});assert.equal(first.completed.length,7);
      for(const id of first.completed){const job=await store.loadJob({...roots,jobId:id});assert.equal(job.status,'cancelled');assert.equal(job.sessionReceipt.reason,'cancelled-before-start');assert(bytes.get(id).equals(await readFile(join(roots.sessionRoot,job.sessionId,'state.json'))));const events=await store.readJobEvents({...roots,jobId:id});assert.equal(events.length,1);assert.equal(events[0].type,'cancelled');}
      assert.equal((await store.completeQueuedCancellations({...roots,limit:32})).completed.length,13);
      assert.equal((await store.completeQueuedCancellations({...roots,limit:32})).completed.length,0);
    });
    await test('bulk cancellation never absorbs started jobs or live publishers', async () => {
      const roots=await fresh('bulk-cancel-live');const started=(await enqueue(roots,'started')).job;
      const running=await claim(roots);await store.cancelJob({...roots,jobId:started.id});await store.stageJobOutcome({...roots,jobId:started.id,leaseToken:running.lease.token,outcome:{status:'completed',result:{issues:[]}}});
      const waiting=(await enqueue(roots,'waiting')).job;await saveSessionSnapshot({sessionId:waiting.sessionId,storageRoot:roots.sessionRoot,expectedRevision:-1,snapshot:{id:waiting.sessionId,workVersion:{id:waiting.binding.versionId}}});await store.cancelJob({...roots,jobId:waiting.id});await store.claimJobPublication({...roots,jobId:waiting.id});
      assert.equal((await store.completeQueuedCancellations(roots)).completed.length,0);assert.equal((await store.loadJob({...roots,jobId:started.id})).status,'publishing');assert.equal((await store.loadJob({...roots,jobId:waiting.id})).status,'publishing');
    });
    await test('failed batch cancellation commit recovers without changing manuscript snapshots', async () => {
      const roots=await fresh('bulk-cancel-crash'),job=(await enqueue(roots,'crashcancel')).job;
      await saveSessionSnapshot({sessionId:job.sessionId,storageRoot:roots.sessionRoot,expectedRevision:-1,snapshot:{id:job.sessionId,workVersion:{id:job.binding.versionId},preserved:'must stay'}});await store.cancelJob({...roots,jobId:job.id});
      const before=await readFile(join(roots.sessionRoot,job.sessionId,'state.json'));
      await assert.rejects(store.completeQueuedCancellations({...roots,faultHooks:{beforeLedgerRename:()=>{throw Error('software forced ledger failure');}}}));
      assert.equal((await store.loadJob({...roots,jobId:job.id})).status,'publishing');assert.equal((await store.completeQueuedCancellations(roots)).completed.length,1);assert(before.equals(await readFile(join(roots.sessionRoot,job.sessionId,'state.json'))));
    });
    await test('preclaim exclusions are validated and preserve skipped model identity while allowing FIFO rule-only work',async()=>{
      const roots=await fresh('preclaim-exclusions'),owner=await store.createJobOwner();
      const first=await enqueue(roots,'excluded-model'),second=await enqueue(roots,'allowed-rule');
      for(const excludedJobIds of [null,{},['wrong'],[first.job.id,first.job.id]])await assert.rejects(store.claimNextJob({...roots,owner,excludedJobIds}),{code:'JOB_CLAIM_EXCLUSIONS_INVALID'});
      const claimed=await store.claimNextJob({...roots,owner,excludedJobIds:[first.job.id]});assert.equal(claimed.id,second.job.id);
      const pending=await store.loadJob({...roots,jobId:first.job.id});assert.equal(pending.status,'queued');assert.equal(pending.lease,null);
    });
    await test('durable safety pause reason is idempotent, survives reload/manual pause and clears only on explicit resume',async()=>{
      const roots=await fresh('pause-reason');const accepted=await store.startBatch({...roots,workspaceId:'wfixture',operationId:'reason-batch',jobs:[fixture('reason1'),fixture('reason2')]});
      const reason={code:'ARK_EXECUTION_BLOCKED',message:'Fixed software unknown capacity',poolId:'software',unknownSentCount:2,concurrency:2};
      await store.pauseBatch({...roots,batchId:accepted.batch.id,reason});const saved=await store.loadBatch({...roots,batchId:accepted.batch.id});assert.deepEqual(saved.pauseReason,reason);assert.equal(saved.paused,true);
      const revision=(await store.loadReviewQueueSnapshot({...roots,workspaceId:'wfixture'})).revision;
      await store.pauseBatch({...roots,batchId:accepted.batch.id,reason});await store.pauseBatch({...roots,batchId:accepted.batch.id});assert.equal((await store.loadReviewQueueSnapshot({...roots,workspaceId:'wfixture'})).revision,revision);
      assert.deepEqual((await store.loadBatch({...roots,batchId:accepted.batch.id})).pauseReason,reason);assert.equal(await store.claimNextJob({...roots,owner:await store.createJobOwner()}),null);
      await assert.rejects(store.pauseBatch({...roots,batchId:accepted.batch.id,reason:[]}),{code:'JOB_PAUSE_REASON_INVALID'});
      const resumed=await store.resumeBatch({...roots,batchId:accepted.batch.id});assert.equal(resumed.paused,false);assert.equal(resumed.pauseReason,null);
      assert.equal((await store.claimNextJob({...roots,owner:await store.createJobOwner()})).id,accepted.jobs[0].id);
    });
    await test('two processes replay one operation and immutable version/config identity', async () => {
      const roots = await fresh('same-operation'); const spec = fixture('same');
      const children = [runChild('enqueue', {roots, spec}), runChild('enqueue', {roots, spec})];
      const results = await bounded(Promise.all(children.map((entry) => entry.ready)));
      await bounded(Promise.all(children.map((entry) => entry.exited)));
      assert.equal(results[0].value.job.id, results[1].value.job.id); assert.equal((await store.listJobs(roots)).length, 1);
      assert.equal(results.filter((result) => result.value.replayed).length, 1);
      for (const change of [{config: {...spec.config, useContext: true}}, {accountId: 'different-account'}, {binding: {...spec.binding, mutationEpoch: 1}}])
        await assert.rejects(store.enqueueJob({...roots, ...spec, ...change}), {code: 'JOB_OPERATION_CONFLICT'});
      assert.equal((await store.listJobs(roots))[0].seq, 1);
    });
    await test('FIFO and durable global capacity are shared by three independent claimers', async () => {
      const roots = await fresh('global-slots'); const jobs = [];
      for (const tag of ['fifo1', 'fifo2', 'fifo3']) jobs.push((await enqueue(roots, tag)).job);
      const entries = [runChild('claim-hold', {roots}), runChild('claim-hold', {roots}), runChild('claim-hold', {roots})];
      const values = await bounded(Promise.all(entries.map((entry) => entry.ready)));
      const claimed = values.map((value) => value.value).filter(Boolean).sort((a, b) => a.seq - b.seq);
      assert.deepEqual(claimed.map((job) => job.id), jobs.slice(0, 2).map((job) => job.id));
      assert.equal((await store.listJobs({...roots, status: 'running'})).length, 2); assert.equal(await claim(roots), null);
      for (const entry of entries) await stop(entry);
      const recovered = await store.recoverJobs(roots); assert.equal(recovered.interrupted.length, 2);
      assert.equal((await claim(roots)).id, jobs[2].id);
    });
    await test('one-ledger workspace snapshot sees referenced cross-workspace live sessions without borrowing their batch', async () => {
      const roots = await fresh('display-session-refs', 2);
      const started = await store.startBatch({...roots, workspaceId: 'wfixture', operationId: 'owner-batch', jobs: [fixture('sharedlive')]});
      const own = await enqueue(roots, 'displayown', {workspaceId: 'wshared'});
      const running = await claim(roots); assert.equal(running.id, started.jobs[0].id); assert.equal(running.status, 'running');
      const before = await readFile(ledgerPath(roots)); const original = fsPromises.readFile;
      let ledgerReads = 0; let outcomeReads = 0;
      fsPromises.readFile = async (path, ...rest) => {
        const value = String(path);
        if (value === ledgerPath(roots)) ledgerReads++;
        if (value.startsWith(join(roots.storageRoot, 'outcomes'))) { outcomeReads++; throw new Error('Snapshot must never read outcomes'); }
        return original(path, ...rest);
      };
      syncBuiltinESMExports();
      try {
        const without = await store.loadReviewQueueSnapshot({...roots, workspaceId: 'wshared'});
        assert.deepEqual(without.jobs.map(job => job.id), [own.job.id]); assert.equal(without.batch, null); assert.equal(ledgerReads, 1);
        ledgerReads = 0;
        const withRefs = await store.loadReviewQueueSnapshot({...roots, workspaceId: 'wshared', sessionIds: [running.sessionId, running.sessionId]});
        assert.equal(ledgerReads, 1); assert.equal(withRefs.revision, without.revision); assert.equal(withRefs.batch, null);
        assert.deepEqual(withRefs.jobs.map(job => job.id), [running.id, own.job.id]);
        assert.equal(withRefs.jobs[0].status, 'running'); assert.equal(withRefs.jobs[0].workspaceId, 'wfixture');
        assert.equal(withRefs.jobs.filter(job => job.id === running.id).length, 1);
        for (const sessionIds of [null, 'ssharedlive', [''], ['wrongsharedlive'], ['Ssharedlive'], ['sbad/path'], ['sbad:version'], ['sbad\u0000'], [0]])
          await assert.rejects(store.loadReviewQueueSnapshot({...roots, workspaceId: 'wshared', sessionIds}), {code: 'JOB_SESSION_IDS_INVALID', status: 400});
        await assert.rejects(store.loadReviewQueueSnapshot({...roots, workspaceId: 'wshared', sessionIds: [running.sessionId], batchId: started.batch.id}), {code: 'JOB_BATCH_NOT_FOUND', status: 404});
        assert.equal(outcomeReads, 0);
      } finally { fsPromises.readFile = original; syncBuiltinESMExports(); }
      assert.ok(before.equals(await readFile(ledgerPath(roots))));
    });
    await test('alive peer with ancient timestamps stays leased through reads and recovery', async () => {
      const roots = await fresh('alive-peer', 1); const first = (await enqueue(roots, 'alive1')).job; await enqueue(roots, 'alive2');
      const child = runChild('claim-hold', {roots}); const active = (await bounded(child.ready)).value; assert.equal(active.id, first.id);
      await mutateFixtureLedger(roots, (state) => { state.jobs[first.id].lease.touchedAt = '1990-01-01T00:00:00.000Z'; state.jobs[first.id].updatedAt = '1990-01-01T00:00:00.000Z'; });
      const before = await readFile(ledgerPath(roots));
      assert.equal((await store.loadJob({...roots, jobId: first.id})).status, 'running'); assert.equal((await store.listJobs(roots)).length, 2);
      assert.equal((await store.recoverJobs(roots)).interrupted.length, 0); assert.equal(await claim(roots), null);
      assert.ok(before.equals(await readFile(ledgerPath(roots)))); await stop(child);
      const recovered = await store.recoverJobs(roots); assert.equal(recovered.interrupted.length, 1);
      const terminal = await publish(roots, recovered.interrupted[0]); assert.equal(terminal.status, 'interrupted');
      assert.equal((await enqueue(roots, 'alive1')).replayed, true);
      assert.notEqual((await enqueue(roots, 'alive1', {operationId: 'explicit-retry'})).job.id, first.id);
    });
    await test('OS birth identity detects PID reuse while unknown identities remain conservative', async () => {
      const roots = await fresh('birth'); const job = (await enqueue(roots, 'birth1')).job; await claim(roots);
      const owner = await store.createJobOwner(); assert.equal(owner.pid, process.pid);
      if (['win32', 'linux'].includes(process.platform)) assert.ok(owner.birthIdentity, 'OS creation identity must be available in this fixture');
      await mutateFixtureLedger(roots, (state) => { state.jobs[job.id].lease.owner.birthIdentity = null; });
      assert.equal((await store.recoverJobs(roots)).interrupted.length, 0);
      if (owner.birthIdentity) {
        await mutateFixtureLedger(roots, (state) => { state.jobs[job.id].lease.owner.birthIdentity = `${owner.birthIdentity}-old`; });
        assert.equal((await store.recoverJobs(roots)).interrupted.length, 1);
      }
    });
    await test('batch ordering, pause-next, resume and cancelling pending jobs are durable', async () => {
      const roots = await fresh('batch', 1); const specs = ['batch1', 'batch2', 'batch3'].map(fixture);
      const spec = {...roots, operationId: 'batch-start', workspaceId: 'wfixture', jobs: specs};
      const started = await store.startBatch(spec); assert.deepEqual(started.jobs.map((job) => job.sessionId), specs.map((item) => item.sessionId));
      assert.equal((await store.startBatch(spec)).replayed, true);
      await assert.rejects(store.startBatch({...spec, jobs: specs.toReversed ? specs.toReversed() : [...specs].reverse()}), {code: 'JOB_OPERATION_CONFLICT'});
      const first = await claim(roots); await store.pauseBatch({...roots, batchId: started.batch.id});
      assert.equal(first.status, 'running'); await finish(roots, first); assert.equal(await claim(roots), null);
      await store.resumeBatch({...roots, batchId: started.batch.id}); const second = await claim(roots);
      await store.cancelBatch({...roots, batchId: started.batch.id});
      assert.equal((await store.loadJob({...roots, jobId: second.id})).cancelRequested, true);
      assert.equal((await store.loadJob({...roots, jobId: started.jobs[2].id})).status, 'publishing');
      await finish(roots, second); await publish(roots, started.jobs[2]);
      const batch = await store.latestBatchForWorkspace({...roots, workspaceId: 'wfixture'});
      assert.equal(batch.status, 'cancelled'); assert.equal((await store.loadBatch({...roots, batchId: batch.id})).cancelRequested, true);
      await assert.rejects(store.resumeBatch({...roots, batchId: batch.id}), {code: 'JOB_BATCH_CANCELLED'});
    });
    await test('cancel wins before outcome staging and cannot erase an already staged completion', async () => {
      const roots = await fresh('cancel-race', 1); let job = (await enqueue(roots, 'cancel1')).job; job = await claim(roots);
      await store.cancelJob({...roots, jobId: job.id}); assert.equal(await claim(roots), null);
      await store.stageJobOutcome({...roots, jobId: job.id, leaseToken: job.lease.token, outcome: {status: 'completed', result: {issues: ['must not publish']}}});
      assert.equal((await store.loadJobOutcome({...roots, jobId: job.id})).status, 'cancelled'); assert.equal((await publish(roots, job)).status, 'cancelled');
      job = (await enqueue(roots, 'cancel2')).job; job = await claim(roots);
      await store.stageJobOutcome({...roots, jobId: job.id, leaseToken: job.lease.token, outcome: {status: 'completed', result: {issues: []}}});
      const afterCancel = await store.cancelJob({...roots, jobId: job.id}); assert.equal(afterCancel.cancelRequested, false);
      assert.equal((await publish(roots, job)).status, 'completed');
    });
    await test('two completed jobs plus an excluded failed upload remain a partial batch with no fabricated job', async () => {
      const roots = await fresh('excluded', 1); const excluded = [{entryId: 'failed-upload-entry', name: '坏稿.docx', reason: '清洗或解析失败'}];
      const spec = {...roots, workspaceId: 'wfixture', operationId: 'batch-with-exclusion', jobs: ['excluded1', 'excluded2'].map(fixture), excluded};
      const started = await store.startBatch(spec); assert.deepEqual(started.batch.excluded, excluded); assert.equal(started.jobs.length, 2);
      await assert.rejects(store.startBatch({...spec, excluded: [{...excluded[0], reason: '不同失败原因'}]}), {code: 'JOB_OPERATION_CONFLICT'});
      await finish(roots, await claim(roots)); await finish(roots, await claim(roots));
      const batch = await store.loadBatch({...roots, batchId: started.batch.id}); assert.equal(batch.status, 'partial');
      assert.equal(batch.jobIds.length, 2); assert.equal((await store.listJobs(roots)).length, 2); assert.equal(await claim(roots), null);
      assert.ok((await store.listJobs(roots)).every((job) => job.status === 'completed'));
      assert.equal((await store.startBatch(spec)).replayed, true);
    });
    await test('wrong leases cannot alter progress/events/outcomes and terminal events replay once', async () => {
      const roots = await fresh('fencing'); let job = (await enqueue(roots, 'fence')).job; job = await claim(roots);
      const before = await readFile(ledgerPath(roots));
      for (const action of [() => store.updateJobProgress({...roots, jobId: job.id, leaseToken: randomUUID(), progress: {phase: 'wrong'}}),
        () => store.appendJobEvents({...roots, jobId: job.id, leaseToken: randomUUID(), events: [{type: 'issue', data: {}}]}),
        () => store.stageJobOutcome({...roots, jobId: job.id, leaseToken: randomUUID(), outcome: {status: 'failed'}})])
        await assert.rejects(action(), {code: 'JOB_LEASE_CONFLICT'});
      assert.ok(before.equals(await readFile(ledgerPath(roots))));
      const events = await store.appendJobEvents({...roots, jobId: job.id, leaseToken: job.lease.token, events: [{type: 'doc', data: {id: job.sessionId}}, {type: 'issue', data: {message: 'fixture'}}]});
      assert.deepEqual(events.map((event) => event.seq), [1, 2]); assert.equal(events[1].versionId, job.binding.versionId);
      await finish(roots, job); const all = await store.readJobEvents({...roots, jobId: job.id, afterSeq: 0});
      assert.deepEqual(all.map((event) => event.type), ['doc', 'issue', 'done']);
      assert.equal((await store.readJobEvents({...roots, jobId: job.id, afterSeq: 3})).length, 0);
      await assert.rejects(store.stageJobOutcome({...roots, jobId: job.id, leaseToken: job.lease.token, outcome: {status: 'failed'}}), {code: 'JOB_LEASE_CONFLICT'});
    });
    await test('outcome crash before ledger publication recovers typed Map without rerunning engine', async () => {
      const roots = await fresh('outbox-crash'); const job = (await enqueue(roots, 'outbox')).job;
      const child = runChild('stage-crash', {roots, hook: 'afterOutcomeCommit'}); const exit = await bounded(child.exited); assert.equal(exit.code, 91);
      assert.equal((await store.loadJob({...roots, jobId: job.id})).status, 'running');
      const recovered = await store.recoverJobs(roots); assert.equal(recovered.interrupted.length, 0); assert.equal(recovered.publishing.length, 1);
      const outcome = await store.loadJobOutcome({...roots, jobId: job.id}); assert.ok(outcome.result.recheck.byKey instanceof Map);
      assert.equal(outcome.result.recheck.byKey.get('fixture').ok, true); assert.equal(await claim(roots), null);
      await publish(roots, job); assert.equal((await store.loadJob({...roots, jobId: job.id})).status, 'completed');
      const session = await loadSessionSnapshot({sessionId: job.sessionId, storageRoot: roots.sessionRoot}); assert.ok(session.snapshot.result.recheck.byKey instanceof Map);
      const ledger = await readFile(ledgerPath(roots), 'utf8'); assert.equal(ledger.includes('byKey'), false);
    });
    await test('full terminal callback data stays in its event artifact while the global ledger keeps receipt metadata only', async () => {
      const roots = await fresh('metadata-receipt'); await enqueue(roots, 'metadata'); const job = await claim(roots);
      const result = {issues: [{message: 'FULL_RESULT_MUST_STAY_OUT_OF_GLOBAL_LEDGER', detail: 'large fixture '.repeat(12000)}],
        recheck: {byKey: new Map([['typed', {ok: true}]])}};
      await store.stageJobOutcome({...roots, jobId: job.id, leaseToken: job.lease.token, outcome: {status: 'completed', result}});
      const publication = await store.claimJobPublication({...roots, jobId: job.id});
      const manifest = await saveSessionSnapshot({sessionId: job.sessionId, storageRoot: roots.sessionRoot, expectedRevision: -1,
        snapshot: {id: job.sessionId, workVersion: {id: job.binding.versionId}, reviewJobId: job.id, reviewRunId: job.id,
          result, resultRunId: job.id, resultVersionId: job.binding.versionId}});
      const terminalData = {issues: result.issues, recheck: {byKey: {typed: {ok: true}}}, serializedResultMarker: 'LARGE_TERMINAL_EVENT'};
      const metadata = {jobRunId: job.id, versionId: job.binding.versionId, sessionRevision: manifest.revision, sessionManifestSha256: manifest.manifestSha256};
      await assert.rejects(store.completeJobPublication({...roots, jobId: job.id, publicationToken: publication.publicationLease.token,
        receipt: {...metadata, error: terminalData}}), {code: 'JOB_PUBLICATION_CONFLICT'});
      const completed = await store.completeJobPublication({...roots, jobId: job.id, publicationToken: publication.publicationLease.token,
        receipt: {...metadata, terminalData, result, unknownPayload: terminalData}, terminalEvent: {type: 'done', data: terminalData}});
      assert.deepEqual(completed.sessionReceipt, metadata);
      const ledger = await readFile(ledgerPath(roots), 'utf8'); assert.equal(ledger.includes('FULL_RESULT_MUST_STAY_OUT_OF_GLOBAL_LEDGER'), false);
      assert.equal(ledger.includes('LARGE_TERMINAL_EVENT'), false); assert.ok(ledger.length < 20000);
      const events = await store.readJobEvents({...roots, jobId: job.id}); assert.deepEqual(events[0].data, terminalData);
      assert.ok((await store.loadJobOutcome({...roots, jobId: job.id})).result.recheck.byKey instanceof Map);
      const original = fsPromises.readFile;
      fsPromises.readFile = async (path, ...rest) => { if (String(path).includes(`${roots.storageRoot}${process.platform === 'win32' ? '\\' : '/'}outcomes`)) throw new Error('GET must not load outcomes'); return original(path, ...rest); };
      syncBuiltinESMExports();
      try {
        assert.equal((await store.loadJob({...roots, jobId: job.id})).status, 'completed');
        assert.equal((await store.listJobs(roots)).length, 1);
      } finally { fsPromises.readFile = original; syncBuiltinESMExports(); }
    });
    await test('an orphan event batch after a failed ledger commit cannot block failure publication', async () => {
      const roots = await fresh('orphan-event'); await enqueue(roots, 'orphan'); const job = await claim(roots);
      await assert.rejects(store.appendJobEvents({...roots, jobId: job.id, leaseToken: job.lease.token,
        events: [{type: 'issue', data: {message: 'uncommitted event'}}], faultHooks: {beforeLedgerRename() { throw new Error('event-ledger-failure'); }}}), /event-ledger-failure/);
      assert.deepEqual(await store.readJobEvents({...roots, jobId: job.id}), []);
      await finish(roots, job, {status: 'failed', error: '事件记录保存失败'});
      const events = await store.readJobEvents({...roots, jobId: job.id});
      assert.deepEqual(events.map((event) => [event.seq, event.type]), [[1, 'error']]);
      assert.equal((await store.loadJob({...roots, jobId: job.id})).status, 'failed');
    });
    await test('crash before ledger rename retains old state and after-commit reply loss replays one claim', async () => {
      const roots = await fresh('ledger-crash'); const job = (await enqueue(roots, 'crash')).job; const before = await readFile(ledgerPath(roots));
      let child = runChild('claim-crash', {roots, hook: 'beforeLedgerRename'}); assert.equal((await bounded(child.exited)).code, 91);
      assert.ok(before.equals(await readFile(ledgerPath(roots)))); assert.equal((await store.loadJob({...roots, jobId: job.id})).status, 'queued');
      child = runChild('claim-crash', {roots, hook: 'afterLedgerCommit'}); assert.equal((await bounded(child.exited)).code, 91);
      assert.equal((await store.loadJob({...roots, jobId: job.id})).status, 'running');
      assert.equal((await enqueue(roots, 'crash')).job.id, job.id); assert.equal((await store.recoverJobs(roots)).interrupted.length, 1);
    });
    await test('queued cancellation outbox survives a lost ledger commit and never gets claimed', async () => {
      const roots = await fresh('cancel-outbox'); const job = (await enqueue(roots, 'pending')).job;
      await assert.rejects(store.cancelJob({...roots, jobId: job.id, faultHooks: {afterOutcomeCommit() { throw new Error('outbox-before-ledger'); }}}), /outbox-before-ledger/);
      assert.equal((await store.loadJob({...roots, jobId: job.id})).status, 'queued');
      assert.equal(await claim(roots), null); assert.equal((await store.loadJob({...roots, jobId: job.id})).status, 'publishing');
      assert.equal((await publish(roots, job)).status, 'cancelled');
    });
    await test('publication fencing requires actual matching session and preserves immutable outcome', async () => {
      const roots = await fresh('receipt'); let job = (await enqueue(roots, 'receipt1')).job; job = await claim(roots);
      await store.stageJobOutcome({...roots, jobId: job.id, leaseToken: job.lease.token, outcome: {status: 'completed', result: {issues: []}}});
      const publishing = await store.claimJobPublication({...roots, jobId: job.id});
      await assert.rejects(store.completeJobPublication({...roots, jobId: job.id, publicationToken: randomUUID(), receipt: {jobRunId: job.id, versionId: job.binding.versionId}}), {code: 'JOB_PUBLICATION_CONFLICT'});
      await assert.rejects(store.completeJobPublication({...roots, jobId: job.id, publicationToken: publishing.publicationLease.token, receipt: {jobRunId: job.id, versionId: job.binding.versionId}}));
      await store.releaseJobPublication({...roots, jobId: job.id, publicationToken: publishing.publicationLease.token});
      assert.equal((await publish(roots, job)).status, 'completed');
    });
    await test('pre-start config rejection proves unpublished failure without replacing existing results and replays idempotently', async () => {
      const roots = await fresh('config-unpublished', 1); const accepted = (await enqueue(roots, 'configreject')).job;
      const original = {id: accepted.sessionId, workVersion: {id: accepted.binding.versionId}, mutationEpoch: 0,
        reviewJobId: 'previous-review', reviewRunId: 'previous-review', resultRunId: 'previous-review', resultVersionId: accepted.binding.versionId,
        result: {issues: [{issueKey: 'previous-issue', message: 'Existing result must survive config rejection'}]},
        human: {decisions: {'previous-issue': {decision: 'accepted'}}}, preserved: {draft: true}};
      let manifest = await saveSessionSnapshot({sessionId: accepted.sessionId, storageRoot: roots.sessionRoot, expectedRevision: -1, snapshot: original});
      manifest = await saveSessionSnapshot({sessionId: accepted.sessionId, storageRoot: roots.sessionRoot, expectedRevision: manifest.revision, snapshot: original});
      const sessionPath = join(roots.sessionRoot, accepted.sessionId, 'state.json'), sessionBefore = await readFile(sessionPath);
      const running = await claim(roots); assert.equal(running.id, accepted.id); assert.equal(running.eventSeq, 0);
      await store.stageJobOutcome({...roots, jobId: running.id, leaseToken: running.lease.token,
        outcome: {status: 'failed', rejection: 'config-conflict', result: null, message: 'Software config changed before review start'}});
      const publication = await store.claimJobPublication({...roots, jobId: running.id});
      const common = {...roots, jobId: running.id, publicationToken: publication.publicationLease.token};
      const receipt = {jobRunId: running.id, versionId: running.binding.versionId, unpublished: true, reason: 'config-conflict',
        currentVersionId: original.workVersion.id, currentMutationEpoch: 0, sessionRevision: manifest.revision, sessionManifestSha256: manifest.manifestSha256};
      const missingEpoch = {...receipt}; delete missingEpoch.currentMutationEpoch;
      for (const invalid of [{...receipt, sessionManifestSha256: hash('forged-config-manifest')},
        {...receipt, sessionRevision: manifest.revision - 1}, missingEpoch, {...receipt, currentMutationEpoch: 1},
        {...receipt, currentVersionId: `${running.sessionId}:v000001-${hash('different-config-version')}`}]) {
        const ledgerBefore = await readFile(ledgerPath(roots));
        await assert.rejects(store.completeJobPublication({...common, receipt: invalid, terminalEvent: {type: 'error', data: {message: 'Rejected receipt must not emit'}}}), {code: 'JOB_PUBLICATION_CONFLICT'});
        assert.ok(ledgerBefore.equals(await readFile(ledgerPath(roots)))); assert.ok(sessionBefore.equals(await readFile(sessionPath)));
        assert.equal((await store.loadJob({...roots, jobId: running.id})).eventSeq, 0);
      }
      const terminal = await store.completeJobPublication({...common, receipt, terminalEvent: {type: 'error', data: {message: 'Config conflict before review'}}});
      assert.equal(terminal.status, 'failed'); assert.equal(terminal.eventSeq, 1); assert.equal(terminal.lease, null); assert.equal(terminal.publicationLease, null);
      assert.deepEqual((await loadSessionSnapshot({sessionId: running.sessionId, storageRoot: roots.sessionRoot})).snapshot, original);
      assert.ok(sessionBefore.equals(await readFile(sessionPath)));
      const ledgerAfter = await readFile(ledgerPath(roots));
      const replay = await store.completeJobPublication({...common, receipt, terminalEvent: {type: 'error', data: {message: 'A replay cannot append another event'}}});
      assert.equal(replay.status, 'failed'); assert.equal(replay.eventSeq, 1); assert.ok(ledgerAfter.equals(await readFile(ledgerPath(roots))));
      assert.ok(sessionBefore.equals(await readFile(sessionPath))); assert.equal((await store.readJobEvents({...roots, jobId: running.id})).length, 1);
      await enqueue(roots, 'afterconfigreject'); assert.ok(await claim(roots));
    });
    await test('config-conflict unpublished receipt cannot bypass status, rejection, saved result or any emitted start event', async () => {
      const cases = [
        ...['cancelled', 'interrupted', 'completed', 'partial'].map(status => ({tag: status, outcome: {status, rejection: 'config-conflict', result: null}})),
        {tag: 'result', outcome: {status: 'failed', rejection: 'config-conflict', result: {issues: [{message: 'Cannot discard a saved result'}]}}},
        {tag: 'wrongrejection', outcome: {status: 'failed', rejection: 'version-conflict', result: null}},
        {tag: 'missingrejection', outcome: {status: 'failed', result: null}},
        ...['doc', 'progress'].map(type => ({tag: type, emitted: type, outcome: {status: 'failed', rejection: 'config-conflict', result: null}}))
      ];
      for (const entry of cases) {
        const roots = await fresh(`config-denied-${entry.tag}`, 1), job = (await enqueue(roots, `configdenied${entry.tag}`)).job;
        const snapshot = {id: job.sessionId, workVersion: {id: job.binding.versionId}, mutationEpoch: 0,
          reviewRunId: 'previous-review', result: {issues: [{issueKey: 'unchanged-existing-result'}]}, preserved: entry.tag};
        const manifest = await saveSessionSnapshot({sessionId: job.sessionId, storageRoot: roots.sessionRoot, expectedRevision: -1, snapshot});
        const sessionPath = join(roots.sessionRoot, job.sessionId, 'state.json'), sessionBefore = await readFile(sessionPath);
        const running = await claim(roots);
        if (entry.emitted) await store.appendJobEvents({...roots, jobId: job.id, leaseToken: running.lease.token,
          events: [{type: entry.emitted, data: {phase: 'start', message: 'Review already observable'}}]});
        await store.stageJobOutcome({...roots, jobId: job.id, leaseToken: running.lease.token, outcome: entry.outcome});
        const publication = await store.claimJobPublication({...roots, jobId: job.id}), ledgerBefore = await readFile(ledgerPath(roots));
        const receipt = {jobRunId: job.id, versionId: job.binding.versionId, unpublished: true, reason: 'config-conflict',
          currentVersionId: snapshot.workVersion.id, currentMutationEpoch: 0, sessionRevision: manifest.revision, sessionManifestSha256: manifest.manifestSha256};
        await assert.rejects(store.completeJobPublication({...roots, jobId: job.id, publicationToken: publication.publicationLease.token,
          receipt, terminalEvent: {type: 'error', data: {message: 'Must not bypass publication'}}}), {code: 'JOB_PUBLICATION_CONFLICT'});
        assert.ok(ledgerBefore.equals(await readFile(ledgerPath(roots)))); assert.ok(sessionBefore.equals(await readFile(sessionPath)));
        const saved = await store.loadJob({...roots, jobId: job.id}); assert.equal(saved.status, 'publishing'); assert.equal(saved.eventSeq, entry.emitted ? 1 : 0);
        assert.deepEqual(await store.loadJobOutcome({...roots, jobId: job.id}), entry.outcome);
      }
    });
    await test('a queued v0 rejected after mutation to v1 releases capacity without changing the newer session', async () => {
      const roots = await fresh('stale-version', 1); let job = (await enqueue(roots, 'stale')).job;
      const nextHash = hash('newer version'); const currentVersionId = `${job.sessionId}:v000001-${nextHash}`;
      const manifest = await saveSessionSnapshot({sessionId: job.sessionId, storageRoot: roots.sessionRoot, expectedRevision: -1,
        snapshot: {id: job.sessionId, workVersion: {id: currentVersionId}, mutationEpoch: 1, preserved: {newerDraft: true}}});
      const path = join(roots.sessionRoot, job.sessionId, 'state.json'); const before = await readFile(path);
      job = await claim(roots);
      await store.stageJobOutcome({...roots, jobId: job.id, leaseToken: job.lease.token,
        outcome: {status: 'failed', rejection: 'version-conflict', error: '冻结任务与当前稿版本不同'}});
      const publication = await store.claimJobPublication({...roots, jobId: job.id});
      const common = {...roots, jobId: job.id, publicationToken: publication.publicationLease.token};
      await assert.rejects(store.completeJobPublication({...common, receipt: {jobRunId: job.id, versionId: job.binding.versionId}}), {code: 'JOB_PUBLICATION_CONFLICT'});
      const receipt = {jobRunId: job.id, versionId: job.binding.versionId, unpublished: true, reason: 'version-conflict',
        sessionRevision: manifest.revision, currentVersionId, currentMutationEpoch: 1, sessionManifestSha256: manifest.manifestSha256};
      await assert.rejects(store.completeJobPublication({...common, receipt: {...receipt, currentVersionId: job.binding.versionId}}), {code: 'JOB_PUBLICATION_CONFLICT'});
      const terminal = await store.completeJobPublication({...common, receipt, terminalEvent: {type: 'error', data: {message: '版本冲突'}}});
      assert.equal(terminal.status, 'failed'); assert.ok(before.equals(await readFile(path)));
      await enqueue(roots, 'stale2'); assert.ok(await claim(roots));
      assert.equal((await loadSessionSnapshot({sessionId: job.sessionId, storageRoot: roots.sessionRoot})).snapshot.preserved.newerDraft, true);
    });
    await test('stale queued cancellation proves unpublished cancellation and preserves the newer session', async () => {
      const roots = await fresh('stale-cancelled', 1); const job = (await enqueue(roots, 'stalecancel')).job;
      const currentVersionId = `${job.sessionId}:v000001-${hash('newer cancelled draft')}`;
      const manifest = await saveSessionSnapshot({sessionId: job.sessionId, storageRoot: roots.sessionRoot, expectedRevision: -1,
        snapshot: {id: job.sessionId, workVersion: {id: currentVersionId}, mutationEpoch: 1, preserved: 'newer cancelled draft'}});
      const path = join(roots.sessionRoot, job.sessionId, 'state.json'); const before = await readFile(path);
      const cancelled = await store.cancelJob({...roots, jobId: job.id}); assert.equal(cancelled.status, 'publishing');
      assert.equal((await store.loadJobOutcome({...roots, jobId: job.id})).status, 'cancelled');
      const publication = await store.claimJobPublication({...roots, jobId: job.id});
      const common = {...roots, jobId: job.id, publicationToken: publication.publicationLease.token};
      const receipt = {jobRunId: job.id, versionId: job.binding.versionId, unpublished: true, reason: 'version-conflict',
        sessionRevision: manifest.revision, currentVersionId, currentMutationEpoch: 1, sessionManifestSha256: manifest.manifestSha256};
      await assert.rejects(store.completeJobPublication({...common, receipt: {...receipt, sessionManifestSha256: hash('forged receipt')}}), {code: 'JOB_PUBLICATION_CONFLICT'});
      const terminal = await store.completeJobPublication({...common, receipt, terminalEvent: {type: 'cancelled', data: {message: '已取消'}}});
      assert.equal(terminal.status, 'cancelled'); assert.ok(before.equals(await readFile(path)));
      await enqueue(roots, 'afterstalecancel'); assert.ok(await claim(roots));
    });
    await test('stale interrupted run proves unpublished interruption after owner death without changing the newer session', async () => {
      const roots = await fresh('stale-interrupted', 1); const job = (await enqueue(roots, 'staleinterrupt')).job;
      const child = runChild('claim-hold', {roots}); assert.equal((await bounded(child.ready)).value.id, job.id);
      const currentVersionId = `${job.sessionId}:v000001-${hash('newer interrupted draft')}`;
      const manifest = await saveSessionSnapshot({sessionId: job.sessionId, storageRoot: roots.sessionRoot, expectedRevision: -1,
        snapshot: {id: job.sessionId, workVersion: {id: currentVersionId}, mutationEpoch: 1, preserved: 'newer interrupted draft'}});
      const path = join(roots.sessionRoot, job.sessionId, 'state.json'); const before = await readFile(path);
      await stop(child); const recovered = await store.recoverJobs(roots); assert.equal(recovered.interrupted.length, 1);
      assert.equal((await store.loadJobOutcome({...roots, jobId: job.id})).status, 'interrupted');
      const publication = await store.claimJobPublication({...roots, jobId: job.id});
      const common = {...roots, jobId: job.id, publicationToken: publication.publicationLease.token};
      const receipt = {jobRunId: job.id, versionId: job.binding.versionId, unpublished: true, reason: 'version-conflict',
        sessionRevision: manifest.revision, currentVersionId, currentMutationEpoch: 1, sessionManifestSha256: manifest.manifestSha256};
      await assert.rejects(store.completeJobPublication({...common, receipt: {...receipt, currentVersionId: job.binding.versionId}}), {code: 'JOB_PUBLICATION_CONFLICT'});
      const terminal = await store.completeJobPublication({...common, receipt, terminalEvent: {type: 'error', data: {message: '已中断'}}});
      assert.equal(terminal.status, 'interrupted'); assert.ok(before.equals(await readFile(path)));
      await enqueue(roots, 'afterstaleinterrupt'); assert.ok(await claim(roots));
    });
    await test('unpublished receipts never discard any saved result or bypass completed and partial publication', async () => {
      for (const status of ['failed', 'cancelled', 'interrupted', 'completed', 'partial']) {
        const roots = await fresh(`unpublished-result-${status}`, 1); const job = (await enqueue(roots, `hasresult${status}`)).job;
        const currentVersionId = `${job.sessionId}:v000001-${hash(`newer-${status}`)}`;
        const manifest = await saveSessionSnapshot({sessionId: job.sessionId, storageRoot: roots.sessionRoot, expectedRevision: -1,
          snapshot: {id: job.sessionId, workVersion: {id: currentVersionId}, mutationEpoch: 1}});
        const path = join(roots.sessionRoot, job.sessionId, 'state.json'); const before = await readFile(path);
        const running = await claim(roots);
        const outcome = {status, rejection: 'version-conflict', result: {issues: [{message: 'saved result must not be discarded'}]}};
        await store.stageJobOutcome({...roots, jobId: job.id, leaseToken: running.lease.token, outcome});
        const publication = await store.claimJobPublication({...roots, jobId: job.id});
        const receipt = {jobRunId: job.id, versionId: job.binding.versionId, unpublished: true, reason: 'version-conflict',
          sessionRevision: manifest.revision, currentVersionId, currentMutationEpoch: 1, sessionManifestSha256: manifest.manifestSha256};
        await assert.rejects(store.completeJobPublication({...roots, jobId: job.id, publicationToken: publication.publicationLease.token, receipt}), {code: 'JOB_PUBLICATION_CONFLICT'});
        assert.ok(before.equals(await readFile(path))); assert.deepEqual((await store.loadJobOutcome({...roots, jobId: job.id})).result, outcome.result);
      }
    });
    await test('storage relationship, canonical policy, damaged hash and missing state never reset data', async () => {
      const roots = await fresh('integrity'); await enqueue(roots, 'integrity1'); const path = ledgerPath(roots); const before = await readFile(path);
      await assert.rejects(store.initializeJobStore({...roots, documentWorkerLimit: 3}), {code: 'JOB_POLICY_CONFLICT'});
      await assert.rejects(store.listJobs({...roots, sessionRoot: join(base, 'other-sessions')}), {code: 'JOB_STORAGE_CONFLICT'});
      assert.ok(before.equals(await readFile(path)));
      const damaged = JSON.parse(before); damaged.state.nextSeq++; await writeFile(path, JSON.stringify(damaged));
      const corrupt = await readFile(path); await assert.rejects(store.initializeJobStore(roots), {code: 'JOB_HASH_MISMATCH'}); assert.ok(corrupt.equals(await readFile(path)));
      await unlink(path); await assert.rejects(store.initializeJobStore(roots), {code: 'JOB_CORRUPT'}); await writeFile(path, before);
      const linkedRoot = join(base, 'linked-jobs'); let permitted = true;
      try { await symlink(roots.storageRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; permitted = false; }
      if (permitted) await assert.rejects(store.listJobs({...roots, storageRoot: linkedRoot}), {code: 'JOB_PATH_INVALID'});
    });
    await test('queue snapshot reads one ledger revision even when the file changes immediately afterward', async () => {
      const roots=await fresh('atomic-queue-snapshot');
      const accepted=await store.startBatch({...roots,workspaceId:'wfixture',operationId:'atomic-snapshot',jobs:[fixture('atomic1'),fixture('atomic2')]});
      const original=fsPromises.readFile;let reads=0;let changed=false;
      fsPromises.readFile=async (file,...options)=>{
        const bytes=await original(file,...options);
        if(file===ledgerPath(roots)){
          reads++;
          if(!changed){
            changed=true;const wrapped=JSON.parse(Buffer.from(bytes).toString());
            wrapped.state.revision++;wrapped.state.batches[accepted.batch.id].paused=true;wrapped.state.batches[accepted.batch.id].status='paused';
            for(const job of Object.values(wrapped.state.jobs))job.progress.message='later revision';
            wrapped.sha256=hash(JSON.stringify(wrapped.state));await writeFile(file,JSON.stringify(wrapped)+'\n');
          }
        }
        return bytes;
      };
      syncBuiltinESMExports();
      let snapshot;
      try{snapshot=await store.loadReviewQueueSnapshot({...roots,workspaceId:'wfixture'});}
      finally{fsPromises.readFile=original;syncBuiltinESMExports();}
      assert.equal(reads,1);assert.equal(snapshot.batch.status,'running');
      assert.ok(snapshot.jobs.every(job=>job.progress.message!=='later revision'));
      const later=await store.loadReviewQueueSnapshot({...roots,workspaceId:'wfixture'});
      assert.equal(later.revision,snapshot.revision+1);assert.equal(later.batch.status,'paused');
      assert.ok(later.jobs.every(job=>job.progress.message==='later revision'));
    });
    if (process.platform === 'win32') await test('Windows atomic replacement retries are finite and keep old committed facts intact', async () => {
      const roots = await fresh('windows-replace'); await enqueue(roots, 'win1'); const path = ledgerPath(roots); const before = await readFile(path);
      const original = fsPromises.rename; let attempts = 0;
      fsPromises.rename = async (from, to) => { if (to === path) { attempts++; assert.ok(before.equals(await readFile(path))); throw Object.assign(new Error('fixture denied replacement'), {code: 'EPERM'}); } return original(from, to); };
      syncBuiltinESMExports();
      try { await assert.rejects(enqueue(roots, 'win2'), {code: 'EPERM'}); } finally { fsPromises.rename = original; syncBuiltinESMExports(); }
      assert.equal(attempts, 6); assert.ok(before.equals(await readFile(path))); assert.equal((await enqueue(roots, 'win2')).job.seq, 2);
      attempts = 0;
      fsPromises.rename = async (from, to) => { if (to === path && ++attempts < 3) throw Object.assign(new Error('fixture transient denial'), {code: 'EPERM'}); return original(from, to); };
      syncBuiltinESMExports();
      try { await enqueue(roots, 'win3'); } finally { fsPromises.rename = original; syncBuiltinESMExports(); }
      assert.equal(attempts, 3); assert.equal((await store.listJobs(roots)).length, 3);
    });
  } finally {
    for (const child of owned) { child.kill('SIGKILL'); }
    const explicit = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6);
    const output = resolve(ROOT, explicit || join(process.env.DSH_VERIFICATION_EVIDENCE_DIR || 'data/verify', `job-store-${Date.now()}-${randomUUID().slice(0, 8)}.json`));
    await mkdir(dirname(output), {recursive: true}); await writeFile(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    console.log(`Evidence: ${output}`);
  }
}
