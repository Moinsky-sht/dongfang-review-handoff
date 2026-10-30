import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=process.cwd(),config=JSON.parse(await readFile('tmp/range-contract-current-run.json','utf8'));
const arg=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
const out=resolve(arg('out')||'');
const rel=relative(resolve(config.runDirectory),out);
assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Output belongs to current fresh run');
await mkdir(out);
const baseline=process.argv.includes('--baseline');
const source=baseline?join(config.runDirectory,'before'):root;
const anchors=await import(pathToFileURL(join(source,'src/anchors.js')));
const working=await import(pathToFileURL(join(source,'src/working-anchors.js')));
const hash=b=>createHash('sha256').update(b).digest('hex');
const fingerprints={};
for(const f of ['src/anchors.js','src/working-anchors.js'])fingerprints[f]=hash(await readFile(join(source,f)));
await writeFile(join(out,'test-source.mjs'),await readFile(new URL(import.meta.url)),{flag:'wx'});
const checks=[];
const test=(name,observe,verify)=>{let observed;try{observed=observe();verify(observed);checks.push({name,ok:true,observed});}
catch(error){checks.push({name,ok:false,observed,error:{name:error.name,message:error.message}});}};
const node=(text,index=0,part='document.xml',physical=index)=>({id:part+':'+index,index,part,text,sourceXmlParagraphOrdinal:physical,sourceXmlNodeId:part+':xml-p:'+physical});
const text='重复原文；重复原文。',second=5;
const doc={paragraphs:[node(text),node('唯一原文。',1),node('AB A B',2),node('甲 A B 乙',3),node('😀甲',4)],
 footnotes:[{...node('脚注重复；脚注重复',0,'footnotes.xml',2),noteId:'5'}],endnotes:[],
 sourcePackageSha256:'a'.repeat(64),sourceVersionId:'review-v0'};
