/** Software-only proof using complete methods from the actual installed/vendored renderer. No API, model or server. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {execFileSync} from 'node:child_process';
import {openZip} from '../src/zip.js';
import {parseXml} from '../src/xml.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const arg=n=>process.argv.find(x=>x.startsWith('--'+n+'='))?.slice(n.length+3);
const sha=x=>createHash('sha256').update(x).digest('hex');
const BASE_SHA='48206d7d7ab55fcdf50e5a47aff0bd15734b3da6dd30e0b46e47ca172d0e16fc';
const pointer=JSON.parse(readFileSync(join(ROOT,existsSync(join(ROOT,'tmp/range-contract-current-run.json'))?'tmp/range-contract-current-run.json':'tmp/endnote-current-run.json'),'utf8'));
const OPTIMIZATION_RUNS=join(ROOT,'data/optimization/runs');
const VERIFY_ROOT=join(ROOT,'data/verify');
const within=(root,p)=>{const r=relative(resolve(root),resolve(p));return r!==''&&r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};
function guardAncestors(target,rejectSealed){
  for(let p=resolve(target);;p=dirname(p)){
    const stat=lstatSync(p,{throwIfNoEntry:false});
    if(stat){
      assert(!stat.isSymbolicLink()&&resolve(realpathSync(p)).toLowerCase()===p.toLowerCase(),'Evidence alias rejected: '+p);
      assert(stat.isDirectory(),'Evidence ancestor must be a directory: '+p);
    }
    if(rejectSealed)assert(!lstatSync(join(p,'complete.json'),{throwIfNoEntry:false}),'Sealed evidence ancestor rejected: '+p);
    if(p===dirname(p))break;
  }
}
assert(pointer&&typeof pointer==='object'&&!Array.isArray(pointer),'Run pointer must be an object');
assert(typeof pointer.runId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(pointer.runId),'Invalid run pointer identity');
assert(typeof pointer.runDirectory==='string'&&isAbsolute(pointer.runDirectory),'Run pointer directory must be absolute');
const run=resolve(pointer.runDirectory);
assert(within(OPTIMIZATION_RUNS,run)&&relative(OPTIMIZATION_RUNS,run).toLowerCase()===pointer.runId.toLowerCase(),'Run pointer must name its direct optimizer run directory');
assert(lstatSync(run,{throwIfNoEntry:false})?.isDirectory(),'Run pointer directory is missing');
// A sealed historical pointer may supply fixtures; only the actual output route is writable.
guardAncestors(run,false);
const inheritedEvidence=process.env.DSH_VERIFICATION_EVIDENCE_DIR?resolve(ROOT,process.env.DSH_VERIFICATION_EVIDENCE_DIR):null;
if(inheritedEvidence){assert(within(OPTIMIZATION_RUNS,inheritedEvidence),'Inherited evidence must stay inside project optimizer runs');guardAncestors(inheritedEvidence,true);}
const defaultEvidence=inheritedEvidence||VERIFY_ROOT;
const out=resolve(ROOT,arg('out')||join(defaultEvidence,'docx-preview-renderer-'+Date.now()+'-'+randomUUID().slice(0,8),'report.json'));
const outputRoots=[run,VERIFY_ROOT,...(inheritedEvidence?[inheritedEvidence]:[])];
function guardOutput(){
  assert(outputRoots.some(root=>within(root,out)),'Evidence output is outside current run, data/verify, or inherited evidence');
  guardAncestors(dirname(out),true);
  assert(!lstatSync(out,{throwIfNoEntry:false}),'Evidence exists; use a fresh output');
}
guardOutput();
const installedPath=join(ROOT,'node_modules/docx-preview/dist/docx-preview.js');
const sourcePath=arg('source')==='original'?installedPath:join(ROOT,'public/vendor/docx-preview-0.4.0.js');
const originalBytes=readFileSync(installedPath),sourceBytes=readFileSync(sourcePath);
const original=originalBytes.toString('utf8').replace(/\r\n/g,'\n'),source=sourceBytes.toString('utf8').replace(/\r\n/g,'\n');
const packageInfo=JSON.parse(readFileSync(join(ROOT,'node_modules/docx-preview/package.json'),'utf8'));
const oldLine='children = [this.h({ tagName: elem.verticalAlign, children: this.renderElements(elem.children) })];';
const newLine='children = [this.h({ tagName: elem.verticalAlign, children })]; // DSH modified: render each run child once.';
function method(s,name){
  const token='        '+name+'(';
  const start=s.indexOf(token,name==='constructor'?s.indexOf('    class HtmlRenderer {'):0),end=s.indexOf('\n        }',start);
  assert(start>=0&&end>start,'Actual complete method boundary required: '+name);
  if(name!=='constructor')assert.equal(s.indexOf(token,start+token.length),-1,'Method extraction must be unique: '+name);
  return s.slice(start,end+10);
}
function helper(s,name){
  const token='    function '+name+'(';
  const start=s.indexOf(token),end=s.indexOf('\n    }',start);
  assert(start>=0&&end>start,'Actual helper boundary required: '+name);
  return s.slice(start,end+6);
}
const methodNames=['constructor','renderElement','renderElements','renderContainer','renderNotes','renderFootnoteReference','renderEndnoteReference','renderRun','renderText','renderTab','tabStopClass','toH','toHTML','processStyleName','createPageElement','createSectionContent','renderSections'];
const helpers=['h','cx','isString','escapeClassName','findParent'];
const extract=s=>({methods:Object.fromEntries(methodNames.map(n=>[n,method(s,n)])),helpers:Object.fromEntries(helpers.map(n=>[n,helper(s,n)]))});
const extracted=extract(source),originalExtracted=extract(original);
class FakeNode {
  constructor(tag,text=''){this.tagName=tag;this.nodeType=tag==='#text'?3:1;this._text=String(text);this.childNodes=[];this.style={};this.attributes={};}
  appendChild(node){assert(node instanceof FakeNode);if(node.parentNode){const a=node.parentNode.childNodes;a.splice(a.indexOf(node),1);}node.parentNode=this;this.childNodes.push(node);return node;}
  setAttribute(key,value){this.attributes[key]=String(value);}
  get textContent(){return this.nodeType===3?this._text:this.childNodes.map(n=>n.textContent).join('');}
}
const document={createTextNode:t=>new FakeNode('#text',t),createElement:t=>new FakeNode(t),createElementNS:(ns,t)=>Object.assign(new FakeNode(t),{namespaceURI:ns}),createDocumentFragment:()=>new FakeNode('#fragment'),createComment:t=>new FakeNode('#comment',t)};
function renderer(e){
  const code=Object.values(e.helpers).join('\n')+'\nclass ActualRenderer {\n'+Object.values(e.methods).join('\n')+'\n}\nglobalThis.ActualRenderer=ActualRenderer;';
  const sandbox={Node:FakeNode,document,DomType:{Run:'run',Text:'text',Tab:'tab',Paragraph:'paragraph',FootnoteReference:'footnoteReference',EndnoteReference:'endnoteReference',Footnote:'footnote',Endnote:'endnote'},ns:{html:'http://www.w3.org/1999/xhtml'}};
  runInNewContext(code,sandbox,{filename:sourcePath,timeout:2000});
  const r=new sandbox.ActualRenderer();r.currentFootnoteIds=[];r.options={};return r;
}
const create=()=>renderer(extracted),oldCreate=()=>renderer(originalExtracted);
const text=t=>({type:'text',text:t});
const ref=(kind,id)=>({type:kind+'Reference',id:String(id)});
const runNode=(children,verticalAlign,extra={})=>({type:'run',children,...(verticalAlign?{verticalAlign}:{}),...extra});
const plainObject=x=>JSON.parse(JSON.stringify(x));
const tree=(node,normalizeRefs=false)=>node.nodeType===3?{text:normalizeRefs&&/^\d+$/.test(node._text)&&node.parentNode?.tagName==='sup'?'REFERENCE_NUMBER':node._text}:{tag:node.tagName,ns:node.namespaceURI||null,attributes:node.attributes,style:node.style,id:node.id||null,lang:node.lang||null,children:node.childNodes.map(n=>tree(n,normalizeRefs))};
const leaves=(node,tag)=>{const result=[];const walk=n=>{if(n.tagName===tag&&n.childNodes.every(c=>c.nodeType===3))result.push(n);n.childNodes.forEach(walk);};walk(node);return result;};
const ids=(r,kind)=>plainObject(kind==='endnote'?r.currentEndnoteIds:r.currentFootnoteIds);
const notes=(kind,id)=>({type:kind,id:String(id),children:[runNode([text('SOFTWARE-ONLY note '+id)])]});
const evidence=[],checks=[];
async function check(name,fn){try{await fn();checks.push({name,ok:true});console.log('PASS '+name);}catch(error){checks.push({name,ok:false,error:{message:error.message,stack:error.stack}});console.log('FAIL '+name+': '+error.message);}}
await check('锁定实际0.4.0安装包、原始SHA和Apache许可',()=>{assert.equal(packageInfo.version,'0.4.0');assert.equal(packageInfo.license,'Apache-2.0');assert.equal(sha(originalBytes),BASE_SHA);assert.match(original,/Released under Apache License 2\.0/);if(arg('source')!=='original'){assert(readFileSync(join(ROOT,'public/vendor/upstream/docx-preview-0.4.0.js')).equals(originalBytes));assert(readFileSync(join(ROOT,'public/vendor/docx-preview-0.4.0.LICENSE.txt')).equals(readFileSync(join(ROOT,'node_modules/docx-preview/LICENSE'))));const p=JSON.parse(readFileSync(join(ROOT,'public/vendor/provenance.json'),'utf8'));assert.equal(p.upstream.bundleSha256,BASE_SHA);assert.equal(p.output.bundleSha256,sha(sourceBytes));assert.equal(p.output.sourceMapSha256,sha(readFileSync(join(ROOT,'public/vendor/docx-preview.js.map'))));}});
await check('候选仅含批准的single-pass、3处物理身份与5处字符补丁且逐处唯一匹配',()=>{
  assert.equal(original.split(oldLine).length-1,1);
  const p=JSON.parse(readFileSync(join(ROOT,'public/vendor/provenance.json'),'utf8'));
  assert.equal(p.generatorVersion,3);assert.equal(p.patch.method,'HtmlRenderer.renderRun');assert.equal(p.patch.uniqueMatches,1);
  assert.equal(p.patch.oldLine.trim(),oldLine);assert.equal(p.patch.newLine.trim(),newLine);
  assert.deepEqual(p.identityPatches.map(h=>h.method),[
    'DocumentParser.dshSourceXmlIdentity','DocumentParser.parseParagraph','DocumentParser.parseTable',
  ]);
  assert.deepEqual(p.characterPatches.map(h=>h.method),[
    'DocumentParser.parseRun.Tab','DocumentParser.parseRun.NoBreakHyphen','HtmlRenderer.renderTab',
    'HtmlRenderer.renderTab.experimental','HtmlRenderer.renderElement.NoBreakHyphen',
  ]);
  const hunks=[{old:p.patch.oldLine,next:p.patch.newLine,uniqueMatches:p.patch.uniqueMatches},...p.identityPatches,...p.characterPatches];
  assert.equal(hunks.length,9);let expected=originalBytes.toString('utf8');
  for(const h of hunks){assert.equal(h.uniqueMatches,1);assert.equal(expected.split(h.old).length-1,1);expected=expected.replace(h.old,h.next);}
  assert(sourceBytes.equals(Buffer.from(expected)),'Candidate must equal pinned upstream with exactly the approved nine unique patch hunks');
  assert.equal(method(source,'renderRun').split('this.renderElements(elem.children)').length-1,1);
  const index=readFileSync(join(ROOT,'public/index.html'),'utf8'),matches=[...index.matchAll(/<script\b[^>]*\bsrc="([^"]*docx-preview[^"]*)"/g)];
  assert.deepEqual(matches.map(m=>m[1]),['/vendor/docx-preview-0.4.0.js']);
});
await check('managed generator只读重建校验bundle/map/provenance/license全部一致',()=>{const r=JSON.parse(execFileSync(process.execPath,[join(ROOT,'tools/generate-docx-preview-vendor.mjs'),'--check'],{encoding:'utf8',cwd:ROOT}));assert.equal(r.ok,true);assert.equal(r.mode,'check');assert.equal(r.patches,9);assert.equal(r.vendorSha256,sha(readFileSync(join(ROOT,'public/vendor/docx-preview-0.4.0.js'))));});
for(const kind of ['footnote','endnote']){
  await check(kind+'普通引用只计一次',()=>{const r=create(),node=r.renderRun(runNode([ref(kind,3)]));assert.deepEqual(ids(r,kind),['3']);assert.deepEqual(leaves(node,'sup').map(n=>n.textContent),['1']);});
  for(const align of ['sup','sub'])await check(kind+' '+align+'引用只计一次且保留上下标结构',()=>{const r=create(),old=oldCreate(),ast=runNode([ref(kind,7)],align),node=r.renderRun(ast),oldNode=old.renderRun(ast);evidence.push({case:kind+'-'+align,actual:ids(r,kind),original:ids(old,kind),visible:node.textContent,originalVisible:oldNode.textContent});assert.deepEqual(ids(r,kind),['7']);assert.deepEqual(leaves(node,'sup').map(n=>n.textContent),['1']);assert.equal(node.childNodes[0].tagName,align);assert.deepEqual(tree(node,true),tree(oldNode,true));});
  await check(kind+'混合文字和引用保留字号、语言、类、id与位置',()=>{const r=create(),old=oldCreate(),ast=runNode([text('SOFTWARE prefix '),ref(kind,11),text(' suffix')],kind==='endnote'?'sup':'sub',{id:'software-run',className:'software-run-class',styleName:'Software Note',cssStyle:{fontSize:'14pt',fontFamily:'Software Serif',color:'#123456',$lang:'zh-CN'}}),node=r.renderRun(ast),oldNode=old.renderRun(ast);assert.deepEqual(ids(r,kind),['11']);assert.equal(node.textContent,'SOFTWARE prefix 1 suffix');assert.deepEqual(tree(node,true),tree(oldNode,true));assert.equal(node.style.fontSize,'14pt');assert.equal(node.style.fontFamily,'Software Serif');assert.equal(node.lang,'zh-CN');assert.equal(node.id,'software-run');assert.match(node.attributes.class,/software-run-class/);assert.equal(node.childNodes[0].childNodes[0].textContent,'SOFTWARE prefix ');});
}
for(const align of ['sup','sub'])await check('普通'+align+'文字和字号DOM与原方法完全一致',()=>{const ast=runNode([text('SOFTWARE exponent')],align,{cssStyle:{fontSize:'9pt',fontFamily:'Software Serif'},className:'software-ordinary'}),r=create(),old=oldCreate();assert.deepEqual(tree(r.renderRun(ast)),tree(old.renderRun(ast)));assert.deepEqual(ids(r,'footnote'),[]);assert.deepEqual(ids(r,'endnote'),[]);});
await check('嵌套上标和一run多类引用仍每个源引用计一次',()=>{const r=create(),ast=runNode([ref('endnote',1),runNode([text('SOFTWARE mixed '),ref('footnote',2)],'sub'),ref('endnote',3)],'sup'),node=r.renderRun(ast);assert.deepEqual(ids(r,'endnote'),['1','3']);assert.deepEqual(ids(r,'footnote'),['2']);assert.deepEqual(leaves(node,'sup').map(n=>n.textContent),['1','1','2']);});
await check('同一note合法多引用按两次源引用登记而非去重',()=>{const r=create();r.endnoteMap={'8':notes('endnote',8)};const nodes=r.renderElements([runNode([ref('endnote',8)],'sup'),runNode([ref('endnote',8)],'sup')]);assert.deepEqual(ids(r,'endnote'),['8','8']);assert.deepEqual(nodes.map(n=>n.textContent),['1','2']);const list=r.renderNotes(r.currentEndnoteIds,r.endnoteMap);assert.equal(list.childNodes.length,2);assert(list.childNodes.every(n=>n.tagName==='li'));});
await check('完整renderSections保留逐页脚注重置和跨页尾注计数',()=>{const r=create();r.options={renderFootnotes:true,renderEndnotes:true};r.footnoteMap={'5':notes('footnote',5)};r.endnoteMap={'8':notes('endnote',8),'9':notes('endnote',9)};const sections=[8,9].map(id=>({sectProps:{},elements:[runNode([ref('footnote',5)],'sup'),runNode([ref('endnote',id)],'sup')]}));r.processElement=()=>{};r.splitBySection=()=>sections;r.groupByPageBreaks=s=>s.map(x=>[x]);const pages=r.renderSections({children:[],props:{},cssStyle:{fontSize:'12pt'}});assert.equal(pages.length,2);assert.deepEqual(plainObject(pages.map(p=>p.childNodes[0].childNodes.map(n=>n.textContent))),[['1','1'],['1','2']]);assert.deepEqual(ids(r,'endnote'),['8','9']);assert.deepEqual(ids(r,'footnote'),['5']);assert.equal(pages[0].childNodes[1].childNodes.length,1);assert.equal(pages[1].childNodes[1].childNodes.length,1);assert.equal(pages[1].childNodes[2].childNodes.length,2);});
await check('真实constructor的新文档尾注计数从一开始',()=>{const first=create();first.renderRun(runNode([ref('endnote',30)],'sup'));const second=create();const node=second.renderRun(runNode([ref('endnote',31)],'sup'));assert.deepEqual(ids(first,'endnote'),['30']);assert.deepEqual(ids(second,'endnote'),['31']);assert.equal(node.textContent,'1');});
await check('fieldRun原有跳过行为无引用副作用',()=>{const r=create();assert.equal(r.renderRun(runNode([ref('endnote',99)],'sup',{fieldRun:true})),null);assert.deepEqual(ids(r,'endnote'),[]);});
await check('同一混合run的文字、脚注、尾注顺序及两个计数独立',()=>{const r=create(),ast=runNode([text('SOFTWARE A '),ref('footnote',1),text(' B '),ref('endnote',2),text(' C '),ref('footnote',3),text(' D')],'sup');const node=r.renderRun(ast);assert.equal(node.textContent,'SOFTWARE A 1 B 1 C 2 D');assert.deepEqual(ids(r,'footnote'),['1','3']);assert.deepEqual(ids(r,'endnote'),['2']);});
await check('实验tab的真实currentTabs副作用同样只执行一次',()=>{const r=create();r.options={experimental:true};const p={type:'paragraph',tabs:[{pos:720}]},tab={type:'tab',parent:p};const node=r.renderRun(runNode([text('SOFTWARE'),tab],'sup'));assert.equal(r.currentTabs.length,1);assert.equal(r.currentTabs[0].span,node.childNodes[0].childNodes[1]);assert.equal(r.currentTabs[0].span.textContent,'\u2003');});
await check('空子节点上下标结构保持原行为',()=>{const ast=runNode([],'sup');assert.deepEqual(tree(create().renderRun(ast)),tree(oldCreate().renderRun(ast)));});
const samplePath=resolve(ROOT,'../发给皓天的一审文件/13-2026年秋/2026秋季刊责编版/01-特稿-张维为/01-特稿-张维为-文明型国家&自主知识体系【0803尾注版】.docx');
const sampleBytes=readFileSync(samplePath),sampleSha256=sha(sampleBytes);
assert.equal(sampleSha256,'6e8d3adacb708371478273affa53eca4b277ee0d6ea6409cef9526a97035dbcd');
const xml=parseXml(openZip(sampleBytes).readText('word/document.xml'));
const refs=xml.descendants('w:endnoteReference').map(n=>{const r=n.parent;assert.equal(r.name,'w:r');const align=r.el('w:rPr')?.el('w:vertAlign')?.attrs['w:val'];return {id:n.attrs['w:id'],verticalAlign:align==='superscript'?'sup':align==='subscript'?'sub':null};});
await check('真实43XML引用重建结构后计数和列表均43且编号连续',()=>{assert.equal(refs.length,43);assert.equal(new Set(refs.map(r=>r.id)).size,43);assert.deepEqual(refs.filter(r=>r.verticalAlign).map(r=>r.id),['9','10','14','42']);const r=create(),old=oldCreate(),asts=refs.map(n=>runNode([ref('endnote',n.id)],n.verticalAlign)),nodes=r.renderElements(asts),oldNodes=old.renderElements(asts);r.endnoteMap=Object.fromEntries(refs.map(n=>[n.id,notes('endnote',n.id)]));const list=r.renderNotes(r.currentEndnoteIds,r.endnoteMap);evidence.push({case:'real-source-43',sourceXmlReferences:43,explicitVerticalAlignIds:refs.filter(n=>n.verticalAlign).map(n=>n.id),actualRecordedReferences:ids(r,'endnote').length,originalRecordedReferences:ids(old,'endnote').length,actualVisibleNumbers:nodes.map(n=>n.textContent),originalVisibleNumbers:oldNodes.map(n=>n.textContent),actualNoteListItems:list.childNodes.length,rawSupElements:nodes.reduce((sum,n)=>{let k=0;const walk=x=>{if(x.tagName==='sup')k++;x.childNodes.forEach(walk);};walk(n);return sum+k;},0),scope:'Real XML supplies IDs and verticalAlign only; generated note text and explicit DOM substitute; no manuscript content judgment'});assert.deepEqual(ids(r,'endnote'),refs.map(n=>n.id));assert.deepEqual(nodes.map(n=>n.textContent),Array.from({length:43},(_,i)=>String(i+1)));assert.equal(list.childNodes.length,43);assert(nodes.every(n=>leaves(n,'sup').length===1));});
await check('上游安装组件及真实原稿字节未改',()=>{assert.equal(sha(readFileSync(installedPath)),BASE_SHA);assert.equal(sha(readFileSync(samplePath)),sampleSha256);assert.equal(sha(readFileSync(sourcePath)),sha(sourceBytes));});
const passed=checks.filter(c=>c.ok).length;
const report={schemaVersion:1,runId:pointer.runId,phase:arg('source')==='original'?'red-original':'green-vendor',sourcePath,sourceSha256:sha(sourceBytes),installedPath,installedSha256:BASE_SHA,version:packageInfo.version,license:packageInfo.license,softwareOnly:true,realBrowserVerified:false,wordApplicationVerified:false,manuscriptContentJudgment:false,semanticQualityClaimed:false,modelCalls:0,apiRequests:0,serversStarted:0,scope:'Complete actual renderer methods and h/cx helpers execute in VM; explicit DOM, XML-processing/page-grouping substitutes; no CSS layout claim',sample:{path:samplePath,sha256:sampleSha256,xmlReferences:refs.length,explicitVerticalAlignIds:refs.filter(n=>n.verticalAlign).map(n=>n.id)},passed,failed:checks.length-passed,total:checks.length,ok:passed===checks.length,checks,evidence,methodSourceHashes:Object.fromEntries(Object.entries(extracted.methods).map(([n,s])=>[n,sha(s)]))};
mkdirSync(dirname(out),{recursive:true});guardOutput();
writeFileSync(join(dirname(out),'actual-renderer-methods.json'),JSON.stringify({sourcePath,sourceSha256:sha(sourceBytes),...extracted},null,2)+'\n',{flag:'wx'});
writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({out,passed,failed:report.failed,total:report.total,ok:report.ok}));if(!report.ok)process.exitCode=1;
