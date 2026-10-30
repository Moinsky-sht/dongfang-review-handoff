/** Lossless primary source windows and confirmed-range accounting for parsed after-text. */
import {createHash} from 'node:crypto';
import {isVerifiedReviewSourceUnit} from './review-plan-store.js';
const ARRAYS={paragraph:'paragraphs',footnote:'footnotes',endnote:'endnotes'};
const FILES={paragraph:'document.xml',footnote:'footnotes.xml',endnote:'endnotes.xml'};
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,code='REVIEW_SOURCE_PLAN_INVALID')=>Object.assign(new Error(message),{code});
const hex=value=>/^[a-f0-9]{64}$/.test(value||'');
export const primarySourceKey=entry=>`${entry.target}:${entry.index}`;
export function sourceUtf16Boundary(text,offset){return Number.isSafeInteger(offset)&&offset>=0&&offset<=text.length&&!(offset>0&&offset<text.length&&text.charCodeAt(offset-1)>=0xd800&&text.charCodeAt(offset-1)<=0xdbff&&text.charCodeAt(offset)>=0xdc00&&text.charCodeAt(offset)<=0xdfff);}
const rangeOf=e=>({target:e.target,index:e.index,part:e.part,noteId:e.noteId,pid:e.pid,sourceXmlNodeId:e.sourceXmlNodeId,
 sourceXmlParagraphOrdinal:e.sourceXmlParagraphOrdinal,sourceXmlTableNodeId:e.sourceXmlTableNodeId,tableIdx:e.tableIdx,tableIndex:e.tableIndex,inTable:e.inTable,
 sourcePackageSha256:e.sourcePackageSha256,sourceVersionId:e.sourceVersionId,rawStart:e.rawStart,rawEnd:e.rawEnd,offsetUnit:'utf16',textView:'after',paragraphIndexOwner:'application-paragraph-index'});

