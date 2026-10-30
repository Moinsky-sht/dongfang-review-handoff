/** Every registered DOCX path: exact persisted human bindings, without content judgment. */
import {readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {loadWorkingVersion, sha256} from '../src/working-version.js';
import {saveSessionSnapshot, loadSessionSnapshot} from '../src/session-store.js';
import {parseDocxBuffer} from '../src/review.js';
import {humanState, buildHumanRecord} from '../src/human-state.js';
import assert from 'node:assert/strict';

const ROOT = resolve(import.meta.dirname, '..');
const flag = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const previous = resolve(ROOT, flag('history', 'data/optimization/runs/p0-02-20261008-224150/tests/corpus-history-all-01.json'));
const history = JSON.parse(readFileSync(previous));
const rows = readFileSync(`${previous}.jsonl`, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
assert.equal(rows.length, 632);
const OUT = resolve(ROOT, flag('out', `data/verify/corpus-human-binding-${Date.now()}.json`));
if (existsSync(OUT) || existsSync(`${OUT}.jsonl`)) throw new Error('Evidence already exists; choose a fresh output');
mkdirSync(dirname(OUT), {recursive: true});
writeFileSync(`${OUT}.jsonl`, '', {flag: 'wx'});
const store = `${OUT}.sessions`;
const fingerprint = {testSha256: sha256(readFileSync(import.meta.filename)),
  humanStateSha256: sha256(readFileSync(resolve(ROOT, 'src/human-state.js'))),
  sessionStoreSha256: sha256(readFileSync(resolve(ROOT, 'src/session-store.js'))),
  historyEvidenceSha256: sha256(readFileSync(previous))};
const started = Date.now();
let passed = 0;
const failures = [];
const totals = {body: 0, footnote: 0, endnote: 0};
for (const row of rows) {
  const checks = {};
  try {
    const sourcePath = resolve(history.corpusRoot, row.path);
    const original = readFileSync(sourcePath);
    assert.equal(sha256(original), row.sourceSha256);
    const saved = await loadWorkingVersion({sessionId: row.sessionId, versionId: row.versions.initial.id, storageRoot: history.storageRoot});
    assert.ok(original.equals(saved.buffer));
    const doc = parseDocxBuffer(saved.buffer, row.path);
    const issue = {ruleId: 'SOFTWARE-BINDING-FIXTURE', location: 'software:0', quote: '软件身份夹具（不作内容判断）'};
    const issueKey = `${issue.ruleId}|${issue.location}|${issue.quote}`;
    const s = {id: row.sessionId, name: row.path, workVersion: saved.version, mutationEpoch: 0,
      result: {issues: [issue]}, resultRunId: 'software-run-1', reviewRunId: 'software-run-1',
      resultVersionId: saved.version.id, doc, humanRecords: [], humanRevision: 0};
    function action(payload) {
      const record = buildHumanRecord(s, {id: s.id, operationId: `fixture-${s.humanRevision}`,
        baseVersionId: s.workVersion.id, baseMutationEpoch: 0, baseRunId: s.resultRunId,
        expectedHumanRevision: s.humanRevision, purpose: 'verification', verificationRunId: 'corpus-software-binding', ...payload});
      s.humanRecords.push(record); s.humanRevision++;
      return record;
    }
    action({kind: 'decision', issueKey, action: 'unsure', opinion: '软件保存验收，非稿件质量判断'});
    for (const [target, field] of [['body', 'paragraphs'], ['footnote', 'footnotes'], ['endnote', 'endnotes']]) {
      const index = (doc[field] || []).findIndex((node) => node.text?.replace(/\s/g, '').length > 0);
      if (index < 0) { if (target === 'body') throw new Error('No body node'); continue; }
      const plain = doc[field][index].text.replace(/\s/g, '');
      const mark = {target, index, start: 0, end: Math.min(8, plain.length), offsetSpace: 'normalized', quote: plain.slice(0, 8), note: '结构范围保存测试'};
      const record = action({kind: 'mark', mark});
      assert.equal(doc[field][index].text.slice(record.mark.rawStart, record.mark.rawEnd), record.mark.quote);
      totals[target]++;
    }
    const expected = humanState(s);
    await saveSessionSnapshot({sessionId: s.id, snapshot: s, expectedRevision: -1, storageRoot: store});
    const restored = (await loadSessionSnapshot({sessionId: s.id, storageRoot: store})).snapshot;
    checks.persistentHumanRecordsExact = JSON.stringify(humanState(restored)) === JSON.stringify(expected);
    assert.ok(checks.persistentHumanRecordsExact);
    checks.correctSourceAndSessionBinding = restored.humanRecords.every((record) => record.binding.sessionId === s.id
      && record.binding.sourceSha256 === row.sourceSha256 && record.binding.workVersionId === saved.version.id);
    assert.ok(checks.correctSourceAndSessionBinding);
    const changed = {...restored, workVersion: row.versions.fixed};
    checks.differentVersionHasNoCurrentHumanActions = Object.keys(humanState(changed).decisions).length === 0 && humanState(changed).marks.length === 0;
    assert.ok(checks.differentVersionHasNoCurrentHumanActions);
    checks.undoRestoresPriorHumanActions = JSON.stringify(humanState({...changed, workVersion: saved.version})) === JSON.stringify(expected);
    assert.ok(checks.undoRestoresPriorHumanActions);
    const newRun = humanState({...restored, resultRunId: 'software-run-2', reviewRunId: 'software-run-2'});
    checks.newRunDropsOldDecisionsKeepsVersionMarks = Object.keys(newRun.decisions).length === 0 && newRun.marks.length === expected.marks.length;
    assert.ok(checks.newRunDropsOldDecisionsKeepsVersionMarks);
    const wrongSession = humanState({...restored, id: `${s.id}other`});
    checks.sameIssueKeyCannotLeakAcrossSessions = Object.keys(wrongSession.decisions).length === 0 && wrongSession.marks.length === 0;
    assert.ok(checks.sameIssueKeyCannotLeakAcrossSessions);
    checks.sourceOnDiskUnchanged = sha256(readFileSync(sourcePath)) === row.sourceSha256;
    assert.ok(checks.sourceOnDiskUnchanged);
    passed++;
  } catch (error) { failures.push({path: row.path, error: error.message}); }
  appendFileSync(`${OUT}.jsonl`, JSON.stringify({path: row.path, sourceSha256: row.sourceSha256,
    sessionId: row.sessionId, status: failures.at(-1)?.path === row.path ? 'failed' : 'passed', checks, ...fingerprint}) + '\n');
  if ((passed + failures.length) % 100 === 0) console.log(`${passed + failures.length}/${rows.length} checked`);
}
const report = {generatedAt: new Date().toISOString(), ...fingerprint, total: rows.length, passed, failed: failures.length,
  elapsedMs: Date.now() - started, markTargets: totals, failures, realArkCalls: 0, paidModelCalls: 0,
  storageRoot: store, coverageNote: 'One software decision and one exact mark per available node type, immutable-version binding and durable session roundtrip for each DOCX path. No content accuracy, browser DOM coverage or legacy-format acceptance is inferred.'};
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({total: report.total, passed, failed: report.failed, markTargets: totals, elapsedMs: report.elapsedMs, realArkCalls: 0}));
if (failures.length) process.exitCode = 1;
