/**
 * 零依赖 ZIP 读取器（只用 node:zlib）。
 * 支持 stored(0) 与 deflate(8)；DOCX 全部条目都落在两种情况内。
 */
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/**
 * OLE2/CFB 复合文档头（旧版 Word .doc、.xls、.ppt 都是这个签名）。
 * 注意字节序：文件头 8 字节是 D0 CF 11 E0 A1 B1 1A E1，
 * 按规范读作大端 0xD0CF11E0（等价于小端 0xE011CFD0）。
 */
const OLE2_SIG_BE = 0xd0cf11e0;
export function isOle2(buf) {
  return buf.length >= 8 && buf.readUInt32BE(0) === OLE2_SIG_BE;
}

/**
 * 给出可操作的错误信息。
 * 实测语料中确实存在「扩展名是 .docx 但内容其实是旧版 .doc」的文件，
 * 此时报「未找到中央目录」会让用户无从下手，因此按文件头识别并明确提示。
 */
function describeBadFile(buf) {
  if (isOle2(buf)) {
    return new Error('这是旧版 Word 格式（.doc / 扩展名为 .docx 但内容为 OLE2 复合文档），本系统只支持 .docx。请在 Word 中「另存为 → Word 文档（*.docx）」后重新导入。');
  }
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    return new Error('文件是 ZIP 容器但中央目录损坏或文件不完整，请确认文件未在传输中截断。');
  }
  const head = buf.slice(0, 8).toString('hex');
  return new Error(`不是有效的 .docx 文件（文件头 ${head}）。请确认导入的是 Word 的 .docx 文档，而不是 .doc、.pdf 或改过扩展名的其他格式。`);
}

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw describeBadFile(buf);
}

/** 解析出 zip 条目表 */
export function readZipEntries(buf) {
  const eocd = findEOCD(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    // 中央目录签名不符说明偏移已被破坏。此前这里直接 break，
    // 会静默返回空条目表，最终表现为「缺少 word/document.xml」这类误导性错误。
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) {
      if (entries.length === 0) {
        throw new Error('ZIP 中央目录偏移异常（文件可能损坏或被非标准工具改写），无法读取文档内容。');
      }
      break;
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, rawSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (entries.length === 0 && count > 0) {
    throw new Error(`ZIP 目录声明 ${count} 个条目但一个都没读到，文件可能已损坏。`);
  }
  return entries;
}

/** 读取单个条目内容（Buffer） */
export function readZipEntry(buf, entry) {
  const off = entry.localOff;
  if (buf.readUInt32LE(off) !== LOC_SIG) throw new Error(`条目本地头损坏：${entry.name}`);
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`);
}

/** 打开 zip，返回 { names, read(name) } */
export function openZip(buf) {
  const entries = readZipEntries(buf);
  const map = new Map(entries.map((e) => [e.name, e]));
  return {
    names: entries.map((e) => e.name),
    has: (n) => map.has(n),
    read(n) {
      const e = map.get(n);
      if (!e) return null;
      return readZipEntry(buf, e);
    },
    readText(n) {
      const b = this.read(n);
      return b ? b.toString('utf8') : null;
    },
    /** 防止 zip 炸弹 */
    totalUncompressed: entries.reduce((s, e) => s + (e.rawSize || 0), 0),
  };
}
