/**
 * 回归测试：中止审阅造成的未知发送，必须能在应用内被核对并人工释放。
 *
 * 复现的真实缺陷（2026-10-13）：用户点「中止」会让在途请求变成 ARK_ATTEMPT_UNKNOWN_SENT，
 * 各占 1 个并发名额；并发为 2 时两笔就把池子占满，之后所有模型审阅被 409 拒绝，
 * 而错误信息让用户「先核对请求记录」时，应用里根本没有查看/处置这些记录的入口。
 *
 * 本测试用「永不响应的本地模型端点」稳定制造在途请求，全程不产生真实调用：
 *   1) 核对视图能列出未知请求，并标明其所属审阅已被中止
 *   2) 授权语句不逐字一致、目标状态已变化 → 一律拒绝（失败关闭）
 *   3) 逐字确认后释放名额，原始回执保持 unknown_sent 不变，授权证据落盘可校验
 *   4) 释放后同一稿件能重新提交审阅（不再是 409 死锁）
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { writeZip } from '../src/zip-write.js';

const SOURCE = resolve(import.meta.dirname, '..');
const PORT = 3305;
const POOL = 'abandon-http-fixture';
const SANDBOX = join(tmpdir(), 'dsh-ark-abandon-' + randomUUID().slice(0, 8));
const ACK = '我确认放弃这些未知结果，允许重新审核';
const MODEL = 'software-hang-model';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha = (value) => createHash('sha256').update(value).digest('hex');

const checks = [];
function ok(condition, label) {
  checks.push({ label, pass: !!condition });
  console.log(`${condition ? '  ✓' : '  ✗'} ${label}`);
  if (!condition) process.exitCode = 1;
}
async function until(label, probe, { timeoutMs = 60000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`超时：${label}`);
    await sleep(intervalMs);
  }
}

/** 永不响应的模型端点：稳定制造「已物理发出但拿不到响应」的在途请求。 */
const hangServer = createServer((req, res) => {
  req.resume();
  // 刻意不回应、不结束：请求停在 sending 状态，直到被中止打断。
  void res;
});
await new Promise((done) => hangServer.listen(0, '127.0.0.1', done));
const hangBase = `http://127.0.0.1:${hangServer.address().port}/api/v3`;

