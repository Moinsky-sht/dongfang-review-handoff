import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const base=process.env.BASE||'http://127.0.0.1:3210';
const call=async(p,body)=>{const r=await fetch(base+p,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const out=await r.json();assert.ok(r.ok,out.error);return out;};
const up=await(await fetch(base+'/api/upload?name=fix-persistence-test.docx',{method:'POST',body:readFileSync(new URL('../samples/test.docx',import.meta.url))})).json();
assert.ok(up.id);
const reviewed=await call('/api/review',{id:up.id,useModel:false,useRecheck:false});
const seen=new Set();
const fixes=reviewed.issues.filter(it=>{if(!it.autoFix?.find||it.anchor?.target!=='paragraph'||seen.has(it.location))return false;seen.add(it.location);return true;}).slice(0,2);
assert.equal(fixes.length,2,'样本须有两处独立的可自动修改问题');
const keys=fixes.map(it=>it.issueKey||`${it.ruleId}|${it.location}|${it.quote||''}`);
const expectedPatchCount=fixes.reduce((count,it)=>count+(it.occurrences?.length||1),0);
const selectedContext=await call('/api/session?id='+up.id);
const selectionReviewRunId=selectedContext.reviewRunId;
assert.equal(selectionReviewRunId,reviewed.reviewRunId,'选择问题时须冻结同一次已完成审阅');
let currentContext=selectedContext;
const requests=[];
for(const key of keys){
 const body={id:up.id,accepted:[key],baseVersionId:currentContext.workVersion.id,baseMutationEpoch:currentContext.history.epoch,
  baseReviewRunId:selectionReviewRunId,operationId:randomUUID()};
 requests.push(body);
 const r=await call('/api/apply-fixes',body);assert.ok(r.applied.length);currentContext=r;
}
const replay=await call('/api/apply-fixes',requests.at(-1));
assert.equal(replay.replayed,true,'响应重试必须沿用原请求与原运行，不能改用新的版本上下文');
assert.equal(replay.workVersion.id,currentContext.workVersion.id);
for(const endpoint of ['/api/session','/api/review-status']){
 const r=await call(endpoint+'?id='+up.id);
 for(const key of keys)assert.ok(r.appliedFixes.includes(key),'连续修改须保留前一条');
 assert.equal(r.appliedFixDetails.length,expectedPatchCount,'归并条目的每处修改均须保留');
 assert.equal(new Set(r.appliedFixDetails.map(a=>a.patchId)).size,expectedPatchCount);
 assert.ok(r.appliedFixDetails.every(a=>a.target==='body'&&Number.isInteger(a.index)&&a.patchId),'修改记录须有逐处身份和具体目标段落');
}
const noop=await call('/api/apply-fixes',{id:up.id,accepted:[keys[0]],baseVersionId:currentContext.workVersion.id,
 baseMutationEpoch:currentContext.history.epoch,baseReviewRunId:selectionReviewRunId,operationId:randomUUID()});
assert.equal(noop.applied.length,0);
assert.equal(noop.appliedFixDetails.length,expectedPatchCount,'重复提交不得新增或清空已有记录');
console.log('连续修改持久性回归通过：两次修改、重复修改、会话恢复和进度接口均保留完整记录');
