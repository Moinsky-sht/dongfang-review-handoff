/**
 * 端到端验证：走**带模型**的完整审阅链路，计时并核对结果。
 *
 * 这一轮之前所有浏览器验证都是 `useModel:false`（只跑规则引擎），
 * 模型审阅这条主链路没有验过。本脚本补上：
 *   上传 → 模型审阅（含复核）→ 统计问题数 / 锚点覆盖 / 各阶段耗时
 *
 * ⚠️ **超时预算的坑（实测踩过，会造成假失败）**
 * 带模型 + 复核的完整审阅实测约 **230—270 秒**（规则引擎只要 1—2 秒，
 * 模型审阅约 100—175 秒，复核再加 60—120 秒）。
 * 用 150 秒的轮询预算去等 `.verdict` 会**在复核阶段超时**，
 * 于是看到「判定徽章不存在、下划线只有 4 条」——
 * 看起来像严重回归，其实只是没等完（本项目的浏览器验证就这样误报过一次）。
 * 判断依据是 `#progress` 里是否还在「模型复核 N/M 批」：
 * 还在复核就是没跑完，不是坏了。
 * 浏览器侧轮询要按 ≥250 秒给，超过单次程序上限就分两次调用。
 * 用 `useRecheck:false` 可以把时间压到约 150 秒（本脚本默认不开复核）。
 */
const BASE = 'http://127.0.0.1:3210';
const files = process.argv.slice(2);
const results = [];

for (const file of files) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const name = path.basename(file);
  const t0 = Date.now();
  const up = await (await fetch(`${BASE}/api/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST', body: fs.readFileSync(file),
  })).json();
  const sid = up.sessionId || up.id;
  const tUp = Date.now() - t0;

  const t1 = Date.now();
  let rv;
  try {
    rv = await (await fetch(`${BASE}/api/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: sid, useModel: true }),
    })).json();
  } catch (e) {
    results.push({ name, error: '审阅请求失败: ' + e.message });
    continue;
  }
  const tReview = Date.now() - t1;

  const issues = rv.issues || [];
  const byOrigin = {};
  const byPrec = {};
  let noAnchor = 0;
  for (const it of issues) {
    /**
     * ⚠️ 判据是 `group`，不是 `origin`/`source`/`model`。
     * 这三个字段在 issue 上**都不存在** —— 模型问题由 `group === 'model'`
     * 标识（与 `buildSummary` 里 `deduped.filter(i => i.group === 'model')` 同一口径）。
     * 之前这里写 `it.origin || it.source || (it.model ? 'model' : 'rule')`，
     * 于是**所有问题都被标成 rule**，模型贡献被静默吞掉 ——
     * 探针自己的 bug 会伪装成"模型没工作"。
     */
    const o = it.group === 'model' ? 'model' : 'rule';
    byOrigin[o] = (byOrigin[o] || 0) + 1;
    const p = it.anchor?.precision || 'none';
    byPrec[p] = (byPrec[p] || 0) + 1;
    if (p === 'none') noAnchor += 1;
  }
  results.push({
    name,
    sessionId: sid,
    uploadMs: tUp,
    reviewMs: tReview,
    totalSec: ((tUp + tReview) / 1000).toFixed(1),
    issues: issues.length,
    byOrigin,
    byPrec,
    noAnchor,
    anchorStats: rv.anchorStats || null,
    rechecked: rv.recheck?.length ?? rv.rechecked ?? null,
    /** 判定（本轮修复重点）：应只由规则问题决定，模型意见单独成块 */
    verdict: rv.verdict ? {
      verdict: rv.verdict.verdict,
      score: rv.verdict.score,
      per1k: rv.verdict.per1k,
      total: rv.verdict.metrics?.total,
      basis: rv.verdict.basis,
      model: rv.verdict.model,
      reasons: rv.verdict.reasons,
    } : null,
    modelErrors: rv.modelErrors,
    keys: Object.keys(rv).slice(0, 30),
  });
}
console.log(JSON.stringify(results, null, 2));
