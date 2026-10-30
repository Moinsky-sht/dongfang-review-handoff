/**
 * 一条命令跑完全部回归（Phase 0 地基）。
 * =================================================================
 * 为什么需要它
 * ------------
 * `长周期执行路线图.md` 的「执行纪律」要求每轮改动后跑一整套脚本
 * （selftest + batch-verify + rule-coverage + rule-liveness + …），
 * 但 `package.json` 只有一个 `test → selftest`，**没有单一入口** ——
 * 靠人肉记住跑哪些，一定会漏。本脚本就是那个入口。
 *
 * 分组（默认 all；可用 `--group=core|heavy|http` 或 `--fast`）
 *   core  秒级、离线、每次必跑：selftest / smoke-* / 探针 / 语法门禁
 *   heavy 全语料扫描（每项十几秒，多核并行）：batch-verify / rule-coverage /
 *         rule-liveness / rule-direction / rule-fp-ledger
 *   post  消费 heavy 产物、必须串行在其后：assert-rule-status / rule-triage /
 *         rule-scorecard（否则会读到上一轮的旧 json —— 这是本编排的第一条纪律）
 *   http  需要 server.mjs 在跑：adversarial / api-e2e / verify-requirements / verify-media
 *
 * 产物：`data/verify/verify-all.json`（逐项 退出码/耗时/结果 + 语法门禁）
 * 退出码：任一「非容忍」项失败 → 非 0（可直接当 CI 门禁）
 *
 * 用法：
 *   node tools/verify-all.mjs            # 全部（HTTP 组在服务未启动时自动跳过）
 *   node tools/verify-all.mjs --fast     # 只跑 core
 *   node tools/verify-all.mjs --group=core,heavy
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, dirname, extname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'verify');
const BASE = process.env.BASE || 'http://127.0.0.1:3210';

const argv = process.argv.slice(2);
const fast = argv.includes('--fast');
const groupArg = (argv.find((a) => a.startsWith('--group=')) || '').slice('--group='.length);
const groups = new Set(
  fast ? ['core']
    : groupArg ? groupArg.split(',')
      : ['core', 'heavy', 'post', 'http'],
);

/**
 * 回归清单。`parse` 用于从 stdout 里抽「N 通过 / M 失败」；
 * `tolerant` = 已知会失败但不算门禁红灯（附 note 说明）。
 */
