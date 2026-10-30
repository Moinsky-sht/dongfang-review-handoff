/**
 * 审阅提速基准：分别量出「模型审阅」与「模型复核」两个阶段的耗时，
 * 用来判断提速应该改哪里、改多少。
 *
 * 用法：
 *   node tools/speed-bench.mjs                # 默认 samples/test.docx
 *   node tools/speed-bench.mjs <file.docx>    # 指定稿件
 *
 * 只读：不写任何文件，不改动规则库。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocxBuffer } from '../src/docx.js';
import { modelReview, DEFAULT_MODEL } from '../src/ark.js';
import { recheckFixes } from '../src/recheck.js';
import { deterministicReview } from '../src/review.js';
import { buildWindows } from '../src/ark.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || resolve(__dirname, '..', 'samples', 'test.docx');
const buf = readFileSync(file);
const doc = parseDocxBuffer(buf, basename(file));

const t = (x) => `${(x / 1000).toFixed(1)}s`;
const line = (s) => console.log(s);

line(`稿件：${basename(file)}  段落 ${doc.paragraphs.length}  脚注 ${doc.footnotes.length}  字数 ${doc.stats?.chars ?? '?'}`);
const windows = buildWindows(doc, {});
line(`窗口：${windows.length} 个（默认 windowChars=1500 / maxParasPerWindow=10）`);
line('');

const det = deterministicReview(doc);
line(`规则引擎：${det.issues.length} 条（瞬时，不计入模型耗时）`);
line('');

// ---- 阶段一：模型审阅 ----
line('=== 阶段一：模型审阅（modelReview）===');
const bench = [];
for (const concurrency of [14, 20]) {
  const sw = Date.now();
  let out;
  try {
    out = await modelReview(doc, {
      model: DEFAULT_MODEL,
      concurrency,
      onProgress: () => {},
    });
  } catch (e) {
    line(`  并发 ${concurrency}: 失败 ${e.message}`);
    continue;
  }
  const ms = Date.now() - sw;
  bench.push({ concurrency, ms, issues: out.issues.length, errors: out.errors.length, usage: out.usage });
  line(`  并发 ${String(concurrency).padStart(2)}: ${t(ms).padStart(7)}  issues=${String(out.issues.length).padStart(3)}  失败窗口=${out.errors.length}  in=${out.usage.input_tokens} out=${out.usage.output_tokens}`);
}
line('');

// ---- 阶段二：模型复核 ----
const all = [...det.issues, ...(bench.at(-1) ? [] : [])];
// 用一轮模型结果做复核基准
const base = bench.at(-1);
if (base) {
  const first = await modelReview(doc, { model: DEFAULT_MODEL, concurrency: 6 });
  const merged = [...det.issues, ...first.issues];
  line(`=== 阶段二：模型复核（recheckFixes），输入 ${merged.length} 条 ===`);
  const sw = Date.now();
  const rc = await recheckFixes(merged, { model: DEFAULT_MODEL, onProgress: () => {} });
  const ms = Date.now() - sw;
  line(`  复核：${t(ms).padStart(7)}  批=${rc.stats.batches}  覆盖=${rc.stats.checked}  同意=${rc.stats.agree} 不同意=${rc.stats.disagree} 拿不准=${rc.stats.unsure} 跳过=${rc.stats.skipped}`);
  line(`  复核错误：${rc.errors.length} 批`);
  line('');
  line(`合计：${t(bench.at(-1).ms + ms)}`);
}
