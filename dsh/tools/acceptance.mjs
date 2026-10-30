/**
 * 验收验证：拿历史「一审 done」稿件做基准，
 * 对比智能体发现的问题与责编真实批注/修订，计算覆盖情况。
 *
 * 用法：node tools/acceptance.mjs <稿件.docx> [--model=xxx] [--no-model] [--out=dir]
 */
import { parseDocx, fullReview, buildReport } from '../src/review.js';
import { DEFAULT_MODEL } from '../src/ark.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
let file = args.find((a) => !a.startsWith('--'));
const getOpt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const useModel = !args.includes('--no-model');
const model = getOpt('model', DEFAULT_MODEL);
const outDir = resolve(getOpt('out', 'data/acceptance'));

/** 支持 --sha=<sha256> / --pick=<序号>，由 manifest 解析真实路径（规避 shell 中文路径问题） */
const shaOpt = args.find((a) => a.startsWith('--sha='));
const pickOpt = args.find((a) => a.startsWith('--pick='));
if (!file && (shaOpt || pickOpt)) {
  const ROOT = resolve('..', '发给皓天的一审文件');
  const manifest = JSON.parse(readFileSync(resolve('data/corpus/manifest.json'), 'utf8'));
  if (shaOpt) {
    const m = manifest.find((x) => x.sha256 === shaOpt.slice(6));
    if (!m) { console.error('未找到该 sha256'); process.exit(1); }
    file = join(ROOT, m.path);
  } else {
    const n = Number(pickOpt.slice(7));
    const list = manifest.map((m) => ({ ...m, full: join(ROOT, m.path) }))
      .filter((m) => m.comments >= 25 && existsSync(m.full))
      .sort((a, b) => b.comments - a.comments);
    if (!list[n]) { console.error(`序号越界 0..${list.length - 1}`); process.exit(1); }
    file = list[n].full;
    console.log(`[pick ${n}] ${list[n].comments} 条历史批注 | ${list[n].path}`);
  }
}
if (!file) { console.error('用法：node tools/acceptance.mjs <稿件.docx|--sha=xxx|--pick=N> [--model=xxx] [--no-model]'); process.exit(1); }

const doc = parseDocx(resolve(file));
const sha = createHash('sha256').update(readFileSync(resolve(file))).digest('hex');

console.log(`\n═══ 验收验证 ═══`);
console.log(`稿件：${basename(file)}`);
console.log(`历史批注 ${doc.comments.length} 条，修订 ${doc.revisions.length} 处，脚注 ${doc.stats.footnotes} 条\n`);

const t0 = Date.now();
const result = await fullReview(doc, { useModel, model, onProgress: (p) => p.message && console.log(`  [${p.phase}] ${p.message}`) });
const secs = ((Date.now() - t0) / 1000).toFixed(1);

/* ---- 1. 规则覆盖率：历史批注涉及的方面，智能体是否也有发现 ---- */
const ASPECTS = [
  { name: '标题层级与编号', kw: /标题|层级|编号|一级|二级|三级|小标题/, ruleKws: ['标题层级', '标题'] },
  { name: '摘要/内容提要', kw: /摘要|提要/, ruleKws: ['摘要'] },
  { name: '关键词', kw: /关键词|关键字/, ruleKws: ['关键词'] },
  { name: '作者简介/基金', kw: /作者简介|基金|课题|项目/, ruleKws: ['作者信息'] },
  { name: '标点符号', kw: /标点|顿号|逗号|句号|分号|冒号|引号|书名号|括号|破折号|省略号|全角|半角/, ruleKws: ['标点符号'] },
  { name: '数字与年代用法', kw: /数字|阿拉伯|汉字数字|约数|年代|世纪|年份|百分比/, ruleKws: ['数字用法'] },
  { name: '图表规范', kw: /图表|表格|插图|图题|表题|资料来源|数据来源|单位|三线表|坐标/, ruleKws: ['图表'] },
  { name: '脚注著录格式', kw: /脚注|尾注|注释|著录|出处|版本|页码|出版社|出版年|期号/, ruleKws: ['脚注', '引文'] },
  { name: '网络来源', kw: /网址|链接|URL|http|浏览日期|访问日期|发布日期|网站|公众号/, ruleKws: ['网络来源'] },
  { name: '经典著作引用', kw: /选集|文集|马克思恩格斯|列宁|毛泽东|经典/, ruleKws: ['经典著作'] },
  { name: '领导人讲话', kw: /习近平|总书记|领导人|讲话/, ruleKws: ['领导人讲话'] },
  { name: '译名与专名', kw: /译名|译法|翻译|原文|外文|英文|人名|地名|机构名|统一/, ruleKws: ['译名', '专有名词', '术语'] },
  { name: '语病与搭配', kw: /搭配|成分|残缺|赘余|重复|语病|不通|语序|歧义|指代|病句/, ruleKws: ['搭配', '成分', '语序', '指代', '语法'] },
  { name: '词汇用词', kw: /用词|词汇|词语|错别字|误用|生造|简称|全称|术语|概念|措辞|口语/, ruleKws: ['用词', '词汇', '口语', '术语', '概念'] },
  { name: '逻辑论证', kw: /逻辑|论证|论据|结论|矛盾|跳跃|过渡|结构/, ruleKws: ['逻辑', '结构', '过渡', '重复'] },
  { name: '事实与数据核查', kw: /事实|核实|核对|核查|数据|统计|来源|依据|证据|有误|不准确/, ruleKws: ['事实', '数据', '引文'] },
  { name: '政治与政策表述', kw: /政治|敏感|提法|中央|习近平|总书记|政策|口径|官方|把关/, ruleKws: ['政治表述'] },
];

