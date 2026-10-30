#!/usr/bin/env node
/**
 * 排除登记表校验：任何规则的正则都不得命中「正常汉语」样例。
 *
 * ── 为什么需要这个工具 ────────────────────────────────
 *
 * 第 17–18 轮实测发现：模型在缺口分析里标注为「口语化」「欧化」「赘余」
 * 的若干结构，其实是**正常汉语**，而且量级极大：
 *
 *   · 「作为……的……」   4224 次 / 604 篇（占 632 篇语料的 96%）
 *   · 「进行……的……」   1473 次 / 410 篇
 *   · 「很大程度上」     1258 次 / 434 篇
 *   · 「我认为」          751 次 / 164 篇
 *
 * 把这些做成规则，等于给**几乎全部语料**扣分 —— 正是「审核尺度不能
 * 卡太严」要防的事。当时的判断只写在散文（路线图/验收目标）里，
 * 靠人记住；而「顺手补全词表」是很自然的动作，一旦有人这么干，
 * 尺度就悄悄坏了，而且**不会有任何测试失败**。
 *
 * 所以把结论固化成 `rules/exclusions.json` + 本校验脚本：
 * 登记表里的每一条都是**正常汉语样例**，任何规则命中它即为过度严格。
 *
 * 用法：
 *   node tools/exclusion-check.mjs          # 校验，有命中则退出码 1
 *   node tools/exclusion-check.mjs --md     # 同时输出 markdown 报告
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleWillRun } from '../src/implemented-rules.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REG_PATH = join(ROOT, 'rules', 'exclusions.json');
const OUT_DIR = join(ROOT, 'data', 'verify');

const reg = JSON.parse(readFileSync(REG_PATH, 'utf8'));
const exclusions = reg.exclusions || [];

const GROUPS = [
  ['format', 'format-rules.json'],
  ['language', 'language-rules.json'],
  ['citation', 'citation-rules.json'],
];

/**
 * 只检查**真正会执行**的规则。
 *
 * 为什么必须过这一层：`detect.patterns` 在引文引擎里**从不被执行**
 * （判据在 scanner-citation.js 的 CHECKS 数组里）。最初不过滤，
 * 于是校验器去检查了旧 CIT-004 的残留模式 —— 那条模式实测命中
 * 41103 次 / 618 篇，校验器报「过度严格」，但它在生产里根本不会跑。
 * 这类「拿不执行的判据报警」会让人去改无用的数据，是假警报。
 *
 * 用 ruleWillRun 过滤后，检查的就都是真会跑到语料上的判据。
 */
const allRules = [];
let skipped = 0;
for (const [group, file] of GROUPS) {
  const j = JSON.parse(readFileSync(join(ROOT, 'rules', file), 'utf8'));
  for (const r of j.rules || []) {
    if (!ruleWillRun(r, group)) { skipped += 1; continue; }
    allRules.push({
      id: r.id,
      group,
      title: r.title,
      status: r.status || '',
      detectType: r.detect?.type || '',
      patterns: (r.detect?.patterns || []).slice(),
      lexicon: (r.detect?.lexicon || []).slice(),
    });
  }
}

/** 一条判据是否命中某样例 */
function hits(pattern, sample) {
  try {
    // 词表项按字面包含判断；正则按匹配判断
    const isRegex = /[\\^$.*+?()[\]{}|]/.test(pattern);
    if (!isRegex) return sample.includes(pattern);
    return new RegExp(pattern).test(sample);
  } catch {
    return false;
  }
}

const violations = [];
let checks = 0;
for (const ex of exclusions) {
  for (const r of allRules) {
    // 只查该样例声明的相关规则 + 所有 language/format 规则
    // （引文规则的判据作用于脚注，与这些正文样例无关，但仍一并检查）
    for (const kind of ['patterns', 'lexicon']) {
      for (const p of r[kind]) {
        checks += 1;
        if (hits(p, ex.sample)) {
          violations.push({
            exclusion: ex.id,
            label: ex.label,
            sample: ex.sample,
            ruleId: r.id,
            ruleTitle: r.title,
            kind,
            pattern: p,
            related: (ex.relatedRules || []).includes(r.id),
          });
        }
      }
    }
  }
}

/** 同规则内两条模式命中同一样例 → 会重复报出（第 17 轮踩过） */
const duplicates = [];
for (const r of allRules) {
  if (r.patterns.length < 2) continue;
  // 用规则自己的 patterns 互相交叉：若 p1 的匹配结果也能被 p2 匹配，视为重叠
  for (const ex of exclusions) {
    const hitPats = r.patterns.filter((p) => hits(p, ex.sample));
    if (hitPats.length > 1) {
      duplicates.push({ ruleId: r.id, sample: ex.sample, patterns: hitPats });
    }
  }
}

