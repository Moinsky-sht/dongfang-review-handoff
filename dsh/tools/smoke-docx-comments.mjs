/**
 * 冒烟测试：导出「带批注的 Word 文档」（src/docx-comments.js + src/zip-write.js）。
 *
 * 断言：
 *   1. 在原稿字节流上注入批注后，仍是合法 ZIP，且能被自家读取器打开；
 *   2. comments.xml 条数 == 注入条数；document.xml 的
 *      commentRangeStart / commentRangeEnd / commentReference 三者数量一致；
 *   3. [Content_Types].xml 有 comments 的 Override、document.xml.rels 有 comments 关系；
 *   4. 导出的 .docx 能被自家解析器当普通稿件读回，批注文本含规则号；
 *   5. 只导出选中条目时，条数与选择一致。
 *
 * 用法：node tools/smoke-docx-comments.mjs
 */
import { readFileSync } from 'node:fs';
import { parseDocxBuffer } from '../src/docx.js';
import { deterministicReview } from '../src/review.js';
import { buildCommentedDocx } from '../src/docx-comments.js';
import { openZip } from '../src/zip.js';

let pass = 0; let fail = 0;
const check = (cond, label) => { if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); } };

const src = readFileSync('samples/test.docx');
const doc = parseDocxBuffer(src, 'test.docx');
const r = deterministicReview(doc);
const anchorable = r.issues.filter((x) => Number.isInteger(x.paragraphIndex) || Number.isInteger(x.footnoteIndex) || Number.isInteger(x.endnoteIndex));

const res = buildCommentedDocx({ buffer: src, issues: anchorable });
check(res.added === anchorable.length, `全部可锚定条目均注入（${res.added}/${anchorable.length}）`);
check(res.skipped === 0, `无跳过（skipped=${res.skipped}）`);

const zip = openZip(res.buffer);
check(zip.has('word/comments.xml'), '导出包含 word/comments.xml');
const cxml = zip.readText('word/comments.xml');
const dxml = zip.readText('word/document.xml');
const nComments = (cxml.match(/<w:comment /g) || []).length;
const nStart = (dxml.match(/<w:commentRangeStart /g) || []).length;
const nEnd = (dxml.match(/<w:commentRangeEnd /g) || []).length;
const nRef = (dxml.match(/<w:commentReference /g) || []).length;
check(nComments === res.added, `comments.xml 条数正确（${nComments}）`);
check(nStart === nEnd && nEnd === nRef, `正文 range/ref 配对一致（${nStart}/${nEnd}/${nRef}）`);
check(/wordprocessingml\.comments\+xml/.test(zip.readText('[Content_Types].xml')), 'Content_Types 有 comments Override');
check(/relationships\/comments/.test(zip.readText('word/_rels/document.xml.rels')), 'document.xml.rels 有 comments 关系');

const doc2 = parseDocxBuffer(res.buffer, 'exported.docx');
check(doc2.comments.length === res.added, `导出文档可读回批注（${doc2.comments.length}）`);
check(/【[A-Z]+-\d+/.test(doc2.comments[0]?.text || ''), '批注文本含规则号');

// 选择导出
const keys = new Set(anchorable.slice(0, 3).map((x) => `${x.ruleId}|${x.location}|${x.quote || ''}`));
const sel = anchorable.filter((x) => keys.has(`${x.ruleId}|${x.location}|${x.quote || ''}`));
const res2 = buildCommentedDocx({ buffer: src, issues: sel });
check(res2.added === sel.length && sel.length <= 3, `选择导出条数正确（${res2.added}）`);

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail ? 1 : 0);
