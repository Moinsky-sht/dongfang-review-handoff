/**
 * 从扫描器源码自动推导「已实现的规则号」
 * ---------------------------------------------------------------
 * 为什么需要这个模块
 * ------------------
 * server.mjs 里原先用三份**手写**的 IMPLEMENTED 集合标注规则状态
 * （规则引擎自动检测 / 模型判断 / 人工复核）。手写清单会漂移：
 *   · FMTB-032 从未实现，却因 `detect.type === 'list'` 的回退分支被算成「自动检测」
 *   · FMTB-018 标的是 manual，却被写进 IMPLEMENTED.format
 *   · LANG-001 / LANG-009 明明在跑，却漏登记
 * 结果页面上显示的「自动检测规则数」长期虚高。
 *
 * 现在改为**在运行时扫描源码**推导，状态不可能再和实现脱节。
 * 判定依据是扫描器里真实的检查项标记：
 *   · scanner-format.js / scanner-language.js  : R('FMT-xxx') 取规则元信息
 *   · scanner-citation.js                      : CHECKS 数组里的 id: 'CIT-xxx'
 *                                               与内联的 push('CIT-xxx', …)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 从一段源码里抽取被当作「检查项」引用的规则号 */
function idsInSource(src) {
  const ids = new Set();
  // R('FMT-001') —— scanner-format.js 取规则元信息，等价于「这里有一项检查」
  for (const m of src.matchAll(/\bR\(\s*'([A-Z][A-Z0-9-]*\d)'\s*\)/g)) ids.add(m[1]);
  // rules.get('LANG-025') —— scanner-language.js 取规则元信息
  for (const m of src.matchAll(/\brules\.get\(\s*'([A-Z][A-Z0-9-]*\d)'\s*\)/g)) ids.add(m[1]);
  // id: 'CIT-001' —— scanner-citation.js 的 CHECKS 数组
  for (const m of src.matchAll(/\bid:\s*'([A-Z][A-Z0-9-]*\d)'/g)) ids.add(m[1]);
  // push('CIT-020', …) —— scanner-citation.js 里内联补写的检查
  for (const m of src.matchAll(/\bpush\(\s*'([A-Z][A-Z0-9-]*\d)'/g)) ids.add(m[1]);
  // ruleId: 'CIT-018' / ruleId === 'LANG-016' —— 直接构造或比较 issue 的写法
  for (const m of src.matchAll(/\bruleId:\s*'([A-Z][A-Z0-9-]*\d)'/g)) ids.add(m[1]);
  for (const m of src.matchAll(/\bruleId\s*===\s*'([A-Z][A-Z0-9-]*\d)'/g)) ids.add(m[1]);
  // ['LANG-008', '口语化词'] —— scanner-language.js 的词表驱动检查
  for (const m of src.matchAll(/\[\s*'([A-Z][A-Z0-9-]*\d)'\s*,\s*'/g)) ids.add(m[1]);
  return ids;
}

let cache = null;

/** 返回 { format:Set, language:Set, citation:Set }，表示各引擎真正实现了哪些规则 */
export function implementedRules() {
  if (cache) return cache;
  const read = (f) => {
    try { return readFileSync(join(ROOT, 'src', f), 'utf8'); } catch { return ''; }
  };
  cache = {
    format: idsInSource(read('scanner-format.js')),
    language: idsInSource(read('scanner-language.js')),
    citation: idsInSource(read('scanner-citation.js')),
  };
  return cache;
}

/** 某个规则号是否在任一引擎里有实现 */
export function isImplemented(id) {
  const impl = implementedRules();
  return impl.format.has(id) || impl.language.has(id) || impl.citation.has(id);
}

/**
 * 判断**一条具体规则**是否真的会被执行。这是给 server.mjs 用的权威判据。
 *
 * 两种实现方式都要认：
 *   1. 显式实现 —— 规则号出现在 scanner-*.js 里（R('FMT-010') / rules.get('LANG-017') …）
 *   2. 通用循环 —— scanner-language.js 第 122—141 行会把**每一条** type='list'
 *      规则的 detect.patterns 都跑一遍，所以「语言规则 + type=list + patterns 非空」
 *      也算有实现，哪怕源码里没有出现它的规则号。
 *
 * 注意反向陷阱：LANG-008/009/013 虽然也是 type=list，但它们的 patterns 是空数组，
 * 真正的词表在 lexiconMap 里，而那段代码默认被 `options.includeFuzzyLexicon` 关掉，
 * 所以它们**不算**自动检测。只看 type 不看 patterns 正是当初 FMTB-032 被错标的原因。
 */
export function ruleWillRun(rule, group) {
  /**
   * ⚠️ 第 31 轮修：**`detect.type === 'manual'` 是权威声明，优先于源码字符串探测**。
   *
   * `isImplemented()` 是**正则抓源码里的规则号**，它无法区分「真实现」与
   * 「注释/文档里提到这个号」或「`id: 'CIT-012'` 这样的残留字符串」。
   * 第 31 轮把 CIT-012 的判据改成 `test: () => false`（不再自动报出）并把
   * `detect.type` 改为 `manual`，但 `CHECKS` 数组里仍有 `id: 'CIT-012'`，
   * 于是 `isImplemented('CIT-012')` 依然为真，页面继续声称它「自动检测」——
   * 正是 withStatus 当初要修的「页面说谎」。
   *
   * 现在规则库显式写 `detect.type === 'manual'` 时一律不执行。
   * 这不会掩盖「声明与实现脱节」：`rule-metadata-consistency.mjs` 与
   * `selftest` 的规则账检查仍然各自核对标题/严重度/实现是否对应。
   */
  if (rule?.detect?.type === 'manual') return false;
  if (isImplemented(rule.id)) return true;
  if (group === 'language' && rule.detect?.type === 'list') {
    const pats = rule.detect.patterns;
    if (Array.isArray(pats) && pats.length > 0) return true;
  }
  return false;
}

/** 该规则号属于哪个引擎的实现（用于诊断），没有则返回 null */
export function implementedIn(id) {
  const impl = implementedRules();
  for (const k of ['format', 'language', 'citation']) if (impl[k].has(id)) return k;
  return null;
}

export const SCANNER_FILES = {
  format: 'scanner-format.js',
  language: 'scanner-language.js',
  citation: 'scanner-citation.js',
};
