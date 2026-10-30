/** Every registered DOCX version: independent range reconstruction, no semantic judgment. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..'),RUNS=join(ROOT,'data/optimization/runs'),VERIFY=join(ROOT,'data/verify');
const arg=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3),sha=b=>createHash('sha256').update(b).digest('hex');
const json=p=>JSON.parse(readFileSync(p,'utf8'));
const within=(r,p)=>{const s=relative(resolve(r),resolve(p));return !!s&&s!=='..'&&!s.startsWith('..'+sep)&&!isAbsolute(s);};
function guard(p,writing=false){for(let d=resolve(p);;d=dirname(d)){
 const st=lstatSync(d,{throwIfNoEntry:false});if(st)assert(!st.isSymbolicLink()&&resolve(realpathSync(d)).toLowerCase()===d.toLowerCase(),'Aliased path refused');
 if(writing)assert(!lstatSync(join(d,'complete.json'),{throwIfNoEntry:false}),'Sealed evidence refused');if(d===dirname(d))break;
}}
const pointer=json(join(ROOT,'tmp/primary-source-current-run.json')),run=resolve(pointer.runDirectory);assert(within(RUNS,run));
const inherited=process.env.DSH_VERIFICATION_EVIDENCE_DIR?resolve(ROOT,process.env.DSH_VERIFICATION_EVIDENCE_DIR):null;
const out=resolve(ROOT,arg('out')||join(inherited||VERIFY,'corpus-review-source-plan-'+Date.now()+'-'+randomUUID().slice(0,8)));
assert([run,VERIFY,...(inherited?[inherited]:[])].some(r=>within(r,out)));guard(out,true);assert(!lstatSync(out,{throwIfNoEntry:false}));mkdirSync(out,{recursive:true});
const put=(n,v)=>{guard(join(out,n),true);writeFileSync(join(out,n),typeof v==='string'?v:JSON.stringify(v,null,2)+'\n',{flag:'wx'});};
put('test-source.mjs',readFileSync(fileURLToPath(import.meta.url),'utf8'));
let deniedNetwork=0;globalThis.fetch=()=>{deniedNetwork++;throw Error('Corpus source planning denies network/model calls');};
const sourceRoot=resolve(ROOT,arg('source-root')||'.');assert(sourceRoot===ROOT||within(RUNS,sourceRoot)||within(VERIFY,sourceRoot));guard(sourceRoot);
const phase=arg('phase')||'current';assert(['before','current'].includes(phase));
const sources=['src/docx.js','src/model-source-location.js','src/review-source-plan.js','src/ark.js'];
const fingerprints=Object.fromEntries(sources.map(f=>[f,lstatSync(join(sourceRoot,f),{throwIfNoEntry:false})?sha(readFileSync(join(sourceRoot,f))):null]));
const {parseDocxBuffer}=await import(pathToFileURL(join(sourceRoot,'src/docx.js')));
const {captureModelSourceContext}=await import(pathToFileURL(join(sourceRoot,'src/model-source-location.js')));
let planner=null,legacy=null;
if(fingerprints['src/review-source-plan.js'])({buildReviewSourcePlan:planner}=await import(pathToFileURL(join(sourceRoot,'src/review-source-plan.js'))));
else if(phase==='before')({buildWindows:legacy}=await import(pathToFileURL(join(sourceRoot,'src/ark.js'))));
else throw Error('Current source must have full primary source planner');
const baseline=json(join(ROOT,'data/optimization/latest.json')),inventoryPath=join(ROOT,baseline.path,'inventory.json'),inventoryBytes=readFileSync(inventoryPath),inventory=JSON.parse(inventoryBytes);
assert.equal(inventory.files.length,715);
const ledgerBytes=readFileSync(join(ROOT,'data/optimization/task-ledger.json')),derivedBytes=readFileSync(join(ROOT,'data/optimization/derived-assets.json')),derivedRegistry=JSON.parse(derivedBytes);
assert.equal(derivedRegistry.assets.length,19);
const originals=inventory.files.map(a=>({...a,path:resolve(inventory.sourceRoot,a.relativePath),sourceKind:'original'}));
const originalBefore=originals.map(a=>{const actual=sha(readFileSync(a.path));assert.equal(actual,a.sourceSha256,a.relativePath);return{assetId:a.assetId,sourceSha256:actual};});
const archivePath=resolve(ROOT,arg('derived-manifest')||'data/optimization/runs/g0-02-assets-20261009073435/artifacts/archive-1791532468754-19299e94/manifest.json');guard(archivePath);
const archiveBytes=readFileSync(archivePath),archive=JSON.parse(archiveBytes),derived=[];
assert.equal(archive.originalPhysicalDenominator,715);assert.equal(archive.memberCount,19);
for(const a of archive.archives){
 const parent=originals.find(p=>p.assetId===a.parent.assetId);assert(parent);assert.equal(parent.sourceSha256,a.parent.sha256);
 for(const m of a.members){
  const row=derivedRegistry.assets.find(d=>d.assetId===m.derivedAssetId);assert(row,'All archive members registered');
  if(m.status!=='retained'){derived.push({assetId:row.assetId,sourceKind:'derived',sourceSha256:row.sourceSha256,relativePath:row.sourcePath,ingestionRoute:'excluded',exclusionReason:row.exclusionReason||m.reason||m.status,sourceChain:row.sourceChain});continue;}
  assert(m.contentFile&&m.crcVerified===true);const path=resolve(dirname(archivePath),m.contentFile);assert(within(dirname(archivePath),path));guard(path);
  assert.equal(sha(readFileSync(path)),m.contentSha256);assert.equal(m.contentSha256,row.sourceSha256);assert.equal(m.parentSha256,parent.sourceSha256);
  assert.equal(m.sourceChain[0].assetId,parent.assetId);assert.equal(m.sourceChain[0].sha256,parent.sourceSha256);assert.equal(m.sourceChain[1].ordinal,m.ordinal);assert.equal(m.sourceChain[1].derivedAssetId,row.assetId);
  derived.push({assetId:row.assetId,sourceKind:'derived',relativePath:row.sourcePath,path,sourceSha256:m.contentSha256,sourceChain:m.sourceChain,ingestionRoute:/\.docx$/i.test(m.name)?'docx':'legacy_doc_conversion'});
 }
}
assert.equal(derived.length,19);
const candidates=[...originals,...derived],rows=[],TABLE={paragraph:'paragraphs',footnote:'footnotes',endnote:'endnotes'};
const boundary=(t,n)=>Number.isSafeInteger(n)&&n>=0&&n<=t.length&&!(n>0&&n<t.length&&t.charCodeAt(n)>=0xdc00&&t.charCodeAt(n)<=0xdfff&&t.charCodeAt(n-1)>=0xd800&&t.charCodeAt(n-1)<=0xdbff);
mkdirSync(join(out,'assets'));
for(const asset of candidates){
 const row={assetId:asset.assetId,sourceKind:asset.sourceKind,sourcePath:asset.relativePath,sourceSha256:asset.sourceSha256,sourceChain:asset.sourceChain||null,status:'pending',semanticReviewed:false,qualityStatus:asset.ingestionRoute==='excluded'?'not_applicable':'pending'};
 if(asset.ingestionRoute!=='docx'){
  row.status=asset.ingestionRoute==='excluded'?'excluded_technical':'pending_format_or_role';row.reason=asset.exclusionReason||asset.ingestionRoute;rows.push(row);continue;
 }
 try{
  const bytes=readFileSync(asset.path);assert.equal(sha(bytes),asset.sourceSha256);const doc=parseDocxBuffer(bytes,asset.relativePath),plan=planner?planner(doc,{windowChars:1500,maxParasPerWindow:10}):null;
  const windows=plan?.windows||legacy(doc,{windowChars:1500,maxParasPerWindow:10}).map((entries,ordinal)=>({ordinal:ordinal+1,entries:entries.map(e=>({target:'paragraph',index:e.index,rawStart:doc.paragraphs[e.index].text.length-doc.paragraphs[e.index].text.trimStart().length,text:e.text}))}));
  const slices=new Map(),exposed=new Map(),windowRecords=[];
  for(const w of windows){
   const entries=w.entries;assert(Array.isArray(entries));const context=captureModelSourceContext(doc,{win:entries,window:w.ordinal});assert.equal(context.rejectedEntries.length,0);
   for(const e of entries){
    const target=e.target||'paragraph',p=doc[TABLE[target]]?.[e.index];assert(p&&!p.isNoteSeparator);const end=e.rawEnd??e.rawStart+e.text.length;
    assert(boundary(p.text,e.rawStart)&&boundary(p.text,end));assert.equal(p.text.slice(e.rawStart,end),e.text);assert.equal(end-e.rawStart,e.text.length);
    const key=target+':'+e.index;if(!slices.has(key))slices.set(key,[]);slices.get(key).push({start:e.rawStart,end,text:e.text});
    if(!exposed.has(key))exposed.set(key,[]);exposed.get(key).push(...context.entries.filter(c=>c.target===target&&c.index===e.index&&c.rawStart===e.rawStart&&c.rawEnd===end));
   }
   windowRecords.push({id:w.id||null,ordinal:w.ordinal,primaryRanges:entries.map(({text,...entry})=>({...entry,textSha256:sha(text)})),contextSha256:sha(JSON.stringify(context))});
  }
  const nodes=[],violations=[],unreviewedVisibleObjects=[],stats=Object.fromEntries(Object.keys(TABLE).map(t=>[t,{nodes:0,utf16:0,tableNodes:0}]));
  for(const [target,array]of Object.entries(TABLE))for(const [index,p]of(doc[array]||[]).entries()){
   if(p.isNoteSeparator){nodes.push({target,index,status:'excluded_separator',reason:'non-manuscript note separator'});continue;}
   assert.equal(typeof p.text,'string');const key=target+':'+index,ordered=(slices.get(key)||[]).sort((a,b)=>a.start-b.start);let cursor=0,rebuilt='';
   for(const e of ordered){if(e.start!==cursor)violations.push({target,index,start:cursor,end:e.start,reason:e.start<cursor?'primary_overlap':'primary_gap'});cursor=e.end;rebuilt+=e.text;}
   if(cursor!==p.text.length||rebuilt!==p.text)violations.push({target,index,rawStart:cursor,rawEnd:p.text.length,reason:'source_not_exactly_reconstructed'});
   if(p.text.length&&!ordered.length)violations.push({target,index,reason:'source_never_primary'});
   for(const e of ordered)if(e.text.length&&!(exposed.get(key)||[]).some(c=>c.rawStart===e.start&&c.rawEnd===e.end&&c.sentText===e.text))violations.push({target,index,rawStart:e.start,rawEnd:e.end,reason:'primary_context_not_verified'});
   stats[target].nodes++;stats[target].utf16+=p.text.length;if(p.inTable)stats[target].tableNodes++;
   for(const [ordinal,box]of(p.textboxes||[]).entries())unreviewedVisibleObjects.push({target,index,ordinal,kind:'textbox',sourceXmlNodeId:p.sourceXmlNodeId||null,textSha256:sha(typeof box==='string'?box:JSON.stringify(box)),reason:'visible_textbox_not_in_primary_text',status:'pending'});
   for(const [ordinal,figure]of(p.figures||[]).entries())unreviewedVisibleObjects.push({target,index,ordinal,kind:figure.kind||'figure',sourceXmlNodeId:p.sourceXmlNodeId||null,reason:'visual_object_not_covered_by_primary_text_plan',status:'pending'});
   nodes.push({target,index,pid:p.id||null,noteId:p.noteId??null,sourceXmlNodeId:p.sourceXmlNodeId||null,sourceXmlTableNodeId:p.sourceXmlTableNodeId||null,sourceUtf16:p.text.length,sourceTextSha256:sha(p.text),reconstructedTextSha256:sha(rebuilt),ranges:ordered.map(({text,...r})=>r)});
  }
  row.status=violations.length?'failed':'source_plan_verified';row.windows=windows.length;row.manifestSha256=plan?.manifestSha256||null;row.stats=stats;row.violations=violations;row.unreviewedVisibleObjectCount=unreviewedVisibleObjects.length;
  const evidence={schemaVersion:1,...row,basis:'independent reconstruction of every parsed after-text primary node, not provider execution',nodes,windows:windowRecords,excluded:plan?.excluded||[],unreviewedVisibleObjects,parserPackageSha256:doc.sourcePackageSha256};
  put('assets/'+asset.assetId+'.json',evidence);row.evidence='assets/'+asset.assetId+'.json';assert.equal(sha(readFileSync(asset.path)),asset.sourceSha256);
 }catch(error){row.status='failed';row.error={name:error.name,message:error.message};if(!row.evidence){put('assets/'+asset.assetId+'.json',row);row.evidence='assets/'+asset.assetId+'.json';}}
 rows.push(row);
}
assert.equal(rows.length,734);assert.equal(rows.filter(r=>r.sourceKind==='original').length,715);assert.equal(rows.filter(r=>r.sourceKind==='derived').length,19);
const originalAfter=originals.map(a=>{const actual=sha(readFileSync(a.path));assert.equal(actual,a.sourceSha256,a.relativePath);return{assetId:a.assetId,sourceSha256:actual};});assert.deepEqual(originalAfter,originalBefore);
for(const a of derived.filter(x=>x.path))assert.equal(sha(readFileSync(a.path)),a.sourceSha256);
assert.deepEqual(readFileSync(join(ROOT,'data/optimization/task-ledger.json')),ledgerBytes);assert.deepEqual(readFileSync(join(ROOT,'data/optimization/derived-assets.json')),derivedBytes);
const sourceStable=sources.every(f=>fingerprints[f]===null||sha(readFileSync(join(sourceRoot,f)))===fingerprints[f]);assert(sourceStable);assert.equal(deniedNetwork,0);
const report={schemaVersion:1,at:new Date().toISOString(),phase,sourceRoot,out,fingerprints,sourceStable,inventorySha256:sha(inventoryBytes),derivedManifestSha256:sha(archiveBytes),originalDenominator:715,derivedDenominator:19,eligibleDocx:639,selectedDocx:rows.filter(r=>r.windows!=null||r.error).length,verifiedDocx:rows.filter(r=>r.status==='source_plan_verified').length,failedDocx:rows.filter(r=>r.status==='failed').length,pendingOrExcluded:rows.filter(r=>!['failed','source_plan_verified'].includes(r.status)).length,originalsModified:false,ledgersUnchanged:true,modelCalls:0,realArkCalls:0,semanticJudgments:0,qualityPromoted:false,basis:'All parsed body/table/footnote/endnote raw UTF16 ranges reconstructed independently; not full OOXML, actual model review or independent quality.',originalSourceProof:originalAfter,rows};
report.ok=report.verifiedDocx===639&&report.failedDocx===0&&report.sourceStable;put('report.json',report);
console.log(JSON.stringify({report:join(out,'report.json'),phase,verifiedDocx:report.verifiedDocx,failedDocx:report.failedDocx,original715Unchanged:true,realArkCalls:0,ok:report.ok}));if(!report.ok)process.exitCode=1;
