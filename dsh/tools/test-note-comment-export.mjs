/** Word-compatible note export correspondence; software fixtures, no server/model. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const SCRIPT = fileURLToPath(import.meta.url);
const PROJECT = resolve(dirname(SCRIPT), '..');
const inheritedEvidence = process.env.DSH_VERIFICATION_EVIDENCE_DIR;
const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const phase = flag('phase') || 'full';
assert.ok(['red', 'full'].includes(phase));
const within = (base, path) => { const rel = relative(resolve(base), resolve(path)); return !rel.startsWith('..') && !isAbsolute(rel); };
const current = JSON.parse(await readFile(join(PROJECT, 'tmp/endnote-current-run.json'), 'utf8'));
const currentRun = resolve(current.runDirectory);
const verifyRoot = join(PROJECT, 'data/verify');
const projectRunRoot = join(PROJECT, 'data/optimization/runs');
const assignedRunEvidence = inheritedEvidence && resolve(inheritedEvidence) !== projectRunRoot
  && within(projectRunRoot, inheritedEvidence) ? resolve(inheritedEvidence) : null;
const evidenceRoot = resolve(flag('evidence-root') || inheritedEvidence || join(verifyRoot, 'note-comment-export'));
assert.ok(within(verifyRoot, evidenceRoot) || within(currentRun, evidenceRoot)
  || assignedRunEvidence && within(assignedRunEvidence, evidenceRoot), 'evidence must stay in data/verify, the sample run, or an assigned project run');
async function checkEvidencePath(path) {
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    assert.ok(!existsSync(join(cursor, 'complete.json')), `sealed ancestor cannot receive evidence: ${cursor}`);
    try {
      const info = await lstat(cursor);
      assert.ok(info.isDirectory() && !info.isSymbolicLink());
      assert.equal(resolve(await realpath(cursor)), cursor, 'evidence cannot traverse aliases');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(cursor) === cursor) break;
  }
}
await checkEvidencePath(evidenceRoot);
for (const key of Object.keys(process.env)) if (/^(?:DSH_|NODE_OPTIONS|NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/i.test(key)
  || /(?:ARK|OPENAI|DOUBAO|VOLC|ANTHROPIC)/i.test(key)) delete process.env[key];
await mkdir(evidenceRoot, { recursive: true });
const RUN = join(evidenceRoot, `note-comment-export-${phase}-${Date.now()}-${randomUUID()}`);
await mkdir(RUN);
const ENV_ROOTS = { DSH_SESSION_ROOT: 'sessions', DSH_WORKING_VERSION_ROOT: 'versions', DSH_WORKSPACE_ROOT: 'workspaces',
  DSH_AUDIT_ROOT: 'audit', DSH_LEGACY_ROOT: 'legacy', DSH_INGESTION_ROOT: 'ingestions', DSH_JOB_ROOT: 'jobs' };
const ROOTS = Object.fromEntries(Object.entries(ENV_ROOTS).map(([key, leaf]) => { process.env[key] = join(RUN, leaf); return [leaf, process.env[key]]; }));
await Promise.all(Object.values(ROOTS).map((path) => mkdir(path)));
const { buildCommentedDocx } = await import('../src/docx-comments.js');
const { parseDocxBuffer } = await import('../src/docx.js');
const { computeAnchor } = await import('../src/anchors.js');
const { openZip } = await import('../src/zip.js');
const { writeZip } = await import('../src/zip-write.js');
const { parseXml } = await import('../src/xml.js');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SOURCE_FILES = ['src/docx-comments.js', 'src/docx.js', 'src/xml.js', 'src/anchors.js', 'src/zip.js', 'src/zip-write.js'];
const sourceHashes = Object.fromEntries(await Promise.all(SOURCE_FILES.map(async (path) => [path, sha(await readFile(join(PROJECT, path)))])));
const report = { generatedAt: new Date().toISOString(), run: RUN, evidenceRoot, phase, roots: ROOTS, rootCount: 7,
  softwareOnly: true, realArkCalls: 0, paidModelCalls: 0, meaningfulModelResponses: 0, apiRequests: 0, serversStarted: 0,
  manuscriptContentJudgment: false, wordApplicationRenderingVerified: false, sourceHashes, testSha256: sha(await readFile(SCRIPT)), checks: [] };
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/package/2006/relationships';
const COMMENT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const COMMENT_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const fixedDate = '2026-10-09T00:00:00.000Z';
const textRun = (text) => `<w:r><w:t>${text}</w:t></w:r>`;
const para = (...children) => `<w:p>${children.join('')}</w:p>`;
const ref = (kind, id) => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${kind}Reference w:id="${id}"/></w:r>`;
const note = (kind, id, content, type = '') => `<w:${kind} w:id="${id}"${type ? ` w:type="${type}"` : ''}>${content}</w:${kind}>`;
const notes = (kind, content) => `<w:${kind}s xmlns:w="${W}">${content}</w:${kind}s>`;
function fixture({ body, footnotes, endnotes, documentRels = true, extra = {} }) {
  const parts = { '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${R}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    'custom/untargeted.bin': 'untargeted\u0000bytes', ...extra };
  if (footnotes) parts['word/footnotes.xml'] = footnotes;
  if (endnotes) parts['word/endnotes.xml'] = endnotes;
  for (const kind of ['footnote', 'endnote']) if (parts[`word/${kind}s.xml`]) {
    parts['[Content_Types].xml'] = parts['[Content_Types].xml'].replace('</Types>', `<Override PartName="/word/${kind}s.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}s+xml"/></Types>`);
  }
  if (documentRels) {
    let xml = parts['word/_rels/document.xml.rels'] || `<Relationships xmlns="${R}"></Relationships>`;
    for (const kind of ['footnote', 'endnote']) if (parts[`word/${kind}s.xml`]) xml = xml.replace('</Relationships>', `<Relationship Id="rId${kind}s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}s" Target="${kind}s.xml"/></Relationships>`);
    parts['word/_rels/document.xml.rels'] = xml;
  }
  return writeZip(Object.entries(parts).map(([name, value]) => ({ name, data: Buffer.from(value) })));
}
const issue = (target, index, text, start = 0, extra = {}) => ({ ruleId: 'SOFTWARE-ONLY-NOTE', title: '软件范围探针', severity: '中',
  location: `${target}:${index}`, [`${target}Index`]: index, quote: text,
  anchor: { target, index, start, end: start + text.length, text, precision: 'exact' }, ...extra });
function assertUntouched(before, after) {
  const a = openZip(before); const b = openZip(after);
  const changed = new Set(['word/document.xml', 'word/comments.xml', '[Content_Types].xml', 'word/_rels/document.xml.rels']);
  for (const name of a.names) if (!changed.has(name)) assert.deepEqual(b.read(name), a.read(name), `untargeted part changed: ${name}`);
  assert.ok(b.names.every((name) => a.has(name) || ['word/comments.xml', 'word/_rels/document.xml.rels'].includes(name)));
  const source = parseDocxBuffer(before); const parsed = parseDocxBuffer(after);
  for (const kind of ['paragraphs', 'footnotes', 'endnotes']) assert.deepEqual(parsed[kind].map((p) => p.text), source[kind].map((p) => p.text));
  for (const kind of ['footnote', 'endnote']) {
    const oldRefs = parseXml(a.readText('word/document.xml')).descendants(`w:${kind}Reference`).map((n) => n.attr('w:id'));
    const newRefs = parseXml(b.readText('word/document.xml')).descendants(`w:${kind}Reference`).map((n) => n.attr('w:id'));
    assert.deepEqual(newRefs, oldRefs, 'reference identity/order remains unchanged');
  }
}
function assertPairs(result) {
  const zip = openZip(result.buffer); const body = parseXml(zip.readText('word/document.xml'));
  const comments = parseXml(zip.readText('word/comments.xml'));
  const rels = parseXml(zip.readText('word/_rels/document.xml.rels'));
  const rel = rels.descendants('Relationship').find((n) => n.attr('Type') === COMMENT_REL);
  assert.ok(rel && rel.attr('Target') === 'comments.xml' && zip.has('word/comments.xml'), 'MainDocument comments relationship has an actual target');
  const ids = result.placements.flatMap((p) => p.targets.map((t) => String(t.commentId)));
  assert.equal(ids.length, result.added); assert.equal(new Set(ids).size, ids.length);
  const bodyXml = zip.readText('word/document.xml'); const parsed = parseDocxBuffer(result.buffer);
  for (const placement of result.placements) for (const target of placement.targets) {
    const id = String(target.commentId); const found = parsed.comments.find((comment) => comment.id === id);
    assert.equal(found?.part, 'document.xml'); assert.equal(found?.paragraphIndex, target.paragraphIndex);
    if (target.reference) {
      const start = body.descendants('w:commentRangeStart').find((node) => node.attr('w:id') === id);
      const end = body.descendants('w:commentRangeEnd').find((node) => node.attr('w:id') === id);
      const range = parseXml(bodyXml.slice(start.openEnd, end.openStart));
      assert.equal(range.descendants(`w:${target.reference.kind}Reference`).length, 1, 'the actual comment range contains the intended reference');
      assert.equal(range.descendants(`w:${target.reference.kind}Reference`)[0].attr('w:id'), placement.source.noteId);
      assert.equal(range.descendants('w:t').length, 0, 'note-reference precision must not include adjacent manuscript text');
    }
  }
  for (const id of ids) for (const tag of ['commentRangeStart', 'commentRangeEnd', 'commentReference']) {
    const found = body.descendants(`w:${tag}`).filter((n) => n.attr('w:id') === id);
    assert.equal(found.length, 1, `${tag} pair for ${id}`);
    assert.equal(tag === 'commentReference' ? found[0].parent.parent.name : found[0].parent.name, 'w:p');
  }
  for (const id of ids) assert.equal(comments.descendants('w:comment').filter((n) => n.attr('w:id') === id).length, 1);
  assert.ok(parseXml(zip.readText('[Content_Types].xml')).descendants('Override').some((n) => n.attr('PartName') === '/word/comments.xml' && n.attr('ContentType') === COMMENT_CT));
}
async function check(name, fn, red = false) {
  if (phase === 'red' && !red) return;
  try { const detail = await fn(); report.checks.push({ name, ok: true, detail: detail || null }); }
  catch (error) { report.checks.push({ name, ok: false, error: error.message, stack: error.stack?.split('\n').slice(0, 5) }); }
}
const runMeta = JSON.parse(await readFile(join(currentRun, 'run.json'), 'utf8'));
await check('real 43 endnotes map to body references and original note bytes stay intact', async () => {
  const src = await readFile(runMeta.realSample.path); assert.equal(sha(src), runMeta.realSample.sha256);
  const doc = parseDocxBuffer(src); const selected = doc.endnotes.map((p, index) => ({ p, index })).filter(({ p }) => !p.isNoteSeparator);
  assert.equal(selected.length, 43);
  const issues = selected.map(({ p, index }) => { const it = issue('endnote', index, p.text.slice(2, 3), 2); it.anchor = computeAnchor(it, doc); return it; });
  const result = buildCommentedDocx({ buffer: src, issues, author: '软件探针', date: fixedDate });
  assert.equal(result.added, 43); assert.equal(result.skipped, 0);
  assert.deepEqual(openZip(result.buffer).read('word/endnotes.xml'), openZip(src).read('word/endnotes.xml'), 'Word ignores note-internal comment markers; notes must not be modified');
  assert.equal(result.placementSchemaVersion, 1); assert.equal(result.addedIssues, 43);
  assert.equal(result.placements.length, 43);
  assert.deepEqual(result.placements.map((p) => p.source.noteId), selected.map(({ p }) => p.noteId));
  for (const p of result.placements) {
    assert.equal(p.precision, 'reference-target'); assert.equal(p.degradation.code, 'word-note-comments-unsupported');
    assert.equal(p.source.start, 2); assert.equal(p.source.end, 3); assert.equal(p.source.text.length, 1);
    assert.equal(p.targets.length, 1); assert.equal(p.targets[0].reference.noteId, p.source.noteId);
    assert.equal(p.targets[0].precision, 'note-reference');
    assert.equal(p.targets[0].xmlRange.unit, 'xml-utf16');
  }
  assertPairs(result); assertUntouched(src, result.buffer);
  await writeFile(join(RUN, 'real-43-commented.docx'), result.buffer, { flag: 'wx' });
  assert.equal(sha(await readFile(runMeta.realSample.path)), runMeta.realSample.sha256);
  return { sourcePath: runMeta.realSample.path, sourceSha256: sha(src), added: result.added, addedIssues: result.addedIssues,
    ordinaryNotes: selected.length, placements: result.placements, noteBytesUnchanged: true };
}, true);
await check('new MainDocument relationship is appended while note relationships stay untouched', () => {
  const src = fixture({ body: para(textRun('正文'), ref('endnote', 7)), endnotes: notes('endnote', note('endnote', 7, para(textRun('注内范围')))),
    documentRels: false, extra: { 'word/_rels/endnotes.xml.rels': `<Relationships xmlns="${R}"><Relationship Id="rIdKeep" Type="urn:software:keep" Target="../custom/untargeted.bin"/></Relationships>` } });
  const out = buildCommentedDocx({ buffer: src, issues: [issue('endnote', 0, '范围', 2)], date: fixedDate });
  assert.equal(out.added, 1); assert.ok(openZip(out.buffer).has('word/_rels/document.xml.rels'));
  assertPairs(out); assertUntouched(src, out.buffer); return { placements: out.placements };
}, true);
await check('multi-paragraph and table notes use the enclosing actual note ID', () => {
  const table = `<w:tbl><w:tr><w:tc>${para(textRun('表内同文'))}</w:tc></w:tr></w:tbl>`;
  const src = fixture({ body: para(ref('endnote', 7), ref('endnote', 9)), endnotes: notes('endnote',
    note('endnote', -1, para('<w:r><w:separator/></w:r>'), 'separator') + note('endnote', 7, para(textRun('第一同文')) + table + para(textRun('最后同文'))) + note('endnote', 9, para(textRun('另一同文')))) });
  const out = buildCommentedDocx({ buffer: src, issues: [issue('endnote', 2, '同文', 2), issue('endnote', 3, '同文', 2), issue('endnote', 4, '同文', 2)], date: fixedDate });
  assert.equal(out.added, 3); assert.deepEqual(out.placements.map((p) => p.source.noteId), ['7', '7', '9']);
  assertPairs(out); assertUntouched(src, out.buffer);
});
await check('equal footnote/endnote text and equal numeric IDs stay distinct', () => {
  const src = fixture({ body: para(ref('footnote', 7), ref('endnote', 7)), footnotes: notes('footnote', note('footnote', 7, para(textRun('相同文字')))), endnotes: notes('endnote', note('endnote', 7, para(textRun('相同文字')))) });
  const out = buildCommentedDocx({ buffer: src, issues: [issue('footnote', 0, '文字', 2), issue('endnote', 0, '文字', 2)], date: fixedDate });
  assert.equal(out.added, 2); assert.deepEqual(out.placements.map((p) => p.targets[0].reference.kind), ['footnote', 'endnote']);
  assertPairs(out); assertUntouched(src, out.buffer);
});
await check('duplicate references are all enumerated even at the same text offset', () => {
  const src = fixture({ body: para(textRun('甲'), ref('endnote', 7), ref('endnote', 7), textRun('乙')), endnotes: notes('endnote', note('endnote', 7, para(textRun('注内文字')))) });
  const out = buildCommentedDocx({ buffer: src, issues: [issue('endnote', 0, '文字', 2)], date: fixedDate });
  assert.equal(out.added, 2); assert.equal(out.addedIssues, 1); assert.equal(out.placements.length, 1);
  assert.deepEqual(out.placements[0].targets.map((t) => t.reference.occurrence), [0, 1]);
  assert.deepEqual(out.placements[0].targets.map((t) => t.reference.offset), [1, 1]);
  assertPairs(out); assertUntouched(src, out.buffer);
});
await check('orphan and separator notes are explicitly skipped without added success', () => {
  const src = fixture({ body: para(textRun('正文')), endnotes: notes('endnote', note('endnote', -1, para(textRun('分隔')), 'separator') + note('endnote', 7, para(textRun('孤儿文字')))) });
  const out = buildCommentedDocx({ buffer: src, issues: [issue('endnote', 0, '分隔'), issue('endnote', 1, '文字', 2)] });
  assert.equal(out.buffer, src); assert.equal(out.added, 0); assert.equal(out.skipped, 2);
  assert.deepEqual(out.skippedDetails.map((p) => p.reasonCode), ['separator_note', 'orphan_note']);
});
await check('stale ranges, ambiguous unpositioned text and identity mismatch never search first', () => {
  const src = fixture({ body: para(ref('endnote', 7)), endnotes: notes('endnote', note('endnote', 7, para(textRun('同文同文')))) });
  const ambiguous = { ruleId: 'SOFTWARE-ONLY', endnoteIndex: 0, quote: '同文' };
  const wrongId = issue('endnote', 0, '同文'); wrongId.anchor.noteId = '8';
  const out = buildCommentedDocx({ buffer: src, issues: [issue('endnote', 0, '同文', 1), ambiguous, wrongId] });
  assert.equal(out.buffer, src); assert.equal(out.added, 0); assert.equal(out.skipped, 3);
  assert.deepEqual(out.skippedDetails.map((p) => p.reasonCode), ['stale_source_range', 'ambiguous_source_range', 'source_identity_mismatch']);
});
await check('version and actual working bytes fence matching-text stale anchors', () => {
  const src = fixture({ body: para(ref('endnote', 7)), endnotes: notes('endnote', note('endnote', 7, para(textRun('注内文字')))) });
  const stale = issue('endnote', 0, '文字', 2); stale.anchor.workVersionId = 'software-v0';
  const out = buildCommentedDocx({ buffer: src, issues: [stale], workVersionId: 'software-v1', workSha256: sha(src) });
  assert.equal(out.added, 0); assert.equal(out.skippedDetails[0].reasonCode, 'source_version_mismatch');
  const wrongBytes = buildCommentedDocx({ buffer: src, issues: [issue('endnote', 0, '文字', 2)], workVersionId: 'software-v1', workSha256: '0'.repeat(64) });
  assert.equal(wrongBytes.added, 0); assert.equal(wrongBytes.skippedDetails[0].reasonCode, 'work_hash_mismatch');
});
await check('conflicting source scope fields and duplicate note IDs are refused', () => {
  const src = fixture({ body: para(ref('endnote', 7)), endnotes: notes('endnote', note('endnote', 7, para(textRun('注内文字'))) + note('endnote', 7, para(textRun('另一文字')))) });
  const conflict = issue('endnote', 0, '文字', 2, { paragraphIndex: 0 });
  const out = buildCommentedDocx({ buffer: src, issues: [conflict, issue('endnote', 1, '文字', 2)] });
  assert.equal(out.added, 0); assert.deepEqual(out.skippedDetails.map((p) => p.reasonCode), ['conflicting_source_target', 'ambiguous_note_id']);
});
await check('hidden fields and deleted references cannot serve as visible Word targets', () => {
  const hidden = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' + ref('endnote', 7) + '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const src = fixture({ body: para(hidden, `<w:del>${ref('endnote', 9)}</w:del>`), endnotes: notes('endnote', note('endnote', 7, para(textRun('隐藏文字'))) + note('endnote', 9, para(textRun('删除文字')))) });
  const out = buildCommentedDocx({ buffer: src, issues: [issue('endnote', 0, '文字', 2), issue('endnote', 1, '文字', 2)] });
  assert.equal(out.added, 0); assert.deepEqual(out.skippedDetails.map((p) => p.reasonCode), ['orphan_note', 'orphan_note']);
});
await check('mixed reference/text run refuses the whole issue instead of pretending exact placement', () => {
  const mixed = '<w:r><w:t>甲</w:t><w:endnoteReference w:id="7"/><w:t>乙</w:t></w:r>';
  const src = fixture({ body: para(ref('endnote', 7), mixed), endnotes: notes('endnote', note('endnote', 7, para(textRun('注内文字')))) });
  const out = buildCommentedDocx({ buffer: src, issues: [issue('endnote', 0, '文字', 2)] });
  assert.equal(out.added, 0); assert.equal(out.skippedDetails[0].reasonCode, 'unsupported_reference_structure');
  assert.equal(out.skippedDetails[0].targets.length, 2); assert.equal(out.buffer, src);
});
await check('existing comment root attributes and relationship IDs remain intact', () => {
  const old = `<w:comment w:id="4" w:author="original">${para(textRun('原批注'))}</w:comment>`;
  const opening = `<w:comments xmlns:w="${W}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14">`;
  const src = fixture({ body: para(textRun('正文'), ref('endnote', 7)), endnotes: notes('endnote', note('endnote', 7, para(textRun('注内文字')))), extra: {
    'word/comments.xml': `${opening}${old}</w:comments>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${R}"><Relationship Id="rIdComments1" Type="urn:software:keep" Target="../custom/untargeted.bin"/></Relationships>` } });
  const out = buildCommentedDocx({ buffer: src, issues: [issue('endnote', 0, '文字', 2)] });
  const zip = openZip(out.buffer); assert.ok(zip.readText('word/comments.xml').startsWith(opening)); assert.ok(zip.readText('word/comments.xml').includes(old));
  assert.equal(out.placements[0].targets[0].commentId, '5');
  const relationships = parseXml(zip.readText('word/_rels/document.xml.rels')).descendants('Relationship');
  assert.equal(new Set(relationships.map((n) => n.attr('Id'))).size, relationships.length);
  assert.ok(relationships.find((n) => n.attr('Id') === 'rIdComments1').attr('Type') === 'urn:software:keep');
  assertPairs(out); assertUntouched(src, out.buffer);
});
await check('textbox nested paragraphs cannot overwrite the enclosing note identity', () => {
  const box = '<w:r><w:drawing><w:txbxContent>' + para(textRun('框内')) + '</w:txbxContent></w:drawing></w:r>';
  const src = fixture({ body: para(ref('endnote', 7), ref('endnote', 9)), endnotes: notes('endnote', note('endnote', 7, para(textRun('首注文字'), box)) + note('endnote', 9, para(textRun('后注文字')))) });
  const out = buildCommentedDocx({ buffer: src, issues: [issue('endnote', 1, '文字', 2)] });
  assert.equal(out.added, 1); assert.equal(out.placements[0].source.noteId, '9'); assert.equal(out.placements[0].targets[0].reference.noteId, '9');
  assertPairs(out); assertUntouched(src, out.buffer);
});
await check('merged occurrences enumerate source ranges without dropping later notes', () => {
  const src = fixture({ body: para(ref('endnote', 7), ref('endnote', 9)), endnotes: notes('endnote', note('endnote', 7, para(textRun('首注文字'))) + note('endnote', 9, para(textRun('后注文字')))) });
  const first = issue('endnote', 0, '文字', 2); first.anchors = [first.anchor, issue('endnote', 1, '文字', 2).anchor];
  const out = buildCommentedDocx({ buffer: src, issues: [first] });
  assert.equal(out.added, 2); assert.equal(out.addedIssues, 1); assert.equal(out.placements.length, 2);
  assert.deepEqual(out.placements.map((p) => p.source.noteId), ['7', '9']); assertPairs(out); assertUntouched(src, out.buffer);
});
await check('body table reference target uses the current body paragraph identity', () => {
  const table = `<w:tbl><w:tr><w:tc>${para(textRun('表格'), ref('footnote', 7))}</w:tc></w:tr></w:tbl>`;
  const src = fixture({ body: para(textRun('首段')) + table, footnotes: notes('footnote', note('footnote', 7, para(textRun('注内文字')))) });
  const out = buildCommentedDocx({ buffer: src, issues: [issue('footnote', 0, '文字', 2)] });
  assert.equal(out.placements[0].targets[0].paragraphIndex, 1); assert.equal(out.placements[0].targets[0].pid, 'document.xml:1');
  assertPairs(out); assertUntouched(src, out.buffer);
});
await check('legacy body paragraph comments disclose paragraph precision and preserve text', () => {
  const src = fixture({ body: para('<w:pPr><w:jc w:val="left"/></w:pPr>', textRun('正文文字')) });
  const out = buildCommentedDocx({ buffer: src, issues: [issue('paragraph', 0, '文字', 2)] });
  assert.equal(out.added, 1); assert.equal(out.placements[0].precision, 'paragraph');
  assert.ok(openZip(out.buffer).readText('word/document.xml').includes('<w:pPr><w:jc w:val="left"/></w:pPr><w:commentRangeStart'));
  assertPairs(out); assertUntouched(src, out.buffer);
});
await check('legacy indexes keep body paragraph precision and verify unique note text without a first-match guess', () => {
  const src = fixture({ body: para(textRun('上下文问题文字'), ref('endnote', 7)), endnotes: notes('endnote', note('endnote', 7, para(textRun('注内唯一文字')))) });
  const body = { ruleId: 'SOFTWARE-ONLY', paragraphIndex: 0, quote: '上下文问题', offset: 3 };
  const noteIssue = { ruleId: 'SOFTWARE-ONLY', endnoteIndex: 0, quote: '注内唯一文字', autoFix: { find: '唯一', offset: 1 } };
  const out = buildCommentedDocx({ buffer: src, issues: [body, noteIssue] });
  assert.equal(out.added, 2); assert.equal(out.placements[0].source.text, '上下文问题文字');
  assert.equal(out.placements[0].source.rangeProof, 'legacy-paragraph'); assert.equal(out.placements[0].precision, 'paragraph');
  assert.equal(out.placements[1].source.start, 2); assert.equal(out.placements[1].source.rangeProof, 'unique-exact-text');
  assertPairs(out); assertUntouched(src, out.buffer);
});
await check('old unpaired marker IDs cannot collide with newly added comments', () => {
  const marker = '<w:commentRangeStart w:id="12"/>';
  const src = fixture({ body: para(marker, textRun('旧标记')) + para(ref('endnote', 7)), endnotes: notes('endnote', note('endnote', 7, para(textRun('注内文字')))) });
  const out = buildCommentedDocx({ buffer: src, issues: [issue('endnote', 0, '文字', 2)] });
  assert.equal(out.placements[0].targets[0].commentId, '13'); assertPairs(out); assertUntouched(src, out.buffer);
  assert.ok(openZip(out.buffer).readText('word/document.xml').includes(marker));
});
await check('UTF-16/entity ranges are verified and empty or split-surrogate note ranges are refused', () => {
  const src = fixture({ body: para(ref('endnote', 7)), endnotes: notes('endnote', note('endnote', 7, para(textRun('😀甲&amp;乙')))) });
  const out = buildCommentedDocx({ buffer: src, issues: [issue('endnote', 0, '甲&', 2)] });
  assert.equal(out.added, 1); assert.equal(out.placements[0].source.text, '甲&'); assert.equal(out.placements[0].source.rangeUnit, 'utf16');
  assertPairs(out); assertUntouched(src, out.buffer);
  const half = issue('endnote', 0, '\uDE00', 1); const empty = issue('endnote', 0, '', 0);
  const rejected = buildCommentedDocx({ buffer: src, issues: [half, empty] });
  assert.equal(rejected.added, 0); assert.equal(rejected.buffer, src);
  assert.deepEqual(rejected.skippedDetails.map((p) => p.reasonCode), ['invalid_source_range', 'invalid_source_range']);
});
await check('legal closing-tag whitespace is kept outside generated comment markers', () => {
  const sourceRef = ref('endnote', 7).replace('</w:r>', '</w:r  >');
  const pPr = '<w:pPr><w:jc w:val="left"/></w:pPr >';
  const src = fixture({ body: para(pPr, textRun('正文文字'), sourceRef), endnotes: notes('endnote', note('endnote', 7, para(textRun('注内文字')))) });
  const out = buildCommentedDocx({ buffer: src, issues: [issue('paragraph', 0, '文字', 2), issue('endnote', 0, '文字', 2)] });
  const xml = openZip(out.buffer).readText('word/document.xml');
  assert.ok(xml.includes('</w:pPr ><w:commentRangeStart'), 'body marker follows the actual complete property closing tag');
  assert.ok(xml.includes('</w:r  ><w:commentRangeEnd'), 'note marker follows the actual complete run closing tag');
  assertPairs(out); assertUntouched(src, out.buffer);
});
report.finalSourceHashes = Object.fromEntries(await Promise.all(SOURCE_FILES.map(async (path) => [path, sha(await readFile(join(PROJECT, path)))])));
report.sourceChanged = JSON.stringify(report.sourceHashes) !== JSON.stringify(report.finalSourceHashes);
report.finishedAt = new Date().toISOString(); report.passed = report.checks.filter((c) => c.ok).length;
report.failed = report.checks.length - report.passed; report.ok = report.failed === 0 && !report.sourceChanged;
await checkEvidencePath(RUN);
await writeFile(join(RUN, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ report: join(RUN, 'report.json'), phase, passed: report.passed, failed: report.failed, ok: report.ok, sourceChanged: report.sourceChanged, realArkCalls: 0 }));
process.exitCode = report.ok ? 0 : 1;
