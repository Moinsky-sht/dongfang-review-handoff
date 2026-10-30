/** Offline explicit migration of a sealed capture selection. Never calls a model. */
import {readFile, writeFile, mkdir, lstat, appendFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {importLegacyCapture, loadLegacyReview} from '../src/legacy-imports.js';
import {loadSessionSnapshot} from '../src/session-store.js';
import {loadWorkingVersion, sha256} from '../src/working-version.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const arg=(name,fallback)=>process.argv.find((value)=>value.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const indexPath=arg('index'), outputPath=arg('out');
if(!indexPath||!outputPath)throw new Error('Require --index=<sealed selection> and a fresh --out=<report.json>');
const OUT=resolve(outputPath), EVENTS=OUT.replace(/\.json$/i,'')+'.events.jsonl';
if(existsSync(OUT)||existsSync(EVENTS))throw new Error('Migration evidence already exists; select a fresh output path');
const options={workspaceId:arg('workspace','wlegacy'),
  legacyRoot:resolve(arg('legacy-root',process.env.DSH_LEGACY_ROOT||join(ROOT,'data/legacy-imports'))),
  versionRoot:resolve(arg('version-root',process.env.DSH_WORKING_VERSION_ROOT||join(ROOT,'data/working-versions'))),
  sessionRoot:resolve(arg('session-root',process.env.DSH_SESSION_ROOT||join(ROOT,'data/sessions'))),
  workspaceRoot:resolve(arg('workspace-root',process.env.DSH_WORKSPACE_ROOT||join(ROOT,'data/workspaces'))),
  oldVersionRoot:resolve(arg('old-version-root',join(ROOT,'data/working-versions')))};
if(!/^w[a-z0-9_-]{1,80}$/.test(options.workspaceId))throw new Error('Invalid migration workspace');
const indexBytes=await readFile(resolve(indexPath)), index=JSON.parse(indexBytes.toString('utf8'));
if(index.schemaVersion!==1||!Array.isArray(index.importCandidates)||!index.importCandidates.length)throw new Error('Invalid sealed capture selection');
const seen=new Set();
for(const candidate of index.importCandidates){
  const key=`${candidate.selectedBase}|${candidate.id}`;
  if(seen.has(key))throw new Error('Duplicate historical session selection');seen.add(key);
  for(const [name,expected] of [[candidate.captureFile,candidate.captureSha256],[candidate.completeFile,candidate.completeSha256]]){
    const info=await lstat(resolve(name));
    if(!info.isFile()||info.isSymbolicLink()||!/^([a-f0-9]{64})$/.test(expected||'')||sha256(await readFile(resolve(name)))!==expected)
      throw new Error('Selected capture identity/hash does not match sealed index');
  }
  if(dirname(resolve(candidate.captureFile))!==dirname(resolve(candidate.completeFile)))throw new Error('Selection mixes capture directories');
}
await mkdir(dirname(OUT),{recursive:true});
const report={schemaVersion:1,startedAt:new Date().toISOString(),indexPath:resolve(indexPath),indexSha256:sha256(indexBytes),
  options,realArkCalls:0,policy:'Raw historical view is read-only; current result remains empty. Source-only recovery never claims historical working bytes.',
  fingerprints:Object.fromEntries(await Promise.all(['src/legacy-imports.js','tools/migrate-legacy-sessions.mjs'].map(async(file)=>[file,sha256(await readFile(join(ROOT,file)))]))),
  entries:[],ok:false};
try {
  for(const candidate of index.importCandidates){
    const imported=await importLegacyCapture({...options,captureDirectory:dirname(resolve(candidate.captureFile)),purpose:candidate.sourcePurpose});
    const saved=await loadSessionSnapshot({sessionId:imported.id,storageRoot:options.sessionRoot});
    const current=await loadWorkingVersion({sessionId:imported.id,versionId:saved.snapshot.workVersion.id,storageRoot:options.versionRoot});
    const archive=await loadLegacyReview({archiveId:imported.archiveId,storageRoot:options.legacyRoot});
    if(archive.manifest.captureSha256!==candidate.captureSha256||saved.snapshot.legacy.archiveId!==imported.archiveId)
      throw new Error('Migration readback identity mismatch');
    if(!imported.replayed&&(saved.snapshot.result!==null||saved.snapshot.reviewRunning||saved.snapshot.clean.status!=='legacy-unverified'))
      throw new Error('Imported history was promoted into current review or cleaning state');
    const history=[];
    for(const entry of saved.snapshot.history.entries){
      const step=await loadWorkingVersion({sessionId:imported.id,versionId:entry.versionId,storageRoot:options.versionRoot});
      history.push({versionId:entry.versionId,sha256:sha256(step.buffer),sourceSha256:sha256(step.originalBuffer),appliedFixCount:entry.appliedFixes.length});
    }
    const entry={sourceSessionId:candidate.id,sourceBase:candidate.selectedBase,purpose:candidate.sourcePurpose,
      ...imported,readback:{storeRevision:saved.manifest.revision,manifestSha256:saved.manifest.manifestSha256,
        sourceSha256:sha256(current.originalBuffer),workSha256:sha256(current.buffer),currentResultAvailable:!!saved.snapshot.result,
        cleanStatus:saved.snapshot.clean.status,historicalViewAvailable:!!archive.view,history}};
    report.entries.push(entry);await appendFile(EVENTS,JSON.stringify({at:new Date().toISOString(),event:'legacy-import-readback',...entry})+'\n');
    console.log(`Imported ${report.entries.length}/${index.importCandidates.length}: ${imported.id} (${imported.legacy.recoveryKind})`);
  }
  report.ok=true;
}catch(error){report.error={code:error.code||null,message:error.message};process.exitCode=1;}
finally {report.completedAt=new Date().toISOString();await writeFile(OUT,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(`Evidence: ${OUT}`);}