/* ---------- 输出 ---------- */
console.log('═══ 排除登记表校验 ═══');
console.log(`登记表 ${exclusions.length} 条正常汉语样例`);
console.log(`规则库 ${allRules.length} 条会执行的规则（另有 ${skipped} 条不执行，已跳过）`);
console.log(`共执行 ${checks} 次「判据 × 样例」检查\n`);

if (violations.length === 0) {
  console.log('✅ 无规则命中登记表中的正常汉语样例（审核尺度未被做坏）');
} else {
  console.log(`❌ ${violations.length} 处规则命中正常汉语样例（过度严格）：\n`);
  for (const v of violations) {
    console.log(`  ${v.ruleId}  ${v.ruleTitle}`);
    console.log(`     命中 ${v.exclusion} 「${v.label}」`);
    console.log(`     样例：${v.sample}`);
    console.log(`     判据（${v.kind}）：${v.pattern}`);
    console.log(`     ${v.related ? '（登记表已声明与该规则相关，需收窄判据）' : '（登记表未声明与该规则相关，可能是新引入的过度严格）'}\n`);
  }
}

if (duplicates.length) {
  console.log(`⚠️  ${duplicates.length} 处同规则内模式重叠（同一处会重复报出）：`);
  for (const d of duplicates) console.log(`  ${d.ruleId}: ${d.patterns.join(' | ')}  样例「${d.sample}」`);
} else {
  console.log('✅ 同规则内无模式重叠（不会重复报出）');
}

/* ---------- 落盘 ---------- */
mkdirSync(OUT_DIR, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  exclusions: exclusions.length,
  rulesChecked: allRules.length,
  checksRun: checks,
  violations,
  duplicates,
  ok: violations.length === 0 && duplicates.length === 0,
  register: exclusions.map((e) => ({
    id: e.id, label: e.label, sample: e.sample,
    measured: e.measured, reason: e.reason, relatedRules: e.relatedRules || [],
  })),
};
writeFileSync(join(OUT_DIR, 'exclusion-check.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

if (process.argv.includes('--md')) {
  const L = [];
  L.push('# 排除登记表校验（正常汉语不得报）\n');
  L.push(`- 生成时间：${report.generatedAt}`);
  L.push(`- 登记表样例：**${exclusions.length}** 条`);
  L.push(`- 规则库规则：**${allRules.length}** 条`);
  L.push(`- 执行检查：**${checks}** 次「判据 × 样例」`);
  L.push(`- 结论：${report.ok ? '**通过**（无规则命中正常汉语样例）' : `**未通过**（${violations.length} 处命中）`}\n`);

  L.push('## 为什么需要这张表\n');
  L.push(reg.meta?.why || '');
  L.push('');
  L.push('## 登记的正常汉语样例\n');
  L.push('| 编号 | 样例 | 实测命中 | 涉及规则 |');
  L.push('| --- | --- | ---: | --- |');
  for (const e of exclusions) {
    const m = e.measured ? `${e.measured.hits} 次 / ${e.measured.docs} 篇` : '—';
    L.push(`| ${e.id} | ${e.label} | ${m} | ${(e.relatedRules || []).join('、') || '—'} |`);
  }
  L.push('');
  L.push('## 逐条理由\n');
  for (const e of exclusions) {
    L.push(`### ${e.id}　${e.label}\n`);
    L.push(`- 样例：\`${e.sample}\``);
    if (e.measured) L.push(`- 实测：**${e.measured.hits} 次 / ${e.measured.docs} 篇**${e.measured.corpusShare ? `（占语料 ${e.measured.corpusShare}）` : ''}`);
    L.push(`- 理由：${e.reason}`);
    if (e.distinguishFrom) L.push(`- 与真违规如何区分：${e.distinguishFrom}`);
    L.push('');
  }
  if (violations.length) {
    L.push('## 违规明细\n');
    for (const v of violations) L.push(`- \`${v.ruleId}\` 命中 ${v.exclusion}：判据 \`${v.pattern}\``);
    L.push('');
  }
  writeFileSync(join(OUT_DIR, '排除登记表校验.md'), `${L.join('\n')}\n`, 'utf8');
  console.log(`\n报告已写入 data/verify/排除登记表校验.md`);
}

process.exit(report.ok ? 0 : 1);
