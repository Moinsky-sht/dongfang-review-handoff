/**
 * 引文与注释扫描引擎。
 *
 * 设计原则（重要）：每条规则的 patterns 必须是「违规形态」的正则，
 * 即命中的文本本身就构成问题。绝不能写「正确形态」的正则，
 * 否则会把合规脚注全部报为问题。规则条目中的说明性文字仅供人工参考。
 *
 * 规则来源：《东方学刊》发文形式规范（2023年版）五·注释格式附例
 *          + 2024秋—2026秋 598份一审稿件中「格式-注释著录」类批注 1926 条
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = resolve(__dirname, '..', 'rules', 'citation-rules.json');

export function loadCitationRules() {
  return JSON.parse(readFileSync(RULES_PATH, 'utf8'));
}

function snippet(text, index, len = 90) {
  const start = Math.max(0, index - 20);
  return text.slice(start, Math.min(text.length, index + len));
}

/** Checks retain their trimmed reading view; edits use verified raw UTF-16 coordinates. */
function noteAutoFixes(check, rawText) {
  if (!check.autoFix && !check.autoFixes) return [];
  const trimmed = rawText.trim();
  let fixes;
  try { fixes = check.autoFixes ? check.autoFixes(trimmed) : [check.autoFix(trimmed)]; } catch { return []; }
  const out = [];
  for (const fix of fixes || []) {
    if (!fix || typeof fix.find !== 'string' || !fix.find || !Number.isInteger(fix.offset) || fix.offset < 0
      || trimmed.slice(fix.offset, fix.offset + fix.find.length) !== fix.find) continue;
    const offset = fix.offset + rawText.length - rawText.trimStart().length;
    if (rawText.slice(offset, offset + fix.find.length) === fix.find) out.push({ ...fix, offset });
  }
  return out;
}

/** 判定一条脚注是否为「文献著录」（相对于纯说明性注释） */
function isBibliographic(t) {
  return /《[^》]+》/.test(t) || /[0-9]{4}\s*年/.test(t) || /出版社|学报|日报|期刊|https?:\/\/|www\.|p{1,2}\.\s*[0-9]/.test(t);
}

/**
 * 判定是否含页码。
 *
 * 「引用多页」的写法在语料里非常普遍，原判据只认**单段**页码，
 * 于是这些**已经给了页码**的著录被 CIT-001「缺少具体页码」误报：
 *   · `第47—56、97—108页`   （顿号分隔的多段区间）
 *   · `第304、332页`         （顿号分隔的多个单页）
 *   · `第47—56、97—108、200页`
 * 实测全语料 CIT-001 的 591 条命中里，51 条（8.6%）属于这一类，
 * 是这条规则最大的一处误报来源。
 *
 * 判据：先认单段/区间；再认**顿号分隔的多段**。分隔符集合里
 * **不能**放「和/及/与」—— 放了会把 `第3页……第5页` 这种跨句文本
 * 连起来，反而制造误判。书名号内的年份区间（`1931-1965年的发展主义`）
 * 不含「页」，天然不会命中。
 *
 * 导出供 `tools/selftest.mjs` 做误报回归护栏。
 */
export function hasPage(t) {
  // 单段或区间：第47页 / 第47—56页
  if (/第\s*[0-9〇一二三四五六七八九十百千]+\s*(?:[—\-~～]\s*[0-9〇一二三四五六七八九十百千]+\s*)?页/.test(t)) return true;
  // 多段：第47—56、97—108页 / 第304、332页 / 第47—56、97—108、200页
  // 注意分隔符集合里**不能**放「和/及/与」—— 放了会把
  // `第3页……第5页` 这种跨句文本连起来，反而制造误判。
  if (/第\s*[0-9〇一二三四五六七八九十百千]+(?:\s*[—\-~～]\s*[0-9〇一二三四五六七八九十百千]+)?(?:\s*[、，,]\s*[0-9〇一二三四五六七八九十百千]+(?:\s*[—\-~～]\s*[0-9〇一二三四五六七八九十百千]+)?)*\s*页/.test(t)) return true;
  if (/\bp{1,2}\.\s*[0-9]/.test(t)) return true;
  if (/第\s*[0-9]+\s*版/.test(t)) return true;
  return false;
}

/** 是否为网络来源 */
function isWeb(t) {
  return /https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/i.test(t);
}

/** 是否为中文期刊论文著录（作者：《篇名》，《刊名》××××年第×期） */
function isChineseJournalArticle(t) {
  if (/[0-9]{4}\s*年\s*第\s*[0-9]+\s*期/.test(t)) return true;
  if (/《[^》]+》\s*[，,]?\s*《[^》]+》\s*[，,]?\s*[0-9]{4}\s*年/.test(t)) return true;
  // 末段书名号后紧跟「××××年×月」或「××××年秋季刊/春季刊」等刊期表述
  if (/《[^》]+》\s*[，,]?\s*[0-9]{4}\s*年\s*[0-9]{0,2}\s*(月|秋季刊|春季刊|夏季刊|冬季刊|秋季号|春季号|卷|辑)/.test(t)) return true;
  return false;
}

/** 是否为纯西文（外文）文献著录 */
function isWesternOnly(t) {
  const cn = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  const total = t.replace(/[\s　]/g, '').length || 1;
  return cn / total < 0.15;
}

/** 是否为档案、未刊文献、内部资料（其著录体例不同于正式出版物，不适用出版社要求） */
function isArchiveSource(t) {
  return /档案号|档案(馆|局)?藏|外档|馆藏|未刊|内部资料|内部发行|手稿|油印|影印本|缩微|全宗|案卷|编号[:：]\s*\d/.test(t);
}

/**
 * 是否为报纸、通讯社、网络来源。
 *
 * 这类来源**本来就没有页码**（报纸按日期定位，网页按 URL 定位），
 * 因此「缺页码」类规则必须把它们排除，否则会把合规著录报成问题。
 * 实测 CIT-001 / CIT-012 里大量命中都是这一类。
 */
function isNewsOrWebSource(t) {
  if (/日报|晚报|周报|时报|商报|参考消息|新华社|通讯社|电讯|澎湃|界面|观察者网|环球网|新华网|人民网/.test(t)) return true;
  if (/https?:\/\/|www\.|\.com|\.org|\.cn\b|\.gov|\.net|retrieved|Retrieved|accessed|最后访问|引用日期/.test(t)) return true;
  // 报纸形态：报名 + 年月日（无卷期、无页码）
  if (/《[^》]{2,12}报》\s*[，,]?\s*[0-9]{4}\s*年\s*[0-9]{1,2}\s*月\s*[0-9]{1,2}\s*日/.test(t)) return true;
  if (/[0-9]{4}\s*年\s*[0-9]{1,2}\s*月\s*[0-9]{1,2}\s*日\s*[，,]?\s*第\s*[0-9]+\s*版/.test(t)) return true;
  return false;
}

/** 是否为「同上」「同前注」等规范省写 */
function isIbid(t) {
  return /^(同上|同前注|同前引|前引|ibid|Ibid|op\.\s*cit)/.test(t.trim()) && t.trim().length <= 12;
}

/**
 * 西文著录是否**按卷次/期号/档案号定位**（因而本来就不需要 p./pp. 页码）。
 *
 * 第 31 轮新增，供 CIT-012 使用。两类：
 *   ① 期刊论文：`… Science Advances, 2023, Vol. 9, No. 34.`
 *      —— 用「卷 + 期」定位，页码非必需（实测 CIT-012 命中里 23.1% 是这类）；
 *   ② 档案/政府公文集：`Foreign Relations of the United States, 1964–1968,
 *      Vol. XXVIII`、`Central Intelligence Agency, “Situation Appraisal…”`
 *      —— 史学与国关论文的标准著录方式，按卷次与文件号定位。
 *
 * 罗马数字卷次（`Vol. XXVIII`、`Vol.VI`）必须支持 —— 实测 `Vol.VI` 无空格，
 * 早期写法 `Vol\.\s*[0-9]` 会漏掉它。
 */
function isVolumeOrArchiveLocated(t) {
  // 卷次/期号：Vol. IX / Vol.VI / No. 34 / 第 3 卷 / 第 3 期 / 2023(4)
  if (/\b(Vol|vol|No|no)\.?\s*[IVXLC0-9]/.test(t)) return true;
  if (/第\s*[0-9IVXLC]+\s*[卷期册辑]/.test(t)) return true;
  if (/[0-9]{4}\s*[（(]\s*[0-9]+\s*[）)]/.test(t)) return true;
  // 档案与政府公文集
  if (/\b(Archives?|Declassified|Documents?)\b/i.test(t)) return true;
  if (/Foreign Relations of the United States|Central Intelligence Agency|Department of State|National Photographic|Wilson Center|Digital National Security/i.test(t)) return true;
  if (/档案|馆藏|未刊|全宗|案卷/.test(t)) return true;
  // 会议论文 / 报告 / 书评：按会议名或报告号定位
  if (/paper presented|conference|Working Paper|Press Release|Dissertation|Thesis|\bReview of\b/i.test(t)) return true;
  return false;
}

/** 是否为夹叙夹议的说明性注释（含大段论证文字，非纯文献著录） */
function isNarrativeNote(t) {
  // 去掉书名号与括号内容后仍很长，说明是叙述性文字
  const stripped = t.replace(/《[^》]*》/g, '').replace(/[（(][^）)]*[）)]/g, '');
  const cn = (stripped.match(/[\u4e00-\u9fa5]/g) || []).length;
  return cn > 40;
}

/**
 * 一条脚注里是否并列著录了**多份**文献。
 *
 * 语料里的实测形态（分号并列两本书，页码常只给第一本）：
 *   `参见[德]维尔纳·桑巴特：《战争与资本主义》，晏小宝译，上海人民出版社2023年版；
 *     Charles Tilly, Coercion, Capital, and European States`
 *
 * 对这类脚注，CIT-001 的 `(年版|年|出版社)[，,]?\s*$` 形态会在**分号处**误命中 ——
 * 它只看「这段文本是否以年份结尾」，而整条脚注是以第二本书结尾的，
 * 分号只是内部边界。实测全语料剩 7 条这一类误报（修好多段页码后仅存的）。
 *
 * 判据：按分号切段后，**至少两段**各自像一条文献著录。
 * 这样既拦住并列著录，又不会把普通脚注里出现的分号误伤。
 *
 * 导出供 `tools/selftest.mjs` 做误报回归护栏。
 */
