/** Source-bound review units. Durable checkpoints precede consumer completion events. */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,realpath,readFile,readdir,open,rename,link,unlink} from 'node:fs/promises';
import {resolve,join,dirname,parse,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createJobOwner,isJobOwnerAlive} from './job-store.js';
import {withArkExecutionStoreLock,readArkExecutionSummary,readArkAttempt} from './ark-execution-store.js';
import {verifyArkModelEndpointConfig,resolveArkModelEndpoint} from './ark-endpoint-config.js';
import {withArkScope} from './ark-execution-context.js';

const DEFAULT_ROOT=fileURLToPath(new URL('../data/review-plans/',import.meta.url));
const states=new Set(['queued','running','completed','partial','failed','blocked','cancelled','unknown_sent','unavailable']);
const hash=value=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
const fail=(code,message,status=500,cause)=>Object.assign(new Error(message,cause?{cause}:undefined),{code,status});
const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}':JSON.stringify(value);
export const reviewPlanFingerprint=value=>hash(stable(clean(value)));
// Transport compatibility is an explicit, source-pinned capability, never a
// general recipe bypass. Nested prompt/source/config data remains exact.
export function reviewTransportProjection(value,kind='input'){
 const out=clean(value),omit=(target,keys)=>target&&typeof target==='object'?Object.fromEntries(Object.entries(target).filter(([k])=>!keys.includes(k))):target;
 return kind==='plan'?{...out,config:omit(out.config,['responseTimeoutMs','queueTimeoutMs','timeoutBasis'])}:omit(out,['responseTimeoutMs','queueTimeoutMs']);
}
export async function verifyTransportRebaseApproval({scope,fromRunId,priorManifest,plan}={}){
 const ref=scope?.checkpointTransportRebase;if(!ref||typeof ref.path!=='string'||!/^[a-f0-9]{64}$/.test(ref.sha256||''))throw fail('REVIEW_TRANSPORT_REBASE_REQUIRED','运输配置迁移缺少固定批准凭证',409);
 const raw=await bytes(ref.path);if(hash(raw)!==ref.sha256)throw fail('REVIEW_TRANSPORT_REBASE_CONFLICT','运输迁移凭证SHA不同',409);const approval=JSON.parse(raw);
 const entry=approval.entries?.find(e=>e.newJobRunId===scope.jobRunId&&e.oldJobRunId===fromRunId);
 if(approval.kind!=='review-transport-rebase-receipt'||approval.schemaVersion!==1||approval.operationId!==ref.operationId||approval.humanAuthorization?.actorType!=='human'||!approval.humanAuthorization.statement||!entry||entry.sessionId!==scope.sessionId||stable(entry.binding)!==stable(scope.binding)||approval.toRecipe!==scope.recipe||approval.fromRecipe!==priorManifest.identity.recipe)throw fail('REVIEW_TRANSPORT_REBASE_CONFLICT','运输迁移的人工批准、运行或来源不同',409);
 await verifyReviewTransportSourcePins(approval);
 const currentIdentity=scopeIdentity(scope),oldIdentity={...priorManifest.identity,recipe:scope.recipe};
 if(stable(currentIdentity)!==stable(oldIdentity)||plan&&stable(reviewTransportProjection(plan,'plan'))!==stable(reviewTransportProjection(priorManifest.plan,'plan')))throw fail('REVIEW_TRANSPORT_REBASE_CONFLICT','来源、模型、提示词或非运输计划发生变化',409);
 if(plan&&(plan.config.responseTimeoutMs!==entry.newConfig.effectiveExecution.responseTimeoutMs||plan.config.queueTimeoutMs!==entry.newConfig.effectiveExecution.queueTimeoutMs||plan.config.timeoutBasis!=='physical-sending-to-body-eof'))throw fail('REVIEW_TRANSPORT_REBASE_CONFLICT','实际期限参数不同于固定新运行配置',409);
 const history=await readArkExecutionSummary({storageRoot:scope.executionRoot,poolId:scope.poolId,jobRunId:fromRunId});
 if(history.attempts.some(a=>['sending','unknown_sent','queued'].includes(a.status)))throw fail('REVIEW_PLAN_UNKNOWN_SENT','旧请求尚未终止或人工放弃',409);
 for(const a of history.attempts.filter(a=>a.status==='abandoned')){
  const proof=await readArkAttempt({storageRoot:scope.executionRoot,poolId:scope.poolId,attemptId:a.id,includeRaw:false});
  if(!approval.abandonment?.attemptIds?.includes(a.id)||a.abandonment?.operationId!==approval.abandonment.operationId||a.abandonment?.eventSha256!==approval.abandonment.eventSha256||proof.receipt?.status!=='unknown_sent'||proof.receipt.bodyComplete!==false)throw fail('REVIEW_PLAN_UNKNOWN_SENT','未知请求没有匹配的人工放弃证据',409);
 }
 return approval;
}
export async function verifyReviewTransportSourcePins(approval){
 const before=approval.fromRuntimeSourceHashes,after=approval.toRuntimeSourceHashes,allowed=new Set(['src/ark.js','src/ark-execution-store.js','src/review-plan-store.js']);
 if(!before||!after||stable(Object.keys(before).sort())!==stable(Object.keys(after).sort())||!Object.keys(after).length)throw fail('REVIEW_TRANSPORT_REBASE_CONFLICT','迁移缺少完整运行源码指纹',409);
 const project=resolve(fileURLToPath(new URL('../',import.meta.url)));
 for(const name of Object.keys(after)){
  if(!/^(src\/[a-z0-9-]+\.js|rules\/[a-z0-9-]+\.json)$/.test(name)||!/^[a-f0-9]{64}$/.test(before[name])||!/^[a-f0-9]{64}$/.test(after[name])||before[name]!==after[name]&&!allowed.has(name)||hash(await bytes(join(project,name)))!==after[name])throw fail('REVIEW_TRANSPORT_REBASE_CONFLICT','未批准的审核程序或规则变化',409);
 }
 const required=['src/review.js','src/review-coverage.js','src/docx.js','src/anchors.js','src/review-source.js','src/ark.js','src/ark-endpoint-config.js','src/model-source-location.js','src/review-source-plan.js','src/issue-identity.js','src/recheck.js','src/scanner-format.js','src/scanner-language.js','src/scanner-citation.js','src/comment-cases.js','src/ark-execution-context.js','src/ark-execution-store.js','src/review-plan-store.js'];for(const name of (await readdir(join(project,'rules'))).sort())if(name.endsWith('.json'))required.push('rules/'+name);if(stable(Object.keys(after).sort())!==stable(required.sort()))throw fail('REVIEW_TRANSPORT_REBASE_CONFLICT','迁移必须校验全部运行源码与规则指纹',409);return true;
}
async function rebaseInputMatches(root,id,old,input){
 if(!old.inputReceipt||old.inputReceipt.file!==old.inputSha256+'.json')return false;
 const saved=await readWrapped(join(runDir(root,id),'inputs',old.inputReceipt.file));
 return saved.inputSha256===old.inputSha256&&reviewPlanFingerprint(saved.input)===old.inputSha256&&stable(reviewTransportProjection(saved.input))===stable(reviewTransportProjection(input));
}
async function authenticatedRebaseUnit(scope,id,unitId){
 const manifest=await readWrapped(join(runDir(rootOf(scope),id),'manifest.json'));
 const readback=await verifyReviewPlanCheckpoints({scope:{...scope,...manifest.identity,jobRunId:id,checkpointTransportRebase:undefined,resumedFromRunId:undefined}});
 const unit=readback.units.find(u=>u.unitId===unitId);if(!unit?.verificationCertificate)throw checkpointMismatch('旧完成窗口缺少真实字节与物理回执认证');
 if(!isVerifiedReviewSourceUnit(unit)){
  // Digest is not primary coverage, but its exact provider text can be reused.
  const input=await readWrapped(join(runDir(rootOf(scope),id),'inputs',unit.inputReceipt.file)),output=await outputFor(rootOf(scope),id,unit.outputReceipt);
  if(unit.stage!=='digest'||output.ok!==true||!unit.verificationCertificate.physicalAttemptIds.length)throw checkpointMismatch('旧非主来源单元不能认证复用');
  const {parseJsonLoose,formatDocDigest}=await import('./ark.js');let matched=false;for(const attemptId of unit.verificationCertificate.physicalAttemptIds){const saved=await readArkAttempt({storageRoot:scope.executionRoot,poolId:scope.poolId,attemptId});
   if(saved.receipt?.status!=='confirmed'||!saved.receipt.bodyComplete||saved.receipt.httpStatus<200||saved.receipt.httpStatus>=300)continue;
   const recorded=input.input,meta=recorded.docMeta||{};
   if(typeof recorded.source!=='string'||!recorded.source||recorded.budget!==6000||saved.request.body.max_output_tokens!==6000||saved.request.body.stream!==false||saved.request.body.temperature!==0||stable(Object.keys(saved.request.body).sort())!==stable(['model','stream','input','instructions','max_output_tokens','temperature'].sort()))throw checkpointMismatch('旧纲要请求的来源、预算或cache/stream策略不同');
   const prompt=`【稿件】${meta.title||'（未识别标题）'}｜栏目：${meta.column||'（未标注）'}\n\n【全文节选（已按段落抽样，仅供把握全貌）】\n${recorded.source}\n\n请输出纲要 JSON。`;
   // Digest never uses the window fallback model chain. Resolve exactly its
   // requested model/endpoint and compare the complete constructor prompt.
   actualPrimaryBody(saved.request.body,[],{...recorded,modelChain:[recorded.model],prompt},manifest,saved.request.scope);
   const parsed=parseJsonLoose(responseText(saved.rawResponse,saved.request.body.stream));
   if(stable(parsed)===stable(output.parsed)&&formatDocDigest(parsed)===output.text)matched=true;
  }if(!matched)throw checkpointMismatch('旧纲要输出与已确认原始响应不同');
 }
 return unit;
}
export async function verifyReviewTransportCheckpoint({scope,fromRunId=scope?.jobRunId,unitId}={}){return authenticatedRebaseUnit(scope,fromRunId,unitId);}
function clean(value,seen=new Set()) {
 if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return value;
 if(value===undefined)return null;
 if(!value||typeof value!=='object'||seen.has(value))throw fail('REVIEW_PLAN_NOT_JSON','来源计划包含不支持的值',400);
 seen.add(value);
 try {
  if(value instanceof Error)return {name:value.name,message:value.message,code:value.code||null,...(value.cause?{cause:clean(value.cause,seen)}:{})};
  if(Array.isArray(value))return value.map(v=>clean(v,seen));
  if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw fail('REVIEW_PLAN_NOT_JSON','来源计划必须使用普通对象',400);
  const out={};for(const key of Object.keys(value)){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!Object.hasOwn(descriptor,'value'))throw fail('REVIEW_PLAN_NOT_JSON','来源计划不能含访问器',400);if(descriptor.value!==undefined)Object.defineProperty(out,key,{value:clean(descriptor.value,seen),enumerable:true});}return out;
 } finally {seen.delete(value);}
}
// Explicit typed envelopes avoid losing recheck Maps and prevent reserved-key collisions.
function encode(value,seen=new Set()) {
 if(value===undefined)return {t:'undefined'};
 if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return {t:'value',v:value};
 if(!value||typeof value!=='object'||seen.has(value))throw fail('REVIEW_PLAN_OUTPUT_INVALID','窗口结果包含不支持或循环的值');
 seen.add(value);try{
  if(value instanceof Error)return {t:'error',v:clean(value)};
  if(value instanceof Map)return {t:'map',v:[...value].map(([k,v])=>[encode(k,seen),encode(v,seen)])};
  if(value instanceof Set)return {t:'set',v:[...value].map(v=>encode(v,seen))};
  if(Array.isArray(value))return {t:'array',v:value.map(v=>encode(v,seen))};
  if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw fail('REVIEW_PLAN_OUTPUT_INVALID','窗口结果不是可保存的普通对象');
  return {t:'object',v:Object.keys(value).map(k=>{const d=Object.getOwnPropertyDescriptor(value,k);if(!Object.hasOwn(d,'value'))throw fail('REVIEW_PLAN_OUTPUT_INVALID','窗口结果不能含访问器');return[k,encode(d.value,seen)];})};
 }finally{seen.delete(value);}
}
function decode(value) {
 if(!value||typeof value.t!=='string')throw fail('REVIEW_PLAN_CORRUPT','窗口结果类型记录损坏');
 if(value.t==='undefined')return undefined;if(value.t==='value')return value.v;
 if(value.t==='error')return Object.assign(new Error(value.v.message),value.v);
 if(value.t==='map')return new Map(value.v.map(([k,v])=>[decode(k),decode(v)]));
 if(value.t==='set')return new Set(value.v.map(decode));if(value.t==='array')return value.v.map(decode);
 if(value.t==='object'){const out={};for(const[k,v]of value.v)Object.defineProperty(out,k,{value:decode(v),enumerable:true,writable:true,configurable:true});return out;}
 throw fail('REVIEW_PLAN_CORRUPT','窗口结果类型记录未知');
}
const rootOf=scope=>resolve(scope?.planRoot||process.env.DSH_REVIEW_PLAN_ROOT||DEFAULT_ROOT);
function assertId(id,name='运行'){if(typeof id!=='string'||!id.length||id.length>240||!/^[-A-Za-z0-9_.:/]+$/.test(id))throw fail('REVIEW_PLAN_ID_INVALID',`${name}身份无效`,400);}
const planIdFor=id=>{assertId(id);return'p'+hash(id);};
function scopeIdentity(scope){
 if(!scope)throw fail('REVIEW_PLAN_SCOPE_REQUIRED','窗口执行缺少来源运行范围',400);assertId(scope.jobRunId);
 if(!scope.binding||typeof scope.binding!=='object'||typeof scope.binding.versionId!=='string'||!scope.binding.versionId
  ||!/^([a-f0-9]{64})$/.test(scope.binding.workSha256||'')||!/^([a-f0-9]{64})$/.test(scope.binding.sourceSha256||'')
  ||!Number.isSafeInteger(scope.binding.mutationEpoch)||scope.binding.mutationEpoch<0)
  throw fail('REVIEW_PLAN_BINDING_REQUIRED','窗口执行缺少可信来源版本、摘要或修改序号',400);
 return clean({sessionId:scope.sessionId||null,workspaceId:scope.workspaceId||null,purpose:scope.purpose||'unknown',verificationRunId:scope.verificationRunId||null,binding:scope.binding,recipe:scope.recipe||null,endpointIdentity:scope.endpointIdentity||null});
}
async function directory(path,create=false){
 const absolute=resolve(path);let cursor=parse(absolute).root;
 for(const part of relative(cursor,absolute).split(sep).filter(Boolean)){
  cursor=join(cursor,part);let info;try{info=await lstat(cursor);}catch(e){if(!create||e.code!=='ENOENT')throw e;try{await mkdir(cursor);}catch(c){if(c.code!=='EEXIST')throw c;}info=await lstat(cursor);}
  if(!info.isDirectory()||info.isSymbolicLink())throw fail('REVIEW_PLAN_PATH_INVALID','来源计划目录不是真实目录');
  try{await lstat(join(cursor,'complete.json'));throw fail('REVIEW_PLAN_SEALED','不能写入或恢复封存运行中的来源计划',409);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 const physical=resolve(await realpath(absolute));if(process.platform==='win32'?physical.toLowerCase()!==absolute.toLowerCase():physical!==absolute)throw fail('REVIEW_PLAN_PATH_INVALID','来源计划目录身份不一致');return absolute;
}
async function bytes(path){await directory(dirname(path));const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw fail('REVIEW_PLAN_PATH_INVALID','来源计划文件不是真实普通文件');return readFile(path);}
async function optional(path){try{return await bytes(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function synced(path,value){const file=await open(path,'wx');try{await file.writeFile(value);await file.sync();}finally{await file.close();}}
async function syncDir(path){let file;try{file=await open(path,'r');await file.sync();}catch(e){if(!['EPERM','EISDIR','EINVAL','ENOTSUP'].includes(e.code))throw e;}finally{await file?.close();}}
async function replace(from,to){const delays=[20,40,80,160,320];for(let i=0;;i++){try{await rename(from,to);return;}catch(e){if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(e.code)||i>=delays.length)throw e;await new Promise(r=>setTimeout(r,delays[i]));}}}
async function atomic(path,value,hook){const temp=path+'.'+randomUUID()+'.tmp';try{await synced(temp,value);await hook?.({path,temporary:temp});await replace(temp,path);await syncDir(dirname(path));}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
async function immutable(path,value){const old=await optional(path);if(old){if(!old.equals(Buffer.from(value)))throw fail('REVIEW_PLAN_IMMUTABLE_CONFLICT','不可变来源计划记录不同',409);return;}const temp=path+'.'+randomUUID()+'.tmp';try{await synced(temp,value);try{await link(temp,path);}catch(e){if(e.code!=='EEXIST'||!(await bytes(path)).equals(Buffer.from(value)))throw e;}await syncDir(dirname(path));}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
const runDir=(root,id)=>join(root,'runs',planIdFor(id));
function wrapped(value){return JSON.stringify({schemaVersion:1,sha256:hash(stable(value)),value})+'\n';}
async function readWrapped(path){let row;try{row=JSON.parse((await bytes(path)).toString());}catch(e){if(e.code==='ENOENT')throw e;throw fail('REVIEW_PLAN_CORRUPT','来源计划 JSON 损坏',500,e);}if(row.schemaVersion!==1||row.sha256!==hash(stable(row.value)))throw fail('REVIEW_PLAN_HASH_MISMATCH','来源计划校验失败');return row.value;}
async function readState(root,id){const state=await readWrapped(join(runDir(root,id),'state.json'));if(state.jobRunId!==id||state.planId!==planIdFor(id)||!Number.isSafeInteger(state.revision)||!state.units)throw fail('REVIEW_PLAN_CORRUPT','来源计划运行身份损坏');for(const[k,u]of Object.entries(state.units)){if(k!==u.unitId||!states.has(u.status)||u.status==='running'&&!u.lease||u.status==='completed'&&!u.outputReceipt)throw fail('REVIEW_PLAN_CORRUPT','来源单元状态损坏');}return state;}
async function commit(root,state,hooks){state.revision++;state.updatedAt=now();await atomic(join(runDir(root,state.jobRunId),'state.json'),wrapped(state),hooks?.beforeStateRename);await hooks?.afterStateCommit?.({state:structuredClone(state)});}
async function locked(root,fn){await directory(root,true);return withArkExecutionStoreLock({storageRoot:root,poolId:'review-plan-ledger'},fn);}
function declaration(unit){assertId(unit.unitId||unit.id,'窗口');return clean({unitId:unit.unitId||unit.id,stage:unit.stage||'window',parentUnitId:unit.parentUnitId||null,required:unit.required!==false,source:unit.source||null,conditional:unit.conditional===true});}
function unitRow(unit){return{...declaration(unit),status:'queued',createdAt:now(),updatedAt:now(),lease:null,inputSha256:null,outputReceipt:null,requestReceipts:[],reuseReceipt:null,sourceCoverageGaps:[],error:null};}

export async function prepareReviewPlan({scope,plan,fromRunId=scope?.resumedFromRunId||null,faultHooks}={}){
 const root=rootOf(scope),identity=scopeIdentity(scope),input=clean(plan);if(!input||!Array.isArray(input.units))throw fail('REVIEW_PLAN_INVALID','必须先登记来源单元分母',400);
 const definitions=input.units.map(declaration);if(new Set(definitions.map(u=>u.unitId)).size!==definitions.length)throw fail('REVIEW_PLAN_INVALID','来源单元身份重复',400);
 const planFingerprint=reviewPlanFingerprint({identity,plan:{...input,units:definitions}});if(fromRunId===scope.jobRunId)throw fail('REVIEW_PLAN_RESUME_CONFLICT','补审必须创建新的运行',409);
 let transportApproval=null;if(fromRunId&&scope.checkpointTransportRebase){const old=await readWrapped(join(runDir(root,fromRunId),'manifest.json'));transportApproval=await verifyTransportRebaseApproval({scope,fromRunId,priorManifest:old,plan:{...input,units:definitions}});}
 const manifest={schemaVersion:1,planId:planIdFor(scope.jobRunId),jobRunId:scope.jobRunId,identity,plan:{...input,units:definitions},planFingerprint,fromRunId:fromRunId||null,...(transportApproval?{transportRebaseApproval:scope.checkpointTransportRebase}:{})};
 await locked(root,async()=>{
  const previous=await optional(join(runDir(root,scope.jobRunId),'manifest.json'));
  if(previous){const saved=await readWrapped(join(runDir(root,scope.jobRunId),'manifest.json'));if(stable(saved)!==stable(manifest))throw fail('REVIEW_PLAN_OPERATION_CONFLICT','同一运行不能更换来源计划',409);try{await readState(root,scope.jobRunId);return;}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(fromRunId){assertId(fromRunId);let prior;try{prior=await readWrapped(join(runDir(root,fromRunId),'manifest.json'));}catch(e){if(e.code==='ENOENT')throw fail('REVIEW_PLAN_RESUME_MISSING','补审来源计划不存在',409,e);throw e;}
   if(prior.planFingerprint!==planFingerprint&&!transportApproval)throw fail('REVIEW_PLAN_RESUME_CONFLICT','来源版本、配置或上下文计划已变化，不能复用旧窗口',409);
   const state=await readState(root,fromRunId);for(const unit of Object.values(state.units)){if(unit.status==='running'||!transportApproval&&(unit.status==='unknown_sent'||unit.requestReceipts?.some(r=>r?.status==='unknown_sent')))throw fail('REVIEW_PLAN_UNKNOWN_SENT','原运行有进行中或结果未知请求，禁止自动重发',409);}
  }
  const dir=runDir(root,scope.jobRunId);await directory(dir,true);await directory(join(dir,'outputs'),true);await directory(join(dir,'inputs'),true);
  await immutable(join(dir,'manifest.json'),wrapped(manifest));const state={schemaVersion:1,planId:manifest.planId,jobRunId:scope.jobRunId,planFingerprint,fromRunId:fromRunId||null,revision:0,createdAt:now(),updatedAt:now(),units:Object.fromEntries(definitions.map(u=>[u.unitId,unitRow(u)]))};
  await atomic(join(dir,'state.json'),wrapped(state),faultHooks?.beforeStateRename);
 });
 if(Object.isExtensible(scope)){scope.planId=manifest.planId;scope.planFingerprint=planFingerprint;}
 return{planId:manifest.planId,jobRunId:scope.jobRunId,planFingerprint,manifest,reusedFromRunId:fromRunId||null};
}

export async function registerReviewUnits({scope,units,faultHooks}={}){
 const root=rootOf(scope);scopeIdentity(scope);return locked(root,async()=>{const state=await readState(root,scope.jobRunId);let changed=false;for(const entry of units||[]){const u=declaration(entry),old=state.units[u.unitId];if(old){const prior=declaration(old);if(stable(prior)!==stable(u))throw fail('REVIEW_PLAN_UNIT_CONFLICT','来源单元声明改变',409);}else{if(u.parentUnitId&&!state.units[u.parentUnitId])throw fail('REVIEW_PLAN_UNIT_CONFLICT','来源单元父项未登记',409);state.units[u.unitId]=unitRow(u);changed=true;}}if(changed)await commit(root,state,faultHooks);return{planId:state.planId,registered:state.units};});
}
async function outputFor(root,id,receipt){const value=await readWrapped(join(runDir(root,id),'outputs',receipt.file));if(value.outputSha256!==receipt.outputSha256||hash(stable(value.encoded))!==receipt.outputSha256||value.unitId!==receipt.unitId||value.inputSha256!==receipt.inputSha256)throw fail('REVIEW_PLAN_CHECKPOINT_MISMATCH','来源窗口检查点校验失败');return decode(value.encoded);}
function attach(output,receipt){if(output&&typeof output==='object'&&!Array.isArray(output))return Object.assign(output,{checkpointReceipt:receipt});return{output,checkpointReceipt:receipt};}
function errorChain(error){const chain=[],seen=new Set();for(let e=error;e&&typeof e==='object'&&!seen.has(e);e=e.cause){seen.add(e);chain.push(e);}return chain;}
function unknown(error){return errorChain(error).some(e=>e.arkAttemptReceipt?.status==='unknown_sent'||/UNKNOWN_SENT/.test(e.code||''));}
export async function runReviewUnit({scope,unitId,stage='window',parentUnitId=null,required=true,input,execute,validate,faultHooks}={}){
 if(typeof execute!=='function'||typeof validate!=='function')throw fail('REVIEW_PLAN_CALLBACK_REQUIRED','来源单元必须提供执行和结果校验',400);
 const root=rootOf(scope);scopeIdentity(scope);assertId(unitId,'窗口');const inputValue=clean(input),inputSha256=reviewPlanFingerprint(inputValue),owner=await createJobOwner();
 let claimed=await locked(root,async()=>{
  const state=await readState(root,scope.jobRunId);let unit=state.units[unitId];if(!unit){if(parentUnitId&&!state.units[parentUnitId])throw fail('REVIEW_PLAN_UNIT_CONFLICT','来源单元父项未登记',409);unit=state.units[unitId]=unitRow({unitId,stage,parentUnitId,required});}
  await directory(join(runDir(root,scope.jobRunId),'inputs'),true);
  await immutable(join(runDir(root,scope.jobRunId),'inputs',inputSha256+'.json'),wrapped({inputSha256,input:inputValue}));
  unit.inputReceipt={inputSha256,file:inputSha256+'.json'};
  if(unit.inputSha256&&unit.inputSha256!==inputSha256)throw fail('REVIEW_PLAN_UNIT_INPUT_CONFLICT','同一窗口的实际输入或依赖改变',409);
  if(unit.status==='running'){if(await isJobOwnerAlive(unit.lease.owner))throw fail('REVIEW_PLAN_UNIT_BUSY','窗口由存活进程执行',409);await recoverUnitState(state,unit,{executionRoot:scope.executionRoot,poolId:scope.poolId});await commit(root,state,faultHooks);if(unit.status==='unknown_sent')throw fail('REVIEW_PLAN_UNKNOWN_SENT',unit.error.message,409);}
  if(unit.status==='unknown_sent'||unit.requestReceipts?.some(r=>r?.status==='unknown_sent'))throw fail('REVIEW_PLAN_UNKNOWN_SENT','窗口有已发出但结果未知的请求，禁止自动重发',409);
  if(unit.status==='completed'){const output=await outputFor(root,state.jobRunId,unit.outputReceipt);return{output,receipt:{...unit.outputReceipt,status:'completed',planId:state.planId,reused:true,fromRunId:unit.reuseReceipt?.fromRunId||state.jobRunId}};}
  let resumeOutput=null,previousCheckpoint=null;
  if(state.fromRunId){const previous=await readState(root,state.fromRunId),old=previous.units[unitId],transport=state.planFingerprint!==previous.planFingerprint&&scope.checkpointTransportRebase; if(transport){const prior=await readWrapped(join(runDir(root,state.fromRunId),'manifest.json'));await verifyTransportRebaseApproval({scope,fromRunId:state.fromRunId,priorManifest:prior});if(old?.inputReceipt&&!await rebaseInputMatches(root,state.fromRunId,old,inputValue))throw fail('REVIEW_PLAN_RESUME_CONFLICT','非运输窗口输入变化，拒绝复用',409);}if(old?.status==='running'||!transport&&(old?.status==='unknown_sent'||old?.requestReceipts?.some(r=>r?.status==='unknown_sent')))throw fail('REVIEW_PLAN_UNKNOWN_SENT','补审来源窗口仍进行中或结果未知',409);if(old?.outputReceipt&&!transport){if(old.inputSha256!==inputSha256)throw fail('REVIEW_PLAN_RESUME_CONFLICT','窗口实际输入或依赖已变化，禁止续用旧部分结果',409);resumeOutput=await outputFor(root,previous.jobRunId,old.outputReceipt);previousCheckpoint=old.outputReceipt;}if(old?.status==='completed'){if(transport)await authenticatedRebaseUnit(scope,state.fromRunId,unitId);
    if(old.inputSha256!==inputSha256&&!transport)throw fail('REVIEW_PLAN_RESUME_CONFLICT','窗口的实际纲要、案例、提示词或来源范围改变',409);
    const output=await outputFor(root,previous.jobRunId,old.outputReceipt),encoded=encode(output),outputSha256=hash(stable(encoded)),file=hash(unitId)+'-'+outputSha256+'.json';
    const receipt={unitId,inputSha256,outputSha256,file,status:'completed',planId:state.planId,reused:true,fromRunId:previous.jobRunId};
    await immutable(join(runDir(root,state.jobRunId),'outputs',file),wrapped({unitId,inputSha256,outputSha256,encoded}));Object.assign(unit,{status:'completed',inputSha256,outputReceipt:receipt,reuseReceipt:{fromRunId:previous.jobRunId,outputSha256,...(transport?{sourceInputSha256:old.inputSha256,transportRebaseApprovalSha256:scope.checkpointTransportRebase.sha256}:{})},requestReceipts:[],sourceCoverageGaps:old.sourceCoverageGaps||[],updatedAt:now()});await commit(root,state,faultHooks);return{output,receipt};
   }}
  const token=randomUUID();Object.assign(unit,{status:'running',inputSha256,lease:{owner,token},startedAt:now(),updatedAt:now(),error:null});await commit(root,state,faultHooks);return{token,planId:state.planId,planFingerprint:state.planFingerprint,resumeOutput,previousCheckpoint};
 });
 if(claimed.receipt)return attach(claimed.output,claimed.receipt);
 const requestReceipts=[];let output,status='failed',error=null;
 try{
  const result=await withArkScope({...scope,planId:claimed.planId,planFingerprint:claimed.planFingerprint,unitId,unitInputSha256:inputSha256,stage,parentUnitId,requestReceipts},()=>execute({resumeOutput:claimed.resumeOutput,previousCheckpoint:claimed.previousCheckpoint}));
  const checked=await validate(result);if(!checked||!states.has(checked.status)||['queued','running'].includes(checked.status)||!Object.hasOwn(checked,'output'))throw fail('REVIEW_PLAN_VALIDATION_FAILED','窗口校验必须返回明确状态与完整结果');
  output=checked.output;status=checked.status;
 }catch(cause){error=cause;for(const e of errorChain(cause)){const r=e.arkAttemptReceipt;if(r&&!requestReceipts.some(old=>old===r||r.attemptId&&old?.attemptId===r.attemptId))requestReceipts.push(r);}status=unknown(cause)?'unknown_sent':cause?.name==='AbortError'||scope.signal?.aborted?'cancelled':'failed';output={ok:false,error:cause};}
 if(requestReceipts.some(r=>r?.status==='unknown_sent'||r?.usageState==='unknown_sent'))status='unknown_sent';
 const encoded=encode(output),outputSha256=hash(stable(encoded));
 const receipt=await locked(root,async()=>{const state=await readState(root,scope.jobRunId),unit=state.units[unitId];if(unit?.status!=='running'||unit.lease?.token!==claimed.token||stable(unit.lease.owner)!==stable(owner))throw fail('REVIEW_PLAN_LEASE_CONFLICT','窗口执行身份已经改变',409);
  const file=hash(unitId)+'-'+outputSha256+'.json';await immutable(join(runDir(root,state.jobRunId),'outputs',file),wrapped({unitId,inputSha256,outputSha256,encoded}));
  const receipt={planId:state.planId,unitId,inputSha256,outputSha256,file,status,reused:false,fromRunId:null};Object.assign(unit,{status,lease:null,outputReceipt:receipt,requestReceipts:clean(requestReceipts),sourceCoverageGaps:clean(Array.isArray(output?.gaps)?output.gaps:[]),finishedAt:now(),updatedAt:now(),error:error?clean(error):null});await commit(root,state,faultHooks);return receipt;
 });
 if(error){const thrown=new Error(error.message||'来源单元执行失败',{cause:error});for(const key of ['name','code','status','safeToRetry','arkAttemptReceipt'])if(error[key]!==undefined)thrown[key]=error[key];thrown.checkpointReceipt=receipt;throw thrown;}return attach(output,receipt);
}

export async function readReviewPlanCoverage({scope,jobRunId=scope?.jobRunId,planId,storageRoot}={}){
 const root=storageRoot?resolve(storageRoot):rootOf(scope);if(!jobRunId){if(planId)throw fail('REVIEW_PLAN_ID_INVALID','只读查询需要运行身份',400);return null;}assertId(jobRunId);
 if(planId&&planId!==planIdFor(jobRunId))throw fail('REVIEW_PLAN_ID_INVALID','来源计划与运行身份不一致',400);
 let manifest,state;try{manifest=await readWrapped(join(runDir(root,jobRunId),'manifest.json'));state=await readState(root,jobRunId);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 const units=Object.values(state.units).map(u=>({...u,lease:u.lease?{owner:u.lease.owner}:null}));const required=units.filter(u=>u.required&& !u.parentUnitId),counts=Object.fromEntries([...states].map(s=>[s,required.filter(u=>u.status===s).length]));
 const gapMap=new Map([...(manifest.plan.sourceCoverageGaps||[]),...units.flatMap(u=>u.sourceCoverageGaps||[])].map(g=>[stable(g),g]));
 return{schemaVersion:1,planId:state.planId,jobRunId,planFingerprint:state.planFingerprint,fromRunId:state.fromRunId,revision:state.revision,identity:manifest.identity,config:manifest.plan.config||null,sourceCoverageGaps:[...gapMap.values()],total:required.length,completed:counts.completed,partial:counts.partial,failed:counts.failed,unknownSent:counts.unknown_sent,pending:counts.queued+counts.running,counts,logicalTaskCount:units.length,reused:units.filter(u=>u.reuseReceipt).length,units};
}

// The brand cannot survive JSON copies or be manufactured from ledger metadata.
const verifiedSourceUnits=new WeakSet();
export const isVerifiedReviewSourceUnit=unit=>!!unit&&verifiedSourceUnits.has(unit);
const sourceParts={paragraph:'document.xml',footnote:'footnotes.xml',endnote:'endnotes.xml'};
const sourceFields=['target','index','part','noteId','pid','sourceXmlNodeId','sourceXmlParagraphOrdinal','sourceXmlTableNodeId','tableIdx','sourcePackageSha256','sourceVersionId'];
const sourcePart=value=>typeof value==='string'?value.replace(/^word\//,''):value;
const sourceValue=(entry,key)=>key==='part'?sourcePart(entry[key]):key==='noteId'?entry[key]==null?null:String(entry[key]):entry[key]??null;
const sourceOwner=(a,b)=>sourceFields.every(key=>sourceValue(a,key)===sourceValue(b,key));
const sourceOwnerKey=entry=>stable(sourceFields.map(key=>sourceValue(entry,key)));
const primaryIndexes=new WeakMap();
function freezeProof(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const v of Object.values(value))freezeProof(v);Object.freeze(value);}return value;}
function sourceUnicode(text){for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;}
const checkpointMismatch=message=>fail('REVIEW_PLAN_CHECKPOINT_MISMATCH',message);
function sourceEntries(input){return Array.isArray(input?.sourceContext?.entries)?input.sourceContext.entries:Array.isArray(input?.win)?input.win:null;}
function sourceText(entry){return entry?.sentText??entry?.text;}
function validatePrimaryRanges(manifest,unit,input){
 const ranges=unit.source?.primaryRanges;if(!Array.isArray(ranges)||!ranges.length)return null;
 const plan=manifest.plan.primarySourcePlan;if(!plan||!Array.isArray(plan.windows)||!Array.isArray(plan.nodes))throw checkpointMismatch('主来源检查点缺少不可变原始窗口');
 let index=primaryIndexes.get(manifest);if(!index){const {manifestSha256,proof,...original}=plan;
  if(manifestSha256!==reviewPlanFingerprint(original))throw checkpointMismatch('主来源窗口清单指纹不一致');
  const nodes=new Map(plan.nodes.map(n=>[sourceOwnerKey(n),n])),pieces=new Map();for(const e of plan.windows.flatMap(w=>w.entries)){const key=sourceOwnerKey(e);if(!pieces.has(key))pieces.set(key,[]);pieces.get(key).push(e);}
  for(const[key,node]of nodes){const list=(pieces.get(key)||[]).sort((a,b)=>a.rawStart-b.rawStart);let at=0,text='';for(const e of list){if(e.rawStart!==at||e.rawEnd<at||typeof e.text!=='string'||e.text.length!==e.rawEnd-e.rawStart||!sourceUnicode(e.text))throw checkpointMismatch('不可变主来源窗口遗漏或Unicode边界无效');at=e.rawEnd;text+=e.text;}if(!list.length||at!==node.length||hash(text)!==node.textSha256)throw checkpointMismatch('不可变主来源节点文字或摘要不一致');}
  index={nodes,pieces};primaryIndexes.set(manifest,index);
 }
 const entries=sourceEntries(input);if(!entries)throw checkpointMismatch('主来源输入缺少实际文本范围');
 if(input.sourceContext&&(input.sourceContext.rejectedEntries?.length||input.sourceContext.sourcePackageSha256!==manifest.identity.binding.workSha256||input.sourceContext.sourceVersionId!==manifest.identity.binding.versionId))throw checkpointMismatch('主来源输入版本或回读不一致');
 return ranges.map(range=>{
  if(!sourceParts[range.target]||!Number.isSafeInteger(range.index)||range.index<0||!Number.isSafeInteger(range.rawStart)||!Number.isSafeInteger(range.rawEnd)||range.rawStart<0||range.rawEnd<range.rawStart||range.offsetUnit!=='utf16'||range.textView!=='after'||sourcePart(range.part)!==sourceParts[range.target])throw checkpointMismatch('主来源范围或坐标无效');
  const key=sourceOwnerKey(range),node=index.nodes.get(key);if(!node||range.rawEnd>node.length||range.sourcePackageSha256!==manifest.identity.binding.workSha256||range.sourceVersionId!==manifest.identity.binding.versionId)throw checkpointMismatch('主来源范围与送审节点身份不一致');
  const pieces=(index.pieces.get(key)||[]).filter(e=>e.rawEnd>=range.rawStart&&e.rawStart<=range.rawEnd);
  let at=range.rawStart,text='';for(const piece of pieces){if(piece.rawEnd<=at&&range.rawStart!==range.rawEnd)continue;const start=Math.max(at,piece.rawStart),end=Math.min(range.rawEnd,piece.rawEnd);if(start!==at||typeof piece.text!=='string'||piece.text.length!==piece.rawEnd-piece.rawStart)throw checkpointMismatch('主来源文本范围不连续');text+=piece.text.slice(start-piece.rawStart,end-piece.rawStart);at=end;if(at===range.rawEnd)break;}
  if(at!==range.rawEnd||!pieces.length||!sourceUnicode(text))throw checkpointMismatch('主来源文本缺失或Unicode边界不完整');
  const exposed=entries.find(e=>sourcePart(e.part)===sourcePart(range.part)&&e.target===range.target&&e.index===range.index&&e.rawStart===range.rawStart&&e.rawEnd===range.rawEnd);
  if(!exposed||sourceText(exposed)!==text||['noteId','pid','sourceXmlNodeId','sourceXmlParagraphOrdinal','sourceXmlTableNodeId','sourcePackageSha256'].some(k=>sourceValue(exposed,k)!==sourceValue(range,k)))throw checkpointMismatch('输入声明没有对应实际主来源文本');
  // Table/source-version fields may be absent in a captured context; immutable
  // plan/window geometry carries them. Explicit conflicting claims still fail.
  for(const key of ['sourceVersionId','tableIdx','tableIndex'])if(exposed[key]!=null&&exposed[key]!==range[key])throw checkpointMismatch('输入主来源版本或表格身份冲突');
  return{range,text};
 });
}
function assertOutputSources(output,primary){
 const contexts=output?.sourceContext?[output.sourceContext]:Array.isArray(output?.issueBatches)?output.issueBatches.map(b=>b.sourceContext):[];
 if(!contexts.length)return false;
 for(const{range,text}of primary){const exposed=contexts.flatMap(c=>c?.entries||[]).find(e=>e.target===range.target&&e.index===range.index&&sourcePart(e.part)===sourcePart(range.part)&&e.rawStart===range.rawStart&&e.rawEnd===range.rawEnd);
  if(!exposed||sourceText(exposed)!==text||['noteId','pid','sourceXmlNodeId','sourceXmlParagraphOrdinal','sourceXmlTableNodeId','sourcePackageSha256'].some(k=>sourceValue(exposed,k)!==sourceValue(range,k)))throw checkpointMismatch('输出主来源与不可变输入不一致');
  const context=contexts.find(c=>c?.entries?.includes(exposed));if(context.rejectedEntries?.length||context.sourcePackageSha256!==range.sourcePackageSha256||context.sourceVersionId!==range.sourceVersionId)throw checkpointMismatch('输出主来源版本或回读不一致');
 }
 return true;
}
function actualPrimaryBody(body,primary,input,manifest,owner){
 if(typeof body?.input!=='string')throw checkpointMismatch('主来源物理请求缺少文本输入');
 const models=[input.model,...(input.modelChain||manifest.plan.config?.modelChain||[])].filter(Boolean);
 const fixedEndpoints=manifest.identity.endpointIdentity?.modelEndpoints;
 if(fixedEndpoints){
  let selected;try{const fixed=verifyArkModelEndpointConfig(fixedEndpoints),requested=owner?.modelResolution?.requestedModel;
   if(!models.includes(requested))throw new Error('unregistered input model');
   selected=resolveArkModelEndpoint(requested,fixed);
   const planChoice=manifest.plan.config?.modelResolution;
   if(!planChoice||stable(planChoice)!==stable(resolveArkModelEndpoint(manifest.plan.config.model,fixed)))throw new Error('plan model identity differs');
  }catch{throw checkpointMismatch('固定输入计划的模型与接入点配置无效');}
  if(body.model!==selected.resolvedModel||stable(owner.modelResolution)!==stable(selected))throw checkpointMismatch('实际请求模型名、接入点或配置指纹与固定计划不一致');
 }else if(!models.includes(body.model))throw checkpointMismatch('实际请求模型不属于固定输入计划');
 if(typeof input.prompt==='string'&&body.input!==input.prompt)throw checkpointMismatch('实际请求与检查点提示词不同');
 if(input.instructions!=null&&body.instructions!==input.instructions)throw checkpointMismatch('实际请求指令与检查点不同');
 for(const{range,text}of primary){let found=false;const regex=/\[primary ([^\]\r\n]*)\] /g;for(const match of body.input.matchAll(regex)){
   const marker=Object.fromEntries(match[1].split(';').map(p=>{const n=p.indexOf('=');return[p.slice(0,n),p.slice(n+1)];}));
   if(marker.target===range.target&&marker.index===String(range.index)&&marker.rawStart===String(range.rawStart)&&marker.rawEnd===String(range.rawEnd)&&sourcePart(marker.part)===sourcePart(range.part)&&String(marker.noteId??null)===String(range.noteId??null)&&(!range.inTable||marker.tableIndex===String(range.tableIndex)&&marker.tableXml===String(range.sourceXmlTableNodeId||''))&&body.input.slice(match.index+match[0].length).startsWith(text)){found=true;break;}
  }if(!found)throw checkpointMismatch('实际请求未发送已声明的主来源范围（旁带材料不抵覆盖）');
 }
}
function responseText(raw,stream){
 const extract=data=>{if(typeof data?.output_text==='string'&&data.output_text)return data.output_text;return(data?.output||[]).filter(v=>v.type==='message').flatMap(v=>v.content||[]).filter(v=>v.type==='output_text').map(v=>v.text||'').join('');};
 if(!stream){try{return extract(JSON.parse(raw.toString('utf8')));}catch(e){throw checkpointMismatch('已确认原始响应不是可读取JSON');}}
 let text='',final=null;for(const line of raw.toString('utf8').split('\n'))if(line.startsWith('data:')){let event;try{event=JSON.parse(line.slice(5).trim());}catch{continue;}if(['response.failed','error'].includes(event.type))throw checkpointMismatch('原始SSE含失败终态');if(event.type==='response.output_text.delta')text+=event.delta||'';if(event.type==='response.completed')final=event.response;}
 return text||(final?extract(final):'');
}
function replyIssues(text){try{const trim=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');let parsed;try{parsed=JSON.parse(trim);}catch{parsed=JSON.parse(trim.slice(trim.indexOf('{'),trim.lastIndexOf('}')+1));}return Array.isArray(parsed.issues)&&parsed.issues.every(i=>i&&typeof i==='object'&&!Array.isArray(i))?parsed.issues:null;}catch{return null;}}
function coversPrimary(primary,certified){return primary.every(({range})=>{const pieces=certified.filter(e=>sourceOwner(e,range)&&e.rawStart>=range.rawStart&&e.rawEnd<=range.rawEnd).sort((a,b)=>a.rawStart-b.rawStart);let at=range.rawStart,seen=false;for(const p of pieces){if(p.rawStart>at)return false;seen=true;at=Math.max(at,p.rawEnd);}return seen&&at===range.rawEnd;});}

/** Read-only deep authentication. Cheap metadata coverage deliberately remains separate. */
export async function verifyReviewPlanCheckpoints({scope}={}){
 const identity=scopeIdentity(scope),root=rootOf(scope),coverage=await readReviewPlanCoverage({scope});if(!coverage)return null;
 const runs=new Map(),attempts=new Map(),checking=new Set(),verified=new Map();
 async function readRun(id){if(runs.has(id))return runs.get(id);const manifest=await readWrapped(join(runDir(root,id),'manifest.json')),state=await readState(root,id);
  if(manifest.schemaVersion!==1||manifest.jobRunId!==id||manifest.planId!==state.planId||manifest.planFingerprint!==state.planFingerprint||manifest.fromRunId!==state.fromRunId||reviewPlanFingerprint({identity:manifest.identity,plan:manifest.plan})!==manifest.planFingerprint||stable(manifest.identity)!==stable(identity))throw checkpointMismatch('来源计划、状态或运行身份不一致');
  for(const original of manifest.plan.units||[])if(!state.units[original.unitId]||stable(declaration(state.units[original.unitId]))!==stable(original))throw checkpointMismatch('原始来源任务声明被更换');
  const run={manifest,state};runs.set(id,run);return run;
 }
 async function inputFor(id,unit){const receipt=unit.inputReceipt;if(!receipt||receipt.inputSha256!==unit.inputSha256||receipt.file!==unit.inputSha256+'.json'||!/^[a-f0-9]{64}$/.test(unit.inputSha256||''))throw checkpointMismatch('窗口输入回执缺失或不一致');const saved=await readWrapped(join(runDir(root,id),'inputs',receipt.file));if(saved.inputSha256!==unit.inputSha256||reviewPlanFingerprint(saved.input)!==unit.inputSha256)throw checkpointMismatch('窗口不可变输入校验失败');return saved.input;}
 async function verify(id,unitId){const key=id+'\0'+unitId;if(verified.has(key))return verified.get(key);if(checking.has(key))throw checkpointMismatch('来源复用或父子检查点存在循环');checking.add(key);
  try{const{manifest,state}=await readRun(id),unit=state.units[unitId];if(!unit||unit.status!=='completed')return null;
   const receipt=unit.outputReceipt;if(receipt.status!=='completed'||receipt.unitId!==unitId||receipt.inputSha256!==unit.inputSha256||receipt.file!==hash(unitId)+'-'+receipt.outputSha256+'.json'||receipt.planId!==state.planId)throw checkpointMismatch('窗口输出回执身份不一致');
   const input=await inputFor(id,unit),output=await outputFor(root,id,receipt),primary=validatePrimaryRanges(manifest,unit,input);let physical=[],children=[],basis='artifacts-only',certified=false;
   if(unit.reuseReceipt&&unit.reuseReceipt.transportRebaseApprovalSha256){const oldId=unit.reuseReceipt.fromRunId,ref=manifest.transportRebaseApproval;if(oldId!==state.fromRunId||receipt.fromRunId!==oldId||!ref||ref.sha256!==unit.reuseReceipt.transportRebaseApprovalSha256)throw checkpointMismatch('运输复用来源与固定批准不同');const oldManifest=await readWrapped(join(runDir(root,oldId),'manifest.json'));await verifyTransportRebaseApproval({scope:{...scope,checkpointTransportRebase:ref},fromRunId:oldId,priorManifest:oldManifest,plan:manifest.plan});const old=await authenticatedRebaseUnit(scope,oldId,unitId);if(old.inputSha256!==unit.reuseReceipt.sourceInputSha256||old.outputReceipt.outputSha256!==receipt.outputSha256||stable(old.source)!==stable(unit.source)||!await rebaseInputMatches(root,oldId,old,input))throw checkpointMismatch('运输复用实际来源、输入或输出不同');certified=isVerifiedReviewSourceUnit(old);for(const attemptId of old.verificationCertificate.physicalAttemptIds){const saved=await readArkAttempt({storageRoot:scope.executionRoot,poolId:scope.poolId,attemptId});physical.push({attemptId,bodySha256:saved.receipt.bodySha256,rawResponseSha256:saved.receipt.rawResponseSha256,requestFingerprint:saved.receipt.requestFingerprint});}children=[];basis='verified-transport-rebase-checkpoint';
   }else if(unit.reuseReceipt){const oldId=unit.reuseReceipt.fromRunId;if(oldId!==state.fromRunId||receipt.fromRunId!==oldId||unit.reuseReceipt.outputSha256!==receipt.outputSha256)throw checkpointMismatch('复用来源与显式新运行不一致');const prior=await verify(oldId,unitId),oldRun=await readRun(oldId),old=oldRun.state.units[unitId];if(!prior||old.inputSha256!==unit.inputSha256||old.outputReceipt.outputSha256!==receipt.outputSha256||stable(old.source)!==stable(unit.source)||oldRun.manifest.planFingerprint!==manifest.planFingerprint)throw checkpointMismatch('复用窗口输入、输出或来源不同');certified=prior.certified;physical=prior.physical;children=prior.children;basis='verified-prior-checkpoint';
   }else{
    for(const reference of unit.requestReceipts||[]){if(!reference?.attemptId)throw checkpointMismatch('物理请求回执身份缺失');let saved=attempts.get(reference.attemptId);if(!saved){saved=await readArkAttempt({storageRoot:scope.executionRoot,poolId:scope.poolId,attemptId:reference.attemptId});attempts.set(reference.attemptId,saved);}const actual=saved.receipt,request=saved.request,owner=request.scope;
     if(!actual||['attemptId','bodySha256','requestFingerprint','rawResponseSha256','bodyComplete','status','httpStatus'].some(k=>reference[k]!==actual[k]))throw checkpointMismatch('窗口引用与实际物理回执不同');
     let originalRun=id;if(reference.reused){if(reference.reuseRunId!==id||reference.fromRunId!==state.fromRunId)throw checkpointMismatch('已确认响应的物化来源不一致');originalRun=state.fromRunId;const prior=await readRun(originalRun);if(prior.manifest.planFingerprint!==manifest.planFingerprint)throw checkpointMismatch('已确认响应来源计划不同');}
     if(owner.jobRunId!==originalRun||owner.unitId!==unitId||owner.unitInputSha256!==unit.inputSha256||owner.planId!==planIdFor(originalRun)||owner.planFingerprint!==manifest.planFingerprint||stable(owner.binding)!==stable(manifest.identity.binding)||stable(owner.endpointIdentity||null)!==stable(manifest.identity.endpointIdentity)||(owner.recipe||null)!==manifest.identity.recipe)throw checkpointMismatch('实际请求不属于该来源、输入、端点或运行');
     if(actual.status==='unknown_sent'||!actual.bodyComplete&&actual.usageState!=='not_sent')throw checkpointMismatch('未知发送状态不能认证完成窗口');
     if(actual.status==='confirmed'&&actual.bodyComplete&&actual.httpStatus>=200&&actual.httpStatus<300){if(!saved.rawResponse||saved.rawResponse.length!==actual.rawResponseBytes)throw checkpointMismatch('已确认响应缺少完整原始字节');
      if(primary){actualPrimaryBody(request.body,primary,input,manifest,owner);const text=responseText(saved.rawResponse,request.body.stream),issues=replyIssues(text);
       // An earlier known 2xx can contain truncated/invalid model text. Its raw
       // artifact remains checked, but only the response actually materialized
       // into this output (or verified successful children) earns coverage.
       if(issues===null||output.ok===false||typeof output.text==='string'&&output.text!==text||Array.isArray(output.issues)&&stable(output.issues)!==stable(issues))continue;
       if(!assertOutputSources(output,primary))continue;
      }
      physical.push({attemptId:actual.attemptId,bodySha256:actual.bodySha256,rawResponseSha256:actual.rawResponseSha256,requestFingerprint:actual.requestFingerprint,jobRunId:owner.jobRunId,unitId:owner.unitId});
     }
    }
    if(primary&&physical.length){certified=true;basis='confirmed-physical-response';}
    else if(primary){const descendants=Object.values(state.units).filter(u=>u.parentUnitId===unitId&&u.status==='completed'),ranges=[];
     for(const child of descendants){const proof=await verify(id,child.unitId);if(proof?.certified&&child.source?.ruleId===unit.source?.ruleId){ranges.push(...child.source.primaryRanges);physical.push(...proof.physical);children.push(child.unitId,...proof.children);}}
     if(coversPrimary(primary,ranges)&&output.ok!==false&&!output.unknownSent&&!output.errors?.length){certified=true;basis='verified-child-primary-union';}
    }
   }
   const proof={certified,physical:[...new Map(physical.map(p=>[p.attemptId,p])).values()],children:[...new Set(children)],certificate:{schemaVersion:1,basis,jobRunId:id,planId:state.planId,planFingerprint:manifest.planFingerprint,unitId,inputSha256:unit.inputSha256,outputSha256:receipt.outputSha256,primaryRangesSha256:primary?reviewPlanFingerprint(unit.source.primaryRanges):null,physicalAttemptIds:[...new Set(physical.map(p=>p.attemptId))],sourceRunId:unit.reuseReceipt?.fromRunId||id,quality:'unverified'}};
   verified.set(key,proof);return proof;
  }finally{checking.delete(key);}
 }
 const current=await readRun(scope.jobRunId);if(current.state.revision!==coverage.revision)throw fail('REVIEW_PLAN_VERIFICATION_CHANGED','校验期间来源计划状态已变化，请重读',409);
 const units=[];for(const unit of coverage.units){const proof=unit.status==='completed'?await verify(scope.jobRunId,unit.unitId):null;const copy={...unit,...(proof?{verificationCertificate:proof.certificate}:{} )};if(proof?.certified){freezeProof(copy);verifiedSourceUnits.add(copy);}units.push(copy);}
 for(const[id,run]of runs)if((await readState(root,id)).revision!==run.state.revision)throw fail('REVIEW_PLAN_VERIFICATION_CHANGED','校验期间来源计划状态已变化，请重读',409);
 return{...coverage,units,verification:{schemaVersion:1,authenticatedCompleted:units.filter(u=>u.verificationCertificate).length,verifiedPrimaryUnits:units.filter(isVerifiedReviewSourceUnit).length,physicalAttempts:attempts.size,basis:'immutable-input/output-and-confirmed-physical-response',quality:'unverified'}};
}

/** Explicit startup recovery; read-only coverage never changes an active peer. */
async function recoverUnitState(state,unit,{executionRoot,poolId}={}){
 let known=false,proof=[];
 if(executionRoot){const summary=await readArkExecutionSummary({storageRoot:executionRoot,poolId,jobRunId:state.jobRunId});
  const attempts=summary.attempts.filter(a=>a.scope?.unitId===unit.unitId||a.scope?.unitId?.startsWith(unit.unitId+'/'));
  known=true;for(const attempt of attempts){
   if(attempt.scope.planFingerprint!==state.planFingerprint||attempt.status==='sending'||attempt.status==='unknown_sent'||!attempt.receipt){known=false;break;}
   const saved=await readArkAttempt({storageRoot:executionRoot,poolId,attemptId:attempt.id});
   if(saved.receipt.usageState!=='not_sent'&&!(saved.receipt.bodyComplete===true&&saved.rawResponse)){known=false;break;}
   proof.push({attemptId:attempt.id,status:saved.receipt.status,bodyComplete:saved.receipt.bodyComplete,rawResponseSha256:saved.receipt.rawResponseSha256||null});
  }
 }
 unit.status=known?'failed':'unknown_sent';unit.lease=null;unit.updatedAt=now();
 unit.recovery={reason:known?'known-response-await-materialization':'unknown-sent',physicalReceipts:proof};
 unit.error={code:known?'REVIEW_PLAN_MATERIALIZATION_PENDING':'REVIEW_PLAN_UNKNOWN_SENT',message:known?'已确认响应或未发送凭证保留，显式新运行可重建窗口结果':'执行者已停止，窗口是否完成未知；禁止自动重发'};
}
export async function recoverReviewPlans({scope,storageRoot,executionRoot=scope?.executionRoot,poolId=scope?.poolId,faultHooks}={}){
 const root=storageRoot?resolve(storageRoot):rootOf(scope);try{await directory(root);}catch(error){if(error.code==='ENOENT')return{recovered:[]};throw error;}
 return locked(root,async()=>{const recovered=[];let names;try{names=await readdir(join(root,'runs'));}catch(error){if(error.code==='ENOENT')return{recovered};throw error;}
  for(const name of names){if(!/^p[a-f0-9]{64}$/.test(name))throw fail('REVIEW_PLAN_CORRUPT','来源计划目录身份损坏');
   const manifest=await readWrapped(join(root,'runs',name,'manifest.json'));if(manifest.planId!==name||planIdFor(manifest.jobRunId)!==name)throw fail('REVIEW_PLAN_CORRUPT','来源计划清单身份损坏');
   const state=await readState(root,manifest.jobRunId);let changed=false;for(const unit of Object.values(state.units))if(unit.status==='running'&&!await isJobOwnerAlive(unit.lease.owner)){
    await recoverUnitState(state,unit,{executionRoot,poolId});changed=true;recovered.push({jobRunId:state.jobRunId,unitId:unit.unitId,status:unit.status});
   }if(changed)await commit(root,state,faultHooks);
  }return{recovered};
 });
}
