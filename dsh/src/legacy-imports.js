/** Immutable legacy evidence and explicit source recovery. No model calls. */
import {readFile, mkdir, open, link, unlink, lstat, realpath} from 'node:fs/promises';
import {resolve, join, relative, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {sha256, saveWorkingVersion, loadWorkingVersion} from './working-version.js';
import {saveSessionSnapshot, loadSessionSnapshot} from './session-store.js';
import {saveWorkspace, loadWorkspace} from './workspace-store.js';
import {parseDocxBuffer} from './review.js';

const ROOT = resolve(process.env.DSH_LEGACY_ROOT || fileURLToPath(new URL('../data/legacy-imports/',import.meta.url)));
function fail(code,message) { const error = new Error(message); error.code=code; throw error; }
const flat = (name) => typeof name==='string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(name) && !name.includes('..');
const archiveIdValid = (id) => /^l[a-f0-9]{32}$/.test(id || '');
const attaching = new Map();
async function checkedFile(directory,name) {
  if (!flat(name)) fail('LEGACY_PATH_INVALID','历史文件名称无效');
  const path=join(directory,name), info=await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail('LEGACY_PATH_INVALID','历史文件类型无效');
  return readFile(path);
}
async function safeDirectory(root,id,create=false) {
  if (!archiveIdValid(id)) fail('LEGACY_ID_INVALID','历史记录身份无效');
  if (create) await mkdir(resolve(root),{recursive:true});
  const realRoot=await realpath(resolve(root)), path=join(realRoot,id);
  if (create) await mkdir(path,{recursive:true});
  const info=await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || relative(realRoot,await realpath(path))!==id) fail('LEGACY_PATH_INVALID','历史存储目录无效');
  return path;
}
async function immutableFile(path,bytes) {
  const temp=`${path}.${randomUUID()}.tmp`; let handle;
  try {
    handle=await open(temp,'wx'); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle=null;
    try { await link(temp,path); }
    catch(error) {
      if(error.code!=='EEXIST') throw error;
      const info=await lstat(path);
      if(!info.isFile()||info.isSymbolicLink())fail('LEGACY_PATH_INVALID','历史存储文件类型无效');
      const old=await readFile(path);
      if(!old.equals(bytes)) fail('LEGACY_IMMUTABLE_CONFLICT','历史存储已有不同内容，拒绝覆盖');
    }
  } finally { if(handle) await handle.close(); try{await unlink(temp);}catch(error){if(error.code!=='ENOENT')throw error;} }
}
const encode = (value) => Buffer.from(JSON.stringify(value,null,2)+'\n');

export async function readLegacyCapture(captureDirectory) {
  const directory=await realpath(resolve(captureDirectory));
  const info=await lstat(resolve(captureDirectory));
  if(!info.isDirectory() || info.isSymbolicLink()) fail('LEGACY_CAPTURE_INVALID','捕获目录类型无效');
  const completeBytes=await checkedFile(directory,'complete.json');
  const complete=JSON.parse(completeBytes.toString('utf8'));
  if(complete.schemaVersion!==1 || !Array.isArray(complete.files)) fail('LEGACY_CAPTURE_INVALID','捕获未完成');
  const files=new Map();
  for(const item of complete.files) {
    const name=item.file || item.path;
    if(['complete.json','capture.complete.json','archive.complete.json','review.json'].includes(name)) fail('LEGACY_CAPTURE_INVALID','捕获文件使用存储保留名称');
    if(files.has(name)) fail('LEGACY_CAPTURE_INVALID','重复捕获文件');
    const bytes=await checkedFile(directory,name);
    if(sha256(bytes)!==item.sha256) fail('LEGACY_CAPTURE_HASH','捕获文件校验失败');
    files.set(name,bytes);
  }
  if(!files.has('capture.json')) fail('LEGACY_CAPTURE_INVALID','捕获缺少身份记录');
  const capture=JSON.parse(files.get('capture.json').toString('utf8'));
  if(capture.schemaVersion!==1 || !/^http:\/\/127\.0\.0\.1:321[01]$/.test(capture.source?.base||'')
    || !/^s[a-z0-9]+$/.test(capture.source?.id||'')) fail('LEGACY_CAPTURE_INVALID','旧服务来源身份无效');
  if(complete.captureSha256 && complete.captureSha256!==sha256(files.get('capture.json'))) fail('LEGACY_CAPTURE_HASH','捕获完成标记身份不一致');
  let view=capture.requests?.session?.body?.result || null;
  if(!view && capture.offlineReview?.file) {
    const bytes=files.get(capture.offlineReview.file);
    if(!bytes || sha256(bytes)!==capture.offlineReview.sha256) fail('LEGACY_CAPTURE_HASH','离线审阅校验失败');
    view=JSON.parse(bytes.toString('utf8'));
  }
  return {directory,complete,completeBytes,capture,files,view};
}

