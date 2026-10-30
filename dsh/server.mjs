/**
 * 东方学刊审稿智能体 —— HTTP 服务。
 * 零依赖（只用 node:http / node:fs），同时提供 API 与静态页面。
 *
 * 启动：node server.mjs   然后打开 http://127.0.0.1:3210
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, join, basename } from 'node:path';
import { parseDocxBuffer, detectMeta, buildReport, rolesOf } from './src/review.js';
import { MODEL_CANDIDATES, DEFAULT_MODEL, arkChat, arkConfigured, arkModelEndpointConfig, resolveArkModel, REVIEW_INSTRUCTIONS, promptStyleRules } from './src/ark.js';
import { loadFormatRules } from './src/scanner-format.js';
import { loadLanguageRules } from './src/scanner-language.js';
import { loadCitationRules } from './src/scanner-citation.js';
import { implementedRules, ruleWillRun } from './src/implemented-rules.js';
import { attachAnchors, attachCommentAnchors } from './src/anchors.js';
import { buildCommentedDocx } from './src/docx-comments.js';
import { cleanDocx } from './src/docx-clean.js';
import { applyDocxPatches } from './src/docx-patches.js';
import { saveWorkingVersion, loadWorkingVersion, sha256 } from './src/working-version.js';
import { rebaseIssueAnchors } from './src/working-anchors.js';
import { buildReportExport, saveReportExport } from './src/report-export.js';
import { buildReviewCoverage } from './src/review-coverage.js';
import { captureReviewSource, reviewedSourceDocument, sourceNodeIdentity } from './src/review-source.js';
import { saveSessionSnapshot, loadSessionSnapshot } from './src/session-store.js';
import { initializeFixHistory, fixHistoryStatus, appendedFixState, historyStep, rememberCompletedReview, selectReviewForHistory } from './src/fix-history.js';
import { loadWorkspace, saveWorkspace } from './src/workspace-store.js';
import { humanState, effectiveReviewRunId, buildHumanRecord, humanAuditEntry } from './src/human-state.js';
import { loadLegacyReview } from './src/legacy-imports.js';
import { beginIngestion, submitIngestion, resumeIngestion, loadIngestion, recoverIngestions, ingestionSourceAvailable, verifyIngestionContext } from './src/ingestion-store.js';
import { randomUUID } from 'node:crypto';
import { recordAudit, listAudit, auditSummary, toCsv } from './src/audit.js';
import { openZip } from './src/zip.js';
import {createServerReviewService,currentSessionJob,latestSessionJob,currentWorkspaceJobs,reviewJobActive,reviewJobRunning,
 normalizeReviewOptions,queryReviewOptions,sameReviewOptions,publicReviewJob,
 readArkRequestPool,abandonUnknownRequestSlots} from './src/review-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = resolve(__dirname, 'public');
const REPORT_DIR = resolve(process.env.DSH_AUDIT_ROOT || resolve(__dirname, 'data', 'audit'), 'report-exports');
const MODULES_DIR = resolve(__dirname, 'node_modules');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.emf': 'image/emf',
  '.wmf': 'image/wmf',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 内存会话：docx 解析结果 + 审阅结果 */
const sessions = new Map();
const loadingSessions = new Map();
const activeMutations = new Map();
const workspaceWrites = new Map();
let reviewService = null;
let reviewRecovery = {state:'starting',error:null};

async function storedWorkspace(id) {
  if (!/^w[a-z0-9_-]{1,80}$/.test(id || '')) { const error = new Error('工作台身份无效'); error.status = 400; throw error; }
  try {
    const stored = await loadWorkspace({workspaceId: id});
    if (!Array.isArray(stored.workspace.entries) || !stored.workspace.queue || !stored.workspace.receipts) throw new Error('工作台队列记录损坏');
    return stored;
  } catch (error) {
    if (error.code !== 'WORKSPACE_NOT_FOUND' || error.missingPart !== 'directory') throw error;
    return {workspace: {id, entries: [], activeSessionId: null,
      queue: {state: 'ready', cursorSessionId: null, options: null}, receipts: {}, createdAt: new Date().toISOString()}, manifest: {revision: -1}};
  }
}

async function workspacePayload(stored, extra = {}) {
  if(reviewRecovery.state==='error'){const error=new Error('审阅任务记录未能恢复，请先处理服务器恢复错误');error.status=503;throw error;}
  const entries = [];
  const reviewView=reviewService?await reviewService.workspaceView(stored.workspace.id,{sessionIds:stored.workspace.entries.map(entry=>entry.id).filter(Boolean)}):{jobs:[],queue:null};
  const jobs = reviewView.jobs;
  for (const entry of stored.workspace.entries) {
    if (entry.ingestionId) {
      try {
        const record = await verifyIngestionContext({ingestionId: entry.ingestionId});
        if (record.workspaceId !== stored.workspace.id || record.entryId !== entry.entryId
          || entry.id && entry.id !== record.sessionId) throw new Error('上传登记与工作台身份不一致');
        const ingestion = await publicIngestion(record);
        if (record.status !== 'completed') {
          entries.push({...entry, id: null, ingestion, operationId: record.operationId, size: record.size,
            status: record.status === 'failed' ? 'upload-failed' : ingestion.canResume ? 'upload-saving' : 'upload-pending',
            canResume: ingestion.canResume, needsFile: ingestion.needsFile, sourceStored: ingestion.sourceStored,
            error: record.receipt?.error || null, hasResult: false, running: false});
          continue;
        }
        if (entry.id !== record.sessionId) throw new Error('已完成上传缺少对应的队列会话');
      } catch (error) {
        entries.push({...entry, id: null, status: 'unavailable', error: `上传恢复失败：${error.message}`, hasResult: false});
        continue;
      }
    }
    if (!entry.id) { entries.push({...entry, status: 'upload-failed'}); continue; }
    try {
      // Listing needs durable facts, not document bytes. Hydrate only when the
      // manuscript is opened; a queue beyond the LRU cap must not parse every
      // working/original DOCX again on each refresh.
      const saved = await loadSessionSnapshot({sessionId: entry.id});
      const s = saved.snapshot;
      const activeJob = [...jobs].reverse().find(job=>job.sessionId===entry.id&&reviewJobActive(job));
      if(activeJob){s.reviewRunning=true;s.reviewProgress=activeJob.progress;}
      const hasResult = currentResultAvailable(s);
      const phase = s.reviewProgress?.phase || null;
      const status = activeJob?.status === 'queued' ? 'queued' : s.reviewRunning ? activeJob?'reviewing':'running-unverified' : s.interrupted ? 'interrupted' : s.cancelled ? 'cancelled'
        : s.reviewError ? 'failed' : hasResult ? phase === 'partial' ? 'partial' : 'complete' : 'ready';
      entries.push({...entry, status, phase, error: s.reviewError || null, running: !!s.reviewRunning,
        hasResult, issueCount: hasResult ? s.result.issues.length : null, workVersion: s.workVersion, history: fixHistoryStatus(s),
        clean: s.clean || null, legacy: s.legacy || null,
        reviewRunId:activeJob?.id||effectiveReviewRunId(s),reviewJobId:activeJob?.id||s.reviewJobId||null,
        workVersionId:s.workVersion.id,waiting:activeJob?.status==='queued',reviewJob:publicReviewJob(activeJob)});
    } catch (error) { entries.push({...entry, status: 'unavailable', error: `稿件恢复失败：${error.message}`}); }
  }
  const {receipts, ...workspace} = stored.workspace;
  const activeSessionId = entries.some((entry) => entry.id && entry.id === workspace.activeSessionId) ? workspace.activeSessionId : null;
  const queue=reviewView.queue;
  return {workspace: {...workspace, activeSessionId, entries,queue:queue||workspace.queue,revision: stored.manifest.revision}, ...extra};
}

async function publicIngestion(record) {
  const sourceStored = await ingestionSourceAvailable({ingestionId: record.ingestionId});
  return {id: record.ingestionId, workspaceId: record.workspaceId, operationId: record.operationId,
    entryId: record.entryId, name: record.name, size: record.size, purpose: record.purpose,
    verificationRunId: record.verificationRunId, status: record.status,
    sourceStored, canResume: sourceStored && !['completed','failed'].includes(record.status),
    needsFile: !sourceStored && record.status !== 'failed' && record.status !== 'completed',
    sourceSha256: record.source?.sha256 || null, error: record.receipt?.error || null,
    createdAt: record.createdAt, updatedAt: record.updatedAt};
}

async function ingestionResponse(result, extra = {}) {
  const record = result.record;
  const ingestion = await publicIngestion(record);
  const stored = await storedWorkspace(record.workspaceId);
  const workspace = (await workspacePayload(stored)).workspace;
  const workspaceRegistered = workspace.entries.some((entry) => entry.ingestionId === record.ingestionId);
  const base = {ingestion, workspace, workspaceRegistered, ...extra};
  if (record.status !== 'completed') return {...base, ...(record.receipt?.status === 422 ? record.receipt : {})};
  const currentManifest = result.sessionManifest || (await loadSessionSnapshot({sessionId: record.sessionId})).manifest;
  const old = sessions.get(record.sessionId);
  if (old && old._storeRevision !== currentManifest.revision) {
    if (old.reviewRunning || old.applyingFixes) { const error = new Error('稿件正在处理，请稍后恢复上传结果'); error.status = 409; throw error; }
    sessions.delete(record.sessionId);
  }
  const s = await touchSession(record.sessionId);
  if (!s) throw new Error('上传已提交，但对应会话无法恢复');
  return {...base, registered: true, id: s.id, name: s.name, doc: serializeDoc(s.doc), workVersion: s.workVersion,
    history: fixHistoryStatus(s), clean: s.clean, legacy: s.legacy || null, human: humanState(s),
    reviewRunId: effectiveReviewRunId(s), running: !!s.reviewRunning,
    result: currentResultAvailable(s) ? serializeReview(s.result, s.doc, s) : null};
}

async function ingestionFailure(res, error, ingestionId) {
  let record = error.record;
  if (!record && ingestionId) { try { record = await loadIngestion({ingestionId}); } catch { /* Keep explicit original failure. */ } }
  const out = {error: String(error.message || error), code: error.code || 'INGESTION_SAVE_FAILED'};
  if (record) {
    try { out.ingestion = await publicIngestion(record); }
    catch (sourceError) { out.ingestion = {id: record.ingestionId, workspaceId: record.workspaceId, operationId: record.operationId,
      entryId: record.entryId, name: record.name, size: record.size, purpose: record.purpose, verificationRunId: record.verificationRunId,
      status: record.status, sourceStored: false, canResume: false, needsFile: false}; out.recoveryError = sourceError.message; }
    try {
      const stored = await storedWorkspace(record.workspaceId);
      out.workspace = (await workspacePayload(stored)).workspace;
      out.workspaceRegistered = out.workspace.entries.some((entry) => entry.ingestionId === record.ingestionId);
    } catch (workspaceError) { out.workspaceError = workspaceError.message; out.workspaceRegistered = false; }
  }
  return json(res, error.status || 500, out);
}

async function workspaceWrite(id, action) {
  const previous = workspaceWrites.get(id);
  const operation = (previous || Promise.resolve()).catch(() => {}).then(action);
  workspaceWrites.set(id, operation);
  try { return await operation; }
  finally { if (workspaceWrites.get(id) === operation) workspaceWrites.delete(id); }
}

async function commitWorkspace(workspace, revision) {
  let manifest;
  try { manifest = await saveWorkspace({workspaceId: workspace.id, workspace, expectedRevision: revision}); }
  catch (error) {
    if (!error.committedManifest) throw error;
    const saved = await loadWorkspace({workspaceId: workspace.id});
    if (saved.manifest.manifestSha256 !== error.committedManifest.manifestSha256) throw error;
    manifest = saved.manifest;
  }
  return {workspace, manifest};
}

function humanPayload(s, extra = {}) {
  return {id: s.id, workVersion: s.workVersion, history: fixHistoryStatus(s),
    reviewRunId: effectiveReviewRunId(s), human: humanState(s), ...extra};
}

/**
 * 会话上限与淘汰。
 * 每个会话同时持有解析后的文档对象和**原始文件 Buffer**，一份长稿可达数 MB。
 * 此前 sessions 只增不减——批量验证跑 632 份稿件后堆到 609 个会话、
 * 全部稿件内容都留在内存里，长时间运行会持续吃内存。
 * 这里按「最近使用时间」淘汰超出上限的会话（正在审阅的不会被淘汰）。
 */
const MAX_SESSIONS = 40;

function evictSessions() {
  if (sessions.size <= MAX_SESSIONS) return;
  const candidates = [...sessions.values()]
    .filter((s) => !s.reviewRunning && !s.applyingFixes)
    .sort((a, b) => (a.lastUsed || a.createdAt || 0) - (b.lastUsed || b.createdAt || 0));
  for (const s of candidates) {
    if (sessions.size <= MAX_SESSIONS) break;
    sessions.delete(s.id);
  }
}

/** 取会话并刷新使用时间（供各接口统一调用） */
async function touchSession(id,{fresh=false,executorJobId=null}={}) {
  let s = sessions.get(id);
  if(s&&!activeMutations.has(id)){
    const stored=await loadSessionSnapshot({sessionId:id});
    if(fresh||stored.manifest.revision!==s._storeRevision){sessions.delete(id);s=null;}
  }
  if (!s && /^s[a-z0-9]+$/.test(id || '')) {
    if (!loadingSessions.has(id)) loadingSessions.set(id, restoreStoredSession(id));
    try { s = await loadingSessions.get(id); }
    finally { loadingSessions.delete(id); }
  }
  if (s) {
    s.lastUsed = Date.now();
    const job=await currentSessionJob(id);
    s._activeReviewJob=job;
    // Derived queue state must not mutate the cached durable snapshot. A reader
    // may observe publishing immediately before its ledger becomes terminal;
    // no session revision changes at that last step to invalidate that cache.
    if(!executorJobId&&job)return{...s,reviewRunning:true,reviewProgress:job.progress};
  }
  return s;
}

async function persistSession(session) {
  let manifest;
  try { manifest = await saveSessionSnapshot({ sessionId: session.id, snapshot: session, expectedRevision: session._storeRevision ?? -1 }); }
  catch (err) {
    if (!err.committedManifest) throw err;
    const saved = await loadSessionSnapshot({ sessionId: session.id });
    if (saved.manifest.manifestSha256 !== err.committedManifest.manifestSha256) throw err;
    manifest = saved.manifest;
    session.storageWarning = '工作记录已保存，文件锁清理失败；后续保存将重试清理';
  }
  session._storeRevision = manifest.revision;
  return manifest;
}

