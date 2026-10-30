import assert from 'node:assert/strict';
import { writeZip } from '../src/zip-write.js';
import { openZip } from '../src/zip.js';
import { parseDocxBuffer } from '../src/docx.js';
import { applyDocxPatches } from '../src/docx-patches.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const run = (text, props = '') => `<w:r>${props}<w:t>${text}</w:t></w:r>`;
const para = (...runs) => `<w:p>${runs.join('')}</w:p>`;
const fixture = (body, extras = {}) => writeZip([
  { name: 'word/document.xml', data: `<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr/></w:body></w:document>` },
  { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
  { name: 'word/styles.xml', data: `<w:styles xmlns:w="${W}"/>` },
  { name: 'word/media/image1.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 13, 10]) },
  ...Object.entries(extras).map(([name, data]) => ({ name, data })),
]);
const patch = (patchId, index, offset, find, replace, target = 'body') => ({ patchId, target, index, offset, find, replace });
const text = (buffer, index = 0) => parseDocxBuffer(buffer).paragraphs[index].text;
const assertUntouched = (before, after, changed) => {
  const a = openZip(before); const b = openZip(after);
  assert.deepEqual(b.names, a.names);
  for (const name of a.names) if (!changed.includes(name)) assert.deepEqual(b.read(name), a.read(name), name);
};
let count = 0;
const test = (name, fn) => { fn(); count += 1; console.log(`✓ ${name}`); };

test('cross-run replacement preserves properties, suffix, unrelated nodes and media', () => {
  const bold = '<w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr>';
  const italic = '<w:rPr><w:i/><w:vertAlign w:val="superscript"/></w:rPr>';
  const src = fixture(para(run('甲坏', bold), run('词乙', italic), run('尾部')) + para(run('其他段落')));
  const res = applyDocxPatches(src, [patch('a', 0, 1, '坏词', '正确&amp;'.replace('&amp;', '&'))]);
  assert.equal(res.applied.length, 1); assert.equal(res.skipped.length, 0);
  assert.equal(text(res.buffer), '甲正确&乙尾部'); assert.equal(text(res.buffer, 1), '其他段落');
  const xml = openZip(res.buffer).readText('word/document.xml');
  assert.ok(xml.includes(bold)); assert.ok(xml.includes(italic)); assert.ok(xml.includes('正确&amp;'));
  assertUntouched(src, res.buffer, ['word/document.xml']);
  assert.equal(text(src), '甲坏词乙尾部', 'input buffer is immutable');
});

test('same-node and cross-node disjoint ranges use the same input version', () => {
  const src = fixture(para(run('坏坏'), run('词，坏')));
  const res = applyDocxPatches(src, [patch('a', 0, 0, '坏', '长替换'), patch('b', 0, 1, '坏词', '对'), patch('c', 0, 4, '坏', '')]);
  assert.equal(res.applied.length, 3); assert.equal(res.skipped.length, 0);
  assert.equal(text(res.buffer), '长替换对，');
});

test('exact offset selects repeated text and stale offsets never guess', () => {
  const src = fixture(para(run('坏词；坏词')));
  const res = applyDocxPatches(src, [patch('a', 0, 3, '坏词', '好词')]);
  assert.equal(text(res.buffer), '坏词；好词');
  const stale = applyDocxPatches(src, [patch('b', 0, 1, '坏词', '好词')]);
  assert.equal(stale.buffer, src); assert.equal(stale.skipped[0].reasonCode, 'stale_range');
  const ambiguous = applyDocxPatches(src, [patch('c', 0, undefined, '坏词', '好词')]);
  assert.equal(ambiguous.skipped[0].reasonCode, 'ambiguous_text');
  const unique = applyDocxPatches(src, [patch('d', 0, undefined, '；', '，')]);
  assert.equal(unique.applied[0].offset, 2); assert.equal(text(unique.buffer), '坏词，坏词');
});

test('all overlapping ranges and duplicate patch ids are rejected', () => {
  const src = fixture(para(run('abcdef')));
  const res = applyDocxPatches(src, [patch('a', 0, 1, 'bcd', 'X'), patch('b', 0, 3, 'de', 'Y'), patch('c', 0, 5, 'f', 'Z')]);
  assert.equal(text(res.buffer), 'abcdeZ'); assert.equal(res.applied.length, 1);
  assert.deepEqual(res.skipped.map((p) => p.reasonCode), ['overlapping_range', 'overlapping_range']);
  const duplicate = applyDocxPatches(src, [patch('a', 0, 0, 'a', 'X'), patch('a', 0, 5, 'f', 'Z')]);
  assert.equal(duplicate.buffer, src); assert.equal(duplicate.skipped.length, 2);
  assert.ok(duplicate.skipped.every((p) => p.reasonCode === 'duplicate_patch_id'));
});

test('tables and separator/multi-paragraph footnotes/endnotes match parser indexes', () => {
  const table = `<w:tbl><w:tr><w:tc>${para(run('表格坏词'))}</w:tc></w:tr></w:tbl>`;
  const notes = (kind) => `<w:${kind}s xmlns:w="${W}"><w:${kind} w:id="-1" w:type="separator">${para('<w:r><w:separator/></w:r>')}</w:${kind}><w:${kind} w:id="5">${para(run('第一段'))}<w:tbl><w:tr><w:tc>${para(run('注内坏词'))}</w:tc></w:tr></w:tbl>${para(run('最后坏词'))}</w:${kind}></w:${kind}s>`;
  const src = fixture(para(run('正文')) + table + para(run('末段')), { 'word/footnotes.xml': notes('footnote'), 'word/endnotes.xml': notes('endnote') });
  const res = applyDocxPatches(src, [patch('a', 1, 2, '坏词', '好词'), patch('b', 2, 2, '坏词', '改词', 'footnote'), patch('c', 3, 2, '坏词', '新词', 'endnote')]);
  assert.equal(res.applied.length, 3); assert.equal(res.skipped.length, 0);
  const doc = parseDocxBuffer(res.buffer);
  assert.equal(doc.paragraphs[1].text, '表格好词'); assert.equal(doc.footnotes[2].text, '注内改词'); assert.equal(doc.endnotes[3].text, '最后新词');
  assertUntouched(src, res.buffer, ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']);
});

test('XML entities, whitespace and supplementary characters retain text', () => {
  const src = fixture(para(run('&#x1F600;甲&amp;乙&lt;丙&gt;')));
  const res = applyDocxPatches(src, [patch('a', 0, 2, '甲&乙', ' 新<文> ')]);
  assert.equal(text(res.buffer), '😀 新<文> <丙>');
  assert.ok(openZip(res.buffer).readText('word/document.xml').includes('xml:space="preserve"') === false, 'interior spaces need no xml:space');
  const edge = applyDocxPatches(fixture(para(run('坏'))), [patch('b', 0, 0, '坏', ' 前后 ')]);
  assert.equal(text(edge.buffer), ' 前后 '); assert.ok(openZip(edge.buffer).readText('word/document.xml').includes('xml:space="preserve"'));
  const split = applyDocxPatches(src, [patch('c', 0, 1, '\uDE00', 'X')]);
  assert.equal(split.skipped[0].reasonCode, 'invalid_patch');
});

test('fields stay byte-identical; plain text outside a field remains editable', () => {
  const field = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>HYPERLINK "https://example.com"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run('域结果') + '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const simple = `<w:fldSimple w:instr="PAGE">${run('2')}</w:fldSimple>`;
  const src = fixture(para(run('普通坏'), field, run('词'), simple));
  const res = applyDocxPatches(src, [patch('a', 0, 2, '坏', '好'), patch('b', 0, 3, '域结果', '改'), patch('c', 0, 7, '2', '3')]);
  assert.equal(res.applied.length, 1); assert.equal(text(res.buffer), '普通好域结果词2');
  assert.deepEqual(res.skipped.map((p) => p.reasonCode), ['unsupported_field', 'unsupported_field']);
  const xml = openZip(res.buffer).readText('word/document.xml'); assert.ok(xml.includes(field)); assert.ok(xml.includes(simple));
});

test('paragraph-spanning fields are refused even when parser shows result text', () => {
  const src = fixture(para('<w:r><w:fldChar w:fldCharType="begin"/></w:r>', '<w:r><w:instrText>TOC</w:instrText><w:fldChar w:fldCharType="separate"/></w:r>', run('第一段结果'))
    + para(run('第二段结果'), '<w:r><w:fldChar w:fldCharType="end"/></w:r>'));
  const res = applyDocxPatches(src, [patch('a', 0, 0, '第一段结果', '改'), patch('b', 1, 0, '第二段结果', '改')]);
  assert.equal(res.buffer, src); assert.equal(res.skipped.length, 2);
  assert.ok(res.skipped.every((p) => p.reasonCode === 'unsupported_field'));
});

test('revisions, note boundaries and tab/break structures refuse unsafe ranges', () => {
  const revisions = `<w:ins w:id="1">${run('新增')}</w:ins><w:del w:id="2"><w:r><w:delText>删除</w:delText></w:r></w:del>`;
  const src = fixture(para(run('甲'), revisions, run('乙'), '<w:r><w:footnoteReference w:id="5"/></w:r>', run('丙'), '<w:r><w:tab/></w:r>', run('丁'), '<w:r><w:br/></w:r>', run('戊')));
  assert.equal(text(src), '甲新增乙丙\t丁\n戊');
  const res = applyDocxPatches(src, [patch('a', 0, 1, '新增', '旧'), patch('b', 0, 3, '乙丙', '合'), patch('c', 0, 4, '丙\t丁', '合'), patch('d', 0, 6, '丁\n戊', '合')]);
  assert.equal(res.buffer, src); assert.equal(res.applied.length, 0);
  assert.deepEqual(res.skipped.map((p) => p.reasonCode), ['unsupported_revision', 'unsupported_boundary', 'unsupported_non_text', 'unsupported_non_text']);
});

test('invalid target/index/control text and missing parts return explicit reasons', () => {
  const src = fixture(para(run('坏')));
  const res = applyDocxPatches(src, [patch('a', 0, 0, '坏', 'x\n'), patch('b', 1, 0, '坏', '好'), patch('c', 0, 0, '坏', '好', 'endnote'), patch('d', 0, 0, '坏', '\x00'), { ...patch('e', 0, 0, '坏', '好'), target: 'header' }]);
  assert.equal(res.buffer, src);
  assert.deepEqual(res.skipped.map((p) => p.reasonCode), ['invalid_patch', 'missing_paragraph', 'missing_part', 'invalid_patch', 'invalid_patch']);
});

test('sequential input versions, deletion and no-op retain verified document text', () => {
  const src = fixture(para(run('坏词，坏词')));
  const one = applyDocxPatches(src, [patch('a', 0, 0, '坏词', '长一点好词')]);
  const two = applyDocxPatches(one.buffer, [patch('b', 0, 6, '坏词', '')]);
  assert.equal(text(two.buffer), '长一点好词，');
  const empty = applyDocxPatches(two.buffer, []); assert.equal(empty.buffer, two.buffer);
  const noop = applyDocxPatches(two.buffer, [patch('c', 0, 0, '長', '長')]); assert.equal(noop.skipped[0].reasonCode, 'invalid_patch');
});

test('signed packages and content controls are safely refused', () => {
  const src = fixture(para(run('坏')), { '_xmlsignatures/sig1.xml': '<Signature/>' });
  const res = applyDocxPatches(src, [patch('a', 0, 0, '坏', '好')]); assert.equal(res.buffer, src); assert.equal(res.skipped[0].reasonCode, 'signed_document');
  const table = `<w:tbl><w:tr><w:tc><w:sdt><w:sdtContent>${para(run('坏'))}</w:sdtContent></w:sdt></w:tc></w:tr></w:tbl>`;
  const controls = applyDocxPatches(fixture(table), [patch('b', 0, 0, '坏', '好')]);
  assert.equal(controls.skipped[0].reasonCode, 'unsupported_structure');
});

test('plain/link and distinct link contexts refuse cross-boundary replacements', () => {
  const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>';
  const link = (runs) => `<w:hyperlink r:id="rId1">${runs}</w:hyperlink>`;
  const src = fixture(para(run('ab'), link(run('cd'))), { 'word/_rels/document.xml.rels': rels });
  const plainToLink = applyDocxPatches(src, [patch('a', 0, 1, 'bc', 'XY')]);
  assert.equal(plainToLink.buffer, src); assert.equal(plainToLink.skipped[0].reasonCode, 'unsupported_context');
  const linkToPlain = applyDocxPatches(fixture(para(link(run('ab')), run('cd'))), [patch('b', 0, 1, 'bc', 'XY')]);
  assert.equal(linkToPlain.applied.length, 0); assert.equal(linkToPlain.skipped[0].reasonCode, 'unsupported_context');
  const distinct = fixture(para(link(run('ab')), link(run('cd'))), { 'word/_rels/document.xml.rels': rels });
  const betweenLinks = applyDocxPatches(distinct, [patch('c', 0, 1, 'bc', 'XY')]);
  assert.equal(betweenLinks.buffer, distinct); assert.equal(betweenLinks.skipped[0].reasonCode, 'unsupported_context');
});

test('same hyperlink permits cross-run and single-character changes while rels remain identical', () => {
  const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>';
  const linked = `<w:hyperlink r:id="rId1">${run('ab', '<w:rPr><w:b/></w:rPr>')}${run('cd', '<w:rPr><w:i/></w:rPr>')}</w:hyperlink>`;
  const src = fixture(para(linked, run('ef')), { 'word/_rels/document.xml.rels': rels });
  const crossRun = applyDocxPatches(src, [patch('a', 0, 1, 'bc', 'XY')]);
  assert.equal(crossRun.applied.length, 1); assert.equal(text(crossRun.buffer), 'aXYdef');
  assertUntouched(src, crossRun.buffer, ['word/document.xml']);
  const xml = openZip(crossRun.buffer).readText('word/document.xml');
  assert.ok(/<w:hyperlink r:id="rId1">[\s\S]*aXY[\s\S]*d[\s\S]*<\/w:hyperlink>/.test(xml));
  const single = applyDocxPatches(crossRun.buffer, [patch('b', 0, 3, 'd', 'D')]);
  assert.equal(single.applied.length, 1); assert.equal(text(single.buffer), 'aXYDef');
  assertUntouched(src, single.buffer, ['word/document.xml']);
  assert.equal(openZip(single.buffer).readText('word/_rels/document.xml.rels'), rels);
});

test('smartTag and bidi wrapper boundaries are refused without rebuilding wrappers', () => {
  const smart = `<w:smartTag w:uri="urn:example" w:element="name">${run('cd')}</w:smartTag>`;
  const src = fixture(para(run('ab'), smart));
  const res = applyDocxPatches(src, [patch('a', 0, 1, 'bc', 'XY')]);
  assert.equal(res.buffer, src); assert.equal(res.skipped[0].reasonCode, 'unsupported_context');
  const bidi = fixture(para(`<w:dir w:val="rtl">${run('ab')}</w:dir>`, run('cd')));
  const directional = applyDocxPatches(bidi, [patch('b', 0, 1, 'bc', 'XY')]);
  assert.equal(directional.buffer, bidi); assert.equal(directional.skipped[0].reasonCode, 'unsupported_context');
});

console.log(`DOCX patches: ${count} scenarios passed; no model API calls.`);
