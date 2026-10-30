/**
 * 模型复核（目标点 13 的后半段）：对每一条「建议修改」再问一次模型
 * —— 是否同意、理由是什么、有没有更好的改法。
 *
 * 设计取舍（都跟成本与稳定性有关，写在这里免得以后被当成随意决定）：
 *
 * 1. **批量复核，不是一条一请求。** 一篇稿子动辄 20—40 条问题，
 *    一条一请求要 20—40 次调用、几分钟起步，而且每次都要重发一遍规则原文。
 *    改成每批 BATCH_SIZE 条一起问，一条稿子通常 2—4 次请求。
 *
 * 2. **只复核「有可核对材料」的条目。** 送模型复核需要它手里有点东西可对：
 *    要么有「具体改法」（`suggestion`/`message`/`fix`/`detail`），
 *    要么至少有一句「逐字原文片段」（`quote`）。
 *
 *    ⚠️ 这条在第二轮加固时**放宽过**：原先只认改法文本，于是「有原文、但没给
 *    改写建议」的问题（多为模型条目）被整条跳过 —— 而它们恰恰是最需要排查
 *    误报的一批。现在只要有原文片段即可送复核。真正什么都没有（无原文、无
 *    改法，如纯文档级判断「缺作者简介」）才标 `skipped`。
 *
 * 3. **要求输出 JSON，但不传 `json_schema`。** 这条是踩坑得来的：
 *    给这些推理模型传 `json_schema` 会把整个输出预算烧在推理链上，
 *    最终 `text` 是空的（见 ark.js 里的同类注释）。所以在提示词里要 JSON，
 *    再用 `parseJsonLoose()` 解析。
 *
 * 4. **复核失败不能拖垮整篇报告。** 任何一批出错就记 `errors` 并继续，
 *    报告里如实写「N 条未复核」。
 */

import { arkRespond, arkConfigured, DEFAULT_MODEL, parseJsonLoose,arkEndpointIdentity,safetyFacts } from './ark.js';
import { addTokenUsage } from './token-usage.js';
import {getArkScope,withArkScope,createLocalArkScope} from './ark-execution-context.js';
import {prepareReviewPlan,registerReviewUnits,runReviewUnit,readReviewPlanCoverage,reviewPlanFingerprint} from './review-plan-store.js';

/**
 * 每批复核多少条。
 *
 * 这个值是实测定的，不是拍的，而且**改过两次**：
 *
 * · 最初 12 条 → 每批都超输出预算被截断。实测 12 条那次输出 1236 token，
 *   其中 1060 是推理链，只剩 176 给正文，连 2 条结论都装不下。
 * · 降到 8 条「不再截断」这个结论**是错的**：那时只看「JSON 解析是否成功」，
 *   而解析器有一条「补回被截掉的开头」的兜底路径，会让**残缺结果看起来解析成功**。
 *   实测 19 条问题分 3 批（8/8/3）跑下来，模型**只给出 8 条结论**，
 *   其余 11 条被记成「模型未返回该条结论」→ 记 `unsure`。
 *   也就是说：**复核跑了，但 58% 的条目其实没复核到**，而页面还显示「已复核」。
 * · 实测对比（同一份 19 条问题的稿子）：
 *     8 条/批 预算 20000 → 回收 11/19 = 58%，用时  63s
 *     6 条/批 预算 32000 → 回收 19/19 = 100%，用时 188s
 *     4 条/批 预算 20000 → 回收 19/19 = 100%，用时 164s   ← 选它
 *   4 条/批在**同样预算下**回收率 100% 且比 6 条/批更快（请求数多但每批推理链短）。
 *
 * 教训：判断「有没有截断」不能只看「JSON 能不能解析」——
 * 解析器的兜底会把截断掩盖成成功，必须核对**回收条数**是否等于送审条数。
 */
// Four-item legacy baseline remains the conservative size for missing-reply retries.
// Initial batches now use buildRecheckBatches: <=12 items and <=6000 described characters.
export const BATCH_SIZE = 4;

