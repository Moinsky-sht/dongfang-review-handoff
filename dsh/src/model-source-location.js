/** Pure source proof for model output. A declaration is never repaired by guessing another node. */
import { createHash } from 'node:crypto';
const PARTS={paragraph:'paragraph',body:'paragraph','document.xml':'paragraph','word/document.xml':'paragraph',footnote:'footnote',footnotes:'footnote','footnotes.xml':'footnote','word/footnotes.xml':'footnote',endnote:'endnote',endnotes:'endnote','endnotes.xml':'endnote','word/endnotes.xml':'endnote',document:'document'};
const ARRAY={paragraph:'paragraphs',footnote:'footnotes',endnote:'endnotes'};
const FILE={paragraph:'word/document.xml',footnote:'word/footnotes.xml',endnote:'word/endnotes.xml'};
const INDEX={paragraph:'paragraphIndex',footnote:'footnoteIndex',endnote:'endnoteIndex'};
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o||{},k);
const canonical=v=>typeof v==='string'?PARTS[v.toLowerCase()]:null;
const shaOf=doc=>doc?.sourcePackageSha256||doc?.paragraphs?.[0]?.sourcePackageSha256||doc?.footnotes?.[0]?.sourcePackageSha256||doc?.endnotes?.[0]?.sourcePackageSha256||null;
const nodeAt=(doc,target,index)=>doc?.[ARRAY[target]]?.[index];
const bound=(text,offset)=>Number.isSafeInteger(offset)&&offset>=0&&offset<=text.length&&!(offset>0&&offset<text.length&&text.charCodeAt(offset)>=0xdc00&&text.charCodeAt(offset)<=0xdfff&&text.charCodeAt(offset-1)>=0xd800&&text.charCodeAt(offset-1)<=0xdbff);
function validUnicode(text){for(let i=0;i<text.length;i++){const n=text.charCodeAt(i);if(n>=0xd800&&n<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(n>=0xdc00&&n<=0xdfff)return false;}return true;}
function identity(doc,target,index){const n=nodeAt(doc,target,index)||{};return{target,index,part:FILE[target],pid:n.id,noteId:n.noteId,sourceXmlNodeId:n.sourceXmlNodeId,sourceXmlParagraphOrdinal:n.sourceXmlParagraphOrdinal,sourceXmlTableNodeId:n.sourceXmlTableNodeId,sourcePackageSha256:n.sourcePackageSha256||shaOf(doc),textView:'after',offsetUnit:'utf16',paragraphIndexOwner:'application-paragraph-index'};}
function trimBounds(text){const start=text.length-text.trimStart().length;return{start,end:text.trimEnd().length};}
function rawHits(text,quote){const out=[];for(let from=0;;){const start=text.indexOf(quote,from);if(start<0)break;const end=start+quote.length;if(bound(text,start)&&bound(text,end))out.push({start,end,matchMode:'literal',precision:'exact'});from=start+1;}return out;}
function whiteProjection(text){let normalized='',raw=[];for(let i=0;i<text.length;){const ch=String.fromCodePoint(text.codePointAt(i));if(!/\s/u.test(ch)){normalized+=ch;for(let j=0;j<ch.length;j++)raw.push(i+j);}i+=ch.length;}return{normalized,raw};}
function candidatesFor(doc,entries,quote){const exact=[];for(const e of entries){const p=nodeAt(doc,e.target,e.index);if(!p||typeof p.text!=='string'||p.isNoteSeparator)continue;for(const h of rawHits(p.text,quote)){if(h.start<e.rawStart||h.end>e.rawEnd)continue;exact.push({...identity(doc,e.target,e.index),...h,text:p.text.slice(h.start,h.end),quote});}}const nq=whiteProjection(quote).normalized;if(!nq)return exact;const out=[...exact];for(const e of entries){const p=nodeAt(doc,e.target,e.index);if(!p||typeof p.text!=='string'||p.isNoteSeparator)continue;const projected=whiteProjection(p.text);for(const hit of rawHits(projected.normalized,nq)){const start=projected.raw[hit.start],end=projected.raw[hit.end-1]+1;if(!bound(p.text,start)||!bound(p.text,end)||start<e.rawStart||end>e.rawEnd)continue;out.push({...identity(doc,e.target,e.index),start,end,text:p.text.slice(start,end),quote,matchMode:'whitespace-normalized',precision:'quote'});}}return out;}
function uniqueCandidates(list){const seen=new Set();return list.filter(c=>{const key=`${c.target}:${c.index}:${c.start}:${c.end}`;if(seen.has(key))return false;seen.add(key);return true;});}

export function modelSourceDeclaration(issue={}){const fields=['part','target','index','location','paragraphIndex','footnoteIndex','endnoteIndex','footnoteNumber','endnoteNumber','noteId','pid','offset','start','end','window','scope','sourceXmlNodeId','sourceXmlParagraphOrdinal','sourceXmlTableNodeId','sourcePackageSha256','sourceReviewedPackageSha256','workSha256','sourceVersionId','workVersionId','versionId','textView','offsetUnit','paragraphIndexOwner','quote','anchor'];const out={};for(const k of fields)if(own(issue,k))out[k]=issue[k];return out;}

/** Array index, immutable note ID and reader numbering are separate coordinates. */
export function modelNoteNumber(doc,target,index){const list=doc?.[ARRAY[target]]||[],note=nodeAt(doc,target,index);if(!note||note.isNoteSeparator)return null;const id=note.noteId;const refs=target==='footnote'?doc.footnoteRefs:doc.endnoteRefs;if(id!=null&&Array.isArray(refs)){const distinct=[...new Set(refs.map(String))],pos=distinct.indexOf(String(id));if(pos>=0)return pos+1;}const seen=new Set();for(let i=0;i<=index&&i<list.length;i++){if(list[i].isNoteSeparator)continue;seen.add(list[i].noteId==null?`paragraph:${i}`:`note:${String(list[i].noteId)}`);}return seen.size||null;}

/** Metadata-bearing lines are also the exact lines sent to the provider. */
export function buildNoteSourceEntries(doc){const out=[];for(const target of ['footnote','endnote'])for(const [index,p]of (doc?.[ARRAY[target]]||[]).entries()){if(p.isNoteSeparator||typeof p.text!=='string'||!p.text.trim())continue;const {start,end}=trimBounds(p.text),number=modelNoteNumber(doc,target,index);const label=`[${target==='footnote'?'脚注':'尾注'}${number??'?'}] [part=${target};${INDEX[target]}=${index};noteId=${p.noteId??'?'}]`;const text=p.text.slice(start,end);out.push({target,index,rawStart:start,rawEnd:end,label,text,line:`${label} ${text}`});}return out;}

function exposedOwner(doc,entry,sourceVersionId){
 if(!entry||typeof entry!=='object')return{reasonCode:'invalid_exposed_node'};
 const declared=declarations(entry),target=declared.target||'paragraph',index=entry.index??declared.index;
 if(declared.errors.length)return{target,index,reasonCode:declared.errors[0]};
 if(!own(ARRAY,target))return{target,index,reasonCode:'unsupported_source_part'};
 if(!Number.isSafeInteger(index)||index<0)return{target,index,reasonCode:'invalid_declared_index'};
 if(declared.index!=null&&declared.index!==index)return{target,index,reasonCode:'conflicting_source_declaration'};
 const p=nodeAt(doc,target,index);
 if(!p||typeof p.text!=='string'||p.isNoteSeparator)return{target,index,reasonCode:'invalid_exposed_node'};
 if(!validUnicode(p.text))return{target,index,reasonCode:'invalid_source_unicode'};
 if(p.part!=null&&canonical(p.part)!==target)return{target,index,reasonCode:'foreign_source_part'};
 const packageSha=shaOf(doc);
 if(p.sourcePackageSha256!=null&&packageSha&&p.sourcePackageSha256!==packageSha)return{target,index,reasonCode:'foreign_source_package'};
 for(const key of ['pid','noteId','sourceXmlNodeId','sourceXmlParagraphOrdinal','sourceXmlTableNodeId']){
  const actual=key==='pid'?p.id:p[key];
  if(entry[key]!=null&&(key==='noteId'?String(entry[key])!==String(actual):entry[key]!==actual))return{target,index,reasonCode:key==='noteId'?'foreign_note_owner':'foreign_source_node'};
 }
 for(const key of ['sourcePackageSha256','sourceReviewedPackageSha256','workSha256'])if(entry[key]!=null&&entry[key]!==packageSha)return{target,index,reasonCode:'foreign_source_package'};
 for(const key of ['sourceVersionId','workVersionId','versionId'])if(entry[key]!=null&&(!sourceVersionId||entry[key]!==sourceVersionId))return{target,index,reasonCode:'foreign_or_unproved_source_version'};
 if(entry.textView!=null&&entry.textView!=='after')return{target,index,reasonCode:'unsupported_text_view'};
 if(entry.offsetUnit!=null&&entry.offsetUnit!=='utf16')return{target,index,reasonCode:'unsupported_offset_unit'};
 if(entry.paragraphIndexOwner!=null&&entry.paragraphIndexOwner!=='application-paragraph-index')return{target,index,reasonCode:'unsupported_index_owner'};
 if(entry.role!=null&&entry.role!=='primary'||entry.sourceRole!=null&&entry.sourceRole!=='primary'||entry.primary===false)return{target,index,reasonCode:'non_primary_source_material'};
 return{target,index,p};
}
function capturedRange(doc,target,index,start,end,actualEnd=end){
 const p=nodeAt(doc,target,index),source=Object.fromEntries(Object.entries(identity(doc,target,index)).filter(([,value])=>value!==undefined));
 return{...source,rawStart:start,rawEnd:end,sentText:p.text.slice(start,end),actualSentRawEnd:actualEnd,trailingIncompleteUtf16Units:actualEnd-end};
}

/** Explicit primary entries prove whole UTF16 slices in each owner. Legacy body/prefix notes remain bounded compatibility paths. */
export function captureModelSourceContext(doc,{win=[],noteEntries=[],noteText='',window=1,kind='window',allowDocumentIssue=false,sourceVersionId=null}={}){
 const entries=[],rejectedEntries=[],reject=(owner,reasonCode=owner.reasonCode)=>rejectedEntries.push({target:owner.target||'paragraph',index:owner.index,reasonCode});
 for(const w of win){
  const owner=exposedOwner(doc,w,sourceVersionId);if(owner.reasonCode){reject(owner);continue;}
  const {target,index,p}=owner;
  if(typeof w.text!=='string'){reject(owner,'invalid_exposed_node');continue;}
  const explicit=own(w,'target')||own(w,'part')||own(w,'rawStart')||own(w,'rawEnd')||Object.values(INDEX).some(key=>own(w,key));
  if(explicit){
   if(!Number.isSafeInteger(w.rawStart)||!Number.isSafeInteger(w.rawEnd)||w.rawStart<0||w.rawEnd<w.rawStart||w.rawEnd>p.text.length){reject(owner,'invalid_exposed_range');continue;}
   if(!bound(p.text,w.rawStart)||!bound(p.text,w.rawEnd)||!validUnicode(w.text)){reject(owner,'invalid_exposed_unicode');continue;}
   if(w.rawEnd-w.rawStart!==w.text.length||p.text.slice(w.rawStart,w.rawEnd)!==w.text){reject(owner,'sent_text_not_source_slice');continue;}
   entries.push(capturedRange(doc,target,index,w.rawStart,w.rawEnd));
  }else{
   // Old body windows used trim/prefix without explicit bounds. A truncated high
   // surrogate is recorded separately and never becomes a reportable character.
   const start=trimBounds(p.text).start,actualEnd=start+w.text.length;
   if(!bound(p.text,start)||actualEnd>p.text.length||p.text.slice(start,actualEnd)!==w.text){reject(owner,'sent_text_not_source_slice');continue;}
   const end=bound(p.text,actualEnd)?actualEnd:actualEnd-1;
   if(!validUnicode(p.text.slice(start,end))){reject(owner,'invalid_exposed_unicode');continue;}
   entries.push(capturedRange(doc,target,index,start,end,actualEnd));
  }
 }
 let at=0;
 for(const n of noteEntries){
  const owner=exposedOwner(doc,n,sourceVersionId),line=typeof n?.line==='string'?n.line:'',label=typeof n?.label==='string'?n.label:'';
  if(owner.reasonCode){reject(owner);at+=line.length+1;continue;}
  const {target,index,p}=owner;
  if(!['footnote','endnote'].includes(target)||typeof n.text!=='string'||!bound(p.text,n.rawStart)||!bound(p.text,n.rawEnd)||n.rawEnd-n.rawStart!==n.text.length||p.text.slice(n.rawStart,n.rawEnd)!==n.text||line!==label+' '+n.text){reject(owner,'sent_text_not_source_slice');at+=line.length+1;continue;}
  const textStart=at+label.length+1,textEnd=textStart+n.text.length,visibleEnd=Math.min(textEnd,noteText.length);
  if(visibleEnd>textStart&&noteText.slice(at,Math.min(at+line.length,noteText.length))===line.slice(0,Math.min(line.length,noteText.length-at))){
   const actualEnd=n.rawStart+visibleEnd-textStart,rawEnd=bound(p.text,actualEnd)?actualEnd:actualEnd-1;
   if(rawEnd>=n.rawStart)entries.push(capturedRange(doc,target,index,n.rawStart,rawEnd,actualEnd));
  }
  at+=line.length+1;
 }
 return{schemaVersion:1,kind,window,allowDocumentIssue,sourcePackageSha256:shaOf(doc),sourceVersionId,entries,rejectedEntries,notesSentUtf16Length:noteText.length,fullDocumentCoverage:false};
}

function allContext(doc){return{kind:'search',window:null,sourcePackageSha256:shaOf(doc),entries:Object.entries(ARRAY).flatMap(([target,key])=>(doc?.[key]||[]).map((p,index)=>({target,index,rawStart:0,rawEnd:String(p.text||'').length,sentText:String(p.text||'')})).filter(e=>!nodeAt(doc,target,e.index)?.isNoteSeparator))};}
function declarations(issue){const values=[issue,issue.anchor&&typeof issue.anchor==='object'?issue.anchor:{}],targets=[],indices=[],errors=[];for(const v of values){for(const key of ['part','target'])if(v[key]!=null){const c=canonical(v[key]);if(!c)errors.push('unsupported_source_part');else targets.push(c);}for(const[target,key]of Object.entries(INDEX))if(v[key]!=null){targets.push(target);indices.push({target,index:v[key]});}if(v.target!=null&&v.index!=null){const target=canonical(v.target);if(target&&target!=='document')indices.push({target,index:v.index});else errors.push('invalid_declared_index');}if(v.location!=null){if(v.location==='document')targets.push('document');else{const m=/^(paragraph|body|footnote|endnote):(\d+)$/.exec(String(v.location));if(m){const target=canonical(m[1]);targets.push(target);indices.push({target,index:Number(m[2])});}else errors.push('unsupported_source_location');}}}
 const targetSet=[...new Set(targets)],indexSet=[...new Map(indices.map(i=>[`${i.target}:${i.index}`,i])).values()];if(targetSet.length>1||indexSet.length>1)errors.push('conflicting_source_declaration');for(const i of indexSet)if(!Number.isSafeInteger(i.index)||i.index<0)errors.push('invalid_declared_index');return{target:targetSet[0]||null,index:indexSet[0]?.index,errors,values};}

export function resolveModelSource({doc,issue={},context}={}){const declaration=modelSourceDeclaration(issue),ctx=context||allContext(doc),d=declarations(issue);let entries=Array.isArray(ctx.entries)?ctx.entries:[];const result=(status,reasonCode,candidates=[],source)=>({status,reasonCode,declaration,window:ctx.window??null,contextKind:ctx.kind,sourcePackageSha256:ctx.sourcePackageSha256||shaOf(doc),sourceVersionId:ctx.sourceVersionId||null,contextProof:{kind:ctx.kind,window:ctx.window??null,sourcePackageSha256:ctx.sourcePackageSha256||shaOf(doc),sourceVersionId:ctx.sourceVersionId||null,exposedSources:entries.map(e=>({...identity(doc,e.target,e.index),rawStart:e.rawStart,rawEnd:e.rawEnd,actualSentRawEnd:e.actualSentRawEnd??e.rawEnd,trailingIncompleteUtf16Units:e.trailingIncompleteUtf16Units||0,sentTextSha256:createHash('sha256').update(String(e.sentText||'')).digest('hex')})),rejectedEntries:ctx.rejectedEntries||[],notesSentUtf16Length:ctx.notesSentUtf16Length??null,fullDocumentCoverage:false},candidateCount:candidates.length,candidates,...(source?{source}:{})});
 if(!doc||!Array.isArray(doc.paragraphs))return result('unmapped','invalid_source_document');if(typeof issue.quote!=='string')return result('unmapped','invalid_quote');const quote=issue.quote;if(!validUnicode(quote))return result('unmapped','invalid_quote_unicode');
 if(issue.anchor?.text!=null&&(typeof issue.anchor.text!=='string'||whiteProjection(issue.anchor.text).normalized!==whiteProjection(quote).normalized))return result('unmapped','conflicting_quote_declaration');
 const validEntries=[];for(const e of entries){const owner=exposedOwner(doc,e,ctx.sourceVersionId),p=owner.p;if(owner.reasonCode||!p||owner.target!==e.target||owner.index!==e.index||!bound(p.text,e.rawStart)||!bound(p.text,e.rawEnd)||e.rawStart>e.rawEnd||typeof e.sentText!=='string'||!validUnicode(e.sentText)||p.text.slice(e.rawStart,e.rawEnd)!==e.sentText)continue;validEntries.push(e);}entries=validEntries;
 const allCandidates=quote.trim()?uniqueCandidates(candidatesFor(doc,entries,quote)):[];
 if(d.errors.length)return result('unmapped',d.errors.includes('conflicting_source_declaration')?'conflicting_source_declaration':d.errors[0],allCandidates);
 if(ctx.sourcePackageSha256&&shaOf(doc)&&ctx.sourcePackageSha256!==shaOf(doc))return result('unmapped','foreign_request_source',allCandidates);
 if(issue.window!=null&&(!Number.isSafeInteger(issue.window)||ctx.window==null||issue.window!==ctx.window))return result('unmapped','conflicting_window',allCandidates);
 for(const v of d.values){if(v.textView!=null&&v.textView!=='after')return result('unmapped','unsupported_text_view',allCandidates);if(v.offsetUnit!=null&&v.offsetUnit!=='utf16')return result('unmapped','unsupported_offset_unit',allCandidates);if(v.paragraphIndexOwner!=null&&v.paragraphIndexOwner!=='application-paragraph-index')return result('unmapped','unsupported_index_owner',allCandidates);for(const k of ['sourcePackageSha256','sourceReviewedPackageSha256','workSha256'])if(v[k]!=null&&v[k]!==shaOf(doc))return result('unmapped','foreign_source_package',allCandidates);for(const k of ['sourceVersionId','workVersionId','versionId'])if(v[k]!=null&&(!ctx.sourceVersionId||v[k]!==ctx.sourceVersionId))return result('unmapped','foreign_or_unproved_source_version',allCandidates);}
 if(!quote.trim()){if(ctx.allowDocumentIssue===true&&d.index==null&&(!d.target||d.target==='document'))return result('document','intentional_document_scope');return result('unmapped','empty_quote',[]);}
 if(d.target==='document'){if(ctx.allowDocumentIssue!==true)return result('unmapped','document_scope_not_allowed',allCandidates);return allCandidates.length?result('document','intentional_document_scope',allCandidates):result('unmapped','full_quote_not_found',[]);}
 if(d.index!=null){const p=nodeAt(doc,d.target,d.index);if(!p||p.isNoteSeparator)return result('unmapped','invalid_declared_index',allCandidates);const exposed=entries.some(e=>e.target===d.target&&e.index===d.index);if(!exposed)return result('unmapped','outside_exposed_source',allCandidates);for(const v of d.values){if(v.noteId!=null&&String(v.noteId)!==String(p.noteId))return result('unmapped','foreign_note_owner',allCandidates);if(v.pid!=null&&v.pid!==p.id)return result('unmapped','foreign_source_node',allCandidates);if(v.sourceXmlNodeId!=null&&v.sourceXmlNodeId!==p.sourceXmlNodeId)return result('unmapped','foreign_source_node',allCandidates);if(v.sourceXmlParagraphOrdinal!=null&&v.sourceXmlParagraphOrdinal!==p.sourceXmlParagraphOrdinal)return result('unmapped','foreign_source_node',allCandidates);if(v.sourceXmlTableNodeId!=null&&v.sourceXmlTableNodeId!==p.sourceXmlTableNodeId)return result('unmapped','foreign_source_node',allCandidates);}}
 let candidates=allCandidates.filter(c=>(!d.target||c.target===d.target)&&(d.index==null||c.index===d.index));
 const identityKeys=['noteId','pid','sourceXmlNodeId','sourceXmlParagraphOrdinal','sourceXmlTableNodeId'];const hasIdentity=d.values.some(v=>identityKeys.some(k=>v[k]!=null));if(hasIdentity){candidates=candidates.filter(c=>d.values.every(v=>identityKeys.every(k=>v[k]==null||(k==='noteId'?String(v[k])===String(c[k]):v[k]===c[k]))));if(!candidates.length)return result('unmapped','declared_source_identity_mismatch',allCandidates);}
 const rangeDeclarations=d.values.filter(v=>v.start!=null||v.end!=null||v.offset!=null);if(rangeDeclarations.length){if(d.index==null)return result('unmapped','range_requires_source_index',candidates);const ranges=rangeDeclarations.map(v=>({start:v.start??v.offset,end:v.end??((v.start??v.offset)+quote.length)}));if(ranges.some(r=>!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end))||new Set(ranges.map(r=>`${r.start}:${r.end}`)).size>1)return result('unmapped','conflicting_range_declaration',candidates);const p=nodeAt(doc,d.target,d.index),r=ranges[0];if(!bound(p.text,r.start)||!bound(p.text,r.end)||r.start>=r.end)return result('unmapped','invalid_declared_range',candidates);candidates=candidates.filter(c=>c.start===r.start&&c.end===r.end);if(!candidates.length)return result('unmapped','declared_range_mismatch',allCandidates);}
 if(!candidates.length)return result('unmapped',d.index!=null?'declared_quote_mismatch':'full_quote_not_found',allCandidates);if(candidates.length>1)return result('ambiguous','ambiguous_full_quote',candidates);
 const source=candidates[0];if(ctx.sourceVersionId)source.sourceVersionId=ctx.sourceVersionId;return result('resolved',d.index!=null?'declared_source_full_quote':'unique_full_quote',candidates,source);}

export function modelSourceAnchor(resolution){if(resolution?.status!=='resolved'||!resolution.source)return null;const s=resolution.source;return{target:s.target,index:s.index,start:s.start,end:s.end,text:s.text,precision:s.precision,resolutionStatus:'resolved',rangeProof:s.matchMode==='literal'?'model-full-quote-source':'model-full-quote-whitespace-source',part:s.part,pid:s.pid,noteId:s.noteId,sourceXmlNodeId:s.sourceXmlNodeId,sourceXmlParagraphOrdinal:s.sourceXmlParagraphOrdinal,sourceXmlTableNodeId:s.sourceXmlTableNodeId,sourcePackageSha256:s.sourcePackageSha256,...(s.sourceVersionId?{sourceVersionId:s.sourceVersionId}:{}),textView:'after',offsetUnit:'utf16',paragraphIndexOwner:'application-paragraph-index'};}
