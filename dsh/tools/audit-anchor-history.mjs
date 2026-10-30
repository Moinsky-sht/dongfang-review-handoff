/** Read-only history audit; sentence flags require human semantic assessment. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadSessionSnapshot} from '../src/session-store.js';
import {computeAnchors} from '../src/anchors.js';
const roots=['data/sessions','data/live-real-review/service-1791592582647-1fb1ed10/sessions'];
const output=path.resolve(process.argv.find(x=>x.startsWith('--out='))?.slice(6)||`reports/anchor-history-audit-${Date.now()}.json`);
const report={at:new Date().toISOString(),readOnly:true,modelCalls:0,scope:roots,sourceHashes:Object.fromEntries(['src/anchors.js','src/model-source-location.js','public/app.js'].map(p=>[p,createHash('sha256').update(fs.readFileSync(p)).digest('hex')])),sessions:0,records:0,issues:0,modelIssues:0,anchors:0,resolved:0,literalMismatch:0,pending:0,structural:0,sentenceCandidates:0,errors:[],recordSummaries:[],modelDetails:[],mismatches:[]};
const sentenceRules=new Set(['LANG-002','LANG-003','LANG-004','LANG-005','LANG-011','LANG-012']);
function sentenceAround(text,start,end){
 const re=/[。！？!?]/g;let s=0,e=text.length;for(const m of text.matchAll(re)){let b=m.index+1;while(/[”’」』）)]/.test(text[b]||'\0'))b++;if(b<=start)s=b;else if(m.index>=end-1){e=b;break;}}
 while(s<start&&/\s/.test(text[s]))s++;
 return{start:s,end:e,text:text.slice(s,e)};
}
for(const root of roots){
 for(const id of fs.readdirSync(root).sort()){
  if(!/^s[a-z0-9]+$/.test(id)||!fs.statSync(path.join(root,id)).isDirectory())continue;
  report.sessions++;let snapshot,manifest;try{({snapshot,manifest}=await loadSessionSnapshot({sessionId:id,storageRoot:path.resolve(root)}));}catch(e){report.errors.push({root,id,error:e.message});continue;}
  const records=[...(snapshot.reviewRecords||[])];
  if(snapshot.result&&!records.some(r=>r.id===snapshot.resultRunId||r.result?.generatedAt===snapshot.result.generatedAt))records.push({id:snapshot.resultRunId||'current',versionId:snapshot.resultVersionId,texts:snapshot.resultTexts,result:snapshot.result,current:true});
  for(const rec of records){
   if(!rec.result?.issues)continue; report.records++;
   const tx=rec.texts,doc=tx&&{paragraphs:tx.sourceNodes?.body||tx.body?.map(text=>({text})),footnotes:tx.sourceNodes?.footnote||tx.footnote?.map(text=>({text})),endnotes:tx.sourceNodes?.endnote||tx.endnote?.map(text=>({text})),sourcePackageSha256:tx.sourcePackageSha256,sourceVersionId:rec.versionId};
   const summary={root,sessionId:id,name:snapshot.name,purpose:snapshot.purpose||'legacy-unspecified',manifestRevision:manifest.revision,recordId:rec.id,date:rec.result.generatedAt,current:rec.current||rec.id===snapshot.resultRunId||rec.result.generatedAt===snapshot.result?.generatedAt,issues:rec.result.issues.length,modelIssues:0,savedAnchors:0,recomputedAnchors:0,rangeMismatches:0,pending:0,sentenceCandidates:0};
   for(const issue of rec.result.issues){
    report.issues++; if(issue.group==='model'){report.modelIssues++;summary.modelIssues++;}
    const saved=issue.anchors?.length?issue.anchors:issue.anchor?[issue.anchor]:null;
    const anchors=saved||doc&&computeAnchors(issue,doc)||[];
    if(saved)summary.savedAnchors+=anchors.length;else summary.recomputedAnchors+=anchors.length;
    for(const a of anchors){
     report.anchors++;
     if(['document','table'].includes(a.target)){report.structural++;continue;}
     if(['ambiguous','unmapped','unresolved'].includes(a.resolutionStatus)){report.pending++;summary.pending++;continue;}
     const text=doc?.[{paragraph:'paragraphs',footnote:'footnotes',endnote:'endnotes'}[a.target]]?.[a.index]?.text;
     if(typeof text!=='string')continue;
     if(!Number.isInteger(a.start)||!Number.isInteger(a.end)||a.start<0||a.end<=a.start||a.end>text.length||text.slice(a.start,a.end)!==a.text){report.literalMismatch++;summary.rangeMismatches++;report.mismatches.push({sessionId:id,name:snapshot.name,recordId:rec.id,ruleId:issue.ruleId,title:issue.title,anchor:a});continue;}
     report.resolved++;
     if(issue.group==='model'){
      const s=sentenceAround(text,a.start,a.end),partial=a.start>s.start||a.end<s.end;
      const sentenceIssue=sentenceRules.has(issue.ruleId)||/句式|长句|成分残缺|主语缺|逻辑|搭配|语序|指代|句法/.test(issue.category+' '+issue.title);
      if(partial&&sentenceIssue){report.sentenceCandidates++;summary.sentenceCandidates++;}
      report.modelDetails.push({root,sessionId:id,name:snapshot.name,recordId:rec.id,date:rec.result.generatedAt,current:summary.current,ruleId:issue.ruleId,title:issue.title,category:issue.category,detail:issue.detail||issue.message,suggestion:issue.fix||issue.suggestion,quote:issue.quote,anchor:{...a},fullSentence:s,partialSentence:partial,sentenceScopeCandidate:partial&&sentenceIssue,paragraphText:text,renderedVerified:false});
     }
    }
   }
   report.recordSummaries.push(summary);
  }
 }
}
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,...Object.fromEntries(Object.entries(report).filter(([k,v])=>typeof v==='number')),errors:report.errors,records:report.recordSummaries.filter(x=>x.modelIssues),candidates:report.modelDetails.filter(x=>x.sentenceScopeCandidate).map(({name,date,current,ruleId,title,quote,fullSentence})=>({name,date,current,ruleId,title,quote,fullSentence})).slice(-12)},null,2));
