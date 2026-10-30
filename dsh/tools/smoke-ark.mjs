import { arkRespond, DEFAULT_MODEL, parseJsonLoose, ISSUE_SCHEMA, REVIEW_INSTRUCTIONS } from '../src/ark.js';

const sample = `[段落5] 中国古代思想家对“政道”进行了各种深入的探讨，无论儒家、法家、道家、墨家，都有很多代表性的观点和表述。
[段落6] 笔者就实地考察过100多个国家，立足中国和外部世界的真实发展，力求对中国和外部世界的真实情况做出整体把握。
[段落7] 国有企业建设基础设施遵循政治发展逻辑，民营与混合所有制企业参与市场竞争遵循经济发展逻辑，这种长期规划与市场竞争模式成为中国强产业引领技术创新的独特结构。“国有筑基、民营创新”的模式为“技术孕育产业、产业反哺技术迭代”提供了良性循环的基础。
[段落8] 数据显示，该工程历时10年，共修建公路1018公里，铺设沥青路面458平方米，平均每公里造价约31万元。
[脚注3] 张维为：《中国震撼》，上海人民出版社2011年版。
[脚注4] 参见 https://www.scio.gov.cn 的相关报道。`;

const prompt = `【稿件信息】标题：测试稿；全文约 500 字。
【本段正文（段落号即 paragraphIndex）】
${sample}

请审阅以上内容，逐条指出问题。`;

const r = await arkRespond({
  model: process.argv[2] || DEFAULT_MODEL,
  input: prompt,
  instructions: REVIEW_INSTRUCTIONS,
  schema: ISSUE_SCHEMA,
  maxOutputTokens: 8000,
});
console.log('model:', process.argv[2] || DEFAULT_MODEL);
console.log('usage:', JSON.stringify(r.usage));
const parsed = parseJsonLoose(r.text);
if (!parsed) { console.log('RAW:', r.text.slice(0, 2000)); process.exit(1); }
console.log('issues:', parsed.issues.length);
for (const it of parsed.issues) {
  console.log(`\n[${it.category}/${it.severity}] ${it.title}  (段落${it.paragraphIndex})`);
  console.log(`  原文: ${it.quote}`);
  console.log(`  问题: ${it.problem}`);
  console.log(`  建议: ${it.suggestion}`);
  if (it.proposed) console.log(`  改写: ${it.proposed}`);
}