export function isMultiWorkNote(t) {
  const parts = t.split(/[；;]/).map((s) => s.trim()).filter((s) => s.length >= 8);
  if (parts.length < 2) return false;
  // 西文文献常被截断（书名后没有年份），`isBibliographic` 认不出，
  // 所以再补一条西文著录判据：含拉丁字母 + 大写词 + 逗号，且汉字很少。
  const looksBibliographic = (p) => {
    if (isBibliographic(p)) return true;
    const latin = (p.match(/[A-Za-z]/g) || []).length;
    const han = (p.match(/[\u4e00-\u9fa5]/g) || []).length;
    return latin >= 8 && han <= 6 && /,/.test(p);
  };
  return parts.filter(looksBibliographic).length >= 2;
}

/** 出版信息是否已出现 */
function hasPublisher(t) {
  if (/出版社|出版中心|出版集团|出版公司|书局|书社|书店|三联|商务印书馆|大学出版|文献出版社|人民出版社|中央文献|研究中心|研究院|研究所|学会|编委会|杂志社|报社|文史馆|古籍社/.test(t)) return true;
  // 港台及海外中文出版机构，命名不带「出版社」
  if (/(允晨文化|时报出版|联经|远流|麦田|脸谱|八旗|左岸|木马文化|印刻|群学|牛津大学出版社|中文大学出版社|香港中文大学|台湾大学出版|商务印书馆（香港）)/.test(t)) return true;
  // 西文与机构出版者：Pew Research Center、Census Bureau、Oxford University Press 等
  if (/(University Press|Press,|Press$|Publishing|Publishers|Research Center|Research Institute|Bureau|Institute|Foundation|Books|Routledge|Palgrave|Springer|Wiley|Sage|Oxford|Cambridge, Mass)/i.test(t)) return true;
  // 网址本身就是网络来源的「出版者」，其著录要素由 CIT-005/006/007 负责
  if (/https?:\/\//.test(t)) return true;
  return false;
}

/** 是否指向报刊文章、期刊论文、法律法规等本就不需要出版社的文献类型 */
function isNonBookSource(t) {
  // 报刊与期刊。注意实测稿件的年份期号写法带空格（「2008 年第 4 期」），必须容忍空格
  if (/(日报|晚报|时报|周报|月报|读书报|文汇报|学报|学刊|杂志|期刊|文学社|第\s*[0-9]+\s*期|第\s*[0-9]+\s*辑|载《[^》]*(报|刊|杂志)[^》]*》)/.test(t)) return true;
  // 报纸日期写法：2020年2月5日 / 2020年02月05日 / 2019年4月
  if (/[0-9]{4}\s*年\s*[0-9]{1,2}\s*月(\s*[0-9]{1,2}\s*日)?/.test(t)) return true;
  // 法律法规、法案、条约、标准
  if (/(法案|法条|第[0-9一二三四五六七八九十]+条|公约|条约|协定|议定书|司法解释|国家标准|GB\/T|CY\/T|修正案)/.test(t)) return true;
  // 政府与国际组织报告
  if (/(国家统计局|人民政府|国务院|白皮书|统计年鉴|年度报告|World Bank|IMF|OECD|United Nations)/i.test(t)) return true;
  // 学位论文（著录体例为「学校＋专业＋学位论文＋年份」，不需要出版社）
  if (/(学位论文|博士学位论文|硕士学位论文|博士论文|硕士论文|毕业论文)/.test(t)) return true;
  return false;
}

/** 判断第二个书名号内是否为期刊名（形如「《新闻与传播研究》2008年第4期」） */
function looksLikeJournalTitle(title) {
  if (!title) return false;
  if (/(研究|学报|学刊|评论|论坛|月刊|周刊|季刊|杂志|导报|日报|晚报|时报|周报|文摘|科学|社会科学|大学学报)/.test(title)) return true;
  return false;
}

/** 是否为境外（非中国大陆）出版的中文文献：其出版机构命名多样，不宜套用「须有出版社」的检查 */
function isOverseasChinese(t) {
  return /(新加坡|香港|台湾|台北|澳门|马来西亚|吉隆坡|纽约|伦敦|东京|首尔|巴黎|策略资讯|华社|中文大学出版社|牛津大学出版社|香港中文大学|台湾大学|联经|允晨|时报出版|远流|麦田|Media Masters)/.test(t)
    || /[（(](新加坡|香港|台湾|台北|澳门|马来西亚|美国|英国|日本|法国|德国)[）)]/.test(t);
}

/** 党和国家领导人（仅限现当代政治文献，避免把历史人物的一切引证都当成领导人讲话） */
function isLeaderRelated(t) {
  return /(习近平|胡锦涛|江泽民|邓小平|毛泽东)/.test(t);
}

/** 是否为马克思主义经典著作或党和国家领导人文献 */
function isCanonical(t) {
  return /(毛泽东选集|毛泽东文集|毛泽东年谱|列宁选集|列宁全集|马克思恩格斯选集|马克思恩格斯全集|邓小平文选|江泽民文选|胡锦涛文选|习近平谈治国理政|斯大林选集|建国以来重要文献选编|中共中央文件选集)/.test(t);
}

/**
 * 是否标明了**页码**（含区间）。
 *
 * ⚠️ 这里踩过一个坑，而且是**原有实现就有的坑**：
 * 旧写法是 `/第\s*[0-9]+\s*页/`，它**匹配不了页码区间**——
 *   「第101-106页」「第113—114页」「第325—326页」全部不匹配，
 * 只有「第188页」这种单页才匹配。
 *
 * 后果：`CIT-003` 的判据是「卷次与页码不同时具备就报」，
 * 于是**页码写成区间的经典著作脚注全部被误报**成「未标明页码」——
 * 而区间恰恰是本刊规范要求的写法（`CIT-001` 就明确要求区间用一字线）。
 * 也就是说：**照着规范写反而被报错**。
 *
 * 区间分隔符必须收全：半角连字符、一字线、波浪线、全角波浪线、短横。
 * 还要支持**多个区间并列**：「第47—56、97—108页」（顿号分隔），
 * 实测漏了这一形态会把带版本、页码完整的脚注误报成「缺页码」。
 */
function hasPageRef(t) {
  return /(?:第\s*)?[0-9]+\s*(?:[-—–~～至]\s*[0-9]+\s*)?(?:\s*[、,，]\s*[0-9]+\s*(?:[-—–~～至]\s*[0-9]+\s*)?)*页/.test(t);
}

/** 是否标明了**卷次**（阿拉伯/中文数字卷、上中下卷，或分册「第4册」） */
function hasVolume(t) {
  return /第\s*[0-9一二三四五六七八九十]+\s*[卷册]|[上中下]\s*卷/.test(t);
}

/**
 * 是否标明了**版本**。
 *
 * 判据来自实测标定：语料里合规写法的形态是
 *   「人民出版社1991年版」「中央文献出版社2013年」「第2版」
 * 所以三种都认：`××××年版` / 单独的 `××××年` / `第N版`。
 *
 * 注意不能只认「××××年版」：实测《列宁全集》第55卷，人民出版社2017年，
 * 第183页 —— 有出版社+年份但没写「版」字，这是合规的，
 * 只认「年版」会把它误报。
 */
function hasEdition(t) {
  return /[0-9]{4}\s*年(\s*版)?|第\s*[0-9一二三四五六七八九十]+\s*版/.test(t);
}

/** 从一条经典著作脚注里抽出著作名（用于「同一著作」的跨脚注比对） */
function canonicalWorkOf(t) {
  const m = /(毛泽东选集|毛泽东文集|毛泽东年谱|列宁选集|列宁全集|马克思恩格斯选集|马克思恩格斯全集|邓小平文选|江泽民文选|胡锦涛文选|习近平谈治国理政|斯大林选集|建国以来重要文献选编|中共中央文件选集)/.exec(t);
  return m ? m[1] : null;
}

function isLeaderRelatedUnused(t) {
  return false;
}

function isAuthoritativeSource(t) {
  return /(选集|文集|年谱|文稿|文选|人民日报|光明日报|求是|新华社|中央文献出版社|人民出版社|人民政府网|gov\.cn|讲话|报告|决议|公报|中央文献|党史|文献出版社)/.test(t);
}

/** 该条脚注是否引用了「领导人的讲话/论述」（而非仅仅提到其姓名） */
function isLeaderSpeech(t) {
  // 必须先确属党和国家领导人文献，否则「发言」「文章」等普通词会把
  // 一般文献（如「笔者在知网搜索」这类说明性注释）误判为领导人讲话。
  if (!isLeaderRelated(t)) return false;
  return /(讲话|谈话|报告|指示|批示|论述|文选|选集|文集|年谱|文稿|致辞|贺信|回信)/.test(t);
}

function mkIssue(meta, loc, extra) {
  return {
    ruleId: meta.id,
    category: meta.category || '引文与注释',
    group: 'citation',
    severity: meta.severity || '中',
    title: meta.title,
    basis: meta.source || meta.basis || '《东方学刊》发文形式规范五 + 历史批注归纳',
    detail: extra.message || meta.rule || '',
    fix: meta.fix || meta.action || '',
    ...loc,
    ...extra,
  };
}

/**
 * 违规形态规则表。
 *
 * ⚠️ **这里只放「怎么判」和「判据文本」，不放 id/标题/严重度这类展示元信息。**
 *
 * 原因（实测踩过的坑）：本表原先每条都自带 `id`/`title`/`severity`，
 * 而 `scanCitation` 又用 `RULE_META`（来自 `rules/citation-rules.json`）
 * **覆盖**了它们。两处各写一份、谁也不校验，于是长期漂移：
 * 17 条自动规则里 **8 条**的标题与规则库对不上 ——
 * 例如 `CIT-008` 规则库写「只有标号而无文献信息」，代码实际判的是
 * 「页码区间使用短横线或波浪线」；`CIT-009` 规则库写「只有标号…」，
 * 代码判的是「脚注中出现半角标点」。
 * 后果是「规则管理」页面显示的判据与实际行为不符，审稿人按页面理解规则会理解错。
 *
 * 现在元信息**只在 `rules/citation-rules.json` 一处**，本表只保留
 * `id`（执行用）与 `rule`/`fix`/`message`/`suggestion`/`occurrence`（判据文本）。
 * `tools/rule-metadata-consistency.mjs` 会校验两边 id 集合完全一致。
 */
const CHECKS = [
  {
    id: 'CIT-001',
    rule: '引用文献须析出具体页码；引用多页用「第××—××页」，引用外文用 p./pp.。期刊论文的页码可省略但全文须统一，直接引文必须给出页码。',
    fix: '在出版信息后补「第×页」；区间用一字线「—」。',
    source: '《东方学刊》发文形式规范五·注释格式附例 + 历史批注（页码类 16 处）',
    // 例外必须落实：本规则自己的条文就写着「期刊论文的页码可省略」，
    // 但原 test 没实现这个例外，于是把「《清华大学学报》2020年第3期」这类
    // 期刊论文著录全报成「未见页码」。实测 632 份稿件上命中 3 056 条、
    // 与编辑批注重合率仅 0.4%，是产出量第一的误报源。
    // 另外报纸文章（《人民日报》2020年5月1日）与网络来源本来就没有页码。
    //
    /**
     * 第 24 轮再收窄：补上「泛引」与「引整章」两个例外。
     *
     * 收窄前实测 571 处命中，逐条分类后发现只有 81 处（14.2%）是真缺陷：
     *
     *   · 373 处（65.3%）以「参见／可参见／详见／另见」开头
     *     —— 这是「另见／进一步阅读」式**泛引**，不是直接引文，本刊惯例就是不给页码。
     *     **证据（分层对照）**：以「参见」开头的脚注共 3 082 处，
     *     其中无页码占 **64.7%**；而**已过审（发排版）层同样是 64.8%**
     *     —— 两层比例几乎完全一致，说明「参见类不给页码」是本刊一贯做法，不是作者疏漏。
     *     另有决定性的一条：编辑修订里给「参见」类脚注**补页码 0 处、删页码 28 处**，
     *     方向与「缺页码是缺陷」正好相反。
     *   · 48 处（8.4%）用章号代替页码（「……复旦大学出版社2023年，第十章。」）
     *     —— 引整章时章号即定位信息，同样不是缺陷。
     *   · 67 处（11.7%）是译著／编著整体引用（「……安佳译，上海人民出版社2008年。」）
     *     —— 整体引用无需页码。
     *
     * 收窄后剩 81 处「其他」，形态如
     * 「梁鸿：《梁庄十年·后记》，三联书店2021年版。」—— 确实缺页码，是真缺陷。
     */
    test: (t) => isBibliographic(t) && (hasPublisher(t) || /年版|年第[0-9]+期|载于/.test(t)) && !hasPage(t) && !/等\s*。?$/.test(t)
      && !isIbid(t) && !isArchiveSource(t) && !isNarrativeNote(t) && (t.match(/《[^》]+》/g) || []).length <= 1
      && !isChineseJournalArticle(t) && !isNewsOrWebSource(t) && !isMultiWorkNote(t)
      // 泛引（另见式）：不给页码是本刊惯例，已过审层比例与在审层一致（64.7% vs 64.8%）
      && !/^[\s　]*(可?参见|另参见|详见|另见|见)/.test(t)
      // 引整章：章号即定位信息
      && !/第\s*[0-9一二三四五六七八九十]+\s*[章节]/.test(t),
    message: '该条脚注为文献著录但未见页码，无法核查引文',
    suggestion: '补「第×页」；引用多页用「第××—××页」',
    occurrence: 16,
  },
  {
    id: 'CIT-002',
    rule: '所有引注和说明性内容均须详列来源。不得出现只有标号而无文献信息、或信息残缺到无法核查的注释。',
    fix: '补出完整文献信息（作者、篇名/书名、出处、年份、页码）。',
    source: '《东方学刊》发文形式规范四 + 历史批注（出处缺失类 17 处）',
    test: (t) => t.replace(/[\s　]/g, '').length <= 6 && !/[《》“”0-9]/.test(t) && !isIbid(t),
    message: '该条脚注内容过短，疑为只有标号而缺文献信息',
    suggestion: '补出完整文献信息',
    occurrence: 17,
  },
  {
    id: 'CIT-003',
    rule: '引用马克思主义经典著作须同时标明卷次、版本与页码，如《毛泽东选集》第2卷，人民出版社1991年版，第648页。同一篇文章须使用同一版本。',
    fix: '补全卷次 + 版本 + 页码。',
    source: '《东方学刊》发文形式规范五 + 历史批注（经典著作类 6 处）',
    /**
     * ⚠️ 本条原先的 test 只查「卷次 + 页码」，**漏掉了规则自己要求的「版本」**。
     *
     * 后果不是小漏报：实测 632 篇里有 **1033 条**经典著作脚注，其中
     * 844 条「卷+页」齐全，而这 844 条里 **215 条缺版本**——
     * 旧 test 因为只看卷+页，把这 215 条全部判为合规，**一条都没报**。
     *
     * 为什么能确定「缺版本」是缺陷而不是正常简写：
     * 183 篇含「卷+页齐全」经典著作脚注的稿件里，
     * **139 篇（76%）是 100% 带版本的** —— 「××××年版」是本刊的常态写法。
     * 只有 5 篇是全部不带、39 篇部分带。
     *
     * 为什么这里需要**跨脚注上下文**（所以 test 用 t 之外的第二个参数）：
     * 同一著作在首次出现时写全版本、其后简写，是正常著录惯例。
     * 若只按单条判，会把同一篇里第 2 次及以后的简写全报成违规（假阳性）。
     * 因此 ctx 提供「本文档中该著作此前是否已带版本」的判断。
     */
    test: (t, ctx) => {
      if (!isCanonical(t)) return false;
      /**
       * 判据顺序很重要：**先看版本**。
       *
       * 本规则的规则文本是「须同时标明卷次、版本与页码」，三者里
       * **版本**才是本条真正独有的要求（卷次、页码缺失已被 CIT-001/其它条覆盖）。
       * 因此：版本已在，本条就不该再报 —— 否则会出现
       * 「明明写着『人民出版社1989年版』却被报成缺卷次」这种自相矛盾的结论。
       * 实测正是这样漏出误报的：有的著录用「第4册」不用「第4卷」，
       * 有的页码写「，664页」不带「第」字，形态远比预想的多。
       */
      if (hasEdition(t)) return false;
      // 版本缺失：同一著作此前已带版本的，属正常简写，不报
      if (ctx && ctx.editionSeenFor(t)) return false;
      /**
       * 到这里说明版本确实缺失。再分两种：
       *   · 卷次、页码都齐全 → 只缺版本，正是本条要报的
       *   · 卷次或页码也缺 → 也报（本就著录不全）
       */
      return true;
    },
    message: '引用经典著作未标明版本（卷次、版本、页码须齐全）',
    suggestion: '按体例写全：卷次 + 版本 + 页码，如「人民出版社1991年版」',
    occurrence: 6,
  },
  {
    id: 'CIT-004',
    rule: '党和国家领导人的讲话、论述必须引权威一手文献（选集、文集、年谱、人民日报、求是等），标明卷次页码；用传记、内部文件、二手三手文献转引的必须改换或删除。',
    fix: '改用《毛泽东选集》《习近平谈治国理政》《人民日报》等权威一手文献；找不到就删去。',
    source: '历史批注（领导人讲话类 14 处）',
    test: (t) => isLeaderRelated(t) && isLeaderSpeech(t) && !isAuthoritativeSource(t) && isBibliographic(t) && !isArchiveSource(t),
    message: '涉及党和国家领导人的引证未见权威一手文献',
    suggestion: '改用权威一手文献并标明卷次页码',
    occurrence: 14,
  },
  {
    id: 'CIT-005',
    rule: '网络来源著录须六要素齐全：作者名（或博主名、机构名）、《文章名》（文章发布日期），网站名，网址，最后浏览日期：××××年×月×日。',
    fix: '补「最后浏览日期：××××年×月×日」。',
    source: '《东方学刊》发文形式规范五·5 + 历史批注（网络来源类 9 处）',
    test: (t) => isWeb(t) && !/(最后浏览日期|最后访问日期|浏览日期|访问日期)/.test(t) && !isWesternOnly(t),
    message: '网络来源未标明最后浏览日期／最后访问日期',
    suggestion: '按体例补：……，最后浏览日期：××××年×月×日',
    occurrence: 9,
  },
  {
    id: 'CIT-006',
    rule: '网络文章须在文章名后以括号注明发布日期，如（2021年10月9日）。',
    fix: '在文章名后加括号注明发布日期。',
    source: '《东方学刊》发文形式规范五·5',
    test: (t) => isWeb(t) && !/[（(]\s*[0-9]{4}\s*年/.test(t) && !/[0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日/.test(t) && !isWesternOnly(t),
    message: '网络来源未标明文章发布日期',
    suggestion: '在文章名后加括号注明发布日期',
    occurrence: 9,
  },
  {
    id: 'CIT-007',
    rule: '网络来源须写明网站名（如「中华人民共和国中央人民政府网」），不能只有网址。',
    fix: '补出网站名。',
    source: '《东方学刊》发文形式规范五·5',
    test: (t) => isWeb(t) && !isWesternOnly(t) && !/(网|网站|公众号|日报|时报|智库|大学|中心|研究院|政府|新华社|中新社|观察者|澎湃|界面|财新|新华网|人民网|光明网|求是网|央视)/.test(t),
    message: '网络来源未见网站名',
    suggestion: '补出网站名',
    occurrence: 5,
  },
  {
    id: 'CIT-008',
    rule: '页码、年代区间统一使用一字线「—」，如「第137—148页」「1949—1955年」。',
    fix: '改用一字线「—」。',
    source: 'GB/T 15835-2011 + 历史批注',
    /**
     * ⚠️ 这条判据原先**大面积误报**，2026 轮次已修，改动必须留住。
     *
     * 原实现：`/第\s*[0-9]+\s*[-~～]\s*[0-9]+\s*页/` **或** `/[0-9]{4}\s*[-~～]\s*[0-9]{4}/`。
     * 后一个「裸四位年份区间」分支把三类**完全正常**的写法判成违规：
     *   ① 英文文献的年份区间 —— `“U.S. Population Projections: 2005-2050”`。
     *      西文文献按自身惯例用半角连字符，本刊规范也只要求西文著作/篇名用斜体与双引号，
     *      并没有要求西文用一字线；
     *   ② 中文书名内部的年份 —— `《毛泽东年谱（1949-1976）》`、`《经济意识形态与日本产业政策 : 1931-1965年的发展主义》`。
     *      书名里的年份区间不是「页码/年代区间」的著录格式，一字线规则管不到；
     *   ③ 网址里的日期路径 —— `http://www.chinawriter.com.cn/n1/2022/0927/...`。
     *      模型复核 3/3 条都把这类判为误报：「网址无页码区间，规则不适用」。
     *
     * 实测全语料 1230 命中中，**525 条（42.7%）属于上述三类误报**。
     *
     * 现在只判**中文语境下的页码区间**：必须同时满足
     *   · 出现「第 N - N 页」结构（真正的页码著录）
     *   · 文本含汉字（排除纯西文条目）
     *   · 不含网址特征（排除网址日期路径）
     * 幸存 705 条，抽样全部是真的「第84-85页」类短横线页码 ——
     * 本刊规范附例明确写作「第51—53 页」「第415—416 页」，用一字线。
     *
     * 教训：**年份区间 ≠ 页码区间**。规则库里写的「页码、年代区间」是两件事，
     * 而裸四位数字对在真实文本里几乎全是年份，不是页码。
     */
    test: (t) => !isWeb(t) && /[\u4e00-\u9fa5]/.test(t)
      && /第\s*[0-9]+\s*[-~～]\s*[0-9]+\s*页/.test(t),
    /**
     * 机械改写：把页码区间里的短横线/波浪线换成一字线「—」。
     * 这是纯字符替换、无歧义，故给出 autoFix 供「一键修改」直接落地。
     */
    autoFix: (t) => {
      const m = /第\s*[0-9]+\s*[-~～]\s*[0-9]+\s*页/.exec(t);
      if (!m) return null;
      const find = m[0];
      const replace = find.replace(/[-~～]/, '—');
      if (find === replace) return null;
      return { find, replace, offset: m.index };
    },
    autoFixes: (t) => [...t.matchAll(/第\s*[0-9]+\s*[-~～]\s*[0-9]+\s*页/g)]
      .map(m => ({ find: m[0], replace: m[0].replace(/[-~～]/, '—'), offset: m.index })),
    message: '页码区间使用了短横线或波浪线',
    suggestion: '改用一字线「—」，如「第137—148页」',
    occurrence: 12,
  },
  {
    id: 'CIT-009',
    rule: '中文脚注中不得使用半角逗号、句号、冒号、分号；网址与西文书名内部的标点不受此限。',
    fix: '改为全角标点。',
    source: 'GB/T 15834-2011',
    test: (t) => /[\u4e00-\u9fa5][,;:]/.test(t) && !isWeb(t),
    message: '脚注中文部分出现半角标点',
    suggestion: '改为全角标点',
    occurrence: 8,
  },
  {
    id: 'CIT-010',
    rule: '中文著作须写明出版社与出版年（如「科学出版社2008年版」）；外文著作须写明出版地与出版社。',
    fix: '补齐出版社与出版年。',
    source: '《东方学刊》发文形式规范五·1',
    test: (t) => /《[^》]+》/.test(t) && /[0-9]{4}\s*年/.test(t) && !hasPublisher(t)
      && !isChineseJournalArticle(t) && !isWesternOnly(t) && !isArchiveSource(t) && !isNarrativeNote(t) && !isOverseasChinese(t)
      && !/日报|学报|期刊|https?:|网/.test(t),
    message: '疑似缺少出版社',
    suggestion: '补出出版社名称',
    occurrence: 6,
  },
  {
    id: 'CIT-011',
    rule: '中文著作出版信息写作「××××出版社××××年版」，不加逗号分隔。',
    fix: '改为「××××出版社××××年版」。',
    source: '《东方学刊》发文形式规范五·1',
    // 只判「出版社与年份之间夹了逗号」这一种真违规。
    //
    // 原实现还有第二个分支 `/出版社\s*[0-9]{4}\s*年(?!版)/`，本意是「缺『版』字」，
    // 但实测把语料里最标准的写法「复旦大学出版社2023年」全部报成违规——
    // 抽样 60 篇的 320 处「出版社+年份」里绝大多数都是这个形态，
    // 于是该规则在 632 份稿件上产生 1 215 条命中、与编辑批注重合率为 0%，
    // 属典型误报机器。删掉该分支，只保留逗号判定。
    test: (t) => /出版社[，,]\s*[0-9]{4}\s*年/.test(t),
    message: '出版信息写法不合体例：出版社与出版年之间不应加逗号',
    suggestion: '改为「出版社××××年版」，去掉逗号',
    occurrence: 8,
  },
  /* --- CIT-012：第 31 轮起不再自动报出（判据不可判），条目保留供人工复核 --- */
  /**
   * 本条原在 CHECKS 数组里，第 31 轮改为 `detect.type = 'manual'` 并删除判据。
   *
   * 删除理由（详见 rules/citation-rules.json 的 CIT-012.detect.note）：
   *   ① 剩余 312 处命中里 119 处（38.1%）是**专著形态**（作者+书名+出版地+出版社+年份），
   *      而整本专著被引用本来就不标页码；
   *   ② 已过审层命中是 `Great Britain Colonial Office, Malayan Union and Singapore:
   *      Statement of Policy…` 这类整份政府出版物，编辑已排版刊发、未要求补页码
   *      （已过审 35.7% vs 在审 21.7%，**方向反了**）；
   *   ③ 编辑修订证据弱：全语料补 p./pp. 仅 **9 处**、删 4 处（对比 FMT-024 的 92:3）。
   *
   * 区分「引整本专著」与「引书中某段」需要理解引用意图，规则做不到。
   * 依据「一条误报率高的检测器比没有更糟」，删实现、留条文。
   *
   * 注意：此处**刻意不写出「id 冒号 + 引号 + 本条规则号」那种字面量**。
   * 因为 implemented-rules.js 的 isImplemented() 是正则抓源码里的规则号，
   * 留着那个字面量会让页面继续声称本条「自动检测」
   * （第 31 轮实际踩过这个坑，已同时给 ruleWillRun 加了
   * detect.type === 'manual' 优先判据作为第二道防线）。
   */
  {
    id: 'CIT-013',
    rule: '内部文件、未公开档案绝大多数读者无法参阅，不宜作为主要引证来源；确有必要的须说明查阅条件。',
    fix: '改引公开出版物，或补充说明查阅条件。',
    source: '历史批注（档案未刊类 5 处）',
    test: (t) => /内部(文件|资料|发行)|未刊|档案(馆)?藏|手稿|油印本/.test(t),
    message: '引用了内部文件或未刊档案',
    suggestion: '核对是否可改为公开出版物，或补充查阅条件说明',
    occurrence: 5,
  },
  {
    id: 'CIT-014',
    rule: '不得以转引代替直接查阅原文献。「转引自」「引自……见……」须核对原文后直接著录原文献。',
    fix: '核对原文，直接著录原始文献。',
    source: '历史批注（转引类 8 处）',
    test: (t) => /转引自|转引至|引自[^，。]{0,10}参见/.test(t),
    message: '使用了转引',
    suggestion: '核对原文后直接著录原始文献',
    occurrence: 8,
  },
  {
    id: 'CIT-015',
    rule: '缩写首次出现须给出中文全称与外文全称，此后才可直接使用缩写。',
    fix: '首次出现改为「中文全称（English Full Name, ABBR）」。',
    source: '《东方学刊》发文形式规范二·1',
    test: (t) => /^[^《]{0,10}[A-Z]{2,6}[，,。]/.test(t) && !/[（(][A-Za-z]/.test(t),
    message: '脚注中出现缩写但未见全称',
    suggestion: '首次出现补全称',
    occurrence: 3,
  },
  {
    id: 'CIT-016',
    rule: '外国人名须用完整规范译名，首次出现以括号备注外文原名；译名须与《辞海》等权威工具书一致，全文统一。',
    fix: '补出完整译名与外文原名。',
    source: '历史批注（外国人名类 12 处）',
    test: (t) => !isWesternOnly(t) && !isNarrativeNote(t) && (/^[A-Z][a-z]+\s[A-Z][a-z]+\s*[，,：:]/.test(t) || /^[\u4e00-\u9fa5]{1,2}[・·][\u4e00-\u9fa5]{1,2}\s*[，,：:]/.test(t)),
    message: '脚注中的外国人名疑为不完整或不规范译名',
    suggestion: '补完整译名，首次出现备注外文原名',
    occurrence: 12,
  },
  {
    id: 'CIT-017',
    rule: '中、日文书籍、期刊、报纸名称与文章篇名一律用书名号《》。',
    fix: '为书名/篇名补书名号。',
    source: '《东方学刊》发文形式规范三·2',
    /**
     * 判据经过一次重写，原因有两个：
     *
     * ① **原判据被 `isNarrativeNote` 全部挡掉**。原式前置了
     *    `!isNarrativeNote(t)`，而 `isNarrativeNote` 的定义是「去书名号与括号后
     *    中文仍多于 40 字」。真正的目标形态
     *    「毛泽东选集，人民出版社1991年版，第47页。」去掉书名号与括号后
     *    正好 40+ 字，于是**恰好被当成叙述性注释排除**。
     *    实测该规则在 632 篇语料上命中 0 条，而合成探针也 0 条 ——
     *    说明不是语料没有，是判据自己把目标挡了。
     *
     * ② **正则会被英文著录误匹配**。原式允许段首出现任意非引号字符，
     *    于是「关于派生性依赖理论，参见Martha Albertson Fineman,
     *    The Autonomy Myth: A Theory of Dependency,」也能命中 ——
     *    因为其中「Autonomy」含「论」字，而 `[^“”]{0,12}` 碰不到后面的拉丁字母。
     *    实测这条英文著录被匹配了 10 次，是本规则**唯一**的"命中"。
     *
     * 修法：要求整条脚注**不含拉丁字母**（纯中文著录），再匹配段首形态。
     * 这样英文文献自然排除，而「毛泽东选集，…」这类真正缺书名号的形态能命中。
     *
     * 修完实测：合成探针 **5/5** 通过，语料命中仍为 **0** ——
     * 说明本语料的中文书名都规范加了《》，这是**真实的语料事实**，
     * 不是判据失效。已按 `auto-未触发` 标注并说明原因。
     */
    test: (t) => !/[A-Za-z]/.test(t) && !/《/.test(t) && !/https?:|www\./.test(t)
      && /^[^“”]{0,12}[\u4e00-\u9fa5]{2,12}(选集|文集|全集|文选|通史|简史|概论|研究|论)\s*[，,。]/.test(t),
    message: '疑似书名未使用书名号',
    suggestion: '补书名号《》',
    occurrence: 4,
  },
  {
    id: 'CIT-031',
    /**
     * ⚠️ 注意：本项**不在脚注上执行**。
     *
     * `CHECKS` 的两个循环（脚注、尾注）都只遍历 `doc.footnotes` / `doc.endnotes`，
     * 而图表的「数据来源／资料来源」是**正文段落**（实测 632 篇里 186 条
     * 全部是独立段落，不在脚注里）。所以本项只登记判据文本，
     * 真正的扫描在下面「CIT-031 图表资料来源只给网站名」那个独立块里。
     *
     * `test` 恒返回 false，是为了让它在脚注循环里不产出任何结果 ——
     * 若留空会因 `chk.test` 未定义而走 catch 分支，行为等价但意图不明显。
     */
    rule: '图、表下的「资料来源」须给出可追溯的完整出处，包括文件名/报告名、发布机构、发布渠道与网址、最后浏览日期。不得只给网站或数据库名称。',
    fix: '补出文件名/报告名、发布机构与网址；数据库检索结果须给出所引文献的完整著录信息。',
    source: '《东方学刊》发文形式规范六·图表 + 历史批注（数据来源类 6 处）',
    test: () => false,
    message: '资料来源只给出网站或数据库名称，无文件名/报告名，无法核查',
    suggestion: '补出所引文件或报告的完整名称、发布机构与网址',
    occurrence: 6,
  },
];

export function scanCitation(doc, options = {}) {
  const cfg = loadCitationRules();
  const issues = [];
  const info = [];
  const notes = doc.footnotes.filter((p) => p.text.trim());
  const paras = doc.paragraphs;
  /** 规则库元信息查表：CIT-0xx → 规则条目 */
  const RULE_META = Object.fromEntries((cfg.rules || []).map((r) => [r.id, r]));

  /**
   * 脚注索引映射。
   *
   * `notes` 是**过滤过**的数组（去掉了空脚注），它的下标既不是脚注在
   * `doc.footnotes` 里的下标，也不是读者看到的脚注序号——docx 的 footnotes.xml
   * 里还含 separator / continuationSeparator 条目。
   *
   * 之前直接把过滤后数组的下标当成 footnoteIndex 写出去，导致两个错误：
   *   ① 报告按 `footnoteIndex + 1` 显示「第 N 条脚注」，与 location 里的编号对不上
   *      （实测 16 条全部错位，第一处显示「footnote:0（第 1 条脚注）」）；
   *   ② 网页端用 `doc.footnotes[footnoteIndex]` 反查原文，取到的是**另一条脚注**，
   *      高亮和原文都对不上。
   *
   * 这里建立两个映射：`origOf` 给出真实数组下标（给前端反查用），
   * `fnLabel` 给出「按真实注释计数、从 1 开始」的序号（给人和报告看）。
   */
  const origOf = [];
  {
    let k = 0;
    for (let i = 0; i < doc.footnotes.length; i += 1) {
      if (doc.footnotes[i].text.trim()) { origOf[k] = i; k += 1; }
    }
  }
  const fnLabel = (i) => {
    let n = 0;
    for (let k = 0; k <= i && k < notes.length; k += 1) {
      if (!notes[k].isNoteSeparator) n += 1;
    }
    return `footnote:${n || i + 1}`;
  };
  /** 生成脚注类问题的定位字段：footnoteIndex 用真实数组下标 */
  const fnLoc = (i, quote) => ({
    location: fnLabel(i),
    footnoteIndex: origOf[i] ?? i,
    footnoteNumber: Number(fnLabel(i).slice(9)),
    quote,
  });

  /**
   * 同一篇稿件里同一条规则的重复命中，超过阈值就归并成一条。
   *
   * 动机：CIT-011（出版社与出版年之间夹逗号）实测在 99 份稿件上产生 967 条命中，
   * 平均每篇 9.8 条，个别稿件同一类问题重复几十次。逐条铺开会把问题清单淹没，
   * 而编辑的处理动作其实只有一次（全文替换）。
   *
   * 信息不丢：归并条目里带 `occurrences`（全部命中位置）与 `occurrenceCount`，
   * 报告与前端都能展开；只是**问题清单默认显示一条**。
   */
  const CONSOLIDATE_AT = 5;
  const citationRanges = [];
  const collectCitationRanges = (spec, target, index, location, quote, node) => {
    for (const fix of noteAutoFixes(spec, node.text)) {
      const source = {
        textView: 'after', offsetUnit: 'utf16', paragraphIndexOwner: 'application-paragraph-index',
        ...(node.id != null ? { pid: node.id } : {}), ...(node.part != null ? { part: node.part } : {}),
        ...(node.noteId != null ? { noteId: String(node.noteId) } : {}),
        ...(node.sourceXmlNodeId != null ? { sourceXmlNodeId: node.sourceXmlNodeId } : {}),
        ...(node.sourceXmlParagraphOrdinal != null ? { sourceXmlParagraphOrdinal: node.sourceXmlParagraphOrdinal } : {}),
        ...(doc.sourcePackageSha256 != null ? { sourcePackageSha256: doc.sourcePackageSha256 } : {}),
        ...(doc.sourceVersionId != null ? { sourceVersionId: doc.sourceVersionId } : {}),
      };
      const autoFix = { ...fix, ...source };
      const geometry = [target, index, source.noteId || null, source.sourceXmlNodeId || null,
        source.sourcePackageSha256 || null, source.sourceVersionId || null, fix.offset, fix.find, fix.replace];
      citationRanges.push({ spec, location, [target + 'Index']: index, quote, autoFix, geometry });
    }
  };
  const pushConsolidated = (chk, hits) => {
    if (!hits.length) return;
    if (hits.length <= CONSOLIDATE_AT) {
      for (const h of hits) {
        issues.push(mkIssue(chk, { location: h.label, footnoteIndex: h.origIndex, quote: h.quote }, {
          message: chk.message,
          suggestion: chk.suggestion,
          autoFix: h.autoFix,
        }));
      }
      return;
    }
    const first = hits[0];
    issues.push(mkIssue(chk, {
      location: first.label,
      footnoteIndex: first.origIndex,
      quote: first.quote,
    }, {
      message: `${chk.message}（全文共 ${hits.length} 处，此处为首处）`,
      suggestion: chk.suggestion,
      autoFix: first.autoFix,
      occurrenceCount: hits.length,
      occurrences: hits.map((h) => ({ location: h.label, footnoteIndex: h.origIndex, quote: h.quote, autoFix: h.autoFix })),
    }));
  };

  /**
   * 跨脚注上下文（`chk.test(t, ctx)` 的第二个参数）。
   *
   * 为什么需要：有些判据**单看一条脚注判不出来**。
   * `CIT-003`（经典著作须标明卷次、版本、页码）就是典型 ——
   * 同一著作首次出现时写全版本、其后简写，是正常著录惯例；
   * 若只按单条判，会把同一篇里第 2 次及以后的简写全报成违规。
   *
   * 所以 ctx 提供「本文档中该著作**此前**是否已带版本」。
   * 注意是**此前**而不是全文：首次出现就缺版本才是真缺陷，
   * 后面的简写是允许的。用「此前」才符合「首次写全」的惯例。
   */
  const makeNoteCtx = (list) => {
    /**
     * 跨脚注上下文（`chk.test(t, ctx)` 的第二个参数）。
     *
     * 为什么需要：有些判据**单看一条脚注判不出来**。
     * `CIT-003`（经典著作须标明卷次、版本、页码）就是典型。
     *
     * 语义经过实测标定 —— 是「**同一著作此前**是否已带版本」，而不是「全文是否有过」：
     * 115 篇含 ≥2 条经典著作脚注的稿件里，76 篇 100% 带版本，39 篇部分带，
     * 而这 39 篇中 **37 篇的版本是从该著作首次出现就写上的**
     * （如「1100111」「1011111」），符合「首次写全、其后简写」的著录惯例。
     * 只有 2 篇是「版本只在后面出现」——那种情况下前面的缺版本是真缺陷。
     *
     * 所以要按**文档顺序逐条**判断。但注意：
     * 每条规则必须拿到**独立的** ctx（`makeNoteCtx` 每次调用都新建一个 `seen`）。
     *
     * ⚠️ 踩过的坑：最初用「一个 ctx 全局共享 + 在循环里登记」，
     * 于是每跑完一条规则 `seen` 就被累加一遍，等轮到 CIT-003 时
     * **全文所有带版本的脚注都已被登记**，`editionSeenFor()` 恒为 true，
     * 「首次缺版本」这种真缺陷一条都报不出来。
     * 后来又改成「独立预扫全文档」，方向反了 —— 变成「全文是否有过」，
     * 于是「首次缺版本、后面补上」也报不出来（实测 2 篇属于此类）。
     *
     * 正确做法：**每条规则一份 ctx，按顺序在 test 之后登记**。
     */
    const seen = new Set();
    return {
      /** 同一著作在**此前**的脚注里是否已带版本 */
      editionSeenFor(t) {
        const w = canonicalWorkOf(t);
        return w ? seen.has(w) : false;
      },
      /** 每条处理完后调用，登记「本条带版本」，供**后续**条目判断 */
      note(t) {
        if (!isCanonical(t) || !hasEdition(t)) return;
        const w = canonicalWorkOf(t);
        if (w) seen.add(w);
      },
    };
  };

  for (const chk of CHECKS) {
    // 元信息（标题/分类/严重度/依据）**只从规则库取**，CHECKS 只提供判据函数。
    // 合并后传给 mkIssue，避免「代码里写一份、规则库里写一份」再次漂移。
    const spec = { ...(RULE_META[chk.id] || {}), ...chk };
    // 每条规则一份独立上下文（见 makeNoteCtx 注释：共享会把 seen 跨规则累加）
    const ctx = makeNoteCtx(notes);
    const hits = [];
    for (let i = 0; i < notes.length; i += 1) {
      const t = notes[i].text.trim();
      if (!t || t.length < 3) continue;
      let hit = false;
      try { hit = chk.test(t, ctx); } catch { hit = false; }
      ctx.note(t); // 按文档顺序登记，只影响**后续**条目
      if (!hit) continue;
      if (chk.id === 'CIT-008') {
        collectCitationRanges(spec, 'footnote', origOf[i] ?? i, fnLabel(i), t.slice(0, 200), notes[i]);
        continue;
      }
      const fx = noteAutoFixes(chk, notes[i].text)[0];
      hits.push({ label: fnLoc(i, t.slice(0, 200)).location, origIndex: origOf[i] ?? i, quote: t.slice(0, 200), autoFix: fx || undefined });
    }
    pushConsolidated(spec, hits);
  }

  /* --- 尾注：与脚注同一套著录检查 ---
     尾注（endnotes.xml）此前完全没有被扫描：解析器读了它，三个扫描器却都不看，
     于是把著录格式改到尾注里的稿件会被整篇漏检。
     实测语料里确有这样一份——01-特稿-张维为【0803尾注版】含 43 条尾注，
     此前 12 条引文著录问题全部漏报。 */
  const endNotes = (doc.endnotes || []).filter((p) => p.text.trim() && !p.isNoteSeparator);
  // 与脚注同理：过滤后的下标不是真实数组下标，也不是读者看到的序号，
  // 必须建立映射，否则前端反查原文会取到另一条尾注。
  const enOrig = [];
  {
    let k = 0;
    for (let i = 0; i < (doc.endnotes || []).length; i += 1) {
      if (doc.endnotes[i].text.trim() && !doc.endnotes[i].isNoteSeparator) { enOrig[k] = i; k += 1; }
    }
  }
  const enLoc = (i, quote) => ({
    location: `endnote:${i + 1}`,
    endnoteIndex: enOrig[i] ?? i,
    endnoteNumber: i + 1,
    quote,
  });
  for (const chk of CHECKS) {
    // 与脚注同理：元信息只从规则库取；每条规则一份独立上下文
    const spec = { ...(RULE_META[chk.id] || {}), ...chk };
    const enCtx = makeNoteCtx(endNotes);
    const hits = [];
    for (let i = 0; i < endNotes.length; i += 1) {
      const t = endNotes[i].text.trim();
      if (!t || t.length < 3) continue;
      let hit = false;
      try { hit = chk.test(t, enCtx); } catch { hit = false; }
      enCtx.note(t);
      if (!hit) continue;
      if (chk.id === 'CIT-008') {
        collectCitationRanges(spec, 'endnote', enOrig[i] ?? i, `endnote:${i + 1}`, t.slice(0, 200), endNotes[i]);
        continue;
      }
      const fx = noteAutoFixes(chk, endNotes[i].text)[0];
      hits.push({ idx: i, label: `endnote:${i + 1}`, origIndex: enOrig[i] ?? i, quote: t.slice(0, 200), autoFix: fx || undefined });
    }
    if (!hits.length) continue;
    if (hits.length <= CONSOLIDATE_AT) {
      for (const h of hits) {
        issues.push(mkIssue(spec, { ...enLoc(h.idx, h.quote) }, {
          message: chk.message,
          suggestion: chk.suggestion,
          autoFix: h.autoFix,
        }));
      }
      continue;
    }
    const first = hits[0];
    issues.push(mkIssue(spec, {
      location: first.label,
      endnoteIndex: first.origIndex,
      endnoteNumber: first.idx + 1,
      quote: first.quote,
    }, {
      message: `${chk.message}（全文共 ${hits.length} 处，此处为首处）`,
      suggestion: chk.suggestion,
      occurrenceCount: hits.length,
      autoFix: first.autoFix,
      occurrences: hits.map((h) => ({ location: h.label, endnoteIndex: h.origIndex, quote: h.quote, autoFix: h.autoFix })),
    }));
  }
  if (endNotes.length) {
    info.push({ label: '尾注著录', value: `全文 ${endNotes.length} 条尾注已纳入引文著录检查` });
  }

  // New range identities never expand an old whole-note decision. Saved old
  // results remain unchanged; fresh runs bind keys to their reviewed geometry.
  const rangeKey = (first, geometries) => `${first.spec.id}|${first.location}|${first.quote}|c:`
    + createHash('sha256').update(JSON.stringify(geometries)).digest('hex').slice(0, 24);
  if (citationRanges.length <= CONSOLIDATE_AT) {
    for (const h of citationRanges) issues.push({ ...mkIssue(h.spec, {
      location: h.location, footnoteIndex: h.footnoteIndex, endnoteIndex: h.endnoteIndex, quote: h.quote,
    }, { message: `${h.spec.message}：「${h.autoFix.find}」`, suggestion: h.spec.suggestion, autoFix: h.autoFix }),
    issueKey: rangeKey(h, [h.geometry]) });
  } else {
    const first = citationRanges[0];
    issues.push({ ...mkIssue(first.spec, {
      location: first.location, footnoteIndex: first.footnoteIndex, endnoteIndex: first.endnoteIndex, quote: first.quote,
    }, { message: `${first.spec.message}（全文共 ${citationRanges.length} 处，批量处理）`,
      suggestion: first.spec.suggestion, autoFix: first.autoFix, occurrenceCount: citationRanges.length,
      occurrences: citationRanges.map(h => ({ location: h.location, footnoteIndex: h.footnoteIndex,
        endnoteIndex: h.endnoteIndex, quote: h.quote, autoFix: h.autoFix })),
    }), issueKey: rangeKey(first, citationRanges.map(h => h.geometry)) });
  }

  /* --- CIT-031 图表资料来源只给网站名 ---
   *
   * 为什么单独写一块：图表的「数据来源／资料来源」是**正文段落**，
   * 不在 `doc.footnotes` / `doc.endnotes` 里，所以上面两个 CHECKS 循环
   * 覆盖不到它。实测 632 篇里 186 条来源段全部是独立正文段落。
   *
   * 判据为什么长这样（这是本规则最关键的一步）：
   * 规则库原先声明的判据是「须含机构名 + 文件名 + 网址 + 日期」，
   * 但实测语料 **186 条来源段里只有 16.1% 含网址、12.9% 含日期** ——
   * 照那条判据实现会命中 84% 的来源段，而其中绝大多数是**合规**的
   * （如「数据来源：根据中国汽车行业协会官方数据整理」「笔者根据国家统计局
   * 发布的多种统计资料估算所得」），属于典型的「把正确写法也报出来」。
   *
   * 真正能干净分开的违规形态是**只给一个网站或数据库名称**：
   *   资料来源：谷歌学术搜索。   资料来源：中国知网。
   * 这类确实无法核查（不知道引的是哪篇文献）。实测命中 10 条 / 5.4%，
   * 逐条核对全部属实，且唯一近邻「数据来源：同图6.」被正确排除
   * （「同图N」是合法交叉引用，不是来源缺失）。
   *
   * 同族的另一类「一条来源笼统列多个表名而不分别标明出自哪份文件」
   * （历史批注原话「这几个表分别出自哪两份文件或报告」）在语料上
   * **零命中** —— 已定性为「判据有效但本语料不触发」，不写检测。
   */
  {
    const spec = RULE_META['CIT-031'];
    /** 来源标签：「数据来源：」「资料来源：」「来源：」，可带前括号 */
    const SRC_LABEL = /^[（(]?\s*(数据来源|资料来源|来源)\s*[：:]\s*/;
    /**
     * 只给网站/数据库名（含常见变体与西文写法），后面除句末标点外没有别的内容。
     * 必须整段匹配：只要补了任何文件名或报告名就不再算违规。
     */
    const GENERIC_ONLY = /^(谷歌学术(搜索)?|中国知网|知网|万方|维普|维基百科|百度百科|百度|必应|搜狗|雅虎|Google(\s*Scholar)?|CNKI|Wikipedia|Web\s*of\s*Science|Scopus|JSTOR|网络|互联网|相关资料|公开资料|官方网站)\s*[。.．]?$/;
    if (spec) {
      const hits = [];
      for (let i = 0; i < paras.length; i += 1) {
        const t = (paras[i].text || '').trim();
        const m = t.match(SRC_LABEL);
        if (!m) continue;
        const body = t.slice(m[0].length).trim();
        if (!GENERIC_ONLY.test(body)) continue;
        hits.push({ i, quote: t.slice(0, 120) });
      }
      if (hits.length) {
    const first = hits[0];
    issues.push(mkIssue(spec, {
      location: `paragraph:${paras[hits[0].i].index}`,
      paragraphIndex: hits[0].i,
      quote: hits[0].quote,
    }, {
      message: hits.length > 1
        ? `${spec.title}（全文共 ${hits.length} 处，此处为首处）`
        : spec.title,
      suggestion: '补出所引文件或报告的完整名称、发布机构与网址',
      occurrenceCount: hits.length,
      /**
       * 每一处带自己的位置（`paragraphIndex` + `quote`）。
       *
       * 本规则**不产出 autoFix**（补出完整出处不是机械替换），
       * 所以不存在「第 2 处回退到首处偏移」的问题 ——
       * 那个坑只在「有 autoFix 且归并」时才会出现（见 scanner-format.js FMTB-041）。
       */
      occurrences: hits.map((h) => ({ location: `paragraph:${paras[h.i].index}`, paragraphIndex: h.i, quote: h.quote })),
    }));
      }
    }
  }

  /* --- 正文中的网络链接 --- */
  for (let i = 0; i < paras.length; i += 1) {
    const t = paras[i].text;
    const m = /https?:\/\/[^\s，。）]+/.exec(t);
    if (!m) continue;
    issues.push({
      ruleId: 'CIT-018', category: '引文与注释', group: 'citation', severity: '中',
      title: '正文中直接出现网址',
      basis: '《东方学刊》发文形式规范四',
      detail: '网址一般应放入脚注，正文中直接出现网址影响阅读',
      fix: '把网址移入脚注，并在脚注中补齐网站名、发布日期与最后浏览日期',
      location: `paragraph:${paras[i].index}`, paragraphIndex: i, quote: snippet(t, m.index),
      message: '正文中直接出现网址',
      suggestion: '移入脚注并补齐来源要素',
    });
  }

  /* ================================================================ */
  /*  CIT-020—CIT-030：补全此前只在规则库登记、未实际执行的检查         */
  /* ================================================================ */
  const push = (id, opts) => {
    const meta = RULE_META[id] || {};
    issues.push({
      ruleId: id,
      category: meta.category || '引文与注释',
      group: 'citation',
      severity: meta.severity || '中',
      title: meta.title || id,
      basis: meta.source || '《东方学刊》发文规范与历史批注归纳',
      detail: opts.detail,
      fix: opts.fix,
      location: opts.location,
      paragraphIndex: opts.paragraphIndex,
      footnoteIndex: opts.footnoteIndex,
      quote: opts.quote,
      message: opts.message,
      suggestion: opts.fix,
    });
  };

  for (let i = 0; i < notes.length; i += 1) {
    const t = notes[i].text.trim();
    const loc = { ...fnLoc(i, t.slice(0, 200)) };

    /* CIT-020 单条引文不宜过长 */
    // 只针对「确实包含大段直接引文」的脚注。实测把阈值设为 300 字会把大量
    // 正常的西文多文献并列著录、夹叙夹议的说明性注释全部误报，因此要求
    // 脚注内存在成段的引号内容（≥200 字）才提示。
    {
      const quoted = [...t.matchAll(/[“"]([^”"]{200,})[”"]/g)].map((m) => m[1].length);
      if (quoted.length) {
        push('CIT-020', {
          ...loc,
          detail: `该条脚注含 ${Math.max(...quoted)} 字的成段直接引文，过长会挤占版面、削弱论证节奏`,
          fix: '提炼观点后以注释交代出处，只保留关键短句作直接引文',
          message: `脚注含 ${Math.max(...quoted)} 字的成段引文`,
        });
      }
    }

    /**
     * CIT-026（非引文不得加引号，引文必须加注释）—— **第 21 轮已改判为人工复核，此处不再报出**。
     *
     * 原判据：`/[“”]/.test(t) && !/《/.test(t) && t.length < 40 && !hasPage(t)`
     * —— 即「短脚注 + 含引号 + 无书名号 + 无页码」，等于把**所有正常加引号的脚注**
     * 都报出来。它在 632 篇语料上的候选总体只有 22 处，逐条核对**零真违规**：
     *
     *   · 10 处含年份的内部研讨文稿，如「王绍光，“七月文稿研讨会筹备建议”，2002年4月9日」
     *     —— 这类文献本来就没有页码，缺页码不是缺陷；
     *   · 5 处译者注，如「“yugans”指印度教中构成历史循环的时代。——译者注」；
     *   · 4 处正文概念的引号，如「“村—县—城”中的城指……」「“联合国近东巴勒斯坦难民救济和工程处”」；
     *   · 2 处以「参见」开头（「参见知乎用户“Khoja Hazrat”的归纳」）；
     *   · 1 处英文词义辨析（government 的「政府」与「治理」两义）。
     *
     * 根本原因是**判据本身不可判**：短脚注里的引号究竟是「直接引文」还是
     * 「仅作强调」，从文本上无法区分。所以无论阈值怎么调都不可能做出可用的检测。
     *
     * 编辑确实提过这个意见（语料批注：「如果这是您的观点，只因想强调而加了引号的话，
     * 实则不必要……请您把关」），但那需要结合上下文并与作者沟通，
     * 属于人工复核项，不能由规则自动报出。规则库中 CIT-026 的
     * detect.type 已改为 manual，此处同步删除判据，避免「库说人工、代码仍在报」的不一致。
     */

    /* CIT-027 引用党的理论与意识形态内容须用党的决议或权威理论文件 */
    // 只针对中国的党的理论与意识形态文献。实测「政治意识形态」在美国政治学
    // 语境（如 DW-Nominate 得分衡量议员意识形态）中是标准术语，不应误报。
    if (/(党的(决议|文件|报告|章程)|中央(文件|精神|全会)|马克思主义中国化|中国特色社会主义理论|习近平新时代中国特色社会主义思想|党的基本理论|党的路线方针)/.test(t)
      && !isAuthoritativeSource(t)) {
      push('CIT-027', {
        ...loc,
        detail: '该条引用党的理论或意识形态内容，但未指向党的决议或权威理论文件',
        fix: '改引党代会报告、中央全会决议、《人民日报》或权威理论文献',
        message: '理论引用来源须为党的决议或权威文件',
      });
    }

    /* CIT-028 判例、法条与法律文献须用规范全称并注明来源 */
    if (/(第[0-9一二三四五六七八九十]+条|判例|判决|法释|宪法|民法典|刑法|行政法|司法解释)/.test(t)
      && !/《[^》]+》/.test(t)) {
      push('CIT-028', {
        ...loc,
        detail: '该条涉及法条或判例，但未用《》标注规范全称',
        fix: '法律名称用《》全称，判例注明法院、案号与年份',
        message: '法律文献未用规范全称',
      });
    }

    /* CIT-029 领导人讲话须析出具体载体，并尽量用直接引文 */
    if (isLeaderSpeech(t) && !/《/.test(t)) {
      push('CIT-029', {
        ...loc,
        detail: '该条为党和国家领导人讲话，但未析出具体载体（《选集》《文集》或权威报刊）',
        fix: '析出权威载体的卷次、版本与页码；尽量使用直接引文',
        message: '领导人讲话未析出载体',
      });
    }

    /* CIT-030 中文著作脚注字段顺序 */
    // 只检查「作者：」开头的著录。书名本身可能含「：」（如《人是马克思主义的出发点：人性、人道主义问题论集》），
    // 若不限制在开头，会把冒号位于书名内部的正常著录误判为字段顺序错误。
    {
      const authorPrefix = /^[\[【（(〔]?[^：:《》]{1,18}[\]】）)〕]?[：:]\s*(?=《|[\u4e00-\u9fa5])/.exec(t);
      if (authorPrefix && isBibliographic(t)) {
        const rest = t.slice(authorPrefix[0].length);
        const mBook = /《([^》]+)》/.exec(rest);
        const mYear = /([0-9]{4})\s*年/.exec(rest);
        if (mBook && mYear && mBook.index > mYear.index) {
          push('CIT-030', {
            ...loc,
            detail: '该条著录字段顺序不符合「作者：《书名》，出版社××××年版，第××页」',
            fix: '按「作者：《书名》，出版社××××年版，第××页」调整字段顺序',
            message: '著录字段顺序不规范',
          });
        }
      }
    }
  }

  /* CIT-025 出版信息须完整，联合出版须全部列出
   * 规范原文允许「出版地可省略，统一即可」，因此只检查出版社，不检查出版地。
   *
   * 关键是区分「首次完整著录」与「重复引用的简称」。中文论著重复引用同一文献时
   * 普遍使用简称（如「《文本盗猎者》，155-167页。」），没有出版社是正常的。
   * 因此先统计全文出现过完整著录的书名，凡是已有完整著录的书，其简称一律不报。
   * 实测不做这一步会在 400 多份稿件上产生数千条误报。
   */
  {
    const fullCited = new Set();   // 已有完整著录（含出版社）的书名
    const journalCited = new Set(); // 期刊/报刊文章（本就不需要出版社）
    for (const p of notes) {
      const t = p.text.trim();
      if (!t) continue;
      const titles = [...t.matchAll(/《([^》]{2,60})》/g)].map((m) => m[1]);
      const hasPub = hasPublisher(t);
      const isJournal = isNonBookSource(t);
      for (const title of titles) {
        if (hasPub) fullCited.add(title);
        if (isJournal) journalCited.add(title);
      }
    }
    for (let i = 0; i < notes.length; i += 1) {
      const t = notes[i].text.trim();
      if (!isBibliographic(t)) continue;
      if (/^[A-Za-z]/.test(t)) continue;                 // 西文著录
      if (/[（(][^）)]*译[）)]/.test(t)) continue;         // 译著（标注了译者）
      if (isNonBookSource(t)) continue;                  // 报刊、期刊、法规、政府报告
      const m = /《([^》]{2,60})》/.exec(t);
      if (!m) continue;                                  // 须有书名号，排除夹叙夹议的注释
      const title = m[1];
      // 首个书名号内若是报刊/法规名，说明这不是图书著录
      if (isNonBookSource(title)) continue;
      // 形如「《文章篇名》，《期刊名》2020年第3期」——第二个书名号是期刊，不是图书
      const titles = [...t.matchAll(/《([^》]{2,60})》/g)].map((x) => x[1]);
      if (titles.length >= 2 && looksLikeJournalTitle(titles[1]) && /第\s*[0-9]+\s*(期|辑)/.test(t)) continue;
      if (fullCited.has(title)) continue;                // 本文他处已有完整著录，此为简称
      if (journalCited.has(title)) continue;             // 期刊/报刊文章
      // 必须出现出版年字段，否则视为尚不构成完整著录的简称
      if (!/[0-9]{4}\s*年|[0-9]{4}\s*年版/.test(t)) continue;
      // 马列经典与党和国家领导人文献的著录体例不同（通常只给卷次与页码），由 CIT-003/004 负责
      if (isCanonical(t) || /马克思恩格斯|列宁全集|列宁选集|斯大林/.test(t)) continue;
      if (hasPublisher(t)) continue;
      push('CIT-025', {
        ...fnLoc(i, t.slice(0, 200)),
        detail: '该条为中文文献著录，但未见出版社名称',
        fix: '补出出版社；联合出版须全部列出',
        message: '著录缺出版社',
      });
    }
  }

  /* CIT-021 档案、内部文件、未刊访谈不得作为公开文献来源 */
  for (let i = 0; i < notes.length; i += 1) {
    const t = notes[i].text.trim();
    if (/(内部资料|内部文件|内部发行|未刊|未刊稿|访谈记录|访谈整理|口述|档案号|馆藏|藏于|手稿|油印本)/.test(t)
      && !/《/.test(t) && !/档案出版社|国家图书馆出版社|社会科学文献出版社/.test(t)) {
      push('CIT-021', {
        ...fnLoc(i, t.slice(0, 200)),
        detail: '该条引用内部文件、未刊稿或访谈，作为公开出版物的注释来源不妥',
        fix: '改引已公开出版的档案汇编或权威出版物；确需引用须说明来源与授权情况',
        message: '引用内部或未刊来源',
      });
    }
  }

  /* CIT-024 同类注释体例与年份信息全文必须统一
   * 注意：一条脚注里常并列多条文献（用「；」分隔），也常有夹叙夹议的说明。
   * 必须只在「该书名所在的那一段著录」里找出版年，否则会把同一脚注里
   * 其他文献的年份（甚至正文叙述里的年份）当成该书的出版年，产生大量误报。
   */
  {
    const fieldsOf = (t) => t.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
    const yearStyleOf = (field, title) => {
      if (!field.includes(`《${title}》`)) return null;
      if (/[0-9]{4}\s*年版/.test(field)) return 'ban';
      // 「出版社××××年」或「，××××年，」这类不带「版」的写法
      if (/[0-9]{4}\s*年/.test(field)) return 'nian';
      return null;
    };
    const byTitle = new Map();
    for (let i = 0; i < notes.length; i += 1) {
      const t = notes[i].text.trim();
      // 只取「著录部分」：正文夹叙夹议时常提到书名（如「由于《史记》曾花费大量笔墨…」），
      // 那不是著录，不能拿它的年份去比较体例。以最后一个引出词为界截取。
      const lastIntro = Math.max(
        t.lastIndexOf('参见'), t.lastIndexOf('详见'), t.lastIndexOf('见'),
        t.lastIndexOf('载'), t.lastIndexOf('收入'),
      );
      const bib = lastIntro > 0 ? t.slice(lastIntro) : t;
      for (const title of new Set([...bib.matchAll(/《([^》]{2,40})》/g)].map((m) => m[1]))) {
        const styles = fieldsOf(bib).map((f) => yearStyleOf(f, title)).filter(Boolean);
        if (!styles.length) continue;
        if (!byTitle.has(title)) byTitle.set(title, []);
        byTitle.get(title).push({ i, t, styles });
      }
    }
    for (const [title, list] of byTitle) {
      if (list.length < 2) continue;
      const all = list.flatMap((x) => x.styles);
      const hasBan = all.includes('ban');
      const hasNian = all.includes('nian');
      if (!(hasBan && hasNian)) continue;
      const banCount = all.filter((s) => s === 'ban').length;
      const nianCount = all.filter((s) => s === 'nian').length;
      const first = list.find((x) => x.styles.includes('nian')) || list[0];
      push('CIT-024', {
        ...fnLoc(first.i, first.t.slice(0, 150)),
        detail: `《${title}》全文出现 ${list.length} 次，其中 ${banCount} 处写作「××××年版」、${nianCount} 处写作「××××年」，出版年体例不统一`,
        fix: '统一为「出版社××××年版」',
        message: `同一文献出版年体例不统一：《${title}》`,
      });
    }
  }

  /* CIT-023 优先选用中国大陆经许可的版本，回避政治风险版本 */
  for (let i = 0; i < notes.length; i += 1) {
    const t = notes[i].text.trim();
    if (/(台版|台湾版|香港版|海外版|内部版|未删节本|全译本（台|大陆未出版)/.test(t)) {
      push('CIT-023', {
        ...fnLoc(i, t.slice(0, 200)),
        detail: '该条指向境外或未删节版本，须核对是否有中国大陆经许可版本',
        fix: '优先改引中国大陆经许可版本；确无替代版本须请示编辑部',
        message: '引用了境外或敏感版本',
      });
    }
  }

  /* CIT-022 陈旧文献与已变更事实的引文须改写或隐去具体名称 */
  {
    const nowYear = new Date().getFullYear();
    for (let i = 0; i < notes.length; i += 1) {
      const t = notes[i].text.trim();
      const years = [...t.matchAll(/(1[89][0-9]{2}|20[0-2][0-9])/g)].map((m) => Number(m[1]));
      if (!years.length) continue;
      const maxY = Math.max(...years);
      if (nowYear - maxY >= 30 && /(统计|数据|排名|人口|GDP|总量|比例|指数)/.test(t)) {
        push('CIT-022', {
          ...fnLoc(i, t.slice(0, 200)),
          detail: `该条引用 ${maxY} 年的统计数据（距今 ${nowYear - maxY} 年），数据已过时`,
          fix: '改用最新数据，或明确标注为历史数据并说明口径',
          message: `引用的统计数据较陈旧（${maxY} 年）`,
        });
      }
    }
  }

  /* CIT-017 中文著作名未用书名号（已在 CHECKS 中实现，此处补齐规则库元信息） */

  /* --- 统计 --- */
  const refCount = doc.footnoteRefs.length;
  info.push({ id: 'CIT-STAT', label: '脚注', value: `正文标记 ${refCount} 处，脚注 ${notes.length} 条` });
  const withPage = notes.filter((p) => hasPage(p.text.trim())).length;
  const bib = notes.filter((p) => isBibliographic(p.text.trim())).length;
  info.push({ id: 'CIT-STAT2', label: '著录完整性', value: `${bib} 条文献著录，其中 ${withPage} 条含页码（${bib ? Math.round((withPage / bib) * 100) : 0}%）` });
  const web = notes.filter((p) => isWeb(p.text.trim())).length;
  if (web) info.push({ id: 'CIT-STAT3', label: '网络来源', value: `${web} 条` });

  /* CIT-019 正文注释标号数与脚注条目数不匹配
   * 必须用真实的 OOXML id 比对：正文的 w:footnoteReference/@w:id
   * 对应 footnotes.xml 里 w:footnote/@w:id。分隔符脚注（separator /
   * continuationSeparator）不是真正的注释，须排除。
   */
  {
    const realNotes = doc.footnotes.filter((p) => !p.isNoteSeparator && p.noteId !== null && p.noteId !== undefined);
    const noteIds = new Set(realNotes.map((p) => String(p.noteId)));
    const refIds = (doc.footnoteRefs || []).map(String);
    const refSet = new Set(refIds);
    // 正文有标记但没有对应脚注条目
    const danglingRefs = [...new Set(refIds.filter((id) => !noteIds.has(id)))];
    // 有脚注条目但正文没有标记（含被删除修订删掉的标记）
    const orphanNotes = [...noteIds].filter((id) => !refSet.has(id));
    if (danglingRefs.length || orphanNotes.length) {
      const parts = [];
      if (danglingRefs.length) parts.push(`正文有 ${danglingRefs.length} 处脚注标记（id ${danglingRefs.slice(0, 8).join('、')}${danglingRefs.length > 8 ? ' 等' : ''}）找不到对应脚注`);
      if (orphanNotes.length) parts.push(`有 ${orphanNotes.length} 条脚注（id ${orphanNotes.slice(0, 8).join('、')}${orphanNotes.length > 8 ? ' 等' : ''}）在正文中没有对应标记`);
      issues.push({
        ruleId: 'CIT-019', category: '引文与注释', group: 'citation', severity: '高',
        title: '正文注释标号与脚注条目未一一对应',
        basis: '《东方学刊》发文形式规范四',
        detail: `${parts.join('；')}。可能是修订过程中删掉了标记或脚注，也可能是脚注编号断号。`,
        fix: '核对全文脚注标号与内容是否一一对应，补齐或删除多余的标记与脚注',
        location: 'document', quote: '',
        message: `正文 ${refIds.length} 处标记 vs ${noteIds.size} 条脚注，未一一对应`,
        suggestion: '核对脚注标号与内容是否一一对应',
      });
    }
  }

  const seen = new Set();
  const out = [];
  for (const it of issues) {
    const key = it.ruleId === 'CIT-008' && it.issueKey ? it.issueKey
      : `${it.ruleId}|${it.footnoteIndex ?? ''}|${it.endnoteIndex ?? ''}|${it.paragraphIndex ?? ''}|${(it.quote || '').slice(0, 30)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }

  return {
    issues: out,
    info,
    summary: {
      total: out.length,
      bySeverity: countBy(out, (i) => i.severity),
      byCategory: countBy(out, (i) => i.category),
      byRule: countBy(out, (i) => i.ruleId),
    },
    rulesApplied: CHECKS.length,
    cataloguedRules: cfg.rules.length,
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
