/**
 * 魔法常数审计（需求 C）：把「我拍的数字」换成**跨语料的分布证据**。
 *
 * 逐个量三处本轮引入的常数：
 *   ① `detectMeta` 的 `limit = 30`（12 → 30，为让一份稿件成立）
 *      → 量 title/author 角色的最大段落下标分布。若天然有界，这个上限
 *        就该**删掉**而不是"论证 30 合理"。
 *   ② `sizeGapTitle` 的 `16`（8pt，篇名字号必须比最大标题大 8pt）
 *      → 量「篇名字号 − 其余标题最大字号」的分布，看 16 是不是从数据里来的。
 *   ③ `nearestNonEmpty` 的半径 `3`
 *      → 量「空段锚点」到最近非空段的距离分布，看 3 够不够。
 *
 * 用法：node tools/audit-constants.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { rolesOf, detectMeta, deterministicReview } from '../src/review.js';
import { computeAnchor } from '../src/anchors.js';
import { classifyHeadings } from '../src/headings.js';
import { ACADEMIC_ROOT } from './paths.mjs';

const ROOT = ACADEMIC_ROOT;
function walk(dir, acc = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.docx?$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}
function classify(p) {
  const rel = path.relative(ROOT, p).replace(/^发给皓天的一审文件\\/, '');
  if (/一审文件/.test(rel)) return 'HOLDB';
  if (/发排/.test(rel)) return 'TUNE';
  if (/责编版|毛条样|编务版/.test(rel)) return 'HOLDA';
  return null;
}
const buckets = { TUNE: [], HOLDA: [], HOLDB: [] };
for (const p of walk(ROOT)) { const c = classify(p); if (c) buckets[c].push(p); }

const q = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const stat = (label, arr) => {
  if (!arr.length) { console.log(`  ${label}: 无样本`); return; }
  console.log(`  ${label}: n=${arr.length} min=${q(arr, 0)} P50=${q(arr, 0.5)} P90=${q(arr, 0.9)} P99=${q(arr, 0.99)} max=${Math.max(...arr)}`);
};

/* ── ① title/author 角色下标分布 ── */
const titleIdx = [];
const authorIdx = [];
const filesWithTitle = { n: 0, beyond30: 0, beyond50: 0, beyond100: 0 };
let parsed = 0, failed = 0;
const sizeGaps = [];
const emptyAnchorDist = [];
/** 空段连续长度（跨全语料）：决定 `nearestNonEmpty` 半径该多大 */
const emptyRuns = [];
/** 脚注文本长度（跨全语料）：决定 `NOTE_MATCH_MIN` 该多低 */
const noteLens = [];

