import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,symlinkSync} from "node:fs";
import {resolve,join,dirname} from "node:path";
import {pathToFileURL,fileURLToPath} from "node:url";
import {createServer} from "node:http";
import {randomUUID,createHash} from "node:crypto";
import {spawn} from "node:child_process";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const args=process.argv.slice(2),flag=name=>args.find(a=>a.startsWith("--"+name+"="))?.slice(name.length+3);
const inheritedEvidence=process.env.DSH_VERIFICATION_EVIDENCE_DIR;
const evidenceRoot=resolve(flag("evidence-root")||inheritedEvidence||join(root,"data","verify","review-plans"));
const allowed=[join(root,"data","verify"),join(root,"data","optimization","runs")];
if(!allowed.some(p=>evidenceRoot===p||evidenceRoot.startsWith(p+String.fromCharCode(92))||evidenceRoot.startsWith(p+"/")))throw Error("Evidence root must remain under project verify or unsealed runs");
const base=join(evidenceRoot,"review-plan-store-"+Date.now()+"-"+randomUUID());
for(let p=base;;p=dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw Error("alias");if(existsSync(join(p,"complete.json")))throw Error("sealed");if(dirname(p)===p)break;}
mkdirSync(base,{recursive:true});
const sha=v=>createHash("sha256").update(v).digest("hex"),files=["src/review-plan-store.js","src/ark.js","src/ark-execution-context.js","src/ark-execution-store.js","src/job-store.js","tools/test-review-plan-store.mjs"],before=Object.fromEntries(files.map(p=>[p,sha(readFileSync(p))]));
const sourceRoot=resolve(flag("source-root")||root),selectedSource=join(sourceRoot,"src/review-plan-store.js");
const selectedSourceSha256=sha(readFileSync(selectedSource)),m=await import(pathToFileURL(selectedSource));
const checks=[],ownedProcesses=[];async function check(name,fn){try{await fn();checks.push({name,ok:true});console.log("PASS "+name);}catch(e){checks.push({name,ok:false,error:{code:e.code,message:e.message,stack:e.stack}});console.log("FAIL "+name+": "+e.message);}}
const h=sha("software-fixture"),binding={versionId:"software:v0:"+h,sourceSha256:h,workSha256:h,mutationEpoch:0};
const roots=Object.fromEntries(["sessions","versions","workspaces","audit","legacy","ingestion","jobs"].map(x=>[x,join(base,"roots",x)]));for(const p of Object.values(roots))mkdirSync(p,{recursive:true});
const scope=(id,dir="main")=>({jobRunId:id,sessionId:"software-session",purpose:"verification",verificationRunId:"g5-software-plan",binding:{...binding},recipe:"fixed-software-recipe",planRoot:join(base,"plans",dir),executionRoot:join(base,"accounts",dir),poolId:"software-plan"});
const plan={config:{model:"software",digest:"fixed",cases:"fixed"},units:["A","B","C"].map(unitId=>({unitId,stage:"window"}))};
let calls={A:0,B:0,C:0};const first=scope("first");const run=(s,id,good=true)=>m.runReviewUnit({scope:s,unitId:id,input:{literal:id,digest:"fixed"},execute:async()=>{calls[id]++;return{issues:[],ok:good,sourceContext:{part:"paragraph",index:id}};},validate:o=>({status:o.ok?"completed":"failed",output:o})});
await check("unknown readonly root creates no store",async()=>{const s=scope("absent","absent");assert.equal(await m.readReviewPlanCoverage({scope:s}),null);assert.equal(existsSync(s.planRoot),false);});
await check("register denominator then persist zero issue windows",async()=>{await m.prepareReviewPlan({scope:first,plan});await run(first,"A");await run(first,"B",false);await run(first,"C");const c=await m.readReviewPlanCoverage({scope:first});assert.equal(c.total,3);assert.equal(c.completed,2);assert.equal(c.failed,1);assert(c.units.every(u=>u.inputReceipt&&u.outputReceipt));});
await check("explicit new run only executes failed window",async()=>{const s={...scope("second"),resumedFromRunId:"first"};await m.prepareReviewPlan({scope:s,plan});for(const id of ["A","B","C"])await run(s,id);assert.deepEqual(calls,{A:1,B:2,C:1});const c=await m.readReviewPlanCoverage({scope:s});assert.equal(c.completed,3);assert.equal(c.reused,2);});
await check("changed source or config cannot reuse",async()=>{await assert.rejects(m.prepareReviewPlan({scope:{...scope("wrong-source"),binding:{...binding,mutationEpoch:1}},plan,fromRunId:"first"}),{code:"REVIEW_PLAN_RESUME_CONFLICT"});await assert.rejects(m.prepareReviewPlan({scope:scope("wrong-config"),plan:{...plan,config:{model:"changed"}},fromRunId:"first"}),{code:"REVIEW_PLAN_RESUME_CONFLICT"});});
await check("actual unit digest change refuses execution",async()=>{const s=scope("wrong-digest");await m.prepareReviewPlan({scope:s,plan,fromRunId:"first"});let executed=false;await assert.rejects(m.runReviewUnit({scope:s,unitId:"A",input:{literal:"A",digest:"changed"},execute:async()=>{executed=true;return{};},validate:o=>({status:"completed",output:o})}),{code:"REVIEW_PLAN_RESUME_CONFLICT"});assert.equal(executed,false);});
await check("Map Error source context typed roundtrip",async()=>{const s=scope("typed","typed"),p={units:[{unitId:"R",stage:"recheck"}]};await m.prepareReviewPlan({scope:s,plan:p});const x=()=>m.runReviewUnit({scope:s,unitId:"R",input:{issueKeys:["stable"]},execute:async()=>({byKey:new Map([["stable",{verdict:"unsure"}]]),error:Object.assign(new Error("software error"),{code:"SOFTWARE"}),sourceContext:{entries:[]}}),validate:o=>({status:"completed",output:o})});await x();const y=await x();assert(y.byKey instanceof Map);assert.equal(y.byKey.get("stable").verdict,"unsure");assert.equal(y.error.code,"SOFTWARE");assert.equal(y.checkpointReceipt.reused,true);});
await check("invalid validation cannot fake completion",async()=>{const s=scope("validation","validation");await m.prepareReviewPlan({scope:s,plan:{units:[{unitId:"X"}]}});await assert.rejects(m.runReviewUnit({scope:s,unitId:"X",input:{},execute:async()=>({issues:[]}),validate:o=>({output:o})}),{code:"REVIEW_PLAN_VALIDATION_FAILED"});assert.equal((await m.readReviewPlanCoverage({scope:s})).failed,1);});
await check("checkpoint write failure never reports success",async()=>{const s=scope("fault","fault");await m.prepareReviewPlan({scope:s,plan:{units:[{unitId:"F"}]}});let n=0;await assert.rejects(m.runReviewUnit({scope:s,unitId:"F",input:{},execute:async()=>({issues:[]}),validate:o=>({status:"completed",output:o}),faultHooks:{beforeStateRename(){if(++n===2)throw Object.assign(new Error("injected write failure"),{code:"SOFTWARE_WRITE_FAILURE"});}}}),{code:"SOFTWARE_WRITE_FAILURE"});const c=await m.readReviewPlanCoverage({scope:s});assert.equal(c.completed,0);assert.equal(c.units[0].status,"running");});
await check("sealed and alias roots reject",async()=>{const blocked=join(base,"sealed");mkdirSync(blocked);writeFileSync(join(blocked,"complete.json"),"{}");await assert.rejects(m.prepareReviewPlan({scope:{...scope("sealed"),planRoot:join(blocked,"plans")},plan}),{code:"REVIEW_PLAN_SEALED"});const target=join(base,"alias-target");mkdirSync(target);const alias=join(base,"alias");symlinkSync(target,alias,process.platform==="win32"?"junction":"dir");try{await assert.rejects(m.prepareReviewPlan({scope:{...scope("alias"),planRoot:join(alias,"plans")},plan}),{code:"REVIEW_PLAN_PATH_INVALID"});}finally{const{unlinkSync}=await import("node:fs");if(lstatSync(alias).isSymbolicLink())unlinkSync(alias);}});
await check("old executor cannot publish after its token is fenced",async()=>{
 const s=scope("fenced","fenced");await m.prepareReviewPlan({scope:s,plan:{units:[{unitId:"L"}]}});
 let entered=false,release;const held=new Promise(done=>release=done);
 const pending=m.runReviewUnit({scope:s,unitId:"L",input:{source:"synthetic token fence"},execute:async()=>{entered=true;await held;return{issues:[]};},validate:o=>({status:"completed",output:o})});
 const deadline=Date.now()+5000;while(!entered&&Date.now()<deadline)await new Promise(done=>setTimeout(done,5));assert(entered);
 const path=join(s.planRoot,"runs","p"+sha(s.jobRunId),"state.json"),wrapped=JSON.parse(readFileSync(path,"utf8"));
 wrapped.value.units.L.lease.token=randomUUID();wrapped.value.revision++;wrapped.sha256=m.reviewPlanFingerprint(wrapped.value);
 writeFileSync(path,JSON.stringify(wrapped)+"\n");release();await assert.rejects(pending,{code:"REVIEW_PLAN_LEASE_CONFLICT"});
 assert.equal((await m.readReviewPlanCoverage({scope:s})).completed,0);
});
const peerFile=join(base,"confirmed-peer.mjs");
writeFileSync(peerFile,`import {readFileSync} from "node:fs";import {pathToFileURL} from "node:url";import {join} from "node:path";
const cfg=JSON.parse(readFileSync(process.argv[2],"utf8")),root=process.cwd();
const m=await import(pathToFileURL(join(root,"src/review-plan-store.js"))),e=await import(pathToFileURL(join(root,"src/ark-execution-store.js"))),c=await import(pathToFileURL(join(root,"src/ark-execution-context.js")));
await m.prepareReviewPlan({scope:cfg.scope,plan:cfg.plan});
await m.runReviewUnit({scope:cfg.scope,unitId:"P",input:{body:"software"},execute:async()=>{
 const sent=await e.executeArkAttempt({storageRoot:cfg.scope.executionRoot,poolId:cfg.scope.poolId,body:{model:"software",input:"software"},scope:c.getArkScope(),transport:async()=>new Response(JSON.stringify({id:"software-confirmed",output_text:"{\\\"issues\\\":[]}",usage:{input_tokens:1,output_tokens:1}}),{status:200}),consumeResponse:r=>r.json()});
 c.recordArkAttempt(sent.receipt);process.exit(0);
},validate:o=>({status:"completed",output:o})});`,{flag:"wx"});
await check("real dead peer confirmed response recovered without unknown",async()=>{const s=scope("peer","peer"),p={units:[{unitId:"P"}]},config=join(base,"confirmed-peer.json");writeFileSync(config,JSON.stringify({scope:s,plan:p}),{flag:"wx"});const child=spawn(process.execPath,[peerFile,config],{cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stderr="";child.stderr.on("data",b=>stderr+=b);const exit=await new Promise(done=>child.on("exit",(code,signal)=>done({code,signal})));ownedProcesses.push({pid:child.pid,...exit,closed:true});assert.equal(exit.code,0,stderr);const recovered=await m.recoverReviewPlans({storageRoot:s.planRoot,executionRoot:s.executionRoot,poolId:s.poolId});assert.equal(recovered.recovered[0].status,"failed");const old=await m.readReviewPlanCoverage({scope:s});assert.equal(old.units[0].recovery.reason,"known-response-await-materialization");assert.equal(old.unknownSent,0);const next={...s,jobRunId:"peer-resume"};await m.prepareReviewPlan({scope:next,plan:p,fromRunId:s.jobRunId});const y=await m.runReviewUnit({scope:next,unitId:"P",input:{body:"software"},execute:async()=>({issues:[],rematerialized:true}),validate:o=>({status:"completed",output:o})});assert.equal(y.rematerialized,true);});

let provider=null,providerRequests=[],phase="split-initial",providerClosed=false;
await check("actual loopback partial split resumes only failed child",async()=>{
 provider=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()),text=String(body.input||""),a=text.includes("[段落0]"),b=text.includes("[段落1]");providerRequests.push({phase,model:body.model,a,b});
 if(phase==="split-initial"&&a&&b){res.writeHead(400);res.end("SensitiveContentDetected software control");return;}
 if(phase==="split-initial"&&b&&!a){res.writeHead(400);res.end("software child failure");return;}
 res.writeHead(200,{"content-type":"application/json","x-request-id":"local-software-"+providerRequests.length});res.end(JSON.stringify({id:"local-response-"+providerRequests.length,output_text:JSON.stringify({issues:[]}),usage:{input_tokens:3,output_tokens:1,input_tokens_details:{cached_tokens:0}}}));
 });
 await new Promise(done=>provider.listen(0,"127.0.0.1",done));
 for(const key of Object.keys(process.env))if(/^(ARK_|DSH_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$)/i.test(key))delete process.env[key];
 Object.assign(process.env,{ARK_API_KEY:"local-plan-store-software-key",ARK_BASE_URL:"http://127.0.0.1:"+provider.address().port+"/api/v3",ARK_PREFIX_CACHE:"0",ARK_CONTEXT:"0",ARK_CASES:"0",ARK_CONSISTENCY:"0",DSH_ARK_POOL_CONCURRENCY:"2"});
 const ark=await import(pathToFileURL(join(root,"src/ark.js"))),ctx=await import(pathToFileURL(join(root,"src/ark-execution-context.js")));
 const doc={sourcePackageSha256:h,sourceVersionId:binding.versionId,paragraphs:[{index:0,text:"软件甲段。",part:"document.xml"},{index:1,text:"软件乙段。",part:"document.xml"}],footnotes:[],endnotes:[],stats:{chars:12}};
 const options={model:"software-model",useContext:false,useCases:false,concurrency:1,docMeta:{title:"synthetic software fixture",modelRules:[]}};
 const firstScope=scope("model-split-first","model-split");
 const x=await ctx.withArkScope(firstScope,()=>ark.modelReview(doc,options));assert(x.errors.length);const oldCount=providerRequests.length;assert.equal(providerRequests.filter(r=>r.a&&!r.b).length,1);
 phase="split-resume";const nextScope={...firstScope,jobRunId:"model-split-resume",resumedFromRunId:firstScope.jobRunId};
 const y=await ctx.withArkScope(nextScope,()=>ark.modelReview(doc,options));assert.equal(y.errors.length,0);const newRequests=providerRequests.slice(oldCount);assert.equal(newRequests.length,1);assert.equal(newRequests[0].a,false);assert.equal(newRequests[0].b,true);assert.equal(y.reviewPlan.completed,1);
 globalThis.softwareArk={ark,ctx,doc,options};
});
await check("actual per-rule denominator and zero-result checkpoint reuse",async()=>{
 assert(globalThis.softwareArk,"split setup must complete");const{ark,ctx,doc,options}=globalThis.softwareArk;
 phase="per-rule";const opts={...options,maxParasPerWindow:1,ruleMode:"per-rule",docMeta:{title:"synthetic software fixture",modelRules:[{id:"SOFT-1",title:"software rule1",category:"software",severity:"低",method:"software"},{id:"SOFT-2",title:"software rule2",category:"software",severity:"低",method:"software"}]}};
 const s=scope("per-rule-first","per-rule"),beforeRequests=providerRequests.length;
 const x=await ctx.withArkScope(s,()=>ark.modelReview(doc,opts));assert.equal(x.reviewPlan.total,4);assert.equal(x.reviewPlan.completed,4);assert.equal(providerRequests.length-beforeRequests,4);
 const beforeResume=providerRequests.length,y=await ctx.withArkScope({...s,jobRunId:"per-rule-resume",resumedFromRunId:s.jobRunId},()=>ark.modelReview(doc,opts));assert.equal(providerRequests.length,beforeResume);assert.equal(y.reviewPlan.completed,4);assert.equal(y.reviewPlan.reused,4);
});
if(provider){await new Promise(done=>provider.close(done));providerClosed=true;}

