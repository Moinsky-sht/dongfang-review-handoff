/**
 * 历史批注案例库（RAG 检索内核）—— 零依赖。
 *
 * ── 为什么做这个 ──
 * 语料里 632 份稿件带着 **8687 条真人编辑写下的批注**。这是「本刊尺度」最直接的
 * 证据：编辑在哪一段写了什么意见、怎么措辞、优先抓什么。此前这套数据只被用来
 * 做规则误报台账（离线统计），**从未在审阅时喂给模型**。
 *
 * 现在把它做成检索库：审阅每一段时，从历史批注里找出「锚定段落与当前段落相似」
 * 的若干条，作为【本刊历史批注参考】附在提示词里，让模型按本刊的实际尺度判断。
 *
 * ── 检索方法（中文无词典，零依赖）──
 * 中文没有空格，零依赖环境也不装分词器，所以用**字符二元组（bigram）**做倒排：
 *   「区域国别研究」→ 区域 / 域国 / 国别 / 别研 / 研究
 * 连续 ASCII 字母数字整体成词。打分用 **BM25**（k1=1.2, b=0.75），
 * 索引字段是批注的**锚定原文**（query 是待审段落 → 找相似的历史锚定段落）。
 *
 * ⚠️ 这是**线索**不是结论：检索到的历史批注只作尺度参考，模型仍须独立判断。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {createHash} from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 索引文件位置（可用 DSH_COMMENT_INDEX 覆盖） */
export const DEFAULT_INDEX_PATH = process.env.DSH_COMMENT_INDEX
  || join(HERE, '..', 'data', 'comments', 'index.json');

/** 每个窗口默认检索几条案例 */
export const DEFAULT_CASE_K = 3;
/**
 * 至少命中多少个**不同的**查询 token 才算相关（挡掉偶发重合）。
 *
 * 光靠数量还不够：锚定原文动辄上百个 bigram，随便一段都能凑够十几个重合，
 * 所以真正的把关是下面的 `MIN_SCORE`（IDF 加权分），`minMatch` 只是廉价初筛。
 */
export const MIN_MATCH_TOKENS = 5;
/**
 * 相对门槛：只保留分数 ≥「最佳命中分 × 该比例」的案例。
 *
 * 为什么不用**绝对**分数下限：BM25 的分值是「命中 token 的 idf 之和」，
 * 会随查询长度一起变——实测 1500 字的窗口 top-1 分普遍在 670–1300，
 * 而 40 字的短查询只有几十。固定绝对阈值必然要么形同虚设、要么误杀短查询。
 * 相对门槛只看「和这一窗的最佳命中差多少」，对查询长度稳健。
 */
export const TOP_SCORE_RATIO = 0.3;
/** 绝对底：连这个分都不到的「最佳命中」也直接丢弃（几乎没有可信重合） */
export const MIN_SCORE_FLOOR = 20;
/**
 * 参与索引的锚定原文截断长度。
 *
 * 从 240 收到 150：锚定太长时，一篇文档覆盖的 token 太多，
 * 与任何窗口都容易「碰巧重合」，反而失去辨别力（实测覆盖率虚高到 98%）。
 */
export const ANCHOR_INDEX_CAP = 150;
/** 同一篇历史稿件最多贡献几条案例（保证多样性，避免三条都来自同一篇） */
export const MAX_CASES_PER_FILE = 2;

/**
 * 归一化：只保留 CJK 与 ASCII 字母数字，其余（空白 / 标点 / 引号）一律去掉。
 * 去标点是刻意的——标点噪声会让「同样的句子」因为逗号不同而匹配不上。
 */
export function normalizeForIndex(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\u4e00-\u9fff\u3400-\u4dbfa-z0-9]+/g, '');
}

/**
 * 分词：CJK 连续段切成字符二元组；ASCII 字母数字连续段整体成词。
 * 纯函数，便于离线单测。
 */
export function tokenize(text) {
  const norm = normalizeForIndex(text);
  const out = [];
  let i = 0;
  while (i < norm.length) {
    const c = norm[i];
    if (c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
      let j = i;
      while (j < norm.length && (norm[j] >= 'a' && norm[j] <= 'z' || norm[j] >= '0' && norm[j] <= '9')) j += 1;
      out.push(norm.slice(i, j));
      i = j;
    } else if (isCjk(c)) {
      let j = i;
      while (j < norm.length && isCjk(norm[j])) j += 1;
      const run = norm.slice(i, j);
      if (run.length === 1) out.push(run);
      else for (let k = 0; k + 1 < run.length; k += 1) out.push(run.slice(k, k + 2));
      i = j;
    } else {
      i += 1;
    }
  }
  return out;
}

