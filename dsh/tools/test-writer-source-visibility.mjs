/** Actual writer/source parity on generated XML. No manuscripts, service or model calls. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {parseDocxBuffer} from '../src/docx.js';
import {applyDocxPatches} from '../src/docx-patches.js';
import {buildCommentedDocx} from '../src/docx-comments.js';
import {writeZip} from '../src/zip-write.js';
import {openZip} from '../src/zip.js';

const PROJECT=resolve(dirname(fileURLToPath(import.meta.url)),'..'),RUNS=join(PROJECT,'data/optimization/runs'),VERIFY=join(PROJECT,'data/verify');
const flag=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const sha=b=>createHash('sha256').update(b).digest('hex');
const within=(base,path)=>{const r=relative(base,path);return r===''||r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};
const pointer=JSON.parse(await readFile(join(PROJECT,'tmp/projection-current-run.json'),'utf8'));
assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(pointer.runId||''));const current=resolve(pointer.runDirectory);
assert(isAbsolute(pointer.runDirectory));assert.equal(current,join(RUNS,pointer.runId));
const inherited=process.env.DSH_VERIFICATION_EVIDENCE_DIR?resolve(PROJECT,process.env.DSH_VERIFICATION_EVIDENCE_DIR):null;
if(inherited)assert(within(RUNS,inherited)&&inherited!==RUNS);
const evidenceRoot=resolve(PROJECT,flag('evidence-root')||inherited||VERIFY);
assert(within(VERIFY,evidenceRoot)||within(current,evidenceRoot)||inherited&&within(inherited,evidenceRoot));
async function guard(path){for(let p=resolve(path);;p=dirname(p)){assert(!existsSync(join(p,'complete.json')),'Sealed evidence ancestor');try{const st=await lstat(p);assert(st.isDirectory()&&!st.isSymbolicLink());assert.equal(resolve(await realpath(p)).toLowerCase(),p.toLowerCase());}catch(e){if(e.code!=='ENOENT')throw e;}if(p===dirname(p))break;}}
await guard(evidenceRoot);await mkdir(evidenceRoot,{recursive:true});
const out=join(evidenceRoot,'writer-visibility-'+Date.now()+'-'+randomUUID());await mkdir(out);
const files=['src/docx.js','src/docx-patches.js','src/docx-comments.js','tools/test-writer-source-visibility.mjs'];
const fingerprints=async()=>Object.fromEntries(await Promise.all(files.map(async f=>[f,sha(await readFile(join(PROJECT,f)))])));
const report={at:new Date().toISOString(),out,phase:flag('phase')||'current',verificationRunId:process.env.DSH_VERIFICATION_RUN_ID||pointer.runId,
  sourceBefore:await fingerprints(),realArkCalls:0,modelCalls:0,apiRequests:0,networkRequests:0,servicesStarted:0,
  manuscriptContentJudgment:false,nativeBrowserVerified:false,wordApplicationVerified:false,
  scope:'Generated actual DOCX/XML, current parser and both real writer modules; exact source ranges, protected structures and preserved ZIP entry data. No content quality, actual-corpus completeness or native Word claim.',checks:[]};
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const run=t=>'<w:r><w:t xml:space="preserve">'+t+'</w:t></w:r>';
const ref=(kind,id='7')=>`<w:r><w:${kind}Reference w:id="${id}"/></w:r>`;
const PPR='<w:pPr><w:tabs><w:tab w:val="left" w:pos="1440"/><w:tab w:val="right" w:pos="4320"/></w:tabs><w:spacing w:after="120"/></w:pPr>';
const RPR='<w:rPr><w:b/><w:color w:val="123456"/></w:rPr>';
const fields={body:'paragraphs',footnote:'footnotes',endnote:'endnotes'},parts={body:'word/document.xml',footnote:'word/footnotes.xml',endnote:'word/endnotes.xml'};
function fixture(body,{noteProps='',noteRuns=run('NOTE BAD')}={}){return writeZip([
  {name:'word/document.xml',data:`<w:document xmlns:w="${W}"><w:body>${body}<w:p>${run('UNRELATED BODY')}</w:p><w:sectPr/></w:body></w:document>`},
  ...['footnote','endnote'].map(kind=>({name:'word/'+kind+'s.xml',data:`<w:${kind}s xmlns:w="${W}"><w:${kind} w:id="-1" w:type="separator"><w:p/></w:${kind}><w:${kind} w:id="7"><w:p>${noteProps}${noteRuns}</w:p></w:${kind}></w:${kind}s>`})),
  {name:'[Content_Types].xml',data:'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'},
  {name:'word/styles.xml',data:`<w:styles xmlns:w="${W}"><w:style w:styleId="UNCHANGED"/></w:styles>`},
  {name:'word/media/software-only.png',data:Buffer.from([137,80,78,71,0,13,10,255])},
  {name:'word/_rels/document.xml.rels',data:'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdMedia" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/software-only.png"/></Relationships>'},
]);}
function patch(buffer,target,index,offset,find,replace='OK'){const node=parseDocxBuffer(buffer)[fields[target]][index],digest=sha(buffer);return {patchId:'software-'+randomUUID(),target,index,offset,find,replace,
  pid:node.id,part:node.part,sourceXmlNodeId:node.sourceXmlNodeId,sourceXmlParagraphOrdinal:node.sourceXmlParagraphOrdinal,
  textView:'after',offsetUnit:'utf16',paragraphIndexOwner:'application-paragraph-index',sourcePackageSha256:digest,workVersionId:'svisibility:v000000-'+digest};}
function issue(buffer,target='endnote',index=1,start=5,end=8,extra={}){const kind=target==='body'?'paragraph':target,node=parseDocxBuffer(buffer)[fields[target]][index];return {ruleId:'SOFTWARE-WRITER',location:kind+':'+index,quote:node.text.slice(start,end),title:'Software source range, no content judgment',severity:'低',[kind+'Index']:index,
  anchor:{target:kind,index,start,end,text:node.text.slice(start,end),pid:node.id,part:node.part,noteId:node.noteId,sourceXmlNodeId:node.sourceXmlNodeId,sourceXmlParagraphOrdinal:node.sourceXmlParagraphOrdinal,textView:'after',offsetUnit:'utf16',paragraphIndexOwner:'application-paragraph-index',sourcePackageSha256:sha(buffer)},...extra};}
function vectors(buffer){const doc=parseDocxBuffer(buffer);return Object.fromEntries(Object.values(fields).map(f=>[f,doc[f].map(n=>n.text)]));}
function unchangedEntries(before,after,changed){const a=openZip(before),b=openZip(after);for(const name of a.names)if(!changed.includes(name))assert.deepEqual(b.read(name),a.read(name),'Unchanged part '+name);}
async function artifact(name,buffer,result){await guard(out);await writeFile(join(out,name+'-source.docx'),buffer,{flag:'wx'});await writeFile(join(out,name+'-result.docx'),result.buffer,{flag:'wx'});await writeFile(join(out,name+'-result.json'),JSON.stringify({...result,buffer:undefined,sourceSha256:sha(buffer),outputSha256:sha(result.buffer)},null,2)+'\n',{flag:'wx'});}
async function check(name,fn){try{const detail=await fn();report.checks.push({name,ok:true,detail});}catch(error){report.checks.push({name,ok:false,error:error.stack||String(error)});}}
async function patchSuccess(name,buffer,target,index,expectedText,offset,find='BAD',protectedFragments=[]){const digest=sha(buffer),before=vectors(buffer);assert.equal(before[fields[target]][index],expectedText);const result=applyDocxPatches(buffer,[patch(buffer,target,index,offset,find)]);await artifact(name,buffer,result);
  assert.equal(result.applied.length,1,JSON.stringify(result.skipped));assert.equal(result.skipped.length,0);assert.equal(result.applied[0].offset,offset);const after=vectors(result.buffer);before[fields[target]][index]=expectedText.slice(0,offset)+'OK'+expectedText.slice(offset+find.length);assert.deepEqual(after,before);unchangedEntries(buffer,result.buffer,[parts[target]]);assert.deepEqual(openZip(result.buffer).names,openZip(buffer).names);for(const fragment of protectedFragments)assert(openZip(result.buffer).readText(parts[target]).includes(fragment));assert.equal(sha(buffer),digest);return {target,index,offset,sourceSha256:digest,outputSha256:sha(result.buffer)};}
async function patchReject(name,buffer,target,index,offset,find,reasonCode){const digest=sha(buffer),result=applyDocxPatches(buffer,[patch(buffer,target,index,offset,find)]);await artifact(name,buffer,result);assert.equal(result.applied.length,0);assert.equal(result.skipped.length,1);assert.equal(result.skipped[0].reasonCode,reasonCode);assert.equal(result.buffer,buffer);assert.equal(sha(buffer),digest);return {reasonCode};}
async function commentSuccess(name,buffer,kind,offset,{prefix=null,issues=null,expectedCount=1}={}){const digest=sha(buffer),before=vectors(buffer),sourceIssues=issues||[issue(buffer,kind)];const result=buildCommentedDocx({buffer,issues:sourceIssues,workVersionId:'svisibility:v000000-'+digest,workSha256:digest,date:'2026-10-09T00:00:00.000Z'});await artifact(name,buffer,result);
  assert.equal(result.added,expectedCount,JSON.stringify(result.skippedDetails));assert.equal(result.skipped,0);assert.deepEqual(vectors(result.buffer),before);unchangedEntries(buffer,result.buffer,['word/document.xml','word/comments.xml','[Content_Types].xml','word/_rels/document.xml.rels']);
  for(const placement of result.placements)for(const target of placement.targets){assert.equal(target.reference?.offset,offset);assert.equal(target.reference?.kind,kind);assert.equal(target.reference?.noteId,'7');assert.equal(target.reference?.occupiesText,false);assert.equal(target.precision,'note-reference');const xml=openZip(buffer).readText('word/document.xml');assert.equal(xml.slice(target.xmlRange.start,target.xmlRange.end),ref(kind));}
  if(prefix)assert(openZip(result.buffer).readText('word/document.xml').includes(prefix));assert.equal(sha(buffer),digest);return {added:result.added,referenceOffset:offset,sourceSha256:digest,outputSha256:sha(result.buffer)};}
async function commentReject(name,buffer,kind,reasonCode){const digest=sha(buffer),result=buildCommentedDocx({buffer,issues:[issue(buffer,kind)],workSha256:digest});await artifact(name,buffer,result);assert.equal(result.added,0);assert.equal(result.skipped,1);assert.equal(result.skippedDetails[0].reasonCode,reasonCode);assert.equal(result.buffer,buffer);assert.equal(sha(buffer),digest);return {reasonCode};}

await check('ordinary text patch remains editable without properties',()=>patchSuccess('ordinary',fixture('<w:p>'+run('BAD END')+'</w:p>'),'body',0,'BAD END',0));
await check('paragraph tab-stop declarations never enter ordinary editable offsets',()=>patchSuccess('ppr-tabs',fixture('<w:p>'+PPR+run('BAD END')+'</w:p>'),'body',0,'BAD END',0,'BAD',[PPR]));
for(const target of ['footnote','endnote'])await check(target+' layout properties preserve exact source patch range',()=>patchSuccess(target+'-ppr',fixture('<w:p>'+run('BODY')+ref(target)+'</w:p>',{noteProps:PPR}),target,1,'NOTE BAD',5,'BAD',[PPR]));
const fakeProperties='<w:rPr><w:b/><w:tab/><w:noBreakHyphen/><w:fldChar w:fldCharType="begin"/></w:rPr>';
await check('run properties cannot contribute text or change field state',()=>patchSuccess('rpr-hidden',fixture('<w:p><w:r>'+fakeProperties+'<w:t>BAD END</w:t></w:r></w:p>'),'body',0,'BAD END',0,'BAD',[fakeProperties]));
const visible='<w:r>'+RPR+'<w:t>A</w:t><w:tab/><w:noBreakHyphen/><w:t>BAD END</w:t></w:r>';
await check('visible TAB and noBreakHyphen retain non-text nodes while adjacent literal text changes',()=>patchSuccess('visible-synthetic',fixture('<w:p>'+visible+'</w:p>'),'body',0,'A\t-BAD END',3,'BAD',[RPR,'<w:tab/>','<w:noBreakHyphen/>']));
for(const [name,offset,find]of [['tab',1,'\t'],['hyphen',2,'-']])await check('actual '+name+' node remains protected from literal replacement',()=>patchReject('protected-'+name,fixture('<w:p>'+visible+'</w:p>'),'body',0,offset,find,'unsupported_non_text'));
const hidden='<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText><w:tab/><w:noBreakHyphen/></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'+run('RESULT')+'<w:r><w:fldChar w:fldCharType="end"/></w:r>';
await check('hidden field TAB/noBreakHyphen do not shift editable text after a complete field',()=>patchSuccess('hidden-field-suffix',fixture('<w:p>'+hidden+run('BAD')+'</w:p>'),'body',0,'RESULTBAD',6,'BAD',[hidden]));
await check('visible field result remains protected',()=>patchReject('field-result',fixture('<w:p>'+hidden+run('BAD')+'</w:p>'),'body',0,0,'RESULT','unsupported_field'));
await check('revision text remains protected',()=>patchReject('revision',fixture('<w:p><w:ins w:id="1">'+run('BAD')+'</w:ins></w:p>'),'body',0,0,'BAD','unsupported_revision'));
await check('content-control text remains protected',()=>patchReject('content-control',fixture('<w:p><w:sdt><w:sdtContent>'+run('BAD')+'</w:sdtContent></w:sdt></w:p>'),'body',0,0,'BAD','unsupported_structure'));
await check('ranges crossing an actual note marker remain protected',()=>patchReject('note-boundary',fixture('<w:p>'+run('B')+ref('endnote')+run('AD')+'</w:p>'),'body',0,0,'BAD','unsupported_boundary'));
await check('incomplete field remains protected even when no synthetic hidden text is emitted',()=>patchReject('partial-field',fixture('<w:p>'+run('BAD')+'<w:r><w:fldChar w:fldCharType="begin"/><w:tab/><w:noBreakHyphen/></w:r></w:p>'),'body',0,0,'BAD','unsupported_field'));
for(const kind of ['footnote','endnote']){
  await check(kind+' ordinary comment targets only the actual visible reference run',()=>commentSuccess(kind+'-ordinary',fixture('<w:p>'+run('ABC')+ref(kind)+'</w:p>'),kind,3));
  await check(kind+' properties with tab-stop declarations do not shift or reject actual reference owner',()=>commentSuccess(kind+'-ppr-ref',fixture('<w:p>'+PPR+run('ABC')+ref(kind)+'</w:p>'),kind,3,{prefix:PPR}));
  const fake='<w:pPr><w:rPr><w:'+kind+'Reference w:id="7"/><w:tab/></w:rPr></w:pPr>';
  await check(kind+' bogus reference nested in properties cannot become a comment owner',()=>commentSuccess(kind+'-fake-prop-ref',fixture('<w:p>'+fake+run('ABC')+ref(kind)+'</w:p>'),kind,3,{prefix:fake}));
  await check(kind+' visible TAB/noBreakHyphen count in actual reference raw boundary',()=>commentSuccess(kind+'-visible-ref',fixture('<w:p>'+run('AB')+'<w:r><w:tab/><w:noBreakHyphen/></w:r>'+ref(kind)+'</w:p>'),kind,4));
  await check(kind+' hidden field TAB/noBreakHyphen excluded before actual reference',()=>commentSuccess(kind+'-hidden-ref',fixture('<w:p>'+hidden+run('ABC')+ref(kind)+'</w:p>'),kind,9));
  const hiddenRef='<w:r><w:fldChar w:fldCharType="begin"/></w:r>'+ref(kind)+'<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  await check(kind+' hidden reference is excluded when the same note also has an actual visible reference',()=>commentSuccess(kind+'-hidden-owner',fixture('<w:p>'+hiddenRef+run('ABC')+ref(kind)+'</w:p>'),kind,3));
  await check(kind+' hidden-only reference stays orphan rather than becoming a target',()=>commentReject(kind+'-hidden-only',fixture('<w:p>'+hiddenRef+run('ABC')+'</w:p>'),kind,'orphan_note'));
  await check(kind+' mixed text/reference run remains unsupported',()=>commentReject(kind+'-mixed',fixture('<w:p><w:r><w:t>ABC</w:t><w:'+kind+'Reference w:id="7"/></w:r></w:p>'),kind,'unsupported_reference_structure'));
  await check(kind+' reference within visible field result remains unsupported',()=>commentReject(kind+'-field-ref',fixture('<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:fldChar w:fldCharType="separate"/></w:r>'+ref(kind)+'<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'),kind,'unsupported_reference_structure'));
  const brSym='<w:r><w:fldChar w:fldCharType="begin"/><w:br/><w:sym w:font="Symbol" w:char="F020"/><w:fldChar w:fldCharType="end"/></w:r>';
  await check(kind+' hidden br/sym raw offsets match current authoritative parser without weakening reference protection',()=>commentSuccess(kind+'-br-sym-current',fixture('<w:p>'+brSym+run('ABC')+ref(kind)+'</w:p>'),kind,5));
}
await check('body paragraph comment starts after original pPr extent and never inside layout properties',async()=>{const ppr=PPR.replace('</w:pPr>','</w:pPr \n>'),buffer=fixture('<w:p>'+ppr+run('BAD')+'</w:p>'),digest=sha(buffer),result=buildCommentedDocx({buffer,issues:[issue(buffer,'body',0,0,3)],workSha256:digest});await artifact('body-prop-comment',buffer,result);assert.equal(result.added,1);const target=result.placements[0].targets[0],xml=openZip(buffer).readText('word/document.xml');assert.equal(target.xmlRange.start,xml.indexOf(ppr)+ppr.length);assert(openZip(result.buffer).readText('word/document.xml').includes(ppr+'<w:commentRangeStart'));assert.deepEqual(vectors(result.buffer),vectors(buffer));unchangedEntries(buffer,result.buffer,['word/document.xml','word/comments.xml','[Content_Types].xml','word/_rels/document.xml.rels']);assert.equal(sha(buffer),digest);return {xmlInsertion:target.xmlRange.start,precision:target.precision};});
await check('two identical legacy signatures keep distinct explicit issue identities in comment receipts',async()=>{const buffer=fixture('<w:p>'+run('BAD')+'</w:p>'),issues=[issue(buffer,'body',0,0,3,{issueKey:'explicit-A'}),issue(buffer,'body',0,0,3,{issueKey:'explicit-B'})],result=buildCommentedDocx({buffer,issues,workSha256:sha(buffer)});await artifact('explicit-keys',buffer,result);assert.equal(result.added,2);assert.equal(result.addedIssues,2);assert.deepEqual(result.placements.map(x=>x.issueKey),['explicit-A','explicit-B']);assert.deepEqual(vectors(result.buffer),vectors(buffer));unchangedEntries(buffer,result.buffer,['word/document.xml','word/comments.xml','[Content_Types].xml','word/_rels/document.xml.rels']);return {keys:result.placements.map(x=>x.issueKey)};});
await check('explicit valid/stale identities retain independent source decisions and receipts',async()=>{const buffer=fixture('<w:p>'+run('BAD')+'</w:p>'),good=issue(buffer,'body',0,0,3,{issueKey:'explicit-valid'}),bad=structuredClone(good);bad.issueKey='explicit-stale';bad.anchor.text='XYZ';const result=buildCommentedDocx({buffer,issues:[good,bad],workSha256:sha(buffer)});await artifact('explicit-independent',buffer,result);assert.equal(result.added,1);assert.equal(result.skipped,1);assert.equal(result.placements[0].issueKey,'explicit-valid');assert.equal(result.skippedDetails[0].issueKey,'explicit-stale');assert.equal(result.skippedDetails[0].reasonCode,'stale_source_range');assert.deepEqual(vectors(result.buffer),vectors(buffer));return {added:result.added,skipped:result.skipped};});
report.sourceAfter=await fingerprints();await check('every exercised source module remained byte-identical during this test',()=>assert.deepEqual(report.sourceAfter,report.sourceBefore));
report.passed=report.checks.filter(x=>x.ok).length;report.failed=report.checks.length-report.passed;report.finishedAt=new Date().toISOString();await guard(out);await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({out,passed:report.passed,failed:report.failed,total:report.checks.length,source:report.sourceBefore,modelCalls:0}));if(report.failed)process.exitCode=1;
