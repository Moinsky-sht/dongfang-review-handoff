/** Note ownership is assigned by its actual XML container; software-only checks. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {writeZip} from '../src/zip-write.js';
import {openZip} from '../src/zip.js';
import {parseXml} from '../src/xml.js';
import {CORPUS_ROOT} from './paths.mjs';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const flag=name=>process.argv.find(arg=>arg.startsWith('--'+name+'='))?.slice(name.length+3);
const source=resolve(project,flag('source')||'src/docx.js');
const within=(base,path)=>{const part=relative(resolve(base),resolve(path));return !part.startsWith('..')&&!isAbsolute(part);};
assert.ok(within(project,source)&&source.endsWith('.js'));
const evidence=resolve(flag('evidence-root')||process.env.DSH_VERIFICATION_EVIDENCE_DIR||join(project,'data/verify'));
assert.ok(within(join(project,'data/verify'),evidence)||process.env.DSH_VERIFICATION_EVIDENCE_DIR&&within(process.env.DSH_VERIFICATION_EVIDENCE_DIR,evidence)||flag('evidence-root')&&within(join(project,'data/optimization/runs'),evidence));
async function safePath(path){for(let cursor=resolve(path);;cursor=dirname(cursor)){assert.equal(existsSync(join(cursor,'complete.json')),false,'Cannot write sealed evidence');try{const s=await lstat(cursor);assert.ok(s.isDirectory()&&!s.isSymbolicLink());assert.equal(resolve(await realpath(cursor)),cursor);}catch(e){if(e.code!=='ENOENT')throw e;}if(dirname(cursor)===cursor)break;}}
await safePath(evidence);await mkdir(evidence,{recursive:true});await safePath(evidence);
const run=join(evidence,'note-identity-'+Date.now()+'-'+randomUUID());await mkdir(run);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),sourceBytes=await readFile(source);
const {parseDocxBuffer}=await import(pathToFileURL(source).href);
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const p=text=>`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const box='<w:r><w:pict><w:txbxContent>'+p('SOFTWARE-BOX')+'</w:txbxContent></w:pict></w:r>';
const fixture=(kind,notes)=>writeZip([{name:'word/document.xml',data:`<w:document xmlns:w="${W}"><w:body>${p('SOFTWARE-BODY')}<w:sectPr/></w:body></w:document>`},{name:`word/${kind}s.xml`,data:`<w:${kind}s xmlns:w="${W}">${notes}</w:${kind}s>`},{name:'[Content_Types].xml',data:'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'}]);
const report={at:new Date().toISOString(),source,sourceSha256:hash(sourceBytes),testSha256:hash(await readFile(fileURLToPath(import.meta.url))),realArkCalls:0,modelsCalled:0,serversStarted:0,sourceManuscriptsModified:false,checks:[],corpusRows:[],scope:'XML identity/text-vector evidence only, not semantic review or browser/Word application proof'};
async function check(name,fn){try{const detail=await fn();report.checks.push({name,ok:true,detail});console.log('PASS '+name);}catch(error){report.checks.push({name,ok:false,error:error.stack});console.log('FAIL '+name);}}
for(const kind of ['footnote','endnote']){
 await check(kind+' direct paragraph textbox never steals the following note identity',()=>{const bytes=fixture(kind,`<w:${kind} w:id="7"><w:p><w:r><w:t>SOFTWARE-FIRST</w:t></w:r>${box}</w:p></w:${kind}><w:${kind} w:id="9">${p('SOFTWARE-NEXT')}</w:${kind}>`),notes=parseDocxBuffer(bytes)[kind+'s'];assert.deepEqual(notes.map(x=>x.noteId),['7','9']);assert.deepEqual(notes.map(x=>x.text),['SOFTWARE-FIRST','SOFTWARE-NEXT']);assert.deepEqual(notes.map(x=>x.index),[0,1]);return{noteIds:notes.map(x=>x.noteId)};});
 await check(kind+' separator textbox does not classify the next ordinary note as separator',()=>{const bytes=fixture(kind,`<w:${kind} w:id="777" w:type="separator"><w:p>${box}</w:p></w:${kind}><w:${kind} w:id="3">${p('SOFTWARE-REGULAR')}</w:${kind}>`),notes=parseDocxBuffer(bytes)[kind+'s'];assert.deepEqual(notes.map(x=>x.noteId),['777','3']);assert.deepEqual(notes.map(x=>x.isNoteSeparator),[true,false]);assert.deepEqual(notes.map(x=>x.noteType),['separator','']);return{noteIds:notes.map(x=>x.noteId)};});
 await check(kind+' multi-paragraph and table paragraphs retain one container ID and stable part indexes',()=>{const table='<w:tbl><w:tr><w:tc>'+p('SOFTWARE-TABLE')+'</w:tc></w:tr></w:tbl>';const bytes=fixture(kind,`<w:${kind} w:id="-1" w:type="separator">${p('')}</w:${kind}><w:${kind} w:id="4">${p('SOFTWARE-A')}${table}${p('SOFTWARE-B')}</w:${kind}><w:${kind} w:id="8">${p('SOFTWARE-C')}</w:${kind}>`),notes=parseDocxBuffer(bytes)[kind+'s'];assert.deepEqual(notes.map(x=>x.noteId),['-1','4','4','4','8']);assert.deepEqual(notes.map(x=>x.index),[0,1,2,3,4]);assert.equal(notes[2].inTable,true);assert.equal(notes[2].text,'SOFTWARE-TABLE');return{noteIds:notes.map(x=>x.noteId)};});
}
if(process.argv.includes('--corpus')){
 await check('all 632 actual source paths keep body/note text vectors and use their actual XML note owner',async()=>{
 const beforePath=resolve(project,'data/optimization/runs/p0-03-reviewqueue-20261009022544/final-source-overlay-fix/src/docx.js');
 const beforeModule=await import(pathToFileURL(beforePath).href);report.beforeParserSha256=hash(await readFile(beforePath));
 const manifestBytes=await readFile(join(project,'data/corpus/manifest.json'));report.manifestSha256=hash(manifestBytes);const rawManifest=JSON.parse(manifestBytes);const manifest=rawManifest.filter(file=>/\.docx$/i.test(file.path));report.wordManifestPaths=rawManifest.length;report.docxSelectedPaths=manifest.length;report.otherWordPaths=rawManifest.length-manifest.length;report.otherWordScope='Legacy DOC remains pending conversion in the global ledger; XML ownership check applies to DOCX only';assert.equal(manifest.length,632);
 const vector=doc=>Object.fromEntries(['paragraphs','footnotes','endnotes'].map(key=>[key,doc[key].map(x=>({text:x.text,before:x.before,id:x.id,index:x.index,part:x.part,inTable:x.inTable,tableIdx:x.tableIdx??null}))]));
  for(const[index,file]of manifest.entries()){
   const path=resolve(CORPUS_ROOT,file.path);assert.ok(within(CORPUS_ROOT,path));const bytes=await readFile(path);assert.equal(hash(bytes),file.sha256);const old=beforeModule.parseDocxBuffer(bytes),doc=parseDocxBuffer(bytes),zip=openZip(bytes);assert.deepEqual(vector(doc),vector(old),file.path);
   const row={index,path:file.path,sourceSha256:file.sha256,textVectorsUnchanged:true,notes:0,oldOwnerMismatches:0};
   for(const kind of ['footnote','endnote']){const xml=zip.readText('word/'+kind+'s.xml');if(!xml){assert.equal(doc[kind+'s'].length,0);continue;}const root=parseXml(xml),expected=[];
    for(const container of root.descendants('w:'+kind)){const id=container.attr('w:id'),type=container.attr('w:type')||'';for(const child of container.children){const nodes=child.name==='w:p'?[child]:child.name==='w:tbl'?child.descendants('w:p'):[];for(const node of nodes)expected.push({id,type,separator:/separator/i.test(type)});}}
    assert.equal(doc[kind+'s'].length,expected.length,file.path);for(const[i,note]of doc[kind+'s'].entries()){assert.equal(note.noteId,expected[i].id,file.path);assert.equal(note.noteType,expected[i].type,file.path);assert.equal(note.isNoteSeparator,expected[i].separator,file.path);row.notes++;if(old[kind+'s'][i].noteId!==expected[i].id||old[kind+'s'][i].noteType!==expected[i].type)row.oldOwnerMismatches++;}
   }
   assert.equal(hash(await readFile(path)),file.sha256);report.corpusRows.push(row);if((index+1)%128===0)console.log('Corpus note ownership '+(index+1)+'/632');
  }
  return{paths:report.corpusRows.length,noteParagraphs:report.corpusRows.reduce((n,x)=>n+x.notes,0),oldOwnerMismatchPaths:report.corpusRows.filter(x=>x.oldOwnerMismatches).length};
 });
}
report.sourceChanged=hash(await readFile(source))!==report.sourceSha256;report.ok=report.checks.every(x=>x.ok)&&!report.sourceChanged;report.finishedAt=new Date().toISOString();
await writeFile(join(run,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log('Evidence: '+join(run,'report.json'));process.exitCode=report.ok?0:1;
