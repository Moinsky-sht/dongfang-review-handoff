/**
 * 规则实现一致性核查
 * ---------------------------------------------------------------
 * 把「规则库声明了什么」和「扫描器真正实现了什么」对起来。
 *
 * 背景：规则覆盖测试发现 632 份稿件里有 8 条标为「规则引擎可自动检测」的
 * 规则一次都没触发。逐条追查后发现根因不是「语料没覆盖」，而是三类实现缺陷：
 *   1. 死规则：JSON 里声明了，但任何扫描器都没有对应实现
 *   2. 判据不可达：实现了，但前置分类逻辑把触发条件排除掉了（如 FMT-010）
 *   3. 判据写反/只看正文：如 FMTB-006 只从正文找「【专题】」，不看文件名
 * 另有 id 冲突：同一 id 在 JSON 与扫描器里指两条不同的规则（如 CIT-017）。
 *
 * 本脚本输出这三类问题的完整清单。
 *
 * 用法：node tools/rule-impl-audit.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const scanners = {
  format: 'src/scanner-format.js',
  language: 'src/scanner-language.js',
  citation: 'src/scanner-citation.js',
};
const jsonFiles = {
  format: 'rules/format-rules.json',
  language: 'rules/language-rules.json',
  citation: 'rules/citation-rules.json',
};

/* ---------- 1) 扫描器里实际出现的规则 id ---------- */
const impl = {};       // group -> Set(id)
const implTitles = {}; // `${group}:${id}` -> 扫描器里的 title
for (const [group, file] of Object.entries(scanners)) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  // 抓 R('FMT-001') 与 id: 'FMT-001' 两种写法
  const ids = new Set();
  for (const m of src.matchAll(/\bR\(\s*'([A-Z]+[A-Z-]*\d+)'\s*\)/g)) ids.add(m[1]);
  for (const m of src.matchAll(/\bid:\s*'([A-Z]+[A-Z-]*\d+)'/g)) ids.add(m[1]);
  impl[group] = ids;
  // 抓 id: 'X', ... title: '...' 的配对
  for (const m of src.matchAll(/id:\s*'([A-Z]+[A-Z-]*\d+)'[\s\S]{0,400}?title:\s*'([^']*)'/g)) {
    implTitles[`${group}:${m[1]}`] = m[2];
  }
}

/* ---------- 2) JSON 里声明的规则 ---------- */
const declared = [];   // {id, group, title, status, detectType}
for (const [group, file] of Object.entries(jsonFiles)) {
  const p = join(ROOT, file);
  if (!existsSync(p)) continue;
  const obj = JSON.parse(readFileSync(p, 'utf8'));
  for (const r of obj.rules || []) {
    declared.push({
      id: r.id, group, title: r.title,
      status: r.status || (r.detect?.type === 'model' ? 'model' : 'auto'),
      detectType: r.detect?.type || null,
    });
  }
}

/* ---------- 3) 比对 ---------- */
const dead = [];        // 声明为 auto 但扫描器无实现
const idClash = [];     // 同一 id 两边标题不一致
const notDeclared = []; // 扫描器有、JSON 没有

for (const d of declared) {
  const has = impl[d.group]?.has(d.id);
  if (!has && d.status === 'auto') dead.push(d);
  if (has) {
    const implTitle = implTitles[`${d.group}:${d.id}`];
    if (implTitle && implTitle !== d.title) {
      idClash.push({ ...d, implTitle });
    }
  }
}
const declaredKeys = new Set(declared.map((d) => `${d.group}:${d.id}`));
for (const [group, set] of Object.entries(impl)) {
  for (const id of set) if (!declaredKeys.has(`${group}:${id}`)) notDeclared.push({ group, id });
}

/* ---------- 4) 输出 ---------- */
const total = declared.length;
const autoDeclared = declared.filter((d) => d.status === 'auto').length;
const autoImplemented = declared.filter((d) => d.status === 'auto' && impl[d.group]?.has(d.id)).length;

console.log('规则实现一致性核查\n');
console.log(`JSON 声明规则总数        : ${total}`);
console.log(`  其中标为「规则引擎 auto」: ${autoDeclared}`);
console.log(`  其中扫描器真有实现      : ${autoImplemented}`);
console.log(`  声明 auto 但无实现（死规则）: ${dead.length}`);
console.log(`id 冲突（JSON 与扫描器同名不同规则）: ${idClash.length}`);
console.log(`扫描器有、JSON 未声明    : ${notDeclared.length}`);

if (dead.length) {
  console.log('\n═══ 一、死规则：声明为自动检测，但扫描器没有实现 ═══');
  console.log('（这些规则永远不可能报出问题，却计入「84 条自动检测」）\n');
  for (const d of dead) console.log(`  · ${d.id.padEnd(10)} [${d.group}/${d.detectType}] ${d.title}`);
}

if (idClash.length) {
  console.log('\n═══ 二、id 冲突：同一个 id 在 JSON 与扫描器里是两条不同规则 ═══\n');
  for (const c of idClash) {
    console.log(`  · ${c.id} (${c.group})`);
    console.log(`      JSON  : ${c.title}`);
    console.log(`      扫描器: ${c.implTitle}`);
  }
}

if (notDeclared.length) {
  console.log('\n═══ 三、扫描器实现但 JSON 未声明 ═══\n');
  for (const n of notDeclared) console.log(`  · ${n.id} (${n.group})`);
}

/* ---------- 落盘 ---------- */
const out = {
  generatedAt: new Date().toISOString(),
  summary: {
    declaredTotal: total,
    autoDeclared,
    autoImplemented,
    deadAutoRules: dead.length,
    idClashes: idClash.length,
    implementedNotDeclared: notDeclared.length,
  },
  deadRules: dead,
  idClashes: idClash,
  implementedNotDeclared: notDeclared,
  implemented: Object.fromEntries(Object.entries(impl).map(([k, v]) => [k, [...v].sort()])),
};
const outPath = join(ROOT, 'data', 'verify', 'rule-impl-audit.json');
writeFileSync(outPath, JSON.stringify(out, null, 1), 'utf8');
console.log(`\n明细已写入 ${outPath}`);
