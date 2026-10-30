/**
 * 火山方舟（Ark）Responses API 适配层。
 * 用途：把规则引擎无法判定的语义问题（语病、逻辑、事实、引文）交给大模型审阅。
 * 设计要点：
 *  - 只从服务端调用，API Key 不进入浏览器。
 *  - 长文按「章节窗口」切片，逐片审阅后合并，避免超出上下文。
 *  - 用 JSON Schema 约束输出，保证可结构化处理。
 *  - 支持流式进度回调，供前端显示审阅进度。
 */

import { loadCaseIndex, retrieveCases, makeRetriever, caseIndexFingerprint, casesEnabled, casesMissingReason, DEFAULT_CASE_K } from './comment-cases.js';
import { resolveModelSource, modelSourceAnchor, modelNoteNumber, buildNoteSourceEntries, captureModelSourceContext } from './model-source-location.js';
import { withIssueIdentity } from './issue-identity.js';
import {executeArkAttempt,noteArkCooldown,readArkExecutionSummary,readArkAttempt} from './ark-execution-store.js';
import {getArkScope,createLocalArkScope,recordArkAttempt} from './ark-execution-context.js';
import {randomUUID,createHash} from 'node:crypto';
import {createArkModelEndpointConfig,resolveArkModelEndpoint} from './ark-endpoint-config.js';

const ARK_BASE = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const ARK_KEY = process.env.ARK_API_KEY || '';
const MODEL_ENDPOINTS=createArkModelEndpointConfig(process.env.ARK_MODEL_ENDPOINTS);
export const DEFAULT_MODEL = process.env.ARK_MODEL || Object.keys(MODEL_ENDPOINTS?.bindings||{})[0] || 'deepseek-v4-1-flash-260910';
export const arkModelEndpointConfig=()=>MODEL_ENDPOINTS;
export const resolveArkModel=model=>resolveArkModelEndpoint(model,MODEL_ENDPOINTS);
if(MODEL_ENDPOINTS)resolveArkModel(DEFAULT_MODEL);
export function arkEndpointIdentity(){
  const url=new URL(`${ARK_BASE}/responses`);
  return{origin:url.origin,pathSha256:createHash('sha256').update(url.pathname).digest('hex'),
    ...(MODEL_ENDPOINTS?{modelEndpoints:MODEL_ENDPOINTS}:{})};
}

import { loadLanguageRules } from './scanner-language.js';
import { loadFormatRules } from './scanner-format.js';
import { loadCitationRules } from './scanner-citation.js';
import { isTextHeading } from './headings.js';

/**
 * 取出「提示词式」规则（`detect.type === 'model'`）。
 *
 * 目标点 12 要求规则同时支持**格式式**与**提示词式**：
 *  - 格式式：`detect.type` 为 regex/list/structure，由扫描器直接跑正则或清单；
 *  - 提示词式：`detect.type === 'model'`，只有一句 `detect.method` 判断要点，
 *    必须把规则原文交给大模型「读规则 → 逐条匹配 → 输出 JSON」。
 * 这里给出提示词式规则的稳定清单，供模型提示词注入与结果回填规则号。
 */
export function promptStyleRules() {
  try {
    // 提示词式规则 = `detect.type === 'model'`，**三个规则文件都要收**。
    // 早期只读 language-rules.json，后来目标点 11 的定性工作把 11 条格式规则
    // （FMT-021/030/038/011、FMTB-001/017/024/029/030/038、FMTB-027）
    // 也从 `structure` 改判为 `model`，它们必须同样进入提示词，
    // 否则规则管理页显示「交模型判断」而模型根本收不到。
    const files = [loadLanguageRules(), loadFormatRules(), loadCitationRules()];
    const seen = new Set();
    const out = [];
    for (const loaded of files) {
      for (const r of loaded.rules) {
        if (r.detect?.type !== 'model') continue;
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push({
          id: r.id,
          category: r.category,
          title: r.title,
          severity: r.severity,
          method: r.detect.method || r.detect.reclassifiedWhy || '',
          rule: r.rule || r.detail || '',
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 候选模型：按「审稿质量优先」排序 */
const MODEL_CATALOG = [
  { id: 'deepseek-v4-pro-ga-260813', label: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-1-flash-260910', label: 'DeepSeek V4.1 Flash' },
  { id: 'glm-5-3-flash-260828', label: 'GLM 5.3 Flash' },
  { id: 'deepseek-v4-flash-ga-260731', label: 'DeepSeek V4 Flash GA' },
  { id: 'doubao-seed-2-1-pro-260915', label: '豆包 Seed 2.1 Pro' },
];
export const MODEL_CANDIDATES = MODEL_ENDPOINTS
  ? [...(DEFAULT_MODEL.startsWith('ep-')?[{id:DEFAULT_MODEL,label:resolveArkModel(DEFAULT_MODEL).modelName+'（指定接入点）'}]:[]),
     ...MODEL_CATALOG.filter(model=>Object.hasOwn(MODEL_ENDPOINTS.bindings,model.id)),
     ...Object.keys(MODEL_ENDPOINTS.bindings).filter(id=>!MODEL_CATALOG.some(model=>model.id===id)).map(id=>({id,label:id+'（已登记接入点）'}))]
  : MODEL_CATALOG;

/**
 * 内容审核未通过时的降级链：先换模型，再切小窗口。
 * 火山方舟的输入内容审核对涉政治表述较严，学术稿件常被误拦，
 * 因此这里提供多模型兜底；仍不通过则标记为「需人工审阅」。
 */
export const MODERATION_FALLBACKS = [
  'glm-5-3-flash-260828',
  'deepseek-v4-flash-ga-260731',
  'deepseek-v4-pro-ga-260813',
];
// Exact endpoint mode never changes the selected model version implicitly.
const reviewModelChain=model=>MODEL_ENDPOINTS?[model]:[model,...MODERATION_FALLBACKS.filter(candidate=>candidate!==model)];

export const ISSUE_SCHEMA = {  type: 'object',
  additionalProperties: false,
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'severity', 'title', 'quote', 'problem', 'suggestion'],
        properties: {
          category: {
            type: 'string',
            enum: ['语言表达', '语法语病', '词汇用词', '逻辑论证', '事实核查', '引文注释', '政治表述', '格式体例', '学术规范'],
          },
          severity: { type: 'string', enum: ['高', '中', '低'] },
          title: { type: 'string', description: '一句话概括问题' },
          quote: { type: 'string', description: '原文片段，必须逐字摘自稿件' },
          rangeScope: { type: 'string', enum: ['phrase', 'sentence', 'paragraph'], description: '词语标点、完整句子或整段的批注范围' },
          paragraphIndex: { type: 'integer', description: '该片段所在段落的序号（从0开始，见输入中的[段落号]）' },
          part: { type: 'string', enum: ['paragraph', 'footnote', 'endnote', 'document'], description: '来源部件；正文、脚注和尾注的数组索引不可混用' },
          footnoteIndex: { type: 'integer', description: '脚注段落原始数组索引，以输入标签为准，不是显示注号' },
          endnoteIndex: { type: 'integer', description: '尾注段落原始数组索引，以输入标签为准，不是显示注号' },
          noteId: { type: 'string', description: '注释不可变ID，以输入标签为准' },
          problem: { type: 'string', description: '说明为什么是问题，引用规则依据' },
          suggestion: { type: 'string', description: '可执行的具体修改建议' },
          proposed: { type: 'string', description: '改写后的完整句子或片段；不需要改写时留空字符串' },
        },
      },
    },
  },
};

/** 判断是否配置了可用 Key */
export function arkConfigured() {
  return !!ARK_KEY;
}

const sleep = (ms,signal) => new Promise((done,fail) => {
  if(signal?.aborted)return fail(abortReason(signal));
  const finish=()=>{signal?.removeEventListener('abort',cancel);done();};
  const timer=setTimeout(finish,ms);
  const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);fail(abortReason(signal));};
  signal?.addEventListener('abort',cancel,{once:true});
});
const DEFAULT_RESPONSE_TIMEOUT_MS=300000;
function defaultQueueTimeoutMs(){const raw=process.env.DSH_ARK_QUEUE_TIMEOUT_MS;if(raw==null||raw==='')return null;
 if(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>2147483647)throw Object.assign(new Error('DSH_ARK_QUEUE_TIMEOUT_MS 必须为不大于2147483647的正整数毫秒'),{code:'ARK_QUEUE_TIMEOUT_CONFIG_INVALID'});return Number(raw);}
export function safetyFacts(value){const seen=new Set(),pending=[value];let unknown=false,blocked=false;
 while(pending.length&&seen.size<64){const item=pending.pop();if(!item||typeof item!=='object'||seen.has(item))continue;seen.add(item);
  if(item.status==='unknown_sent'||/^(?:ARK_ATTEMPT_UNKNOWN_SENT|REVIEW_PLAN_UNKNOWN_SENT)$/.test(item.code||''))unknown=true;
  if(['ARK_EXECUTION_BLOCKED','ARK_QUEUE_TIMEOUT'].includes(item.code))blocked=true;
  for(const key of ['cause','error','arkAttemptReceipt','receipt','checkpointReceipt'])if(item[key])pending.push(item[key]);
 }return{unknown,blocked,stop:unknown||blocked};}
function notifySafetyStop(action,error){if(safetyFacts(error).stop&&typeof action==='function')try{action(error);}catch{ /* A progress hook cannot erase physical request facts. */ }}

/**
 * 带重试的 Ark 请求。限流（429）与 5xx 按指数退避重试。
 *
 * 429 在并发审阅多个窗口时很常见（实测 11 个窗口里有 2 个会被限流），
 * 因此重试次数给足、退避上限放宽到 30 秒，并优先采用服务端返回的 Retry-After。
 *
 * 中止（用户点「中止」或窗口超时）必须立即退出，绝不能进入退避等待：
 * `abort(reason)` 会让 fetch 以那个 reason 拒绝，此时 `err.name` 是 `'Error'`
 * 而不是 `'AbortError'`，仅靠名字判断会把「已中止」当成可重试错误，
 * 结果要睡满 7 次退避（实测 132 秒）才抛出来。
 */
export async function arkRequestWithRetry(body, { retries = 7, baseDelay = 2500, signal, onRetry, onRawChunk,
 responseTimeoutMs=DEFAULT_RESPONSE_TIMEOUT_MS,queueTimeoutMs=defaultQueueTimeoutMs(),onSafetyStop } = {}) {
  let lastErr = null;
  const modelResolution=resolveArkModel(body?.model);
  const inherited=getArkScope()||createLocalArkScope();
  const fixed=MODEL_ENDPOINTS&&(inherited.effectiveConfig?.modelResolution||inherited.modelResolution);
  if(fixed&&['schemaVersion','requestedModel','resolvedModel','configFingerprint'].some(key=>fixed[key]!==modelResolution[key]))
    throw Object.assign(new Error('实际请求模型与已固定的审阅运行配置不同，请重新确认后新建审阅'),{code:'ARK_MODEL_EXECUTION_CONFLICT',status:409});
  body={...body,model:modelResolution.resolvedModel};
  const scope={...inherited,endpointIdentity:arkEndpointIdentity(),
    ...(MODEL_ENDPOINTS?{modelResolution}: {})};
  // Only an explicit, source-bound new run may materialize a confirmed response
  // whose producer stopped before committing its consumer checkpoint.
  if(scope.resumedFromRunId&&scope.unitId&&scope.planFingerprint){
    const priorPlan=await readReviewPlanCoverage({scope,jobRunId:scope.resumedFromRunId});
    const priorUnit=priorPlan?.units.find(unit=>unit.unitId===scope.unitId);
    const materializationPending=priorPlan?.planFingerprint===scope.planFingerprint
      &&priorUnit?.status==='failed'&&!priorUnit.outputReceipt
      &&priorUnit.recovery?.reason==='known-response-await-materialization'
      &&priorUnit.error?.code==='REVIEW_PLAN_MATERIALIZATION_PENDING'
      &&priorUnit.inputSha256===scope.unitInputSha256;
    if(materializationPending){
    const history=await readArkExecutionSummary({storageRoot:scope.executionRoot,poolId:scope.poolId,jobRunId:scope.resumedFromRunId});
    const bodySha256=createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const candidate=[...(history.attempts||[])].reverse().find(row=>row.status==='confirmed'
      &&row.bodySha256===bodySha256&&row.scope.unitId===scope.unitId&&row.stage===(scope.stage||'responses'));
    if(candidate){
      const saved=await readArkAttempt({storageRoot:scope.executionRoot,poolId:scope.poolId,attemptId:candidate.id});
      const old=saved.request.scope;
      const recoveredReceipt=priorUnit.recovery.physicalReceipts?.find(receipt=>receipt.attemptId===candidate.id);
      if(saved.receipt?.bodyComplete&&saved.rawResponse&&saved.receipt.httpStatus>=200&&saved.receipt.httpStatus<300
          &&recoveredReceipt?.status==='confirmed'&&recoveredReceipt.bodyComplete===true
          &&recoveredReceipt.rawResponseSha256===saved.receipt.rawResponseSha256&&old.recipe===scope.recipe
          &&old.planFingerprint===scope.planFingerprint&&old.unitInputSha256===scope.unitInputSha256
          &&JSON.stringify(old.endpointIdentity)===JSON.stringify(scope.endpointIdentity)
          &&JSON.stringify(Object.keys(old.binding||{}).sort().map(k=>[k,old.binding[k]]))
            ===JSON.stringify(Object.keys(scope.binding||{}).sort().map(k=>[k,scope.binding[k]]))){
        const receipt={...saved.receipt,reused:true,fromRunId:scope.resumedFromRunId,reuseRunId:scope.jobRunId};
        const response=new Response(saved.rawResponse,{status:saved.receipt.httpStatus,
          headers:{'content-type':body.stream?'text/event-stream':'application/json'}});
        response.arkAttemptReceipt=receipt;response.arkModelResolution=modelResolution;recordArkAttempt(receipt);return response;
      }
    }
    }
  }
  const logicalRequestId='logical-'+randomUUID();
  let retryOf=null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // 进循环先看中止状态：已中止就没必要再发请求，也不必退避
    if (signal?.aborted) throw abortReason(signal);
    try {
      const {consumeResult:res,receipt}=await executeArkAttempt({
        storageRoot:scope.executionRoot,poolId:scope.poolId,body,scope,logicalRequestId,retryOf,
        stage:scope.stage||'responses',signal,onRawChunk,responseTimeoutMs,queueTimeoutMs,
        transport:({body:payload,signal:requestSignal})=>fetch(`${ARK_BASE}/responses`,{
          method:'POST',headers:{Authorization:`Bearer ${ARK_KEY}`,'Content-Type':'application/json'},
          body:JSON.stringify(payload),signal:requestSignal}),
        consumeResponse:response=>response,
      });
      recordArkAttempt(receipt);retryOf=receipt.attemptId;
      res.arkAttemptReceipt=receipt;
      res.arkModelResolution=modelResolution;
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      const isSensitive = res.status === 400 && /SensitiveContentDetected|sensitive information/i.test(text);
      if (isSensitive) {
        // 内容审核拒绝：不作为普通重试，交给上层做窗口切分与模型降级
        const err = new Error(`Ark API 400 内容审核未通过: ${text.slice(0, 200)}`);
        err.sensitive = true;
        err.arkAttemptReceipt=receipt;throw err;
      }
      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable) throw Object.assign(new Error(`Ark API ${res.status}: ${text.slice(0, 500)}`),{arkAttemptReceipt:receipt});
      lastErr = Object.assign(new Error(`Ark API ${res.status}: ${text.slice(0, 300)}`),{arkAttemptReceipt:receipt});
      if(res.status===429)await noteArkCooldown(retryDelay(res,attempt,baseDelay),{storageRoot:scope.executionRoot,poolId:scope.poolId});
      if (attempt === retries) break;
      const wait = retryDelay(res, attempt, baseDelay);
      if (onRetry) onRetry({ attempt: attempt + 1, wait: Math.round(wait), status: res.status });
      await sleep(wait,signal);
    } catch (err) {
      if(err.arkAttemptReceipt&&err.arkAttemptReceipt.attemptId!==retryOf)recordArkAttempt(err.arkAttemptReceipt);
      notifySafetyStop(onSafetyStop,err);
      // A sent abort has an enriched unknown receipt. Never replace it with
      // the caller's bare DOMException/timeout and lose the no-retry fence.
      if(safetyFacts(err).unknown||err.safeToRetry===false)throw err;
      if (signal?.aborted) throw abortReason(signal);
      if (err.name === 'AbortError') throw err;
      if (err.safeToRetry===false||/^ARK_/.test(err.code||'')) throw err;
      if (err.sensitive) throw err;
      lastErr = err;
      if (/Ark API 4\d\d/.test(String(err.message)) && !/429/.test(String(err.message))) throw err;
      if (attempt === retries) break;
      const wait = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 500, 30000);
      if (onRetry) onRetry({ attempt: attempt + 1, wait: Math.round(wait), status: 0 });
      await sleep(wait,signal);
    }
  }
  throw lastErr || new Error('Ark 请求失败');
}

