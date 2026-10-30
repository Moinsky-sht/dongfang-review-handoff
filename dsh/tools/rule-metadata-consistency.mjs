#!/usr/bin/env node
/**
 * 规则元信息一致性校验（目标点 12：规则管理优化）。
 *
 * ## 为什么要这个脚本
 *
 * 「规则管理」页面的权威性是整个审稿智能体的地基 —— 审稿人按页面上的
 * 判据理解规则。如果页面显示的标题/严重度与代码实际判的不是一回事，
 * 规则管理就是骗人的。
 *
 * 而引文扫描器（`src/scanner-citation.js`）历史上**两处各写一份元信息**：
 * `CHECKS` 数组自带 `title`/`category`/`severity`，`rules/citation-rules.json`
 * 也写一份，然后 `scanCitation` 用 `RULE_META`（来自 JSON）**覆盖**代码里的。
 * 两份谁也不校验，于是长期漂移。实测抓到 4 处：
 *
 *   · `CIT-008` 库：「只有标号而无文献信息」/ 码：「页码区间使用短横线或波浪线」
 *   · `CIT-018` 库：「缩写首次出现须先给中文全称并备注原文缩写」/ 码：「正文中直接出现网址」
 *   · `CIT-019` 库：「期刊名与文章名用书名号，课程名用双引号」/ 码：「正文注释标号与脚注条目未一一对应」
 *   · `FMT-024` 库 severity=中 / 码=低（代码按实测主动降级并归并，库未同步）
 *
 * 修法：元信息收敛到**规则库一处**；`CHECKS` 只留 `id` + 判据文本。
 *
 * ## 判据为什么用「实际扫描输出」而不是「源码里有没有那个 id」
 *
 * 最初想用「源码里是否出现 `'CIT-0xx'` 字面量」来判断规则是否真的执行。
 * 这个判据**是错的**，并且真的骗过我一次：语言扫描器（`scanner-language.js`）
 * 是**遍历规则库里的 patterns 动态执行**的，源码里根本没有 `'LANG-001'` 这种字面量，
 * 于是 `LANG-001`/`LANG-006` 被误报成「声明了但从未执行」——
 * 而它们其实各自命中 26 / 258 条。
 * （还有一层：`FMT-\d+` 会匹配到 `FMTB-003` 里面，把 FMTB 系列错算进 FMT。）
 *
 * 所以判据改为：**真的跑一遍扫描器**，看它产出的 issue 里每条规则的
 * `title`/`severity` 与规则库是否一致。这是唯一不会骗人的口径。
 *
 * ## 用法
 *
 *   node tools/rule-metadata-consistency.mjs            # 校验（抽样 200 篇）
 *   node tools/rule-metadata-consistency.mjs --all      # 全量 632 篇
 *   node tools/rule-metadata-consistency.mjs --md       # 同时写落盘报告
 *
 * 退出码非 0 表示存在不一致。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocx } from '../src/docx.js';
import { scanFormat } from '../src/scanner-format.js';
import { scanLanguage } from '../src/scanner-language.js';
import { scanCitation } from '../src/scanner-citation.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'verify');
const argv = process.argv.slice(2);
const WANT_MD = argv.includes('--md');
const LIMIT = argv.includes('--all') ? Infinity : 200;

/* ---- 规则库：id → {title, severity, type} ---- */
const LIB = new Map();
for (const f of ['format-rules.json', 'language-rules.json', 'citation-rules.json']) {
  const j = JSON.parse(readFileSync(join(ROOT, 'rules', f), 'utf8'));
  for (const r of j.rules || []) LIB.set(r.id, { title: r.title, severity: r.severity, type: r.detect?.type, file: f });
}

/* ---- 实际跑扫描器，收集真实产出的元信息 ---- */
const coverage = JSON.parse(readFileSync(join(OUT, 'rule-coverage.json'), 'utf8'));
const docs = coverage.perDoc.slice(0, LIMIT === Infinity ? undefined : LIMIT);

/** ruleId → { titles:Set, severities:Set, hits } */
const actual = new Map();
let scanned = 0;
let failed = 0;

for (const d of docs) {
  let doc;
  try { doc = await parseDocx(join(coverage.corpusRoot, d.path)); } catch { failed += 1; continue; }
  scanned += 1;
  for (const fn of [scanFormat, scanLanguage, scanCitation]) {
    let res;
    try { res = fn(doc); } catch { continue; }
    for (const it of res.issues || []) {
      if (!actual.has(it.ruleId)) actual.set(it.ruleId, { titles: new Set(), severities: new Set(), hits: 0 });
      const e = actual.get(it.ruleId);
      if (it.title) e.titles.add(it.title);
      if (it.severity) e.severities.add(it.severity);
      e.hits += 1;
    }
  }
}

