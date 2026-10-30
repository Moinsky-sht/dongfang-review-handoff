/** Representative real DOCX range checks on in-memory copies; never edits corpus files or ledger. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {parseDocxBuffer,paragraphText} from '../src/docx.js';
import {parseXml} from '../src/xml.js';
import {openZip,isOle2} from '../src/zip.js';
import {computeAnchor} from '../src/anchors.js';
import {applyDocxPatches} from '../src/docx-patches.js';
import {buildCommentedDocx} from '../src/docx-comments.js';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..'),RUNS=join(ROOT,'data/optimization/runs'),VERIFY=join(ROOT,'data/verify');
const arg=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>JSON.parse(readFileSync(p,'utf8'));
const cfg=read(join(ROOT,'tmp/range-contract-current-run.json'));
const within=(r,p)=>{const s=relative(resolve(r),resolve(p));return s!==''&&s!=='..'&&!s.startsWith('..'+sep)&&!isAbsolute(s);};
function guard(p,sealed=true){for(let a=resolve(p);;a=dirname(a)){
 const st=lstatSync(a,{throwIfNoEntry:false});if(st)assert(!st.isSymbolicLink()&&resolve(realpathSync(a)).toLowerCase()===a.toLowerCase(),'Alias evidence refused');
 if(sealed)assert(!lstatSync(join(a,'complete.json'),{throwIfNoEntry:false}),'Sealed output ancestor refused');
 if(a===dirname(a))break;
}}
const run=resolve(cfg.runDirectory);assert(within(RUNS,run)&&relative(RUNS,run).toLowerCase()===cfg.runId.toLowerCase());
const inherited=process.env.DSH_VERIFICATION_EVIDENCE_DIR?resolve(ROOT,process.env.DSH_VERIFICATION_EVIDENCE_DIR):null;
if(inherited){assert(within(RUNS,inherited));guard(inherited);}
const out=resolve(ROOT,arg('out')||join(inherited||VERIFY,'corpus-source-ranges-'+Date.now()+'-'+randomUUID().slice(0,8)));
assert([run,VERIFY,...(inherited?[inherited]:[])].some(r=>within(r,out)));guard(out);assert(!lstatSync(out,{throwIfNoEntry:false}),'Use a fresh output directory');mkdirSync(out,{recursive:true});
process.on('uncaughtException',error=>{
 try{writeFileSync(join(out,'fatal-report.json'),JSON.stringify({at:new Date().toISOString(),status:'fatal_setup_or_guard_failure',error:{name:error.name,message:error.message,stack:error.stack},modelCalls:0,apiRequests:0,servicesStarted:0},null,2)+'\n',{flag:'wx'});}catch{}
 console.error(error);process.exit(1);
});
const write=(name,obj)=>{guard(out);writeFileSync(join(out,name),typeof obj==='string'?obj:JSON.stringify(obj,null,2)+'\n',{flag:'wx'});};
const inventoryPath=resolve(ROOT,arg('inventory')||'data/optimization/runs/baseline-20261009-f7bba6676b-99bf7867/inventory.json');
const inventoryBytes=readFileSync(inventoryPath),inventory=JSON.parse(inventoryBytes),inventoryHash=sha(inventoryBytes);
assert.equal(inventory.files.length,715);
const original=inventory.files.filter(a=>a.ingestionRoute==='docx');assert.equal(original.length,632);
const originals=inventory.files.map(a=>({assetId:a.assetId,path:resolve(inventory.sourceRoot,a.relativePath),expected:a.sourceSha256}));
const sourceProofBefore=originals.map(a=>{const actual=sha(readFileSync(a.path));assert.equal(actual,a.expected,a.path);return{assetId:a.assetId,sha256:actual};});
const entries=original.map(a=>({...a,sourceKind:'original',path:resolve(inventory.sourceRoot,a.relativePath)}));
const derivedPath=arg('derived-manifest')?resolve(ROOT,arg('derived-manifest')):null;
const derivedPending=[],derivedProof=[];let derivedManifestSha=null;
if(derivedPath){
 const bytes=readFileSync(derivedPath),manifest=JSON.parse(bytes);derivedManifestSha=sha(bytes);
 assert.equal(manifest.originalPhysicalDenominator,715);assert.equal(manifest.retained,9);assert.equal(manifest.memberCount,19);
 for(const archive of manifest.archives){
  const base=inventory.files.find(a=>a.assetId===archive.parent.assetId);assert(base);assert.equal(base.sourceSha256,archive.parent.sha256);
  assert.equal(sha(readFileSync(resolve(inventory.sourceRoot,base.relativePath))),base.sourceSha256);
  for(const m of archive.members.filter(m=>m.status==='retained')){
   assert(m.contentFile&&m.crcVerified===true);const path=resolve(dirname(derivedPath),m.contentFile);assert(within(dirname(derivedPath),path));
   const bytes=readFileSync(path);assert.equal(sha(bytes),m.contentSha256);assert.equal(m.parentSha256,base.sourceSha256);
   assert.equal(m.sourceChain[0].assetId,base.assetId);assert.equal(m.sourceChain[0].sha256,base.sourceSha256);
   assert.equal(m.sourceChain[1].ordinal,m.ordinal);assert.equal(m.sourceChain[1].derivedAssetId,m.derivedAssetId);assert.equal(m.sourceChain[1].contentSha256,m.contentSha256);
   derivedProof.push({derivedAssetId:m.derivedAssetId,parentAssetId:m.parentAssetId,parentSha256:m.parentSha256,ordinal:m.ordinal,contentSha256:m.contentSha256,path,sourceChain:m.sourceChain});
   if(/\.docx$/i.test(m.name)){assert(!isOle2(bytes));entries.push({assetId:m.derivedAssetId,relativePath:m.name,sourceKind:'derived',sourceSha256:m.contentSha256,path,sourceChain:m.sourceChain});}
   else{assert(/\.doc$/i.test(m.name)&&isOle2(bytes));derivedPending.push({assetId:m.derivedAssetId,sourceSha256:m.contentSha256,sourceChain:m.sourceChain,status:'pending_legacy_word_conversion',bodyParsePerformed:false,conversionPerformed:false});}
  }
 }
 assert.equal(entries.filter(a=>a.sourceKind==='derived').length,7);assert.equal(derivedPending.length,2);
}
const limit=arg('limit')==null?entries.length:Number(arg('limit'));assert(Number.isSafeInteger(limit)&&limit>0);
const selected=entries.slice(0,limit),fingerprints=Object.fromEntries(['src/docx.js','src/anchors.js','src/docx-patches.js','src/docx-comments.js','src/working-anchors.js'].map(f=>[f,sha(readFileSync(join(ROOT,f)))]));
write('test-source.mjs',readFileSync(fileURLToPath(import.meta.url),'utf8'));
const TYPES={body:'paragraphs',footnote:'footnotes',endnote:'endnotes'},PART={body:'word/document.xml',footnote:'word/footnotes.xml',endnote:'word/endnotes.xml'};
const PROTECTION=new Set(['unsupported_revision','unsupported_field','unsupported_structure','unsupported_non_text','unsupported_boundary','unsupported_context','unsupported_xml_text','signed_document','unsupported_package','separator_note','unsupported_reference_structure']);
const PENDING=new Set(['orphan_note','ambiguous_note_id','source_version_unverified','unresolved_source_range','source_identity_mismatch','missing_source_part','missing_source_paragraph','mapping_mismatch','verification_failed']);
function character(text,offset=null){if(offset==null){const match=/\S/u.exec(text);offset=match?.index;}
 if(!Number.isInteger(offset)||offset<0||offset>=text.length)return null;
 if(offset>0&&/[\uD800-\uDBFF]/.test(text[offset-1])&&/[\uDC00-\uDFFF]/.test(text[offset]))return null;
 const find=String.fromCodePoint(text.codePointAt(offset));return{offset,find,replace:find==='Ⓢ'?'Ⓣ':'Ⓢ'};
}
function candidates(doc){
 const map=new Map(),unmapped=[];
 const add=(target,index,reason,offset=null)=>{
  const p=doc[TYPES[target]]?.[index];if(!p||p.isNoteSeparator)return;
  const char=character(p.text,offset);if(!char){unmapped.push({target,index,pid:p.id,sourceXmlNodeId:p.sourceXmlNodeId,reason:'no_nonwhitespace_after_text',selectedBecause:reason});return;}
  const key=target+':'+index+':'+char.offset;
  if(map.has(key)){map.get(key).selectedBecause.push(reason);return;}
  map.set(key,{target,index,pid:p.id,sourceXmlNodeId:p.sourceXmlNodeId,sourceXmlParagraphOrdinal:p.sourceXmlParagraphOrdinal,
   selectedBecause:[reason],inTable:!!p.inTable,logicalPhysicalDifferent:p.index!==p.sourceXmlParagraphOrdinal,
   revisionBearing:p.before!==p.text,fields:p.fields?.length||0,figures:p.figures?.length||0,textboxes:p.textboxes?.length||0,...char});
 };
 for(const target of Object.keys(TYPES)){
  const list=doc[TYPES[target]]||[],indices=list.map((p,i)=>!p.isNoteSeparator&&p.text?.trim()?i:-1).filter(i=>i>=0);
  if(!indices.length){unmapped.push({target,reason:'no_eligible_nonseparator_after_paragraph'});continue;}
  add(target,indices[0],'first-nonempty');add(target,indices.at(-1),'last-nonempty');
  for(const [label,predicate]of [['table',p=>p.inTable],['logical-physical-difference',p=>p.index!==p.sourceXmlParagraphOrdinal],
   ['revision-bearing',p=>p.before!==p.text],['figure-bearing',p=>p.figures?.length||p.textboxes?.length]]){
   const index=indices.find(i=>predicate(list[i]));if(index!=null)add(target,index,label);
  }
  const fieldIndex=indices.find(i=>list[i].fields?.length);
  if(fieldIndex!=null)add(target,fieldIndex,'field-boundary',list[fieldIndex].fields[0].offset);
 }
 return{items:[...map.values()],unmapped};
}
function xmlNodes(zip){return new Map(Object.values(PART).filter(p=>zip.has(p)).map(part=>[part,parseXml(zip.readText(part)).descendants('w:p')]));}
const rows=[];
for(const [ordinal,entry]of selected.entries()){
 const row={assetId:entry.assetId,sourceKind:entry.sourceKind,sourcePath:entry.relativePath,sourceSha256:entry.sourceSha256,sourceChain:entry.sourceChain||null,
  status:'pending',candidateCount:0,patchApplied:0,patchProtected:0,patchUnmapped:0,commentAccepted:0,commentWordTargets:0,commentProtected:0,commentUnmapped:0,violations:[]};
 try{
  const bytes=readFileSync(entry.path);assert.equal(sha(bytes),entry.sourceSha256);
  const doc=parseDocxBuffer(bytes,entry.relativePath);assert.equal(doc.sourcePackageSha256,entry.sourceSha256);
  const version='s'+sha(bytes).slice(0,24)+':v000000-'+sha(bytes);doc.sourceVersionId=version;
  const picked=candidates(doc);row.unmappedCandidateContexts=picked.unmapped;row.candidateCount=picked.items.length;
  const issues=picked.items.map((c,i)=>{
   const issue={ruleId:'SOFTWARE-CORPUS-'+i,location:c.target+':'+c.index,quote:c.find,autoFix:{find:c.find,replace:c.replace,offset:c.offset}};
   issue[c.target==='body'?'paragraphIndex':c.target+'Index']=c.index;issue.anchor=computeAnchor(issue,doc);issue.anchors=[issue.anchor];return issue;
  });
  const patches=issues.map((issue,i)=>({...picked.items[i],...issue.anchor,target:picked.items[i].target,patchId:'p'+i,
   offset:picked.items[i].offset,find:picked.items[i].find,replace:picked.items[i].replace,workSha256:entry.sourceSha256,workVersionId:version}));
  const patched=applyDocxPatches(bytes,patches),commented=buildCommentedDocx({buffer:bytes,issues,workVersionId:version,workSha256:entry.sourceSha256});
  const before=openZip(bytes),after=openZip(patched.buffer),beforeNodes=xmlNodes(before),afterNodes=xmlNodes(after);
  const expected=new Map(),changedParts=new Set();
  for(const applied of patched.applied){
   const candidate=picked.items.find((c,i)=>'p'+i===applied.patchId);assert(candidate);
   assert.equal(applied.sourceXmlNodeId,candidate.sourceXmlNodeId);assert.equal(applied.sourceXmlParagraphOrdinal,candidate.sourceXmlParagraphOrdinal);
   const part=PART[candidate.target],key=part+':'+candidate.sourceXmlParagraphOrdinal,originalNode=beforeNodes.get(part)[candidate.sourceXmlParagraphOrdinal];
   assert.equal(paragraphText(originalNode,'after'),doc[TYPES[candidate.target]][candidate.index].text);
   if(!expected.has(key))expected.set(key,{part,ordinal:candidate.sourceXmlParagraphOrdinal,text:paragraphText(originalNode,'after'),patches:[]});
   expected.get(key).patches.push(applied);changedParts.add(part);
  }
  for(const plan of expected.values()){
   for(const patch of plan.patches.sort((a,b)=>b.offset-a.offset))plan.text=plan.text.slice(0,patch.offset)+patch.replace+plan.text.slice(patch.offset+patch.find.length);
  }
  assert.deepEqual(after.names,before.names);
  for(const name of before.names)if(!changedParts.has(name))assert.deepEqual(after.read(name),before.read(name),'Untouched package entry '+name);
  for(const [part,nodes]of beforeNodes){const changed=afterNodes.get(part);assert.equal(changed.length,nodes.length);
   for(let i=0;i<nodes.length;i++)assert.equal(paragraphText(changed[i],'after'),expected.get(part+':'+i)?.text??paragraphText(nodes[i],'after'),'Physical paragraph mismatch '+part+':'+i);
  }
  for(const place of commented.placements){
   const logical=doc[TYPES[place.source.target==='paragraph'?'body':place.source.target]][place.source.index];
   assert.equal(place.source.sourceXmlNodeId,logical.sourceXmlNodeId);assert.equal(place.source.sourceXmlParagraphOrdinal,logical.sourceXmlParagraphOrdinal);
   for(const target of place.targets){const node=beforeNodes.get('word/document.xml')[target.sourceXmlParagraphOrdinal];assert(node);
    assert.equal(target.sourceXmlNodeId,'document.xml:xml-p:'+target.sourceXmlParagraphOrdinal);
    assert(target.xmlRange.start>=node.openEnd&&target.xmlRange.end<=node.closeStart);
   }
  }
  const commentsZip=openZip(commented.buffer),allowedComments=new Set(['word/document.xml','word/comments.xml','[Content_Types].xml','word/_rels/document.xml.rels']);
  for(const name of before.names)if(!allowedComments.has(name))assert.deepEqual(commentsZip.read(name),before.read(name),'Comment non-target package entry '+name);
  row.patchApplied=patched.applied.length;row.commentAccepted=commented.placements.length;row.commentWordTargets=commented.added;
  row.patchOutcomes=patched.skipped.map(x=>({patchId:x.patchId,reasonCode:x.reasonCode,classification:PROTECTION.has(x.reasonCode)?'protected':PENDING.has(x.reasonCode)?'unmapped':'unexpected'}));
  row.commentOutcomes=commented.skippedDetails.map(x=>({issueIndex:x.issueIndex,reasonCode:x.reasonCode,classification:PROTECTION.has(x.reasonCode)?'protected':PENDING.has(x.reasonCode)?'unmapped':'unexpected'}));
  for(const x of row.patchOutcomes)row['patch'+(x.classification==='protected'?'Protected':'Unmapped')]++;
  for(const x of row.commentOutcomes)row['comment'+(x.classification==='protected'?'Protected':'Unmapped')]++;
  row.candidates=picked.items.map((c,i)=>({...c,anchor:issues[i].anchor}));
  row.sourceReadbackSha256=sha(readFileSync(entry.path));assert.equal(row.sourceReadbackSha256,entry.sourceSha256);
  row.originalXmlEntryHashes=Object.fromEntries([...beforeNodes.keys()].map(part=>[part,sha(before.read(part))]));
  row.unmodifiedPackageEntryUncompressedBytesPreserved=true;row.modifiedPhysicalNodesVerified=true;
  row.status=!row.candidateCount?'pending_no_coordinate_candidate':row.patchOutcomes.some(x=>x.classification==='unexpected')||row.commentOutcomes.some(x=>x.classification==='unexpected')?'partial_unexpected_rejection'
   :row.patchUnmapped||row.commentUnmapped?'partial_unmapped':row.patchProtected||row.commentProtected?'partial_protected':'representative_ranges_verified';
 }catch(error){row.status='failed_technical_verification';row.violations.push({name:error.name,message:error.message});}
 rows.push(row);write(String(ordinal).padStart(4,'0')+'-'+entry.assetId+'.json',row);
 if(ordinal%25===0)console.log(JSON.stringify({progress:ordinal+1,total:selected.length,originalSelected:Math.min(selected.length,632),derivedSelected:Math.max(0,selected.length-632)}));
}
const afterProof=originals.map(a=>{const actual=sha(readFileSync(a.path));assert.equal(actual,a.expected,a.path);return{assetId:a.assetId,sha256:actual};});
assert.deepEqual(afterProof,sourceProofBefore);assert.equal(sha(readFileSync(inventoryPath)),inventoryHash);
for(const d of derivedProof)assert.equal(sha(readFileSync(d.path)),d.contentSha256);
if(derivedPath)assert.equal(sha(readFileSync(derivedPath)),derivedManifestSha);
for(const [f,h]of Object.entries(fingerprints))assert.equal(sha(readFileSync(join(ROOT,f))),h,'Source changed during representative corpus test');
const report={schemaVersion:1,at:new Date().toISOString(),runId:cfg.runId,inventoryPath,inventorySha256:inventoryHash,originalPhysicalDenominator:715,
 plannedOriginalDocxPaths:632,plannedDerivedDocxPaths:derivedPath?7:0,selectedOriginalDocxPaths:rows.filter(r=>r.sourceKind==='original').length,selectedDerivedDocxPaths:rows.filter(r=>r.sourceKind==='derived').length,
 fullPlannedPathCoverage:selected.length===entries.length,derivedLegacyPending:derivedPending,fingerprints,
 source715BeforeAfterHashUnchanged:true,derivedSourceChainAndHashesUnchanged:true,
 statuses:Object.fromEntries([...new Set(rows.map(r=>r.status))].map(s=>[s,rows.filter(r=>r.status===s).length])),
 counts:Object.fromEntries(['candidateCount','patchApplied','patchProtected','patchUnmapped','commentAccepted','commentWordTargets','commentProtected','commentUnmapped'].map(k=>[k,rows.reduce((sum,r)=>sum+r[k],0)])),
 failures:rows.filter(r=>r.status==='failed_technical_verification').map(r=>({assetId:r.assetId,violations:r.violations})),rows,derivedProof,
 softwareOnly:true,modelCalls:0,apiRequests:0,servicesStarted:0,originalFilesModified:false,ledgerModified:false,
 scope:'Representative first/last body and note ranges, table/logical-physical difference/revision/figure/field-bearing contexts on actual immutable packages; in-memory patch/comment copies read back. Protected/unmapped outcomes remain partial or pending. No full-character, semantics, DOM, Word application, intake or quality acceptance claim.'};
write('report.json',report);console.log(JSON.stringify({out,statuses:report.statuses,counts:report.counts,failed:report.failures.length,fullPlannedPathCoverage:report.fullPlannedPathCoverage}));if(report.failures.length)process.exitCode=1;

