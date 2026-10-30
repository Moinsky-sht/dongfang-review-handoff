/**
 * 极简 XML 解析器：面向 OOXML（wordprocessingml）的容错实现。
 * 只构建我们需要的节点树：元素名、属性、文本、父子关系。
 * 目的：不引入任何 npm 依赖即可读取 .docx 的 document.xml / comments.xml / styles.xml。
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

/**
 * 非法控制字符过滤器。
 *
 * ── 为什么必须在**解析层**过滤 ──
 * XML 1.0 本来就不允许这些字符出现在文档里，但实测真实稿件确实会带进来，
 * 而且有**两条**进入路径：
 *   1. 源码里直接写裸控制字符（Word 遇到损坏的域代码、从 PDF 复制、
 *      或第三方工具生成时会发生）
 *   2. **数字字符引用**：`&#x0;` / `&#1;` 这类写法会被 `decodeEntities`
 *      正常解码成一个裸控制字符 —— 也就是说，即使源码里没有裸控制字符，
 *      也能"合法地"注入
 *
 * 实测（`tools/adversarial.mjs`）：一份含 `\x00\x01\x02\x1f` 的稿件，
 * 篇名被抽成 `"正常\u0000文字\u0001\u0002带\u001f控制字符"` ——
 * 这些字符会一路进 JSON、进界面、进导出的报告，让渲染错乱、
 * 让下游 JSON 解析器拒绝整个响应。
 *
 * 保留 `\t`(09) `\n`(0A) `\r`(0D) —— 解析器自己会用它们表示
 * `<w:tab/>` 与 `<w:br/>`。同时清掉 `\uFFFE`/`\uFFFF` 这两个
 * 永久保留的非字符，以及它们之外的其他非字符区段由 UTF-8 解码兜底。
 *
 * 放在 `decodeEntities` 里是刻意的：这是**所有文本节点与属性值**的
 * 唯一出口，改一处就全覆盖（`docx.js` 里 `w:t`、`w:delText`、
 * `w:instrText`、样式名、编号格式都经过它）。
 */
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g;
function stripControlChars(s) {
  return s.replace(CTRL_RE, '');
}

function decodeEntities(s) {
  if (s === undefined || s === null) return s;
  // 注意：不能因为「没有 &」就提前返回 —— 裸控制字符不经过实体解码
  const decoded = s.includes('&')
    ? s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[body] !== undefined ? ENTITIES[body] : m;
    })
    : s;
  return stripControlChars(decoded);
}

export class XmlNode {
  constructor(name, attrs = {}, parent = null) {
    this.name = name;
    this.attrs = attrs;
    this.parent = parent;
    this.children = [];
    this.text = '';
  }

  /** 直接子元素 */
  els(name) {
    if (!name) return this.children;
    return this.children.filter((c) => c.name === name);
  }

  /** 第一个直接子元素 */
  el(name) {
    return this.children.find((c) => c.name === name) || null;
  }

  /** 全部后代元素（含自身可选） */
  descendants(name) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (!name || c.name === name) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  attr(name, dflt = null) {
    return this.attrs[name] !== undefined ? this.attrs[name] : dflt;
  }

  /** 拼接本子树全部文本 */
  allText() {
    let out = this.text;
    for (const c of this.children) out += c.allText();
    return out;
  }

  /** 按本地名（去掉命名空间前缀）取属性 */
  attrLocal(local, dflt = null) {
    if (this.attrs[local] !== undefined) return this.attrs[local];
    for (const k of Object.keys(this.attrs)) {
      if (k.includes(':') && k.split(':').pop() === local) return this.attrs[k];
    }
    return dflt;
  }

  /** 取 w:val 风格属性 */
  get val() {
    return this.attr('w:val') ?? this.attrLocal('val');
  }
}

const VOID_HINT = new Set(['br', 'tab', 'cr', 'lastRenderedPageBreak', 'noBreakHyphen', 'softHyphen']);

/**
 * 解析 XML 文本为节点树。OOXML 无需处理 DTD/命名空间校验。
 * @param {string} xml
 * @returns {XmlNode} 根节点（虚拟 document 节点）
 */
export function parseXml(xml) {
  const root = new XmlNode('#root');
  let cur = root;
  let i = 0;
  const len = xml.length;
  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      if (i < len) cur.text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) cur.text += decodeEntities(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      cur.text += xml.slice(lt + 9, end < 0 ? len : end);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt);
      i = end < 0 ? len : end + 1;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt < 0) break;
    let tag = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      // 容错：闭合标签与当前节点不匹配时向上找
      let target = cur;
      while (target && target !== root && target.name !== name) target = target.parent;
      // 记录闭合标签的起始位置（供 docx 批注注入等「按源串切片改写」的场景使用）
      if (target && target !== root) target.closeStart = lt;
      cur = target && target !== root ? (target.parent || root) : cur;
      continue;
    }
    const selfClose = tag.endsWith('/');
    if (selfClose) tag = tag.slice(0, -1);
    const sp = tag.search(/[\s]/);
    const name = sp < 0 ? tag : tag.slice(0, sp);
    const attrs = {};
    if (sp >= 0) {
      const attrStr = tag.slice(sp);
      const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m;
      while ((m = re.exec(attrStr))) {
        attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
      }
    }
    const node = new XmlNode(name, attrs, cur);
    /**
     * 源串位置（新增，纯附加字段，不影响既有解析行为）：
     *   openStart/openEnd —— 开始标签 `<` 与 `>` 之后的位置
     *   closeStart        —— 闭合标签 `</name>` 的 `<` 位置（自闭合元素无此字段）
     * 用于「在原 XML 字符串里精确切片插入内容」，如给 Word 文档注入批注。
     */
    node.openStart = lt;
    node.openEnd = i;
    node.selfClosing = selfClose;
    cur.children.push(node);
    if (!selfClose && !VOID_HINT.has(name.split(':').pop())) {
      cur = node;
    }
  }
  return root;
}

/** 便捷：按标签名取第一个后代 */
export function first(node, name) {
  const found = node.descendants(name);
  return found.length ? found[0] : null;
}
