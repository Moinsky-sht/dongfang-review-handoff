/** Execution evidence is separate from source coverage and independent quality. */
const STATES=new Set(['completed','partial','failed','disabled','unavailable','unknown']);
const count=(value)=>Number.isInteger(value)&&value>=0?value:null;
const counts=(input,keys)=>Object.fromEntries(keys.filter(k=>count(input?.[k])!==null).map(k=>[k,input[k]]));
const step=(status,reason,extra={})=>({status,reason,...extra});
const reasonLabels={not_requested:'本次未选择此步骤',configuration_disabled:'本次服务未启用此步骤',
  context_not_requested:'本次未选择全局上下文',digest_unavailable:'未取得全局纲要，无法执行此步骤',
  digest_returned:'全局纲要已生成',digest_not_parseable:'纲要返回内容无法读取',
  result_returned:'本步骤结果已返回',output_truncated:'返回内容达到输出上限，未能完整读取',
  output_not_parseable:'返回内容无法读取',no_result_returned:'没有取得本步骤结果',
  no_issues_to_check:'没有进入终检的候选问题，此步骤未执行',not_observed:'缺少实际执行记录',
  index_unavailable:'历史批注参考索引未就绪',case_index_unavailable:'历史批注参考索引未就绪',
  index_loaded:'历史批注参考索引已读取',index_ready:'历史批注参考索引已就绪',cases_loaded:'历史批注参考索引已读取'};
const actualStep=(value,missingReason)=>value&&STATES.has(value.status)
  ?step(value.status,reasonLabels[value.reason]||String(value.reason||''),{rawReason:String(value.reason||''),requested:value.requested===true,...(typeof value.enabled==='boolean'?{enabled:value.enabled}:{}),...(typeof value.configured==='boolean'?{configured:value.configured}:{})})
  :step('unknown',missingReason);
const pinnedOptions=input=>input&&typeof input.useModel==='boolean'&&typeof input.useRecheck==='boolean'
  ?{useModel:input.useModel,useRecheck:input.useRecheck,useContext:input.useContext===true,useCases:input.useCases===true,ruleMode:input.ruleMode==='per-rule'?'per-rule':'all',verdictWithModel:input.verdictWithModel===true}:null;

/** Compact confirmed source proof; a bare completion label is insufficient. */
export function projectConfirmedSourceCoverage(input){
  if(!input||input.schemaVersion!==1||input.basis!=='confirmed-primary-source-ranges'
    ||input.scope!=='parsed-after-text-body-table-footnote-endnote'||!['complete','partial'].includes(input.status)
    ||!/^[a-f0-9]{64}$/.test(input.manifestSha256||''))return null;
  const keys=['expectedNodes','completedNodes','expectedUtf16','coveredUtf16','pendingUtf16','expectedTasks','completedTasks'];
  if(!keys.every(k=>Number.isSafeInteger(input.totals?.[k])&&input.totals[k]>=0))return null;
  const t=input.totals;
  if(t.coveredUtf16+t.pendingUtf16!==t.expectedUtf16||t.completedTasks>t.expectedTasks||t.completedNodes>t.expectedNodes)return null;
  if(!Array.isArray(input.sourceCoverageGaps))return null;
  if(input.status==='complete'&&(t.pendingUtf16!==0||t.completedTasks!==t.expectedTasks||t.completedNodes!==t.expectedNodes||input.sourceCoverageGaps.length))return null;
  return{schemaVersion:1,status:input.status,manifestSha256:input.manifestSha256,basis:input.basis,scope:input.scope,
    totals:Object.fromEntries(keys.map(k=>[k,t[k]])),byTarget:structuredClone(input.byTarget||{}),
    sourceCoverageGaps:structuredClone(input.sourceCoverageGaps),
    ...(typeof input.sourcePackageSha256==='string'?{sourcePackageSha256:input.sourcePackageSha256}:{}),
    ...(typeof input.sourceVersionId==='string'?{sourceVersionId:input.sourceVersionId}:{}),
    qualityStatus:'unverified'};
}