const base={ruleId:'SOFTWARE-REPEAT',paragraphIndex:0,location:'paragraph:0',quote:'重复原文'};
const fix={find:'重复原文',replace:'修正原文'};
test('primitive control: exact second occurrence remains available',()=>anchors.computeAnchor({...base,autoFix:{...fix,offset:second}},doc),a=>{
 assert.equal(a.start,second);assert.equal(a.end,second+4);assert.equal(a.text,'重复原文');assert.equal(a.precision,'exact');
});
test('primitive control: unique literal remains available',()=>anchors.computeAnchor({...base,paragraphIndex:1,autoFix:{find:'唯一原文',replace:'修正'}},doc),a=>{
 assert.equal(a.start,0);assert.equal(a.end,4);assert.equal(a.text,'唯一原文');assert.equal(a.precision,'exact');
});
test('primitive control: normalized unique quote maps original positions',()=>anchors.computeAnchor({...base,paragraphIndex:3,quote:'AB'},doc),a=>{
 assert.equal(a.start,2);assert.equal(a.end,5);assert.equal(a.text,'A B');
});
test('primitive control: body/note explicit occurrences stay separate',()=>anchors.computeAnchors({...base,
 occurrences:[{paragraphIndex:0,autoFix:{...fix,offset:second}},{footnoteIndex:0,quote:'脚注重复',autoFix:{find:'脚注重复',replace:'修正',offset:5}}]},doc),aa=>{
 assert.deepEqual(aa.map(a=>[a.target,a.start]),[['paragraph',second],['footnote',5]]);
});
test('primitive control: verified long replacement retains second occurrence',()=>working.rebaseIssueAnchors([
 {...base,anchors:[{target:'paragraph',index:0,start:5,end:9,text:'重复原文',precision:'exact'}]}],
 {paragraphs:[{text:'长替换原文；重复原文。'}]},[{patchId:'p0',target:'body',index:0,sourceVersionId:'v0',sourceOffset:0,find:'重复',replace:'长替换'}],'v0')[0],i=>{
 assert.equal(i.needsRelocation,false);assert.equal(i.anchor.start,6);assert.equal(i.anchor.text,'重复原文');
});
test('primitive control: stale rebase never searches another duplicate',()=>working.rebaseIssueAnchors([
 {...base,anchors:[{target:'paragraph',index:0,start:5,end:9,text:'重复原文',precision:'exact'}]}],
 {paragraphs:[{text:'重复原文；不同原文。'}]},[],'v0')[0],i=>{
 assert.equal(i.needsRelocation,true);assert.equal(i.relocationReason,'text_mismatch');assert.equal(i.anchor,null);
});
test('ambiguous find keeps navigation and every original-view candidate',()=>anchors.computeAnchor({...base,autoFix:fix},doc),a=>{
 assert.equal(a.precision,'paragraph');assert.equal(a.resolutionStatus,'ambiguous');
 assert.deepEqual(a.candidateRanges.map(r=>r.start),[0,second]);assert.equal(a.text,text);
});
test('ambiguous quote is not assigned to its first occurrence',()=>anchors.computeAnchor(base,doc),a=>{
 assert.equal(a.resolutionStatus,'ambiguous');assert.deepEqual(a.candidateRanges.map(r=>r.start),[0,second]);
});
test('explicit second offset preserves exact current source identity',()=>anchors.computeAnchor({...base,autoFix:{...fix,offset:second}},doc),a=>{
 assert.equal(a.start,second);assert.equal(a.end,second+4);assert.equal(a.precision,'exact');assert.equal(a.resolutionStatus,'resolved');
 assert.equal(a.sourceXmlNodeId,'document.xml:xml-p:0');assert.equal(a.pid,'document.xml:0');
 assert.equal(a.sourcePackageSha256,doc.sourcePackageSha256);assert.equal(a.offsetUnit,'utf16');assert.equal(a.textView,'after');
 assert.equal(a.paragraphIndexOwner,'application-paragraph-index');
});
test('unique literal find remains exactly actionable',()=>anchors.computeAnchor({...base,paragraphIndex:1,autoFix:{find:'唯一原文',replace:'修正'}},doc),a=>{
 assert.equal(a.start,0);assert.equal(a.text,'唯一原文');assert.equal(a.precision,'exact');assert.equal(a.resolutionStatus,'resolved');
});
test('literal hit plus whitespace-aligned hit stays ambiguous',()=>anchors.computeAnchor({...base,paragraphIndex:2,quote:'AB',autoFix:{find:'AB',replace:'CD'}},doc),a=>{
 assert.equal(a.resolutionStatus,'ambiguous');assert.deepEqual(a.candidateRanges.map(r=>[r.start,r.end]),[[0,2],[3,6]]);
});
test('unique normalized quote owns original after-view UTF-16 range',()=>anchors.computeAnchor({...base,paragraphIndex:3,quote:'AB'},doc),a=>{
 assert.equal(a.start,2);assert.equal(a.end,5);assert.equal(a.text,'A B');assert.equal(a.precision,'quote');
 assert.equal(a.comparisonView,'whitespace-normalized');assert.equal(a.offsetUnit,'utf16');assert.equal(a.textView,'after');
});
test('occurrence offsets never inherit the first parent fix offset',()=>anchors.computeAnchors({...base,autoFix:{...fix,offset:0},
 occurrences:[{paragraphIndex:0,quote:'重复原文',offset:0},{paragraphIndex:0,quote:'重复原文',offset:second}]},doc),aa=>{
 assert.deepEqual(aa.map(a=>a.start),[0,second]);assert(aa.every(a=>a.resolutionStatus==='resolved'));
 assert.deepEqual(aa.map(a=>a.occurrenceIndex),[0,1]);
});
test('body and note occurrence own separate physical/source nodes',()=>anchors.computeAnchors({...base,autoFix:{...fix,offset:0},
 occurrences:[{paragraphIndex:0,autoFix:{...fix,offset:second}},{footnoteIndex:0,quote:'脚注重复',autoFix:{find:'脚注重复',replace:'修正',offset:5}}]},doc),aa=>{
 assert.deepEqual(aa.map(a=>[a.target,a.index,a.start]),[['paragraph',0,second],['footnote',0,5]]);
 assert.equal(aa[1].sourceXmlNodeId,'footnotes.xml:xml-p:2');assert.equal(aa[1].noteId,'5');
});
test('stale explicit offset never searches for a different matching occurrence',()=>anchors.computeAnchor({...base,autoFix:{...fix,offset:1}},doc),a=>{
 assert.equal(a.resolutionStatus,'unmapped');assert.equal(a.resolutionReason,'stale_offset');assert.notEqual(a.precision,'exact');
});
test('unsupported before view retains only typed navigation',()=>anchors.computeAnchor({...base,textView:'before',autoFix:{...fix,offset:0}},doc),a=>{
 assert.equal(a.resolutionStatus,'unmapped');assert.equal(a.resolutionReason,'unsupported_text_view');assert.notEqual(a.precision,'exact');
});
test('unsupported owner cannot silently default to the after view',()=>anchors.computeAnchor({...base,owner:'before',autoFix:{...fix,offset:0}},doc),a=>{
 assert.equal(a.resolutionStatus,'unmapped');assert.equal(a.resolutionReason,'unsupported_source_owner');
});
test('different physical identity cannot be laundered by matching text',()=>anchors.computeAnchor({...base,sourceXmlNodeId:'document.xml:xml-p:99',autoFix:{...fix,offset:0}},doc),a=>{
 assert.equal(a.resolutionStatus,'unmapped');assert.equal(a.resolutionReason,'source_identity_mismatch');
});
test('fractional offsets cannot create nominal exact ranges',()=>anchors.computeAnchor({...base,autoFix:{...fix,offset:0.5}},doc),a=>{
 assert.equal(a.resolutionStatus,'unmapped');assert.equal(a.resolutionReason,'invalid_offset');
});
test('surrogate boundaries cannot be split by a precise anchor',()=>anchors.computeAnchor({...base,paragraphIndex:4,autoFix:{find:'\uDE00',replace:'X',offset:1}},doc),a=>{
 assert.equal(a.resolutionStatus,'unmapped');assert.equal(a.resolutionReason,'invalid_offset');
});
test('stats report ambiguous navigation separately from resolved marks',()=>{const result={issues:[base,{...base,autoFix:{...fix,offset:second}}]};const stats=anchors.attachAnchors(result,doc);return{stats,result};},o=>{
 assert.equal(o.stats.ambiguous,1);assert.equal(o.stats.exact,1);assert.equal(o.stats.paragraph,1);assert.equal(o.stats.issues,2);
});
const sourceAnchor={target:'paragraph',index:0,start:5,end:9,text:'重复原文',precision:'exact',pid:'document.xml:0',
 part:'document.xml',sourceXmlNodeId:'document.xml:xml-p:0',sourceXmlParagraphOrdinal:0,textView:'after',offsetUnit:'utf16',
 paragraphIndexOwner:'application-paragraph-index',sourceVersionId:'review-v0',sourcePackageSha256:'a'.repeat(64),resolutionStatus:'resolved'};
