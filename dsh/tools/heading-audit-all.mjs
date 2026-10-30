/**
 * 标题识别全量异常扫描（需求 6 的验收工具）
 *
 * ── 为什么要单独写这个 ──
 * 之前的 `heading-audit.mjs` 只在 13 份定稿上比「新判据 vs 旧判据」的条数。
 * 但「条数差不多」证明不了识别**准确** —— 层级判错、把正文行认成标题、
 * 把署名行认成标题，都可能条数刚好抵消。
 *
 * 这里换个思路：不做两套判据对拍，而是拿**已发排定稿**（编辑部认可、
 * 标题样式规范的成品）当基准，逐份检查**结构性异常**：
 *
 *   · 零标题 / 标题过多 / 过少
 *   · 层级全平（整篇一个级别 —— 结构信息丢失，实测真出现过）
 *   · 层级跳级（一级直接到三级）
 *   · 标题首级不是一级（说明篇名或别的什么东西占了 L1）
 *   · 标题像正文（过长、以句号结尾、含「，」分句）
 *   · 标题像署名行（短、纯人名、无标点）
 *   · 标题像表图题注（以「表 1」「图 2」开头）
 *   · 表内段落被当成标题
 *   · 前置区（篇名/署名/摘要/关键词）被当成标题
 *
 * 每条异常都带**具体段落文本**，可以直接判断是真错还是误报。
 *
 * 用法：
 *   node tools/heading-audit-all.mjs <目录> [目录2 ...]
 *   node tools/heading-audit-all.mjs --list <文件清单.txt>
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocxBuffer } from '../src/docx.js';
import { classifyParagraphs } from '../src/scanner-format.js';

const args = process.argv.slice(2);
const roots = [];
let listFile = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--list') { listFile = args[++i]; continue; }
  roots.push(args[i]);
}

/** 递归收集 .docx（跳过 Word 锁文件 ~$ 与临时文件） */
function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) out.push(p);
  }
  return out;
}

let files = [];
if (listFile) {
  files = fs.readFileSync(listFile, 'utf8').split(/\r?\n/)
    .map((s) => s.trim()).filter((s) => /\.docx$/i.test(s) && !/\\~\$/.test(s))
    .map((s) => path.resolve(process.cwd(), s));
} else {
  for (const r of roots) files.push(...walk(r));
}
files = [...new Set(files)].filter((f) => fs.existsSync(f));

if (!files.length) { console.error('没有找到 .docx'); process.exit(1); }

/* ── 异常判据 ── */

/** 像正文行：长、有句末标点、或含多个分句 */
function looksLikeProseLine(t) {
  if (t.length > 45) return '过长(>45字)';
  /**
   * 只认 `。！；`，**不认 `？`**。
   *
   * 中文论文标题用问号是常态 —— 实测这 6 处「标题像正文」全部是
   * `二、文明型国家（文明国家）与民族国家？`、`"网左"之实践：新的出路抑或是"美丽灵魂"？`
   * 这类**合法的疑问式标题**，把 `？` 当正文信号是纯误报。
   * 标题分级器内部（`looksLikeProse`）本来也只认 `。`，这里对齐。
   */
  if (/[。！；]$/.test(t) && t.length > 18) return '以句末标点结尾且较长';
  const commas = (t.match(/[，,]/g) || []).length;
  if (commas >= 2 && t.length > 24) return `含 ${commas} 个逗号且较长`;
  return null;
}

/**
 * 像署名行：**汉字之间夹空格**的 2–4 字串（本刊署名写法 `罗  楠`、`孟 捷`）。
 *
 * 早期版本只判「2–4 字纯汉字」，于是把 `改革前史`、`尾声` 这类
 * **正常的短章节标题**全报成署名行（实测 2 处，全是误报）。
 * 光看「短且是汉字」根本分不出人名和短标题 —— 必须再加一个信号。
 * 本刊署名一律**姓名之间留空格**，这个特征足够稳，且不会误伤标题。
 * 代价是漏掉不空格的署名（如 `孟捷`）—— 作为分诊工具，
 * 漏报比误报划算（误报会淹没真问题）。
 */
function looksLikeAuthor(t) {
  if (!/^[\u4e00-\u9fa5]+([\s\u3000]+[\u4e00-\u9fa5]+)+$/.test(t)) return null;
  const s = t.replace(/[\s\u3000]+/g, '');
  if (s.length < 2 || s.length > 5) return null;
  if (/^(引言|结语|余论|结论|导论|绪论|摘要|注释|参考文献|后记|致谢)$/.test(s)) return null;
  return '像人名行(汉字间夹空格)';
}

/** 像表图题注 */
function looksLikeCaption(t) {
  if (/^\s*(表|图|附表|附图)\s*[0-9一二三四五六七八九十]/.test(t)) return '像表图题注';
  if (/^(资料来源|数据来源|注)[：:]/.test(t)) return '像资料来源行';
  return null;
}

