import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {writeZip} from '../src/zip-write.js';
import {openZip} from '../src/zip.js';
import {parseDocxBuffer,paragraphText} from '../src/docx.js';
import {parseXml} from '../src/xml.js';
import {computeAnchor} from '../src/anchors.js';
import {rebaseIssueAnchors} from '../src/working-anchors.js';
import {applyDocxPatches} from '../src/docx-patches.js';
import {buildCommentedDocx} from '../src/docx-comments.js';
const root=process.cwd(),cfg=JSON.parse(await readFile('tmp/range-contract-current-run.json','utf8'));
const out=resolve(process.argv.find(a=>a.startsWith('--out='))?.slice(6)||''),rel=relative(resolve(cfg.runDirectory),out);
assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await mkdir(out);
const save=(name,data)=>writeFile(join(out,name),Buffer.isBuffer(data)?data:JSON.stringify(data,null,2)+'\n',{flag:'wx'});
const sha=b=>createHash('sha256').update(b).digest('hex');
const files=['src/docx.js','src/anchors.js','src/working-anchors.js','src/docx-patches.js','src/docx-comments.js'];
const fingerprints=Object.fromEntries(await Promise.all(files.map(async f=>[f,sha(await readFile(f))])));
await writeFile(join(out,'test-source.mjs'),await readFile(new URL(import.meta.url)),{flag:'wx'});
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const p=t=>'<w:p><w:r><w:t>'+t+'</w:t></w:r></w:p>';
const repeated='foo；foo。',noteText='注中foo；foo';
const textbox='<w:pict><v:shape><v:textbox><w:txbxContent>'+p('TEXTBOX')+'</w:txbxContent></v:textbox></v:shape></w:pict>';
const buffer=writeZip([
 {name:'word/document.xml',data:'<w:document xmlns:w="'+W+'" xmlns:v="urn:schemas-microsoft-com:vml"><w:body><w:p><w:r><w:t>HOST</w:t>'+textbox+'</w:r></w:p>'+p(repeated)+'<w:p><w:r><w:footnoteReference w:id="5"/></w:r><w:r><w:t>尾部</w:t></w:r></w:p></w:body></w:document>'},
 {name:'word/footnotes.xml',data:'<w:footnotes xmlns:w="'+W+'"><w:footnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="5">'+p(noteText)+'</w:footnote></w:footnotes>'},
 {name:'[Content_Types].xml',data:'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>'}
]);
await save('source.docx',buffer);
const version='ssoftware:v000000-'+sha(buffer),doc=parseDocxBuffer(buffer);doc.sourceVersionId=version;
const checks=[],observe=(name,fn)=>{try{checks.push({name,ok:true,observed:fn()});}catch(e){checks.push({name,ok:false,error:{name:e.name,message:e.message}});}};
const base={ruleId:'SOFTWARE-FLOW',location:'paragraph:1',paragraphIndex:1,quote:'foo',autoFix:{find:'foo',replace:'LONGER',offset:repeated.lastIndexOf('foo')}};
const anchor=computeAnchor(base,doc),issue={...base,anchor,anchors:[anchor]};
const dto=(anchor,id,replace)=>({...anchor,patchId:id,target:anchor.target,index:anchor.index,offset:anchor.start,find:anchor.text,replace,workVersionId:version,workSha256:sha(buffer)});
observe('real parser logical paragraph 1 owns physical XML paragraph 2',()=>{
 assert.equal(doc.paragraphs.length,3);assert.equal(doc.paragraphs[1].sourceXmlParagraphOrdinal,2);
 assert.equal(anchor.sourceXmlNodeId,'document.xml:xml-p:2');assert.equal(anchor.pid,'document.xml:1');
 return{pid:anchor.pid,sourceXmlNodeId:anchor.sourceXmlNodeId};
});
observe('ambiguous navigation cannot become a precise exported source',()=>{
 const ambiguous=computeAnchor({...base,autoFix:{find:'foo',replace:'LONGER'}},doc);
 assert.equal(ambiguous.resolutionStatus,'ambiguous');
 const exported=buildCommentedDocx({buffer,issues:[{...base,autoFix:undefined,anchor:ambiguous}],workVersionId:version,workSha256:sha(buffer)});
 assert.equal(exported.added,0);assert.equal(exported.skippedDetails[0].reasonCode,'unresolved_source_range');
 return{anchor:ambiguous,skipped:exported.skippedDetails};
});
const patched=applyDocxPatches(buffer,[dto(anchor,'second','LONGER')]);
observe('exact second occurrence modifies physical body node while textbox stays unchanged',()=>{
 assert.equal(patched.applied.length,1);assert.equal(parseDocxBuffer(patched.buffer).paragraphs[1].text,'foo；LONGER。');
 const physical=parseXml(openZip(patched.buffer).readText('word/document.xml')).descendants('w:p').map(n=>paragraphText(n,'after'));
 assert.deepEqual(physical,['HOST','TEXTBOX','foo；LONGER。','尾部']);
 return{applied:patched.applied,physical};
});
await save('second-patched.docx',patched.buffer);
observe('wrong physical identity is rejected even with matching logical text',()=>{
 const bad=applyDocxPatches(buffer,[{...dto(anchor,'wrong-physical','LONGER'),sourceXmlNodeId:'document.xml:xml-p:1'}]);
 assert.equal(bad.applied.length,0);assert.equal(bad.skipped[0].reasonCode,'source_identity_mismatch');assert.equal(bad.buffer,buffer);
 return bad.skipped;
});
observe('explicit current range remains exportable with both source coordinates',()=>{
 const exported=buildCommentedDocx({buffer,issues:[issue],workVersionId:version,workSha256:sha(buffer)});
 assert.equal(exported.added,1);const place=exported.placements[0];
 assert.equal(place.source.start,4);assert.equal(place.source.sourceXmlParagraphOrdinal,2);
 assert.equal(place.targets[0].pid,'document.xml:1');assert.equal(place.targets[0].sourceXmlNodeId,'document.xml:xml-p:2');
 return place;
});
const first={...dto({...anchor,start:0,end:3,text:'foo'},'first','LONGER'),sourceVersionId:version,sourceOffset:0};
const changed=applyDocxPatches(buffer,[first]),current=parseDocxBuffer(changed.buffer);current.sourceVersionId='ssoftware:v000001-'+sha(changed.buffer);
const mapped=rebaseIssueAnchors([issue],current,changed.applied,version)[0];
observe('rebase and comments keep review provenance but verify actual current package',()=>{
 assert.equal(mapped.needsRelocation,false);assert.equal(mapped.anchor.start,7);assert.equal(mapped.anchor.text,'foo');
 assert.equal(mapped.anchor.sourceReviewedPackageSha256,sha(buffer));assert.equal(mapped.anchor.sourcePackageSha256,sha(changed.buffer));
 const exported=buildCommentedDocx({buffer:changed.buffer,issues:[mapped],workVersionId:current.sourceVersionId,workSha256:sha(changed.buffer)});
 assert.equal(exported.added,1);assert.equal(exported.placements[0].source.start,7);
 return{anchor:mapped.anchor,placement:exported.placements[0]};
});
await save('first-patched.docx',changed.buffer);
observe('note source owns physical note and body reference separately',()=>{
 const noteIndex=doc.footnotes.findIndex(n=>n.noteId==='5');
 const input={ruleId:'SOFTWARE-NOTE',footnoteIndex:noteIndex,quote:'foo',autoFix:{find:'foo',replace:'LONGER',offset:noteText.lastIndexOf('foo')}};
 const a=computeAnchor(input,doc);
 const exported=buildCommentedDocx({buffer,issues:[{...input,anchor:a}],workVersionId:version,workSha256:sha(buffer)});
 assert.equal(exported.added,1);const place=exported.placements[0];
 assert.equal(place.source.sourceXmlNodeId,'footnotes.xml:xml-p:1');assert.equal(place.source.noteId,'5');
 assert.equal(place.targets[0].sourceXmlNodeId,'document.xml:xml-p:3');assert.equal(place.targets[0].pid,'document.xml:2');
 assert.deepEqual(openZip(exported.buffer).read('word/footnotes.xml'),openZip(buffer).read('word/footnotes.xml'));
 return place;
});
for(const[f,h]of Object.entries(fingerprints))assert.equal(sha(await readFile(f)),h,'Source changed during actual flow');
const report={at:new Date().toISOString(),softwareOnly:true,realArkCalls:0,servicesStarted:0,apiCalls:0,fingerprints,
 passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,checks};
await save('report.json',report);console.log(JSON.stringify({out,passed:report.passed,failed:report.failed,realArkCalls:0}));if(report.failed)process.exitCode=1;

