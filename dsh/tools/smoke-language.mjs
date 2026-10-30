import { parseDocx } from '../src/docx.js';
import { scanLanguage } from '../src/scanner-language.js';

const f = process.argv[2];
const doc = parseDocx(f);
const res = scanLanguage(doc);
console.log('=== 文件 ===', f.split('\\').pop());
console.log('=== 统计 ===', JSON.stringify(res.summary, null, 2));
console.log('=== 语言统计 ===', JSON.stringify(res.stats));
for (const i of res.info) console.log(` ${i.label}: ${i.value}`);
console.log('=== 问题（前 50 条）===');
for (const i of res.issues.slice(0, 50)) {
  console.log(`[${i.ruleId}/${i.severity}] ${i.location} ${i.category} :: ${i.message}`);
  if (i.quote) console.log(`     原文: ${i.quote.replace(/\n/g, ' ').slice(0, 110)}`);
}
console.log('=== 需大模型判断的规则 ===');
for (const r of res.modelRules) console.log(` ${r.id} ${r.category} ${r.title}`);
