/** Identity-bound Markdown reports and atomic, non-overwriting artifact pairs. */
import fs from 'node:fs/promises';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {buildReport} from './review.js';
import {issueIdentity} from './issue-identity.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const shaPattern=/^[a-f0-9]{64}$/;
const fail=(code,message,cause)=>Object.assign(new Error(message,{cause}),{code});
const plain=value=>JSON.parse(JSON.stringify(value));
const within=(root,p)=>{const r=relative(root,p);return r!==''&&!isAbsolute(r)&&!r.startsWith('..');};

function validateContext(view,doc,context){
  if(!context||!uuid.test(context.exportId||'')||typeof context.sessionId!=='string'||!context.sessionId
    ||typeof context.reviewRunId!=='string'||!context.reviewRunId||typeof context.resultVersionId!=='string'||!context.resultVersionId
    ||typeof context.workVersion?.id!=='string'||!context.workVersion.id||!shaPattern.test(context.workVersion.sha256||'')
    ||!shaPattern.test(context.workVersion.sourceSha256||'')||!['editorial','verification'].includes(context.purpose)
    ||typeof context.exportedAt!=='string'||!Number.isFinite(Date.parse(context.exportedAt))){
    throw fail('REPORT_EXPORT_CONTEXT_INVALID','报告导出身份或版本声明不完整');
  }
  if(view?.reviewRunId&&view.reviewRunId!==context.reviewRunId
    ||view?.sourceBinding?.versionId&&view.sourceBinding.versionId!==context.resultVersionId
    ||view?.human?.reviewRunId&&view.human.reviewRunId!==context.reviewRunId
    ||view?.human?.workVersionId&&view.human.workVersionId!==context.workVersion.id
    ||doc?.sourcePackageSha256&&doc.sourcePackageSha256!==context.workVersion.sha256
    ||view?.reviewCoverage?.reviewedVersionId&&view.reviewCoverage.reviewedVersionId!==context.resultVersionId
    ||view?.reviewCoverage?.currentWorkVersionId&&view.reviewCoverage.currentWorkVersionId!==context.workVersion.id
    ||view?.reviewCoverage?.purpose==='verification'&&context.purpose!=='verification'){
    throw fail('REPORT_EXPORT_CONTEXT_MISMATCH','报告视图与指定审阅或当前工作版本不一致');
  }
  if(!Array.isArray(view?.issues))throw fail('REPORT_EXPORT_VIEW_INVALID','报告缺少问题视图');
}

export function buildReportExport({view,doc,context}){
  validateContext(view,doc,context);
  const current={...view,issues:view.issues.map(issue=>({...issue,issueKey:issueIdentity(issue)}))};
  const markdown=buildReport(current,doc,context),bytes=Buffer.from(markdown,'utf8');
  const decisions=current.human?.decisions||{};
  const receipt=plain({schemaVersion:1,artifactType:'markdown-report',exportId:context.exportId,exportedAt:context.exportedAt,
    sessionId:context.sessionId,reviewRunId:context.reviewRunId,resultVersionId:context.resultVersionId,
    workVersion:{...context.workVersion},purpose:context.purpose,verificationRunId:context.verificationRunId||null,
    completionStatus:current.completionStatus||'unknown',sourceBinding:current.sourceBinding||null,
    reviewCoverage:current.reviewCoverage||null,
    execution:current.execution||null,
    human:current.human||{decisions:{},marks:[]},issueCount:current.issues.length,
    issues:current.issues.map(issue=>({...issue,
      modelSourceDeclaration:issue.modelSourceDeclaration??null,modelSourceResolution:issue.modelSourceResolution??null,
      anchors:Array.isArray(issue.anchors)?issue.anchors:issue.anchor?[issue.anchor]:[],anchor:issue.anchor??null,
      needsRelocation:!!issue.needsRelocation,humanDecision:Object.hasOwn(decisions,issue.issueKey)?decisions[issue.issueKey]:null})),
    outputSha256:sha(bytes),outputBytes:bytes.length});
  return{markdown,receipt};
}

async function safeRoot(storageRoot){
  if(typeof storageRoot!=='string'||!storageRoot)throw fail('REPORT_EXPORT_ROOT_INVALID','报告保存目录未指定');
  const root=resolve(storageRoot);
  for(let c=root;;c=dirname(c)){
    try{await fs.lstat(join(c,'complete.json'));throw fail('REPORT_EXPORT_ROOT_SEALED','禁止写入已封存目录');}
    catch(e){if(e.code!=='ENOENT')throw e;}
    try{const s=await fs.lstat(c);if(!s.isDirectory()||s.isSymbolicLink()||resolve(await fs.realpath(c))!==c)throw fail('REPORT_EXPORT_ROOT_ALIAS','报告保存目录不能使用别名或符号链接');}
    catch(e){if(e.code!=='ENOENT')throw e;}
    if(dirname(c)===c)break;
  }
  await fs.mkdir(root,{recursive:true});return root;
}

async function writeImmutable(path,bytes){
  const file=await fs.open(path,'wx');
  try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
}

export async function saveReportExport({markdown,receipt},{storageRoot}={}){
  if(typeof markdown!=='string'||receipt?.schemaVersion!==1||receipt.artifactType!=='markdown-report'||!uuid.test(receipt.exportId||''))throw fail('REPORT_EXPORT_RECEIPT_INVALID','报告保存回执无效');
  const bytes=Buffer.from(markdown,'utf8');
  if(sha(bytes)!==receipt.outputSha256||bytes.length!==receipt.outputBytes)throw fail('REPORT_EXPORT_SHA_MISMATCH','报告内容与导出回执校验不符');
  const savedReceipt=plain(receipt),receiptBytes=Buffer.from(JSON.stringify(savedReceipt,null,2)+'\n','utf8');
  const root=await safeRoot(storageRoot),directory=join(root,savedReceipt.exportId);
  if(!within(root,directory))throw fail('REPORT_EXPORT_ROOT_INVALID','报告保存位置超出指定目录');
  try{await fs.mkdir(directory);}catch(e){if(e.code==='EEXIST')throw fail('REPORT_EXPORT_EXISTS','此报告导出身份已经使用，原产物未覆盖',e);throw fail('REPORT_EXPORT_SAVE_FAILED','报告保存目录创建失败',e);}
  const pending=join(directory,`.pending-${randomUUID()}`),published=join(directory,'published');
  try{
    await fs.mkdir(pending);
    await writeImmutable(join(pending,'report.md'),bytes);
    await writeImmutable(join(pending,'receipt.json'),receiptBytes);
    // Only this owner created the export directory. Publish the complete pair
    // in one rename; callers receive paths only after that commit succeeds.
    await fs.rename(pending,published);
    return{savedTo:join(published,'report.md'),receiptSavedTo:join(published,'receipt.json'),receipt:savedReceipt};
  }catch(e){
    // Keep the exclusive export-ID reservation, but remove only our staging
    // directory. An unsuccessful ID cannot later be mistaken for a replay.
    if(within(directory,pending))try{await fs.rm(pending,{recursive:true,force:true});}catch{}
    throw fail('REPORT_EXPORT_SAVE_FAILED','报告文件未完成发布',e);
  }
}
