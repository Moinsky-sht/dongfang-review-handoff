/**
 * CIT 规则标题对齐核查
 * ---------------------------------------------------------------
 * 背景：tools/rule-impl-audit.mjs 发现 citation 组里 JSON 与扫描器同 id 不同标题。
 * 需要判断这些是「真的规则内容不一致」还是「扫描器的 id 顺序与 JSON 不同」。
 * 本脚本把两边标题并排列出，便于人工判定。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cit = JSON.parse(readFileSync(join(ROOT, 'rules', 'citation-rules.json'), 'utf8'));
const src = readFileSync(join(ROOT, 'src', 'scanner-citation.js'), 'utf8');

/* 抓扫描器里 id / title 相邻出现的配对（容错：title 可在 id 之后 500 字符内） */
const impl = new Map();
for (const m of src.matchAll(/id:\s*'([A-Z]+[A-Z-]*\d+)'([\s\S]{0,500}?)title:\s*'([^']*)'/g)) {
  if (!impl.has(m[1])) impl.set(m[1], m[3]);
}

const rows = [];
for (const r of cit.rules || []) {
  const implTitle = impl.get(r.id) || '（扫描器未实现）';
  rows.push({ id: r.id, json: r.title, impl: implTitle, same: implTitle === r.title });
}

const diff = rows.filter((r) => !r.same);
console.log(`citation 规则 ${rows.length} 条；标题一致的 ${rows.length - diff.length} 条，不一致的 ${diff.length} 条\n`);
console.log('id'.padEnd(10) + 'JSON 规则'.padEnd(40) + '扫描器实现');
console.log('─'.repeat(120));
for (const r of diff) {
  console.log(`${r.id.padEnd(10)}${r.json.slice(0, 38).padEnd(40)}${r.impl.slice(0, 46)}`);
}

/* 判断扫描器里那些标题是否在 JSON 中作为别的 id 存在（即只是顺序不同） */
const jsonTitles = new Map((cit.rules || []).map((r) => [r.title, r.id]));
console.log('\n扫描器标题能在 JSON 中找到对应 id 的（说明只是编号顺序不同，不是内容冲突）：');
for (const r of diff) {
  const jsonId = jsonTitles.get(r.impl);
  if (jsonId) console.log(`  ${r.id} 的实现在 JSON 里对应 ${jsonId}：「${r.impl.slice(0, 40)}」`);
}
console.log('\n扫描器标题在 JSON 中找不到对应项（说明是 JSON 独有的声明，未实现）：');
for (const r of diff) {
  if (!jsonTitles.get(r.impl) && r.impl !== '（扫描器未实现）') {
    console.log(`  ${r.id}：「${r.impl.slice(0, 44)}」—— JSON 里没有这条规则`);
  }
}