export function buildReviewCoverage({result={},options=null,purpose='unknown',reviewedVersionId=null,currentWorkVersionId=null}={}){
  const selected=pinnedOptions(options),model=result.modelResult,recheck=result.recheck,observed=model?.executionScope;
  const steps={rules:result.deterministic?step('completed','规则检查已执行；命中分数不表示内容质量通过'):step('unknown','缺少规则执行记录')};
  if(!selected){
    for(const name of['model','recheck','context','cases','consistency'])steps[name]=step('unknown','历史结果缺少该运行的固定设置，不能推断执行范围');
  }else{
    steps.model=!selected.useModel?step('disabled','本次未选择模型深度审阅')
      :!model?step('unavailable','已选择模型审阅，但没有模型执行结果')
      :observed&&STATES.has(observed.status)?step(observed.status,observed.status==='partial'?'已记录未完成的模型步骤或来源覆盖缺口':'已选择的模型任务已返回；不等于全文覆盖或内容质量通过')
      :model.errors?.length||model.blockedParagraphs?.length?step('partial','模型记录含失败或平台拦截；完整执行范围未证实')
      :step('unknown','模型结果已返回，但缺少实际步骤及覆盖记录');
    steps.model.executionReturned=!!model;
    if(model)steps.model.counts={...counts(model,['windows']),reportedErrors:Array.isArray(model.errors)?model.errors.length:0,blockedParagraphs:Array.isArray(model.blockedParagraphs)?new Set(model.blockedParagraphs).size:0};
    steps.context=!selected.useContext?step('disabled','本次未选择全局上下文')
      :!selected.useModel||!model?step('unavailable','没有可执行全局上下文的模型运行')
      :actualStep(observed?.context,'缺少全局纲要的实际执行记录');
    steps.cases=!selected.useCases?step('disabled','本次未选择历史批注参考')
      :!selected.useModel||!model?step('unavailable','没有历史批注参考的模型运行')
      :actualStep(observed?.cases,'缺少历史批注参考的实际执行记录');
    if(model&&count(model.casesUsed)!==null)steps.cases.counts={used:model.casesUsed};
    steps.consistency=!selected.useModel?step('disabled','本次未选择模型审阅')
      :!model?step('unavailable','没有一致性终检的模型运行')
      :actualStep(observed?.consistency,'缺少一致性终检的实际执行记录');
    const stats=recheck?.stats;
    steps.recheck=!selected.useRecheck?step('disabled','本次未选择模型复核')
      :!recheck?step('unavailable','已选择模型复核，但没有复核执行结果')
      :recheck.executionStatus==='failed'?step('failed','模型复核未能完成')
      :stats?.reason?step('unavailable',String(stats.reason))
      :(stats?.noReply||0)>0?step('partial','部分送审建议未返回复核结论')
      :count(stats?.total)!==null&&count(stats?.checked)!==null&&count(stats?.skipped)!==null&&stats.checked+stats.skipped===stats.total
        ?step('completed','可复核建议已返回；跳过建议和拿不准结论单独记录')
        :step('unknown','复核返回记录不足以核对实际处理范围');
    if(stats){steps.recheck.counts=counts(stats,['total','checked','skipped','noReply','agree','disagree','recovered','batches']);if(count(stats.unsure)!==null)steps.recheck.counts.unsure=Math.max(0,stats.unsure-(stats.noReply||0));}
    if(Array.isArray(recheck?.errors))steps.recheck.reportedErrors=recheck.errors.length;
  }
  const sourceCoverage=projectConfirmedSourceCoverage(observed?.sourceCoverage);
  const fullTextCoverage=!selected?'unverified':!selected.useModel?'not_requested'
    :sourceCoverage?.status==='partial'||observed?.fullTextCoverage==='partial'||observed?.sourceCoverageGaps?.length?'partial'
    :sourceCoverage?.status==='complete'&&observed?.fullTextCoverage==='complete'?'complete':'unverified';
  // Historical errors may have been recovered. Only actual incomplete steps,
  // missing requested execution or recorded source gaps change current status.
  const needed=selected?[steps.model,...(selected.useRecheck?[steps.recheck]:[]),...(selected.useContext?[steps.context]:[])]:[];
  const hasIncompleteRequestedSteps=needed.some(s=>['partial','failed','unavailable','unknown'].includes(s.status))||fullTextCoverage==='partial';
  const executionStatus=hasIncompleteRequestedSteps?'partial'
    :selected&&steps.rules.status==='completed'&&needed.every(s=>['disabled','completed'].includes(s.status))?'completed':'unknown';
  return{schemaVersion:1,purpose:['editorial','verification'].includes(purpose)?purpose:'unknown',options:selected,steps,
    executionStatus,hasIncompleteRequestedSteps,fullTextCoverage,
    sourceCoverage:selected?.useModel?sourceCoverage:null,
    sourceCoverageGaps:Array.isArray(observed?.sourceCoverageGaps)?structuredClone(observed.sourceCoverageGaps):[],
    qualityStatus:'unverified',qualityReason:'尚无独立内容质量确认；运行结束、低规则分或模型自证不代替确认',
    reviewedVersionId,currentWorkVersionId,currentWorkChanged:!!reviewedVersionId&&!!currentWorkVersionId&&reviewedVersionId!==currentWorkVersionId};
}

export function finalizeReviewCoverage(result,options){
  const coverage=buildReviewCoverage({result,options,purpose:options.purpose});
  return{...result,reviewOptions:{...coverage.options},reviewCoverage:coverage,completionStatus:coverage.executionStatus==='completed'?'completed':'partial'};
}
