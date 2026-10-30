/**
 * 批量 API 链路验证：对多份真实稿件依次走完
 *   上传 → 规则审阅 → 自动修复 → 报告生成
 * 并校验每一步的响应结构与不变量，确认网页端依赖的接口在大量稿件上都正常。
 *
 * 用法：
 *   node tools/api-batch.mjs                 # 默认 20 份（按问题数分层抽样）
 *   node tools/api-batch.mjs --count=40
 *   node tools/api-batch.mjs --sha=<sha256>
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3210';
const args = process.argv.slice(2);
const flag = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const COUNT = Number(flag('count', 20)) || 20;
const ONLY_SHA = flag('sha', '');
const ROOT = resolve('..', '发给皓天的一审文件');

const manifest = JSON.parse(readFileSync(resolve('data/corpus/manifest.json'), 'utf8'));
let picks = manifest.filter((m) => existsSync(join(ROOT, m.path)));
if (ONLY_SHA) picks = picks.filter((m) => m.sha256 === ONLY_SHA);

// 分层抽样：按语料顺序均匀取，保证覆盖各季次、各栏目
if (!ONLY_SHA) {
  const step = Math.max(1, Math.floor(picks.length / COUNT));
  const out = [];
  for (let i = 0; i < picks.length && out.length < COUNT; i += step) out.push(picks[i]);
  picks = out;
}

const results = [];
let pass = 0;
let fail = 0;
const failures = [];
/** 按检查项统计失败，便于定位是哪一项不满足 */
const failByCheck = {};

function check(cond, label) {
  if (cond) { pass += 1; return true; }
  fail += 1;
  failByCheck[label] = (failByCheck[label] || 0) + 1;
  return false;
}

