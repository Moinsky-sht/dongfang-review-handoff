/** HTTP acceptance for the real working DOCX. Never invokes a model.
 * node tools/test-working-version.mjs --base=http://127.0.0.1:3210
 * node tools/test-working-version.mjs --capture-old --out=tmp/p0-01-old-repro.json
 * BASE_URL also selects the server; artifacts contain only the software sample.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDocxBuffer } from '../src/docx.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const BASE = flag('base', process.env.BASE_URL || process.env.BASE || 'http://127.0.0.1:3210').replace(/\/$/, '');
const CAPTURE_OLD = args.includes('--capture-old');
const OUT = resolve(ROOT, flag('out', CAPTURE_OLD ? 'tmp/p0-01-old-repro.json' : 'data/verify/working-version.json'));
const SAMPLE = resolve(ROOT, flag('sample', 'samples/test.docx'));
const hash = (x) => createHash('sha256').update(x).digest('hex');
const issueKey = (x) => `${x.ruleId}|${x.location}|${x.quote || ''}`;
const snapshot = (doc) => ({
  paragraphs: (doc?.paragraphs || []).map((p) => p.text || ''),
  footnotes: (doc?.footnotes || []).map((p) => p.text || ''),
  endnotes: (doc?.endnotes || []).map((p) => p.text || ''),
});
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const report = { generatedAt: new Date().toISOString(), mode: CAPTURE_OLD ? 'old-service-reproduction' : 'acceptance', base: BASE, modelCalls: 0, checks: [], stages: [] };
function check(ok, name, details = {}) {
  report.checks.push({ name, ok: !!ok, ...details });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
function save() {
  mkdirSync(dirname(OUT), { recursive: true });
  report.passed = report.checks.filter((x) => x.ok).length;
  report.failed = report.checks.filter((x) => !x.ok).length;
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
}
async function request(path, { json, bytes } = {}) {
  const res = await fetch(BASE + path, {
    method: json || bytes ? 'POST' : 'GET',
    headers: json ? { 'content-type': 'application/json' } : bytes ? { 'content-type': 'application/octet-stream' } : {},
    body: json ? JSON.stringify(json) : bytes,
    signal: AbortSignal.timeout(120000),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  let data = null;
  if (/json/i.test(res.headers.get('content-type') || '')) {
    try { data = JSON.parse(buffer.toString('utf8')); } catch { /* Assert status below. */ }
  }
  return { status: res.status, ok: res.ok, buffer, data, headers: Object.fromEntries(res.headers) };
}
async function fileAt(path, label) {
  const r = await request(path);
  const rec = { label, status: r.status, sha256: hash(r.buffer), bytes: r.buffer.length };
  if (r.ok && !r.data) {
    try { rec.text = snapshot(parseDocxBuffer(r.buffer, label)); }
    catch (e) { rec.parseError = e.message; }
  }
  report.stages.push(rec);
  return { ...r, rec };
}
function targetOf(it) {
  if (Number.isInteger(it.paragraphIndex)) return ['paragraphs', it.paragraphIndex];
  if (Number.isInteger(it.footnoteIndex)) return ['footnotes', it.footnoteIndex];
  if (Number.isInteger(it.endnoteIndex)) return ['endnotes', it.endnoteIndex];
  return null;
}
function applyExpected(doc, issue) {
  const out = structuredClone(doc);
  const items = issue.occurrences?.length ? issue.occurrences.map((x) => ({ ...issue, ...x, autoFix: x.autoFix || issue.autoFix })) : [issue];
  items.sort((a, b) => (b.autoFix?.offset ?? b.offset ?? 0) - (a.autoFix?.offset ?? a.offset ?? 0));
  for (const it of items) {
    const target = targetOf(it);
    if (!target) throw new Error('Sample auto-fix has no target');
    const [kind, index] = target;
    const text = out[kind][index];
    const find = it.autoFix.find;
    const start = it.autoFix.offset ?? it.offset ?? text.indexOf(find);
    if (start < 0 || text.slice(start, start + find.length) !== find) throw new Error('Sample fix does not match its exact source offset');
    out[kind][index] = text.slice(0, start) + (it.autoFix.replace || '') + text.slice(start + find.length);
  }
  return out;
}
try {
  const source = readFileSync(SAMPLE);
  report.source = { path: SAMPLE, sha256: hash(source), bytes: source.length };
  const uploaded = await request(`/api/upload?name=${encodeURIComponent(basename(SAMPLE))}`, { bytes: source });
  check(uploaded.ok && !!uploaded.data?.id, 'sample upload');
  if (!uploaded.data?.id) throw new Error(`Upload failed: HTTP ${uploaded.status}`);
  const id = uploaded.data.id;
  report.sessionId = id;
  const reviewed = await request('/api/review', { json: { id, useModel: false } });
  check(reviewed.ok && Array.isArray(reviewed.data?.issues), 'deterministic review');
  if (!reviewed.ok || !Array.isArray(reviewed.data?.issues)) throw new Error('Deterministic review returned no issues');
  const initial = await request(`/api/session?id=${id}`);
  const baseline = snapshot(initial.data?.doc || uploaded.data.doc);
  const original = await fileAt(`/api/session-file?id=${id}&original=1`, 'original-before');
  const workingBefore = await fileAt(`/api/session-file?id=${id}`, 'working-before');
  check(original.ok && hash(original.buffer) === hash(source), 'original bytes equal uploaded bytes before changes');
  check(equal(workingBefore.rec.text, baseline), 'working bytes and session text agree before changes');

  const candidates = reviewed.data.issues.filter((x) => targetOf(x) && x.autoFix?.find && x.autoFix.find !== x.autoFix.replace && !x.occurrences?.length);
  // Prefer different targets. If both are in one target, apply the later offset first.
  let selected = [];
  for (const x of candidates) {
    if (!selected.length || JSON.stringify(targetOf(x)) !== JSON.stringify(targetOf(selected[0]))) selected.push(x);
    if (selected.length === 2) break;
  }
  if (selected.length < 2) selected = candidates.sort((a, b) => (b.autoFix.offset ?? 0) - (a.autoFix.offset ?? 0)).slice(0, 2);
  check(selected.length === 2, 'sample provides two independently applicable auto-fixes', { candidates: candidates.length });
  if (selected.length < 2) throw new Error('Need two sample auto-fixes; choose another software sample with --sample');
  report.selected = selected.map((x) => ({ key: issueKey(x), ruleId: x.ruleId, target: targetOf(x), autoFix: x.autoFix }));
  let expected = baseline;
  let lastVersion = initial.data?.workVersion ?? uploaded.data.workVersion;
  const startingVersion = lastVersion;
  const selectionReviewRunId = initial.data?.reviewRunId;
  check(Number.isInteger(lastVersion?.revision) && lastVersion.revision === 0 && !!lastVersion.id, 'session exposes initial workVersion', { observed: lastVersion ?? null });
  check(lastVersion?.sha256 === hash(workingBefore.buffer) && lastVersion?.sourceSha256 === hash(source), 'initial workVersion hashes identify working bytes and original input');
  for (const [i, issue] of selected.entries()) {
    expected = applyExpected(expected, issue);
    const fixed = await request('/api/apply-fixes', { json: { id, accepted: [issueKey(issue)], baseVersionId: lastVersion?.id, baseReviewRunId: selectionReviewRunId } });
    check(fixed.ok && fixed.data?.applied?.length > 0, `apply fix ${i + 1}`, { status: fixed.status, applied: fixed.data?.applied?.length ?? 0, skipped: fixed.data?.skipped || [] });
    const serialized = snapshot(fixed.data?.doc);
    check(equal(serialized, expected), `fix ${i + 1} changes only expected text`);
    const working = await fileAt(`/api/session-file?id=${id}`, `working-after-${i + 1}`);
    check(working.ok && equal(working.rec.text, serialized), `fix ${i + 1} is stored in real DOCX bytes`);
    check(equal(working.rec.text, expected), `fix ${i + 1} DOCX contains all consecutive changes`);
    const restored = await request(`/api/session?id=${id}`);
    check(equal(snapshot(restored.data?.doc), expected), `session restore after fix ${i + 1} preserves text`);
    const nextVersion = restored.data?.workVersion;
    check(Number.isInteger(nextVersion?.revision) && nextVersion.revision === lastVersion?.revision + 1, `fix ${i + 1} increments workVersion once`, { previous: lastVersion ?? null, observed: nextVersion ?? null });
    check(!!nextVersion?.id && nextVersion.id !== lastVersion?.id && nextVersion.parentId === lastVersion?.id, `fix ${i + 1} creates a linked working version`);
    check(nextVersion?.sha256 === hash(working.buffer) && nextVersion?.sha256 !== lastVersion?.sha256 && nextVersion?.sourceSha256 === hash(source), `fix ${i + 1} records exact working hash with stable source hash`);
    lastVersion = restored.data?.workVersion;
    report.stages.push({ label: `fix-${i + 1}-response`, text: serialized, workVersion: lastVersion ?? null, applied: fixed.data?.applied || [] });
  }
  const beforeRepeat = await fileAt(`/api/session-file?id=${id}`, 'before-repeat');
  if (startingVersion?.id) {
    const stale = await request('/api/apply-fixes', { json: { id, accepted: [issueKey(selected[0])], baseVersionId: startingVersion.id, baseReviewRunId: selectionReviewRunId } });
    check(stale.status === 409, 'stale working version is rejected before applying text', { status: stale.status });
  }
  const repeated = await request('/api/apply-fixes', { json: { id, accepted: selected.map(issueKey), baseVersionId: lastVersion?.id, baseReviewRunId: selectionReviewRunId } });
  const afterRepeat = await fileAt(`/api/session-file?id=${id}`, 'after-repeat');
  const restored = await request(`/api/session?id=${id}`);
  check(repeated.ok && (repeated.data?.applied?.length ?? -1) === 0, 'duplicate submission applies no second change');
  check(hash(beforeRepeat.buffer) === hash(afterRepeat.buffer), 'duplicate submission leaves working bytes unchanged');
  check(!!lastVersion?.id && restored.data?.workVersion?.id === lastVersion.id && restored.data.workVersion.revision === lastVersion.revision && restored.data.workVersion.sha256 === lastVersion.sha256, 'duplicate submission leaves workVersion unchanged', { observed: restored.data?.workVersion ?? null });
  check(equal(snapshot(restored.data?.doc), expected), 'restored session preserves both changes');
  check(selected.every((x) => (restored.data?.appliedFixes || []).includes(issueKey(x))), 'restored session identifies both applied issues');
  const originalAfter = await fileAt(`/api/session-file?id=${id}&original=1`, 'original-after');
  check(originalAfter.ok && hash(originalAfter.buffer) === hash(source), 'original bytes remain unchanged after fixes');
  const currentExport = await fileAt(`/api/export-working-docx?id=${id}`, 'working-export');
  check(currentExport.ok && equal(currentExport.rec.text, expected), 'export current working DOCX reopens with both changes', { status: currentExport.status });
  check(currentExport.ok && hash(currentExport.buffer) === hash(afterRepeat.buffer), 'current export and reader share identical working bytes');
  const commentExport = await request('/api/export-docx', { json: { id } });
  const commentStage = { label: 'commented-export', status: commentExport.status, sha256: hash(commentExport.buffer), added: Number(commentExport.headers['x-comments-added'] || 0) };
  if (commentExport.ok && !commentExport.data) {
    try {
      const doc = parseDocxBuffer(commentExport.buffer, 'commented-export.docx');
      commentStage.text = snapshot(doc);
      commentStage.comments = doc.comments.length;
    } catch (e) { commentStage.parseError = e.message; }
  }
  report.stages.push(commentStage);
  check(commentExport.ok && equal(commentStage.text, expected), 'commented export uses the current working text');
  check(commentStage.added > 0 && commentStage.comments > 0, 'commented export retains valid Word comments');
  report.workVersion = { start: startingVersion ?? null, end: restored.data?.workVersion ?? null };
} catch (e) {
  report.error = e.stack || String(e);
  check(false, 'test completes', { error: e.message });
} finally {
  save();
}
console.log(`Working DOCX acceptance: ${report.passed} passed / ${report.failed} failed. ${OUT}`);
process.exitCode = CAPTURE_OLD ? 0 : report.failed ? 1 : 0;
