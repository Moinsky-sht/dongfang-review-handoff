/** Every source DOCX: exact non-comment bytes/text, residuals and idempotency. */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { cleanDocx, inspectDocxComments } from '../src/docx-clean.js';
import { scanCleanXml, deleteCleanSpans } from '../src/docx-clean-xml.js';
import { parseDocxBuffer } from '../src/docx.js';
import { openZip } from '../src/zip.js';
import { sha256 } from '../src/working-version.js';
import { CORPUS_ROOT, DSH_ROOT } from './paths.mjs';

const WORD = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const ANCHORS = new Set(['commentRangeStart', 'commentRangeEnd', 'commentReference', 'annotationRef']);
const PROTECTED = new Set(['t', 'delText', 'instrText', 'hyperlink', 'fldChar', 'fldSimple', 'bookmarkStart', 'bookmarkEnd', 'ins', 'del', 'moveFrom', 'moveTo', 'footnoteReference', 'endnoteReference']);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const textVector = (doc) => Object.fromEntries(['paragraphs', 'footnotes', 'endnotes'].map((key) => [key, (doc[key] || []).map((part) => part.text || '')]));
function protectedVector(bytes, part) {
  const scanned = scanCleanXml(bytes, part);
  const markers = scanned.nodes.filter((node) => WORD.has(node.ns) && ANCHORS.has(node.local));
  const out = [];
  for (const node of scanned.nodes) if (WORD.has(node.ns) && PROTECTED.has(node.local)) {
    const nested = markers.filter((marker) => marker.start >= node.start && marker.end <= node.end)
      .map((marker) => ({ start: marker.start - node.start, end: marker.end - node.start }));
    const xml = deleteCleanSpans(scanned.xml.slice(node.start, node.end), nested, part);
    out.push({ kind: node.local, sha256: sha256(xml) });
  }
  return out;
}
function runOne(item) {
  const record = { path: item.path, sourceSha256: item.sha256, status: 'failed', modelCalls: 0, realArkCalls: 0, checks: {} };
  const path = join(CORPUS_ROOT, item.path);
  let original;
  try {
    original = readFileSync(path); record.actualSourceSha256 = sha256(original);
    record.checks.manifestSourceMatches = record.actualSourceSha256 === item.sha256;
    const baselineDoc = parseDocxBuffer(original); const before = openZip(original);
    const result = cleanDocx(original); const output = result.buffer; const after = openZip(output);
    record.stats = result.stats; record.outputSha256 = sha256(output);
    const remaining = inspectDocxComments(output);
    record.checks.zeroCommentResiduals = ['comments', 'anchors', 'commentParts', 'relationships', 'contentTypes'].every((key) => remaining[key] === 0);
    record.checks.verifiedStats = result.stats.beforeAfter?.verified === true && result.stats.sourceSha256 === sha256(original) && result.stats.outputSha256 === sha256(output);
    const touched = new Set(result.stats.partsTouched); const removed = new Set(result.stats.partsRemoved);
    record.checks.packageEntryIdentity = equal(after.names, before.names.filter((name) => !removed.has(name)));
    record.checks.untargetedZipEntryBytes = before.names.every((name) => removed.has(name) || touched.has(name) || before.read(name).equals(after.read(name)));
    const media = before.names.filter((name) => /(?:^|\/)media\//.test(name));
    record.mediaParts = media.length;
    record.checks.allMediaBytesPreserved = media.every((name) => after.has(name) && before.read(name).equals(after.read(name)));
    const counts = {};
    record.checks.protectedXmlByteSpans = true;
    for (const name of before.names) if (!removed.has(name) && /\.xml$/i.test(name) && name !== '[Content_Types].xml') {
      const originalProtected = protectedVector(before.read(name), name);
      const outputProtected = touched.has(name) ? protectedVector(after.read(name), name) : originalProtected;
      for (const row of originalProtected) counts[row.kind] = (counts[row.kind] || 0) + 1;
      if (!equal(originalProtected, outputProtected)) record.checks.protectedXmlByteSpans = false;
    }
    record.protectedElements = counts;
    const outputDoc = parseDocxBuffer(output);
    record.checks.bodyAndNoteTextsUnchanged = equal(textVector(baselineDoc), textVector(outputDoc));
    record.checks.revisionsExact = equal(baselineDoc.revisions, outputDoc.revisions);
    record.checks.tableAndNoteStructure = baselineDoc.tables.length === outputDoc.tables.length
      && equal(baselineDoc.footnoteRefs || [], outputDoc.footnoteRefs || [])
      && ['paragraphs', 'footnotes', 'endnotes'].every((key) => equal((baselineDoc[key] || []).map((p) => [p.noteId ?? null, !!p.isNoteSeparator, !!p.inTable]), (outputDoc[key] || []).map((p) => [p.noteId ?? null, !!p.isNoteSeparator, !!p.inTable])));
    const second = cleanDocx(output);
    record.checks.exactByteIdempotency = second.buffer === output && second.buffer.equals(output) && second.stats.unchanged === true && second.stats.changed === false;
    record.checks.noTargetReturnsOriginalBytes = result.stats.changed || result.buffer === original;
    record.textVectorSha256 = sha256(JSON.stringify(textVector(baselineDoc)));
    record.protectedVectorSha256 = sha256(JSON.stringify(counts));
    record.checks.sourceOnDiskUnchanged = sha256(readFileSync(path)) === sha256(original);
    record.status = Object.values(record.checks).every(Boolean) ? 'passed' : 'failed';
  } catch (error) {
    record.errorCode = error.code || null; record.errorPart = error.part || null; record.error = error.stack || String(error);
    if (original) record.checks.sourceOnDiskUnchanged = sha256(readFileSync(path)) === sha256(original);
  }
  return record;
}
if (!isMainThread) {
  parentPort.on('message', ({ item }) => parentPort.postMessage(runOne(item)));
} else {
  const flag = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const OUT = resolve(DSH_ROOT, flag('out', `data/verify/corpus-clean-${Date.now()}.json`));
  const LOG = `${OUT}.jsonl`;
  if (existsSync(OUT) || existsSync(LOG)) throw new Error('Evidence exists; choose a fresh --out.');
  const threads = Math.max(1, Math.min(8, Number(flag('threads', process.env.DSH_CORPUS_THREADS || 4)) || 4));
  const limit = Number(flag('limit', 0)) || 0;
  const manifestBytes = readFileSync(resolve(DSH_ROOT, 'data/corpus/manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  let list = manifest.filter((item) => /\.docx$/i.test(item.path)); if (limit) list = list.slice(0, limit);
  const fingerprints = { testSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), cleanerSha256: sha256(readFileSync(resolve(DSH_ROOT, 'src/docx-clean.js'))), xmlHelperSha256: sha256(readFileSync(resolve(DSH_ROOT, 'src/docx-clean-xml.js'))) };
  mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(LOG, '', { flag: 'wx' });
  const results = new Map(); let next = 0; let completed = 0; const workers = [];
  console.log(`DOCX clean contract: ${list.length} actual source files, ${threads} workers, no model calls.`);
  try {
    await Promise.all(Array.from({ length: Math.min(threads, list.length) }, () => new Promise((done, reject) => {
      const worker = new Worker(new URL(import.meta.url)); workers.push(worker);
      const feed = () => { if (next >= list.length) { worker.terminate(); done(); return; } worker.postMessage({ item: list[next++] }); };
      worker.on('message', (record) => {
        const saved = { ...record, ...fingerprints }; results.set(record.path, saved); appendFileSync(LOG, JSON.stringify(saved) + '\n');
        completed += 1; if (completed % 25 === 0 || completed === list.length) console.log(`  ${completed}/${list.length}`); feed();
      }); worker.on('error', reject); feed();
    })));
  } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
  const rows = list.map((item) => results.get(item.path) || { path: item.path, status: 'not_completed' });
  const totals = (key) => rows.reduce((total, record) => total + (record.stats?.[key] || 0), 0);
  const report = { generatedAt: new Date().toISOString(), realArkCalls: 0, modelCalls: 0,
    ...fingerprints, manifestSha256: sha256(manifestBytes), total: list.length, passed: rows.filter((r) => r.status === 'passed').length,
    failed: rows.filter((r) => r.status === 'failed').length, notCompleted: rows.filter((r) => r.status === 'not_completed').length,
    changed: rows.filter((r) => r.stats?.changed).length, unchanged: rows.filter((r) => r.stats?.unchanged).length,
    removed: Object.fromEntries(['commentsRemoved', 'anchors', 'commentParts', 'commentRelationshipParts', 'relationships', 'contentTypes'].map((key) => [key, totals(key)])),
    explicitFailures: Object.fromEntries([...new Set(rows.filter((r) => r.errorCode).map((r) => r.errorCode))].map((code) => [code, rows.filter((r) => r.errorCode === code).length])),
    coverage: 'Every source DOCX individually: unchanged source SHA; zero supported OOXML comment residuals; untargeted ZIP entries/media byte-exact; all Word text/link/bookmark/field/revision spans unchanged after only comment-anchor deletion; body/footnote/endnote texts and parser revision vectors exact; second clean returns identical byte object. Unsupported source structures explicitly fail. No semantic review.',
    results: rows };
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`${report.passed}/${report.total} passed, ${report.failed} failed: ${OUT}`);
  process.exitCode = report.failed || report.notCompleted ? 1 : 0;
}