function originalCommentCount(buffer, fallback = 0) {
  try { return cleanDocx(buffer).stats.beforeAfter.before.comments; }
  catch { return fallback; }
}

function cleaningProof(stats, version, originalCount) {
  return {...stats, status: stats.changed ? 'cleaned' : 'unchanged',
    cleaningInputSha256: stats.sourceSha256, sourceSha256: version.sourceSha256,
    workSha256: version.sha256, outputSha256: version.sha256,
    originalCommentCount: originalCount, validatedVersionId: version.id};
}

// Validate the exact saved stream. Old metadata alone is never proof of cleaning.
function inspectWorkingClean(s, buffer = s.buffer, version = s.workVersion) {
  const originalCount = s.doc?.originalCommentCount ?? s.clean?.originalCommentCount ?? 0;
  const unverified = (reason, code) => ({status: 'legacy-unverified', reason, code,
    originalCommentCount: originalCount, sourceSha256: version.sourceSha256, workSha256: version.sha256});
  if (s.legacy?.available && !s.cleanVerificationStarted)
    return unverified('历史文件的清洗尚未验证，请先验证清洗');
  try {
    const cleaned = cleanDocx(buffer);
    if (cleaned.stats.changed) return unverified('当前保存稿仍含批注或批注关系，请先验证清洗');
    const previous = s.cleanRecords?.[version.id] || s.clean;
    if (['cleaned','unchanged'].includes(previous?.status) && previous.validatedVersionId === version.id
      && previous.workSha256 === version.sha256 && previous.sourceSha256 === version.sourceSha256)
      return {...previous, currentVerification: {sha256: version.sha256, beforeAfter: cleaned.stats.beforeAfter}};
    return cleaningProof(cleaned.stats, version, originalCount);
  } catch (error) { return unverified(`当前稿清洗验证失败：${error.message}`, error.code); }
}

function rememberCleanProof(candidate) {
  candidate.cleanRecords = {...(candidate.cleanRecords || {}), [candidate.workVersion.id]: candidate.clean};
}

function cleanReviewGate(s) {
  return !['cleaned','unchanged'].includes(s.clean?.status);
}

async function restoreStoredSession(id) {
  let stored;
  try { stored = await loadSessionSnapshot({ sessionId: id }); }
  catch (err) { if (err.code === 'ENOENT' || err.code === 'SESSION_NOT_FOUND') return null; throw new Error(`会话记录无法恢复：${err.message}`); }
  if (!stored) return null;
  const s = stored.snapshot;
  if (s.ingestionId) {
    const admission = await verifyIngestionContext({ingestionId: s.ingestionId});
    if (admission.sessionId !== id || admission.workspaceId !== s.workspaceId) throw new Error('会话与上传事务身份不一致');
    if (admission.status !== 'completed') return null;
  }
  const saved = await loadWorkingVersion({ sessionId: id, versionId: s.workVersion?.id });
  if (s.id !== id || s.workVersion.sha256 !== saved.version.sha256) throw new Error('会话与工作版本身份不一致');
  s.workVersion = saved.version;
  s.buffer = saved.buffer;
  s.originalBuffer = saved.originalBuffer;
  s.doc = parseDocxBuffer(saved.buffer, s.name);
  const originalDoc = parseDocxBuffer(saved.originalBuffer, s.name);
  s.sourceComments ||= originalDoc.comments || [];
  s.doc.originalCommentCount = originalCommentCount(saved.originalBuffer, originalDoc.comments?.length || 0);
  s._storeRevision = stored.manifest.revision;
  initializeFixHistory(s);
  const sourceRecovered = await restoreReviewSources(s);
  rememberCompletedReview(s);
  if (!Number.isInteger(s.history.cursor) || !s.history.entries[s.history.cursor]
    || s.history.entries[s.history.cursor].versionId !== s.workVersion.id
    || s.history.entries.some((e) => !e.versionId.startsWith(`${id}:`) || !Array.isArray(e.appliedFixes))) throw new Error('会话修改历史损坏');
  s.applyingFixes = false;
  s.reviewController = null;
  const proofIdentity = (clean) => JSON.stringify(clean && {...clean, currentVerification: undefined});
  const previousClean = proofIdentity(s.clean);
  s.clean = inspectWorkingClean(s);
  rememberCleanProof(s);
  let mustPersist = sourceRecovered || previousClean !== proofIdentity(s.clean);
  // Missing local controllers are not evidence that another process stopped.
  // Jobs recover dead owners and materialize interruption through the outbox.
  if (mustPersist&&!s.reviewRunning) await persistSession(s);
  s.lastUsed = Date.now();
  sessions.set(id, s);
  evictSessions();
  return s;
}

function mutationPayload(s, extra = {}) {
  return { applied: [], skipped: [], appliedFixes: completedFixKeys(s), appliedFixDetails: s.appliedFixes || [],
    doc: serializeDoc(s.doc), workVersion: s.workVersion, history: fixHistoryStatus(s),
    clean: s.clean || null, legacy: s.legacy || null,
    human: humanState(s), reviewRunId: effectiveReviewRunId(s),
    result: currentResultAvailable(s) ? serializeReview(s.result, s.doc, s) : null, running: !!s.reviewRunning, ...extra };
}

function currentResultAvailable(s) {
  return !!s.result && !cleanReviewGate(s) && !s.reviewRunning && !s.reviewError && !s.interrupted && s.resultRunId === s.reviewRunId;
}

function mutationFingerprint(operation, body) {
  if (operation === 'human') return sha256(Buffer.from(JSON.stringify([operation, body.baseVersionId, body.baseMutationEpoch,
    body.baseRunId, body.expectedHumanRevision, body.kind, body.issueKey, body.action, body.opinion, body.mark,
    body.purpose || 'editorial', body.verificationRunId || null])));
  const fields = [operation, body.baseVersionId || null, body.baseMutationEpoch ?? null, [...(body.accepted || [])].sort()];
  if (operation === 'apply' && Object.hasOwn(body, 'baseReviewRunId')) fields.push(['reviewRun', body.baseReviewRunId]);
  return sha256(JSON.stringify(fields));
}

function mutationGate(s, body, operation) {
  if (body.operationId && !/^[A-Za-z0-9_-]{1,128}$/.test(body.operationId)) return { status: 400, error: '修改操作身份无效' };
  const receipt = body.operationId && Object.hasOwn(s.mutationReceipts || {}, body.operationId) ? s.mutationReceipts[body.operationId] : null;
  if (receipt) {
    if (receipt.fingerprint !== mutationFingerprint(operation, body)) return { status: 409, error: '同一操作身份不能用于不同修改' };
    return { replayed: true };
  }
  if (s.reviewRunning || s.applyingFixes) return { status: 409, error: '该稿件正在处理，请稍候' };
  if (operation === 'apply') {
    if (typeof body.baseReviewRunId !== 'string' || !body.baseReviewRunId) return {
      status: 409, code: 'REVIEW_CONTEXT_REQUIRED', error: '请核对当前审阅记录后重新提交修改',
      workVersion: s.workVersion, reviewRunId: effectiveReviewRunId(s) };
    if (body.baseReviewRunId !== effectiveReviewRunId(s)) return {
      status: 409, code: 'REVIEW_CONTEXT_STALE', error: '审阅记录已变化，请刷新后核对，修改未执行',
      workVersion: s.workVersion, reviewRunId: effectiveReviewRunId(s) };
  }
  if (body.baseVersionId && body.baseVersionId !== s.workVersion.id
    || body.baseMutationEpoch != null && body.baseMutationEpoch !== (s.mutationEpoch || 0)) return { status: 409, error: '工作稿或修改历史已变化，请刷新后核对', workVersion: s.workVersion, history: fixHistoryStatus(s) };
  return null;
}

function recordMutationReceipt(candidate, body, operation) {
  if (!body.operationId) return;
  candidate.mutationReceipts = { ...(candidate.mutationReceipts || {}), [body.operationId]: {
    operation, fingerprint: mutationFingerprint(operation, body), completedVersionId: candidate.workVersion.id,
    completedEpoch: candidate.mutationEpoch, completedAt: new Date().toISOString(),
  } };
}

function pendingDuplicate(s, body, operation) {
  const active = activeMutations.get(s.id);
  return body.operationId && active?.operationId === body.operationId
    && active.fingerprint === mutationFingerprint(operation, body) ? active.done : null;
}

function beginMutation(s, body, operation) {
  s.applyingFixes = true;
  let finish;
  const active = { operationId: body.operationId, fingerprint: mutationFingerprint(operation, body), done: new Promise((resolve) => { finish = resolve; }) };
  activeMutations.set(s.id, active);
  return () => {
    s.applyingFixes = false;
    if (activeMutations.get(s.id) === active) activeMutations.delete(s.id);
    finish();
  };
}

async function moveFixHistory(req, res, operation) {
  const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}');
  const s = await touchSession(body.id);
  if (!s) return json(res, 404, { error: '会话不存在' });
  const pending = pendingDuplicate(s, body, operation);
  if (pending) await pending;
  const gate = mutationGate(s, body, operation);
  if (gate?.replayed) return json(res, 200, mutationPayload(s, { replayed: true }));
  if (gate) return json(res, gate.status, gate);
  const step = historyStep(s, operation);
  const finish = beginMutation(s, body, operation);
  try {
    if (!step) {
      const candidate = { ...s };
      recordMutationReceipt(candidate, body, operation);
      await persistSession(candidate);
      Object.assign(s, candidate);
      return json(res, 200, mutationPayload(s, { noop: true }));
    }
    rememberCompletedReview(s);
    const saved = await loadWorkingVersion({ sessionId: s.id, versionId: step.entry.versionId });
    const doc = parseDocxBuffer(saved.buffer, s.name);
    doc.originalCommentCount = s.doc.originalCommentCount;
    const candidate = { ...s, doc, buffer: saved.buffer, workVersion: saved.version,
      appliedFixes: structuredClone(step.entry.appliedFixes), history: { ...s.history, cursor: step.cursor }, mutationEpoch: s.mutationEpoch + 1 };
    candidate.clean = inspectWorkingClean(candidate);
    rememberCleanProof(candidate);
    selectReviewForHistory(candidate);
    recordMutationReceipt(candidate, body, operation);
    const payload = mutationPayload(candidate, { operation });
    JSON.stringify(payload);
    await persistSession(candidate);
    Object.assign(s, candidate);
    return json(res, 200, payload);
  } catch (err) {
    return json(res, 500, { error: `历史操作未提交：${err.message}`, workVersion: s.workVersion, history: fixHistoryStatus(s) });
  } finally { finish(); }
}

/** A grouped issue is resolved only when every occurrence was actually committed. */
function completedFixKeys(s) {
  const counts = new Map();
  for (const patch of s.appliedFixes || []) {
    if (patch.sourceVersionId !== (s.resultVersionId || s.reviewVersionId)) continue;
    counts.set(patch.key, (counts.get(patch.key) || 0) + 1);
  }
  return (s.result?.issues || []).filter((issue) => {
    const key = issue.issueKey || `${issue.ruleId}|${issue.location}|${issue.quote || ''}`;
    return (counts.get(key) || 0) === (issue.occurrences?.length || 1);
  }).map((issue) => issue.issueKey || `${issue.ruleId}|${issue.location}|${issue.quote || ''}`);
}

function reviewTexts(doc, version = null) {
  return captureReviewSource(doc, version);
}

/** Recover old review identities only by reopening the immutable reviewed version. */
async function restoreReviewSources(s) {
  let changed = false;
  const versions = new Map([[s.workVersion.id, s.doc]]);
  const recover = async (texts, versionId) => {
    if (!texts || !versionId) return texts;
    const reject = (reason) => {
      const key = sha256(JSON.stringify(texts));
      if (s.reviewSourceProblems?.[key] !== reason) {
        s.reviewSourceProblems = { ...(s.reviewSourceProblems || {}), [key]: reason }; changed = true;
      }
    };
    try {
      if (!versions.has(versionId)) {
        const saved = await loadWorkingVersion({ sessionId: s.id, versionId });
        versions.set(versionId, parseDocxBuffer(saved.buffer, s.name));
      }
      const verified = reviewedSourceDocument(texts, { savedDoc: versions.get(versionId), versionId });
      if (verified.verified && verified.source !== texts) { changed = true; return verified.source; }
      if (!verified.verified) reject(verified.reason);
    } catch {
      // Missing historical bytes leave the old evidence intact and visibly unmapped.
      reject('review_source_saved_version_unavailable');
    }
    return texts;
  };
  s.resultTexts = await recover(s.resultTexts, s.resultVersionId || s.reviewVersionId);
  for (const record of s.reviewRecords || []) record.texts = await recover(record.texts, record.versionId);
  return changed;
}

function sessionReviewSource(s, doc = s.doc) {
  const recordedFailure = s.resultTexts && s.reviewSourceProblems?.[sha256(JSON.stringify(s.resultTexts))];
  if (recordedFailure) return { verified: false, reason: recordedFailure, doc: null };
  const versionId = s.resultVersionId || s.reviewVersionId;
  return reviewedSourceDocument(s.resultTexts, { versionId,
    savedDoc: versionId === s.workVersion?.id ? doc : null });
}

/**
 * 取会话对应的 ZIP 读取器（图片字节从这里读）。
 *
 * 优先用**原始字节流**：`cleanDocx` 只动批注相关 part，`word/media/*` 原样保留，
 * 但用原始流最稳妥（清洗稿若出意外也不影响取图）。
 * 解析一次缓存到会话上——`/api/session-media` 会被一张图一次地反复调用，
 * 每张都重解一遍中央目录是白费（长稿有上百个 media 条目）。
 */
