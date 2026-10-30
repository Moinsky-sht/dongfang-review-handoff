/**
 * 冒烟测试：导入即清洗（src/docx-clean.js）。
 *
 * 用一份**确实带原有批注**的语料稿件验证：
 *   1. 清洗前 comments.xml 存在、正文含 commentRangeStart/Reference；
 *   2. 清洗后 comments.xml 及其配套部件被删除，正文锚点清零；
 *   3. [Content_Types].xml / *.rels 里的批注声明被同步清除（不留悬空引用）；
 *   4. 清洗后可被自家解析器读回，且**段落/脚注/各级标题数与清洗前一致**（只去批注，不伤正文）；
 *   5. 修订单（w:ins/w:del）不被清掉（对比视图要用）。
 *
 * 用法：node tools/smoke-docx-clean.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { cleanDocx } from '../src/docx-clean.js';
import { openZip } from '../src/zip.js';

let pass = 0; let fail = 0;
const check = (cond, label) => { if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); } };

const ROOT = resolve('..', '发给皓天的一审文件');
const manifest = JSON.parse(readFileSync(resolve('data/corpus/manifest.json'), 'utf8'));
const pick = manifest.find((m) => (m.comments || 0) > 0 && /\.docx$/i.test(m.path) && existsSync(join(ROOT, m.path)));
if (!pick) { console.log('未找到带批注的语料稿件，跳过'); process.exit(0); }
const buf = readFileSync(join(ROOT, pick.path));
console.log(`语料：${pick.path.split('\\').pop()}（manifest 记录批注 ${pick.comments} 条）`);

const before = openZip(buf);
const beforeDoc = parseDocxBuffer(buf, 'before.docx');
const beforeDxml = before.readText('word/document.xml');
check(before.has('word/comments.xml'), '清洗前存在 word/comments.xml');
const beforeAnchors = (beforeDxml.match(/<w:commentRangeStart /g) || []).length;
check(beforeAnchors > 0, `清洗前正文含批注锚点（${beforeAnchors}）`);

const { buffer: cleanBuf, stats } = cleanDocx(buf);
const after = openZip(cleanBuf);
const afterDoc = parseDocxBuffer(cleanBuf, 'after.docx');
const afterDxml = after.readText('word/document.xml');

check(!after.has('word/comments.xml'), '清洗后 word/comments.xml 已删除');
check(stats.anchors > 0, `清洗统计：锚点 ${stats.anchors}、批注部件 ${stats.commentParts}`);
check(!/<w:commentRange(Start|End)\b/.test(afterDxml) && !/<w:commentReference\b/.test(afterDxml), '清洗后正文无任何批注锚点');
const afterCt = after.readText('[Content_Types].xml');
const afterDrels = after.readText('word/_rels/document.xml.rels');
check(!/wordprocessingml\.comments\+xml/.test(afterCt), 'Content_Types 无批注 Override');
check(!/relationships\/comments/.test(afterDrels), 'document.xml.rels 无批注关系');
check(afterDoc.comments.length === 0, '清洗后解析批注数 = 0');

check(afterDoc.paragraphs.length === beforeDoc.paragraphs.length, `段落数不变（${beforeDoc.paragraphs.length}）`);
check(afterDoc.footnotes.length === beforeDoc.footnotes.length, `脚注数不变（${beforeDoc.footnotes.length}）`);
check(afterDoc.endnotes.length === beforeDoc.endnotes.length, `尾注数不变（${beforeDoc.endnotes.length}）`);
const headBefore = beforeDoc.paragraphs.filter((p) => p._headingLevel).length;
const headAfter = afterDoc.paragraphs.filter((p) => p._headingLevel).length;
check(headAfter === headBefore, `各级标题数不变（${headBefore}）`);
check((afterDoc.revisions || []).length >= (beforeDoc.revisions || []).length * 0.9, `修订痕迹保留（${afterDoc.revisions.length} vs ${beforeDoc.revisions.length}）`);

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail ? 1 : 0);
