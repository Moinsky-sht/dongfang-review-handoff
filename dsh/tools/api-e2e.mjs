/**
 * 端到端 API 测试：模拟网页的完整操作序列。
 * 用法：node tools/api-e2e.mjs <稿件.docx> [--no-model]
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3210';
let file = process.argv[2];
const useModel = !process.argv.includes('--no-model');

/** 支持 --pick=N，由 manifest 解析真实路径（规避 PowerShell 对中文路径的破坏） */
const pickArg = process.argv.find((a) => a.startsWith('--pick='));
if (pickArg) {
  const ROOT = resolve('..', '发给皓天的一审文件');
  const man = JSON.parse(readFileSync(resolve('data/corpus/manifest.json'), 'utf8'));
  const list = man.map((m) => ({ ...m, full: join(ROOT, m.path) }))
    .filter((m) => m.comments >= 25 && existsSync(m.full))
    .sort((a, b) => b.comments - a.comments);
  const n = Number(pickArg.slice(7));
  file = list[n].full;
  console.log(`[pick ${n}] ${list[n].comments} 条历史批注`);
}
if (!file) { console.error('用法：node tools/api-e2e.mjs <稿件.docx|--pick=N> [--no-model]'); process.exit(1); }

let pass = 0; let fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

console.log(`\n═══ 端到端 API 测试（${BASE}）═══\n`);

/* 1. health */
console.log('[1] GET /api/health');
const h = await (await fetch(`${BASE}/api/health`)).json();
ok(h.ok === true, '服务健康');
ok(h.rules.format >= 30 && h.rules.language >= 25 && h.rules.citation >= 20, `规则条数 ${h.rules.format}/${h.rules.language}/${h.rules.citation}`);
ok(h.models.length >= 3, `可选模型 ${h.models.length} 个`);

/* 2. rules */
console.log('\n[2] GET /api/rules');
const r = await (await fetch(`${BASE}/api/rules`)).json();
ok(r.format.rules.length >= 30, `格式规则 ${r.format.rules.length}`);
ok(r.language.lexicon && Object.keys(r.language.lexicon).length >= 5, `语言词表 ${Object.keys(r.language.lexicon).length} 组`);
ok(r.modelRules.length >= 5, `需模型判断的规则 ${r.modelRules.length} 条`);
ok(typeof r.instructions === 'string' && r.instructions.length > 500, '审稿提示词已下发');

/* 3. upload */
console.log('\n[3] POST /api/upload');
const buf = readFileSync(resolve(file));
const up = await (await fetch(`${BASE}/api/upload?name=${encodeURIComponent(basename(file))}`, { method: 'POST', body: buf })).json();
ok(!up.error, `上传成功${up.error ? '：' + up.error : ''}`);
if (up.error) process.exit(1);
const doc = up.doc;
ok(doc.paragraphs.length > 10, `段落 ${doc.paragraphs.length}`);
ok(doc.footnotes.length >= 0, `脚注 ${doc.footnotes.length}`);
ok(doc.meta && doc.meta.title, `识别标题：${doc.meta.title?.slice(0, 40)}`);
ok(doc.stats && typeof doc.stats.chars === 'number', `字数 ${doc.stats?.chars}`);

/* 4. review */
console.log(`\n[4] POST /api/review（useModel=${useModel}）`);
const t0 = Date.now();
const rv = await (await fetch(`${BASE}/api/review`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: up.id, useModel, model: process.env.MODEL }),
})).json();
const secs = ((Date.now() - t0) / 1000).toFixed(1);
ok(!rv.error, `审阅完成（${secs}s）${rv.error ? '：' + rv.error : ''}`);
if (rv.error) process.exit(1);
ok(rv.summary.total > 0, `问题总数 ${rv.summary.total}`);
ok(rv.summary.format >= 0 && rv.summary.language >= 0 && rv.summary.citation >= 0, `格式 ${rv.summary.format} / 语言 ${rv.summary.language} / 引文 ${rv.summary.citation}`);
ok(rv.issues.every((i) => i.ruleId && i.severity && i.group), '每条问题都有 ruleId/severity/group');
ok(rv.issues.every((i) => i.title), '每条问题都有标题');
const unlocatable = rv.issues.filter((i) => i.paragraphIndex === undefined && i.footnoteIndex === undefined
  && i.tableIndex === undefined && i.location !== 'document');
ok(unlocatable.length === 0, '每条问题都有可定位的位置', `${unlocatable.length} 条不可定位：${unlocatable.slice(0, 3).map((i) => i.ruleId + '/' + i.location).join(', ')}`);
if (useModel) {
  ok(rv.summary.modelBased >= 0, `模型发现 ${rv.summary.modelBased} 条`);
  ok(Array.isArray(rv.modelErrors), `模型错误 ${rv.modelErrors.length} 处`);
}
const withQuote = rv.issues.filter((i) => i.quote).length;
console.log(`  · 带原文片段的问题：${withQuote}/${rv.issues.length}`);
const fixable = rv.issues.filter((i) => i.autoFix?.find).length;
console.log(`  · 可自动修复的问题：${fixable}`);

/* 5. apply-fixes */
console.log('\n[5] POST /api/apply-fixes');
const fixableKeys = rv.issues.filter((i) => i.autoFix?.find).slice(0, 5).map((i) => `${i.ruleId}|${i.location}|${i.quote || ''}`);
if (fixableKeys.length) {
  const af = await (await fetch(`${BASE}/api/apply-fixes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: up.id, accepted: fixableKeys, baseReviewRunId: rv.reviewRunId }),
  })).json();
  ok(!af.error, `应用修复${af.error ? '：' + af.error : ''}`);
  ok(Array.isArray(af.applied), `实际应用 ${af.applied?.length} 项`);
  ok(af.doc && af.doc.paragraphs.length > 0, '返回更新后的文档');
  for (const a of (af.applied || []).slice(0, 3)) console.log(`    · ${a.ruleId} ${a.before.slice(0, 40)} → ${a.after.slice(0, 40)}`);
} else {
  console.log('  - 跳过（无自动修复项）');
}

/* 6. report */
console.log('\n[6] POST /api/report');
const rp = await (await fetch(`${BASE}/api/report`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: up.id }),
})).json();
ok(!rp.error, `报告生成${rp.error ? '：' + rp.error : ''}`);
ok((rp.markdown || '').includes('# 《东方学刊》一审审校报告'), '报告含标题');
ok((rp.markdown || '').includes('人工复核'), '报告含人工复核提示');
ok(rp.savedTo && rp.savedTo.endsWith('.md'), `落盘：${rp.savedTo}`);
console.log(`  · 报告长度 ${(rp.markdown || '').length} 字符`);

/* 7. 静态资源 */
console.log('\n[7] 静态资源');
for (const p of ['/', '/app.js', '/styles.css']) {
  const res = await fetch(`${BASE}${p}`);
  ok(res.status === 200, `${p} → ${res.status}`);
}

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══\n`);
process.exit(fail ? 1 : 0);