function sessionZip(s) {
  const src = s.originalBuffer || s.buffer;
  if (!s._zip || s._zipSrc !== src) { s._zip = openZip(src); s._zipSrc = src; }
  return s._zip;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req, limit = 120 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/**
 * 把解析结果精简成前端可用的结构。
 *
 * ⚠️ 标题分级**在这里现算**，不能只依赖段落上的 `_headingLevel`。
 *
 * 踩过的坑：`_headingLevel` 是 `classifyParagraphs()` 写的，而它只在
 * **审阅**时（`scanFormat()` 内部）才跑；`serializeDoc()` 却在上传
 * 那一刻就被调用 —— 于是上传响应里的 `headings` 永远是空的，
 * 界面上「各级标题」在审阅开始前完全看不到。实测确认过：
 * 上传 test.docx 得到 0 条标题，审阅之后才有。
 *
 * 这里调的是 `classifyParagraphs()` 而**不是** `classifyHeadings()`：
 * 前者会先判出篇名/署名/提要等前置区角色，再把这些段排除在标题之外。
 * 只用 `classifyHeadings()` 会漏掉这一步 —— 实测 test.docx 的篇名
 * 「作为经济基础的国家：对历史唯物主义的再认识」（比正文大、居中加粗）
 * 就被当成了一条三级标题。
 *
 * 纯函数、不吃网络，一篇 1.3 万字稿件上是毫秒级，所以直接在这里算。
 *
 * 走 `rolesOf()` 而不是直接调 `classifyParagraphs()`：`serializeDoc()` 会被
 * `/api/session`、`/api/review-status`、`/api/apply-fixes`
 * 反复调用（审阅期间前端在轮询状态），每次重算一遍角色分类是白费。
 * `rolesOf()` 把结果缓存在 doc 上，同一份稿子只算一次。
 */
function serializeDoc(doc) {
  rolesOf(doc);
  const headingOf = (p, i) => {
    // classifyParagraphs 已把结果写到段落上（含前置区清理后的最终结论）
    const marked = p._headingLevel ? Number(String(p._headingLevel).replace('level', '')) || null : null;
    return { level: marked, source: p._headingSource || '' };
  };
  const headings = [];
  doc.paragraphs.forEach((p, i) => {
    const h = headingOf(p, i);
    if (!h.level) return;
    headings.push({
      index: i,
      wordIndex: p.index,
      level: h.level,
      levelName: `level${h.level}`,
      source: h.source,
      text: (p.text || '').trim(),
    });
  });
  return {
    label: doc.label,
    sourcePackageSha256: doc.sourcePackageSha256,
    core: doc.core,
    stats: doc.stats,
    originalCommentCount: doc.originalCommentCount ?? (doc.comments || []).length,
    meta: detectMeta(doc),
    paragraphs: doc.paragraphs.map((p, i) => {
      const h = headingOf(p, i);
      return {
        ...sourceNodeIdentity(p),
        sourceCharacters: (p.sourceCharacters || []).map(character => ({ ...character })),
        text: p.text,
        before: p.before,
        changed: p.changed,
        style: p.properties.style,
        jc: p.properties.jc,
        outline: p.properties.outline,
        outlineLevel: p.properties.outlineLevel ?? null,
        headingLevel: h.level,
        headingSource: h.source,
        eastAsia: p.format.eastAsia,
        sizeHalfPt: p.format.sizeHalfPt,
        bold: p.format.bold,
        inTable: p.inTable,
        /**
         * 「导入即清洗」：特殊格式必须随负载下发，否则前端与规则引擎会
         * **静默降级** —— 解析器明明抽出来了，界面上却什么都没有。
         *
         * ⚠️ 这里曾经漏过：`docx.js` 加了 `marks` / `noteRefs` /
         * `textboxes` / `figures`，但本函数是白名单式的，没加进来，
         * 于是上传负载里这几个字段全为空。是 `verify-requirements.mjs`
         * 的【导入即清洗】断言块抓出来的（4 条同时失败）。
         * 同一类问题本项目已发生过两次（`info.superscript` 全项目零处使用），
         * 所以每次给 `docx.js` 加字段，必须同步检查这里。
         */
        marks: p.marks || [],
        noteRefs: p.noteRefs || [],
        highlights: p.highlights || [],
        fields: p.fields || [],
        textboxes: p.textboxes || [],
        figures: p.figures || [],
      };
    }),
    headings,
    // isNoteSeparator 必须下发：docx 的 footnotes.xml 里含 separator /
    // continuationSeparator 条目，前端要靠它跳过这些条目才能显示正确的脚注序号。
    footnotes: doc.footnotes.map((p, i) => ({ ...sourceNodeIdentity(p), sourceCharacters: (p.sourceCharacters || []).map(character => ({ ...character })), index: i, text: p.text,
      isNoteSeparator: !!p.isNoteSeparator, noteId: p.noteId ?? null, noteType: p.noteType || '',
      inTable: !!p.inTable, tableIdx: p.tableIdx ?? null })),
    endnotes: doc.endnotes.map((p, i) => ({ ...sourceNodeIdentity(p), sourceCharacters: (p.sourceCharacters || []).map(character => ({ ...character })), index: i, text: p.text,
      isNoteSeparator: !!p.isNoteSeparator, noteId: p.noteId ?? null, noteType: p.noteType || '',
      inTable: !!p.inTable, tableIdx: p.tableIdx ?? null })),
    /**
     * 正文里脚注引用的**出现顺序**（OOXML `w:footnoteReference` 的 `w:id`）。
     * 前端据此把第 i 个正文上标精确映射到 `noteId === footnoteRefs[i]` 的注释，
     * 而不是「第 i 个上标配第 i 个 li」的按序配对 —— 后者在正文含
     * 非脚注上标、或同时有尾注（两套编号都从 1 开始）时会错配。
     */
    footnoteRefs: doc.footnoteRefs || [],
    /**
     * ⚠️ 原文自带的 Word 批注**不再下发**（需求 2）。
     *
     * 原先这里下发 `comments: doc.comments`（含 author / date / text /
     * anchorText）与每段的 `commentIds`。这些是稿件上一轮的责编批注、
     * 也是规则库的学习语料，按要求不参与本次审阅、也不在界面出现。
     * 保留 `stats.comments`（批注条数）作为解析统计。
     */
    tables: doc.tables,
    blocks: doc.blocks,
    revisions: doc.revisions.slice(0, 5000),
  };
}

function requireReviewService(){if(!reviewService){const error=new Error('服务器审阅任务未就绪，请查看恢复状态');error.status=503;throw error;}return reviewService;}
async function reviewStatusPayload(s,{runId=null,includeDoc=false,attempt=0}={}){
  const activeJob=await currentSessionJob(s.id);
  let latestJob=null;
  if(!activeJob){
    const latest=await latestSessionJob(s.id);
    latestJob=latest;
    // Publishing can become terminal without another session revision. A prior
    // derived running view must yield to durable facts even at the same revision.
    if(reviewJobActive(s._activeReviewJob)||latest?.sessionReceipt?.sessionRevision>(s._storeRevision??-1)){
      if(attempt>=3){const error=new Error('稿件状态正在变化，请稍后重试');error.status=503;throw error;}
      return reviewStatusPayload(await touchSession(s.id,{fresh:true}),{runId,includeDoc,attempt:attempt+1});
    }
  }
  const unstartedCancellation=!activeJob&&latestJob?.status==='cancelled'&&latestJob.sessionReceipt?.reason==='cancelled-before-start'
    &&latestJob.binding.versionId===s.workVersion.id&&latestJob.binding.mutationEpoch===(s.mutationEpoch||0);
  let selectedJob=activeJob||(unstartedCancellation?latestJob:null);
  const currentRun=activeJob?.id||(unstartedCancellation?latestJob.id:null)||s.reviewRunId||effectiveReviewRunId(s);
  const selectedRun=runId||currentRun;
  if(runId&&runId!==currentRun){const error=new Error('审阅运行已变化，请刷新后核对；旧运行只能作为历史查看');error.status=409;throw error;}
  if(!selectedJob&&selectedRun&&/^r[a-f0-9]{64}$/.test(selectedRun))selectedJob=await currentSessionJob(s.id,{runId:selectedRun});
  if(!activeJob&&selectedJob?.sessionReceipt?.sessionRevision>(s._storeRevision??-1)){
    if(attempt>=3){const error=new Error('稿件状态正在变化，请稍后重试');error.status=503;throw error;}
    return reviewStatusPayload(await touchSession(s.id,{fresh:true}),{runId,includeDoc,attempt:attempt+1});
  }
  if(runId&&!selectedJob&&runId!==effectiveReviewRunId(s)){const error=new Error('审阅运行不属于当前记录');error.status=404;throw error;}
  const waiting=activeJob?.status==='queued',running=reviewJobRunning(activeJob)||!activeJob&&!selectedJob&&!!s.reviewRunning;
  const hasResult=!activeJob&&!unstartedCancellation&&currentResultAvailable(s)&&(!runId||runId===effectiveReviewRunId(s));
  const phase=s.reviewProgress?.phase;
  const status=selectedJob?.status||(s.reviewRunning?'running-unverified':s.interrupted?'interrupted':s.cancelled?'cancelled':s.reviewError?'failed':hasResult?phase==='partial'?'partial':'completed':'unreviewed');
  return{id:s.id,reviewRunId:selectedRun||null,reviewJobId:selectedJob?.id||null,workVersionId:s.workVersion.id,
    reviewVersionId:selectedJob?.binding.versionId||s.resultVersionId||s.reviewVersionId||null,status,waiting,running,
    progress:activeJob?.progress||(unstartedCancellation?selectedJob.progress:null)||s.reviewProgress||null,
    error:unstartedCancellation?null:selectedJob?.sessionReceipt?.unpublished?'工作稿已变化，此次任务没有覆盖当前稿':s.reviewError||null,
    hasResult,hasHistoricalResult:!!s.result||!!s.reviewRecords?.length||!!s.legacy?.historyAvailable,
    cancelled:selectedJob?.status==='cancelled'||!!s.cancelled,cancelRequested:activeJob?.cancelRequested||false,
    appliedFixes:completedFixKeys(s),appliedFixDetails:s.appliedFixes||[],workVersion:s.workVersion,history:fixHistoryStatus(s),
    human:humanState(s),interrupted:selectedJob?.status==='interrupted'||!!s.interrupted,clean:s.clean||null,legacy:s.legacy||null,
    result:hasResult?serializeReview(s.result,s.doc,s):null,reviewJob:publicReviewJob(selectedJob),...(includeDoc?{doc:serializeDoc(s.doc)}:{})};
}

async function startReviewRequest(s,options,body={},allowAttach=false){
  const service=requireReviewService();
  const current=await currentSessionJob(s.id);
  if(current){
    if(body.baseVersionId&&body.baseVersionId!==current.binding.versionId||body.baseMutationEpoch!=null&&body.baseMutationEpoch!==current.binding.mutationEpoch){const error=new Error('此次请求的工作稿或修改历史与已登记任务不同');error.status=409;throw error;}
    if(body.operationId&&body.operationId!==current.operationId){const error=new Error('此稿件已有未完成任务，请等待或取消后重审');error.status=409;throw error;}
    if(!sameReviewOptions(current.config,options)){const error=new Error('正在审阅的设置与此次请求不同');error.status=409;throw error;}
    if(!allowAttach&&!body.operationId){const error=new Error('此稿件已有未完成任务');error.status=409;throw error;}
    return{job:current,replayed:true};
  }
  if(s.reviewRunning&&!s.reviewJobId){const error=new Error('旧审阅运行缺少所有者记录，请先确认旧服务任务已结束');error.status=409;throw error;}
  return service.enqueue(s,options,{operationId:body.operationId||randomUUID(),baseVersionId:body.baseVersionId,
    baseMutationEpoch:body.baseMutationEpoch,workspaceId:s.workspaceId||null});
}

async function streamReviewRequest(req,res,url){
  const s=await touchSession(url.searchParams.get('id'));if(!s)return json(res,404,{error:'会话不存在，请重新导入稿件'});
  const service=requireReviewService(),requestedRun=url.searchParams.get('runId'),detach=url.searchParams.get('detach')==='1';
  const want=queryReviewOptions(url.searchParams,DEFAULT_MODEL);
  let job;
  if(requestedRun){job=await currentSessionJob(s.id,{runId:requestedRun});if(!job)return json(res,404,{error:'审阅运行不存在'});}
  else{
    const active=await currentSessionJob(s.id);
    if(!active&&detach&&url.searchParams.get('force')!=='1'&&currentResultAvailable(s)&&s.resultVersionId===s.workVersion.id&&sameReviewOptions(s.resultOptions,want)&&s.resultRecipe===service.recipe)
      return json(res,200,{reused:true,id:s.id,result:serializeReview(s.result,s.doc,s)});
    if(active&&!detach)return json(res,409,{error:'该稿件正在审阅中，请稍候'});
    job=(await startReviewRequest(s,want,{operationId:url.searchParams.get('operationId')||undefined},detach)).job;
  }
  const header=req.headers['last-event-id'];
  const cursorText=url.searchParams.get('afterSeq')||(typeof header==='string'?header.split(':').at(-1):'0');
  if(!/^\d+$/.test(cursorText)||!Number.isSafeInteger(Number(cursorText)))return json(res,400,{error:'事件位置无效'});
  if(typeof header==='string'&&header.includes(':')&&!header.startsWith(job.id+':'))return json(res,409,{error:'事件位置不属于此次审阅'});
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});
  res.flushHeaders();
  let closed=false,unsubscribe=null;
  const finish=()=>{if(closed)return;closed=true;unsubscribe?.();res.end();};
  res.on('close',()=>{if(closed)return;closed=true;unsubscribe?.();if(!detach)void service.runtime.cancel({jobId:job.id}).catch(()=>{});});
  unsubscribe=await service.runtime.observe({jobId:job.id,afterSeq:Number(cursorText),onEvent:event=>{
    if(closed)return;
    const data={...event.data,id:job.sessionId,reviewRunId:job.id,reviewJobId:job.id,workVersionId:job.binding.versionId};
    if(res.writableLength>1024*1024){finish();return;}
    res.write(`id: ${job.id}:${event.seq}\nevent: ${event.event}\ndata: ${JSON.stringify(data)}\n\n`);
    if(['done','error','cancelled'].includes(event.event))finish();
  }});
  if(closed)unsubscribe();
}

/** 规则文件映射：按规则号前缀定位到对应的规则库文件，供「规则编辑」落盘使用 */
const RULE_FILES = [
  { file: 'format-rules.json', group: 'format', match: /^FMTB?-/ },
  { file: 'language-rules.json', group: 'language', match: /^LANG-/ },
  { file: 'citation-rules.json', group: 'citation', match: /^CIT-/ },
];

