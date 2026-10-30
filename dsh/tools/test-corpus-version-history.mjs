/** All formal DOCX files: immutable store/read/undo-byte/redo-byte acceptance.
 * Only in-memory copies are patched; original corpus paths are never written.
 * node tools/test-corpus-version-history.mjs --threads=4 --out=data/verify/corpus-history.json
 * --storage-root selects an isolated experiment store; defaults to OUT.store.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parseDocxBuffer } from '../src/docx.js';
import { applyDocxPatches } from '../src/docx-patches.js';
import * as storage from '../src/working-version.js';
import { CORPUS_ROOT, DSH_ROOT } from './paths.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const vector = (d) => Object.fromEntries(['paragraphs', 'footnotes', 'endnotes'].map((key) => [key, (d[key] || []).map((p) => p.text || '')]));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function runOne(item, storageRoot) {
  const start = Date.now();
  const record = { path: item.path, sourceSha256: item.sha256, status: 'failed', modelCalls: 0, checks: {}, rejectedProbes: [] };
  try {
    const file = join(CORPUS_ROOT, item.path);
    const source = readFileSync(file);
    const sourceSha = hash(source);
    record.actualSourceSha256 = sourceSha;
    record.checks.sourceMatchesManifest = sourceSha === item.sha256;
    const doc = parseDocxBuffer(source, item.path);
    const baseline = vector(doc);
    let patch = null, patched = null;
    for (const [index, p] of doc.paragraphs.entries()) {
      const offsets = [...String(p.text || '').matchAll(/[\p{L}\p{N}]/gu)].map((m) => m.index);
      if (!offsets.length) continue;
      for (const offset of [...new Set([offsets[0], offsets[Math.floor(offsets.length / 2)], offsets[offsets.length - 1]])]) {
        const candidate = { patchId: 'history-roundtrip', target: 'body', index, offset, find: String.fromCodePoint(p.text.codePointAt(offset)), replace: '〔版本验收〕' };
        const attempt = applyDocxPatches(Buffer.from(source), [candidate]);
        if (attempt.applied.length === 1 && attempt.skipped.length === 0) { patch = candidate; patched = attempt.buffer; break; }
        record.rejectedProbes.push({ index, offset, reasons: attempt.skipped.map((x) => x.reasonCode), bytesUnchanged: attempt.buffer.equals(source) });
        if (!attempt.buffer.equals(source)) throw new Error('Rejected range changed source-copy bytes');
      }
      if (patch) break;
    }
    if (!patch) throw new Error('No safe actual patch was found for this file');
    record.patch = patch;
    const expected = structuredClone(baseline);
    const text = expected.paragraphs[patch.index];
    expected.paragraphs[patch.index] = text.slice(0, patch.offset) + patch.replace + text.slice(patch.offset + patch.find.length);
    record.checks.patchChangesOnlyExpectedText = equal(vector(parseDocxBuffer(patched, 'patched.docx')), expected);
    record.checks.realPatchedBytesChanged = hash(patched) !== sourceSha;
    const sessionId = `s${hash(Buffer.from(item.path)).slice(0, 24)}`;
    record.sessionId = sessionId;
    const v0 = await storage.saveWorkingVersion({ sessionId, name: item.path, buffer: source, originalBuffer: source, operation: 'history-test-import', storageRoot });
    const v1 = await storage.saveWorkingVersion({ sessionId, name: item.path, buffer: patched, originalBuffer: source, parent: v0, patches: [patch], operation: 'history-test-fix', storageRoot });
    record.versions = { initial: v0, fixed: v1 };
    record.checks.versionChain = v0.revision === 0 && v1.revision === 1 && v1.parentId === v0.id && v1.id !== v0.id;
    record.checks.versionSourceHashesStable = v0.sourceSha256 === sourceSha && v1.sourceSha256 === sourceSha;
    record.checks.versionWorkingHashesExact = v0.sha256 === sourceSha && v1.sha256 === hash(patched);
    const initial = await storage.loadWorkingVersion({ sessionId, versionId: v0.id, storageRoot });
    const fixed = await storage.loadWorkingVersion({ sessionId, versionId: v1.id, storageRoot });
    record.checks.readInitialExactlyMatchesSourceBytes = Buffer.from(initial.buffer).equals(source);
    record.checks.readFixedExactlyMatchesPatchedBytes = Buffer.from(fixed.buffer).equals(patched);
    record.checks.originalByteCopiesRemainExact = Buffer.from(initial.originalBuffer).equals(source) && Buffer.from(fixed.originalBuffer).equals(source);
    // Undo/redo select archived bytes, not reverse text substitution/repackaging.
    const undo = await storage.loadWorkingVersion({ sessionId, versionId: v0.id, storageRoot });
    const redo = await storage.loadWorkingVersion({ sessionId, versionId: v1.id, storageRoot });
    record.checks.undoRestoresEveryOriginalByte = Buffer.from(undo.buffer).equals(source);
    record.checks.redoRestoresEveryFixedByte = Buffer.from(redo.buffer).equals(patched);
    record.checks.undoAndRedoTextReopens = equal(vector(parseDocxBuffer(undo.buffer, 'undo.docx')), baseline) && equal(vector(parseDocxBuffer(redo.buffer, 'redo.docx')), expected);
    const versionsDirectory = join(storageRoot, sessionId);
    const stem0 = v0.id.split(':')[1], stem1 = v1.id.split(':')[1];
    const archivedFiles = ['original.docx', `${stem0}.docx`, `${stem0}.json`, `${stem0}.complete.json`, `${stem1}.docx`, `${stem1}.json`, `${stem1}.complete.json`];
    const immutableBefore = archivedFiles.map((name) => ({ name, sha256: hash(readFileSync(join(versionsDirectory, name))) }));
    const repeatedSave = await storage.saveWorkingVersion({ sessionId, name: item.path, buffer: patched, originalBuffer: source, parent: v0, patches: [patch], operation: 'history-test-fix', storageRoot });
    const immutableAfter = archivedFiles.map((name) => ({ name, sha256: hash(readFileSync(join(versionsDirectory, name))) }));
    record.checks.archivesNeverOverwritten = equal(immutableBefore, immutableAfter) && repeatedSave.id === v1.id;
    record.archivedFileHashes = immutableAfter;
    record.checks.sourceOnDiskUnchanged = hash(readFileSync(file)) === sourceSha;
    record.undoSha256 = hash(undo.buffer);
    record.redoSha256 = hash(redo.buffer);
    record.status = Object.values(record.checks).every(Boolean) ? 'passed' : 'failed';
  } catch (error) { record.error = error.stack || String(error); }
  record.elapsedMs = Date.now() - start;
  return record;
}
if (!isMainThread) {
  parentPort.on('message', async ({ index, item }) => parentPort.postMessage({ index, result: await runOne(item, workerData.storageRoot) }));
} else {
  if (typeof storage.loadWorkingVersion !== 'function') throw new Error('loadWorkingVersion is not available yet; run after the storage API is implemented');
  const args = process.argv.slice(2);
  const flag = (name, fallback) => args.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const OUT = resolve(DSH_ROOT, flag('out', 'data/verify/corpus-version-history.json'));
  const LOG = `${OUT}.jsonl`;
  const storageRoot = resolve(DSH_ROOT, flag('storage-root', `${OUT}.store`));
  const THREADS = Math.max(1, Number(flag('threads', 4)) || 4);
  const LIMIT = Number(flag('limit', 0)) || 0;
  const resume = args.includes('--resume');
  const testSha256 = hash(readFileSync(fileURLToPath(import.meta.url)));
  const writerSha256 = hash(readFileSync(resolve(DSH_ROOT, 'src/docx-patches.js')));
  const storageModuleSha256 = hash(readFileSync(resolve(DSH_ROOT, 'src/working-version.js')));
  const manifestBytes = readFileSync(resolve(DSH_ROOT, 'data/corpus/manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  let list = manifest.filter((m) => /\.docx$/i.test(m.path));
  if (LIMIT) list = list.slice(0, LIMIT);
  const results = new Map();
  if (existsSync(LOG)) {
    if (!resume) throw new Error(`Evidence exists: ${LOG}; choose a new --out or explicitly --resume`);
    const prior = readFileSync(LOG, 'utf8');
    for (const line of prior.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.testSha256 === testSha256 && rec.writerSha256 === writerSha256 && rec.storageModuleSha256 === storageModuleSha256 && rec.status === 'passed' && existsSync(join(storageRoot, rec.sessionId))) results.set(`${rec.path}|${rec.sourceSha256}`, rec);
      } catch { /* An interrupted line is never a completed file. */ }
    }
    if (prior && !prior.endsWith('\n')) appendFileSync(LOG, '\n');
  }
  mkdirSync(dirname(OUT), { recursive: true });
  mkdirSync(storageRoot, { recursive: true });
  if (!existsSync(LOG)) writeFileSync(LOG, '', { flag: 'wx' });
  const todo = list.filter((m) => !results.has(`${m.path}|${m.sha256}`));
  console.log(`Corpus immutable history: ${list.length} files, ${todo.length} pending, ${THREADS} workers, no model calls.`);
  const start = Date.now();
  let next = 0, completed = 0;
  const workers = [];
  try {
    await Promise.all(Array.from({ length: Math.min(THREADS, todo.length) }, () => new Promise((done, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { storageRoot } });
      workers.push(worker);
      const feed = () => {
        if (next >= todo.length) { worker.terminate(); done(); return; }
        const index = next++;
        worker.postMessage({ index, item: todo[index] });
      };
      worker.on('message', ({ result }) => {
        const row = { ...result, testSha256, writerSha256, storageModuleSha256 };
        appendFileSync(LOG, JSON.stringify(row) + '\n', 'utf8');
        results.set(`${row.path}|${row.sourceSha256}`, row);
        completed++;
        if (completed % 25 === 0 || completed === todo.length) console.log(`  ${completed}/${todo.length} finished`);
        feed();
      });
      worker.on('error', reject);
      feed();
    })));
  } finally { for (const worker of workers) await worker.terminate(); }
  const rows = list.map((m) => results.get(`${m.path}|${m.sha256}`) || { path: m.path, sourceSha256: m.sha256, status: 'not_completed' });
  const summary = {
    generatedAt: new Date().toISOString(), modelCalls: 0, corpusRoot: CORPUS_ROOT, storageRoot,
    manifestSha256: hash(manifestBytes), testSha256, writerSha256, storageModuleSha256,
    total: rows.length, passed: rows.filter((r) => r.status === 'passed').length,
    failed: rows.filter((r) => r.status === 'failed').length, notCompleted: rows.filter((r) => r.status === 'not_completed').length,
    excludedLegacyDoc: manifest.filter((m) => /\.doc$/i.test(m.path)).length,
    elapsedMs: Date.now() - start, coverageNote: 'Each DOCX has one safe actual patch, immutable save/read, exact source-byte undo, exact patched-byte redo and unchanged source-file SHA. This is software history acceptance, not manuscript-quality evaluation.', results: rows,
  };
  writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(`Immutable history: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.notCompleted} not completed. ${OUT}`);
  process.exitCode = summary.failed || summary.notCompleted ? 1 : 0;
}