const SUITES = [
  { name: 'selftest', group: 'core', parse: /结果：(\d+) 通过 \/ (\d+) 失败/ },
  { name: 'smoke-docx-clean', group: 'core', parse: /结果：(\d+) 通过 \/ (\d+) 失败/ },
  { name: 'test-docx-clean-contract', group: 'core' },
  { name: 'test-clean-provenance-ui', group: 'core' },
  { name: 'test-clean-ingestion', group: 'core' },
  { name: 'test-legacy-imports', group: 'core' },
  { name: 'test-ingestion-store', group: 'core' },
  { name: 'test-ingestion-lock-diagnostics', group: 'core' },
  { name: 'test-ingestion-ui', group: 'core' },
  { name: 'smoke-verdict', group: 'core', parse: /结果：(\d+) 通过 \/ (\d+) 失败/ },
  { name: 'smoke-docx-comments', group: 'core', parse: /结果：(\d+) 通过 \/ (\d+) 失败/ },
  { name: 'test-note-identity', group: 'core' },
  { name: 'test-review-source-contract', group: 'core' },
  { name: 'test-source-characters', group: 'core' },
  { name: 'test-model-source-location', group: 'core' },
  { name: 'test-model-source-consumers', group: 'core' },
  { name: 'test-report-export', group: 'core' },
  { name: 'test-review-coverage', group: 'core' },
  { name: 'test-review-coverage-ui', group: 'core' },
  { name: 'test-review-source-plan', group: 'core' },
  { name: 'test-review-primary-source', group: 'core' },
  { name: 'test-model-execution-scope', group: 'core' },
  { name: 'test-ark-execution-store', group: 'core' },
  { name: 'test-review-plan-store', group: 'core' },
  { name: 'test-ark-transport', group: 'core', args: ['--phase=green','--frozen=1'] },
  { name: 'test-ark-endpoint-config', group: 'core', args: ['--phase=green'] },
  { name: 'test-ark-execution-http', group: 'core', args: ['--phase=green'] },
  { name: 'test-human-raw-ranges', group: 'core' },
  { name: 'test-reader-projection-ui', group: 'core' },
  { name: 'test-writer-source-visibility', group: 'core' },
  { name: 'test-explicit-source-anchors', group: 'core' },
  { name: 'test-reader-xml-identity', group: 'core' },
  { name: 'test-review-range-ui', group: 'core' },
  { name: 'test-note-comment-export', group: 'core' },
  { name: 'test-endnote-reader', group: 'core' },
  { name: 'test-docx-preview-renderer', group: 'core' },
  { name: 'test-note-export-http', group: 'core' },
  { name: 'never-fired-probe', group: 'core' },
  { name: 'validate-rules', group: 'core' },
  { name: 'rule-impl-audit', group: 'core' },
  { name: 'model-eval', group: 'core' },
  { name: 'test-token-usage', group: 'core' },
  { name: 'test-docx-patches', group: 'core' },
  { name: 'test-working-anchors', group: 'core' },
  { name: 'test-working-version-storage', group: 'core' },
  { name: 'test-session-store', group: 'core' },
  { name: 'test-workspace-store', group: 'core' },
  { name: 'test-workspace-listing', group: 'core' },
  { name: 'test-human-state', group: 'core' },
  { name: 'test-audit-purpose', group: 'core' },
  { name: 'test-fix-transactions', group: 'core' },
  { name: 'test-working-version-ui', group: 'core' },
  { name: 'test-fix-history-ui', group: 'core' },
  { name: 'test-workspace-human-ui', group: 'core' },
  { name: 'test-fix-history-state', group: 'core' },
  { name: 'test-review-restart', group: 'core' },
  { name: 'test-job-store', group: 'core' },
  { name: 'test-review-runtime', group: 'core' },
  { name: 'test-review-read-consistency', group: 'core' },
  { name: 'test-review-queue-ui', group: 'core' },
  { name: 'test-review-queue-http', group: 'core', args: ['--phase=full'] },
  { name: 'batch-verify', group: 'heavy', parse: /验证完成：成功 (\d+) \/ 失败 (\d+)/ },
  { name: 'rule-coverage', group: 'heavy' },
  { name: 'rule-liveness', group: 'heavy' },
  { name: 'rule-direction', group: 'heavy' },
  { name: 'rule-fp-ledger', group: 'heavy' },
  { name: 'rule-metadata-consistency', group: 'heavy', parse: /实际产出 (\d+) 条不同规则/ },
  { name: 'test-corpus-clean', group: 'heavy' },
  { name: 'test-corpus-review-source-plan', group: 'heavy' },
  { name: 'test-corpus-ingestions', group: 'heavy' },
  { name: 'test-corpus-source-range-writers', group: 'heavy', args: ['--derived-manifest=data/optimization/runs/g0-02-assets-20261009073435/artifacts/archive-1791532468754-19299e94/manifest.json'] },
  // post：依赖上面 heavy 组落盘的 json，必须串行、在 heavy 之后
  { name: 'test-citation-raw-offsets', group: 'heavy', args: ['--corpus'] },
  { name: 'classify-never-fired', group: 'post' },
  { name: 'assert-rule-status', group: 'post' },
  { name: 'rule-triage', group: 'post' },
  { name: 'rule-scorecard', group: 'post' },
  { name: 'comment-rag-eval', group: 'post', args: ['--docs=6', '--samples=0'] },
  { name: 'adversarial', group: 'http', parse: /全部 (\d+) 个畸形输入/, parseTwo: /共 (\d+)\/(\d+) 个输入有问题/ },
  { name: 'api-e2e', group: 'http', args: ['--pick=1', '--no-model'], parse: /结果：(\d+) 通过 \/ (\d+) 失败/ },
  {
    name: 'verify-requirements', group: 'http', parse: /共 (\d+) 项，通过 (\d+) 项，失败 (\d+) 项/,
    tolerant: true, note: '功能验收诊断：完整范围覆盖与外部浏览器渲染尚待完成；逐项失败保留，不能作为G3或质量通过证据',
  },
  { name: 'verify-media', group: 'http', parse: /结果：(\d+) 通过 \/ (\d+) 失败/ },
  { name: 'verify-ui-shell', group: 'http', parse: /结果：(\d+) 通过 \/ (\d+) 失败/ },
  { name: 'test-fix-persistence', group: 'http' },
  { name: 'test-working-version', group: 'http' },
  { name: 'test-fix-history', group: 'http', args: ['--spawn-server'] },
  { name: 'test-review-entrypoints', group: 'http' },
  { name: 'test-workspace-human', group: 'http' },
  { name: 'test-ingestion-http', group: 'http', args: ['--race-repeats=64', '--fs-diagnostic=1'] },
  { name: 'test-issue-identity-http', group: 'http' },
  { name: 'test-review-coverage-http', group: 'http' },
  { name: 'test-citation-occurrence-http', group: 'http' },
];

