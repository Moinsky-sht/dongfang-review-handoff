/**
 * 构建历史批注案例库索引（`data/comments/index.json`）。
 *
 * 输入：`data/comments/occurrences.json`（632 份稿件的 8687 条真人编辑批注）
 * 输出：BM25 倒排索引，供 `src/comment-cases.js` 在审阅时检索相似历史批注。
 *
 * 用法：node tools/build-comment-index.mjs
 *
 * 设计要点（都在 `src/comment-cases.js` 里详细注释）：
 *   · 索引字段 = 批注的**锚定原文**（query 是待审段落 → 找相似历史段落）；
 *   · 中文用**字符 bigram** + BM25，零依赖；
 *   · 过滤编辑的「处理回执」类批注（已修改/同上…），它们不含审阅意见。
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DSH_ROOT } from './paths.mjs';
import { tokenize, isUsefulComment, normalizeForIndex, ANCHOR_INDEX_CAP } from '../src/comment-cases.js';

const SRC = join(DSH_ROOT, 'data', 'comments', 'occurrences.json');
const OUT = join(DSH_ROOT, 'data', 'comments', 'index.json');

const raw = JSON.parse(readFileSync(SRC, 'utf8'));

const docs = [];
const files = [];
const fileIdx = new Map();
const seen = new Set();
let dropShort = 0;
let dropReceipt = 0;
let dropNoAnchor = 0;
let dropDup = 0;

for (const o of raw) {
  const text = String(o.text || '').trim();
  const anchor = String(o.anchorText || '').replace(/\s+/g, ' ').trim();
  if (!anchor || anchor.length < 6) { dropNoAnchor += 1; continue; }
  if (text.length < 6) { dropShort += 1; continue; }
  if (!isUsefulComment(text)) { dropReceipt += 1; continue; }

  const anchorIdx = anchor.slice(0, ANCHOR_INDEX_CAP);
  const normAnchor = normalizeForIndex(anchorIdx);
  const key = `${normAnchor}|${text}`;
  if (seen.has(key)) { dropDup += 1; continue; }
  seen.add(key);

  const f = String(o.file || '');
  if (!fileIdx.has(f)) { fileIdx.set(f, files.length); files.push(f); }
  docs.push({
    t: text.slice(0, 160),
    a: anchor.slice(0, 120),
    s: String(o.season || ''),
    au: String(o.author || ''),
    fi: fileIdx.get(f),
    _tok: tokenize(anchorIdx),
  });
}

/* 倒排：token → 扁平数组 [docId, tf, docId, tf, ...] */
const postings = new Map();
const lens = [];
for (let id = 0; id < docs.length; id += 1) {
  const toks = docs[id]._tok;
  lens.push(toks.length);
  const tf = new Map();
  for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [t, c] of tf) {
    let arr = postings.get(t);
    if (!arr) { arr = []; postings.set(t, arr); }
    arr.push(id, c);
  }
}
for (const d of docs) delete d._tok;

const avgLen = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
const payload = {
  builtAt: new Date().toISOString(),
  source: 'data/comments/occurrences.json',
  count: docs.length,
  avgLen: +avgLen.toFixed(2),
  files,
  docs,
  lens,
  postings: Object.fromEntries(postings),
};

mkdirSync(join(DSH_ROOT, 'data', 'comments'), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload));

const bytes = statSync(OUT).size;
let postings_total = 0;
for (const v of postings.values()) postings_total += v.length / 2;

console.log('═══ 历史批注案例库索引 ═══');
console.log(`原始批注        ${raw.length}`);
console.log(`入库            ${docs.length}`);
console.log(`  丢弃·无锚定原文 ${dropNoAnchor}`);
console.log(`  丢弃·过短       ${dropShort}`);
console.log(`  丢弃·处理回执   ${dropReceipt}`);
console.log(`  丢弃·完全重复   ${dropDup}`);
console.log(`覆盖稿件        ${files.length} 份`);
console.log(`唯一 token      ${postings.size}`);
console.log(`倒排条目        ${postings_total}`);
console.log(`平均文档长度    ${avgLen.toFixed(1)} 个 bigram`);
console.log(`索引体积        ${(bytes / 1024 / 1024).toFixed(2)} MB → ${OUT}`);
