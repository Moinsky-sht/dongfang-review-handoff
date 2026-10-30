/** Independently re-read archived Word bytes using the application's parser/cleaner. */
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute,extname} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {parseDocxBuffer} from '../src/docx.js';
import {cleanDocx,inspectDocxComments} from '../src/docx-clean.js';
import {openZip,isOle2} from '../src/zip.js';
import {scanCleanXml,deleteCleanSpans} from '../src/docx-clean-xml.js';
const project=process.cwd(),runs=resolve('data/optimization/runs'),hash=b=>createHash('sha256').update(b).digest('hex');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const within=(base,p)=>{const r=relative(base,p);return r!==''&&!r.startsWith('..')&&!isAbsolute(r);};
const arg=name=>process.argv.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3);
const manifestPath=resolve(arg('manifest')||''),out=resolve(arg('out')||'');
assert(within(runs,manifestPath)&&within(runs,out),'Input and output must be registered run artifacts');
async function guard(path,writing){for(let ancestor=path;ancestor!==dirname(ancestor);ancestor=dirname(ancestor)){
 try{assert(!(await lstat(ancestor)).isSymbolicLink(),'Evidence alias');}catch(e){if(e.code!=='ENOENT')throw e;}
 if(writing)try{await lstat(join(ancestor,'complete.json'));throw Error('Sealed output');}catch(e){if(e.code!=='ENOENT')throw e;}
}}
await guard(manifestPath,false);await guard(out,true);
const outputRun=join(runs,relative(runs,out).split(/[\\/]/)[0]);assert((await lstat(join(outputRun,'run.json'))).isFile());
await mkdir(out);await guard(out,true);
const manifest=await json(manifestPath),base=dirname(manifestPath);
const baseline=await json('data/optimization/runs/baseline-20261009-f7bba6676b-99bf7867/inventory.json');
const WORD=new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main','http://purl.oclc.org/ooxml/wordprocessingml/main']);
const ANCHORS=new Set(['commentRangeStart','commentRangeEnd','commentReference','annotationRef']);
const PROTECTED=new Set(['t','delText','instrText','hyperlink','fldChar','fldSimple','bookmarkStart','bookmarkEnd','ins','del','moveFrom','moveTo','footnoteReference','endnoteReference']);
function protectedVector(bytes,part){const s=scanCleanXml(bytes,part),markers=s.nodes.filter(n=>WORD.has(n.ns)&&ANCHORS.has(n.local));return s.nodes.filter(n=>WORD.has(n.ns)&&PROTECTED.has(n.local)).map(n=>({kind:n.local,sha256:hash(deleteCleanSpans(s.xml.slice(n.start,n.end),markers.filter(m=>m.start>=n.start&&m.end<=n.end).map(m=>({start:m.start-n.start,end:m.end-n.start})),part))}));}
const vector=d=>Object.fromEntries(['paragraphs','footnotes','endnotes'].map(k=>[k,(d[k]||[]).map(p=>({id:p.id,text:p.text,noteId:p.noteId??null,inTable:p.inTable??false,tableIdx:p.tableIdx??null}))]));
const fingerprints={};for(const file of ['src/docx.js','src/docx-clean.js','src/docx-clean-xml.js','src/zip.js','src/zip-write.js','tools/validate-derived-word-assets.mjs'])fingerprints[file]=hash(await readFile(file));
const results=[];
for(const archive of manifest.archives){
 const asset=baseline.files.find(a=>a.assetId===archive.parent.assetId);assert(asset);assert.equal(archive.parent.sha256,asset.sourceSha256);
 const originalArchive=resolve(baseline.sourceRoot,asset.relativePath);assert.equal(hash(await readFile(originalArchive)),asset.sourceSha256);
 for(const member of archive.members){
  if(!member.contentFile||member.type!=='file'||!['.doc','.docx'].includes(extname(member.name).toLowerCase())||member.exclusionReason||member.role==='technical_metadata')continue;
  const row={derivedAssetId:member.derivedAssetId,parentAssetId:asset.assetId,ordinal:member.ordinal,name:member.name,sourceSha256:member.contentSha256,status:'failed',checks:{},semanticQualityVerified:false,realArkCalls:0};
  try{
   assert(typeof member.derivedAssetId==='string'&&/^[a-z0-9][a-z0-9_-]{0,160}$/i.test(member.derivedAssetId),'Invalid derived identity');
   assert(member.crcVerified===true,'Archive member CRC has not been verified');
   const payload=resolve(base,member.contentFile);assert(within(base,payload));await guard(payload,false);const bytes=await readFile(payload);assert.equal(hash(bytes),member.contentSha256);
   row.checks.extractedBytesMatchIdentity=true;
   if(isOle2(bytes)){row.status='pending_legacy_word_validation_and_conversion';row.reason='An OLE compound payload is preserved; this does not prove a lossless Word conversion or an available DOCX intake.';}
   else{
    const beforeDoc=parseDocxBuffer(bytes,member.name),before=openZip(bytes),clean=cleanDocx(bytes),after=openZip(clean.buffer),afterDoc=parseDocxBuffer(clean.buffer,member.name);
    const residual=inspectDocxComments(clean.buffer),touched=new Set(clean.stats.partsTouched),removed=new Set(clean.stats.partsRemoved);
    const checks={zeroCommentResiduals:['comments','anchors','commentParts','relationships','contentTypes'].every(k=>residual[k]===0),verifiedCleanStats:clean.stats.beforeAfter?.verified===true,
     packageEntryIdentity:JSON.stringify(after.names)===JSON.stringify(before.names.filter(n=>!removed.has(n))),untargetedBytes:before.names.every(n=>removed.has(n)||touched.has(n)||before.read(n).equals(after.read(n))),
     protectedXmlSpans:before.names.filter(n=>/\.xml$/i.test(n)&&!removed.has(n)).every(n=>JSON.stringify(protectedVector(before.read(n),n))===JSON.stringify(protectedVector(after.read(n),n))),
     bodyNoteIdentityTextAndTableVectors:JSON.stringify(vector(beforeDoc))===JSON.stringify(vector(afterDoc)),exactCleanIdempotency:cleanDocx(clean.buffer).buffer.equals(clean.buffer),archivePayloadStillUnchanged:hash(await readFile(payload))===member.contentSha256};
    Object.assign(row.checks,checks);assert(Object.values(checks).every(Boolean),'Derived Word parse/clean fidelity condition failed');
    row.status='software_parse_clean_passed';row.cleanStats=clean.stats;row.outputSha256=hash(clean.buffer);row.vectorSha256=hash(JSON.stringify(vector(afterDoc)));
    row.counts={bodyParagraphs:afterDoc.paragraphs.length,footnoteParagraphs:afterDoc.footnotes?.length||0,endnoteParagraphs:afterDoc.endnotes?.length||0,tables:afterDoc.tables?.length||0};
    row.originalContentEvidence=relative(project,payload).replaceAll('\\','/');
    if(!clean.buffer.equals(bytes)){const file=member.derivedAssetId+'.clean.docx';await writeFile(join(out,file),clean.buffer,{flag:'wx'});row.cleanContentEvidence=relative(project,join(out,file)).replaceAll('\\','/');}
    else row.cleanContentEvidence=row.originalContentEvidence;
   }
  }catch(e){row.error={name:e.name,code:e.code??null,message:e.message};}
  results.push(row);
 }
 assert.equal(hash(await readFile(originalArchive)),asset.sourceSha256);
}
for(const [file,sha]of Object.entries(fingerprints))assert.equal(hash(await readFile(file)),sha,file);
const report={at:new Date().toISOString(),archiveManifest:relative(project,manifestPath).replaceAll('\\','/'),archiveManifestSha256:hash(await readFile(manifestPath)),originalPhysicalDenominator:715,derivedWordMemberPaths:results.length,passed:results.filter(r=>r.status==='software_parse_clean_passed').length,pendingLegacy:results.filter(r=>r.status==='pending_legacy_word_validation_and_conversion').length,failed:results.filter(r=>r.status==='failed').length,results,fingerprints,realArkCalls:0,roleAndFamilyPromoted:false,browserOrFormatIngestionPassed:false,scope:'Independent application-parser and software clean fidelity on actual preserved archive members, not content judgment, full intake or browser acceptance.'};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({members:report.derivedWordMemberPaths,passed:report.passed,pendingLegacy:report.pendingLegacy,failed:report.failed,realArkCalls:0}));
if(report.failed)process.exitCode=1;
