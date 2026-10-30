/** Explicit source ranges: actual functions, real 43-note control and software negative fixtures. No API/server/model. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute,sep} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {parseDocxBuffer} from '../src/docx.js';
import {buildCommentedDocx} from '../src/docx-comments.js';
import {openZip} from '../src/zip.js';
import {writeZip} from '../src/zip-write.js';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..'),arg=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const evidenceRoot=resolve(ROOT,process.env.DSH_VERIFICATION_EVIDENCE_DIR||'data/verify');
const out=resolve(ROOT,arg('out')||join(evidenceRoot,'explicit-source-anchors-'+Date.now()+'-'+randomUUID())),phase=arg('phase')||'green',sourcePath=resolve(ROOT,arg('anchor-source')||'src/anchors.js');
const within=(r,p)=>{const s=relative(resolve(r),resolve(p));return s&&s!=='..'&&!s.startsWith('..'+sep)&&!isAbsolute(s);};
assert(within(join(ROOT,'data/verify'),out)||within(join(ROOT,'data/optimization/runs'),out));assert(['red','green'].includes(phase));
for(let a=out;;a=dirname(a)){try{const st=await lstat(a);assert(!st.isSymbolicLink());assert.equal(resolve(await realpath(a)).toLowerCase(),a.toLowerCase());}catch(e){if(e.code!=='ENOENT')throw e;}
try{await lstat(join(a,'complete.json'));throw Error('Sealed output ancestor');}catch(e){if(e.code!=='ENOENT')throw e;}if(a===dirname(a))break;}
await mkdir(out);const sha=b=>createHash('sha256').update(b).digest('hex'),sourceSha256=sha(await readFile(sourcePath));
const {computeAnchor,computeAnchors}=await import(pathToFileURL(sourcePath));
const save=(name,data)=>writeFile(join(out,name),Buffer.isBuffer(data)||typeof data==='string'?data:JSON.stringify(data,null,2)+'\n',{flag:'wx'});
await save('test-source.mjs',await readFile(fileURLToPath(import.meta.url)));
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const para=t=>'<w:p><w:r><w:t>'+t+'</w:t></w:r></w:p>';
const buffer=writeZip([{name:'word/document.xml',data:'<w:document xmlns:w="'+W+'"><w:body>'+para('foo foo')+para('foo bar')+para('😀 foo')+'</w:body></w:document>'},
 {name:'word/endnotes.xml',data:'<w:endnotes xmlns:w="'+W+'"><w:endnote w:id="5">'+para('foo foo')+'</w:endnote></w:endnotes>'},
 {name:'[Content_Types].xml',data:'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'}]);
const doc=parseDocxBuffer(buffer),version='ssoftware:v000000-'+sha(buffer);doc.sourceVersionId=version;
const base={ruleId:'SOFTWARE-EXPLICIT',paragraphIndex:0,location:'paragraph:0',quote:'foo'};
const basic={target:'paragraph',index:0,start:4,end:7,text:'foo',precision:'exact'};
const canonical={...basic,textView:'after',offsetUnit:'utf16',paragraphIndexOwner:'application-paragraph-index',
 pid:doc.paragraphs[0].id,part:doc.paragraphs[0].part,sourceXmlNodeId:doc.paragraphs[0].sourceXmlNodeId,
 sourceXmlParagraphOrdinal:doc.paragraphs[0].sourceXmlParagraphOrdinal,sourcePackageSha256:sha(buffer),sourceVersionId:version};
const checks=[];
const test=(name,observe,verify)=>{let observed;try{observed=observe();verify(observed);checks.push({name,ok:true,observed});}catch(error){checks.push({name,ok:false,observed,error:{name:error.name,message:error.message}});}};
const valid=a=>{assert.equal(a.resolutionStatus,'resolved');assert.equal(a.start,4);assert.equal(a.end,7);assert.equal(a.text,'foo');assert.equal(a.rangeProof,'verified-explicit-anchor');assert.equal(a.precision,'exact');};
test('legacy explicit second range remains exact despite repeated single-word quote',()=>computeAnchor({...base,anchor:basic},doc),valid);
test('fully declared current source range remains exact',()=>computeAnchor({...base,anchor:canonical},doc),a=>{valid(a);assert.equal(a.sourceXmlNodeId,canonical.sourceXmlNodeId);assert.equal(a.sourcePackageSha256,sha(buffer));assert.equal(a.sourceVersionId,version);});
test('explicit range can be the sole concrete source target',()=>computeAnchor({ruleId:'SOFTWARE-ANCHOR-ONLY',quote:'foo',anchor:canonical},doc),valid);
test('grouped explicit occurrences own separate offsets without parent inheritance',()=>computeAnchors({...base,autoFix:{find:'foo',replace:'bar',offset:0},anchor:{...canonical,start:0,end:3},
 occurrences:[{paragraphIndex:0,anchor:{...canonical,start:0,end:3}},{paragraphIndex:0,anchor:canonical}]},doc),a=>{
 assert.deepEqual(a.map(x=>x.start),[0,4]);assert(a.every(x=>x.rangeProof==='verified-explicit-anchor'));assert.deepEqual(a.map(x=>x.occurrenceIndex),[0,1]);
});
const cases=[
 ['different target',{target:'endnote'},'conflicting_source_target'],
 ['different logical index',{index:1},'conflicting_source_target'],
 ['before view',{textView:'before'},'unsupported_text_view'],
 ['unknown view',{textView:'normalized'},'unsupported_text_view'],
 ['non-UTF16 unit',{offsetUnit:'unicode-scalar'},'unsupported_offset_unit'],
 ['unknown index owner',{paragraphIndexOwner:'xml-ordinal'},'unsupported_index_owner'],
 ['before owner',{owner:'before'},'unsupported_source_owner'],
 ['foreign logical pid',{pid:'document.xml:1'},'source_identity_mismatch'],
 ['foreign part',{part:'word/endnotes.xml'},'source_identity_mismatch'],
 ['foreign physical node',{sourceXmlNodeId:'document.xml:xml-p:2'},'source_identity_mismatch'],
 ['foreign physical ordinal',{sourceXmlParagraphOrdinal:2},'source_identity_mismatch'],
 ['wrong package hash',{sourcePackageSha256:'b'.repeat(64)},'source_package_mismatch'],
 ['wrong working package hash',{workSha256:'b'.repeat(64)},'source_package_mismatch'],
 ['wrong source version',{sourceVersionId:'another'},'source_version_mismatch'],
 ['wrong work version',{workVersionId:'another'},'source_version_mismatch'],
 ['wrong version alias',{versionId:'another'},'source_version_mismatch'],
 ['stale literal',{text:'bar'},'stale_explicit_range'],
 ['out-of-bounds',{end:8,text:'foo '},'invalid_explicit_range'],
 ['fractional offset',{start:4.5,end:7.5},'invalid_explicit_range'],
 ['already ambiguous source',{resolutionStatus:'ambiguous'},'unresolved_source_range'],
];
for(const[name,delta,reason]of cases)test('explicit '+name+' is rejected without after-text search',()=>computeAnchor({...base,anchor:{...canonical,...delta}},doc),a=>{
 assert.equal(a.resolutionStatus,'unmapped');assert.equal(a.resolutionReason,reason);assert.notEqual(a.precision,'exact');
 assert.deepEqual(a.rejectedExplicitAnchor,{...canonical,...delta});
});
test('supplied version without a reviewed version context is not invented',()=>computeAnchor({...base,anchor:canonical},{...doc,sourceVersionId:null}),a=>{
 assert.equal(a.resolutionReason,'source_version_unverified');assert.equal(a.resolutionStatus,'unmapped');
});
test('split surrogate explicit source cannot become an after match',()=>computeAnchor({...base,paragraphIndex:2,location:'paragraph:2',quote:'foo',anchor:{target:'paragraph',index:2,start:1,end:2,text:'\uDE00',precision:'exact'}},doc),a=>{
 assert.equal(a.resolutionReason,'invalid_explicit_range');assert.equal(a.resolutionStatus,'unmapped');
});
test('valid supplementary character keeps its exact UTF16 boundaries',()=>computeAnchor({...base,paragraphIndex:2,location:'paragraph:2',quote:'😀',anchor:{target:'paragraph',index:2,start:0,end:2,text:'😀',precision:'exact'}},doc),a=>{
 assert.equal(a.start,0);assert.equal(a.end,2);assert.equal(a.text,'😀');assert.equal(a.rangeProof,'verified-explicit-anchor');
});
test('non-explicit duplicate quote remains ambiguous and never becomes first exact',()=>computeAnchor(base,doc),a=>{
 assert.equal(a.resolutionStatus,'ambiguous');assert.deepEqual(a.candidateRanges.map(x=>x.start),[0,4]);
});
test('non-explicit verified offset control stays precise',()=>computeAnchor({...base,autoFix:{find:'foo',replace:'bar',offset:4}},doc),a=>{
 assert.equal(a.start,4);assert.equal(a.precision,'exact');assert.equal(a.rangeProof,'verified-text-at-offset');
});
test('contradictory location cannot be hidden by an otherwise valid literal range',()=>computeAnchor({...base,location:'paragraph:1',anchor:canonical},doc),a=>{
 assert.equal(a.resolutionReason,'conflicting_source_target');assert.equal(a.resolutionStatus,'unmapped');
});
test('contradictory issue-level before declaration is retained as a typed rejection',()=>computeAnchor({...base,textView:'before',anchor:canonical},doc),a=>{
 assert.equal(a.resolutionReason,'unsupported_text_view');assert.equal(a.resolutionStatus,'unmapped');assert.deepEqual(a.rejectedExplicitAnchor,canonical);
});
test('contradictory issue-level version cannot be replaced by the anchor version',()=>computeAnchor({...base,sourceVersionId:'stale',anchor:canonical},doc),a=>{
 assert.equal(a.resolutionReason,'source_version_mismatch');assert.equal(a.resolutionStatus,'unmapped');
});
test('unknown source resolution status cannot be promoted to resolved',()=>computeAnchor({...base,anchor:{...canonical,resolutionStatus:'unsupported-state'}},doc),a=>{
 assert.equal(a.resolutionReason,'unresolved_source_range');assert.equal(a.resolutionStatus,'unmapped');
});
test('explicit anchor for an out-of-bounds source index never adopts a valid neighbor',()=>computeAnchor({...base,paragraphIndex:99,anchor:canonical},doc),a=>{
 assert.equal(a.resolutionReason,'conflicting_source_target');assert.equal(a.resolutionStatus,'unmapped');assert.deepEqual(a.rejectedExplicitAnchor,canonical);
});
test('paragraph navigation retains its resolution class after literal verification',()=>computeAnchor({...base,anchor:{...canonical,start:0,end:7,text:'foo foo',precision:'paragraph',resolutionStatus:'paragraph'}},doc),a=>{
 assert.equal(a.resolutionStatus,'paragraph');assert.equal(a.precision,'paragraph');assert.equal(a.rangeProof,'verified-explicit-anchor');
});
test('structural navigation never borrows a mismatched package identity',()=>computeAnchor({location:'document',anchor:{target:'document',index:0,start:0,end:0,text:'',precision:'document',sourcePackageSha256:'b'.repeat(64)}},doc),a=>{
 assert.equal(a.resolutionReason,'source_package_mismatch');assert.equal(a.resolutionStatus,'unmapped');
});
const uniqueBase={...base,paragraphIndex:1,location:'paragraph:1'},uniqueAnchor={...canonical,index:1,start:0,end:3,
 pid:doc.paragraphs[1].id,sourceXmlNodeId:doc.paragraphs[1].sourceXmlNodeId,sourceXmlParagraphOrdinal:doc.paragraphs[1].sourceXmlParagraphOrdinal};
for(const[name,delta,reason]of [
 ['before',{textView:'before'},'unsupported_text_view'],
 ['unknown-view',{textView:'unknown'},'unsupported_text_view'],
 ['stale-package',{sourcePackageSha256:'b'.repeat(64)},'source_package_mismatch'],
 ['stale-version',{sourceVersionId:'stale'},'source_version_mismatch'],
 ['foreign-physical-node',{sourceXmlNodeId:'document.xml:xml-p:0'},'source_identity_mismatch'],
 ['wrong-literal-range',{text:'bar'},'stale_explicit_range'],
])test('actual writer cannot remount rejected '+name+' input to a unique after quote',()=>{
 const input={...uniqueBase,anchor:{...uniqueAnchor,...delta}},anchor=computeAnchor(input,doc);
 const result=buildCommentedDocx({buffer,issues:[{...input,anchor}],workVersionId:version,workSha256:sha(buffer)});
 return{anchor,added:result.added,skipped:result.skipped,skippedDetails:result.skippedDetails,inputBytesIntact:result.buffer.equals(buffer)};
},o=>{
 assert.equal(o.anchor.resolutionReason,reason);assert.equal(o.added,0);assert.equal(o.skipped,1);assert(o.inputBytesIntact);
 assert.equal(o.skippedDetails[0].reasonCode,'unresolved_source_range');
});
const pointer=JSON.parse(await readFile(join(ROOT,'tmp/endnote-current-run.json'),'utf8'));
const meta=JSON.parse(await readFile(join(pointer.runDirectory,'run.json'),'utf8'));
const realBytes=await readFile(meta.realSample.path);assert.equal(sha(realBytes),meta.realSample.sha256);
const realDoc=parseDocxBuffer(realBytes),selected=realDoc.endnotes.map((p,index)=>({p,index})).filter(({p})=>!p.isNoteSeparator);
assert.equal(selected.length,43);
const realIssues=selected.map(({p,index})=>{const initial={ruleId:'SOFTWARE-REAL43',endnoteIndex:index,location:'endnote:'+index,quote:p.text.slice(2,3),
 anchor:{target:'endnote',index,start:2,end:3,text:p.text.slice(2,3),precision:'exact'}};return{...initial,anchor:computeAnchor(initial,realDoc)};});
const realResult=buildCommentedDocx({buffer:realBytes,issues:realIssues,author:'软件显式范围探针',date:'2026-10-09T00:00:00.000Z'});
test('real43 supplied literal ranges map all real note IDs to body references',()=>({added:realResult.added,skipped:realResult.skipped,anchors:realIssues.map(i=>i.anchor),
 placements:realResult.placements,skippedDetails:realResult.skippedDetails}),o=>{
 assert.equal(o.added,43);assert.equal(o.skipped,0);assert.equal(o.placements.length,43);
 assert.deepEqual(o.placements.map(p=>p.source.noteId),selected.map(({p})=>p.noteId));
 assert(o.placements.every(p=>p.source.start===2&&p.source.end===3&&p.source.text.length===1));
});
test('real note and untargeted source bytes remain intact',()=>({
 notesEqual:openZip(realResult.buffer).read('word/endnotes.xml').equals(openZip(realBytes).read('word/endnotes.xml')),
 sourceSha256:sha(realBytes)}),o=>{assert(o.notesEqual);assert.equal(o.sourceSha256,meta.realSample.sha256);});
await save('real43-commented.docx',realResult.buffer);
assert.equal(sha(await readFile(meta.realSample.path)),meta.realSample.sha256);assert.equal(sha(await readFile(sourcePath)),sourceSha256);
const report={at:new Date().toISOString(),phase,sourcePath,sourceSha256,modelCalls:0,apiRequests:0,servicesStarted:0,softwareOnly:true,
 sample:{path:meta.realSample.path,sha256:meta.realSample.sha256},real43Added:realResult.added,real43Skipped:realResult.skipped,
 passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,checks};
await save('report.json',report);console.log(JSON.stringify({out,phase,passed:report.passed,failed:report.failed,real43Added:report.real43Added,real43Skipped:report.real43Skipped}));
if(phase==='green'&&report.failed||phase==='red'&&report.failed===0)process.exitCode=1;

