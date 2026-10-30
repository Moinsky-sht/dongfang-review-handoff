/**
 * 规则误报台账（用真实历史批注做监督信号）
 * =================================================================
 * 思路
 * ----
 * 语料里 632 份稿件带着 8 687 条编辑实际写下的批注。这些批注是**真人编辑的判断**：
 * 编辑在某处写了批注，说明那里确实有问题（或至少值得讨论）。
 *
 * 于是可以给每条规则算一个「与编辑关注点重合率」：
 *
 *     重合率 = 该规则命中段落中，与编辑批注锚点重合的条数 / 该规则总命中条数
 *
 * 语义（必须谨慎解读）
 * --------------------
 * · 高重合率 → 规则打在了编辑也在意的地方，可信度高
 * · 低重合率 → 规则打在了编辑**没有**动过的地方。这**不等于**误报：
 *   编辑不可能逐字校完全部体例（632 份里多数是「一审」稿，体例问题常由排版环节处理），
 *   所以低重合率只是「可疑信号」，必须人工抽样复核后才能定性。
 *
 * 本工具的用途是**排序与抽样**：把可疑规则排到前面，并把命中原文摘出来，
 * 让复核者一眼就能判断是误报还是真问题。定论一律靠人工核对后写回 LEDGER_VERDICTS。
 *
 * 输出
 * ----
 *   data/verify/rule-fp-ledger.json   逐规则指标 + 可疑命中样本
 *   data/verify/规则误报台账.md        人读版，含抽样复核清单
 *
 * 用法：node tools/rule-fp-ledger.mjs [--limit N]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapCorpus } from './lib/corpus.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const LIMIT = argOf('--limit', 0);          // 0 = 全量

/* ------------------------------------------------------------------ */
/* 1) 载入历史批注，按文件归集锚点                                       */
/* ------------------------------------------------------------------ */
const occ = JSON.parse(readFileSync(join(ROOT, 'data', 'comments', 'occurrences.json'), 'utf8'));