// Keep admission journals and archived DOCX beside their immutable run report.
// The controller supplies a new directory for each attempt; standalone runs
// retain the tools' normal fresh output locations.
const admissionEvidenceDirectory = process.env.DSH_VERIFICATION_EVIDENCE_DIR;
let suiteLogDirectory = null;
if (admissionEvidenceDirectory) {
  suiteLogDirectory = resolve(admissionEvidenceDirectory, 'suite-logs');
  const scope = relative(resolve(ROOT, 'data/optimization/runs'), suiteLogDirectory);
  if (!scope || scope.startsWith('..') || isAbsolute(scope)) throw new Error('Suite logs require a project experiment directory');
  for (let parent = suiteLogDirectory; ; parent = dirname(parent)) {
    if (existsSync(join(parent, 'complete.json'))) throw new Error('Cannot append logs to sealed evidence');
    if (existsSync(parent) && (lstatSync(parent).isSymbolicLink() || resolve(realpathSync(parent)).toLowerCase() !== parent.toLowerCase())) throw new Error('Suite log alias refused');
    if (parent === dirname(parent)) break;
  }
  mkdirSync(suiteLogDirectory, { recursive: true });
  for (const suite of SUITES) {
    if (suite.name === 'test-explicit-source-anchors') {
      suite.args = [...(suite.args || []), `--out=${join(admissionEvidenceDirectory, suite.name)}`];
    }
    if (['test-ingestion-store', 'test-ingestion-ui', 'test-corpus-ingestions', 'test-ingestion-http', 'test-job-store', 'test-review-queue-ui', 'test-endnote-reader', 'test-reader-projection-ui'].includes(suite.name)) {
      suite.args = [...(suite.args || []), `--out=${join(admissionEvidenceDirectory, `${suite.name}.json`)}`];
    }
  }
}

function run(cmd, args, timeoutMs = 600000, extraEnv = null) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { cwd: ROOT, env: extraEnv ? { ...process.env, ...extraEnv } : process.env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, ms: Date.now() - t0 }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + e.message, ms: Date.now() - t0 }); });
  });
}

