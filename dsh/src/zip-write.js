/**
 * 零依赖 ZIP 写入器（只用 node:zlib）——与 src/zip.js 读取器配套。
 *
 * 为什么需要：导出「带批注的 Word 文档」时，要在**原稿**基础上改写
 * `word/document.xml`、新增 `word/comments.xml`，然后重新打包成 .docx。
 * DOCX 本质就是 ZIP，所以需要一个写 ZIP 的能力。
 *
 * 实现取向：全部条目重打包，能压就压（deflate），压不动就 stored；
 * 文件名用 UTF-8 标志位（bit 11）。不写目录条目、不写扩展字段——
 * Word / WPS 对此都能正确识别（实测）。
 */
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 固定的 DOS 时间戳（1980-01-01 00:00），保证输出可复现、与运行时间无关 */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 1980-01-01

/**
 * @param {Array<{name:string, data:Buffer|Uint8Array|string}>} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const deflated = data.length ? deflateRawSync(data) : Buffer.alloc(0);
    const useDeflate = deflated.length && deflated.length < data.length;
    const method = useDeflate ? 8 : 0;
    const comp = useDeflate ? deflated : data;
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);        // version needed
    lh.writeUInt16LE(0x0800, 6);    // flags: UTF-8 文件名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);        // version made by
    ch.writeUInt16LE(20, 6);        // version needed
    ch.writeUInt16LE(0x0800, 8);    // flags
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);        // extra len
    ch.writeUInt16LE(0, 32);        // comment len
    ch.writeUInt16LE(0, 34);        // disk number
    ch.writeUInt16LE(0, 36);        // internal attrs
    ch.writeUInt32LE(0, 38);        // external attrs
    ch.writeUInt32LE(offset, 42);   // local header offset
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }

  const cdStart = offset;
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...local, ...central, eocd]);
}