const sourceIssue={...base,anchors:[sourceAnchor],anchor:sourceAnchor};
test('rebase preserves reviewed package and assigns verified current package owner',()=>working.rebaseIssueAnchors([sourceIssue],
 {...doc,sourcePackageSha256:'b'.repeat(64),sourceVersionId:'work-v1',paragraphs:[node('长替换原文；重复原文。')]},
 [{patchId:'p0',target:'body',index:0,sourceVersionId:'review-v0',sourceOffset:0,find:'重复',replace:'长替换'}],'review-v0')[0],i=>{
 assert.equal(i.needsRelocation,false);assert.equal(i.anchor.start,6);assert.equal(i.anchor.text,'重复原文');
 assert.equal(i.anchor.sourcePackageSha256,'b'.repeat(64));assert.equal(i.anchor.sourceReviewedPackageSha256,'a'.repeat(64));
 assert.equal(i.anchor.sourceVersionId,'work-v1');assert.equal(i.anchor.sourceReviewedVersionId,'review-v0');
});
test('rebase refuses another physical node even when its text is identical',()=>working.rebaseIssueAnchors([sourceIssue],
 {...doc,paragraphs:[node(text,0,'document.xml',9)]},[],'review-v0')[0],i=>{
 assert.equal(i.needsRelocation,true);assert.equal(i.relocationReason,'source_identity_mismatch');assert.equal(i.anchor,null);
});
test('rebase refuses before-owner ranges rather than interpreting them as after',()=>working.rebaseIssueAnchors([
 {...sourceIssue,anchors:[{...sourceAnchor,textView:'before'}]}],doc,[],'review-v0')[0],i=>{
 assert.equal(i.needsRelocation,true);assert.equal(i.relocationReason,'unsupported_text_view');
});
test('rebase rejects a declared owner even when canonical view was omitted',()=>working.rebaseIssueAnchors([
 {...sourceIssue,anchors:[{...sourceAnchor,owner:'before'}]}],doc,[],'review-v0')[0],i=>{
 assert.equal(i.needsRelocation,true);assert.equal(i.relocationReason,'unsupported_source_owner');
});
for(const[f,digest]of Object.entries(fingerprints))assert.equal(hash(await readFile(join(source,f))),digest,'Source changed during targeted run');
const report={at:new Date().toISOString(),mode:baseline?'baseline-red':'current-green',softwareOnly:true,realArkCalls:0,servicesStarted:0,
 apiCalls:0,fingerprints,passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,checks};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({out,mode:report.mode,passed:report.passed,failed:report.failed,realArkCalls:0}));
if(!baseline&&report.failed||baseline&&report.failed===0)process.exitCode=1;

