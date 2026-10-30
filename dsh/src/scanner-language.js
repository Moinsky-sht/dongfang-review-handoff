/**
 * 语言与词汇扫描引擎。
 * 执行 rules/language-rules.json 中 type=list 的规则（正则 + 词表 + 统计）。
 * type=model 的规则由 src/ark.js 交给大模型处理。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = resolve(__dirname, '..', 'rules', 'language-rules.json');

export function loadLanguageRules() {
  return JSON.parse(readFileSync(RULES_PATH, 'utf8'));
}

function snippet(text, index, len = 70) {
  const start = Math.max(0, index - 24);
  return text.slice(start, Math.min(text.length, index + len));
}

function mkIssue(rule, loc, extra) {
  return {
    ruleId: rule.id,
    category: rule.category,
    group: 'language',
    severity: rule.severity,
    title: rule.title,
    basis: '历史批注归纳',
    detail: rule.rule,
    fix: rule.fix || '',
    ...loc,
    ...extra,
  };
}

/**
 * 句末终止符：中文全角（。！？；…）与西文半角（. ! ? ;）。
 * 省略号「……」是中文句末标点之一，必须切（否则整段议论会被并成一句）。
 */
const SENT_TERM = new Set(['。', '！', '？', '；', '…', '.', '!', '?', ';']);
/**
 * 句子结束后应并入**同一句**的收尾符：引号 / 括号 / 省略号续点。
 *
 * ── 为什么必须吸掉 ──
 * 中文句末标点常被收尾引号包住（`。”` / `？」` / `。」`）。旧实现一到
 * `。` 就切，收尾引号被甩到下一段，于是下一句变成「”从另一角度看……」——
 * **句首多了一个引号**。实测全语料有 **6329 句（2.90%）** 是这样开头的，
 * 其中大量是孤零零一个 `”`。这直接破坏一切「看句首」的规则
 * （LANG-012 层次标识要求 `startsWith` 命中，多一个 `”` 就全部失效）。
 */
const SENT_CLOSE = new Set(['”', '’', '」', '』', '）', ')', '】', '》', ']', '}', '"', "'", '…']);

/**
 * 常见西文缩写：其后的点号**不是**句末。全部按小写比对。
 * 语料里的真实误切（见 `tools/audit-sentences.mjs`）：
 *   `et al.` / `trans.` / `p.105` / `pp.` / `cf.` / `ed.` / `No.5`
 * 旧实现只认「点前是大写字母」（U.S.），这些**小写结尾**的缩写全部被误切，
 * 切出的半截片段以 `al.,` / `p.97` / `trans.` 开头（实测 311 句）。
 */
const ABBR = new Set([
  'al', 'et', 'no', 'nos', 'pp', 'p', 'cf', 'ed', 'eds', 'vol', 'vols', 'ch', 'fig', 'figs',
  'vs', 'etc', 'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'trans', 'repr', 'dir',
  'ibid', 'op', 'cit', 'seq', 'ser', 'sec', 'dept', 'univ', 'inc', 'ltd', 'co', 'corp',
  'approx', 'c', 'ca', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug',
  'sep', 'sept', 'oct', 'nov', 'dec', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
]);
/** 网址 / 文件名 / 域名后缀：其点号不是句末（`.../a.htm ` / `www.gov.cn` / `x.pdf`） */
const URLISH = /:\/\/|^www\.|\.(?:com|org|net|gov|edu|cn|uk|jp|de|fr|htm|html|php|asp|jsp|pdf|doi|xml|json|txt|png|jpe?g|gif)$/i;

/**
 * 半角句末标点**是否其实不是句末**。
 *
 * 判据（任一成立即「不是句末」）：
 *   1. 后面不是空白/结尾（`3.14` / `www.a.com` / `e.g.`）；
 *   2. 点前是大写字母（`U.S.` / `A.` 之类单个或首字母缩写）；
 *   3. 以点结尾的整词是常见缩写（`et al.` / `p.` / `trans.` / `No.`）；
 *   4. 以点结尾的整词是网址/文件名/域名（`.../a.htm` / `x.pdf`）。
 *
 * ⚠️ **不能**再用「点前是数字 ⇒ 小数点」这条判据。判据 1 已经把「点后紧跟数字」
 * （`3.14` / `No.5`）挡住了；再按「点前是数字」压制，会把**句末的年份**误判为
 * 小数点 —— `…in 2020. The next…` 就不再切句，两句并成一句（实测真实缺陷）。
 */
function notSentenceEnd(ch, buf, chars, i) {
  const next = chars[i + 1];
  const prev = chars[i - 1] || '';
  if (next !== undefined && !/\s/.test(next)) return true;
  if (ch === '.') {
    if (/[A-Z]/.test(prev)) return true;      // U.S. / A.
    const m = buf.match(/\S+\.$/);
    if (m) {
      const word = m[0].replace(/\.$/, '').toLowerCase();
      if (ABBR.has(word)) return true;        // et al. / p. / trans. / No.
      if (URLISH.test(m[0])) return true;     // .htm / .com / http://
    }
  }
  return false;
}

