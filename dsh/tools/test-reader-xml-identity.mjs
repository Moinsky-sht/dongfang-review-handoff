/** Complete actual DocumentParser methods execute in a VM over real XML with an explicit standard DOM adapter. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {parseXml} from '../src/xml.js';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const arg=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const sha=b=>createHash('sha256').update(b).digest('hex');
const pointer=JSON.parse(readFileSync(join(ROOT,'tmp/range-contract-current-run.json'),'utf8'));
const RUNS=join(ROOT,'data/optimization/runs'),VERIFY=join(ROOT,'data/verify');
const within=(r,p)=>{const q=relative(resolve(r),resolve(p));return q!==''&&q!=='..'&&!q.startsWith('..'+sep)&&!isAbsolute(q);};
function guard(p,sealed=true){
 for(let a=resolve(p);;a=dirname(a)){
  const st=lstatSync(a,{throwIfNoEntry:false});
  if(st)assert(!st.isSymbolicLink()&&resolve(realpathSync(a)).toLowerCase()===a.toLowerCase(),'Evidence alias refused');
  if(sealed)assert(!lstatSync(join(a,'complete.json'),{throwIfNoEntry:false}),'Sealed ancestor refused');
  if(a===dirname(a))break;
 }
}
const run=resolve(pointer.runDirectory);
assert(within(RUNS,run)&&relative(RUNS,run).toLowerCase()===pointer.runId.toLowerCase());
guard(run,false);
const inherited=process.env.DSH_VERIFICATION_EVIDENCE_DIR?resolve(ROOT,process.env.DSH_VERIFICATION_EVIDENCE_DIR):null;
if(inherited){assert(within(RUNS,inherited));guard(inherited);}
const requested=resolve(ROOT,arg('out')||join(inherited||VERIFY,'reader-xml-identity-'+Date.now()+'-'+randomUUID().slice(0,8)));
const out=extname(requested)==='.json'?requested:join(requested,'report.json');
assert([run,VERIFY,...(inherited?[inherited]:[])].some(r=>within(r,out)),'Output outside current/unsealed evidence roots');
guard(dirname(out));assert(!lstatSync(out,{throwIfNoEntry:false}),'Fresh wx report required');
const mode=arg('source')||'current';
assert(['original','before','current','vendor'].includes(mode));
const installed=join(ROOT,'node_modules/docx-preview/dist/docx-preview.js');
const sourcePath=mode==='original'?installed:mode==='before'?resolve(ROOT,arg('backupVendor')||join(run,'before/public/vendor/docx-preview-0.4.0.js')):join(ROOT,'public/vendor/docx-preview-0.4.0.js');
guard(sourcePath,false);
const bytes=readFileSync(sourcePath),source=bytes.toString('utf8').replace(/\r\n/g,'\n');
const exportPoint='    exports.parseAsync = parseAsync;';
assert.equal(source.split(exportPoint).length-1,1,'Actual bundle export point must be unique');
// ZIP loading is outside this direct-parser contract. Refuse it explicitly;
// do not install dependencies or let a mock ZIP reader manufacture XML nodes.
const zipBoundary=Object.freeze({loadAsync(){throw new Error('ZIP loading is disabled in direct XML parser VM');}});
const exports={},sandbox={exports,module:{exports},require(name){assert.equal(name,'jszip');return zipBoundary;},console,
 Node:{ELEMENT_NODE:1,TEXT_NODE:3},WeakMap,Map,Set};
runInNewContext(source.replace(exportPoint,'    exports.__dshDocumentParser = DocumentParser;\n'+exportPoint),sandbox,{filename:sourcePath,timeout:5000});
const Actual=sandbox.exports.__dshDocumentParser;assert.equal(typeof Actual,'function');
function method(name){
 const classAt=source.indexOf('    class DocumentParser {');
 const start=source.indexOf('        '+name+'(',classAt);
 if(start<0)return null;
 const end=source.indexOf('\n        }',start);assert(end>start);
 return source.slice(start,end+10);
}
const methodNames=['parseParagraph','parseTable','parseTableRow','parseTableCell','parseRun','parseSdt','parseChange','dshSourceXmlIdentity'];
const actualMethods=Object.fromEntries(methodNames.map(n=>[n,method(n)]));
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const list=items=>Object.assign(items,{item(i){return this[i]??null;}});
/** Namespace/ownership/NodeList APIs match the DOM calls made by the actual parser. */
function xmlDocument(xml){
 const tree=parseXml(xml),document={nodeType:9,documentElement:null};
 const all=(node,uri,local,include=false)=>{
  const result=[];
  const walk=n=>{if(n.nodeType===1&&(uri==='*'||n.namespaceURI===uri)&&(local==='*'||n.localName===local))result.push(n);for(const c of n.childNodes||[])walk(c);};
  if(include)walk(node);else for(const c of node.childNodes||[])walk(c);
  return list(result);
 };
 const convert=(raw,parent,namespaces)=>{
  const ns={...namespaces};
  for(const [key,value]of Object.entries(raw.attrs||{}))if(key==='xmlns')ns['']=value;else if(key.startsWith('xmlns:'))ns[key.slice(6)]=value;
  const parts=raw.name.split(':'),prefix=parts.length===2?parts[0]:'',localName=parts.at(-1);
  const node={nodeType:1,nodeName:raw.name,tagName:raw.name,localName,prefix:prefix||null,namespaceURI:ns[prefix]||null,
   ownerDocument:document,parentNode:parent,childNodes:list([])};
  node.attributes=list(Object.entries(raw.attrs||{}).map(([name,value])=>({name,nodeName:name,localName:name.split(':').at(-1),value,nodeValue:value})));
  node.getAttribute=name=>Object.hasOwn(raw.attrs||{},name)?raw.attrs[name]:null;
  node.getAttributeNS=(uri,local)=>node.attributes.find(a=>a.localName===local&&ns[a.name.includes(':')?a.name.split(':')[0]:'']===uri)?.value??null;
  node.getElementsByTagNameNS=(uri,local)=>all(node,uri,local);
  node.childNodes=list((raw.children||[]).map(c=>convert(c,node,ns)));
  if(raw.text){const text={nodeType:3,nodeName:'#text',nodeValue:raw.text,ownerDocument:document,parentNode:node};Object.defineProperty(text,'textContent',{get:()=>text.nodeValue});node.childNodes.push(text);}
  Object.defineProperty(node,'textContent',{get:()=>node.childNodes.map(n=>n.textContent||'').join('')});
  Object.defineProperty(node,'firstElementChild',{get:()=>node.childNodes.find(n=>n.nodeType===1)||null});
  return node;
 };
 const raw=tree.children[0];assert(raw,'XML root required');document.documentElement=convert(raw,document,{});
 document.childNodes=list([document.documentElement]);document.getElementsByTagNameNS=(uri,local)=>all(document.documentElement,uri,local,true);
 return document;
}
const p=t=>'<w:p><w:r><w:t>'+t+'</w:t></w:r></w:p>';
const textbox='<w:pict><v:shape><v:textbox><w:txbxContent>'+p('BOX')+'</w:txbxContent></v:textbox></v:shape></w:pict>';
const nested='<w:tbl><w:tr><w:tc>'+p('INNER')+'</w:tc></w:tr></w:tbl>';
const body='<w:p/>'+p('FIRST')+'<w:p><w:r>'+textbox+'</w:r></w:p><w:tbl><w:tr><w:tc>'+p('CELL')+nested+'</w:tc></w:tr></w:tbl>'+p('LAST');
const fixture='<w:document xmlns:w="'+W+'" xmlns:v="urn:schemas-microsoft-com:vml"><w:body>'+body+'</w:body></w:document>';
const xml=xmlDocument(fixture),paragraphs=xml.getElementsByTagNameNS(W,'p'),tables=xml.getElementsByTagNameNS(W,'tbl');
const parser=new Actual(),checks=[];
const plain=x=>JSON.parse(JSON.stringify(x));
const test=(name,fn)=>{try{const observed=fn();checks.push({name,ok:true,observed});}catch(error){checks.push({name,ok:false,error:{name:error.name,message:error.message}});}};
const identity=(ast,ordinal,part='document.xml',kind='p')=>{
 assert.equal(ast.part,part);assert.equal(ast.sourceXmlNodeId,part+':xml-'+kind+':'+ordinal);
 assert.equal(ast[kind==='p'?'sourceXmlParagraphOrdinal':'sourceXmlTableOrdinal'],ordinal);
};
test('standard adapter namespace and document order controls',()=>{
 assert.equal(paragraphs.length,7);assert.equal(tables.length,2);assert.deepEqual(paragraphs.map(n=>n.textContent),['','FIRST','BOX','BOX','CELL','INNER','LAST']);
 return{paragraphs:paragraphs.length,tables:tables.length};
});
test('complete actual parser methods preserve plain text without replacing parseRun',()=>{
 const ast=parser.parseParagraph(paragraphs[1]);assert.equal(ast.children[0].type,'run');assert.equal(ast.children[0].children[0].text,'FIRST');
 return{type:ast.type,text:ast.children[0].children[0].text};
});
test('actual helper is callable and not inferred from source strings',()=>{
 assert.equal(typeof parser.dshSourceXmlIdentity,'function');const a=parser.dshSourceXmlIdentity(paragraphs[1],'p');identity(a,1);return a;
});
for(let i=0;i<paragraphs.length;i++)test('actual parseParagraph physical ordinal '+i,()=>{
 const ast=parser.parseParagraph(paragraphs[i]);identity(ast,i);return{part:ast.part,sourceXmlNodeId:ast.sourceXmlNodeId,sourceXmlParagraphOrdinal:ast.sourceXmlParagraphOrdinal};
});
for(let i=0;i<tables.length;i++)test('actual parseTable nested physical ordinal '+i,()=>{
 const ast=parser.parseTable(tables[i]);identity(ast,i,'document.xml','tbl');return{part:ast.part,sourceXmlNodeId:ast.sourceXmlNodeId,sourceXmlTableOrdinal:ast.sourceXmlTableOrdinal};
});
test('textbox counts physically but its AST identity is not a business membership claim',()=>{
 const box=parser.parseParagraph(paragraphs[3]);identity(box,3);const host=parser.parseParagraph(paragraphs[2]);identity(host,2);
 assert.equal(box.sourceXmlParagraphOrdinal,3);return{host:host.sourceXmlNodeId,textbox:box.sourceXmlNodeId,scope:'Physical counting only; business membership must come from backend DTO.'};
});
const wrappers=xmlDocument('<w:document xmlns:w="'+W+'"><w:body><w:p><w:ins w:id="1"><w:r><w:t>INS</w:t></w:r></w:ins><w:del w:id="2"><w:r><w:delText>DEL</w:delText></w:r></w:del><w:sdt><w:sdtContent><w:r><w:t>SDT</w:t></w:r></w:sdtContent></w:sdt></w:p></w:body></w:document>');
for(const local of ['ins','del','sdtContent'])test('fake paragraph adapter '+local+' has no source identity',()=>{
 const ast=parser.parseParagraph(wrappers.getElementsByTagNameNS(W,local)[0]);
 assert(!Object.hasOwn(ast,'sourceXmlNodeId'));assert(!Object.hasOwn(ast,'sourceXmlParagraphOrdinal'));return{type:ast.type,identityAbsent:true};
});
test('actual outer revision paragraph retains its own identity',()=>{const ast=parser.parseParagraph(wrappers.getElementsByTagNameNS(W,'p')[0]);identity(ast,0);assert.equal(ast.children.length,3);return{sourceXmlNodeId:ast.sourceXmlNodeId,children:ast.children.map(c=>c.type)};});
for(const [root,part]of [['footnotes','footnotes.xml'],['endnotes','endnotes.xml']])test('same parser separates actual part '+part,()=>{
 const d=xmlDocument('<w:'+root+' xmlns:w="'+W+'"><w:'+root.slice(0,-1)+' w:id="5">'+p('NOTE')+'</w:'+root.slice(0,-1)+'></w:'+root+'>');
 const ast=parser.parseParagraph(d.getElementsByTagNameNS(W,'p')[0]);identity(ast,0,part);return{sourceXmlNodeId:ast.sourceXmlNodeId};
});
test('default namespace identity uses URI instead of a w prefix heuristic',()=>{
 const d=xmlDocument('<document xmlns="'+W+'"><body><p><r><t>DEFAULT</t></r></p></body></document>');
 const ast=parser.parseParagraph(d.getElementsByTagNameNS(W,'p')[0]);identity(ast,0);return{sourceXmlNodeId:ast.sourceXmlNodeId};
});
test('foreign p namespace cannot impersonate real WML paragraph',()=>{
 const d=xmlDocument('<w:document xmlns:w="'+W+'" xmlns:f="urn:foreign"><w:body><f:p/></w:body></w:document>');
 const ast=parser.parseParagraph(d.getElementsByTagNameNS('urn:foreign','p')[0]);assert(!Object.hasOwn(ast,'sourceXmlNodeId'));return{identityAbsent:true};
});
test('foreign document root cannot confer a business part',()=>{
 const d=xmlDocument('<f:document xmlns:f="urn:foreign" xmlns:w="'+W+'"><w:p/></f:document>');
 const ast=parser.parseParagraph(d.getElementsByTagNameNS(W,'p')[0]);assert(!Object.hasOwn(ast,'sourceXmlNodeId'));return{identityAbsent:true};
});
test('unknown WML part root remains unbound instead of guessed as document',()=>{
 const d=xmlDocument('<w:hdr xmlns:w="'+W+'">'+p('HEADER')+'</w:hdr>');
 const ast=parser.parseParagraph(d.getElementsByTagNameNS(W,'p')[0]);assert(!Object.hasOwn(ast,'sourceXmlNodeId'));return{identityAbsent:true};
});
test('current ownerDocument separates ordinals across complete XML documents',()=>{
 const d=xmlDocument('<w:document xmlns:w="'+W+'"><w:body>'+p('ONLY')+'</w:body></w:document>');
 const a=parser.parseParagraph(d.getElementsByTagNameNS(W,'p')[0]);identity(a,0);
 const b=parser.parseParagraph(paragraphs[6]);identity(b,6);return{newDocument:a.sourceXmlNodeId,originalDocument:b.sourceXmlNodeId};
});
test('upstream installation and selected source remain byte unchanged',()=>{
 assert.equal(sha(readFileSync(sourcePath)),sha(bytes));return{sourceSha256:sha(bytes),installedSha256:sha(readFileSync(installed))};
});
const report={schemaVersion:1,runId:pointer.runId,phase:mode==='original'||mode==='before'?'red-source':'green-current',sourcePath,sourceSha256:sha(bytes),
 softwareOnly:true,realBrowserVerified:false,wordVerified:false,modelCalls:0,apiRequests:0,servicesStarted:0,
 scope:'Full actual vendor bundle executes in VM with one export hook; actual DocumentParser methods execute over real XML and a documented DOM namespace/ownership adapter. ZIP dependency is an explicit disabled boundary, not exercised. No AST business-membership, CSS or real-DOM bridge acceptance claim.',
 methodSourceHashes:Object.fromEntries(Object.entries(actualMethods).map(([n,s])=>[n,s==null?null:sha(s)])),
 passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,total:checks.length,checks};
guard(dirname(out));mkdirSync(dirname(out),{recursive:true});guard(dirname(out));assert(!lstatSync(out,{throwIfNoEntry:false}));
writeFileSync(join(dirname(out),'fixture.xml'),fixture+'\n',{flag:'wx'});
writeFileSync(join(dirname(out),'actual-parser-methods.json'),JSON.stringify({sourcePath,sourceSha256:sha(bytes),methods:actualMethods},null,2)+'\n',{flag:'wx'});
writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({out,sourcePath,passed:report.passed,failed:report.failed,total:report.total}));if(report.failed)process.exitCode=1;

