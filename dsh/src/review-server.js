/** HTTP-independent review adapter. Job identity and publication never use a mutable display run. */
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {sha256} from './working-version.js';
import {loadSessionSnapshot} from './session-store.js';
import {rememberCompletedReview,fixHistoryStatus} from './fix-history.js';
import {streamingReview} from './review.js';
import {computeAnchors,attachCommentAnchors} from './anchors.js';
import {createReviewRuntime} from './review-runtime.js';
import {listJobs,loadJob,latestBatchForWorkspace,loadBatch,loadReviewQueueSnapshot,pauseBatch} from './job-store.js';
import {withArkScope} from './ark-execution-context.js';
import {readArkExecutionSummary,recoverArkExecutions,abandonUnknownArkAttempts} from './ark-execution-store.js';
import {readReviewPlanCoverage,recoverReviewPlans} from './review-plan-store.js';
import {DEFAULT_INDEX_PATH} from './comment-cases.js';
import {arkConfigured,arkEndpointIdentity,arkModelEndpointConfig,resolveArkModel} from './ark.js';

const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
export const reviewStoreArgs={storageRoot:resolve(process.env.DSH_JOB_ROOT||join(root,'data/review-jobs')),
 sessionRoot:resolve(process.env.DSH_SESSION_ROOT||join(root,'data/sessions')),
 workspaceRoot:resolve(process.env.DSH_WORKSPACE_ROOT||join(root,'data/workspaces')),
 versionRoot:resolve(process.env.DSH_WORKING_VERSION_ROOT||join(root,'data/working-versions')),
 documentWorkerLimit:Number(process.env.DSH_REVIEW_WORKERS||2)};
const active=new Set(['queued','running','publishing']);
const jobIdPattern=/^r[a-f0-9]{64}$/;
const plain=value=>JSON.parse(JSON.stringify(value));
const arkStoreArgs={storageRoot:resolve(process.env.DSH_ARK_EXECUTION_ROOT||join(root,'data/ark-executions')),
 poolId:process.env.DSH_ARK_POOL_ID||'project-account'};
const reviewPlanRoot=resolve(process.env.DSH_REVIEW_PLAN_ROOT||join(root,'data/review-plans'));
async function effectiveExecutionConfig(options={}){
 const queueSetting=process.env.DSH_ARK_QUEUE_TIMEOUT_MS;
 if(queueSetting!=null&&queueSetting!==''&&(!/^[1-9]\d*$/.test(queueSetting)||!Number.isSafeInteger(Number(queueSetting))||Number(queueSetting)>2147483647))
   throw fail('请求排队期限配置无效',500,'REVIEW_EXECUTION_CONFIG_INVALID');
 let caseIndexSha256=null;try{caseIndexSha256=sha256(await readFile(DEFAULT_INDEX_PATH));}catch(error){if(error.code!=='ENOENT')throw error;}
 return{schemaVersion:1,endpointIdentity:arkEndpointIdentity(),prefixCache:process.env.ARK_PREFIX_CACHE!=='0',contextDefault:process.env.ARK_CONTEXT!=='0',
  casesDefault:process.env.ARK_CASES!=='0',consistency:process.env.ARK_CONSISTENCY==='1',caseIndexSha256,
  recheckConcurrency:Number(process.env.DSH_RECHECK_CONCURRENCY)||0,windowChars:1500,maxParasPerWindow:10,
  windowTimeoutMs:300000,responseTimeoutMs:300000,queueTimeoutMs:queueSetting==null||queueSetting===''?null:Number(queueSetting),perRuleMaxTasks:120,
  ...(arkModelEndpointConfig()&&(options.useModel!==false||options.useRecheck===true)?{modelResolution:resolveArkModel(options.model)}:{})};
}
function executionScope(job){return{jobRunId:job.id,operationId:job.operationId,operationKind:'manuscript-review',
 sessionId:job.sessionId,workspaceId:job.workspaceId,purpose:job.purpose,verificationRunId:job.verificationRunId,
 binding:{...job.binding},recipe:job.config.recipe,effectiveConfig:job.config.effectiveExecution,endpointIdentity:job.config.effectiveExecution?.endpointIdentity||null,
 resumedFromRunId:job.config.resumedFromRunId||null,checkpointTransportRebase:job.config.transportRebase||null,executionRoot:arkStoreArgs.storageRoot,poolId:arkStoreArgs.poolId,planRoot:reviewPlanRoot};}
const fail=(message,status=409,code='REVIEW_CONFLICT')=>Object.assign(new Error(message),{status,code});
export const reviewJobActive=job=>!!job&&active.has(job.status);
export const reviewJobRunning=job=>!!job&&['running','publishing'].includes(job.status);
const needsArk=options=>options.useModel!==false||options.useRecheck===true||options.verdictWithModel===true;
const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']':value&&typeof value==='object'
 ?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}':JSON.stringify(value);