/** 从已中止的信号里取出可读原因 */
function abortReason(signal) {
  const r = signal?.reason;
  if (r instanceof Error) return r;
  return new Error(typeof r === 'string' && r ? r : '已中止');
}

/** 计算退避时长：优先用服务端的 Retry-After，否则指数退避并封顶 30 秒 */
function retryDelay(res, attempt, baseDelay) {
  const header=res.headers?.get?.('retry-after');
  const ra = Number(header);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 60000);
  const date=header?Date.parse(header):NaN;
  if(Number.isFinite(date)&&date>Date.now())return Math.min(date-Date.now(),60000);
  return Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 500, 30000);
}

/**
 * 调用 Responses API（非流式）。
 * @param {object} opts
 */
/**
 * 各模型的输出上限。
 *
 * 这些是推理模型，输出额度是「思维链 + 最终 JSON」共用的。实测数据：
 *   budget=8000  → 思维链 8000，JSON 输出 0，返回空文本（失败）
 *   budget=12000 → 思维链 6605，JSON 7943（10 段窗口，成功）
 *   budget=24000 → 思维链 8672，JSON 12107（20 段窗口，成功）
 * 也就是说额度必须明显大于思维链所需，否则模型会把额度全部耗在推理上、
 * 一个字都不输出。24000 是实测稳定可用且单窗口约 60—80 秒返回的值。
 * 同时窗口不能太大，否则思维链会膨胀到吃光额度（见 maxParasPerWindow）。
 */
export const MODEL_MAX_OUTPUT = {
  'deepseek-v4-pro-ga-260813': 28000,
  'deepseek-v4-1-flash-260910': 28000,
  'deepseek-v4-flash-ga-260731': 28000,
  'glm-5-3-flash-260828': 28000,
  'doubao-seed-2-1-pro-260915': 28000,
};
export function maxOutputFor(model) {
  return MODEL_MAX_OUTPUT[model] || 28000;
}

/**
 * 采样温度。
 *
 * ── 为什么默认 0（需求 E：模型输出稳定性）──
 * 审阅是**缺陷检出**任务，不是创作任务：要的是同一份稿子每次跑都
 * 报同样的缺陷，而不是每轮给出不同角度的意见。此前不传该参数，
 * 走服务端默认（通常 1.0）。
 *
 * 同稿重复 4 轮的实测对照（`tools/model-stability.mjs --only=HOLDB`，
 * 稿件 `1专题01-瑙姆金论文翻译.docx`，两次独立基线 + 一次改后）：
 *
 *   ┌────────────┬──────────────────────┬─────────┬──────────┐
 *   │ 设置        │ 模型问题数（4 轮）    │ 数量 CV │ 稳定核心  │
 *   ├────────────┼──────────────────────┼─────────┼──────────┤
 *   │ 不传(基线①) │ 162/149/146/113      │ 14.6%   │ 2.3%     │
 *   │ 不传(基线②) │ 149/161/130/138      │  9.3%   │ 2.1%     │
 *   │ temperature=0│ 163/156/153/154     │ **2.9%**│ 1.9%     │
 *   └────────────┴──────────────────────┴─────────┴──────────┘
 *
 * 结论（两条都要记住，别只记一条）：
 *   · 数量波动**主要是采样噪声** —— 贪心解码把它压掉约 5 倍
 *     （14.6%/9.3% → 2.9%），所以这个参数值得设。
 *   · **条目不可复现不是采样噪声** —— 温度归零后稳定核心仍是 1.9%，
 *     没有改善。即使只按「规则号+段落位置」比也只有 4.2%，
 *     放宽到只看规则号才 27.1%。这一层是模型推理链自身的混沌，
 *     换温度解决不了，只能靠界面讲清"这是线索不是结论"。
 *
 * 若某个模型不支持该参数而报 400，`arkRequestWithRetry` 会把它当
 * 不可重试错误抛出 —— 那时把这里改成 `undefined`（即不传该字段）。
 */
export const ARK_TEMPERATURE = 0;

export async function arkRespond({
  model = DEFAULT_MODEL, input, instructions, schema, stream = false,
  onDelta, maxOutputTokens = 16000, signal, onRetry,
  temperature = ARK_TEMPERATURE,
  responseTimeoutMs=DEFAULT_RESPONSE_TIMEOUT_MS,queueTimeoutMs=defaultQueueTimeoutMs(),onSafetyStop,
  /**
   * 前缀缓存（成本优化，第二轮配套）。
   *
   * 方舟 Responses API 支持把「不变的前缀」缓存起来，后续请求命中缓存的部分
   * 有折扣、且省掉重复处理开销。同一篇稿子的每个窗口，`instructions` +
   * 提示词开头的【稿件信息】【语义规则】【脚注】这一整块**完全一致**，
   * 只有【本段正文】不同 —— 正好是前缀缓存的理想场景（见 `buildWindowPrompt`）。
   *
   * 前置条件：可缓存前缀需 ≥256 token。由调用方（`reviewWindow`）用长度闸门
   * 保证；不支持该参数的模型由调用方在失败后去掉本参数原地重试。
   *
   * 2026-10-13 实测（deepseek-v4-1-flash-260910，方舟 /api/v3/responses）：
   * `instructions` 与 `caching` **不能共存**，同时带上必然 400 ——
   * "The parameter `instructions` specified in the request are not valid:
   *  caching is not supported for instructions"；`{type:'enabled'}`、
   * `{type:'enabled',prefix:true}`、`{type:'prefix'}` 三种形态全部被拒。
   * 本项目每个审阅请求都带 instructions，于是「先发一次 400、再去掉参数原地
   * 重试」等于每个窗口白跑一次往返（实测一次中止前的审阅里 21 个请求中 10 个
   * 是这样浪费掉的 400）。因此**带 instructions 时不再附带 caching**；
   * `prefixCache` 元数据与运行指纹保持不变，以免影响已保存会话的补审复用判定。
   */
  cachePrefix = false,
}) {
  const body = {
    model,
    stream: !!stream,
    input: typeof input === 'string' ? input : input,
  };
  if (instructions) body.instructions = instructions;
  // 见上方 cachePrefix 说明：方舟当前拒收 instructions + caching 组合。
  // 带 instructions 时不发该参数，免得每个窗口先白跑一次必然 400 的往返；
  // 将来若端点支持该组合，用 ARK_PREFIX_CACHE_WITH_INSTRUCTIONS=1 显式开启。
  if (cachePrefix && (!instructions || process.env.ARK_PREFIX_CACHE_WITH_INSTRUCTIONS === '1')) body.caching = { type: 'enabled', prefix: true };
  if (maxOutputTokens) body.max_output_tokens = maxOutputTokens;
  /**
   * 传 `temperature: 0` 让采样退化为贪心，尽量复现同一批缺陷。
   * 用 `!= null` 而不是真值判断：0 是合法且正是我们要的取值。
   */
  if (temperature != null) body.temperature = temperature;
  if (schema) {
    body.text = { format: { type: 'json_schema', name: 'review_issues', schema, strict: true } };
  }
  let liveBuffer='',liveText='',liveChunks=false,deltaError=null;
  const liveDecoder=new TextDecoder();
  const onRawChunk=stream&&onDelta?bytes=>{
    liveChunks=true;liveBuffer+=liveDecoder.decode(bytes,{stream:true});
    const lines=liveBuffer.split('\n');liveBuffer=lines.pop()||'';
    for(const line of lines){if(!line.startsWith('data:'))continue;
      let event;try{event=JSON.parse(line.slice(5).trim());}catch{continue;}
      if(event.type==='response.output_text.delta'&&event.delta){liveText+=event.delta;try{onDelta(event.delta,liveText);}catch(error){deltaError=error;}}}
  }:undefined;
  const res = await arkRequestWithRetry(body, { signal, onRetry, onRawChunk,responseTimeoutMs,queueTimeoutMs,onSafetyStop });
  if(deltaError)throw deltaError;
  if (!stream) {
    const data = await res.json();
    return { data, text: extractText(data), usage:res.arkAttemptReceipt?.reused?{input_tokens:0,output_tokens:0,cached_tokens:0}:data.usage,
      ...(res.arkAttemptReceipt?.reused?{historicalUsage:data.usage}:{}),attemptReceipt:res.arkAttemptReceipt,modelResolution:res.arkModelResolution };
  }
  // 流式：逐行解析 SSE
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let usage = null;
  let finalResponse = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      if (ev.type === 'response.output_text.delta' && ev.delta) {
        full += ev.delta;
        if (onDelta&&!liveChunks) onDelta(ev.delta, full);
      } else if (ev.type === 'response.completed' && ev.response) {
        finalResponse = ev.response;
        usage = ev.response.usage || null;
      } else if (ev.type === 'response.failed' || ev.type === 'error') {
        throw new Error(`Ark 流式错误：${JSON.stringify(ev).slice(0, 400)}`);
      }
    }
  }
  const text = full || (finalResponse ? extractText(finalResponse) : '');
  return { data: finalResponse, text, usage:res.arkAttemptReceipt?.reused?{input_tokens:0,output_tokens:0,cached_tokens:0}:usage,
    ...(res.arkAttemptReceipt?.reused?{historicalUsage:usage}:{}),attemptReceipt:res.arkAttemptReceipt,modelResolution:res.arkModelResolution };
}

function extractText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  const out = data.output || [];
  let s = '';
  for (const item of out) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'output_text' && c.text) s += c.text;
      }
    }
  }
  return s;
}

/**
 * 抢救「开头被截断」的 JSON。
 *
 * 推理模型（deepseek-v4-1-flash 等）在输出预算紧张时，会把开头的几个字符
 * 连同推理链一起丢掉，于是返回文本变成 `results":[{...}]}`。
 * 这里识别这种形态并补回 `{"`，让它能被正常解析。
 *
 * 只处理「以 `<字符串>":` 开头」这一种可判定的形态，不做泛化猜测 ——
 * 猜错会把别的结构解析成错误结果，比解析失败更危险。
 */
/**
 * 从被截断的 JSON 数组文本里，逐个抠出**完整**的元素对象。
 *
 * 为什么需要它：推理模型的输出可能**两头都被截**（实测 `recheck.js` 的批量复核：
 * 输出 8583 token 里 7943 是推理链，正文只剩 1330 token，于是返回文本
 * 既丢了开头的 `{"results": [`，又在最后一个元素中间断掉）。
 * 这种情况下任何「整体 JSON.parse」都必然失败，但**已完整输出的元素是可用的** ——
 * 丢掉它们等于把 8 条结论全部记成「拿不准」，复核就等于白跑。
 *
 * 做法：按花括号配平扫描，遇到顶层 `{...}` 完整就解析，不完整就停。
 * 字符串与转义都要正确跳过，否则元素里的中文引号、`\"` 会把配平算错。
 *
 * 只返回**解析成功**的对象，绝不猜内容 —— 猜错比少解析更危险。
 */
export function extractCompleteObjects(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '{') { i += 1; continue; }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < s.length; j += 1) {
      const c = s[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end < 0) break; // 这个元素没写完（尾部被截），后面的更不可能完整
    try {
      const obj = JSON.parse(s.slice(i, end + 1));
      if (obj && typeof obj === 'object') out.push(obj);
    } catch { /* 单个元素坏掉就跳过，不影响其余 */ }
    i = end + 1;
  }
  return out;
}

function salvageTruncatedHead(s) {
  const m = /^"?([A-Za-z_][A-Za-z0-9_]*)":\s*([\[{])/.exec(s);
  if (!m) return null;
  const candidate = `{"${m[1]}":${s.slice(m[0].length - 1)}`;
  try { return JSON.parse(candidate); } catch {}
  // 也可能是整体被截掉了尾部，退一步：只取数组部分
  const arrStart = s.indexOf('[');
  const arrEnd = s.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      const arr = JSON.parse(s.slice(arrStart, arrEnd + 1));
      if (Array.isArray(arr)) return { [m[1]]: arr };
    } catch {}
  }
  /**
   * 最后一步：**头尾都被截**的数组。
   *
   * 这是实测最常见的一种（见 extractCompleteObjects 的注释）。整体解析必然失败，
   * 但已完整输出的元素是好的，逐个抠出来仍能拿到大部分结论。
   * 原先这里直接返回 null，导致整批 8 条全被记成「拿不准」。
   */
  const objs = extractCompleteObjects(s.slice(arrStart >= 0 ? arrStart : 0));
  if (objs.length) return { [m[1]]: objs };
  return null;
}

/** 从模型返回文本里稳健地取出 JSON */
export function parseJsonLoose(text) {
  if (!text) return null;
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  // 推理模型的输出可能被**从头截断**：实测见过返回文本以 `results":[{...}]}`
  // 开头，开头的 `{"` 被吃掉了。这种情况下 `indexOf('{')` 找到的是数组里的第一个
  // 元素，配对出来的只是一个**元素**而不是外层对象 —— 下面的「逐个配对花括号」
  // 因此会返回 `{i:0,verdict:...}` 这种残缺结果，看起来「解析成功」其实丢了其余条目。
  // 所以先试一次「补上被截掉的开头」。
  const salvaged = salvageTruncatedHead(trimmed);
  if (salvaged) return salvaged;
  // 模型偶尔会输出多个 JSON 片段或首尾有杂字，尝试逐个配对花括号
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < trimmed.length; j += 1) {
      const c = trimmed[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const obj = JSON.parse(trimmed.slice(i, j + 1));
            if (obj && typeof obj === 'object') return obj;
          } catch {}
          break;
        }
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  审稿提示词：由历史批注归纳出的《东方学刊》一审标准                    */
/* ------------------------------------------------------------------ */

