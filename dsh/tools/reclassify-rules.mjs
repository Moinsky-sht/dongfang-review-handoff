/**
 * 规则定性重分类（目标点 11：明确哪些格式可机器直接比对、哪些必须靠模型）。
 *
 * 背景：规则库里有 34 条 `detect.type === 'structure'` 的规则**没有任何实现**。
 * `detect.type: 'structure'` 会让 `/api/status` 把它们算进「规则引擎自动检测」，
 * 于是对外宣称的能力**大于实际能力** —— 这正是目标点 11 要消除的问题。
 *
 * 这个脚本把这 34 条逐条定性，并且**每条都给判据**，而不是凭感觉改：
 *
 *   model   规则本身需要语义判断（有例外条款、要看上下文），改为交模型
 *   manual  需要作者确认 / 需要图表原稿 / 需要原始文献核对，机器做不了
 *   drop    规则本身有误（与国标冲突）或声明的模式在语料上零命中
 *
 * 判据来源写在每条的理由里，都可复现：
 *   · FMT-021 的 detail 自己写了「完整引用独立成句时…引文作为作者句子的一部分时…」
 *     —— 这是条件式规则，正则无法判定「是否独立成句」。
 *   · FMT-040 声明的两个模式在 632 篇语料上命中 0 次（实测）。
 *   · FMTB-012 / FMT-026 / FMTB-039 已在本轮做成真实现，不在此表内。
 *
 * 用法：node tools/reclassify-rules.mjs [--dry]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RULES = join(ROOT, 'rules');
const DRY = process.argv.includes('--dry');

/**
 * 34 条未实现规则的定性。
 * key = 规则号，value = { to, why }
 */
const VERDICT = {
  // ---- 需语义判断，交模型（有例外条款 / 要看上下文） ----
  'FMT-021': { to: 'model', why: 'detail 自述「完整引用独立成句时点号在引号内；引文作为作者句子一部分时点号在引号外」——条件式规则，正则判不出「是否独立成句」。实测按「点号在引号内」硬报会在 150 篇报 784 处，而中文完整引用本就该如此' },
  'FMT-030': { to: 'model', why: '条文含例外「对专门概念、原理、事件加注除外」，须判断注释属于哪一类' },
  'FMTB-001': { to: 'model', why: '条文自述「仅当引用是概括自某一部著作时，可加『参见』二字而不必给页码」——豁免面覆盖了大部分专著引用。实测：150 篇脚注中含「出版社」的 1707 条，无页码仅 167 条，其中 75 条带「参见」（规则明示可豁免）、22 条的引号其实是书名，真正可直接判定的不到 15 条且多为 URL/英文篇名/EndNote 残留' },
  'FMTB-017': { to: 'model', why: '「全文统一」是跨段落一致性判断，需通读比对多种年份写法' },
  'FMTB-024': { to: 'model', why: '「引言不得与摘要重合」须做两段文字的语义相似度判断' },
  'FMTB-029': { to: 'model', why: '著录完整性要看文种体例（中/英/日各不相同）。实测含出版社的脚注中无年份的仅 2.4%，其中多数是西文文献的年份写法差异，正则判不准' },
  'FMTB-030': { to: 'model', why: '「正文引用的数据必须能从所引图表中读出来」须交叉核对正文与图表内容' },
  'FMTB-038': { to: 'model', why: '「按清样中文摘要撰写」须比对中英文摘要语义，且属清样阶段事项' },
  'FMT-038': { to: 'model', why: '「标题与正文内容须一致，不得题文不符」是标题与全文的语义一致性判断' },
  'FMT-011': { to: 'model', why: '「译名首次出现须括注英文原文」须判断某专名是否首次出现、是否已括注' },
  'FMTB-027': { to: 'model', why: '「时间表述必须与所涉事件实际时间相符」是事实核查' },

  // ---- 需要图/表原稿或作者确认，机器做不了 ----
  'FMT-009': { to: 'manual', why: '「同级标题编号形式统一」需人判断标题层级归属，且语料中多数稿件本无编号体系' },
  'FMT-017': { to: 'manual', why: '西文斜体/篇名双引号依赖原稿字体信息，纯文本解析后不可恢复' },
  'FMT-028': { to: 'manual', why: '「独立引文左右各缩进两格、上下各空一行」需看排版效果，属排版阶段' },
  'FMT-029': { to: 'manual', why: '「每页序号从①起重新编号」是排版后的分页结果，Word 文本层拿不到分页' },
  'FMT-032': { to: 'manual', why: '「表题在表上方、图题在图下方、全文连续编号」需图表的实际位置与题注配对' },
  'FMT-034': { to: 'manual', why: '「表注先析出资料来源再析出注释」需读表注原文并判断内容类型' },
  'FMT-035': { to: 'manual', why: '「图表须标明单位与统计口径」需看图表原稿' },
  'FMT-037': { to: 'manual', why: '「基金项目须给出全称与项目编号」需向作者索取编号，且语料中多数稿件无基金' },
  'FMTB-002': { to: 'manual', why: '条文自述「须逐条请作者本人确认」——本质是流程要求，不是文本检查' },
  'FMTB-007': { to: 'manual', why: '「图表必须有题名」需图表对象本身；声明的 4 个模式针对「表1 XXX」「图1」这种占位形态' },
  'FMTB-008': { to: 'manual', why: '「提要不得照抄正文」需语义相似度比对（与 FMTB-024 同源）' },
  'FMTB-009': { to: 'manual', why: '「表格第一行与第一列交叉格不得空白」需表格结构，文本层只有制表符' },
  'FMTB-011': { to: 'manual', why: '「图表各轴单位须单独列出」需图表原稿' },
  'FMTB-016': { to: 'manual', why: '「先文后表：表格与正文之间须有呼应性文字」需表格位置与正文的相对关系' },
  'FMTB-020': { to: 'manual', why: '「图表内容不得与正文重复表述」需图表内容' },
  'FMTB-025': { to: 'manual', why: '「表格单位标注在表框外、表题下一行并靠右对齐」是排版对齐要求' },
  'FMTB-028': { to: 'manual', why: '「图中不宜二次出现图题」需图内文字' },
  'FMTB-032': { to: 'manual', why: '「专有名词与量词全文统一」需建立全文术语表并逐项比对，工作量随篇幅增长，宜用模型通读' },
  'FMTB-035': { to: 'manual', why: '「表格左上角标题须为第一列内容的抽象」需表格结构' },

  // ---- 规则本身有误 / 零命中 ----
  'FMT-040': { to: 'manual', why: '声明的两个模式在 632 篇语料上命中 0 次；按「《书名》+《篇名》」形态实测 137 处全是**相邻的独立书名**（《价值和积累理论》《发达资本主义经济的长波》），不是古籍书名+篇名。判据不成立，降为审稿要点' },
};