export function reviewConfigChanges(config,recipe,effective){
 return{recipeChanged:config?.recipe!==recipe,
  executionChanged:!config?.effectiveExecution||stable(config.effectiveExecution)!==stable(effective)};
}

async function blockedPoolReason(){
 // 未配置模型凭据时不存在任何物理发送，请求池闸门（含批量暂停与领取前排除）不适用。
 // 否则历史未知请求会把纯规则审阅永久挡在 409 或排队状态，且报错与真实原因无关。
 if(!arkConfigured())return null;
 const summary=await readArkExecutionSummary(arkStoreArgs);
 if(summary.policy&&summary.blockedUnknownCount>=summary.policy.concurrency)return{
  code:'ARK_EXECUTION_BLOCKED',message:'未知发送占满模型请求池，批量审阅已暂停；请先核对请求记录，不能自动重发',
  poolId:summary.poolId,unknownSentCount:summary.blockedUnknownCount,concurrency:summary.policy.concurrency,
  unknownAttemptIds:(summary.attempts||[]).filter(attempt=>attempt.status==='unknown_sent').map(attempt=>attempt.id).sort()};
 return null;
}
async function requireAvailablePool(options){
 if(!needsArk(options))return;
 const reason=await blockedPoolReason();
 if(reason)throw Object.assign(fail(reason.message,409,reason.code),{poolId:reason.poolId,
  unknownSentCount:reason.unknownSentCount,concurrency:reason.concurrency,unknownAttemptIds:reason.unknownAttemptIds});
}

/**
 * 未知发送的**核对视图**：只读，供工作台列出「哪些请求需要人工处置」。
 *
 * 请求池闸门只说「已占满」，但错误信息让用户「先核对请求记录」时，
 * 应用里原本没有任何地方能看到这些记录，处置就成了死胡同。
 * 这里把每笔未知发送的身份、模型、时间，以及它所属审阅任务是否已被取消
 * 一并列出——「中止审阅导致在途请求变成未知」是最常见的成因，
 * 核对时必须能看出这一点，否则无法判断该怎么处置。
 */
export async function readArkRequestPool(){
 const summary=await readArkExecutionSummary(arkStoreArgs);
 const unknowns=[];
 for(const attempt of summary.attempts||[]){
  if(attempt.status!=='unknown_sent')continue;
  let job=null;
  try{job=attempt.scope?.jobRunId?await loadJob({...reviewStoreArgs,jobId:attempt.scope.jobRunId}):null;}catch{job=null;}
  unknowns.push({id:attempt.id,seq:Number.isSafeInteger(attempt.seq)?attempt.seq:null,model:attempt.model||null,stage:attempt.stage||null,
   queuedAt:attempt.queuedAt||null,sendingAt:attempt.sendingAt||null,finishedAt:attempt.finishedAt||null,
   sessionId:attempt.scope?.sessionId||null,jobRunId:attempt.scope?.jobRunId||null,unitId:attempt.scope?.unitId||null,
   receiptErrorCode:attempt.receipt?.error?.code||null,
   runCancelled:!!job&&(job.cancelRequested===true||job.status==='cancelled')});
 }
 unknowns.sort((a,b)=>(a.seq??0)-(b.seq??0));
 const concurrency=Number.isSafeInteger(summary.policy?.concurrency)?summary.policy.concurrency:null;
 const blockedUnknownCount=summary.blockedUnknownCount??0;
 return{poolId:summary.poolId,concurrency,counts:summary.counts||null,activeCount:summary.activeCount??0,
  blockedUnknownCount,blocked:concurrency!==null&&blockedUnknownCount>=concurrency,
  unknownSentCount:unknowns.length,unknowns};
}

/** 释放未知占位必须由真人逐字确认这句后果陈述，页面原样回传，服务器逐字校验。 */
export const ARK_ABANDON_ACKNOWLEDGE='我确认放弃这些未知结果，允许重新审核';
const ARK_ABANDON_STATEMENT='确认放弃旧结果，允许重新审核'; // 请求池存储层校验的固定措辞
const arkAttemptIdPattern=/^a[a-f0-9]{32}$/;

/**
 * 人工授权的未知占位释放。
 *
 * 设计约束（不得放宽）：未知发送意味着请求已物理发出但没取回响应，
 * 响应内容与费用都无法确认，因此**绝不自动重发**，也**不能由系统代替真人判断**；
 * 存储层要求一条真人授权证据。本函数负责：核对目标仍是未知发送 → 落盘授权证据
 * → CAS 提交放弃事件。原始回执与发送字节一律不动，可追溯性完整保留。
 */
