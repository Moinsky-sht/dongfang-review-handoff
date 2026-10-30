/**
 * 审稿经验审计日志（用户需求 7：后台记录系统）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 这个系统的价值不只是「这一篇审得怎么样」，而是**把审稿经验沉淀下来**：
 * 审稿人在哪些地方标注过、对模型/规则给出的哪些结论追加了什么看法、
 * 哪些结论被驳回 —— 这些反馈是后续修改规则与提示词的依据。
 *
 * 因此这里不做「只记成功/失败」的日志，而是记**可溯源的审稿行为**：
 *   · 哪个审阅任务、哪篇稿子（`sessionId` / `manuscript`）
 *   · 哪个段落、哪句话（`paragraphIndex` / `location` / `quote`）
 *   · 规则/模型当时说了什么（`ruleId` / `modelVerdict` / `modelOpinion`）
 *   · 审稿人怎么处置、补了什么意见（`humanAction` / `humanOpinion`）
 *   · 审稿人自选的属性（`attributes`：类别、严重度、标签…）
 *
 * ── 存储形态：append-only JSONL ─────────────────────────────────
 * 每条记录一行 JSON，**只追加、不重写**。理由：
 *   ① 追加是原子性最好的写盘方式，进程被杀最多丢最后一行，不会写坏整个文件；
 *   ② 便于用 `grep` / 脚本直接消费，不依赖本项目的代码；
 *   ③ 审稿经验是「累积资产」，天然只增不改。
 *
 * 查询时整文件读入再过滤。语料量级（几百篇、每篇几十条）下这是毫秒级，
 * 不值得为它引入索引文件带来的「索引与数据不一致」风险。
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIT_DIR = resolve(process.env.DSH_AUDIT_ROOT || resolve(__dirname, '..', 'data', 'audit'));
const LOG_FILE = join(AUDIT_DIR, 'audit-log.jsonl');

function ensureDir() {
  try { mkdirSync(AUDIT_DIR, { recursive: true }); } catch { /* 已存在 */ }
}

let seq = 0;

/** 允许的记录类型（防止前端笔误写入无法归类的记录） */
const KINDS = new Set([
  'human-mark',        // 审稿人在正文里圈画的一段（人工审阅模式）
  'human-decision',    // 对某条规则/模型结论的处置（采纳 / 驳回 / 存疑）
  'human-comment',     // 对某条结论追加的看法
  'model-opinion',     // 记录模型的复核观点（系统自动写）
  'fix-apply',         // 应用了自动修复
  'export',            // 导出报告 / 批注 Word
]);

/**
 * 规范化一条记录：补齐 id / ts，收敛字段长度。
 * 长度是**防御性**的 —— 审计日志会被反复追加，一条超长记录会拖累所有读取。
 */
function normalize(e, now) {
  seq += 1;
  const s = (v, n = 500) => (v === undefined || v === null ? '' : String(v).slice(0, n));
  return {
    id: `${now.toString(36)}-${seq.toString(36)}`,
    ts: new Date(now).toISOString(),
    sessionId: s(e.sessionId, 80),
    manuscript: s(e.manuscript, 300),
    taskId: s(e.taskId, 80),
    kind: KINDS.has(e.kind) ? e.kind : 'human-comment',
    // 溯源：段落 / 位置 / 原文
    paragraphIndex: Number.isInteger(e.paragraphIndex) ? e.paragraphIndex : (e.paragraphIndex ?? null),
    location: s(e.location, 120),
    quote: s(e.quote, 500),
    // 当时的规则/模型结论
    ruleId: s(e.ruleId, 40),
    ruleTitle: s(e.ruleTitle, 200),
    severity: s(e.severity, 8),
    severityBase: s(e.severityBase, 8),
    modelVerdict: s(e.modelVerdict, 16),
    modelOpinion: s(e.modelOpinion, 800),
    modelBetter: s(e.modelBetter, 500),
    // 审稿人的处置与意见
    humanAction: s(e.humanAction, 32),
    humanOpinion: s(e.humanOpinion, 1000),
    attributes: (e.attributes && typeof e.attributes === 'object') ? e.attributes : {},
    provenance: (e.provenance && typeof e.provenance === 'object') ? e.provenance : {},
  };
}

/**
 * 追加记录。返回写入后的记录数组（含 id / ts）。
 * @param {object|object[]} entries
 */
