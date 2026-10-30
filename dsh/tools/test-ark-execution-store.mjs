/** Fresh physical-attempt/FIFO controls: real peer processes, local Response streams, zero HTTP/model calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve, dirname, join, relative, isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID, createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createJobOwner, isJobOwnerAlive} from '../src/job-store.js';

const SCRIPT = fileURLToPath(import.meta.url), ROOT = resolve(dirname(SCRIPT), '..');
const flag = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const SOURCE_ROOT=resolve(flag('source-root')||ROOT),SOURCE_FILE=join(SOURCE_ROOT,'src/ark-execution-store.js');
assert(SOURCE_ROOT===ROOT||relative(join(ROOT,'data/optimization/runs'),SOURCE_ROOT)&&!relative(join(ROOT,'data/optimization/runs'),SOURCE_ROOT).startsWith('..'),'Source fixture must be a saved project snapshot');
const store=await import(pathToFileURL(SOURCE_FILE).href);
const hash = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(done => setTimeout(done, ms));
const bounded = async (promise, ms = 20000) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned software fixture deadline')), ms); })]); } finally { clearTimeout(timer); } };
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const answer = await fn(); if (answer) return answer; await pause(60); } throw Error('Software state deadline'); };
const body = tag => ({model: `software-${tag}`, input: [{role: 'user', content: `Exact raw payload ${tag} 中文`}], stream: false});
const scope = tag => ({jobRunId: `run-${tag}`, sessionId: `s${tag.replace(/[^a-z0-9]/g, '')}`, stage: 'window', unitId: `unit-${tag}`,
  binding: {versionId: `v-${tag}`, sourceSha256: hash(`source-${tag}`), workSha256: hash(`work-${tag}`), mutationEpoch: 0}});
const rawPayload = usage => JSON.stringify({id: 'provider-response-local', output_text: 'software fixture only', ...(usage === null ? {} : {usage})});
const knownUsage = {input_tokens: 11, output_tokens: 3, input_tokens_details: {cached_tokens: 4}, total_tokens: 14};
const consume = response => response.json();
const execute = (roots, tag, overrides = {}) => store.executeArkAttempt({...roots, body: body(tag), scope: scope(tag), logicalRequestId: `logical-${tag}`,
  transport: async () => new Response(rawPayload(knownUsage), {headers: {'content-type': 'application/json', 'x-request-id': 'local-request-id'}}), consumeResponse: consume, ...overrides});

if (flag('child')) {
  const config = JSON.parse(process.env.DSH_ARK_EXECUTION_TEST_CONFIG), mode = flag('child');
  let release; const released = new Promise(done => { release = done; });
  process.on('message', message => { if (message?.release) release(); });
  try {
    const answer = await execute(config.roots, config.tag, {faultHooks: {
      afterQueued: info => { process.send?.({type: 'queued', attemptId: info.attempt.id}); if (mode === 'crash-queued') process.exit(91); },
      afterSending: info => { if (mode === 'crash-sending') { process.send?.({type: 'sending', attemptId: info.attempt.id}); process.exit(91); } },
      afterReceiptPersisted: info => { if (mode === 'crash-receipt') { process.send?.({type: 'receipt', receipt: info.receipt}); process.exit(91); } },
    }, transport: async ({attemptId}) => {
      process.send?.({type: 'sending', attemptId, at: Date.now()});
      if (mode === 'hold') return new Response(new ReadableStream({start(controller) { controller.enqueue(Buffer.from(rawPayload(knownUsage))); released.then(() => controller.close()); }}), {headers: {'content-type': 'application/json'}});
      return new Response(rawPayload(knownUsage), {headers: {'content-type': 'application/json'}});
    }});
    process.send?.({type: 'finished', answer});
  } catch (error) { process.send?.({type: 'failed', error: {code: error.code, message: error.message}, receipt: error.arkAttemptReceipt}); process.exitCode = 1; }
  if (process.connected) process.disconnect();
} else {
  const evidenceRoot = resolve(flag('evidence-root') || process.env.DSH_VERIFICATION_EVIDENCE_DIR || join(ROOT, 'data/verify/ark-execution-store'));
  const within = (parent, child) => { const path = relative(resolve(parent), resolve(child)); return path === '' || !isAbsolute(path) && !path.startsWith('..'); };
  assert(within(join(ROOT, 'data/verify'), evidenceRoot) || within(join(ROOT, 'data/optimization/runs'), evidenceRoot), 'Evidence must be in an authorized fresh tree');
  async function guard(path) { for (let cursor = resolve(path); ; cursor = dirname(cursor)) { assert(!existsSync(join(cursor, 'complete.json')), 'Sealed evidence ancestor'); if (existsSync(cursor)) { const stat = await fs.lstat(cursor); assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Evidence alias refused'); assert.equal(resolve(await fs.realpath(cursor)), cursor, 'Evidence realpath differs'); } if (dirname(cursor) === cursor) break; } }
  await guard(evidenceRoot); const OUT = join(evidenceRoot, `ark-execution-store-${Date.now()}-${randomUUID()}`); await fs.mkdir(OUT, {recursive: true});
  const report = {schemaVersion: 1, generatedAt: new Date().toISOString(), out: OUT, realArkCalls: 0, httpCalls: 0, serversStarted: 0,
    sourceRoot:SOURCE_ROOT,only:flag('only')||null,interfaces:{queueTimeoutMs:'optional positive milliseconds; queued only',responseTimeoutMs:'optional positive milliseconds from sending',externalSignal:'user cancellation',unknownErrorCode:'ARK_ATTEMPT_UNKNOWN_SENT',queueTimeoutCode:'ARK_QUEUE_TIMEOUT'},
    sourceBefore: {execution: hash(await fs.readFile(SOURCE_FILE)), owner: hash(await fs.readFile(join(SOURCE_ROOT, 'src/job-store.js'))), test: hash(await fs.readFile(SCRIPT))},
    checks: [], processes: [], cleanup: [], roots: [], semanticQualityClaimed: false};
  await fs.writeFile(join(OUT, 'test-source.mjs'), await fs.readFile(SCRIPT), {flag: 'wx'});
  const owned = new Set();
  async function fresh(tag, concurrency = 1) {
    const base = join(OUT, 'storage', tag), seven = Object.fromEntries(['sessions', 'versions', 'workspaces', 'audit', 'legacy', 'ingestions', 'jobs','plans'].map(key => [key, join(base, key)]));
    for (const path of Object.values(seven)) await fs.mkdir(path, {recursive: true});
    const roots = {storageRoot: join(base, 'ark'), poolId: 'project-account', policy: {concurrency}}; await store.initializeArkExecutionStore(roots);
    report.roots.push({tag, roots, seven}); return roots;
  }
  function child(mode, roots, tag) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:ARK|OPENAI|DOUBAO|VOLC|ANTHROPIC|API_KEY|SECRET|CREDENTIAL|ACCESS_TOKEN|PROXY)/i.test(key) && !/^DSH_(?:SESSION|WORKING_VERSION|WORKSPACE|AUDIT|LEGACY|INGESTION|JOB|REVIEW_PLAN)_ROOT$/.test(key)));
    const fixture = report.roots.find(row => row.roots.storageRoot === roots.storageRoot).seven;
    Object.assign(env, {DSH_ARK_EXECUTION_TEST_CONFIG: JSON.stringify({roots, tag}), DSH_ARK_EXECUTION_ROOT: roots.storageRoot, DSH_ARK_POOL_ID: roots.poolId,
      DSH_ARK_POOL_CONCURRENCY: String(roots.policy.concurrency), DSH_SESSION_ROOT: fixture.sessions, DSH_WORKING_VERSION_ROOT: fixture.versions,
      DSH_WORKSPACE_ROOT: fixture.workspaces, DSH_AUDIT_ROOT: fixture.audit, DSH_LEGACY_ROOT: fixture.legacy, DSH_INGESTION_ROOT: fixture.ingestions, DSH_JOB_ROOT: fixture.jobs,DSH_REVIEW_PLAN_ROOT:fixture.plans});
    const proc = spawn(process.execPath, [SCRIPT, `--child=${mode}`,`--source-root=${SOURCE_ROOT}`], {cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']}); owned.add(proc);
    const record = {pid: proc.pid, mode, tag, startedAt: new Date().toISOString(), events: [], stderr: ''}; report.processes.push(record);
    proc.stderr.on('data', data => record.stderr += data); proc.stdout.resume();
    const waits = new Map(); proc.on('message', message => { record.events.push(message); waits.get(message.type)?.(message); });
    const waitFor = type => { const found = record.events.find(event => event.type === type); if (found) return Promise.resolve(found); return new Promise(done => waits.set(type, done)); };
    const exited = new Promise((done, reject) => { proc.once('error', reject); proc.once('exit', (code, signal) => { record.exit = {code, signal}; owned.delete(proc); done(record.exit); }); });
    return {proc, record, waitFor, exited};
  }
  async function stop(entry) { if (entry.proc.exitCode === null && entry.proc.signalCode === null) entry.proc.kill('SIGKILL'); await bounded(entry.exited, 7000); report.cleanup.push({pid: entry.proc.pid, closed: true}); }
  async function check(name, action) { if(flag('only')==='new-safety'&&!name.startsWith('safety:'))return;const started = Date.now(); try { const facts = await action(); report.checks.push({name, ok: true, elapsedMs: Date.now() - started, facts}); console.log('PASS ' + name); } catch (error) { report.checks.push({name, ok: false, elapsedMs: Date.now() - started, error: {message: error.message, stack: error.stack}}); console.log('FAIL ' + name + ': ' + error.message); } }
  try {
    await check('safety: readonly DOMException and frozen transport errors retain unknown receipt and never resend',async()=>{
      const facts=[];for(const [tag,cause]of [['dom',new DOMException('software aborted transport','AbortError')],['frozen',Object.freeze(Object.assign(Error('software disconnected'),{code:'PROVIDER_DISCONNECTED'}))]]){
        const roots=await fresh('readonly-'+tag);let calls=0;const originalCode=cause.code;const error=await execute(roots,tag,{transport:async()=>{calls++;throw cause;}}).catch(e=>e);
        assert(error instanceof Error&&!(error instanceof DOMException));assert.notEqual(error,cause);assert.equal(error.cause,cause);assert.equal(error.code,'ARK_ATTEMPT_UNKNOWN_SENT');assert.equal(cause.code,originalCode);assert.equal(error.safeToRetry,false);assert.equal(error.arkAttemptReceipt.status,'unknown_sent');assert.equal(error.arkAttemptReceipt.usageState,'unknown');
        const saved=await store.readArkAttempt({...roots,attemptId:error.arkAttemptReceipt.attemptId});assert.deepEqual(saved.receipt,error.arkAttemptReceipt);const blocked=await execute(roots,tag+'blocked',{transport:async()=>{calls++;return new Response('{}');}}).catch(e=>e);assert.equal(blocked.code,'ARK_EXECUTION_BLOCKED');assert.equal(blocked.arkAttemptReceipt.usageState,'not_sent');assert.equal(calls,1);const summary=await store.readArkExecutionSummary(roots);assert.equal(summary.blockedUnknownCount,1);assert.equal(summary.physicalSendCount,1);facts.push({kind:tag,errorClass:error.constructor.name,causeClass:cause.constructor.name,code:error.code,receipt:error.arkAttemptReceipt,blockedCode:blocked.code,calls});
      }return facts;
    });
    await check('safety: frozen consumer and receipt-index errors keep complete body and known receipt',async()=>{
      const roots=await fresh('frozen-complete'),consumer=Object.freeze(Error('software parse failure'));
      const failed=await execute(roots,'frozenconsumer',{consumeResponse:async()=>{throw consumer;}}).catch(e=>e);assert.equal(failed.cause,consumer);assert.equal(failed.code,'ARK_CONSUMER_FAILED');assert.equal(failed.arkAttemptReceipt.status,'failed');assert.equal(failed.arkAttemptReceipt.bodyComplete,true);assert.equal(failed.safeToRetry,false);
      const commit=Object.freeze(Error('software index failure'));const known=await execute(roots,'frozencommit',{faultHooks:{afterReceiptPersisted:()=>{throw commit;}}}).catch(e=>e);assert.equal(known.cause,commit);assert.equal(known.code,'ARK_ATTEMPT_COMMIT_FAILED');assert.equal(known.arkAttemptReceipt.status,'confirmed');assert.equal(known.safeToRetry,false);const recovered=await store.recoverArkExecutions(roots);assert.equal(recovered.physicalSendCount,2);assert.equal(recovered.activeCount,0);return{consumerReceipt:failed.arkAttemptReceipt,commitReceipt:known.arkAttemptReceipt};
    });
    await check('safety: time spent FIFO queued does not consume response deadline',async()=>{
      const roots=await fresh('separate-deadlines');await store.noteArkCooldown(700,roots);let queuedAt,sentAt;const result=await execute(roots,'deadline-separate',{responseTimeoutMs:300,faultHooks:{afterQueued:()=>{queuedAt=Date.now();}},transport:async({signal})=>{sentAt=Date.now();assert(!signal.aborted);return new Response(rawPayload(knownUsage));}});
      assert(sentAt-queuedAt>300);assert.equal(result.receipt.status,'confirmed');assert.equal(result.receipt.bodyComplete,true);assert.equal((await store.readArkExecutionSummary(roots)).activeCount,0);const saved=await store.readArkAttempt({...roots,attemptId:result.receipt.attemptId});assert.equal(saved.request.responseTimeoutMs,300);assert.equal(saved.request.queueTimeoutMs,null);return{queueWaitMs:sentAt-queuedAt,responseTimeoutMs:300,receipt:result.receipt};
    });
    await check('safety: finite queue deadline persists not_sent without invoking transport',async()=>{
      const roots=await fresh('queue-deadline');await store.noteArkCooldown(2000,roots);const controller=new AbortController();let calls=0;const fallback=setTimeout(()=>controller.abort(Error('software baseline cleanup')),800);let error;
      try{error=await bounded(execute(roots,'queue-timeout',{queueTimeoutMs:200,responseTimeoutMs:1000,signal:controller.signal,transport:async()=>{calls++;return new Response('{}');}}).catch(e=>e),1400);}finally{clearTimeout(fallback);controller.abort(Error('software fixture cleanup'));}
      assert.equal(error.code,'ARK_QUEUE_TIMEOUT');assert.equal(error.safeToRetry,false);assert.equal(error.arkAttemptReceipt.usageState,'not_sent');assert.equal(error.arkAttemptReceipt.error.timeoutPhase,'queue');assert.equal(error.arkAttemptReceipt.bodyComplete,false);assert.equal(calls,0);const summary=await store.readArkExecutionSummary(roots);assert.equal(summary.physicalSendCount,0);assert.equal(summary.activeCount,0);return{code:error.code,calls,receipt:error.arkAttemptReceipt};
    });
    await check('safety: response deadline covers partial body and retains unknown capacity',async()=>{
      const roots=await fresh('response-deadline');const controller=new AbortController();let calls=0,responseSignal;const fallback=setTimeout(()=>controller.abort(Error('software baseline cleanup')),900);let error;
      try{error=await bounded(execute(roots,'response-timeout',{responseTimeoutMs:220,signal:controller.signal,transport:async({signal})=>{responseSignal=signal;calls++;return new Response(new ReadableStream({start(stream){stream.enqueue(Buffer.from('partial timed body'));}}));}}).catch(e=>e),1600);}finally{clearTimeout(fallback);}
      assert.equal(error.code,'ARK_ATTEMPT_UNKNOWN_SENT');assert.equal(error.cause.code,'ARK_RESPONSE_TIMEOUT');assert.equal(error.safeToRetry,false);assert.equal(error.arkAttemptReceipt.status,'unknown_sent');assert.equal(error.arkAttemptReceipt.error.timeoutPhase,'response');assert.equal(error.arkAttemptReceipt.bodyComplete,false);assert.equal(calls,1);assert(responseSignal.aborted&&!controller.signal.aborted);const saved=await store.readArkAttempt({...roots,attemptId:error.arkAttemptReceipt.attemptId});assert.equal(hash(saved.rawResponse),error.arkAttemptReceipt.rawResponseSha256);assert.equal(saved.rawResponse.toString(),'partial timed body');const summary=await store.readArkExecutionSummary(roots);assert.equal(summary.activeCount,1);assert.equal(summary.blockedUnknownCount,1);return{code:error.code,causeCode:error.cause.code,externalAborted:controller.signal.aborted,receipt:error.arkAttemptReceipt};
    });
    await check('safety: external default DOMException cancellation survives independent response budget',async()=>{
      const roots=await fresh('external-dom-cancel');const controller=new AbortController();let started=false;const promise=execute(roots,'externalcancel',{responseTimeoutMs:5000,signal:controller.signal,transport:async()=>{started=true;return new Response(new ReadableStream({start(stream){stream.enqueue(Buffer.from('external partial'));}}));}}).catch(e=>e);await until(()=>started);controller.abort();const error=await bounded(promise,2000);assert.equal(error.code,'ARK_ATTEMPT_UNKNOWN_SENT');assert.equal(error.cause,controller.signal.reason);assert.equal(error.safeToRetry,false);assert.equal(error.arkAttemptReceipt.status,'unknown_sent');assert.equal(error.arkAttemptReceipt.usageState,'unknown');return{code:error.code,causeClass:error.cause.constructor.name,causeCode:error.cause.code,receipt:error.arkAttemptReceipt};
    });
    await check('canonical pool policy and immutable exact payload/receipt SHA, known zero versus missing usage', async () => {
      const roots = await fresh('usage');
      await assert.rejects(store.initializeArkExecutionStore({...roots, policy: {concurrency: 2}}), {code: 'ARK_POLICY_CONFLICT'});
      const zero = await execute(roots, 'zero', {transport: async () => new Response(rawPayload({input_tokens: 0, output_tokens: 0}))});
      const unknown = await execute(roots, 'missing', {transport: async () => new Response(rawPayload(null))});
      assert.equal(zero.receipt.usageState, 'known'); assert.equal(zero.receipt.usage.input_tokens, 0); assert.equal(zero.receipt.usage.cached_tokens, null);
      assert.equal(unknown.receipt.usageState, 'unknown'); assert.equal(unknown.receipt.usage.output_tokens, null);
      const saved = await store.readArkAttempt({...roots, attemptId: zero.receipt.attemptId});
      assert.equal(saved.receipt.rawResponseSha256, hash(saved.rawResponse)); assert.equal(saved.receipt.bodySha256, hash(JSON.stringify(body('zero'))));
      assert.deepEqual(saved.request.body, body('zero')); assert.equal(saved.receipt.responseId, 'provider-response-local');
      const before = await store.readArkExecutionSummary(roots), after = await store.readArkExecutionSummary(roots); assert.deepEqual(after, before);
      assert.equal(after.physicalSendCount, 2); assert.equal(after.unknownUsageAttempts, 1); assert.equal(after.knownFieldCounts.input_tokens, 1);
      return {attemptCount: after.attemptCount, usageTotals: after.usageTotals, unknownUsageAttempts: after.unknownUsageAttempts};
    });
    await check('two real peers share FIFO; headers and first body chunk do not release the slot', async () => {
      const roots = await fresh('two-peers'), first = child('hold', roots, 'first'); await bounded(first.waitFor('sending'));
      const second = child('auto', roots, 'second'); await bounded(second.waitFor('queued'));
      let thirdSent = false; const third = execute(roots, 'third', {transport: async () => { thirdSent = true; return new Response(rawPayload(knownUsage)); }});
      await until(async () => (await store.readArkExecutionSummary(roots)).counts.queued === 2);
      await pause(350); const held = await store.recoverArkExecutions(roots); assert.equal(held.activeCount, 1); assert.equal(held.counts.sending, 1);
      assert.equal(second.record.events.some(event => event.type === 'sending'), false); assert.equal(thirdSent, false);
      first.proc.send({release: true}); await bounded(first.waitFor('finished')); const secondDone = await bounded(second.waitFor('finished')); await bounded(third);
      await bounded(Promise.all([first.exited, second.exited]));
      const final = await store.readArkExecutionSummary(roots); assert.equal(final.activeCount, 0); assert.equal(final.counts.confirmed, 3);
      assert(final.attempts.find(row => row.scope.jobRunId === 'run-second').seq < final.attempts.find(row => row.scope.jobRunId === 'run-third').seq);
      assert(Date.parse(secondDone.answer.receipt.sendingAt) >= Date.parse(final.attempts[0].receipt.finishedAt));
      return {peerPids: [first.proc.pid, second.proc.pid], heldActive: held.activeCount, orderedAttempts: final.attempts.map(row => [row.seq, row.scope.jobRunId, row.status])};
    });
    await check('queued cancellation persists not_sent and never invokes transport', async () => {
      const roots = await fresh('abort-queued'), peer = child('hold', roots, 'holder'); await bounded(peer.waitFor('sending'));
      const controller = new AbortController(); let calls = 0;
      const waiting = execute(roots, 'cancel', {signal: controller.signal, transport: async () => { calls++; return new Response('{}'); }});
      const rejected = waiting.catch(error => error);
      await until(async () => (await store.readArkExecutionSummary(roots)).counts.queued === 1); controller.abort(Error('software abort'));
      const error = await bounded(rejected); assert.equal(calls, 0); assert.equal(error.arkAttemptReceipt.usageState, 'not_sent');
      const summary = await store.readArkExecutionSummary(roots); assert.equal(summary.counts.notSent, 1); assert.equal(summary.activeCount, 1);
      peer.proc.send({release: true}); await bounded(peer.waitFor('finished')); await bounded(peer.exited); return {calls, cancellationReceipt: error.arkAttemptReceipt.attemptId};
    });
    await check('shared Retry-After delays another process and backoff abort exits without sending', async () => {
      const roots = await fresh('cooldown'); const limited = await execute(roots, '429', {transport: async () => new Response(rawPayload(null), {status: 429, headers: {'retry-after': '0.7'}})});
      assert.equal(limited.receipt.status, 'failed'); const snapshot = await store.readArkExecutionSummary(roots); assert(snapshot.notBefore > Date.now()); assert.equal(snapshot.activeCount, 0);
      const peer = child('auto', roots, 'cooldownpeer'); await bounded(peer.waitFor('queued')); const sent = await bounded(peer.waitFor('sending')); await bounded(peer.exited);
      assert(sent.at >= snapshot.notBefore - 25);
      await store.noteArkCooldown(1000, roots); const controller = new AbortController(); let calls = 0, started = Date.now();
      const waiting = execute(roots, 'backoffcancel', {signal: controller.signal, transport: async () => { calls++; return new Response('{}'); }}).catch(error => error);
      await until(async () => (await store.readArkExecutionSummary(roots)).counts.queued === 1); controller.abort(); const error = await bounded(waiting);
      assert.equal(error.arkAttemptReceipt.usageState, 'not_sent'); assert.equal(calls, 0); assert(Date.now() - started < 1000);
      return {peerSentAt: sent.at, sharedNotBefore: snapshot.notBefore, abortElapsedMs: Date.now() - started};
    });
    await check('live birth identity is never TTL-stolen; reused PID identity is rejected', async () => {
      const roots = await fresh('identity'), peer = child('hold', roots, 'live'); await bounded(peer.waitFor('sending'));
      await pause(1100); const recovered = await store.recoverArkExecutions(roots); assert.equal(recovered.counts.sending, 1); assert.equal(recovered.blockedUnknownCount, 0);
      const owner = await createJobOwner(); assert.equal(await isJobOwnerAlive(owner), true);
      if (owner.birthIdentity) assert.equal(await isJobOwnerAlive({...owner, birthIdentity: owner.birthIdentity + '-different-birth'}), false);
      peer.proc.send({release: true}); await bounded(peer.exited); return {livePeerPid: peer.proc.pid, platform: process.platform, realBirthIdentityAvailable: !!owner.birthIdentity};
    });
    await check('dead sending remains unknown_sent, holds capacity and is not automatically reissued', async () => {
      const roots = await fresh('dead-sending'), peer = child('hold', roots, 'dead'); await bounded(peer.waitFor('sending')); await stop(peer);
      const summary = await store.recoverArkExecutions(roots); assert.equal(summary.blockedUnknownCount, 1); assert.equal(summary.activeCount, 1); assert.equal(summary.unknownUsageAttempts, 1);
      let calls = 0;
      const error = await bounded(execute(roots, 'afterdead', {transport: async () => { calls++; return new Response('{}'); }}).catch(error => error));
      assert.equal(error.code, 'ARK_EXECUTION_BLOCKED'); assert.equal(error.arkAttemptReceipt.usageState, 'not_sent'); assert.equal(calls, 0);
      const again = await store.recoverArkExecutions(roots); assert.equal(again.physicalSendCount, 1); assert.equal(again.activeCount, 1);
      return {unknownAttempt: again.attempts[0].id, callsAfterRecovery: calls, retainedCapacity: again.activeCount};
    });
    await check('partial body/active abort persist raw SHA and unknown usage while retaining uncertain capacity', async () => {
      const roots = await fresh('broken-body'); let transportCalls = 0, sawChunk = false;
      const controller = new AbortController();
      const attempt = execute(roots, 'activeabort', {signal: controller.signal, transport: async () => { transportCalls++; return new Response(new ReadableStream({start(stream) { stream.enqueue(Buffer.from('partial raw body')); }})); }, onRawChunk: () => { sawChunk = true; }}).catch(error => error);
      await until(() => sawChunk); controller.abort(Error('software active abort'));
      const result = await bounded(attempt, 3000);
      assert.equal(result.code, 'ARK_ATTEMPT_UNKNOWN_SENT'); assert.equal(result.arkAttemptReceipt.usageState, 'unknown');
      assert.equal(result.arkAttemptReceipt.bodyComplete, false); assert.equal(transportCalls, 1);
      const summary = await store.readArkExecutionSummary(roots); assert.equal(summary.activeCount, 1); return {rawSha256: result.arkAttemptReceipt.rawResponseSha256};
    });
    await check('receipt-first process crash or index-commit failure reconciles without silently retrying a known response', async () => {
      const roots = await fresh('receipt-crash'), peer = child('crash-receipt', roots, 'receipt'); await bounded(peer.waitFor('receipt')); assert.equal((await bounded(peer.exited)).code, 91);
      const summary = await store.recoverArkExecutions(roots); assert.equal(summary.counts.confirmed, 1); assert.equal(summary.activeCount, 0); assert.equal(summary.physicalSendCount, 1);
      const receipt = (await store.readArkAttempt({...roots, attemptId: summary.attempts[0].id})).receipt; assert.equal(receipt.usage.input_tokens, 11);
      let sends = 0;
      const failure = await execute(roots, 'indexfailure', {transport: async () => { sends++; return new Response(rawPayload(knownUsage)); },
        faultHooks: {afterReceiptPersisted: () => { throw Error('software index commit fault'); }}}).catch(error => error);
      assert.equal(failure.code, 'ARK_ATTEMPT_COMMIT_FAILED'); assert.equal(failure.safeToRetry, false); assert.equal(failure.arkAttemptReceipt.status, 'confirmed');
      const reconciled = await store.recoverArkExecutions(roots); assert.equal(reconciled.counts.confirmed, 2); assert.equal(reconciled.activeCount, 0); assert.equal(sends, 1);
      return {reconciledAttempt: receipt.attemptId, physicalSendCount: reconciled.physicalSendCount, confirmedIndexFailure: failure.arkAttemptReceipt.attemptId};
    });
    await check('dead queued intent is not_sent and does not stall FIFO behind a live holder', async () => {
      const roots = await fresh('queued-crash'), holder = child('hold', roots, 'holder'); await bounded(holder.waitFor('sending'));
      const dead = child('crash-queued', roots, 'deadqueued'); await bounded(dead.waitFor('queued')); assert.equal((await bounded(dead.exited)).code, 91);
      const recovered = await store.recoverArkExecutions(roots); assert.equal(recovered.counts.notSent, 1); assert.equal(recovered.counts.queued, 0);
      holder.proc.send({release: true}); await bounded(holder.exited); await execute(roots, 'afterqueued');
      assert.equal((await store.readArkExecutionSummary(roots)).counts.confirmed, 2); return {notSent: recovered.counts.notSent};
    });
    await check('consumer failure preserves known cost and raw bytes; repeated summary never double-counts cached input', async () => {
      const roots = await fresh('consume-failure'); const error = await execute(roots, 'parsefail', {consumeResponse: async () => { throw Error('software parser failure'); }}).catch(error => error);
      assert.equal(error.arkAttemptReceipt.status, 'failed'); assert.equal(error.arkAttemptReceipt.bodyComplete, true); assert.equal(error.arkAttemptReceipt.usage.input_tokens, 11);
      assert.equal(error.safeToRetry, false);
      const first = await store.readArkExecutionSummary(roots), second = await store.readArkExecutionSummary(roots); assert.deepEqual(second, first);
      assert.equal(first.activeCount, 0); assert.deepEqual(first.usageTotals, {input_tokens: 11, output_tokens: 3, cached_tokens: 4, total_tokens: 14});
      const saved = await store.readArkAttempt({...roots, attemptId: error.arkAttemptReceipt.attemptId}); assert.equal(hash(saved.rawResponse), error.arkAttemptReceipt.rawResponseSha256);
      await fs.writeFile(join(roots.storageRoot, 'pools', roots.poolId, 'attempts', saved.attempt.id, 'raw-response.bin'), 'tampered local fixture');
      await assert.rejects(store.readArkAttempt({...roots, attemptId: saved.attempt.id}), {code: 'ARK_RESPONSE_HASH_MISMATCH'}); return {usageTotals: first.usageTotals};
    });
    await check('sealed ancestors, path aliases and credential-shaped fields are rejected before transport', async () => {
      const roots = await fresh('guards'); const sealed = join(OUT, 'sealed-fixture'); await fs.mkdir(sealed); await fs.writeFile(join(sealed, 'complete.json'), '{}');
      await assert.rejects(store.initializeArkExecutionStore({storageRoot: join(sealed, 'ark')}), {code: 'ARK_STORE_SEALED'});
      const real = join(OUT, 'real-fixture'), alias = join(OUT, 'alias-fixture'); await fs.mkdir(real); await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(store.initializeArkExecutionStore({storageRoot: join(alias, 'ark')}), {code: 'ARK_STORE_ALIAS'});
      let sent = 0; await assert.rejects(execute(roots, 'secret', {scope: {...scope('secret'), authorization: 'fixture-redacted'}, transport: async () => { sent++; return new Response('{}'); }}), {code: 'ARK_EXECUTION_NOT_JSON'}); assert.equal(sent, 0);
      return {aliasesRejected: true, sealedRejected: true, credentialFieldsRejected: true};
    });
  } finally {
    for (const proc of [...owned]) { const entry = {proc, exited: new Promise(done => proc.once('exit', done))}; await stop(entry).catch(error => report.cleanup.push({pid: proc.pid, closed: false, error: error.message})); }
    report.sourceAfter = {execution: hash(await fs.readFile(SOURCE_FILE)), owner: hash(await fs.readFile(join(SOURCE_ROOT, 'src/job-store.js'))), test: hash(await fs.readFile(SCRIPT))};
    report.sourceFrozen = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter); report.ownedChildrenClosed = owned.size === 0;
    report.passed = report.checks.filter(row => row.ok).length; report.failed = report.checks.length - report.passed;
    await guard(OUT); await fs.writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    console.log(`Ark execution store: ${report.passed}/${report.checks.length}; API 0; evidence ${join(OUT, 'report.json')}`);
    if (report.failed || !report.sourceFrozen || !report.ownedChildrenClosed) process.exitCode = 1;
  }
}
