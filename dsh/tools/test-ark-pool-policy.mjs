/**
 * 回归测试：账户池并发上限的留痕变更，以及「上限提高后一次中止不再堵死整个池」。
 *
 * 复现的真实问题（2026-10-13）：上限为 2，用户在模型审阅途中点「中止」，两笔已发出的
 * 请求被打断成 unknown_sent 并一直占用名额 —— 之后每次重新审阅都被
 * ARK_EXECUTION_BLOCKED 拒绝，刷新重试无效，连续 4 次。
 *
 * 本测试全程使用进程内合成传输（无网络、无真实模型调用），落在临时隔离根目录：
 *   1) 默认上限 2，且只有留痕通道能改
 *   2) 参数/授权证据/版本边界不合法一律拒绝
 *   3) 有请求在途或排队时拒绝变更
 *   4) 变更成功后上限真的放开（8 笔并发 → 最多 6 笔同时在途）
 *   5) 2 笔未知占位 + 上限 6 时仍能继续发送（安全阀生效）
 *   6) 静默改回（env 或 policy 参数）仍被 ARK_POLICY_CONFLICT 挡住
 *   7) 手改账本上限字段或篡改事件文件会在读取时被抓成 ARK_POLICY_CORRUPT
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as store from '../src/ark-execution-store.js';

const POOL = 'policy-fixture';
const SANDBOX = join(tmpdir(), 'dsh-ark-policy-' + randomUUID().slice(0, 8));
const STORAGE = join(SANDBOX, 'ark');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const STATEMENT = '我确认变更本项目 Ark 请求并发上限';
const knownUsage = { input_tokens: 11, output_tokens: 3, total_tokens: 14 };
const payload = () => JSON.stringify({ id: 'provider-response-local', output_text: 'policy fixture only', usage: knownUsage });
delete process.env.DSH_ARK_POOL_CONCURRENCY;

const checks = [];
function ok(condition, label) {
  checks.push({ label, pass: !!condition });
  console.log(`${condition ? '  ✓' : '  ✗'} ${label}`);
  if (!condition) process.exitCode = 1;
}
const codeOf = (error) => error?.code || String(error?.message || error);
async function rejects(label, action, expected) {
  const error = await action().catch((caught) => caught);
  ok(error instanceof Error && error.code === expected, `${label}（期望 ${expected}，实际 ${codeOf(error)}）`);
}

function fixture(tag, concurrency = 2) {
  const base = { storageRoot: STORAGE, poolId: `${POOL}-${tag}` };
  const roots = { ...base, policy: { concurrency } };
  return roots;
}
const ledger = (roots) => join(roots.storageRoot, 'pools', roots.poolId, 'state.json');
const readLedger = (roots) => { const raw = readFileSync(ledger(roots)); const wrapped = JSON.parse(raw.toString('utf8')); return { raw, wrapped, revision: wrapped.state.revision, sha256: sha(raw) }; };
async function change(roots, concurrency, { reason = '回归测试夹具', operationId = randomUUID(), authorization } = {}) {
  const current = readLedger(roots);
  return store.setArkPoolConcurrency({ ...roots, policy: { concurrency, reason }, operationId,
    expectedRevision: current.revision, expectedLedgerSha256: current.sha256,
    humanAuthorization: authorization || { schemaVersion: 1, actorType: 'human', statement: STATEMENT, evidenceRef: 'reports/fixture.json', evidenceSha256: sha('fixture') } });
}
function execute(roots, tag, overrides = {}) {
  return store.executeArkAttempt({ ...roots, body: { model: `software-${tag}`, input: [{ role: 'user', content: `policy ${tag}` }], stream: false },
    scope: { jobRunId: `run-${tag}`, sessionId: `s${tag}`, stage: 'window', unitId: `unit-${tag}` }, logicalRequestId: `logical-${tag}`,
    transport: async () => new Response(payload(), { headers: { 'content-type': 'application/json' } }),
    consumeResponse: (response) => response.json(), ...overrides });
}

try {
  mkdirSync(SANDBOX, { recursive: true });
  console.log('=== 账户池并发上限留痕变更 · 回归 ===');

  const main = fixture('main');
  const initialized = await store.initializeArkExecutionStore(main);
  ok(initialized.policy.concurrency === 2, '默认上限为 2');

  await rejects('拒绝超过 32 的上限', () => change(main, 33), 'ARK_POLICY_CHANGE_INVALID');
  await rejects('拒绝非整数上限', () => change(main, 2.5), 'ARK_POLICY_CHANGE_INVALID');
  await rejects('缺少变更理由', () => change(main, 6, { reason: '   ' }), 'ARK_POLICY_CHANGE_INVALID');
  const stale = readLedger(main);
  await rejects('缺少稳定账本版本', () => store.setArkPoolConcurrency({ ...main, policy: { concurrency: 6, reason: 'x' }, operationId: randomUUID(),
    expectedRevision: stale.revision, expectedLedgerSha256: 'f'.repeat(64),
    humanAuthorization: { schemaVersion: 1, actorType: 'human', statement: STATEMENT, evidenceRef: 'r.json', evidenceSha256: sha('x') } }), 'ARK_POLICY_CHANGE_STALE');
  await rejects('授权语句不匹配', () => change(main, 6, { authorization: { schemaVersion: 1, actorType: 'human', statement: '随便改一下', evidenceRef: 'r.json', evidenceSha256: sha('x') } }),
    'ARK_HUMAN_AUTHORIZATION_INVALID');
  await rejects('缺少授权证据摘要', () => change(main, 6, { authorization: { schemaVersion: 1, actorType: 'human', statement: STATEMENT, evidenceRef: 'r.json', evidenceSha256: 'abc' } }),
    'ARK_HUMAN_AUTHORIZATION_INVALID');
  ok(readLedger(main).wrapped.state.policy.concurrency === 2, '以上失败都没有改动账本上限');

  // 在途请求期间必须拒绝变更
  let releaseHeld;
  const held = new Promise((done) => { releaseHeld = done; });
  let heldSending = false;
  const holding = execute(main, 'held', {
    transport: async () => { heldSending = true; await held; return new Response(payload(), { headers: { 'content-type': 'application/json' } }); },
  });
  for (let i = 0; i < 200 && !heldSending; i += 1) await sleep(20);
  await rejects('有请求在途时拒绝变更上限', () => change(main, 6), 'ARK_POLICY_CHANGE_BUSY');
  releaseHeld();
  ok((await holding).receipt.status === 'confirmed', '在途请求正常结束（上限未被中途改动）');

  const applied = await change(main, 6);
  ok(applied.replayed === false && applied.previousConcurrency === 2 && applied.concurrency === 6, '留痕变更 2 → 6 成功');
  const after = await store.readArkExecutionSummary(main);
  ok(after.policy.concurrency === 6, '账本生效上限变为 6');
  ok(JSON.parse(readFileSync(join(STORAGE, 'pools', main.poolId, applied.event.eventFile), 'utf8')).afterConcurrency === 6, '留下不可变变更事件');
  ok(after.revision === applied.revision, '变更是一次原子提交（修订一致）');
  await rejects('目标与当前一致时拒绝重复变更', () => change(main, 6), 'ARK_POLICY_CHANGE_INVALID');
  await rejects('缺少账本版本时安全失败', () => store.setArkPoolConcurrency({ ...main, policy: { concurrency: 7, reason: 'x' }, operationId: randomUUID(),
    expectedRevision: stale.revision + 9999, expectedLedgerSha256: sha('nope'),
    humanAuthorization: { schemaVersion: 1, actorType: 'human', statement: STATEMENT, evidenceRef: 'r.json', evidenceSha256: sha('x') } }), 'ARK_POLICY_CHANGE_STALE');

  // 静默改回仍被挡住
  const noPolicy = { storageRoot: main.storageRoot, poolId: main.poolId };
  ok((await store.initializeArkExecutionStore(noPolicy)).policy.concurrency === 6, '不带策略参数时读到已登记的上限 6');
  await rejects('policy 参数静默改回被拒', () => store.initializeArkExecutionStore({ ...noPolicy, policy: { concurrency: 2 } }), 'ARK_POLICY_CONFLICT');
  process.env.DSH_ARK_POOL_CONCURRENCY = '2';
  await rejects('环境变量静默改回被拒', () => store.initializeArkExecutionStore(noPolicy), 'ARK_POLICY_CONFLICT');
  delete process.env.DSH_ARK_POOL_CONCURRENCY;

  // 上限真的放开：8 笔并发 → 最多 6 笔同时在途（传输端刻意持有足够久，让 6 个名额都被占住）
  const gate = fixture('gate');
  await store.initializeArkExecutionStore(gate);
  await change(gate, 6);
  const bare = { storageRoot: gate.storageRoot, poolId: gate.poolId };
  let inFlight = 0, peak = 0;
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => execute(bare, `gate${index}`, {
    transport: async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await sleep(1500);
      inFlight -= 1;
      return new Response(payload(), { headers: { 'content-type': 'application/json' } });
    },
  })));
  ok(peak === 6, `并发上限真的放开到 6（8 笔并发时峰值在途 ${peak}）`);
  ok(results.every((row) => row.receipt.status === 'confirmed'), '8 笔请求全部正常完成');
  const gateSummary = await store.readArkExecutionSummary(bare);
  ok(gateSummary.activeCount === 0 && gateSummary.blockedUnknownCount === 0, '结束后池内无占位、未阻塞');

  // 安全阀：2 笔未知占位 + 上限 6 → 仍能继续发送
  const valve = fixture('valve');
  await store.initializeArkExecutionStore(valve);
  await change(valve, 6);
  const valveRoots = { storageRoot: valve.storageRoot, poolId: valve.poolId };
  let unknown = 0;
  for (const tag of ['unknown1', 'unknown2']) {
    const error = await execute(valveRoots, tag, { transport: async () => { unknown += 1; throw new DOMException('software aborted transport', 'AbortError'); } }).catch((caught) => caught);
    ok(error?.code === 'ARK_ATTEMPT_UNKNOWN_SENT', `${tag} 记为未知发送（未取回响应）`);
  }
  ok(unknown === 2, '两笔未知都物理发出过一次');
  const valveSummary = await store.readArkExecutionSummary(valveRoots);
  ok(valveSummary.blockedUnknownCount === 2 && valveSummary.counts.unknown_sent === 2 && valveSummary.policy.concurrency === 6,
    `2 笔未知不再堵死整个池（未知占位 ${valveSummary.blockedUnknownCount} / 上限 ${valveSummary.policy.concurrency}）`);
  const resumed = await execute(valveRoots, 'after-unknown');
  ok(resumed.receipt.status === 'confirmed', '有 2 笔未知占位时仍能继续执行新请求');

  // 上限 2 的老行为对照：两笔未知即阻塞
  const narrow = fixture('narrow', 2);
  await store.initializeArkExecutionStore(narrow);
  const narrowRoots = { storageRoot: narrow.storageRoot, poolId: narrow.poolId };
  for (const tag of ['n1', 'n2']) await execute(narrowRoots, tag, { transport: async () => { throw new DOMException('software aborted transport', 'AbortError'); } }).catch(() => {});
  const blocked = await execute(narrowRoots, 'n3').catch((caught) => caught);
  ok(blocked?.code === 'ARK_EXECUTION_BLOCKED', '上限 2 时同样的两笔未知仍会阻塞（这就是本次要修的行为）');

  // 篡改检测：手改账本上限字段
  const tamper = fixture('tamper');
  await store.initializeArkExecutionStore(tamper);
  await change(tamper, 6);
  const tamperFile = ledger(tamper);
  const wrapped = JSON.parse(readFileSync(tamperFile, 'utf8'));
  wrapped.state.policy.concurrency = 9;
  wrapped.sha256 = sha(JSON.stringify(wrapped.state));
  writeFileSync(tamperFile, JSON.stringify(wrapped) + '\n');
  await rejects('手改账本上限字段被读取时发现', () => store.readArkExecutionSummary({ storageRoot: tamper.storageRoot, poolId: tamper.poolId }), 'ARK_POLICY_CORRUPT');

  // 篡改检测：改动事件文件内容
  const forged = fixture('forged');
  await store.initializeArkExecutionStore(forged);
  const changed = await change(forged, 6);
  const eventFile = join(STORAGE, 'pools', forged.poolId, changed.event.eventFile);
  const event = JSON.parse(readFileSync(eventFile, 'utf8'));
  event.afterConcurrency = 9;
  writeFileSync(eventFile, JSON.stringify(event) + '\n');
  await rejects('篡改变更事件被读取时发现', () => store.readArkExecutionSummary({ storageRoot: forged.storageRoot, poolId: forged.poolId }), 'ARK_POLICY_CORRUPT');

  // 幂等：同一个操作的完整请求（含同一版本边界）重复提交返回 replayed，且不再改版本
  const replay = fixture('replay');
  await store.initializeArkExecutionStore(replay);
  const snapshot = readLedger(replay);
  const operationId = randomUUID();
  const request = { ...replay, policy: { concurrency: 6, reason: '回归测试夹具' }, operationId,
    expectedRevision: snapshot.revision, expectedLedgerSha256: snapshot.sha256,
    humanAuthorization: { schemaVersion: 1, actorType: 'human', statement: STATEMENT, evidenceRef: 'reports/fixture.json', evidenceSha256: sha('fixture') } };
  const first = await store.setArkPoolConcurrency(request);
  const second = await store.setArkPoolConcurrency(request);
  ok(second.replayed === true && second.revision === first.revision, '同一操作重复提交幂等（replayed、修订不变）');
  await rejects('同一 operationId 换请求被拒', () => change(replay, 7, { operationId }), 'ARK_POLICY_CHANGE_OPERATION_CONFLICT');
} catch (error) {
  ok(false, `测试异常：${String(error?.stack || error)}`);
} finally {
  await sleep(200);
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

const failed = checks.filter((row) => !row.pass).length;
console.log(`\n═══ 结果：${checks.length - failed} 通过 / ${failed} 失败 ═══`);
process.exitCode = failed ? 1 : 0;
