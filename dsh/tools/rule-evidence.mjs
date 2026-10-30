/**
 * 规则证据取证（Phase 2 基础设施）。
 * =================================================================
 * 给定一个规则号，把它在**真实语料**里的每一条命中连同上下文摊开，
 * 供人工/自动化定性：到底是真命中、机械误报，还是判据太松。
 *
 * 为什么需要它
 * ------------
 * 「方向性」（Δ痕迹）与「重合率」都只是**聚合信号**，判不了单条命中的对错。
 * 要定一条规则该留、该收、还是该改，必须看**命中原文**——本工具就是那把放大镜。
 *
 * 做法（快）：先用 `rule-coverage.json` 的 perDoc.rules 把「压根没命中过该规则」
 * 的稿件排除，只对真正命中的那几十篇重新解析扫描；不重复扫全量 632 篇。
 *
 * 用法：
 *   node tools/rule-evidence.mjs --rule=FMT-003
 *   node tools/rule-evidence.mjs --rule=CIT-021 --max=30
 *   node tools/rule-evidence.mjs --rule=LANG-025 --json > ev.json
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapCorpus } from './lib/corpus.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V = join(ROOT, 'data', 'verify');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const RULE = argOf('--rule', '');
const MAX = Number(argOf('--max', 40)) || 40;
const AS_JSON = argv.includes('--json');

if (!RULE) { console.error('用法：node tools/rule-evidence.mjs --rule=<规则号> [--max=N] [--json]'); process.exit(1); }

const cov = JSON.parse(readFileSync(join(V, 'rule-coverage.json'), 'utf8'));
const corpusRoot = cov.corpusRoot;

/** 规则元信息 */
const meta = (() => {
  for (const [group, file] of [['format', 'format-rules.json'], ['language', 'language-rules.json'], ['citation', 'citation-rules.json']]) {
    for (const r of JSON.parse(readFileSync(join(ROOT, 'rules', file), 'utf8')).rules || []) {
      if (r.id === RULE) return { group, title: r.title, severity: r.severity, type: r.detect?.type || null, status: r.status || null, method: r.detect?.method || null };
    }
  }
  return null;
})();

if (!meta) { console.error(`规则库里没有 ${RULE}`); process.exit(1); }

/** 只挑「命中过该规则」的稿件 */
const targets = (cov.perDoc || []).filter((d) => (d.rules || []).includes(RULE));
console.log(`规则 ${RULE}｜${meta.group}/${meta.type}｜${meta.title || ''}`);
console.log(`命中稿件 ${targets.length} 篇，重新解析扫描取证…\n`);

const items = targets.map((d) => ({ full: join(corpusRoot, d.path || d.file), path: d.path || d.file }));
const raws = await mapCorpus(items, 'fpLedger');

const hits = [];
for (const [i, msg] of raws.entries()) {
  if (!msg || !msg.result) continue;
  for (const it of msg.result.issues) {
    if (it.ruleId !== RULE) continue;
    hits.push({
      file: items[i].path,
      paragraphIndex: it.paragraphIndex,
      quote: (it.quote || '').replace(/\s+/g, ' ').slice(0, 120),
      message: it.message,
      paraText: (it.paraText || '').replace(/\s+/g, ' ').slice(0, 120),
    });
  }
}

if (AS_JSON) { console.log(JSON.stringify(hits, null, 2)); process.exitCode = 0; } else {
  console.log(`共 ${hits.length} 条命中，展示前 ${Math.min(MAX, hits.length)} 条：\n`);
  for (const h of hits.slice(0, MAX)) {
    console.log(`· [${h.file.split(/[\\/]/).pop()}] ¶${h.paragraphIndex}`);
    console.log(`  判定：${h.message}`);
    console.log(`  引文：${h.quote || '（空）'}`);
    console.log(`  段落：${h.paraText || '（空）'}`);
    console.log('');
  }
}
