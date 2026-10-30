/**
 * 域代码（`w:fldChar` / `w:instrText`）调查。
 *
 * ── 为什么要查 ──
 * 目标里明确列了「域代码」这一类。现在 `docx.js` 的做法是：
 *   · `w:instrText`（域指令，隐藏）**永不进入文本**
 *   · `w:fldChar begin..separate` 之间的 `w:t` 也当隐藏指令跳过
 *   · `separate..end` 之间的 `w:t` 是**域结果**（可见），正常进入文本
 * 这个处理对「文本正确性」是对的。但要回答的是：**域指令本身要不要结构化抽取**？
 *
 * 判据：域的类型决定了它有没有编辑价值。
 *   · `PAGE` / `NUMPAGES` —— 页码域，正文里不该出现（属于版式，不是内容）
 *   · `REF` / `NOTEREF` —— 交叉引用，**未更新时会显示错误编号**，是真实的编辑问题
 *   · `HYPERLINK` —— 超链接
 *   · `TOC` —— 目录
 * 所以要按指令类型分布来判断，不能一概而论。
 *
 * 用法：node tools/investigate-fields.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { openZip } from '../src/zip.js';
import { CORPUS_ROOT } from './paths.mjs';

const ROOT = CORPUS_ROOT;
function walk(dir, acc = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name.startsWith('.')) continue; walk(p, acc); }
    else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}

const typeFiles = new Map();  // 域类型 → 出现篇数
const typeRuns = new Map();   // 域类型 → 出现次数
const examples = new Map();
let filesWithField = 0, totalInstr = 0;

for (const f of walk(ROOT)) {
  let z;
  try { z = openZip(fs.readFileSync(f)); } catch { continue; }
  const seen = new Set();
  for (const part of ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']) {
    const xml = z.readText(part) || '';
    if (!xml) continue;
    for (const m of xml.matchAll(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/g)) {
      const instr = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      if (!instr) continue;
      totalInstr += 1;
      // 域类型 = 指令的第一个词（去掉开关）
      const type = (instr.match(/^[A-Za-z]+/) || ['?'])[0].toUpperCase();
      typeRuns.set(type, (typeRuns.get(type) || 0) + 1);
      seen.add(type);
      if (!examples.has(type)) examples.set(type, instr.slice(0, 60));
    }
  }
  if (seen.size) filesWithField += 1;
  for (const t of seen) typeFiles.set(t, (typeFiles.get(t) || 0) + 1);
}

console.log(`含域的稿件：${filesWithField} 篇｜域指令合计 ${totalInstr} 条\n`);
console.log('═══ 域类型分布 ═══');
console.log('  类型            出现篇数   出现次数   样例指令');
for (const [t, n] of [...typeRuns.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(14)} ${String(typeFiles.get(t) || 0).padStart(7)} ${String(n).padStart(10)}   ${examples.get(t) || ''}`);
}