async function serverUp() {
  try {
    const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

/** 语法门禁：对 src/ public/ tools/（含 tools/lib/ 等子目录）下所有 .js/.mjs 跑 `node --check`（并发 8） */
async function syntaxCheck() {
  const dirs = ['src', 'public', 'tools'];
  const files = [];
  const walk = (rel) => {
    let es; try { es = readdirSync(join(ROOT, rel), { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const child = join(rel, e.name);
      if (e.isDirectory()) walk(child);
      else if (e.isFile() && ['.js', '.mjs'].includes(extname(e.name))) files.push(child);
    }
  };
  for (const d of dirs) walk(d);
  const failed = [];
  let i = 0;
  const worker = async () => {
    while (i < files.length) {
      const f = files[i]; i += 1;
      const r = await run(process.execPath, ['--check', f], 30000);
      if (r.code !== 0) failed.push(f);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { checked: files.length, failed };
}

const started = Date.now();
mkdirSync(OUT, { recursive: true });

console.log('═══ 全量回归 · verify-all ═══');
console.log(`分组：${[...groups].join(', ')}${fast ? '（--fast）' : ''}`);

const httpOn = groups.has('http') ? await serverUp() : false;
if (groups.has('http')) console.log(`HTTP 组：${httpOn ? '服务在跑，纳入' : '服务未启动，跳过'}`);

const syntax = await syntaxCheck();
console.log(`语法门禁：检查 ${syntax.checked} 个文件，失败 ${syntax.failed.length}${syntax.failed.length ? '（' + syntax.failed.join('、') + '）' : ''}`);

const results = [];

/** 抽取某一项的「N 通过 / M 失败」；parseTwo 用于单值+失败分支两种输出（如 adversarial） */
function parseResult(s, out, ok) {
  if (s.parseTwo) {
    const m2 = out.match(s.parseTwo);
    if (m2) return { pass: +m2[2] - +m2[1], fail: +m2[1], total: +m2[2] };
    const m1 = out.match(s.parse);
    if (m1) return { pass: +m1[1], fail: 0, total: +m1[1] };
    return null;
  }
  if (!s.parse) return null;
  const m = out.match(s.parse);
  if (!m) return null;
  if (m.length === 3) return { pass: +m[1], fail: +m[2], total: +m[1] + +m[2] };
  return m.length === 2
    ? { total: +m[1], pass: ok ? +m[1] : null, fail: ok ? 0 : null }
    : { total: +m[1], pass: +m[2], fail: +m[3] };
}

async function runOne(s, extraEnv = null) {
  if (s.group === 'http' && !httpOn) {
    return { name: s.name, group: s.group, skipped: true, note: '服务未启动' };
  }
  const r = await run(process.execPath, [join('tools', `${s.name}.mjs`), ...(s.args || [])], 600000, extraEnv);
  let logs = null;
  if (suiteLogDirectory) {
    const stdoutPath = join(suiteLogDirectory, `${s.name}.stdout.log`);
    const stderrPath = join(suiteLogDirectory, `${s.name}.stderr.log`);
    writeFileSync(stdoutPath, r.out, { flag: 'wx' }); writeFileSync(stderrPath, r.err, { flag: 'wx' });
    logs = { stdout: relative(ROOT, stdoutPath), stderr: relative(ROOT, stderrPath),
      stdoutBytes: Buffer.byteLength(r.out), stderrBytes: Buffer.byteLength(r.err),
      stdoutSha256: createHash('sha256').update(r.out).digest('hex'), stderrSha256: createHash('sha256').update(r.err).digest('hex') };
  }
  const ok = r.code === 0;
  const parsed = parseResult(s, r.out, ok);
  return {
    name: s.name, group: s.group, exit: r.code, ms: r.ms, ok,
    tolerant: !!s.tolerant, note: s.note, result: parsed,
    logs,
    tail: (r.out.trim().split('\n').filter(Boolean).slice(-1)[0] || r.err.trim().split('\n')[0] || '').slice(0, 120),
  };
}

/** 并发池：heavy 组在多核机器上并行跑，墙钟时间从 ~100s 降到 ~30s */
async function runPool(list, concurrency, extraEnv = null) {
  const out = new Array(list.length);
  let i = 0;
  const worker = async () => {
    while (true) {
      const idx = i; i += 1;
      if (idx >= list.length) return;
      out[idx] = await runOne(list[idx], extraEnv);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) || 1 }, worker));
  return out;
}

const CPU = cpus()?.length || 4;
// CPU count alone does not bound Windows commit. Each tool opens real DOCX/XML
// trees, and each worker has its own heap. Keep a bounded default across tools.
const GROUP_CONCURRENCY = { core: 1, heavy: 2, post: 1, http: 1 };
const heavyThreads = String(Math.max(1, Math.min(2, Math.floor(CPU / GROUP_CONCURRENCY.heavy))));
if (groups.has('heavy')) console.log(`heavy 组：并发 ${GROUP_CONCURRENCY.heavy}｜每进程语料线程 ${heavyThreads}（核数 ${CPU}）`);
for (const g of ['core', 'heavy', 'post', 'http']) {
  if (!groups.has(g)) continue;
  const list = SUITES.filter((s) => s.group === g);
  const env = g === 'heavy' ? { DSH_CORPUS_THREADS: heavyThreads } : null;
  const got = await runPool(list, GROUP_CONCURRENCY[g] || 1, env);
  for (const entry of got) {
    results.push(entry);
    if (entry.skipped) { console.log(`· ${entry.name.padEnd(22)}  跳过（${entry.note}）`); continue; }
    const flag = entry.ok ? '✓' : (entry.tolerant ? '△' : '✗');
    const p = entry.result;
    const res = p ? `  ${p.pass}/${p.total ?? ''}` : '';
    console.log(`${flag} ${entry.name.padEnd(22)} ${String(entry.ms).padStart(6)}ms${res}`);
  }
}

const wallMs = Date.now() - started;
const failing = results.filter((r) => !r.skipped && !r.ok && !r.tolerant);
const tolerantFailing = results.filter((r) => !r.skipped && !r.ok && r.tolerant);
const payload = {
  generatedAt: new Date().toISOString(),
  groups: [...groups], fast, serverUp: httpOn, wallMs,
  syntax: { checked: syntax.checked, failed: syntax.failed },
  /** 回归面清单：跑之前就声明"都查了什么"，便于 CI/人核对，而不是只看结果 */
  declared: SUITES.map((s) => ({ name: s.name, group: s.group, args: s.args || [], tolerant: !!s.tolerant, note: s.note || null })),
  suites: results,
  failing: failing.map((r) => r.name),
  tolerantFailing: tolerantFailing.map((r) => r.name),
};
writeFileSync(join(OUT, 'verify-all.json'), JSON.stringify(payload, null, 2), 'utf8');
writeFileSync(join(OUT, 'verify-manifest.json'), JSON.stringify({
  generatedAt: payload.generatedAt,
  command: 'node tools/verify-all.mjs',
  groups: ['core', 'heavy', 'post', 'http'],
  syntaxGate: { scope: ['src', 'public', 'tools'], exts: ['.js', '.mjs'] },
  declared: payload.declared,
}, null, 2), 'utf8');

console.log(`\n总耗时 ${(wallMs / 1000).toFixed(1)}s｜必需检查失败 ${failing.length}｜未完成诊断 ${tolerantFailing.length}`);
if (tolerantFailing.length) console.log(`  未完成的功能诊断（实际失败逐项保留，不作为阶段完成证据）：${tolerantFailing.map((r) => r.name).join('、')}`);
console.log(`明细：data/verify/verify-all.json`);
process.exitCode = (failing.length || syntax.failed.length) ? 1 : 0;
