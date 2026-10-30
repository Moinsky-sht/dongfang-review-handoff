/**
 * 抽取 scanner-citation.js 里实际实现的规则清单
 * ---------------------------------------------------------------
 * 用途：scanner-citation.js 的规则编号（CIT-001—030）与 rules/citation-rules.json
 * 的编号是两套互不相干的体系（两边同 id 不同标题，30/30 全不一致）。
 * 规则管理页面展示的是 JSON 的标题，而真正执行的是扫描器里的检查，
 * 于是页面上写的规则名和实际报出的规则名对不上。
 *
 * 本脚本把扫描器里真实存在的规则抽出来，作为对齐 JSON 的依据。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'src', 'scanner-citation.js'), 'utf8');

const rules = [];
/* 形如：
     {
       id: 'CIT-001', category: '...', severity: '高',
       title: '...',
       rule: '...',
       fix: '...',
       source: '...',
       test: (t) => ...,
       message: '...',
       suggestion: '...',
       occurrence: 12,
     },
*/
for (const m of src.matchAll(/\{\s*id:\s*'(CIT-[A-Z0-9]+)',\s*category:\s*'([^']*)',\s*severity:\s*'([^']*)',\s*title:\s*'([^']*)',/g)) {
  rules.push({ id: m[1], category: m[2], severity: m[3], title: m[4] });
}
/* 扫描器里用 R('CIT-xxx') 引用的规则号 */
const referenced = [...new Set([...src.matchAll(/\bR\(\s*'(CIT-[A-Z0-9]+)'\s*\)/g)].map((m) => m[1]))];

console.log(`扫描器内联规则定义：${rules.length} 条`);
for (const r of rules) console.log(`  ${r.id.padEnd(11)} [${r.severity}] ${r.category} / ${r.title}`);
console.log(`\n扫描器引用的规则号（R('…')）：${referenced.length} 个`);
console.log('  ' + referenced.join(', '));

const onlyRef = referenced.filter((id) => !rules.some((r) => r.id === id));
console.log(`\n只被引用、没有内联定义的：${onlyRef.length} 个 -> ${onlyRef.join(', ')}`);

writeFileSync(join(ROOT, 'data', 'verify', 'citation-impl-rules.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), inlineRules: rules, referenced }, null, 1), 'utf8');
console.log('\n已写入 data/verify/citation-impl-rules.json');