/**
 * 中文句子切分。
 * @param {string} text
 * @param {{semicolon?: boolean}} [opts]
 *   `semicolon`（默认 true）：是否把分号 `；` / `;` 也当作句子边界。
 *   · 「看句首」类规则（LANG-012 层次标识）需要分号边界 ——「首先……；其次……」
 *     的「其次」是**分句首**；
 *   · 「看句子长度」类规则（LANG-010 欧化长句）**不能**用分号边界 ——
 *     分号是句内分句，一句带分号的长句被切成几截就永远量不出「长句」。
 */
export function splitSentences(text, opts = {}) {
  const useSemicolon = opts.semicolon !== false;
  const out = [];
  let buf = '';
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    buf += ch;
    let term = SENT_TERM.has(ch);
    if (term && (ch === '；' || ch === ';') && !useSemicolon) term = false;
    if (term) {
      // 全角标点一律切；半角标点要过一遍「其实不是句末」的判断
      if (ch === '.' || ch === '!' || ch === '?' || ch === ';') {
        term = !notSentenceEnd(ch, buf, chars, i);
      }
    } else if (ch === '\n') {
      // `w:br` / `w:cr` 手工换行：作者在此断开，视为句子边界。
      // 实测 74 个段落含换行却没有任何句末标点，旧实现会把两行并成一句。
      term = true;
    }
    if (!term) continue;
    /**
     * 书名号《》**内部**的句末标点不切句。
     *
     * ── 为什么 ──
     * 书名/篇名里带问号、句号极常见：《怎么办？》《我们是谁？》
     * 《什么是“人民之友”以及他们如何攻击社会民主党人？》。旧实现一见 `？`
     * 就切，把 `《怎么办？》` 拆成 `《怎么办？》`+`，陕西：…`，
     * 于是下一句以 `，` 开头（实测 closeStart 里占比最高的一类）。
     *
     * 判据：`buf` 里最后一个 `《` 晚于最后一个 `》` ⇒ 处在书名号内。
     * 加 80 字上限：遇到**没闭合**的《（作者漏写》），到一定长度就恢复切句，
     * 避免「一个漏写的书名号把整段变成一句话」这种灾难性退化。
     */
    if (ch !== '\n') {
      const bo = buf.lastIndexOf('《');
      const bc = buf.lastIndexOf('》');
      if (bo > bc && (i - bo) <= 80) term = false;
    }
    if (!term) continue;
    // 吸收紧随其后的收尾引号/括号/省略号续点，避免 `。”` 被拆成两段；
    // 连着的句末标点（作者偶发的 `。”。` / `！？`）也一并吸进来，免得切出
    // 一个孤零零的 `。` 片段。
    while (i + 1 < chars.length && (SENT_CLOSE.has(chars[i + 1]) || SENT_TERM.has(chars[i + 1]))) { i += 1; buf += chars[i]; }
    if (buf.trim()) out.push(buf);
    buf = '';
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** 收集全部可扫描文本单元 */
function units(doc) {
  const list = [];
  doc.paragraphs.forEach((p, i) => {
    if (p.text.trim()) list.push({ text: p.text, kind: 'paragraph', pi: i, ref: p });
  });
  doc.footnotes.forEach((p, i) => {
    if (p.text.trim()) list.push({ text: p.text, kind: 'footnote', fi: i, ref: p });
  });
  return list;
}

function locOf(u, paras) {
  return u.kind === 'paragraph'
    ? { location: `paragraph:${paras[u.pi].index}`, paragraphIndex: u.pi }
    : { location: `footnote:${u.fi}`, footnoteIndex: u.fi };
}

/**
 * 判断位置是否落在引号内部（中文引号 “” 「」 『』 与西文引号）。
 * 引用原文中的文言与生僻语是必要的，不应作为语体问题报出。
 */
function isInsideQuotes(text, at) {
  const before = text.slice(0, at);
  const pairs = [['“', '”'], ['「', '」'], ['『', '』'], ['"', '"']];
  for (const [open, close] of pairs) {
    const lastOpen = before.lastIndexOf(open);
    if (lastOpen < 0) continue;
    const lastClose = before.lastIndexOf(close);
    if (lastOpen > lastClose) return true;
  }
  return false;
}

/**
 * 判断一处政治术语是否处于「保持距离」的语境：
 * 加引号引用、前面有「所谓」「西方主张的」等转述标记、或前文有批判性动词。
 * 这类用法是规范的批判性引用，不应报为问题。
 */
function isDistancedPoliticalUse(text, at, term) {
  const before = text.slice(Math.max(0, at - 24), at);
  const after = text.slice(at + term.length, at + term.length + 3);
  // 紧邻引号（“”「」『』）包裹
  if (/[“「『]$/.test(before) && /^[”」』]/.test(after)) return true;
  if (/[“「『]$/.test(before)) return true;
  // 转述 / 批判标记
  if (/(所谓|西方(主张|宣称|标榜|鼓吹|推崇|定义|话语)|美西方|标榜|鼓吹|自诩|自封|号称|并不存在|不存在|批判|批评|解构|驳斥|否定|质疑|反思|摒弃|警惕|拒斥|反对)$/.test(before)) return true;
  if (/(的|之)$/.test(before) && /(所谓|西方|美西方|美国|自由主义|冷战)/.test(before)) return true;
  // 「中华民国」用于客观历史时段（如「中华民国时期」「中华民国政府」「1929年」等）是规范用法
  if (term === '中华民国' && /(时期|年间|时代|初年|末年|元年|政府|教育新法令|临时约法|南京临时)/.test(after + text.slice(at + term.length, at + term.length + 12))) return true;
  // 「落后国家」「第三世界国家」在政治经济学、发展经济学、依附理论的学术语境中是规范术语
  // （如「发达资本主义国家与落后国家」「中心—外围」），只有用于描述当代中国的对外表述时才须改口径
  if (term === '落后国家' || term === '第三世界国家') {
    const wide = text.slice(Math.max(0, at - 60), at + term.length + 60);
    if (/(资本主义|世界体系|中心|外围|依附|殖民|发达|不发达|经济史|发展经济学|帝国主义|世界经济|全球南方|民族解放|独立运动|学术|理论|概念|范畴)/.test(wide)) return true;
  }
  return false;
}

export function scanLanguage(doc, options = {}) {
  const cfg = loadLanguageRules();
  const rules = new Map(cfg.rules.map((r) => [r.id, r]));
  const issues = [];
  const info = [];
  const paras = doc.paragraphs;
  const all = units(doc);
  const bodyUnits = all.filter((u) => u.kind === 'paragraph');
  const fullText = bodyUnits.map((u) => u.text).join('\n');

  const listRules = cfg.rules.filter((r) => r.detect?.type === 'list');

  /* --- 正则类规则 --- */
  for (const rule of listRules) {
    const pats = rule.detect.patterns || [];
    // 政治表述类规则必须走「保持距离的引用」判定，否则「中华民国政府」
    // 「发达资本主义国家和落后国家」这类规范表述会被误报。
    // 实测不做这一步，LANG-016 会在 250 份稿件上产生 1000+ 条误报。
    const isPolitical = rule.category === '政治表述';
    for (const u of all) {
      for (const pat of pats) {
        let re;
        try { re = new RegExp(pat, 'g'); } catch { continue; }
        let m;
        let guard = 0;
        while ((m = re.exec(u.text)) && guard < 50) {
          guard += 1;
          if (isPolitical && isDistancedPoliticalUse(u.text, m.index, m[0])) continue;
          issues.push(mkIssue(rule, { ...locOf(u, paras), quote: snippet(u.text, m.index), offset: m.index }, {
            message: `命中「${rule.category}」规则：${m[0].slice(0, 40)}`,
            suggestion: rule.fix,
          }));
        }
      }
    }
  }

  /* --- 词表类规则 ---
   * 注意：口语化词、空泛表达、易误用成语这三组词表只做「疑似」提示。
   * 实测发现，脱离语境的词表匹配误报率很高（例如「比较」在「比较研究」中、
   * 「可以看出」在转述中都是规范用法），会把合规稿件报成问题。
   * 因此默认关闭，仅在显式传入 { includeFuzzyLexicon: true } 时输出，
   * 且严重度降为「低」、消息中标明「疑似」，由编辑判断。
   */
  const lexiconMap = [
    ['LANG-008', '口语化词'],
    ['LANG-009', '空泛表达'],
    ['LANG-013', '易误用成语'],
  ];
  const CJK = /[\u4e00-\u9fa5]/;
  /** 判定命中是否为独立词语：前后不再接汉字，避免「独特」误命中「特」 */
  const isStandalone = (text, at, wd) => {
    const pre = text[at - 1] || '';
    const post = text[at + wd.length] || '';
    return !CJK.test(pre) && !CJK.test(post);
  };
  for (const [ruleId, key] of lexiconMap) {
    if (!options.includeFuzzyLexicon) break;
    const rule = rules.get(ruleId);
    if (!rule) continue;
    const words = cfg.lexicon[key];
    if (!Array.isArray(words)) continue;
    for (const u of all) {
      for (const wd of words) {
        if (!wd || wd.length < 2) continue;
        let from = 0;
        let hits = 0;
        while (hits < 3) {
          const at = u.text.indexOf(wd, from);
          if (at < 0) break;
          from = at + wd.length;
          if (!isStandalone(u.text, at, wd)) continue;
          hits += 1;
          issues.push(mkIssue(rule, { ...locOf(u, paras), quote: snippet(u.text, at), offset: at }, {
            severity: '低',
            message: `疑似${rule.category}：「${wd}」，请结合语境判断`,
            suggestion: rule.fix,
          }));
        }
      }
    }
  }

  /* --- LANG-025 称谓 --- */
  {
    const rule = rules.get('LANG-025');
    if (rule) {
      for (const u of all) {
        for (const wd of ['你刊', '你校', '你方', '你单位']) {
          const at = u.text.indexOf(wd);
          if (at < 0) continue;
          issues.push(mkIssue(rule, { ...locOf(u, paras), quote: snippet(u.text, at), offset: at }, {
            message: `称谓「${wd}」不得体`,
            suggestion: '改为「贵刊」「贵校」等敬称',
          }));
        }
      }
    }
  }

  /* --- LANG-003 冗余结构（bad -> good 对照） --- */
  {
    const rule = rules.get('LANG-003');
    for (const item of cfg.lexicon['冗余结构'] || []) {
      const bad = item.bad.replace(/……/g, '');
      if (bad.length < 2) continue;
      for (const u of all) {
        const at = u.text.indexOf(bad);
        if (at < 0) continue;
        issues.push(mkIssue(rule, { ...locOf(u, paras), quote: snippet(u.text, at), offset: at }, {
          message: `冗余表达「${item.bad}」`,
          suggestion: `改为「${item.good}」`,
          autoFix: { find: bad, replace: item.good },
        }));
      }
    }
  }

  /* --- LANG-010 欧化长句 --- */
  {
    const rule = rules.get('LANG-010');

    /**
     * 阈值必须有语料依据。
     *
     * 原默认 100 字：实测在 120 篇稿件 28 409 个句子上，**超过 100 字的有 2 450 句
     * （8.6%），约每篇 20 句** —— 中文人文社科学术写作本来就多长句，
     * 100 字远低于该文体的正常上限，于是这条规则在 632 份稿件上产生 6 687 条命中，
     * 占全部问题的 27%，是产出量第一的规则，与编辑批注重合率仅 21%。
     *
     * 实测句子长度分布（第 31 轮改用 semicolon:false，正文段 >10 字，
     * 共 160 234 句）：P50=48 P75=71 P90=98 P95=119 P97=136 P99=174 max=624。
     * 取 150 字（约 P98，每篇约 6 句）作为「确实过长、值得建议拆分」的门槛，
     * 既不放过真正失控的长句，也不把正常学术长句全报出来。
     */
    const LIMIT = options.longSentenceLimit || 150;
    const longSentences = [];
    for (const u of bodyUnits) {
      // 只查**中文为主**的段落。
      //
      // 这条规则针对的是「中文欧化长句」，建议是「改写为中文短句结构」。
      // 语料里有相当一部分英文摘要与英文正文段落（本刊发译文与英文摘要），
      // 拿中文长句阈值去量英文，会报出「句子长度 979 字，建议拆分」这种
      // 既改不了也没意义的条目 —— 英文摘要本来就该是一段完整论述。
      // 模型复核也指出了这一点：「片段截断且为直接引语，150字阈值非刊例规范」。
      // 判据：拉丁字母占比 ≥ 30% 视为西文段落，跳过。
      const letters = (u.text.match(/[A-Za-z]/g) || []).length;
      const total = [...u.text].length || 1;
      if (letters / total >= 0.3) continue;
      /**
       * ⚠️ 必须 `semicolon: false` —— 长句规则量的是**句子**，分号只是句内分句。
       * 实测全语料：按分号切句只量出 1609 句 >150 字；不切分号则有 3054 句，
       * 即**分号切句掩盖了 47% 的长句**。触发「长句失控」的稿件从 228 篇
       * 升到 393 篇，且**没有任何一篇是「只有分号切句才触发」** ——
       * 说明这个改动是严格更灵敏、不会引入新的假触发。
       * 典型被掩盖的例子：
       *   「国家作为经济基础的一部分，主要植根于以下原因：首先……；其次……」
       */
      for (const s of splitSentences(u.text, { semicolon: false })) {
        const n = [...s].length;
        if (n > LIMIT) longSentences.push({ u, s, n });
      }
    }
    // 只报最长的若干条，避免刷屏；其余以统计形式呈现。
    // 上限从 12 降到 6：超长句是「建议」而非硬性错误，逐条列出 12 条会挤占真正该改的问题。
    const MAX_LIST = 6;
    longSentences.sort((a, b) => b.n - a.n);
    /**
     * ⚠️ 「有长句」不等于「长句失控」—— 必须加触发门槛。
     *
     * 原实现只要存在 1 句 >150 字就报，实测在已过审（发排版）稿件上命中 85.7%，
     * 比在审的 73.6% 还高 —— 方向反了：每篇都有一两句长句是中文人文社科学术
     * 写作的常态，只报 1 句等于把绝大多数已刊发定稿都判为有问题。
     *
     * 第 31 轮：分句改用 `semicolon:false`（分号不再切句）后，用
     * `tools/_gate-calib.mjs` 在同一套语料上**扫描门槛组合**（LIMIT × EXCESS ×
     * EXTREME），按「Δ痕迹 > 0 且 Δ分层 > 0」筛选（Δ痕迹 = 有编辑痕迹 vs 无痕迹
     * 的命中率差，n=448/184，样本大最稳；Δ分层 = 在审 vs 已过审，仅 14 篇，噪声大）：
     *
     *   | 门槛（≥N 句 >150 或 任一句 >250） | Δ痕迹 | Δ分层 | 已过审/在审 |
     *   |---|---:|---:|---|
     *   | ≥3 句（旧值） | +11.8 | **-9.5** ❌ | 71.4% / 62.0% |
     *   | **≥6 句（采用）** | **+13.8** | **+6.8** ✅ | 35.7% / 42.6% |
     *
     * 取 ≥6 句使两个方向判据都为正；任一句 >250 字直接触发（极端长句仍无条件报出）。
     */
    const EXCESS_MIN = 6;
    const EXTREME_LEN = 250;
    const overLimit = longSentences.length;
    const isExcessive = overLimit >= EXCESS_MIN || (longSentences[0] && longSentences[0].n > EXTREME_LEN);
    /** 严重度按长度分档，分档点来自**语料里编辑真实的拆句动作**。
     *
     * 原先一律 `低`，但这是「一刀切」：150 字和 400 字都标「低」，
     * 审稿人看不出哪句真的该动手。用 `tools/long-sentence-calibration.mjs`
     * 从 27 190 条修订对里挑出**编辑真的把长句拆开**的修订，量被拆句子的长度。
     *
     * ⚠️ 第 31 轮：分句逻辑改用 `semicolon:false`（分号不再切句）后重跑标定，
     * 样本从 391 处增到 **516 处**，分布整体右移：
     *   min=151 P25=163 **P50=186** P75=211 P90=275 max=517。
     * 于是分档点随之更新：
     *   · 151—185 字（低于 P50）→ 低：编辑多数时候不管，只作提示
     *   · 186—210 字（P50—P75）→ 中：编辑开始动手拆的区间
     *   · ≥211 字（高于 P75）  → 高：编辑明确会拆，且往往牵动整段改写
     * 分档点是**语料测出来的**，不是拍的。
     */
    const sevFor = (n) => (n >= 211 ? '高' : n >= 186 ? '中' : '低');
    if (isExcessive) {
      for (const { u, s, n } of longSentences.slice(0, MAX_LIST)) {
        issues.push(mkIssue(rule, { ...locOf(u, paras), quote: s.slice(0, 70) }, {
          severity: sevFor(n),
          message: `句子长度 ${n} 字，超过 ${LIMIT} 字，建议拆分`,
          suggestion: '拆分为两个以上短句，或删去嵌套修饰成分',
        }));
      }
    }
    /**
     * 未达触发门槛时**不再报问题，只出统计**。
     * 这样「偶尔一两句长句」的正常稿件不会被判为有问题，但审稿人仍看得到数据。
     */
    if (longSentences.length > MAX_LIST) {
      info.push({ id: 'LANG-010', label: '超长句', value: `另有 ${longSentences.length - MAX_LIST} 处超过 ${LIMIT} 字的句子未逐条列出` });
    } else if (!isExcessive && longSentences.length) {
      info.push({ id: 'LANG-010', label: '超长句', value: `${longSentences.length} 句超过 ${LIMIT} 字（未达失控门槛 ${EXCESS_MIN} 句，仅作提示）` });
    }
    for (const pat of rule.detect.patterns || []) {
      let re;
      try { re = new RegExp(pat, 'g'); } catch { continue; }
      for (const u of all) {
        let m;
        while ((m = re.exec(u.text))) {
          issues.push(mkIssue(rule, { ...locOf(u, paras), quote: snippet(u.text, m.index), offset: m.index }, {
            message: `疑似欧化句式/翻译腔：「${m[0].slice(0, 30)}」`,
            suggestion: '改写为中文短句结构',
          }));
        }
      }
    }
  }
  /* --- LANG-012 层次标识配套 --- */
  {
    const rule = rules.get('LANG-012');
    /** 只统计处于句首（前为句读或段首）的层次标识词 */
    // 「第一」既可以是层次标识（「第一，……」「第一点」），也可以是序数词
    // （「第一次」「第一产业」「第一个例子」）。只有前者才是层次标识，
    // 必须要求其后紧跟顿号/逗号/「点」「方面」「条」等，否则会大量误报。
    const ENUM_FOLLOW = /^[\s、，,：:是]|^(点|方面|条|项|个层次|层)/;
    const isEnumeration = (rest) => ENUM_FOLLOW.test(rest);
    const countLeading = (word) => {
      let n = 0;
      for (const u of bodyUnits) {
        for (const s of splitSentences(u.text)) {
          const t = s.trim();
          if (t.startsWith(word) && isEnumeration(t.slice(word.length))) n += 1;
        }
      }
      return n;
    };
    /** 定位句首标识词所在段落，便于编辑跳转 */
    const leadingLocations = (word) => {
      const out = [];
      for (const u of bodyUnits) {
        for (const s of splitSentences(u.text)) {
          const t = s.trim();
          if (t.startsWith(word) && isEnumeration(t.slice(word.length))) out.push({ u, quote: t.slice(0, 70) });
        }
      }
      return out;
    };
    // 「第一/第二」这类序数标识必须成对计数才有意义；
    // 「首先/其次」是真正的层次标识词，但也不应与序数混用比较。
    const pairs = [['首先', '其次'], ['其一', '其二'], ['一是', '二是']];
    for (const [a, b] of pairs) {
      const ca = countLeading(a);
      const cb = countLeading(b);
      if (ca === 0) continue;
      if (cb === 0) {
        // 每个孤立的句首标识词单独定位，避免只报一条无法跳转的 document 级问题
        for (const loc of leadingLocations(a).slice(0, 8)) {
          issues.push(mkIssue(rule, { ...locOf(loc.u, paras), quote: loc.quote }, {
            message: `句首使用「${a}」但全文未见句首「${b}」，层次标识不配套`,
            suggestion: `补齐「${b}」，或删除无配套的「${a}」`,
          }));
        }
      } else if (ca !== cb) {
        const loc = leadingLocations(a)[0];
        issues.push(mkIssue(rule, { ...locOf(loc.u, paras), quote: loc.quote }, {
          message: `句首「${a}」出现 ${ca} 次，「${b}」出现 ${cb} 次，层次标识数量不匹配`,
          suggestion: '核对并列层次是否完整',
        }));
      }
    }
  }

  /* --- LANG-007 概念混用：第 28 轮已删除实现（判据不成立） --- */
  /**
   * 原实现：读 `cfg.lexicon['术语统一组']`，若同一组里有 >1 个概念在全文出现即报「易混概念同时出现」。
   *
   * ⚠️ 第 28 轮**删除**，理由是**分层方向反了** —— 这是最硬的判据：
   * 若一条规则真能识别缺陷，已过审（发排版）稿件上的命中率必须**低于**在审稿件。
   * 实测：
   *
   *   | | 在审 618 篇 | 已过审 14 篇 |
   *   |---|---:|---:|
   *   | LANG-007 命中率 | 26.4% | **42.9%** |
   *
   * 已过审层**更高** —— 说明它命中的是**正常学术写作**，不是缺陷。
   *
   * 根因：词表把**不同的概念**当成同义/易混词并列。实例（均为已排版刊发的定稿）：
   *   · 「民族国家(30) 文明国家(7) 文明型国家(141)」—— 一篇**研究「文明型国家」**的论文
   *     必然要拿「民族国家」作对比项，三个词是三个不同的概念，共现是论述需要；
   *   · 「全球南方(21) 发展中国家(1) 第三世界(1)」—— 主用「全球南方」，
   *     另两词各出现 1 次属偶发引述，不是「混用」。
   * 全语料 194 处里，次高频概念只出现 1 次的有 62 处（32.0%）；
   * 按「次高/最高 ≥ 0.3」过滤也只去掉 56.7% —— **频率阈值无法把两类分开**。
   *
   * 还试过并**一并否掉**的三个替代判据（都实测过）：
   *   · 显式异译标记（又译/简称/或称）—— 168 处含已过审层，是作者**合法**用法；
   *   · 全称与简称都「substantively」使用（各 ≥3 次）—— 已过审层 21.4% vs 在审 16.8%，
   *     仍是已过审层更高；中文论文本来就惯用「首次全称、其后简称」；
   *   · 子串归并 —— 同样 93 处 / 56 篇，噪声不变。
   *
   * **结论：自动化不可靠，改为人工复核要点。** 但这条规则**不是无据的** ——
   * 编辑批注确实反复要求术语统一（原文）：
   *   · 「有两种译名，按第一次出现时的表述统一。」
   *   · 「专有名词表述请统一，上文表述为「关键的历史节点」。」
   *   · 「专有名词表述请统一，上文使用的是「被教化者」。」
   *   · 「按前文表述统一，请吴老师把关。」
   *   · 「您在第二个部分将这一概念表述为「党」，是否需要统一？请您酌。」
   * 所以规则条目保留（`detect.type` 由 `list` 改为 `manual`），只是不再自动报出。
   * 依据既有纪律：**一条误报率高的检测器比没有更糟**；判据不成立时删除并记录证据，
   * 而不是留着刷命中数。
   */

  /* --- LANG-015 术语不统一：机构名多种写法 --- */
  {
    const rule = rules.get('LANG-015');
    /**
     * ⚠️ 第 28 轮**删除了这里的「同一外文名对应多种译名」检查**。
     *
     * 原判据 `/([\u4e00-\u9fa5·]{2,12})[（(]([A-Za-z][A-Za-z.\- ]{2,40})[）)]/g`
     * 想抓「中文译名（English）」里的中文，但 `{2,12}` 是**贪婪**的，
     * 会把译名**前面**的虚词、动词、甚至上一个小句一起吞进来。实测捕获结果：
     *
     *   | 原文片段 | 错误捕获 | 应为 |
     *   |---|---|---|
     *   | 「和以大穆夫提（Grand Mufti）」 | `和以大穆夫提` | 大穆夫提 |
     *   | 「为首的欧莱玛（Ulama）」 | `为首的欧莱玛` | 欧莱玛 |
     *   | 「据卡尔·布罗克尔曼（Carl Brockelmann）」 | `据卡尔·布罗克尔曼` | 卡尔·布罗克尔曼 |
     *   | 「笔者根据美国联邦调查局（FBI）」 | `笔者根据美国联邦调查局` | 美国联邦调查局 |
     *
     * 于是**同一个译名**因为前后文不同被算成「多种译名」：
     * `美国联邦调查局、笔者根据美国联邦调查局 → fbi`（133 处此类）。
     * 剥离前导虚词只从 98 降到 97，说明噪声**不只在词首**，无法靠词表修好。
     * 且该部分在已过审层有 2 处命中 —— 全部来自这个坏检查。
     *
     * 判定「中文里译名的边界在哪」需要分词/句法，正则做不到。
     * 与 LANG-007 同样处理：规则条目保留，改为人工复核要点。
     */
    // 机构名多种写法。
    // 注意：「中国」「中央」这类简称在中文里是正常用法（「中国政府」「中央文献出版社」），
    // 只有当简称确实指代该机构时才提示，否则会在几乎所有稿件上误报。
    // 判定方法：简称必须作为独立词出现（后面不是继续构成别的专名）。
    const orgPatterns = [
      { canonical: '工业和信息化部', variants: ['工信部'], re: /工信部/ },
      { canonical: '国家发展和改革委员会', variants: ['发改委'], re: /发改委/ },
      { canonical: '国家统计局', variants: [], re: null },
      { canonical: '中共中央', variants: ['党中央'], re: /党中央/ },
      { canonical: '中华人民共和国', variants: [], re: null },
    ];
    for (const org of orgPatterns) {
      if (!org.re || !fullText.includes(org.canonical)) continue;
      const found = org.variants.filter((v) => org.re.test(fullText));
      if (!found.length) continue;
      issues.push(mkIssue(rule, { location: 'document', quote: `${org.canonical} / ${found.join('、')}` }, {
        message: `机构名存在多种写法：${org.canonical} 与 ${found.join('、')}`,
        suggestion: '首次出现用全称，其后统一使用同一简称（须为官方认可简称）',
      }));
    }
  }

  /* --- LANG-016 政治表述 --- */
  {
    const rule = rules.get('LANG-016');
    const lexiconItems = cfg.lexicon['政治表述规范'] || [];
    // detect.patterns 与 lexicon 有重叠词条（如「中华民国」「落后国家」），
    // 同一位置会被两个循环各报一次，产生重复条目。这里按「段落+偏移」去重。
    const already = new Set(issues.filter((x) => x.ruleId === 'LANG-016')
      .map((x) => `${x.paragraphIndex ?? ''}|${x.footnoteIndex ?? ''}|${x.offset}`));
    for (const item of lexiconItems) {
      for (const u of all) {
        let from = 0;
        let hits = 0;
        while (hits < 5) {
          const at = u.text.indexOf(item.bad, from);
          if (at < 0) break;
          from = at + item.bad.length;
          if (isDistancedPoliticalUse(u.text, at, item.bad)) continue;
          const key = `${u.kind === 'paragraph' ? u.pi : ''}|${u.kind === 'footnote' ? u.fi : ''}|${at}`;
          if (already.has(key)) continue;
          already.add(key);
          hits += 1;
          // 「一带一路倡议」中的「战略」不误报
          issues.push(mkIssue(rule, { ...locOf(u, paras), quote: snippet(u.text, at), offset: at }, {
            message: `政治表述「${item.bad}」须核对官方口径`,
            suggestion: `建议改为「${item.good}」`,
          }));
        }
      }
    }
  }

  /* --- LANG-020 重复论述：第 31 轮**删除机械实现，改交模型** ---
   *
   * ── 原实现 ──
   * 对正文做 24 字 n-gram，跨段落逐字重复即报「段落 X 与段落 Y 存在 24 字以上
   * 重复表述」。
   *
   * ── 删除依据（`tools/lang020-window-sweep.mjs` 全语料标定）──
   * 把窗口 W 从 24 扫到 56，**任何取值下 Δ痕迹都是负的**（-5.0 ~ -10.3）：
   * 「跨段落逐字重复 24+ 字」这个特征在**编辑没动过**的稿件上反而更常见 ——
   * 已过审定稿里标准表述、政策提法、理论原句的复现本就很多，逐字重复
   * 根本不指向编辑认为的「重复论述」。
   *
   * 规则条文说的是「同一论点、同一史料、同一数据不得反复出现」——这是**语义**
   * 问题（换个说法复述同一论点也算），字符串匹配做不到。故与
   * LANG-002/004/005/011/018/023 同一处置：改交模型判断。
   * 规则库 `detect.type` 已由 `list` 改为 `model`（含 method 与定性理由）。
   */

  /* --- LANG-021 数据表述：单位缺失 --- */
  {
    const rule = rules.get('LANG-021');
    const numRe = /[0-9]+(?:\.[0-9]+)?/g;
    for (const u of bodyUnits) {
      const sents = splitSentences(u.text);
      for (const s of sents) {
        const nums = s.match(numRe) || [];
        if (!nums.length) continue;
        /**
         * 纯西文句（英文摘要、外文参考文献行）不是「中文数据表述」。
         * 实测这类句子（如「 1 (2021), pp.」「retrieved January 30, 2024」）
         * 被大量误报，按「西文字母多于汉字」整句跳过。
         */
        const cnN = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
        const laN = (s.match(/[A-Za-z]/g) || []).length;
        if (laN > cnN) continue;
        // 世纪与年代表述（19世纪末、20世纪初、1990年代）不是统计数据
        /**
         * 编号/引用类数字**不是统计数据**，必须在计数前剔除，否则会把
         * 「图2」「表1」「假设3」「第4章」「附录5」乃至编号「W41」当成数据，
         * 与真正需要核对的统计数字混为一谈（全语料实测这类占误报相当比例）。
         * 页码/年份区间（50-64、1980—1950）同理由 CIT-008 / FMTB-026 负责，此处不再计为「无单位数据」。
         */
        const stripped = s.replace(/[0-9]{2}\s*世纪(末|初|中叶|中后期)?/g, '')
          .replace(/[0-9]{4}\s*年代/g, '')
          .replace(/[0-9]{4}\s*年/g, '')
          .replace(/[0-9]+\s*[-–—~～]\s*[0-9]+/g, '')
          .replace(/(?:图|表|式|注|假设|例|附录|步骤|阶段|第|方|项)\s*[0-9]+/g, '')
          .replace(/\b[A-Za-z]{1,4}[0-9]{1,4}\b/g, '');
        if (!(stripped.match(numRe) || []).length) continue;
        const rest = stripped.match(numRe) || [];
        // 含数字但整句无单位也无「年/月/日/页/期/卷/%/倍」
        // 量词（位/名/户/篇…）本身即交代了计数口径，计入单位信号
        const hasUnit = /(年|月|日|页|期|卷|版|%|％|倍|个|人|位|名|户|篇|部|件|份|座|张|台|辆|架|艘|册|岁|级|类|款|则|宗|起|轮|届|任|家|所|次|项|种|条|组|批|道|门|笔|公里|米|平方|吨|元|亿元|万元|美元|万|亿|千|百|度|小时|分钟|天|周|km|m|kg|GB|MB|TB|分|点)/.test(s);
        if (!hasUnit && rest.length >= 2) {
          // 纯网址/西文著录句不是中文数据表述
          if (/https?:\/\/|www\./.test(s)) continue;
          issues.push(mkIssue(rule, { ...locOf(u, paras), quote: s.slice(0, 70) }, {
            message: '句子含多个数字但未见计量单位或口径说明',
            suggestion: '补齐单位、统计口径与时间范围',
          }));
        }
      }
    }
  }

  /* --- LANG-017 量词误用 --- */
  {
    const rule = rules.get('LANG-017');
    for (const pat of rule.detect.patterns || []) {
      let re;
      try { re = new RegExp(pat, 'g'); } catch { continue; }
      for (const u of all) {
        let m;
        while ((m = re.exec(u.text))) {
          issues.push(mkIssue(rule, { ...locOf(u, paras), quote: snippet(u.text, m.index), offset: m.index }, {
            message: `量词搭配可疑：「${m[0].slice(0, 24)}」`,
            suggestion: '核对量词与名词的搭配',
          }));
        }
      }
    }
  }

  /* --- LANG-018 文白混杂 --- */
  {
    const rule = rules.get('LANG-018');
    for (const pat of rule.detect.patterns || []) {
      let re;
      try { re = new RegExp(pat, 'g'); } catch { continue; }
      for (const u of bodyUnits) {
        let m;
        while ((m = re.exec(u.text))) {
          // 引用原文中的文言是必要的，不报
          if (rule.detect.skipInsideQuotes && isInsideQuotes(u.text, m.index)) continue;
          issues.push(mkIssue(rule, { ...locOf(u, paras), quote: snippet(u.text, m.index), offset: m.index }, {
            message: `文白混杂或生僻古语：「${m[0].slice(0, 20)}」`,
            suggestion: '改用现代汉语书面语，或为生僻古语加注说明',
          }));
        }
      }
    }
  }

  /* --- 统计信息 --- */
  // 句长统计与 LANG-010 同源（semicolon:false），避免「面板说最长 180 字、
  // 长句规则却报出 260 字」这种自相矛盾。
  const sentences = bodyUnits.flatMap((u) => splitSentences(u.text, { semicolon: false })).filter((s) => [...s].length > 10);
  const lens = sentences.map((s) => [...s].length).sort((a, b) => a - b);
  const avg = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0;
  const longRatio = lens.length ? (lens.filter((l) => l > 120).length / lens.length) : 0;
  info.push({ id: 'STAT-SENT', label: '句子', value: `共 ${lens.length} 句，平均 ${avg} 字，最长 ${lens[lens.length - 1] || 0} 字，超 120 字占比 ${(longRatio * 100).toFixed(1)}%` });
  info.push({ id: 'STAT-CHAR', label: '正文字数', value: `${[...fullText.replace(/\s/g, '')].length} 字` });

  return {
    issues,
    info,
    summary: {
      total: issues.length,
      bySeverity: countBy(issues, (i) => i.severity),
      byCategory: countBy(issues, (i) => i.category),
      byRule: countBy(issues, (i) => i.ruleId),
    },
    modelRules: cfg.rules.filter((r) => r.detect?.type === 'model').map((r) => ({ id: r.id, category: r.category, title: r.title, method: r.detect.method, severity: r.severity })),
    stats: { sentences: lens.length, avgLength: avg, longest: lens[lens.length - 1] || 0, longRatio },
  };
}

function countBy(arr, fn) {
  const m = {};
  for (const x of arr) {
    const k = fn(x) || '其他';
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}
