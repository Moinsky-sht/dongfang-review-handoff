import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, cp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { saveSessionSnapshot, loadSessionSnapshot, listSessionSnapshots } from '../src/session-store.js';

const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-session-store-'));
const sessionId = 'steststore';
const hash = (x) => createHash('sha256').update(x).digest('hex');
const workVersion = { id: `${sessionId}:v000000-${hash('working')}`, sessionId, revision: 0, sha256: hash('working') };
const snapshot = { id: sessionId, name: 'software-fixture.docx', workVersion, createdAt: 1, reviewRunning: true,
  result: { issues: [], recheck: { byKey: new Map([['FMT|p0', { verdict: 'agree', optional: undefined }], ['x', { verdict: 'unsure' }]]) } },
  resultVersionId: workVersion.id, resultTexts: { body: ['software'], footnote: [], endnote: [] },
  history: { entries: [{ versionId: workVersion.id, appliedFixes: [] }], cursor: 0 },
  mutationEpoch: 0, mutationReceipts: {}, reviewRecords: { [workVersion.id]: { resultVersionId: workVersion.id } },
  future: { tag: 'map', value: [['ordinary', 'object']], nested: ['map', [['still', 'array']]] },
  prototypeLike: JSON.parse('{"__proto__":{"polluted":true},"constructor":"ordinary"}'),
  applyingFixes: true, buffer: Buffer.from('raw-buffer'), originalBuffer: Buffer.from('raw-original'),
  doc: { text: 'do-not-store-doc' }, controller: new AbortController(), reviewController: new AbortController(),
  _zip: { read() {} }, _zipSrc: Buffer.from('zip-cache'), _storeRevision: 100 };
let count = 0;
const test = async (name, fn) => { await fn(); count += 1; console.log(`✓ ${name}`); };
let latest;

async function holdWindowsFile(path) {
  const escapedPath = path.replace(/'/g, "''");
  const script = `$stream=[IO.File]::Open('${escapedPath}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[Console]::WriteLine('READY');[Console]::In.ReadLine()|Out-Null;$stream.Dispose();`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows sharing fixture timed out')); }, 5000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', () => { clearTimeout(timer); reject(new Error('Windows sharing fixture exited before ready')); });
    child.stdout.once('data', (data) => { clearTimeout(timer); data.toString().includes('READY') ? ready() : reject(new Error('Missing ready marker')); });
  });
  return async () => {
    const done = child.exitCode == null ? new Promise((resolve) => child.once('exit', resolve)) : Promise.resolve();
    child.stdin.end('\n'); await done;
  };
}

await test('pure state, unknown fields and Maps survive without runtime/byte copies or tag collisions', async () => {
  latest = await saveSessionSnapshot({ sessionId, snapshot, storageRoot, expectedRevision: -1 });
  assert.equal(latest.revision, 0);
  const loaded = await loadSessionSnapshot({ sessionId, storageRoot });
  assert.deepEqual(loaded.manifest, latest);
  assert.ok(loaded.snapshot.result.recheck.byKey instanceof Map);
  assert.deepEqual(loaded.snapshot.result.recheck.byKey, snapshot.result.recheck.byKey);
  assert.deepEqual(loaded.snapshot.future, snapshot.future);
  assert.deepEqual(loaded.snapshot.reviewRecords, snapshot.reviewRecords);
  assert.equal(loaded.snapshot.reviewRunning, true, 'restart handler can explicitly mark interrupted work');
  assert.ok(Object.hasOwn(loaded.snapshot.prototypeLike, '__proto__'));
  assert.equal(Object.getPrototypeOf(loaded.snapshot.prototypeLike), Object.prototype);
  assert.equal({}.polluted, undefined);
  for (const key of ['buffer', 'originalBuffer', 'doc', 'controller', 'reviewController', '_zip', '_zipSrc', 'applyingFixes', '_storeRevision']) assert.ok(!Object.hasOwn(loaded.snapshot, key), key);
  const raw = await readFile(join(storageRoot, sessionId, 'state.json'), 'utf8');
  assert.ok(!raw.includes('raw-buffer')); assert.ok(!raw.includes('do-not-store-doc'));
});

