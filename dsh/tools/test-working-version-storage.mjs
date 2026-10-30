import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rmdir, writeFile, cp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { saveWorkingVersion, loadWorkingVersion, sha256 } from '../src/working-version.js';

const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-working-version-'));
const args = { storageRoot, sessionId: 'stestversion', name: 'fixture.docx', originalBuffer: Buffer.from('original'), buffer: Buffer.from('clean') };
const first = await saveWorkingVersion(args);
assert.equal(first.revision, 0);
assert.equal(first.sourceSha256, sha256(args.originalBuffer));
assert.deepEqual(await saveWorkingVersion(args), first, 'identical retry reuses immutable identity/time');
assert.deepEqual(await readFile(join(storageRoot, args.sessionId, 'original.docx')), args.originalBuffer);

const changed = Buffer.from('changed');
const stem = `v000001-${sha256(changed)}`;
const directory = join(storageRoot, args.sessionId);
// Reproduce an interrupted attempt that already persisted DOCX bytes.
await writeFile(join(directory, stem + '.docx'), changed, { flag: 'wx' });
const secondArgs = { ...args, buffer: changed, parent: first, operation: 'apply-fixes', patches: [{ patchId: 'p1' }] };
const second = await saveWorkingVersion(secondArgs);
assert.equal(second.parentId, first.id);
assert.equal(second.revision, 1);
assert.deepEqual(await readFile(join(directory, stem + '.docx')), changed);

const thirdBytes = Buffer.from('third');
const thirdStem = `v000002-${sha256(thirdBytes)}`;
const markerPath = join(directory, thirdStem + '.complete.json');
await mkdir(markerPath);
const thirdArgs = { ...args, buffer: thirdBytes, parent: second };
await assert.rejects(saveWorkingVersion(thirdArgs), 'failed commit must not claim success');
await rmdir(markerPath); // Empty directory created by this test only.
const third = await saveWorkingVersion(thirdArgs);
assert.equal(third.revision, 2, 'interrupted complete marker can be retried');
const complete = JSON.parse(await readFile(markerPath, 'utf8'));
assert.equal(complete.sha256, sha256(thirdBytes));
assert.equal(complete.metadataSha256, sha256(await readFile(join(directory, thirdStem + '.json'))));
await assert.rejects(saveWorkingVersion({ ...thirdArgs, operation: 'different-action' }), /身份冲突/);
await assert.rejects(saveWorkingVersion({ ...args, sessionId: '../outside' }), /身份无效/);
assert.ok((await readdir(directory)).every((name) => !name.endsWith('.tmp')));

const loaded = await loadWorkingVersion({ storageRoot, sessionId: args.sessionId, versionId: second.id });
assert.deepEqual(loaded.version, second);
assert.deepEqual(loaded.buffer, changed);
assert.deepEqual(loaded.originalBuffer, args.originalBuffer);
const byteSnapshot = Object.fromEntries(await Promise.all((await readdir(directory)).map(async (name) => [name, sha256(await readFile(join(directory, name)))])));
await loadWorkingVersion({ storageRoot, sessionId: args.sessionId, versionId: first.id });
assert.deepEqual(Object.fromEntries(await Promise.all((await readdir(directory)).map(async (name) => [name, sha256(await readFile(join(directory, name)))]))), byteSnapshot, 'load is read-only');

const branch = await saveWorkingVersion({ ...secondArgs, parent: first, revision: 4, patches: [{ patchId: 'branch' }], operation: 'branch-after-undo' });
assert.equal(branch.revision, 4); assert.equal(branch.parentId, first.id);
assert.notEqual(branch.id, second.id, 'same bytes on a new branch have a distinct immutable identity');
assert.deepEqual((await loadWorkingVersion({ storageRoot, sessionId: args.sessionId, versionId: branch.id })).buffer, changed);
await assert.rejects(saveWorkingVersion({ ...args, revision: 1 }), { code: 'VERSION_REVISION_INVALID' });
await assert.rejects(saveWorkingVersion({ ...secondArgs, revision: 0 }), { code: 'VERSION_REVISION_INVALID' });
await assert.rejects(loadWorkingVersion({ storageRoot, sessionId: '../outside', versionId: first.id }), { code: 'VERSION_ID_INVALID' });
await assert.rejects(loadWorkingVersion({ storageRoot, sessionId: 'sother', versionId: first.id }), { code: 'VERSION_ID_INVALID' });
await assert.rejects(loadWorkingVersion({ storageRoot, sessionId: args.sessionId, versionId: `${args.sessionId}:../../original.docx` }), { code: 'VERSION_ID_INVALID' });