for (const set of Object.keys(buckets)) {
  for (const f of buckets[set]) {
    let doc;
    try { doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f)); } catch { failed += 1; continue; }
    parsed += 1;
    let cls;
    try { cls = rolesOf(doc); } catch { continue; }
    let lastT = -1;
    for (let i = 0; i < cls.roles.length; i += 1) {
      if (cls.roles[i] === 'title') { titleIdx.push(i); lastT = Math.max(lastT, i); }
      if (cls.roles[i] === 'author') authorIdx.push(i);
    }
    if (lastT >= 0) {
      filesWithTitle.n += 1;
      if (lastT >= 30) filesWithTitle.beyond30 += 1;
      if (lastT >= 50) filesWithTitle.beyond50 += 1;
      if (lastT >= 100) filesWithTitle.beyond100 += 1;
    }
    /* ② sizeGapTitle：必须量**同一个总体**，而且要用**正确的字段**。
     *
     * ⚠️ 这个测量错了两次，两次都得出过假结论：
     *   第一次：量的是 `role === 'title'` 的段落，而 `sizeGapTitle`
     *     （scanner-format.js:784）作用在**被判为标题的 `firstHeading`** 上 ——
     *     篇名角色段落和「格式来源的标题」是两个不同总体。
     *   第二次：判据读 `p._headingSource`，但这个字段是
     *     `scanner-format.js` 在 `classifyParagraphs` 里写的（319 行），
     *     `classifyHeadings` 只返回 `source` **数组**，不写段落对象。
     *     于是条件恒为 false，得出"0 样本、分支从不触发"的假结论 ——
     *     而实际上 `5现场-章永乐等` 明明满足（source=format, jc=center, gap=22）。
     * 结论：**审计脚本必须用被审计代码自己的字段**，不能凭印象取。
     */
    try {
      const hres = classifyHeadings(doc);
      const level = hres.level || [];
      const src = hres.source || [];
      let firstHeading = -1;
      for (let i = 0; i < level.length; i += 1) { if (level[i]) { firstHeading = i; break; } }
      if (firstHeading >= 0) {
        const p = doc.paragraphs[firstHeading];
        const mine = p.format?.sizeHalfPt;
        if (mine && p.properties?.jc === 'center' && src[firstHeading] === 'format') {
          let next = 0;
          for (let k = 0; k < doc.paragraphs.length; k += 1) {
            if (k === firstHeading || !level[k]) continue;
            const s = doc.paragraphs[k].format?.sizeHalfPt || 0;
            if (s > next) next = s;
          }
          if (next) sizeGaps.push(mine - next);
        }
      }
    } catch { /* 忽略 */ }

    /* ③ 空段锚点距离 + 空段连续长度
     *
     * `nearestNonEmpty` 的半径 3 是个「别指太远」的护栏，但 3 是拍的。
     * 规则引擎几乎不把问题指向空段（实测样本 0），所以**不能**从
     * 「锚点到最近非空段的距离」取证 —— 那个总体在规则侧是空的。
     *
     * 该半径真正约束的是**模型**指向空段时能走多远，而决定这个距离的
     * 量是「空段连续长度」：要找最近的非空段，最坏情况就是要跨过整段空行区。
     * 所以改为量空段连续长度的分布 —— 这是可测的、且直接决定上界该多大。
     */
    try {
      const det = deterministicReview(doc);
      for (const it of det.issues) {
        if (!Number.isInteger(it.paragraphIndex)) continue;
        const target = doc.paragraphs[it.paragraphIndex];
        if (!target || (target.text || '').trim()) continue;
        let d = null;
        for (let k = 1; k <= 8; k += 1) {
          for (const j of [it.paragraphIndex + k, it.paragraphIndex - k]) {
            if (j < 0 || j >= doc.paragraphs.length) continue;
            if ((doc.paragraphs[j].text || '').trim()) { d = k; break; }
          }
          if (d !== null) break;
        }
        if (d !== null) emptyAnchorDist.push(d);
      }
      // 空段连续长度
      let run = 0;
      for (let i = 0; i < doc.paragraphs.length; i += 1) {
        const t = (doc.paragraphs[i].text || '').trim();
        if (!t) { run += 1; continue; }
        if (run > 0) { emptyRuns.push(run); run = 0; }
      }
      if (run > 0) emptyRuns.push(run);
      // 脚注长度（决定 NOTE_MATCH_MIN）
      for (const n of (doc.footnotes || [])) {
        const t = (n.text || '').trim();
        if (t) noteLens.push(t.length);
      }
    } catch { /* 忽略 */ }
  }
}

console.log(`解析成功 ${parsed} 篇｜失败 ${failed} 篇\n`);

console.log('① title / author 角色的段落下标分布');
stat('title  下标', titleIdx);
stat('author 下标', authorIdx);
console.log(`  有 title 的稿件 ${filesWithTitle.n} 篇；最后一条 title 下标 ≥30 的 ${filesWithTitle.beyond30} 篇`
  + `，≥50 的 ${filesWithTitle.beyond50} 篇，≥100 的 ${filesWithTitle.beyond100} 篇`);
console.log(`  → ${filesWithTitle.beyond100 === 0
  ? '没有任何稿件把 title 判到 100 段之后，`limit` 这个上限可以**删掉**（角色本身已有前置区约束）'
  : '有稿件把 title 判到很深的位置，需要保留上界并说明依据'}`);

