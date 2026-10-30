/** Isolated import durability tests. Never starts a server or calls a model. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, unlink, symlink, rename, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { beginIngestion, submitIngestion, resumeIngestion, loadIngestion, listIngestions, recoverIngestions, ingestionSourceAvailable, verifyIngestionContext } from '../src/ingestion-store.js';
import { loadWorkspace, saveWorkspace } from '../src/workspace-store.js';
import { loadSessionSnapshot, saveSessionSnapshot } from '../src/session-store.js';
import { saveWorkingVersion, loadWorkingVersion } from '../src/working-version.js';
import { inspectDocxComments } from '../src/docx-clean.js';
import { writeZip } from '../src/zip-write.js';
import { openZip } from '../src/zip.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const SCRIPT = fileURLToPath(import.meta.url); const ROOT = resolve(dirname(SCRIPT), '..');
function fixture(text = '隔离软件测试的正文。', comments = true) {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const parts = [
    {name: '[Content_Types].xml', data: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${comments ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : ''}</Types>`},
    {name: '_rels/.rels', data: `<Relationships xmlns="${rel}"><Relationship Id="rDoc" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`},
    {name: 'word/document.xml', data: `<w:document xmlns:w="${w}"><w:body><w:p>${comments ? '<w:commentRangeStart w:id="0"/>' : ''}<w:r><w:t>${text}</w:t></w:r>${comments ? '<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>' : ''}</w:p><w:sectPr/></w:body></w:document>`},
    {name: 'word/media/untouched.bin', data: Buffer.from([1, 2, 3, 255])},
  ];
  if (comments) parts.push(
    {name: 'word/_rels/document.xml.rels', data: `<Relationships xmlns="${rel}"><Relationship Id="rComment" Type="${office}/comments" Target="comments.xml"/></Relationships>`},
    {name: 'word/comments.xml', data: `<w:comments xmlns:w="${w}"><w:comment w:id="0" w:author="fixture"><w:p><w:r><w:t>旧责编意见</w:t></w:r></w:p></w:comment></w:comments>`});
  return writeZip(parts.map((entry) => ({...entry, data: Buffer.from(entry.data)})));
}
const buffer = fixture();
const childMode = process.argv.find((arg) => arg.startsWith('--child='))?.slice(8);
if (childMode) {
  if (childMode === 'hold') { process.stdout.write('READY\n'); process.stdin.resume(); }
  else {
    const config = JSON.parse(process.env.DSH_INGESTION_TEST_CONFIG);
    const args = {...config.roots, ...config.identity, buffer: fixture(config.text)};
    if (childMode === 'crash') args.faultHooks = {[config.hook]: () => process.exit(91)};
    try { const result = await submitIngestion(args); console.log(JSON.stringify({id: result.record.ingestionId, status: result.record.status})); }
    catch (error) { console.error(error.stack); process.exitCode = 1; }
  }
} else {
  const base = await mkdtemp(join(tmpdir(), 'dsh-ingestion-store-'));
  const report = {generatedAt: new Date().toISOString(), modelCalls: 0, realArkCalls: 0, base, checks: [],
    moduleSha256: hash(await readFile(new URL('../src/ingestion-store.js', import.meta.url))), testSha256: hash(await readFile(SCRIPT))};
  const selected = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6);
  const OUT = resolve(ROOT, selected || `data/verify/ingestion-store-${Date.now()}.json`);
  const fresh = async (tag) => {
    const root = join(base, tag); await mkdir(root);
    return {storageRoot: join(root, 'ingestions'), sessionRoot: join(root, 'sessions'), workspaceRoot: join(root, 'workspaces'),
      versionRoot: join(root, 'versions'), reviewRoot: join(root, 'reviews'), auditRoot: join(root, 'audit')};
  };
  const proposal = (operationId = 'operation-one', workspaceId = 'wfixture') => ({workspaceId, operationId, name: '软件合约稿件.docx', size: buffer.length, purpose: 'editorial', verificationRunId: 'isolated-ingestion-store'});
  const begin = (roots, item = proposal(), extra = {}) => beginIngestion({...roots, ...item, ...extra});
  const submit = (roots, item = proposal(), extra = {}) => submitIngestion({...roots, ...item, buffer, ...extra});
  const resume = (roots, ingestionId, extra = {}) => resumeIngestion({...roots, ingestionId, ...extra});
  const runChild = async (mode, config) => {
    const child = spawn(process.execPath, [SCRIPT, `--child=${mode}`], {cwd: ROOT, windowsHide: true,
      env: {...process.env, DSH_INGESTION_TEST_CONFIG: JSON.stringify(config),
        DSH_INGESTION_ROOT: config.roots?.storageRoot || base, DSH_SESSION_ROOT: config.roots?.sessionRoot || base,
        DSH_WORKSPACE_ROOT: config.roots?.workspaceRoot || base, DSH_WORKING_VERSION_ROOT: config.roots?.versionRoot || base,
        DSH_REVIEW_ROOT: config.roots?.reviewRoot || base, DSH_AUDIT_ROOT: config.roots?.auditRoot || base}, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = ''; let stderr = ''; child.stdout.on('data', (data) => stdout += data); child.stderr.on('data', (data) => stderr += data);
    return new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code) => done({code, stdout, stderr})); });
  };
  const deferred = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return {promise, release}; };
  const ticketDirectory = (roots, ingestionId) => join(roots.storageRoot, '.locks', 'ingestions', ingestionId);
  async function withTicketRenamePatch(lockDir, replacement, action) {
    const original = fsPromises.rename;
    fsPromises.rename = (from, to) => dirname(to) === lockDir && to.endsWith('.lock') ? replacement(from, to, original) : original(from, to);
    syncBuiltinESMExports();
    try { return await action(); }
    finally { fsPromises.rename = original; syncBuiltinESMExports(); }
  }
  const test = async (name, action) => {
    const started = Date.now();
    try { await action(); report.checks.push({name, ok: true, elapsedMs: Date.now() - started}); console.log(`PASS ${name}`); }
    catch (error) { report.checks.push({name, ok: false, error: error.stack, elapsedMs: Date.now() - started}); throw error; }
  };
  let canonical;
  try {
    await test('intent is durable, stable and ordered before any source/session exists', async () => {
      const roots = await fresh('intent'); const item = proposal(); const one = await begin(roots, item);
      assert.equal(one.record.status, 'awaiting-file'); assert.equal(one.snapshot, null); assert.equal(one.record.source, null);
      assert.deepEqual(one.record.storageContext, {schemaVersion: 1, sessionRoot: {kind: 'relative', path: '../sessions'},
        workspaceRoot: {kind: 'relative', path: '../workspaces'}, versionRoot: {kind: 'relative', path: '../versions'}});
      const workspace = await loadWorkspace({workspaceId: item.workspaceId, storageRoot: roots.workspaceRoot});
      assert.equal(workspace.workspace.entries.length, 1); assert.equal(workspace.workspace.entries[0].id, null);
      assert.equal(workspace.workspace.entries[0].ingestionId, one.record.ingestionId);
      const repeated = await begin(roots, item); assert.equal(repeated.record.ingestionId, one.record.ingestionId);
      assert.equal(repeated.record.sessionId, one.record.sessionId);
      for (const change of [{name: 'other.docx'}, {size: item.size + 1}, {purpose: 'other'}, {verificationRunId: 'other'}])
        await assert.rejects(begin(roots, {...item, ...change}), {status: 409, code: 'INGESTION_CONFLICT'});
      await assert.rejects(resume(roots, one.record.ingestionId), {status: 409, code: 'INGESTION_SOURCE_MISSING'});
      assert.equal((await listIngestions(roots)).length, 1);
      assert.equal((await recoverIngestions(roots))[0].error.code, 'INGESTION_SOURCE_MISSING');
    });
    await test('strict clean creates immutable v0 and an unreviewed session with complete source hash proof', async () => {
      const roots = await fresh('completed'); const item = proposal(); const result = await submit(roots, item);
      canonical = {roots, item, result}; const record = result.record;
      assert.equal(record.status, 'completed'); assert.equal(result.receipt.status, 200);
      assert.equal(result.snapshot.ingestionId, record.ingestionId); assert.equal(result.snapshot.reviewRunning, false);
      assert.equal(result.snapshot.result, null); assert.equal(result.snapshot.mutationEpoch, 0); assert.equal(result.sessionManifest.revision, 0);
      assert.equal(record.source.sha256, hash(buffer)); assert.equal(record.clean.originalCommentCount, 1);
      assert.equal(record.clean.workSha256, record.workVersion.sha256); assert.equal(record.clean.validatedVersionId, record.workVersion.id);
      const saved = await loadWorkingVersion({sessionId: record.sessionId, versionId: record.workVersion.id, storageRoot: roots.versionRoot});
      assert.ok(saved.originalBuffer.equals(buffer)); assert.equal(inspectDocxComments(saved.buffer).comments, 0);
      assert.ok((await readFile(join(roots.storageRoot, record.ingestionId, 'source', 'original.docx'))).equals(buffer));
      const workspace = await loadWorkspace({workspaceId: item.workspaceId, storageRoot: roots.workspaceRoot});
      assert.equal(workspace.workspace.entries[0].id, record.sessionId); assert.equal(workspace.workspace.entries.length, 1);
    });
    await test('same operation rejects another body and a lost success reply replays one identity', async () => {
      const {roots, item, result} = canonical;
      const sameSize = Buffer.from(buffer); sameSize[sameSize.length - 1] ^= 1;
      await assert.rejects(submit(roots, item, {buffer: sameSize}), {status: 409, code: 'INGESTION_CONFLICT'});
      await assert.rejects(submit(roots, item, {buffer: Buffer.from('short')}), {status: 409, code: 'INGESTION_FILE_SIZE'});
      const again = await submit(roots, item); assert.equal(again.record.ingestionId, result.record.ingestionId);
      assert.equal(again.sessionManifest.revision, 0); assert.equal((await listIngestions(roots)).length, 1);
    });
    if (process.platform === 'win32') await test('transient ticket replacement denials keep choosing bytes intact and commit one same-identity session', async () => {
      const roots = await fresh('ticket-transient'); const item = proposal(); const id = 'i' + hash(`${item.workspaceId}\0${item.operationId}`);
      let attempts = 0, ticket, temporary, oldTicket;
      const intent = await withTicketRenamePatch(ticketDirectory(roots, id), async (from, to, original) => {
        ticket ||= to; temporary ||= from; assert.equal(to, ticket); assert.equal(from, temporary); attempts += 1;
        oldTicket ||= await readFile(to); assert.ok(oldTicket.equals(await readFile(to)));
        assert.equal(JSON.parse(oldTicket).choosing, true); assert.equal(JSON.parse(oldTicket).ticket, 0);
        assert.equal(JSON.parse(await readFile(from, 'utf8')).choosing, false);
        if (attempts <= 2) throw Object.assign(new Error('fixture-ticket-transient'), {code: 'EPERM'});
        return original(from, to);
      }, () => begin(roots, item));
      assert.equal(attempts, 3); assert.equal(intent.record.ingestionId, id);
      const completed = await submit(roots, item); assert.equal(completed.record.ingestionId, id); assert.equal(completed.sessionManifest.revision, 0);
      assert.equal((await begin(roots, item)).record.sessionId, completed.record.sessionId);
      assert.equal((await submit(roots, item)).sessionManifest.revision, 0);
      assert.equal((await loadWorkspace({workspaceId: item.workspaceId, storageRoot: roots.workspaceRoot})).workspace.entries.length, 1);
      assert.equal((await readdir(roots.sessionRoot)).filter((name) => /^s[a-f0-9]{64}$/.test(name)).length, 1);
      assert.deepEqual(await readdir(ticketDirectory(roots, id)), []);
    });
    if (process.platform === 'win32') await test('persistent ticket denial is bounded, preserves durable source and choosing ticket, then same operation resumes', async () => {
      const roots = await fresh('ticket-persistent'); const item = proposal(); let record;
      await assert.rejects(submit(roots, item, {faultHooks: {afterSourceStored(event) { record = event.record; throw new Error('source-before-ticket-denial'); }}}), /source-before-ticket-denial/);
      const statePath = join(roots.storageRoot, record.ingestionId, 'state.json'); const before = await readFile(statePath);
      const archive = await readFile(join(roots.storageRoot, record.ingestionId, 'source', 'original.docx'));
      let attempts = 0, ticket, temporary, oldTicket;
      await withTicketRenamePatch(ticketDirectory(roots, record.ingestionId), async (from, to) => {
        ticket ||= to; temporary ||= from; assert.equal(to, ticket); assert.equal(from, temporary); attempts += 1;
        oldTicket ||= await readFile(to); assert.ok(oldTicket.equals(await readFile(to))); assert.equal(JSON.parse(oldTicket).choosing, true);
        assert.ok(before.equals(await readFile(statePath))); throw Object.assign(new Error('fixture-ticket-persistent'), {code: 'EPERM'});
      }, () => assert.rejects(resume(roots, record.ingestionId), (error) => error.code === 'EPERM' && error.record.status === 'source-stored'));
      assert.equal(attempts, 6); assert.ok(before.equals(await readFile(statePath)));
      assert.ok(archive.equals(await readFile(join(roots.storageRoot, record.ingestionId, 'source', 'original.docx'))));
      assert.deepEqual(await readdir(ticketDirectory(roots, record.ingestionId)), []);
      const completed = await resume(roots, record.ingestionId); assert.equal(completed.record.ingestionId, record.ingestionId);
      assert.equal(completed.record.sessionId, record.sessionId); assert.equal(completed.sessionManifest.revision, 0);
    });
    await test('non-transient and non-Windows ticket replacement errors fail once without retry or losing the prior intent', async () => {
      for (const variant of ['non-transient', 'non-Windows']) {
        const roots = await fresh(`ticket-${variant}`); const item = proposal(); const intent = await begin(roots, item);
        const statePath = join(roots.storageRoot, intent.record.ingestionId, 'state.json'); const before = await readFile(statePath); let attempts = 0;
        const platform = Object.getOwnPropertyDescriptor(process, 'platform');
        if (variant === 'non-Windows') Object.defineProperty(process, 'platform', {...platform, value: 'linux'});
        try {
          await withTicketRenamePatch(ticketDirectory(roots, intent.record.ingestionId), async () => {
            attempts += 1; throw Object.assign(new Error('fixture-ticket-no-retry'), {code: variant === 'non-transient' ? 'EIO' : 'EPERM'});
          }, () => assert.rejects(begin(roots, item), {code: variant === 'non-transient' ? 'EIO' : 'EPERM'}));
        } finally { Object.defineProperty(process, 'platform', platform); }
        assert.equal(attempts, 1); assert.ok(before.equals(await readFile(statePath)));
        assert.deepEqual(await readdir(ticketDirectory(roots, intent.record.ingestionId)), []);
        assert.equal((await submit(roots, item)).record.ingestionId, intent.record.ingestionId);
      }
    });
    if (process.platform === 'win32') await test('a peer observes the old choosing ticket and cannot enter the critical section while its replacement retries', async () => {
      const roots = await fresh('ticket-peer-wait'); const item = proposal(); const intent = await begin(roots, item);
      const lockDir = ticketDirectory(roots, intent.record.ingestionId); const statePath = join(roots.storageRoot, intent.record.ingestionId, 'state.json');
      const before = await readFile(statePath); const retrying = deferred(), finish = deferred(); let attempts = 0, ticket;
      await withTicketRenamePatch(lockDir, async (from, to, original) => {
        ticket ||= to; assert.equal(ticket, to); attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('fixture-ticket-peer-wait'), {code: 'EPERM'});
        retrying.release(); await finish.promise; return original(from, to);
      }, async () => {
        const parent = begin(roots, item).then((result) => ({result}), (error) => ({error}));
        let peerDone = false, peer;
        try {
          await retrying.promise;
          peer = runChild('submit', {roots, identity: item}).then((result) => { peerDone = true; return result; });
          let observed = false;
          for (let check = 0; check < 200 && !observed; check += 1) {
            for (const name of (await readdir(lockDir)).filter((name) => name.endsWith('.lock'))) {
              try { const row = JSON.parse(await readFile(join(lockDir, name), 'utf8')); if (row.pid !== process.pid && row.choosing === false) observed = true; }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            if (!observed) await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.equal(observed, true); assert.equal(peerDone, false); assert.equal(JSON.parse(await readFile(ticket, 'utf8')).choosing, true);
          assert.ok(before.equals(await readFile(statePath))); assert.equal(await ingestionSourceAvailable({ingestionId: intent.record.ingestionId, storageRoot: roots.storageRoot}), false);
          await assert.rejects(loadSessionSnapshot({sessionId: intent.record.sessionId, storageRoot: roots.sessionRoot}), {code: 'SESSION_NOT_FOUND'});
        } finally { finish.release(); }
        const parentResult = await parent; assert.equal(parentResult.error, undefined); assert.equal(parentResult.result.record.ingestionId, intent.record.ingestionId);
        const peerResult = await peer; assert.equal(peerResult.code, 0, peerResult.stderr); assert.equal(attempts, 2);
      });
      const completed = await resume(roots, intent.record.ingestionId); assert.equal(completed.sessionManifest.revision, 0);
      assert.equal((await loadWorkspace({workspaceId: item.workspaceId, storageRoot: roots.workspaceRoot})).workspace.entries.length, 1);
    });
    await test('pending operations reject redirected roots before creating any alternate workspace/session/version storage', async () => {
      const roots = await fresh('pending-storage-context'); const item = proposal(); let record;
      await assert.rejects(submit(roots, item, {faultHooks: {afterSourceStored(event) { record = event.record; throw new Error('pending-context'); }}}), /pending-context/);
      const before = await readFile(join(roots.storageRoot, record.ingestionId, 'state.json'));
      for (const key of ['sessionRoot', 'workspaceRoot', 'versionRoot']) {
        const alternate = join(base, `pending-redirect-${key}`); const wrong = {...roots, [key]: alternate};
        for (const call of [() => begin(wrong, item), () => submit(wrong, item), () => resume(wrong, record.ingestionId)])
          await assert.rejects(call(), {status: 409, code: 'INGESTION_STORAGE_CONFLICT'});
        const recovered = await recoverIngestions({...wrong, skipActive: true});
        assert.equal(recovered[0].error.code, 'INGESTION_STORAGE_CONFLICT'); assert.equal(recovered[0].error.status, 409);
        await assert.rejects(readdir(alternate), {code: 'ENOENT'});
      }
      assert.ok(before.equals(await readFile(join(roots.storageRoot, record.ingestionId, 'state.json'))));
      assert.equal((await loadIngestion({ingestionId: record.ingestionId, storageRoot: roots.storageRoot})).status, 'source-stored');
      assert.equal((await resume(roots, record.ingestionId)).record.status, 'completed');
    });
    await test('terminal receipts also reject redirected roots rather than loading another configured session store', async () => {
      const roots = await fresh('terminal-storage-context'); const item = proposal(); const completed = await submit(roots, item);
      const before = await readFile(join(roots.storageRoot, completed.record.ingestionId, 'state.json'));
      for (const key of ['sessionRoot', 'workspaceRoot', 'versionRoot']) {
        const alternate = join(base, `terminal-redirect-${key}`); const wrong = {...roots, [key]: alternate};
        for (const call of [() => begin(wrong, item), () => submit(wrong, item), () => resume(wrong, completed.record.ingestionId)])
          await assert.rejects(call(), {status: 409, code: 'INGESTION_STORAGE_CONFLICT'});
        assert.equal((await recoverIngestions({...wrong, skipActive: true}))[0].error.code, 'INGESTION_STORAGE_CONFLICT');
        await assert.rejects(readdir(alternate), {code: 'ENOENT'});
      }
      assert.ok(before.equals(await readFile(join(roots.storageRoot, completed.record.ingestionId, 'state.json'))));
      assert.equal((await begin(roots, item)).snapshot.id, completed.record.sessionId);
    });
    await test('read-only context verification rejects wrong roots while metadata-only loading stays available', async () => {
      const roots = await fresh('readonly-context'); const intent = await begin(roots); const id = intent.record.ingestionId;
      const before = await readFile(join(roots.storageRoot, id, 'state.json'));
      const wrong = {...roots, sessionRoot: join(base, 'readonly-context-redirect')};
      const reads = []; const original = fsPromises.readFile;
      fsPromises.readFile = async (path, ...rest) => { reads.push(String(path)); return original(path, ...rest); };
      syncBuiltinESMExports();
      try {
        assert.equal((await verifyIngestionContext({...roots, ingestionId: id})).ingestionId, id);
        assert.equal((await loadIngestion({ingestionId: id, storageRoot: roots.storageRoot})).status, 'awaiting-file');
        await assert.rejects(verifyIngestionContext({...wrong, ingestionId: id}), {status: 409, code: 'INGESTION_STORAGE_CONFLICT'});
        assert.ok(reads.every((path) => path === join(roots.storageRoot, id, 'state.json')));
      } finally { fsPromises.readFile = original; syncBuiltinESMExports(); }
      await assert.rejects(readdir(wrong.sessionRoot), {code: 'ENOENT'});
      assert.ok(before.equals(await readFile(join(roots.storageRoot, id, 'state.json'))));
    });
    await test('copying the entire storage tree preserves relative context for pending recovery and completed replay', async () => {
      const roots = await fresh('movable-tree'); const doneItem = proposal('done'); const pendingItem = proposal('pending');
      const completed = await submit(roots, doneItem); let pending;
      await assert.rejects(submit(roots, pendingItem, {faultHooks: {afterSourceStored(event) { pending = event.record; throw new Error('move-pending'); }}}), /move-pending/);
      const movedParent = join(base, 'moved-tree'); await cp(dirname(roots.storageRoot), movedParent, {recursive: true});
      const moved = Object.fromEntries(Object.keys(roots).map((key) => [key, join(movedParent, roots[key].split(/[\\/]/).at(-1))]));
      const recovered = await resume(moved, pending.ingestionId); assert.equal(recovered.record.status, 'completed');
      assert.equal(recovered.record.sessionId, pending.sessionId); assert.deepEqual(recovered.record.storageContext, pending.storageContext);
      for (const call of [() => begin(moved, doneItem), () => submit(moved, doneItem), () => resume(moved, completed.record.ingestionId)]) {
        const replay = await call(); assert.equal(replay.snapshot.id, completed.record.sessionId); assert.equal(replay.sessionManifest.revision, 0);
      }
      assert.equal((await listIngestions({storageRoot: moved.storageRoot})).length, 2);
      assert.equal((await loadWorkspace({workspaceId: doneItem.workspaceId, storageRoot: moved.workspaceRoot})).workspace.entries.length, 2);
    });
    if (process.platform === 'win32' && parse(ROOT).root.toLowerCase() !== parse(base).root.toLowerCase())
      await test('independently configured roots on another drive bind as absolute comparisons and remain supported', async () => {
        const roots = await fresh('cross-drive-registry'); const external = join(dirname(OUT), `cross-drive-${randomUUID()}`);
        const split = {...roots, sessionRoot: join(external, 'sessions'), workspaceRoot: join(external, 'workspaces'), versionRoot: join(external, 'versions')};
        const completed = await submit(split);
        for (const key of ['sessionRoot', 'workspaceRoot', 'versionRoot']) {
          assert.equal(completed.record.storageContext[key].kind, 'absolute');
          assert.equal(completed.record.storageContext[key].path, resolve(split[key]).replace(/\\/g, '/'));
        }
        assert.equal((await submit(split)).record.sessionId, completed.record.sessionId);
        const movedRegistry = join(base, 'cross-drive-moved-registry'); await cp(roots.storageRoot, movedRegistry, {recursive: true});
        assert.equal((await resume({...split, storageRoot: movedRegistry}, completed.record.ingestionId)).snapshot.id, completed.record.sessionId);
        await assert.rejects(resume({...split, sessionRoot: join(external, 'another-session-store')}, completed.record.ingestionId),
          {status: 409, code: 'INGESTION_STORAGE_CONFLICT'});
      });
    await test('validation failures retain an immutable source and a failed placeholder but never a usable session', async () => {
      const roots = await fresh('validation'); const bad = Buffer.from('not a docx'); const item = {...proposal(), size: bad.length};
      const result = await submit(roots, item, {buffer: bad}); assert.equal(result.record.status, 'failed'); assert.equal(result.receipt.status, 422);
      assert.equal(result.record.source.sha256, hash(bad)); assert.equal(result.snapshot, null);
      const workspace = await loadWorkspace({workspaceId: item.workspaceId, storageRoot: roots.workspaceRoot});
      assert.equal(workspace.workspace.entries[0].id, null); assert.equal(workspace.workspace.entries[0].ingestionStatus, 'failed');
      await assert.rejects(loadSessionSnapshot({sessionId: result.record.sessionId, storageRoot: roots.sessionRoot}), {code: 'SESSION_NOT_FOUND'});
      assert.deepEqual((await submit(roots, item, {buffer: bad})).receipt, result.receipt);
    });
    await test('a strict cleaning failure still reports the known original comment count', async () => {
      const roots = await fresh('known-comment-count'); const zip = openZip(buffer);
      const unsafe = writeZip(zip.names.map((name) => ({name, data: name === 'word/_rels/document.xml.rels'
        ? Buffer.from(zip.readText(name).replace('Id="rComment"', 'Id="rComment" TargetMode="External"')) : zip.read(name)})));
      const result = await submit(roots, {...proposal(), size: unsafe.length}, {buffer: unsafe});
      assert.equal(result.record.status, 'failed'); assert.equal(result.receipt.code, 'CLEAN_EXTERNAL_COMMENT_RELATIONSHIP');
      assert.equal(result.receipt.clean.originalCommentCount, 1);
    });
    const hooks = ['afterIntent', 'afterSourceStored', 'afterVersionSaved', 'afterSessionSaved', 'afterWorkspaceAttached', 'beforeComplete',
      'afterSourceIdentityBeforeBytes', 'afterSourceBytesBeforeRecord', 'afterSessionStateRenamed', 'afterSessionCommitBeforeRecord'];
    for (const hook of hooks) await test(`abrupt child exit at ${hook} resumes without duplication`, async () => {
      const roots = await fresh(`crash-${hook}`); const item = proposal(hook);
      const exited = await runChild('crash', {roots, identity: item, hook}); assert.equal(exited.code, 91, exited.stderr);
      const records = await listIngestions(roots); assert.equal(records.length, 1);
      assert.equal(await ingestionSourceAvailable({ingestionId: records[0].ingestionId, storageRoot: roots.storageRoot}),
        !['afterIntent', 'afterSourceIdentityBeforeBytes'].includes(hook));
      let completed;
      if (['afterIntent', 'afterSourceIdentityBeforeBytes'].includes(hook)) {
        await assert.rejects(resume(roots, records[0].ingestionId), {code: 'INGESTION_SOURCE_MISSING'});
        completed = await submit(roots, item);
      } else completed = await resume(roots, records[0].ingestionId);
      assert.equal(completed.record.status, 'completed'); assert.equal(completed.record.ingestionId, records[0].ingestionId);
      assert.equal(completed.sessionManifest.revision, 0);
      const workspace = await loadWorkspace({workspaceId: item.workspaceId, storageRoot: roots.workspaceRoot});
      assert.equal(workspace.workspace.entries.length, 1); assert.equal(workspace.workspace.entries[0].id, completed.record.sessionId);
      assert.equal((await submit(roots, item)).sessionManifest.revision, 0);
    });
    await test('committed session-save errors expose checkpoint and recover by reading the existing session', async () => {
      const roots = await fresh('committed-error'); const item = proposal(); let caught;
      try { await submit(roots, item, {faultHooks: {afterSessionStateRenamed() { throw new Error('fixture-after-rename'); }}}); }
      catch (error) { caught = error; }
      assert.equal(caught.message, 'fixture-after-rename'); assert.ok(caught.committedManifest); assert.equal(caught.record.status, 'version-saved');
      const existing = await loadSessionSnapshot({sessionId: caught.record.sessionId, storageRoot: roots.sessionRoot}); assert.equal(existing.manifest.revision, 0);
      const resumed = await resume(roots, caught.ingestionId); assert.equal(resumed.sessionManifest.revision, 0);
    });
    await test('64 simultaneous same-operation submissions produce exactly one session and entry', async () => {
      const roots = await fresh('same-concurrency'); const results = await Promise.all(Array.from({length: 64}, () => submit(roots)));
      assert.equal(new Set(results.map((result) => result.record.ingestionId)).size, 1);
      assert.ok(results.every((result) => result.sessionManifest.revision === 0));
      assert.equal((await loadWorkspace({workspaceId: 'wfixture', storageRoot: roots.workspaceRoot})).workspace.entries.length, 1);
      assert.equal((await readdir(roots.sessionRoot)).filter((name) => /^s[a-f0-9]{64}$/.test(name)).length, 1);
    });
    await test('64 operations bootstrap a shared workspace concurrently and retain placeholder order', async () => {
      const roots = await fresh('workspace-concurrency');
      const intents = await Promise.all(Array.from({length: 64}, (_, i) => begin(roots, proposal(`operation-${i}`))));
      const before = await loadWorkspace({workspaceId: 'wfixture', storageRoot: roots.workspaceRoot});
      const order = before.workspace.entries.map((entry) => entry.ingestionId); assert.equal(new Set(order).size, 64);
      await Promise.all(intents.map((result) => submit(roots, proposal(result.record.operationId))));
      const after = await loadWorkspace({workspaceId: 'wfixture', storageRoot: roots.workspaceRoot});
      assert.deepEqual(after.workspace.entries.map((entry) => entry.ingestionId), order);
      assert.ok(after.workspace.entries.every((entry) => entry.id));
    });
    await test('cross-process admission serializes same operation and first workspace creation', async () => {
      const roots = await fresh('process-concurrency');
      const results = await Promise.all(['same', 'same', 'two', 'three'].map((operationId) => runChild('submit', {roots, identity: proposal(operationId)})));
      for (const result of results) assert.equal(result.code, 0, result.stderr);
      const workspace = await loadWorkspace({workspaceId: 'wfixture', storageRoot: roots.workspaceRoot}); assert.equal(workspace.workspace.entries.length, 3);
      assert.equal((await listIngestions(roots)).length, 3);
    });
    await test('retries preserve later work versions, feedback, workspace choice and order', async () => {
      const {roots, item, result} = canonical; const record = result.record;
      const existing = await loadSessionSnapshot({sessionId: record.sessionId, storageRoot: roots.sessionRoot});
      const edited = fixture('新的已修改稿件。', false);
      const version = await saveWorkingVersion({sessionId: record.sessionId, name: item.name, buffer: edited, originalBuffer: buffer,
        parent: existing.snapshot.workVersion, storageRoot: roots.versionRoot});
      const snapshot = {...existing.snapshot, workVersion: version, mutationEpoch: 9, humanState: {feedback: '保留人工反馈'},
        reviewRecords: [{id: 'later-feedback', result: {issues: []}}], result: {issues: [{message: 'later'}]}};
      await saveSessionSnapshot({sessionId: record.sessionId, snapshot, storageRoot: roots.sessionRoot, expectedRevision: existing.manifest.revision});
      const workspace = await loadWorkspace({workspaceId: item.workspaceId, storageRoot: roots.workspaceRoot});
      workspace.workspace.activeSessionId = 'another-selection'; workspace.workspace.queue = {state: 'paused', cursorSessionId: 'later'};
      await saveWorkspace({workspaceId: item.workspaceId, workspace: workspace.workspace, expectedRevision: workspace.manifest.revision, storageRoot: roots.workspaceRoot});
      const beforeWorkspace = await readFile(join(roots.workspaceRoot, item.workspaceId, 'state.json'));
      for (const call of [() => begin(roots, item), () => submit(roots, item), () => resume(roots, record.ingestionId)]) {
        const replay = await call(); assert.equal(replay.snapshot.workVersion.id, version.id); assert.equal(replay.snapshot.mutationEpoch, 9);
        assert.deepEqual(replay.snapshot.humanState, snapshot.humanState); assert.equal(replay.sessionManifest.revision, 1);
      }
      assert.ok(beforeWorkspace.equals(await readFile(join(roots.workspaceRoot, item.workspaceId, 'state.json'))));
    });
    await test('an edit after session checkpoint is preserved while the unfinished import completes', async () => {
      const roots = await fresh('edit-before-complete'); const item = proposal(); let checkpoint;
      await assert.rejects(submit(roots, item, {faultHooks: {afterSessionSaved({record}) { checkpoint = record; throw new Error('pause-import'); }}}), /pause-import/);
      const stored = await loadSessionSnapshot({sessionId: checkpoint.sessionId, storageRoot: roots.sessionRoot});
      await saveSessionSnapshot({sessionId: checkpoint.sessionId, snapshot: {...stored.snapshot, feedback: 'later', mutationEpoch: 4},
        storageRoot: roots.sessionRoot, expectedRevision: stored.manifest.revision});
      const resumed = await resume(roots, checkpoint.ingestionId); assert.equal(resumed.snapshot.feedback, 'later');
      assert.equal(resumed.snapshot.mutationEpoch, 4); assert.equal(resumed.sessionManifest.revision, 1);
    });
    await test('existing workspace/session/intent missing or corrupt state is never recreated as new', async () => {
      const roots = await fresh('damaged'); const item = proposal(); const result = await submit(roots, item);
      await unlink(join(roots.workspaceRoot, item.workspaceId, 'state.json'));
      await assert.rejects(begin(roots, proposal('new-operation')), {code: 'WORKSPACE_MISSING'});
      await unlink(join(roots.sessionRoot, result.record.sessionId, 'state.json'));
      await assert.rejects(resume(roots, result.record.ingestionId), {code: 'SESSION_MISSING'});
      await unlink(join(roots.storageRoot, result.record.ingestionId, 'state.json'));
      await assert.rejects(begin(roots, item), {code: 'INGESTION_CORRUPT'});
      await assert.rejects(readFile(join(roots.storageRoot, result.record.ingestionId, 'state.json')), {code: 'ENOENT'});
    });
    await test('source corruption and immutable v0 deletion are rejected without regeneration', async () => {
      const roots = await fresh('source-corrupt'); const item = proposal(); let record;
      await assert.rejects(submit(roots, item, {faultHooks: {afterVersionSaved(event) { record = event.record; throw new Error('checkpoint'); }}}), /checkpoint/);
      const stem = record.workVersion.id.split(':')[1]; await unlink(join(roots.versionRoot, record.sessionId, `${stem}.docx`));
      await assert.rejects(resume(roots, record.ingestionId), {code: 'VERSION_INCOMPLETE'});
      await assert.rejects(readFile(join(roots.versionRoot, record.sessionId, `${stem}.docx`)), {code: 'ENOENT'});
      const path = join(roots.storageRoot, record.ingestionId, 'source', 'original.docx'); const bytes = await readFile(path);
      bytes[0] ^= 1; await writeFile(path, bytes);
      await assert.rejects(resume(roots, record.ingestionId), {code: 'INGESTION_SOURCE_CORRUPT'});
    });
    await test('metadata.file is never followed and symlinked archive/root/state files are rejected', async () => {
      const roots = await fresh('paths'); const item = proposal(); const result = await submit(roots, item); const record = result.record;
      const stem = record.workVersion.id.split(':')[1]; const metadataPath = join(roots.versionRoot, record.sessionId, `${stem}.json`);
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')); metadata.file = join(base, 'must-not-read.docx');
      const bytes = Buffer.from(JSON.stringify(metadata) + '\n'); await writeFile(metadataPath, bytes);
      const completePath = join(roots.versionRoot, record.sessionId, `${stem}.complete.json`);
      const complete = JSON.parse(await readFile(completePath, 'utf8')); complete.metadataSha256 = hash(bytes); await writeFile(completePath, JSON.stringify(complete));
      assert.ok((await loadWorkingVersion({sessionId: record.sessionId, versionId: metadata.id, storageRoot: roots.versionRoot})).originalBuffer.equals(buffer));
      const outside = join(base, 'external'); await mkdir(outside); await writeFile(join(outside, 'original.docx'), buffer);
      const sourceAlias = join(roots.storageRoot, record.ingestionId, 'source-alias'); await symlink(outside, sourceAlias, process.platform === 'win32' ? 'junction' : 'dir');
      const aliasRoots = {...roots, storageRoot: sourceAlias};
      await assert.rejects(listIngestions(aliasRoots), {code: 'INGESTION_PATH_INVALID'});
      // Directory junctions are available without Windows symlink privilege.
      const linkedRoot = join(base, 'linked-root'); await symlink(roots.storageRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(begin({...roots, storageRoot: linkedRoot}, item), {code: 'INGESTION_PATH_INVALID'});
      const sourcePath = join(roots.storageRoot, record.ingestionId, 'source');
      await rename(sourcePath, `${sourcePath}-preserved`); await symlink(outside, sourcePath, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(ingestionSourceAvailable({ingestionId: record.ingestionId, storageRoot: roots.storageRoot}), {code: 'INGESTION_PATH_INVALID'});
      await assert.rejects(submit(roots, item), {code: 'INGESTION_PATH_INVALID'});
      const state = join(roots.storageRoot, record.ingestionId, 'state.json'); const saved = await readFile(state); await writeFile(join(outside, 'state.json'), saved); await unlink(state);
      try { await symlink(join(outside, 'state.json'), state, 'file'); await assert.rejects(loadIngestion({ingestionId: record.ingestionId, storageRoot: roots.storageRoot}), {code: 'INGESTION_PATH_INVALID'}); }
      catch (error) { if (error.code !== 'EPERM' || process.platform !== 'win32') throw error; report.fileSymlinkPermissionUnavailable = true; }
    });
    await test('terminal startup recovery reads checked metadata but no original/source/session payloads', async () => {
      const roots = await fresh('terminal-recovery'); await submit(roots);
      const reads = []; const original = fsPromises.readFile;
      fsPromises.readFile = async (path, ...rest) => { reads.push(String(path)); return original(path, ...rest); };
      syncBuiltinESMExports();
      try {
        const result = await recoverIngestions({...roots, skipActive: true}); assert.equal(result.length, 1); assert.equal(result[0].skippedTerminal, true);
        assert.ok(reads.some((path) => path.endsWith('state.json')));
        assert.equal(reads.filter((path) => path.includes(roots.sessionRoot) || path.includes(roots.versionRoot) || path.includes(`${roots.storageRoot}${process.platform === 'win32' ? '\\' : '/'}source`)
          || path.endsWith('original.docx') || path.endsWith('manifest.json')).length, 0);
      } finally { fsPromises.readFile = original; syncBuiltinESMExports(); }
    });
    await test('one corrupt journal reports its error while independent pending imports recover', async () => {
      const roots = await fresh('recover-isolation'); const bad = await begin(roots, proposal('bad')); let good;
      await assert.rejects(submit(roots, proposal('good'), {faultHooks: {afterSourceStored({record}) { good = record; throw new Error('pause'); }}}), /pause/);
      await writeFile(join(roots.storageRoot, bad.record.ingestionId, 'state.json'), '{');
      const results = await recoverIngestions({...roots, skipActive: true});
      assert.equal(results.find((row) => row.ingestionId === bad.record.ingestionId).error.code, 'INGESTION_CORRUPT');
      assert.equal(results.find((row) => row.ingestionId === good.ingestionId).result.record.status, 'completed');
      await assert.rejects(listIngestions(roots), {code: 'INGESTION_CORRUPT'});
    });
    await test('live lock tickets remain live regardless of age; dead process tickets recover', async () => {
      const roots = await fresh('alive-lock'); const item = proposal(); const ingestionId = 'i' + hash(`${item.workspaceId}\0${item.operationId}`);
      await begin(roots, item);
      const lockDir = join(roots.storageRoot, '.locks', 'ingestions', ingestionId); await mkdir(lockDir, {recursive: true});
      const holder = spawn(process.execPath, [SCRIPT, '--child=hold'], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
      await new Promise((ready, reject) => { holder.once('error', reject); holder.stdout.once('data', ready); });
      const token = randomUUID(); await writeFile(join(lockDir, `${token}.lock`), JSON.stringify({schemaVersion: 1, pid: holder.pid, token, choosing: false, ticket: 1, createdAt: '1990-01-01'}));
      const stateBefore = await readFile(join(roots.storageRoot, ingestionId, 'state.json'));
      const fastStarted = Date.now(); const skipped = await recoverIngestions({...roots, skipActive: true});
      assert.equal(skipped[0].result.skippedActive, true); assert.ok(Date.now() - fastStarted < 1000);
      assert.ok(stateBefore.equals(await readFile(join(roots.storageRoot, ingestionId, 'state.json'))));
      let done = false; const waiting = begin(roots, item).then((value) => { done = true; return value; });
      await new Promise((resolve) => setTimeout(resolve, 250)); assert.equal(done, false);
      const closed = new Promise((resolve) => holder.once('exit', resolve)); holder.stdin.end(); await closed;
      const result = await waiting; assert.equal(result.record.status, 'awaiting-file');
      const locks = await readdir(lockDir); assert.ok(locks.includes(`${token}.lock`), 'dead tickets need no unsafe unlink/reclaim');
    });
    if (process.platform === 'win32') await test('deny-delete lock cleanup publishes release proof for same-PID and peer recovery', async () => {
      const roots = await fresh('release-proof'); const item = proposal(); let holder, heldPath, finish;
      try {
        await assert.rejects(begin(roots, item, {faultHooks: {async afterIntent({record}) {
          const lockDir = join(roots.storageRoot, '.locks', 'ingestions', record.ingestionId);
          const name = (await readdir(lockDir)).find((entry) => entry.endsWith('.lock')); heldPath = join(lockDir, name);
          const escaped = heldPath.replace(/'/g, "''");
          const command = `$stream=[IO.File]::Open('${escaped}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[Console]::WriteLine('READY');[Console]::In.ReadLine()|Out-Null;$stream.Dispose();`;
          holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
          await new Promise((ready, reject) => { holder.once('error', reject); holder.stdout.once('data', (data) => String(data).includes('READY') ? ready() : reject(new Error('missing holder marker'))); });
          finish = new Promise((resolve) => holder.once('exit', resolve));
        }}}), (error) => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
        assert.ok(JSON.parse(await readFile(heldPath.replace(/\.lock$/, '.released.json'), 'utf8')).released);
        const same = await begin(roots, item); assert.equal(same.record.status, 'awaiting-file');
        const peer = await runChild('submit', {roots, identity: item}); assert.equal(peer.code, 0, peer.stderr);
        assert.equal((await loadIngestion({ingestionId: same.record.ingestionId, storageRoot: roots.storageRoot})).status, 'completed');
      } finally { if (holder) { holder.stdin.end('\n'); await finish; } }
    });
    report.ok = true;
  } catch (error) { report.ok = false; report.error = error.stack; process.exitCode = 1; console.error(error.stack); }
  finally {
    report.completedAt = new Date().toISOString(); report.pass = report.checks.filter((check) => check.ok).length;
    await mkdir(dirname(OUT), {recursive: true}); await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    console.log(`REPORT ${OUT}`); console.log(`${report.pass}/${report.checks.length} passed; model calls=0; real Ark calls=0`);
  }
}