export function recordAudit(entries) {
  ensureDir();
  const now = Date.now();
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  const out = list.map((e) => normalize(e, now));
  if (!out.length) return [];
  try {
    appendFileSync(LOG_FILE, out.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  } catch (err) {
    // 写盘失败不能连累主流程；但必须回传错误，让调用方知道记录没落盘
    throw new Error(`审计日志写入失败：${err.message}`);
  }
  return out;
}

/**
 * 读取全部记录（容错：跳过损坏行）。
 *
 * ── 为什么加缓存（D1）──
 * `listAudit` / `auditSummary` / 导出都会整文件读一遍。界面上「审稿日志」
 * 会被反复打开，日志上千行后每次重读+重解析是纯浪费。这里按文件的
 * `mtimeMs + size` 做失效判断：文件没变就直接返回上次解析结果。
 * 一次追加会同时改变 size（通常也改 mtime），因此缓存键必然失效、不会读到旧数据。
 */
let _cache = { key: '', data: [] };
export function readAll() {
  if (!existsSync(LOG_FILE)) return [];
  let st;
  try { st = statSync(LOG_FILE); } catch { return _cache.data; }
  const key = `${st.mtimeMs}:${st.size}`;
  if (_cache.key === key) return _cache.data;
  const out = [];
  for (const line of readFileSync(LOG_FILE, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 跳过损坏行 */ }
  }
  _cache = { key, data: out };
  return out;
}

/**
 * 按条件列记录。
 * @param {{sessionId?:string, kind?:string, limit?:number}} [q]
 */
export function listAudit(q = {}) {
  let all = readAll();
  if (q.sessionId) all = all.filter((e) => e.sessionId === q.sessionId);
  if (q.kind) all = all.filter((e) => e.kind === q.kind);
  const limit = Number(q.limit) > 0 ? Number(q.limit) : 0;
  if (limit) all = all.slice(-limit);
  return all;
}

/**
 * 汇总 + **规则优化建议**（用户需求 7.3：针对反馈决定要不要改规则/提示词）。
 *
 * 对每条规则统计：
 *   · 规则命中后被人工**驳回**（`humanAction==='reject'`）的次数 → 误报信号；
 *   · 模型复核**不同意**的次数 → 规则过严信号；
 *   · 审稿人**自行圈画**（`human-mark` 且带 ruleId）的次数 → 规则漏检信号
 *     （审稿人标了、规则没报，说明规则可能缺失）。
 *
 * 三者任一超过阈值就给出 `suggestion`，让「要不要改提示词」这件事有据可依。
 */
export function auditSummary() {
  const logged = readAll();
  // Verification exercises remain in the full audit/export trail; only real
  // editorial feedback contributes to rule optimization signals.
  const all = logged.filter((entry) => entry.provenance?.purpose !== 'verification');
  const byKind = {};
  const byRule = new Map();
  for (const e of all) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    if (!e.ruleId) continue;
    if (!byRule.has(e.ruleId)) {
      byRule.set(e.ruleId, { ruleId: e.ruleId, ruleTitle: e.ruleTitle, reject: 0, modelDisagree: 0, humanMark: 0, accept: 0, total: 0 });
    }
    const r = byRule.get(e.ruleId);
    r.total += 1;
    if (e.kind === 'human-decision' && e.humanAction === 'reject') r.reject += 1;
    if (e.kind === 'human-decision' && e.humanAction === 'accept') r.accept += 1;
    if (e.modelVerdict === 'disagree') r.modelDisagree += 1;
    if (e.kind === 'human-mark') r.humanMark += 1;
  }
  const rules = [...byRule.values()].map((r) => {
    const flags = [];
    if (r.reject >= 3) flags.push(`被人工驳回 ${r.reject} 次，疑似误报`);
    if (r.modelDisagree >= 3) flags.push(`模型 ${r.modelDisagree} 次不同意，规则可能过严`);
    if (r.humanMark >= 3) flags.push(`审稿人自行标注 ${r.humanMark} 次，疑似漏检`);
    return { ...r, suggestion: flags.length ? `建议复核该规则：${flags.join('；')}` : '' };
  }).sort((a, b) => (b.reject + b.modelDisagree + b.humanMark) - (a.reject + a.modelDisagree + a.humanMark));
  return { total: all.length, loggedTotal: logged.length, excludedVerification: logged.length - all.length, byKind, rules };
}

/** CSV 单元格转义：含逗号/引号/换行时用双引号包裹并把引号翻倍 */
function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 把审计记录导成 CSV（需求 7 延伸：审稿经验要能带出去做后续分析）。
 * 列顺序即「溯源链」：谁（任务/稿件）→ 在哪（位置/原文）→ 当时结论（规则/模型）
 * → 审稿人怎么看（处置/意见）→ 自选属性。
 */
export function toCsv(entries) {
  const cols = [
    'id', 'ts', 'sessionId', 'manuscript', 'kind',
    'paragraphIndex', 'location', 'quote',
    'ruleId', 'ruleTitle', 'severity', 'severityBase',
    'modelVerdict', 'modelOpinion', 'modelBetter',
    'humanAction', 'humanOpinion',
  ];
  const head = cols.concat(['attributes', 'provenance']).join(',');
  const lines = entries.map((e) => cols.map((c) => csvCell(e[c])).concat([
    csvCell(JSON.stringify(e.attributes || {})),
    csvCell(JSON.stringify(e.provenance || {})),
  ]).join(','));
  // 加 BOM，Excel 打开中文不乱码
  return '\ufeff' + [head, ...lines].join('\r\n') + '\r\n';
}
