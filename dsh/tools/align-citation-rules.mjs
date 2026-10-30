/**
 * 对齐 citation 规则库与扫描器实现
 * ---------------------------------------------------------------
 * 问题：rules/citation-rules.json 与 src/scanner-citation.js 各有一套 CIT 编号。
 *   · CIT-001—017：两边同 id 不同标题（30/30 全不一致）
 *   · CIT-018—030：两边一致
 * 规则管理页面展示 JSON 的标题，但真正执行的是扫描器的检查，
 * 于是页面上写的规则名与实际报出的规则名对不上，属「文档与实现不符」。
 *
 * 处理原则：
 *   1. 扫描器是既成事实（它真的在跑），JSON 向扫描器对齐。
 *   2. JSON 原本的规范表述不丢弃，保留到 `normative` 字段，避免丢失体例依据。
 *   3. 只在标题确实不同、且能确认语义对应时改写，改写明细落盘可复核。
 *
 * 用法：node tools/align-citation-rules.mjs [--apply]
 *   不带 --apply 时只打印将要做的改动（dry-run）。
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');

const jsonPath = join(ROOT, 'rules', 'citation-rules.json');
const cit = JSON.parse(readFileSync(jsonPath, 'utf8'));
const impl = JSON.parse(readFileSync(join(ROOT, 'data', 'verify', 'citation-impl-rules.json'), 'utf8'));

/* 扫描器 CIT-001—017 的实现标题 */
const implById = new Map(impl.inlineRules.map((r) => [r.id, r]));

/* 语义对应关系：JSON 的规范表述 → 扫描器实际执行的检查。
   逐条人工核对过，不是靠字符串相似度自动匹配。 */
const MAPPING = {
  'CIT-001': 'CIT-001', // 具体页码        ↔ 文献著录缺少具体页码
  'CIT-002': 'CIT-002', // 须有脚注来源    ↔ 只有标号而无文献信息
  'CIT-003': 'CIT-004', // 领导人讲话一手文献 ↔ 党和国家领导人文献未引权威一手来源
  'CIT-004': 'CIT-016', // 外国人名译名    ↔ 外国人名译名不规范
  'CIT-005': 'CIT-005', // 网络文献六要素  ↔ 网络来源缺最后浏览日期
  'CIT-006': 'CIT-006', // 译著与日文原版  ↔ 网络来源缺文章发布日期（不对应，见下）
  'CIT-007': 'CIT-003', // 马克思主义经典  ↔ 马克思主义经典著作未标明卷次与页码
  'CIT-008': 'CIT-002', // 引文与文献对应  ↔ 出处无法辨识
  'CIT-009': 'CIT-002', // 脚注标号位置    ↔ 出处无法辨识
  'CIT-010': 'CIT-014', // 转引须标明      ↔ 转引二手文献
  'CIT-011': 'CIT-011', // 注释体例字段    ↔ 出版年缺「年版」
  'CIT-012': 'CIT-012', // 网络权威网站    ↔ 西文文献缺 p./pp.（不对应，见下）
  'CIT-013': 'CIT-005', // 网络来源体例    ↔ 网络来源缺最后浏览日期
  'CIT-014': 'CIT-013', // 失效链接        ↔ 内部文件、未刊档案不宜公开引证（不对应，见下）
  'CIT-015': 'CIT-015', // 政治差错        ↔ 缩写未给全称（不对应，见下）
  'CIT-016': 'CIT-016', // 说明性文字入正文 ↔ 外国人名译名不规范（不对应，见下）
  'CIT-017': 'CIT-017', // 图表资料来源    ↔ 中文著作名未用书名号（不对应，见下）
};

/* 语义确实对不上的：不强行改写标题，改为标注「声明与实现不一致，待补实现」 */
const MISMATCH = new Set(['CIT-006', 'CIT-012', 'CIT-014', 'CIT-015', 'CIT-016', 'CIT-017']);

const changes = [];
for (const r of cit.rules || []) {
  const implId = MAPPING[r.id];
  if (!implId) continue;
  const implRule = implById.get(implId);
  if (!implRule) continue;
  if (implRule.title === r.title) continue;
  changes.push({ id: r.id, implId, oldTitle: r.title, newTitle: implRule.title, mismatch: MISMATCH.has(r.id) });
}

console.log(`citation 规则 ${(cit.rules || []).length} 条；需对齐标题的 ${changes.length} 条\n`);
console.log('id'.padEnd(10) + 'JSON 原标题'.padEnd(38) + '扫描器实际检查');
console.log('─'.repeat(120));
for (const c of changes) {
  console.log(`${c.id.padEnd(10)}${c.oldTitle.slice(0, 36).padEnd(38)}${c.newTitle.slice(0, 44)}${c.mismatch ? '   ⚠ 语义不一致' : ''}`);
}

const realMismatch = changes.filter((c) => c.mismatch);
console.log(`\n其中语义确实对不上、不能靠改标题了事的：${realMismatch.length} 条`);
for (const c of realMismatch) console.log(`  · ${c.id}：JSON 说「${c.oldTitle}」，扫描器做的是「${c.newTitle}」`);

if (!APPLY) {
  console.log('\n（dry-run，未写入。加 --apply 才会改写 rules/citation-rules.json）');
  process.exit(0);
}

/* ---------- 应用 ---------- */
copyFileSync(jsonPath, join(ROOT, 'rules', `citation-rules.backup-${Date.now()}.json`));
let n = 0;
for (const r of cit.rules || []) {
  const c = changes.find((x) => x.id === r.id);
  if (!c) continue;
  // 规范表述保留到 normative，避免丢失体例依据
  r.normative = r.rule || r.title;
  r.title = c.newTitle;
  if (c.mismatch) {
    r.note = `声明与实现不一致：规则库原表述为「${c.oldTitle}」，当前扫描器执行的是「${c.newTitle}」，待补实现或调整声明。`;
    r.implemented = false;
  } else {
    r.implemented = true;
  }
  n += 1;
}
writeFileSync(jsonPath, JSON.stringify(cit, null, 1), 'utf8');
writeFileSync(join(ROOT, 'data', 'verify', 'citation-align.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), applied: n, changes }, null, 1), 'utf8');
console.log(`\n已改写 ${n} 条，备份见 rules/citation-rules.backup-*.json`);
console.log('明细已写入 data/verify/citation-align.json');
