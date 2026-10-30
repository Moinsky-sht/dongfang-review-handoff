/** 当前工作版本前端回归：仅用本地响应替身，不启动服务或调用模型。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
assert.match(html, /id="btnWorkingDocx"/);
assert.match(html, /导出当前修改稿/);

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const noops = ['renderDocInfo', 'renderMarkupIssues', 'renderMarkupStats', 'highlightIssuesInDoc',
  'markHeadingLevels', 'wireCitations', 'updateApplyBtn', 'clearMarks', 'indexRenderedParagraphs',
  'markTitleParagraph', 'normalizeReaderFormatting', 'renderFigures', 'reapplyHumanMarks', 'initHeadingSpy'];
function harness() {
  const elements = new Map();
  const downloads = [];
  const makeElement = () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    textContent: '', innerHTML: '', disabled: false, childNodes: [], dataset: {},
    querySelector: () => null, querySelectorAll: () => [],
    replaceChildren(...children) { this.childNodes = children; },
    click() { if (this.download) downloads.push(this.download); },
  });
  const sandbox = {
    document: {
      querySelector: (id) => { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
      querySelectorAll: () => [], addEventListener() {}, createElement: makeElement,
    },
    window: { matchMedia: () => ({ matches: false }) }, fetch: () => { throw new Error('Unexpected fetch'); },
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} }, URLSearchParams,
    Blob, TextEncoder, crypto: webcrypto, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  runInNewContext(source + `\n
    globalThis.realIssueRender = renderMarkupIssues;
    globalThis.realStatsRender = renderMarkupStats;
    ${noops.map((name) => `${name} = () => {};`).join('\n')}
    renderRecheck = () => {};
    globalThis.api = { state, rendered, documentRenderSignature, renderDocument, replayAppliedFixes,
      postApplyFixes, loadWorkingVersion, exportWorkingDocx, exportDocx, exportReport, issueKey, isFixable,
      selectIssue, scrollToIssueInDoc, applyFixOne, renderMarkupIssues: realIssueRender,
      renderMarkupStats: realStatsRender };
    globalThis.replacements = 0;
    replaceTextInDom = () => { replacements += 1; return true; };
    fixDomTarget = () => ({});
    syncDocText = () => { throw new Error('Server document must not be modified twice'); };
    globalThis.stubRender = () => { renderDocument = async () => { renderSnapshots.push({
      sessionId: state.sessionId, version: state.workVersion, buffer: state.buffer }); }; };
    globalThis.renderSnapshots = [];
  `, sandbox, { filename: 'public/app.js' });
  const { state } = sandbox.api;
  Object.assign(state, { sessionId: 'A', reviewRunId: 'run-A', buffer: new Uint8Array([1]).buffer,
    workVersion: { id: 'A-v0', revision: 0, sha256: 'old' },
    doc: { meta: { title: '稿件甲' }, paragraphs: [{ text: 'a' }], footnotes: [] },
    // Saving tests submit a real selectable software issue, rather than a key
    // absent from the current review. The entry guard rejects absent keys now.
    issues: [{ issueKey: 'FMT|paragraph:0|a', ruleId: 'FMT', group: 'format', severity: '中', title: '软件修改探针',
      autoFix: { find: 'a', replace: 'aa', offset: 0 },
      anchor: { target: 'paragraph', index: 0, start: 0, end: 1, text: 'a', resolutionStatus: 'resolved' } }], queue: [], showOriginal: false });
  return { sandbox, api: sandbox.api, elements, downloads };
}
const newVersion = { id: 'A-v1', revision: 1, sha256: 'new' };
const changedDoc = { meta: { title: '稿件甲' }, paragraphs: [{ text: 'aa' }], footnotes: [{ text: 'updated note' }] };
const applied = { key: 'FMT|paragraph:0|a', target: 'paragraph', index: 0, find: 'a', replace: 'aa', offset: 0 };
const reply = { reviewRunId: 'run-A', applied: [applied], skipped: [], doc: changedDoc, workVersion: newVersion,
  appliedFixes: [applied.key], appliedFixDetails: [applied] };
const jsonResponse = (value, ok = true) => ({ ok, status: ok ? 200 : 409, json: async () => value });
const bytesResponse = (bytes, versionId = newVersion.id) => ({ ok: true,
  headers: { get: (name) => name.toLowerCase() === 'x-work-version' ? versionId : null },
  arrayBuffer: async () => bytes });
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`✓ ${name}`); }

await check('渲染签名区分工作版本，原稿签名不随工作版本改变', () => {
  const { api } = harness();
  const original = api.documentRenderSignature();
  api.state.workVersion = newVersion;
  assert.notEqual(api.documentRenderSignature(), original);
  api.state.showOriginal = true;
  const originalSignature = api.documentRenderSignature();
  api.state.workVersion = { ...newVersion, revision: 2, id: 'A-v2' };
  assert.equal(api.documentRenderSignature(), originalSignature);
});
await check('新版字节不再回放修改，旧服务仍能回放', () => {
  const { sandbox, api } = harness();
  api.state.appliedFixDetails = [applied];
  api.replayAppliedFixes({});
  assert.equal(sandbox.replacements, 0);
  api.state.workVersion = null;
  api.replayAppliedFixes({});
  assert.equal(sandbox.replacements, 1);
});
await check('保存请求带基础版本，预览采用完整服务端文档和字节', async () => {
  const { sandbox, api } = harness();
  const calls = [];
  const bytes = new Uint8Array([9, 8, 7]).buffer;
  sandbox.stubRender();
  sandbox.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return url === '/api/apply-fixes' ? jsonResponse(reply) : bytesResponse(bytes);
  };
  await api.postApplyFixes([applied.key], { single: true });
  assert.equal(JSON.parse(calls[0].opts.body).baseVersionId, 'A-v0');
  assert.equal(JSON.parse(calls[0].opts.body).baseReviewRunId, 'run-A');
  assert.equal(calls[1].url, '/api/session-file?id=A');
  assert.equal(api.state.doc, changedDoc);
  assert.equal(api.state.workVersion, newVersion);
  assert.equal(api.state.buffer, bytes);
  assert.ok(api.state.resolved.has(applied.key));
  assert.equal(sandbox.replacements, 0);
  assert.equal(sandbox.renderSnapshots.length, 1);
});
await check('长文字修改后采用新锚点及定位统计，并同步队列结果', async () => {
  const { sandbox, api } = harness();
  const oldIssue = { ruleId: 'FMT', location: 'paragraph:0', quote: 'repeat', issueKey: 'stable-remaining',
    anchor: { target: 'paragraph', index: 0, start: 2, end: 8, text: 'repeat' } };
  const movedIssue = { ...oldIssue, anchor: { ...oldIssue.anchor, start: 19, end: 25 } };
  movedIssue.anchors = [movedIssue.anchor];
  const result = { issues: [movedIssue], anchorStats: { issues: 1, exact: 1, marks: 1 }, summary: { total: 1 } };
  api.state.issues = [...api.state.issues, oldIssue];
  api.state.anchorStats = { issues: 1, exact: 0 };
  api.state.queue = [{ id: 'A', result: { issues: [oldIssue] } }];
  sandbox.stubRender();
  sandbox.fetch = async (url) => url === '/api/apply-fixes' ? jsonResponse({ ...reply, result })
    : bytesResponse(new Uint8Array([9]).buffer);
  await api.postApplyFixes([applied.key]);
  assert.equal(api.state.issues, result.issues);
  assert.equal(api.state.issues[0].anchor.start, 19);
  assert.equal(api.state.anchorStats, result.anchorStats);
  assert.equal(api.state.queue[0].result, result);
  assert.equal(api.issueKey(api.state.issues[0]), 'stable-remaining');
});
await check('需重新定位的问题保留在清单和详情，并停止自动修改', async () => {
  const { sandbox, api, elements } = harness();
  const issue = { issueKey: 'relocation-needed', ruleId: 'FMT', group: 'format', severity: '中',
    location: 'paragraph:0', quote: 'repeat', title: '剩余问题', message: '仍待确认',
    needsRelocation: true, relocationReason: '原范围与修改重叠', anchors: [], anchor: null,
    autoFix: { find: 'repeat', replace: 'fixed' } };
  api.state.issues = [issue];
  api.state.summary = { total: 1, byGroup: {}, bySeverity: {} };
  api.state.anchorStats = { issues: 1, exact: 0, none: 1 };
  let fetches = 0;
  sandbox.fetch = async () => { fetches += 1; throw new Error('Must not edit unknown location'); };
  api.renderMarkupIssues();
  api.renderMarkupStats();
  assert.match(elements.get('#mkIssues').innerHTML, /需重新定位/);
  assert.doesNotMatch(elements.get('#mkIssues').innerHTML, /class="issue-fix/);
  assert.match(elements.get('#mkStats').innerHTML, /需重新定位 1/);
  api.selectIssue(issue.issueKey);
  assert.match(elements.get('#detailMeta').textContent, /需重新定位/);
  assert.match(elements.get('#detailQuote').textContent, /审阅时原文/);
  assert.match(elements.get('#detailProblem').textContent, /原范围与修改重叠/);
  assert.match(elements.get('#toast').textContent, /需重新定位/);
  assert.equal(api.isFixable(issue), false);
  api.applyFixOne(issue.issueKey);
  await api.postApplyFixes([issue.issueKey]);
  assert.equal(fetches, 0);
  assert.equal(api.state.issues.length, 1);
});
await check('保存响应晚到时只更新原队列项，不覆盖当前稿件', async () => {
  const { sandbox, api } = harness();
  const body = deferred();
  api.state.queue = [{ id: 'A' }];
  sandbox.fetch = async () => ({ ok: true, json: () => body.promise });
  const pending = api.postApplyFixes([applied.key]);
  const otherDoc = { paragraphs: [{ text: '稿件乙' }] };
  Object.assign(api.state, { sessionId: 'B', doc: otherDoc, workVersion: { id: 'B-v0' }, issues: [] });
  const migratedResult = { issues: [{ issueKey: 'remaining', anchor: { start: 19 } }], anchorStats: { exact: 1 } };
  body.resolve({ ...reply, result: migratedResult });
  await pending;
  assert.equal(api.state.doc, otherDoc);
  assert.equal(api.state.workVersion.id, 'B-v0');
  assert.equal(api.state.resolved.size, 0);
  assert.equal(api.state.issues.length, 0);
  assert.equal(api.state.queue[0].doc, changedDoc);
  assert.equal(api.state.queue[0].workVersion, newVersion);
  assert.equal(api.state.queue[0].result, migratedResult);
});
await check('工作字节晚到时不污染切换后的稿件', async () => {
  const { sandbox, api } = harness();
  const bytes = deferred();
  const requested = deferred();
  sandbox.fetch = async (url) => url === '/api/apply-fixes' ? jsonResponse(reply)
    : { ...bytesResponse(null), arrayBuffer: () => { requested.resolve(); return bytes.promise; } };
  const pending = api.postApplyFixes([applied.key]);
  await requested.promise;
  const otherBuffer = new Uint8Array([2]).buffer;
  const otherDoc = { paragraphs: [{ text: '稿件乙' }] };
  Object.assign(api.state, { sessionId: 'B', buffer: otherBuffer, doc: otherDoc, workVersion: { id: 'B-v0' } });
  bytes.resolve(new Uint8Array([9]).buffer);
  await pending;
  assert.equal(api.state.buffer, otherBuffer);
  assert.equal(api.state.doc, otherDoc);
  assert.equal(api.state.workVersion.id, 'B-v0');
});
await check('同稿双击仅发出一次保存，避免响应倒序', async () => {
  const { sandbox, api } = harness();
  const body = deferred();
  let saves = 0;
  sandbox.stubRender();
  sandbox.fetch = async (url) => {
    if (url === '/api/apply-fixes') { saves += 1; return { ok: true, json: () => body.promise }; }
    return bytesResponse(new Uint8Array([9]).buffer);
  };
  const first = api.postApplyFixes([applied.key]);
  await api.postApplyFixes([applied.key]);
  body.resolve(reply);
  await first;
  assert.equal(saves, 1);
});
await check('基础版本冲突保留原文和原字节，禁止标记已修复', async () => {
  const { sandbox, api } = harness();
  const oldDoc = api.state.doc;
  const oldBuffer = api.state.buffer;
  sandbox.fetch = async () => jsonResponse({ error: '工作版本已改变，请重新加载' }, false);
  await api.postApplyFixes([applied.key]);
  assert.equal(api.state.doc, oldDoc);
  assert.equal(api.state.buffer, oldBuffer);
  assert.equal(api.state.workVersion.id, 'A-v0');
  assert.equal(api.state.resolved.size, 0);
});
await check('归并问题部分修改成功时，父问题仍保留未修复状态', async () => {
  const { sandbox, api } = harness();
  sandbox.stubRender();
  api.state.queue = [{ id: 'A' }];
  sandbox.fetch = async (url) => url === '/api/apply-fixes'
    ? jsonResponse({ ...reply, appliedFixes: [], skipped: [{ key: applied.key, reason: '另一处冲突' }] })
    : bytesResponse(new Uint8Array([9]).buffer);
  await api.postApplyFixes([applied.key]);
  assert.equal(api.state.resolved.size, 0);
  assert.equal(api.state.queue[0].appliedFixes.length, 0);
  assert.equal(api.state.appliedFixDetails.length, 1);
});
await check('工作字节版本头不符时拒绝挂载到旧版本', async () => {
  const { sandbox, api } = harness();
  const oldBuffer = api.state.buffer;
  sandbox.fetch = async () => bytesResponse(new Uint8Array([9]).buffer, 'A-v2');
  await assert.rejects(api.loadWorkingVersion('A', newVersion), /版本已变化/);
  assert.equal(api.state.buffer, oldBuffer);
  assert.equal(api.state.workVersion.id, 'A-v0');
});
await check('保存后预览下载失败明确保留保存状态，不展示旧稿', async () => {
  const { sandbox, api, elements } = harness();
  sandbox.fetch = async (url) => url === '/api/apply-fixes' ? jsonResponse(reply) : { ok: false };
  await api.postApplyFixes([applied.key]);
  assert.equal(api.state.workVersion, newVersion);
  assert.equal(api.state.buffer, null);
  assert.equal(api.state.doc, changedDoc);
  assert.match(elements.get('#docHost').innerHTML, /修改已保存/);
});
await check('异步旧稿渲染晚结束，不覆盖新稿画面', async () => {
  const { sandbox, api, elements } = harness();
  const oldRender = deferred();
  sandbox.window.docx = { renderAsync: async (buffer, host) => {
    if (new Uint8Array(buffer)[0] === 1) await oldRender.promise;
    host.childNodes = [{ manuscript: new Uint8Array(buffer)[0] }];
  } };
  const first = api.renderDocument(true);
  Object.assign(api.state, { sessionId: 'B', buffer: new Uint8Array([2]).buffer, workVersion: { id: 'B-v0' } });
  await api.renderDocument(true);
  oldRender.resolve();
  await first;
  assert.equal(elements.get('#docHost').childNodes[0].manuscript, 2);
  assert.match(api.rendered.markup, /^B\|/);
});
await check('当前稿下载固定请求稿件及文件名，切稿不会误命名', async () => {
  const { sandbox, api, downloads } = harness();
  const blob = deferred();
  let path;
  sandbox.fetch = async (url) => { path = url; return { ok: true, blob: () => blob.promise }; };
  const pending = api.exportWorkingDocx();
  Object.assign(api.state, { sessionId: 'B', doc: { meta: { title: '稿件乙' } } });
  blob.resolve(new Blob(['fixture']));
  await pending;
  assert.equal(path, '/api/export-working-docx?id=A');
  assert.equal(downloads[0], '稿件甲_当前修改稿.docx');
});
await check('修改缺少审阅身份时不发请求',async()=>{const {api,sandbox}=harness();api.state.reviewRunId=null;let calls=0;sandbox.fetch=async()=>{calls++;throw Error('must not submit');};await api.postApplyFixes([applied.key]);assert.equal(calls,0);assert.equal(api.state.workVersion.id,'A-v0');});
await check('同稿同版本新审阅后迟到的旧修改响应不覆盖当前结果',async()=>{const {api,sandbox}=harness(),pending=deferred();api.state.queue=[{id:'A',reviewRunId:'run-A'}];sandbox.fetch=async()=>({ok:true,json:()=>pending.promise});const saving=api.postApplyFixes([applied.key]);const latestDoc={paragraphs:[{text:'current R2'}]};api.state.reviewRunId='run-B';api.state.doc=latestDoc;api.state.queue[0].reviewRunId='run-B';pending.resolve(reply);await saving;assert.equal(api.state.reviewRunId,'run-B');assert.equal(api.state.doc,latestDoc);assert.equal(api.state.workVersion.id,'A-v0');assert.equal(api.state.queue[0].reviewRunId,'run-B');assert.equal(api.state.resolved.size,0);});
const reportFixture=(extra={})=>{const markdown='# 软件报告 α\n';return{markdown,receipt:{schemaVersion:1,artifactType:'markdown-report',sessionId:'A',reviewRunId:'run-A',workVersion:{id:'A-v0'},outputSha256:createHash('sha256').update(markdown).digest('hex'),...extra}};};
await check('报告请求固定版本运行且只下载校验一致的内容',async()=>{const {api,sandbox,downloads}=harness();let body;sandbox.fetch=async(url,opts)=>{assert.equal(url,'/api/report');body=JSON.parse(opts.body);return jsonResponse(reportFixture());};await api.exportReport();assert.deepEqual(body,{id:'A',baseVersionId:'A-v0',baseReviewRunId:'run-A'});assert.deepEqual(downloads,['稿件甲_审校报告.md']);});
await check('报告缺失凭证、错版本或错文件SHA均不下载',async()=>{for(const payload of [{markdown:'# missing receipt'},reportFixture({reviewRunId:'run-old'}),reportFixture({outputSha256:'0'.repeat(64)})]){const {api,sandbox,downloads}=harness();sandbox.fetch=async()=>jsonResponse(payload);await api.exportReport();assert.equal(downloads.length,0);}});
await check('同版本重审后的迟到报告不下载',async()=>{const {api,sandbox,downloads}=harness(),pending=deferred();sandbox.fetch=async()=>({json:()=>pending.promise});const saving=api.exportReport();api.state.reviewRunId='run-B';pending.resolve(reportFixture());await saving;assert.equal(downloads.length,0);assert.equal(api.state.reviewRunId,'run-B');});
console.log(`当前工作版本前端回归通过：${passed} 项（未调用真实模型）`);
