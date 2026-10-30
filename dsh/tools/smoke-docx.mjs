import { parseDocx } from '../src/docx.js';
const f = process.argv[2];
const d = parseDocx(f);
console.log(JSON.stringify({
  label: d.label,
  core: d.core,
  stats: d.stats,
  firstParagraphs: d.paragraphs.slice(0, 12).map((p) => ({ i: p.index, style: p.properties.style, jc: p.properties.jc, ea: p.format.eastAsia, sz: p.format.sizeHalfPt, text: p.text.slice(0, 60) })),
  firstComments: d.comments.slice(0, 5).map((c) => ({ id: c.id, author: c.author, text: c.text.slice(0, 80) })),
  footnoteSample: d.footnotes.slice(0, 4).map((p) => p.text.slice(0, 80)),
}, null, 2));