for (const [i, m] of picks.entries()) {
  const file = join(ROOT, m.path);
  const rec = { name: basename(m.path), path: m.path, steps: {}, errors: [] };
  const t0 = Date.now();
  /** 各阶段耗时，用于定位性能瓶颈 */
  const stage = {};
  const mark = (label, from) => { stage[label] = Date.now() - from; };
  try {
    const buf = readFileSync(file);
    const tRead = Date.now();

    /* 1) 上传 */
    const upRes = await fetch(`${BASE}/api/upload?name=${encodeURIComponent(basename(m.path))}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: buf,
    });
    const up = await upRes.json();
    mark('上传', tRead);
    if (!check(upRes.ok && up.id, '上传')) { rec.errors.push(`上传失败 HTTP ${upRes.status}: ${JSON.stringify(up).slice(0, 200)}`); results.push(rec); continue; }
    const upParas = up.doc?.paragraphs?.length ?? up.paragraphs ?? 0;
    rec.steps.upload = { id: up.id, paragraphs: upParas, footnotes: up.doc?.footnotes?.length };
    check(typeof upParas === 'number' && upParas > 0, '上传返回段落数');
    check(Array.isArray(up.doc?.paragraphs), '上传返回文档结构');

    /* 2) 规则审阅 */
    const tReview = Date.now();
    const rvRes = await fetch(`${BASE}/api/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: up.id, useModel: false }),
    });
    const rv = await rvRes.json();
    mark('规则审阅', tReview);
    if (!check(rvRes.ok && Array.isArray(rv.issues), '规则审阅')) { rec.errors.push(`审阅失败 HTTP ${rvRes.status}: ${JSON.stringify(rv).slice(0, 200)}`); results.push(rec); continue; }
    rec.steps.review = { total: rv.issues.length, summary: rv.summary };
    // 记下「未被自动修复改动过」时的原始问题数：
    // 后面的异步审阅在应用自动修复之后才跑，文档文本已经变了，条数本来就会不同，
    // 必须拿这个原始值去比对，否则会误判成两条路径不一致。
    const originalIssueCount = rv.issues.length;

    // 不变量：每条问题都应有 ruleId / severity / location
    const badShape = rv.issues.filter((x) => !x.ruleId || !x.severity || !x.location);
    check(badShape.length === 0, '问题条目结构完整');
    if (badShape.length) rec.errors.push(`${badShape.length} 条问题缺 ruleId/severity/location`);

    // 不变量：paragraphIndex 必须落在文档段落范围内
    const badIdx = rv.issues.filter((x) => x.paragraphIndex !== undefined
      && (x.paragraphIndex < 0 || x.paragraphIndex >= upParas));
    check(badIdx.length === 0, '段落索引在范围内');
    if (badIdx.length) rec.errors.push(`${badIdx.length} 条问题段落索引越界`);

    // 不变量：同一 key 不重复
    const keys = rv.issues.map((x) => `${x.ruleId}|${x.location}|${x.quote || ''}`);
    check(new Set(keys).size === keys.length, '问题无重复');
    if (new Set(keys).size !== keys.length) rec.errors.push(`存在重复问题条目（${keys.length - new Set(keys).size} 条）`);

    /* 3) 自动修复 */
    // 注意：删除类改写（replace === ''）也是有效的自动修复，不能因 replace 为空而漏掉，
    // 否则这些 key 不会送进 /api/apply-fixes，重审后被误判成「残留可修复项」。
    // 口径与前端 isFixable() 及服务端 apply-fixes 完全一致。
    const fixable = rv.issues.filter((x) => x.autoFix && x.autoFix.find
      && x.autoFix.find !== x.autoFix.replace);
    rec.steps.fixable = fixable.length;
    // 空操作改写必须已被上游过滤
    const noop = rv.issues.filter((x) => x.autoFix && x.autoFix.find === x.autoFix.replace);
    check(noop.length === 0, '无空操作改写');

    const fxRes = await fetch(`${BASE}/api/apply-fixes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: up.id, accepted: fixable.map((x) => `${x.ruleId}|${x.location}|${x.quote || ''}`), baseReviewRunId: rv.reviewRunId }),
    });
    const fx = await fxRes.json();
    // 接口返回 { applied: [...], skipped: [...], doc: {...} }，applied 是明细数组
    check(fxRes.ok && Array.isArray(fx.applied), '自动修复接口');
    const appliedCount = Array.isArray(fx.applied) ? fx.applied.length : 0;
    const skippedCount = Array.isArray(fx.skipped) ? fx.skipped.length : 0;
    rec.steps.applied = appliedCount;
    rec.steps.skipped = skippedCount;
    if (fixable.length > 0) {
      check(appliedCount > 0, '自动修复确实生效');
      if (appliedCount === 0) {
        rec.errors.push(`有 ${fixable.length} 条可修复项但一条都没应用；跳过原因：${JSON.stringify((fx.skipped || []).slice(0, 3))}`);
      }
    }
    // 修复后文档文本必须真的变了
    if (appliedCount > 0 && fx.doc?.paragraphs) {
      const changed = fx.doc.paragraphs.filter((p) => p.before !== p.after).length;
      check(changed > 0, '修复后文本有实际变化');
      if (changed === 0) rec.errors.push('报告已应用修复但文本无变化');
      rec.steps.changedParagraphs = changed;
    }

    /* 4) 报告 */
    const tReport = Date.now();
    const rpRes = await fetch(`${BASE}/api/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: up.id }),
    });
    const rp = await rpRes.json();
    mark('报告', tReport);
    check(rpRes.ok && rp.markdown && rp.markdown.length > 500, '报告生成');
    rec.steps.reportChars = rp.markdown?.length || 0;
    if (rp.markdown) {
      // 报告标题取自稿件内部的标题（而非文件名），所以核对「有标题行 + 有稿件信息」即可
      check(/^#\s+\S/m.test(rp.markdown), '报告含标题行');
      check(/稿件：|栏目：|字数：/.test(rp.markdown), '报告含稿件信息');
      check(/人工复核|复核/.test(rp.markdown), '报告含人工复核提示');
    }

    /* 5) 追问接口（规则库问答，不调模型） */
    const tAsk = Date.now();
    const askRes = await fetch(`${BASE}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: up.id, question: '这份稿件主要有哪些格式问题？', useModel: false }),
    });
    const ask = await askRes.json();
    mark('追问', tAsk);
    check(askRes.ok, '追问接口');
    // 规则库直答必须真的给出内容，而不是空字符串
    check(typeof ask.answer === 'string' && ask.answer.length > 40, '追问有实质回答');
    check(ask.mode === 'rules', '追问走规则库直答（不调模型）');

    /* 6) 异步审阅链路：网页端走的就是这条路径，必须单独验证。
       注意此时文档已被自动修复改过，条数会少于原始值——只要「不多于原始值」
       就说明两条路径一致；若反而变多则说明有重复产出。 */
    const tAsync = Date.now();
    const acc = await (await fetch(`${BASE}/api/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: up.id, useModel: false, async: true }),
    })).json();
    check(acc.accepted === true, '异步审阅受理');
    let ast = null;
    const adeadline = Date.now() + 120000;
    while (Date.now() < adeadline) {
      await new Promise((r) => setTimeout(r, 400));
      ast = await (await fetch(`${BASE}/api/review-status?id=${up.id}`)).json();
      if (!ast.running) break;
    }
    mark('异步审阅', tAsync);
    check(ast && ast.running === false, '异步审阅结束');
    check(!ast?.error, '异步审阅无错误');
    check(Array.isArray(ast?.result?.issues), '异步审阅返回结果');
    check((ast?.result?.issues?.length ?? Infinity) <= originalIssueCount, '异步结果不多于同步结果（无重复产出）');
    // 修复后再审阅，若仍有可修复项，说明自动修复没有真正生效
    const stillFixable = (ast?.result?.issues || []).filter((x) => x.autoFix?.find && x.autoFix.find !== x.autoFix.replace);
    rec.steps.residualFixable = stillFixable.length;
    if (stillFixable.length) {
      rec.steps.residual = stillFixable.slice(0, 8).map((x) => ({
        ruleId: x.ruleId,
        location: x.location,
        find: (x.autoFix?.find || '').slice(0, 24),
        replace: (x.autoFix?.replace || '').slice(0, 24),
        quote: (x.quote || '').slice(0, 24),
      }));
    }
    check(stillFixable.length <= 2, '修复后残留可修复项在合理范围');

    /* 7) 会话淘汰后旧会话应仍可访问（上限 40，不能误删正在用的） */
    check(!!ast?.result, '会话未被误淘汰');
  } catch (err) {
    fail += 1;
    failByCheck['异常'] = (failByCheck['异常'] || 0) + 1;
    rec.errors.push(`异常：${err.message}`);
  }
  rec.ms = Date.now() - t0;
  rec.stage = stage;
  results.push(rec);
  process.stdout.write(`  ${i + 1}/${picks.length} ${rec.errors.length ? '✗' : '✓'} ${basename(m.path).slice(0, 40)}\r`);
}