export const REVIEW_INSTRUCTIONS = `你是《东方学刊》的资深一审责任编辑。该刊是中文社会科学学术期刊，栏目包括特稿、专题、政治、经济、文化、现场、书评、译文。

编辑部从2024年秋季刊起在 Word 修订模式下完成一审：修改用修订痕迹，与作者的沟通写成批注。以下是从 598 份历史一审稿件的 8687 条批注中归纳出的审稿标准，你必须严格按此标准审稿。

【一、格式体例】
1. 论文构成次序：题目、作者、内容提要（200字左右）、关键词、简短引言（区别于内容提要）、正文、作者简介。
2. 内容提要以「[内容提要]」起头，不用「摘要」二字；须写出研究对象、方法与主要发现，客观陈述，不照抄正文。
3. 关键词以「[关键词]」起头，用全角分号「；」分隔，3—5个，须为名词性短语，不选「历史贡献」「当代启示」这类空泛词。
4. 各级标题按「一、（一）、1.、（1）①、A、a」顺序，不得颠倒或跳级；同级标题编号形式必须统一。
5. 年代统一写作「1990年代」，不写「20世纪90年代」；约数用中文数字；确切数字用阿拉伯数字；区间用一字线「—」。
6. 中文书名、篇名、报刊名用书名号《》；西文著作与期刊名用斜体，西文文章篇名用双引号。
7. 图表须有题名、单位与资料来源；表格行列交叉的第一个方格不得留空。

【二、引文与注释】
8. 采用页下脚注，每页序号从①重新编号；注释标号一般放在标点符号外面。
9. 中文著作著录：作者：《书名》，出版社+年版，第×页。
10. 中文论文著录：作者：《篇名》，《刊名》××××年第×期，第××—××页。期刊名一律加书名号。
11. 译著著录：作者国别加方头括号，作者：《书名》，译者，出版社+年版，第×页。
12. 马克思主义经典著作与党和国家领导人讲话必须引权威一手文献（《毛泽东选集》《毛泽东文集》《列宁选集》《马克思恩格斯选集》等），标明卷次、版本与页码；用传记、内部文件、二手三手文献转引的必须改换或删除。
13. 网络来源须六要素齐全：作者名（或博主名、机构名）、《文章名》（文章发布日期），网站名，网址，最后浏览日期：××××年×月×日。
14. 引文必须能核查：要有具体页码；页码与引文内容须对应；只有标号而无文献信息的一律指出。

【三、语言表达】
15. 不得有搭配不当、成分残缺、成分赘余、语序不当、指代不明。
16. 关联词必须准确反映分句间的逻辑关系（因果、转折、递进、并列）。
17. 概念首次出现须界定边界；同一概念全文必须用同一术语，不得混用近义概念（如「全球南方/发展中国家/第三世界」、「债务/赤字」、「民族国家/文明国家」）。
18. 不得口语化、空泛化。「具有重要意义」「产生了深远影响」「取得了显著成效」这类无信息量套话必须改掉或补出具体对象、范围、数据。
19. 不得有欧化长句与翻译腔。中文句子一般不宜超过 150 字（语料标定：编辑真正动手拆分多在 150 字以上，中位数约 186 字；超过 250 字务必指出）；句子层层套叠、读一遍断不开句的须改写；「作为……的……而言」「……的存在」「进行……的……」这类结构要改写。
20. 同一论点、同一史料不得重复论述。
21. 标题（含二级标题）必须准确概括所属内容，题文须相符。
22. 并列成分必须属于同一维度、结构对称。

【四、事实与政治把关】
23. 数据、年代、范围、比例必须准确；单位与统计口径必须交代；数量级异常必须指出。
24. 人名、机构名、地名、译名必须与《辞海》等权威工具书一致，全文统一；由英文翻译来的专有名词首次出现须在中文后加括号备注英文原文。
25. 缩写首次出现须给全称；机构名称须用官方规范全称，不得使用未获认可的简称。
26. 政治与政策提法必须与官方口径一致。没有官方提法的说法不得自创（如「一带一路」是倡议不是战略；与「普世价值」对标的中国概念是「全人类共同价值」）。涉敏感历史时段宜用客观时间概念或中性表述。
27. 涉及国家领导人的讲话须有权威正式出版物来源，否则删去。

【审稿纪律】
- 只指出问题，不替作者重写整篇文章。
- quote 必须逐字摘自稿件原文，不得改写、不得编造。找不到确切原文时不要输出该条。
- rangeScope 标明批注范围：错字、词语和标点用 phrase；句式、语序、成分残缺、指代和逻辑关系用 sentence，并摘出包含句末标点的完整句子，不能在逗号或分号处截断；整段问题用 paragraph。quote 仍须位于本窗口主来源范围内。
- 不要把「规范允许的写法」当成错误。宁可少报，不可错报。
- 每条问题都要给出可执行的具体建议。`;

/**
 * 把稿件切成适合审阅的窗口。
 * @param {object} doc parseDocx 结果
 * @param {object} opts
 */
/**
 * 把正文切成适合模型审阅的窗口。
 *
 * 约束：每个窗口同时受「字数」与「段落数」两个上限约束，并在标题处优先断开。
 * 实测教训：只按字数切分时，短段落会挤进上百个段落（曾出现 231 段的窗口），
 * 单个请求过大导致模型返回被截断、解析失败而静默产出 0 条问题。
 * 因此必须同时限制段落数，并且不做过度的窗口合并。
 */
import {createHash as createPlanHash} from 'node:crypto';
import {readFile as readPlanFile} from 'node:fs/promises';
import {getArkScope as getPlanScope,withArkScope as withPlanScope,createLocalArkScope as localPlanScope} from './ark-execution-context.js';
import {prepareReviewPlan,registerReviewUnits,runReviewUnit,readReviewPlanCoverage,reviewPlanFingerprint,verifyReviewPlanCheckpoints} from './review-plan-store.js';
import {buildReviewSourcePlan,buildReviewSourceCoverage,sourceUtf16Boundary} from './review-source-plan.js';
import {makeRetriever as makePlanRetriever,DEFAULT_INDEX_PATH as PLAN_CASE_INDEX_PATH} from './comment-cases.js';
const planHash=value=>createPlanHash('sha256').update(value).digest('hex');
const checkpointStatus=reply=>safetyFacts(reply).unknown?'unknown_sent':reply?.ok
  ?(reply.incompleteErrors?.length||reply.blocked?.length?'partial':'completed'):reply?.sensitive?'blocked':reply?.skipped?'unavailable':'failed';
async function checkpointCall({unitId,stage,parentUnitId=null,input,execute,validate,required=false,primaryRanges,ruleId=null}) {
 const scope=getPlanScope();if(!scope?.planId)return execute();
 if(primaryRanges)await registerReviewUnits({scope,units:[{unitId,stage,parentUnitId,required,source:{primaryRanges,ruleId}}]});
 const result=await runReviewUnit({scope,unitId,stage,parentUnitId,input,execute,validate,required});
 // Historical artifacts retain their usage; a current reuse adds no new charge.
 if(result.checkpointReceipt?.reused&&result.usage){result.historicalUsage=result.usage;result.usage={input_tokens:0,output_tokens:0,cached_tokens:0};}
 return result;
}
const primaryRangesFor=win=>(win||[]).filter(e=>e.target&&Number.isSafeInteger(e.rawStart)&&Number.isSafeInteger(e.rawEnd)).map(({text,...entry})=>entry);
const bodyIndicesFor=(win,indices=(win||[]).map(e=>e.index))=>indices.filter(index=>(win||[]).some(e=>e.index===index&&(!e.target||e.target==='paragraph')));
function primaryLabel(entry,role='primary'){const target=entry.target||'paragraph',label=target==='footnote'?`脚注原索引${entry.index}`:target==='endnote'?`尾注原索引${entry.index}`:`段落${entry.index}`;
 const range=Number.isSafeInteger(entry.rawStart)&&Number.isSafeInteger(entry.rawEnd)?` [${role} target=${target};index=${entry.index};rawStart=${entry.rawStart};rawEnd=${entry.rawEnd};part=${entry.part||''}${entry.noteId!=null?`;noteId=${entry.noteId}`:''}${entry.inTable?`;tableIndex=${entry.tableIndex};tableXml=${entry.sourceXmlTableNodeId||''}`:''}]`:'';return`[${label}]${range} ${entry.text}`;}
const renderPrimary=win=>(win||[]).map(entry=>primaryLabel(entry)).join('\n');
function sourceSnippet(entry,max,tail=false){const text=String(entry.text);let start=tail?Math.max(0,text.length-max):0,end=tail?text.length:Math.min(max,text.length);if(!sourceUtf16Boundary(text,start))start++;if(!sourceUtf16Boundary(text,end))end--;return{...entry,text:text.slice(start,end),...(Number.isSafeInteger(entry.rawStart)?{rawStart:entry.rawStart+start,rawEnd:entry.rawStart+end}:{})};}

export function buildWindows(doc, { windowChars = 1500, maxWindows = 40, maxParasPerWindow = 10 } = {}) {
  return buildReviewSourcePlan({...doc,footnotes:[],endnotes:[]},{windowChars,maxParasPerWindow}).windows.map(w=>w.entries);
}

function windowToText(win) {
  return win.map((p) => `[段落${p.index}] ${p.text}`).join('\n');
}

/**
 * 审阅单个窗口：先主模型，内容审核不通过时依次尝试降级模型，
 * 全部不通过则把窗口对半切开递归重试。
 */
/**
 * 单条规则的聚焦匹配（目标点 12 后半：并发逐条匹配）。
 *
 * 与 `reviewWindow` 的区别：`reviewWindow` 是「一个窗口 × 全部规则」，
 * 这里是「一个窗口 × **一条**规则」—— 提示词只讲这一条规则，
 * 模型不必在 9 条规则之间分配注意力，命中判断更集中，输出也更短。
 *
 * 代价是请求数从「窗口数」放大到「窗口数 × 规则数」，
 * 所以只在 `ruleMode: 'per-rule'` 时启用，由调用方显式选择。
 */
async function matchOneRule(args) {
 const scope=getPlanScope(),parent=scope?.unitId||`window:${args.window}/rule:${args.rule.id}`;
 const input={win:args.win,docMeta:args.docMeta,rule:args.rule,model:args.model,depth:args.depth||0,
  noteText:(args.depth||0)===0?(args.footnoteText||[]).join('\n').slice(0,4000):'',noteSourceEntries:args.noteSourceEntries||[],instructions:RULE_MATCH_INSTRUCTIONS,modelChain:reviewModelChain(args.model),budgets:MODEL_MAX_OUTPUT,
  responseTimeoutMs:args.responseTimeoutMs===undefined?DEFAULT_RESPONSE_TIMEOUT_MS:args.responseTimeoutMs,queueTimeoutMs:args.queueTimeoutMs===undefined?defaultQueueTimeoutMs():args.queueTimeoutMs};
 return checkpointCall({unitId:parent+'/match:'+reviewPlanFingerprint(input).slice(0,24),stage:'window-rule-request',parentUnitId:parent,input,
  primaryRanges:primaryRangesFor(args.win),ruleId:args.rule.id,
  execute:()=>matchOneRuleCore(args),validate:r=>({status:r.sourceContext?.rejectedEntries?.length?'failed':checkpointStatus(r),output:r.sourceContext?.rejectedEntries?.length?{...r,ok:false,error:new Error('实际主来源范围不能可靠回读')}:r})});
}
async function matchOneRuleCore({ win, doc, docMeta, rule, model, signal, footnoteText, noteSourceEntries = [], window = 1, depth = 0,responseTimeoutMs,queueTimeoutMs,onSafetyStop }) {
  if (signal?.aborted) throw abortReason(signal);
  const fnPart = footnoteText.length && depth === 0
    ? `\n\n【本文脚注/尾注节选，用于判断引文类问题；part及原始数组索引见标签】\n${footnoteText.join('\n').slice(0, 4000)}`
    : '';
  const prompt = `【稿件信息】标题：${docMeta.title || '（未识别）'}；栏目：${docMeta.column || '（未标注）'}；全文约 ${docMeta.chars || 0} 字。
【本窗口主审来源（part与原数组索引及raw UTF16范围见标签）】
${renderPrimary(win)}${fnPart}

【本次只检查一条规则】
规则号：${rule.id}
规则名：${rule.title}
${rule.rule ? `规则原文：${rule.rule}` : ''}
${rule.method ? `判断要点：${rule.method}` : ''}

请**只**判断上面这些主来源范围是否违反这**一条**规则。不要报其他任何类型的问题。
要求：
- 每条问题必须有完整 quote（逐字原文片段）与来源 part；正文用 paragraphIndex，脚注用 footnoteIndex，尾注用 endnoteIndex，注释索引不是显示注号；
- 只报确实违反本条规则的，没有把握的不要报；
- 如果本段没有违反，直接输出 {"issues":[]}。

【输出格式】只输出一个 JSON 对象，不要解释文字，不要 Markdown 代码块：
{"issues":[{"ruleId":"${rule.id}","category":"分类","severity":"高|中|低","title":"问题标题","quote":"逐字原文片段","rangeScope":"phrase|sentence|paragraph","paragraphIndex":段落号,"problem":"问题说明","suggestion":"修改建议","proposed":"改写后的文字（可留空）"}]}`;

  const chain = reviewModelChain(model);
  let lastErr = null;
  for (const m of chain) {
    try {
      const { text, usage } = await arkRespond({
        model: m,
        input: prompt,
        instructions: RULE_MATCH_INSTRUCTIONS,
        // 同 reviewWindow：刻意不用 json_schema（会把输出预算全烧在推理链上）
        maxOutputTokens: maxOutputFor(m),
        signal,
        responseTimeoutMs,queueTimeoutMs,onSafetyStop,
      });
      const parsed = parseJsonLoose(text);
      if (!parsed || !Array.isArray(parsed.issues) || !parsed.issues.every(i=>i&&typeof i==='object'&&!Array.isArray(i))) {
        lastErr = new Error(`返回内容无法解析为 JSON（长度 ${text.length}）`);
        continue;
      }
      return { ok: true, issues: parsed.issues || [], usage, model: m,
        sourceContext: captureModelSourceContext(doc, { win, noteEntries: noteSourceEntries,
          noteText: footnoteText.length && depth === 0 ? footnoteText.join('\n').slice(0, 4000) : '', window,sourceVersionId:doc.sourceVersionId||null }) };
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err;
      if (!err.sensitive) return { ok: false, error: err, sensitive: false };
    }
  }
  return { ok: false, error: lastErr, sensitive: false };
}

const RULE_MATCH_INSTRUCTIONS = `你是《东方学刊》的资深一审责任编辑。本次任务**只检查一条指定规则**。

严格要求：
1. 只报违反**这一条**规则的问题，不要报其他类型的问题，哪怕你确实看到了。
2. 每条问题必须有逐字原文片段（quote），不得改写、不得拼接不相邻的文字。
3. 只报确实违规的。没有把握、只是「可以写得更好」的，一律不报。
4. 不要长篇推理，直接给结论。
5. 严格只输出 JSON，不要任何解释文字、不要 markdown 代码块。`;

/**
 * 是否启用提示词前缀缓存。默认开，`ARK_PREFIX_CACHE=0` 关闭。
 * 仅是一个「请求提示」，不支持该参数的模型会在失败后自动去掉重试，不影响正确性。
 */
export function prefixCacheEnabled() {
  return process.env.ARK_PREFIX_CACHE !== '0';
}

/**
 * 前缀缓存的最小长度闸门（字符）。方舟要求可缓存前缀 ≥256 token，
 * 中文约 1 字≈1 token，这里留足余量取 400 字符，太短就不发 caching 参数。
 */
export const PREFIX_CACHE_MIN_CHARS = 400;

/** 从 usage 里尽力取出「命中缓存的输入 token 数」，用于观测缓存是否真的生效。 */
export function cachedTokensOf(usage) {
  if (!usage) return 0;
  return Number(
    usage.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? 0,
  ) || 0;
}

