/** State/race failures isolated from filesystem and model response timing. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { sha256 } from '../src/working-version.js';
import { humanState, effectiveReviewRunId } from '../src/human-state.js';
import { initializeFixHistory, fixHistoryStatus, historyStep, rememberCompletedReview, selectReviewForHistory } from '../src/fix-history.js';

const result = { generatedAt: 'first', issues: [] };
const session = { workVersion: { id: 'v0', revision: 0 }, result, resultVersionId: 'v0', resultRunId: 'completed-A', reviewRunId: 'completed-A' };
rememberCompletedReview(session);
session.reviewRunId = 'failed-B';
rememberCompletedReview(session);
assert.equal(session.reviewRecords.length, 1, 'failed run must not archive the previous result as its own success');
assert.equal(session.reviewRecords[0].id, 'completed-A');
session.history = { entries: [{ versionId: 'v0', appliedFixes: [] }, { versionId: 'v1', appliedFixes: [] }], cursor: 0 };
session.reviewRecords.push({ id: 'completed-C', versionId: 'v1', result: { issues: [], modelResult: { errors: [{ window: 2 }] } } });
selectReviewForHistory(session);
assert.equal(session.resultRunId, 'completed-A');
session.history.cursor = 1;
selectReviewForHistory(session);
assert.equal(session.reviewProgress.phase, 'partial', 'restoring a partial review retains its missing-window state');

const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const activeMutations = new Map();
let unblock, entered;
const blocked = new Promise((resolve) => { unblock = resolve; });
const saving = new Promise((resolve) => { entered = resolve; });
let saves = 0;
const s = { id: 'srace', workVersion: { id: 'v0', revision: 0 }, doc: {}, mutationEpoch: 0 };
const context = vm.createContext({
  Buffer, JSON, Map, structuredClone, sha256, activeMutations,
  humanState, effectiveReviewRunId,
  initializeFixHistory, fixHistoryStatus, historyStep, rememberCompletedReview, selectReviewForHistory,
  touchSession: async () => s,
  readBody: async (req) => Buffer.from(JSON.stringify(req)),
  completedFixKeys: () => [], serializeDoc: () => ({}), serializeReview: () => ({}),
  persistSession: async () => { saves += 1; entered(); await blocked; },
  json: (response, status, data) => { response.status = status; response.data = data; },
});
const mutationStart = source.indexOf('function mutationPayload(');
const mutationEnd = source.indexOf('/** A grouped issue is resolved', mutationStart);
assert.ok(mutationStart >= 0, 'server mutation helpers must have a declared start boundary');
assert.ok(mutationEnd > mutationStart, 'server mutation helpers must end before the next grouped-issue section');
vm.runInContext(source.slice(mutationStart, mutationEnd), context);
const move = vm.runInContext('moveFixHistory', context);
const command = { id: s.id, operationId: 'noop-retry', baseVersionId: 'v0', baseMutationEpoch: 0 };
const first = {}, second = {};
const pending = move(command, first, 'undo');
await saving;
assert.equal(s.applyingFixes, true, 'a boundary noop still owns the manuscript mutation lock while its receipt is saved');
assert.equal(vm.runInContext('mutationGate', context)(s, { ...command, operationId: 'another-command' }, 'apply').status, 409);
const duplicate = move(command, second, 'undo');
await Promise.resolve();
assert.equal(second.status, undefined, 'an identical in-flight retry waits for the first durable result');
unblock();
await Promise.all([pending, duplicate]);
assert.equal(first.status, 200);
assert.equal(second.status, 200);
assert.equal(second.data.replayed, true);
assert.equal(saves, 1);
assert.equal(s.applyingFixes, false);
assert.equal(activeMutations.size, 0);
assert.equal(s.mutationEpoch, 0, 'noop receipts do not add a modification step');
console.log('修改历史状态回归通过：失败运行不冒充完成记录、部分状态恢复、边界操作锁和并发同号重试（模型调用 0）');