function isCjk(c) {
  const code = c.codePointAt(0);
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

/**
 * 这条批注是否值得进案例库（纯函数）。
 *
 * 8687 条里有大量**编辑的处理回执**（「已修改。」「同上。」「已按前一句调整…」），
 * 它们不表达审阅意见，收进案例库只会污染检索。过滤规则：
 *   · 太短（<6 字）直接丢；
 *   · 以「已…／同上／收到…」开头的**短**回执丢掉；长句仍保留（可能含真实指示）。
 */
export function isUsefulComment(text) {
  const t = String(text || '').trim();
  if (t.length < 6) return false;
  const receipt = /^(已(修改|改|调整|统一|补充|删除|删|加|处理|核对|更新|按|修正|替换|标注|完成|核实)|同上|同前|好的|收到|谢谢|可以|ok)/i;
  if (t.length < 20 && receipt.test(t)) return false;
  return true;
}

/**
 * 构造 BM25 检索器（纯函数：喂给它索引对象即可，便于单测）。
 * @param {{docs:Array, lens:number[], avgLen:number, postings:Object}} index
 */
export function makeRetriever(index) {
  const { docs = [], lens = [], postings = {} } = index;
  const N = docs.length;
  const avgLen = index.avgLen || (lens.reduce((a, b) => a + b, 0) / Math.max(1, N));
  const K1 = 1.2;
  const B = 0.75;

  return function retrieve(queryText, { k = DEFAULT_CASE_K, minMatch = MIN_MATCH_TOKENS, ratio = TOP_SCORE_RATIO, floor = MIN_SCORE_FLOOR, excludeFiles = null } = {}) {
    const qTokens = tokenize(queryText);
    if (!qTokens.length || !N) return [];
    const qTf = new Map();
    for (const t of qTokens) qTf.set(t, (qTf.get(t) || 0) + 1);

    const scores = new Map();
    const matched = new Map();
    for (const [t, qf] of qTf) {
      const post = postings[t];
      if (!post) continue;
      const df = post.length / 2;
      // 文档频率高于 90% 的 token（几乎人人都有的常用字组合）信息量极低，跳过。
      // 这是**大语料下的性能优化**（那些 token 的倒排表最长）；小语料里所有文档
      // 天然共享大量 token，若也跳过会把整篇都筛没，所以加一个最小规模门槛。
      if (N >= 50 && df / N > 0.9) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < post.length; i += 2) {
        const id = post[i];
        const tf = post[i + 1];
        const dl = lens[id] || 1;
        const denom = tf + K1 * (1 - B + B * (dl / avgLen));
        scores.set(id, (scores.get(id) || 0) + idf * (tf * (K1 + 1) / denom) * qf);
        matched.set(id, (matched.get(id) || 0) + 1);
      }
    }

    const ranked = [];
    let best = 0;
    for (const [id, score] of scores) {
      if ((matched.get(id) || 0) < minMatch) continue;
      const d = docs[id];
      if (excludeFiles && d.fi != null) {
        const f = index.files ? index.files[d.fi] : null;
        if (f && excludeFiles.has(f)) continue;
      }
      if (score > best) best = score;
      ranked.push({ id, score, comment: d.t, anchor: d.a, season: d.s, author: d.au, fi: d.fi });
    }
    ranked.sort((a, b) => b.score - a.score || a.id - b.id);

    // 相对门槛：与最佳命中差距过大的直接不要（避免塞「碰巧有点重合」的噪声）
    const cut = Math.max(best * ratio, floor);
    const kept = ranked.filter((c) => c.score >= cut);

    // 去重 + 多样性：同一句批注只留一条，同一篇历史稿件最多贡献 MAX_CASES_PER_FILE 条
    const picked = [];
    const seenComment = new Set();
    const perFile = new Map();
    for (const c of kept) {
      if (seenComment.has(c.comment)) continue;
      if (c.fi != null && (perFile.get(c.fi) || 0) >= MAX_CASES_PER_FILE) continue;
      picked.push({ ...c, score: +c.score.toFixed(4) });
      seenComment.add(c.comment);
      if (c.fi != null) perFile.set(c.fi, (perFile.get(c.fi) || 0) + 1);
      if (picked.length >= k) break;
    }
    return picked;
  };
}

/* ------------------------------------------------------------------ */
/* 运行期懒加载                                                        */
/* ------------------------------------------------------------------ */
let _index = null;
let _retriever = null;
let _loadTried = false;
let _missingNote = false;
let _indexPath = null;
let _indexSha256 = null;
export const caseIndexFingerprint=()=>_indexSha256;

/** 案例库总开关：默认开，`ARK_CASES=0` 关闭 */
export function casesEnabled() {
  return process.env.ARK_CASES !== '0';
}

/** 索引是否已就绪（供进度/诊断用，不触发加载） */
export function casesIndexReady() {
  return !!_index;
}

/**
 * 懒加载索引。文件缺失 / 解析失败时不抛异常，只返回 null —— 拿不到案例库
 * 就退回「没有历史参考」的旧行为，绝不拖垮审阅。
 */
export function loadCaseIndex(path = DEFAULT_INDEX_PATH) {
  _loadTried = true;
  try {
    if (!existsSync(path)) { _index=null;_retriever=null;_indexPath=path;_indexSha256=null;_missingNote = true; return null; }
    const bytes=readFileSync(path);
    const fingerprint=createHash('sha256').update(bytes).digest('hex');
    if(_index&&_indexPath===path&&_indexSha256===fingerprint)return _index;
    _index = JSON.parse(bytes.toString('utf8'));
    _retriever = makeRetriever(_index);
    _indexPath=path;_indexSha256=fingerprint;_missingNote=false;
    return _index;
  } catch {
    _index=null;_retriever=null;_indexPath=path;_indexSha256=null;
    _missingNote = true;
    return null;
  }
}

/** 案例库缺失时的提示语（供调用方写进 progress / 报告，而不是静默） */
export function casesMissingReason() {
  return _missingNote ? '未找到历史批注索引（data/comments/index.json），本次按无案例参考继续' : '';
}

/**
 * 供审阅调用：给定段落文本，返回历史批注案例。
 * 拿不到索引 / 关了开关 / 查询为空，一律返回 []。
 */
export function retrieveCases(queryText, { k = DEFAULT_CASE_K, minMatch = MIN_MATCH_TOKENS, ratio = TOP_SCORE_RATIO, floor = MIN_SCORE_FLOOR, excludeFiles = null } = {}) {
  if (!casesEnabled()) return [];
  if (!_retriever) loadCaseIndex();
  if (!_retriever) return [];
  return _retriever(queryText, { k, minMatch, ratio, floor, excludeFiles });
}
