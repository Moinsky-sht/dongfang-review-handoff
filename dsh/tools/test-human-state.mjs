/** Human binding/range contracts plus real handler order with injected disk IO. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildHumanRecord, humanState, effectiveReviewRunId, humanAuditEntry } from '../src/human-state.js';
import { fixHistoryStatus } from '../src/fix-history.js';
import { sha256 } from '../src/working-version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selectedOut = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6);
const OUT = resolve(ROOT, selectedOut || `data/verify/human-state-${Date.now()}.json`);
if (existsSync(OUT)) throw new Error('Evidence exists; choose a fresh --out.');
const source = readFileSync(resolve(ROOT, 'server.mjs'), 'utf8');
const report = { generatedAt: new Date().toISOString(), realArkCalls: 0, modelCalls: 0, checks: [],
  coverage: 'Pure human contracts and current HTTP-handler ordering with injected persistence. No browser DOM or manuscript correctness judgment.',
  testSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), serverSha256: sha256(source),
  humanStateSha256: sha256(readFileSync(resolve(ROOT, 'src/human-state.js'))) };
const issue = { ruleId: 'SOFTWARE-ONLY', location: 'paragraph:0', quote: '重复片段', title: '软件范围验收', severity: '中' };
const issueKey = `${issue.ruleId}|${issue.location}|${issue.quote}`;
const plain = (text) => text.replace(/\s/g, '');
function fixture(text = '重复 片段，重复\t片段。') {
  const s = { id: 'shumanfixture', name: 'software-only.docx', mutationEpoch: 0, humanRevision: 0, humanRecords: [],
    workVersion: { id: `shumanfixture:v000000-${sha256(text)}`, revision: 0, sha256: sha256(text), sourceSha256: sha256('software-original') },
    result: { issues: [structuredClone(issue)] }, resultRunId: 'completed-run-A', reviewRunId: 'completed-run-A',
    doc: { paragraphs: [{ text }], footnotes: [{ text: '脚注 文字' }], endnotes: [{ text: '尾注 文字' }] },
    reviewRunning: false, applyingFixes: false, reviewError: null, interrupted: false, _storeRevision: 0 };
  s.history = { entries: [{ versionId: s.workVersion.id, appliedFixes: [] }], cursor: 0 };
  return s;
}
const bodyFor = (s, fields = {}) => ({ id: s.id, operationId: 'software-op', baseVersionId: s.workVersion.id,
  baseMutationEpoch: s.mutationEpoch, baseRunId: effectiveReviewRunId(s), expectedHumanRevision: s.humanRevision, ...fields });
const mark = (start, end, quote, extra = {}) => ({ target: 'body', index: 0, start, end, quote, offsetSpace: 'normalized', ...extra });
function append(s, body) { const record = buildHumanRecord(s, body); s.humanRecords.push(record); s.humanRevision += 1; return record; }
const test = async (name, fn) => {
  try { await fn(); report.checks.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, ok: false, error: error.stack || String(error) }); throw error; }
};

function serverFunction(name) {
  const a = source.indexOf(`function ${name}(`);
  if (a < 0) throw new Error(`Missing server function ${name}`);
  const prefix = source.slice(Math.max(0, a - 6), a) === 'async ' ? a - 6 : a;
  return source.slice(prefix, source.indexOf('\n}', a) + 2);
}
function handlerFixture() {
  const s = fixture();
  let stored = { snapshot: structuredClone(s), manifest: { revision: 0, manifestSha256: 'initial' } };
  const controls = { fail: false, afterCommitFailure: false, auditFailure: false, auditCount: 0, persistCount: 0, pause: null };
  const context = {
    Buffer, Map, Set, Object, JSON, Promise, structuredClone, sha256, buildHumanRecord, humanState, effectiveReviewRunId, humanAuditEntry, fixHistoryStatus,
    activeMutations: new Map(),
    readBody: async (req) => Buffer.from(JSON.stringify(req.payload)), touchSession: async () => s,
    json: (res, status, payload) => { res.status = status; res.payload = payload; },
    recordAudit: () => { controls.auditCount += 1; if (controls.auditFailure) throw new Error('audit disk failure'); },
    saveSessionSnapshot: async ({ snapshot, expectedRevision }) => {
      controls.persistCount += 1;
      if (controls.pause) await controls.pause();
      if (controls.fail) throw new Error('session disk failure');
      assert.equal(expectedRevision, stored.manifest.revision);
      const manifest = { schemaVersion: 1, sessionId: s.id, revision: expectedRevision + 1,
        savedAt: new Date().toISOString(), payloadSha256: sha256(JSON.stringify(snapshot)) };
      manifest.manifestSha256 = sha256(JSON.stringify(manifest));
      stored = { snapshot: structuredClone(snapshot), manifest };
      if (controls.afterCommitFailure) { const error = new Error('committed lock cleanup failure'); error.committedManifest = manifest; throw error; }
      return manifest;
    },
    loadSessionSnapshot: async () => structuredClone(stored),
  };
  for (const name of ['mutationFingerprint', 'mutationGate', 'recordMutationReceipt', 'pendingDuplicate', 'beginMutation', 'persistSession', 'humanPayload']) {
    context[name] = runInNewContext(`(${serverFunction(name)})`, context);
  }
  const prefix = "'POST /api/human-records': ";
  const start = source.indexOf(prefix);
  const end = source.indexOf('\n  },', start);
  const handler = runInNewContext(`(${source.slice(start + prefix.length, end + 4)})`, context);
  return { s, controls, call: async (body) => { const res = {}; await handler({ payload: body }, res); return res; } };
}

try {
  await test('second repeated quote retains the selected normalized and raw occurrence', async () => {
    const s = fixture();
    const record = append(s, bodyFor(s, { kind: 'mark', mark: mark(5, 9, '重复片段', { nodeTextSha256: sha256(plain(s.doc.paragraphs[0].text)) }) }));
    assert.equal(record.mark.start, 5); assert.equal(record.mark.rawStart, 6); assert.equal(record.mark.rawEnd, 11);
    assert.equal(record.mark.quote, '重复\t片段'); assert.equal(record.mark.text, s.doc.paragraphs[0].text.slice(6, 11));
    assert.equal(humanState(s).marks[0].rawStart, 6);
  });

  await test('UTF-16 half-character selections are rejected while complete emoji/CJK points remain valid', async () => {
    for (const character of ['😀', '𠀀']) {
      const s = fixture(character + '甲');
      for (const [start, end] of [[0, 1], [1, 2]]) {
        assert.throws(() => buildHumanRecord(s, bodyFor(s, { kind: 'mark', mark: mark(start, end, character.slice(start, end)) })), (error) => error.status === 400);
      }
      const record = buildHumanRecord(s, bodyFor(s, { kind: 'mark', mark: mark(0, 2, character) }));
      assert.equal(record.mark.quote, character); assert.equal(record.mark.rawEnd, 2);
    }
  });

  await test('version, mutation epoch, human CAS and review-run mismatches reject stale writes', async () => {
    const s = fixture();
    const good = bodyFor(s, { kind: 'decision', issueKey, action: 'unsure', opinion: 'software-only' });
    for (const changes of [{ baseVersionId: 'wrong' }, { baseMutationEpoch: 1 }, { expectedHumanRevision: 1 }, { baseRunId: 'other-run' }]) {
      assert.throws(() => buildHumanRecord(s, { ...good, ...changes }), (error) => error.status === 409);
    }
    assert.throws(() => buildHumanRecord(s, bodyFor(s, { kind: 'mark', mark: mark(5, 9, 'not-the-quote') })), (error) => error.status === 409);
    assert.throws(() => buildHumanRecord(s, bodyFor(s, { kind: 'mark', mark: mark(5, 9, '重复片段', { nodeTextSha256: 'wrong' }) })), (error) => error.status === 409);
  });

  await test('body, footnote and endnote marks keep separate exact container identities', async () => {
    const s = fixture();
    for (const [target, quote] of [['footnote', '脚注文字'], ['endnote', '尾注文字']]) {
      const record = append(s, bodyFor(s, { kind: 'mark', mark: mark(0, 4, quote, { target }) }));
      assert.equal(record.mark.target, target); assert.equal(record.mark.rawStart, 0); assert.equal(record.mark.rawEnd, 5);
      assert.equal(record.mark.paragraphIndex, null);
    }
    assert.equal(humanState(s).marks.length, 2);
  });

  await test('same issue keys never leak across sessions or working versions', async () => {
    const s = fixture();
    append(s, bodyFor(s, { kind: 'decision', issueKey, action: 'accept', opinion: 'software-only' }));
    append(s, bodyFor(s, { kind: 'mark', mark: mark(5, 9, '重复片段') }));
    const own = humanState(s); assert.equal(Object.keys(own.decisions).length, 1); assert.equal(own.marks.length, 1);
    for (const changed of [{ ...s, id: 'sdifferent' }, { ...s, workVersion: { ...s.workVersion, id: 'different-version' } }]) {
      assert.equal(Object.keys(humanState(changed).decisions).length, 0); assert.equal(humanState(changed).marks.length, 0);
    }
    assert.deepEqual(humanState({ ...s, workVersion: s.workVersion }), own, 'returning to immutable version restores its observations');
  });

  await test('new runs and interrupted/failed runs hide decisions while preserving version marks/history', async () => {
    const s = fixture();
    append(s, bodyFor(s, { kind: 'decision', issueKey, action: 'reject', opinion: 'software-only' }));
    append(s, bodyFor(s, { kind: 'mark', mark: mark(5, 9, '重复片段') }));
    for (const changes of [{ resultRunId: 'new-run', reviewRunId: 'new-run' }, { interrupted: true }, { reviewError: 'failure' }, { reviewRunning: true }]) {
      const state = humanState({ ...s, ...changes });
      assert.equal(Object.keys(state.decisions).length, 0); assert.equal(state.marks.length, 1); assert.equal(state.historyCount, 2);
    }
    const unreviewed = { ...fixture(), result: null, resultRunId: null, reviewRunId: null };
    const record = append(unreviewed, bodyFor(unreviewed, { kind: 'mark', mark: mark(5, 9, '重复片段') }));
    assert.equal(record.binding.reviewRunId, null);
    assert.throws(() => buildHumanRecord(unreviewed, bodyFor(unreviewed, { kind: 'decision', issueKey, action: 'accept', opinion: '' })), (error) => error.status === 409);
  });

  await test('audit projection carries the exact committed source/version/run/range provenance', async () => {
    const s = fixture(); const record = append(s, bodyFor(s, { kind: 'mark', mark: mark(5, 9, '重复片段', { note: 'software-only' }) }));
    const audit = humanAuditEntry(s, record);
    assert.equal(audit.provenance.sessionId, s.id); assert.equal(audit.provenance.sourceSha256, s.workVersion.sourceSha256);
    assert.equal(audit.provenance.workVersionId, s.workVersion.id); assert.equal(audit.provenance.reviewRunId, s.resultRunId);
    assert.equal(audit.provenance.humanRecordId, record.id); assert.equal(audit.provenance.start, 5);
    assert.equal(audit.quote, '重复\t片段'); assert.equal(audit.kind, 'human-mark');
  });

  await test('actual handler never publishes a human record or audit entry before persistence succeeds', async () => {
    const h = handlerFixture(); h.controls.fail = true;
    const reply = await h.call(bodyFor(h.s, { kind: 'decision', issueKey, action: 'unsure', opinion: 'software-only' }));
    assert.equal(reply.status, 500); assert.equal(h.s.humanRevision, 0); assert.equal(h.s.humanRecords.length, 0);
    assert.equal(h.controls.auditCount, 0); assert.equal(h.s.applyingFixes, false);
  });

  await test('actual handler verifies committedManifest and publishes the durable record after cleanup error', async () => {
    const h = handlerFixture(); h.controls.afterCommitFailure = true;
    const reply = await h.call(bodyFor(h.s, { kind: 'decision', issueKey, action: 'unsure', opinion: 'software-only' }));
    assert.equal(reply.status, 200); assert.equal(h.s.humanRevision, 1); assert.equal(h.s.humanRecords.length, 1);
    assert.equal(h.s._storeRevision, 1); assert.equal(h.controls.auditCount, 1);
  });

  await test('same-operation in-flight retries wait and commit one record, receipt and audit entry', async () => {
    const h = handlerFixture();
    let entered; let finish;
    const ready = new Promise((resolve) => { entered = resolve; });
    h.controls.pause = async () => { entered(); await new Promise((resolve) => { finish = resolve; }); };
    const body = bodyFor(h.s, { kind: 'mark', mark: mark(5, 9, '重复片段') });
    const first = h.call(body); await ready; const second = h.call(body);
    finish(); const replies = await Promise.all([first, second]);
    assert.ok(replies.every((reply) => reply.status === 200)); assert.equal(replies[1].payload.replayed, true);
    assert.equal(h.s.humanRevision, 1); assert.equal(h.s.humanRecords.length, 1); assert.equal(h.controls.persistCount, 1); assert.equal(h.controls.auditCount, 1);
    h.controls.pause = null;
    const conflict = await h.call({ ...body, mark: { ...body.mark, note: 'different-body' } });
    assert.equal(conflict.status, 409); assert.equal(h.s.humanRecords.length, 1);
  });

  await test('one human CAS revision cannot accept two distinct operations', async () => {
    const h = handlerFixture();
    const body = bodyFor(h.s, { kind: 'decision', issueKey, action: 'accept', opinion: 'software-only' });
    const first = await h.call(body);
    const second = await h.call({ ...body, operationId: 'different-op', action: 'unsure' });
    assert.equal(first.status, 200); assert.equal(second.status, 409); assert.equal(h.s.humanRecords.length, 1);
  });

  await test('audit projection failure is a warning after primary human facts remain committed', async () => {
    const h = handlerFixture(); h.controls.auditFailure = true;
    const reply = await h.call(bodyFor(h.s, { kind: 'mark', mark: mark(5, 9, '重复片段') }));
    assert.equal(reply.status, 200); assert.ok(reply.payload.auditWarning); assert.equal(h.s.humanRevision, 1); assert.equal(h.s.humanRecords.length, 1);
  });
} catch (error) { report.error = error.stack || String(error); process.exitCode = 1; }
finally {
  report.passed = report.checks.filter((entry) => entry.ok).length;
  report.failed = report.checks.filter((entry) => !entry.ok).length;
  report.finishedAt = new Date().toISOString(); mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(`Human state: ${report.passed} passed / ${report.failed} failed; model calls 0. ${OUT}`);
