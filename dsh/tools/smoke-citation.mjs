import { parseDocx } from '../src/docx.js';
import { scanCitation } from '../src/scanner-citation.js';

const doc = parseDocx(process.argv[2]);
const res = scanCitation(doc);
const byRule = {};
for (const i of res.issues) (byRule[i.ruleId] ||= []).push(i);
for (const [rid, items] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n### ${rid} — ${items[0].title}  (${items.length} 条)`);
  for (const it of items.slice(0, 3)) {
    console.log(`   [${it.location}] ${it.message}`);
    console.log(`     脚注原文: ${(it.quote || '').slice(0, 120)}`);
  }
}