export function buildReviewSourcePlan(doc,{windowChars=1500,maxParasPerWindow=10}={}){
 if(!Number.isSafeInteger(windowChars)||windowChars<1||!Number.isSafeInteger(maxParasPerWindow)||maxParasPerWindow<1)throw fail('主来源窗口大小必须为正整数');
 const nodes=[],excluded=[],windows=[],unreviewedContent=[];let entries=[],size=0;
 const flush=()=>{if(!entries.length)return;const ordinal=windows.length+1;windows.push({id:`primary:${ordinal}`,ordinal,entries,primaryRanges:entries.map(rangeOf)});entries=[];size=0;};
 for(const[target,arrayName]of Object.entries(ARRAYS)){
  const list=doc?.[arrayName]||[];if(!Array.isArray(list))throw fail('主来源节点数组无效');flush();
  for(let index=0;index<list.length;index++){
   const p=list[index];if(!p||typeof p.text!=='string')throw fail(`主来源 ${target}:${index} 缺少原始文本`);
   const identity={target,index,part:p.part||FILES[target],noteId:p.noteId==null?null:String(p.noteId),pid:p.id||null,
    sourceXmlNodeId:p.sourceXmlNodeId||null,sourceXmlParagraphOrdinal:p.sourceXmlParagraphOrdinal??null,
    sourceXmlTableNodeId:p.sourceXmlTableNodeId||null,tableIdx:p.tableIdx??null,tableIndex:p.tableIdx??null,inTable:p.inTable===true,
    sourcePackageSha256:p.sourcePackageSha256||doc?.sourcePackageSha256||null,sourceVersionId:p.sourceVersionId||doc?.sourceVersionId||null,
    textView:'after',offsetUnit:'utf16',paragraphIndexOwner:'application-paragraph-index'};
   if(target!=='paragraph'&&(p.isNoteSeparator===true||/separator/i.test(p.noteType||''))){excluded.push({...identity,rawStart:0,rawEnd:p.text.length,length:p.text.length,textSha256:sha(p.text),reason:'note-separator',noteType:p.noteType||null});continue;}
   for(const[objectIndex,text]of(p.textboxes||[]).entries())unreviewedContent.push({...identity,objectKind:'textbox',objectIndex,objectPath:`${target}:${index}/textboxes/${objectIndex}`,textUtf16:typeof text==='string'?text.length:null,textSha256:typeof text==='string'?sha(text):sha(canonical(text)),reason:'textbox_text_not_primary',status:'pending',offsetSpace:'parsed-textbox-object'});
   for(const[objectIndex,figure]of(p.figures||[]).entries())unreviewedContent.push({...identity,objectKind:figure.kind||'figure',objectIndex,objectPath:`${target}:${index}/figures/${objectIndex}`,objectSha256:sha(canonical(figure)),rIds:figure.rIds||[],equations:figure.equations||0,reason:'unparsed_visual_content',status:'pending',offsetSpace:'parsed-figure-object'});
   const node={...identity,length:p.text.length,textSha256:sha(p.text),empty:p.text.length===0};nodes.push(node);
   let start=0;
   do{
    let end=Math.min(p.text.length,start+windowChars);if(!sourceUtf16Boundary(p.text,end))end--;if(end===start&&start<p.text.length)end=Math.min(p.text.length,start+2);
    const text=p.text.slice(start,end),entry={...identity,rawStart:start,rawEnd:end,text};
    if(entries.length&&(size+text.length>windowChars||entries.length>=maxParasPerWindow))flush();
    entries.push(entry);size+=text.length;start=end;
    if(size>=windowChars||entries.length>=maxParasPerWindow||start<p.text.length)flush();
   }while(start<p.text.length);
  }
  flush();
 }
 const expectedUtf16=nodes.reduce((n,p)=>n+p.length,0),counts={expectedNodes:nodes.length,expectedUtf16,windows:windows.length,primaryRanges:windows.reduce((n,w)=>n+w.entries.length,0),excludedNodes:excluded.length,emptyNodes:nodes.filter(n=>n.empty).length,tableNodes:nodes.filter(n=>n.inTable).length};
 const policy={windowChars,maxParasPerWindow,offsetUnit:'utf16',unicodePairMayExceedBudgetByOne:true,overlapUtf16:0,trim:false,dropWhitespace:false,tableIndexBasis:'parsed-tableIdx-first-paragraph-owner'};
 const manifest={schemaVersion:1,scope:'parsed-after-text-body-table-footnote-endnote',sourcePackageSha256:doc?.sourcePackageSha256||null,sourceVersionId:doc?.sourceVersionId||null,policy,nodes,excluded,unreviewedContent,windows,counts};
 const manifestSha256=sha(canonical(manifest));
 // Verify independently of the grouping loop before returning a reusable plan.
 const piecesByNode=new Map();for(const entry of windows.flatMap(w=>w.entries)){const key=primarySourceKey(entry);if(!piecesByNode.has(key))piecesByNode.set(key,[]);piecesByNode.get(key).push(entry);}
 for(const node of nodes){const pieces=piecesByNode.get(primarySourceKey(node))||[];let at=0;
  for(const e of pieces){if(e.rawStart!==at||e.rawEnd<e.rawStart||!sourceUtf16Boundary(listText(doc,node),e.rawStart)||!sourceUtf16Boundary(listText(doc,node),e.rawEnd)||listText(doc,node).slice(e.rawStart,e.rawEnd)!==e.text)throw fail('主来源范围不能连续回读');at=e.rawEnd;}
  if(!pieces.length||at!==node.length||pieces.map(e=>e.text).join('')!==listText(doc,node))throw fail('主来源文字遗漏或重叠');
 }
 return{...manifest,manifestSha256,proof:{basis:'parsed-source-readback',continuous:true,nonOverlapping:true,sourceReadback:true,primaryCoverageOnly:true,quality:'unverified'}};
}
function listText(doc,node){return doc[ARRAYS[node.target]][node.index].text;}
function merge(ranges){const out=[];for(const r of [...ranges].sort((a,b)=>a[0]-b[0]||a[1]-b[1])){const last=out.at(-1);if(last&&r[0]<=last[1])last[1]=Math.max(last[1],r[1]);else out.push([...r]);}return out;}
function contains(ranges,start,end){return ranges.some(([s,e])=>s<=start&&e>=end);}
function eligible(unit){return isVerifiedReviewSourceUnit(unit)&&unit.status==='completed'&&unit.outputReceipt?.status==='completed'&&hex(unit.outputReceipt.inputSha256)&&hex(unit.outputReceipt.outputSha256);}

