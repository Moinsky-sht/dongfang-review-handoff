/** Strict namespace-aware XML spans for deletion only; never reserialize XML. */
export function cleanError(code, message, part, cause) {
  const error = new Error(`${message}${part ? `（${part}）` : ''}`, cause ? { cause } : undefined);
  error.code = code; if (part) error.part = part;
  return error;
}
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;
const SPACE = /[\x20\t\r\n]/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/;
function entities(value, part) {
  if (CONTROL.test(value)) throw cleanError('CLEAN_XML_INVALID', 'XML 含无效控制字符', part);
  return value.replace(/&([^;]*);|&/g, (raw, body) => {
    const predefined = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, body)) return predefined[body];
    if (/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(body || '')) {
      const code = body.startsWith('#x') ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      if ([9, 10, 13].includes(code) || code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff) return String.fromCodePoint(code);
    }
    throw cleanError('CLEAN_XML_ENTITY', 'XML 含不能安全解析的实体', part);
  });
}
function qname(name, scope, attribute, part) {
  const pieces = name.split(':');
  if (pieces.length > 2 || pieces.some((piece) => !piece)) throw cleanError('CLEAN_XML_INVALID', 'XML 名称无效', part);
  const [prefix, local] = pieces.length === 2 ? pieces : ['', pieces[0]];
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(local) || prefix && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(prefix)) throw cleanError('CLEAN_XML_INVALID', 'XML 限定名称无效', part);
  if (prefix && !scope.has(prefix)) throw cleanError('CLEAN_XML_NAMESPACE', `XML 前缀 ${prefix} 未绑定命名空间`, part);
  return { local, ns: prefix ? scope.get(prefix) : attribute ? '' : scope.get('') || '' };
}
export function scanCleanXml(bytes, part = '') {
  const xml = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  if (Buffer.isBuffer(bytes) && !Buffer.from(xml, 'utf8').equals(bytes)) throw cleanError('CLEAN_XML_ENCODING', '只支持可无损读取的 UTF-8 XML', part);
  const encoding = /^\ufeff?\s*<\?xml\b[^?]*encoding\s*=\s*(['"])([^'"]+)\1/.exec(xml)?.[2];
  if (encoding && !['utf-8', 'us-ascii'].includes(encoding.toLowerCase())) throw cleanError('CLEAN_XML_ENCODING', 'XML 声明使用不支持的编码', part);
  const nodes = []; const stack = []; const roots = [];
  let cursor = xml[0] === '\ufeff' ? 1 : 0;
  const fail = (message) => { throw cleanError('CLEAN_XML_INVALID', message, part); };
  const skipSpace = (at) => { while (SPACE.test(xml[at] || '') && at < xml.length) at += 1; return at; };
  while (cursor < xml.length) {
    if (xml[cursor] !== '<') {
      const next = xml.indexOf('<', cursor); const end = next < 0 ? xml.length : next;
      const text = xml.slice(cursor, end); entities(text, part);
      if (!stack.length && text.trim()) fail('XML 根元素外出现正文');
      cursor = end; continue;
    }
    if (xml.startsWith('<!--', cursor)) {
      const end = xml.indexOf('-->', cursor + 4);
      if (end < 0 || xml.slice(cursor + 4, end).includes('--')) fail('XML 注释未闭合或内容无效');
      cursor = end + 3; continue;
    }
    if (xml.startsWith('<![CDATA[', cursor)) {
      const end = xml.indexOf(']]>', cursor + 9);
      if (end < 0 || !stack.length) fail('CDATA 位置或闭合无效');
      if (CONTROL.test(xml.slice(cursor + 9, end))) fail('CDATA 含无效字符');
      cursor = end + 3; continue;
    }
    if (xml.startsWith('<?', cursor)) {
      const end = xml.indexOf('?>', cursor + 2);
      if (end < 0) fail('XML 处理指令未闭合');
      cursor = end + 2; continue;
    }
    if (xml.startsWith('<!', cursor)) throw cleanError('CLEAN_XML_UNSUPPORTED', '不支持 DTD 或其它 XML 声明', part);
    if (xml.startsWith('</', cursor)) {
      const match = NAME.exec(xml.slice(cursor + 2)); if (!match) fail('XML 闭合元素名无效');
      const at = skipSpace(cursor + 2 + match[0].length);
      if (xml[at] !== '>' || !stack.length || stack.at(-1).name !== match[0]) fail('XML 元素未正确闭合');
      const node = stack.pop(); node.closeStart = cursor; node.end = at + 1; cursor = at + 1; continue;
    }
    const start = cursor; const match = NAME.exec(xml.slice(cursor + 1)); if (!match) fail('XML 元素名无效');
    const name = match[0]; let at = cursor + 1 + name.length;
    const rawAttrs = []; const seen = new Set(); let selfClosing = false;
    while (at < xml.length) {
      const beforeSpace = at; at = skipSpace(at);
      if (xml[at] === '>') { at += 1; break; }
      if (xml.startsWith('/>', at)) { selfClosing = true; at += 2; break; }
      if (at === beforeSpace) fail('XML 属性间缺少空白');
      const attrName = NAME.exec(xml.slice(at)); if (!attrName) fail('XML 属性名无效');
      at += attrName[0].length; at = skipSpace(at);
      if (xml[at++] !== '=') fail('XML 属性缺少等号');
      at = skipSpace(at); const quote = xml[at++];
      if (quote !== '"' && quote !== "'") fail('XML 属性必须使用引号');
      const end = xml.indexOf(quote, at); if (end < 0 || xml.slice(at, end).includes('<')) fail('XML 属性未闭合或内容无效');
      if (seen.has(attrName[0])) fail('XML 属性重复'); seen.add(attrName[0]);
      rawAttrs.push({ name: attrName[0], value: entities(xml.slice(at, end), part) }); at = end + 1;
    }
    if (at > xml.length || xml[at - 1] !== '>') fail('XML 开始元素未闭合');
    const parent = stack.at(-1) || null;
    const scope = new Map(parent?.scope || [['xml', XML_NS]]);
    for (const attr of rawAttrs) {
      if (attr.name === 'xmlns') scope.set('', attr.value);
      else if (attr.name.startsWith('xmlns:')) {
        const prefix = attr.name.slice(6);
        if (!prefix || prefix === 'xmlns' || !attr.value || attr.value === XMLNS_NS || prefix === 'xml' && attr.value !== XML_NS) fail('XML 命名空间声明无效');
        scope.set(prefix, attr.value);
      }
    }
    const resolved = qname(name, scope, false, part);
    const attrs = []; const expanded = new Set();
    for (const attr of rawAttrs) {
      const resolvedAttr = attr.name === 'xmlns' || attr.name.startsWith('xmlns:') ? { ns: XMLNS_NS, local: attr.name === 'xmlns' ? '' : attr.name.slice(6) } : qname(attr.name, scope, true, part);
      const key = `${resolvedAttr.ns}|${resolvedAttr.local}`;
      if (expanded.has(key)) fail('XML 同名空间属性重复'); expanded.add(key);
      attrs.push({ ...attr, ...resolvedAttr });
    }
    const node = { name, ...resolved, attrs, scope, parent, children: [], start, openEnd: at, selfClosing, closeStart: selfClosing ? at : null, end: selfClosing ? at : null };
    if (parent) parent.children.push(node); else roots.push(node);
    nodes.push(node); if (!selfClosing) stack.push(node); cursor = at;
  }
  if (stack.length || roots.length !== 1) fail('XML 必须有一个完整根元素');
  return { xml, nodes, root: roots[0] };
}
export const cleanAttr = (node, local) => node.attrs.find((attr) => attr.ns === '' && attr.local === local)?.value;
export function deleteCleanSpans(xml, nodes, part) {
  const ranges = nodes.map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const range of ranges) {
    if (!Number.isInteger(range.end)) throw cleanError('CLEAN_XML_INVALID', '删除范围不完整', part);
    const last = merged.at(-1);
    if (last && range.start < last.end) {
      if (range.end > last.end) throw cleanError('CLEAN_XML_INVALID', '删除范围交叠', part);
      continue;
    }
    merged.push(range);
  }
  let out = ''; let at = 0;
  for (const range of merged) { out += xml.slice(at, range.start); at = range.end; }
  return out + xml.slice(at);
}