const routes = {
  'GET /api/workspace': async (req, res, url) => {
    return json(res, 200, await workspacePayload(await storedWorkspace(url.searchParams.get('id') || 'wdefault')));
  },

  'POST /api/workspace': async (req, res) => {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(body.operationId || '') || !Number.isSafeInteger(body.expectedRevision)) return json(res, 400, {error: '工作台操作身份或版本无效'});
    await workspaceWrite(body.id, async () => {
      const stored = await storedWorkspace(body.id);
      const fingerprint = sha256(Buffer.from(JSON.stringify([body.action, body.expectedRevision, body.sessionId,
        body.entryId, body.name, body.error, body.state, body.cursorSessionId, body.options])));
      const receipt = Object.hasOwn(stored.workspace.receipts, body.operationId) ? stored.workspace.receipts[body.operationId] : null;
      if (receipt) return json(res, receipt.fingerprint === fingerprint ? 200 : 409,
        await workspacePayload(stored, receipt.fingerprint === fingerprint ? {replayed: true} : {error: '同一操作身份不能用于不同工作台操作'}));
      if (body.expectedRevision !== stored.manifest.revision) return json(res, 409, await workspacePayload(stored, {error: '工作台已变化，请刷新后核对'}));
      const workspace = structuredClone(stored.workspace);
      if (body.action === 'attach') {
        const s = await touchSession(body.sessionId);
        if (!s) return json(res, 404, {error: '待登记的稿件不存在'});
        if (!workspace.entries.some((entry) => entry.id === s.id)) workspace.entries.push({entryId: `e${randomUUID()}`, id: s.id,
          name: s.name, sourceSha256: s.workVersion.sourceSha256, addedAt: new Date().toISOString()});
        if (!workspace.activeSessionId) workspace.activeSessionId = s.id;
      } else if (body.action === 'activate') {
        if (!workspace.entries.some((entry) => entry.id && entry.id === body.sessionId)) return json(res, 409, {error: '稿件不属于该工作台'});
        workspace.activeSessionId = body.sessionId;
      } else if (body.action === 'failure') {
        if (!/^e[A-Za-z0-9_-]{1,160}$/.test(body.entryId || '') || typeof body.name !== 'string' || body.name.length > 300
          || typeof body.error !== 'string' || body.error.length > 2000) return json(res, 400, {error: '导入失败记录无效'});
        if (workspace.entries.some((entry) => entry.entryId === body.entryId)) return json(res, 409, {error: '队列项身份已经存在'});
        workspace.entries.push({entryId: body.entryId, name: body.name, error: body.error, addedAt: new Date().toISOString()});
      } else if (body.action === 'queue') {
        if (!['paused', 'completed', 'ready'].includes(body.state)
          || body.cursorSessionId != null && !workspace.entries.some((entry) => entry.id === body.cursorSessionId)
          || JSON.stringify(body.options || null).length > 4000) return json(res, 400, {error: '续审状态或游标无效'});
        if (body.state === 'completed') {
          const current = await workspacePayload(stored);
          if (current.workspace.entries.some((entry) => entry.status !== 'complete')) return json(res, 409, {...current, error: '队列仍有未完成或导入失败的稿件，请保留待处理状态'});
        }
        workspace.queue = {state: body.state, cursorSessionId: body.cursorSessionId || null,
          options: body.options || null, savedAt: new Date().toISOString()};
      } else return json(res, 400, {error: '工作台操作类型无效'});
      workspace.receipts = {...workspace.receipts, [body.operationId]: {fingerprint, savedAt: new Date().toISOString()}};
      workspace.updatedAt = new Date().toISOString();
      try {
        return json(res, 200, await workspacePayload(await commitWorkspace(workspace, stored.manifest.revision)));
      } catch (error) {
        if (['WORKSPACE_REVISION_CONFLICT', 'WORKSPACE_BUSY'].includes(error.code)) return json(res, 409, await workspacePayload(await storedWorkspace(body.id), {error: '工作台保存冲突，请刷新后核对'}));
        throw error;
      }
    });
  },

  'GET /api/human-records': async (req, res, url) => {
    const s = await touchSession(url.searchParams.get('id'));
    if (!s) return json(res, 404, {error: '稿件不存在'});
    return json(res, 200, humanPayload(s, url.searchParams.get('history') === '1' ? {records: s.humanRecords || []} : {}));
  },

  'POST /api/human-records': async (req, res) => {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(body.operationId || '')) return json(res, 400, {error: '人工操作身份无效'});
    const s = await touchSession(body.id);
    if (!s) return json(res, 404, {error: '稿件不存在'});
    const pending = pendingDuplicate(s, body, 'human');
    if (pending) await pending;
    const gate = mutationGate(s, body, 'human');
    if (gate?.replayed) return json(res, 200, humanPayload(s, {replayed: true}));
    if (gate) return json(res, gate.status, humanPayload(s, {error: gate.error}));
    let record;
    try { record = buildHumanRecord(s, body); }
    catch (error) { return json(res, error.status || 400, humanPayload(s, {error: error.message})); }
    const finish = beginMutation(s, body, 'human');
    try {
      const candidate = {...s, humanRecords: [...(s.humanRecords || []), record], humanRevision: (s.humanRevision || 0) + 1};
      recordMutationReceipt(candidate, body, 'human');
      await persistSession(candidate);
      Object.assign(s, candidate);
      let auditWarning = null;
      try { recordAudit(humanAuditEntry(s, record)); }
      catch { auditWarning = '人工记录已保存，审稿日志投影暂未写入；原始记录可从人工历史恢复'; }
      return json(res, 200, humanPayload(s, {recordId: record.id, auditWarning}));
    } catch (error) { return json(res, error.code === 'SESSION_REVISION_CONFLICT' ? 409 : 500,
      humanPayload(s, {error: `人工记录未提交：${error.message}`})); }
    finally { finish(); }
  },

  'GET /api/health': async (req, res) => {
    json(res, 200, {
      ok: true,
      arkConfigured: arkConfigured(),
      defaultModel: DEFAULT_MODEL,
      models: MODEL_CANDIDATES,
      ...(arkModelEndpointConfig()?{modelEndpointMode:'configured-exact',modelResolution:resolveArkModel(DEFAULT_MODEL),modelEndpointsSha256:arkModelEndpointConfig().sha256}:{}),
      rules: {
        format: loadFormatRules().rules.length,
        language: loadLanguageRules().rules.length,
        citation: loadCitationRules().rules.length,
      },
      sessions: sessions.size,
      ingestionProtocol: 1,
      ingestionRecovery,
      reviewQueueProtocol:reviewService?1:null,
      applyContextProtocol: 1,
      reviewRecovery,
      documentWorkerLimit: Number(process.env.DSH_REVIEW_WORKERS||2),
    });
  },

  /**
   * 审稿经验审计（用户需求 7）。
   *
   * POST 追加记录：审稿人的圈画、对规则/模型结论的处置与看法。
   * GET  按 sessionId / kind 查询：用于「编辑本次审阅做了什么」的复盘。
   * GET /api/audit-summary：按规则聚合，产出**规则/提示词优化建议**。
   *
   * 每条记录会被自动补上审阅任务上下文（sessionId + 稿件名），
   * 保证「哪一次审阅、哪篇稿子」这一层溯源不需要前端记得传。
   */
  'POST /api/audit': async (req, res) => {
    const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}');
    const s = body.id ? await touchSession(body.id) : null;
    const list = Array.isArray(body.entries) ? body.entries : [body];
    const enriched = list.filter(Boolean).map((e) => ({
      ...e,
      sessionId: e.sessionId || body.id || '',
      manuscript: e.manuscript || s?.name || '',
      // The client audit entry point cannot mint a server export receipt.
      // Purpose and other submitted context remain observations.
      provenance: { ...e.provenance, origin: 'client-audit' },
    }));
    try {
      const out = recordAudit(enriched);
      return json(res, 200, { ok: true, recorded: out.length, entries: out });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  },

  'GET /api/audit': async (req, res, url) => {
    const entries = listAudit({
      sessionId: url.searchParams.get('id') || '',
      kind: url.searchParams.get('kind') || '',
      limit: Number(url.searchParams.get('limit')) || 0,
    });
    json(res, 200, { entries, count: entries.length });
  },

  'GET /api/audit-summary': async (req, res) => {
    json(res, 200, auditSummary());
  },

  /**
   * 导出审稿日志（B2）：`?format=csv|jsonl`，可选 `?id=` 只导本次、`?kind=` 按类型。
   * 带 `Content-Disposition` 直接触发下载，便于把审稿经验带出去做后续规则迭代。
   */
  'GET /api/audit-export': async (req, res, url) => {
    const entries = listAudit({
      sessionId: url.searchParams.get('id') || '',
      kind: url.searchParams.get('kind') || '',
    });
    const fmt = (url.searchParams.get('format') || 'jsonl').toLowerCase();
    if (fmt === 'csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="audit-log.csv"',
        'Cache-Control': 'no-store',
      });
      return res.end(toCsv(entries));
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': 'attachment; filename="audit-log.jsonl"',
      'Cache-Control': 'no-store',
    });
    res.end(entries.map((e) => JSON.stringify(e)).join('\n'));
  },

  'GET /api/rules': async (req, res) => {
    const fmt = loadFormatRules();
    const lang = loadLanguageRules();
    const cit = loadCitationRules();
    json(res, 200, {
      format: { meta: fmt.meta, journal: fmt.journal, rules: fmt.rules.map((r) => withStatus(r, 'format')) },
      language: { meta: lang.meta, rules: lang.rules.map((r) => withStatus(r, 'language')), lexicon: lang.lexicon },
      citation: { meta: cit.meta, rules: cit.rules.map((r) => withStatus(r, 'citation')) },
      /**
       * modelRules 必须与**真正注入提示词的那一组**完全一致。
       *
       * 原先只从 language 里筛 type==='model'，得到 9 条；而 ark.js 的
       * promptStyleRules() 现在会跨三个规则文件收集（目标点 11 的定性工作
       * 把 11 条格式规则也改判为 model），实际注入 20 条。
       * 于是规则管理页显示「交模型判断 20 条」，模型却只收到 9 条 —— 页面在说谎。
       * 这里改为直接调用 promptStyleRules()，让「显示」与「实际注入」同源，
       * 从根上避免再次漂移。
       */
      modelRules: promptStyleRules().map((r) => ({
        id: r.id, category: r.category, title: r.title, severity: r.severity,
        method: r.method, rule: r.rule, status: 'model', statusNote: '由模型做语义判断',
      })),
      statusSummary: summarizeStatus(fmt, lang, cit),
      instructions: REVIEW_INSTRUCTIONS,
    });
  },

  /**
   * 规则编辑（需求：所有规则都要可以查看编辑）。
   *
   * 只写回 `rules/*.json`，不重启即生效 —— 三个 scanner 的 loadXxxRules()
   * 都是**每次扫描现读文件**、没有内存缓存，所以下一次审阅就会用上新规则。
   *
   * 安全约束：只接受白名单字段；`detect.patterns` 每一条都要能编译成正则
   * （否则写坏规则会让扫描器抛错），不合法直接 400 拒绝，不落盘。
   */
  'POST /api/rules/update': async (req, res) => {
    const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}');
    const id = String(body.id || '').trim();
    const patch = body.patch || {};
    if (!id) return json(res, 400, { error: '缺少规则编号' });
    const target = RULE_FILES.find((f) => f.match.test(id));
    if (!target) return json(res, 400, { error: `未知规则编号：${id}` });
    const file = resolve(__dirname, 'rules', target.file);
    let cfg;
    try {
      cfg = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      return json(res, 500, { error: `规则文件读取失败：${err.message}` });
    }
    const rule = (cfg.rules || []).find((r) => r.id === id);
    if (!rule) return json(res, 404, { error: `规则文件中找不到 ${id}` });

    /**
     * `optimizationNote` 是审计闭环（E1）写回的「规则优化备注」：
     * 由「审稿日志」里的规则优化建议一键写入，只记录不改检测行为 ——
     * 与规则自身的 `note` 分开，避免覆盖人工维护的说明。
     */
    const TEXT_FIELDS = ['title', 'category', 'severity', 'rule', 'detail', 'fix', 'basis', 'note', 'status', 'statusNote', 'optimizationNote'];
    const ARRAY_FIELDS = ['badExamples', 'goodExamples'];
    for (const k of TEXT_FIELDS) if (patch[k] !== undefined) rule[k] = String(patch[k]);
    if (patch.occurrences !== undefined) rule.occurrences = Number(patch.occurrences) || 0;
    for (const k of ARRAY_FIELDS) {
      if (patch[k] === undefined) continue;
      rule[k] = Array.isArray(patch[k]) ? patch[k].map(String)
        : String(patch[k]).split('\n').map((s) => s.trim()).filter(Boolean);
    }
    if (patch.detect && typeof patch.detect === 'object') {
      const d = { ...(rule.detect || {}) };
      if (patch.detect.type !== undefined) d.type = String(patch.detect.type);
      if (patch.detect.method !== undefined) d.method = String(patch.detect.method);
      if (patch.detect.patterns !== undefined) {
        const arr = Array.isArray(patch.detect.patterns) ? patch.detect.patterns.map(String)
          : String(patch.detect.patterns).split('\n').map((s) => s.trim()).filter(Boolean);
        for (const p of arr) {
          try { new RegExp(p); } catch (err) { return json(res, 400, { error: `违例模式不是合法正则：${p}（${err.message}）` }); }
        }
        d.patterns = arr;
      }
      if (patch.detect.lexicon !== undefined) {
        d.lexicon = Array.isArray(patch.detect.lexicon) ? patch.detect.lexicon.map(String)
          : String(patch.detect.lexicon).split('\n').map((s) => s.trim()).filter(Boolean);
      }
      rule.detect = d;
    }

    try {
      await writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    } catch (err) {
      return json(res, 500, { error: `规则文件写入失败：${err.message}` });
    }
    json(res, 200, { ok: true, file: target.file, rule: withStatus(rule, target.group) });
  },

  'POST /api/ingestions': async (req, res) => {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
    try { return json(res, 200, await ingestionResponse(await beginIngestion(body))); }
    catch (error) { return ingestionFailure(res, error, error.ingestionId); }
  },

  'GET /api/ingestion': async (req, res, url) => {
    const id = url.searchParams.get('id');
    try {
      const record = await verifyIngestionContext({ingestionId: id});
      // A status read never reopens a commit or automatically starts a review.
      return json(res, 200, await ingestionResponse({record}));
    } catch (error) { return ingestionFailure(res, error, id); }
  },

  'POST /api/resume-ingestion': async (req, res) => {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
    try {
      const result = await resumeIngestion({ingestionId: body.id});
      return json(res, result.receipt?.status || 200, await ingestionResponse(result));
    } catch (error) { return ingestionFailure(res, error, body.id); }
  },

  'POST /api/upload': async (req, res, url) => {
    let record, buffer;
    try {
      const ingestionId = req.headers['x-ingestion-id'];
      const operationId = req.headers['x-upload-operation'];
      const workspaceId = req.headers['x-workspace-id'];
      const name = url.searchParams.get('name') || 'manuscript.docx';
      if (ingestionId || operationId || workspaceId) {
        if (!ingestionId || !operationId || !workspaceId) {
          const error = new Error('上传需要完整的工作台与操作身份'); error.status = 400; throw error;
        }
        record = await verifyIngestionContext({ingestionId});
        if (record.operationId !== operationId || record.workspaceId !== workspaceId || record.name !== name) {
          const error = new Error('上传文件与已登记的操作身份不一致'); error.status = 409; error.code = 'INGESTION_CONFLICT'; throw error;
        }
      } else {
        const length = req.headers['content-length'] == null ? null : Number(req.headers['content-length']);
        if (length === null || !Number.isSafeInteger(length) || length < 0) buffer = await readBody(req);
        const begun = await beginIngestion({workspaceId: url.searchParams.get('workspace') || 'wdefault',
          operationId: `legacy-${randomUUID()}`, name, size: buffer?.length ?? length});
        record = begun.record;
      }
      buffer ||= await readBody(req);
      const result = await submitIngestion({...record, buffer});
      return json(res, result.receipt?.status || 200, await ingestionResponse(result));
    } catch (error) { req.resume(); return ingestionFailure(res, error, record?.ingestionId); }
  },

  'GET /api/legacy-review': async (req, res, url) => {
    const s = await touchSession(url.searchParams.get('id'));
    if (!s) return json(res, 404, {error: '会话不存在'});
    if (!s.legacy?.archiveId) return json(res, 404, {error: '该稿件没有迁移历史记录'});
    const saved = await loadLegacyReview({archiveId: s.legacy.archiveId});
    return json(res, 200, {id: s.id, legacy: s.legacy, view: saved.view,
      captureSha256: saved.manifest.captureSha256, source: saved.manifest.source,
      captureHashes: {archiveId: saved.manifest.id, captureSha256: saved.manifest.captureSha256,
        files: saved.manifest.files.map(({file,sha256})=>({file,sha256}))}});
  },

  'POST /api/clean-session': async (req, res) => {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
    if (!body.operationId || !body.baseVersionId || !Number.isSafeInteger(body.baseMutationEpoch))
      return json(res, 400, {error: '清洗操作需要明确的操作、工作版本和历史身份'});
    const s = await touchSession(body.id);
    if (!s) return json(res, 404, {error: '会话不存在'});
    const pending = pendingDuplicate(s, body, 'clean');
    if (pending) await pending;
    const gate = mutationGate(s, body, 'clean');
    if (gate?.replayed) return json(res, 200, mutationPayload(s, {replayed: true}));
    if (gate) return json(res, gate.status, gate);
    const finish = beginMutation(s, body, 'clean');
    try {
      let cleaned;
      try { cleaned = cleanDocx(s.buffer); }
      catch (error) { return json(res, 422, {error: `清洗失败：${error.message}`, code: error.code || 'CLEAN_FAILED',
        workVersion: s.workVersion, history: fixHistoryStatus(s),
        clean: {status: 'failed', reason: error.message, originalCommentCount: s.doc.originalCommentCount,
          sourceSha256: s.workVersion.sourceSha256, workSha256: s.workVersion.sha256}}); }
      const candidate = {...s, cleanVerificationStarted: true};
      if (cleaned.stats.changed) {
        const version = await saveWorkingVersion({sessionId: s.id, name: s.name, buffer: cleaned.buffer,
          originalBuffer: s.originalBuffer, parent: s.workVersion, patches: [], operation: 'comment-clean',
          revision: s.maxVersionRevision + 1});
        const doc = parseDocxBuffer(cleaned.buffer, s.name);
        doc.originalCommentCount = s.doc.originalCommentCount;
        Object.assign(candidate, {buffer: cleaned.buffer, workVersion: version, doc, ...appendedFixState(s, version, [])});
        // Prior review context is retained as history, never promoted across an
        // unverified cleaning transition or later undo/redo.
        candidate.reviewRecords = structuredClone(s.reviewRecords || []);
        rememberCompletedReview(candidate);
        candidate.reviewRecords = candidate.reviewRecords.map((record) => ({...record, cleanBlocked: true}));
        Object.assign(candidate, {result: null, resultRunId: null, resultVersionId: null, resultTexts: null,
          reviewRunId: null, reviewVersionId: null, reviewTexts: null, reviewError: null, interrupted: false,
          reviewProgress: {phase: 'unreviewed', done: 0, total: 0, message: '清洗已验证，请开始新的审阅'}});
      } else candidate.mutationEpoch = (s.mutationEpoch || 0) + 1;
      candidate.clean = cleaningProof(cleaned.stats, candidate.workVersion, s.doc.originalCommentCount);
      rememberCleanProof(candidate);
      recordMutationReceipt(candidate, body, 'clean');
      const payload = mutationPayload(candidate, {operation: 'clean', noop: !cleaned.stats.changed});
      JSON.stringify(payload);
      await persistSession(candidate);
      Object.assign(s, candidate);
      return json(res, 200, payload);
    } catch (error) { return json(res, 500, {error: `清洗未提交：${error.message}`, workVersion: s.workVersion,
      history: fixHistoryStatus(s), clean: s.clean, legacy: s.legacy || null}); }
    finally { finish(); }
  },

  'POST /api/review': async (req,res)=>{
    const body=JSON.parse((await readBody(req,4*1024*1024)).toString('utf8')||'{}');
    const s=await touchSession(body.id);if(!s)return json(res,404,{error:'会话不存在，请重新导入稿件'});
    const want=normalizeReviewOptions(body,DEFAULT_MODEL);
    if(body.force===false&&currentResultAvailable(s)&&s.resultVersionId===s.workVersion.id&&sameReviewOptions(s.resultOptions,want)&&s.resultRecipe===requireReviewService().recipe)
      return json(res,200,{reused:true,id:s.id,result:serializeReview(s.result,s.doc,s)});
    const {job,replayed}=await startReviewRequest(s,want,body,body.async===true);
    if(body.async===true){const current=await touchSession(s.id);return json(res,202,{accepted:true,replayed,...await reviewStatusPayload(current,{runId:job.id})});}
    const terminal=await requireReviewService().runtime.waitForTerminal({jobId:job.id});
    const current=await touchSession(s.id,{fresh:true});const status=await reviewStatusPayload(current,{runId:job.id});
    if(['completed','partial'].includes(terminal.status)&&status.result)return json(res,200,status.result);
    return json(res,500,{...status,error:status.error||status.progress?.message||'此次审阅未完成'});
  },

  'GET /api/review-stream': streamReviewRequest,

  'POST /api/review-resume':async(req,res)=>{
    const body=JSON.parse((await readBody(req,1024*1024)).toString('utf8')||'{}');
    const s=await touchSession(body.id);if(!s)return json(res,404,{error:'会话不存在'});
    if(Object.keys(body).some(key=>!['id','fromRunId','baseVersionId','baseMutationEpoch','operationId','mode'].includes(key)))
      return json(res,400,{code:'REVIEW_RESUME_OPTIONS_INVALID',error:'补审沿用原运行的固定设置；变更设置请新建审阅'});
    let accepted;
    try{accepted=await requireReviewService().resume(s,body);}
    catch(error){if(Number.isInteger(error.status))return json(res,error.status,{error:error.message,code:error.code||'REVIEW_RESUME_FAILED'});throw error;}
    const current=await touchSession(s.id,{fresh:true});
    return json(res,202,{accepted:true,replayed:accepted.replayed,resumedFromRunId:accepted.resumedFromRunId,
      ...await reviewStatusPayload(current,{runId:accepted.job.id})});
  },
  'GET /api/review-execution':async(req,res,url)=>{
    const s=await touchSession(url.searchParams.get('id'));if(!s)return json(res,404,{error:'会话不存在'});
    const runId=url.searchParams.get('runId');if(!runId)return json(res,400,{error:'须指定审阅运行'});
    const job=await currentSessionJob(s.id,{runId});if(!job)return json(res,404,{error:'审阅运行不存在'});
    return json(res,200,{id:s.id,reviewRunId:job.id,workVersionId:job.binding.versionId,execution:await requireReviewService().executionView(job)});
  },
  /** 未知发送核对视图：只读，供工作台列出需要人工处置的请求记录。 */
  'GET /api/review-requests':async(req,res)=>json(res,200,await readArkRequestPool()),
  /**
   * 人工授权释放未知占位。
   * 必须带逐字确认语句；任何 4xx 都表示授权不足或目标状态已变化，
   * 客户端不得自动重试，必须重新核对后由人再确认一次。
   */
  'POST /api/review-requests/abandon':async(req,res)=>{
    const body=JSON.parse((await readBody(req,256*1024)).toString('utf8')||'{}');
    if(Object.keys(body).some(key=>!['attemptIds','acknowledge'].includes(key)))
      return json(res,400,{code:'ARK_ABANDON_INPUT_INVALID',error:'未知占位释放只接受请求身份与逐字确认语句'});
    try{return json(res,200,await abandonUnknownRequestSlots(body));}
    catch(error){
      if(Number.isInteger(error.status))return json(res,error.status,{error:error.message,code:error.code||'ARK_ABANDON_FAILED'});
      throw error;
    }
  },

  'GET /api/review-queue':async(req,res,url)=>{
    const stored=await storedWorkspace(url.searchParams.get('workspaceId'));
    const payload=await workspacePayload(stored);return json(res,200,{...payload,queue:payload.workspace.queue});
  },
  'POST /api/review-queue':async(req,res)=>{
    const body=JSON.parse((await readBody(req,4*1024*1024)).toString('utf8')||'{}');
    const stored=await storedWorkspace(body.workspaceId);let accepted;
    try{accepted=await requireReviewService().controlQueue(stored.workspace,body);}
    catch(error){
      if(error.status===409&&['REVIEW_QUEUE_CONFIG_CHANGED','ARK_EXECUTION_BLOCKED'].includes(error.code)){
        const payload=await workspacePayload(await storedWorkspace(body.workspaceId));
        return json(res,409,{...payload,queue:payload.workspace.queue,error:error.message,code:error.code});
      }
      throw error;
    }
    const payload=await workspacePayload(await storedWorkspace(body.workspaceId));return json(res,200,{...payload,queue:payload.workspace.queue,command:accepted.command});
  },

  /**
   * 取回一个已存在会话的文档骨架与审阅状态（目标点 5：断线重连）。
   *
   * 刷新页面后前端只剩 localStorage 里的会话 id，靠这个接口把
   * 「文档内容 + 审阅是否在跑 + 是否已有结果」一次性拿回来，
   * 不必让用户重新导入稿件、更不必重新烧一遍模型额度。
   * 只回文档骨架（与 /api/review-stream 的 doc 事件同构），不回原始文件 Buffer。
   */
  'GET /api/session': async (req, res, url) => {
    const s = await touchSession(url.searchParams.get('id'));
    /**
     * 会话不在时返回 **200 + exists:false**，而不是 404。
     *
     * 「刷新后发现自己上次的会话没了」是完全正常的路径（服务重启、
     * 或会话被 LRU 淘汰），不是错误。返 404 会让浏览器控制台常驻一条
     * 红色 `Failed to load resource`，把真正的故障淹没掉 ——
     * 排查时最怕的就是「分不清哪条红字是真问题」。
     */
    if (!s) return json(res, 200, { exists: false, id: url.searchParams.get('id') || null });
    json(res, 200, {
      exists: true,
      id: s.id,
      name: s.name,
      workVersion: s.workVersion,
      history: fixHistoryStatus(s),
      clean: s.clean || null,
      legacy: s.legacy || null,
      reviewRunId: effectiveReviewRunId(s),
      human: humanState(s),
      doc: serializeDoc(s.doc),
      running: !!s.reviewRunning,
      progress: s.reviewProgress || null,
      hasResult: currentResultAvailable(s),
      hasHistoricalResult: !!s.result || !!s.reviewRecords?.length || !!s.legacy?.historyAvailable,
      error: s.reviewError || null,
      interrupted: !!s.interrupted,
      // 逐处记录用作修改证据；阅读器从工作版本字节恢复，不再靠 DOM 回放。
      appliedFixes: completedFixKeys(s),
      appliedFixDetails: s.appliedFixes || [],
      result: currentResultAvailable(s) ? serializeReview(s.result, s.doc, s) : null,
      ...await reviewStatusPayload(s,{includeDoc:true}),
    });
  },

  /**
   * 取回会话的当前工作版本（original=1 才取上传原稿）。
   *
   * 为什么需要它：批阅视图与 Word 视图共用 docx-preview 渲染，
   * 而 docx-preview 吃的是原始 ArrayBuffer —— 光有解析后的文本骨架
   * 渲染不出页面。刷新后前端只记得会话 id，靠这个接口把字节流拿回来，
   * 才能真正「恢复现场」，而不是只剩一个空文档区。
   *
   * 会话本身持有 buffer（见 sessions.set），所以这里只是原样回吐，不重新解析。
   */
  'GET /api/session-file': async (req, res, url) => {
    const s = await touchSession(url.searchParams.get('id'));
    if (!s || !s.buffer) return json(res, 404, { error: '会话或原始文件不存在，请重新导入稿件' });
    /**
     * `?original=1` 回吐**投稿时上传的原始字节流**（含上一轮责编批注、
     * 未清洗的样式），供「查看原文」用。
     *
     * 为什么需要单独一个开关：清洗后的 `buffer` 是审阅与批注导出的基准，
     * 但审稿人有时需要核对「作者原稿到底长什么样」（比如怀疑清洗
     * 误删了内容）。这时切到原文视图，渲染 `originalBuffer` 即可，
     * 不必重新上传、也不影响清洗后的审阅结果。
     */
    const wantOriginal = url.searchParams.get('original') === '1';
    const buf = (wantOriginal && s.originalBuffer) ? s.originalBuffer : s.buffer;
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'X-Work-Version': wantOriginal ? 'original' : s.workVersion.id,
      'X-Content-SHA256': wantOriginal ? sha256(buf) : s.workVersion.sha256,
    });
    res.end(buf);
  },

  /**
   * 读取稿件内嵌图片（`word/media/*`）。
   *
   * ── 为什么需要单独一个端点 ──
   * docx-preview **不渲染** `w:drawing`，图片在页面上是空的。解析层已把
   * 每个 figure 的 `media[].path`（ZIP 条目名）下发，前端据此逐张取字节。
   * 走端点而不是把 base64 塞进 `/api/session`：一篇稿可能有上百张图、
   * 单张几 MB，塞进 JSON 会让会话负载与轮询一起变慢。
   *
   * 安全：`name` 只允许 `word/media/` 下的**扁平条目名**（无 `/`、无 `\`），
   * 从根上杜绝 `../` 路径穿越与读取任意 ZIP 条目。
   */
  'GET /api/session-media': async (req, res, url) => {
    const s = await touchSession(url.searchParams.get('id'));
    if (!s) return json(res, 404, { error: '会话不存在，请重新导入稿件' });
    const name = url.searchParams.get('name') || '';
    if (!/^word\/media\/[^/\\]+$/.test(name)) return json(res, 400, { error: '非法的媒体路径' });
    let data = null;
    try { data = sessionZip(s).read(name); } catch { data = null; }
    if (!data) return json(res, 404, { error: '图片不存在' });
    res.writeHead(200, {
      'Content-Type': MIME[extname(name).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(data);
  },

  /** 审阅进度与结果轮询：async / detach 模式下前端用它取回进度与结果 */
  'GET /api/review-status':async(req,res,url)=>{
    const s=await touchSession(url.searchParams.get('id'));if(!s)return json(res,404,{error:'会话不存在'});
    return json(res,200,await reviewStatusPayload(s,{runId:url.searchParams.get('runId')}));
  },
  'POST /api/cancel-review':async(req,res)=>{
    const body=JSON.parse((await readBody(req,1024*1024)).toString('utf8')||'{}');
    const s=await touchSession(body.id);if(!s)return json(res,404,{error:'会话不存在'});
    const job=await currentSessionJob(s.id);
    if(!job)return json(res,s.reviewRunning?409:200,{accepted:false,cancelled:false,unknown:!!s.reviewRunning,error:s.reviewRunning?'旧运行缺少持久所有者，不能假称已中止':null});
    if(body.reviewRunId&&body.reviewRunId!==job.id||body.reviewJobId&&body.reviewJobId!==job.id||body.workVersionId&&body.workVersionId!==s.workVersion.id)
      return json(res,409,{error:'稿件或审阅运行已变化，取消未执行'});
    const changed=await requireReviewService().runtime.cancel({jobId:job.id});
    return json(res,200,{id:s.id,reviewRunId:job.id,reviewJobId:job.id,workVersionId:s.workVersion.id,
      accepted:changed.cancelRequested||changed.status==='cancelled',cancelled:changed.status==='cancelled',
      cancelRequested:changed.cancelRequested,publicationCommitted:changed.status==='publishing'&&!changed.cancelRequested,status:changed.status});
  },

  'POST /api/report': async (req, res) => {
    const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}');
    const s = await touchSession(body.id);
    if (!s) return json(res, 404, { error: '会话不存在' });
    if (!currentResultAvailable(s)) return json(res, 409, { error: '本次审阅尚未完成，请完成审阅后导出报告' });
    const reviewRunId = effectiveReviewRunId(s);
    if ((body.baseVersionId != null && body.baseVersionId !== s.workVersion.id)
      || (Object.hasOwn(body, 'baseReviewRunId') && body.baseReviewRunId !== reviewRunId)) return json(res, 409, {
      code: 'EXPORT_CONTEXT_STALE', error: '稿件版本或审阅已变化，请刷新后重新导出', workVersion: s.workVersion, reviewRunId });
    const purpose = [s.purpose, body.purpose, body.provenance?.purpose].includes('verification') ? 'verification' : 'editorial';
    const verificationRunId = purpose === 'verification' ? String(body.verificationRunId ?? s.verificationRunId ?? '').slice(0, 100) || null : null;
    const view = structuredClone({ ...serializeReview(s.result, s.doc, s), modelResult: s.result.modelResult,
      completionStatus: s.result.completionStatus, appliedFixes: completedFixKeys(s) });
    const context = { exportId: randomUUID(), sessionId: s.id, reviewRunId, workVersion: { ...s.workVersion },
      resultVersionId: s.resultVersionId || s.reviewVersionId || null, purpose, verificationRunId, exportedAt: new Date().toISOString() };
    try {
      const exported = buildReportExport({ view, doc: { stats: structuredClone(s.doc.stats) }, context });
      const saved = await saveReportExport(exported, { storageRoot: REPORT_DIR });
      recordAudit({ kind: 'export', sessionId: s.id, manuscript: s.name, taskId: reviewRunId,
        humanAction: 'export-markdown-report', attributes: { receipt: saved.receipt },
        provenance: { origin: 'server-report-export', purpose, verificationRunId,
          exportId: context.exportId, workVersionId: context.workVersion.id, reviewRunId } });
      return json(res, 200, { markdown: exported.markdown, ...saved });
    } catch (err) { return json(res, 500, { error: `报告保存失败：${err.message}` }); }
  },

  /**
   * 导出「带批注的 Word 文档」。
   *
   * `accepted` 缺省 → 导出全部可锚定问题；给了数组 → 只导出其中的条目
   * （与前端 `issueKey()` 同键：`ruleId|location|quote`）。
   * 在指定的当前工作版本上注入 Word 批注。
   */
  'POST /api/export-docx': async (req, res) => {
    const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}');
    const s = await touchSession(body.id);
    if (!s) return json(res, 404, { error: '会话不存在' });
    if (!currentResultAvailable(s)) return json(res, 409, { error: '本次审阅尚未完成，请完成审阅后导出批注' });
    const version = { ...s.workVersion };
    const reviewRunId = effectiveReviewRunId(s);
    const purpose = (body.provenance?.purpose ?? body.purpose ?? s.purpose) === 'verification' ? 'verification' : 'editorial';
    const verificationRunId = purpose === 'verification'
      ? String(body.verificationRunId ?? body.provenance?.verificationRunId ?? s.verificationRunId ?? '').slice(0, 100) || null : null;
    if ((body.baseVersionId != null && body.baseVersionId !== version.id)
      || (Object.hasOwn(body, 'baseReviewRunId') && body.baseReviewRunId !== reviewRunId)) {
      return json(res, 409, { code: 'EXPORT_CONTEXT_STALE', error: '稿件版本或审阅已变化，请刷新后重新导出',
        workVersion: version, reviewRunId });
    }
    const keyOf = (x) => x.issueKey || `${x.ruleId}|${x.location}|${x.quote || ''}`;
    const accepted = Array.isArray(body.accepted) ? new Set(body.accepted) : null;
    // Use the same current-version ranges as the reader, including every
    // grouped occurrence and invalidated ranges after committed changes.
    const issues = serializeReview(s.result, s.doc, s).issues.filter((x) => (accepted ? accepted.has(keyOf(x)) : true));
    let out;
    let receipt;
    try {
      out = buildCommentedDocx({ buffer: s.buffer, issues, workVersionId: version.id, workSha256: version.sha256 });
      receipt = {
        schemaVersion: 1, exportId: randomUUID(), generatedAt: new Date().toISOString(), sessionId: s.id, manuscript: s.name,
        reviewRunId, resultVersionId: s.resultVersionId || s.reviewVersionId || null, purpose, verificationRunId,
        workVersion: { id: version.id, sha256: version.sha256, sourceSha256: version.sourceSha256 },
        sourceSha256: version.sourceSha256, outputSha256: sha256(out.buffer), outputBytes: out.buffer.length,
        selection: accepted ? 'selected' : 'all', selectedIssueKeys: issues.map(keyOf), requestedIssues: issues.length,
        placementSchemaVersion: out.placementSchemaVersion, added: out.added, addedIssues: out.addedIssues,
        skipped: out.skipped, byPart: out.byPart, actualByPart: out.actualByPart,
        noteSources: out.placements.filter((p) => p.source.target === 'footnote' || p.source.target === 'endnote').length,
        placements: out.placements, skippedDetails: out.skippedDetails,
      };
      // Keep the full range/target correspondence in the existing append-only
      // record, rather than exceeding HTTP header limits on long manuscripts.
      recordAudit({ kind: 'export', sessionId: s.id, manuscript: s.name, taskId: reviewRunId,
        humanAction: 'export-commented-docx', attributes: { receipt },
        provenance: { origin: 'server-export', purpose, verificationRunId,
          exportId: receipt.exportId, workVersionId: version.id, reviewRunId } });
    } catch (err) {
      return json(res, 500, { error: `导出批注失败：${err.message}` });
    }
    const safe = (s.name || 'manuscript').replace(/[\\/:*?"<>|]/g, '_').replace(/\.docx?$/i, '');
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="reviewed.docx"; filename*=UTF-8''${encodeURIComponent(`${safe}_批注稿.docx`)}`,
      'Content-Length': out.buffer.length,
      'X-Comments-Added': String(out.added),
      'X-Comments-Skipped': String(out.skipped),
      'X-Comments-Added-Issues': String(out.addedIssues),
      'X-Comments-Note-Sources': String(receipt.noteSources),
      'X-Export-Placement-Schema': String(out.placementSchemaVersion),
      'X-Export-Id': receipt.exportId,
      'X-Content-SHA256': receipt.outputSha256,
      'X-Work-SHA256': version.sha256,
      'X-Work-Version': version.id,
      'X-Review-Run': reviewRunId || '',
      'Cache-Control': 'no-store',
    });
    res.end(out.buffer);
  },

  'GET /api/export-placement': async (req, res, url) => {
    const id = url.searchParams.get('id');
    const exportId = url.searchParams.get('exportId');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(exportId || '')) {
      return json(res, 400, { error: '导出记录身份无效' });
    }
    if (!await touchSession(id)) return json(res, 404, { error: '会话不存在' });
    const entry = listAudit({ sessionId: id, kind: 'export' }).find((item) =>
      item.provenance?.origin === 'server-export' && item.attributes?.receipt?.exportId === exportId);
    if (!entry) return json(res, 404, { error: '导出记录不存在或不属于该会话' });
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, entry.attributes.receipt);
  },

  'GET /api/export-working-docx': async (req, res, url) => {
    const s = await touchSession(url.searchParams.get('id'));
    if (!s) return json(res, 404, { error: '会话不存在，请重新导入稿件' });
    const safe = (s.name || 'manuscript').replace(/[\\/:*?"<>|]/g, '_').replace(/\.docx?$/i, '');
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="working.docx"; filename*=UTF-8''${encodeURIComponent(`${safe}_当前稿.docx`)}`,
      'Content-Length': s.buffer.length,
      'X-Work-Version': s.workVersion.id,
      'X-Content-SHA256': s.workVersion.sha256,
      'Cache-Control': 'no-store',
    });
    res.end(s.buffer);
  },

  'POST /api/ask': async (req, res) => {
    const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}');
    const s = await touchSession(body.id);
    if (!s) return json(res, 404, { error: '会话不存在' });

    // useModel === false 时走「规则库直答」：不调模型，直接从本次审阅结果里
    // 归纳回答。此前该分支被忽略，任何追问都会调用模型，单次中位耗时 11 秒，
    // 页面上的快速问答因此长期卡顿。
    if (body.useModel === false) {
      return json(res, 200, { answer: ruleBasedAnswer(s, body.question || ''), usage: null, mode: 'rules' });
    }

    const { text, usage } = await arkChat({
      model: body.model || DEFAULT_MODEL,
      question: body.question || '',
      context: body.context || '',
    });
    json(res, 200, { answer: text, usage });
  },

  /** 一键导出「建议稿」：把可自动修复的格式问题应用到副本上 */
  'POST /api/undo-fixes': async (req, res) => moveFixHistory(req, res, 'undo'),
  'POST /api/redo-fixes': async (req, res) => moveFixHistory(req, res, 'redo'),

  'POST /api/apply-fixes': async (req, res) => {
    const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}');
    const s = await touchSession(body.id);
    if (!s) return json(res, 404, { error: '会话不存在' });
    const pending = pendingDuplicate(s, body, 'apply');
    if (pending) await pending;
    const gate = mutationGate(s, body, 'apply');
    if (gate?.replayed) return json(res, 200, mutationPayload(s, { replayed: true }));
    if (gate) return json(res, gate.status, gate);
    if (!currentResultAvailable(s)) return json(res, 409, { error: '本次审阅尚未完成，请重新审阅后再应用建议' });
    initializeFixHistory(s);
    rememberCompletedReview(s);
    const accepted = new Set(body.accepted || []);
    const skipped = [];
    const selected = [];
    const prior = s.appliedFixes || [];
    const sourceVersionId = s.resultVersionId || s.reviewVersionId || s.workVersion.id;
    const sourceProof = sessionReviewSource(s);
    for (const raw of s.result?.issues || []) {
      const itemKey = raw.issueKey || `${raw.ruleId}|${raw.location}|${raw.quote || ''}`;
      if (!accepted.has(itemKey)) continue;
      if (!sourceProof.verified) {
        skipped.push({ key: itemKey, ruleId: raw.ruleId, reasonCode: sourceProof.reason,
          reason: '审核版本的原文身份尚未验证，请重新审阅后修改' });
        continue;
      }
      const expanded = raw.occurrences?.length ? raw.occurrences.map((o) => ({
        ...raw,
        // An occurrence may belong to a different part; never inherit the parent's target.
        paragraphIndex: undefined, footnoteIndex: undefined, endnoteIndex: undefined, anchor: undefined, anchors: undefined,
        offset: undefined, pid: undefined, part: undefined, sourceXmlNodeId: undefined, sourceXmlParagraphOrdinal: undefined,
        ...o, autoFix: o.autoFix ? { ...o.autoFix } : raw.autoFix ? { ...raw.autoFix, offset: undefined } : undefined,
      })) : [raw];
      for (const [ordinal, it] of expanded.entries()) {
        if (it.needsRelocation || it.modelSourceResolution
          && !['resolved', 'document'].includes(it.modelSourceResolution.status)) {
          skipped.push({ key: itemKey, ruleId: it.ruleId, reasonCode: 'unresolved_model_source',
            reason: '此建议的原文位置尚未确认，修改未执行' });
          continue;
        }
        if (it.autoFix && it.autoFix.offset == null && it.offset != null) it.autoFix = { ...it.autoFix, offset: it.offset };
        if (!it.autoFix?.find) { skipped.push({ key: itemKey, ruleId: it.ruleId, reason: '该规则不支持自动改写' }); continue; }
        if ([it, it.autoFix].some(value => value.textView != null && value.textView !== 'after'
          || value.owner != null && !['after', 'application-paragraph-index'].includes(value.owner)
          || value.paragraphIndexOwner != null && value.paragraphIndexOwner !== 'application-paragraph-index'
          || value.offsetUnit != null && value.offsetUnit !== 'utf16')) {
          skipped.push({ key: itemKey, ruleId: it.ruleId, reasonCode: 'unsupported_source_contract',
            reason: '此建议的文本视图或位置单位尚不支持，需重新定位后修改' });
          continue;
        }
        const target = it.paragraphIndex !== undefined ? 'body'
          : it.footnoteIndex !== undefined ? 'footnote' : it.endnoteIndex !== undefined ? 'endnote' : null;
        const index = it.paragraphIndex ?? it.footnoteIndex ?? it.endnoteIndex;
        if (!target || !Number.isInteger(index)) { skipped.push({ key: itemKey, ruleId: it.ruleId, reason: '未定位到原文' }); continue; }
        const listKey = target === 'body' ? 'paragraphs' : target === 'footnote' ? 'footnotes' : 'endnotes';
        const sourceNode = sourceProof.doc[listKey]?.[index];
        const currentNode = s.doc[listKey]?.[index];
        if (!sourceNode || !currentNode || sourceNode.id !== currentNode.id
          || sourceNode.sourceXmlNodeId !== currentNode.sourceXmlNodeId) {
          skipped.push({ key: itemKey, ruleId: it.ruleId, reasonCode: 'source_node_changed', reason: '原文节点已变化，需重新定位后修改' });
          continue;
        }
        if ([it, it.autoFix].some(value => value.pid != null && value.pid !== sourceNode.id
          || value.noteId != null && (sourceNode.noteId == null || String(value.noteId) !== String(sourceNode.noteId))
          || value.part != null && String(value.part).replace(/^word\//, '') !== sourceNode.part
          || value.sourceXmlNodeId != null && value.sourceXmlNodeId !== sourceNode.sourceXmlNodeId
          || value.sourceXmlParagraphOrdinal != null && value.sourceXmlParagraphOrdinal !== sourceNode.sourceXmlParagraphOrdinal
          || value.sourcePackageSha256 != null && value.sourcePackageSha256 !== sourceProof.doc.sourcePackageSha256
          || value.workSha256 != null && value.workSha256 !== sourceProof.doc.sourcePackageSha256
          || value.sourceVersionId != null && value.sourceVersionId !== sourceVersionId)) {
          skipped.push({ key: itemKey, ruleId: it.ruleId, reasonCode: 'source_identity_mismatch', reason: '建议的原文身份不一致，需重新定位后修改' });
          continue;
        }
        let sourceOffset = it.autoFix.offset ?? it.offset;
        const sourceText = s.resultTexts?.[target]?.[index];
        if (typeof sourceText !== 'string') {
          skipped.push({ key: itemKey, ruleId: it.ruleId, reasonCode: 'missing_source_version', reason: '缺少审阅版本原文，请重新审阅' });
          continue;
        }
        if (sourceOffset == null) {
          sourceOffset = sourceText.indexOf(it.autoFix.find);
          if (sourceOffset < 0 || sourceText.indexOf(it.autoFix.find, sourceOffset + 1) >= 0) {
            skipped.push({ key: itemKey, ruleId: it.ruleId, reasonCode: 'ambiguous_source_range', reason: '原文缺失或存在多处，请明确位置后重新审阅' });
            continue;
          }
        }
        if (!Number.isInteger(sourceOffset) || sourceOffset < 0 || sourceOffset + it.autoFix.find.length > sourceText.length
          || sourceText.slice(sourceOffset, sourceOffset + it.autoFix.find.length) !== it.autoFix.find) {
          skipped.push({ key: itemKey, ruleId: it.ruleId, reasonCode: 'invalid_source_range', reason: '审阅位置与原文不一致，拒绝猜测修改' });
          continue;
        }
        const patchId = `p${sha256(JSON.stringify([sourceVersionId, itemKey, ordinal, target, index, sourceOffset, it.autoFix])).slice(0, 32)}`;
        if (prior.some((p) => p.patchId === patchId)) {
          skipped.push({ patchId, key: itemKey, ruleId: it.ruleId, reasonCode: 'already_applied', reason: '此处修改已应用' });
          continue;
        }
        const patch = {
          patchId, key: itemKey, ruleId: it.ruleId, location: it.location,
          target, index, sourceVersionId, sourceOffset,
          offset: sourceOffset, find: it.autoFix.find, replace: it.autoFix.replace ?? '',
          pid: currentNode.id, part: currentNode.part,
          sourceXmlNodeId: currentNode.sourceXmlNodeId, sourceXmlParagraphOrdinal: currentNode.sourceXmlParagraphOrdinal,
          sourcePackageSha256: s.workVersion.sha256, workSha256: s.workVersion.sha256,
          sourceReviewedPackageSha256: sourceProof.doc.sourcePackageSha256,
          textView: 'after', offsetUnit: 'utf16', paragraphIndexOwner: 'application-paragraph-index',
        };
        // Issue ranges belong to the reviewed version. Transform only through verified
        // edits from that same version, never by choosing a nearby repeated phrase.
        let conflict = false;
        if (Number.isInteger(sourceOffset)) {
          for (const previous of prior) {
            if (previous.sourceVersionId !== sourceVersionId || previous.target !== target || previous.index !== index || !Number.isInteger(previous.sourceOffset)) continue;
            const end = previous.sourceOffset + previous.find.length;
            if (end <= sourceOffset) patch.offset += previous.replace.length - previous.find.length;
            else if (previous.sourceOffset < sourceOffset + patch.find.length) conflict = true;
          }
        }
        if (conflict) skipped.push({ ...patch, reasonCode: 'previous_patch_overlap', reason: '此处与已应用修改重叠，请重新审阅' });
        else selected.push(patch);
      }
    }
    const finish = beginMutation(s, body, 'apply');
    try {
      const out = applyDocxPatches(s.buffer, selected);
      let applied = out.applied.map((patch) => ({ ...patch, before: patch.find, after: patch.replace }));
      skipped.push(...out.skipped);
      if (applied.length) {
        const nextDoc = parseDocxBuffer(out.buffer, s.name);
        // Historical editorial comments remain source evidence, separate from working bytes.
        nextDoc.originalCommentCount = s.doc.originalCommentCount;
        const version = await saveWorkingVersion({
          sessionId: s.id, name: s.name, buffer: out.buffer, originalBuffer: s.originalBuffer,
          parent: s.workVersion, patches: applied, operation: 'apply-fixes',
          revision: s.maxVersionRevision + 1,
        });
        applied = applied.map((p) => ({ ...p, fromVersionId: s.workVersion.id, toVersionId: version.id }));
        const candidate = { ...s, buffer: out.buffer, doc: nextDoc, workVersion: version, ...appendedFixState(s, version, applied) };
        candidate.clean = inspectWorkingClean(candidate);
        rememberCleanProof(candidate);
        recordMutationReceipt(candidate, body, 'apply');
        // Validate the response before publishing the in-memory version pointer.
        const payload = {
          applied, appliedFixes: completedFixKeys(candidate), appliedFixDetails: candidate.appliedFixes, skipped,
          doc: serializeDoc(nextDoc), workVersion: version,
          history: fixHistoryStatus(candidate),
          clean: candidate.clean, legacy: candidate.legacy || null,
          human: humanState(candidate), reviewRunId: effectiveReviewRunId(candidate),
          result: s.result ? serializeReview(s.result, nextDoc, candidate) : null,
        };
        JSON.stringify(payload);
        await persistSession(candidate);
        Object.assign(s, candidate);
        return json(res, 200, payload);
      }
      const candidate = { ...s };
      recordMutationReceipt(candidate, body, 'apply');
      const payload = mutationPayload(candidate, { applied, skipped });
      await persistSession(candidate);
      Object.assign(s, candidate);
      return json(res, 200, payload);
    } catch (err) {
      return json(res, 500, { error: `修改未提交：${err.message}`, workVersion: s.workVersion });
    } finally {
      finish();
    }
  },
};