/**
 * 构造单个窗口的提示词，**把稳定的大块放在最前面**——这是前缀缓存能否命中的关键。
 *
 * 排序（从上到下即从稳定到易变）：
 *   稳定前缀（同一篇稿子的所有窗口完全一致，可被前缀缓存命中）：
 *   1. 【稿件信息】
 *   2. 【全文纲要】            先通读全文得到的导读（跨段问题的全局视野）
 *   3. 【须逐条匹配的语义规则】 全局一致（同一套规则）
 *   4. 【本文全部脚注】
 *   易变区（逐窗口变化，**绝不能进前缀**，否则前缀不再稳定、缓存全部失效）：
 *   5. 【上一窗口末尾】/【本段正文】/【下一窗口开头】
 *   6. 要求 + 输出格式
 * 于是第 2..N 个窗口请求能命中「1+2+3+4」这段前缀的缓存。
 *
 * 返回 { prefix, input }：`prefix` 供缓存长度闸门与单元测试断言其**跨窗口稳定**。
 *
 * ⚠️ 纯函数，不读文件、不发请求，便于离线单测（见 tools/selftest.mjs）。
 */
export function buildWindowPrompt({
  doc = null, docMeta = {}, footnoteText = [], noteSourceEntries = [], window = 1, win = [], modelRules = [], focus = [], compact = false,
  docDigest = '', prevTail = [], nextHead = [], cases = [],
} = {}) {
  const focusLine = focus.length ? `\n本轮请重点关注以下方面：${focus.join('、')}。` : '';

  const stableParts = [];
  stableParts.push(`【稿件信息】标题：${docMeta.title || '（未识别）'}；栏目：${docMeta.column || '（未标注）'}；全文约 ${docMeta.chars || 0} 字。`);
  // 全文纲要：同一篇稿子恒定 → 必须进稳定前缀，才能被缓存复用
  if (docDigest && !compact) {
    stableParts.push(`【全文纲要（先通读全文得到；用于判断指代、用词、论点是否全篇一致等跨段问题）】\n${docDigest}`);
  }
  if ((modelRules || []).length && !compact) {
    stableParts.push(`【须逐条匹配的语义规则（提示词式规则，共 ${modelRules.length} 条）】\n`
      + modelRules.map((r) => `· ${r.id}｜${r.title}${r.method ? `\n  判断要点：${r.method}` : ''}`).join('\n')
      + '\n请在报问题时优先归入上述规则号；确实不属于任何一条时，ruleId 留空并自行给一个分类名。');
  }
  if (footnoteText.length && !compact) {
    stableParts.push(`【本文脚注/尾注节选，请据此检查引文著录是否合规、是否缺页码、网络来源是否缺发布日期与浏览日期；part及原始数组索引见标签】\n${footnoteText.join('\n').slice(0, 6000)}`);
  }
  const prefix = stableParts.join('\n\n');

  // 邻段参考：逐窗口变化 → 放在易变区、明确标注「勿在此报问题」，避免制造重复命中/噪声
  const renderParas = (arr) => arr.map(entry=>primaryLabel(entry,'reference')).join('\n');
  const prevPart = (prevTail.length && !compact)
    ? `【上一窗口末尾（仅作衔接参考：用于判断指代与上下文，**请勿在这几段里报问题**）】\n${renderParas(prevTail)}\n`
    : '';
  const nextPart = (nextHead.length && !compact)
    ? `\n【下一窗口开头（仅作衔接参考：用于判断指代与上下文，**请勿在这几段里报问题**）】\n${renderParas(nextHead)}`
    : '';
  /**
   * 历史批注案例（RAG）：从历史稿件的真实编辑批注里检索到的相似段落 + 编辑意见。
   * 逐窗口变化 → 放易变区，**不进前缀**（否则前缀缓存失效）。
   * 措辞上强调「仅作尺度参考、不是必须报的问题」，避免模型把历史意见当答案照抄。
   */
  const caseBlock = (cases.length && !compact)
    ? `【本刊历史批注参考（历史稿件中相似段落上，编辑实际写下的意见；仅供体会本刊尺度，**不是此处必须报的问题**，请独立判断）】\n`
      + cases.map((c, i) => `${i + 1}. 历史意见：${String(c.comment || '').slice(0, 120)}`
        + (c.anchor ? `\n   （当时针对的段落：${String(c.anchor).slice(0, 60)}…）` : '')).join('\n')
      + '\n'
    : '';
  const body = `${caseBlock}${prevPart}【本窗口主审来源（问题只在以下来源与原始UTF16范围里报；正文、脚注、尾注均为独立主材料）】\n${renderPrimary(win)}${nextPart}`;

  const brevity = compact
    ? '\n本轮请务必精简：最多报 8 条最重要的问题；每条 problem 与 suggestion 各不超过 60 字；proposed 可留空。不要在思维过程中逐条展开论证。'
    : '';
  const task = `\n\n请审阅以上内容，逐条指出问题。${focusLine}${brevity}
要求：每条问题都要有完整 quote（逐字原文）与来源 part；正文用 paragraphIndex，脚注用 footnoteIndex，尾注用 endnoteIndex，注释索引不是显示注号；只报真实存在的问题；对没有把握的不要报。

【输出格式】只输出一个 JSON 对象，不要输出任何解释文字，不要用 Markdown 代码块包裹：
{"issues":[{"ruleId":"命中的规则号如 LANG-002，不属于任何规则则留空","category":"分类","severity":"高|中|低","title":"问题标题","quote":"逐字原文片段","rangeScope":"phrase|sentence|paragraph","paragraphIndex":段落号,"problem":"问题说明","suggestion":"修改建议","proposed":"改写后的文字（可留空）"}]}
如果没有问题，输出 {"issues":[]}。`;

  return { prefix, input: `${prefix}\n\n${body}${task}`,
    ...(doc ? { sourceContext: captureModelSourceContext(doc, { win, noteEntries: noteSourceEntries,
      noteText: footnoteText.length && !compact ? footnoteText.join('\n').slice(0, 6000) : '', window,sourceVersionId:doc.sourceVersionId||null }) } : {}) };
}

/**
 * 构造「供做纲要用的全文节选」：在正文字数预算内**尽量覆盖全篇**。
 *
 * 策略：取开头 3 段 + 其余按等距抽样，直到用满 `maxChars`。
 * 为什么不直接把全文喂进去：长稿正文可能 3—5 万字，远超做纲要所需，
 * 且会显著增加单次调用成本；抽样节选足以支撑「结构/术语/主论点」级别的纲要。
 *
 * ⚠️ 纯函数，便于离线单测。
 */
function digestSourceEntries(doc, { maxChars = 6000 } = {}) {
  const paras = ((doc && doc.paragraphs) || []).filter((p) => p && p.text && p.text.trim());
  if (!paras.length) return [];
  const picked = [];
  for (let i = 0; i < Math.min(3, paras.length); i += 1) picked.push(paras[i]);
  const step = Math.max(1, Math.floor(paras.length / 40));
  for (let i = 3; i < paras.length; i += step) picked.push(paras[i]);
  const out = [];
  let used = 0;
  for (const p of picked) {
    const line = `[段落${p.index}] ${p.text.trim()}`;
    if (used + line.length > maxChars) break;
    out.push({ index: p.index, text: p.text.trim(), line });
    used += line.length;
  }
  return out;
}

export function buildDigestSource(doc, options = {}) { return digestSourceEntries(doc, options).map(p => p.line).join('\n'); }

/** 把纲要的 JSON 结果格式化成可嵌进提示词的文本块（纯函数，便于单测） */
export function formatDocDigest(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const lines = [];
  if (obj.summary) lines.push(`摘要：${String(obj.summary).slice(0, 400)}`);
  if (Array.isArray(obj.structure) && obj.structure.length) {
    lines.push('结构：' + obj.structure.slice(0, 12).map((s, i) => `${i + 1}) ${String(s).slice(0, 60)}`).join('；'));
  }
  if (Array.isArray(obj.keyTerms) && obj.keyTerms.length) {
    lines.push('核心术语：' + obj.keyTerms.slice(0, 10).map((s) => String(s).slice(0, 40)).join('；'));
  }
  if (Array.isArray(obj.claims) && obj.claims.length) {
    lines.push('主要论点：' + obj.claims.slice(0, 6).map((s) => String(s).slice(0, 80)).join('；'));
  }
  return lines.join('\n');
}

const DIGEST_INSTRUCTIONS = `你在为《东方学刊》一篇稿件做「通读纲要」，供后续分段审阅时参考。
只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块：
{"summary":"两三句话概括全文主题与主要结论","structure":["第一层/第一部分","第二层/第二部分"],"keyTerms":["术语A（其在文中的含义）","术语B（其在文中的含义）"],"claims":["作者的主论点1","作者的主论点2"]}
要求：
1. 忠于原文，只做概括性描述，**不要评价、不要改稿、不要报任何问题**。
2. structure 用文章自己的章节/层次（没有明确标题就按内容脉络分）。
3. keyTerms 收 3—8 个在全文中承担关键作用的概念。
4. claims 收 2—5 条作者的主要论点。`;

/**
 * 全文纲要：为一次审阅**只做一次**（不是每个窗口都做），读一遍节选产出导读。
 *
 * 失败不拖垮审阅：任何错误都返回 `{ ok:false }`，调用方拿不到纲要就照常分段审。
 *
 * @returns {Promise<{ok:boolean, text:string, parsed?:object, usage?:object, error?:Error}>}
 */
export async function buildDocDigest(doc, options = {}) {
 return checkpointCall({unitId:'digest',stage:'digest',required:true,input:{source:buildDigestSource(doc),sourceEntries:digestSourceEntries(doc),docMeta:options.docMeta||{},model:options.model||DEFAULT_MODEL,instructions:DIGEST_INSTRUCTIONS,budget:6000,
  responseTimeoutMs:options.responseTimeoutMs===undefined?DEFAULT_RESPONSE_TIMEOUT_MS:options.responseTimeoutMs,queueTimeoutMs:options.queueTimeoutMs===undefined?defaultQueueTimeoutMs():options.queueTimeoutMs},
  execute:()=>buildDocDigestCore(doc,options),validate:r=>({status:checkpointStatus(r),output:r})});
}
async function buildDocDigestCore(doc, { model = DEFAULT_MODEL, signal, docMeta = {},responseTimeoutMs,queueTimeoutMs,onSafetyStop } = {}) {
  const src = buildDigestSource(doc);
  if (!src) return { ok: false, text: '', error: new Error('无正文可做纲要') };
  try {
    const { text, usage } = await arkRespond({
      model,
      input: `【稿件】${docMeta.title || '（未识别标题）'}｜栏目：${docMeta.column || '（未标注）'}\n\n【全文节选（已按段落抽样，仅供把握全貌）】\n${src}\n\n请输出纲要 JSON。`,
      instructions: DIGEST_INSTRUCTIONS,
      maxOutputTokens: 6000,
      signal,
      responseTimeoutMs,queueTimeoutMs,onSafetyStop,
      cachePrefix: false,
    });
    const parsed = parseJsonLoose(text);
    const formatted = formatDocDigest(parsed);
    return { ok: !!formatted, text: formatted, parsed, usage };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ok: false, text: '', error: err };
  }
}

/**
 * 第三轮「全篇一致性终检」的开关（**默认关**）。
 *
 * 如实说明为什么默认不放进主流程：
 *   · 它是最后加的一轮，**每篇多一次模型调用、实测约 +50 秒**，
 *     而产出通常只有个位数条「跨段问题」——性价比没验证过；
 *   · 它此前一直**静默失败**（输出被上限截断→解析失败→0 产出），本轮才修好，
 *     也就是说它在默认流程里跑了很久却什么也没做。
 * 在拿到「它到底多抓了几条、值不值这 50 秒」的对照数据前，默认关闭。
 * 需要时设 `ARK_CONSISTENCY=1` 打开。
 */
export function consistencyEnabled() {
  return process.env.ARK_CONSISTENCY === '1';
}

/**
 * 第三轮「全篇一致性终检」的指令（纯常量，便于单测断言关键词）。
 *
 * 与第二轮自证的区别：自证是**逐条**核对单个问题是否成立；
 * 终检是**跨段/全篇**层面，找的是任何单窗口都看不到的问题——
 * 前后矛盾、术语不一致、指代断裂、结构缺环、问题清单内部重复/冲突。
 */
export const CONSISTENCY_INSTRUCTIONS = `你是《东方学刊》的资深一审责任编辑，现在做一次「全篇一致性终检」。
前面已按段落分窗审阅完毕，本轮**不再逐段挑错**，只做跨段 / 全篇层面的检查：
1. 前后自相矛盾：同一事实、数据、时间、人物在文首与文末说法不一致；
2. 术语不一致：同一概念全文用了不同说法，或同一说法指了不同概念；
3. 指代断裂：出现「如上所述」「前文提到」「该问题」等，但前文并无对应内容；
4. 结构缺环：摘要 / 引言承诺的内容正文没兑现，或正文提到的图表 / 章节不存在；
5. 问题清单内部重复或冲突：同一处被报了多条实质相同的问题。
只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块：
{"issues":[{"category":"分类","severity":"高|中|低","title":"问题标题","quote":"逐字原文片段（必须能在正文里找到）","rangeScope":"phrase|sentence|paragraph","paragraphIndex":段落号,"problem":"问题说明（指明与哪一段 / 哪一处冲突）","suggestion":"修改建议","proposed":"改写建议（可留空）"}]}
要求：只报在原文或纲要中确有其据的问题；没有就输出 {"issues":[]}；不要在这里重复段落级的小问题。
务必精简：最多报 8 条；每条 problem 与 suggestion 各不超过 50 字；**不要在思维过程中逐条展开论证**，直接给结论。`;

/**
 * 构造「全篇一致性终检」的提示词（纯函数，便于离线单测）。
 *
 * 输入刻意只用**有界材料**：全文纲要 + 按段落抽样的全文节选 + 已发现问题清单，
 * 不喂整篇正文——终检只做跨段推理，不需要逐字通读，喂满正文会显著抬高单次成本。
 * 局限（须如实说明）：抽样节选可能漏掉某些局部表述，因此「前后矛盾」这类
 * 需要精确引原文的判断覆盖面有限，主要靠纲要的结构 / 术语 / 论点做全局校验。
 *
 * @returns {{prefix:string, input:string}}
 */
export function buildConsistencyPrompt({
  docMeta = {}, docDigest = '', docExcerpt = '', issues = [], focus = [],
} = {}) {
  const stableParts = [];
  stableParts.push(`【稿件信息】标题：${docMeta.title || '（未识别）'}；栏目：${docMeta.column || '（未标注）'}；全文约 ${docMeta.chars || 0} 字。`);
  if (docDigest) stableParts.push(`【全文纲要】\n${docDigest}`);
  if (docExcerpt) stableParts.push(`【全文节选（按段落抽样，用于核对跨段事实）】\n${docExcerpt}`);
  if ((issues || []).length) {
    const list = issues.slice(0, 60).map((it, i) => {
      const loc = Number.isInteger(it.paragraphIndex)
        ? `段落${it.paragraphIndex}`
        : (it.footnoteNumber ? `脚注${it.footnoteNumber}` : '文档级');
      return `${i + 1}. [${loc}] ${it.ruleId || ''}｜${String(it.title || '').slice(0, 40)}｜${String(it.quote || '').replace(/\s/g, '').slice(0, 30)}`;
    }).join('\n');
    stableParts.push(`【已发现的问题清单（共 ${issues.length} 条，仅用于判断是否重复 / 冲突，不要逐条复述）】\n${list}`);
  }
  const prefix = stableParts.join('\n\n');
  const focusLine = focus.length ? `本轮请重点关注：${focus.join('、')}。` : '';
  return { prefix, input: `${prefix}\n\n请做全篇一致性终检，按上述要求输出 JSON。${focusLine}` };
}