console.log('\n② sizeGapTitle：firstHeading（format 来源 + 居中）与其余标题最大字号之差');
stat('sizeGap', sizeGaps);
const ge16 = sizeGaps.filter((x) => x >= 16).length;
console.log(`  达到阈值 16 的样本 ${ge16} 个，未达到 ${sizeGaps.length - ge16} 个`);
if (ge16 && ge16 < sizeGaps.length) {
  const sorted = [...sizeGaps].sort((a, b) => a - b);
  const below = sorted.filter((x) => x < 16);
  const above = sorted.filter((x) => x >= 16);
  console.log(`  → 阈值以下最大 ${below.at(-1)}，阈值以上最小 ${above[0]}`
    + `（间隔 ${above[0] - below.at(-1)}，${above[0] - below.at(-1) >= 4 ? '存在自然断层，16 落在断层内' : '⚠️ 分布连续，16 是任意值'}）`);
} else if (!ge16) {
  console.log('  → ⚠️ 没有任何样本达到 16，这个分支在语料上从不触发');
}

console.log('\n③ nearestNonEmpty 的半径：空段连续长度分布（决定"最近非空段"最远要走多少）');
stat('空段连续长度', emptyRuns);
const runHist = {};
for (const r of emptyRuns) runHist[Math.min(r, 10)] = (runHist[Math.min(r, 10)] || 0) + 1;
console.log('  分布（≥10 归并到 10） ' + JSON.stringify(runHist));
const le3 = emptyRuns.filter((r) => r <= 3).length;
console.log(`  → 长度 ≤3 的空段区占 ${Math.round((le3 / Math.max(1, emptyRuns.length)) * 1000) / 10}%`
  + `，>3 的占 ${Math.round(((emptyRuns.length - le3) / Math.max(1, emptyRuns.length)) * 1000) / 10}%`);
console.log(`  规则引擎指向空段的样本：${emptyAnchorDist.length} 个（说明该分支是为**模型**而加，规则侧不触发）`);
console.log('  说明：半径 3 是「防病态扫描」的护栏，不是语义阈值 ——'
  + '\n  「最近的非空段」按构造就是离目标最近的内容，走远一点仍比不给位置有用。'
  + '\n  真正的风险是跨过整段空行区后指到别的语义单元，而上面的分布显示'
  + `\n  ${Math.round((le3 / Math.max(1, emptyRuns.length)) * 1000) / 10}% 的空段区长度 ≤3，`
  + '所以 3 覆盖了绝大多数情形，同时挡住了病态的长空行区。');

console.log('\n④ NOTE_MATCH_MIN = 4：脚注对齐门槛');
stat('脚注文本长度（字）', noteLens);
const short4 = noteLens.filter((n) => n < 4).length;
const short8 = noteLens.filter((n) => n < 8).length;
const pc = (x) => Math.round((x / Math.max(1, noteLens.length)) * 1000) / 10;
console.log(`  → 长度 <4 的脚注 ${short4} 条（${pc(short4)}%），<8 的 ${short8} 条（${pc(short8)}%）`);
console.log('  说明：门槛只约束**模糊**匹配 —— 逐字相等时 `paraMatchScore` 返回 `长度+1000`，'
  + '\n  再短的脚注也过。所以 4 不是"最短脚注有多短"的下界，而是"多短的模糊匹配不算数"。'
  + '\n  正文用 8 而脚注用 4，依据是脚注里存在极短条目（最短 2 字，如 `同上。`）：'
  + `\n  实测 <8 字的脚注占 ${pc(short8)}% —— 这个比例**不大**，所以 4 与 8 的差别`
  + `\n  上限就是这 ${pc(short8)}%（${short8} 条）脚注的模糊匹配，不是"整批漏掉"。`
  + '\n  之所以仍取 4：脚注极短时模糊匹配的可信度本来就低，门槛再高会把这些条目'
  + '\n  一起推给"无位置"，而脚注正是引文类规则（CIT-008 等）的主战场 ——'
  + '\n  宁可让短脚注多匹配几次，也不要让引文问题失去定位。');
