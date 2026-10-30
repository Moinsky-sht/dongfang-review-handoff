/** Isolated workspace persistence checks; no app servers or model API calls. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, cp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { saveWorkspace, loadWorkspace } from '../src/workspace-store.js';

const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-workspace-store-'));
const workspaceId = 'wtest_store';
const workspace = { id: workspaceId, selectedSessionId: 'sqa2', items: [
  { sessionId: 'sqa1', order: 0, name: 'software-one.docx', state: 'completed' },
  { sessionId: 'sqa2', order: 1, name: 'software-two.docx', state: 'interrupted' },
], batch: { status: 'interrupted', completed: 1 }, future: { tag: 'map', rows: [['ordinary', 'JSON']] },
  prototypeLike: JSON.parse('{"__proto__":{"polluted":true},"constructor":"ordinary"}') };
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const selectedOut = args.find((arg) => arg.startsWith('--out='))?.slice(6);
const OUT = resolve(ROOT, selectedOut || `data/verify/workspace-store-${Date.now()}.json`);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const report = { generatedAt: new Date().toISOString(), modelCalls: 0, realArkCalls: 0, storageRoot, checks: [],
  moduleSha256: hash(await readFile(new URL('../src/workspace-store.js', import.meta.url))),
  testSha256: hash(await readFile(new URL(import.meta.url))) };
let latest;
const test = async (name, fn) => {
  try { await fn(); report.checks.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, ok: false, error: error.stack || String(error) }); throw error; }
};
const load = () => loadWorkspace({ workspaceId, storageRoot });
const save = (extra = {}) => saveWorkspace({ workspaceId, workspace, storageRoot, ...extra });
const defer = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return {promise, release}; };
async function withRenamePatch(replacement, action) {
  const original = fsPromises.rename;
  fsPromises.rename = (from, to) => replacement(from, to, original);
  syncBuiltinESMExports();
  try { return await action(); }
  finally { fsPromises.rename = original; syncBuiltinESMExports(); }
}

async function holdWindowsFile(path) {
  const escapedPath = path.replace(/'/g, "''");
  const script = `$stream=[IO.File]::Open('${escapedPath}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[Console]::WriteLine('READY');[Console]::In.ReadLine()|Out-Null;$stream.Dispose();`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows sharing fixture timed out')); }, 5000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', () => { clearTimeout(timer); reject(new Error('Windows sharing fixture exited before ready')); });
    child.stdout.once('data', (data) => { clearTimeout(timer); data.toString().includes('READY') ? ready() : reject(new Error('Missing ready marker')); });
  });
  return async () => {
    const done = child.exitCode == null ? new Promise((resolve) => child.once('exit', resolve)) : Promise.resolve();
    child.stdin.end('\n'); await done;
  };
}

try {
  await test('missing workspaces return explicit WORKSPACE_NOT_FOUND', async () => {
    await assert.rejects(load(), { code: 'WORKSPACE_NOT_FOUND', missingPart: 'directory' });
    await assert.rejects(loadWorkspace({ workspaceId, storageRoot: join(storageRoot, 'absent-root') }), { code: 'WORKSPACE_NOT_FOUND', missingPart: 'directory' });
  });

  await test('pure queue facts, order, selection and unknown JSON fields survive intact', async () => {
    latest = await save({ expectedRevision: -1 });
    assert.equal(latest.schemaVersion, 1); assert.equal(latest.workspaceId, workspaceId); assert.equal(latest.revision, 0);
    assert.deepEqual(Object.keys(latest).sort(), ['schemaVersion', 'workspaceId', 'revision', 'savedAt', 'payloadSha256', 'manifestSha256'].sort());
    const loaded = await load();
    assert.deepEqual(loaded.workspace, workspace); assert.deepEqual(loaded.manifest, latest);
    assert.equal(Object.getPrototypeOf(loaded.workspace.prototypeLike), Object.prototype); assert.equal({}.polluted, undefined);
    const state = JSON.parse(await readFile(join(storageRoot, workspaceId, 'state.json'), 'utf8'));
    assert.deepEqual(state.payload, workspace, 'payload is plain JSON, without runtime tags or session data copies');
    assert.equal(state.payloadSha256, hash(JSON.stringify(workspace)));
  });

  await test('capture happens before queued IO and readers return detached JSON', async () => {
    const candidate = structuredClone(workspace);
    const saving = save({ workspace: candidate, expectedRevision: latest.revision });
    candidate.items.reverse(); candidate.selectedSessionId = 'not-captured';
    latest = await saving;
    const loaded = await load(); assert.equal(loaded.workspace.selectedSessionId, 'sqa2'); assert.equal(loaded.workspace.items[0].sessionId, 'sqa1');
    loaded.workspace.items[0].state = 'mutated-reader';
    assert.equal((await load()).workspace.items[0].state, 'completed');
  });

  await test('stale and invalid CAS revisions never overwrite complete state', async () => {
    const before = await readFile(join(storageRoot, workspaceId, 'state.json'));
    await assert.rejects(save({ expectedRevision: 0 }), { code: 'WORKSPACE_REVISION_CONFLICT' });
    await assert.rejects(save({ expectedRevision: -2 }), { code: 'WORKSPACE_REVISION_INVALID' });
    assert.deepEqual(await readFile(join(storageRoot, workspaceId, 'state.json')), before);
  });

  await test('same-process concurrent CAS permits exactly one writer', async () => {
    const revision = latest.revision;
    const results = await Promise.allSettled([1, 2].map((epoch) => save({ workspace: { ...workspace, epoch }, expectedRevision: revision })));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'WORKSPACE_REVISION_CONFLICT');
    latest = (await load()).manifest; assert.equal(latest.revision, revision + 1);
  });

  await test('real child processes cannot both commit the same expected revision', async () => {
    const revision = latest.revision;
    const results = await Promise.all([10, 11].map(async (epoch) => {
      const script = `import {saveWorkspace} from ${JSON.stringify(new URL('../src/workspace-store.js', import.meta.url).href)};try{const x=await saveWorkspace({workspaceId:${JSON.stringify(workspaceId)},workspace:JSON.parse(${JSON.stringify(JSON.stringify({ ...workspace, epoch }))}),storageRoot:${JSON.stringify(storageRoot)},expectedRevision:${revision}});console.log(JSON.stringify({ok:true,revision:x.revision}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}`;
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true });
      return JSON.parse(stdout.trim());
    }));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.ok(['WORKSPACE_BUSY', 'WORKSPACE_REVISION_CONFLICT'].includes(results.find((result) => !result.ok).code));
    latest = (await load()).manifest; assert.equal(latest.revision, revision + 1);
  });

  await test('runtime objects, functions, cycles, accessors and non-JSON arrays are rejected before IO', async () => {
    const before = await readFile(join(storageRoot, workspaceId, 'state.json'));
    const cycle = {}; cycle.self = cycle;
    const sparse = []; sparse[2] = 'x';
    let called = false;
    const getter = {}; Object.defineProperty(getter, 'x', { enumerable: true, get() { called = true; return 1; } });
    for (const unknown of [new Map(), Buffer.from('runtime-bytes'), new AbortController(), () => {}, undefined, NaN, Infinity, cycle, getter, sparse]) {
      await assert.rejects(save({ workspace: { ...workspace, unknown } }), { code: 'WORKSPACE_NOT_JSON' });
    }
    assert.equal(called, false);
    assert.deepEqual(await readFile(join(storageRoot, workspaceId, 'state.json')), before);
  });

  await test('identity rules reject traversal, wrong workspaces and excessive ids', async () => {
    for (const badId of ['w', '../outside', 'w../outside', 'Wmain', 'w' + 'a'.repeat(81)]) {
      await assert.rejects(loadWorkspace({ workspaceId: badId, storageRoot }), { code: 'WORKSPACE_ID_INVALID' });
    }
    await assert.rejects(save({ workspace: { ...workspace, id: 'wother' } }), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
    const longId = 'w' + 'a'.repeat(80);
    const manifest = await saveWorkspace({ workspaceId: longId, workspace: { id: longId }, storageRoot });
    assert.equal(manifest.revision, 0);
  });

  await test('crashed temporary files never replace the last complete workspace', async () => {
    const before = await readFile(join(storageRoot, workspaceId, 'state.json'));
    await writeFile(join(storageRoot, workspaceId, 'state.crashed.tmp'), '{partial');
    assert.deepEqual((await load()).manifest, latest);
    assert.deepEqual(await readFile(join(storageRoot, workspaceId, 'state.json')), before);
  });

  await test('dead child-process locks recover and live locks are never stolen', async () => {
    const lock = join(storageRoot, workspaceId, 'state.lock');
    const script = `require('fs').writeFileSync(process.argv[1],JSON.stringify({schemaVersion:1,pid:process.pid,token:'terminated-child'}));`;
    await promisify(execFile)(process.execPath, ['-e', script, lock], { windowsHide: true });
    latest = await save({ expectedRevision: latest.revision });
    await writeFile(lock, JSON.stringify({ schemaVersion: 1, pid: process.pid, token: 'foreign-live-lock' }), { flag: 'wx' });
    await assert.rejects(save({ expectedRevision: latest.revision }), { code: 'WORKSPACE_BUSY' });
    assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'foreign-live-lock');
    await unlink(lock);
  });

  const cloneStorage = async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-corruption-'));
    await cp(join(storageRoot, workspaceId), join(root, workspaceId), { recursive: true });
    return root;
  };
  await test('an existing workspace losing state is damaged, never a new empty workspace', async () => {
    const root = await cloneStorage();
    const path = join(root, workspaceId, 'state.json');
    const expectedRevision = latest.revision;
    await unlink(path);
    await assert.rejects(loadWorkspace({ workspaceId, storageRoot: root }), { code: 'WORKSPACE_MISSING', missingPart: 'state' });
    await assert.rejects(saveWorkspace({ workspaceId, workspace, expectedRevision, storageRoot: root }), { code: 'WORKSPACE_REVISION_CONFLICT' });
    await assert.rejects(readFile(path), { code: 'ENOENT' }, 'a CAS retry never recreates an empty replacement');
  });
  await test('corruption, missing files, header/payload hash changes and cross-workspace copies fail explicitly', async () => {
    const cases = [
      { code: 'WORKSPACE_CORRUPT', change: (path) => writeFile(path, '{') },
      { code: 'WORKSPACE_MISSING', change: (path) => unlink(path) },
      { code: 'WORKSPACE_HASH_MISMATCH', change: async (path) => { const state = JSON.parse(await readFile(path, 'utf8')); state.payload.items.reverse(); await writeFile(path, JSON.stringify(state)); } },
      { code: 'WORKSPACE_HASH_MISMATCH', change: async (path) => { const state = JSON.parse(await readFile(path, 'utf8')); state.revision += 1; await writeFile(path, JSON.stringify(state)); } },
      { code: 'WORKSPACE_IDENTITY_MISMATCH', change: async (path) => { const state = JSON.parse(await readFile(path, 'utf8')); state.workspaceId = 'wother'; await writeFile(path, JSON.stringify(state)); } },
    ];
    for (const item of cases) {
      const root = await cloneStorage(); await item.change(join(root, workspaceId, 'state.json'));
      await assert.rejects(loadWorkspace({ workspaceId, storageRoot: root }), { code: item.code });
      if (item.code !== 'WORKSPACE_MISSING') await assert.rejects(saveWorkspace({ workspaceId, workspace, storageRoot: root }), { code: item.code });
    }
    const mixed = await mkdtemp(join(tmpdir(), 'dsh-workspace-mix-'));
    await cp(join(storageRoot, workspaceId), join(mixed, 'wother'), { recursive: true });
    await assert.rejects(loadWorkspace({ workspaceId: 'wother', storageRoot: mixed }), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  });

  await test('failure after rename includes the complete checked committedManifest', async () => {
    const revision = latest.revision;
    let error;
    try { await save({ workspace: { ...workspace, epoch: 300 }, expectedRevision: revision, faultHooks: { afterRename() { throw new Error('fixture-after-rename'); } } }); }
    catch (caught) { error = caught; }
    assert.equal(error?.message, 'fixture-after-rename');
    const loaded = await load(); assert.deepEqual(error.committedManifest, loaded.manifest);
    assert.equal(loaded.workspace.epoch, 300); assert.equal(loaded.manifest.revision, revision + 1);
    latest = loaded.manifest;
  });

  if (process.platform === 'win32') {
    await test('transient Windows replacement denials retry the same synced file and lock, then commit exactly once', async () => {
      for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
        const revision = latest.revision; const target = join(storageRoot, workspaceId, 'state.json');
        const before = await readFile(target); let attempts = 0, temporary, lockToken;
        const manifest = await withRenamePatch(async (from, to, original) => {
          assert.equal(to, target); temporary ||= from; assert.equal(from, temporary);
          const lock = JSON.parse(await readFile(join(storageRoot, workspaceId, 'state.lock'), 'utf8'));
          lockToken ||= lock.token; assert.equal(lock.token, lockToken);
          attempts += 1;
          if (attempts <= 2) { assert.ok(before.equals(await readFile(target))); throw Object.assign(new Error('fixture-transient-replacement'), {code}); }
          return original(from, to);
        }, () => save({workspace: {...workspace, retryFixture: code}, expectedRevision: revision}));
        assert.equal(attempts, 3); assert.equal(manifest.revision, revision + 1);
        const loaded = await load(); assert.equal(loaded.workspace.retryFixture, code); assert.deepEqual(loaded.manifest, manifest);
        latest = manifest;
      }
    });

    await test('persistent Windows replacement denial stops after six attempts, preserves prior bytes and permits later same-CAS save', async () => {
      const revision = latest.revision; const target = join(storageRoot, workspaceId, 'state.json'); const before = await readFile(target);
      let attempts = 0, temporary;
      const error = await withRenamePatch(async (from, to) => {
        assert.equal(to, target); temporary ||= from; assert.equal(from, temporary); attempts += 1;
        assert.ok(before.equals(await readFile(target)));
        throw Object.assign(new Error('fixture-persistent-replacement'), {code: 'EPERM'});
      }, async () => {
        try { await save({workspace: {...workspace, retryFixture: 'must-not-commit'}, expectedRevision: revision}); }
        catch (error) { return error; }
        assert.fail('persistent denial must fail');
      });
      assert.equal(attempts, 6); assert.equal(error.code, 'EPERM'); assert.equal(error.committedManifest, undefined);
      assert.ok(before.equals(await readFile(target))); assert.equal((await load()).manifest.revision, revision);
      assert.ok(!(await readdir(join(storageRoot, workspaceId))).some((name) => /^state\.[a-f0-9-]{36}\.tmp$/.test(name)));
      await assert.rejects(readFile(join(storageRoot, workspaceId, 'state.lock')), {code: 'ENOENT'});
      latest = await save({workspace: {...workspace, retryFixture: 'same-CAS-after-failure'}, expectedRevision: revision});
      assert.equal(latest.revision, revision + 1);
    });

    await test('non-transient replacement errors fail immediately and never delete the previous state', async () => {
      const revision = latest.revision; const target = join(storageRoot, workspaceId, 'state.json'); const before = await readFile(target); let attempts = 0;
      await withRenamePatch(async () => { attempts += 1; throw Object.assign(new Error('fixture-not-transient'), {code: 'EIO'}); },
        () => assert.rejects(save({expectedRevision: revision}), {code: 'EIO'}));
      assert.equal(attempts, 1); assert.ok(before.equals(await readFile(target))); assert.equal((await load()).manifest.revision, revision);
      assert.ok(!(await readdir(join(storageRoot, workspaceId))).some((name) => /^state\.[a-f0-9-]{36}\.tmp$/.test(name)));
    });

    await test('replacement retries retain the live lock and reject peer writes and queued stale-CAS snapshots', async () => {
      const revision = latest.revision; const target = join(storageRoot, workspaceId, 'state.json'); const before = await readFile(target);
      const entered = defer(), retrying = defer(), finish = defer(); let attempts = 0;
      await withRenamePatch(async (from, to, original) => {
        assert.equal(to, target); attempts += 1;
        if (attempts === 1) { entered.release(); throw Object.assign(new Error('fixture-retry-lock'), {code: 'EPERM'}); }
        retrying.release(); await finish.promise; return original(from, to);
      }, async () => {
        const winner = save({workspace: {...workspace, retryFixture: 'winner'}, expectedRevision: revision});
        await entered.promise; let queuedSettled = false;
        const queued = save({workspace: {...workspace, retryFixture: 'stale-writer'}, expectedRevision: revision})
          .then((manifest) => ({manifest}), (error) => ({error})).finally(() => { queuedSettled = true; });
        try {
          await retrying.promise; assert.equal(queuedSettled, false); assert.ok(before.equals(await readFile(target)));
          const script = `import {saveWorkspace} from ${JSON.stringify(new URL('../src/workspace-store.js', import.meta.url).href)};const workspace=JSON.parse(${JSON.stringify(JSON.stringify({...workspace, retryFixture: 'peer'}))});try{await saveWorkspace({workspaceId:${JSON.stringify(workspaceId)},workspace,storageRoot:${JSON.stringify(storageRoot)},expectedRevision:${revision}});console.log(JSON.stringify({unexpectedCommit:true}));}catch(error){console.log(JSON.stringify({code:error.code}));}`;
          const {stdout} = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {windowsHide: true});
          assert.equal(JSON.parse(stdout).code, 'WORKSPACE_BUSY'); assert.ok(before.equals(await readFile(target)));
        } finally { finish.release(); }
        latest = await winner; const loser = await queued;
        assert.equal(attempts, 2); assert.equal(latest.revision, revision + 1); assert.equal(loser.error?.code, 'WORKSPACE_REVISION_CONFLICT');
        assert.equal(loser.error.currentRevision, latest.revision); assert.equal((await load()).workspace.retryFixture, 'winner');
      });
    });

    await test('actual Windows sharing failure before rename preserves complete prior bytes', async () => {
      const path = join(storageRoot, workspaceId, 'state.json');
      const before = await readFile(path);
      const release = await holdWindowsFile(path);
      try {
        await assert.rejects(save({ expectedRevision: latest.revision }), (error) => !error.committedManifest);
        assert.deepEqual(await readFile(path), before); assert.deepEqual((await load()).manifest, latest);
      } finally { await release(); }
      assert.ok(!(await readdir(join(storageRoot, workspaceId))).some((name) => /^state\.[a-f0-9-]{36}\.tmp$/.test(name)));
    });

    await test('actual Windows post-commit lock cleanup failure recovers with exact own token and CAS', async () => {
      const revision = latest.revision;
      let release; let error;
      try {
        await save({ workspace: { ...workspace, epoch: 400 }, expectedRevision: revision,
          faultHooks: { async afterRename({ directory }) { release = await holdWindowsFile(join(directory, 'state.lock')); } } });
      } catch (caught) { error = caught; }
      try {
        const loaded = await load(); assert.ok(error); assert.deepEqual(error.committedManifest, loaded.manifest);
        assert.equal(loaded.workspace.epoch, 400); assert.equal(loaded.manifest.revision, revision + 1);
        const bytes = await readFile(join(storageRoot, workspaceId, 'state.json'));
        await assert.rejects(save({ expectedRevision: loaded.manifest.revision }), (error) => !error.committedManifest);
        assert.deepEqual(await readFile(join(storageRoot, workspaceId, 'state.json')), bytes);
        latest = loaded.manifest;
      } finally { if (release) await release(); }
      latest = await save({ workspace: { ...workspace, epoch: 401 }, expectedRevision: latest.revision });
      assert.equal(latest.revision, revision + 2); assert.equal((await load()).workspace.epoch, 401);
    });
  }

  await test('directory/record type mismatches are rejected instead of followed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-file-type-'));
    await mkdir(join(root, workspaceId), { recursive: true }); await mkdir(join(root, workspaceId, 'state.json'));
    await assert.rejects(loadWorkspace({ workspaceId, storageRoot: root }), { code: 'WORKSPACE_PATH_INVALID' });
  });

  await test('a fresh process restores exact workspace facts through DSH_WORKSPACE_ROOT', async () => {
    const script = `import {loadWorkspace} from ${JSON.stringify(new URL('../src/workspace-store.js', import.meta.url).href)};const x=await loadWorkspace({workspaceId:${JSON.stringify(workspaceId)}});console.log(JSON.stringify(x));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DSH_WORKSPACE_ROOT: storageRoot }, windowsHide: true });
    assert.deepEqual(JSON.parse(stdout), await load());
  });
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  report.passed = report.checks.filter((entry) => entry.ok).length;
  report.failed = report.checks.filter((entry) => !entry.ok).length;
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(`Workspace store: ${report.passed} passed / ${report.failed} failed; model calls 0. ${OUT}`);