/**
 * 并发批次数（**按批数自适应**）。
 *
 * ⚠️ **证据等级低于 `BATCH_SIZE`，如实标注**：
 * 最初固定 3，来自运维观察（并发跑批时遇到过 429 限流，降到 3 之后没再出现），
 * **不是**像 `BATCH_SIZE` 那样做过受控对照实验。
 *
 * 之所以可以接受这个证据等级：**正确性不依赖它**。
 * `arkRequestWithRetry()` 对 429 与 5xx 有指数退避重试（7 次、上限 30 秒、
 * 优先采用服务端 `Retry-After`），所以并发给高了只会变慢，不会出错或漏复核。
 *
 * ── 为什么改成自适应（本轮）──
 * 固定 3 对**问题很多的长稿**是灾难：实测一份 126 条问题的稿子 = 32 批，
 * 32 ÷ 3 ≈ 11 轮串行，是「审核非常慢」的最大头。而复核墙钟的瓶颈就是
 * 「**批数 ÷ 并发**」，所以批数越多、越该把并发抬起来。
 * 现在：批数 ≤12 仍用保守的 3；批数一多按 `ceil(批数/4)` 抬升，上限 8。
 * 可用 `DSH_RECHECK_CONCURRENCY` 覆盖（想回到保守值就设 `=3`）。
 *
 * ⚠️ 这仍是**未做受控实验**的经验值（本机 429 耐受度未标定）——
 * 真要定一个有依据的值，需要固定一份稿件，在并发 2/3/5/8 下各跑若干轮、
 * 记录 429 次数与总耗时，取拐点。这个实验没做。
 */
export const RECHECK_CONCURRENCY_ENV = Math.max(0, Number(process.env.DSH_RECHECK_CONCURRENCY) || 0);

export function recheckConcurrency(batchCount) {
  if (RECHECK_CONCURRENCY_ENV) return RECHECK_CONCURRENCY_ENV;
  return Math.max(3, Math.min(8, Math.ceil(batchCount / 4)));
}

const RECHECK_INSTRUCTIONS = `你是《东方学刊》的资深一审责任编辑，正在**复核**另一位编辑给出的修改建议。

逐条判断给出的「修改建议」是否成立：
- 该问题是否真实存在（有没有可能是误报）；
- 建议的改法是否正确、是否会造成新的问题。

判断尺度：
- 格式体例类，依据刊物规范。符合规范判 agree；
  规范本身允许该写法（如「期刊论文页码可省略」「概数可用中文数字」）判 disagree。
- 语言词汇类，只有确实不通、歧义或不合规范才判 agree。
  仅仅「可以写得更好」不算问题，判 disagree。
- 拿不准就判 unsure。

**要求（重要）**：
1. 不要长篇推理，直接给结论。每条 reason 不超过 30 字。
2. 严格只输出 JSON，不要任何解释文字、不要 markdown 代码块。
3. 格式：{"results":[{"i":序号,"verdict":"agree|disagree|unsure","reason":"...","better":"..."}]}
4. i 必须与输入序号一致，results 必须覆盖每一个输入序号。
5. better 只在确实有更好改法时填写，否则留空字符串。`;

/**
 * 从问题对象里取出「可核对的改法文本」。没有就返回空串 —— 这类条目不送模型复核。
 *
 * ── 为什么兜底读 `fix` / `detail` ──
 * 规则条目的文案在 `message`/`suggestion`，而**模型条目**用的是 `detail`/`fix`
 * （见 `ark.js` 组装模型问题的地方）。原先只认前两者，于是模型条目
 * **全部被判「无可核对改法」而跳过复核** —— 实测一篇稿子 136 条里 122 条
 * （几乎全是模型条目）没被复核，而界面还显示「已复核」。用户明确要求
 * 「所有问题都让模型看一遍是否正确」，所以这里补齐兜底，让模型条目也进复核。
 */