const {buildReviewSourcePlan,buildReviewSourceCoverage}=await import(pathToFileURL(join(root,"src/review-source-plan.js")));
const {captureModelSourceContext}=await import(pathToFileURL(join(root,"src/model-source-location.js")));
// A frozen-source run must use that module's own AsyncLocalStorage instance;
// mixing current and frozen contexts would create an unrelated missing-scope red.
const execution=await import(pathToFileURL(join(sourceRoot,"src/ark-execution-store.js"))),context=await import(pathToFileURL(join(sourceRoot,"src/ark-execution-context.js")));
await check("physical unknown receipt survives frozen native timeout and aborted scope without collector",async()=>{
 for(const nested of [false,true]){
  const s=scope("native-timeout-"+nested,"native-timeout-"+nested),p={units:[{unitId:"U"}]},controller=new AbortController();s.signal=controller.signal;
  await m.prepareReviewPlan({scope:s,plan:p});let physicalReceipt;
  await assert.rejects(m.runReviewUnit({scope:s,unitId:"U",input:{fixture:"software timeout"},execute:async()=>{
   try{const {signal:operationalSignal,...requestScope}=context.getArkScope();await execution.executeArkAttempt({storageRoot:s.executionRoot,poolId:s.poolId,scope:requestScope,body:{model:"software",input:"software timeout"},transport:async()=>{throw new DOMException("software response timed out","TimeoutError");},consumeResponse:r=>r.json()});}
   catch(error){physicalReceipt=error.arkAttemptReceipt;assert.equal(physicalReceipt?.status,"unknown_sent");const native=new DOMException("software native timeout","TimeoutError");Object.defineProperty(native,"arkAttemptReceipt",{value:physicalReceipt});Object.freeze(native);controller.abort(native);throw nested?Object.freeze(Object.assign(new Error("software wrapper",{cause:native}),{code:"SOFTWARE_RESPONSE_TIMEOUT"})):native;}
  },validate:output=>({status:"completed",output})}),error=>{assert.equal(error.checkpointReceipt.status,"unknown_sent");assert(error.cause);return true;});
  const coverage=await m.readReviewPlanCoverage({scope:s});assert.equal(coverage.unknownSent,1);assert.equal(coverage.counts.cancelled,0);assert.equal(coverage.units[0].requestReceipts.length,1);assert.equal(coverage.units[0].requestReceipts[0].attemptId,physicalReceipt.attemptId);
  await assert.rejects(m.prepareReviewPlan({scope:{...s,jobRunId:s.jobRunId+"-resume"},plan:p,fromRunId:s.jobRunId}),{code:"REVIEW_PLAN_UNKNOWN_SENT"});
  const statePath=join(s.planRoot,"runs","p"+sha(s.jobRunId),"state.json"),original=readFileSync(statePath),legacy=JSON.parse(original);legacy.value.units.U.status="failed";legacy.sha256=m.reviewPlanFingerprint(legacy.value);writeFileSync(statePath,JSON.stringify(legacy)+"\n");
  try{await assert.rejects(m.prepareReviewPlan({scope:{...s,jobRunId:s.jobRunId+"-legacy-resume"},plan:p,fromRunId:s.jobRunId}),{code:"REVIEW_PLAN_UNKNOWN_SENT"});let repeated=false;await assert.rejects(m.runReviewUnit({scope:s,unitId:"U",input:{fixture:"software timeout"},execute:async()=>{repeated=true;return{};},validate:output=>({status:"completed",output})}),{code:"REVIEW_PLAN_UNKNOWN_SENT"});assert.equal(repeated,false);}finally{writeFileSync(statePath,original);}
 }
});
const proofDoc={sourcePackageSha256:h,sourceVersionId:binding.versionId,paragraphs:[{index:0,id:"p0",part:"document.xml",text:"  软件😀甲  ",sourceXmlNodeId:"body-0",sourceXmlParagraphOrdinal:0}],footnotes:[{index:0,noteId:"8",id:"f0",part:"footnotes.xml",text:"原脚注文字",sourceXmlNodeId:"foot-8",sourceXmlParagraphOrdinal:0}],endnotes:[{index:0,noteId:"9",id:"e0",part:"endnotes.xml",text:"",sourceXmlNodeId:"end-9",sourceXmlParagraphOrdinal:0}]};
const primaryPlan=buildReviewSourcePlan(proofDoc,{windowChars:100,maxParasPerWindow:10}),entries=primaryPlan.windows.flatMap(w=>w.entries),ranges=primaryPlan.windows.flatMap(w=>w.primaryRanges);
const endpointIdentity={origin:"http://127.0.0.1:software-only",pathSha256:sha("/software/responses")};
const proofScope=id=>({...scope(id,"certificate"),endpointIdentity});
const inputForEntries=es=>({prompt:es.map(e=>`[主来源] [primary target=${e.target};index=${e.index};rawStart=${e.rawStart};rawEnd=${e.rawEnd};part=${e.part}${e.noteId!=null?`;noteId=${e.noteId}`:""}] ${e.text}`).join("\n"),sourceContext:captureModelSourceContext(proofDoc,{win:es,sourceVersionId:binding.versionId}),model:"software"});
const proofPlan=units=>({config:{model:"software"},primarySourcePlan:primaryPlan,windows:primaryPlan.windows.map(w=>w.entries),units});
const proofUnit=async(s,unitId,es,{invalidBefore=false,bodyOverride,outputOverride}={})=>m.runReviewUnit({scope:s,unitId,input:inputForEntries(es),execute:async()=>{
 const send=async text=>{const sent=await execution.executeArkAttempt({storageRoot:s.executionRoot,poolId:s.poolId,scope:context.getArkScope(),body:{model:"software",input:bodyOverride??inputForEntries(es).prompt},transport:async()=>new Response(JSON.stringify({output_text:text,usage:{input_tokens:1,output_tokens:0}}),{status:200}),consumeResponse:r=>r.json()});context.recordArkAttempt(sent.receipt);};
 if(invalidBefore)await send("software invalid JSON");await send('{"issues":[]}');
 return outputOverride||{ok:true,text:'{"issues":[]}',sourceContext:inputForEntries(es).sourceContext,typed:new Map([["kept",{zero:0}]])};
},validate:output=>({status:"completed",output})});
const proofPath=(s,name)=>join(s.planRoot,"runs","p"+sha(s.jobRunId),name);
const editWrapped=(path,mutate)=>{const original=readFileSync(path),row=JSON.parse(original);mutate(row.value);row.sha256=m.reviewPlanFingerprint(row.value);writeFileSync(path,JSON.stringify(row)+"\n");return()=>writeFileSync(path,original);};
let certifiedScope,certifiedCoverage;
await check("completed metadata and callback-only output cannot certify primary exposure",async()=>{
 const s=proofScope("callback-primary"),unit={unitId:"P",source:{primaryRanges:ranges,ruleId:null}};await m.prepareReviewPlan({scope:s,plan:proofPlan([unit])});
 await m.runReviewUnit({scope:s,unitId:"P",input:inputForEntries(entries),execute:async()=>({ok:true,text:'{"issues":[]}',sourceContext:inputForEntries(entries).sourceContext}),validate:output=>({status:"completed",output})});
 const cheap=await m.readReviewPlanCoverage({scope:s});assert.equal(cheap.completed,1);assert.equal(typeof m.verifyReviewPlanCheckpoints,"function");assert.equal(m.isVerifiedReviewSourceUnit(cheap.units[0]),false);
 const verified=await m.verifyReviewPlanCheckpoints({scope:s});assert.equal(verified.verification.verifiedPrimaryUnits,0);assert.equal(buildReviewSourceCoverage(primaryPlan,{units:verified.units}).status,"partial");
});
await check("confirmed physical body raw response and typed checkpoint certify real primary ranges",async()=>{
 const s=certifiedScope=proofScope("certified"),unit={unitId:"P",source:{primaryRanges:ranges,ruleId:null}};await m.prepareReviewPlan({scope:s,plan:proofPlan([unit])});await proofUnit(s,"P",entries,{invalidBefore:true});
 const saved=await m.runReviewUnit({scope:s,unitId:"P",input:inputForEntries(entries),execute:()=>{throw Error("must use saved output");},validate:()=>{throw Error("must not validate again");}});assert(saved.typed instanceof Map);assert.equal(saved.typed.get("kept").zero,0);
 const result=certifiedCoverage=await m.verifyReviewPlanCheckpoints({scope:s}),u=result.units[0];assert.equal(m.isVerifiedReviewSourceUnit(u),true);assert.equal(result.verification.verifiedPrimaryUnits,1);assert.equal(u.verificationCertificate.physicalAttemptIds.length,1);assert.equal(u.requestReceipts.length,2);assert.equal(buildReviewSourceCoverage(primaryPlan,{units:result.units}).status,"complete");
 assert(Object.isFrozen(u)&&Object.isFrozen(u.source.primaryRanges[0]));assert.equal(m.isVerifiedReviewSourceUnit(structuredClone(u)),false);assert.equal(m.isVerifiedReviewSourceUnit(JSON.parse(JSON.stringify(u))),false);
 await assert.rejects(async()=>{u.source.primaryRanges[0].rawEnd++;},TypeError);
});
await check("immutable input output and raw response corruption fail without changing cheap metadata reads",async()=>{
 assert(certifiedScope);const s=certifiedScope,cheap=await m.readReviewPlanCoverage({scope:s}),u=cheap.units[0];
 for(const name of ["inputs/"+u.inputReceipt.file,"outputs/"+u.outputReceipt.file]){const path=proofPath(s,name),original=readFileSync(path);writeFileSync(path,Buffer.concat([original,Buffer.from("broken")]));try{assert.equal((await m.readReviewPlanCoverage({scope:s})).completed,1);await assert.rejects(m.verifyReviewPlanCheckpoints({scope:s}),{code:"REVIEW_PLAN_CORRUPT"});}finally{writeFileSync(path,original);}}
 const summary=await execution.readArkExecutionSummary({storageRoot:s.executionRoot,poolId:s.poolId,jobRunId:s.jobRunId}),actual=summary.attempts.at(-1),pool=join(s.executionRoot,"pools",s.poolId);
 const raw=join(pool,"attempts",actual.id,"raw-response.bin"),original=readFileSync(raw);writeFileSync(raw,"tampered raw response");try{assert.equal((await m.readReviewPlanCoverage({scope:s})).completed,1);await assert.rejects(m.verifyReviewPlanCheckpoints({scope:s}),{code:"ARK_RESPONSE_HASH_MISMATCH"});}finally{writeFileSync(raw,original);}
 assert.equal((await m.verifyReviewPlanCheckpoints({scope:s})).verification.verifiedPrimaryUnits,1);
});
await check("endpoint input scope and foreign output sources cannot be forged by metadata",async()=>{
 const s=certifiedScope,u=(await m.readReviewPlanCoverage({scope:s})).units[0];
 await assert.rejects(m.verifyReviewPlanCheckpoints({scope:{...s,endpointIdentity:{...endpointIdentity,pathSha256:sha("foreign")}}}),{code:"REVIEW_PLAN_CHECKPOINT_MISMATCH"});
 const inputPath=proofPath(s,"inputs/"+u.inputReceipt.file),restore=editWrapped(inputPath,v=>{v.input.sourceContext.entries[0].rawEnd--;});try{await assert.rejects(m.verifyReviewPlanCheckpoints({scope:s}),{code:"REVIEW_PLAN_CHECKPOINT_MISMATCH"});}finally{restore();}
 const wrong=proofScope("foreign-output");await m.prepareReviewPlan({scope:wrong,plan:proofPlan([{unitId:"P",source:{primaryRanges:ranges,ruleId:null}}])});const out={ok:true,text:'{"issues":[]}',sourceContext:structuredClone(inputForEntries(entries).sourceContext)};out.sourceContext.entries[1].noteId="foreign";
 await proofUnit(wrong,"P",entries,{outputOverride:out});await assert.rejects(m.verifyReviewPlanCheckpoints({scope:wrong}),{code:"REVIEW_PLAN_CHECKPOINT_MISMATCH"});
});
await check("references and unsent ranges never become primary even with confirmed empty issues",async()=>{
 const s=proofScope("unsent-reference");await m.prepareReviewPlan({scope:s,plan:proofPlan([{unitId:"P",source:{primaryRanges:ranges,ruleId:null}}])});await proofUnit(s,"P",entries,{bodyOverride:inputForEntries(entries).prompt.replaceAll("[primary ","[reference ")});await assert.rejects(m.verifyReviewPlanCheckpoints({scope:s}),{code:"REVIEW_PLAN_CHECKPOINT_MISMATCH"});
});
await check("parent without own physical receipts authenticates exact successful child union and explicit reuse",async()=>{
 const s=proofScope("child-union"),p=proofPlan([{unitId:"P",source:{primaryRanges:ranges,ruleId:null}}]);await m.prepareReviewPlan({scope:s,plan:p});await m.registerReviewUnits({scope:s,units:entries.map((e,i)=>({unitId:"P/"+i,parentUnitId:"P",required:false,source:{primaryRanges:[ranges[i]],ruleId:null}}))});
 await m.runReviewUnit({scope:s,unitId:"P",input:inputForEntries(entries),execute:async()=>{for(let i=0;i<entries.length;i++)await proofUnit(s,"P/"+i,[entries[i]]);return{issues:[],errors:[],unknownSent:false};},validate:output=>({status:"completed",output})});
 const checked=await m.verifyReviewPlanCheckpoints({scope:s}),parent=checked.units.find(u=>u.unitId==="P");assert.equal(parent.requestReceipts.length,0);assert.equal(m.isVerifiedReviewSourceUnit(parent),true);assert.equal(parent.verificationCertificate.basis,"verified-child-primary-union");assert.equal(parent.verificationCertificate.physicalAttemptIds.length,3);assert.equal(buildReviewSourceCoverage(primaryPlan,{units:[parent]}).status,"complete");
 const resumed={...s,jobRunId:"child-union-resume",resumedFromRunId:s.jobRunId};await m.prepareReviewPlan({scope:resumed,plan:p});await m.runReviewUnit({scope:resumed,unitId:"P",input:inputForEntries(entries),execute:()=>{throw Error("parent must reuse validated prior children");},validate:()=>{throw Error("parent must reuse");}});
 const reused=await m.verifyReviewPlanCheckpoints({scope:resumed});assert.equal(reused.units.length,1);assert.equal(m.isVerifiedReviewSourceUnit(reused.units[0]),true);assert.equal(reused.units[0].verificationCertificate.basis,"verified-prior-checkpoint");assert.equal(buildReviewSourceCoverage(primaryPlan,{units:reused.units}).status,"complete");
 const restore=editWrapped(proofPath(resumed,"state.json"),v=>{v.units.P.reuseReceipt.fromRunId="certified";});try{await assert.rejects(m.verifyReviewPlanCheckpoints({scope:resumed}),{code:"REVIEW_PLAN_CHECKPOINT_MISMATCH"});}finally{restore();}
});
await check("incomplete child union and unknown receipts earn no whole-parent coverage",async()=>{
 const s=proofScope("incomplete-union");await m.prepareReviewPlan({scope:s,plan:proofPlan([{unitId:"P",source:{primaryRanges:ranges,ruleId:null}}])});await m.registerReviewUnits({scope:s,units:[{unitId:"P/0",parentUnitId:"P",required:false,source:{primaryRanges:[ranges[0]],ruleId:null}}]});
 await m.runReviewUnit({scope:s,unitId:"P",input:inputForEntries(entries),execute:async()=>{await proofUnit(s,"P/0",[entries[0]]);return{issues:[],errors:[],unknownSent:false};},validate:output=>({status:"completed",output})});const verified=await m.verifyReviewPlanCheckpoints({scope:s});assert.equal(m.isVerifiedReviewSourceUnit(verified.units.find(u=>u.unitId==="P")),false);const coverage=buildReviewSourceCoverage(primaryPlan,{units:verified.units});assert.equal(coverage.status,"partial");assert(coverage.byTarget.footnote.pendingUtf16>0);assert.equal(coverage.totals.completedNodes,1);
 const original=certifiedScope,restore=editWrapped(proofPath(original,"state.json"),v=>{v.units.P.requestReceipts[0].status="unknown_sent";});try{await assert.rejects(m.verifyReviewPlanCheckpoints({scope:original}),{code:"REVIEW_PLAN_CHECKPOINT_MISMATCH"});}finally{restore();}
});

const after=Object.fromEntries(files.map(p=>[p,sha(readFileSync(p))])),report={schemaVersion:1,kind:"source-plan/checkpoint callback and actual loopback software controls",generatedAt:new Date().toISOString(),checks,passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,roots,sourceBefore:before,sourceAfter:after,sourceFrozen:files.every(p=>before[p]===after[p])&&selectedSourceSha256===sha(readFileSync(selectedSource)),selectedSource,selectedSourceSha256,helperSha256:sha(readFileSync(process.argv[1])),realArkCalls:0,paidModelCalls:0,softwareProviderRequests:providerRequests,providerClosed,ownedProcesses,applicationServiceStarts:0,ownedProviderStarted:provider?1:0,confirmedPeer:"Owned Node process exited0 after a callback Response was durably confirmed and before window commit; that peer used no network provider or manuscript judgments."};writeFileSync(join(base,"report.json"),JSON.stringify(report,null,2)+"\n",{flag:"wx"});console.log(JSON.stringify({passed:report.passed,failed:report.failed,sourceFrozen:report.sourceFrozen,report:join(base,"report.json")}));process.exitCode=report.failed?1:0;