/** Only parsed, durably completed source units count; sampled/reference text never does. */
export function buildReviewSourceCoverage(plan,{units=[],ruleMode='all',ruleIds=[]}={}){
 if(!plan||plan.schemaVersion!==1||!hex(plan.manifestSha256)||!Array.isArray(plan.windows)||!Array.isArray(plan.nodes))throw fail('主来源覆盖缺少可信计划');
 const{manifestSha256,proof,...manifest}=plan;if(sha(canonical(manifest))!==manifestSha256||plan.counts.expectedUtf16!==plan.nodes.reduce((n,node)=>n+node.length,0))throw fail('主来源覆盖计划指纹或分母已变化');
 const rules=ruleMode==='per-rule'&&ruleIds.length?[...new Set(ruleIds)]:[null],nodeMap=new Map(plan.nodes.map(n=>[primarySourceKey(n),n])),coverage=new Map();
 for(const unit of units){if(!eligible(unit))continue;const ranges=unit.source?.primaryRanges||[],ruleId=unit.source?.ruleId??null;if(!rules.includes(ruleId))continue;
  for(const r of ranges){const node=nodeMap.get(primarySourceKey(r));if(!node||['part','pid','sourceXmlNodeId','sourceXmlParagraphOrdinal','sourceXmlTableNodeId','tableIdx','sourcePackageSha256','sourceVersionId'].some(k=>r[k]!==node[k])||String(r.noteId)!==String(node.noteId)
    ||!Number.isSafeInteger(r.rawStart)||!Number.isSafeInteger(r.rawEnd)||r.rawStart<0||r.rawEnd<r.rawStart||r.rawEnd>node.length)throw fail('完成凭证的主来源范围与计划不一致');
   const key=JSON.stringify([primarySourceKey(r),ruleId]);if(!coverage.has(key))coverage.set(key,[]);coverage.get(key).push([r.rawStart,r.rawEnd]);
  }
 }
 for(const[key,ranges]of coverage)coverage.set(key,merge(ranges));
 const newCount=()=>({expectedNodes:0,expectedUtf16:0,coveredUtf16:0,pendingUtf16:0,tableNodes:0});
 const coveredRanges=[],sourceCoverageGaps=[],byTarget=Object.fromEntries(Object.keys(ARRAYS).map(target=>[target,newCount()])),byPart={};
 let coveredUtf16=0,completedNodes=0;
 for(const node of plan.nodes){const perRule=rules.map(rule=>coverage.get(JSON.stringify([primarySourceKey(node),rule]))||[]),cuts=[...new Set([0,node.length,...perRule.flat(2)])].sort((a,b)=>a-b);let covered=0,all=node.length>0;
  for(let i=0;i<cuts.length-1;i++){const start=cuts[i],end=cuts[i+1];if(end===start)continue;const good=perRule.every(rs=>contains(rs,start,end));const row={...rangeOf({...node,rawStart:start,rawEnd:end}),reason:good?'confirmed-primary-range':'primary-not-completed'};
   if(good){coveredRanges.push(row);covered+=end-start;}else{all=false;sourceCoverageGaps.push({...row,missingRuleIds:rules.filter((_,n)=>!contains(perRule[n],start,end))});}
  }
  if(node.length===0){all=perRule.every(rs=>contains(rs,0,0));const row=rangeOf({...node,rawStart:0,rawEnd:0});if(all)coveredRanges.push({...row,reason:'confirmed-empty-primary-node'});else sourceCoverageGaps.push({...row,reason:'empty-primary-node-not-completed',missingRuleIds:rules.filter((_,n)=>!contains(perRule[n],0,0))});}
  if(all)completedNodes++;coveredUtf16+=covered;byPart[node.part]??=newCount();
  for(const c of [byTarget[node.target],byPart[node.part]]){c.expectedNodes++;c.expectedUtf16+=node.length;c.coveredUtf16+=covered;c.pendingUtf16+=node.length-covered;if(node.inTable)c.tableNodes++;}
 }
 const requiredTasks=plan.windows.flatMap(window=>rules.map(ruleId=>({window:window.ordinal,unitId:ruleId===null?`window:${window.ordinal}`:`window:${window.ordinal}/rule:${ruleId}`,ruleId,
  completed:window.primaryRanges.every(r=>contains(coverage.get(JSON.stringify([primarySourceKey(r),ruleId]))||[],r.rawStart,r.rawEnd)),primaryRanges:window.primaryRanges})));
 const completedTasks=requiredTasks.filter(t=>t.completed).length,complete=completedTasks===requiredTasks.length&&completedNodes===plan.nodes.length;
 return{schemaVersion:1,status:complete?'complete':'partial',manifestSha256:plan.manifestSha256,basis:'confirmed-primary-source-ranges',scope:plan.scope,
  totals:{expectedNodes:plan.nodes.length,completedNodes,expectedUtf16:plan.counts.expectedUtf16,coveredUtf16,pendingUtf16:plan.counts.expectedUtf16-coveredUtf16,expectedTasks:requiredTasks.length,completedTasks},
  byTarget,byPart,coveredRanges,sourceCoverageGaps,requiredTasks,excluded:plan.excluded,unreviewedContent:plan.unreviewedContent,quality:'unverified'};
}