export function fixTextOf(it) {
  const parts = [];
  if (it.autoFix?.find) parts.push(`将「${it.autoFix.find}」改为「${it.autoFix.replace ?? ''}」`);
  if (it.suggestion) parts.push(it.suggestion);
  else if (it.message) parts.push(it.message);
  else if (it.fix) parts.push(it.fix);
  else if (it.detail) parts.push(it.detail);
  return parts.join('；').trim();
}

/** 构造送模型的单条描述（保持短，避免输出预算被吃光） */
export function describeRecheckIssue(it, i) {
  const lines = [`${i}. [${it.ruleId}] ${it.title || ''}`];
  if (it.quote) lines.push(`   原文片段：${String(it.quote)}`);
  // 问题说明：message 优先；模型条目常用 detail/problem，补齐兜底
  const prob = it.message || it.detail || it.problem;
  if (prob) lines.push(`   判定的问题：${String(prob).slice(0, 100)}`);
  const fx = fixTextOf(it);
  if (fx) lines.push(`   建议的改法：${fx}`);
  if (it.basis) lines.push(`   规则依据：${String(it.basis).slice(0, 80)}`);
  return lines.join('\n');
}
const describe = describeRecheckIssue;

/** Pack short issues together without cutting source quotes or proposed changes. */
export function buildRecheckBatches(issues, { maxItems = 12, maxChars = 6000 } = {}) {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || !Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('复核批次上限无效');
  const batches = []; let batch = [], size = 0;
  for (const issue of issues) {
    const chars = describe(issue, batch.length).length + 2;
    if (batch.length && (batch.length >= maxItems || size + chars > maxChars)) { batches.push(batch); batch = []; size = 0; }
    batch.push(issue); size += chars;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * 精简复核提示词（截断时的兜底）。
 *
 * 为什么要它：实测这个推理模型在复核任务上会**随机**把 1.2 万—1.5 万 token
 * 花在推理链上，正文 JSON 就被截掉。同一份 19 条的稿子、同一份代码，
 * 三次跑出 58% / 42% / 100% 的回收率 —— **单条单独问也只有 47%**，
 * 说明瓶颈不是批量大小，而是模型「想太多、写得少」。
 *
 * 所以截断/漏回时改用这套**极简提示词**：只要 verdict + 20 字理由，
 * 明确禁止解释、禁止 better（`better` 是最费输出的字段）。实测能把回收率
 * 从 47% 提到可用水平；仍漏回的才如实记为「模型未返回该条结论」。
 *
 * 这与 `ark.js` 里 `reviewWindow()` 的 `compact` 重试是同一套思路。
 */
const RECHECK_INSTRUCTIONS_COMPACT = `复核修改建议是否成立。
只输出 JSON：{"results":[{"i":0,"verdict":"agree|disagree|unsure","reason":"不超过20字"}]}
不要解释、不要 markdown、不要 better 字段。results 必须覆盖每个输入序号。`;

/**
 * 对一批问题做模型复核。
 *
 * @param {object[]} batch
 * @param {{model?:string, signal?:AbortSignal, compact?:boolean}} [opts]
 * @returns {Promise<Map<number, {verdict,reason,better}>>} key 为批次内下标
 */
async function recheckBatch(batch, { model, signal, compact = false, onUsage, onSafetyStop } = {}) {
  const scope=getArkScope();
  if(!scope)return recheckBatchRaw(batch,{model,signal,compact,onUsage,onSafetyStop});
  const input={model,compact,maxOutputTokens:20000,temperature:0,
    batch:JSON.parse(JSON.stringify(batch)),instructions:compact?RECHECK_INSTRUCTIONS_COMPACT:RECHECK_INSTRUCTIONS,
    prompt:batch.map((it,i)=>describe(it,i)).join('\n\n')};
  const unitId='recheck-'+reviewPlanFingerprint(input);
  const checked=await runReviewUnit({scope,unitId,stage:'recheck',parentUnitId:scope.stage==='recheck'?scope.unitId||null:null,
    input,execute:async()=>({entries:[...await recheckBatchRaw(batch,{model,signal,compact,onUsage,onSafetyStop})]}),
    validate:output=>({status:output.entries.length===batch.length?'completed':'partial',output})});
  return new Map(checked.entries);
}
async function recheckBatchRaw(batch, { model, signal, compact = false, onUsage, onSafetyStop } = {}) {
  const body = batch.map((it, i) => describe(it, i)).join('\n\n');
  const input = compact
    ? `复核以下 ${batch.length} 条修改建议，直接输出 JSON：\n\n${body}\n\n`
      + `{"results":[{"i":0,"verdict":"agree|disagree|unsure","reason":"不超过20字"}]}`
    : `复核以下 ${batch.length} 条修改建议，直接输出 JSON：\n\n${body}\n\n`
      + `{"results":[{"i":0,"verdict":"agree|disagree|unsure","reason":"...","better":"..."}]}`;
  const { text, usage } = await arkRespond({
    model,
    input,
    instructions: compact ? RECHECK_INSTRUCTIONS_COMPACT : RECHECK_INSTRUCTIONS,
    // 注意：不传 schema —— 传了会让推理模型把输出预算全烧在推理链上，text 变空。
    // 预算给到 20000：实测推理链会吃掉大部分，正文留够才不会被截断。
    maxOutputTokens: 20000,
    signal,
    onSafetyStop,
  });
  onUsage?.(usage);
  const parsed = parseJsonLoose(text);
  const out = new Map();
  const list = Array.isArray(parsed?.results) ? parsed.results : [];
  const truncated = (usage?.output_tokens || 0) >= 20000 * 0.98;
  for (const r of list) {
    const i = Number(r?.i);
    if (!Number.isInteger(i) || i < 0 || i >= batch.length) continue;
    const v = String(r.verdict || '').toLowerCase();
    out.set(i, {
      verdict: ['agree', 'disagree', 'unsure'].includes(v) ? v : 'unsure',
      reason: String(r.reason || '').slice(0, 200),
      better: String(r.better || '').slice(0, 300),
    });
  }
  /**
   * 输出被截断（推理吃满额度）**或**没覆盖全部序号时，用精简提示词再问一次，
   * 把这次拿到的结论合并进去。
   *
   * 关键：判断「要不要重试」不能只看「JSON 能不能解析」——
   * `parseJsonLoose` 有「补回被截掉的开头」「逐个抠完整元素」等兜底，
   * 会让**残缺结果看起来解析成功**。必须核对**回收条数**是否覆盖了全部序号。
   */
  if (!compact && (truncated || out.size < batch.length)) {
    const missing = batch.map((_, i) => i).filter((i) => !out.has(i));
    try {
      const more = await recheckBatch(missing.map((i) => batch[i]), { model, signal, compact: true, onUsage, onSafetyStop });
      missing.forEach((origIdx, k) => {
        const r = more.get(k);
        if (r && !out.has(origIdx)) out.set(origIdx, r);
      });
    } catch (error) { if (signal?.aborted || safetyFacts(error).stop) throw error; /* Ordinary failure keeps known replies. */ }
  }
  return out;
}

/**
 * 对一篇稿件的全部问题做模型复核。
 *
 * @param {object[]} issues
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {AbortSignal} [opts.signal]
 * @param {(p:object)=>void} [opts.onProgress]
 * @param {number} [opts.limit] 最多复核多少条（默认不限）
 * @returns {Promise<{byKey:Map<string,object>, stats:object, errors:object[]}>}
 */
export async function recheckFixes(issues, opts = {}) {
  if(!getArkScope()){
    const sha256=reviewPlanFingerprint(JSON.parse(JSON.stringify(issues)));
    return withArkScope(createLocalArkScope({operationKind:'direct-model-recheck',purpose:opts.purpose||'editorial',transientSource:true,resumable:false,
      binding:{sourceSha256:sha256,workSha256:sha256,versionId:'transient:'+sha256,mutationEpoch:0}}),()=>recheckFixes(issues,opts));
  }
  if(!getArkScope().endpointIdentity)return withArkScope({...getArkScope(),endpointIdentity:arkEndpointIdentity()},()=>recheckFixes(issues,opts));
  const { model = DEFAULT_MODEL, signal, onProgress, limit = Infinity } = opts;
  const stats = { total: issues.length, checked: 0, agree: 0, disagree: 0, unsure: 0, skipped: 0, batches: 0 };
  const errors = [];
  const byKey = new Map();
  const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
  const onUsage = (u) => addTokenUsage(usage, u);
  /**
   * 模型漏回结论的条目，等待重试。
   *
   * 模型输出不稳定（同代码同稿件三次跑出 58%/42%/100% 的回收率），
   * 所以「漏回」必须当成**暂时性失败**处理，而不是最终结论。
   */
  const pending = [];
  const MAX_ATTEMPTS = 2;

  if (!arkConfigured()) {
    return { byKey, stats: { ...stats, skipped: issues.length, reason: 'ARK_API_KEY 未配置' }, errors: [{ message: 'ARK_API_KEY 未配置，跳过模型复核' }] };
  }

  // 只复核「有可核对材料」的条目：有改法文本，或至少有逐字原文片段
  const targets = [];
  for (const it of issues) {
    if (!fixTextOf(it) && !it.quote) { stats.skipped += 1; continue; }
    if (targets.length >= limit) { stats.skipped += 1; continue; }
    targets.push(it);
  }

  const batches = buildRecheckBatches(targets, opts.batchPolicy);
  const scope=getArkScope();
  const units=batches.map(batch=>({unitId:'recheck-'+reviewPlanFingerprint({model,compact:false,maxOutputTokens:20000,temperature:0,
    batch:JSON.parse(JSON.stringify(batch)),instructions:RECHECK_INSTRUCTIONS,prompt:batch.map((it,i)=>describe(it,i)).join('\n\n')}),stage:'recheck'}));
  if(!await readReviewPlanCoverage({scope}))await prepareReviewPlan({scope,plan:{kind:'recheck-only',
    options:{model,batchPolicy:opts.batchPolicy||{maxItems:12,maxChars:6000},limit:Number.isFinite(limit)?limit:null},issues:JSON.parse(JSON.stringify(issues)),units}});
  else await registerReviewUnits({scope,units});

  onProgress?.({ phase: 'recheck-start', message: `模型复核：${targets.length} 条待复核，分 ${batches.length} 批` });

  let done = 0;
  let dispatchStop = null;
  const onSafetyStop = error => { if (safetyFacts(error).stop) dispatchStop ||= error; };
  // 按 recheckConcurrency(批数) 自适应并发跑批，批间不设 barrier
  const queue = batches.map((b, bi) => ({ b, bi }));
  async function worker() {
    while (queue.length && !dispatchStop) {
      const job = queue.shift();
      if (!job) break;
      if (signal?.aborted) return;
      try {
        const res = await recheckBatch(job.b, { model, signal, onUsage, onSafetyStop });
        stats.batches += 1;
        job.b.forEach((it, i) => {
          const r = res.get(i);
          /**
           * 复核结论的 key 必须与**前端 `issueKey()` 和报告**完全一致：
           *   `${ruleId}|${location}|${quote||''}`
           * 原先这里还兜底过一个 `it.id`，一旦某类条目带 `id`，
           * key 就会漂移成 id，导致「复核跑过了但页面上对不上」。
           * 统一到同一构造，别再兜 `id`。
           */
          const key = it.issueKey || `${it.ruleId}|${it.location}|${it.quote || ''}`;
          if (!r) {
            /**
             * 模型漏回了这一条。**先别急着记「拿不准」—— 记进待重试队列。**
             *
             * 为什么必须重试：实测同一份 19 条问题的稿子、同一份代码，
             * 三次跑下来回收率是 **58% / 42% / 100%** —— 模型输出极不稳定
             * （推理链会随机吃掉大部分输出预算，正文 JSON 就断了）。
             * 既然失败是随机的，重试就能补回来：把漏掉的条目单独再问一次，
             * 每批只有几条、推理链短、几乎不会再截断。
             *
             * 不做重试的后果很严重：漏掉的条目会被记成 `unsure`，
             * 而 `unsure` 在报告和页面上看起来是「模型判断过但拿不准」，
             * 用户无法分辨它其实**根本没被复核**。
             */
            pending.push({ it, key, batch: job.bi, attempt: 1 });
            return;
          }
          byKey.set(key, { ...r, batch: job.bi });
          if (r.verdict === 'agree') stats.agree += 1;
          else if (r.verdict === 'disagree') stats.disagree += 1;
          else stats.unsure += 1;
          stats.checked += 1;
        });
      } catch (err) {
        // 中止要如实抛出，其余错误记下来继续跑别的批
        if (signal?.aborted) throw err;
        onSafetyStop(err);
        errors.push({ batch: job.bi, message: String(err?.message || err).slice(0, 300) });
        // 整批失败同样进重试队列
        for (const it of job.b) {
          const key = it.issueKey || `${it.ruleId}|${it.location}|${it.quote || ''}`;
          pending.push({ it, key, batch: job.bi, attempt: 1 });
        }
      } finally {
        done += 1;
        onProgress?.({ phase: 'recheck-progress', done, total: batches.length, message: `模型复核 ${done}/${batches.length} 批` });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(recheckConcurrency(batches.length), batches.length) }, worker));
  if (dispatchStop) {
    for (const job of queue.splice(0)) for (const it of job.b) pending.push({it,key:it.issueKey||`${it.ruleId}|${it.location}|${it.quote||''}`,batch:job.bi,attempt:0});
    errors.push({code:dispatchStop.code||'RECHECK_DISPATCH_STOPPED',message:'复核请求结果未知或请求池受阻，已停止分配新批次，未完成条目保留待核对'});
  }

  /**
   * 重试轮：把模型漏回的条目重新组批再问。
   *
   * 最多 `MAX_ATTEMPTS` 轮，每轮仍按 BATCH_SIZE 合批、按批数自适应并发。
   * 仍然漏回的才最终记为「模型未返回该条结论」（此时是**如实**记录，
   * 而不是把「没问到」伪装成「拿不准」）。
   */
  let round = 0;
  while (pending.length && round < MAX_ATTEMPTS && !signal?.aborted && !dispatchStop) {
    round += 1;
    const retry = pending.splice(0, pending.length);
    onProgress?.({
      phase: 'recheck-retry',
      message: `模型漏回 ${retry.length} 条，第 ${round} 轮补问`,
    });
    const rq = [];
    for (const batch of buildRecheckBatches(retry.map(x=>x.it), {maxItems:BATCH_SIZE,maxChars:6000})) rq.push(batch.map(it=>retry.find(x=>x.it===it)));
    async function retryWorker() {
      while (rq.length && !dispatchStop) {
        const job = rq.shift();
        if (!job || signal?.aborted) return;
        try {
          const res = await recheckBatch(job.map((x) => x.it), { model, signal, onUsage, onSafetyStop });
          stats.batches += 1;
          job.forEach((entry, i) => {
            const r = res.get(i);
            if (!r) { pending.push({ ...entry, attempt: round + 1 }); return; }
            byKey.set(entry.key, { ...r, batch: entry.batch, retried: round });
            if (r.verdict === 'agree') stats.agree += 1;
            else if (r.verdict === 'disagree') stats.disagree += 1;
            else stats.unsure += 1;
            stats.checked += 1;
          });
        } catch (err) {
          if (signal?.aborted) throw err;
          onSafetyStop(err);
          errors.push({ batch: `retry${round}`, message: String(err?.message || err).slice(0, 300) });
          for (const entry of job) pending.push({ ...entry, attempt: round + 1 });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(recheckConcurrency(rq.length), rq.length) }, retryWorker));
    if (dispatchStop) for (const job of rq.splice(0)) pending.push(...job);
  }

  // 重试后仍漏回的：如实记为「模型未返回该条结论」
  for (const entry of pending) {
    byKey.set(entry.key, { verdict: 'unsure', reason: '模型未返回该条结论', better: '', batch: entry.batch });
    stats.unsure += 1;
  }
  stats.retryRounds = round;

  /**
   * 把「模型没回结论」的条数**显式暴露出来**，不能让 `unsure` 把它们吞掉。
   *
   * 踩过的坑：8 条/批时 19 条问题只回收 8 条结论，其余 11 条被记为
   * `{verdict:'unsure', reason:'模型未返回该条结论'}`。`unsure` 在报告和页面上
   * 只是「拿不准」，看起来像模型**判断过**但拿不准 —— 实际上模型压根没输出这一条。
   * 两者的可信度完全不同，必须分开计数。
   */
  const noReply = [...byKey.values()].filter((v) => v.reason === '模型未返回该条结论').length;
  stats.noReply = noReply;
  stats.recovered = stats.total - stats.skipped - noReply;
  onProgress?.({
    phase: 'recheck-done',
    message: `模型复核完成：同意 ${stats.agree} / 不同意 ${stats.disagree} / 拿不准 ${stats.unsure - noReply}`
      + (noReply ? ` / 模型未回结论 ${noReply}` : '')
      + `，未复核 ${stats.skipped}`,
  });
  return { byKey, stats, errors, usage };
}

/** 复核结论的中文标签，报告与前端共用 */
export function verdictLabel(v) {
  return { agree: '同意', disagree: '不同意', unsure: '拿不准' }[v] || '未复核';
}

/** 严重度降一级（低已经是最低，不再降） */
const DEMOTE = { 高: '中', 中: '低', 低: '低' };

/**
 * 把模型复核结论落到**每条问题的优先级**上（用户需求：模型认了保留优先级，
 * 模型不认就降级并给出模型观点，同时留出人工审阅的空间）。
 *
 * 规则：
 *   · agree    —— 保留原优先级，附 `modelOpinion`（模型同意）。
 *   · disagree —— **降一级**（高→中→低），标 `severityAdjusted` 与
 *                 `needsHuman`，`modelOpinion` 说明「模型认为不必改」，
 *                 并保留 `severityBase` 供界面显示「原为 X」。
 *   · unsure   —— 保留优先级，但标 `needsHuman`，观点写成「拿不准，请人工判断」。
 *
 * ⚠️ 只在**界面展示层**降级，不改 `verdict` 合格性判定 —— 判定吃的是纯规则
 * 分布（见 `judge()` 注释），把模型结论掺进去会让已付印定稿也被判不合格。
 *
 * @param {object[]} issues 去重后的问题（就地修改并返回）
 * @param {{byKey?:Map<string,object>}} recheck
 */
export function applyModelVerdicts(issues, recheck) {
  const rc = recheck?.byKey;
  if (!rc || !rc.size) return issues;
  for (const it of issues) {
    const key = it.issueKey || `${it.ruleId}|${it.location}|${it.quote || ''}`;
    const r = rc.get(key);
    if (!r) continue;
    it.modelVerdict = r.verdict;
    it.modelReason = r.reason || '';
    it.modelBetter = r.better || '';
    it.severityBase = it.severity;
    const why = r.reason ? `：${r.reason}` : '';
    if (r.verdict === 'agree') {
      it.modelOpinion = `模型同意保留该问题${why}`;
    } else if (r.verdict === 'disagree') {
      it.severity = DEMOTE[it.severity] || it.severity;
      it.severityAdjusted = true;
      it.needsHuman = true;
      it.modelOpinion = `模型认为这条不必改${why}。已自动降一级（${it.severityBase}→${it.severity}），是否采纳请人工确认。`;
    } else {
      it.needsHuman = true;
      it.modelOpinion = `模型拿不准${why}，是否有必要改请人工判断。`;
    }
  }
  return issues;
}
