import { parseDocx } from '../src/docx.js';
import { scanFormat } from '../src/scanner-format.js';

const f = process.argv[2];
const doc = parseDocx(f);
const res = scanFormat(doc);
console.log('=== 文件 ===', f.split('\\').pop());
console.log('=== 统计 ===', JSON.stringify(res.summary, null, 2));
console.log('=== 要素信息 ===');
for (const i of res.info) console.log(` ${i.id} ${i.label}: ${i.value}`);
console.log('=== 问题清单（前 60 条）===');
for (const i of res.issues.slice(0, 60)) {
  console.log(`[${i.ruleId}/${i.severity}] ${i.location} :: ${i.message}`);
  if (i.quote) console.log(`     原文: ${i.quote.replace(/\n/g, ' ').slice(0, 100)}`);
  if (i.suggestion) console.log(`     建议: ${i.suggestion}`);
}
