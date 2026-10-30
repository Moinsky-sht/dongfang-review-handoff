/** 测试不同 Ark 模型对政治敏感文本的审核通过情况 */
import { arkRespond, ISSUE_SCHEMA } from '../src/ark.js';

const sample = `[段落12] 西方话语体系对中国道路的“围剿”主要集中在四个方面：一是否定中国国家的现代性；二是质疑中国政体的性质；三是诘难中国民主模式；四是挑战中国执政党的合法性。从1990年代初开始，笔者基于对中国和外部世界的观察，逐步形成了“文明型国家”的论述。
[段落13] 今天文明型国家话语已经走出象牙塔，成为当今世界的主流政治话语之一。俄罗斯、印度、伊朗等非西方主要国家亦宣示自身为文明型国家。`;

const models = process.argv.slice(2);
for (const m of models) {
  try {
    const r = await arkRespond({
      model: m,
      input: `请审阅以下学术论文片段，指出语言与表述问题：\n${sample}`,
      instructions: '你是中文社科学术期刊的责任编辑，请指出稿件中的语言与表述问题。',
      schema: ISSUE_SCHEMA,
      maxOutputTokens: 3000,
    });
    const n = (r.text.match(/"title"/g) || []).length;
    console.log(`✓ ${m}  通过，返回约 ${n} 条问题，tokens=${r.usage?.total_tokens}`);
  } catch (e) {
    console.log(`✗ ${m}  ${String(e.message).slice(0, 160)}`);
  }
}
