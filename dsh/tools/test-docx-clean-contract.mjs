/** Exact-span cleaning contracts, including fixtures that the previous cleaner missed. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { cleanDocx, inspectDocxComments } from '../src/docx-clean.js';
import { openZip } from '../src/zip.js';
import { writeZip } from '../src/zip-write.js';
import { parseDocxBuffer } from '../src/docx.js';
import { sha256 } from '../src/working-version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) || `data/verify/docx-clean-${Date.now()}.json`);
if (existsSync(OUT)) throw new Error('Evidence exists; choose a fresh --out.');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const STRICT_W = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const R = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const COMMENT_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const oldPath = resolve(ROOT, 'data/optimization/runs/p0-03-migration-20261009001155/before/src/docx-clean.js');
const oldSource = existsSync(oldPath) ? readFileSync(oldPath, 'utf8') : null;
const oldClean = oldSource ? runInNewContext(oldSource.replace(/^import .*;\r?\n/gm, '').replace('export function cleanDocx', 'function cleanDocx') + '\ncleanDocx;', { openZip, writeZip, Buffer }) : null;
const report = { generatedAt: new Date().toISOString(), realArkCalls: 0, modelCalls: 0, checks: [],
  testSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), cleanerSha256: sha256(readFileSync(resolve(ROOT, 'src/docx-clean.js'))),
  xmlHelperSha256: sha256(readFileSync(resolve(ROOT, 'src/docx-clean-xml.js'))), oldCleanerSha256: oldSource ? sha256(oldSource) : null };
const types = (extra = '') => `<ct:Types xmlns:ct='${CT}'><ct:Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/><ct:Default Extension='xml' ContentType='application/xml'/><ct:Override PartName='/word/document.xml' ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'/>${extra}</ct:Types>`;
const document = (body, prefix = 'w', ns = W) => `<${prefix}:document xmlns:${prefix}='${ns}' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'><${prefix}:body>${body}<${prefix}:sectPr/></${prefix}:body></${prefix}:document>`;
const comments = (prefix = 'w', ns = W) => `<${prefix}:comments xmlns:${prefix}='${ns}'><${prefix}:comment ${prefix}:id='0'><${prefix}:p><${prefix}:r><${prefix}:t>软件批注内容</${prefix}:t></${prefix}:r></${prefix}:p></${prefix}:comment></${prefix}:comments>`;
const rels = (rows, prefix = '') => prefix ? `<${prefix}:Relationships xmlns:${prefix}='${R}'>${rows}</${prefix}:Relationships>` : `<Relationships xmlns='${R}'>${rows}</Relationships>`;
const relation = (id, target, type = COMMENT_TYPE, prefix = '', mode = '') => `<${prefix ? prefix + ':' : ''}Relationship Id='${id}' Type='${type}' Target='${target}'${mode ? ` TargetMode='${mode}'` : ''}/>`;
const override = (part, mime = MIME) => `<ct:Override PartName='/${part}' ContentType='${mime}'/>`;
const packageOf = (xml, extra = {}, declarations = '') => writeZip([
  { name: '[Content_Types].xml', data: types(declarations) }, { name: 'word/document.xml', data: xml },
  { name: 'word/media/software.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  ...Object.entries(extra).map(([name, data]) => ({ name, data })),
]);
const anchors = (prefix = 'w') => [`<${prefix}:commentRangeStart ${prefix}:id='0'></${prefix}:commentRangeStart>`, `<${prefix}:commentRangeEnd ${prefix}:id='0'/>`, `<${prefix}:commentReference ${prefix}:id='0'></${prefix}:commentReference>`];
const plainBody = '<w:p><w:r><w:t>软件正文</w:t></w:r></w:p>';
const allResidualZero = (buffer) => { const info = inspectDocxComments(buffer); for (const key of ['comments', 'anchors', 'commentParts', 'relationships', 'contentTypes']) assert.equal(info[key], 0, key); };
const test = async (name, fn) => { try { const facts = await fn(); report.checks.push({ name, ok: true, ...facts }); console.log(`PASS ${name}`); } catch (error) { report.checks.push({ name, ok: false, error: error.stack || String(error) }); throw error; } };
const untouched = (before, after, touched, removed) => {
  const a = openZip(before); const b = openZip(after);
  assert.deepEqual(b.names, a.names.filter((name) => !removed.includes(name)));
  for (const name of a.names) if (!touched.includes(name) && !removed.includes(name)) assert.deepEqual(b.read(name), a.read(name), name);
};
try {
  await test('fixed old failure: alternate prefixes, single quotes and custom normalized comment targets', () => {
    const markers = anchors('z'); const xml = document(`<z:p>${markers[0]}<z:r><z:t>软件正文</z:t></z:r>${markers[1]}<z:r>${markers[2]}</z:r></z:p>`, 'z');
    const part = 'word/review notes/custom.xml';
    const input = packageOf(xml, { [part]: comments('z'), 'word/_rels/document.xml.rels': rels(relation('c', '/word/./review%20notes/custom.xml', COMMENT_TYPE, 'p'), 'p') }, override('word/review%20notes/custom.xml'));
    if (oldClean) {
      const missed = oldClean(input); const oldZip = openZip(missed.buffer);
      assert.ok(oldZip.has(part)); assert.ok(oldZip.readText('word/document.xml').includes('z:commentReference'));
      assert.ok(oldZip.readText('word/_rels/document.xml.rels').includes('relationships/comments'));
    }
    const result = cleanDocx(input);
    assert.equal(openZip(result.buffer).readText('word/document.xml'), markers.reduce((text, marker) => text.replace(marker, ''), xml));
    assert.equal(result.stats.commentsRemoved, 1); assert.equal(result.stats.anchors, 3); assert.equal(result.stats.commentParts, 1);
    assert.equal(result.stats.relationships, 1); assert.equal(result.stats.contentTypes, 1); allResidualZero(result.buffer);
    return { oldMissed: !!oldClean, sourceSha256: sha256(input), stats: result.stats };
  });
  if (!process.argv.includes('--old-only')) {
    await test('headers, footnotes, endnotes, nested local prefix bindings and paired anchors all clean', () => {
      const part = 'annotations/comment.data';
      const header = `<h:hdr xmlns:h='${W}'><h:p><h:commentRangeStart h:id='0'/><h:r><h:t>软件页眉</h:t></h:r><h:commentRangeEnd h:id='0'/></h:p></h:hdr>`;
      const foot = `<w:footnotes xmlns:w='${W}'><w:footnote w:id='1'><w:p xmlns:q='${W}'><q:commentRangeStart q:id='0'/><w:r><w:t>软件脚注</w:t><q:commentReference q:id='0'/></w:r></w:p></w:footnote></w:footnotes>`;
      const end = `<w:endnotes xmlns:w='${W}'><w:endnote w:id='1'><w:p><w:commentRangeEnd w:id='0'></w:commentRangeEnd><w:r><w:t>软件尾注</w:t></w:r></w:p></w:endnote></w:endnotes>`;
      const input = packageOf(document(plainBody), { [part]: comments(), 'word/header1.xml': header, 'word/footnotes.xml': foot, 'word/endnotes.xml': end,
        'word/_rels/header1.xml.rels': rels(relation('c', '../annotations/comment.data')),
        'annotations/_rels/comment.data.rels': rels(relation('image', '../word/media/software.png', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image')) }, override(part));
      const result = cleanDocx(input); assert.equal(result.stats.anchors, 5); assert.equal(result.stats.commentRelationshipParts, 1); assert.equal(result.stats.relationships, 2);
      assert.ok(!openZip(result.buffer).has('annotations/_rels/comment.data.rels')); allResidualZero(result.buffer);
      untouched(input, result.buffer, result.stats.partsTouched, result.stats.partsRemoved);
      return { stats: result.stats };
    });
    await test('media, bookmarks, links, fields, revisions and note text remain byte-exact around removed markers', () => {
      const markers = anchors();
      const protectedBody = `<w:p><w:bookmarkStart w:id='2' w:name='software'/>${markers[0]}<w:hyperlink r:id='link'><w:r><w:t>软件链接</w:t></w:r></w:hyperlink><w:fldSimple w:instr=' PAGE '><w:r><w:t>1</w:t></w:r></w:fldSimple><w:ins w:id='3' w:author='软件'><w:r><w:t>软件新增</w:t></w:r>${markers[1]}</w:ins><w:del w:id='4'><w:r><w:delText>软件删除</w:delText></w:r></w:del><w:r>${markers[2]}<w:footnoteReference w:id='1'/></w:r><w:bookmarkEnd w:id='2'/></w:p>`;
      const xml = document(protectedBody);
      const input = packageOf(xml, { 'word/comments.xml': comments(), 'word/_rels/document.xml.rels': rels(relation('c', './comments.xml') + relation('link', 'https://example.invalid/software?x=1&amp;y=2', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', '', 'External')),
        'word/footnotes.xml': `<w:footnotes xmlns:w='${W}'><w:footnote w:id='1'><w:p><w:r><w:t>软件正文注释文字</w:t></w:r></w:p></w:footnote></w:footnotes>` }, override('word/comments.xml'));
      const before = parseDocxBuffer(input); const result = cleanDocx(input); const after = parseDocxBuffer(result.buffer);
      assert.equal(openZip(result.buffer).readText('word/document.xml'), markers.reduce((text, marker) => text.replace(marker, ''), xml));
      assert.deepEqual(after.paragraphs.map((p) => p.text), before.paragraphs.map((p) => p.text));
      assert.deepEqual(after.footnotes.map((p) => p.text), before.footnotes.map((p) => p.text));
      assert.deepEqual(after.revisions, before.revisions); untouched(input, result.buffer, result.stats.partsTouched, result.stats.partsRemoved); allResidualZero(result.buffer);
    });
    await test('foreign same-name elements and textual lookalikes are preserved; no-target bytes are identical', () => {
      const xml = document(`<w:p xmlns:w='urn:foreign'><w:commentReference/><w:t>软件内容</w:t></w:p><w:p><w:r><w:t>&lt;w:commentReference/&gt;</w:t></w:r></w:p><!-- <w:commentReference/> --><![CDATA[<w:commentRangeStart/>]]>`);
      const input = packageOf(xml, { 'custom/foreign.xml': '<comments xmlns="urn:foreign"><comment>保留</comment></comments>' });
      const result = cleanDocx(input); assert.equal(result.buffer, input); assert.equal(result.stats.changed, false); assert.equal(result.stats.unchanged, true);
      assert.equal(result.stats.sourceSha256, result.stats.outputSha256); assert.equal(result.stats.partsTouched.length, 0);
    });
    await test('strict Word namespace and namespace-prefixed relationships/content types are supported', () => {
      const markers = anchors('s');
      const input = packageOf(document(`<s:p>${markers.join('')}<s:r><s:t>软件正文</s:t></s:r></s:p>`, 's', STRICT_W), {
        'word/comments.xml': comments('s', STRICT_W), 'word/_rels/document.xml.rels': rels(relation('c', 'comments.xml', 'http://purl.oclc.org/ooxml/officeDocument/relationships/comments', 'x'), 'x') }, override('word/comments.xml'));
      const result = cleanDocx(input); assert.equal(result.stats.anchors, 3); allResidualZero(result.buffer);
    });
    await test('all known modern comment companion parts and their own relationships are removed', () => {
      const companions = [
        ['ex', 'http://schemas.microsoft.com/office/word/2012/wordml', 'commentsEx', 'commentsExtended', 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended'],
        ['ids', 'http://schemas.microsoft.com/office/word/2016/wordml/cid', 'commentsIds', 'commentsIds', 'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds'],
        ['ext', 'http://schemas.microsoft.com/office/word/2018/wordml/cex', 'commentsExtensible', 'commentsExtensible', 'http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible'],
        ['people', 'http://schemas.microsoft.com/office/word/2012/wordml', 'people', 'people', 'http://schemas.microsoft.com/office/2011/relationships/people'],
      ];
      const extra = {}; let declarations = ''; let rows = '';
      for (const [name, ns, root, kind, type] of companions) {
        extra[`reviews/${name}.xml`] = `<a:${root} xmlns:a='${ns}'/>`;
        declarations += override(`reviews/${name}.xml`, `application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml`);
        rows += relation(name, `../reviews/${name}.xml`, type);
      }
      extra['word/_rels/document.xml.rels'] = rels(rows);
      const result = cleanDocx(packageOf(document(plainBody), extra, declarations));
      assert.equal(result.stats.commentParts, 4); assert.equal(result.stats.relationships, 4); assert.equal(result.stats.contentTypes, 4); allResidualZero(result.buffer);
    });
    await test('OPC encoded ZIP spellings, target case and dot segments resolve to one exact part identity', () => {
      const part = 'reviews/Notes%20One.XML';
      const ownRels = 'REVIEWS/_rels/NOTES%20ONE.xml.rels';
      const input = packageOf(document(plainBody), { [part]: comments(),
        'word/_rels/document.xml.rels': rels(relation('c', '../reviews/./notes%20one.xml')),
        [ownRels]: rels(relation('image', '../word/media/software.png', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image')) }, override('REVIEWS/NOTES%20ONE.XML'));
      const result = cleanDocx(input); assert.equal(result.stats.commentParts, 1); assert.equal(result.stats.commentRelationshipParts, 1);
      assert.ok(!openZip(result.buffer).has(part)); assert.ok(!openZip(result.buffer).has(ownRels));
      untouched(input, result.buffer, result.stats.partsTouched, result.stats.partsRemoved); allResidualZero(result.buffer);
      const ambiguous = packageOf(document(plainBody), { 'reviews/a.xml': comments(), 'reviews/A.XML': comments() });
      assert.throws(() => cleanDocx(ambiguous), (error) => error.code === 'CLEAN_PACKAGE_AMBIGUOUS');
    });
    await test('comment Default declarations respect later non-comment Overrides and remove only comment-owned entries', () => {
      const input = packageOf(document(plainBody), { 'reviews/annotation.cmt': comments(), 'reviews/preserved.cmt': '<software xmlns="urn:software">保留</software>' },
        `<ct:Default Extension='cmt' ContentType='${MIME}'/><ct:Override PartName='/reviews/preserved.cmt' ContentType='application/xml'/>`);
      const result = cleanDocx(input); assert.equal(result.stats.commentParts, 1); assert.equal(result.stats.contentTypes, 1);
      assert.ok(openZip(result.buffer).has('reviews/preserved.cmt')); allResidualZero(result.buffer);
      untouched(input, result.buffer, result.stats.partsTouched, result.stats.partsRemoved);
    });
    await test('cleaning is fully idempotent and preserves the caller original buffer', () => {
      const input = packageOf(document(`<w:p>${anchors().join('')}</w:p>`), { 'word/comments.xml': comments(), 'word/_rels/document.xml.rels': rels(relation('c', 'comments.xml')) }, override('word/comments.xml'));
      const before = sha256(input); const result = cleanDocx(input); const second = cleanDocx(result.buffer);
      assert.equal(sha256(input), before); assert.equal(second.buffer, result.buffer); assert.equal(second.stats.changed, false); assert.equal(second.stats.commentsRemoved, 0);
      assert.equal(second.stats.outputSha256, result.stats.outputSha256);
    });
    await test('unsafe XML, unbound namespaces, nonempty anchors and ambiguous targets fail explicitly', () => {
      const cases = [
        [packageOf('<w:document><w:body/></w:document>'), 'CLEAN_XML_NAMESPACE'],
        [packageOf(document('<w:p><w:commentReference><w:r><w:t>不能删除的正文</w:t></w:r></w:commentReference></w:p>')), 'CLEAN_ANCHOR_INVALID'],
        [packageOf(document(plainBody), { 'word/_rels/document.xml.rels': rels(relation('c', 'missing.xml')) }), 'CLEAN_DANGLING_COMMENT_RELATIONSHIP'],
        [packageOf(document(plainBody), { 'word/_rels/document.xml.rels': rels(relation('c', '../../../outside.xml')) }), 'CLEAN_RELATIONSHIP_TARGET'],
        [packageOf(document(plainBody), { 'word/_rels/document.xml.rels': rels(relation('c', 'https://example.invalid/comments', COMMENT_TYPE, '', 'External')) }), 'CLEAN_EXTERNAL_COMMENT_RELATIONSHIP'],
        [packageOf(document(plainBody), { 'word/comments.xml': document(plainBody) }, override('word/comments.xml')), 'CLEAN_COMMENT_PART_INVALID'],
        [packageOf(document('<w:p><w:r><w:t>&unknown;</w:t></w:r></w:p>')), 'CLEAN_XML_ENTITY'],
        [packageOf('<!DOCTYPE w:document [<!ENTITY e "x">]>' + document(plainBody)), 'CLEAN_XML_UNSUPPORTED'],
        [packageOf(document('<w:p><w:r></w:p></w:r>')), 'CLEAN_XML_INVALID'],
        [packageOf(document(plainBody), { 'word/_rels/document.xml.rels': rels(relation('c', 'future.xml', 'http://schemas.microsoft.com/office/2030/relationships/commentsFuture')) }), 'CLEAN_COMMENT_TYPE_UNSUPPORTED'],
      ];
      for (const [input, code] of cases) { const hash = sha256(input); assert.throws(() => cleanDocx(input), (error) => error.code === code, code); assert.equal(sha256(input), hash); }
      return { explicitFailures: cases.length };
    });
    await test('signed documents requiring cleaning fail instead of invalidating signatures', () => {
      const input = packageOf(document(`<w:p>${anchors().join('')}</w:p>`), { '_xmlsignatures/sig1.xml': '<signature/>' });
      assert.throws(() => cleanDocx(input), (error) => error.code === 'CLEAN_SIGNED_DOCUMENT');
    });
    await test('a partially readable central directory is explicitly rejected instead of silently dropping later entries', () => {
      const valid = packageOf(document(plainBody), { 'word/comments.xml': comments() }, override('word/comments.xml'));
      const damaged = Buffer.from(valid);
      const end = damaged.length - 22; const central = damaged.readUInt32LE(end + 16);
      const second = central + 46 + damaged.readUInt16LE(central + 28) + damaged.readUInt16LE(central + 30) + damaged.readUInt16LE(central + 32);
      damaged.writeUInt32LE(0, second);
      assert.ok(openZip(damaged).names.length < openZip(valid).names.length, 'fixture must reach the old partial-reader behavior');
      assert.throws(() => cleanDocx(damaged), (error) => error.code === 'CLEAN_PACKAGE_INVALID');
    });
  }
  report.ok = true;
} catch (error) { report.ok = false; report.error = error.stack || String(error); process.exitCode = 1; }
finally { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(`Evidence: ${OUT}`); }
