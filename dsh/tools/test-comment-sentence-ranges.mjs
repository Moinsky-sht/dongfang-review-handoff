import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {attachAnchors,attachCommentAnchors,sentenceRange,commentRangeScope} from '../src/anchors.js';
import {rebaseIssueAnchors} from '../src/working-anchors.js';
import {buildRecheckBatches,describeRecheckIssue} from '../src/recheck.js';
import {buildCommentedDocx} from '../src/docx-comments.js';
import {parseDocxBuffer} from '../src/docx.js';
import {loadWorkingVersion} from '../src/working-version.js';
const checks=[];function test(name,f){f();checks.push({name,ok:true});}
const outDir=path.resolve(process.argv.find(x=>x.startsWith('--outdir='))?.slice(9)||`data/verify/comment-sentence-ranges-${Date.now()}`);fs.mkdirSync(outDir,{recursive:true});
const text='前句。😀甲，乙；丙。”后句。',quote='乙；',start=text.indexOf(quote),node={text,id:'document.xml:0',part:'document.xml',sourceXmlNodeId:'document.xml:xml-p:0',sourceXmlParagraphOrdinal:0};
const doc={paragraphs:[node],sourcePackageSha256:'a'.repeat(64),sourceVersionId:'v0'};
const issue={ruleId:'LANG-002',group:'model',title:'句式杂糅',quote,paragraphIndex:0,autoFix:{find:quote,replace:'乙，',offset:start}};
test('full sentence crosses comma and semicolon and includes closing quotation',()=>assert.deepEqual(sentenceRange(text,start,start+quote.length),{start:3,end:12,text:'😀甲，乙；丙。”'}));
test('source quote and automatic edit remain immutable',()=>{const r={issues:[structuredClone(issue)]};attachAnchors(r,doc);const original=structuredClone(r.issues[0].anchor);attachCommentAnchors(r,doc);assert.deepEqual(r.issues[0].anchor,original);assert.deepEqual(r.issues[0].autoFix,issue.autoFix);assert.equal(r.issues[0].commentAnchors[0].text,'😀甲，乙；丙。”');});
test('punctuation and word comments keep exact phrase range',()=>{for(const extra of [{group:'format'},{group:'model',ruleId:'LANG-013',title:'错别字'},{ruleId:'LANG-013',title:'错别字',rangeScope:'phrase'}]){const r={issues:[{...issue,...extra}]};attachAnchors(r,doc);attachCommentAnchors(r,doc);assert.equal(r.issues[0].commentAnchors[0].text,quote);}});
test('structural sentence classification cannot be shortened by a model phrase tag',()=>assert.equal(commentRangeScope({...issue,rangeScope:'phrase'}),'sentence'));
test('explicit paragraph scope preserves full raw paragraph',()=>{const r={issues:[{...issue,rangeScope:'paragraph'}]};attachAnchors(r,doc);attachCommentAnchors(r,doc);assert.equal(r.issues[0].commentAnchors[0].text,text);});
test('English decimals and abbreviations retain full sentence',()=>assert.equal(sentenceRange('Before. Dr. Li measured 3.14 units. After.',25,29).text,'Dr. Li measured 3.14 units.'));
test('ambiguous repeated evidence never expands into guessed sentence',()=>{const d={...doc,paragraphs:[{...node,text:'同词。同词。'}]},r={issues:[{...issue,quote:'同词',autoFix:undefined}]};attachAnchors(r,d);attachCommentAnchors(r,d);assert.equal(r.issues[0].commentAnchors[0].resolutionStatus,'ambiguous');assert.equal(r.issues[0].commentAnchors[0].commentScope,undefined);});
test('obsolete version and relocation never receive sentence expansion',()=>{const r={issues:[{...issue,anchor:{target:'paragraph',index:0,start,end:start+quote.length,text:quote,sourceVersionId:'vOld'}}]};attachAnchors(r,doc);attachCommentAnchors(r,doc);assert.equal(r.issues[0].commentAnchors[0].resolutionStatus,'unmapped');r.issues[0].needsRelocation=true;attachCommentAnchors(r,doc);assert.equal(r.issues[0].commentAnchors,undefined);});
test('regenerate comment scope after committed edits using rebased evidence',()=>{const r={issues:[structuredClone(issue)]};attachAnchors(r,doc);const next={...doc,sourceVersionId:'v1',paragraphs:[{...node,text:'新'+text}]};r.issues=rebaseIssueAnchors(r.issues,next,[{target:'body',index:0,sourceVersionId:'v0',sourceOffset:0,find:'前',replace:'新前'}],'v0');attachCommentAnchors(r,next);assert.equal(r.issues[0].commentAnchors[0].text,'😀甲，乙；丙。”');assert.equal(r.issues[0].anchor.start,start+1);});
const short=Array.from({length:40},(_,i)=>({ruleId:'RULE',quote:`原文${i}。`,suggestion:'保持原意修订'}));
test('40 short issues reduce ten four-item requests to four bounded batches',()=>{const b=buildRecheckBatches(short);assert.deepEqual(b.map(x=>x.length),[12,12,12,4]);assert.deepEqual(b.flat(),short);});
test('long quotes and complete change survive prompt construction',()=>{const q='甲'.repeat(250)+'不能漏掉句末。',s='乙'.repeat(240)+'保留建议结尾';assert(describeRecheckIssue({quote:q,suggestion:s},0).includes(q));assert(describeRecheckIssue({quote:q,suggestion:s},0).includes(s));});
test('large individual issue remains singleton and is never discarded',()=>{const big={quote:'甲'.repeat(8000)};assert.deepEqual(buildRecheckBatches([short[0],big,short[1]]).map(x=>x.length),[1,1,1]);});
test('invalid batching bounds rejected',()=>assert.throws(()=>buildRecheckBatches(short,{maxItems:0})));
const history=JSON.parse(fs.readFileSync('reports/anchor-history-audit-20261010.json'));
let actualSentences=0,exportAdded=0;
const config=JSON.parse(fs.readFileSync('tmp/real-review-service-current.json'));
for(const entry of history.modelDetails.filter(x=>x.current)){
 const snapshot={paragraphs:[...Array(entry.anchor.index+1)].map((_,i)=>i===entry.anchor.index?{text:entry.paragraphText,id:entry.anchor.pid,sourceXmlNodeId:entry.anchor.sourceXmlNodeId}:{text:''}),sourcePackageSha256:entry.anchor.sourcePackageSha256,sourceVersionId:entry.anchor.sourceVersionId};
 const it={group:'model',ruleId:entry.ruleId,title:entry.title,category:entry.category,quote:entry.quote,anchor:entry.anchor,anchors:[entry.anchor]};
 attachCommentAnchors({issues:[it]},snapshot);
 if(commentRangeScope(it)==='sentence'){assert.equal(it.commentAnchors[0].text,entry.fullSentence.text);actualSentences++;}
 if(entry.title==='“关注……进行突破”句式杂糅'){
  const loaded=await loadWorkingVersion({sessionId:entry.sessionId,versionId:entry.anchor.sourceVersionId,storageRoot:config.roots.versions});
  const result=buildCommentedDocx({buffer:loaded.buffer,issues:[it],workVersionId:entry.anchor.sourceVersionId});
  assert.equal(result.added,1);assert.equal(result.placements[0].source.text,entry.fullSentence.text);
  // Word export currently documents paragraph-level placement; do not claim exact character placement.
  assert.equal(result.placements[0].precision,'paragraph');const parsed=parseDocxBuffer(result.buffer);assert.equal(parsed.comments.at(-1).anchorText,entry.paragraphText);exportAdded++;
  const out=path.join(outDir,'sentence-comment-example.docx');fs.writeFileSync(out,result.buffer,{flag:'wx'});
 }
}
assert(actualSentences>=3);assert.equal(exportAdded,1);
const out=path.join(outDir,'sentence-tests.json');fs.writeFileSync(out,JSON.stringify({passed:checks.length,failed:0,actualHistoricalSentenceComments:actualSentences,actualWordExportSourceRangeVerified:exportAdded,wordVisualPlacement:'paragraph',checks},null,2),{flag:'wx'});console.log(JSON.stringify({passed:checks.length,actualSentences,exportAdded,out}));
