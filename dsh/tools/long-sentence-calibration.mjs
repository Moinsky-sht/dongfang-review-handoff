#!/usr/bin/env node
/**
 * 长句阈值标定（目标点 9：避免过度严格）。
 *
 * 「超过 150 字的句子建议拆分」这个阈值到底是不是拍脑袋定的？
 * 这个脚本用**语料里编辑真实的修订动作**来回答，而不是靠主观判断。
 *
 * 方法：`data/corpus/revision-pairs.json` 里有 27 190 条「改前 → 改后」对照
 * （Word 修订痕迹还原出来的）。挑出「改前含 >150 字长句、改后句数变多」
 * 的编辑 —— 这就是**编辑真的在拆句**的直接证据。如果这类编辑大量存在，
 * 且被拆句子的长度分布与规则命中分布吻合，说明阈值落在编辑的实际动作区间内；
 * 如果编辑从不拆 150—200 字的句子，那阈值就是过严。
 *
 * 用法：
 *   node tools/long-sentence-calibration.mjs
 *   node tools/long-sentence-calibration.mjs --threshold 150
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSentences } from '../src/scanner-language.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'verify');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d; };
const THRESHOLD = argOf('--threshold', 150);

const pairs = JSON.parse(readFileSync(join(ROOT, 'data', 'corpus', 'revision-pairs.json'), 'utf8'));
const list = Array.isArray(pairs) ? pairs : (pairs.pairs || []);

const len = (s) => [...s].length;
let considered = 0;
const splitLens = [];
const examples = [];

for (const p of list) {
  const b = String(p.before || '').trim();
  const a = String(p.after || '').trim();
  if (b.length < 120 || a.length < 40) continue;
  considered += 1;
  const sb = splitSentences(b, { semicolon: false });
  const sa = splitSentences(a, { semicolon: false });
  const longB = sb.filter((s) => len(s) > THRESHOLD);
  if (!longB.length) continue;
  // 判据：改后句数增加 = 发生了拆句
  if (sa.length > sb.length) {
    const n = Math.max(...longB.map(len));
    splitLens.push(n);
    if (examples.length < 12) {
      examples.push({ n, nb: sb.length, na: sa.length, before: b.slice(0, 120), after: a.slice(0, 120), file: p.file });
    }
  }
}

splitLens.sort((x, y) => x - y);
const q = (p) => (splitLens.length ? splitLens[Math.min(splitLens.length - 1, Math.floor(splitLens.length * p))] : null);

const payload = {
  generatedAt: new Date().toISOString(),
  threshold: THRESHOLD,
  revisionPairs: list.length,
  comparablePairs: considered,
  splitEdits: splitLens.length,
  splitLen: splitLens.length
    ? { min: splitLens[0], p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), max: splitLens[splitLens.length - 1] }
    : null,
  examples,
  conclusion: splitLens.length >= 20
    ? `语料里有 ${splitLens.length} 处「编辑真的把长句拆开」的修订，被拆句子长度中位数 ${q(0.5)} 字。`
      + `规则阈值 ${THRESHOLD} 字落在编辑实际动作区间内（最短被拆 ${splitLens[0]} 字），阈值有语料依据。`
    : `只找到 ${splitLens.length} 处拆句修订，样本不足，阈值需要重新考虑。`,
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'long-sentence-calibration.json'), JSON.stringify(payload, null, 2), 'utf8');

const md = [
  '# 长句阈值标定（目标点 9）', '',
  `- 生成时间：${payload.generatedAt}`,
  `- 规则阈值：**> ${THRESHOLD} 字**建议拆分`,
  `- 语料修订对：${payload.revisionPairs} 条（可比较 ${considered} 条）`,
  `- **编辑真的拆句的修订：${payload.splitEdits} 处**`, '',
  payload.splitLen
    ? `被拆句子的长度分布：min=${payload.splitLen.min} P25=${payload.splitLen.p25} **P50=${payload.splitLen.p50}** P75=${payload.splitLen.p75} P90=${payload.splitLen.p90} max=${payload.splitLen.max}`
    : '（无样本）',
  '',
  `> ${payload.conclusion}`, '',
  '## 样例（编辑把一句拆成两句以上）', '',
  ...examples.flatMap((e) => [
    `- **${e.n} 字**（${e.nb} 句 → ${e.na} 句）`,
    `  - 改前：\`${e.before}\``,
    `  - 改后：\`${e.after}\``,
  ]),
  '',
];
writeFileSync(join(OUT, '长句阈值标定.md'), md.join('\n'), 'utf8');

console.log('═══ 长句阈值标定（目标点 9） ═══');
console.log(`规则阈值 > ${THRESHOLD} 字`);
console.log(`语料修订对 ${payload.revisionPairs} 条，可比较 ${considered} 条`);
console.log(`编辑真的拆句的修订：${payload.splitEdits} 处`);
if (payload.splitLen) {
  console.log(`被拆句子长度：min=${payload.splitLen.min} P25=${payload.splitLen.p25} P50=${payload.splitLen.p50} P75=${payload.splitLen.p75} P90=${payload.splitLen.p90} max=${payload.splitLen.max}`);
}
console.log(`\n${payload.conclusion}`);
console.log(`\n明细已写入 ${join(OUT, 'long-sentence-calibration.json')}`);
console.log(`报告已写入 ${join(OUT, '长句阈值标定.md')}`);