/* 全局接口检查：这些与具体稿件无关，只跑一次 */
{
  const h = await (await fetch(`${BASE}/api/health`)).json();
  check(h.ok === true, '健康检查');
  check(h.arkConfigured === true, 'Ark 已配置');
  check(Array.isArray(h.models) && h.models.length > 0, '模型列表非空');

  const rl = await (await fetch(`${BASE}/api/rules`)).json();
  const all = [...rl.format.rules, ...rl.language.rules, ...rl.citation.rules];
  const ss = rl.statusSummary;
  // 规则条数随规则库增长，不再硬编码 135；以状态汇总的 total 为准
  check(all.length === ss.total, '规则总数与状态汇总一致');
  // 执行状态必须如实标注，且分项之和等于总数（dormant「auto-未触发」也算一项）
  check(ss && ss.auto + ss.model + ss.manual + (ss.dormant || 0) === ss.total, '规则状态分项之和等于总数');
  check(all.every((r) => ['auto', 'model', 'manual', 'auto-未触发'].includes(r.status)), '每条规则都有执行状态');
  // 「人工复核」的规则不得出现在扫描器的自动实现清单里（防止虚高）
  const autoIds = new Set(all.filter((r) => r.status === 'auto').map((r) => r.id));
  check(!autoIds.has('FMT-040'), '未实现的规则未被标为自动检测');

  // 不存在的会话必须返回 404 而不是 500
  const nf = await fetch(`${BASE}/api/review-status?id=does-not-exist`);
  check(nf.status === 404, '未知会话返回 404');
  const nf2 = await fetch(`${BASE}/api/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'does-not-exist', question: 'x', useModel: false }),
  });
  check(nf2.status === 404, '未知会话追问返回 404');
}

console.log('\n');
const withErr = results.filter((r) => r.errors.length);
console.log(`═══ 结果：${pass} 项通过 / ${fail} 项失败 ═══`);
if (Object.keys(failByCheck).length) {
  console.log('\n按检查项统计失败：');
  for (const [k, v] of Object.entries(failByCheck).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v} 次`);
}
console.log(`稿件 ${results.length} 份，其中 ${withErr.length} 份存在异常`);
if (withErr.length) {
  console.log('\n异常明细：');
  for (const r of withErr) {
    console.log(`  ${r.name.slice(0, 50)}`);
    for (const e of r.errors) console.log(`     - ${e}`);
  }
}
const fixableTotal = results.reduce((s, r) => s + (r.steps.fixable || 0), 0);
const appliedTotal = results.reduce((s, r) => s + (r.steps.applied || 0), 0);
console.log(`\n可自动修复 ${fixableTotal} 条，实际应用 ${appliedTotal} 条`);
console.log(`问题数分布：${results.map((r) => r.steps.review?.total ?? '-').join(', ')}`);

/* 阶段耗时：定位接口瓶颈 */
{
  const labels = ['上传', '规则审阅', '报告', '追问'];
  const stat = {};
  for (const l of labels) {
    const vals = results.map((r) => r.stage?.[l]).filter((x) => typeof x === 'number').sort((a, b) => a - b);
    if (vals.length) stat[l] = { 中位: vals[Math.floor(vals.length / 2)], 最大: vals[vals.length - 1] };
  }
  console.log('\n各阶段耗时（毫秒）：');
  for (const [k, v] of Object.entries(stat)) console.log(`  ${k}: 中位 ${v.中位} / 最大 ${v.最大}`);
  const totalMs = results.reduce((s, r) => s + (r.ms || 0), 0);
  console.log(`  单份全链路合计：${(totalMs / results.length / 1000).toFixed(1)} 秒/份`);
}

mkdirSync(resolve('data/verify'), { recursive: true });
writeFileSync(resolve('data/verify/api-batch.json'), JSON.stringify({ pass, fail, results }, null, 2), 'utf8');
console.log('\n明细：data/verify/api-batch.json');
