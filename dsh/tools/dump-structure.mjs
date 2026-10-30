/**
 * 结构诊断：把一份稿件的段落属性、脚注、标题逐条打出来。
 *
 * ⚠️ 标题判据必须用 `headings.js` 的 `isTextHeading`，不要在这里另写正则。
 * 本文件原本有一条自己的正则（3 组形态、卡 `<60` 字），是全项目**三套互不
 * 一致**的标题判据之一 —— 拿它诊断会得出与产品实际行为不同的结论。
 * 三处已收敛到同一实现，另两处见 `src/ark.js` 的分窗与
 * `rules/format-rules.json` 的 `journal.headingLevelPatterns`。
 *
 * 用法：node tools/dump-structure.mjs <稿件路径> [...]
 */
import { parseDocx } from '../src/docx.js';
import { isTextHeading } from '../src/headings.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.log('用法：node tools/dump-structure.mjs <稿件.docx> [...]');
  process.exit(0);
}
for (const f of files) {
  try {
    const d = parseDocx(f);
    console.log('\n===== ' + f.split('\\').pop() + ' =====');
    console.log('stats', JSON.stringify(d.stats));
    for (const p of d.paragraphs.slice(0, 26)) {
      const t = p.text.trim();
      if (!t) continue;
      console.log(`[${p.index}] style=${p.properties.style} jc=${p.properties.jc} outline=${p.properties.outline} ea=${p.format.eastAsia} sz=${p.format.sizeHalfPt} | ${t.slice(0, 90)}`);
    }
    console.log('--- footnotes ---');
    for (const p of d.footnotes.filter((x) => x.text.trim()).slice(0, 6)) console.log('  * ' + p.text.slice(0, 130));
    console.log('--- headings (all, 按 headings.js 判据) ---');
    let n = 0;
    for (const p of d.paragraphs) {
      const t = p.text.trim();
      const hit = isTextHeading(t);
      if (!hit) continue;
      n += 1;
      console.log(`  H${hit.level}[${p.index}] jc=${p.properties.jc} ea=${p.format.eastAsia} bold=${p.format.bold} | ${t}`);
    }
    console.log(`  共 ${n} 条文本编号标题`);
  } catch (e) { console.log('ERR', f, e.message); }
}
