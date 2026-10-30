/** Software-only immutable conversion controls. Never opens Word or an actual manuscript. */
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, lstat, realpath, readdir, symlink, unlink, readlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve, join, dirname, relative, isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
const SCRIPT = fileURLToPath(import.meta.url), PROJECT = resolve(dirname(SCRIPT), '..');
const flag = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const sourceRoot = resolve(flag('source-root') || PROJECT), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const base = resolve(flag('evidence-root') || process.env.DSH_VERIFICATION_EVIDENCE_DIR || join(PROJECT, 'data/verify/doc-conversion-receipt'));
const within = (root, path) => { const r = relative(root, path); return !isAbsolute(r) && (r === '' || !r.startsWith('..')); };
assert(within(join(PROJECT, 'data/verify'), base) || within(join(PROJECT, 'data/optimization/runs'), base), 'Evidence must be in an authorized verification tree');
for (let cursor = base; ; cursor = dirname(cursor)) {
  assert(!existsSync(join(cursor, 'complete.json')), 'Sealed evidence ancestor');
  if (existsSync(cursor)) { const s = await lstat(cursor); assert(s.isDirectory() && !s.isSymbolicLink(), 'Evidence directory alias'); assert.equal(resolve(await realpath(cursor)), cursor); }
  if (dirname(cursor) === cursor) break;
}
const OUT = join(base, `doc-conversion-receipt-${Date.now()}-${randomUUID()}`); await mkdir(OUT, {recursive: true});
const sourcePaths = ['src/doc-conversion-receipt.js', 'src/docx.js', 'src/xml.js', 'src/zip.js', 'src/zip-write.js'];
const sourceBefore = {}; for (const path of sourcePaths) { const bytes = await readFile(join(sourceRoot, path)); sourceBefore[path] = sha(bytes); await writeFile(join(OUT, path.split('/').at(-1) + '.before'), bytes, {flag: 'wx'}); }
await writeFile(join(OUT, 'test-source.mjs'), await readFile(SCRIPT), {flag: 'wx'});
let deniedNetworkAttempts = 0; globalThis.fetch = () => { deniedNetworkAttempts++; throw Error('Conversion receipt tests forbid network'); };
const store = await import(pathToFileURL(join(sourceRoot, 'src/doc-conversion-receipt.js')));
const {writeZip} = await import(pathToFileURL(join(sourceRoot, 'src/zip-write.js')));
const convertedBytes = writeZip([
  {name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'},
  {name: 'word/document.xml', data: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Software provenance only 😀</w:t></w:r></w:p></w:body></w:document>'},
]);
const sourceBytes = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(504, 0)]);
const report = {schemaVersion: 1, kind: 'doc-conversion-receipt-software-tests', out: OUT, sourceRoot, sourceBefore, testSha256: sha(await readFile(SCRIPT)), checks: [], realArkCalls: 0, paidCalls: 0, httpCalls: 0, wordProcessActions: 0, actualManuscriptsRead: 0, businessStoreWrites: 0, independentQualityConfirmed: false, limitation: 'Generated OLE2-signature and DOCX fixtures certify archive mechanics only; no actual Word conversion, CFB-content fidelity or DOC upload admission.'};
async function check(name, action) { try { const detail = await action(); report.checks.push({name, ok: true, detail}); } catch (error) { report.checks.push({name, ok: false, error: {code: error.code, message: error.message, stack: error.stack}}); } }
async function rejects(action, codes) { await assert.rejects(action, error => codes.includes(error.code)); }
async function removeOwnedAlias(path, target) { assert(within(OUT, path)); assert((await lstat(path)).isSymbolicLink()); assert.equal(resolve(await readlink(path)), resolve(target)); await unlink(path); }
let ordinal = 0;
async function fixture(label, extra = {}) {
  const path = join(OUT, 'fixtures', `${++ordinal}-${label}`); await mkdir(path, {recursive: true});
  const assetId = extra.assetId || `asset-software-${ordinal}`, originalPath = extra.originalPath || `software/${label}.doc`, sourceChain = extra.sourceChain ?? null, archiveOrdinal = extra.archiveOrdinal ?? 0;
  const source = {path: join(path, 'input.doc'), sha256: sha(sourceBytes)}, converted = {path: join(path, 'input.docx'), sha256: sha(convertedBytes)};
  await writeFile(source.path, sourceBytes, {flag: 'wx'}); await writeFile(converted.path, convertedBytes, {flag: 'wx'});
  const record = {assetId, sourcePath: originalPath, sourceChain, archiveOrdinal, sourceSha256: source.sha256, convertedSha256: converted.sha256, status: 'partial', notes: {rawView: 'unchanged', rangeComparison: 'software-fixture'}, fullVisualFidelityVerified: false};
  const evidencePath = join(path, 'word-range.json'); const evidenceBytes = Buffer.from(JSON.stringify({results: [record]}) + '\n'); await writeFile(evidencePath, evidenceBytes, {flag: 'wx'});
  return {storageRoot: join(path, 'receipts'), assetId, originalPath, sourceChain, archiveOrdinal, source, converted, evidenceRefs: [{path: evidencePath, sha256: sha(evidenceBytes), kind: 'word-range-after', scope: 'Software generated range record; bytes and owner binding only. No visual or content-quality proof.', recordPath: ['results', 0]}]};
}
async function treeHashes(path) { const out = {}; async function visit(dir) { for (const name of (await readdir(dir)).sort()) { const p = join(dir, name), s = await lstat(p); if (s.isDirectory()) await visit(p); else if (s.isFile()) out[relative(path, p)] = sha(await readFile(p)); else throw Error('Unexpected tree link'); } } await visit(path); return out; }
await check('archive verifies and freezes exact bytes with mandatory partial and pending admission', async () => {
  const f = await fixture('happy'), saved = await store.archiveDocConversionReceipt(f), loaded = await store.loadDocConversionReceipt({storageRoot: f.storageRoot, archiveId: saved.receipt.archiveId, expectedReceiptSha256: saved.receiptSha256});
  assert.equal(saved.replayed, false); assert.deepEqual(saved.receipt, loaded.receipt); assert.equal(saved.receipt.status, 'partial'); assert.equal(saved.receipt.formatReady, false); assert.equal(saved.receipt.independentQuality, 'unverified'); assert.equal(saved.receipt.visual, 'unverified'); assert.equal(saved.receipt.reviewIntakeStatus, 'pending'); assert.equal(saved.receipt.currentDocUploadSupported, false);
  assert.deepEqual(await readFile(saved.sourcePath), sourceBytes); assert.deepEqual(await readFile(saved.convertedPath), convertedBytes); assert.equal(saved.receipt.parser.parsed, true); return {archiveId: saved.receipt.archiveId, receiptSha256: saved.receiptSha256};
});
await check('identical replay is read-only and altered evidence scope cannot overwrite prior receipt', async () => {
  const f = await fixture('replay'), a = await store.archiveDocConversionReceipt(f), before = await treeHashes(f.storageRoot), b = await store.archiveDocConversionReceipt(f);
  assert.equal(b.replayed, true); assert.equal(b.receiptSha256, a.receiptSha256); assert.deepEqual(await treeHashes(f.storageRoot), before);
  await rejects(() => store.archiveDocConversionReceipt({...f, evidenceRefs: [{...f.evidenceRefs[0], scope: 'Another scope declaration'}]}), ['CONVERSION_IMMUTABLE_CONFLICT']); assert.deepEqual(await treeHashes(f.storageRoot), before);
});
await check('same family and same source bytes retain distinct original assets and archival ordinals', async () => {
  const a = await fixture('family-a', {assetId: 'asset-software-family-a'}), b = await fixture('family-b', {assetId: 'asset-software-family-b'}), c = await fixture('family-c', {assetId: a.assetId, originalPath: a.originalPath, archiveOrdinal: 1});
  b.storageRoot = c.storageRoot = a.storageRoot; const result = await Promise.all([a, b, c].map(f => store.archiveDocConversionReceipt(f))); assert.equal(new Set(result.map(r => r.receipt.archiveId)).size, 3);
});
await check('derived chain binds content hash asset and real archive-member ordinal', async () => {
  const chain = [{assetId: 'asset-software-container', sourcePath: 'software/source.zip', sha256: 'c'.repeat(64)}, {kind: 'archive-member', ordinal: 2, name: 'members/paper.doc', derivedAssetId: 'derived-software-member', contentSha256: sha(sourceBytes)}];
  const f = await fixture('derived', {assetId: 'derived-software-member', sourceChain: chain, archiveOrdinal: 2}); const saved = await store.archiveDocConversionReceipt(f); assert.equal(saved.receipt.archiveOrdinal, 2); assert.deepEqual(saved.receipt.sourceChain, chain);
  for (const patch of [{sourceChain: null}, {archiveOrdinal: 3}, {sourceChain: [chain[0], {...chain[1], derivedAssetId: 'derived-other'}]}, {sourceChain: [chain[0], {...chain[1], contentSha256: 'f'.repeat(64)}]}]) await rejects(() => store.archiveDocConversionReceipt({...f, ...patch}), ['CONVERSION_SOURCE_CHAIN_MISMATCH']);
});
await check('passed formatReady quality visual and claimed upload support promotions are rejected', async () => {
  const f = await fixture('promotion'); for (const patch of [{status: 'passed'}, {formatReady: true}, {independentQuality: 'passed'}, {visual: 'verified'}, {currentDocUploadSupported: true}, {receipt: {status: 'passed'}}]) await rejects(() => store.archiveDocConversionReceipt({...f, ...patch}), ['CONVERSION_PROMOTION_FORBIDDEN', 'CONVERSION_INPUT_INVALID']); assert(!existsSync(f.storageRoot));
});
await check('wrong source converted or evidence SHA rejects before any completed archive', async () => {
  const f = await fixture('hash'); for (const patch of [{source: {...f.source, sha256: 'f'.repeat(64)}}, {converted: {...f.converted, sha256: 'f'.repeat(64)}}, {evidenceRefs: [{...f.evidenceRefs[0], sha256: 'f'.repeat(64)}]}]) await rejects(() => store.archiveDocConversionReceipt({...f, ...patch}), ['CONVERSION_HASH_MISMATCH']); assert.deepEqual(await readdir(f.storageRoot), []);
});
await check('raw non-OLE and fake DOCX packages cannot become conversion receipts', async () => {
  const f = await fixture('format'); const source = Buffer.from('not DOC'); await writeFile(f.source.path, source); await rejects(() => store.archiveDocConversionReceipt({...f, source: {...f.source, sha256: sha(source)}}), ['CONVERSION_DOC_INVALID']); await writeFile(f.source.path, sourceBytes);
  for (const bytes of [Buffer.from('not ZIP'), writeZip([{name: 'word/document.xml', data: '<bad/>'}])]) { await writeFile(f.converted.path, bytes); await rejects(() => store.archiveDocConversionReceipt({...f, converted: {...f.converted, sha256: sha(bytes)}}), ['CONVERSION_DOCX_INVALID']); }
});
await check('evidence cannot be relabeled from another asset source pair or source chain', async () => {
  const f = await fixture('foreign'); const bytes = await readFile(f.evidenceRefs[0].path), json = JSON.parse(bytes);
  for (const patch of [{assetId: 'asset-other'}, {sourceSha256: 'f'.repeat(64)}, {convertedSha256: 'f'.repeat(64)}, {sourcePath: 'other/paper.doc'}, {sourceChain: [{assetId: 'fake'}]}, {archiveOrdinal: 1}]) { const value = Buffer.from(JSON.stringify({results: [{...json.results[0], ...patch}]})); await writeFile(f.evidenceRefs[0].path, value); await rejects(() => store.archiveDocConversionReceipt({...f, evidenceRefs: [{...f.evidenceRefs[0], sha256: sha(value)}]}), ['CONVERSION_EVIDENCE_BINDING_MISMATCH']); }
});
await check('stored source converted and evidence tamper fails closed on load', async () => {
  const f = await fixture('tamper'), saved = await store.archiveDocConversionReceipt(f); for (const file of ['source.doc', 'converted.docx', 'evidence/0001.json']) { const path = join(saved.directory, file), before = await readFile(path); await writeFile(path, Buffer.concat([before, Buffer.from('X')])); await rejects(() => store.loadDocConversionReceipt({storageRoot: f.storageRoot, archiveId: saved.receipt.archiveId}), ['CONVERSION_HASH_MISMATCH']); await writeFile(path, before); }
});
await check('receipt hash pin and forged fixed-state receipt are not accepted', async () => {
  const f = await fixture('receipt'), saved = await store.archiveDocConversionReceipt(f); await rejects(() => store.loadDocConversionReceipt({storageRoot: f.storageRoot, archiveId: saved.receipt.archiveId, expectedReceiptSha256: 'f'.repeat(64)}), ['CONVERSION_HASH_MISMATCH']); const path = join(saved.directory, 'receipt.json'), value = JSON.parse(await readFile(path)); value.status = 'passed'; const forged = Buffer.from(JSON.stringify(value)), completePath = join(saved.directory, 'receipt.complete.json'), complete = JSON.parse(await readFile(completePath)); complete.receiptSha256 = sha(forged); const entry = complete.files.find(f => f.file === 'receipt.json'); entry.sha256 = sha(forged); entry.size = forged.length; await writeFile(path, forged); await writeFile(completePath, JSON.stringify(complete)); await rejects(() => store.loadDocConversionReceipt({storageRoot: f.storageRoot, archiveId: saved.receipt.archiveId}), ['CONVERSION_PROMOTION_FORBIDDEN']);
});
await check('archive traversal source traversal and dangerous record selectors are rejected', async () => {
  const f = await fixture('escape'); await rejects(() => store.loadDocConversionReceipt({storageRoot: f.storageRoot, archiveId: '../outside'}), ['CONVERSION_IDENTITY_INVALID']); await rejects(() => store.archiveDocConversionReceipt({...f, originalPath: '../source.doc'}), ['CONVERSION_PATH_INVALID']); await rejects(() => store.archiveDocConversionReceipt({...f, source: {...f.source, path: dirname(f.source.path) + '/sub/../input.doc'}}), ['CONVERSION_PATH_INVALID']); await rejects(() => store.archiveDocConversionReceipt({...f, evidenceRefs: [{...f.evidenceRefs[0], recordPath: ['__proto__']}]}), ['CONVERSION_EVIDENCE_INVALID']);
});
await check('source and evidence aliases are rejected even for reads', async () => {
  const f = await fixture('alias-input'), alias = join(dirname(f.source.path), 'alias'); await symlink(dirname(f.source.path), alias, process.platform === 'win32' ? 'junction' : 'dir'); try { await rejects(() => store.archiveDocConversionReceipt({...f, source: {...f.source, path: join(alias, 'input.doc')}}), ['CONVERSION_PATH_ALIAS']); await rejects(() => store.archiveDocConversionReceipt({...f, evidenceRefs: [{...f.evidenceRefs[0], path: join(alias, 'word-range.json')}]}), ['CONVERSION_PATH_ALIAS']); } finally { await removeOwnedAlias(alias, dirname(f.source.path)); }
});
await check('target alias and ancestor seal forbid writes while sealed evidence remains readable', async () => {
  const f = await fixture('sealed'); const saved = await store.archiveDocConversionReceipt(f), before = await treeHashes(f.storageRoot); const alias = join(dirname(f.storageRoot), 'alias-target'); await symlink(f.storageRoot, alias, process.platform === 'win32' ? 'junction' : 'dir'); try { await rejects(() => store.loadDocConversionReceipt({storageRoot: alias, archiveId: saved.receipt.archiveId}), ['CONVERSION_PATH_ALIAS']); await rejects(() => store.archiveDocConversionReceipt({...f, storageRoot: alias}), ['CONVERSION_PATH_ALIAS']); } finally { await removeOwnedAlias(alias, f.storageRoot); }
  await writeFile(join(f.storageRoot, 'complete.json'), '{}', {flag: 'wx'}); await rejects(() => store.archiveDocConversionReceipt(f), ['CONVERSION_TARGET_SEALED']); assert.equal((await store.loadDocConversionReceipt({storageRoot: f.storageRoot, archiveId: saved.receipt.archiveId})).receiptSha256, saved.receiptSha256); const after = await treeHashes(f.storageRoot); delete after['complete.json']; assert.deepEqual(after, before);
  await writeFile(join(dirname(f.source.path), 'complete.json'), '{}', {flag: 'wx'}); const g = await fixture('sealed-read'); g.source = f.source; g.converted = f.converted; g.evidenceRefs = f.evidenceRefs; g.assetId = f.assetId; g.originalPath = f.originalPath; const copy = await store.archiveDocConversionReceipt(g); assert.equal(copy.receipt.status, 'partial');
});
await check('source changed after verified read cannot publish a complete receipt', async () => {
  const f = await fixture('read-race'); let archiveId; await rejects(() => store.archiveDocConversionReceipt({...f, faultHooks: {afterInputsRead: async value => { archiveId = value.archiveId; await writeFile(f.source.path, Buffer.concat([sourceBytes, Buffer.from('changed')])); }}}), ['CONVERSION_INPUT_CHANGED']); assert(!existsSync(join(f.storageRoot, archiveId, 'receipt.complete.json')));
});
await check('evidence changed during archive cannot publish and partial bytes remain inspectable', async () => {
  const f = await fixture('commit-race'); let archiveId; await rejects(() => store.archiveDocConversionReceipt({...f, faultHooks: {beforeCommit: async value => { archiveId = value.archiveId; await writeFile(f.evidenceRefs[0].path, '{}'); }}}), ['CONVERSION_INPUT_CHANGED']); assert(existsSync(join(f.storageRoot, archiveId, 'source.doc'))); assert(!existsSync(join(f.storageRoot, archiveId, 'receipt.complete.json'))); await rejects(() => store.loadDocConversionReceipt({storageRoot: f.storageRoot, archiveId}), ['CONVERSION_ARCHIVE_INCOMPLETE']);
});
await check('concurrent identical creators publish one byte-identical complete identity', async () => {
  const f = await fixture('concurrent'), results = await Promise.all([store.archiveDocConversionReceipt(f), store.archiveDocConversionReceipt(f)]); assert.equal(results[0].receiptSha256, results[1].receiptSha256); assert.equal((await readdir(f.storageRoot)).length, 1); assert.equal((await store.loadDocConversionReceipt({storageRoot: f.storageRoot, archiveId: results[0].receipt.archiveId})).receiptSha256, results[0].receiptSha256);
});
report.sourceAfter = {}; for (const path of sourcePaths) report.sourceAfter[path] = sha(await readFile(join(sourceRoot, path)));
report.testSha256After = sha(await readFile(SCRIPT)); report.sourceFrozen = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter) && report.testSha256 === report.testSha256After; report.deniedNetworkAttempts = deniedNetworkAttempts;
report.ok = report.sourceFrozen && deniedNetworkAttempts === 0 && report.checks.every(c => c.ok); report.passed = report.checks.filter(c => c.ok).length; report.total = report.checks.length;
await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'}); console.log(JSON.stringify({ok: report.ok, passed: report.passed, total: report.total, sourceFrozen: report.sourceFrozen, report: join(OUT, 'report.json'), realArkCalls: 0, wordProcessActions: 0})); process.exitCode = report.ok ? 0 : 1;
