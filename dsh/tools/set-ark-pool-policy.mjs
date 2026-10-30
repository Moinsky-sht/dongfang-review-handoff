/**
 * 变更本项目 Ark 账户池的请求并发上限（留痕操作，唯一通道）。
 *
 * 用法：
 *   node tools/set-ark-pool-policy.mjs --concurrency=6 --reason="..." --authorization-quote="..."
 *
 * 为什么要有这个工具：**不要**手改 state.json 里的 policy，也不要用
 * DSH_ARK_POOL_CONCURRENCY 覆盖已登记的值（后者会被 ARK_POLICY_CONFLICT 挡住）。
 * 这个工具会写一份不可变证据文件 + 一份不可变变更事件，并在同一次加锁提交里
 * 更新账本；读取时若发现「账本里的上限」和「最后一次留痕变更」不一致，会直接报
 * ARK_POLICY_CORRUPT。变更前要求池内没有任何在途或排队请求。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArkExecutionSummary, setArkPoolConcurrency } from '../src/ark-execution-store.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE = resolve(flag('storage-root') || process.env.DSH_ARK_EXECUTION_ROOT || join(PROJECT, 'data/ark-executions'));
const POOL = flag('pool-id') || process.env.DSH_ARK_POOL_ID || 'project-account';
const REPORTS = resolve(flag('reports-root') || process.env.DSH_REPORTS_ROOT || join(PROJECT, 'reports'));
const concurrency = Number(flag('concurrency'));
const reason = flag('reason') || '';
const quote = flag('authorization-quote') || '';
const STATEMENT = '我确认变更本项目 Ark 请求并发上限';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const statePath = join(STORAGE, 'pools', POOL, 'state.json');

if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('--concurrency 必须是 1–32 的整数');
if (!reason.trim()) throw new Error('必须用 --reason 说明变更理由（会写进不可变事件）');
if (!quote.trim()) throw new Error('必须用 --authorization-quote 记录真人授权原话（会写进证据文件）');
if (!existsSync(statePath)) throw new Error(`账户池账本不存在：${statePath}`);

const before = await readArkExecutionSummary({ storageRoot: STORAGE, poolId: POOL });
if (!before.initialized) throw new Error('账户池尚未初始化');
const inFlight = (before.attempts || []).filter((row) => row.status === 'sending' || row.status === 'queued').length;
if (inFlight) throw new Error(`池内仍有 ${inFlight} 笔在途/排队请求，先等它们结束再变更上限`);
if (before.policy?.concurrency === concurrency) { console.log(JSON.stringify({ status: 'unchanged', concurrency }, null, 2)); process.exit(0); }

mkdirSync(REPORTS, { recursive: true });
const evidenceRef = `ark-pool-policy-change-${Date.now()}.json`;
const evidence = {
  schemaVersion: 1, kind: 'human-authorization-evidence',
  authorizedBy: '稿件负责人（本机操作者直接指令）',
  authorizedAt: new Date().toISOString(),
  authorizationQuote: quote.trim(),
  statement: STATEMENT,
  poolId: POOL,
  requestedConcurrency: concurrency,
  previousConcurrency: before.policy?.concurrency ?? null,
  reason: reason.trim(),
  evidence: { unknownSentCount: before.unknownSentCount ?? null, activeCount: before.activeCount ?? null, physicalSendCount: before.physicalSendCount ?? null },
};
writeFileSync(join(REPORTS, evidenceRef), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
const evidenceSha256 = sha(readFileSync(join(REPORTS, evidenceRef)));

let result, lastError;
for (let round = 0; round < 8 && !result; round += 1) {
  const raw = readFileSync(statePath);
  const wrapped = JSON.parse(raw.toString('utf8'));
  // 留痕事件与账本必须在同一次提交里对齐：这里用「当前字节 + 当前版本」做 CAS，
  // 期间任何其他写入都会让本次操作以 ARK_POLICY_CHANGE_STALE 安全失败。
  try {
    result = await setArkPoolConcurrency({ storageRoot: STORAGE, poolId: POOL, policy: { concurrency, reason: reason.trim() },
      operationId: randomUUID(), expectedRevision: wrapped.state.revision, expectedLedgerSha256: sha(raw),
      humanAuthorization: { schemaVersion: 1, actorType: 'human', statement: STATEMENT, evidenceRef, evidenceSha256 } });
  } catch (error) {
    lastError = error;
    if (!['ARK_POLICY_CHANGE_STALE'].includes(error.code)) throw error;
  }
}
if (!result) throw lastError || new Error('并发上限变更未完成');
console.log(JSON.stringify({ ...result, evidenceRef, evidenceSha256,
  after: (await readArkExecutionSummary({ storageRoot: STORAGE, poolId: POOL })).policy }, null, 2));