async function storeArchive(input,legacyRoot) {
  const captureHash=sha256(input.files.get('capture.json')), id=`l${captureHash.slice(0,32)}`;
  const directory=await safeDirectory(legacyRoot,id,true);
  const files=[];
  for(const [name,bytes] of [...input.files].sort(([a],[b])=>a.localeCompare(b))) {
    await immutableFile(join(directory,name),bytes); files.push({file:name,sha256:sha256(bytes),bytes:bytes.length});
  }
  await immutableFile(join(directory,'capture.complete.json'),input.completeBytes);
  files.push({file:'capture.complete.json',sha256:sha256(input.completeBytes),bytes:input.completeBytes.length});
  const reviewBytes=encode(input.view);
  await immutableFile(join(directory,'review.json'),reviewBytes);
  files.push({file:'review.json',sha256:sha256(reviewBytes),bytes:reviewBytes.length});
  const manifest={schemaVersion:1,id,captureSha256:captureHash,source:input.capture.source,
    capturedAt:input.capture.capturedAt,files};
  await immutableFile(join(directory,'archive.complete.json'),encode(manifest));
  return manifest;
}

export async function loadLegacyReview({archiveId,storageRoot=ROOT}) {
  const directory=await safeDirectory(storageRoot,archiveId);
  const manifest=JSON.parse((await checkedFile(directory,'archive.complete.json')).toString('utf8'));
  if(manifest.schemaVersion!==1 || manifest.id!==archiveId || !Array.isArray(manifest.files)) fail('LEGACY_ARCHIVE_INVALID','历史记录完成身份不一致');
  const files=new Map();
  for(const entry of manifest.files) {
    const bytes=await checkedFile(directory,entry.file);
    if(files.has(entry.file)||sha256(bytes)!==entry.sha256) fail('LEGACY_ARCHIVE_HASH','历史文件校验失败');
    files.set(entry.file,bytes);
  }
  if(!files.has('capture.json') || !files.has('review.json')
    || sha256(files.get('capture.json'))!==manifest.captureSha256
    || archiveId!==`l${manifest.captureSha256.slice(0,32)}`) fail('LEGACY_ARCHIVE_HASH','历史捕获身份不一致');
  return {manifest,capture:JSON.parse(files.get('capture.json').toString('utf8')),
    view:JSON.parse(files.get('review.json').toString('utf8'))};
}

async function attachImportedSessionOnce({id,name,sourceSha256,workspaceId,workspaceRoot}) {
  for(let attempt=0;attempt<5;attempt++) {
    let stored;
    try {stored=await loadWorkspace({workspaceId,storageRoot:workspaceRoot});}
    catch(error) {
      if(error.code!=='WORKSPACE_NOT_FOUND'||error.missingPart!=='directory')throw error;
      stored={workspace:{id:workspaceId,entries:[],activeSessionId:null,
        queue:{state:'ready',cursorSessionId:null,options:null},receipts:{}},manifest:{revision:-1}};
    }
    if(stored.workspace.entries.some(entry=>entry.id===id))return {revision:stored.manifest.revision,replayed:true};
    const workspace=structuredClone(stored.workspace);
    workspace.entries.push({entryId:`emigration-${id}`,id,name,sourceSha256,addedAt:new Date().toISOString()});
    if(!workspace.activeSessionId)workspace.activeSessionId=id;
    try {
      const manifest=await saveWorkspace({workspaceId,workspace,expectedRevision:stored.manifest.revision,storageRoot:workspaceRoot});
      return {revision:manifest.revision,replayed:false};
    } catch(error) {
      if(error.committedManifest) {
        const saved=await loadWorkspace({workspaceId,storageRoot:workspaceRoot});
        if(saved.manifest.manifestSha256===error.committedManifest.manifestSha256)return {revision:saved.manifest.revision,replayed:true};
      }
      if(!['WORKSPACE_REVISION_CONFLICT','WORKSPACE_BUSY'].includes(error.code))throw error;
    }
  }
  fail('LEGACY_WORKSPACE_CONFLICT','迁移记录已保存，队列登记冲突；可重试同一捕获');
}

