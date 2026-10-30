/** Actual human-state module contracts. Generated DOCX only; no model, browser or service. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {parseDocxBuffer} from '../src/docx.js';
import {writeZip} from '../src/zip-write.js';
import {saveSessionSnapshot,loadSessionSnapshot} from '../src/session-store.js';

const PROJECT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const flag=name=>process.argv.find(arg=>arg.startsWith('--'+name+'='))?.slice(name.length+3);
const hash=value=>createHash('sha256').update(value).digest('hex');
const within=(base,path)=>{const r=relative(base,path);return r===''||r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};
const RUNS=join(PROJECT,'data/optimization/runs'),VERIFY=join(PROJECT,'data/verify');
const pointer=JSON.parse(await readFile(join(PROJECT,'tmp/projection-current-run.json'),'utf8'));
assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(pointer.runId||''));
const current=resolve(pointer.runDirectory);assert.equal(current,join(RUNS,pointer.runId));assert(isAbsolute(pointer.runDirectory));
const inherited=process.env.DSH_VERIFICATION_EVIDENCE_DIR?resolve(PROJECT,process.env.DSH_VERIFICATION_EVIDENCE_DIR):null;
if(inherited)assert(within(RUNS,inherited)&&inherited!==RUNS,'Inherited evidence must identify a project run');
const evidenceRoot=resolve(PROJECT,flag('evidence-root')||inherited||VERIFY);
assert(within(VERIFY,evidenceRoot)||within(current,evidenceRoot)||inherited&&within(inherited,evidenceRoot),'Unauthorized evidence root');
async function guard(path){for(let p=resolve(path);;p=dirname(p)){assert(!existsSync(join(p,'complete.json')),'Sealed evidence ancestor: '+p);try{const info=await lstat(p);assert(info.isDirectory()&&!info.isSymbolicLink(),'Evidence alias/ancestor rejected');assert.equal(resolve(await realpath(p)).toLowerCase(),p.toLowerCase());}catch(error){if(error.code!=='ENOENT')throw error;}if(p===dirname(p))break;}}
await guard(evidenceRoot);await mkdir(evidenceRoot,{recursive:true});
const out=join(evidenceRoot,'human-raw-'+Date.now()+'-'+randomUUID());await mkdir(out);
const sourcePath=resolve(PROJECT,flag('human-source')||'src/human-state.js');assert(within(PROJECT,sourcePath));
const sourceBefore=hash(await readFile(sourcePath)),parserBefore=hash(await readFile(join(PROJECT,'src/docx.js')));
const {buildHumanRecord,humanState,humanAuditEntry,effectiveReviewRunId}=await import(pathToFileURL(sourcePath).href);
const report={at:new Date().toISOString(),out,humanSourcePath:sourcePath,humanSourceSha256:sourceBefore,parserSourceSha256:parserBefore,
  testSha256:hash(await readFile(fileURLToPath(import.meta.url))),verificationRunId:process.env.DSH_VERIFICATION_RUN_ID||pointer.runId,
  realArkCalls:0,modelCalls:0,apiCalls:0,servicesStarted:0,nativeBrowserVerified:false,manuscriptContentJudgment:false,
  scope:'Actual buildHumanRecord/humanState/humanAuditEntry on generated parsed DOCX; no actual-manuscript quality, DOM or Word proof.',checks:[]};
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const esc=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;');
const p=text=>'<w:p><w:r><w:t xml:space="preserve">'+esc(text)+'</w:t></w:r></w:p>';
const body='<w:p><w:r><w:t>甲</w:t><w:tab/><w:t>乙</w:t><w:tab/><w:t>乙😀</w:t></w:r></w:p>'+p('  \t  ')
  +'<w:p><w:del><w:r><w:delText>删除</w:delText></w:r></w:del><w:ins><w:r><w:t>新😀</w:t></w:r></w:ins></w:p>'
  +'<w:p><w:r><w:t>甲</w:t><w:noBreakHyphen/><w:t>乙</w:t></w:r></w:p>';
const bytes=writeZip([{name:'word/document.xml',data:`<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`},
  {name:'word/footnotes.xml',data:`<w:footnotes xmlns:w="${W}"><w:footnote w:id="-1" w:type="separator">${p('separator')}</w:footnote><w:footnote w:id="7">${p('同\t文😀')}${p(' \t ')}</w:footnote><w:footnote w:id="8">${p('同\t文😀')}</w:footnote></w:footnotes>`},
  {name:'word/endnotes.xml',data:`<w:endnotes xmlns:w="${W}"><w:endnote w:id="-1" w:type="separator">${p('separator')}</w:endnote><w:endnote w:id="7">${p('同\t文😀')}${p(' \t ')}</w:endnote><w:endnote w:id="8">${p('同\t文😀')}</w:endnote></w:endnotes>`},
  {name:'[Content_Types].xml',data:'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'}]);
await writeFile(join(out,'generated-only.docx'),bytes,{flag:'wx'});
const fields={body:'paragraphs',footnote:'footnotes',endnote:'endnotes'};
function fixture(){const doc=parseDocxBuffer(bytes),digest=hash(bytes);return {id:'shumanraw',name:'SOFTWARE-ONLY.docx',doc,
  workVersion:{id:'shumanraw:v000000-'+digest,sha256:digest,sourceSha256:digest},humanRevision:0,humanRecords:[],mutationEpoch:0,
  result:null,resultRunId:null,reviewRunId:null,reviewRunning:false,interrupted:false,reviewError:null};}
function request(s,mark,changes={}){return {kind:'mark',operationId:'software-'+randomUUID(),purpose:'verification',verificationRunId:pointer.runId,
  baseVersionId:s.workVersion.id,baseMutationEpoch:s.mutationEpoch,expectedHumanRevision:s.humanRevision,baseRunId:effectiveReviewRunId(s),mark,...changes};}
function rawMark(s,target='body',index=0,start=1,end=2,extra={}){const n=s.doc[fields[target]][index];return {target,index,start,end,offsetSpace:'raw',quote:n.text.slice(start,end),text:n.text.slice(start,end),
  textView:'after',offsetUnit:'utf16',paragraphIndexOwner:'application-paragraph-index',sourceVersionId:s.workVersion.id,sourcePackageSha256:s.workVersion.sha256,
  part:n.part,sourceXmlNodeId:n.sourceXmlNodeId,sourceXmlParagraphOrdinal:n.sourceXmlParagraphOrdinal,rawNodeTextSha256:hash(n.text),
  ...(target==='body'?{}:{noteId:n.noteId}),...extra};}
function append(s,mark){const record=buildHumanRecord(s,request(s,mark));s.humanRecords.push(record);s.humanRevision++;return record;}
async function check(name,fn){try{const detail=await fn();report.checks.push({name,ok:true,...(detail?{detail}:{} )});}catch(error){report.checks.push({name,ok:false,error:error.stack||String(error)});}}
const rejects=(s,mark,status)=>assert.throws(()=>buildHumanRecord(s,request(s,mark)),error=>error.status===(status||400)||!status&&error.status===409);
await check('baseline normalized pure TAB has empty coordinates and cannot be saved',()=>{const s=fixture();assert.equal(s.doc.paragraphs[0].text,'甲\t乙\t乙😀');rejects(s,{target:'body',index:0,start:1,end:1,offsetSpace:'normalized',quote:'\t'},400);});
for(const [name,target,index,start,end]of [['body TAB','body',0,1,2],['body trailing repeated occurrence','body',0,4,5],['body pure whitespace','body',1,0,5],['body after revision emoji','body',2,1,3],['body raw NoBreakHyphen','body',3,1,2],['footnote TAB','footnote',1,1,2],['footnote pure whitespace','footnote',2,0,3],['endnote TAB','endnote',1,1,2],['endnote pure whitespace','endnote',2,0,3]])await check('raw '+name+' retains exact original coordinates and text',()=>{const s=fixture(),m=rawMark(s,target,index,start,end),r=append(s,m);assert.equal(r.mark.offsetSpace,'raw');assert.equal(r.mark.start,start);assert.equal(r.mark.end,end);assert.equal(r.mark.rawStart,start);assert.equal(r.mark.rawEnd,end);assert.equal(r.mark.quote,m.quote);assert.equal(r.mark.text,m.quote);assert.equal(r.mark.rawNodeTextSha256,m.rawNodeTextSha256);assert.equal(r.mark.nodeTextSha256,hash(s.doc[fields[target]][index].text.replace(/\s/g,'')));assert.equal(r.mark.sourceXmlNodeId,m.sourceXmlNodeId);assert.equal(r.mark.sourceVersionId,s.workVersion.id);assert.equal(humanState(s).marks.length,1);return {target,index,start,end,quote:m.quote};});
await check('normalized input stays normalized and maps second repeated occurrence as before',()=>{const s=fixture(),r=append(s,{target:'body',index:0,start:2,end:3,offsetSpace:'normalized',quote:'乙'});assert.equal(r.mark.offsetSpace,'normalized');assert.equal(r.mark.rawStart,4);assert.equal(r.mark.rawEnd,5);assert.equal(r.mark.quote,'乙');assert.equal(humanState(s).marks[0].offsetSpace,'normalized');});
await check('legacy normalized history remains isolated from raw coordinate interpretation',()=>{const s=fixture(),r=append(s,{target:'body',index:0,start:2,end:3,offsetSpace:'normalized',quote:'乙'});r.mark.rawStart=4;r.mark.rawEnd=5;assert.equal(humanState(s).marks[0].start,2);assert.equal(humanState(s).marks[0].rawStart,4);assert.equal(humanState({...s,id:'another'}).marks.length,0);assert.equal(humanState({...s,workVersion:{...s.workVersion,id:'another'}}).marks.length,0);});
for(const [field,value]of [['offsetSpace','other'],['offsetSpace','RAW'],['textView','before'],['offsetUnit','unicode-scalar'],['paragraphIndexOwner','xml-paragraph-index'],['sourceVersionId','stale'],['sourcePackageSha256','0'.repeat(64)],['part','endnotes.xml'],['sourceXmlNodeId','document.xml:xml-p:1'],['sourceXmlParagraphOrdinal',1],['rawNodeTextSha256','0'.repeat(64)],['nodeTextSha256','0'.repeat(64)],['quote','乙'],['text','乙'],['pid','document.xml:99'],['id','document.xml:99'],['rawStart',2],['rawEnd',3],['sourceXmlTableNodeId','document.xml:xml-tbl:99'],['noteId','7'],['noteType','separator']])await check('raw rejects mismatched declaration '+field,()=>{const s=fixture();rejects(s,rawMark(s,'body',0,1,2,{[field]:value}));});
for(const field of ['textView','offsetUnit','paragraphIndexOwner','sourceVersionId','sourcePackageSha256','part','sourceXmlNodeId','sourceXmlParagraphOrdinal','rawNodeTextSha256'])await check('raw requires explicit '+field,()=>{const s=fixture(),m=rawMark(s);delete m[field];rejects(s,m);});
await check('raw normalized-looking coordinates never silently remove or jump over TAB',()=>{const s=fixture();rejects(s,rawMark(s,'body',0,1,2,{quote:'乙',text:'乙'}));const r=buildHumanRecord(s,request(s,rawMark(s,'body',0,2,3)));assert.equal(r.mark.quote,'乙');assert.equal(r.mark.rawStart,2);});
await check('display NoBreakHyphen U+2011 is rejected when exact raw source is ASCII hyphen',()=>{const s=fixture();assert.equal(s.doc.paragraphs[3].text,'甲-乙');rejects(s,rawMark(s,'body',3,1,2,{quote:'\u2011',text:'\u2011'}));});
for(const [start,end]of [[5,6],[6,7]])await check('raw rejects split UTF16 surrogate '+start+':'+end,()=>{const s=fixture();rejects(s,rawMark(s,'body',0,start,end),400);});
for(const [start,end]of [[-1,1],[1,1],[1,8],[0.5,2]])await check('raw rejects invalid bounds '+start+':'+end,()=>{const s=fixture();rejects(s,rawMark(s,'body',0,start,end));});
for(const target of ['footnote','endnote']){
  await check(target+' raw rejects missing owner, equal text in another note and separator',()=>{const s=fixture(),m=rawMark(s,target,1,1,2);delete m.noteId;rejects(s,m);rejects(s,rawMark(s,target,1,1,2,{noteId:'8'}));rejects(s,rawMark(s,target,1,1,2,{noteType:'separator'}));rejects(s,rawMark(s,target,0,0,1));rejects(s,rawMark(s,target,1,1,2,{target:target==='footnote'?'endnote':'footnote'}));});
  await check(target+' multiple paragraphs with same note owner keep distinct physical identities',()=>{const s=fixture(),a=append(s,rawMark(s,target,1,1,2)),b=append(s,rawMark(s,target,2,1,2));assert.equal(a.mark.noteId,b.mark.noteId);assert.notEqual(a.mark.sourceXmlNodeId,b.mark.sourceXmlNodeId);assert.equal(humanState(s).marks.length,2);});
}
for(const [field,value]of [['textView','before'],['offsetUnit','unicode-scalar'],['paragraphIndexOwner','xml-paragraph-index'],['sourcePackageSha256','0'.repeat(64)],['id','document.xml:99'],['index',99],['part','footnotes.xml'],['sourceXmlNodeId','document.xml:xml-p:99'],['sourceXmlParagraphOrdinal',-1]])await check('raw refuses corrupted current parsed source '+field,()=>{const s=fixture(),m=rawMark(s);s.doc.paragraphs[0][field]=value;rejects(s,m);});
await check('raw refuses a current document or working package SHA mismatch',()=>{for(const kind of ['doc','workVersion']){const s=fixture(),m=rawMark(s);if(kind==='doc')s.doc.sourcePackageSha256='0'.repeat(64);else s.workVersion.sha256='0'.repeat(64);rejects(s,m);}});
await check('raw refuses duplicate physical node identity in a current container',()=>{const s=fixture(),m=rawMark(s);s.doc.paragraphs[1].sourceXmlNodeId=s.doc.paragraphs[0].sourceXmlNodeId;rejects(s,m);});
await check('raw stale version, epoch, human revision and review run still reject at existing CAS boundary',()=>{const s=fixture(),m=rawMark(s);for(const changes of [{baseVersionId:'other'},{baseMutationEpoch:1},{expectedHumanRevision:1},{baseRunId:'other'}])assert.throws(()=>buildHumanRecord(s,request(s,m,changes)),error=>error.status===409);});
await check('raw restored records are withheld when work SHA or source content no longer match',()=>{const s=fixture(),r=append(s,rawMark(s));assert.equal(humanState(s).marks.length,1);assert.equal(humanState({...s,workVersion:{...s.workVersion,sha256:'0'.repeat(64)}}).marks.length,0);const changed=structuredClone(s);changed.doc.paragraphs[0].text='changed';assert.equal(humanState(changed).marks.length,0);r.mark.noteId='wrong';assert.equal(humanState(s).marks.length,0);});
await check('raw records preserve version history and return only to their exact immutable version',()=>{const s=fixture(),r=append(s,rawMark(s)),different=structuredClone(s);different.workVersion={...s.workVersion,id:'other',sha256:'0'.repeat(64)};assert.equal(humanState(different).marks.length,0);assert.equal(humanState(different).historyCount,1);assert.equal(humanState(s).marks[0].id,r.id);});
await check('actual durable session roundtrip preserves raw TAB/whitespace observations until exact source bytes are rehydrated',async()=>{const s=fixture();for(const target of ['body','footnote','endnote'])append(s,rawMark(s,target,target==='body'?1:2,0,target==='body'?5:3));const expected=humanState(s);await guard(out);const storageRoot=join(out,'isolated-sessions');await saveSessionSnapshot({sessionId:s.id,snapshot:s,expectedRevision:-1,storageRoot});const restored=(await loadSessionSnapshot({sessionId:s.id,storageRoot})).snapshot;assert.equal(restored.doc,undefined);assert.equal(humanState(restored).marks.length,0,'Unrehydrated source cannot prove raw marks');const reloadedBytes=await readFile(join(out,'generated-only.docx'));assert.equal(hash(reloadedBytes),s.workVersion.sha256);restored.doc=parseDocxBuffer(reloadedBytes);assert.deepEqual(humanState(restored),expected);return {records:restored.humanRecords.length,storageRoot,generatedSourceSha256:hash(reloadedBytes)};});
await check('raw audit projection carries exact range and complete source identity',()=>{const s=fixture(),r=append(s,rawMark(s)),a=humanAuditEntry(s,r);assert.equal(a.quote,'\t');assert.equal(a.provenance.offsetSpace,'raw');assert.equal(a.provenance.start,1);assert.equal(a.provenance.end,2);assert.equal(a.provenance.rawStart,1);assert.equal(a.provenance.rawEnd,2);assert.equal(a.provenance.rawNodeTextSha256,r.mark.rawNodeTextSha256);assert.equal(a.provenance.sourceXmlNodeId,r.mark.sourceXmlNodeId);assert.equal(a.provenance.sourcePackageSha256,s.workVersion.sha256);assert.equal(a.provenance.sourceVersionId,s.workVersion.id);});
report.sourceAfterSha256=hash(await readFile(sourcePath));report.parserAfterSha256=hash(await readFile(join(PROJECT,'src/docx.js')));
await check('actual exercised source stayed unchanged during this test',()=>{assert.equal(report.sourceAfterSha256,sourceBefore);assert.equal(report.parserAfterSha256,parserBefore);});
report.passed=report.checks.filter(c=>c.ok).length;report.failed=report.checks.length-report.passed;report.finishedAt=new Date().toISOString();
await guard(out);await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({out,passed:report.passed,failed:report.failed,humanSourceSha256:sourceBefore,modelCalls:0}));
if(report.failed)process.exitCode=1;