const FILES = ['format-rules.json', 'language-rules.json', 'citation-rules.json'];

function loadAll() {
  const out = [];
  for (const f of FILES) {
    const p = join(RULES, f);
    out.push({ file: f, path: p, json: JSON.parse(readFileSync(p, 'utf8')) });
  }
  return out;
}

const stores = loadAll();
const byId = new Map();
for (const s of stores) for (const r of s.json.rules) byId.set(r.id, { rule: r, store: s });

let changed = 0;
const rows = [];
for (const [id, v] of Object.entries(VERDICT)) {
  const hit = byId.get(id);
  if (!hit) { rows.push({ id, to: v.to, from: '(不在规则库)', ok: false, why: v.why }); continue; }
  const from = hit.rule.detect?.type || '(无 detect)';
  hit.rule.detect = hit.rule.detect || {};
  hit.rule.detect.type = v.to;
  // 把定性理由写回规则本身，规则管理页可直接看到「为什么不做成自动检测」
  hit.rule.detect.reclassifiedFrom = from;
  hit.rule.detect.reclassifiedWhy = v.why;
  changed += 1;
  rows.push({ id, to: v.to, from, ok: true, why: v.why });
}

if (!DRY) {
  for (const s of stores) {
    writeFileSync(s.path, `${JSON.stringify(s.json, null, 2)}\n`, 'utf8');
  }
}

const tally = {};
for (const r of rows) tally[r.to] = (tally[r.to] || 0) + 1;

console.log(`═══ 规则定性重分类${DRY ? '（dry-run，未写盘）' : ''} ═══`);
console.log(`共处理 ${rows.length} 条：${Object.entries(tally).map(([k, v]) => `${k} ${v} 条`).join('，')}`);
console.log('');
for (const r of rows.sort((a, b) => a.id.localeCompare(b.id))) {
  console.log(`${r.id}  ${r.from} → ${r.to}`);
  console.log(`    ${r.why}`);
}

// 重分类后的整体分布
console.log('\n═══ 重分类后规则库 type 分布 ═══');
const dist = {};
for (const s of stores) {
  for (const r of s.json.rules) {
    const t = r.detect?.type || '(无)';
    dist[t] = (dist[t] || 0) + 1;
  }
}
for (const [t, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(12)} ${n}`);
console.log(`  合计 ${stores.reduce((a, s) => a + s.json.rules.length, 0)}`);

if (changed && !DRY) console.log(`\n已写回 ${stores.length} 个规则文件。`);
