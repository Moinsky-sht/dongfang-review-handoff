/**
 * 规则库结构门禁（Phase 4）。
 * =================================================================
 * `assert-rule-status` 管的是「状态口径守恒」，`rule-metadata-consistency`
 * 管的是「库↔代码元信息一致」，`classify-never-fired` 管的是「未触发定性」——
 * 但**没有一道门管规则库自身的结构合法性**：id 是否重复、编号前缀是否与分组一致、
 * 严重度/判定类型是否在允许集内、期刊参数（摘要字数区间、关键词数量区间）是否齐全。
 * 结构一坏，上面那些下游工具会以各种奇怪方式失真。
 *
 * 本门禁把「规则库的 schema」固化成断言，任何一条被破坏即失败（退出码 1）。
 *
 * 用法：node tools/validate-rules.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = [['format', 'format-rules.json', ['FMT', 'FMTB']], ['language', 'language-rules.json', ['LANG']], ['citation', 'citation-rules.json', ['CIT']]];
const SEVERITIES = new Set(['高', '中', '低']);
const DETECT_TYPES = new Set(['regex', 'list', 'structure', 'structural', 'model', 'manual']);
const STATUSES = new Set(['auto-未触发']);
const ID_RE = /^(FMT|FMTB|LANG|CIT)-\d+$/;

const errors = [];
const warns = [];
const allIds = new Map();

for (const [group, file, prefixes] of GROUPS) {
  let cfg;
  try { cfg = JSON.parse(readFileSync(join(ROOT, 'rules', file), 'utf8')); }
  catch (e) { errors.push(`${file}：无法解析（${e.message}）`); continue; }

  if (!Array.isArray(cfg.rules) || !cfg.rules.length) errors.push(`${file}：缺少 rules 数组`);

  for (const r of cfg.rules || []) {
    const where = `${file}/${r.id || '(无id)'}`;
    if (!r.id) { errors.push(`${where}：缺少 id`); continue; }
    if (!ID_RE.test(r.id)) errors.push(`${where}：id 格式非法（应为 FMT/FMTB/LANG/CIT + 数字）`);
    const pfx = r.id.split('-')[0];
    if (!prefixes.includes(pfx)) errors.push(`${where}：编号前缀与分组不符（${group} 应为 ${prefixes.join('/')}）`);
    if (allIds.has(r.id)) errors.push(`${where}：id 与 ${allIds.get(r.id)} 重复`);
    allIds.set(r.id, file);

    if (!r.title || !r.title.trim()) errors.push(`${where}：缺少 title`);
    if (!SEVERITIES.has(r.severity)) errors.push(`${where}：severity 非法（${JSON.stringify(r.severity)}）`);
    if (!r.detect || !DETECT_TYPES.has(r.detect.type)) errors.push(`${where}：detect.type 非法（${JSON.stringify(r.detect && r.detect.type)}）`);
    if (r.status !== undefined && !STATUSES.has(r.status)) errors.push(`${where}：status 非法（${JSON.stringify(r.status)}）`);

    const t = r.detect && r.detect.type;
    if ((t === 'regex' || t === 'list' || t === 'structure' || t === 'structural')) {
      const hasMechanism = (r.detect.patterns && r.detect.patterns.length)
        || r.detect.check || r.detect.source || (r.detect.lexicon && r.detect.lexicon.length);
      if (!hasMechanism) warns.push(`${where}：机械规则但没有 patterns/check/source/lexicon`);
    }
  }
}

/* 期刊参数齐全性（format-rules.journal 被多个字数/数量规则依赖） */
{
  let cfg = null;
  try { cfg = JSON.parse(readFileSync(join(ROOT, 'rules', 'format-rules.json'), 'utf8')); } catch { /* 上面已报 */ }
  const jn = cfg && cfg.journal;
  for (const key of ['abstractCharRange', 'keywordCountRange', 'abstractMarker']) {
    if (!jn || jn[key] === undefined) errors.push(`format-rules.json/journal：缺少必要字段 ${key}`);
  }
}

console.log('规则库结构门禁');
console.log(`规则总数 ${allIds.size}（期望 138）`);
console.log(`错误 ${errors.length}｜告警 ${warns.length}`);
for (const e of errors) console.log(`  ✗ ${e}`);
for (const w of warns.slice(0, 20)) console.log(`  ! ${w}`);

process.exit(errors.length ? 1 : 0);
