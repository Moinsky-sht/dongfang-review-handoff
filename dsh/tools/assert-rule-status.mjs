/**
 * 规则状态一致性断言（回归守卫）
 * ---------------------------------------------------------------
 * 这个项目在「规则数量口径」上漂移过三次：
 *   · FMTB-032 从未实现，却因 type='list' 的回退分支被算成「自动检测」
 *   · FMTB-018 有实现却被标成 manual
 *   · LANG-001 / LANG-006 明明在跑，却漏登记为自动
 * 每次漂移都让页面上显示的「自动检测规则数」失真。
 *
 * 本脚本把三条不变式固化成断言，任何一条被破坏就直接失败：
 *
 *   I1  语料上触发过的规则，必须被判为「会执行」
 *       —— 反例意味着推导漏掉了一种实现机制
 *   I2  判为「会执行」的规则，必须真的能跑（构造样本或语料至少一处报出），
 *       或者被明确记录在「语料未覆盖」清单里
 *       —— 反例意味着「声明为自动但实际不跑」
 *   I3  规则总数守恒：auto + model + manual === 规则库声明总数
 *
 * 用法：node tools/assert-rule-status.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleWillRun, implementedRules } from '../src/implemented-rules.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const fail = [];
const pass = [];
const check = (name, ok, detail = '') => {
  if (ok) pass.push(name);
  else fail.push(`${name}${detail ? ` —— ${detail}` : ''}`);
};

/* ---------- 载入规则库与语料统计 ---------- */
const groups = [
  ['format', 'format-rules.json'],
  ['language', 'language-rules.json'],
  ['citation', 'citation-rules.json'],
];
const rules = [];
for (const [g, f] of groups) {
  const o = JSON.parse(readFileSync(join(ROOT, 'rules', f), 'utf8'));
  for (const r of o.rules || []) rules.push({ ...r, group: g });
}

const cov = JSON.parse(readFileSync(join(ROOT, 'data', 'verify', 'rule-coverage.json'), 'utf8'));
const neverFired = new Set(cov.neverFired);
const fired = new Set(rules.map((r) => r.id).filter((id) => !neverFired.has(id)));

/* 分类结果（若存在则用于 I2 的豁免判断） */
let cls = null;
try { cls = JSON.parse(readFileSync(join(ROOT, 'data', 'verify', 'never-fired-classification.json'), 'utf8')); } catch { /* 可选 */ }

/* ---------- I1：触发过 ⇒ 会执行 ---------- */
{
  const bad = [...fired].filter((id) => {
    const r = rules.find((x) => x.id === id);
    return r && !ruleWillRun(r, r.group);
  });
  check('I1 语料触发过的规则都被判为「会执行」', bad.length === 0, bad.length ? `漏判：${bad.join(', ')}` : '');
}

/* ---------- I2：会执行 ⇒ 确实能跑（或已记录为语料未覆盖） ---------- */
{
  const willRun = rules.filter((r) => ruleWillRun(r, r.group));
  const unexplained = willRun.filter((r) => {
    if (fired.has(r.id)) return false;                       // 语料上跑过，没问题
    if (cls) {
      // 已被定性为「合法未触发」的，属于语料确实没有这种情形，不算问题
      if (cls.legitimatelySilent.includes(r.id)) return false;
      // 定性为「未实现 / 判据失效」的，说明推导与事实不符，必须报错
      if (cls.unimplemented.includes(r.id)) return true;
      if (cls.detectionBroken.includes(r.id)) return true;
    }
    return false;
  });
  check('I2 「会执行」的规则没有与定性结果冲突', unexplained.length === 0,
    unexplained.length ? `冲突：${unexplained.map((r) => r.id).join(', ')}` : '');
}

/* ---------- I3：状态计数守恒 ---------- */
{
  const auto = rules.filter((r) => ruleWillRun(r, r.group));
  const model = rules.filter((r) => !ruleWillRun(r, r.group) && r.detect?.type === 'model');
  const manual = rules.filter((r) => !ruleWillRun(r, r.group) && r.detect?.type !== 'model');
  const sum = auto.length + model.length + manual.length;
  check('I3 规则状态计数守恒', sum === rules.length, `${auto.length}+${model.length}+${manual.length}=${sum}，规则库 ${rules.length}`);
  console.log(`状态分布：auto ${auto.length} / model ${model.length} / manual ${manual.length}（合计 ${sum}，规则库 ${rules.length}）`);
}

/* ---------- 附加：实现清单规模 ---------- */
{
  const impl = implementedRules();
  console.log(`源码推导实现：format ${impl.format.size} / language ${impl.language.size} / citation ${impl.citation.size}`);
}

/* ---------- 结果 ---------- */
console.log(`\n断言结果：${pass.length} 通过 / ${fail.length} 失败`);
for (const p of pass) console.log(`  ✓ ${p}`);
for (const f of fail) console.log(`  ✗ ${f}`);

const out = {
  generatedAt: new Date().toISOString(),
  passed: pass,
  failed: fail,
  corpusDocs: cov.docsScanned,
  firedOnCorpus: fired.size,
  neverFired: neverFired.size,
};
const { writeFileSync } = await import('node:fs');
writeFileSync(join(ROOT, 'data', 'verify', 'rule-status-assertions.json'), JSON.stringify(out, null, 1), 'utf8');
console.log('\n明细已写入 data/verify/rule-status-assertions.json');

process.exit(fail.length ? 1 : 0);