/* ------------------------------------------------------------------ */
/*  规则执行状态                                                       */
/* ------------------------------------------------------------------ */

/**
 * 各引擎实际执行的规则编号。
 *
 * 这里**不再手写清单**，而是从 scanner-*.js 源码实时推导（见 src/implemented-rules.js）。
 * 手写清单会漂移，且已经漂移过三次：
 *   · FMTB-032 从未实现，却因 `detect.type === 'list'` 的回退分支被算成「自动检测」
 *   · FMTB-018 有实现，却因被写进手写清单/被排除而状态反复出错
 *   · LANG-001 / LANG-006 明明在跑，却漏登记
 * 推导式实现让「页面上显示的自动检测规则数」不可能再和真实实现脱节。
 */
const IMPLEMENTED = implementedRules();

/**
 * 标注每条规则的执行状态，避免把「只登记未实现」的规则也算成自动化能力。
 *   auto   —— 规则引擎自动检测（源码里有真实检查项）
 *   model  —— 交给模型做语义判断
 *   manual —— 需要在页面上人工复核（多为需结合语境的体例要求）
 *
 * 判断必须严格：格式体例规则里带 detect.patterns 的很多只是「描述用的例子」，
 * 扫描器并没有读取它们（例如 FMT-040、FMTB-010、FMTB-012 全文从未命中）。
 * 现在「是否实现」由 implementedRules() 从源码推导，不再手写，避免漂移。
 */
