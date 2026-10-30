/** Exercise the actual HTTP mutation handler with controlled review fixtures. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDocxPatches } from '../src/docx-patches.js';
import { parseDocxBuffer } from '../src/docx.js';
import { writeZip } from '../src/zip-write.js';
import { sha256 } from '../src/working-version.js';
import { humanState, effectiveReviewRunId } from '../src/human-state.js';
import { initializeFixHistory, appendedFixState, fixHistoryStatus, rememberCompletedReview } from '../src/fix-history.js';
import { cleanDocx } from '../src/docx-clean.js';
import { captureReviewSource, reviewedSourceDocument } from '../src/review-source.js';

const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selectedOut = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6);
const OUT = selectedOut ? resolve(ROOT, selectedOut) : null;
if (OUT && existsSync(OUT)) throw new Error('Evidence exists; choose a fresh --out.');
const report = { generatedAt: new Date().toISOString(), modelCalls: 0, realArkCalls: 0, checks: [],
  coverage: 'Current actual server mutation/cleaning helper functions in a VM, valid OPC software fixture and checked version-byte hashes; controlled storage failures. No HTTP browser or provider calls.',
  testSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), serverSha256: sha256(source),
  cleanerSha256: sha256(readFileSync(resolve(ROOT, 'src/docx-clean.js'))), xmlHelperSha256: sha256(readFileSync(resolve(ROOT, 'src/docx-clean-xml.js'))) };
function serverFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing actual helper ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const marker = "'POST /api/apply-fixes': ";
const start = source.indexOf(marker) + marker.length;
const end = source.indexOf('\n  },\n};', start) + '\n  }'.length;
assert.ok(start >= marker.length && end > start);
const helperStart = source.indexOf('function completedFixKeys(');
const helperEnd = source.indexOf('\nfunction reviewTexts(', helperStart);
const key = (i) => `${i.ruleId}|${i.location}|${i.quote || ''}`;
const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>badXYZXYZ</w:t></w:r></w:p><w:p><w:ins w:id="7" w:author="software"><w:r><w:t>protected</w:t></w:r></w:ins></w:p><w:sectPr/></w:body></w:document>';
const original = writeZip([
  { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
  { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
  { name: 'word/document.xml', data: Buffer.from(xml) },
]);
const originalHash = sha256(original);
const initialVersionId = `sfixture:v000000-${originalHash}`;
let diskFailure = false;
let savedVersionCount = 0; let persistedSessionCount = 0;
const selectedReviewRunId = 'completed-fixture';
const s = {
  id: 'sfixture', name: 'fixture.docx', buffer: original, originalBuffer: original,
  doc: parseDocxBuffer(original), workVersion: { id: initialVersionId, sessionId: 'sfixture', revision: 0, sha256: originalHash, sourceSha256: originalHash },
  resultVersionId: initialVersionId, resultTexts: { body: ['badXYZXYZ', 'protected'], footnote: [], endnote: [] },
  resultRunId: selectedReviewRunId, reviewRunId: selectedReviewRunId,
  result: { issues: [
    { ruleId: 'A', location: 'paragraph:0', paragraphIndex: 0, quote: 'bad', autoFix: { find: 'bad', replace: 'LONGER' } },
    { ruleId: 'B', location: 'paragraph:0', paragraphIndex: 0, quote: 'second XYZ', autoFix: { find: 'XYZ', replace: 'Q', offset: 6 } },
    { ruleId: 'C', location: 'group', quote: 'mixed', occurrences: [
      { paragraphIndex: 0, autoFix: { find: 'XYZ', replace: 'R', offset: 3 } },
      { paragraphIndex: 1, autoFix: { find: 'protected', replace: 'safe', offset: 0 } },
    ] },
  ] },
};
const context = vm.createContext({
  Buffer, Set, Map, Number, JSON, sha256, applyDocxPatches, parseDocxBuffer, cleanDocx, structuredClone,
  reviewedSourceDocument,
  activeMutations: new Map(),
  humanState, effectiveReviewRunId,
  initializeFixHistory, appendedFixState, fixHistoryStatus, rememberCompletedReview,
  persistSession: async () => { persistedSessionCount++; },
  touchSession: (id) => id === s.id ? s : null,
  readBody: async (req) => Buffer.from(JSON.stringify(req)),
  json: (res, status, data) => { res.status = status; res.data = data; },
  serializeDoc: (doc) => ({ paragraphs: doc.paragraphs.map((p) => ({ text: p.text })) }),
  serializeReview: () => ({ issues: [] }),
  saveWorkingVersion: async ({ sessionId, buffer, originalBuffer, parent, revision }) => {
    savedVersionCount++;
    if (diskFailure) throw new Error('injected disk failure');
    assert.equal(sessionId, s.id); assert.equal(revision, s.maxVersionRevision + 1);
    assert.equal(sha256(originalBuffer), originalHash);
    return { id: `${sessionId}:v${String(revision).padStart(6, '0')}-${sha256(buffer)}`, sessionId,
      parentId: parent.id, revision, sha256: sha256(buffer), sourceSha256: originalHash };
  },
});
for (const name of ['cleaningProof', 'inspectWorkingClean', 'rememberCleanProof', 'cleanReviewGate', 'sessionReviewSource']) vm.runInContext(serverFunction(name), context);
// The live review publisher captures this canonical source, and legacy sessions
// recover it by loading immutable bytes. The VM storage substitute never runs
// hydration, so prepare its source with the real capture function here.
s.resultTexts = captureReviewSource(s.doc, s.workVersion);
s.doc.originalCommentCount = 0;
s.clean = context.cleaningProof(cleanDocx(original).stats, s.workVersion, 0);
context.rememberCleanProof(s);
vm.runInContext(source.slice(helperStart, helperEnd), context);
vm.runInContext(source.slice(source.indexOf('function mutationPayload('), source.indexOf('async function moveFixHistory(')), context);
const handler = vm.runInContext('(' + source.slice(start, end) + ')', context);
async function call(accepted, extra = {}) {
  const response = {};
  await handler({ id: s.id, accepted, baseReviewRunId: selectedReviewRunId, ...extra }, response);
  return response;
}
function assertCleanProof(response) {
  assert.equal(response.data.clean.status, 'unchanged');
  assert.equal(response.data.clean.validatedVersionId, s.workVersion.id);
  assert.equal(response.data.clean.workSha256, sha256(s.buffer));
  assert.equal(response.data.clean.sourceSha256, originalHash);
  assert.equal(response.data.clean.beforeAfter.verified, true);
}
try {
const [a, b, c] = s.result.issues.map(key);
const unchangedBeforeRunControls = {bufferHash:sha256(s.buffer),versionId:s.workVersion.id,
  epoch:s.mutationEpoch||0,saveCount:savedVersionCount,persistCount:persistedSessionCount,
  applied:JSON.stringify(s.appliedFixes||[]),receipts:JSON.stringify(s.mutationReceipts||{})};
const assertRunControlUnchanged = () => {
  assert.equal(sha256(s.buffer),unchangedBeforeRunControls.bufferHash);
  assert.equal(s.workVersion.id,unchangedBeforeRunControls.versionId);
  assert.equal(s.mutationEpoch||0,unchangedBeforeRunControls.epoch);
  assert.equal(savedVersionCount,unchangedBeforeRunControls.saveCount);
  assert.equal(persistedSessionCount,unchangedBeforeRunControls.persistCount);
  assert.equal(JSON.stringify(s.appliedFixes||[]),unchangedBeforeRunControls.applied);
  assert.equal(JSON.stringify(s.mutationReceipts||{}),unchangedBeforeRunControls.receipts);
};
const missingRunControl=await call([a],{baseVersionId:initialVersionId,baseMutationEpoch:0,baseReviewRunId:undefined});
assert.equal(missingRunControl.status,409,
  'missing review run is rejected before a real source edit or storage write');
assert.equal(missingRunControl.data.code,'REVIEW_CONTEXT_REQUIRED');
assertRunControlUnchanged();
report.checks.push({name:'missing run rejects the actual handler without byte, version, epoch, receipt or storage changes',ok:true});
s.reviewRunId='completed-fixture-R2';s.resultRunId='completed-fixture-R2';
const oldRunControl=await call([a],{baseVersionId:initialVersionId,baseMutationEpoch:0,baseReviewRunId:selectedReviewRunId});
assert.equal(oldRunControl.status,409,
  'a same-version/epoch/key request selected from R1 cannot apply after completed R2');
assert.equal(oldRunControl.data.code,'REVIEW_CONTEXT_STALE');
assertRunControlUnchanged();
report.checks.push({name:'same version and epoch with old selected R1 rejects completed R2 without mutation',ok:true});
s.reviewRunId=selectedReviewRunId;s.resultRunId=selectedReviewRunId;
const initialProof = s.clean;
s.clean = { status: 'legacy-unverified' };
assert.equal((await call([a])).status, 409, 'real cleaning gate blocks an unverified fixture');
assert.equal(sha256(s.buffer), originalHash);
s.clean = initialProof;
report.checks.push({ name: 'actual cleaning gate with a valid OPC/version-bound proof', ok: true });
const first = await call([a]);
assert.equal(first.status, 200);
assert.equal(s.doc.paragraphs[0].text, 'LONGERXYZXYZ');
assert.equal(s.appliedFixes[0].sourceOffset, 0, 'verified unique source offset must be saved');
assertCleanProof(first);
report.checks.push({ name: 'unique reviewed source offset and long replacement', ok: true });
const second = await call([b]);
assert.equal(second.status, 200);
assert.equal(s.doc.paragraphs[0].text, 'LONGERXYZQ', 'second repeated text stays the second occurrence after length change');
assert.equal(s.appliedFixes[1].offset, 9);
assert.equal(s.appliedFixes[1].sourceOffset, 6);
assertCleanProof(second);
report.checks.push({ name: 'second repeated occurrence survives prior length change', ok: true });
const repeat = await call([b]);
assert.equal(repeat.data.applied.length, 0);
assert.equal(s.workVersion.revision, 2);
assertCleanProof(repeat);
const conflict = await call([c], { baseVersionId: initialVersionId });
assert.equal(conflict.status, 409);
report.checks.push({ name: 'repeated occurrence does not reapply; stale real version is rejected', ok: true });
const partial = await call([c], { baseVersionId: s.workVersion.id });
assert.equal(partial.data.applied.length, 1);
assert.equal(partial.data.skipped[0].reasonCode, 'unsupported_revision');
assert.ok(!partial.data.appliedFixes.includes(c), 'partial group cannot be resolved');
assert.equal(s.doc.paragraphs[0].text, 'LONGERRQ');
assert.equal(sha256(s.originalBuffer), sha256(original));
assertCleanProof(partial);
report.checks.push({ name: 'partial grouped change never resolves the protected occurrence or mutates original bytes', ok: true });

// A failed durable commit cannot advance either parsed text or current bytes.
s.result.issues.push({ ruleId: 'D', location: 'paragraph:1', paragraphIndex: 0, quote: 'new', autoFix: { find: 'Q', replace: 'END', offset: 7 } });
s.resultVersionId = s.workVersion.id;
s.resultTexts = captureReviewSource(s.doc, s.workVersion);
const before = { hash: sha256(s.buffer), text: s.doc.paragraphs[0].text, id: s.workVersion.id };
diskFailure = true;
const failed = await call([key(s.result.issues.at(-1))]);
assert.equal(failed.status, 500);
assert.equal(sha256(s.buffer), before.hash);
assert.equal(s.doc.paragraphs[0].text, before.text);
assert.equal(s.workVersion.id, before.id);
assert.equal(s.applyingFixes, false);
report.checks.push({ name: 'failed durable save retains current bytes, parsed text, version and releases mutation lock', ok: true });
s.reviewRunning = true;
assert.equal((await call([a])).status, 409);
report.checks.push({ name: 'active review lock rejects mutation', ok: true });
report.ok = true;
console.log('修改事务回归通过：重复原文位置、连续长替换、逐处身份、部分成功、过期版本、落盘失败与运行锁（模型调用 0）');
} catch (error) {
  report.ok = false; report.error = error.stack || String(error); process.exitCode = 1;
  console.error(report.error);
} finally {
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(`Evidence: ${OUT}`); }
}