const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
function fixtureDocx() {
  // 约 4000 字，确保产生多个窗口；并发上限设为 1，故一笔在途即占满整个池子。
  const sentence = '国有企业建设基础设施遵循政治发展逻辑，民营与混合所有制企业参与市场竞争遵循经济发展逻辑，这种结构支撑了长期规划与市场竞争的结合。';
  const body = Array.from({ length: 12 }, (_, index) => para(`[段落${index + 1}] ${sentence}${sentence}${sentence}`)).join('');
  return writeZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>` },
  ]);
}

const roots = {
  sessions: join(SANDBOX, 'sessions'), versions: join(SANDBOX, 'versions'), workspaces: join(SANDBOX, 'workspaces'),
  audit: join(SANDBOX, 'audit'), legacy: join(SANDBOX, 'legacy'), ingestions: join(SANDBOX, 'ingestions'),
  jobs: join(SANDBOX, 'jobs'), plans: join(SANDBOX, 'plans'), execution: join(SANDBOX, 'execution'),
  reports: join(SANDBOX, 'reports'),
};
mkdirSync(SANDBOX, { recursive: true });
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ARK|DSH_|NODE_OPTIONS)/i.test(key))),
  HOST: '127.0.0.1', PORT: String(PORT), ARK_API_KEY: 'software-abandon-http-key', ARK_BASE_URL: hangBase, ARK_MODEL: MODEL,
  ARK_CONTEXT: '0', ARK_CASES: '0', ARK_CONSISTENCY: '0', ARK_PREFIX_CACHE: '0', DSH_REVIEW_WORKERS: '1',
  DSH_ARK_POOL_ID: POOL, DSH_ARK_POOL_CONCURRENCY: '1',
  DSH_SESSION_ROOT: roots.sessions, DSH_WORKING_VERSION_ROOT: roots.versions, DSH_WORKSPACE_ROOT: roots.workspaces,
  DSH_AUDIT_ROOT: roots.audit, DSH_LEGACY_ROOT: roots.legacy, DSH_INGESTION_ROOT: roots.ingestions,
  DSH_JOB_ROOT: roots.jobs, DSH_REVIEW_PLAN_ROOT: roots.plans, DSH_ARK_EXECUTION_ROOT: roots.execution,
  DSH_REPORTS_ROOT: roots.reports,
};
const app = spawn(process.execPath, [join(SOURCE, 'server.mjs')], { cwd: SOURCE, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let appLog = '';
app.stdout.on('data', (chunk) => { appLog += chunk; });
app.stderr.on('data', (chunk) => { appLog += chunk; });
const base = `http://127.0.0.1:${PORT}`;
const statePath = join(roots.execution, 'pools', POOL, 'state.json');
const readPool = () => JSON.parse(readFileSync(statePath, 'utf8')).state;
const countOf = (state, status) => Object.values(state.attempts).filter((row) => row.status === status).length;

async function api(path, options) {
  const response = await fetch(base + path, options);
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}
const jsonPost = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

try {
  console.log('=== 请求池人工释放 · HTTP 回归 ===');
  await until('服务启动', async () => (await api('/api/health')).data.ok === true);
  ok((await api('/api/health')).data.arkConfigured === true, '夹具已配置模型凭据（闸门会真正生效）');

  const before = await api('/api/review-requests');
  ok(before.status === 200 && before.data.unknownSentCount === 0 && before.data.blocked === false,
    '初始核对视图：无未知请求、未被拦截');

  const upload = await api(`/api/upload?name=abandon-${randomUUID().slice(0, 6)}.docx`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: fixtureDocx(),
  });
  ok(!!upload.data.id, '样稿导入成功');
  const sessionId = upload.data.id;

  const started = await jsonPost('/api/review', { id: sessionId, useModel: true, model: MODEL, async: true, ruleMode: 'all' });
  ok(started.status === 202 && !!started.data.reviewRunId, '模型审阅已受理（202）');
  const runId = started.data.reviewRunId;

  await until('出现物理在途请求', async () => {
    if (!existsSync(statePath)) return null;
    return countOf(readPool(), 'sending') > 0 ? true : null;
  }, { timeoutMs: 90000 });
  const inFlight = await until('在途请求占满并发', async () => {
    const state = readPool();
    const sending = countOf(state, 'sending');
    return sending >= 1 ? sending : null;
  }, { timeoutMs: 90000 });
  ok(inFlight >= 1, `中止前有 ${inFlight} 笔物理在途请求`);

  const cancel = await jsonPost('/api/cancel-review', { id: sessionId, reviewRunId: runId });
  ok(cancel.status === 200 && (cancel.data.cancelRequested || cancel.data.cancelled), '中止请求已被接受');
  // 该轮尚未进入终态时，异步重审会「附着」到同一任务（replayed），不会走请求池闸门；
  // 必须先等这一轮真正结束，才能验证「被占满 → 409」。
  await until('该轮审阅进入终态', async () => {
    const status = await api(`/api/review-status?id=${sessionId}&runId=${runId}`);
    return ['cancelled', 'interrupted', 'failed', 'completed', 'partial'].includes(status.data.status) ? true : null;
  }, { timeoutMs: 60000 });

  const blockedState = await until('在途请求转为未知发送', async () => {
    const state = readPool();
    return countOf(state, 'unknown_sent') >= 1 ? state : null;
  }, { timeoutMs: 90000 });
  ok(blockedState !== null, '中止让在途请求落为 unknown_sent（这就是把池子占满的根因）');

  const view = await until('核对视图列出未知请求', async () => {
    const seen = await api('/api/review-requests');
    return seen.data.unknownSentCount >= 1 ? seen.data : null;
  }, { timeoutMs: 30000 });
  ok(view.blocked === true && view.blockedUnknownCount >= view.concurrency, '核对视图：已被未知发送占满');
  ok(view.unknowns.every((row) => row.id && row.model === MODEL && row.jobRunId === runId && row.runCancelled === true),
    '核对视图逐笔给出来源，并标明所属审阅已被中止');

  const blockedStart = await jsonPost('/api/review', { id: sessionId, useModel: true, model: MODEL, async: true, ruleMode: 'all' });
  ok(blockedStart.status === 409 && blockedStart.data.code === 'ARK_EXECUTION_BLOCKED',
    `被占满时重新审阅得到 409 ARK_EXECUTION_BLOCKED（实际 ${blockedStart.status} ${blockedStart.data.code || blockedStart.data.accepted || ''} ${blockedStart.data.error || ''}）`);

  const noAck = await jsonPost('/api/review-requests/abandon', { attemptIds: view.unknowns.map((row) => row.id) });
  ok(noAck.status === 400 && noAck.data.code === 'ARK_ABANDON_ACKNOWLEDGE_REQUIRED', '缺逐字授权语句 → 400 拒绝');
  const wrongAck = await jsonPost('/api/review-requests/abandon', { attemptIds: view.unknowns.map((row) => row.id), acknowledge: '好' });
  ok(wrongAck.status === 400 && wrongAck.data.code === 'ARK_ABANDON_ACKNOWLEDGE_REQUIRED', '授权语句不逐字一致 → 400 拒绝');
  const extra = await jsonPost('/api/review-requests/abandon', { attemptIds: view.unknowns.map((row) => row.id), acknowledge: ACK, note: '多余的授权说明' });
  ok(extra.status === 400 && extra.data.code === 'ARK_ABANDON_INPUT_INVALID', '携带多余字段的授权请求 → 400 拒绝');
  const stale = await jsonPost('/api/review-requests/abandon', { attemptIds: ['a' + '0'.repeat(32)], acknowledge: ACK });
  ok(stale.status === 409 && stale.data.code === 'ARK_ABANDON_TARGET_CHANGED', '目标不是未知发送 → 409 失败关闭，不放行');
  ok((await api('/api/review-requests')).data.blocked === true, '以上失败尝试都没有动过名额');

  const receiptsBefore = Object.fromEntries(view.unknowns.map((row) =>
    [row.id, sha(readFileSync(join(roots.execution, 'pools', POOL, 'attempts', row.id, 'receipt.json')))]));
  const released = await jsonPost('/api/review-requests/abandon', { attemptIds: view.unknowns.map((row) => row.id), acknowledge: ACK });
  ok(released.status === 200 && released.data.ok === true && released.data.automaticRetryAllowed === false,
    '逐字确认后释放名额，并明确「不自动重发」');
  ok(released.data.blockedUnknownCountAfter === 0 && released.data.remoteCompletion === 'unconfirmed',
    '释放后未知占位归零，远端完成情况仍记为未确认');
  ok(Array.isArray(released.data.abandoned) && released.data.abandoned.length === view.unknowns.length, '释放笔数与核对清单一致');
  const evidencePath = released.data.authorizationEvidenceFile;
  const evidenceOk = existsSync(evidencePath)
    && sha(readFileSync(evidencePath)) === released.data.authorizationEvidenceSha256
    && JSON.parse(readFileSync(evidencePath, 'utf8')).attemptIds.length === view.unknowns.length;
  ok(evidenceOk, '人工授权证据已落盘且摘要可校验');
  const receiptsKept = view.unknowns.every((row) =>
    sha(readFileSync(join(roots.execution, 'pools', POOL, 'attempts', row.id, 'receipt.json'))) === receiptsBefore[row.id]);
  ok(receiptsKept, '原始回执字节保持 unknown_sent 原样（不确认响应、不篡改证据）');
  const finalState = readPool();
  ok(countOf(finalState, 'abandoned') === view.unknowns.length && countOf(finalState, 'unknown_sent') === 0,
    '账本终态：未知发送 → abandoned，无残留占位');

  const afterRelease = await jsonPost('/api/review', { id: sessionId, useModel: true, model: MODEL, async: true, ruleMode: 'all' });
  ok(afterRelease.status === 202, '释放后同一稿件可重新提交审阅（不再死锁）');
  if (afterRelease.status === 202) await jsonPost('/api/cancel-review', { id: sessionId, reviewRunId: afterRelease.data.reviewRunId });

  const passed = checks.filter((row) => row.pass).length;
  console.log(`\n═══ 结果：${passed} 通过 / ${checks.length - passed} 失败 ═══`);
} catch (error) {
  console.log(`\n✗ 测试异常：${error.message}`);
  console.log(appLog.slice(-1200));
  process.exitCode = 1;
} finally {
  if (app.exitCode === null) { app.kill('SIGKILL'); await sleep(300); }
  await new Promise((done) => hangServer.close(done));
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
}
