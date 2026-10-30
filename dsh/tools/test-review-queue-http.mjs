/** Owned loopback HTTP acceptance. Nine roots, generated OPC, no real provider. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,access,unlink} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer as httpServer} from 'node:http';
import {createServer as netServer} from 'node:net';
import {writeZip} from '../src/zip-write.js';

const evidenceEnvironment = process.env.DSH_VERIFICATION_EVIDENCE_DIR;
const verificationRunId = process.env.DSH_VERIFICATION_RUN_ID || null;
for(const key of Object.keys(process.env))if(/(?:ARK|OPENAI|DOUBAO|VOLC|ANTHROPIC)/i.test(key)||/^DSH_/i.test(key)
 ||/^(?:NODE_OPTIONS|NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key))delete process.env[key];

const PROJECT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const flag=(name,fallback)=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const phase=flag('phase','basic');assert.ok(['basic','full','sse-header','blocked','config'].includes(phase));
const SOURCE_ROOT=resolve(flag('source-root',PROJECT));
const ports=[Number(flag('port',3380)),Number(flag('peer-port',3381))];
for(const port of ports)assert.ok(Number.isInteger(port)&&port>0&&port<65536&&![3210,3211,3212].includes(port),'isolated port required');
assert.notEqual(...ports);
const evidenceRoot=resolve(flag('evidence-root',null)||evidenceEnvironment||join(PROJECT,'data/verify/review-queue'));
const RUN=join(evidenceRoot,`queue-http-${phase}-${Date.now()}-${randomUUID()}`);
await mkdir(RUN,{recursive:true});
const ROOTS=Object.fromEntries(['sessions','versions','workspaces','audit','legacy','ingestions','jobs','arkExecutions','reviewPlans'].map(kind=>[kind,join(RUN,kind)]));
await Promise.all(Object.values(ROOTS).map(path=>mkdir(path)));
const storage={storageRoot:ROOTS.jobs,sessionRoot:ROOTS.sessions,versionRoot:ROOTS.versions,workspaceRoot:ROOTS.workspaces};
let softwarePoolId='queue-http-software';
const sourceFiles=['server.mjs','src/review-server.js','src/review-runtime.js','src/job-store.js','src/review.js','src/ark.js','src/ark-execution-store.js','src/ark-execution-context.js','src/review-plan-store.js','src/session-store.js'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceHashes=()=>Promise.all(sourceFiles.map(async path=>[path,hash(await readFile(join(SOURCE_ROOT,path)))])).then(Object.fromEntries);
const report={generatedAt:new Date().toISOString(),verificationRunId,evidenceRoot,phase,run:RUN,roots:ROOTS,
 realArkCalls:0,paidModelCalls:0,meaningfulModelResponses:0,sourceRoot:SOURCE_ROOT,checks:[],requests:[],processes:[],providerRequests:[],
 sourceHashes:await sourceHashes(),testSha256:hash(await readFile(fileURLToPath(import.meta.url))),
 providerPolicy:'Only an owned loopback Responses stand-in; inherited provider/DSH/proxy/Node options cleared.'};
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
async function until(action,message,ms=40000){const end=Date.now()+ms;let last;while(Date.now()<end){last=await action();if(last)return last;await sleep(80);}throw new Error(`Timed out: ${message}`);}
async function bounded(action,ms,message){let timer;try{return await Promise.race([action,new Promise((done,reject)=>timer=setTimeout(()=>reject(new Error(message)),ms))]);}finally{clearTimeout(timer);}}
const children=new Map(),streams=new Set(),sockets=new Set(),held=new Set();
let provider=null,providerBase=null,providerMode='hold';
const FAKE_KEY='local-queue-http-owned-software-key';const FAKE_MODEL='queue-http-owned-software-model';
const bases=ports.map(port=>`http://127.0.0.1:${port}`);
const TERMINAL=new Set(['completed','partial','failed','cancelled','interrupted']);
let store,sessionStore;

function fixture(tag){
 const w='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
 const text=`${tag}。软件合约验收正文...只用于检验程序状态，不作为稿件质量结论。`.repeat(8);
 return writeZip([
  {name:'[Content_Types].xml',data:'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'},
  {name:'_rels/.rels',data:'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'},
  {name:'word/document.xml',data:`<w:document xmlns:w="${w}"><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>软件合约验收</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`},
 ]);
}

async function request(index,path,{body,bytes,headers={},expected}={}){
 const at=Date.now();const response=await fetch(bases[index]+path,{method:body!==undefined||bytes?'POST':'GET',
  headers:{...(body!==undefined?{'content-type':'application/json'}:bytes?{'content-type':'application/octet-stream'}:{}),...headers},
  body:body!==undefined?JSON.stringify(body):bytes,signal:AbortSignal.timeout(45000)});
 const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={raw:text};}
 report.requests.push({index,path,status:response.status,elapsedMs:Date.now()-at,data});
 if(expected!==undefined)assert.equal(response.status,expected,JSON.stringify(data));
 return{status:response.status,data,headers:response.headers};
}
async function json(index,path,options={}){const response=await request(index,path,options);assert.ok(response.status<300,JSON.stringify(response.data));return response.data;}
const rules={useModel:false,useRecheck:false,useContext:false,useCases:false};
const model={useModel:true,useRecheck:false,useContext:false,useCases:false,model:FAKE_MODEL};
async function upload(index,tag,workspace='whttpbasic'){
 const data=await json(index,`/api/upload?name=software-http.docx&workspace=${workspace}`,{bytes:fixture(tag)});
 assert.ok(data.id&&data.workVersion?.id,JSON.stringify(data));return data;
}
async function status(index,id,runId){return json(index,`/api/review-status?id=${id}${runId?`&runId=${runId}`:''}`);}
async function done(index,id,runId){return until(async()=>{const s=await status(index,id,runId);return TERMINAL.has(s.status)&&!s.running&&!s.waiting?s:null;},`terminal ${runId||id}`);}

async function openStream(index,id,{runId,afterSeq,lastEventId,options=rules,operationId,headerTimeoutMs=0}={}){
 const abort=new AbortController();const query=new URLSearchParams({id,detach:'1',...Object.fromEntries(Object.entries(options).map(([key,value])=>[key,String(value)]))});
 if(runId)query.set('runId',runId);if(afterSeq!==undefined)query.set('afterSeq',String(afterSeq));if(operationId)query.set('operationId',operationId);
 let headerTimer,response;
 if(headerTimeoutMs)headerTimer=setTimeout(()=>abort.abort(new Error(`SSE response headers not received within ${headerTimeoutMs}ms`)),headerTimeoutMs);
 try{response=await fetch(bases[index]+'/api/review-stream?'+query,{headers:lastEventId?{'last-event-id':lastEventId}:{},signal:abort.signal});}
 finally{clearTimeout(headerTimer);}
 assert.equal(response.status,200);assert.match(response.headers.get('content-type')||'',/event-stream/);
 const item={abort,events:[],error:null,ended:false,task:null};streams.add(item);
 item.task=(async()=>{const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
  try{while(true){const next=await reader.read();if(next.done)break;pending+=decoder.decode(next.value,{stream:true});const frames=pending.split(/\r?\n\r?\n/);pending=frames.pop();
   for(const frame of frames){const event=/^event: (.*)$/m.exec(frame)?.[1],data=/^data: (.*)$/m.exec(frame)?.[1],eventId=/^id: (.*)$/m.exec(frame)?.[1];
    if(event&&data)item.events.push({event,id:eventId,seq:Number(eventId?.split(':').at(-1)),data:JSON.parse(data)});}}
  }catch(error){if(!abort.signal.aborted){item.error=error.stack;throw error;}}
  finally{item.ended=true;streams.delete(item);}})();
 item.task.catch(()=>{});return item;
}
async function closeStream(item){item.abort.abort();await item.task.catch(()=>{});}

function respond(entry,{failed=false}={}){if(entry.res.destroyed||entry.res.writableEnded)return;held.delete(entry);entry.record.repliedAt=new Date().toISOString();entry.record.softwareStatus=failed?400:200;
 entry.res.writeHead(failed?400:200,{'content-type':'application/json'});
 entry.res.end(JSON.stringify(failed?{error:{type:'invalid_request_error',message:'software injected non-retryable provider failure'}}
  :{id:'local-'+randomUUID(),status:'completed',output_text:JSON.stringify({issues:[]}),usage:{input_tokens:0,output_tokens:0,total_tokens:0}}));}
async function startProvider(){provider=httpServer((req,res)=>{let body='';req.on('data',part=>body+=part);req.on('end',()=>{
  const record={path:req.url,method:req.method,arrivedAt:new Date().toISOString(),credentialMatched:req.headers.authorization===`Bearer ${FAKE_KEY}`,closedAt:null,repliedAt:null,bodySha256:hash(body)};
  report.providerRequests.push(record);const entry={res,record};held.add(entry);res.once('close',()=>{record.closedAt=new Date().toISOString();held.delete(entry);});
  if(providerMode==='drop'){res.writeHead(200,{'content-type':'application/json'});res.write('{"id":"local-owned-incomplete');setTimeout(()=>res.destroy(),20);return;}
  if(['auto','fail'].includes(providerMode))respond(entry,{failed:providerMode==='fail'});
 });});provider.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 await new Promise((done,reject)=>{provider.once('error',reject);provider.listen(0,'127.0.0.1',done);});
 providerBase=`http://127.0.0.1:${provider.address().port}/api/v3`;report.providerBase=providerBase;
}
function releaseProvider(){providerMode='auto';for(const entry of [...held])respond(entry);}

async function probePort(port){const probe=netServer();await new Promise((done,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));}
function environment(port,overrides={}){
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(?:ARK|OPENAI|DOUBAO|VOLC|ANTHROPIC)/i.test(key)&&!/^DSH_/i.test(key)
  &&!/^(?:NODE_OPTIONS|NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)));
 return{...env,PORT:String(port),HOST:'127.0.0.1',DSH_SESSION_ROOT:ROOTS.sessions,DSH_WORKING_VERSION_ROOT:ROOTS.versions,
  DSH_WORKSPACE_ROOT:ROOTS.workspaces,DSH_AUDIT_ROOT:ROOTS.audit,DSH_LEGACY_ROOT:ROOTS.legacy,DSH_INGESTION_ROOT:ROOTS.ingestions,
  DSH_JOB_ROOT:ROOTS.jobs,DSH_REVIEW_WORKERS:'1',DSH_ARK_EXECUTION_ROOT:ROOTS.arkExecutions,DSH_REVIEW_PLAN_ROOT:ROOTS.reviewPlans,
  DSH_ARK_POOL_ID:softwarePoolId,DSH_ARK_POOL_CONCURRENCY:'2',ARK_BASE_URL:providerBase,ARK_API_KEY:FAKE_KEY,ARK_MODEL:FAKE_MODEL,
  ARK_CONTEXT:'0',ARK_CASES:'0',ARK_CONSISTENCY:'0',ARK_PREFIX_CACHE:'0',...overrides};
}
async function startApp(index,overrides={}){await probePort(ports[index]);const processRecord={index,pid:null,port:ports[index],startedAt:new Date().toISOString(),stdout:'',stderr:'',stoppedAt:null,queueTimeoutMs:overrides.DSH_ARK_QUEUE_TIMEOUT_MS||null};
 const child=spawn(process.execPath,[join(SOURCE_ROOT,'server.mjs')],{cwd:SOURCE_ROOT,env:environment(ports[index],overrides),windowsHide:true,stdio:['ignore','pipe','pipe']});
 processRecord.pid=child.pid;report.processes.push(processRecord);children.set(index,{child,record:processRecord});
 child.stdout.on('data',data=>processRecord.stdout+=data);child.stderr.on('data',data=>processRecord.stderr+=data);
 await until(async()=>{if(child.exitCode!==null)throw new Error(`Owned server ${index} exited ${child.exitCode}: ${processRecord.stderr}`);
  try{const reply=await request(index,'/api/health');return reply.status===200?reply.data:null;}catch{return null;}},`owned server ${index} healthy`,25000);
 return child;
}
async function stopApp(index,reason){const own=children.get(index);if(!own)return;children.delete(index);const {child,record}=own;
 if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(done=>child.once('exit',done));child.kill('SIGKILL');await bounded(exited,7000,'owned process did not exit');}
 record.stoppedAt=new Date().toISOString();record.stopReason=reason;record.exitCode=child.exitCode;record.signalCode=child.signalCode;
}
async function freshSoftwarePool(label,{peer=true}={}){
 const {readArkExecutionSummary}=await import('../src/ark-execution-store.js');const previous=softwarePoolId;
 const before=await readArkExecutionSummary({storageRoot:ROOTS.arkExecutions,poolId:previous});
 await stopApp(0,'independent software account '+label);await stopApp(1,'independent software account '+label);
 softwarePoolId='queue-http-'+label;await startApp(0);if(peer)await startApp(1);
 const after=await readArkExecutionSummary({storageRoot:ROOTS.arkExecutions,poolId:previous});assert.deepEqual(after,before,'Independent cases may not release or acknowledge any earlier unknown send');
 (report.independentPoolTransitions||=[]).push({previousPool:previous,newPool:softwarePoolId,unknownReceiptsPreserved:before.blockedUnknownCount||0,physicalSendsPreserved:before.physicalSendCount||0});
}
async function check(name,action){const start=Date.now();try{const details=await action();report.checks.push({name,ok:true,elapsedMs:Date.now()-start,...details});console.log(`PASS ${name}`);}
 catch(error){report.checks.push({name,ok:false,elapsedMs:Date.now()-start,error:error.stack});console.log(`FAIL ${name}: ${error.message}`);throw error;}}

// The fixtures are admitted through the real store API while the owned server
// is stopped. No checksum-protected ledger bytes are patched by this phase.
const configurationMessage=count=>`有 ${count} 份待审稿件的审核程序或配置已变化，请结束旧批次后新建完整审阅`;
async function configurationSeed(tag,workspace,options=rules){
 providerMode='auto';const up=await upload(0,tag,workspace),result=await json(0,'/api/review',{body:{id:up.id,...options,operationId:'seed-'+randomUUID()}});
 const completed=await done(0,up.id,result.reviewRunId);assert.equal(completed.status,'completed');
 const job=await store.loadJob({...storage,jobId:result.reviewRunId});assert(job.config.recipe&&job.config.effectiveExecution);
 return{up,job};
}
async function frozenSessionProof(seeds){return Promise.all(seeds.map(async({up})=>{
 const bytes=await readFile(join(ROOTS.sessions,up.id,'state.json')),loaded=await sessionStore.loadSessionSnapshot({sessionId:up.id,storageRoot:ROOTS.sessions});
 return{sessionId:up.id,sha256:hash(bytes),manifestSha256:loaded.manifest.manifestSha256,revision:loaded.manifest.revision,reviewRunId:loaded.snapshot.reviewRunId,resultRunId:loaded.snapshot.resultRunId};
}));}
async function assertFrozenSessions(before){const after=await frozenSessionProof(before.map(row=>({up:{id:row.sessionId}})));assert.deepEqual(after,before,'Rejected queue may not rewrite session, discard result or advance revision');return after;}
async function fixtureBatch(workspace,seeds,configurations){assert(!children.has(0)&&!children.has(1),'Stop owned servers before declaring historical configuration fixtures');
 return store.startBatch({...storage,workspaceId:workspace,operationId:'fixture-'+randomUUID(),jobs:seeds.map((seed,index)=>({sessionId:seed.up.id,binding:structuredClone(seed.job.binding),config:structuredClone(configurations[index]),purpose:seed.job.purpose,verificationRunId:seed.job.verificationRunId}))});
}
async function rejectedConfigurationBatch(workspace,accepted,sessionBefore,changed){
 const providerBefore=report.providerRequests.length;
 const observed=await until(async()=>{const jobs=await store.listJobs({...storage,batchId:accepted.batch.id}),batch=await store.loadBatch({...storage,batchId:accepted.batch.id});
  // Old-source red stops immediately if a stale job is claimed; do not wait
  // forty seconds for a pause that the old source cannot create.
  return batch.paused||jobs.some(job=>job.status!=='queued')?{jobs,batch}:null;
 },'configuration pause before queued claim');
 assert.equal(observed.batch.paused,true,'Historical configuration batch must pause before claim');assert.equal(observed.batch.status,'paused');
 assert(observed.jobs.every(job=>job.status==='queued'&&job.lease===null&&!job.startedAt&&job.eventSeq===0&&job.outcomeReceipt===null));
 const reason=observed.batch.pauseReason;assert.equal(reason.code,'REVIEW_QUEUE_CONFIG_CHANGED');assert.equal(reason.message,configurationMessage(changed.length));assert.equal(reason.affectedJobCount,changed.length);
 assert.deepEqual(reason.affectedJobs.map(job=>job.jobId).sort(),changed.map(row=>row.jobId).sort());
 for(const expected of changed){const actual=reason.affectedJobs.find(job=>job.jobId===expected.jobId);assert.equal(actual.recipeChanged,expected.recipeChanged);assert.equal(actual.executionChanged,expected.executionChanged);}
 const view=await json(0,'/api/review-queue?workspaceId='+workspace);assert.equal(view.queue.runId,accepted.batch.id);assert.equal(view.queue.state,'paused');assert.deepEqual(view.queue.items.map(job=>job.status),accepted.jobs.map(()=> 'queued'));
 const refused=await request(0,'/api/review-queue',{body:{workspaceId:workspace,action:'resume',runId:accepted.batch.id},expected:409});
 assert.equal(refused.data.code,'REVIEW_QUEUE_CONFIG_CHANGED');assert.equal(refused.data.error,reason.message);assert.equal(refused.data.queue?.state,'paused');assert.equal(refused.data.queue?.runId,accepted.batch.id);
 const after=await store.loadBatch({...storage,batchId:accepted.batch.id});assert.deepEqual(after.pauseReason,reason);assert.equal(after.paused,true);
 await sleep(180);const stable=await store.loadBatch({...storage,batchId:accepted.batch.id});assert.deepEqual(stable,after,'Repeated automatic safety observation must not rewrite the stable pause');
 const sessionAfter=await assertFrozenSessions(sessionBefore);assert.equal(report.providerRequests.length,providerBefore,'Stale configuration must not reach even the software provider');
 return{batchId:accepted.batch.id,reason,view:view.queue,resume:refused.data,jobs:observed.jobs.map(job=>({id:job.id,status:job.status,eventSeq:job.eventSeq,startedAt:job.startedAt||null})),sessionBefore,sessionAfter,providerRequests:0};
}
function reverseObjectKeys(value){if(Array.isArray(value))return value.map(reverseObjectKeys);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reverseObjectKeys(value[key])]));return value;}
async function configurationPhase(){
 await check('config: one stale recipe pauses the whole mixed rules-only batch before claim or session write',async()=>{
  const workspace='wcfgmixed',seeds=[await configurationSeed('CONFIG-MIXED-BAD',workspace),await configurationSeed('CONFIG-MIXED-GOOD',workspace)];
  const configurations=seeds.map(seed=>structuredClone(seed.job.config));configurations[0].recipe=hash('fixed-old-recipe-fixture');await stopApp(0,'declare old recipe fixture');
  const accepted=await fixtureBatch(workspace,seeds,configurations),before=await frozenSessionProof(seeds);await startApp(0);
  return rejectedConfigurationBatch(workspace,accepted,before,[{jobId:accepted.jobs[0].id,recipeChanged:true,executionChanged:false}]);
 });
 await check('config: missing effective execution metadata is rejected with genuine model options intact',async()=>{
  const workspace='wcfgmissingeffective',seeds=[await configurationSeed('CONFIG-MISSING-EFFECTIVE',workspace,model)],config=structuredClone(seeds[0].job.config);delete config.effectiveExecution;
  await stopApp(0,'declare missing effective fixture');const accepted=await fixtureBatch(workspace,seeds,[config]),before=await frozenSessionProof(seeds);await startApp(0);
  return rejectedConfigurationBatch(workspace,accepted,before,[{jobId:accepted.jobs[0].id,recipeChanged:false,executionChanged:true}]);
 });
 await check('config: legacy missing recipe does not bypass rules-only admission',async()=>{
  const workspace='wcfgmissingrecipe',seeds=[await configurationSeed('CONFIG-MISSING-RECIPE',workspace)],config=structuredClone(seeds[0].job.config);delete config.recipe;
  await stopApp(0,'declare missing recipe fixture');const accepted=await fixtureBatch(workspace,seeds,[config]),before=await frozenSessionProof(seeds);await startApp(0);
  return rejectedConfigurationBatch(workspace,accepted,before,[{jobId:accepted.jobs[0].id,recipeChanged:true,executionChanged:false}]);
 });
 await check('config: actual old-to-new process queue policy detects effective-only drift independently of recipe',async()=>{
  await stopApp(0,'old finite queue policy');await startApp(0,{DSH_ARK_QUEUE_TIMEOUT_MS:'1000'});const workspace='wcfgeffective',old=await configurationSeed('CONFIG-OLD-QUEUE-POLICY',workspace);assert.equal(old.job.config.effectiveExecution.queueTimeoutMs,1000);
  await stopApp(0,'new finite queue policy');await startApp(0,{DSH_ARK_QUEUE_TIMEOUT_MS:'2000'});const current=await configurationSeed('CONFIG-CURRENT-QUEUE-POLICY','wcfgeffectivetemplate');assert.equal(current.job.config.effectiveExecution.queueTimeoutMs,2000);
  const config=structuredClone(old.job.config);config.recipe=current.job.config.recipe;await stopApp(0,'declare effective-only historical fixture');
  const accepted=await fixtureBatch(workspace,[old],[config]),before=await frozenSessionProof([old]);await startApp(0,{DSH_ARK_QUEUE_TIMEOUT_MS:'2000'});
  return{oldQueueTimeoutMs:1000,newQueueTimeoutMs:2000,currentRecipeCopiedFromRealCurrentJob:true,...await rejectedConfigurationBatch(workspace,accepted,before,[{jobId:accepted.jobs[0].id,recipeChanged:false,executionChanged:true}])};
 });
 await check('config: canonical key order keeps a compatible manual pause resumable',async()=>{
  const workspace='wcfgmanual',seed=await configurationSeed('CONFIG-VALID-MANUAL',workspace),config=reverseObjectKeys(seed.job.config);await stopApp(0,'declare compatible manually paused batch');
  const accepted=await fixtureBatch(workspace,[seed],[config]);await store.pauseBatch({...storage,batchId:accepted.batch.id});const before=await frozenSessionProof([seed]);await startApp(0,{DSH_ARK_QUEUE_TIMEOUT_MS:'2000'});await sleep(200);
  const paused=await store.loadBatch({...storage,batchId:accepted.batch.id});assert.equal(paused.paused,true);assert(!Object.hasOwn(paused,'pauseReason')||paused.pauseReason===null,'Compatible manual pause must have no safety conflict reason');assert.equal((await store.loadJob({...storage,jobId:accepted.jobs[0].id})).status,'queued');await assertFrozenSessions(before);
  const resumed=await json(0,'/api/review-queue',{body:{workspaceId:workspace,action:'resume',runId:accepted.batch.id}});assert.equal(resumed.command.runId,accepted.batch.id);
  const terminal=await until(async()=>{const job=await store.loadJob({...storage,jobId:accepted.jobs[0].id});return TERMINAL.has(job.status)?job:null;},'compatible manual resume terminal');assert.equal(terminal.status,'completed');assert.equal((await store.loadBatch({...storage,batchId:accepted.batch.id})).paused,false);
  const saved=await sessionStore.loadSessionSnapshot({sessionId:seed.up.id,storageRoot:ROOTS.sessions});assert.equal(saved.snapshot.resultRunId,terminal.id);assert.equal(saved.snapshot.resultVersionId,seed.up.workVersion.id);
  return{batchId:accepted.batch.id,keyOrderReversedOnly:true,manualPause:paused,resume:resumed.command,status:terminal.status,newResultRunId:saved.snapshot.resultRunId};
 });
 await check('config: standalone stale recipe fails at the execution fence and publishes proof without changing session',async()=>{
  const seed=await configurationSeed('CONFIG-STANDALONE-EARLY-FENCE','wcfgstandalone'),config=structuredClone(seed.job.config);config.recipe=hash('fixed-standalone-old-recipe');await stopApp(0,'declare standalone old recipe');
  const accepted=await store.enqueueJob({...storage,operationId:'standalone-'+randomUUID(),workspaceId:seed.job.workspaceId,sessionId:seed.up.id,binding:structuredClone(seed.job.binding),config,purpose:seed.job.purpose,verificationRunId:seed.job.verificationRunId}),before=await frozenSessionProof([seed]),providerBefore=report.providerRequests.length;
  await startApp(0,{DSH_ARK_QUEUE_TIMEOUT_MS:'2000'});const job=await until(async()=>{const j=await store.loadJob({...storage,jobId:accepted.job.id});return TERMINAL.has(j.status)?j:null;},'standalone execution config fence');assert.equal(job.status,'failed');
  const outcome=await store.loadJobOutcome({...storage,jobId:job.id});assert.equal(outcome.rejection,'config-conflict');assert.equal(outcome.result,null);assert.equal(job.sessionReceipt.unpublished,true);assert.equal(job.sessionReceipt.reason,'config-conflict');
  const events=await store.readJobEvents({...storage,jobId:job.id,afterSeq:0});assert.equal(events.length,1);assert.equal(events[0].type,'error');assert(!events.some(event=>['doc','progress','issue'].includes(event.type)));const after=await assertFrozenSessions(before);assert.equal(report.providerRequests.length,providerBefore);
  return{jobId:job.id,outcome:{status:outcome.status,rejection:outcome.rejection,result:outcome.result},sessionReceipt:job.sessionReceipt,events,sessionBefore:before,sessionAfter:after,providerRequests:0};
 });
}

async function exactCursorHeaderCheck(){
 providerMode='hold';const up=await upload(0,'SSE-EXACT-CURSOR','whttpexactcursor'),before=report.providerRequests.length;
 const accepted=await json(0,'/api/review',{body:{id:up.id,...model,async:true,operationId:'exact-cursor-header-run'}});
 await until(()=>report.providerRequests.length>before,'exact-cursor run reaches held provider');
 const durable=await until(async()=>{
  const job=await store.loadJob({...storage,jobId:accepted.reviewRunId});
  const events=await store.readJobEvents({...storage,jobId:job.id,afterSeq:0,limit:500});const last=events.at(-1);
  // This is the final progress callback before the held window request; seeing
  // it in the durable log proves the engine's pre-request events were flushed.
  return job.status==='running'&&last?.seq===job.eventSeq&&last?.type==='progress'
   &&last.data.phase==='model-prepare'&&/注入提示词式规则/.test(last.data.message)?{job,last}:null;
 },'all pre-request events are durable');
 const exactSeq=durable.job.eventSeq;assert.ok(exactSeq>0);
 const evidence={sessionId:up.id,jobId:accepted.reviewRunId,afterSeq:exactSeq,preRequestLastEvent:durable.last,
  headerRequestedAt:new Date().toISOString(),providerHeld:true,providerReleasedAt:null};
 (report.exactCursorHeaders ||= []).push(evidence);
 const began=Date.now();const stream=await openStream(0,up.id,{runId:accepted.reviewRunId,afterSeq:exactSeq,options:model,headerTimeoutMs:5000});
 const headerElapsedMs=Date.now()-began;assert.ok(headerElapsedMs<=5000,'empty replay must flush response headers within five seconds');
 evidence.headerElapsedMs=headerElapsedMs;
 await sleep(100);
 assert.equal(stream.events.length,0,'header delivery cannot depend on a subsequent event');
 const stillHeld=await store.loadJob({...storage,jobId:accepted.reviewRunId});assert.equal(stillHeld.eventSeq,exactSeq);assert.equal(stillHeld.status,'running');
 assert.ok(report.providerRequests.slice(before).every(row=>row.repliedAt===null),'provider must remain held until after headers arrive');
 evidence.eventsBeforeRelease=stream.events.length;evidence.eventSeqBeforeRelease=stillHeld.eventSeq;evidence.providerReleasedAt=new Date().toISOString();
 releaseProvider();await bounded(stream.task,30000,'exact-cursor stream must complete after provider release');
 assert.equal(stream.events.filter(event=>event.event==='done').length,1);assert.ok(stream.events.every(event=>event.seq>exactSeq));
 const end=await done(0,up.id,accepted.reviewRunId);assert.equal(end.status,'completed');assert.equal(end.hasResult,true);
 return{sessionId:up.id,jobId:accepted.reviewRunId,afterSeq:exactSeq,headerElapsedMs,preRequestLastEvent:durable.last,events:stream.events,end};
}

try{
 await startProvider();await startApp(0);
 // Explicit arguments on every disk read keep parent process module defaults inert.
 store=await import('../src/job-store.js');sessionStore=await import('../src/session-store.js');
 await check('owned server starts with recovered durable review service',async()=>{const health=await json(0,'/api/health');assert.equal(health.reviewRecovery?.state,'done',JSON.stringify(health));assert.equal(health.reviewRecovery.error,null);assert.equal(health.reviewQueueProtocol,1);return{health};});
 if(phase==='config')await configurationPhase();
 if(phase==='sse-header')await check('exact-current SSE replay flushes headers before any later event or provider release',exactCursorHeaderCheck);
 const blockedPoolCheck=async()=>{
  const providerBefore=report.providerRequests.length;
  const workspace='whttpblocked',uploads=[];for(const tag of ['HELD-FIRST','QUEUED-SECOND','QUEUED-THIRD'])uploads.push(await upload(0,tag,workspace));
  providerMode='hold';const started=await json(0,'/api/review-queue',{body:{workspaceId:workspace,action:'start',operationId:'blocked-fifo',options:model,concurrency:1}});
  await until(()=>report.providerRequests.length===providerBefore+1,'first model manuscript reaches owned provider');
  const {executeArkAttempt,readArkExecutionSummary}=await import('../src/ark-execution-store.js');providerMode='drop';
  await assert.rejects(executeArkAttempt({storageRoot:ROOTS.arkExecutions,poolId:softwarePoolId,
   body:{model:FAKE_MODEL,input:'FIXED SOFTWARE SATURATION CONTROL',stream:false},scope:{jobRunId:'software-unknown-seed',purpose:'verification'},
   responseTimeoutMs:2000,signal:AbortSignal.timeout(5000),transport:({body,signal})=>fetch(providerBase+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${FAKE_KEY}`},body:JSON.stringify(body),signal}),consumeResponse:response=>response}),error=>error.arkAttemptReceipt?.status==='unknown_sent');
  const cancel=await json(0,'/api/cancel-review',{body:{id:uploads[0].id,reviewRunId:started.queue.items[0].id,workVersionId:uploads[0].workVersion.id}});assert.equal(cancel.accepted,true);
  await done(0,uploads[0].id,started.queue.items[0].id);
  const view=await until(async()=>{const v=await json(0,'/api/review-queue?workspaceId='+workspace);return v.queue.state==='paused'||v.queue.items.slice(1).some(job=>job.status!=='queued')?v:null;},'safety pause before later manuscript claim');
  assert.equal(view.queue.state,'paused');assert.equal(view.queue.pauseReason?.code,'ARK_EXECUTION_BLOCKED');assert.deepEqual(view.queue.items.slice(1).map(job=>job.status),['queued','queued']);
  const pool=await readArkExecutionSummary({storageRoot:ROOTS.arkExecutions,poolId:softwarePoolId});assert.equal(pool.blockedUnknownCount,2);assert.equal(pool.physicalSendCount,2);assert.equal(report.providerRequests.length,providerBefore+2);
  const rejected=await request(0,'/api/review-queue',{body:{workspaceId:workspace,action:'resume',runId:view.queue.runId},expected:409});assert.equal(rejected.data.error,view.queue.pauseReason.message);
  const saved=await store.loadBatch({...storage,batchId:view.queue.runId});assert.equal(saved.paused,true);assert.deepEqual(saved.pauseReason,view.queue.pauseReason);
  await stopApp(0,'software blocked restart');await startApp(0);
  const after=await json(0,'/api/review-queue?workspaceId='+workspace);assert.equal(after.queue.state,'paused');assert.deepEqual(after.queue.pauseReason,saved.pauseReason);assert.deepEqual(after.queue.items.slice(1).map(job=>job.status),['queued','queued']);
  const ruleDoc=await upload(0,'RULES-WHILE-BLOCKED','whttprulesblocked');const ruleResult=await json(0,'/api/review',{body:{id:ruleDoc.id,...rules,operationId:'rules-under-block'}});assert(ruleResult.reviewRunId);const ruleStatus=await done(0,ruleDoc.id,ruleResult.reviewRunId);assert.equal(ruleStatus.status,'completed');
  const modelDoc=await upload(0,'MODEL-MUST-NOT-ENQUEUE','whttpmodelblocked');const refused=await request(0,'/api/review',{body:{id:modelDoc.id,...model,async:true,operationId:'blocked-enqueue'},expected:409});assert.equal(refused.data.error,view.queue.pauseReason.message);assert.equal((await store.listJobs({...storage,sessionId:modelDoc.id})).length,0);
  const finalPool=await readArkExecutionSummary({storageRoot:ROOTS.arkExecutions,poolId:softwarePoolId});assert.equal(finalPool.blockedUnknownCount,2);assert.equal(finalPool.physicalSendCount,2);assert.equal(report.providerRequests.length,providerBefore+2);
  return{batchId:view.queue.runId,paused:view.queue,rejected:rejected.data,restart:after.queue,ruleOnlyCompleted:true,refusedEnqueue:refused.data,physicalSendCount:2,unknownPreserved:2};
 };
 if(phase==='blocked')await check('unknown-saturated account pauses before next manuscript claim, survives restart and permits rules only',blockedPoolCheck);
 if(!['sse-header','blocked','config'].includes(phase)){
 const results=[];
 for(const entrance of ['sync','async','SSE'])await check(`${entrance} rule review materializes one durable job identity`,async()=>{
  const up=await upload(0,'ENTRYPOINT');let result,accepted,stream;
  if(entrance==='SSE'){stream=await openStream(0,up.id,{operationId:'http-SSE'});await bounded(stream.task,30000,'rules SSE not terminal');
   assert.equal(stream.error,null);assert.ok(stream.events.find(e=>e.event==='doc'));assert.equal(stream.events.filter(e=>e.event==='done').length,1);
   assert.ok(!stream.events.some(e=>['error','cancelled'].includes(e.event)));result=stream.events.find(e=>e.event==='done').data;
  }else{const reply=await request(0,'/api/review',{body:{id:up.id,...rules,async:entrance==='async',operationId:'http-'+entrance}});
   assert.equal(reply.status,entrance==='async'?202:200,JSON.stringify(reply.data));accepted=reply.data;if(entrance==='sync')result=reply.data;}
  const state=await done(0,up.id);if(entrance==='async')result=state.result;
  assert.equal(state.status,'completed');assert.equal(state.hasResult,true);assert.equal(state.error,null);
  assert.equal(result.reviewRunId,state.reviewRunId);assert.equal(state.reviewJobId,state.reviewRunId);
  assert.equal(state.workVersionId,up.workVersion.id);assert.equal(state.reviewVersionId,up.workVersion.id);
  assert.deepEqual(state.result.issues.map(i=>i.issueKey),result.issues.map(i=>i.issueKey));
  const job=await store.loadJob({...storage,jobId:state.reviewRunId});assert.equal(job.status,'completed');assert.equal(job.sessionId,up.id);
  const saved=await sessionStore.loadSessionSnapshot({sessionId:up.id,storageRoot:ROOTS.sessions});
  assert.equal(saved.snapshot.resultRunId,job.id);assert.equal(saved.snapshot.resultVersionId,job.binding.versionId);
  assert.equal(saved.snapshot.reviewRecords.filter(record=>record.id===job.id).length,1);
  const jobs=await store.listJobs({...storage,sessionId:up.id});assert.equal(jobs.length,1);
  const idleCancel=await json(0,'/api/cancel-review',{body:{id:up.id,reviewRunId:job.id,workVersionId:up.workVersion.id}});
  assert.equal(idleCancel.accepted,false);assert.equal(idleCancel.cancelled,false);
  const afterIdle=await status(0,up.id,job.id);assert.equal(afterIdle.status,'completed');assert.equal(afterIdle.hasResult,true);
  results.push(result.issues.map(i=>i.issueKey));return{sessionId:up.id,jobId:job.id,versionId:job.binding.versionId,issueCount:result.issues.length,accepted,events:stream?.events};
 });
 assert.deepEqual(results[0],results[1]);assert.deepEqual(results[0],results[2]);
 assert.equal(report.providerRequests.length,0,'rule-only entrances must not contact even the stand-in');
 }

 if(phase==='full'){
  await check('live peer observes without interruption and cancels the owning execution',async()=>{
   providerMode='hold';const up=await upload(0,'LIVE-PEER','whttppeer'),before=report.providerRequests.length;
   const accepted=await json(0,'/api/review',{body:{id:up.id,...model,async:true,operationId:'peer-owned-run'}});
   await until(()=>report.providerRequests.length>before,'peer run reaches local provider');
   const running=await store.loadJob({...storage,jobId:accepted.reviewRunId});assert.equal(running.lease.owner.pid,children.get(0).child.pid);
   await startApp(1);
   const persistedBefore=await sessionStore.loadSessionSnapshot({sessionId:up.id,storageRoot:ROOTS.sessions});
   const views=[await json(1,'/api/workspace?id=whttppeer'),await json(1,'/api/session?id='+up.id),await status(1,up.id,accepted.reviewRunId)];
   assert.equal(views[2].running,true);assert.equal(views[2].interrupted,false);
   const persistedAfter=await sessionStore.loadSessionSnapshot({sessionId:up.id,storageRoot:ROOTS.sessions});
   assert.equal(persistedBefore.manifest.manifestSha256,persistedAfter.manifest.manifestSha256,'read-only peer GET must not save interruption');
   const cancel=await request(1,'/api/cancel-review',{body:{id:up.id,reviewRunId:accepted.reviewRunId,workVersionId:up.workVersion.id},expected:200});
   assert.equal(cancel.data.accepted,true);assert.equal(cancel.data.cancelRequested,true);
   assert.equal(cancel.data.cancelled,cancel.data.status==='cancelled','intent acceptance is not terminal cancellation');
   assert.equal((await store.loadJob({...storage,jobId:accepted.reviewRunId})).cancelRequested,true);
   const end=await done(1,up.id,accepted.reviewRunId);assert.equal(end.status,'cancelled');assert.equal(end.hasResult,false);assert.equal(end.reviewRunId,accepted.reviewRunId);
   await until(()=>report.providerRequests.slice(before).every(row=>row.closedAt),'owner closes cancelled model request');
   return{sessionId:up.id,jobId:accepted.reviewRunId,cancel:cancel.data,end};
  });

  await check('provider failure stays partial and a new queue includes the unfinished manuscript',async()=>{
   providerMode='fail';const up=await upload(0,'PROVIDER-FAILURE','whttppartial'),before=report.providerRequests.length;
   const accepted=await json(0,'/api/review',{body:{id:up.id,...model,async:true,operationId:'provider-failed-run'}});
   const end=await done(0,up.id,accepted.reviewRunId);assert.equal(end.status,'partial');assert.equal(end.hasResult,true);
   assert.equal(end.reviewRunId,accepted.reviewRunId);assert.equal(end.result.reviewRunId,accepted.reviewRunId);
   const outcome=await store.loadJobOutcome({...storage,jobId:accepted.reviewRunId});assert.equal(outcome.status,'partial');
   assert.ok(outcome.result.modelResult.errors.length>0);assert.ok(report.providerRequests.slice(before).some(row=>row.softwareStatus===400));
   providerMode='auto';const next=await json(0,'/api/review-queue',{body:{workspaceId:'whttppartial',action:'start',operationId:'partial-followup',options:model,concurrency:1}});
   assert.deepEqual(next.queue.items.map(item=>item.sessionId),[up.id]);
   const recovered=await done(0,up.id,next.queue.items[0].id);assert.equal(recovered.status,'completed');
   await request(0,'/api/review-queue',{body:{workspaceId:'whttppartial',action:'resume',runId:next.queue.runId},expected:409});
   return{sessionId:up.id,partialRunId:accepted.reviewRunId,partial:end,statusErrors:outcome.result.modelResult.errors,retryBatchId:next.queue.runId,recovered};
  });

  await check('committed publication rejects cancellation until session materialization finishes',async()=>{
   providerMode='hold';const up=await upload(0,'PUBLICATION-BOUNDARY','whttppublishing'),before=report.providerRequests.length;
   const accepted=await json(0,'/api/review',{body:{id:up.id,...model,async:true,operationId:'publishing-owned-run'}});
   await until(()=>report.providerRequests.length>before,'publication run reaches held provider');
   const path=join(ROOTS.sessions,up.id,'state.lock'),token=randomUUID();
   await writeFile(path,JSON.stringify({schemaVersion:1,pid:process.pid,token}),{flag:'wx'});
   try{
    releaseProvider();await until(async()=>{const job=await store.loadJob({...storage,jobId:accepted.reviewRunId});return job.status==='publishing'?job:null;},'completed outbox waits for owned session lock');
    const cancel=await json(1,'/api/cancel-review',{body:{id:up.id,reviewRunId:accepted.reviewRunId,workVersionId:up.workVersion.id}});
    assert.equal(cancel.accepted,false);assert.equal(cancel.cancelled,false);assert.equal(cancel.publicationCommitted,true);assert.equal(cancel.status,'publishing');
    const outbox=await store.loadJobOutcome({...storage,jobId:accepted.reviewRunId});assert.equal(outbox.status,'completed');
    const saved=await sessionStore.loadSessionSnapshot({sessionId:up.id,storageRoot:ROOTS.sessions});
    assert.notEqual(saved.snapshot.resultRunId,accepted.reviewRunId,'a held publication is not an exposed completed result');
    const own=JSON.parse(await readFile(path,'utf8'));assert.equal(own.token,token);assert.equal(own.pid,process.pid);await unlink(path);
    const end=await done(1,up.id,accepted.reviewRunId);assert.equal(end.status,'completed');assert.equal(end.hasResult,true);assert.equal(end.reviewRunId,accepted.reviewRunId);
    return{sessionId:up.id,jobId:accepted.reviewRunId,cancel,end,heldPublicationToken:token};
   }finally{
    try{const own=JSON.parse(await readFile(path,'utf8'));if(own.token===token&&own.pid===process.pid)await unlink(path);}catch(error){if(error.code!=='ENOENT')throw error;}
   }
  });

  await check('an old session run cannot be selected after a new run starts',async()=>{
   providerMode='hold';const up=await upload(0,'STALE-STATUS','whttpstatus');
   const first=await json(0,'/api/review',{body:{id:up.id,...rules,operationId:'status-first'}});
   const second=await json(0,'/api/review',{body:{id:up.id,...model,async:true,operationId:'status-second'}});
   const stale=await request(1,`/api/review-status?id=${up.id}&runId=${first.reviewRunId}`,{expected:409});
   await json(1,'/api/cancel-review',{body:{id:up.id,reviewRunId:second.reviewRunId,workVersionId:up.workVersion.id}});
   const end=await done(0,up.id,second.reviewRunId);assert.equal(end.reviewRunId,second.reviewRunId);assert.equal(end.status,'cancelled');
   return{sessionId:up.id,firstRunId:first.reviewRunId,secondRunId:second.reviewRunId,stale:stale.data,end};
  });

  // Two independent cancellation controls can exhaust their simulated account.
  // The following success controls use a new account without clearing receipts.
  await freshSoftwarePool('successful-replay');

  await check('exact-current SSE replay flushes headers before any later event or provider release',exactCursorHeaderCheck);

  await check('detached SSE and cursor replay observe one execution and one authoritative done',async()=>{
   providerMode='hold';const up=await upload(0,'SSE-REPLAY','whttpreplay'),before=report.providerRequests.length;
   const stream=await openStream(0,up.id,{options:model,operationId:'replay-owned-run'});
   await until(()=>report.providerRequests.length>before&&stream.events.length>1,'stream reaches held provider');
   const runId=stream.events[0].data.reviewRunId,seq=stream.events.at(-1).seq;await closeStream(stream);
   assert.equal((await status(1,up.id,runId)).running,true);
   const replay=await openStream(1,up.id,{runId,lastEventId:`${runId}:${seq}`,options:model});
   releaseProvider();await bounded(replay.task,30000,'replayed stream not terminal');
   assert.ok(replay.events.every(e=>e.seq>seq));assert.equal(replay.events.filter(e=>e.event==='done').length,1);
   const ended=await done(0,up.id,runId);assert.equal(ended.status,'completed');
   const jobs=await store.listJobs({...storage,sessionId:up.id});assert.equal(jobs.length,1);
   const countBeforeTerminalReplay=report.providerRequests.length;
   const tail=await openStream(0,up.id,{runId,afterSeq:seq,options:model});await bounded(tail.task,10000,'terminal replay not closed');
   assert.equal(tail.events.filter(e=>e.event==='done').length,1);assert.equal((await store.listJobs({...storage,sessionId:up.id})).length,1);
   assert.equal(report.providerRequests.length,countBeforeTerminalReplay,'SSE observation must not call the provider again');
   return{sessionId:up.id,jobId:runId,afterSeq:seq,events:replay.events,terminalReplay:tail.events,providerRequests:report.providerRequests.length-before};
  });

  await check('server batch FIFO persists pause, resumes next and cancels remainder',async()=>{
   providerMode='hold';const workspace='whttpbatch',uploads=[];for(const tag of ['BATCH-FIRST','BATCH-SECOND','BATCH-THIRD'])uploads.push(await upload(0,tag,workspace));
   const before=report.providerRequests.length;
   const started=await json(0,'/api/review-queue',{body:{workspaceId:workspace,action:'start',operationId:'http-batch',options:model,concurrency:1}});
   assert.equal(started.queue.items.length,3);assert.deepEqual(started.queue.items.map(item=>item.sessionId),uploads.map(up=>up.id));
   await until(()=>report.providerRequests.length>before,'first batch model request');
   const batchId=started.queue.runId;
   const paused=await json(1,'/api/review-queue',{body:{workspaceId:workspace,action:'pause',runId:batchId}});assert.equal(paused.queue.state,'pausing');
   releaseProvider();await done(0,uploads[0].id,started.queue.items[0].id);
   const view=await json(1,'/api/review-queue?workspaceId='+workspace);
   assert.equal(view.queue.items[1].status,'queued');assert.equal(view.queue.items[2].status,'queued');
   providerMode='hold';const middleCount=report.providerRequests.length;
   await json(0,'/api/review-queue',{body:{workspaceId:workspace,action:'resume',runId:batchId}});
   await until(()=>report.providerRequests.length>middleCount,'second batch model request');
   const cancelled=await json(1,'/api/review-queue',{body:{workspaceId:workspace,action:'cancel',runId:batchId}});
   assert.equal(cancelled.queue.state,'cancelling');
   const end=await until(async()=>{const now=await json(0,'/api/review-queue?workspaceId='+workspace);return now.queue.items.every(item=>TERMINAL.has(item.status))?now:null;},'batch cancelled terminals');
   assert.deepEqual(end.queue.items.map(item=>item.status),['completed','cancelled','cancelled']);
   assert.equal(end.queue.state,'cancelled');
   await request(1,'/api/review-queue',{body:{workspaceId:workspace,action:'resume',runId:batchId},expected:409});
   providerMode='hold';const next=await json(0,'/api/review-queue',{body:{workspaceId:workspace,action:'start',operationId:'http-batch-next',options:model,concurrency:1}});
   assert.notEqual(next.queue.runId,batchId);
   assert.deepEqual(next.queue.items.map(item=>item.sessionId),uploads.slice(1).map(up=>up.id),'new batch must skip the completed first manuscript');
   const stale=[];for(const action of ['pause','resume','cancel'])stale.push(await request(1,'/api/review-queue',{body:{workspaceId:workspace,action,runId:batchId},expected:409}));
   const replay=await json(1,'/api/review-queue',{body:{workspaceId:workspace,action:'start',operationId:'http-batch',options:model,concurrency:1}});
   assert.equal(replay.command.runId,batchId);assert.equal(replay.command.replayed,true);assert.equal(replay.queue.runId,next.queue.runId);
   await json(0,'/api/review-queue',{body:{workspaceId:workspace,action:'cancel',runId:next.queue.runId}});
   await until(async()=>{const now=await json(0,'/api/review-queue?workspaceId='+workspace);return now.queue.items.every(item=>TERMINAL.has(item.status))?now:null;},'new batch cancelled after identity checks');
   return{batchId,paused:paused.queue,cancelled:cancelled.queue,end:end.queue,nextBatchId:next.queue.runId,stale:stale.map(item=>item.data),replayCommand:replay.command};
  });

  // Earlier cancellation cases deliberately retain uncertain remote sends.
  // This independent owner-death experiment uses a fresh simulated account;
  // previous receipts and occupied permits remain intact and are never reset.
  const {readArkExecutionSummary}=await import('../src/ark-execution-store.js');
  const previousPoolId=softwarePoolId,previousPool=await readArkExecutionSummary({storageRoot:ROOTS.arkExecutions,poolId:softwarePoolId});
  await stopApp(0,'independent owner-death software account');await stopApp(1,'independent owner-death software account');
  softwarePoolId='queue-http-owner-death';await startApp(0);
  assert.equal((await readArkExecutionSummary({storageRoot:ROOTS.arkExecutions,poolId:previousPoolId})).blockedUnknownCount,previousPool.blockedUnknownCount);
  report.independentOwnerDeathPool={previousPool:previousPoolId,newPool:softwarePoolId,unknownReceiptsPreserved:previousPool.blockedUnknownCount};
  await check('dead execution owner recovers interrupted without another provider request',async()=>{
   await stopApp(1,'isolate restart owner');providerMode='hold';const up=await upload(0,'DEAD-OWNER','whttpdead'),before=report.providerRequests.length;
   const accepted=await json(0,'/api/review',{body:{id:up.id,...model,async:true,operationId:'dead-owned-run'}});
   await until(()=>report.providerRequests.length>before,'owner reaches provider before kill');
   const requestCount=report.providerRequests.length;await stopApp(0,'restart acceptance abrupt kill');await startApp(0);
   const end=await done(0,up.id,accepted.reviewRunId);assert.equal(end.status,'interrupted');assert.equal(end.running,false);assert.equal(end.hasResult,false);
   assert.equal(report.providerRequests.length,requestCount,'dead run must not silently rerun the model');
   const saved=await sessionStore.loadSessionSnapshot({sessionId:up.id,storageRoot:ROOTS.sessions});assert.equal(saved.snapshot.interrupted,true);
   assert.equal(saved.snapshot.reviewRunId,accepted.reviewRunId);return{sessionId:up.id,jobId:accepted.reviewRunId,end,providerRequests:requestCount-before};
  });
  await freshSoftwarePool('blocked-admission',{peer:false});
  await check('unknown-saturated account pauses before next manuscript claim, survives restart and permits rules only',blockedPoolCheck);
 }
 assert.ok(report.providerRequests.every(row=>row.path==='/api/v3/responses'&&row.credentialMatched),'all provider requests must use the owned stand-in credential and path');
}catch(error){report.failure=error.stack;process.exitCode=1;}
finally{
 for(const item of [...streams])await closeStream(item);
 for(const index of [...children.keys()])await stopApp(index,'test cleanup').catch(error=>report.cleanupError=error.stack);
 for(const socket of sockets)socket.destroy();if(provider)await new Promise(done=>provider.close(done));
 report.finishedAt=new Date().toISOString();report.finalSourceHashes=await sourceHashes();report.sourceChanged=JSON.stringify(report.sourceHashes)!==JSON.stringify(report.finalSourceHashes);
 report.finalTestSha256=hash(await readFile(fileURLToPath(import.meta.url)));report.testChanged=report.testSha256!==report.finalTestSha256;
 report.ok=!report.failure&&report.checks.every(check=>check.ok)&&!report.sourceChanged&&!report.testChanged;
 if(report.sourceChanged||report.testChanged)process.exitCode=1;
 await writeFile(join(RUN,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 for(const processRecord of report.processes)await writeFile(join(RUN,`app-${processRecord.index}-${processRecord.pid}.log`),processRecord.stdout+'\nSTDERR\n'+processRecord.stderr,{flag:'wx'});
 console.log(`REPORT ${join(RUN,'report.json')}`);if(report.failure)console.error(report.failure);
}
