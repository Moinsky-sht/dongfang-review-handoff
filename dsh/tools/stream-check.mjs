/**
 * SSE 流式接口验证：确认问题确实「逐条」推送，且顺序为
 * 标题 → 正文 → 脚注 → 尾注，最后 done 里的清单与 /api/review 完全一致。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = 'http://127.0.0.1:3210';
const ROOT = resolve('..', '发给皓天的一审文件');
const man = JSON.parse(readFileSync('data/corpus/manifest.json', 'utf8'));
const m = man.find((x) => x.path.includes('01-孟捷') && x.path.endsWith('.docx'));
const buf = readFileSync(join(ROOT, m.path));

const up = await (await fetch(`${BASE}/api/upload?name=x.docx`, {
  method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf,
})).json();
console.log(`上传完成，会话 ${up.id}，段落 ${up.doc.paragraphs.length}，脚注 ${up.doc.footnotes.length}`);

/* ---- 1) 流式审阅 ---- */
const t0 = Date.now();
const res = await fetch(`${BASE}/api/review-stream?id=${up.id}&useModel=false`);
console.log(`SSE 响应 HTTP ${res.status}，content-type=${res.headers.get('content-type')}`);

const reader = res.body.getReader();
const dec = new TextDecoder('utf-8');
let bufText = '';
const events = [];
const arrivals = [];

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  bufText += dec.decode(value, { stream: true });
  let sep;
  while ((sep = bufText.indexOf('\n\n')) >= 0) {
    const chunk = bufText.slice(0, sep);
    bufText = bufText.slice(sep + 2);
    let ev = 'message';
    const dl = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) dl.push(line.slice(5).trimStart());
    }
    if (!dl.length) continue;
    const data = JSON.parse(dl.join('\n'));
    events.push({ ev, data });
    if (ev === 'issue') arrivals.push({ seq: data.seq, ms: Date.now() - t0, it: data.issue });
  }
}
const totalMs = Date.now() - t0;

const kinds = {};
for (const e of events) kinds[e.ev] = (kinds[e.ev] || 0) + 1;
console.log(`\n事件统计：${JSON.stringify(kinds)}`);
console.log(`总耗时 ${totalMs} ms`);

/* ---- 2) 顺序检查 ---- */
const pos = (it) => {
  if (it.paragraphIndex !== undefined && it.paragraphIndex !== null) return it.paragraphIndex;
  if (it.footnoteIndex !== undefined && it.footnoteIndex !== null) return 100000 + it.footnoteIndex;
  if (it.endnoteIndex !== undefined && it.endnoteIndex !== null) return 200000 + it.endnoteIndex;
  return 300000;
};
let inversions = 0;
for (let i = 1; i < arrivals.length; i += 1) {
  if (pos(arrivals[i].it) < pos(arrivals[i - 1].it)) inversions += 1;
}
console.log(`\n顺序检查：${arrivals.length} 条，逆序 ${inversions} 处（应为 0）`);

const paraIssues = arrivals.filter((a) => a.it.paragraphIndex !== undefined && a.it.paragraphIndex !== null);
const fnIssues = arrivals.filter((a) => a.it.footnoteIndex !== undefined && a.it.footnoteIndex !== null);
const docIssues = arrivals.filter((a) => a.it.paragraphIndex == null && a.it.footnoteIndex == null);
console.log(`  正文段落 ${paraIssues.length} 条，脚注 ${fnIssues.length} 条，文档级 ${docIssues.length} 条`);
if (paraIssues.length) {
  console.log(`  正文首条在第 ${paraIssues[0].it.paragraphIndex} 段：「${String(paraIssues[0].it.title).slice(0, 30)}」`);
  console.log(`  正文末条在第 ${paraIssues[paraIssues.length - 1].it.paragraphIndex} 段`);
}
if (fnIssues.length) {
  console.log(`  脚注首条：${fnIssues[0].it.location}，末条：${fnIssues[fnIssues.length - 1].it.location}`);
}
// 脚注必须全部排在正文之后
const lastPara = paraIssues.length ? arrivals.lastIndexOf(paraIssues[paraIssues.length - 1]) : -1;
const firstFn = fnIssues.length ? arrivals.indexOf(fnIssues[0]) : -1;
console.log(`  脚注是否全部在正文之后：${firstFn === -1 || lastPara === -1 || firstFn > lastPara ? '是' : '否'}`);

/* ---- 3) 逐条到达的时序（证明是流式而非一次性） ---- */
if (arrivals.length > 3) {
  const marks = [0, Math.floor(arrivals.length * 0.25), Math.floor(arrivals.length * 0.5), Math.floor(arrivals.length * 0.75), arrivals.length - 1];
  console.log('\n到达时序（累计条数 → 耗时）：');
  for (const i of [...new Set(marks)]) console.log(`  第 ${arrivals[i].seq} 条 → ${arrivals[i].ms} ms`);
}