/** 像前置区（篇名/署名/摘要/关键词/基金） */
function looksLikeFrontMatter(t) {
  if (/^[\[【(（]?\s*(内容提要|摘要|关键词|关键字|作者简介|基金项目|收稿日期)/.test(t)) return '像摘要/关键词/作者简介';
  return null;
}

const reports = [];
let totalHeadings = 0;
const allAnomalies = [];
const sourceTotals = {};
const levelTotals = {};

for (const f of files) {
  let doc;
  try {
    doc = parseDocxBuffer(fs.readFileSync(f), path.basename(f));
  } catch (e) {
    reports.push({ file: f, error: String(e.message).slice(0, 90) });
    continue;
  }
  let cls;
  try {
    cls = classifyParagraphs(doc);
  } catch (e) {
    reports.push({ file: f, error: 'classifyParagraphs: ' + String(e.message).slice(0, 80) });
    continue;
  }

  const heads = [];
  doc.paragraphs.forEach((p, i) => {
    if (!p._headingLevel) return;
    heads.push({
      index: i,
      level: Number(String(p._headingLevel).replace('level', '')) || 0,
      source: p._headingSource || '',
      text: (p.text || '').trim(),
      inTable: !!p.inTable,
    });
  });

  const levels = heads.map((h) => h.level);
  const anomalies = [];
  const push = (kind, detail) => anomalies.push({ kind, detail, file: path.basename(f) });

  if (!heads.length) push('零标题', '整篇没识别出任何标题');
  if (heads.length > 40) push('标题过多', `${heads.length} 条`);

  if (heads.length > 1) {
    const uniq = [...new Set(levels)];
    /**
     * 层级全平**不一定**是异常，判据要分情况。
     *
     * 实测发排定稿里（旧记录写作「103 份」，实为 89 篇 —— 旧分类器把 14 个
 * 文件名带「发排」的责编版在审稿也算了进来）有 39 份是「全 1 级、3–5 条」——
     * 那是**正常结构**：一篇 4 个章节、章节下不再分小节的短文，
     * 本来就该全是 1 级。早期版本把这些全报成异常，
     * 噪声大到没法看出真正的问题（真正的问题是「全 2 级」这类
     * 层级整体偏移，或标题很多却全平）。
     *
     * 所以只在两种情况报：
     *   · 平在 2 级或更深 —— 一篇稿子没有 1 级标题，层级整体偏移了
     *   · 标题超过 6 条却全平 —— 这个数量级通常意味着存在子层级
     */
    if (uniq.length === 1) {
      const lv = uniq[0];
      if (lv > 1) push('层级全平', `全部为第 ${lv} 级（${heads.length} 条）—— 没有一级标题`);
      else if (heads.length > 6) push('层级全平', `${heads.length} 条全为第 1 级，疑有子层级未分出`);
    }
    // 跳级
    for (let i = 1; i < heads.length; i += 1) {
      if (levels[i] - levels[i - 1] > 1) {
        push('层级跳级', `「${heads[i - 1].text.slice(0, 16)}」(L${levels[i - 1]}) → 「${heads[i].text.slice(0, 16)}」(L${levels[i]})`);
      }
    }
    const minLv = Math.min(...levels);
    if (minLv > 1) push('无一级标题', `最小层级为第 ${minLv} 级`);
  }

  for (const h of heads) {
    if (h.inTable) push('表内段落被当标题', `[${h.index}] ${h.text.slice(0, 30)}`);
    const p1 = looksLikeProseLine(h.text); if (p1) push('标题像正文', `[${h.index}] ${p1}｜${h.text.slice(0, 40)}`);
    const p2 = looksLikeAuthor(h.text); if (p2) push('标题像署名', `[${h.index}] ${p2}｜${h.text.slice(0, 30)}`);
    const p3 = looksLikeCaption(h.text); if (p3) push('标题像题注', `[${h.index}] ${p3}｜${h.text.slice(0, 30)}`);
    const p4 = looksLikeFrontMatter(h.text); if (p4) push('前置区被当标题', `[${h.index}] ${p4}｜${h.text.slice(0, 30)}`);
    sourceTotals[h.source] = (sourceTotals[h.source] || 0) + 1;
    levelTotals[h.level] = (levelTotals[h.level] || 0) + 1;
  }

  totalHeadings += heads.length;
  allAnomalies.push(...anomalies);
  reports.push({ file: f, name: path.basename(f), paras: doc.paragraphs.length, heads, anomalies });
}

/* ── 输出 ── */
const KIND_ORDER = ['零标题', '标题过多', '层级全平', '无一级标题', '层级跳级',
  '标题像正文', '标题像署名', '标题像题注', '前置区被当标题', '表内段落被当标题'];

const byKind = {};
for (const a of allAnomalies) (byKind[a.kind] ||= []).push(a);

console.log(`扫描 ${files.length} 份稿件，段落合计 ${reports.reduce((s, r) => s + (r.paras || 0), 0)}`);
console.log(`识别标题合计 ${totalHeadings} 条`);
console.log(`判据来源分布： ${JSON.stringify(sourceTotals)}`);
console.log(`层级分布： ${JSON.stringify(Object.fromEntries(Object.entries(levelTotals).sort((a, b) => a[0] - b[0])))}`);

const errs = reports.filter((r) => r.error);
if (errs.length) {
  console.log(`\n── 解析失败 ${errs.length} 份 ──`);
  for (const e of errs) console.log(`  ✗ ${e.file.split('\\').pop()}：${e.error}`);
}

console.log('\n════════ 异常汇总 ════════');
if (!allAnomalies.length) {
  console.log('  未发现结构性异常');
} else {
  for (const kind of KIND_ORDER) {
    const list = byKind[kind];
    if (!list) continue;
    console.log(`\n【${kind}】${list.length} 处`);
    // 同一份稿件里的同类异常只列前 3 条
    const seen = new Map();
    for (const a of list) {
      const n = (seen.get(a.file) || 0) + 1;
      seen.set(a.file, n);
      if (n <= 3) console.log(`  · ${a.file.split('\\').pop().slice(0, 34)}：${a.detail}`);
    }
    const multi = [...seen.entries()].filter(([, n]) => n > 3);
    if (multi.length) console.log(`  …另有 ${multi.length} 份稿件同类异常各超过 3 处`);
  }
}

const clean = reports.filter((r) => !r.error && !r.anomalies.length).length;
console.log(`\n无异常稿件 ${clean}/${reports.length}`);