await test('CAS rejects a stale snapshot and concurrent same-revision writes cannot both commit', async () => {
  latest = await saveSessionSnapshot({ sessionId, snapshot: { ...snapshot, mutationEpoch: 1 }, expectedRevision: latest.revision, storageRoot });
  await assert.rejects(saveSessionSnapshot({ sessionId, snapshot: { ...snapshot, mutationEpoch: 2 }, expectedRevision: 0, storageRoot }), { code: 'SESSION_REVISION_CONFLICT' });
  assert.equal((await loadSessionSnapshot({ sessionId, storageRoot })).snapshot.mutationEpoch, 1);
  const revision = latest.revision;
  const results = await Promise.allSettled([2, 3].map((mutationEpoch) => saveSessionSnapshot({ sessionId, snapshot: { ...snapshot, mutationEpoch }, expectedRevision: revision, storageRoot })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'SESSION_REVISION_CONFLICT');
  latest = (await loadSessionSnapshot({ sessionId, storageRoot })).manifest;
});

await test('capture is immutable while queued and listing returns checked manifests', async () => {
  const candidate = { ...snapshot, future: { nested: { value: 'captured' } } };
  const saving = saveSessionSnapshot({ sessionId, snapshot: candidate, storageRoot, expectedRevision: latest.revision });
  candidate.future.nested.value = 'changed-after-call';
  latest = await saving;
  assert.equal((await loadSessionSnapshot({ sessionId, storageRoot })).snapshot.future.nested.value, 'captured');
  const list = await listSessionSnapshots({ storageRoot });
  assert.deepEqual(list, [latest]);
  assert.deepEqual(await listSessionSnapshots({ storageRoot: join(storageRoot, 'not-created') }), []);
  await assert.rejects(loadSessionSnapshot({ sessionId: 'sunknown', storageRoot }), { code: 'SESSION_NOT_FOUND' });
  await assert.rejects(loadSessionSnapshot({ sessionId, storageRoot: join(storageRoot, 'not-created') }), { code: 'SESSION_NOT_FOUND' });
});

await test('cross-process CAS prevents both writers committing the same expected revision', async () => {
  const revision = latest.revision;
  const calls = [10, 11].map(async (mutationEpoch) => {
    const plain = { id: sessionId, workVersion, mutationEpoch };
    const script = `import {saveSessionSnapshot} from ${JSON.stringify(new URL('../src/session-store.js', import.meta.url).href)};try{const x=await saveSessionSnapshot({sessionId:${JSON.stringify(sessionId)},snapshot:${JSON.stringify(plain)},storageRoot:${JSON.stringify(storageRoot)},expectedRevision:${revision}});console.log(JSON.stringify({ok:true,revision:x.revision}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true });
    return JSON.parse(stdout.trim());
  });
  const results = await Promise.all(calls);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(['SESSION_BUSY', 'SESSION_REVISION_CONFLICT'].includes(results.find((r) => !r.ok).code));
  latest = (await loadSessionSnapshot({ sessionId, storageRoot })).manifest;
  assert.equal(latest.revision, revision + 1);
});

await test('an interrupted temporary write never replaces the previous complete state', async () => {
  const before = await readFile(join(storageRoot, sessionId, 'state.json'));
  await writeFile(join(storageRoot, sessionId, 'state.crashed.tmp'), '{"partial":');
  const loaded = await loadSessionSnapshot({ sessionId, storageRoot });
  assert.deepEqual(loaded.manifest, latest);
  assert.deepEqual(await readFile(join(storageRoot, sessionId, 'state.json')), before);
});

await test('post-rename failure reports the checked committed manifest, not a false rollback', async () => {
  const before = latest.revision;
  let failure;
  try {
    await saveSessionSnapshot({ sessionId, snapshot: { ...snapshot, mutationEpoch: 300 }, expectedRevision: before, storageRoot,
      faultHooks: { afterRename() { throw new Error('injected-after-rename'); } } });
  } catch (err) { failure = err; }
  assert.equal(failure?.message, 'injected-after-rename');
  const loaded = await loadSessionSnapshot({ sessionId, storageRoot });
  assert.deepEqual(failure.committedManifest, loaded.manifest);
  assert.equal(loaded.snapshot.mutationEpoch, 300);
  assert.equal(loaded.manifest.revision, before + 1);
  latest = loaded.manifest;
});

await test('dead process storage lock is recovered; live ownership is never stolen', async () => {
  const lock = join(storageRoot, sessionId, 'state.lock');
  const script = `require('fs').writeFileSync(process.argv[1],JSON.stringify({schemaVersion:1,pid:process.pid,token:'crashed-owner'}));`;
  await promisify(execFile)(process.execPath, ['-e', script, lock], { windowsHide: true });
  latest = await saveSessionSnapshot({ sessionId, snapshot, storageRoot, expectedRevision: latest.revision });
  await writeFile(lock, JSON.stringify({ schemaVersion: 1, pid: process.pid, token: 'live-owner' }), { flag: 'wx' });
  await assert.rejects(saveSessionSnapshot({ sessionId, snapshot, storageRoot, expectedRevision: latest.revision }), { code: 'SESSION_BUSY' });
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'live-owner');
  await unlink(lock);
});

const cloneStorage = async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-corruption-'));
  await cp(join(storageRoot, sessionId), join(root, sessionId), { recursive: true });
  return root;
};
await test('truncated JSON, checksum/identity changes, missing state and session mixing fail explicitly', async () => {
  const cases = [
    { code: 'SESSION_CORRUPT', change: async (path) => writeFile(path, '{') },
    { code: 'SESSION_HASH_MISMATCH', change: async (path) => { const state = JSON.parse(await readFile(path, 'utf8')); state.payloadSha256 = '0'.repeat(64); await writeFile(path, JSON.stringify(state)); } },
    { code: 'SESSION_HASH_MISMATCH', change: async (path) => { const state = JSON.parse(await readFile(path, 'utf8')); state.revision += 1; await writeFile(path, JSON.stringify(state)); } },
    { code: 'SESSION_IDENTITY_MISMATCH', change: async (path) => { const state = JSON.parse(await readFile(path, 'utf8')); state.sessionId = 'sother'; await writeFile(path, JSON.stringify(state)); } },
    { code: 'SESSION_MISSING', change: async (path) => unlink(path) },
  ];
  for (const item of cases) {
    const root = await cloneStorage();
    await item.change(join(root, sessionId, 'state.json'));
    await assert.rejects(loadSessionSnapshot({ sessionId, storageRoot: root }), { code: item.code });
    await assert.rejects(listSessionSnapshots({ storageRoot: root }), { code: item.code });
  }
  const mixed = await mkdtemp(join(tmpdir(), 'dsh-session-mix-'));
  await cp(join(storageRoot, sessionId), join(mixed, 'sother'), { recursive: true });
  await assert.rejects(loadSessionSnapshot({ sessionId: 'sother', storageRoot: mixed }), { code: 'SESSION_IDENTITY_MISMATCH' });
  await assert.rejects(saveSessionSnapshot({ sessionId: 'sother', snapshot, storageRoot }), { code: 'SESSION_IDENTITY_MISMATCH' });
  await assert.rejects(loadSessionSnapshot({ sessionId: '../outside', storageRoot }), { code: 'SESSION_ID_INVALID' });
  await assert.rejects(saveSessionSnapshot({ sessionId, snapshot: { ...snapshot, workVersion: { ...workVersion, id: 'sother:v000000-' + hash('working') } }, storageRoot }), { code: 'SESSION_IDENTITY_MISMATCH' });
});

await test('cyclic/runtime payloads fail before replacing the last good manifest', async () => {
  const before = await readFile(join(storageRoot, sessionId, 'state.json'));
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(saveSessionSnapshot({ sessionId, snapshot: { ...snapshot, unknown: cycle }, storageRoot }), { code: 'SESSION_UNSERIALIZABLE' });
  await assert.rejects(saveSessionSnapshot({ sessionId, snapshot: { ...snapshot, unknown: () => {} }, storageRoot }), { code: 'SESSION_UNSERIALIZABLE' });
  assert.deepEqual(await readFile(join(storageRoot, sessionId, 'state.json')), before);
});

if (process.platform === 'win32') {
  await test('Windows transient real sharing failure retries the same complete temp and commits exactly one CAS revision', async () => {
    const statePath = join(storageRoot, sessionId, 'state.json');
    const before = await readFile(statePath), revision = latest.revision;
    const release = await holdWindowsFile(statePath);
    const attempts = []; let temporaryPath, temporarySha256, releaseTimer, releasePromise;
    const releaseOnce = () => releasePromise ||= release();
    try {
      const saved = await saveSessionSnapshot({ sessionId, snapshot: { ...snapshot, mutationEpoch: 500 }, storageRoot, expectedRevision: revision,
        faultHooks: { async beforeRenameAttempt({ temporary, target, attempt }) {
          // No injected sharing error: FileShare.Read really prevents Windows rename.
          attempts.push(attempt); assert.equal(target, statePath);
          assert.deepEqual(await readFile(statePath), before, 'every failed rename leaves all old manifest bytes intact');
          const temporaryBytes = await readFile(temporary);
          if (attempt === 0) {
            temporaryPath = temporary; temporarySha256 = hash(temporaryBytes);
            releaseTimer = setTimeout(() => { releaseOnce().catch(() => {}); }, 90);
          }
          assert.equal(temporary, temporaryPath, 'bounded retry must reuse the same atomic temp');
          assert.equal(hash(temporaryBytes), temporarySha256, 'retry cannot rebuild or partially rewrite the captured state');
        } } });
      assert.ok(attempts.length >= 2 && attempts.length <= 6, 'real first sharing failure was retried within the finite attempt budget');
      assert.deepEqual(attempts, Array.from({ length: attempts.length }, (_, i) => i));
      const loaded = await loadSessionSnapshot({ sessionId, storageRoot }), bytes = await readFile(statePath), state = JSON.parse(bytes);
      assert.deepEqual(saved, loaded.manifest); assert.equal(saved.revision, revision + 1); assert.equal(loaded.snapshot.mutationEpoch, 500);
      assert.equal(hash(bytes), temporarySha256, 'only the complete captured temporary state was installed');
      assert.equal(state.payloadSha256, hash(JSON.stringify(state.payload)));
      assert.equal(state.manifestSha256, hash(JSON.stringify({ schemaVersion: state.schemaVersion, sessionId: state.sessionId,
        revision: state.revision, savedAt: state.savedAt, payloadSha256: state.payloadSha256 })));
      await assert.rejects(saveSessionSnapshot({ sessionId, snapshot, storageRoot, expectedRevision: revision }), { code: 'SESSION_REVISION_CONFLICT' });
      assert.deepEqual(await readFile(statePath), bytes, 'stale CAS cannot add a second commit after successful retry');
      latest = saved;
    } finally { clearTimeout(releaseTimer); await releaseOnce(); }
    assert.ok(!(await readdir(join(storageRoot, sessionId))).some(name => /^state\.[a-f0-9-]{36}\.tmp$/.test(name)), 'successful retry leaves no atomic temp behind');
  });

  await test('Windows non-sharing EIO fails on its first attempt without changing the checked old state', async () => {
    const statePath = join(storageRoot, sessionId, 'state.json'), before = await readFile(statePath), attempts = [];
    await assert.rejects(saveSessionSnapshot({ sessionId, snapshot: { ...snapshot, mutationEpoch: 501 }, storageRoot, expectedRevision: latest.revision,
      faultHooks: { beforeRenameAttempt({ attempt }) { attempts.push(attempt); throw Object.assign(new Error('software non-sharing I/O failure'), { code: 'EIO' }); } } }), { code: 'EIO' });
    assert.deepEqual(attempts, [0]); assert.deepEqual(await readFile(statePath), before);
    assert.deepEqual((await loadSessionSnapshot({ sessionId, storageRoot })).manifest, latest);
    assert.ok(!(await readdir(join(storageRoot, sessionId))).some(name => /^state\.[a-f0-9-]{36}\.tmp$/.test(name)), 'non-retriable failed save cleans its atomic temp');
  });

  await test('Windows replacement sharing failure preserves the complete old manifest', async () => {
    const statePath = join(storageRoot, sessionId, 'state.json');
    const before = await readFile(statePath);
    const release = await holdWindowsFile(statePath);
    try {
      await assert.rejects(saveSessionSnapshot({ sessionId, snapshot, storageRoot, expectedRevision: latest.revision }), (err) => !err.committedManifest);
      assert.deepEqual(await readFile(statePath), before);
      assert.deepEqual((await loadSessionSnapshot({ sessionId, storageRoot })).manifest, latest);
    } finally {
      await release();
    }
    assert.ok(!(await readdir(join(storageRoot, sessionId))).some((name) => /^state\.[a-f0-9-]{36}\.tmp$/.test(name)), 'failed atomic save cleaned its own temporary file');
  });

  await test('Windows post-commit release failure is identified and ended-own lock recovers with CAS', async () => {
    const before = latest.revision;
    let release; let failure;
    try {
      await saveSessionSnapshot({ sessionId, snapshot: { ...snapshot, mutationEpoch: 400 }, expectedRevision: before, storageRoot,
        faultHooks: { async afterRename({ directory }) { release = await holdWindowsFile(join(directory, 'state.lock')); } } });
    } catch (err) { failure = err; }
    try {
      assert.ok(failure, 'sharing constraint must fail lock unlink after commit');
      const loaded = await loadSessionSnapshot({ sessionId, storageRoot });
      assert.deepEqual(failure.committedManifest, loaded.manifest);
      assert.equal(loaded.manifest.revision, before + 1); assert.equal(loaded.snapshot.mutationEpoch, 400);
      const bytes = await readFile(join(storageRoot, sessionId, 'state.json'));
      await assert.rejects(saveSessionSnapshot({ sessionId, snapshot, expectedRevision: loaded.manifest.revision, storageRoot }), (err) => !err.committedManifest);
      assert.deepEqual(await readFile(join(storageRoot, sessionId, 'state.json')), bytes, 'blocked lock recovery never overwrites committed state');
      latest = loaded.manifest;
    } finally { if (release) await release(); }
    latest = await saveSessionSnapshot({ sessionId, snapshot: { ...snapshot, mutationEpoch: 401 }, expectedRevision: latest.revision, storageRoot });
    assert.equal(latest.revision, before + 2);
    assert.equal((await loadSessionSnapshot({ sessionId, storageRoot })).snapshot.mutationEpoch, 401);
  });
}

await test('default directory honors DSH_SESSION_ROOT in a fresh process', async () => {
  const script = `import {loadSessionSnapshot} from ${JSON.stringify(new URL('../src/session-store.js', import.meta.url).href)};const x=await loadSessionSnapshot({sessionId:${JSON.stringify(sessionId)}});console.log(x.manifest.revision);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DSH_SESSION_ROOT: storageRoot }, windowsHide: true });
  assert.equal(Number(stdout.trim()), latest.revision);
});

console.log(`Session store: ${count} scenarios passed; model calls 0.`);
