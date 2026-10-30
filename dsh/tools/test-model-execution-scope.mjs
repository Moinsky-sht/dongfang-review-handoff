/** Fixed local Responses controls; no manuscript judgment or real Ark request. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,resolve,relative,isAbsolute,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const arg=name=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3);
const phase=arg('phase')||'current';
assert(['before','current'].includes(phase));
const within=(root,path)=>{const rel=relative(root,path);return !!rel&&!rel.startsWith('..')&&!isAbsolute(rel);};
const verifyRoot=join(ROOT,'data/verify'),runsRoot=join(ROOT,'data/optimization/runs');
let cfg=null;
try{cfg=JSON.parse(await readFile(join(ROOT,'tmp/coverage-current-run.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const run=cfg?.runDirectory?resolve(cfg.runDirectory):null;
if(run)assert(within(runsRoot,run),'Coverage pointer must identify a managed evidence run');
const inherited=process.env.DSH_VERIFICATION_EVIDENCE_DIR?resolve(ROOT,process.env.DSH_VERIFICATION_EVIDENCE_DIR):null;
const explicit=arg('out');
if(explicit!==undefined)assert(explicit.trim(),'Explicit output must name a directory');
const fresh=Date.now()+'-'+randomUUID();
const out=explicit!==undefined?resolve(ROOT,explicit):inherited?join(inherited,'model-execution-scope-'+fresh)
  :join(verifyRoot,'model-execution-scope',fresh);
const authorizedRoots=[verifyRoot,...(run?[run]:[]),...(inherited?[inherited]:[])];
const authorizedRoot=authorizedRoots.find(root=>within(root,out));
assert(authorizedRoot,'Output must be within an authorized verification evidence root');
async function guardPath(path,{writing=false,directory=false}={}){
  for(let current=path;;current=dirname(current)){
    try{
      const stat=await lstat(current);
      assert(!stat.isSymbolicLink(),'No linked evidence path');
      assert(resolve(await realpath(current)).toLowerCase()===resolve(current).toLowerCase(),'No aliased evidence path');
      if(current!==path||directory)assert(stat.isDirectory(),'Evidence parent must be a directory');
    }catch(error){if(error.code!=='ENOENT')throw error;}
    if(writing){try{await lstat(join(current,'complete.json'));throw Error('Sealed evidence is read-only');}catch(error){if(error.code!=='ENOENT')throw error;}}
    if(dirname(current)===current)break;
  }
}
await guardPath(out,{writing:true,directory:true});
await mkdir(dirname(out),{recursive:true});
await guardPath(out,{writing:true,directory:true});
await mkdir(out,{recursive:false});
const sha=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const arkSource=arg('ark-source')?resolve(ROOT,arg('ark-source')):join(ROOT,'src/ark.js');
if(arkSource!==join(ROOT,'src/ark.js'))assert(within(runsRoot,arkSource)||within(verifyRoot,arkSource),'Archived source must be managed verification evidence');
await guardPath(arkSource);
const sourceBefore=await readFile(arkSource);
await writeFile(join(out,'ark-source.js'),sourceBefore,{flag:'wx'});
await writeFile(join(out,'test-source.mjs'),await readFile(fileURLToPath(import.meta.url)),{flag:'wx'});
if(arg('guard-only')==='true'){
  const admission={schemaVersion:1,kind:'output-admission',phase,out,authorizedRoot,
    outputSelection:explicit!==undefined?'explicit':inherited?'inherited':'default',arkSource,
    sourceSha256:sha(sourceBefore),testSourceSha256:sha(await readFile(fileURLToPath(import.meta.url))),
    checks:['authorized-root','full-ancestor-unsealed','no-alias','exclusive-fresh-directory'],
    localResponsesRequests:0,realArkCalls:0,ok:true};
  await writeFile(join(out,'admission.json'),JSON.stringify(admission,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(admission));
  process.exit(0);
}
const report={schemaVersion:1,phase,out,arkSource,sourceSha256:sha(sourceBefore),generatedSoftwareFixture:true,
  localResponsesAdapterActuallyExercised:true,realArkCalls:0,paidModelCalls:0,semanticJudgments:0,checks:[],scenarios:[]};
let mode='',requests=[];
const usage={input_tokens:11,output_tokens:7,input_tokens_details:{cached_tokens:3}};
const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);requests.push({method:req.method,path:req.url,body});
  const input=String(body.input||''),instructions=String(body.instructions||'');
  const digest=instructions.includes('通读纲要');
  const consistency=instructions.includes('现在做一次「全篇一致性终检」');
  const blocked=['half-split','nested-split','mixed-split-failure'].includes(mode)&&input.includes('SOFTWARE-BLOCKED')
    || mode==='per-rule-blocked';
  if(blocked){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'SensitiveContentDetected',message:'fixed software rejection'}}));return;}
  if(mode==='mixed-split-failure'&&input.includes('SOFTWARE-ERROR')){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'FixedSoftwareRequestError',message:'fixed non-sensitive rejection'}}));return;}
  let text=JSON.stringify({issues:[]});
  if(digest)text=mode==='digest-failure'?'fixed invalid digest JSON':JSON.stringify({summary:'Fixed software summary',structure:['Fixed section'],keyTerms:['Fixed term'],claims:['Fixed claim']});
  else if(consistency&&mode==='consistency-failure')text='fixed invalid consistency JSON';
  else if(!consistency&&(mode==='consistency-zero'||mode==='consistency-failure'))text=JSON.stringify({issues:[{ruleId:'LANG-999',category:'software',severity:'低',title:'SOFTWARE-ISSUE',quote:'SOFTWARE-SUCCESS',paragraphIndex:0,problem:'fixed fixture',suggestion:'fixed fixture'}]});
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({output_text:text,usage}));
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base=`http://127.0.0.1:${server.address().port}`;
process.env.ARK_BASE_URL=base;process.env.ARK_API_KEY='local-software-only';process.env.ARK_MODEL='software-scope-model';
process.env.ARK_CASES='0';process.env.ARK_CONSISTENCY='0';process.env.ARK_PREFIX_CACHE='0';
// Scope probes must never inherit stale request pools or business checkpoints.
for(const [variable,name] of Object.entries({DSH_SESSION_ROOT:'sessions',DSH_WORKING_VERSION_ROOT:'versions',DSH_WORKSPACE_ROOT:'workspaces',DSH_AUDIT_ROOT:'audit',DSH_LEGACY_ROOT:'legacy',DSH_INGESTION_ROOT:'ingestions',DSH_JOB_ROOT:'jobs',DSH_ARK_EXECUTION_ROOT:'execution',DSH_REVIEW_PLAN_ROOT:'plans'})) process.env[variable]=join(out,'storage',name);
process.env.DSH_ARK_POOL_ID='software-execution-scope';process.env.DSH_ARK_POOL_CONCURRENCY='2';
process.env.DSH_COMMENT_INDEX=join(out,'intentionally-absent-case-index.json');
const nativeFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>{assert.equal(String(url),base+'/responses','Only the owned local provider may receive a request');return nativeFetch(url,options);};
const node=(text,index,part,noteId)=>({text,index,id:`${part}:${index}`,part,
  sourceXmlParagraphOrdinal:index,sourceXmlNodeId:`${part}:xml-p:${index}`,
  ...(noteId!=null?{noteId,isNoteSeparator:false}:{}),textView:'after',offsetUnit:'utf16',paragraphIndexOwner:'application-paragraph-index'});
const doc=(texts=['SOFTWARE-SUCCESS'],notes=[])=>({paragraphs:texts.map((text,index)=>node(text,index,'document.xml')),
  footnotes:notes.map((text,index)=>node(text,index,'footnotes.xml',String(index+1))),endnotes:[],sourcePackageSha256:'0'.repeat(64),
  stats:{chars:texts.join('').length},footnoteRefs:notes.map((_,index)=>String(index+1))});
const check=(name,fn)=>{try{fn();report.checks.push({name,ok:true});}catch(error){report.checks.push({name,ok:false,error:{name:error.name,message:error.message}});}};
try{
  const moduleUrl=arkSource===join(ROOT,'src/ark.js')?pathToFileURL(arkSource).href:'data:text/javascript;base64,'+Buffer.from(sourceBefore.toString('utf8')
    .replace(/from (['"])(\.\/[^'"]+)\1/g,(_,quote,specifier)=>'from '+quote+pathToFileURL(resolve(ROOT,'src',specifier)).href+quote)).toString('base64');
  const {modelReview}=await import(moduleUrl);
  const baselinePath=arg('baseline')?resolve(ROOT,arg('baseline')):null;
  if(baselinePath){assert(within(runsRoot,baselinePath)||within(verifyRoot,baselinePath),'Baseline must be managed verification evidence');await guardPath(baselinePath);}
  const baseline=baselinePath?JSON.parse(await readFile(baselinePath,'utf8')):null;
  const scenarios=[
    {name:'normal-zero',doc:doc()},
    {name:'digest-failure',doc:doc(),options:{useContext:true}},
    {name:'half-split',doc:doc(['SOFTWARE-SUCCESS','SOFTWARE-BLOCKED'])},
    {name:'nested-split',doc:doc(['SOFTWARE-SUCCESS','SOFTWARE-SUCCESS-TWO','SOFTWARE-SUCCESS-THREE','SOFTWARE-BLOCKED'])},
    {name:'mixed-split-failure',doc:doc(['SOFTWARE-BLOCKED','SOFTWARE-ERROR'])},
    {name:'per-rule-blocked',doc:doc(['SOFTWARE-BLOCKED']),options:{ruleMode:'per-rule'}},
    {name:'cases-disabled',doc:doc(),options:{useCases:true}},
    {name:'cases-unavailable',doc:doc(),options:{useCases:true},cases:'1'},
    {name:'consistency-zero',doc:doc(),options:{useContext:true},consistency:'1'},
    {name:'consistency-failure',doc:doc(),options:{useContext:true},consistency:'1'},
    {name:'long-body-prefix',doc:doc(['SOFTWARE-LONG '.repeat(450)])},
    {name:'note-excerpt-limit',doc:doc(['SOFTWARE-SUCCESS'],['SOFTWARE-NOTE '.repeat(600)])},
    {name:'per-rule-task-limit',doc:doc(['SOFTWARE-ONE','SOFTWARE-TWO']),options:{ruleMode:'per-rule',maxParasPerWindow:1,perRuleMaxTasks:1}},
  ];
  for(const scenario of scenarios){
    mode=scenario.name;requests=[];process.env.ARK_CASES=scenario.cases||'0';process.env.ARK_CONSISTENCY=scenario.consistency||'0';
    const progress=[];
    const result=await modelReview(scenario.doc,{model:'software-scope-model',useContext:false,useCases:false,concurrency:1,
      docMeta:{title:'Generated software control',modelRules:[{id:'LANG-999',title:'Fixed software rule',method:'Fixed software predicate'}]},
      onProgress:event=>progress.push(event),...scenario.options});
    const invariant={requests,issues:result.issues,usage:result.usage,windows:result.windows,modelsUsed:result.modelsUsed,
      outOfScopeRuleIds:result.outOfScopeRuleIds,globalIssues:result.globalIssues,casesUsed:result.casesUsed};
    const facts={name:scenario.name,requestCount:requests.length,invariantSha256:sha(invariant),invariant,
      executionScope:result.executionScope||null,errors:result.errors,blockedParagraphs:result.blockedParagraphs,progress};
    report.scenarios.push(facts);
    check(scenario.name+' has actual scope',()=>assert.equal(result.executionScope?.schemaVersion,1));
    if(baseline)check(scenario.name+' retains exact requests/issues/usage',()=>{
      const old=baseline.scenarios.find(item=>item.name===scenario.name);assert(old,'Missing before scenario');
      assert.equal(sha(invariant),old.invariantSha256);
      assert.deepEqual(JSON.parse(JSON.stringify(invariant)),old.invariant);
    });
    const scope=result.executionScope;
    if(scenario.name==='normal-zero')check('zero issue normal request has truthful source coverage independent of quality',()=>{
      assert.equal(requests.length,1);assert.equal(result.issues.length,0);assert.equal(scope?.status,'completed');assert.equal(scope?.fullTextCoverage,phase==='before'?'unverified':'complete');
      if(phase==='current'){assert.equal(scope.sourceCoverage.status,'complete');assert.equal(scope.sourceCoverage.totals.coveredUtf16,scenario.doc.paragraphs[0].text.length);assert.equal(scope.sourceCoverage.totals.pendingUtf16,0);}
      assert.equal(scope?.context.status,'disabled');assert.equal(scope?.consistency.status,'disabled');
    });
    if(scenario.name==='digest-failure')check('digest failure remains explicit without altering window results',()=>{
      assert.equal(requests.length,2);assert.equal(scope?.context.status,'failed');assert.equal(scope?.status,'partial');assert(scope?.incompleteReasons.length);
    });
    if(scenario.name==='half-split')check('half split does not swallow failed child or its blocked source',()=>{
      assert(result.errors.some(error=>error.paragraphs?.includes(1)));assert.deepEqual(result.blockedParagraphs,[1]);assert.equal(scope?.status,'partial');
    });
    if(scenario.name==='nested-split')check('nested successful split preserves descendant failure and blocked source',()=>{
      assert(result.errors.some(error=>error.paragraphs?.includes(3)));assert.deepEqual(result.blockedParagraphs,[3]);assert.equal(scope?.status,'partial');
    });
    if(scenario.name==='mixed-split-failure')check('early non-sensitive failure preserves the preceding sensitive child metadata',()=>{
      assert(result.errors.some(error=>error.paragraphs?.includes(0)));assert.deepEqual(result.blockedParagraphs,[0]);assert.equal(scope?.status,'partial');
    });
    if(scenario.name==='per-rule-blocked')check('per-rule sensitive rejection has both error and blocked source',()=>{
      assert(result.errors.some(error=>error.window===1));assert.deepEqual(result.blockedParagraphs,[0]);assert.equal(scope?.status,'partial');
    });
    if(scenario.name==='cases-disabled')check('requested cases retain explicit configured-disabled state',()=>{
      assert.equal(scope?.cases.requested,true);assert.equal(scope?.cases.enabled,false);assert.equal(scope?.cases.status,'disabled');assert.equal(scope?.cases.count,0);
    });
    if(scenario.name==='cases-unavailable')check('missing case index is unavailable rather than silently completed',()=>{
      assert.equal(scope?.cases.enabled,true);assert.equal(scope?.cases.status,'unavailable');assert(scope?.cases.reason);
    });
    if(scenario.name==='consistency-zero')check('zero consistency findings retain actual successful attempt',()=>{
      assert.equal(requests.length,3);assert.equal(result.globalIssues,0);assert.equal(scope?.consistency.status,'completed');assert.equal(scope?.consistency.configured,true);
    });
    if(scenario.name==='consistency-failure')check('consistency failed result is independent of zero findings',()=>{
      assert.equal(requests.length,3);assert.equal(result.globalIssues,0);assert.equal(scope?.consistency.status,'failed');assert.equal(scope?.status,'partial');
    });
    if(['long-body-prefix','note-excerpt-limit'].includes(scenario.name))check(scenario.name+' preserves full source through primary windows or exposes old omission',()=>{
      if(phase==='before'){assert.equal(scope?.fullTextCoverage,'partial');assert(scope?.sourceCoverageGaps.length);assert.equal(requests.length,1);}
      else{const expected=[...scenario.doc.paragraphs,...scenario.doc.footnotes].reduce((n,p)=>n+p.text.length,0);assert.equal(scope?.fullTextCoverage,'complete');assert.equal(scope.sourceCoverage.status,'complete');assert.equal(scope.sourceCoverage.totals.expectedUtf16,expected);assert.equal(scope.sourceCoverage.totals.coveredUtf16,expected);assert.equal(scope.sourceCoverage.totals.pendingUtf16,0);assert.equal(scope.sourceCoverageGaps.length,0);assert(requests.length>1);}
    });
    if(scenario.name==='per-rule-task-limit')check('unexecuted per-rule tasks remain partial',()=>{
      assert.equal(requests.length,1);assert(result.errors.length);assert.equal(scope?.status,'partial');
    });
  }
}catch(error){report.setupError={name:error.name,message:error.message,stack:error.stack};}
finally{
  globalThis.fetch=nativeFetch;server.closeAllConnections();await new Promise(done=>server.close(done));
  report.sourceStable=sha(await readFile(arkSource))===report.sourceSha256;
  report.passed=report.checks.filter(item=>item.ok).length;report.failed=report.checks.filter(item=>!item.ok).length;
  report.ok=!report.setupError&&!report.failed&&report.sourceStable;
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({out,report:join(out,'report.json'),phase,ok:report.ok,passed:report.passed,failed:report.failed,sourceStable:report.sourceStable,setupError:report.setupError?.message,realArkCalls:0}));
  if(!report.ok)process.exitCode=1;
}