const commentTexts = doc.comments.map((c) => c.text).join('\n');
const issueText = result.issues.map((i) => `${i.title} ${i.category} ${i.detail} ${i.fix}`).join('\n');

const coverage = ASPECTS.map((a) => {
  const inComments = a.kw.test(commentTexts);
  const inIssues = result.issues.some((i) => a.ruleKws.some((k) => `${i.category}${i.title}`.includes(k)));
  return { aspect: a.name, 批注提及: inComments ? '是' : '否', 智能体发现: inIssues ? '是' : '否', 覆盖: !inComments ? '—' : (inIssues ? '✓' : '✗') };
});

/* ---- 2. 数量对比 ---- */
const summary = result.summary;
console.log(`\n【规则引擎 + 模型审阅结果】`);
console.log(`  合计 ${summary.total} 条（规则 ${summary.ruleBased} / 模型 ${summary.modelBased}）`);
console.log(`  格式 ${summary.format} · 语言 ${summary.language} · 引文 ${summary.citation}`);
console.log(`  严重度 高 ${summary.bySeverity['高'] || 0} / 中 ${summary.bySeverity['中'] || 0} / 低 ${summary.bySeverity['低'] || 0}`);
console.log(`  耗时 ${secs} 秒${result.usage ? `，Token 输入 ${result.usage.input_tokens} / 输出 ${result.usage.output_tokens}` : ''}`);

console.log(`\n【与历史批注的方面覆盖对照】`);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
console.log(`  ${pad('方面', 20)}${pad('批注提及', 10)}${pad('智能体发现', 12)}覆盖`);
for (const c of coverage) console.log(`  ${pad(c.aspect, 20)}${pad(c.批注提及, 10)}${pad(c.智能体发现, 12)}${c.覆盖}`);

const covered = coverage.filter((c) => c.覆盖 === '✓').length;
const applicable = coverage.filter((c) => c.覆盖 !== '—').length;
console.log(`\n  方面覆盖率：${covered}/${applicable} = ${applicable ? ((covered / applicable) * 100).toFixed(0) : 0}%`);

/* ---- 3. 与真实修订对照：同一段落是否有发现 ---- */
const revParas = new Set();
for (const p of doc.paragraphs) if (p.changed) revParas.add(p.index);
const issueParas = new Set(result.issues.filter((i) => i.paragraphIndex !== undefined).map((i) => i.paragraphIndex));
let hitRev = 0;
for (const i of revParas) if (issueParas.has(i)) hitRev += 1;
console.log(`\n【与真实修订位置对照】`);
console.log(`  含修订痕迹的段落 ${revParas.size} 个，其中智能体也报出问题的 ${hitRev} 个（${revParas.size ? ((hitRev / revParas.size) * 100).toFixed(0) : 0}%）`);

/* ---- 输出 ---- */
mkdirSync(outDir, { recursive: true });
const base = basename(file).replace(/\.docx?$/i, '');
const report = buildReport(result, doc);
writeFileSync(resolve(outDir, `${base}_审校报告.md`), report, 'utf8');
writeFileSync(resolve(outDir, `${base}_审阅结果.json`), JSON.stringify({
  file, sha256: sha, model: useModel ? model : null, seconds: Number(secs),
  summary, coverage, revisionOverlap: { revisedParagraphs: revParas.size, alsoFlagged: hitRev },
  issues: result.issues,
}, null, 2), 'utf8');
console.log(`\n  报告：${resolve(outDir, `${base}_审校报告.md`)}`);
console.log(`  结果：${resolve(outDir, `${base}_审阅结果.json`)}\n`);