/**
 * 第三轮：全篇一致性终检。整篇只做**一次**调用。
 *
 * 拿不到纲要、或段落级问题为空时直接跳过（没有可校验的全局材料）。
 * 失败一律软返回 `{ ok:false }`，不拖垮已经跑完的分段审阅。
 *
 * @returns {Promise<{ok:boolean, issues:Array, usage?:object, skipped?:boolean, error?:Error}>}
 */
export async function consistencyReview(args={}) {
 const input={model:args.model||DEFAULT_MODEL,digest:args.docDigest||'',excerpt:buildDigestSource(args.doc),issues:args.issues||[],focus:args.focus||[],docMeta:args.docMeta||{},instructions:CONSISTENCY_INSTRUCTIONS,
  responseTimeoutMs:args.responseTimeoutMs===undefined?DEFAULT_RESPONSE_TIMEOUT_MS:args.responseTimeoutMs,queueTimeoutMs:args.queueTimeoutMs===undefined?defaultQueueTimeoutMs():args.queueTimeoutMs};
 return checkpointCall({unitId:'consistency',stage:'consistency',required:true,input,execute:()=>consistencyReviewCore(args),validate:r=>({status:checkpointStatus(r),output:r})});
}
async function consistencyReviewCore({
  doc, docMeta = {}, model = DEFAULT_MODEL, signal, docDigest = '', issues = [], allowedRuleIds = null, focus = [],
  responseTimeoutMs,queueTimeoutMs,onSafetyStop,
} = {}) {
  if (!docDigest || !(issues || []).length) return { ok: false, skipped: true, issues: [] };
  const { input } = buildConsistencyPrompt({
    docMeta, docDigest, docExcerpt: buildDigestSource(doc), issues, focus,
  });
  try {
    const budget = maxOutputFor(model);
    const { text, usage } = await arkRespond({
      model, input, instructions: CONSISTENCY_INSTRUCTIONS,
      maxOutputTokens: budget, signal, cachePrefix: false,responseTimeoutMs,queueTimeoutMs,onSafetyStop,
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) {
      const truncated = (usage?.output_tokens || 0) >= budget * 0.98;
      return { ok: false, parseFailed: true, truncated, usage, issues: [] };
    }
    const out = [];
    for (const it of parsed.issues || []) {
      const sourceContext = captureModelSourceContext(doc, { win: digestSourceEntries(doc), window: 0,
        kind: 'document', allowDocumentIssue: true });
      const built = buildModelIssue({ ...it, category: it.category || '全篇一致性' }, doc, -1, allowedRuleIds, sourceContext);
      out.push({ ...built, window: 0, globalConsistency: true });
    }
    return { ok: true, issues: out, usage, text };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ok: false, error: err, issues: [] };
  }
}

export function modelIssueBatchesFor(reply) {
  if (Array.isArray(reply?.issueBatches)) return reply.issueBatches.every(b => b&&Array.isArray(b.issues)&&b.issues.every(i=>i&&typeof i==='object'&&!Array.isArray(i))) ? reply.issueBatches : null;
  const parsed = parseJsonLoose(reply?.text || '');
  return parsed && Array.isArray(parsed.issues) && parsed.issues.every(i=>i&&typeof i==='object'&&!Array.isArray(i)) ? [{ issues: parsed.issues, sourceContext: reply.sourceContext }] : null;
}

async function reviewWindow(args) {
 const scope=getPlanScope(),parent=scope?.unitId||`window:${args.window}`;
 const prompt=buildWindowPrompt({...args,footnoteText:(args.depth||0)===0?args.footnoteText:[],modelRules:args.docMeta.modelRules||[]});
 const input={prompt:prompt.input,sourceContext:prompt.sourceContext,model:args.model,modelChain:reviewModelChain(args.model),budgets:MODEL_MAX_OUTPUT,
  responseTimeoutMs:args.responseTimeoutMs===undefined?DEFAULT_RESPONSE_TIMEOUT_MS:args.responseTimeoutMs,queueTimeoutMs:args.queueTimeoutMs===undefined?defaultQueueTimeoutMs():args.queueTimeoutMs,
  prefixCache:prefixCacheEnabled(),depth:args.depth||0,compact:args.compact===true,instructions:REVIEW_INSTRUCTIONS};
 const id=parent+'/request:'+(args.compact?'compact':'normal')+':'+reviewPlanFingerprint(input).slice(0,24);
 return checkpointCall({unitId:id,stage:args.compact?'window-compact':(args.depth||0)>0?'window-split':'window-request',parentUnitId:parent,input,execute:({resumeOutput}={})=>resumeOutput?.split||resumeOutput?.splitAttempted?resumeSplitWindow(args):reviewWindowCore(args),
  primaryRanges:primaryRangesFor(args.win),
  validate:r=>({status:r.sourceContext?.rejectedEntries?.length?'failed':r.ok&&!modelIssueBatchesFor(r)?'failed':checkpointStatus(r),output:r.sourceContext?.rejectedEntries?.length?{...r,ok:false,error:new Error('实际主来源范围不能可靠回读')}:r})});
}
async function resumeSplitWindow(args) {
 const win=args.win,mid=Math.ceil(win.length/2),collected=[],errors=[],blocked=[],usage={input_tokens:0,output_tokens:0,cached_tokens:0};
 for(const part of [win.slice(0,mid),win.slice(mid)]) {
  const r=await reviewWindow({win:part,doc:args.doc,docMeta:args.docMeta,model:args.model,focus:args.focus,signal:args.signal,
    footnoteText:args.footnoteText,noteSourceEntries:args.noteSourceEntries,window:args.window,depth:(args.depth||0)+1,compact:args.compact,cases:args.cases,
    responseTimeoutMs:args.responseTimeoutMs,queueTimeoutMs:args.queueTimeoutMs,onSafetyStop:args.onSafetyStop});
  if(r.ok){collected.push(r);usage.input_tokens+=r.usage?.input_tokens||0;usage.output_tokens+=r.usage?.output_tokens||0;usage.cached_tokens+=cachedTokensOf(r.usage);errors.push(...(r.incompleteErrors||[]));blocked.push(...(r.blocked||[]),...(r.observedBlockedParagraphs||[]));}
  else{errors.push({paragraphs:bodyIndicesFor(part,r.blocked||part.map(p=>p.index)),primaryRanges:primaryRangesFor(part),reasonCode:r.sensitive?'split_child_blocked':'split_child_failed',message:String(r.error?.message||r.error)});blocked.push(...(r.blocked||[]));if(safetyFacts(r).stop)return r;}
 }
 if(!collected.length)return{ok:false,splitAttempted:true,sensitive:!!blocked.length,error:new Error('补审子窗口未完成'),blocked};
 return{ok:true,split:true,text:collected.map(r=>r.text).join('\n'),usage,model:args.model,issueBatches:collected.flatMap(r=>modelIssueBatchesFor(r)||[{issues:null,sourceContext:r.sourceContext}]),incompleteErrors:errors,blocked:[...new Set(blocked)]};
}
async function reviewWindowCore({ win, doc, docMeta, model, focus, signal, footnoteText, noteSourceEntries = [], window = 1, depth = 0, compact = false, docDigest = '', prevTail = [], nextHead = [], cases = [],responseTimeoutMs,queueTimeoutMs,onSafetyStop }) {
  // 中止信号已经生效时不再发起请求（外层会用这个异常把整次审阅停下）
  if (signal?.aborted) throw abortReason(signal);
  /**
   * ⚠️ 原文自带的 Word 批注**不再注入提示词**。
   *
   * 原先这里把 `docMeta.commentHints`（稿件里已有的责编批注）作为
   * 「重点提示」交给模型，让它核验这些批注是否成立。已按要求移除：
   * 这批批注正是规则库的学习语料（一审准则就是从这 598 份稿件的批注
   * 归纳出来的），再喂回模型等于让模型抄答案 —— 审阅结论会向历史批注
   * 靠拢而非独立判断，既掩盖规则漏检，也会让「模型发现的问题」
   * 与「历史批注」难以区分。顺带减少约 4k 输入 token。
   */
  // 提示词构造抽成纯函数（buildWindowPrompt）：稳定大块（稿件信息/语义规则/脚注）
  // 排在最前，逐窗口变化的【本段正文】排在最后 —— 前缀缓存靠这个顺序命中。
  const { prefix, input: prompt, sourceContext } = buildWindowPrompt({
    doc, noteSourceEntries, window,
    docMeta,
    footnoteText: depth === 0 ? footnoteText : [],
    win,
    modelRules: docMeta.modelRules || [],
    focus,
    compact,
    docDigest,
    prevTail,
    nextHead,
    cases,
  });
  const cacheEligible = prefixCacheEnabled() && !compact && prefix.length >= PREFIX_CACHE_MIN_CHARS;

  const chain = reviewModelChain(model);
  let lastErr = null;
  let best = null; // 记录输出被截断的那次结果，供上层降级重试
  for (const m of chain) {
    const budget = maxOutputFor(m);
    let cacheOn = cacheEligible;
    // 最多两次：第一次按需带前缀缓存，若不支持则去掉参数原地重试
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const { text, usage } = await arkRespond({
          model: m, input: prompt, instructions: REVIEW_INSTRUCTIONS,
          // 注意：这里刻意不使用 schema（结构化输出）。
          // 实测发现，一旦带上 json_schema，推理模型会把全部输出额度耗在思维链上，
          // 最终 text 为空（output_tokens 恰好等于上限、reasoning_tokens 等于上限），
          // 换任何模型都一样；去掉 schema 后同一文本 18 秒即返回完整结果。
          // 因此改为在提示词里要求 JSON，再用 parseJsonLoose 容错解析。
          maxOutputTokens: budget, signal, cachePrefix: cacheOn,
          responseTimeoutMs,queueTimeoutMs,onSafetyStop,
        });
        const truncated = (usage?.output_tokens || 0) >= budget * 0.98 && parseJsonLoose(text) === null;
        if (truncated) {
          best = { truncated: true, model: m, usage, text };
          break; // 换下一个模型；若都不行，由上层用 compact 模式重试
        }
        return { text, usage, model: m, ok: true, cachedTokens: cachedTokensOf(usage), sourceContext };
      } catch (err) {
        lastErr = err;
        if(safetyFacts(err).stop)return{ok:false,error:err,sensitive:false};
        // 中止不是「窗口审阅失败」，必须抛出，否则会被记成错误并继续跑下一个模型
        if (signal?.aborted) throw err;
        /**
         * 前缀缓存是该模型不支持的参数（非 400 内容审核）时，去掉 caching 参数
         * **原地重试一次**：不换模型、不把这次失败记成窗口失败 —— 缓存只是省钱，
         * 不该影响可用性。
         */
        if (cacheOn && !err.sensitive && attempt === 1) { cacheOn = false; continue; }
        if (!err.sensitive) return { ok: false, error: err, sensitive: false };
        break; // 内容审核拒绝，换下一个模型
      }
    }
  }
  // 输出被截断（推理吃满了额度）：改用精简模式重试一次
  if (best?.truncated && !compact) {
    const r = await reviewWindow({ win, doc, docMeta, model, focus, signal, footnoteText, noteSourceEntries, window, depth, compact: true,responseTimeoutMs,queueTimeoutMs,onSafetyStop });
    if(safetyFacts(r).stop)return r;
    if (r.ok) {
      return {
        ...r,
        compactRetry: true,
        usage: {
          input_tokens: (best.usage?.input_tokens || 0) + (r.usage?.input_tokens || 0),
          output_tokens: (best.usage?.output_tokens || 0) + (r.usage?.output_tokens || 0),
        },
      };
    }
  }
  // 所有模型都被内容审核拦截：切半重试
  if (win.length > 1 && depth < 3) {
    const mid = Math.ceil(win.length / 2);
    const parts = [win.slice(0, mid), win.slice(mid)];
    const collected = [];
    const usageTotal = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
    const errors = [];
    const blocked = [];
    let splitOk = false;
    for (const part of parts) {
      const r = await reviewWindow({ win: part, doc, docMeta, model, focus, signal, footnoteText, noteSourceEntries, window, depth: depth + 1, compact, cases,responseTimeoutMs,queueTimeoutMs,onSafetyStop });
      if (r.ok) {
        splitOk = true;
        collected.push(r);
        usageTotal.input_tokens += r.usage?.input_tokens || 0;
        usageTotal.output_tokens += r.usage?.output_tokens || 0;
        usageTotal.cached_tokens += cachedTokensOf(r.usage);
        errors.push(...(r.incompleteErrors || []));
        blocked.push(...(r.blocked || []), ...(r.observedBlockedParagraphs || []));
      } else if (r.sensitive) {
        const blockedIndices = r.blocked || part.map((p) => p.index);
        errors.push({ paragraphs:bodyIndicesFor(part,blockedIndices), primaryRanges:primaryRangesFor(part), reasonCode: 'split_child_blocked', message: String(r.error?.message || r.error) });
        blocked.push(...blockedIndices);
      } else {
        return { ...r, splitAttempted:true, incompleteErrors: [...errors, ...(r.incompleteErrors || [])],
          observedBlockedParagraphs: [...new Set([...blocked, ...(r.blocked || []), ...(r.observedBlockedParagraphs || [])])] };
      }
    }
    if (splitOk) {
      return { text: collected.map(r => r.text).join('\n'), usage: usageTotal, model, ok: true, split: true,
        issueBatches: collected.flatMap(r => modelIssueBatchesFor(r) || [{ issues: null, sourceContext: r.sourceContext }]),
        incompleteErrors: errors, blocked: [...new Set(blocked)] };
    }
    return { ok: false, splitAttempted:true, error: lastErr, sensitive: true, blocked: win.map((p) => p.index) };
  }
  if (best?.truncated) {
    return {
      ok: false,
      sensitive: false,
      truncated: true,
      error: new Error(`模型输出被截断（推理用满 ${best.usage?.output_tokens} tokens），精简重试后仍无法解析`),
    };
  }
  return { ok: false, error: lastErr, sensitive: true, blocked: win.map((p) => p.index) };
}

/**
 * 对一篇稿件做模型深度审阅。
 * @param {object} doc
 * @param {object} opts
 */
