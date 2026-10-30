/** All public review entrances must durably publish their own result. No model. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const base = process.env.BASE || 'http://127.0.0.1:3212';
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || `data/verify/review-entrypoints-${Date.now()}.json`;
const sample = readFileSync(new URL('../samples/test.docx', import.meta.url));
const sourceSha256 = createHash('sha256').update(sample).digest('hex');
const evidence = { generatedAt: new Date().toISOString(), base, realArkCalls: 0, checks: [] };
async function json(path, body) {
  const r = await fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await r.json(); assert.ok(r.ok, data.error); return data;
}
try { for (const entrance of ['sync', 'async', 'stream']) {
  const up = await (await fetch(base + '/api/upload?name=entrypoint-' + entrance + '.docx', { method: 'POST', body: sample })).json();
  assert.ok(up.id);
  assert.equal(up.workVersion.sourceSha256, sourceSha256, 'upload must identify the exact submitted source bytes');
  let result, accepted, streamDoc, expectedRunId;
  if (entrance === 'stream') {
    const query = new URLSearchParams({ id: up.id, detach: '1', useModel: 'false', useRecheck: 'false', useContext: 'false', useCases: 'false' });
    const response = await fetch(base + '/api/review-stream?' + query);
    assert.ok(response.ok);
    const frames = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
      const event = /^event: (.*)$/m.exec(frame)?.[1]; const data = /^data: (.*)$/m.exec(frame)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
    assert.ok(!frames.some((f) => f.event === 'error'), 'stream must publish a durable done instead of a saving error');
    streamDoc = frames.find((f) => f.event === 'doc')?.data;
    assert.ok(streamDoc?.history);
    result = frames.find((f) => f.event === 'done')?.data;
    assert.ok(result);
    expectedRunId = streamDoc.reviewRunId;
    assert.equal(streamDoc.id, up.id);
    assert.equal(streamDoc.reviewJobId, expectedRunId);
    assert.equal(streamDoc.workVersionId, up.workVersion.id);
    assert.equal(streamDoc.workVersion.sourceSha256, sourceSha256);
    assert.equal(result.reviewRunId, expectedRunId, 'doc and done must describe the same accepted stream run');
  } else {
    accepted = await json('/api/review', { id: up.id, useModel: false, useRecheck: false, useContext: false, useCases: false, async: entrance === 'async' });
    expectedRunId = accepted.reviewRunId;
    if (entrance === 'sync') result = accepted;
    else {
      assert.equal(accepted.id, up.id);
      assert.equal(accepted.reviewJobId, expectedRunId);
      assert.equal(accepted.workVersionId, up.workVersion.id);
      assert.equal(accepted.reviewVersionId, up.workVersion.id);
      assert.equal(accepted.workVersion.sourceSha256, sourceSha256);
    }
  }
  assert.match(expectedRunId, /^r[a-f0-9]{64}$/, 'each entrance must accept a durable review job');
  const deadline = Date.now() + 10000;
  let status;
  do {
    status = await json('/api/review-status?id=' + up.id);
    if (!status.running && !status.waiting) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.equal(status.running, false);
  assert.equal(status.waiting, false, 'a queued job is not a completed review');
  assert.equal(status.status, 'completed');
  assert.equal(status.id, up.id);
  assert.equal(status.reviewRunId, expectedRunId);
  assert.equal(status.reviewJobId, expectedRunId);
  assert.equal(status.reviewJob.id, expectedRunId);
  assert.equal(status.reviewJob.sessionId, up.id);
  assert.equal(status.reviewJob.versionId, up.workVersion.id);
  assert.equal(status.reviewVersionId, up.workVersion.id);
  assert.equal(status.workVersionId, up.workVersion.id);
  assert.equal(status.workVersion.id, up.workVersion.id);
  assert.equal(status.workVersion.sha256, up.workVersion.sha256);
  assert.equal(status.workVersion.sourceSha256, sourceSha256);
  assert.equal(status.error, null);
  assert.equal(status.hasResult, true);
  assert.ok(status.result?.issues?.length);
  assert.equal(status.result.reviewRunId, expectedRunId);
  if (entrance !== 'async') assert.deepEqual(status.result.issues.map((i) => i.issueKey), result.issues.map((i) => i.issueKey));
  const session = await json('/api/session?id=' + up.id);
  assert.equal(session.id, up.id);
  assert.equal(session.reviewRunId, expectedRunId);
  assert.equal(session.reviewJobId, expectedRunId);
  assert.equal(session.reviewVersionId, up.workVersion.id);
  assert.equal(session.workVersionId, up.workVersion.id);
  assert.equal(session.workVersion.sourceSha256, sourceSha256);
  assert.equal(session.result?.reviewRunId, expectedRunId);
  assert.deepEqual(session.result.issues.map((i) => i.issueKey), status.result.issues.map((i) => i.issueKey), 'independent session and status responses must publish the same run issues');
  assert.equal(session.hasResult, true);
  assert.equal(session.hasHistoricalResult, true);
  const auto = session.result.issues.find((i) => i.autoFix?.find && !i.occurrences);
  assert.ok(auto);
  const applied = await json('/api/apply-fixes', { id: up.id, accepted: [auto.issueKey], baseVersionId: session.workVersion.id, baseMutationEpoch: session.history.epoch, baseReviewRunId: expectedRunId, operationId: `entry-${entrance}` });
  assert.ok(applied.applied.length);
  assert.equal(applied.workVersion.sourceSha256, sourceSha256);
  assert.equal(applied.reviewRunId, expectedRunId);
  assert.equal(applied.result?.reviewRunId, expectedRunId);
  const undone = await json('/api/undo-fixes', { id: up.id, baseVersionId: applied.workVersion.id, baseMutationEpoch: applied.history.epoch, operationId: `undo-${entrance}` });
  assert.equal(undone.workVersion.sha256, up.workVersion.sha256);
  assert.equal(undone.workVersion.id, up.workVersion.id);
  assert.equal(undone.workVersion.sourceSha256, sourceSha256);
  assert.equal(undone.reviewRunId, expectedRunId);
  assert.equal(undone.result?.reviewRunId, expectedRunId, 'undo must restore the original run rather than any available result');
  assert.ok(undone.result?.issues?.length, 'each entrance has a review context recoverable by undo');
  evidence.checks.push({ entrance, sessionId: up.id, passed: true, acceptedRunId: expectedRunId,
    acceptedJobId: accepted?.reviewJobId || streamDoc?.reviewJobId || status.reviewJobId,
    publishedRunId: status.result.reviewRunId, reviewVersionId: status.reviewVersionId, sourceSha256,
    issueCount: session.result.issues.length, undoRestoredRunId: undone.result.reviewRunId, undoRestoredSha256: undone.workVersion.sha256 });
  console.log(`PASS ${entrance}: durable result, version history, undo and current-run identity`);
}
} catch(error) { evidence.failure=error.stack; throw error; }
finally { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n', {flag:'wx'}); }
console.log('审阅入口回归通过：同步、异步、流式均完成保存和历史恢复（方舟调用 0）');