function withStatus(rule, group) {
  const type = rule.detect?.type;
  let status = 'manual';
  let statusNote = '需人工复核：须结合上下文判断，未做成自动检测';
  /**
   * 判据顺序很重要：**先看类型，再看有没有实现**。
   *
   * 原先是先 `ruleWillRun` 再判 type，于是「detect.type === 'model' 但源码里
   * 恰好也提到过这个规则号」的规则会被标成 `auto`（规则引擎自动检测）——
   * 而它实际上根本不在扫描器里跑，是交给模型判断的。
   * 目标点 11 的定性工作把 11 条格式规则改判为 model 之后，这个顺序问题
   * 会让「自动检测规则数」重新虚高，正好是 withStatus 当初要修的病。
   */
  if (type === 'model') {
    status = 'model';
    statusNote = rule.detect?.reclassifiedWhy
      ? `由模型做语义判断（原标为自动检测，经定性改判：${rule.detect.reclassifiedWhy.slice(0, 60)}…）`
      : '由模型做语义判断';
  } else if (ruleWillRun(rule, group)) {
    /**
     * 规则库里已经明确标注了「判据有效但在本语料上不可能触发」的，
     * 必须**保留库里的说法**，不能被这里统一覆盖成「规则引擎自动检测」。
     *
     * 踩过的坑：库里给 `FMTB-018` 写了 `status: 'auto-未触发'` +
     * 详细 statusNote（语料 `word/media/` 图片数为 0，永远无法触发），
     * 但 withStatus 无条件重算 status/statusNote，把它盖掉了 ——
     * 页面于是声称「规则引擎自动检测」，而实际全语料一次都没跑出过结果。
     * 这正是 withStatus 当初要修的那类「页面说谎」。
     */
    if (rule.status === 'auto-未触发') {
      status = 'auto-未触发';
      statusNote = rule.statusNote || '判据有效，但本语料上未触发';
    } else {
      status = 'auto';
      statusNote = '规则引擎自动检测';
    }
  } else {
    /**
     * manual：**分两种情况说清**，不能一句话盖掉。
     *
     * 原先这里无条件写死「需人工复核：须结合上下文判断，未做成自动检测」，
     * 于是两类**成因完全不同**的规则在页面上显示成同一句话：
     *   · **一直是 manual** 的（`reclassifiedFrom === 'manual'`）——
     *     本来就靠人判断，如「标题层级是否统一」；
     *   · **从 model 改判过来**的（`reclassifiedFrom === 'model'`）——
     *     曾经交给模型，实测零命中后改判，如 `FMTB-030`（语料没有图表）、
     *     `FMTB-038`（流程性提示、初审阶段本就不该改英文摘要）。
     * 审稿人看不出区别，也就分不清「技术上做不到」和「流程上不该做」。
     *
     * 这与 `model` 分支显示 `reclassifiedWhy` 是同一个道理：状态说明的价值
     * 就在于说清**为什么**，否则等于没说。
     */
    if (rule.detect?.reclassifiedFrom && rule.detect.reclassifiedFrom !== 'manual'
        && rule.detect.reclassifiedWhy) {
      statusNote = `需人工复核（原标为${rule.detect.reclassifiedFrom === 'model' ? '模型判断' : '自动检测'}，经定性改判：`
        + `${rule.detect.reclassifiedWhy.slice(0, 90)}${rule.detect.reclassifiedWhy.length > 90 ? '…' : ''}）`;
    } else {
      statusNote = '需人工复核：须结合上下文判断，未做成自动检测';
    }
  }
  return { ...rule, status, statusNote };
}