/* ---- 4) done 清单必须与 /api/review 一致 ---- */
const doneEv = events.find((e) => e.ev === 'done');
console.log(`\ndone 事件：问题 ${doneEv?.data?.issues?.length} 条，summary.total=${doneEv?.data?.summary?.total}`);

const up2 = await (await fetch(`${BASE}/api/upload?name=x.docx`, {
  method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf,
})).json();
const rv = await (await fetch(`${BASE}/api/review`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: up2.id, useModel: false }),
})).json();
const key = (it) => `${it.ruleId}|${it.location}|${it.quote || ''}`;
const sset = new Set((doneEv?.data?.issues || []).map(key));
const rest = new Set(rv.issues.map(key));
const same = sset.size === rest.size && [...sset].every((k) => rest.has(k));
console.log(`与 /api/review 结果一致：${same ? '是' : '否'}（SSE ${sset.size} 条 / HTTP ${rest.size} 条）`);
if (!same) {
  const onlySse = [...sset].filter((k) => !rest.has(k));
  const onlyRest = [...rest].filter((k) => !sset.has(k));
  console.log(`  仅 SSE 有 ${onlySse.length} 条，仅 HTTP 有 ${onlyRest.length} 条`);
  for (const k of onlySse.slice(0, 3)) console.log(`    SSE only: ${k.slice(0, 80)}`);
  for (const k of onlyRest.slice(0, 3)) console.log(`    HTTP only: ${k.slice(0, 80)}`);
}

/* ---- 5) 尾注顺序：找一份含尾注的稿件，验证 正文 → 脚注 → 尾注 的块顺序 ---- */
const enMan = man.find((x) => /尾注/.test(x.path) && x.path.endsWith('.docx'));
if (!enMan) {
  console.log('\n尾注顺序检查：语料中未找到含尾注的稿件，跳过');
} else {
  const enBuf = readFileSync(join(ROOT, enMan.path));
  const up3 = await (await fetch(`${BASE}/api/upload?name=y.docx`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: enBuf,
  })).json();
  const r3 = await fetch(`${BASE}/api/review-stream?id=${up3.id}&useModel=false`);
  const rd3 = r3.body.getReader();
  let t3 = '';
  const arr3 = [];
  for (;;) {
    const { done, value } = await rd3.read();
    if (done) break;
    t3 += dec.decode(value, { stream: true });
    let s3;
    while ((s3 = t3.indexOf('\n\n')) >= 0) {
      const chunk = t3.slice(0, s3);
      t3 = t3.slice(s3 + 2);
      let ev = 'message';
      const dl = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) dl.push(line.slice(5).trimStart());
      }
      if (!dl.length) continue;
      const d = JSON.parse(dl.join('\n'));
      if (ev === 'issue') arr3.push(d.issue);
    }
  }

  const kindOf = (it) => {
    if (it.paragraphIndex !== undefined && it.paragraphIndex !== null) return '正文';
    if (it.footnoteIndex !== undefined && it.footnoteIndex !== null) return '脚注';
    if (it.endnoteIndex !== undefined && it.endnoteIndex !== null) return '尾注';
    return '文档级';
  };
  const rank = { 正文: 0, 脚注: 1, 尾注: 2, 文档级: 3 };
  const kinds = arr3.map(kindOf);
  let blockInv = 0;
  let prev = -1;
  for (const k of kinds) { if (rank[k] < prev) blockInv += 1; prev = rank[k]; }
  let innerInv = 0;
  const seenIdx = {};
  for (const it of arr3) {
    const k = kindOf(it);
    const v = k === '正文' ? it.paragraphIndex
      : k === '脚注' ? it.footnoteIndex
        : k === '尾注' ? it.endnoteIndex : 0;
    if (seenIdx[k] !== undefined && v < seenIdx[k]) innerInv += 1;
    seenIdx[k] = v;
  }
  const enIssues = arr3.filter((x) => x.endnoteIndex !== undefined);
  let badEn = 0;
  for (const x of enIssues) {
    const p = (up3.doc.endnotes || [])[x.endnoteIndex];
    const q = String(x.quote || '').replace(/\s/g, '').slice(0, 12);
    if (!p || (q && !p.text.replace(/\s/g, '').includes(q))) badEn += 1;
  }
  const counts3 = kinds.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {});
  console.log(`\n尾注顺序检查（${enMan.path.split(/[\\/]/).pop().slice(0, 40)}）`);
  console.log(`  尾注条目 ${(up3.doc.endnotes || []).length}，流中共 ${arr3.length} 条：${JSON.stringify(counts3)}`);
  console.log(`  类别块顺序：${[...new Set(kinds)].join(' → ')}`);
  console.log(`  类别逆序 ${blockInv} 处（应为 0）／同类别内逆序 ${innerInv} 处（应为 0）`);
  console.log(`  尾注问题 ${enIssues.length} 条，原文反查对不上 ${badEn} 条（应为 0）`);
  const enOk = blockInv === 0 && innerInv === 0 && badEn === 0 && enIssues.length > 0;
  console.log(`  结论：${enOk ? '通过' : '不通过'}`);
}
