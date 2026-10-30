/**
 * 回归测试：模型阶段必须让用户看见「在动」。
 *
 * 复现的真实问题（2026-10-13）：一份 119 段的稿件本轮共 17 个窗口，每个窗口要
 * 几十秒到两分钟，而进度只在**窗口返回后**才更新。开工后近 50 秒界面只有秒表在走，
 * 用户判断成「卡死」并点了中止 —— 中止打断了已发出的在途请求，那两笔一直占用
 * 模型名额，导致随后每次重新审阅都被 409 拒绝。
 *
 * 本测试用「按固定时长响应的本地模型端点」驱动真实的窗口阶段，全程不产生真实调用：
 *   1) 开工时先给出窗口总数、在途并发与预计时长（用户知道要等多久）
 *   2) 窗口阶段每 N 秒有一次心跳（用户知道还在动）
 *   3) 心跳回调不能把服务打挂（定时器里抛错会是未捕获异常）
 *   4) 每个窗口完成后照旧回报该窗口结果
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { writeZip } from '../src/zip-write.js';

const SOURCE = resolve(import.meta.dirname, '..');
const PORT = 3306;
const POOL = 'progress-http-fixture';
const SANDBOX = join(tmpdir(), 'dsh-ark-progress-' + randomUUID().slice(0, 8));
const MODEL = 'software-slow-model';
const WINDOW_MS = 3500;            // 每个窗口响应耗时：多个窗口串行，每条完成消息都可见
const HEARTBEAT_MS = 5000;
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
function ok(condition, label) {
  checks.push({ label, pass: !!condition });
  console.log(`${condition ? '  ✓' : '  ✗'} ${label}`);
  if (!condition) process.exitCode = 1;
}
async function until(label, probe, { timeoutMs = 60000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`超时：${label}`);
    await sleep(intervalMs);
  }
}

/** 慢速模型端点：每个窗口固定耗时 WINDOW_MS，期间心跳应当被触发。 */
let providerRequests = 0;
const provider = createServer(async (req, res) => {
  req.resume();
  providerRequests += 1;
  await sleep(req.url.includes('digest') ? 200 : WINDOW_MS);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'software-slow-' + providerRequests,
    output_text: JSON.stringify({ issues: [] }),
    usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16, input_tokens_details: { cached_tokens: 0 } },
  }));
});
await new Promise((done) => provider.listen(0, '127.0.0.1', done));
const providerBase = `http://127.0.0.1:${provider.address().port}/api/v3`;

const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
function fixtureDocx() {
  const sentence = '国有企业建设基础设施遵循政治发展逻辑，民营与混合所有制企业参与市场竞争遵循经济发展逻辑，这种结构支撑了长期规划与市场竞争的结合。';
  const body = Array.from({ length: 24 }, (_, index) => para(`[段落${index + 1}] ${sentence}${sentence}${sentence}`)).join('');
  return writeZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>` },
  ]);
}

const roots = Object.fromEntries(['sessions', 'versions', 'workspaces', 'audit', 'legacy', 'ingestions', 'jobs', 'plans', 'execution', 'reports']
  .map((key) => [key, join(SANDBOX, key)]));
mkdirSync(SANDBOX, { recursive: true });
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ARK|DSH_|NODE_OPTIONS)/i.test(key))),
  HOST: '127.0.0.1', PORT: String(PORT), ARK_API_KEY: 'software-progress-key', ARK_BASE_URL: providerBase, ARK_MODEL: MODEL,
  ARK_CONTEXT: '0', ARK_CASES: '0', ARK_CONSISTENCY: '0', ARK_PREFIX_CACHE: '0', DSH_REVIEW_WORKERS: '1',
  DSH_ARK_POOL_ID: POOL, DSH_ARK_POOL_CONCURRENCY: '1', ARK_PROGRESS_HEARTBEAT_MS: String(HEARTBEAT_MS),
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
const api = async (path, options) => {
  const response = await fetch(base + path, options);
  return { status: response.status, data: await response.json().catch(() => ({})) };
};
const jsonPost = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

try {
  console.log('=== 模型阶段可见进度 · HTTP 回归 ===');
  await until('服务启动', async () => (await api('/api/health')).data.ok === true);

  const upload = await api(`/api/upload?name=progress-${randomUUID().slice(0, 6)}.docx`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: fixtureDocx(),
  });
  ok(!!upload.data.id, '样稿导入成功');
  const sessionId = upload.data.id;

  const started = await jsonPost('/api/review', { id: sessionId, useModel: true, model: MODEL, async: true, ruleMode: 'all' });
  ok(started.status === 202 && !!started.data.reviewRunId, '模型审阅已受理（202）');
  const runId = started.data.reviewRunId;

  // 轮询用户界面看到的那个字段，收集出现过的进度文本
  const seen = [];
  let terminal = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const status = await api(`/api/review-status?id=${sessionId}&runId=${runId}`);
    const message = status.data.progress?.message;
    if (message && seen[seen.length - 1] !== message) seen.push(message);
    if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(status.data.status)) { terminal = status.data; break; }
    if (app.exitCode !== null) break;
    await sleep(300);
  }
  ok(!!terminal && ['completed', 'partial'].includes(terminal.status), `审阅正常结束（${terminal ? terminal.status : '未结束'}）`);
  for (const message of seen) console.log('    · ' + message);

  const startMessage = seen.find((text) => /分段审阅开始：共 \d+ 个窗口/.test(text));
  ok(!!startMessage, '开工时说明窗口总数、在途并发与预计时长');
  ok(!!startMessage && /同时最多 \d+ 个在途/.test(startMessage) && /预计需要 \d+–\d+ 分钟/.test(startMessage),
    '预计时长与并发数都明确给出');
  // 夹具的账户池并发是 1：窗口并发是 10，若直接报窗口并发就会说谎
  ok(!!startMessage && /同时最多 1 个在途（受本项目请求池并发上限 1 限制）/.test(startMessage),
    '在途并发按账户请求池真实上限报告，而不是窗口并发');
  ok(!!startMessage && /不必中止/.test(startMessage), '明确告知不必中止（中止会打断已发出的请求）');
  const heartbeats = seen.filter((text) => /模型审阅进行中：已完成 \d+\/\d+ 个窗口，在途 1 个，已用 [\d.]+ 分钟/.test(text));
  ok(heartbeats.length >= 3, `窗口阶段有持续心跳（本轮 ${heartbeats.length} 次）`);
  ok(seen.some((text) => /第 \d+ 段审阅完成，发现 \d+ 条/.test(text)), '每个窗口完成后照旧回报结果');

  // 心跳是定时器回调：它抛错会是未捕获异常，必须确认服务没有被打挂
  ok(app.exitCode === null, '心跳期间服务进程一直存活');
  ok(!/Unhandled|uncaught|UnhandledPromiseRejection/i.test(appLog), '服务日志没有未捕获异常');
  ok((await api('/api/health')).data.ok === true, '结束后 /api/health 仍正常');

  // 心跳不能盖掉终态：终态之后不应再出现「进行中」
  const lastMessage = seen[seen.length - 1] || '';
  ok(!/模型审阅进行中/.test(lastMessage) || terminal?.status === 'running', '心跳不会盖掉终态提示');
} catch (error) {
  ok(false, `测试异常：${String(error?.message || error)}`);
} finally {
  app.kill();
  provider.close();
  await sleep(300);
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

const failed = checks.filter((row) => !row.pass).length;
console.log(`\n═══ 结果：${checks.length - failed} 通过 / ${failed} 失败 ═══`);
process.exitCode = failed ? 1 : 0;
