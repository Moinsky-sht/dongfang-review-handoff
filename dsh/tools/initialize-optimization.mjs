/** 冻结长期优化基线并初始化逐文件账本；只读原始语料，不调用模型。 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CORPUS_ROOT, DSH_ROOT } from './paths.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashFile = (file) => sha(readFileSync(file));
const slash = (p) => p.replaceAll('\\', '/');
const walk = (root) => {
  const result = [];
  function visit(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) visit(abs);
      else if (e.isFile()) result.push(abs);
    }
  }
  visit(root);
  return result.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
};
const manifest = JSON.parse(readFileSync(path.join(DSH_ROOT, 'data/corpus/manifest.json'), 'utf8'));
const references = new Map(manifest.map((m) => [slash(m.path), m]));
const generatedAt = new Date().toISOString();
const clientDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const stages = ['role_and_family', 'format_ingestion', 'parse', 'clean_fidelity', 'anchors', 'rules', 'model_windows', 'self_verify', 'browser_flow', 'patch_export_roundtrip', 'independent_quality'];
const files = walk(CORPUS_ROOT).map((abs) => {
  const relativePath = slash(path.relative(CORPUS_ROOT, abs));
  const ext = path.extname(abs).toLowerCase();
  const name = path.basename(abs);
  const stat = statSync(abs);
  let sourceSha256 = null, readError = null;
  try { sourceSha256 = hashFile(abs); } catch (e) { readError = e.code || e.message; }
  const exclusionReason = name.startsWith('~$') ? 'Word 临时锁文件，不是稿件版本'
    : name === '.DS_Store' ? '操作系统目录元信息，不是稿件' : null;
  const ingestionRoute = exclusionReason ? 'excluded'
    : ext === '.docx' ? 'docx'
    : ext === '.doc' ? 'legacy_doc_conversion'
    : ext === '.pdf' ? 'pdf_role_and_ocr_triage'
    : ['.jpg', '.jpeg', '.png'].includes(ext) ? 'image_role_triage'
    : ext === '.xlsx' ? 'index_or_attachment_triage'
    : ['.zip', '.rar'].includes(ext) ? 'archive_member_inventory' : 'unknown';
  const ref = references.get(relativePath);
  return {
    assetId: 'asset-' + sha(relativePath).slice(0, 24), relativePath,
    sourceSha256, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), ext,
    readError, ingestionRoute, exclusionReason,
    assetRole: exclusionReason ? 'excluded' : 'unclassified',
    articleFamilyId: null,
    wordManifestEntry: !!ref,
    wordManifestShaMatch: ref ? sourceSha256 === ref.sha256 : null,
    earlierPaperScanDirectory: ext === '.pdf' && /^(01|02|03|04)-/.test(relativePath),
  };
});
const byExtension = {}, byRoute = {};
for (const f of files) {
  byExtension[f.ext || '(none)'] = (byExtension[f.ext || '(none)'] || 0) + 1;
  byRoute[f.ingestionRoute] = (byRoute[f.ingestionRoute] || 0) + 1;
}
const wordFiles = files.filter((f) => f.wordManifestEntry);
const groups = new Map();
for (const f of wordFiles) {
  if (!f.sourceSha256) continue;
  if (!groups.has(f.sourceSha256)) groups.set(f.sourceSha256, []);
  groups.get(f.sourceSha256).push(f.assetId);
}
const duplicateGroups = [...groups].filter(([, ids]) => ids.length > 1)
  .map(([sourceSha256, assetIds]) => ({ sourceSha256, assetIds }));
const present = new Set(files.map((f) => f.relativePath));
const missing = [...references.keys()].filter((p) => !present.has(p));
const mismatches = wordFiles.filter((f) => !f.wordManifestShaMatch).map((f) => f.relativePath);
const summary = {
  physicalFiles: files.length, excludedFiles: files.filter((f) => f.exclusionReason).length,
  assetsRequiringTriageOrValidation: files.filter((f) => !f.exclusionReason).length,
  byExtension, byRoute,
  wordManifest: { declared: manifest.length, present: wordFiles.length, missing, shaMismatches: mismatches },
  uniqueWordContentHashes: groups.size,
  duplicateWordGroups: duplicateGroups.length,
  duplicateWordExtraPaths: duplicateGroups.reduce((n, g) => n + g.assetIds.length - 1, 0),
  earlierPaperScanPdfPaths: files.filter((f) => f.earlierPaperScanDirectory).length,
  otherPdfPaths: files.filter((f) => f.ext === '.pdf' && !f.earlierPaperScanDirectory).length,
  independentArticleCount: null,
  readErrors: files.filter((f) => f.readError).map((f) => ({ assetId: f.assetId, code: f.readError })),
};
const inventoryHash = sha(JSON.stringify(files.map((f) => ({ path: f.relativePath, sha: f.sourceSha256, bytes: f.bytes, route: f.ingestionRoute }))));
const trackedFiles = ['server.mjs', 'package.json', ...['src', 'public', 'tools'].flatMap((d) => walk(path.join(DSH_ROOT, d))
  .filter((f) => ['.js', '.mjs', '.css', '.html'].includes(path.extname(f)))
  .map((f) => slash(path.relative(DSH_ROOT, f))))];
const codeFiles = [...new Set(trackedFiles)].sort().map((relativePath) => ({ path: relativePath, sha256: hashFile(path.join(DSH_ROOT, relativePath)) }));
const ruleFiles = walk(path.join(DSH_ROOT, 'rules')).filter((f) => f.endsWith('.json'))
  .map((f) => ({ path: slash(path.relative(DSH_ROOT, f)), sha256: hashFile(f) }));
const codeHash = sha(JSON.stringify(codeFiles));
const rulesHash = sha(JSON.stringify(ruleFiles));
const runId = `baseline-${clientDate.replaceAll('-', '')}-${inventoryHash.slice(0, 10)}-${codeHash.slice(0, 8)}`;
const optimizationRoot = path.join(DSH_ROOT, 'data/optimization');
const runDir = path.join(optimizationRoot, 'runs', runId);
const sealPath = path.join(runDir, 'complete.json');
const reused = existsSync(sealPath);
if (reused) {
  const seal = JSON.parse(readFileSync(sealPath, 'utf8'));
  if (seal.inventoryHash !== inventoryHash || seal.codeHash !== codeHash) throw new Error('快照标识冲突');
  for (const f of seal.files) {
    if (hashFile(path.join(runDir, f.path)) !== f.sha256) throw new Error(`已冻结证据发生变化：${f.path}`);
  }
}
mkdirSync(path.join(runDir, 'evidence'), { recursive: true });

if (!reused) {
  writeFileSync(path.join(runDir, 'inventory.json'), JSON.stringify({ schemaVersion: 1, runId, generatedAt, clientDate, sourceRoot: CORPUS_ROOT,
    inventoryHash, summary, files, duplicateGroups }, null, 2));
  writeFileSync(path.join(runDir, 'config-snapshot.json'), JSON.stringify({ schemaVersion: 1, runId, generatedAt,
    runtime: process.version, inventoryHash, codeHash, rulesHash, codeFiles, ruleFiles,
    provider: 'existing_server_ark_env', modelCallsStarted: 0,
    credentialsIncluded: false, baselineMeaning: '资产与工程证据快照，未认定语义质量通过' }, null, 2));
  const ledger = files.map((f) => ({
    schemaVersion: 1, assetId: f.assetId, sourcePath: f.relativePath, sourceSha256: f.sourceSha256,
    articleFamilyId: null, originalRevisionId: f.sourceSha256 ? 'source-' + f.sourceSha256 : null,
    ingestionRoute: f.ingestionRoute, role: f.assetRole, duplicateContentHash: f.sourceSha256,
    scopeStatus: f.exclusionReason ? 'excluded' : 'pending_role_confirmation',
    exclusionReason: f.exclusionReason, runIds: [], feedbackIds: [],
    stages: Object.fromEntries(stages.map((stage) => [stage, { status: f.exclusionReason ? 'not_applicable' : 'pending',
      reason: f.exclusionReason, lastRunId: null, evidencePaths: [] }])),
    priorEvidenceIsNotStagePass: true,
  }));
  writeFileSync(path.join(runDir, 'initial-task-ledger.json'), JSON.stringify({ schemaVersion: 1, runId, generatedAt, assets: ledger }, null, 2));
  writeFileSync(path.join(runDir, 'initial-events.jsonl'), ledger.map((entry) => JSON.stringify({
    schemaVersion: 1, eventId: `${runId}:${entry.assetId}:registered`, type: 'asset_registered',
    generatedAt, actor: 'inventory_tool', assetId: entry.assetId, sourceSha256: entry.sourceSha256,
    runId, scopeStatus: entry.scopeStatus, exclusionReason: entry.exclusionReason,
  })).join('\n') + '\n');
  const evidencePaths = ['data/verify/verify-all.json', 'data/verify/ui-acceptance-20261009.json',
    'tmp/ui-test-20261009/api-results.json', 'tmp/ui-test-20261009/full-ui-checks.json', 'tmp/ui-test-20261009/token-live.json'];
  const evidence = [];
  for (const rel of evidencePaths) {
    const source = path.join(DSH_ROOT, rel);
    if (!existsSync(source)) continue;
    const targetName = sha(rel).slice(0, 8) + '-' + path.basename(rel);
    copyFileSync(source, path.join(runDir, 'evidence', targetName));
    evidence.push({ sourcePath: rel, frozenPath: 'evidence/' + targetName, sha256: hashFile(source), evidenceLevel: 'prior_measurement' });
  }
  writeFileSync(path.join(runDir, 'evidence-index.json'), JSON.stringify({ runId, generatedAt, evidence }, null, 2));
}
const saved = JSON.parse(readFileSync(path.join(runDir, 'initial-task-ledger.json'), 'utf8'));
if (saved.assets.length !== files.length || new Set(saved.assets.map((x) => x.assetId)).size !== files.length) throw new Error('账本与文件清单不一致');
if (Object.values(byRoute).reduce((a, n) => a + n, 0) !== files.length) throw new Error('分类分母不一致');
if (!reused) {
  const sealedFiles = walk(runDir).map((f) => ({ path: slash(path.relative(runDir, f)), sha256: hashFile(f) }));
  writeFileSync(sealPath, JSON.stringify({ runId, generatedAt, inventoryHash, codeHash, files: sealedFiles }, null, 2));
}
mkdirSync(optimizationRoot, { recursive: true });
const latest = { schemaVersion: 1, runId, path: slash(path.relative(DSH_ROOT, runDir)), inventoryHash, codeHash, rulesHash,
  updatedAt: generatedAt, status: 'baseline_registered', summary, modelCallsStarted: 0 };
const latestPath = path.join(optimizationRoot, 'latest.json');
writeFileSync(latestPath + '.tmp', JSON.stringify(latest, null, 2));
renameSync(latestPath + '.tmp', latestPath);
console.log(JSON.stringify({ runId, reused, output: slash(runDir), ...summary, modelCallsStarted: 0 }, null, 2));
if (missing.length || mismatches.length) process.exitCode = 1;
