/** Offline, per-file working-DOCX round trips. No model calls and no source writes.
 * node tools/test-corpus-patches.mjs --threads=4 --out=data/verify/corpus-patches.json
 * --resume resumes matching source/test/writer hashes from the adjacent JSONL.
 * Safe character replacements exercise software invariants, not editorial quality.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { parseDocxBuffer } from '../src/docx.js';
import { applyDocxPatches } from '../src/docx-patches.js';
import { openZip } from '../src/zip.js';
import { CORPUS_ROOT, DSH_ROOT } from './paths.mjs';

const hash = (x) => createHash('sha256').update(x).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const texts = (d) => Object.fromEntries(['paragraphs', 'footnotes', 'endnotes'].map((key) => [key, (d[key] || []).map((p) => p.text || '')]));
const structure = (d) => ({
  containers: Object.fromEntries(['paragraphs', 'footnotes', 'endnotes'].map((key) => [key, (d[key] || []).map((p) => ({ inTable: !!p.inTable, properties: p.properties, format: p.format, noteId: p.noteId ?? null, isNoteSeparator: !!p.isNoteSeparator }))])),
  comments: d.comments.length, revisions: d.revisions.length, tables: d.tables.length,
  footnoteRefs: d.footnoteRefs || [],
});
const PARTS = { body: 'word/document.xml', footnote: 'word/footnotes.xml', endnote: 'word/endnotes.xml' };
const PROTECTED_REASONS = new Set(['unsupported_revision', 'unsupported_field', 'unsupported_structure', 'unsupported_non_text', 'unsupported_boundary', 'unsupported_xml_text', 'signed_document']);
const SCOPES = [
  { label: 'body', target: 'body', key: 'paragraphs', matches: (p) => !p.inTable },
  { label: 'table', target: 'body', key: 'paragraphs', matches: (p) => !!p.inTable },
  { label: 'footnote', target: 'footnote', key: 'footnotes', matches: (p) => !p.isNoteSeparator },
  { label: 'endnote', target: 'endnote', key: 'endnotes', matches: (p) => !p.isNoteSeparator },
];
function candidateOffsets(text) {
  const offsets = [...text.matchAll(/[\p{L}\p{N}]/gu)].map((m) => m.index);
  if (!offsets.length) return [];
  // Probe separated text runs without changing fields, revisions or note markers.
  return [...new Set([offsets[0], offsets[Math.floor(offsets.length / 2)], offsets[offsets.length - 1]])];
}
function unchangedParts(before, after, changedParts) {
  const a = openZip(before), b = openZip(after);
  if (!equal([...a.names].sort(), [...b.names].sort())) return false;
  return a.names.every((name) => changedParts.has(name) || a.read(name).equals(b.read(name)));
}
function runOne(item) {
  const start = Date.now();
  const record = { path: item.path, sourceSha256: item.sha256, status: 'failed', scopes: [], checks: {}, modelCalls: 0 };
  try {
    const file = join(CORPUS_ROOT, item.path);
    const source = readFileSync(file);
    record.actualSourceSha256 = hash(source);
    record.checks.sourceMatchesManifest = record.actualSourceSha256 === item.sha256;
    const baselineDoc = parseDocxBuffer(source, item.path);
    const baseline = texts(baselineDoc);
    const baselineStructure = structure(baselineDoc);
    const expected = structuredClone(baseline);
    let working = Buffer.from(source);
    const applied = [];
    for (const scope of SCOPES) {
      const probes = [];
      let chosen = null;
      const possible = (baselineDoc[scope.key] || []).map((p, index) => ({ p, index })).filter(({ p }) => scope.matches(p) && /[\p{L}\p{N}]/u.test(p.text || ''));
      for (const { p, index } of possible) {
        for (const offset of candidateOffsets(p.text)) {
          const find = String.fromCodePoint(p.text.codePointAt(offset));
          const replace = '〔P0验收〕';
          const patch = { patchId: `roundtrip-${scope.label}`, target: scope.target, index, offset, find, replace };
          const result = applyDocxPatches(working, [patch]);
          if (result.applied.length === 1 && result.skipped.length === 0) {
            chosen = patch;
            working = result.buffer;
            const text = expected[scope.key][index];
            expected[scope.key][index] = text.slice(0, offset) + replace + text.slice(offset + find.length);
            applied.push({ patch, key: scope.key });
            break;
          }
          probes.push({ index, offset, reasons: result.skipped.map((x) => x.reasonCode || x.reason), unchangedBytes: result.buffer.equals(working) });
          if (!result.buffer.equals(working)) throw new Error(`Rejected ${scope.label} probe altered working bytes`);
        }
        if (chosen) break;
      }
      const observed = texts(parseDocxBuffer(working, 'roundtrip-working.docx'));
      const protectedSample = !chosen && probes.length > 0 && probes.every((p) => p.unchangedBytes && p.reasons.length > 0 && p.reasons.every((r) => PROTECTED_REASONS.has(r)));
      record.scopes.push({ scope: scope.label, status: chosen ? 'patched' : protectedSample ? 'protected_sample' : possible.length ? 'no_safe_sample' : 'not_present', candidateParagraphs: possible.length, chosen, rejectedProbes: probes, exactTextAfterStep: equal(observed, expected) });
      if (!equal(observed, expected)) throw new Error(`${scope.label}: changed unrelated or unexpected text`);
    }
    record.checks.atLeastOneActualPatch = applied.length > 0;
    record.checks.sampledScopesSafelyHandled = record.scopes.every((s) => s.status !== 'no_safe_sample');
    record.checks.forwardExactText = equal(texts(parseDocxBuffer(working, 'forward.docx')), expected);
    record.checks.forwardStructurePreserved = equal(structure(parseDocxBuffer(working, 'forward-structure.docx')), baselineStructure);
    const changedParts = new Set(applied.map(({ patch }) => PARTS[patch.target]));
    record.checks.untargetedZipEntriesUnchanged = unchangedParts(source, working, changedParts);
    record.forwardSha256 = hash(working);
    record.checks.realWorkingBytesChanged = hash(working) !== hash(source);
    for (const { patch } of [...applied].reverse()) {
      const reverse = { ...patch, patchId: `restore-${patch.patchId}`, find: patch.replace, replace: patch.find };
      const result = applyDocxPatches(working, [reverse]);
      if (result.applied.length !== 1 || result.skipped.length) throw new Error(`Restoration failed for ${patch.patchId}: ${result.skipped.map((x) => x.reasonCode).join(',')}`);
      working = result.buffer;
    }
    const restoredDoc = parseDocxBuffer(working, 'restored.docx');
    record.checks.restoredExactText = equal(texts(restoredDoc), baseline);
    record.checks.restoredStructurePreserved = equal(structure(restoredDoc), baselineStructure);
    record.checks.restoredUntargetedZipEntriesUnchanged = unchangedParts(source, working, changedParts);
    record.checks.sourceOnDiskUnchanged = hash(readFileSync(file)) === hash(source);
    record.textVectorSha256 = hash(JSON.stringify(baseline));
    record.restoredTextVectorSha256 = hash(JSON.stringify(texts(restoredDoc)));
    record.restoredDocxSha256 = hash(working);
    record.patchCount = applied.length;
    record.status = Object.values(record.checks).every(Boolean) ? 'passed' : 'failed';
  } catch (error) {
    record.error = error.stack || String(error);
  }
  record.elapsedMs = Date.now() - start;
  return record;
}
if (!isMainThread) {
  parentPort.on('message', ({ item, index }) => parentPort.postMessage({ index, result: runOne(item) }));
} else {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => args.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const OUT = resolve(DSH_ROOT, flag('out', 'data/verify/corpus-patches.json'));
  const LOG = `${OUT}.jsonl`;
  const THREADS = Math.max(1, Number(flag('threads', 4)) || 4);
  const LIMIT = Number(flag('limit', 0)) || 0;
  const resume = args.includes('--resume');
  const testSha256 = hash(readFileSync(fileURLToPath(import.meta.url)));
  const writerSha256 = hash(readFileSync(resolve(DSH_ROOT, 'src/docx-patches.js')));
  const manifestBytes = readFileSync(resolve(DSH_ROOT, 'data/corpus/manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  let list = manifest.filter((m) => /\.docx$/i.test(m.path));
  if (LIMIT) list = list.slice(0, LIMIT);
  const results = new Map();
  if (existsSync(LOG)) {
    if (!resume) throw new Error(`Evidence already exists: ${LOG}. Choose another --out or explicitly --resume.`);
    for (const line of readFileSync(LOG, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.testSha256 === testSha256 && rec.writerSha256 === writerSha256 && rec.status === 'passed') results.set(`${rec.path}|${rec.sourceSha256}`, rec);
      } catch { /* An interrupted final line is not a completed file. */ }
    }
  }
  mkdirSync(dirname(OUT), { recursive: true });
  if (!existsSync(LOG)) writeFileSync(LOG, '', { flag: 'wx' });
  const todo = list.filter((m) => !results.has(`${m.path}|${m.sha256}`));
  const start = Date.now();
  let next = 0, completed = 0;
  console.log(`Corpus DOCX roundtrip: ${list.length} files, ${todo.length} pending, ${THREADS} workers, no model calls.`);
  const workers = [];
  try {
    await Promise.all(Array.from({ length: Math.min(THREADS, todo.length) }, () => new Promise((done, reject) => {
      const worker = new Worker(new URL(import.meta.url));
      workers.push(worker);
      const feed = () => {
        if (next >= todo.length) { worker.terminate(); done(); return; }
        const index = next++;
        worker.postMessage({ index, item: todo[index] });
      };
      worker.on('message', ({ result }) => {
        const record = { ...result, testSha256, writerSha256 };
        appendFileSync(LOG, JSON.stringify(record) + '\n', 'utf8');
        results.set(`${result.path}|${result.sourceSha256}`, record);
        completed++;
        if (completed % 25 === 0 || completed === todo.length) console.log(`  ${completed}/${todo.length} finished`);
        feed();
      });
      worker.on('error', reject);
      feed();
    })));
  } finally {
    for (const worker of workers) await worker.terminate();
  }
  const rows = list.map((m) => results.get(`${m.path}|${m.sha256}`) || { path: m.path, sourceSha256: m.sha256, status: 'not_completed' });
  const report = {
    generatedAt: new Date().toISOString(), modelCalls: 0, corpusRoot: CORPUS_ROOT,
    manifestSha256: hash(manifestBytes), writerSha256, testSha256,
    total: list.length, passed: rows.filter((r) => r.status === 'passed').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    notCompleted: rows.filter((r) => r.status === 'not_completed').length,
    filesWithProtectedSamples: rows.filter((r) => r.scopes?.some((s) => s.status === 'protected_sample')).length,
    patchedScopes: Object.fromEntries(SCOPES.map((s) => [s.label, rows.filter((r) => r.scopes?.some((x) => x.scope === s.label && x.status === 'patched')).length])),
    coverageNote: 'Every passing file has at least one real safe patch and exact restored text. Each existing body/table/note scope is sampled; rejected protected samples remain explicit. This does not test every text range or editorial accuracy.',
    excludedLegacyDoc: manifest.filter((m) => /\.doc$/i.test(m.path)).length,
    elapsedMs: Date.now() - start, results: rows,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`Roundtrip: ${report.passed}/${report.total} passed, ${report.failed} failed, ${report.notCompleted} not completed. ${OUT}`);
  process.exitCode = report.failed || report.notCompleted ? 1 : 0;
}
