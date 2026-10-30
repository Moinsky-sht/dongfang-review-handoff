/**
 * 语料并行编排（Phase 1 地基）。
 * =================================================================
 * 目标（对应总目标里的「效率速度 + 可维护性」）
 * -----------------------------------------------
 * 让所有「遍历全部 632 篇语料」的工具（batch-verify / rule-coverage /
 * rule-direction …）**共享同一套多核并行 + 同一套清单读取**，
 * 而不是各自写一份、各自串行。
 *
 * 为什么是 worker_threads 而不是「异步 worker() + 并发」
 * -----------------------------------------------------
 * `parseDocx()` 是同步 CPU 活，async 并发在同一事件循环里**不会并行**。
 * 只有 `worker_threads` 才能让 N 个核同时解析。
 *
 * 为什么不做磁盘缓存
 * ------------------
 * 解析结果是庞大的嵌套对象（段落级逐字符标记），序列化比重新解析还慢；
 * 且 verify-all 并行启动多个工具，缓存写读错峰，反而引入「依赖缓存状态」
 * 的不确定性。所以这里**每次都真解析**，只把「并行」这一件事做对——
 * 零陈旧数据风险。
 *
 * 导出
 * ----
 *   loadCorpusList(opts)      读 manifest → 存在性过滤 → 剔除旧版 .doc(OLE2)
 *   mapCorpus(list, task)     把 list 按 task 分发给 worker 池，按序返回结果
 */
import { Worker } from 'node:worker_threads';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { isOle2 } from '../../src/zip.js';
import { CORPUS_ROOT, DSH_ROOT } from '../paths.mjs';

const WORKER_URL = new URL('./corpus-worker.mjs', import.meta.url);
const MANIFEST = join(DSH_ROOT, 'data', 'corpus', 'manifest.json');

/**
 * 默认线程数：留 1 核给主线程，上限 12，避免超线程抖动。
 * 可用环境变量 `DSH_CORPUS_THREADS` 覆盖——verify-all 并行跑多个工具时，
 * 会按「核数 ÷ 同时运行的工具数」下调，避免多进程 × 多线程把核打满反而变慢。
 */
const ENV_THREADS = Number(process.env.DSH_CORPUS_THREADS) || 0;
export const DEFAULT_THREADS = Math.max(2, Math.min(ENV_THREADS || ((cpus()?.length || 4) - 1), 12));

/**
 * 读取语料清单。
 * @param {object} [opts]
 * @param {string} [opts.corpusRoot]  语料根目录（默认共享 CORPUS_ROOT）
 * @param {string} [opts.manifestRel] manifest 相对 DSH_ROOT 的路径
 * @param {boolean}[opts.docxOnly]    只保留 .docx（rule-coverage 用）
 * @param {boolean}[opts.dropLegacy]  剔除旧版 .doc（OLE2）；默认 true
 * @returns {{list:object[], legacy:object[], missing:number, total:number}}
 */
export function loadCorpusList(opts = {}) {
  const corpusRoot = opts.corpusRoot || CORPUS_ROOT;
  const manifestPath = opts.manifestRel ? join(DSH_ROOT, opts.manifestRel) : MANIFEST;
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const total = raw.length;

  let list = raw.map((m) => ({ ...m, full: join(corpusRoot, m.path) }));
  list = list.filter((m) => existsSync(m.full));
  const missing = total - list.length;

  if (opts.docxOnly) list = list.filter((m) => /\.docx$/i.test(m.path));

  let legacy = [];
  if (opts.dropLegacy !== false) {
    legacy = list.filter((m) => { try { return isOle2(readFileSync(m.full)); } catch { return false; } });
    const legacySet = new Set(legacy.map((l) => l.full));
    list = list.filter((m) => !legacySet.has(m.full));
  }

  return { list, legacy, missing, total };
}

/**
 * 多核并行映射：把 list 交给 worker 池，按 `task` 计算，结果**按原顺序**返回。
 * @param {object[]} list       loadCorpusList().list（每项需有 .full）
 * @param {string}   task       corpus-worker.mjs 里登记的任务名
 * @param {object}   [opts]
 * @param {number}   [opts.threads]
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<Array<{id:number,result?:object,error?:string,stack?:string}>>}
 */
export async function mapCorpus(list, task, opts = {}) {
  const n = list.length;
  if (!n) return [];
  const threads = Math.max(1, Math.min(opts.threads || DEFAULT_THREADS, n));
  const results = new Array(n);
  let next = 0;
  let done = 0;
  let ended = 0;

  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolvePromise(results); } };

    const spawn = () => {
      const w = new Worker(WORKER_URL);
      const feed = () => {
        if (next >= n) {
          w.terminate();
          ended += 1;
          if (ended === threads) finish();
          return;
        }
        const idx = next; next += 1;
        w.postMessage({ id: idx, task, file: list[idx].full });
      };
      w.on('message', (msg) => {
        results[msg.id] = msg;
        done += 1;
        if (opts.onProgress) opts.onProgress(done, n);
        feed();
      });
      w.on('error', (e) => { if (!settled) { settled = true; rejectPromise(e); } });
      feed();
    };

    for (let i = 0; i < threads; i += 1) spawn();
  });
}
