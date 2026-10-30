import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,realpath,lstat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import { rebaseIssueAnchors } from '../src/working-anchors.js';

const SCRIPT=fileURLToPath(import.meta.url),PROJECT=resolve(dirname(SCRIPT),'..');
const inherited=process.env.DSH_VERIFICATION_EVIDENCE_DIR;
const explicit=process.argv.find(a=>a.startsWith('--evidence-root='))?.slice('--evidence-root='.length);
const base=resolve(explicit||inherited||join(PROJECT,'data/verify/working-anchors'));
const within=(root,p)=>{const r=relative(root,p);return r===''||(!isAbsolute(r)&&!r.startsWith('..'));};
assert(within(join(PROJECT,'data/verify'),base)||within(join(PROJECT,'data/optimization/runs'),base),'Evidence must be inside project verification or optimization runs');
for(let cursor=base;;cursor=dirname(cursor)){assert(!existsSync(join(cursor,'complete.json')),`Sealed ancestor ${cursor}`);if(existsSync(cursor)){const stat=await lstat(cursor);assert(stat.isDirectory()&&!stat.isSymbolicLink());assert.equal(resolve(await realpath(cursor)),cursor,'Alias ancestor refused');}if(dirname(cursor)===cursor)break;}
await mkdir(base,{recursive:true});const OUT=join(base,`working-anchors-${Date.now()}-${randomUUID()}`);await mkdir(OUT);
const roots=Object.fromEntries(['sessions','versions','workspaces','audit','legacy','ingestions','jobs'].map(n=>[n,join(OUT,'fixture-roots',n)]));for(const p of Object.values(roots))await mkdir(p,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex'),moduleFile=join(PROJECT,'src/working-anchors.js'),sourceBytes=await readFile(moduleFile),sourceBefore=sha(sourceBytes);
await writeFile(join(OUT,'working-anchors.js.before'),sourceBytes,{flag:'wx'});await writeFile(join(OUT,'test-source.mjs'),await readFile(SCRIPT),{flag:'wx'});
let deniedNetworkAttempts=0;globalThis.fetch=()=>{deniedNetworkAttempts++;throw Error('Pure working-anchor fixture forbids network/model requests');};
const anchor = (start, text, target = 'paragraph', index = 0) => ({ target, index, start, end: start + text.length, text, precision: 'exact' });
const issue = (ruleId, start, text, extras = {}) => ({ ruleId, location: 'paragraph:0', quote: text,
  autoFix: { find: text, replace: 'new', offset: start }, ...extras,
  anchors: [anchor(start, text)], anchor: anchor(start, text) });
const key = (it) => `${it.ruleId}|${it.location}|${it.quote || ''}`;
const patch = (sourceOffset, find, replace, extras = {}) => ({ patchId: `p${sourceOffset}`, target: 'body', index: 0,
  sourceVersionId: 'v0', sourceOffset, find, replace, ...extras });
const doc = (text, extras = {}) => ({ paragraphs: [{ text }], ...extras });
const rebase = (issues, text, patches) => rebaseIssueAnchors(issues, doc(text), patches, 'v0');
let count = 0;
const checks=[];
const test = (name, fn) => { try { const detail=fn(); count += 1; checks.push({name,ok:true,detail:detail??null});console.log(`✓ ${name}`); } catch(error) { checks.push({name,ok:false,error:{name:error.name,message:error.message,stack:error.stack}});console.error(`✗ ${name}: ${error.message}`); } };

test('repeated phrases retain the original occurrence after a long replacement', () => {
  const source = issue('B', 6, 'XYZ');
  const [mapped] = rebase([source], 'LONGERXYZXYZ', [patch(0, 'bad', 'LONGER')]);
  assert.equal(mapped.anchor.start, 9); assert.equal(mapped.anchor.end, 12); assert.equal(mapped.anchor.text, 'XYZ');
  assert.equal(mapped.needsRelocation, false); assert.deepEqual(mapped.autoFix, source.autoFix);
  assert.equal(source.anchor.start, 6, 'source issue remains immutable');
});

test('multiple requests use source offsets instead of transformed current offsets', () => {
  const [mapped] = rebase([issue('C', 6, 'cc')], 'LONG- BIGGER- cc', [
    patch(0, 'aa', 'LONG-', { offset: 0 }), patch(3, 'bb', 'BIGGER-', { offset: 6 }),
  ]);
  assert.equal(mapped.anchor.start, 14); assert.equal(mapped.anchor.text, 'cc');
  assert.equal(mapped.needsRelocation, false);
});

test('applied exact ranges map replacement text and verified deletions', () => {
  const changed = issue('A', 0, 'bad');
  const [mapped] = rebase([changed], 'LONGERXYZ', [patch(0, 'bad', 'LONGER', { key: key(changed) })]);
  assert.equal(mapped.anchor.start, 0); assert.equal(mapped.anchor.end, 6); assert.equal(mapped.anchor.text, 'LONGER');
  assert.deepEqual(mapped.autoFix, changed.autoFix); assert.equal(mapped.quote, 'bad');
  const [deleted] = rebase([changed], 'XYZ', [patch(0, 'bad', '', { key: key(changed) })]);
  assert.equal(deleted.anchor.start, 0); assert.equal(deleted.anchor.end, 0); assert.equal(deleted.anchor.text, '');
  assert.equal(deleted.needsRelocation, false);
});

test('partial grouped application maps every occurrence without completing it', () => {
  const grouped = issue('G', 0, 'bad');
  grouped.anchors = [anchor(0, 'bad'), { ...anchor(4, 'bad'), occurrence: true }, { ...anchor(8, 'bad'), occurrence: true }];
  grouped.occurrences = [{ offset: 0 }, { offset: 4 }, { offset: 8 }];
  const [mapped] = rebase([grouped], 'LONGER|bad|bad', [patch(0, 'bad', 'LONGER', { key: key(grouped) })]);
  assert.deepEqual(mapped.anchors.map((a) => [a.start, a.text]), [[0, 'LONGER'], [7, 'bad'], [11, 'bad']]);
  assert.equal(mapped.anchor, mapped.anchors[0]); assert.deepEqual(mapped.occurrences, grouped.occurrences);
  assert.equal(mapped.needsRelocation, false); assert.ok(!Object.hasOwn(mapped, 'resolved'));
});

test('overlapping unresolved range invalidates the complete grouped issue', () => {
  const source = issue('B', 1, 'adXYZ');
  source.anchors.push(anchor(9, 'XYZ'));
  const [mapped] = rebase([source], 'LONGERXYZXYZ', [patch(0, 'bad', 'LONGER', { key: 'other' })]);
  assert.deepEqual(mapped.anchors, []); assert.equal(mapped.anchor, null); assert.equal(mapped.needsRelocation, true);
  assert.equal(mapped.relocationReason, 'changed_range');
  const exactOther = rebase([issue('B', 0, 'bad')], 'LONGERXYZ', [patch(0, 'bad', 'LONGER', { key: 'other' })])[0];
  assert.equal(exactOther.needsRelocation, true);
});

test('stale text never searches for another identical phrase', () => {
  const source = issue('B', 3, 'XYZ');
  const [mapped] = rebase([source], 'badABCXYZ', []);
  assert.equal(mapped.needsRelocation, true); assert.equal(mapped.relocationReason, 'text_mismatch');
  assert.equal(mapped.anchor, null); assert.deepEqual(mapped.anchors, []);
});

test('footnote/endnote coordinates and versions remain separate', () => {
  const foot = issue('F', 3, 'XYZ'); foot.anchors = [anchor(3, 'XYZ', 'footnote')];
  const end = issue('E', 3, 'XYZ'); end.anchors = [anchor(3, 'XYZ', 'endnote')];
  const current = doc('badXYZ', { footnotes: [{ text: 'LONGERXYZ' }], endnotes: [{ text: 'badXYZ' }] });
  const mapped = rebaseIssueAnchors([foot, end], current, [patch(0, 'bad', 'LONGER', { target: 'footnote' }),
    patch(0, 'bad', 'LONGER', { target: 'endnote', sourceVersionId: 'older' })], 'v0');
  assert.equal(mapped[0].anchor.start, 6); assert.equal(mapped[1].anchor.start, 3);
  assert.ok(mapped.every((it) => !it.needsRelocation));
});

test('unverifiable/overlapping histories fail safely; duplicate verified record does not shift twice', () => {
  const source = issue('B', 6, 'XYZ');
  const unknown = rebase([source], 'LONGERXYZXYZ', [patch(undefined, 'bad', 'LONGER')])[0];
  assert.equal(unknown.relocationReason, 'invalid_history');
  const overlap = rebase([source], 'LONGERXYZXYZ', [patch(0, 'bad', 'LONGER'), patch(1, 'ad', 'q')])[0];
  assert.equal(overlap.relocationReason, 'invalid_history');
  const p = patch(0, 'bad', 'LONGER');
  const duplicate = rebase([source], 'LONGERXYZXYZ', [p, structuredClone(p)])[0];
  assert.equal(duplicate.anchor.start, 9); assert.equal(duplicate.needsRelocation, false);
});

test('no-patch return is deeply cloned; document/table anchors are retained', () => {
  const source = issue('A', 0, 'bad');
  source.occurrences = [{ autoFix: { find: 'bad', replace: 'good', offset: 0 } }];
  const structural = { ruleId: 'S', anchors: [{ target: 'document', index: 0, start: 0, end: 0, text: '', precision: 'document' }] };
  const mapped = rebase([source, structural], 'bad', []);
  mapped[0].autoFix.find = 'mutated'; mapped[0].occurrences[0].autoFix.find = 'mutated';
  assert.equal(source.autoFix.find, 'bad'); assert.equal(source.occurrences[0].autoFix.find, 'bad');
  assert.equal(mapped[1].anchor.target, 'document');
});

test('unresolved document/table placeholders remain rejected after a valid unrelated patch', () => {
  const inputs=[];
  for(const target of ['document','table'])for(const status of ['ambiguous','unmapped','unresolved'])inputs.push({issueKey:`software:${target}:${status}`,ruleId:'MODEL',location:'document',quote:'missing',needsRelocation:true,modelSourceResolution:{status},anchors:[{target,index:0,start:0,end:0,text:'',precision:'none',resolutionStatus:status}]});
  const before=structuredClone(inputs),mapped=rebase(inputs,'good',[patch(0,'bad','good',{key:'software:other'})]);
  for(const [i,it]of mapped.entries()){assert.equal(it.issueKey,inputs[i].issueKey);assert.equal(it.needsRelocation,true);assert.equal(it.relocationReason,'unresolved_source_range');assert.equal(it.anchor,null);assert.deepEqual(it.anchors,[]);assert.equal(it.modelSourceResolution.status,inputs[i].modelSourceResolution.status);}
  assert.deepEqual(inputs,before);return {targets:2,statuses:3,allRejected:true,keys:mapped.map(it=>it.issueKey)};
});

test('no patch history cannot promote unresolved document/table navigation to located', () => {
  for(const target of ['document','table'])for(const status of ['ambiguous','unmapped','unresolved']){
    const source={issueKey:`software:no-patch:${target}:${status}`,needsRelocation:true,anchor:{target,index:0,start:0,end:0,text:'',precision:'none',resolutionStatus:status}};
    const [mapped]=rebase([source],'unchanged',[]);assert.equal(mapped.needsRelocation,true);assert.equal(mapped.relocationReason,'unresolved_source_range');assert.equal(mapped.issueKey,source.issueKey);assert.equal(mapped.anchor,null);assert.deepEqual(mapped.anchors,[]);
  }return {emptyHistoryControls:6};
});

test('legal document/table navigation remains available without fabricating exact character proof', () => {
  for(const target of ['document','table'])for(const status of [undefined,target]){
    const navigation={target,index:0,start:0,end:0,text:'',precision:target,...(status?{resolutionStatus:status}:{})},source={issueKey:`software:legal:${target}:${status||'legacy'}`,needsRelocation:false,anchor:navigation};
    const [mapped]=rebase([source],'unchanged',[]);assert.equal(mapped.issueKey,source.issueKey);assert.equal(mapped.needsRelocation,false);assert.deepEqual(mapped.anchor,navigation);assert.equal(mapped.anchor.precision,target);assert.equal(mapped.anchor.rangeProof,undefined);
  }return {legalNavigationControls:4};
});

test('one unresolved occurrence rejects the whole grouped issue and retains its parent identity', () => {
  for(const patches of [[],[patch(0,'bad','good',{key:'software:group'})]]){
    const source={...issue('GROUP',0,'bad'),issueKey:'software:group',needsRelocation:true,occurrences:[{offset:0},{location:'document',resolutionStatus:'unmapped'}],anchors:[anchor(0,'bad'),{target:'document',index:0,start:0,end:0,text:'',precision:'none',resolutionStatus:'unmapped'}]},before=structuredClone(source);
    const [mapped]=rebase([source],patches.length?'good':'bad',patches);assert.equal(mapped.issueKey,source.issueKey);assert.equal(mapped.needsRelocation,true);assert.equal(mapped.relocationReason,'unresolved_source_range');assert.equal(mapped.anchor,null);assert.deepEqual(mapped.anchors,[]);assert.deepEqual(mapped.occurrences,source.occurrences);assert.deepEqual(source,before);
  }return {emptyAndCommittedHistory:true,wholeGroupRejected:true};
});

test('issues without any source anchor stay unresolved and are deeply cloned with no patches', () => {
  const source={issueKey:'software:no-anchor',needsRelocation:true,modelSourceDeclaration:{paragraphIndex:99},modelSourceResolution:{status:'unmapped'},anchors:[],anchor:null};
  const [mapped]=rebase([source],'unchanged',[]);assert.equal(mapped.needsRelocation,true);assert.equal(mapped.issueKey,source.issueKey);assert.equal(mapped.anchor,null);assert.deepEqual(mapped.anchors,[]);mapped.modelSourceDeclaration.paragraphIndex=0;assert.equal(source.modelSourceDeclaration.paragraphIndex,99);return {noLocationInvented:true};
});

const sourceAfter=sha(await readFile(moduleFile));assert.equal(sourceAfter,sourceBefore,'Working-anchor source changed during test');assert.equal(deniedNetworkAttempts,0);
const report={schemaVersion:1,at:new Date().toISOString(),mode:process.argv.find(a=>a.startsWith('--mode='))?.slice(7)||'current',scope:'Pure generated working-anchor rebase and unresolved-navigation controls; no semantic judgment',ok:checks.every(c=>c.ok),passed:count,failed:checks.filter(c=>!c.ok).length,checks,roots,sourceBefore:{'src/working-anchors.js':sourceBefore},sourceAfter:{'src/working-anchors.js':sourceAfter},testSha256:sha(await readFile(SCRIPT)),realArkCalls:0,modelCalls:0,networkRequests:0,servicesStarted:0,qualityPromoted:false};
await writeFile(join(OUT,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({report:join(OUT,'report.json'),sha256:sha(await readFile(join(OUT,'report.json'))),passed:count,failed:report.failed,realArkCalls:0}));
console.log(`Working anchors: ${count}/${checks.length} scenarios passed; no model API calls.`);if(!report.ok)process.exitCode=1;