export async function modelReview(doc, opts = {}) {
 const modelResolution=resolveArkModel(opts.model||DEFAULT_MODEL);
 const current=getPlanScope(),originalPackageSha=doc.sourcePackageSha256||['paragraphs','footnotes','endnotes'].flatMap(key=>doc[key]||[]).find(p=>p.sourcePackageSha256)?.sourcePackageSha256;
 const sourceSha=originalPackageSha||planHash(JSON.stringify(['paragraphs','footnotes','endnotes'].map(key=>(doc[key]||[]).map(p=>({text:p.text||'',noteId:p.noteId||null})))));
 const binding=current?.binding||{versionId:doc.sourceVersionId||'local:'+sourceSha,sourceSha256:sourceSha,workSha256:sourceSha,mutationEpoch:0};
 if(!originalPackageSha&&(binding.workSha256!==sourceSha||current?.resumedFromRunId))throw Object.assign(new Error('派生解析文本的来源身份不同或不支持跨运行复用'),{code:'REVIEW_PLAN_RESUME_CONFLICT'});
 const scope={...(current||localPlanScope({purpose:opts.purpose||'unknown'})),endpointIdentity:arkEndpointIdentity(),binding,
   ...(MODEL_ENDPOINTS?{modelResolution}:{}),
   ...(!originalPackageSha?{syntheticSource:true,transientSource:true,resumable:false,sourceBindingBasis:'derived-parsed-source'}:{})};
 return withPlanScope(scope,()=>modelReviewCore({...doc,sourcePackageSha256:originalPackageSha||sourceSha,sourceVersionId:scope.binding.versionId},opts));
}
async function modelReviewCore(doc, opts = {}) {
  const {
    model = DEFAULT_MODEL,
    windowChars = 1500,
    maxParasPerWindow = 10,
    onProgress = () => {},
    signal,
    focus = [],
    docMeta = {},
    /**
     * 并发窗口数。**默认 10**（原为 3）。
     *
     * 原注释写的是「并发 4 会频繁触发 429（实测 11 个窗口里 2 个被限流），
     * 降到 3 更稳，总耗时几乎没有差别，因为重试等待的时间远大于并发收益」。
     * 这个结论在**当时的限流策略**下成立，但现在已经不成立了 ——
     * 用 `tools/speed-bench.mjs` 在同一份稿件（test.docx，10 个窗口）
     * 上重测，结果是单调变快、且**零失败窗口**：
     *
     *     并发  3 → 269.6s
     *     并发  6 → 193.4s
     *     并发 10 → 101.9s   ← 拐点，比并发 3 快 2.65×
     *     并发 14 → 107.2s   ← 开始回升，说明 10 附近已到平台
     *
     * 为什么快这么多：审阅是**纯 I/O 等待**（每个窗口一次请求，模型侧
     * 生成要几十秒），并发 3 时 CPU/网络都在空转。请求总数不变，
     * 所以提速完全来自把等待时间叠起来，不增加任何模型成本。
     *
     * 并发 14 反而变慢，是模型侧开始排队/限流的信号，所以**不取更高**。
     */
    concurrency = 10,
    windowTimeoutMs = 300000,
    queueTimeoutMs = defaultQueueTimeoutMs(),
    /**
     * 提示词式规则的匹配方式（目标点 12）。
     *   'all'      一个窗口一次请求，提示词里列出全部提示词式规则（默认，请求数 = 窗口数）
     *   'per-rule' 一个窗口 × 一条规则一次请求（请求数 = 窗口数 × 规则数），判断更聚焦
     *
     * **实测结论：默认必须是 'all'，'per-rule' 不是升级。**
     * 同一份 12 段内容各跑一次：
     *   all       64.1s，发现 4 条（3 条挂到提示词式规则），output_tokens 22 052
     *   per-rule  87.8s，发现 2 条（2 条挂到提示词式规则），output_tokens 33 880
     * 即 per-rule 在 **1.54 倍输出 token、1.37 倍耗时**下**少发现一半**问题。
     * 原因推测：单条规则的聚焦提示让模型变保守，只报「铁证如山」的那几条，
     * 而 all 模式下模型在通读中会顺带发现跨规则的关联问题。
     * 所以 per-rule 作为**可选能力**保留（规则管理页可显式选用），
     * 不作为默认路径 —— 这一点是量出来的，不是猜的。
     */
    ruleMode = 'all',
    /**
     * per-rule 模式的硬上限（防止请求量失控）。
     * 任务数 = 窗口数 × 规则数，长稿 40 窗口 × 9 规则 = 360 次调用，
     * 按实测 4.3s/任务、并发 3 计算约需 8.6 分钟，必须先截断。
     * 截断时按「窗口优先」保留前 N 个任务，并在 errors 里记一条说明，
     * 让调用方知道结果不完整，而不是静默少报。
     */
    perRuleMaxTasks = 120,
    /**
     * 全局上下文（本轮新增，默认开，`ARK_CONTEXT=0` 或调用方传 false 可关）：
     *   · 全文纲要：先通读一遍产出导读，作为所有窗口共享的稳定前缀
     *     （**+1 次模型调用/篇**，换来跨段问题的判断能力）；
     *   · 滑窗邻段：每个窗口带上前后邻段（明确标注「勿在此报问题」），治断章取义。
     * 只改「喂什么给模型」，不改判定逻辑；纲要失败会自动跳过、不拖垮分段审阅。
     */
    useContext = process.env.ARK_CONTEXT !== '0',
    /**
     * 历史批注案例库（RAG，默认开，`ARK_CASES=0` 或传 false 关闭）：
     * 每个窗口从 8687 条真人编辑批注里检索「相似段落 + 编辑当时写下的意见」，
     * 作为【本刊历史批注参考】附进提示词，让模型按本刊的实际尺度判断。
     * 只加材料、不改判定；索引缺失时自动跳过。
     */
    useCases = process.env.ARK_CASES !== '0',
  } = opts;

  const sourcePlan=buildReviewSourcePlan(doc,{windowChars,maxParasPerWindow});
  const windows=sourcePlan.windows.map(w=>w.entries);
  // 提示词式规则注入：让模型「读规则、逐条匹配」并回填真实规则号。
  // 调用方若已传入 modelRules 就用传入的，否则自行从规则库取，
  // 这样 /api/review 与命令行批处理两条路径都能拿到规则，不必各自接线。
  const rulesForPrompt = docMeta.modelRules?.length ? docMeta.modelRules : promptStyleRules();
  const metaWithRules = { ...docMeta, modelRules: rulesForPrompt };
  /**
   * 本次真正交给模型的规则号集合。`buildModelIssue` 用它拦截**越界引用**：
   * 模型偶尔会报出规则库里真实存在、但本次并没交给它的规则号
   * （实测 `LANG-017`/`LANG-018`/`LANG-020`/`LANG-015`/`FMT-024` 都被这样引用过）。
   * 这些号的 status 是 `auto`，规则引擎本身没报过 —— 若直接采纳，
   * 规则管理页会把「模型凭印象引用的规则」显示成「这条规则真的命中了」。
   */
  const allowedRuleIds = new Set(rulesForPrompt.map((r) => r.id));
  onProgress({
    phase: 'model-prepare',
    message: `注入提示词式规则 ${rulesForPrompt.length} 条（${rulesForPrompt.map((r) => r.id).join('、')}）`,
  });
  // Metadata labels preserve part/raw paragraph index/noteId. Reader numbering
  // is a separate display value, including multi-paragraph notes.
  // Notes are now their own lossless primary units. Legacy note-prefix support
  // remains in the public prompt helper, but is not this run's review coverage.
  const noteSourceEntries = [];
  const footnoteText = [];
  const allIssues = [];
  const usageTotal = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
  const errors = [];
  const blockedParagraphs = [];
  // Newly observed omissions are metadata only: retain the existing issue and usage output.
  const observedBlockedParagraphs = [];
  const textGaps = [...sourcePlan.unreviewedContent];
  const executionScope = {
    schemaVersion: 1, status: 'completed',
    syntheticSource:getPlanScope()?.syntheticSource===true,sourceBindingBasis:getPlanScope()?.sourceBindingBasis||'declared-package-source',resumable:getPlanScope()?.resumable!==false,
    context: { requested: !!useContext, status: useContext ? 'unknown' : 'disabled', reason: useContext ? 'not_observed' : 'not_requested' },
    cases: { requested: !!useCases, enabled: false, status: 'disabled', reason: 'not_requested', count: 0 },
    consistency: { configured: false, requested: false, status: 'disabled', reason: 'not_requested' },
    incompleteReasons: [], fullTextCoverage: textGaps.length ? 'partial' : 'unverified', sourceCoverageGaps: textGaps,
  };
  const modelsUsed = new Set();
  let done = 0;
  let casesUsed = 0;

  // Freeze this run's actual case selection. A peer reloading the global index
  // cannot change prompts after the source plan has been registered.
  const caseExclude = docMeta.sourcePath ? new Set([String(docMeta.sourcePath).replace(/\//g, '\\')]) : null;
  const casesConfigured = useCases && casesEnabled();
  const fixedCaseIndex = casesConfigured ? loadCaseIndex() : null;
  const fixedRetriever = fixedCaseIndex ? makePlanRetriever(fixedCaseIndex) : null;
  const fixedCases = windows.map(win => fixedRetriever ? fixedRetriever(win.map(p => p.text).join('\n'), {k:DEFAULT_CASE_K,excludeFiles:caseExclude}) : []);
  let caseIndexFileSha256 = null;
  if(casesConfigured)try{caseIndexFileSha256=planHash(await readPlanFile(PLAN_CASE_INDEX_PATH));}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
  const definitions = ruleMode === 'per-rule' && rulesForPrompt.length
    ? windows.flatMap((win,w)=>rulesForPrompt.map(rule=>({unitId:`window:${w+1}/rule:${rule.id}`,stage:'window-rule',source:{window:w+1,ruleId:rule.id,primaryRanges:sourcePlan.windows[w].primaryRanges}})))
    : windows.map((win,w)=>({unitId:`window:${w+1}`,stage:'window',source:{window:w+1,ruleId:null,primaryRanges:sourcePlan.windows[w].primaryRanges}}));
  if(useContext)definitions.unshift({unitId:'digest',stage:'digest'});
  if(useContext&&consistencyEnabled())definitions.push({unitId:'consistency',stage:'consistency',conditional:true});
  const prepared = await prepareReviewPlan({scope:getPlanScope(),plan:{kind:'model-review',
    config:{model,windowChars,maxParasPerWindow,windowTimeoutMs,responseTimeoutMs:windowTimeoutMs,queueTimeoutMs,timeoutBasis:'physical-sending-to-body-eof',ruleMode,perRuleMaxTasks,useContext,useCases,focus,docMeta:metaWithRules,
      syntheticSource:getPlanScope()?.syntheticSource===true,sourceBindingBasis:getPlanScope()?.sourceBindingBasis||'declared-package-source',resumable:getPlanScope()?.resumable!==false,
      prefixCache:prefixCacheEnabled(),consistency:consistencyEnabled(),casesConfigured,caseIndexFileSha256,
      caseIndexLoadedSha256:fixedCaseIndex?reviewPlanFingerprint(fixedCaseIndex):null,
      casesByWindow:fixedCases,modelChain:reviewModelChain(model),budgets:MODEL_MAX_OUTPUT,
      ...(MODEL_ENDPOINTS?{modelResolution:resolveArkModel(model)}:{})},
    windows,primarySourcePlan:sourcePlan,sourceCoverageGaps:textGaps,units:definitions}});
  return withPlanScope({...getPlanScope(),planId:prepared.planId,planFingerprint:prepared.planFingerprint},async()=>{
  let dispatchStop=null;
  const stopDispatch=error=>{const facts=safetyFacts(error);if(facts.stop&&(!dispatchStop||facts.unknown&&!safetyFacts(dispatchStop).unknown))dispatchStop=error;};

  /**
   * 全文纲要：整篇只做一次，作为所有窗口的共享前缀。
   * 失败（超时/解析失败/被限流）只记一条 progress，不写进 errors 拖垮审阅 ——
   * 拿不到纲要就退回"没有全局视野"的老行为，分段审阅照常进行。
   */
  let digestText = '';
  if (useContext) {
    try {
      onProgress({ phase: 'digest', message: '通读全文，生成全局纲要…' });
      const dg = await buildDocDigest(doc, { model, signal, docMeta,responseTimeoutMs:windowTimeoutMs,queueTimeoutMs,onSafetyStop:stopDispatch });
      stopDispatch(dg);
      if (dg.ok) {
        digestText = dg.text;
        executionScope.context = { requested: true, status: 'completed', reason: 'digest_returned' };
        if (dg.usage) {
          usageTotal.input_tokens += dg.usage.input_tokens || 0;
          usageTotal.output_tokens += dg.usage.output_tokens || 0;
        }
        onProgress({ phase: 'digest-done', message: '全局纲要已生成，将作为所有段落的共享上下文' });
      } else {
        executionScope.context = { requested: true, status: 'failed', reason: dg.error ? String(dg.error.message || dg.error) : 'digest_not_parseable' };
        onProgress({ phase: 'digest-skip', message: dispatchStop?'全局纲要请求未确认或排队受阻，停止分配后续任务，请核对请求记录':'全局纲要生成失败，本次按无纲要继续' });
      }
    } catch (err) {
      stopDispatch(err);
      if (signal?.aborted) throw safetyFacts(err).unknown?err:abortReason(signal);
      executionScope.context = { requested: true, status: 'failed', reason: String(err?.message || err) };
      onProgress({ phase: 'digest-skip', message: dispatchStop?'全局纲要请求未确认或排队受阻，停止分配后续任务，请核对请求记录':`全局纲要生成出错，按无纲要继续：${String(err?.message || err).slice(0, 40)}` });
    }
  }

  /** 取窗口的前后邻段（各最多 2 段、限长），仅供衔接参考 */
  const NEIGHBOR_PARAS = 2;
  const NEIGHBOR_CHARS = 400;
  const headOf = (win) => win.slice(0, NEIGHBOR_PARAS).map(p=>sourceSnippet(p,NEIGHBOR_CHARS));
  const tailOf = (win) => win.slice(-NEIGHBOR_PARAS).map(p=>sourceSnippet(p,NEIGHBOR_CHARS,true));

  /**
   * 历史批注案例库（RAG）：整篇只加载一次，逐窗口检索。
   * 索引缺失 / 关闭时 casesReady=false，行为退回「无案例参考」，不影响审阅。
   */
  const casesReady = !!fixedCaseIndex;
  executionScope.cases.enabled = !!casesConfigured;
  if (useCases && !casesConfigured) executionScope.cases.reason = 'configuration_disabled';
  if (casesConfigured) {
    const idx = fixedCaseIndex;
    if (idx) {
      executionScope.cases.status = 'completed';
      executionScope.cases.reason = 'index_ready';
      onProgress({ phase: 'cases', message: `历史批注案例库就绪：${idx.count} 条真人编辑批注（覆盖 ${idx.files.length} 篇），每窗检索 ${DEFAULT_CASE_K} 条参考` });
    } else {
      executionScope.cases.status = 'unavailable';
      executionScope.cases.reason = casesMissingReason() || 'case_index_unavailable';
      onProgress({ phase: 'cases-skip', message: casesMissingReason() || '历史批注案例库不可用，本次按无案例参考继续' });
    }
  }

  /** 处理单个窗口，返回该窗口的模型问题 */
  const executeWindow = async (w,notify) => {
    const win = windows[w];
    // 用户点「中止」后立刻停掉剩余窗口，不再发起新的请求
    if (signal?.aborted) throw abortReason(signal);
    // 该窗口的历史批注案例（相似段落上编辑当时的意见），供模型体会本刊尺度
    const caseList = fixedCases[w];
    if (caseList.length) casesUsed += caseList.length;
    // Queuing does not consume the response budget. The physical transport
    // starts its response deadline only after acquiring a sending slot.
    let r;
    try {
      r = await reviewWindow({
        win, doc, docMeta: metaWithRules, model, focus, signal, footnoteText, noteSourceEntries, window: w + 1,
        responseTimeoutMs:windowTimeoutMs,queueTimeoutMs,onSafetyStop:stopDispatch,
        docDigest: digestText,
        prevTail: w > 0 ? tailOf(windows[w - 1]) : [],
        nextHead: w < windows.length - 1 ? headOf(windows[w + 1]) : [],
        cases: caseList,
      });
    } catch (err) {
      stopDispatch(err);
      r = { ok: false, error: err, sensitive: false };
    }
    stopDispatch(r);
    // 中止不是「审阅失败」，必须向上抛出，否则会被记成一条普通错误继续跑下一个窗口
    if (signal?.aborted) throw safetyFacts(r).unknown?r.error:abortReason(signal);
    done += 1;
    if (r.usage) {
      usageTotal.input_tokens += r.usage.input_tokens || 0;
      usageTotal.output_tokens += r.usage.output_tokens || 0;
      usageTotal.cached_tokens += cachedTokensOf(r.usage);
    }
    if (r.model) modelsUsed.add(r.model);
    if (r.incompleteErrors?.length) {
      errors.push(...r.incompleteErrors.map((error) => ({ ...error, window: w + 1 })));
      observedBlockedParagraphs.push(...bodyIndicesFor(win,[...(r.ok ? r.blocked || [] : []), ...(r.observedBlockedParagraphs || [])]));
    }
    if ((r.split || r.compactRetry) && noteSourceEntries.length) {
      textGaps.push({ window: w + 1, targets: ['footnote', 'endnote'],
        reason: r.split ? 'notes_omitted_from_split_requests' : 'notes_omitted_from_compact_retry' });
    }
    if (!r.ok) {
      const msg = String(r.error?.message || r.error);
      errors.push({ window: w + 1, paragraphs: bodyIndicesFor(win,r.blocked || win.map((p) => p.index)), primaryRanges:primaryRangesFor(win), message: msg });
      if (r.blocked) {
        blockedParagraphs.push(...bodyIndicesFor(win,r.blocked));
        notify({ phase: 'model', current: done, total: windows.length, message: `第 ${w + 1} 段未通过平台内容审核，已标记为需人工审阅` });
      } else {
        notify({ phase: 'model', current: done, total: windows.length, message: `第 ${w + 1} 段审阅失败（${msg.slice(0, 40)}），已记录` });
      }
      return [];
    }
    const parsed = modelIssueBatchesFor(r);
    if (!parsed && !r.compactRetry) {
      // 返回内容不是合法 JSON：用精简模式再试一次，仍失败才记为错误
      notify({ phase: 'model', current: done, total: windows.length, message: `第 ${w + 1} 段返回内容无法解析，改用精简模式重试` });
      const r2 = await reviewWindow({
        win, doc, docMeta: metaWithRules, model, focus, signal, footnoteText, noteSourceEntries, window: w + 1, compact: true,
        responseTimeoutMs:windowTimeoutMs,queueTimeoutMs,onSafetyStop:stopDispatch,
        docDigest: digestText,
        prevTail: w > 0 ? tailOf(windows[w - 1]) : [],
        nextHead: w < windows.length - 1 ? headOf(windows[w + 1]) : [],
      });
      stopDispatch(r2);
      if (r2.usage) {
        usageTotal.input_tokens += r2.usage.input_tokens || 0;
        usageTotal.output_tokens += r2.usage.output_tokens || 0;
        usageTotal.cached_tokens += cachedTokensOf(r2.usage);
      }
      if (r2.incompleteErrors?.length) {
        errors.push(...r2.incompleteErrors.map((error) => ({ ...error, window: w + 1 })));
        observedBlockedParagraphs.push(...bodyIndicesFor(win,[...(r2.ok ? r2.blocked || [] : []), ...(r2.observedBlockedParagraphs || [])]));
      }
      if (r2.ok && noteSourceEntries.length) {
        textGaps.push({ window: w + 1, targets: ['footnote', 'endnote'], reason: 'notes_omitted_from_compact_retry' });
      }
      const p2 = r2.ok ? modelIssueBatchesFor(r2) : null;
      if (p2) {
        const out2 = [];
        for (const batch of p2) for (const it of batch.issues) out2.push(buildModelIssue(it, doc, w, allowedRuleIds, batch.sourceContext));
        notify({ phase: 'model', current: done, total: windows.length, message: `第 ${w + 1} 段精简重试成功，发现 ${out2.length} 条` });
        return out2;
      }
    }
    if (!parsed) {
      // 解析失败必须显式记录，不能静默产出 0 条
      errors.push({ window: w + 1, paragraphs: bodyIndicesFor(win), primaryRanges:primaryRangesFor(win), message: `模型返回内容无法解析为 JSON（长度 ${r.text.length}）：${r.text.slice(0, 120)}` });
      notify({ phase: 'model', current: done, total: windows.length, message: `第 ${w + 1} 段返回内容无法解析，已记录` });
      return [];
    }
    const out = [];
    for (const batch of parsed) for (const it of batch.issues) out.push(buildModelIssue(it, doc, w, allowedRuleIds, batch.sourceContext));
    notify({
      phase: 'model', current: done, total: windows.length,
      message: `第 ${w + 1} 段审阅完成，发现 ${out.length} 条`,
    });
    return out;
  };

  const handleWindow = async(w)=>{
    const scope=getPlanScope(),unitId=`window:${w+1}`,events=[];
    const prompt=buildWindowPrompt({doc,noteSourceEntries,window:w+1,docMeta:metaWithRules,footnoteText,win:windows[w],modelRules:rulesForPrompt,focus,
      docDigest:digestText,prevTail:w>0?tailOf(windows[w-1]):[],nextHead:w<windows.length-1?headOf(windows[w+1]):[],cases:fixedCases[w]});
    const outcome=await runReviewUnit({scope,unitId,stage:'window',input:{prompt:prompt.input,sourceContext:prompt.sourceContext,model,windowTimeoutMs,responseTimeoutMs:windowTimeoutMs,queueTimeoutMs,prefixCache:prefixCacheEnabled(),budgets:MODEL_MAX_OUTPUT},
      execute:async()=>{
        const issues=await executeWindow(w,event=>events.push(event));
        const coverage=await readReviewPlanCoverage({scope});
        const childUnits=coverage.units.filter(u=>u.unitId.startsWith(unitId+'/'));
        return{issues,events,errors:errors.filter(e=>e.window===w+1),blocked:bodyIndicesFor(windows[w],blockedParagraphs),
          gaps:textGaps.filter(g=>g.window===w+1),modelsUsed:[...modelsUsed],unknownSent:childUnits.some(u=>u.status==='unknown_sent')};
      },validate:output=>({status:output.unknownSent?'unknown_sent':output.errors.length?(output.issues.length?'partial':output.blocked.length?'blocked':'failed'):'completed',output})});
    if(outcome.checkpointReceipt.reused){done++;errors.push(...outcome.errors);blockedParagraphs.push(...outcome.blocked);textGaps.push(...outcome.gaps);for(const m of outcome.modelsUsed)modelsUsed.add(m);}
    for(const event of outcome.events)onProgress({...event,current:done,total:windows.length,reused:outcome.checkpointReceipt.reused});
    return outcome.issues;
  };

  // 受控并发：窗口之间互不依赖，串行会非常慢
  let next = 0;
  let emitted = 0;
  const worker = async () => {
    while (next < windows.length) {
      if (signal?.aborted||dispatchStop) break;
      const w = next;
      next += 1;
      const got = await handleWindow(w);
      allIssues.push(...got);
      // 每完成一个窗口就把该窗口的问题回吐出去，供流式批注即时显示
      if (got.length && typeof opts.onIssues === 'function') {
        emitted += got.length;
        try {
          opts.onIssues(got, { window: w + 1, windows: windows.length, emitted });
        } catch { /* 回调异常不能影响审阅本身 */ }
      }
    }
  };

  /**
   * 窗口阶段的心跳间隔与时长预估。
   *
   * 为什么需要：窗口请求每个要几十秒到两分钟，而「第 N 段完成」这类进度只有在
   * **窗口真的返回后**才会出现。实测一份 119 段的稿件（10 个窗口、并发 2）在
   * 开工后近 50 秒内界面只有秒表在走，用户会判断成「卡死」而去点中止；而中止会
   * 打断已发出的在途请求，那些请求会一直占用模型名额，直到人工核对后释放。
   * 所以开工时必须先讲清规模与预计时长，并持续心跳，让等待是「可见的」。
   */
  const heartbeatMs = Math.max(5000, Number(process.env.ARK_PROGRESS_HEARTBEAT_MS) || 20000);
  const estimateMinutes = (count, concurrent) => {
    const rounds = Math.max(1, Math.ceil(count / Math.max(1, concurrent)));
    return `${Math.max(1, Math.ceil(rounds * 0.5))}–${Math.max(2, Math.ceil(rounds * 2))} 分钟`;
  };
  /**
   * 实际生效的在途窗口数 = min(窗口并发, 账户请求池并发)。
   * 只报窗口并发会说谎：账户池只有 1 个名额时，10 个窗口仍然是一个一个发。
   * 池并发读的是本次运行真正用的那个池（与发起请求时同源），读不到就不报数字。
   */
  const readPoolLimit = async () => {
    try {
      const scopeNow = getPlanScope();
      const summary = await readArkExecutionSummary({ storageRoot: scopeNow?.executionRoot, poolId: scopeNow?.poolId });
      const value = summary?.policy?.concurrency;
      return Number.isInteger(value) && value >= 1 ? value : null;
    } catch { return null; }
  };
  if (ruleMode === 'per-rule' && rulesForPrompt.length) {
    // ---- 并发逐条匹配：每个「窗口 × 规则」一个任务，各自输出 JSON 再合并 ----
    const tasks = [];
    for (let w = 0; w < windows.length; w += 1) {
      for (const rule of rulesForPrompt) tasks.push({ w, rule });
    }
    const totalTasks = tasks.length;
    let truncatedTasks = false;
    if (tasks.length > perRuleMaxTasks) {
      tasks.length = perRuleMaxTasks;
      truncatedTasks = true;
    }
    onProgress({
      phase: 'model-prepare',
      message: `逐条匹配模式：${windows.length} 段 × ${rulesForPrompt.length} 条规则 = ${totalTasks} 个任务`
        + `，实际执行 ${tasks.length} 个（上限 ${perRuleMaxTasks}），并发 ${concurrency}`,
    });
    if (truncatedTasks) {
      // 必须显式记下来：截断意味着结果不完整，不能让调用方以为已全量覆盖
      errors.push({
        window: 0,
        rule: '-',
        message: `逐条匹配任务数 ${totalTasks} 超过上限 ${perRuleMaxTasks}，仅执行前 ${perRuleMaxTasks} 个，其余未覆盖`,
      });
    }
    let tNext = 0;
    let tDone = 0;
    const ruleWorker = async () => {
      while (tNext < tasks.length) {
        if (signal?.aborted||dispatchStop) break;
        const job = tasks[tNext];
        tNext += 1;
        const win = windows[job.w];
        try {
          const scope=getPlanScope(),unitId=`window:${job.w+1}/rule:${job.rule.id}`;
          const r = await runReviewUnit({scope,unitId,stage:'window-rule',input:{win,docMeta:metaWithRules,rule:job.rule,model,responseTimeoutMs:windowTimeoutMs,queueTimeoutMs,
            noteText:footnoteText.join('\n').slice(0,4000),noteSourceEntries,instructions:RULE_MATCH_INSTRUCTIONS,budgets:MODEL_MAX_OUTPUT},
            execute:()=>matchOneRule({win,doc,docMeta:metaWithRules,rule:job.rule,model,signal,footnoteText,noteSourceEntries,window:job.w+1,depth:0,responseTimeoutMs:windowTimeoutMs,queueTimeoutMs,onSafetyStop:stopDispatch}),
            validate:reply=>({status:checkpointStatus(reply),output:{...reply,normalizedIssues:reply.ok?(reply.issues||[]).map(it=>buildModelIssue({...it,ruleId:job.rule.id},doc,job.w,allowedRuleIds,reply.sourceContext)):[]}})});
          stopDispatch(r);
          if(r.checkpointReceipt.reused&&r.usage){r.historicalUsage=r.usage;r.usage={input_tokens:0,output_tokens:0,cached_tokens:0};}
          if (r.ok) {
            for (const it of r.normalizedIssues) {
              // 强制使用本次任务的规则号：模型有时会自作主张填别的号，
              // 那会让「按规则统计」失真 —— 这一路本来就是在查这条规则。
              allIssues.push(it);
            }
            // 逐条模式每个任务都是一次独立调用，token 必须逐个累加，
            // 否则整个 per-rule 路径的 usage 恒为 0（第一版就漏了这一步）。
            if (r.usage) {
              usageTotal.input_tokens += r.usage.input_tokens || 0;
              usageTotal.output_tokens += r.usage.output_tokens || 0;
            }
            if (r.model) modelsUsed.add(r.model);
          } else if (r.sensitive) {
            blockedParagraphs.push(...bodyIndicesFor(win));
            errors.push({ window: job.w + 1, rule: job.rule.id, paragraphs: bodyIndicesFor(win), primaryRanges:primaryRangesFor(win),
              message: `逐条匹配失败：${String(r.error?.message || r.error).slice(0, 200)}` });
          } else if (r.error) {
            if (r.error.sensitive) observedBlockedParagraphs.push(...bodyIndicesFor(win));
            errors.push({ window: job.w + 1, rule: job.rule.id, primaryRanges:primaryRangesFor(win), message: `逐条匹配失败：${String(r.error.message || r.error).slice(0, 200)}` });
          }
        } catch (err) {
          stopDispatch(err);
          if (signal?.aborted) throw err;
          errors.push({ window: job.w + 1, rule: job.rule.id, primaryRanges:primaryRangesFor(win), message: String(err?.message || err).slice(0, 200) });
        } finally {
          tDone += 1;
          if (tDone % 3 === 0 || tDone === tasks.length) {
            onProgress({
              phase: 'model', current: tDone, total: tasks.length,
              message: `逐条匹配 ${tDone}/${tasks.length}（已完成 ${tDone} 个「段落×规则」任务）`,
            });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, ruleWorker));
  } else {
    const poolLimit = await readPoolLimit();
    const maxInflight = Math.max(1, Math.min(concurrency, windows.length));
    const inflight = Math.max(1, poolLimit ? Math.min(maxInflight, poolLimit) : maxInflight);
    const startedAt = Date.now();
    onProgress({
      phase: 'model-start', current: 0, total: windows.length,
      // 池上限读不到时（例如账户池记录尚未建立）不能把窗口并发说成实际并发
      message: `分段审阅开始：共 ${windows.length} 个窗口，`
        + (poolLimit
          ? `同时最多 ${inflight} 个在途${poolLimit < maxInflight ? `（受本项目请求池并发上限 ${poolLimit} 限制）` : ''}`
          : `按窗口设置最多 ${inflight} 个在途（实际并行数还受本项目请求池上限约束）`)
        + `；每个窗口约 30 秒–2 分钟，预计需要 ${estimateMinutes(windows.length, inflight)}。`
        + '期间可以离开页面（服务器会继续跑），不必中止；中止会打断已发出的请求并占用模型名额。',
    });
    // 心跳只在窗口阶段存活，结束/中止/抛错都必须清掉，不能盖掉终态提示
    const heartbeat = setInterval(() => {
      const minutes = ((Date.now() - startedAt) / 60000).toFixed(1);
      onProgress({
        phase: 'model-progress', current: done, total: windows.length,
        message: `模型审阅进行中：已完成 ${done}/${windows.length} 个窗口，在途 ${inflight} 个，已用 ${minutes} 分钟`,
      });
    }, heartbeatMs);
    try {
      await Promise.all(Array.from({ length: inflight }, worker));
    } finally {
      clearInterval(heartbeat);
    }
  }
  // 中止后不再拼装结果，直接抛出，由上层标记为「已中止」
  if (signal?.aborted) throw safetyFacts(dispatchStop).unknown?dispatchStop:abortReason(signal);
  if(dispatchStop){executionScope.dispatchStopped={code:dispatchStop.code||dispatchStop.error?.code||null,unknownSent:safetyFacts(dispatchStop).unknown,reason:'physical_request_safety_fence',newTaskAllocationStopped:true};executionScope.incompleteReasons.push('model_dispatch_stopped');errors.push({window:0,reasonCode:'model_dispatch_stopped',message:'请求发送未确认或账户池/排队受阻，已停止新任务分配；完整未完成任务仍在计划中，须核对请求记录。'});}

  /**
   * 第三轮：全篇一致性终检。在拿到全部段落级问题之后再做，整篇只调一次。
   * **默认关**（见 `consistencyEnabled()`：每篇约 +50 秒、产出个位数条，性价比未验证）。
   * `ARK_CONSISTENCY=1` 打开；关掉时不影响「全文纲要 + 邻段」这两种全局上下文。
   * 失败 / 跳过都只记 progress，不影响已完成的段落级结果。
   */
  let globalIssues = 0;
  const consistencyConfigured = consistencyEnabled();
  executionScope.consistency = { configured: consistencyConfigured, requested: !!useContext && consistencyConfigured,
    status: 'disabled', reason: !consistencyConfigured ? 'configuration_disabled' : !useContext ? 'context_not_requested'
      : !digestText ? 'digest_unavailable' : !allIssues.length ? 'no_issues_to_check' : 'not_observed' };
  if (executionScope.consistency.requested && (!digestText || !allIssues.length)) executionScope.consistency.status = 'unavailable';
  if(dispatchStop&&executionScope.consistency.requested){executionScope.consistency.status='unavailable';executionScope.consistency.reason='dispatch_safety_fence';}
  if (!dispatchStop&&useContext && consistencyConfigured && digestText && allIssues.length) {
    try {
      onProgress({ phase: 'consistency', message: '做全篇一致性终检（跨段矛盾 / 术语 / 指代 / 结构）…' });
      const cr = await consistencyReview({
        doc, docMeta: metaWithRules, model, signal, docDigest: digestText,
        issues: allIssues, allowedRuleIds, focus,
        responseTimeoutMs:windowTimeoutMs,queueTimeoutMs,onSafetyStop:stopDispatch,
      });
      if (cr.usage) {
        usageTotal.input_tokens += cr.usage.input_tokens || 0;
        usageTotal.output_tokens += cr.usage.output_tokens || 0;
        usageTotal.cached_tokens += cachedTokensOf(cr.usage);
      }
      if (cr.ok && cr.issues.length) {
        executionScope.consistency.status = 'completed';
        executionScope.consistency.reason = 'result_returned';
        allIssues.push(...cr.issues);
        globalIssues = cr.issues.length;
        if (typeof opts.onIssues === 'function') {
          try { opts.onIssues(cr.issues, { window: 0, windows: windows.length, emitted: allIssues.length, global: true }); } catch { /* 回调异常不影响审阅 */ }
        }
        onProgress({ phase: 'consistency-done', message: `全篇一致性终检完成，补充 ${globalIssues} 条跨段问题` });
      } else if (cr.ok) {
        executionScope.consistency.status = 'completed';
        executionScope.consistency.reason = 'result_returned';
        onProgress({ phase: 'consistency-done', message: '全篇一致性终检完成，未发现跨段问题' });
      } else {
        const why = cr.parseFailed
          ? (cr.truncated ? '返回被输出上限截断' : '返回无法解析为 JSON')
          : (cr.error ? String(cr.error.message || cr.error).slice(0, 40) : '未产出');
        executionScope.consistency.status = 'failed';
        executionScope.consistency.reason = cr.parseFailed ? (cr.truncated ? 'output_truncated' : 'output_not_parseable')
          : cr.error ? String(cr.error.message || cr.error) : 'no_result_returned';
        onProgress({ phase: 'consistency-skip', message: `全篇一致性终检未能完成（${why}），按无此轮继续` });
      }
    } catch (err) {
      if (signal?.aborted) throw safetyFacts(err).unknown?err:abortReason(signal);
      executionScope.consistency.status = 'failed';
      executionScope.consistency.reason = String(err?.message || err);
      onProgress({ phase: 'consistency-skip', message: `全篇一致性终检出错，按无此轮继续：${String(err?.message || err).slice(0, 40)}` });
    }
  }

  // 被内容审核拦截的段落单独列出，提示人工复核
  if (blockedParagraphs.length) {
    const uniq = [...new Set(blockedParagraphs)].sort((a, b) => a - b);
    allIssues.push({
      ruleId: 'ARK-MANUAL',
      category: '需人工审阅',
      group: 'model',
      severity: '高',
      title: '平台内容审核拦截，该部分未完成模型审阅',
      detail: `以下段落在调用火山方舟时被平台输入内容审核拦截，模型未能审阅：段落 ${uniq.slice(0, 40).join('、')}${uniq.length > 40 ? ' 等' : ''}。这类段落通常涉及政治表述、领导人讲话或敏感历史事件，本刊作为政论性刊物出现概率较高，须由责任编辑人工重点审阅。`,
      fix: '请人工审阅这些段落的政治表述、引文出处与事实准确性；也可切换其他模型重试。',
      location: 'document',
      quote: '',
      basis: '火山方舟输入内容审核策略',
    });
  }

  /**
   * 越界引用的规则号，按「模型报了但本次没交给它」汇总。
   *
   * 汇总出来是为了让这个现象**可观测**：如果某条 `auto` 规则被模型反复引用，
   * 说明它的判据其实更适合交模型判断（应当改判为 model），
   * 或者说明模型的规则清单提示还不够清楚。
   */
  const outOfScopeRuleIds = new Set();
  for (const it of allIssues) {
    if (it.ruleOutOfScope && it.ruleReported) outOfScopeRuleIds.add(it.ruleReported);
  }

  executionScope.cases.count = casesUsed;
  if(dispatchStop&&!executionScope.dispatchStopped){executionScope.dispatchStopped={code:dispatchStop.code||dispatchStop.error?.code||null,unknownSent:safetyFacts(dispatchStop).unknown,reason:'physical_request_safety_fence',newTaskAllocationStopped:true};executionScope.incompleteReasons.push('model_dispatch_stopped');}
  const reviewPlan=await readReviewPlanCoverage({scope:getPlanScope()});
  const sourceCoverage=buildReviewSourceCoverage(sourcePlan,{units:(await verifyReviewPlanCheckpoints({scope:getPlanScope()})).units,ruleMode,ruleIds:rulesForPrompt.map(r=>r.id)});
  executionScope.sourceCoverage=sourceCoverage;
  textGaps.push(...sourceCoverage.sourceCoverageGaps);
  executionScope.fullTextCoverage=sourceCoverage.status==='complete'&&!textGaps.length?'complete':'partial';
  for (const stage of ['context', 'cases', 'consistency']) {
    if (executionScope[stage].requested && ['failed', 'unavailable', 'partial', 'unknown'].includes(executionScope[stage].status)) {
      executionScope.incompleteReasons.push(`${stage}_${executionScope[stage].status}`);
    }
  }
  if (errors.length || blockedParagraphs.length || observedBlockedParagraphs.length) executionScope.incompleteReasons.push('model_requests_incomplete');
  if (textGaps.length) {
    executionScope.fullTextCoverage = 'partial';
    executionScope.incompleteReasons.push('known_text_gaps');
  }
  if (executionScope.incompleteReasons.length) executionScope.status = 'partial';

  return {
    issues: dedupeModelIssues(allIssues),
    usage: usageTotal,
    errors,
    windows: windows.length,
    modelsUsed: [...modelsUsed],
    modelResolution:resolveArkModel(model),
    blockedParagraphs: [...new Set([...blockedParagraphs, ...observedBlockedParagraphs])].sort((a, b) => a - b),
    outOfScopeRuleIds: [...outOfScopeRuleIds].sort(),
    globalIssues,
    casesUsed,
    executionScope,
    reviewPlan,
  };
  });
}

/**
 * 把模型返回的一条问题整理成统一结构。
 *
 * 定位顺序：模型给的 paragraphIndex → 用 quote 反查正文段落 → 用 quote 反查脚注。
 * 脚注命中时记 footnoteIndex 与 footnote:N，否则所有脚注类问题
 * （篇名书名号、页码区间、译者、出版信息等）都会退化成「未定位」，
 * 界面上点不进去。实测一份稿件有 35 条受此影响。
 */
/**
 * 模型回填的 ruleId 必须是**本次真的交给它的那些规则**里的一个。
 *
 * ⚠️ 这里曾经只校验**格式**（`/^[A-Z]+B?-\d{3}$/`），不校验**归属**，
 * 于是模型可以「越界引用」：实测 8 篇分层样本里有 3 篇报出了
 * `LANG-017`（量词与名词搭配不当）、`LANG-018`（文言与白话混杂）、
 * `LANG-020`（同一论点重复）、`LANG-015`、`FMT-024` —— 这些在规则库里
 * **都真实存在**，但 `status` 是 `auto`（规则引擎检测），**根本不在**
 * 交给模型的那 20 条提示词式规则里。
 *
 * 后果很具体：规则管理页按规则号归并，于是这些 `auto` 规则会显示
 * 「模型判断命中 N 条」，而规则引擎本身一次都没报过 ——
 * 页面把「模型凭印象引用的规则」当成了「这条规则真的命中了」。
 * 这与 §2.26 修的「元信息漂移」、§2.27 修的「状态被覆盖」是同一类病：
 * **页面显示的能力必须等于实际能力**。
 *
 * 处理方式：越界引用按「模型没填规则号」处理（走 `ARK-分类名`），
 * 并汇总到返回值的 `outOfScopeRuleIds`，让这个现象**可观测**而不是被悄悄吞掉。
 *
 * @param {string} rawId 模型回填的规则号
 * @param {Set<string>|null} allowed 本次交给模型的规则号集合
 * @returns {{id: string|null, outOfScope: boolean}}
 */
export function resolveModelRuleId(rawId, allowed) {
  if (typeof rawId !== 'string') return { id: null, outOfScope: false };
  const id = rawId.trim();
  if (!/^[A-Z]+B?-\d{3}$/.test(id)) return { id: null, outOfScope: false };
  if (allowed && allowed.size && !allowed.has(id)) return { id: null, outOfScope: true };
  return { id, outOfScope: false };
}

export function buildModelIssue(it, doc, windowNo, allowedRuleIds = null, sourceContext = null) {
  return withIssueIdentity(buildModelIssueCore(it, doc, windowNo, allowedRuleIds, sourceContext));
}

function buildModelIssueCore(it, doc, windowNo, allowedRuleIds = null, sourceContext = null) {
  // ruleId 必须是**真实规则号**，前端「批阅视图」与「规则管理」都按它归并、跳转。
  // 早期实现写的是 `ARK-${it.category}` —— 那是个凭分类名现造的合成号，
  // 在规则库里根本不存在，于是模型报出的问题永远挂不到任何一条规则上，
  // 「规则管理」里那些 model 规则永远显示 0 命中。现在优先采用模型回填的真实规则号。
  const { id: realId, outOfScope } = resolveModelRuleId(it.ruleId, allowedRuleIds);
  const base = {
    ruleId: realId || `ARK-${it.category}`,
    ruleMatched: Boolean(realId),
    ruleOutOfScope: outOfScope,
    /**
     * 越界引用时，保留模型**实际报出的**规则号。
     *
     * 不能只留布尔标记：`ruleId` 已经被改写成 `ARK-分类名`，
     * 原始号就丢了。而「模型反复引用哪几条越界规则」正是判断
     * 「这些规则是否该改判为 model」的依据 —— 丢了就没法决策。
     */
    ruleReported: outOfScope ? String(it.ruleId || '').trim() : undefined,
    category: it.category,
    group: 'model',
    severity: it.severity || '中',
    title: it.title,
    detail: it.problem,
    fix: it.suggestion,
    quote: it.quote,
    proposed: it.proposed || '',
    rangeScope: ['phrase', 'sentence', 'paragraph'].includes(it.rangeScope) ? it.rangeScope : undefined,
    basis: realId
      ? '《东方学刊》一审准则（历史批注归纳）+ 大模型按规则逐条匹配'
      : '《东方学刊》一审准则（历史批注归纳）+ 大模型语义判断',
    window: windowNo + 1,
  };
  const context = sourceContext || { kind: windowNo < 0 ? 'document' : 'window', window: windowNo + 1,
    allowDocumentIssue: windowNo < 0, sourcePackageSha256: doc.sourcePackageSha256, entries: [] };
  const resolution = resolveModelSource({ doc, issue: it, context });
  const issue = { ...base, modelSourceDeclaration: resolution.declaration, modelSourceResolution: resolution,
    needsRelocation: !['resolved', 'document'].includes(resolution.status) };
  if (resolution.status !== 'resolved') return { ...issue, location: 'document' };
  const source = resolution.source, anchor = modelSourceAnchor(resolution);
  if (source.target === 'paragraph') return { ...issue, paragraphIndex: source.index, location: `paragraph:${source.index}`, anchor };
  const number = modelNoteNumber(doc, source.target, source.index);
  return { ...issue, [source.target + 'Index']: source.index, [source.target + 'Number']: number,
    noteId: source.noteId, location: `${source.target}:${source.index}`, anchor };
}

/**
 * 用 quote 反查位置。
 * 返回 { kind: 'paragraph'|'footnote', index }，找不到返回 null。
 *
 * 此前这个函数只返回段落号，命中脚注时一律返回 -1 并把匹配结果丢掉，
 * 结果所有脚注类模型问题都被标成「未定位到段落」。
 */
export function findLocation(doc, quote, options = {}) {
  const resolution = resolveModelSource({ doc, issue: { ...(options.issue || {}), quote }, context: options.context });
  if (resolution.status !== 'resolved') return resolution;
  return { ...resolution, kind: resolution.source.target, index: resolution.source.index };
}

/** 用 quote 反查段落号（保留给只关心正文的调用方） */
export function findParagraph(doc, quote) {
  const loc = findLocation(doc, quote);
  return loc?.status === 'resolved' && loc.kind === 'paragraph' ? loc.index : -1;
}

export function dedupeModelIssues(list) {
  const seen = new Map();
  const out = [];
  for (const it of list) {
    const source = it.modelSourceResolution?.source, resolution = it.modelSourceResolution;
    const sourceKey = source ? [source.sourcePackageSha256, source.part, source.sourceXmlNodeId, source.index, source.start, source.end]
      : [resolution?.status || 'legacy', it.location, it.paragraphIndex, it.footnoteIndex, it.endnoteIndex,
        resolution?.window, it.modelSourceDeclaration || null, resolution?.candidates || []];
    const key = (resolution || it.modelSourceDeclaration) && typeof it.issueKey === 'string' && it.issueKey
      ? it.issueKey
      : JSON.stringify([it.ruleId, it.category, it.quote || '', it.title || '', it.detail || '', it.fix || '', it.proposed || '', sourceKey]);
    if (seen.has(key)) { const prior = seen.get(key); prior.reportedWindows = [...new Set([...(prior.reportedWindows || [prior.window]), it.window])]; continue; }
    seen.set(key, it);
    out.push(it);
  }
  return out;
}

/** 单次轻量问答，用于网页上的「追问」 */
export async function arkChat({ model = DEFAULT_MODEL, question, context, instructions }) {
  const { text, usage,modelResolution } = await arkRespond({
    model,
    input: `${context ? `【稿件背景】\n${context.slice(0, 6000)}\n\n` : ''}${question}`,
    instructions: instructions || REVIEW_INSTRUCTIONS,
    maxOutputTokens: 4000,
  });
  return { text, usage,modelResolution };
}
