/**
 * 语料并行 worker（`tools/lib/corpus.mjs` 的工作线程端）。
 * =================================================================
 * 为什么需要它
 * ------------
 * `parseDocx()` 是**同步 CPU 活**（解压 + 正则解析 XML）。Node 单线程下，
 * 工具里 `async worker()` + 并发 6 的写法**根本不并行**——事件循环被同步
 * 解析占满，墙钟 ≈ CPU 总和（batch-verify 632 篇 → 20s CPU / 22s 墙钟）。
 * 只有把解析放进 `worker_threads`，才是真并行（N 线程 = N 核同时跑）。
 *
 * 协议：主线程 postMessage `{ id, task, file }`；本线程回
 * `{ id, result }` 或 `{ id, error, stack }`。`result` 必须可结构化克隆
 * （只回计数/数组/基本类型，不回 doc 对象本身）。
 *
 * 新增任务：在 `TASKS` 里登记 `名字 → (file) => result` 即可，
 * 主线程用 `mapCorpus(list, '名字')` 调用。
 */
import { parentPort } from 'node:worker_threads';
import { parseDocx } from '../../src/docx.js';
import { deterministicReview } from '../../src/review.js';
import { classifyParagraphs, scanFormat } from '../../src/scanner-format.js';
import { scanLanguage } from '../../src/scanner-language.js';
import { scanCitation } from '../../src/scanner-citation.js';

const TASKS = {
  /** 批验：解析 → 段落分类 → 确定性审阅（字段与 batch-verify 原逻辑逐一对齐） */
  batch(file) {
    let stage = 'parse';
    try {
      const t0 = Date.now();
      const doc = parseDocx(file);
      const parseMs = Date.now() - t0;

      stage = 'classify';
      const { roles } = classifyParagraphs(doc);
      const roleCount = {};
      for (const r of roles) roleCount[r] = (roleCount[r] || 0) + 1;

      stage = 'review';
      const t1 = Date.now();
      const r = deterministicReview(doc);
      const reviewMs = Date.now() - t1;
      stage = 'done';

      const byRuleMap = {};
      for (const x of r.issues) byRuleMap[x.ruleId] = (byRuleMap[x.ruleId] || 0) + 1;

      return {
        ok: true,
        ms: Date.now() - t0,
        parseMs,
        reviewMs,
        paragraphs: doc.paragraphs.length,
        footnotes: doc.footnotes.length,
        comments_: doc.comments.length,
        revisions: doc.revisions.length,
        tables: doc.tables.length,
        chars: doc.stats?.chars || 0,
        changed: doc.stats?.changedParagraphs || 0,
        roles: roleCount,
        total: r.summary.total,
        format: r.summary.format,
        language: r.summary.language,
        citation: r.summary.citation,
        byRule: Object.entries(byRuleMap).sort((a, b) => b[1] - a[1]),
        bySeverity: r.summary.bySeverity || {},
        unlocated: r.issues.filter((x) => x.paragraphIndex === undefined
          && x.footnoteIndex === undefined && x.tableIndex === undefined
          && x.location !== 'document').length,
        noQuote: r.issues.filter((x) => !x.quote).length,
        noopFix: r.issues.filter((x) => x.autoFix?.find && x.autoFix.find === x.autoFix.replace).length,
      };
    } catch (err) {
      err.stage = stage;
      throw err;
    }
  },

  /** 规则覆盖：解析 → 三引擎扫描 → 该篇命中的规则与各引擎计数（对应 rule-coverage） */
  coverage(file) {
    const doc = parseDocx(file);
    const fmt = scanFormat(doc);
    const lang = scanLanguage(doc);
    const cit = scanCitation(doc);
    const issues = [...fmt.issues, ...lang.issues, ...cit.issues];

    const seen = new Set();
    const ruleCounts = {};
    for (const it of issues) {
      seen.add(it.ruleId);
      ruleCounts[it.ruleId] = (ruleCounts[it.ruleId] || 0) + 1;
    }

    return {
      paragraphs: doc.stats.paragraphs,
      chars: doc.stats.chars,
      footnotes: doc.stats.footnotes,
      comments: doc.stats.comments,
      issues: issues.length,
      format: fmt.issues.length,
      language: lang.issues.length,
      citation: cit.issues.length,
      rules: [...seen].sort(),
      ruleCounts,
    };
  },

  /** 方向性：解析 → 三引擎扫描（单引擎失败不拖垮）→ 该篇各规则命中数（对应 rule-direction） */
  direction(file) {
    const doc = parseDocx(file);
    const traced = (doc.revisions || []).length > 0 || (doc.comments || []).length > 0;

    let issues = [];
    for (const scan of [scanFormat, scanLanguage, scanCitation]) {
      try { issues = issues.concat(scan(doc).issues || []); } catch { /* 单引擎失败不拖垮整轮 */ }
    }
    const ruleCounts = {};
    for (const it of issues) ruleCounts[it.ruleId] = (ruleCounts[it.ruleId] || 0) + 1;

    return { traced, ruleCounts };
  },

  /** 存活复现：解析 → 三引擎扫描 → 该篇触发到的规则号（去重），供规则存活复现用 */
  ruleIds(file) {
    const doc = parseDocx(file);
    const set = new Set();
    for (const fn of [scanFormat, scanLanguage, scanCitation]) {
      try { for (const i of fn(doc).issues) set.add(i.ruleId); } catch { /* 单引擎失败不拖垮整轮 */ }
    }
    return { ruleIds: [...set] };
  },

  /**
   * 误报台账：解析 → 三引擎扫描 → 逐条给出比对所需的扁平字段
   * （ruleId / quote / message / 段落文本），重合判定在主线程做
   * （锚点按文件变化，不适合放进 worker）。
   */
  fpLedger(file) {
    const doc = parseDocx(file);
    let issues = [];
    for (const fn of [scanFormat, scanLanguage, scanCitation]) {
      try { issues = issues.concat(fn(doc).issues); } catch { /* 单篇失败不影响整体 */ }
    }
    return {
      issues: issues.map((it) => ({
        ruleId: it.ruleId,
        group: it.group || '',
        quote: it.quote || '',
        message: it.message || '',
        paragraphIndex: it.paragraphIndex,
        paraText: (it.paragraphIndex != null && doc.paragraphs[it.paragraphIndex])
          ? doc.paragraphs[it.paragraphIndex].text
          : '',
      })),
    };
  },
};

parentPort.on('message', (msg) => {
  const fn = TASKS[msg.task];
  if (!fn) {
    parentPort.postMessage({ id: msg.id, error: `未知任务：${msg.task}` });
    return;
  }
  try {
    parentPort.postMessage({ id: msg.id, result: fn(msg.file) });
  } catch (err) {
    parentPort.postMessage({
      id: msg.id,
      error: `${err?.name || 'Error'}: ${err?.message || err}`,
      stage: err?.stage || 'worker',
      stack: String(err?.stack || '').split('\n').slice(0, 4).join(' | '),
    });
  }
});