function summarizeStatus(fmt, lang, cit) {
  const all = [
    ...fmt.rules.map((r) => withStatus(r, 'format')),
    ...lang.rules.map((r) => withStatus(r, 'language')),
    ...cit.rules.map((r) => withStatus(r, 'citation')),
  ];
  const by = { auto: 0, model: 0, manual: 0, 'auto-未触发': 0 };
  for (const r of all) by[r.status] = (by[r.status] || 0) + 1;
  const dormant = by['auto-未触发'] || 0;
  return {
    total: all.length,
    auto: by.auto,
    model: by.model,
    manual: by.manual,
    dormant,
    note: `规则库共 ${all.length} 条：${by.auto} 条由规则引擎自动检测，`
      + `${by.model} 条交模型做语义判断，`
      + `${by.manual} 条需人工复核（未做成自动检测，仅作为审稿要点提示）`
      + (dormant ? `；另有 ${dormant} 条判据有效但本语料上不可能触发（已标注原因）` : '')
      + '。',
  };
}
/** 把审阅结果整理成前端需要的结构（同步与异步两条路径共用） */
function serializeReview(result, doc, session = null) {
  /**
   * 补齐锚点（需求 3/4/5）：给每条问题算出正文里的**确切区间**，
   * 供前端下划线高亮与点击跳转。
   *
   * 必须在这里做，而不是在扫描器里：模型类问题（`group:'model'`）的
   * `quote` 要拿**原文**反查偏移，而扫描器手上只有自己那一段文本；
   * 另外 `occurrences`（归并条目）也要展开成逐处锚点。
   */
  const view = { ...result, issues: structuredClone(result.issues) };
  for (const issue of view.issues) issue.issueKey ||= `${issue.ruleId}|${issue.location}|${issue.quote || ''}`;
  const sourceProof = session ? sessionReviewSource(session, doc) : { verified: true, doc };
  const sourceDoc = sourceProof.doc;
  const anchorStats = sourceDoc ? attachAnchors(view, sourceDoc) : null;
  if (session?.appliedFixes?.length) {
    view.issues = rebaseIssueAnchors(view.issues, { ...doc, sourceVersionId: session.workVersion?.id || null }, session.appliedFixes, session.resultVersionId || session.reviewVersionId);
    if (anchorStats) {
      for (const k of Object.keys(anchorStats)) anchorStats[k] = 0;
      for (const issue of view.issues) {
        anchorStats.issues += 1;
        anchorStats.marks += issue.anchors?.length || 0;
        const precision = issue.anchor?.precision || 'none';
        anchorStats[precision] = (anchorStats[precision] || 0) + 1;
        if (issue.anchors?.some(a => a.resolutionStatus === 'ambiguous')) anchorStats.ambiguous += 1;
        if (issue.needsRelocation || issue.anchors?.some(a => a.resolutionStatus === 'unmapped')) anchorStats.unmapped += 1;
      }
    }
  }
  if (!sourceProof.verified) for (const issue of view.issues) {
    issue.anchors = []; issue.anchor = null; issue.needsRelocation = true;
    issue.relocationReason = sourceProof.reason;
  }
  attachCommentAnchors(view, { ...doc, sourceVersionId: session?.workVersion?.id || doc.sourceVersionId || null });
  const reviewCoverage = buildReviewCoverage({ result,
    options: result.reviewOptions || session?.resultOptions || null,
    purpose: session?.purpose || result.reviewCoverage?.purpose || 'unknown',
    reviewedVersionId: session?.resultVersionId || session?.reviewVersionId || null,
    currentWorkVersionId: session?.workVersion?.id || null });
  return {
    reviewRunId: session ? effectiveReviewRunId(session) : null,
    reviewCoverage,
    completionStatus: result.completionStatus || reviewCoverage.executionStatus,
    purpose: reviewCoverage.purpose,
    human: session ? humanState(session) : null,
    clean: session?.clean || null,
    legacy: session?.legacy || null,
    summary: result.summary,
    issues: view.issues,
    anchorStats,
    sourceBinding: { verified: sourceProof.verified, reason: sourceProof.reason || null,
      versionId: session?.resultVersionId || session?.reviewVersionId || null,
      sourcePackageSha256: sourceDoc?.sourcePackageSha256 || null },
    meta: result.meta,
    model: result.model,
    ...(result.modelResolution?{modelResolution:result.modelResolution}:{}),
    generatedAt: result.generatedAt,
    usage: result.usage,
    usageBreakdown: result.usageBreakdown || null,
    execution:projectExecutionSummary(result.execution),
    // Retained legacy rule threshold data; readers label it as a rule reference.
    verdict: result.verdict || null,
    // 计入模型复核结论后的合格性判定（E2，默认关）：仅作参考，不覆盖主判定。
    verdictModel: result.verdictModel || null,
    // 模型复核（目标点 13）：Map 不能直接 JSON 序列化，转成普通对象
    recheck: result.recheck
      ? {
        stats: result.recheck.stats,
        usage: result.recheck.usage || null,
        errors: result.recheck.errors || [],
        byKey: Object.fromEntries(result.recheck.byKey || []),
      }
      : null,
    deterministic: {
      format: result.deterministic.format.summary,
      language: result.deterministic.language.summary,
      citation: result.deterministic.citation.summary,
      info: [
        ...result.deterministic.format.info,
        ...result.deterministic.language.info,
        ...result.deterministic.citation.info,
      ],
    },
    modelErrors: result.modelResult?.errors || [],
    /**
     * 模型**越界引用**的规则号（目标点 12/13）。
     *
     * 模型偶尔会报出规则库里真实存在、但本次并没交给它的规则号
     * （实测 `LANG-017`/`LANG-018`/`LANG-020`/`LANG-015`/`FMT-024`）。
     * 这些号的 status 是 `auto`，规则引擎本身没报过 —— 若不拦下来，
     * 规则管理页会把「模型凭印象引用的规则」显示成「这条规则真的命中了」。
     * 拦下来之后仍要透出，否则问题从「显示错」变成「看不见」。
     */
    modelOutOfScopeRules: result.modelResult?.outOfScopeRuleIds || [],
  };
}
function projectExecutionSummary(execution){
  if(!execution)return null;
  const requests=execution.requests||{},plan=execution.plan;
  return{schemaVersion:1,requests:{poolId:requests.poolId||null,policy:requests.policy||null,
    attemptCount:requests.attemptCount??null,physicalSendCount:requests.physicalSendCount??null,
    counts:requests.counts||null,usageTotals:requests.usageTotals||null,knownFieldCounts:requests.knownFieldCounts||null,
    unknownUsageAttempts:requests.unknownUsageAttempts??null,blockedUnknownCount:requests.blockedUnknownCount??null},
    plan:plan?{planId:plan.planId,jobRunId:plan.jobRunId,fromRunId:plan.fromRunId||null,planFingerprint:plan.planFingerprint,
      sourceBinding:plan.identity?.binding||null,total:plan.total,completed:plan.completed,partial:plan.partial,failed:plan.failed,
      unknownSent:plan.unknownSent,pending:plan.pending,reused:plan.reused,logicalTaskCount:plan.logicalTaskCount,
      sourceCoverageGaps:plan.sourceCoverageGaps||[],qualityStatus:'unverified'}:null};
}