export async function abandonUnknownRequestSlots({attemptIds,acknowledge}={}){
 if(acknowledge!==ARK_ABANDON_ACKNOWLEDGE)
  throw fail('释放未知请求名额必须由真人逐字确认放弃后果',400,'ARK_ABANDON_ACKNOWLEDGE_REQUIRED');
 const view=await readArkRequestPool();
 if(!view.unknowns.length)throw fail('当前没有结果未确认的模型请求，无需释放名额',409,'ARK_ABANDON_NOTHING_TO_DO');
 const requested=Array.isArray(attemptIds)&&attemptIds.length?attemptIds:view.unknowns.map(row=>row.id);
 const ids=[...new Set(requested)].sort();
 if(ids.length!==requested.length||ids.some(id=>typeof id!=='string'||!arkAttemptIdPattern.test(id)))
  throw fail('待放弃的请求身份无效',400,'ARK_ABANDON_INPUT_INVALID');
 // 失败关闭：任一目标不再是「未知发送」就整体拒绝，避免误放仍在途或已确认的请求。
 const targets=ids.map(id=>view.unknowns.find(row=>row.id===id));
 if(targets.some(row=>!row))throw fail(`目标请求状态已变化，未执行放弃：${ids.filter((id,index)=>!targets[index]).join(',')}`,
  409,'ARK_ABANDON_TARGET_CHANGED');
 const evidence={schemaVersion:1,kind:'human-authorization-evidence',
  authorizedBy:'稿件负责人（本机工作台页面人工确认）',authorizedAt:new Date().toISOString(),
  statement:'授权将工作台列出的、发送结果未确认的模型请求在本地标记为放弃，保留原始回执与费用未知状态，释放并发名额以便后续模型审阅。',
  attemptIds:ids,poolId:view.poolId,concurrency:view.concurrency,blockedUnknownCountBefore:view.blockedUnknownCount,
  acknowledge,
  attempts:targets.map(row=>({attemptId:row.id,seq:row.seq,beforeStatus:'unknown_sent',model:row.model,stage:row.stage,
   queuedAt:row.queuedAt,sendingAt:row.sendingAt,finishedAt:row.finishedAt,sessionId:row.sessionId,
   jobRunId:row.jobRunId,unitId:row.unitId,receiptErrorCode:row.receiptErrorCode,runCancelled:row.runCancelled})),
  rationale:'未知发送表示请求已物理发出但未取回响应，响应内容与费用均无法确认；设计上既不能自动重发，也不能由系统代替真人处置。',
  consequence:'放弃仅声明「结果与费用按未知处理」，不确认响应、不自动重发，原始回执与可追溯性完整保留。'};
 const reportsRoot=resolve(process.env.DSH_REPORTS_ROOT||join(root,'reports'));
 await mkdir(reportsRoot,{recursive:true});
 const evidenceName=`review-pool-abandonment-authorization-${Date.now()}.json`;
 const evidenceFile=join(reportsRoot,evidenceName);
 await writeFile(evidenceFile,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
 const evidenceRef=`reports/${evidenceName}`;
 const humanAuthorization={schemaVersion:1,actorType:'human',statement:ARK_ABANDON_STATEMENT,evidenceRef,
  evidenceSha256:sha256(await readFile(evidenceFile))};
 const ledgerPath=join(arkStoreArgs.storageRoot,'pools',arkStoreArgs.poolId,'state.json');
 const operationId=randomUUID();
 let result=null,lastError=null;
 for(let attempt=0;attempt<8;attempt+=1){
  const ledger=await readFile(ledgerPath);
  try{
   result=await abandonUnknownArkAttempts({...arkStoreArgs,attemptIds:ids,operationId,
    expectedRevision:JSON.parse(ledger.toString('utf8')).state.revision,expectedLedgerSha256:sha256(ledger),humanAuthorization});
   break;
  }catch(error){
   lastError=error;
   // 决策尚未落盘时账本可能被并发推进：重新取版本重试；已落盘的同一操作只会重放。
   if(!/ARK_ABANDON_STALE|CONFLICT|REVISION/.test(error.code||'')||attempt===7)throw error;
  }
 }
 if(!result)throw lastError||fail('人工放弃未完成，请刷新后核对请求记录',500,'ARK_ABANDON_INCOMPLETE');
 const after=await readArkRequestPool();
 return{ok:true,poolId:view.poolId,operationId:result.operationId,abandoned:result.attemptIds,
  remoteCompletion:result.remoteCompletion||'unconfirmed',automaticRetryAllowed:result.automaticRetryAllowed===true,
  revision:result.revision,eventFile:result.event?.eventFile||null,eventSha256:result.event?.eventSha256||null,
  blockedUnknownCountBefore:view.blockedUnknownCount,blockedUnknownCountAfter:after.blockedUnknownCount,
  concurrency:after.concurrency,counts:after.counts,
  authorizationEvidence:evidenceRef,authorizationEvidenceFile:evidenceFile,
  authorizationEvidenceSha256:humanAuthorization.evidenceSha256};
}

export function normalizeReviewOptions(input={},defaultModel){
 const useModel=input.useModel!==false;
 return {useModel,useRecheck:input.useRecheck===undefined?useModel:input.useRecheck===true,
  useContext:input.useContext===undefined?useModel:input.useContext===true,
  useCases:input.useCases===undefined?useModel:input.useCases===true,
  verdictWithModel:input.verdictWithModel===true,ruleMode:input.ruleMode==='per-rule'?'per-rule':'all',
  model:input.model||defaultModel,focus:Array.isArray(input.focus)?input.focus:[]};
}
export function queryReviewOptions(params,defaultModel){
 const input={model:params.get('model')||defaultModel,ruleMode:params.get('ruleMode'),focus:params.getAll('focus')};
 for(const key of ['useModel','useRecheck','useContext','useCases','verdictWithModel'])if(params.has(key))input[key]=params.get(key)==='true';
 return normalizeReviewOptions(input,defaultModel);
}
export const sameReviewOptions=(a,b)=>!!a&&!!b&&JSON.stringify(normalizeReviewOptions(a,b.model))===JSON.stringify(normalizeReviewOptions(b,b.model));
export function publicReviewJob(job){return job?{id:job.id,jobRunId:job.id,sessionId:job.sessionId,workspaceId:job.workspaceId,
 resumedFromRunId:job.config.resumedFromRunId||null,
 batchId:job.batchId,versionId:job.binding.versionId,status:job.status,cancelRequested:job.cancelRequested,
 progress:job.progress,error:job.sessionReceipt?.error||null,createdAt:job.createdAt,startedAt:job.startedAt||null,
 finishedAt:job.finishedAt||null}:null;}
export async function currentSessionJob(sessionId,{runId=null}={}){
 if(runId){if(!jobIdPattern.test(runId))return null;const job=await loadJob({...reviewStoreArgs,jobId:runId});
  if(job.sessionId!==sessionId)throw fail('审阅运行不属于该稿件',404);return job;}
 const jobs=await listJobs({...reviewStoreArgs,sessionId});return [...jobs].reverse().find(reviewJobActive)||null;
}
export async function currentWorkspaceJobs(workspaceId){return listJobs({...reviewStoreArgs,workspaceId});}
export async function latestSessionJob(sessionId){
 return (await listJobs({...reviewStoreArgs,sessionId})).at(-1)||null;
}

export async function createServerReviewService({getSession,persistSession,adoptSession,serializeDoc,serializeReview,humanState,cleanGate,reviewTexts,defaultModel,onError=()=>{}}){
 const priorRequests=await readArkExecutionSummary(arkStoreArgs);
 if(priorRequests.policy)await recoverArkExecutions(arkStoreArgs);
 await recoverReviewPlans({storageRoot:reviewPlanRoot,executionRoot:arkStoreArgs.storageRoot,poolId:arkStoreArgs.poolId});
 const files=['src/review.js','src/review-coverage.js','src/docx.js','src/anchors.js','src/review-source.js','src/ark.js','src/ark-endpoint-config.js','src/model-source-location.js','src/review-source-plan.js','src/issue-identity.js','src/recheck.js','src/scanner-format.js','src/scanner-language.js','src/scanner-citation.js','src/comment-cases.js','src/ark-execution-context.js','src/ark-execution-store.js','src/review-plan-store.js'];
 for(const name of (await readdir(join(root,'rules'))).sort())if(name.endsWith('.json'))files.push(`rules/${name}`);
 const fingerprints=Object.fromEntries(await Promise.all(files.map(async name=>[name,sha256(await readFile(join(root,name)))])));
 const executionPolicy=await effectiveExecutionConfig({useModel:false,useRecheck:false});
 const recipe=sha256(JSON.stringify({...fingerprints,'config/ark-execution-policy':executionPolicy,...(arkModelEndpointConfig()?{'config/ark-model-endpoints':arkModelEndpointConfig()}: {})}));
 function matches(s,job){return s.workVersion.id===job.binding.versionId&&s.workVersion.sha256===job.binding.workSha256
  &&s.workVersion.sourceSha256===job.binding.sourceSha256&&(s.mutationEpoch||0)===job.binding.mutationEpoch;}
 async function configurationReason(jobs){
  const current=new Map(),affected=[];
  for(const job of jobs){
   const options=normalizeReviewOptions(job.config,defaultModel),key=stable(options);
   if(!current.has(key)){
    try{current.set(key,{effective:await effectiveExecutionConfig(options)});}
    catch(error){
     if(!['ARK_MODEL_ENDPOINT_UNREGISTERED','ARK_MODEL_NAME_INVALID'].includes(error.code))throw error;
     current.set(key,{effective:null,errorCode:error.code});
    }
   }
   const expected=current.get(key),changes=reviewConfigChanges(job.config,recipe,expected.effective);
   if(changes.recipeChanged||changes.executionChanged)affected.push({jobId:job.id,...changes,
    ...(expected.errorCode?{executionErrorCode:expected.errorCode}:{})});
  }
  if(!affected.length)return null;
  affected.sort((a,b)=>a.jobId.localeCompare(b.jobId));
  return{code:'REVIEW_QUEUE_CONFIG_CHANGED',message:`有 ${affected.length} 份待审稿件的审核程序或配置已变化，请结束旧批次后新建完整审阅`,
   affectedJobCount:affected.length,currentRecipe:recipe,affectedJobs:affected};
 }
 async function retainPause(batchId,reason){
  const batch=await loadBatch({...reviewStoreArgs,batchId});
  if(!batch.finishedAt&&(!batch.paused||stable(batch.pauseReason||null)!==stable(reason)))
   await pauseBatch({...reviewStoreArgs,batchId,reason});
 }
 const runtime=await createReviewRuntime({storeArgs:reviewStoreArgs,
  onRuntimeError:onError,
  beforeClaim:async({jobs})=>{
   const queued=jobs.filter(job=>job.status==='queued'),modelJobs=queued.filter(job=>needsArk(job.config));
   const reason=modelJobs.length?await blockedPoolReason():null,excluded=new Set(),blockedBatches=new Set();
   if(reason){
    for(const job of modelJobs){excluded.add(job.id);if(job.batchId)blockedBatches.add(job.batchId);}
    for(const batchId of blockedBatches)await retainPause(batchId,reason);
   }
   // A batch is one confirmed configuration. Stop the whole batch before any
   // claim, rather than consume old jobs one by one under a new review recipe.
   const groups=new Map();for(const job of queued)if(job.batchId&&!blockedBatches.has(job.batchId)){
    if(!groups.has(job.batchId))groups.set(job.batchId,[]);groups.get(job.batchId).push(job);
   }
   for(const [batchId,pending] of groups){const conflict=await configurationReason(pending);if(conflict){
    await retainPause(batchId,conflict);for(const job of pending)excluded.add(job.id);
   }}
   return{excludedJobIds:[...excluded]};
  },
  execute:async({job,signal,emit})=>{
   const options=normalizeReviewOptions(job.config,defaultModel),conflict=await configurationReason([job]);
   if(conflict)return{status:'failed',rejection:'config-conflict',result:null,
    message:'审核程序或配置已变化，此次审阅未执行；请核对设置后新建完整审阅'};
   const s=await getSession(job.sessionId,{fresh:true,executorJobId:job.id});
   if(!s)throw fail('稿件记录缺失',404);
   if(!matches(s,job))return{status:'failed',rejection:'version-conflict',result:null,message:'工作稿或修改历史已变化，此次审阅未执行，请核对当前版本后重试'};
   if(s.applyingFixes)throw fail('稿件正在保存修改，此次审阅未执行');
   if(cleanGate(s))throw fail('当前稿清洗尚未验证，此次审阅未执行');
   const candidate={...s,reviewRecords:structuredClone(s.reviewRecords||[])};rememberCompletedReview(candidate);
   Object.assign(candidate,{reviewJobId:job.id,reviewRunId:job.id,reviewVersionId:job.binding.versionId,
    reviewTexts:reviewTexts(candidate.doc,candidate.workVersion),reviewRunning:true,reviewController:null,result:null,
    reviewError:null,cancelled:false,interrupted:false,
    reviewProgress:{phase:'start',done:0,total:0,message:'开始审阅'}});
   await persistSession(candidate);adoptSession(candidate);
   emit('doc',{id:candidate.id,name:candidate.name,reviewRunId:job.id,reviewJobId:job.id,workVersionId:job.binding.versionId,
    workVersion:candidate.workVersion,history:fixHistoryStatus(candidate),human:humanState(candidate),doc:serializeDoc(candidate.doc),clean:candidate.clean,legacy:candidate.legacy||null});
   const result=await withArkScope(executionScope(job),()=>streamingReview(candidate.doc,{...options,purpose:job.purpose,signal,
    onProgress:progress=>{candidate.reviewProgress=progress;emit('progress',{...progress,id:candidate.id,reviewRunId:job.id,reviewJobId:job.id,workVersionId:job.binding.versionId});},
    onIssue:(issue,info)=>{const sourceDoc={...candidate.doc,sourceVersionId:job.binding.versionId},anchors=computeAnchors(issue,sourceDoc);
      const anchored=anchors.length?{...issue,anchors,anchor:anchors[0]}:{...issue};attachCommentAnchors({issues:[anchored]},sourceDoc);
      emit('issue',{id:candidate.id,reviewRunId:job.id,reviewJobId:job.id,workVersionId:job.binding.versionId,issue:anchored,...info});}}));
   if(job.config.effectiveExecution?.modelResolution)result.modelResolution=job.config.effectiveExecution.modelResolution;
   result.execution={requests:await readArkExecutionSummary({...arkStoreArgs,jobRunId:job.id}),
     plan:await readReviewPlanCoverage({scope:executionScope(job)})};
   const partial=result.reviewCoverage?.hasIncompleteRequestedSteps===true;
   result.completionStatus=partial?'partial':'completed';
   return{status:result.completionStatus,result,texts:candidate.reviewTexts,options};
  },
  publish:async({job,outcome})=>{
   const s=await getSession(job.sessionId,{fresh:true,executorJobId:job.id});
   if(!s)throw fail('稿件记录缺失，审阅结果已保存在待发布记录',404);
   if(outcome.rejection==='config-conflict'){
    const stored=await loadSessionSnapshot({sessionId:s.id,storageRoot:reviewStoreArgs.sessionRoot});
    return{jobRunId:job.id,versionId:job.binding.versionId,unpublished:true,reason:'config-conflict',
     currentVersionId:stored.snapshot.workVersion.id,currentMutationEpoch:stored.snapshot.mutationEpoch||0,
     error:outcome.message,sessionRevision:stored.manifest.revision,sessionManifestSha256:stored.manifest.manifestSha256};
   }
   if(!matches(s,job)){
    if(outcome.result||!['failed','cancelled','interrupted'].includes(outcome.status))throw fail('工作稿已变化，审阅结果已保留，禁止覆盖当前稿');
    const stored=await loadSessionSnapshot({sessionId:s.id,storageRoot:reviewStoreArgs.sessionRoot});
    return{jobRunId:job.id,versionId:job.binding.versionId,unpublished:true,reason:'version-conflict',currentVersionId:stored.snapshot.workVersion.id,
     currentMutationEpoch:stored.snapshot.mutationEpoch||0,error:'工作稿已变化，此次任务没有覆盖当前稿',
     sessionRevision:stored.manifest.revision,sessionManifestSha256:stored.manifest.manifestSha256};
   }
   const candidate={...s,reviewRecords:structuredClone(s.reviewRecords||[]),reviewJobId:job.id,reviewRunId:job.id,
    reviewVersionId:job.binding.versionId,reviewRunning:false,reviewController:null,cancelled:outcome.status==='cancelled',
    interrupted:outcome.status==='interrupted',reviewError:null};
   if(['completed','partial'].includes(outcome.status)){
    Object.assign(candidate,{result:outcome.result,resultRunId:job.id,resultVersionId:job.binding.versionId,
     resultTexts:outcome.texts||reviewTexts(candidate.doc,candidate.workVersion),reviewTexts:outcome.texts||reviewTexts(candidate.doc,candidate.workVersion),
     resultOptions:outcome.options||normalizeReviewOptions(job.config,defaultModel),resultRecipe:job.config.recipe||null,
     reviewProgress:{phase:outcome.status==='partial'?'partial':'done',done:1,total:1,message:outcome.status==='partial'?'审阅部分完成，存在需补审步骤':'审阅完成'}});
    rememberCompletedReview(candidate);
   }else{
    const message=String(outcome.error?.message||outcome.error||outcome.message||(candidate.cancelled?'已中止':'审阅已中断'));
    candidate.reviewError=candidate.cancelled?null:message;
    candidate.reviewProgress={phase:candidate.cancelled?'cancelled':candidate.interrupted?'interrupted':'error',done:0,total:0,message};
    if(candidate.interrupted)candidate.interruption={runId:job.id,versionId:job.binding.versionId,at:new Date().toISOString(),reason:message};
   }
   // If publication already committed before a process crash, reread and confirm
   // the same receipt. No later modification or human decision is overwritten.
   const already=s.reviewJobId===job.id&&!s.reviewRunning&&s.reviewProgress?.phase===candidate.reviewProgress.phase
    &&(['completed','partial'].includes(outcome.status)?s.resultRunId===job.id:true);
   const manifest=already?(await loadSessionSnapshot({sessionId:s.id,storageRoot:reviewStoreArgs.sessionRoot})).manifest:await persistSession(candidate);
   if(!already)adoptSession(candidate);
   return{jobRunId:job.id,versionId:job.binding.versionId,sessionRevision:manifest.revision,sessionManifestSha256:manifest.manifestSha256,
    ...(candidate.reviewError?{error:candidate.reviewError}:{}),
    terminalData:['completed','partial'].includes(outcome.status)?plain(serializeReview(already?s.result:candidate.result,already?s.doc:candidate.doc,already?s:candidate)):{message:candidate.reviewProgress.message}};
  }});
 async function enqueue(s,options,{operationId=randomUUID(),workspaceId=s.workspaceId||null,baseVersionId,baseMutationEpoch}={}){
  if(s.applyingFixes)throw fail('稿件正在保存修改，请稍候');
  if(baseVersionId&&baseVersionId!==s.workVersion.id||baseMutationEpoch!=null&&baseMutationEpoch!==(s.mutationEpoch||0))throw fail('工作稿或修改历史已变化，请刷新后核对');
  if(cleanGate(s))throw fail('当前稿清洗尚未验证，请先验证清洗');
  const normalized=normalizeReviewOptions(options,defaultModel);
  await requireAvailablePool(normalized);
  return runtime.enqueue({operationId,workspaceId,sessionId:s.id,
   binding:{versionId:s.workVersion.id,sourceSha256:s.workVersion.sourceSha256,workSha256:s.workVersion.sha256,mutationEpoch:s.mutationEpoch||0},
   config:{...normalized,recipe,effectiveExecution:await effectiveExecutionConfig(normalized)},purpose:s.purpose||'editorial',verificationRunId:s.verificationRunId||null});
 }
 async function resume(s,{fromRunId,baseVersionId,baseMutationEpoch,operationId,mode}={}){
  if(mode!=='missing-only'||!jobIdPattern.test(fromRunId||'')||!operationId||!baseVersionId||!Number.isSafeInteger(baseMutationEpoch))
    throw fail('补审须明确原运行、当前版本、修改序号和操作身份',400,'REVIEW_RESUME_INPUT_INVALID');
  const previous=await loadJob({...reviewStoreArgs,jobId:fromRunId});
  if(previous.sessionId!==s.id||previous.workspaceId!==(s.workspaceId||null))throw fail('补审运行不属于当前稿件或工作台',409,'REVIEW_RESUME_OWNER_CONFLICT');
  if(reviewJobActive(previous))throw fail('原审阅尚未结束，不能补审',409,'REVIEW_RESUME_ACTIVE');
  if(!matches(s,previous)||baseVersionId!==s.workVersion.id||baseMutationEpoch!==(s.mutationEpoch||0))
    throw fail('稿件版本或修改历史已变化，原窗口不能复用',409,'REVIEW_RESUME_SOURCE_CONFLICT');
  if(await configurationReason([previous]))
    throw fail('审核程序、设置或案例已变化，请新建完整审阅',409,'REVIEW_RESUME_CONFIG_CONFLICT');
  if(s.applyingFixes||cleanGate(s))throw fail('工作稿保存或清洗尚未确认，补审未执行');
  await requireAvailablePool(previous.config);
  const plan=await readReviewPlanCoverage({scope:executionScope(previous)});
  if(!plan)throw fail('该运行没有可核验的窗口检查点，请重新审阅整份',409,'REVIEW_RESUME_PLAN_MISSING');
  if(plan.unknownSent||plan.units?.some(unit=>['running','unknown_sent'].includes(unit.status)))
    throw fail('存在发送结果未知的请求，请先核对请求记录，不能自动重发',409,'REVIEW_RESUME_UNKNOWN_SENT');
  const accepted=await runtime.enqueue({operationId,workspaceId:s.workspaceId||null,sessionId:s.id,binding:{...previous.binding},
    config:{...previous.config,resumedFromRunId:previous.id},purpose:previous.purpose,verificationRunId:previous.verificationRunId});
  return{...accepted,resumedFromRunId:previous.id};
 }
 async function executionView(job){return{requests:await readArkExecutionSummary({...arkStoreArgs,jobRunId:job.id}),
   plan:await readReviewPlanCoverage({scope:executionScope(job)})};}
 function queueProjection(snapshot){
  const {batch,revision}=snapshot;if(!batch)return null;
  const jobs=snapshot.jobs.filter(job=>job.batchId===batch.id),counts={total:jobs.length+(batch.excluded||[]).length,queued:0,running:0,completed:0,partial:0,failed:0,cancelled:0,interrupted:0,excluded:(batch.excluded||[]).length};
  for(const job of jobs){const status=job.status==='publishing'?'running':job.status;counts[status]=(counts[status]||0)+1;}
  const cursor=jobs.find(reviewJobRunning);
  const state=batch.paused&&!batch.finishedAt&&!batch.cancelRequested?(cursor?'pausing':'paused'):batch.status;
  return{runId:batch.id,revision,state,cancelRequested:batch.cancelRequested,pauseReason:batch.pauseReason||null,cursorSessionId:cursor?.sessionId||null,options:jobs[0]?normalizeReviewOptions(jobs[0].config,defaultModel):null,
   counts,items:jobs.map(job=>({...publicReviewJob(job),jobId:job.id})),excluded:batch.excluded||[],createdAt:batch.createdAt,updatedAt:batch.updatedAt};
 }
 async function workspaceView(workspaceId,{sessionIds=[]}={}){
  const snapshot=await loadReviewQueueSnapshot({...reviewStoreArgs,workspaceId,sessionIds});
  return{jobs:snapshot.jobs,queue:queueProjection(snapshot),revision:snapshot.revision};
 }
 async function queueView(workspaceId,{batchId=null}={}){
  return queueProjection(await loadReviewQueueSnapshot({...reviewStoreArgs,workspaceId,batchId}));
 }
 async function controlQueue(workspace,{action,operationId,options,concurrency,runId}={}){
  if(concurrency!=null&&concurrency!==reviewStoreArgs.documentWorkerLimit)throw fail('并发稿件数由服务器配置，请刷新后核对');
  if(action==='start'){
   const want=normalizeReviewOptions(options,defaultModel),jobs=[],excluded=[];
   if(operationId){
    let previous=null;try{previous=await loadBatch({...reviewStoreArgs,batchId:'q'+sha256(`${workspace.id}\0${operationId}`)});}
    catch(error){if(error.code!=='JOB_BATCH_NOT_FOUND')throw error;}
    if(previous){const existing=await listJobs({...reviewStoreArgs,batchId:previous.id});
     if(existing.some(job=>!sameReviewOptions(job.config,want)||job.config.recipe!==recipe))throw fail('同一批量操作不能更换审阅设置');
     return{queue:await queueView(workspace.id),command:{action,operationId,runId:previous.id,replayed:true}};
    }
   }
   await requireAvailablePool(want);
   for(const entry of workspace.entries){
    if(!entry.id){excluded.push({entryId:entry.entryId||entry.ingestionId||'unregistered',name:entry.name||'未登记稿件',reason:entry.error||'稿件尚未成功接收'});continue;}
    const s=await getSession(entry.id,{fresh:true});if(!s)throw fail('队列稿件记录缺失',404);
    if(cleanGate(s)){excluded.push({entryId:entry.entryId||entry.id,name:entry.name||s.name,reason:'清洗尚未验证'});continue;}
    if(s.result&&s.resultRunId===s.reviewRunId&&!s.reviewRunning&&!s.reviewError&&!s.interrupted&&s.resultVersionId===s.workVersion.id&&sameReviewOptions(s.resultOptions,want)&&s.resultRecipe===recipe&&s.reviewProgress?.phase!=='partial')continue;
    jobs.push({sessionId:s.id,binding:{versionId:s.workVersion.id,sourceSha256:s.workVersion.sourceSha256,workSha256:s.workVersion.sha256,mutationEpoch:s.mutationEpoch||0},
     config:{...want,recipe,effectiveExecution:await effectiveExecutionConfig(want)},purpose:s.purpose||'editorial',verificationRunId:s.verificationRunId||null});
   }
   if(!jobs.length)throw fail(excluded.length?'没有可审阅稿件，请先处理导入或清洗问题':'当前版本和设置下的可用稿件均已完成，请选择需要重审的稿件',400);
   operationId ||= randomUUID();
   const accepted=await runtime.startBatch({workspaceId:workspace.id,operationId,jobs,config:{...want,recipe},excluded});
   return{queue:await queueView(workspace.id),command:{action,operationId,runId:accepted.batch.id,replayed:accepted.replayed}};
  }else{
   const batch=await latestBatchForWorkspace({...reviewStoreArgs,workspaceId:workspace.id});if(!batch)throw fail('尚未创建服务器审阅队列',404);
   if(!runId)throw fail('队列操作缺少批次身份，请刷新后重试',400);
   if(runId!==batch.id)throw fail('批量任务已变化，此次操作没有执行，请刷新后核对');
   if(action==='resume'&&batch.finishedAt)throw fail('本轮已经结束，请新建一轮审阅未完成稿件');
   if(action==='pause')await runtime.pauseBatch({batchId:batch.id});
   else if(action==='resume'){
    const pending=(await listJobs({...reviewStoreArgs,batchId:batch.id})).filter(job=>job.status==='queued');
    if(pending.some(job=>needsArk(job.config)))await requireAvailablePool({useModel:true});
    const conflict=await configurationReason(pending);if(conflict){await retainPause(batch.id,conflict);throw fail(conflict.message,409,conflict.code);}
    await runtime.resumeBatch({batchId:batch.id});
   }
   else if(action==='cancel')await runtime.cancelBatch({batchId:batch.id});
   else throw fail('队列动作无效',400);
  }
  return{queue:await queueView(workspace.id),command:{action,operationId:operationId||null,runId,replayed:false}};
 }
 return{runtime,enqueue,resume,executionView,queueView,workspaceView,controlQueue,recipe,fingerprints,describeConfiguration:async options=>{const want=normalizeReviewOptions(options,defaultModel);return{recipe,runtimeSourceHashes:fingerprints,options:want,effectiveExecution:await effectiveExecutionConfig(want)};}};
}
