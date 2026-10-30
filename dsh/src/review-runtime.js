/** Durable review execution and subscriptions; document/model policy stays in review.js. */
import * as defaultStore from './job-store.js';

const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const PUBLIC_EVENTS = new Set(['doc', 'progress', 'issue']);
const messageOf = (error) => String(error?.message || error);
const eventPlain = (data) => JSON.parse(JSON.stringify(data));

function runtimeError(code, message, cause) {
  const error = new Error(message, cause ? {cause} : undefined);
  error.code = code;
  return error;
}

/**
 * execute({job,signal,emit}) returns an immutable outcome. emit(type,data) queues
 * an event synchronously; subscribers see it only after its batch is durable.
 * publish({job,outcome,leaseToken}) materializes that outcome into the session
 * and returns {jobRunId,versionId,terminalData?}. leaseToken is the short
 * publication lease, not the preceding execution lease.
 */
export async function createReviewRuntime({storeArgs = {}, owner, execute, publish,
  pollMs = 250, flushMs = 30, eventBatchSize = 32, publicationConcurrency = 4, onProgress = () => {},
  onRuntimeError = () => {}, beforeClaim = null, store = defaultStore, autoStart = true} = {}) {
  if (typeof execute !== 'function' || typeof publish !== 'function')
    throw runtimeError('REVIEW_RUNTIME_CONFIG', '审阅运行层需要执行与发布回调');
  if (beforeClaim !== null && typeof beforeClaim !== 'function')
    throw runtimeError('REVIEW_RUNTIME_CONFIG', '领取任务前的执行准入检查无效');
  if (!Number.isInteger(pollMs) || pollMs < 10 || !Number.isInteger(flushMs) || flushMs < 0
    || !Number.isInteger(eventBatchSize) || eventBatchSize < 1
    || !Number.isInteger(publicationConcurrency) || publicationConcurrency < 1)
    throw runtimeError('REVIEW_RUNTIME_CONFIG', '审阅运行层计时或事件批量配置无效');
  await store.initializeJobStore({...storeArgs});
  owner ||= await store.createJobOwner();
  const running = new Map();
  const publishing = new Map();
  const subscribers = new Map();
  const waiters = new Map();
  const errors = [];
  let timer = null;
  let pumpPromise = null;
  let closed = false;
  let lastRecovery = 0;

  const args = (extra = {}) => ({...storeArgs, ...extra});
  const reportError = (error, context) => {
    errors.push({at: new Date().toISOString(), code: error?.code || null, message: messageOf(error), ...context});
    if (errors.length > 100) errors.shift();
    try { onRuntimeError(error, context); } catch { /* Reporting cannot change durable state. */ }
  };
  const load = (jobId) => store.loadJob(args({jobId}));
  const executionCommitted = (record, job) =>
    (job.status === 'publishing' || TERMINAL.has(job.status))
    && job.outcomeReceipt?.leaseToken === record.token;

  function deliver(view, event) {
    if (!view.active || event.seq <= view.afterSeq) return;
    view.afterSeq = event.seq;
    const item = {seq: event.seq, event: event.type, type: event.type, data: event.data,
      jobId: view.jobId, jobRunId: event.jobRunId || view.jobId,
      versionId: event.versionId || null, at: event.at || null};
    try {
      const sent = view.onEvent(item);
      if (sent && typeof sent.catch === 'function')
        sent.catch((error) => { view.stop(); reportError(error, {jobId: view.jobId, phase: 'subscriber'}); });
    }
    catch (error) { view.stop(); reportError(error, {jobId: view.jobId, phase: 'subscriber'}); }
    if (['done', 'error', 'cancelled'].includes(event.type)) view.stop();
  }

  function broadcast(jobId, events) {
    for (const view of subscribers.get(jobId) || []) {
      // Replay and the local append callback can overlap. Sequence fencing makes
      // delivery once-per-subscription even when both see the same durable batch.
      if (view.reading) view.pending.push(...events);
      else for (const event of events) deliver(view, event);
    }
  }

  async function flush(record) {
    if (record.flushTimer) { clearTimeout(record.flushTimer); record.flushTimer = null; }
    const prior = record.flushing || Promise.resolve();
    const operation = prior.then(async () => {
      if (record.flushError) throw record.flushError;
      while (record.events.length) {
        const events = record.events.splice(0, eventBatchSize);
        try {
          const saved = await store.appendJobEvents(args({jobId: record.job.id,
            leaseToken: record.token, events}));
          broadcast(record.job.id, saved);
        } catch (cause) {
          const error = runtimeError('REVIEW_EVENT_SAVE_FAILED', `审阅进度记录保存失败：${messageOf(cause)}`, cause);
          record.flushError = error;
          record.controller.abort(error);
          throw error;
        }
      }
    });
    record.flushing = operation;
    try { await operation; }
    finally { if (record.flushing === operation) record.flushing = null; }
  }

  function emitFor(record, type, data = {}) {
    if (!PUBLIC_EVENTS.has(type)) throw runtimeError('REVIEW_EVENT_INVALID', '执行器只能发布文档、进度和问题事件');
    if (record.ended || record.controller.signal.aborted || record.flushError) return;
    const eventData = {...data, jobId: record.job.id, jobRunId: record.job.jobRunId || record.job.id,
      versionId: record.job.binding.versionId};
    // Capture now: the engine can change rule issue severity during recheck.
    record.events.push({type, data: eventPlain(eventData)});
    if (type === 'progress') {
      try { onProgress({job: record.job, progress: eventData}); }
      catch (error) { reportError(error, {jobId: record.job.id, phase: 'progress-callback'}); }
    }
    if (record.events.length >= eventBatchSize) {
      void flush(record).catch((error) => reportError(error, {jobId: record.job.id, phase: 'flush'}));
    } else if (!record.flushTimer) {
      record.flushTimer = setTimeout(() => {
        record.flushTimer = null;
        void flush(record).catch((error) => reportError(error, {jobId: record.job.id, phase: 'flush'}));
      }, flushMs);
      record.flushTimer.unref?.();
    }
  }

  async function run(job) {
    const record = {job, token: job.lease.token, controller: new AbortController(),
      events: [], flushTimer: null, flushing: null, flushError: null, ended: false,
      closing: false, done: null, lastRenew: 0};
    running.set(job.id, record);
    record.done = (async () => {
      let outcome;
      try {
        outcome = await execute({job, signal: record.controller.signal,
          emit: (type, data) => emitFor(record, type, data)});
        if (!outcome || !TERMINAL.has(outcome.status))
          throw runtimeError('REVIEW_OUTCOME_INVALID', '执行器未返回有效审阅终态');
        await flush(record);
        if (record.controller.signal.aborted) throw record.controller.signal.reason || new Error('已中止');
      } catch (error) {
        // A lost lease must never let an old owner stage or publish another run.
        // stageJobOutcome performs the authoritative token/cancel CAS below.
        outcome = {status: record.closing ? 'interrupted'
          : record.flushError ? 'failed' : record.controller.signal.aborted ? 'cancelled' : 'failed',
        error: messageOf(record.flushError || error)};
        try { if (!record.flushError) await flush(record); }
        catch (saveError) { outcome = {status: 'failed', error: messageOf(saveError)}; }
      }
      record.ended = true;
      if (record.flushTimer) clearTimeout(record.flushTimer);
      try {
        const staged = await store.stageJobOutcome(args({jobId: job.id, leaseToken: record.token, outcome}));
        void materialize(staged).catch((error) => reportError(error, {jobId: job.id, phase: 'publication'}));
      } catch (error) { reportError(error, {jobId: job.id, phase: 'stage'}); }
      finally {
        if (running.get(job.id)?.token === record.token) running.delete(job.id);
        wake();
      }
    })();
    return record;
  }

  function terminalEvent(job, outcome, receipt) {
    const identity = {jobId: job.id, jobRunId: job.jobRunId || job.id, versionId: job.binding.versionId};
    if (['completed', 'partial'].includes(outcome.status)) return {type: 'done',
      data: eventPlain({...(receipt?.terminalData || outcome.result || {}), ...identity})};
    return {type: outcome.status === 'cancelled' ? 'cancelled' : 'error',
      data: eventPlain({...identity, status: outcome.status,
        message: outcome.error || outcome.message || (outcome.status === 'cancelled' ? '已中止' : '此次审阅未完成')})};
  }

  async function materialize(candidate) {
    if (publishing.has(candidate.id)) return publishing.get(candidate.id);
    const operation = (async () => {
      const job = await store.claimJobPublication(args({jobId: candidate.id, owner}));
      if (!job) return null;
      const token = job.publicationLease.token;
      try {
        const outcome = await store.loadJobOutcome(args({jobId: job.id}));
        const receipt = await publish({job, outcome, leaseToken: token});
        if (!receipt || receipt.jobRunId !== (job.jobRunId || job.id)
          || receipt.versionId !== job.binding.versionId)
          throw runtimeError('REVIEW_PUBLICATION_RECEIPT', '审阅发布回执与任务或工作版本不一致');
        const terminal = await store.completeJobPublication(args({jobId: job.id,
          publicationToken: token, sessionReceipt: receipt,
          terminalEvent: terminalEvent(job, outcome, receipt)}));
        await refreshViews(job.id);
        settleWaiters(job.id, terminal);
        return terminal;
      } catch (error) {
        try { await store.releaseJobPublication(args({jobId: job.id, publicationToken: token})); }
        catch (releaseError) { reportError(releaseError, {jobId: job.id, phase: 'publication-release'}); }
        throw error;
      }
    })();
    publishing.set(candidate.id, operation);
    try { return await operation; }
    finally { if (publishing.get(candidate.id) === operation) publishing.delete(candidate.id); }
  }

  function settleWaiters(jobId, job) {
    if (!TERMINAL.has(job.status)) return;
    for (const waiter of waiters.get(jobId) || []) waiter.finish(null, job);
  }

  async function refreshViews(jobId) {
    const views = [...(subscribers.get(jobId) || [])].filter((view) => view.active);
    if (!views.length) return;
    // Each view owns its replay cursor; a reconnect can ask for an older prefix.
    await Promise.all(views.map(async (view) => {
      if (view.reading) return;
      view.reading = true;
      try {
        while (view.active) {
          const events = await store.readJobEvents(args({jobId, afterSeq: view.afterSeq, limit: 500}));
          for (const event of events) deliver(view, event);
          if (events.length < 500) break;
        }
      } finally {
        view.reading = false;
        const pending = view.pending.splice(0).sort((a, b) => a.seq - b.seq);
        for (const event of pending) deliver(view, event);
      }
    }));
  }

  async function pump() {
    if (closed) return;
    if (pumpPromise) return pumpPromise;
    pumpPromise = (async () => {
      if (Date.now() - lastRecovery >= Math.max(1000, pollMs)) {
        await store.recoverJobs(args());
        lastRecovery = Date.now();
      }
      for (const record of [...running.values()]) {
        try {
          // Cancellation reads need no write lock. The heartbeat is diagnostic,
          // so do not rewrite the shared ledger on every subscriber poll.
          let current = await load(record.job.id);
          if (current.status === 'running' && current.lease?.token === record.token
            && Date.now() - record.lastRenew >= Math.max(1000, pollMs)) {
            current = await store.renewJobLease(args({jobId: record.job.id, owner, leaseToken: record.token}));
            record.lastRenew = Date.now();
          }
          if (current.status !== 'running' || current.lease?.token !== record.token) {
            if (!executionCommitted(record, current)) {
              const error = runtimeError('REVIEW_LEASE_LOST', '审阅运行身份已变化');
              record.controller.abort(error);
              reportError(error, {jobId: record.job.id, phase: 'lease'});
            }
            continue;
          }
          if (current.cancelRequested && !record.controller.signal.aborted)
            record.controller.abort(new Error('已中止'));
        } catch (error) {
          if (error.code === 'JOB_LEASE_CONFLICT') {
            // The executor can commit its own outbox between the running read
            // and renewal. Only that durable token proves a normal completion;
            // a running job or another owner's receipt is still a lost lease.
            try {
              if (executionCommitted(record, await load(record.job.id))) continue;
            } catch { /* Failed proof never suppresses the original lease error. */ }
          }
          record.controller.abort(runtimeError('REVIEW_LEASE_LOST', `审阅运行身份已变化：${messageOf(error)}`, error));
          reportError(error, {jobId: record.job.id, phase: 'lease'});
        }
      }
      const jobs = await store.listJobs(args());
      const settledIds = new Set();
      if (typeof store.completeQueuedCancellations === 'function') {
        const settled = await store.completeQueuedCancellations(args({limit:32}));
        for (const id of settled.completed) { settledIds.add(id); await refreshViews(id); if(waiters.has(id))settleWaiters(id,await load(id)); }
      }
      for (const job of jobs) {
        if (settledIds.has(job.id)) continue;
        // Bulk cancellation/recovery may stage hundreds of outcomes at once.
        // Bound publishers instead of flooding the shared ledger with one waiter per manuscript.
        if (job.status === 'publishing' && !publishing.has(job.id) && publishing.size < publicationConcurrency)
          void materialize(job).catch((error) => reportError(error, {jobId: job.id, phase: 'publication'}));
        if (TERMINAL.has(job.status)) settleWaiters(job.id, job);
      }
      for (const jobId of subscribers.keys()) await refreshViews(jobId);
      while (!closed) {
        // Policy is checked before the claim changes any queued job to running.
        // Read/persistence failures fail closed; publication and subscriptions
        // above remain recoverable even while admission is blocked.
        const admission = beforeClaim ? await beforeClaim({jobs: await store.listJobs(args()), owner}) : null;
        const excludedJobIds = admission?.excludedJobIds;
        const job = await store.claimNextJob(args({owner, ...(excludedJobIds === undefined ? {} : {excludedJobIds})}));
        if (!job) break;
        if (running.has(job.id)) break;
        await run(job);
      }
    })();
    try { await pumpPromise; }
    finally { pumpPromise = null; }
  }

  function wake() {
    if (!closed) void pump().catch((error) => reportError(error, {phase: 'pump'}));
  }

  function start() {
    if (closed) throw runtimeError('REVIEW_RUNTIME_CLOSED', '审阅运行层已经关闭');
    if (!timer) {
      timer = setInterval(wake, pollMs);
      timer.unref?.();
    }
    wake();
    return api;
  }

  async function observe({jobId, afterSeq = 0, onEvent}) {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || typeof onEvent !== 'function')
      throw runtimeError('REVIEW_SUBSCRIPTION_INVALID', '审阅订阅游标或回调无效');
    await load(jobId);
    const view = {jobId, afterSeq, onEvent, active: true, reading: false, pending: [], stop: null};
    if (!subscribers.has(jobId)) subscribers.set(jobId, new Set());
    view.stop = () => {
      view.active = false;
      subscribers.get(jobId)?.delete(view);
      if (!subscribers.get(jobId)?.size) subscribers.delete(jobId);
    };
    subscribers.get(jobId).add(view);
    try { await refreshViews(jobId); }
    catch (error) { view.stop(); throw error; }
    return view.stop;
  }

  async function waitForTerminal({jobId, signal} = {}) {
    const current = await load(jobId);
    if (TERMINAL.has(current.status)) return current;
    if (signal?.aborted) throw signal.reason || new Error('等待已中止');
    return new Promise((resolve, reject) => {
      const waiter = {finish: null};
      const abort = () => waiter.finish(signal.reason || new Error('等待已中止'));
      waiter.finish = (error, job) => {
        signal?.removeEventListener('abort', abort);
        waiters.get(jobId)?.delete(waiter);
        if (!waiters.get(jobId)?.size) waiters.delete(jobId);
        if (error) reject(error); else resolve(job);
      };
      if (!waiters.has(jobId)) waiters.set(jobId, new Set());
      waiters.get(jobId).add(waiter);
      signal?.addEventListener('abort', abort, {once: true});
      wake();
    });
  }

  async function cancel({jobId, operationId} = {}) {
    const job = await store.cancelJob(args({jobId, operationId}));
    const record = running.get(jobId);
    if (job.cancelRequested && record && !record.controller.signal.aborted)
      record.controller.abort(new Error('已中止'));
    wake();
    return job;
  }

  async function close({interruptRunning = true} = {}) {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    for (const views of subscribers.values()) for (const view of views) view.active = false;
    subscribers.clear();
    for (const [jobId, entries] of waiters) for (const waiter of [...entries])
      waiter.finish(runtimeError('REVIEW_RUNTIME_CLOSED', '本地等待已关闭，后台任务状态可重新查询'));
    if (interruptRunning) for (const record of running.values()) {
      record.closing = true;
      record.controller.abort(new Error('服务关闭中断了此次审阅'));
    }
    // Closing a local view is always cheap. Explicit runtime shutdown asks the
    // cooperative executor to finish staging; no peer's controller is touched.
    if (interruptRunning) await Promise.allSettled([...running.values()].map((record) => record.done));
    await Promise.allSettled([...publishing.values()]);
  }

  const api = {owner, errors, start, pump, observe, waitForTerminal, cancel, close,
    closeLocalView: (view) => {
      const unsubscribe = typeof view === 'function' ? view : view?.unsubscribe;
      if (typeof unsubscribe === 'function') unsubscribe();
    },
    getJob: ({jobId}) => load(jobId),
    getOutcome: ({jobId}) => store.loadJobOutcome(args({jobId})),
    readEvents: ({jobId, afterSeq = 0, limit = 500}) => store.readJobEvents(args({jobId, afterSeq, limit})),
    enqueue: async (spec) => { const receipt = await store.enqueueJob(args(spec)); wake(); return receipt; },
    startBatch: async (spec) => { const receipt = await store.startBatch(args(spec)); wake(); return receipt; },
    pauseBatch: async (spec) => { const receipt = await store.pauseBatch(args(spec)); wake(); return receipt; },
    resumeBatch: async (spec) => { const receipt = await store.resumeBatch(args(spec)); wake(); return receipt; },
    cancelBatch: async (spec) => { const receipt = await store.cancelBatch(args(spec)); wake(); return receipt; },
  };
  await store.recoverJobs(args());
  lastRecovery = Date.now();
  if (autoStart) start();
  return api;
}