async function attachImportedSession(options) {
  // Serialize local bootstrap/read/CAS, so a sibling importer cannot mistake a
  // directory being initialized by this importer for an already damaged state.
  // Cross-process conflicts still use storage CAS; missing persisted state is
  // never reset to an empty workspace.
  const key=`${resolve(options.workspaceRoot || '.')}|${options.workspaceId}`;
  const previous=attaching.get(key);
  const operation=(previous || Promise.resolve()).catch(()=>{}).then(()=>attachImportedSessionOnce(options));
  attaching.set(key,operation);
  try{return await operation;}
  finally{if(attaching.get(key)===operation)attaching.delete(key);}
}

/** Import bytes and history; an old review never becomes a current run. */
export async function importLegacyCapture({captureDirectory,legacyRoot=ROOT,versionRoot,sessionRoot,workspaceRoot,
  workspaceId='wlegacy',oldVersionRoot,purpose='legacy-unknown'}) {
  const input=await readLegacyCapture(captureDirectory), cap=input.capture;
  const archive=await storeArchive(input,legacyRoot), id=`slegacy${archive.id.slice(1)}`;
  const originalInfo=cap.requests?.original, workingInfo=cap.requests?.working;
  for(const info of [originalInfo,workingInfo]) if(info?.status===200
    && (!flat(info.file)||!input.files.has(info.file)||!/^[a-f0-9]{64}$/.test(info.sha256||'')))
    fail('LEGACY_BYTES_MISSING','历史接口声明成功但文件未完整捕获，拒绝推断恢复');
  let original=originalInfo?.status===200 && originalInfo.file ? input.files.get(originalInfo.file) : null;
  const verifiedSource=cap.sourceDoc?.verified===true && input.files.get(cap.sourceDoc.file);
  if(verifiedSource && sha256(verifiedSource)!==cap.sourceDoc.sha256)fail('LEGACY_SOURCE_HASH','已登记原稿校验失败');
  if(!original)original=verifiedSource;
  if(!original)fail('LEGACY_BYTES_MISSING','历史已归档，缺少可验证原稿，不能创建当前稿');
  const observedWorking=workingInfo?.status===200 && workingInfo.file ? input.files.get(workingInfo.file) : null;
  if(originalInfo?.status===200 && sha256(original)!==originalInfo.sha256)fail('LEGACY_SOURCE_HASH','历史原稿校验失败');
  if(observedWorking && sha256(observedWorking)!==workingInfo.sha256)fail('LEGACY_SOURCE_HASH','历史工作文件校验失败');
  const working=observedWorking || original;
  const sourceHash=sha256(original), workHash=sha256(working);
  const name=cap.source.name || cap.candidate?.names?.[0] || basename(cap.sourceFile?.path||'历史稿件.docx');
  const consistent=observedWorking ? cap.consistency?.vectorsEqual===true ? 'verified' : cap.consistency?.vectorsEqual===false ? 'mismatch' : 'unknown' : 'unknown';
  const legacy={available:true,archiveId:archive.id,sourceBase:cap.source.base,sourceSessionId:cap.source.id,
    capturedAt:cap.capturedAt,historyAvailable:!!input.view,consistency:consistent,
    recoveryKind:observedWorking?'captured-working-file':'verified-source-reimport',
    historicalWorkingAvailable:!!observedWorking,sourceVerified:!!verifiedSource && sourceHash===cap.sourceDoc.sha256,
    sourcePath:cap.sourceFile?.path||null,sourceSha256:sourceHash,importedWorkSha256:workHash,purpose,
    reason:observedWorking ? consistent==='verified'?'历史保存文件已核对；清洗仍待当前验证':'历史页面与保存文件存在差异或缺少对照，已独立保留'
      :'旧会话文件已不可取，当前稿从已核对原稿重新接入；历史工作文件及内存修改未推断恢复'};
  let existing;
  try {existing=await loadSessionSnapshot({sessionId:id,storageRoot:sessionRoot});}
  catch(error){if(error.code!=='SESSION_NOT_FOUND')throw error;}
  if(existing) {
    if(existing.snapshot.legacy?.archiveId!==archive.id || existing.snapshot.workVersion.sourceSha256!==sourceHash)fail('LEGACY_SESSION_CONFLICT','迁移身份已存在不同来源');
    await attachImportedSession({id,name,sourceSha256:sourceHash,workspaceId,workspaceRoot});
    return {id,archiveId:archive.id,replayed:true,legacy:existing.snapshot.legacy,workVersion:existing.snapshot.workVersion};
  }
  const declared=cap.requests?.session?.body?.workVersion;
  let ancestors=[];
  if(observedWorking && declared?.id) {
    const seen=new Set(); let cursor=declared.id;
    while(cursor) {
      if(seen.has(cursor)||ancestors.length>1000)fail('LEGACY_HISTORY_INVALID','历史工作版本父链无效');
      seen.add(cursor);
      const saved=await loadWorkingVersion({sessionId:cap.source.id,versionId:cursor,storageRoot:oldVersionRoot});
      if(saved.version.sourceSha256!==sourceHash)fail('LEGACY_HISTORY_INVALID','历史父版本不属于同一原稿');
      ancestors.unshift(saved); cursor=saved.version.parentId;
    }
    if(sha256(ancestors.at(-1).buffer)!==workHash)fail('LEGACY_HISTORY_INVALID','历史文件与当前父链不一致');
  } else ancestors=[{buffer:working,version:{id:null,patches:[],operation:legacy.recoveryKind}}];
  const versionMap=new Map(), entries=[]; let parent=null, cumulative=[];
  for(const [revision,ancestor] of ancestors.entries()) {
    const patches=(ancestor.version.patches||[]).map(patch=>({...patch,
      sourceVersionId:versionMap.get(patch.sourceVersionId) || patch.sourceVersionId}));
    const version=await saveWorkingVersion({sessionId:id,name,buffer:ancestor.buffer,originalBuffer:original,
      parent,patches,operation:revision?'legacy-history-save':'import-legacy',revision,storageRoot:versionRoot});
    if(ancestor.version.id)versionMap.set(ancestor.version.id,version.id);
    const mapped=patches.map(patch=>({...patch,fromVersionId:parent?.id||version.id,toVersionId:version.id}));
    cumulative=[...cumulative,...mapped]; entries.push({versionId:version.id,appliedFixes:structuredClone(cumulative)}); parent=version;
  }
  legacy.importedVersionMap=Object.fromEntries(versionMap); legacy.restoredHistorySteps=entries.length-1;
  const originalDoc=parseDocxBuffer(original,name), currentDoc=parseDocxBuffer(working,name);
  const session={id,name,workVersion:parent,sourceComments:originalDoc.comments||[],
    clean:{status:'legacy-unverified',reason:'历史文件的清洗尚未验证，请先验证清洗',originalCommentCount:originalDoc.comments?.length||0,
      sourceSha256:sourceHash,workSha256:workHash},legacy,result:null,reviewRecords:[],
    reviewRunning:false,reviewRunId:null,resultRunId:null,reviewError:null,
    history:{entries,cursor:entries.length-1},appliedFixes:cumulative,mutationEpoch:0,maxVersionRevision:parent.revision,
    humanRecords:[],humanRevision:0,createdAt:Date.now(),lastUsed:Date.now()};
  // Reparse before publishing, but do not store runtime XML objects.
  if(!currentDoc.paragraphs?.length)fail('LEGACY_PARSE_INVALID','当前文件没有可读正文');
  try {await saveSessionSnapshot({sessionId:id,snapshot:session,expectedRevision:-1,storageRoot:sessionRoot});}
  catch(error) {
    if(!error.committedManifest && error.code!=='SESSION_REVISION_CONFLICT')throw error;
    const saved=await loadSessionSnapshot({sessionId:id,storageRoot:sessionRoot});
    if(saved.snapshot.legacy?.archiveId!==archive.id || saved.snapshot.workVersion.sourceSha256!==sourceHash
      || error.committedManifest && saved.manifest.manifestSha256!==error.committedManifest.manifestSha256)throw error;
  }
  await attachImportedSession({id,name,sourceSha256:sourceHash,workspaceId,workspaceRoot});
  return {id,archiveId:archive.id,replayed:false,legacy,workVersion:parent};
}