const cloneStorage = async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-version-corruption-'));
  await cp(directory, join(root, args.sessionId), { recursive: true });
  return root;
};
const paths = (root) => ({
  metadata: join(root, args.sessionId, stem + '.json'),
  marker: join(root, args.sessionId, stem + '.complete.json'),
  docx: join(root, args.sessionId, stem + '.docx'),
  original: join(root, args.sessionId, 'original.docx'),
});
const expectCorrupt = async (mutate, code) => {
  const root = await cloneStorage();
  await mutate(paths(root));
  await assert.rejects(loadWorkingVersion({ storageRoot: root, sessionId: args.sessionId, versionId: second.id }), { code });
};
await expectCorrupt(async (p) => unlink(p.marker), 'VERSION_INCOMPLETE');
await expectCorrupt(async (p) => writeFile(p.marker, '{'), 'VERSION_CORRUPT');
await expectCorrupt(async (p) => writeFile(p.metadata, '{}'), 'VERSION_METADATA_HASH_MISMATCH');
await expectCorrupt(async (p) => writeFile(p.docx, 'tampered'), 'VERSION_HASH_MISMATCH');
await expectCorrupt(async (p) => writeFile(p.original, 'wrong original'), 'SOURCE_HASH_MISMATCH');
await expectCorrupt(async (p) => unlink(p.docx), 'VERSION_INCOMPLETE');
await expectCorrupt(async (p) => {
  const marker = JSON.parse(await readFile(p.marker, 'utf8'));
  marker.id = 'sother:' + stem;
  await writeFile(p.marker, JSON.stringify(marker));
}, 'VERSION_IDENTITY_MISMATCH');
await expectCorrupt(async (p) => {
  const metadata = JSON.parse(await readFile(p.metadata, 'utf8'));
  metadata.sessionId = 'sother';
  const bytes = JSON.stringify(metadata);
  const marker = JSON.parse(await readFile(p.marker, 'utf8'));
  marker.metadataSha256 = sha256(bytes);
  await writeFile(p.metadata, bytes); await writeFile(p.marker, JSON.stringify(marker));
}, 'VERSION_IDENTITY_MISMATCH');

const pathRoot = await cloneStorage();
const pathFiles = paths(pathRoot);
const evilMetadata = JSON.parse(await readFile(pathFiles.metadata, 'utf8'));
evilMetadata.file = '../outside.docx';
const evilBytes = JSON.stringify(evilMetadata);
const evilMarker = JSON.parse(await readFile(pathFiles.marker, 'utf8'));
evilMarker.metadataSha256 = sha256(evilBytes);
await writeFile(pathFiles.metadata, evilBytes); await writeFile(pathFiles.marker, JSON.stringify(evilMarker));
assert.deepEqual((await loadWorkingVersion({ storageRoot: pathRoot, sessionId: args.sessionId, versionId: second.id })).buffer, changed, 'metadata.file is never followed');

const script = `import {loadWorkingVersion} from ${JSON.stringify(new URL('../src/working-version.js', import.meta.url).href)}; const x=await loadWorkingVersion({sessionId:${JSON.stringify(args.sessionId)},versionId:${JSON.stringify(first.id)}}); console.log(x.version.id);`;
const environment = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DSH_WORKING_VERSION_ROOT: storageRoot }, windowsHide: true });
assert.equal(environment.stdout.trim(), first.id, 'default root honors DSH_WORKING_VERSION_ROOT');
console.log('工作版本存储回归通过：完整只读加载、不可变快照、分支序号、重试、损坏校验、身份隔离与环境目录（模型调用 0）');