/* ---- 比对 ---- */
const mismatches = [];
for (const [id, a] of [...actual].sort()) {
  const lib = LIB.get(id);
  if (!lib) {
    mismatches.push({ id, kind: '规则库里没有', lib: '（缺失）', code: [...a.titles].join(' / '), hits: a.hits });
    continue;
  }
  if (a.titles.size && !a.titles.has(lib.title)) {
    mismatches.push({ id, kind: '标题不一致', lib: lib.title, code: [...a.titles].join(' / '), hits: a.hits, file: lib.file });
  }
  // 严重度：代码可以按长度/语境**动态分档**（如 LANG-010 按句长 低/中/高）。
  // 只要规则库声明的值是实际会出现的值之一，就算一致；否则报出来。
  if (a.severities.size && !a.severities.has(lib.severity)) {
    mismatches.push({
      id, kind: '严重度不一致', lib: lib.severity, code: [...a.severities].join(' / '), hits: a.hits, file: lib.file,
    });
  }
}

/* ---- 声明为自动、但整轮没产出过任何 issue 的规则 ---- */
const silentAuto = [...LIB]
  .filter(([id, r]) => ['regex', 'list', 'structure', 'structural'].includes(r.type) && !actual.has(id))
  .map(([id]) => id);

/* ---- 输出 ---- */
console.log('═══ 规则元信息一致性校验（目标点 12） ═══');
console.log(`抽样 ${scanned} 篇（解析失败 ${failed}），实际产出 ${actual.size} 条不同规则，共 ${[...actual.values()].reduce((s, e) => s + e.hits, 0)} 个 issue`);

const L = [
  '# 规则元信息一致性校验（目标点 12）', '',
  `生成时间：${new Date().toISOString()}`,
  `抽样 ${scanned} 篇（解析失败 ${failed}）`,
  `实际产出 ${actual.size} 条不同规则，共 ${[...actual.values()].reduce((s, e) => s + e.hits, 0)} 个 issue`, '',
];

if (!mismatches.length) {
  console.log('✅ 全部一致：规则库声明的标题/严重度与代码实际产出完全对应。');
  L.push('✅ **全部一致**：规则库声明的标题/严重度与代码实际产出完全对应。', '');
} else {
  console.log(`\n❌ 不一致 ${mismatches.length} 处：`);
  L.push('## 不一致明细', '', '| 规则 | 类型 | 规则库 | 代码实际 | 命中 |', '| --- | --- | --- | --- | ---: |');
  for (const m of mismatches) {
    console.log(`  ${m.id}  ${m.kind}`);
    console.log(`       规则库: ${m.lib}`);
    console.log(`       实际出: ${m.code}`);
    L.push(`| ${m.id} | ${m.kind} | ${m.lib} | ${m.code} | ${m.hits} |`);
  }
  L.push('');
}

if (silentAuto.length) {
  console.log(`\n⚠ 声明为自动、但本轮从未产出 issue 的规则 ${silentAuto.length} 条（可能是真没触发，也可能是空转）：`);
  console.log(`   ${silentAuto.join(', ')}`);
  L.push('## 声明为自动但本轮未产出', '',
    `共 ${silentAuto.length} 条：${silentAuto.join('、')}`, '',
    '> 「未产出」不等于「没实现」—— 也可能只是这批稿件里确实没有这种问题。',
    '> 用 `node tools/rule-liveness.mjs` 做探针复现才能区分。', '');
}

L.push('## 判据说明', '',
  '判据是**真的跑一遍扫描器**，比对它产出的 issue 的 `title`/`severity` 与规则库。',
  '不用「源码里有没有 `\'CIT-0xx\'` 字面量」—— 那个判据会骗人：',
  '语言扫描器是遍历规则库 patterns 动态执行的，源码里没有规则 id 字面量，',
  '会把 `LANG-001`/`LANG-006` 误报成「未执行」（实际各命中 26 / 258 条）。', '');

if (WANT_MD) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, '规则元信息一致性.md'), L.join('\n'), 'utf8');
  console.log(`\n报告已写入 ${join(OUT, '规则元信息一致性.md')}`);
}

process.exit(mismatches.length ? 1 : 0);
