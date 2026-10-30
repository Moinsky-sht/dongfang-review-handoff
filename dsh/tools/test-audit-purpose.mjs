/** Verification feedback must stay exportable without training formal signals. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { sha256 } from '../src/working-version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) || `data/verify/audit-purpose-${Date.now()}.json`);
if (existsSync(OUT)) throw new Error('Evidence exists; choose a fresh --out.');
const scratch = await mkdtemp(join(tmpdir(), 'dsh-audit-purpose-'));
const auditRoot = join(scratch, 'audit');
const previousRoot = process.env.DSH_AUDIT_ROOT;
process.env.DSH_AUDIT_ROOT = auditRoot;
const audit = await import(`../src/audit.js?purpose-test=${Date.now()}`);
const source = await readFile(join(ROOT, 'src/audit.js'), 'utf8');
const summarySource = (source) => {
  const start = source.indexOf('function auditSummary(');
  if (start < 0) throw new Error('Missing auditSummary');
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
// Exercise the pre-change production algorithm against the same real log.
// Reconstruct only the two changed lines, so future runs need no run archive.
const oldSummarySource = summarySource(source)
  .replace(/const logged = readAll\(\);[\s\S]*?const all = logged\.filter\(\(entry\) => entry\.provenance\?\.purpose !== 'verification'\);/, 'const all = readAll();')
  .replace('total: all.length, loggedTotal: logged.length, excludedVerification: logged.length - all.length, byKind, rules', 'total: all.length, byKind, rules');
assert.ok(oldSummarySource.includes('const all = readAll();') && !oldSummarySource.includes('excludedVerification'), 'old algorithm projection must remove only the new purpose filter and counters');
const oldSummary = runInNewContext(`(${oldSummarySource})`, { readAll: audit.readAll, Map });
const archivedPath = join(ROOT, 'data/optimization/runs/p0-03-20261008232649/before-audit-purpose/src/audit.js');
let archivedOldMatches = null;
if (existsSync(archivedPath)) {
  assert.equal(oldSummarySource.replace(/\r\n/g, '\n'), summarySource(await readFile(archivedPath, 'utf8')).replace(/\r\n/g, '\n'), 'old reference must match archived production function');
  archivedOldMatches = true;
}
const report = {
  generatedAt: new Date().toISOString(), realArkCalls: 0, modelCalls: 0, checks: [],
  coverage: 'Actual append-only audit files under an isolated DSH_AUDIT_ROOT; pre-purpose summary algorithm compared against the current module; full JSON list and CSV parsed back for provenance. No main logs, manuscript semantics, or provider calls.',
  testSha256: sha256(await readFile(fileURLToPath(import.meta.url))), auditSha256: sha256(source),
  auditSummarySha256: sha256(summarySource(source)), oldAlgorithmSha256: sha256(oldSummarySource),
  archivedOldMatches,
};
const provenance = (purpose, sequence) => ({ purpose, verificationRunId: purpose === 'verification' ? 'software-purpose-run' : null,
  sessionId: 'sauditpurpose', sourceSha256: sha256('software-original'), workVersionId: 'software-version',
  reviewRunId: 'software-review-run', humanRecordId: `software-record-${purpose}-${sequence}`, operationId: `software-op-${purpose}-${sequence}`, start: 2, end: 4 });
const record = (kind, purpose, sequence) => ({ sessionId: 'sauditpurpose', manuscript: 'software-only.docx',
  kind: kind === 'reject' ? 'human-decision' : kind === 'mark' ? 'human-mark' : 'model-opinion',
  ruleId: `SOFTWARE-${kind.toUpperCase()}`, ruleTitle: `软件用途验收 ${kind}`,
  humanAction: kind === 'reject' ? 'reject' : '', modelVerdict: kind === 'model' ? 'disagree' : '',
  quote: '软件,含"引号"\n记录', provenance: provenance(purpose, `${kind}-${sequence}`) });
const test = async (name, fn) => {
  try { const facts = await fn(); report.checks.push({ name, ok: true, ...facts }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, ok: false, error: error.stack || String(error) }); throw error; }
};
function csvRows(csv) {
  // Parse the real exported CSV, including comma/quote/newline cells and BOM.
  const text = csv.replace(/^\ufeff/, '');
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (quoted) {
      if (character === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(cell); cell = ''; }
    else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += character;
  }
  assert.equal(quoted, false, 'CSV quotes must close');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

try {
  await test('empty isolated log declares both formal and logged totals', async () => {
    const summary = audit.auditSummary();
    assert.equal(summary.total, 0); assert.equal(summary.loggedTotal, 0); assert.equal(summary.excludedVerification, 0);
    assert.equal(summary.rules.length, 0); assert.equal(audit.listAudit().length, 0);
  });
  await test('three verification rejects, marks and model disagreements trigger old suggestions but none in formal summary', async () => {
    audit.recordAudit(['reject', 'mark', 'model'].flatMap((kind) => [1, 2, 3].map((index) => record(kind, 'verification', index))));
    const previous = oldSummary();
    assert.equal(previous.total, 9); assert.equal(previous.rules.length, 3);
    assert.ok(previous.rules.every((rule) => rule.suggestion.startsWith('建议复核')));
    const summary = audit.auditSummary();
    assert.equal(summary.total, 0); assert.equal(summary.loggedTotal, 9); assert.equal(summary.excludedVerification, 9);
    assert.equal(summary.rules.length, 0); assert.deepEqual(summary.byKind, {});
    return { oldSuggestions: previous.rules.length, currentSuggestions: summary.rules.length, excludedVerification: summary.excludedVerification };
  });
  await test('mixed verification feedback does not push two real editorial signals over the three-record threshold', async () => {
    audit.recordAudit(['reject', 'mark', 'model'].flatMap((kind) => [1, 2].map((index) => record(kind, 'editorial', index))));
    const summary = audit.auditSummary();
    assert.equal(summary.total, 6); assert.equal(summary.loggedTotal, 15); assert.equal(summary.excludedVerification, 9);
    assert.equal(summary.byKind['human-decision'], 2); assert.equal(summary.byKind['human-mark'], 2); assert.equal(summary.byKind['model-opinion'], 2);
    assert.ok(summary.rules.every((rule) => rule.total === 2 && rule.suggestion === ''));
    assert.ok(oldSummary().rules.every((rule) => rule.suggestion));
    return { formalRecords: summary.total, excludedVerification: summary.excludedVerification };
  });
  await test('real editorial thresholds and legacy records continue to contribute to formal optimization', async () => {
    audit.recordAudit(['reject', 'mark', 'model'].map((kind) => record(kind, 'editorial', 3)));
    audit.recordAudit({ ...record('reject', 'editorial', 'accept'), humanAction: 'accept' });
    audit.recordAudit({ sessionId: 'sauditpurpose', kind: 'human-decision', ruleId: 'SOFTWARE-LEGACY', humanAction: 'accept' });
    const summary = audit.auditSummary();
    assert.equal(summary.total, 11); assert.equal(summary.loggedTotal, 20); assert.equal(summary.excludedVerification, 9);
    const byRule = new Map(summary.rules.map((rule) => [rule.ruleId, rule]));
    assert.equal(byRule.get('SOFTWARE-REJECT').reject, 3); assert.equal(byRule.get('SOFTWARE-REJECT').accept, 1);
    assert.equal(byRule.get('SOFTWARE-MARK').humanMark, 3); assert.equal(byRule.get('SOFTWARE-MODEL').modelDisagree, 3);
    assert.equal(summary.rules.filter((rule) => rule.suggestion).length, 3);
    assert.equal(byRule.get('SOFTWARE-LEGACY').accept, 1);
    assert.equal(summary.byKind['human-decision'], 5); assert.equal(summary.byKind['human-mark'], 3); assert.equal(summary.byKind['model-opinion'], 3);
    return { formalRecords: summary.total, loggedTotal: summary.loggedTotal, formalSuggestions: 3 };
  });
  await test('listAudit, unchanged JSONL and parsed CSV retain every verification record and full provenance', async () => {
    const path = join(auditRoot, 'audit-log.jsonl');
    const before = await readFile(path);
    const all = audit.listAudit();
    assert.equal(all.length, 20); assert.equal(audit.listAudit({ sessionId: 'sauditpurpose' }).length, 20);
    assert.equal(all.filter((entry) => entry.provenance.purpose === 'verification').length, 9);
    assert.equal(audit.listAudit({ kind: 'human-mark' }).length, 6);
    const csv = audit.toCsv(all); const [header, ...rows] = csvRows(csv);
    assert.equal(rows.length, all.length); assert.equal(header.at(-1), 'provenance');
    const provenanceIndex = header.indexOf('provenance'); const idIndex = header.indexOf('id'); const quoteIndex = header.indexOf('quote');
    for (let index = 0; index < all.length; index += 1) {
      assert.equal(rows[index].length, header.length);
      assert.equal(rows[index][idIndex], all[index].id); assert.equal(rows[index][quoteIndex], all[index].quote);
      assert.deepEqual(JSON.parse(rows[index][provenanceIndex]), all[index].provenance);
    }
    audit.auditSummary();
    assert.deepEqual(await readFile(path), before, 'summary/list/export must not rewrite or purge the log');
    assert.equal(before.toString('utf8').trim().split('\n').length, 20);
    return { fullListCount: all.length, csvCount: rows.length, retainedVerification: 9, unchangedLogSha256: sha256(before) };
  });
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack || String(error); process.exitCode = 1;
} finally {
  if (previousRoot === undefined) delete process.env.DSH_AUDIT_ROOT;
  else process.env.DSH_AUDIT_ROOT = previousRoot;
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const cleanupRelative = relative(resolve(tmpdir()), resolve(scratch));
  if (!cleanupRelative || cleanupRelative.startsWith('..') || isAbsolute(cleanupRelative) || !cleanupRelative.startsWith('dsh-audit-purpose-')) throw new Error('Unsafe scratch cleanup path');
  await rm(scratch, { recursive: true, force: true });
  console.log(`Evidence: ${OUT}`);
}
