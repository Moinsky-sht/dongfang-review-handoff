/**
 * 对抗性输入验收（需求 D）：畸形/边界稿件不能让服务 500、不能挂住、
 * 必须给出**可理解的**错误。
 *
 * 造一批最小 docx 夹具（自写 store-only zip，不引依赖）+ 复用真实 .doc，
 * 逐个打 /api/upload 与 /api/review，记录状态码、耗时、响应体形状。
 *
 * 用法：node tools/adversarial.mjs [服务地址]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CORPUS_ROOT } from './paths.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:3210';
const DIR = 'tools/.adv';
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

/* ── 最小 ZIP 写入（store，不压缩）── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, contentRaw] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(contentRaw) ? contentRaw : Buffer.from(contentRaw, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);        // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cenBuf, end]);
}

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
const doc = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
const P = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const mkDocx = (body) => makeZip([
  ['[Content_Types].xml', CT], ['_rels/.rels', RELS], ['word/document.xml', doc(body)],
]);

const fixtures = [];
const add = (name, buf, note) => {
  const p = path.join(DIR, name);
  fs.writeFileSync(p, buf);
  fixtures.push({ name, p, note, size: buf.length });
};

add('空文档.docx', mkDocx(''), '完全没有段落');
add('仅空段.docx', mkDocx('<w:p/><w:p/><w:p/>'), '三个空段落');
add('仅表格.docx', mkDocx(`<w:tbl><w:tr><w:tc>${P('单元格甲')}</w:tc><w:tc>${P('单元格乙')}</w:tc></w:tr></w:tbl>`), '只有一个表格');
add('仅图片.docx', mkDocx('<w:p><w:r><w:drawing/></w:r></w:p>'), '只有 drawing，无文字');
add('零字节.docx', Buffer.alloc(0), '零字节');
add('非docx内容.docx', Buffer.from('这其实是一个纯文本文件，只是改了扩展名。'.repeat(20), 'utf8'), '纯文本改扩展名');
add('截断docx.docx', (() => { const b = mkDocx(P('正常段落')); return b.subarray(0, Math.floor(b.length / 3)); })(), '合法 docx 的前 1/3');
add('乱码二进制.docx', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 137) % 256)), '随机二进制');
add('控制字符.docx', mkDocx(P('正常\x00文字\x01\x02带\x1f控制字符') + P('\uFFFD\uFFFE替换字符')), '含控制字符');
add('超长单段.docx', mkDocx(P('很长的一段话。'.repeat(20000))), '单段 12 万字');
add('超多段落.docx', mkDocx(P('这是一个普通的正文段落，用于测试大量段落时的表现。').repeat(1).padEnd(1) + Array.from({ length: 5000 }, (_, i) => P(`第 ${i + 1} 段正文内容，用于压测。`)).join('')), '5000 段');
add('畸形XML.docx', makeZip([['[Content_Types].xml', CT], ['_rels/.rels', RELS], ['word/document.xml', '<w:document><w:body><w:p>未闭合']]), 'XML 不闭合');
add('缺document.docx', makeZip([['[Content_Types].xml', CT], ['_rels/.rels', RELS]]), '缺 word/document.xml');
add('深嵌套.docx', mkDocx('<w:sdt>'.repeat(60) + P('深层嵌套') + '</w:sdt>'.repeat(60)), '60 层嵌套');

/* 真实 .doc（旧二进制格式）与真实超大稿 */
const corpus = CORPUS_ROOT;
const findOne = (re) => {
  const stack = [corpus];
  while (stack.length) {
    const d = stack.pop();
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (re.test(e.name)) return p;
    }
  }
  return null;
};
const docFile = findOne(/\.doc$/i);
if (docFile) add('真实旧格式.doc', fs.readFileSync(docFile), 'Word 97-2003 二进制，' + path.basename(docFile).slice(0, 30));

/* ── 打接口 ── */
const results = [];
for (const fx of fixtures) {
  const rec = { name: fx.name, note: fx.note, size: fx.size };
  const t0 = Date.now();
  let upRes = null, upBody = null;
  try {
    const r = await fetch(`${BASE}/api/upload?name=${encodeURIComponent(fx.name)}`, {
      method: 'POST', body: fs.readFileSync(fx.p), signal: AbortSignal.timeout(60000),
    });
    upRes = r.status;
    const txt = await r.text();
    try { upBody = JSON.parse(txt); } catch { upBody = { _raw: txt.slice(0, 200) }; }
  } catch (e) { upRes = 'ERR:' + String(e.message).slice(0, 60); }
  rec.uploadStatus = upRes;
  rec.uploadMs = Date.now() - t0;
  rec.uploadBody = upBody && (upBody.error || upBody.sessionId || upBody.id || upBody.ok || Object.keys(upBody).slice(0, 5).join(','));

  const sid = upBody?.sessionId || upBody?.id;
  if (sid) {
    const t1 = Date.now();
    try {
      const r = await fetch(`${BASE}/api/review`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: sid, useModel: false }), signal: AbortSignal.timeout(120000),
      });
      rec.reviewStatus = r.status;
      const txt = await r.text();
      let b = null; try { b = JSON.parse(txt); } catch { b = { _raw: txt.slice(0, 160) }; }
      rec.reviewIssues = Array.isArray(b?.issues) ? b.issues.length : (b?.error ? 'ERR:' + String(b.error).slice(0, 60) : '无 issues 字段');
      rec.reviewMeta = b?.meta ? `篇名=${JSON.stringify(String(b.meta.title || '').slice(0, 24))}` : '-';
    } catch (e) { rec.reviewStatus = 'ERR:' + String(e.message).slice(0, 60); }
    rec.reviewMs = Date.now() - t1;
  }
  results.push(rec);
  console.log(`${String(rec.uploadStatus).padEnd(6)} ${rec.name.padEnd(20)} ${String(rec.uploadMs + 'ms').padEnd(9)} ${rec.note}`);
  if (rec.uploadBody && rec.uploadStatus !== 200) console.log(`        上传响应: ${JSON.stringify(rec.uploadBody).slice(0, 130)}`);
  if (rec.reviewStatus) console.log(`        审阅 ${rec.reviewStatus} ${rec.reviewMs}ms issues=${rec.reviewIssues} ${rec.reviewMeta}`);
}

/* ── 判定 ── */
console.log('\n════════ 验收判定 ════════');
let bad = 0;
for (const r of results) {
  const problems = [];
  if (typeof r.uploadStatus === 'number' && r.uploadStatus >= 500) problems.push(`上传 ${r.uploadStatus}（服务端错误）`);
  if (String(r.uploadStatus).startsWith('ERR')) problems.push('上传请求异常: ' + r.uploadStatus);
  if (typeof r.reviewStatus === 'number' && r.reviewStatus >= 500) problems.push(`审阅 ${r.reviewStatus}（服务端错误）`);
  if (String(r.reviewStatus).startsWith('ERR')) problems.push('审阅请求异常: ' + r.reviewStatus);
  if (r.uploadMs > 30000) problems.push(`上传耗时 ${r.uploadMs}ms（过久）`);
  if (problems.length) { bad += 1; console.log(`  ❌ ${r.name}: ${problems.join('；')}`); }
}
if (!bad) console.log(`  ✅ 全部 ${results.length} 个畸形输入：无 5xx、无挂起、无请求异常`);
else console.log(`  共 ${bad}/${results.length} 个输入有问题`);
fs.writeFileSync('tools/.adv-results.json', JSON.stringify(results, null, 1));
process.exitCode = bad ? 1 : 0;