/** file（反斜杠形式）→ 该文件的批注锚点数组 */
const anchorsByFile = new Map();
for (const o of occ) {
  if (!o.file) continue;
  const key = o.file.replace(/\//g, '\\');
  if (!anchorsByFile.has(key)) anchorsByFile.set(key, []);
  anchorsByFile.get(key).push({
    text: String(o.text || '').trim(),
    anchor: String(o.anchorText || '').trim(),
    paragraphIndex: o.paragraphIndex,
    season: o.season,
    author: o.author,
  });
}
console.log(`历史批注 ${occ.length} 条，覆盖 ${anchorsByFile.size} 个文件`);

/* ------------------------------------------------------------------ */
/* 2) 语料清单                                                        */
/* ------------------------------------------------------------------ */
const cov = JSON.parse(readFileSync(join(ROOT, 'data', 'verify', 'rule-coverage.json'), 'utf8'));
const corpusRoot = cov.corpusRoot;
let perDoc = cov.perDoc || [];
if (LIMIT > 0) perDoc = perDoc.slice(0, LIMIT);
console.log(`待评估稿件 ${perDoc.length} 篇\n`);

/* ------------------------------------------------------------------ */
/* 3) 逐篇扫描并比对                                                   */
/* ------------------------------------------------------------------ */
/** 归一化：去空白与全角/半角差异，便于包含判断 */
const norm = (s) => String(s || '').replace(/[\s\u3000]+/g, '').replace(/[，,]/g, '，');

/** 规则号 → 统计 */
const stats = new Map();
const ensure = (id, group) => {
  if (!stats.has(id)) {
    stats.set(id, {
      id, group,
      hits: 0,              // 命中条数
      overlap: 0,           // 与编辑批注锚点重合的条数
      docs: new Set(),      // 命中稿件
      overlapDocs: new Set(),
      samples: [],          // 未重合的命中样本（可疑误报）
      matched: [],          // 重合的命中样本（可信）
    });
  }
  return stats.get(id);
};

let done = 0;
let anchorsUsed = 0;
const t0 = Date.now();

const items = perDoc.map((d) => {
  const rel = String(d.path || d.file || '');
  return { full: join(corpusRoot, rel), path: rel };
});
const raws = await mapCorpus(items, 'fpLedger', {
  onProgress: (n, total) => { if (n % 100 === 0 || n === total) console.log(`  … 已扫描 ${n}/${total}（${((Date.now() - t0) / 1000).toFixed(0)}s）`); },
});
console.log('');

for (const [i, msg] of raws.entries()) {
  if (!msg || !msg.result) continue;
  done += 1;
  const rel = items[i].path;

  const anchors = anchorsByFile.get(rel) || [];
  const anchorNorms = anchors.map((a) => norm(a.anchor)).filter((s) => s.length >= 4);
  if (anchorNorms.length) anchorsUsed += 1;

  for (const it of msg.result.issues) {
    const st = ensure(it.ruleId, it.group || '');
    st.hits += 1;
    st.docs.add(rel);

    // 重合判定：命中引文 / 所在段落文本，是否与某条批注锚点互相包含
    const quote = norm(it.quote);
    const paraText = norm(it.paraText);
    const probe = quote.length >= 6 ? quote : paraText;
    let hit = false;
    if (probe.length >= 4) {
      for (const a of anchorNorms) {
        if (a.includes(probe) || probe.includes(a)) { hit = true; break; }
        // 长引文取前 24 字做宽松匹配
        if (probe.length >= 24 && a.includes(probe.slice(0, 24))) { hit = true; break; }
      }
    }
    if (hit) {
      st.overlap += 1;
      st.overlapDocs.add(rel);
      if (st.matched.length < 3) {
        st.matched.push({ file: rel, quote: (it.quote || '').slice(0, 90), message: it.message });
      }
    } else if (st.samples.length < 6) {
      st.samples.push({
        file: rel,
        quote: (it.quote || '').slice(0, 90),
        message: it.message,
        paraIndex: it.paragraphIndex,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4) 汇总与排序                                                      */
/* ------------------------------------------------------------------ */
const rows = [...stats.values()].map((s) => ({
  id: s.id,
  group: s.group,
  hits: s.hits,
  docs: s.docs.size,
  overlap: s.overlap,
  overlapDocs: s.overlapDocs.size,
  overlapRate: s.hits ? +(s.overlap / s.hits).toFixed(4) : 0,
  // 可疑度：命中多但重合率低 → 排前面；命中 <10 条的先不排（样本太小无意义）
  suspect: s.hits >= 10,
  samples: s.samples,
  matched: s.matched,
}));

rows.sort((a, b) => {
  // 先按「命中数 × (1 - 重合率)」降序，即「可疑命中绝对量」大的排前
  const wa = a.hits * (1 - a.overlapRate);
  const wb = b.hits * (1 - b.overlapRate);
  return wb - wa;
});

const totalHits = rows.reduce((s, r) => s + r.hits, 0);
const totalOverlap = rows.reduce((s, r) => s + r.overlap, 0);
console.log(`\n扫描完成：${done} 篇，命中 ${totalHits} 条，其中与编辑批注重合 ${totalOverlap} 条`
  + `（整体重合率 ${(totalOverlap / (totalHits || 1) * 100).toFixed(1)}%）`);
console.log(`有批注可比的稿件 ${anchorsUsed} 篇`);

/* ------------------------------------------------------------------ */
/* 5) 落盘                                                            */
/* ------------------------------------------------------------------ */
const out = {
  generatedAt: new Date().toISOString(),
  docsScanned: done,
  docsWithComments: anchorsUsed,
  commentOccurrences: occ.length,
  totalHits,
  totalOverlap,
  overallOverlapRate: +(totalOverlap / (totalHits || 1)).toFixed(4),
  caveat: '重合率低不等于误报：编辑不会逐字校完全部体例，低重合率只是「可疑信号」，'
    + '必须人工抽样复核后才能定性。本文件用于排序与抽样，不定论。',
  rules: rows,
};
writeFileSync(join(ROOT, 'data', 'verify', 'rule-fp-ledger.json'), JSON.stringify(out, null, 1), 'utf8');

/* Markdown 人读版 */
const md = [];
md.push('# 规则误报台账（基于真实历史批注）', '');
md.push(`- 生成时间：${out.generatedAt}`);
md.push(`- 扫描稿件：**${done}** 篇（其中 **${anchorsUsed}** 篇带编辑批注可比对）`);
md.push(`- 历史批注总量：${occ.length} 条`);
md.push(`- 规则命中：**${totalHits}** 条，与编辑批注锚点重合 **${totalOverlap}** 条`
  + `（整体重合率 **${(out.overallOverlapRate * 100).toFixed(1)}%**）`);
md.push('');
md.push('> **解读警告**：重合率低**不等于**误报。语料里多数是「一审」稿，编辑不会逐字校完全部');
md.push('> 体例（排版类问题常留到排版环节）。因此本表用于**排序与抽样**，把可疑规则排到前面并');
md.push('> 摘出命中原文供人工判断，**不自动定论**。');
md.push('');
md.push('## 一、可疑规则排序（命中 ≥10 条，按「可疑命中绝对量」降序）', '');
md.push('| 规则号 | 组 | 命中 | 涉及稿件 | 与批注重合 | 重合率 | 可疑量 |');
md.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const r of rows.filter((x) => x.suspect).slice(0, 40)) {
  md.push(`| ${r.id} | ${r.group} | ${r.hits} | ${r.docs} | ${r.overlap} | `
    + `${(r.overlapRate * 100).toFixed(1)}% | ${Math.round(r.hits * (1 - r.overlapRate))} |`);
}
md.push('');
md.push('## 二、抽样复核清单（前 15 条可疑规则的命中原文）', '');
for (const r of rows.filter((x) => x.suspect).slice(0, 15)) {
  md.push(`### ${r.id}（${r.group}）命中 ${r.hits} 条，重合率 ${(r.overlapRate * 100).toFixed(1)}%`, '');
  md.push('**与批注重合的（可信）**：');
  if (r.matched.length) for (const m of r.matched) md.push(`- \`${m.quote}\` —— ${m.message}`);
  else md.push('- （无）');
  md.push('', '**未重合的（待人工判断是否误报）**：');
  if (r.samples.length) for (const s of r.samples) md.push(`- \`${s.quote}\` —— ${s.message}`);
  else md.push('- （无）');
  md.push('');
}
md.push('## 三、全部规则指标', '');
md.push('| 规则号 | 组 | 命中 | 稿件 | 重合 | 重合率 |');
md.push('| --- | --- | ---: | ---: | ---: | ---: |');
for (const r of rows) {
  md.push(`| ${r.id} | ${r.group} | ${r.hits} | ${r.docs} | ${r.overlap} | ${(r.overlapRate * 100).toFixed(1)}% |`);
}
md.push('');
writeFileSync(join(ROOT, 'data', 'verify', '规则误报台账.md'), md.join('\n'), 'utf8');

console.log('\n已写入 data/verify/rule-fp-ledger.json 与 data/verify/规则误报台账.md');
console.log('\n可疑规则 Top 12（命中≥10，按可疑量降序）:');
console.log('  规则号        命中   重合  重合率   可疑量');
for (const r of rows.filter((x) => x.suspect).slice(0, 12)) {
  console.log(`  ${r.id.padEnd(12)} ${String(r.hits).padStart(5)} ${String(r.overlap).padStart(6)} `
    + `${(r.overlapRate * 100).toFixed(1).padStart(6)}% ${String(Math.round(r.hits * (1 - r.overlapRate))).padStart(7)}`);
}