/**
 * 规则库直答：不调用模型，直接从本次审阅结果归纳答案。
 * 用于「快速问答」模式，让页面上的追问立刻有回应，同时避免无谓的模型开销。
 */
function ruleBasedAnswer(session, question) {
  const issues = session.result?.issues || [];
  const summary = session.result?.summary || {};
  if (!issues.length) {
    return `本次审阅没有发现问题。\n\n稿件统计：${session.doc?.paragraphs?.length || 0} 个段落，`
      + `${session.doc?.footnotes?.length || 0} 条脚注，${session.doc?.stats?.chars || 0} 字。\n\n`
      + '如需从语义、论证层面进一步判断，请切换到「模型审阅」模式。';
  }
  const q = question || '';
  // 按问题里的关键词过滤，命不中就给总览
  const wantsFormat = /格式|体例|版式|标点|数字/.test(q);
  const wantsLanguage = /语言|语法|词汇|搭配|句子|表述/.test(q);
  const wantsCitation = /引文|注释|脚注|著录|文献/.test(q);
  const wantsFix = /修复|改写|怎么改|如何改|建议/.test(q);
  let pool = issues;
  let scope = '全部';
  if (wantsFormat || wantsLanguage || wantsCitation) {
    const groups = [];
    if (wantsFormat) groups.push('format');
    if (wantsLanguage) groups.push('language');
    if (wantsCitation) groups.push('citation');
    pool = issues.filter((x) => groups.includes(x.group));
    scope = groups.map((g) => ({ format: '格式体例', language: '语言词汇', citation: '引文注释' }[g])).join('、');
  }

  const byRule = {};
  for (const x of pool) (byRule[x.ruleId] = byRule[x.ruleId] || []).push(x);
  const top = Object.entries(byRule).sort((a, b) => b[1].length - a[1].length).slice(0, 6);

  const lines = [];
  lines.push(`**${scope}**共 ${pool.length} 条问题（全稿合计 ${issues.length} 条：格式 ${summary.format || 0} / 语言 ${summary.language || 0} / 引文 ${summary.citation || 0}）。`);
  lines.push('');
  lines.push('按规则归并后最集中的几类：');
  lines.push('');
  for (const [id, list] of top) {
    const first = list[0];
    const fixable = list.filter((x) => x.autoFix?.find).length;
    lines.push(`- **${id}｜${first.title || first.category}**（${list.length} 处${fixable ? `，其中 ${fixable} 处可自动改写` : ''}）`);
    lines.push(`  - 依据：${first.basis || '—'}`);
    if (first.detail) lines.push(`  - 说明：${String(first.detail).slice(0, 90)}`);
    lines.push(`  - 例：${String(first.quote || '').slice(0, 70)}`);
    if (first.fix) lines.push(`  - 改法：${String(first.fix).slice(0, 80)}`);
  }
  if (wantsFix) {
    const fixable = pool.filter((x) => x.autoFix?.find && x.autoFix.find !== x.autoFix.replace);
    lines.push('');
    lines.push(`其中 **${fixable.length} 处**支持一键自动改写，可在左侧勾选后点「应用自动修复」。`);
    if (fixable.length) {
      lines.push('');
      lines.push('改写示例：');
      for (const x of fixable.slice(0, 5)) {
        lines.push(`- 「${String(x.autoFix.find).slice(0, 40)}」→「${String(x.autoFix.replace).slice(0, 40)}」`);
      }
    }
  }
  lines.push('');
  lines.push('> 这是规则库直答，不含模型判断。需要语义层面的分析请切到「模型审阅」模式。');
  return lines.join('\n');
}

/**
 * 静态资源的版本戳（用于 index.html 里的 `?v=` 缓存破坏）。
 *
 * 为什么需要：静态资源发的是 `Cache-Control: no-cache`，浏览器**会复用
 * 本地缓存**（没有 ETag 时不一定真正回源）。后果是改了 `app.js` /
 * `styles.css` 之后刷新页面，浏览器仍跑旧代码 —— 排查前端问题时
 * 会看到「明明改了却没生效」的假象，非常费时间。
 *
 * 实测踩到：给 `layout-check` 加 `?_=时间戳` 只破坏了 HTML 的缓存，
 * `<script src="/app.js">` 这个子资源仍走旧缓存，于是脚本量到的还是
 * 修复前的行为，报出「抽屉态设置控件消失」的假红。
 *
 * 做法：进程启动时按文件 mtime 生成版本号，注入到 index.html 的
 * `<script>` / `<link>` 上。**内容一变版本就变**，浏览器必然重新拉取；
 * 内容不变则版本不变，缓存照常生效。
 */
function assetVersion() {
  let stamp = 0;
  for (const f of ['app.js', 'styles.css']) {
    try { stamp = Math.max(stamp, statSync(join(PUBLIC_DIR, f)).mtimeMs); } catch { /* 文件缺失不致命 */ }
  }
  return String(Math.floor(stamp)).slice(-8) || '0';
}

async function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  p = p.replace(/\.\.+/g, '');
  // 允许 node_modules 路径
  if (p.startsWith('/node_modules/')) {
    const full = resolve(MODULES_DIR, '.' + p.slice('/node_modules'.length));
    if (!full.startsWith(MODULES_DIR)) { res.writeHead(403); return res.end('forbidden'); }
    try {
      const data = await readFile(full);
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); }
    return;
  }
  const full = resolve(PUBLIC_DIR, '.' + p);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    let data = await readFile(full);
    if (p === '/index.html') {
      const v = assetVersion();
      data = Buffer.from(
        data.toString('utf8')
          .replace(/(href|src)="(\/(?:app\.js|styles\.css))"/g, `$1="$2?v=${v}"`),
        'utf8',
      );
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

let ingestionRecovery = {state: 'starting', recovered: 0, pending: 0, errors: []};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;
  try {
    if (routes[key]) return await routes[key](req, res, url);
    if (req.method === 'GET') return await serveStatic(req, res, url);
    json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[error]', key, err);
    if (!res.headersSent) {
      // 明确拒绝必须带上机器可判别的 code 与池诊断，客户端才能区分
      // 「刷新重试无效」和「结果未知」两种完全不同的处置方式。
      const payload = { error: String(err.message || err) };
      for (const field of ['code', 'poolId', 'unknownSentCount', 'concurrency']) if (err[field] !== undefined) payload[field] = err[field];
      json(res, err.status || 500, payload);
    }
    else res.end();
  }
});

try {
  const recovered = await recoverIngestions({skipActive: true});
  ingestionRecovery = {state: 'done', recovered: recovered.filter((entry) => !entry.skippedTerminal && !entry.result?.skippedActive && entry.result?.record?.status === 'completed').length,
    alreadyCompleted: recovered.filter((entry) => entry.skippedTerminal && entry.result?.record?.status === 'completed').length,
    pending: recovered.filter((entry) => entry.result?.skippedActive || entry.error?.code === 'INGESTION_SOURCE_MISSING').length,
    errors: recovered.filter((entry) => entry.error && entry.error.code !== 'INGESTION_SOURCE_MISSING').map((entry) => ({id: entry.ingestionId, ...entry.error}))};
} catch (error) { ingestionRecovery = {state: 'error', recovered: 0, pending: null, errors: [{code: error.code || 'INGESTION_RECOVERY_FAILED', message: error.message}]}; }

try{
  reviewService=await createServerReviewService({getSession:touchSession,persistSession,
    adoptSession:s=>{sessions.set(s.id,s);evictSessions();},serializeDoc,serializeReview,humanState,
    cleanGate:cleanReviewGate,reviewTexts,defaultModel:DEFAULT_MODEL,
    onError:(error,context)=>console.error('[review-task]',context?.phase||'',String(error.message||error))});
  reviewRecovery={state:'done',error:null};
}catch(error){reviewRecovery={state:'error',error:{code:error.code||'REVIEW_RECOVERY_FAILED',message:error.message}};console.error('[review-startup]',error);}

server.listen(PORT, HOST, () => {
  console.log(`《东方学刊》审稿智能体已启动`);
  console.log(`  地址：http://${HOST}:${PORT}`);
  console.log(`  规则：格式 ${loadFormatRules().rules.length} 条 / 语言 ${loadLanguageRules().rules.length} 条 / 引文 ${loadCitationRules().rules.length} 条`);
  console.log(`  模型：${DEFAULT_MODEL}（${arkConfigured() ? '已配置 API Key' : '未配置，仅本地规则可用'}）`);
});
