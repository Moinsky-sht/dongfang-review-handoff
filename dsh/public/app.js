const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  sessionId: null, doc: null, buffer: null, workVersion: null, history: null, clean: null, legacy: null, issues: [],
  auditView: 'audit', auditRequestSerial: 0,
  workspaceId: 'wdefault', workspace: null, workspaceSupported: null, workspaceError: null,
  workspaceSerial: 0, ingestionSupported: null, queueSupported: null,
  /** 请求池被未知发送占满时的核对视图（来自 /api/review-requests），为空表示无需处置。 */
  arkPoolBlock: null,
  /** 核对视图拉取失败的原因（不能静默：那会让「已在左侧列出来源」变成死胡同）。 */
  arkPoolBlockError: null,
  /** 面板是否处于「第二步确认」状态（页面内确认，不用会被浏览器静默禁用的原生对话框）。 */
  arkPoolConfirm: false,
  /** 已为哪个暂停原因拉取过核对视图，避免渲染时反复请求。 */
  arkPoolBlockChecked: '',
  activationSerial: 0,
  reviewRunId: null, humanRevision: null, humanVersionId: null,
  accepted: new Set(), filterGroup: 'all', filterSeverity: 'all', search: '',
  onlyFixable: false, onlyAccepted: false,
  view: 'markup', showMarks: true, mkFollow: true,
  /**
   * 「查看原文」：是否渲染**投稿时上传的原始文档**（含上一轮责编批注、未清洗）。
   * `originalBuffer` 在首次切换时按需从 `/api/session-file?original=1` 拉取，
   * 之后缓存在内存里，来回切换不再重复下载。
   */
  showOriginal: false, originalBuffer: null,
  streaming: false, streamSeq: 0, streamPhase: '', streamStartAt: 0,
  // 流式「逐条揭示」队列：服务端按窗口成批推批注，这里再按节奏一条条冒出来
  revealQueue: [],
  activeIssueKey: null, summary: null,
  // 模型复核结论（目标点 13），key 与 issueKey() 同构
  recheck: null,
  /** 模型复核统计（checked / skipped / noReply 等），用于显示实际覆盖率 */
  recheckStats: null,
  /**
   * 已经**逐条一键修改**过的条目（key 与 `issueKey()` 同构）。
   *
   * 为什么不直接从 `state.issues` 里删掉：用户需要看见「这一条我改过了」，
   * 而不是让它凭空消失 —— 后者会让人怀疑是不是漏审了。列表里保留该行、
   * 显示为已修复态，正文里撤掉它的下划线。
   */
  resolved: new Set(),
  appliedFixDetails: [],
  /** 锚点质量统计（服务端下发），用于在统计条上显示「定位到标点级」的比例 */
  anchorStats: null,
  /** 规则命中加权参考分；不能据此确认稿件内容质量。 */
  verdict: null,
  /** 计入模型复核结论后的参考判定（E2，默认关），仅作对照展示 */
  verdictModel: null,
  /** 本次结果的执行覆盖事实；与当前稿件、版本和审阅 run 一起接收或清空。 */
  reviewCoverage: null, reviewCoverageScope: null,
  /**
   * 人工审阅模式（用户需求 6）：开启后可在正文里圈画、记录判断。
   * 圈画结果通过 `/api/audit` 落到后台审计日志，成为可累积的审稿经验。
   */
  humanMode: false,
  /** 审稿人对每条问题的处置：issueKey → {action, opinion} */
  humanDecisions: new Map(),
  /** 审稿人自建的圈画标注（内存态；记录已落后台审计日志） */
  humanMarks: [],
  /**
   * 批量导入队列（B1）。一次选多篇时逐篇上传+清洗，队列里保留每篇的
   * 会话 id、解析结果与状态；点击某篇即切换为当前稿件，「批量审阅」逐篇跑。
   */
  queue: [],
  queueRunning: false,
  queueStopRequested: false,
  queueRequestPending: false, queueError: null, reviewWaiting: false,
};

/** 标题判据来源 → 中文标签（层级徽标的 tooltip 用，与 docInfo 标题结构口径一致） */
const HEAD_SOURCE_LABEL = {
  text: '编号', numbering: '编号链', style: '样式', outline: '大纲级别',
  format: '字号格式', 'text-trailing-punct': '编号(带句号)',
};

/* ==================================================================
   审稿经验审计（用户需求 7）：把审稿人的操作与看法记到后台
   ================================================================== */

/**
 * 追加一条审计记录。**fire-and-forget**：记录失败只提示，绝不阻断审稿动作。
 *
 * 每条记录都会带上审阅任务（`sessionId`）与稿件名，保证后台能回答
 * 「哪一次审阅、哪篇稿子」这一层溯源；段落/原文/规则/模型结论由调用方传入。
 */
function recordAudit(entry) {
  if (!state.sessionId) return;
  const payload = {
    id: state.sessionId,
    entries: [{ manuscript: state.doc?.label || '', ...entry }],
  };
  fetch('/api/audit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((r) => r.json())
    .then((r) => { if (r.error) toast('审稿日志写入失败：' + r.error, 4200); })
    .catch(() => { /* 网络失败不阻断审稿 */ });
}

const humanRequests = new Set();
function closeIssueDetail() {
  state.activeIssueKey = null;
  $('#detail')?.classList.add('hidden');
  const note = $('#rcHumanNote');
  if (note) { note.value = ''; note.disabled = true; }
  for (const id of ['detailTitle', 'detailMeta', 'detailQuote', 'detailProblem', 'detailFix', 'detailProposed', 'detailBasis', 'detailAnswer']) {
    const field = $('#' + id);
    if (field) { field.textContent = ''; field.title = ''; }
  }
  const recheck = $('#detailRecheck');
  if (recheck) recheck.innerHTML = '';
  for (const id of ['detailRecheckWrap', 'detailProposedWrap', 'detailAnswer']) $('#' + id)?.classList.add('hidden');
  const fixButton = $('#detailFixOne');
  if (fixButton) { fixButton.disabled = true; fixButton.classList.add('hidden'); if (fixButton.dataset) delete fixButton.dataset.key; }
  const askButton = $('#detailAsk');
  if (askButton) askButton.disabled = true;
}
function resetHumanState({ keepMarks = false } = {}) {
  resetReviewCoverage();
  closeIssueDetail();
  if (state.auditView === 'legacy') { state.auditRequestSerial += 1; $('#auditModal')?.classList.add('hidden'); }
  state.humanDecisions.clear();
  if (!keepMarks) state.humanMarks = [];
  state.humanRevision = null;
  state.reviewRunId = null;
  state.humanVersionId = keepMarks ? state.workVersion?.id || null : null;
  closeHumanPop();
}

function humanContext() {
  return { id: state.sessionId, versionId: state.workVersion?.id || null,
    epoch: state.history?.epoch, runId: state.reviewRunId,
    workspaceId: state.workspaceId, activationSerial: state.activationSerial };
}
function sameHumanContext(context) {
  const current = humanContext();
  return context.id === current.id && context.versionId === current.versionId
    && context.epoch === current.epoch && context.runId === current.runId
    && context.workspaceId === current.workspaceId && context.activationSerial === current.activationSerial;
}

function adoptHumanContext(data) {
  const has = (key) => Object.prototype.hasOwnProperty.call(data, key);
  const versionId = data.workVersion?.id || state.workVersion?.id || null;
  if (state.humanVersionId !== versionId) {
    resetReviewCoverage();
    closeIssueDetail();
    state.humanDecisions.clear(); state.humanMarks = []; state.humanRevision = null; closeHumanPop();
    state.humanVersionId = versionId;
  }
  const runId = has('reviewRunId') ? data.reviewRunId : data.result?.reviewRunId;
  if ((has('reviewRunId') || data.result && Object.prototype.hasOwnProperty.call(data.result, 'reviewRunId'))
      && runId !== state.reviewRunId) {
    resetReviewCoverage();
    closeIssueDetail();
    state.humanDecisions.clear(); closeHumanPop(); state.reviewRunId = runId || null;
  }
  if (!has('human')) return;
  const human = data.human;
  if (!human || human.workVersionId !== versionId) {
    state.humanDecisions.clear(); state.humanMarks = []; state.humanRevision = null; return;
  }
  if (Number.isInteger(state.humanRevision) && human.revision < state.humanRevision) return;
  state.humanRevision = human.revision;
  state.humanMarks = human.marks || [];
  state.humanDecisions = state.reviewRunId && human.reviewRunId === state.reviewRunId
    ? new Map(Object.entries(human.decisions || {})) : new Map();
}

async function saveHumanRecord(kind, entry) {
  if (state.workspaceError) { toast('工作台恢复失败，请先重试恢复再保存人工记录'); return false; }
  const context = humanContext();
  if (!context.id || !context.versionId || state.showOriginal || state.streaming || applyFixRequests.has(context.id) || humanRequests.has(context.id)) return false;
  if (kind === 'decision' && !context.runId) { toast('请先完成当前稿审阅，再保存人工判断'); return false; }
  if (!Number.isInteger(state.humanRevision)) {
    try {
      const res = await fetch('/api/human-records?id=' + encodeURIComponent(context.id));
      const data = await res.json();
      if (!res.ok || !sameHumanContext(context)) return false;
      adoptHumanContext(data);
    } catch { toast('人工记录状态获取失败，请刷新重试'); return false; }
  }
  if (!sameHumanContext(context) || !Number.isInteger(state.humanRevision)) return false;
  const verificationRunId = new URLSearchParams(globalThis.location?.search || '').get('verification');
  const body = JSON.stringify({ id: context.id, operationId: newWorkOperationId(), baseVersionId: context.versionId,
    baseMutationEpoch: context.epoch, baseRunId: context.runId, expectedHumanRevision: state.humanRevision,
    purpose: verificationRunId ? 'verification' : 'editorial', verificationRunId: verificationRunId || undefined, kind, ...entry });
  humanRequests.add(context.id);
  try {
    const { res, response } = await fetchWorkMutation('/api/human-records', body, context.epoch !== undefined);
    if (!sameHumanContext(context)) return false;
    if (!res.ok || response.error) { toast(response.error || '人工记录未保存，请刷新后重试', 5000); return false; }
    adoptHumanContext(response);
    reapplyHumanMarks();
    const active = state.issues.find((issue) => issueKey(issue) === state.activeIssueKey);
    if (active) renderRecheck(active);
    toast(kind === 'mark' ? '标注已保存' : '人工判断已保存', 2600);
    return true;
  } catch { if (sameHumanContext(context)) toast('人工记录保存失败，请重试', 5000); return false; }
  finally { humanRequests.delete(context.id); }
}

/**
 * 断线重连的轮询定时器（目标点 5）。
 *
 * **必须在这里声明**，不能声明在 resumeReview 附近：`finishReview()` 与
 * `importFile()` 都要 clearInterval(resumeTimer)，而它们的位置在文件中间，
 * 顶层 `let` 在那之前处于 TDZ —— 只要有一次调用发生在声明语句执行前，
 * 就会抛 `ReferenceError: Cannot access 'resumeTimer' before initialization`。
 * 这个坑在本项目已经踩过一次（`hasPublisher` 的 TDZ），所以统一前置。
 */
let resumeTimer = null;
let healthReady = null;
let pendingIngestionSelection = null;
const ingestionFiles = new Map();
const ingestionRequests = new Set();

const GROUP_LABEL = { format: '格式', language: '语言', citation: '引文', model: '模型' };
const GROUP_TAG = { format: 'fmt', language: 'lang', citation: 'cite', model: 'model' };

/**
 * 模型条目的提示文案（挂在「模型」标签的 `title` 上）。
 *
 * 为什么必须显式告知：实测（`tools/model-stability.mjs`，同稿跑 4 轮 × 3 份稿件）
 * 模型问题**数量**很稳（变异系数 3.9%~14.6%），但**具体条目几乎全换** ——
 * 4 轮并集 434 条里出现在全部 4 轮的只有 9 条（2.1%）；
 * 即使只按「规则号+段落位置」比也只有 4.2%；放宽到只看规则号才 27.1%。
 *
 * 也就是说模型给的是一批**待人工确认的线索**。不告知会有两个后果：
 *   · 编辑把某一条当成"确定的缺陷"去改 → 可能改的是模型这一轮的随机产物；
 *   · 重跑一次发现条目全变了 → 以为程序坏了。
 * 这两件事都不是靠改代码能避免的，只能靠把事实讲清楚。
 */
const MODEL_TAG_TITLE = '模型审阅意见：待人工确认的线索，不参与合格判定。'
  + '实测同稿重复运行条目不可复现（4 轮并集中仅约 2% 每轮都出现），重跑得到不同条目是预期行为。';

function modelTagTitle(group) { return group === 'model' ? MODEL_TAG_TITLE : ''; }

function issueKey(it) { return it.issueKey || `${it.ruleId}|${it.location}|${it.quote || ''}`; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function issueRangeProblem(it) {
  const anchors = [it?.anchor, ...(it?.anchors || []), ...(it?.autoFix?.occurrences || []).map(x => x.anchor || x)];
  const pending = anchors.find(a => ['ambiguous', 'unmapped', 'unresolved'].includes(a?.resolutionStatus));
  if (!pending) return '';
  return pending.resolutionStatus === 'ambiguous' ? '文字范围存在多个候选，位置待确认，不能自动修改'
    : '文字范围尚未准确对应当前稿，位置待确认，不能自动修改';
}

function isFixable(it) { return !!it && !state.showOriginal && !it.needsRelocation && !issueRangeProblem(it)
  && !readerNoteIssueProblem(it) && !!(it.autoFix && it.autoFix.find && it.autoFix.find !== it.autoFix.replace); }

function selectedFixableKeys(keys) {
  const selected = new Set(keys);
  return [...new Set(state.issues.filter(it => selected.has(issueKey(it)) && !state.resolved.has(issueKey(it)) && isFixable(it)).map(issueKey))];
}

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ==================================================================
   面板折叠 / 抽屉
   ================================================================== */
const NARROW = () => window.matchMedia('(max-width:1024px)').matches;

const panels = {
  left: { panel: () => $('#leftPanel'), layoutClass: 'left-collapsed', key: 'dsh.leftCollapsed' },
  right: { panel: () => $('#rightPanel'), layoutClass: 'right-collapsed', key: 'dsh.rightCollapsed' },
};

function setPanelCollapsed(side, collapsed) {
  const cfg = panels[side];
  const panel = cfg.panel();
  const layout = $('#layout');
  if (!panel || !layout) return;
  panel.classList.toggle('collapsed', collapsed);
  if (NARROW()) {
    // 窄屏：折叠 = 收起抽屉
    panel.classList.remove('open');
    syncScrim();
  } else {
    layout.classList.toggle(cfg.layoutClass, collapsed);
  }
  try { localStorage.setItem(cfg.key, collapsed ? '1' : '0'); } catch { /* 隐私模式 */ }
  syncRailBadges();
}

function isPanelCollapsed(side) {
  const panel = panels[side].panel();
  return panel ? panel.classList.contains('collapsed') : false;
}

function openDrawer(side) {
  const panel = panels[side].panel();
  if (!panel) return;
  panel.classList.remove('collapsed');
  panel.classList.add('open');
  syncScrim();
}
function closeDrawer(side) {
  const panel = panels[side].panel();
  if (!panel) return;
  panel.classList.remove('open');
  syncScrim();
}
function syncScrim() {
  const anyOpen = ['left', 'right'].some((s) => panels[s].panel()?.classList.contains('open'));
  $('#scrim')?.classList.toggle('hidden', !anyOpen);
}

/** 窄轨与顶栏上的问题数徽标 */
function syncRailBadges() {
  const n = state.issues.length;
  for (const id of ['rpRailBadge', 'btnRightBadge']) {
    const el = $('#' + id);
    if (!el) continue;
    el.textContent = String(n);
    el.classList.toggle('hidden', !n);
  }
}

function initPanels() {
  let lc = false; let rc = false;
  try {
    lc = localStorage.getItem('dsh.leftCollapsed') === '1';
    rc = localStorage.getItem('dsh.rightCollapsed') === '1';
  } catch { /* ignore */ }
  // 宽屏恢复上次状态；窄屏一律收起（抽屉默认关闭）
  if (!NARROW()) {
    $('#layout').classList.toggle('left-collapsed', lc);
    $('#layout').classList.toggle('right-collapsed', rc);
    $('#leftPanel').classList.toggle('collapsed', lc);
    $('#rightPanel').classList.toggle('collapsed', rc);
  } else {
    $('#leftPanel').classList.add('collapsed');
    $('#rightPanel').classList.add('collapsed');
  }
  syncRailBadges();

  // 桌面：折叠按钮在面板头，展开按钮在窄轨；窄屏：折叠=收起抽屉
  $('#btnLeftCollapse').addEventListener('click', () => setPanelCollapsed('left', true));
  $('#btnLeftExpand').addEventListener('click', () => setPanelCollapsed('left', false));
  $('#btnRightCollapse').addEventListener('click', () => setPanelCollapsed('right', true));
  $('#btnRightExpand').addEventListener('click', () => setPanelCollapsed('right', false));
  // 窄屏抽屉开关
  $('#btnLeft').addEventListener('click', () => openDrawer('left'));
  $('#btnRight').addEventListener('click', () => openDrawer('right'));
  $('#btnRightOpen').addEventListener('click', () => openDrawer('right'));
  // 关闭按钮：窄屏关抽屉，宽屏折叠面板
  $('#btnRightClose').addEventListener('click', () => {
    if (NARROW()) closeDrawer('right'); else setPanelCollapsed('right', true);
  });
  $('#scrim').addEventListener('click', () => { closeDrawer('left'); closeDrawer('right'); });

  /**
   * 点击正文里被高亮的文字/标点 → 跳到右侧清单并展开该问题的详情。
   *
   * 需求 2(b)：文内所有被高亮的文字、标点都要能点，点了就在右侧看到
   * 「发现了什么问题、问题详解、怎么改」。用一个 key 才对应一条问题；
   * 同一处重叠多条时取数组第一个（清单顺序即严重度优先，足够直观）。
   * 用事件委托挂在稳定的文档宿主上，标记是动态生成的，不必逐个绑定。
   */
  for (const sel of ['#docHost']) {
    const host = $(sel);
    if (!host) continue;
    host.addEventListener('click', onIssueMarkClick);
  }

  // 视口跨过断点时重置，避免桌面折叠态污染抽屉态
  let wasNarrow = NARROW();
  window.addEventListener('resize', () => {
    const nowNarrow = NARROW();
    if (nowNarrow === wasNarrow) return;
    wasNarrow = nowNarrow;
    if (nowNarrow) {
      $('#layout').classList.remove('left-collapsed', 'right-collapsed');
      closeDrawer('left'); closeDrawer('right');
      $('#leftPanel').classList.add('collapsed');
      $('#rightPanel').classList.add('collapsed');
    } else {
      closeDrawer('left'); closeDrawer('right');
      let l = false; let r = false;
      try { l = localStorage.getItem('dsh.leftCollapsed') === '1'; r = localStorage.getItem('dsh.rightCollapsed') === '1'; } catch { /* ignore */ }
      $('#layout').classList.toggle('left-collapsed', l);
      $('#layout').classList.toggle('right-collapsed', r);
      $('#leftPanel').classList.toggle('collapsed', l);
      $('#rightPanel').classList.toggle('collapsed', r);
    }
  });
}

/* ==================================================================
   Boot
   ================================================================== */
/**
 * 把顶栏的审阅设置控件**搬进**左栏「审阅设置」卡片（目标点 3）。
 *
 * 为什么搬：实测顶栏有 9 个控件、合计 961px 宽，其中「审阅模型」和
 * 「规则匹配方式」两个 220px 下拉就占掉 440px，把「导入 / 开始审阅 /
 * 导出报告」这些**主操作**挤到右边，主次不分。
 *
 * 为什么用搬移而不是复制：`#model`、`#useModel`、`#ruleMode` 这三个 id
 * 被 app.js 多处读写（模型列表填充、审阅参数、恢复设置），
 * 复制一份就会出现两个同 id 元素、读写分叉。搬移后 id、事件监听、
 * 现有取值逻辑全部原样保留，零改动风险。
 *
 * 兜底：`#settingsSlot` 不存在时（老结构）不搬，
 * 控件留在顶栏，功能不消失。
 *
 * ⚠️ **曾经按断点两处安放，这是错的，已改回「永远放设置卡」。**
 *
 * 原实现：≥1025px 放设置卡；≤1024px（左右栏变抽屉）把控件**搬回顶栏**、
 * 同时把设置卡 `hidden`。理由是「抽屉态下设置卡占地方」。
 * 但这制造了两个断档，且第二个是**功能彻底消失**：
 *   ① `@media (max-width:640px)` 里有一条 `.topbar-actions .switch{display:none}`
 *      —— 手机上「模型深度审阅」开关被 CSS 藏了，而它**只**在顶栏里，
 *      设置卡又被 `hidden` 藏了 → **手机上根本无法开启模型审阅**；
 *   ② 同一套「两处安放」逻辑此前已经出过一次同源故障
 *      （`origin.children` 为空导致三个控件全丢，见下）。
 *
 * 结论：控件的**唯一归宿就是设置卡**。抽屉态下左栏是浮层，
 * 设置卡是折叠的 `<details>`（实测折叠高 39px），点一下就能展开，
 * 远比「功能消失」好。顶栏只留主操作。
 */
function mountSettings() {
  const slot = $('#settingsSlot');
  const origin = $('#settingsOrigin');
  if (!slot || !origin) return;
  const card = $('#settingsCard');
  /**
   * 按 **id 搬移**，不能按 `origin.children` 搬 —— 这是个真踩到的坑。
   *
   * 第一次实现写成 `const kids = [...origin.children]; for (k of kids) origin.appendChild(k)`。
   * 而 `apply()` 会把控件从 `origin` 挪进 `slot`，**并给每个控件
   * 套一层 `.set-field` 外壳**（加小标签那步）。于是：
   *   · 控件已不在 `origin` 里 → `origin.children` 为空
   *   · 即使还在，`origin.appendChild` 只会把控件自己拉回来，
   *     留在 `slot` 里的 `.set-field` 外壳会成为空壳
   * 结果就是缩到抽屉宽度时 `kids` 是空数组，一个控件都没搬回去，
   * 而设置卡又被 `hidden` 藏了 —— **三个设置控件彻底消失、无法找回**。
   * （实测 1024/900px 下 `#model` 宽高均为 0。）
   *
   * 现在按 id 取控件本体，连外壳一起搬：外壳是 `.set-field` 就搬外壳。
   */
  const CONTROLS = ['#model', '#useModel', '#ruleMode', '#verdictWithModel', '#selfVerify', '#useContext', '#useCases'];
  const moveTo = (dest) => {
    for (const sel of CONTROLS) {
      const el = $(sel);
      if (!el || el.parentElement === dest) continue;
      const shell = el.closest('.set-field') || el.closest('label.switch') || el;
      dest.appendChild(shell);
    }
  };
  const apply = () => {
    card?.classList.remove('hidden');
    moveTo(slot);
    // 给每个控件补一行小标签，否则「规则：整段通读」这种选项文字看不出是什么设置
    if (!slot.dataset.labeled) {
      const labels = [['审阅模型', '#model'], ['深度审阅', '#useModel'], ['规则匹配', '#ruleMode'], ['判定口径', '#verdictWithModel'], ['第二轮自证', '#selfVerify'], ['全局上下文', '#useContext'], ['历史批注参考', '#useCases']];
      for (const [text, sel] of labels) {
        const el = $(sel);
        if (!el) continue;
        /**
         * 要包的是**控件的可见外壳**，不是 input 本身。
         *
         * `#useModel` 是 `<input>`，它的外层是 `<label class="switch">`；
         * 第一版直接包 `el`（input），于是 label 留在外面、文字跑到框外，
         * 布局散掉。所以：checkbox/radio 取最近的 label 祖先，其余取自身。
         */
        const target = (el.type === 'checkbox' || el.type === 'radio')
          ? (el.closest('label') || el)
          : el;
        const box = document.createElement('div');
        box.className = 'set-field';
        const lab = document.createElement('label');
        lab.className = 'set-label';
        lab.textContent = text;
        // 只有不是包住 input 的那个 label 时才用 for，否则会重复关联
        if (target.tagName !== 'LABEL') lab.setAttribute('for', el.id);
        target.parentNode.insertBefore(box, target);
        box.appendChild(lab);
        box.appendChild(target);
      }
      slot.dataset.labeled = '1';
    }
    syncSettingsSummary();
  };
  apply();
  // 设置卡不再随断点搬家，所以**不需要**断点监听：
  // 唯一的例外是 `#settingsSlot` 缺失时控件留在顶栏（上面的兜底），
  // 那种情况下断点变化也不需要重新安置。
}

/** 折叠状态下也要能一眼看出「模型审阅开没开」 */
function syncSettingsSummary() {
  const el = $('#settingsSummary');
  if (!el) return;
  const on = $('#useModel')?.checked;
  const mode = $('#ruleMode')?.value === 'per-rule' ? '逐条匹配' : '整段通读';
  const verifyOn = $('#selfVerify')?.checked !== false;
  const verify = verifyOn ? ' · 自证' : '';
  const ctx = on && $('#useContext')?.checked !== false ? ' · 全局' : '';
  const cases = on && $('#useCases')?.checked !== false ? ' · 案例' : '';
  el.textContent = on ? `模型审阅开 · ${mode}${verify}${ctx}${cases}` : '仅规则引擎';
  el.classList.toggle('set-summary-off', !on);
}

async function boot() {
  state.ingestionSupported = null;
  state.queueSupported = null;
  try {
    healthReady = fetch('/api/health').then(async (response) => {
      if (!response.ok) throw new Error('服务连接尚未确认');
      const health = await response.json();
      if (!health || typeof health !== 'object' || !health.rules || !Array.isArray(health.models)
        || !['format', 'language', 'citation'].every((group) => Number.isFinite(health.rules[group])))
        throw new Error('服务连接信息尚未确认');
      state.ingestionSupported = health.ingestionProtocol === 1 ? true
        : Object.prototype.hasOwnProperty.call(health, 'ingestionProtocol') ? null : false;
      state.queueSupported = health.reviewQueueProtocol === 1 ? true
        : Object.prototype.hasOwnProperty.call(health, 'reviewQueueProtocol') ? null : false;
      return health;
    });
    const h = await healthReady;
    const el = $('#health');
    el.textContent = `规则库 ${h.rules.format + h.rules.language + h.rules.citation} 条 · ${h.arkConfigured ? 'Ark 已连接' : 'Ark 未配置'}`;
    el.className = `pill ${h.arkConfigured ? 'pill-ok' : 'pill-warn'}`;
    const sel = $('#model');
    sel.innerHTML = h.models.map((m) => `<option value="${m.id}"${m.id === h.defaultModel ? ' selected' : ''}>${esc(m.label)}</option>`).join('');
  } catch { state.ingestionSupported = null; state.queueSupported = null; $('#health').textContent = '服务未连接'; }
  mountSettings();
  // 设置改动时同步折叠态的摘要文字
  for (const id of ['#useModel', '#ruleMode', '#selfVerify', '#useContext', '#useCases']) {
    $(id)?.addEventListener('change', syncSettingsSummary);
  }
  switchView(state.view);
  const purposeLabel = $('#humanPurposeLabel');
  if (purposeLabel) purposeLabel.classList.toggle('hidden', currentReviewCoverage()?.purpose !== 'verification');
  // 刷新后自动接上上次的会话（目标点 5）：页面重载不该丢掉正在跑的审阅
  if (!await restoreWorkspace()) await restoreSession();
}

async function awaitIngestionCapability() {
  if (healthReady) { try { await healthReady; } catch { /* Failed checks keep capability unknown. */ } }
  return state.ingestionSupported === true ? true : state.ingestionSupported === false ? false : null;
}
function unconfirmedIngestionMessage() {
  toast('尚未确认服务的稿件保存方式，请刷新页面重新连接后重试', 6500);
}

const QUEUE_STATUS = { ready: '待审阅', reviewing: '审阅中', complete: '所选步骤已结束', partial: '部分完成，请查看未完成项',
  queued: '等待审阅', running: '审阅中', publishing: '正在保存审阅结果', completed: '所选步骤已结束', failure: '审阅失败',
  failed: '审阅失败', cancelled: '已中止', interrupted: '已中断', unavailable: '稿件不可用', 'upload-pending': '需重新选择文件',
  'upload-saving': '稿件保存待继续', 'upload-failed': '导入失败', unregistered: '稿件已保存，队列登记待重试' };
const QUEUE_ACTIVE_STATES = new Set(['running', 'pausing', 'cancelling']);

function cleanPresentation(clean) {
  const count = (value) => Number.isInteger(value) && value >= 0 ? String(value) : '未提供';
  const status = clean?.status;
  if (status === 'cleaned') return { cls: 'done', text: `清洗已验证：移除 ${count(clean.commentsRemoved)} 条批注、${count(clean.anchorsRemoved)} 处锚点、${count(clean.commentParts)} 个批注部件` };
  if (status === 'unchanged') return { cls: 'done', text: '清洗检查已完成，稿件无需变更' };
  if (status === 'legacy-unverified') return { cls: 'warn', text: `历史文件清洗未验证${clean.reason ? `：${clean.reason}` : ''}` };
  if (status === 'failed') return { cls: 'err', text: `清洗失败${clean.reason ? `：${clean.reason}` : ''}` };
  return { cls: 'warn', text: '未提供清洗验证' };
}

function currentCleanProgress(name) {
  return [{ cls: 'done', text: `稿件已载入：${name || state.doc?.label || ''}` }, cleanPresentation(state.clean),
    ...(!state.buffer ? [{ cls: 'warn', text: '当前稿预览未载入，请刷新重试' }] : [])];
}

function adoptDocumentProvenance(data) {
  const has = (key) => Object.prototype.hasOwnProperty.call(data, key);
  if (has('clean')) state.clean = data.clean || null;
  if (has('legacy')) state.legacy = data.legacy || null;
  syncLegacyReviewButton();
}
function syncLegacyReviewButton() {
  const button = $('#btnLegacyReview');
  if (!button) return;
  const available = state.legacy?.historyAvailable === true;
  button.classList.toggle('hidden', !available);
  button.disabled = !available;
  const verify = $('#btnVerifyClean');
  const needsVerification = state.clean?.status === 'legacy-unverified';
  if (verify) {
    verify.classList.toggle('hidden', !needsVerification);
    verify.disabled = !needsVerification || !state.workVersion?.id || state.workspaceError || state.streaming
      || state.queueRunning || applyFixRequests.has(state.sessionId);
  }
  const review = $('#btnReview');
  if (review && !state.streaming) {
    if (needsVerification) review.textContent = '先验证清洗';
    else if (review.textContent === '先验证清洗') review.textContent = state.summary ? '重新审阅' : '开始审阅';
    review.title = needsVerification ? '请先点击“验证清洗”，确认当前稿再开始审阅' : '';
  }
}

async function verifyLegacyClean() {
  if (state.clean?.status !== 'legacy-unverified' || !state.workVersion?.id) return;
  return requestWorkMutation('/api/clean-session', {}, { kind: 'clean' });
}

function uploadFailureMessage(data) {
  const cleaning = cleanPresentation(data.clean);
  return data.clean?.status === 'failed' ? cleaning.text : data.error || '导入失败：服务未返回有效稿件';
}

function workspaceContext() {
  return { workspaceId: state.workspaceId, workspaceSerial: state.workspaceSerial };
}
function sameWorkspaceContext(context) {
  return context.workspaceId === state.workspaceId && context.workspaceSerial === state.workspaceSerial;
}
function ingestionKey(owner) { return `${owner.workspaceId}:${owner.ingestionId}`; }
function ingestionOwner(item, context = workspaceContext()) {
  return { ...context, ingestionId: item.ingestionId, operationId: item.operationId,
    name: item.name, size: item.size, purpose: item.purpose, verificationRunId: item.verificationRunId };
}
function matchingIngestion(owner, data) {
  const ingestion = data?.ingestion;
  return !!ingestion && ingestion.workspaceId === owner.workspaceId && ingestion.operationId === owner.operationId
    && (!owner.ingestionId || ingestion.id === owner.ingestionId)
    && (!owner.name || ingestion.name === owner.name)
    && (!Number.isFinite(owner.size) || ingestion.size === owner.size)
    && (!owner.purpose || ingestion.purpose === owner.purpose)
    && (owner.verificationRunId || null) === (ingestion.verificationRunId || null);
}
function ingestionComplete(data) {
  return data.ingestion?.status === 'completed' && data.registered === true && !!data.id && !!data.doc
    && !data.error && data.clean?.status !== 'failed';
}
function ingestionQueueStatus(ingestion) {
  if (ingestion.status === 'completed') return 'ready';
  if (ingestion.status === 'failed') return 'upload-failed';
  return ingestion.canResume === true ? 'upload-saving' : 'upload-pending';
}

/** 保存事实只来自所属导入；页面切换后，迟到响应不能改变新的工作台。 */
function adoptIngestionResponse(owner, data) {
  if (!sameWorkspaceContext(owner) || !matchingIngestion(owner, data)) return false;
  const ingestion = data.ingestion;
  owner.ingestionId = ingestion.id;
  if (data.workspace) adoptWorkspace(data.workspace);
  let item = state.queue.find((entry) => entry.ingestionId === ingestion.id);
  if (item?.id && ingestion.status !== 'completed') return false;
  if (!item) {
    item = { entryId: ingestion.entryId, ingestionId: ingestion.id, name: ingestion.name };
    state.queue.push(item);
  }
  Object.assign(item, { operationId: ingestion.operationId, name: ingestion.name, size: ingestion.size,
    purpose: ingestion.purpose, verificationRunId: ingestion.verificationRunId,
    status: ingestionQueueStatus(ingestion), canResume: ingestion.canResume === true,
    sourceStored: ingestion.sourceStored === true, needsFile: ingestion.needsFile === true,
    queueUnsaved: false, error: data.error || ingestion.error || null });
  if (ingestionComplete(data)) {
    const newerHistory = item.id === data.id && Number.isInteger(item.history?.epoch) && Number.isInteger(data.history?.epoch)
      && item.history.epoch > data.history.epoch;
    if (!newerHistory) Object.assign(item, { id: data.id, doc: data.doc, workVersion: data.workVersion, history: data.history,
      clean: data.clean || null, legacy: data.legacy || null, error: null });
    ingestionFiles.delete(ingestionKey(owner));
  } else if (data.clean) item.clean = data.clean;
  renderQueue();
  return true;
}

async function readIngestion(owner) {
  const res = await fetch('/api/ingestion?id=' + encodeURIComponent(owner.ingestionId));
  const data = await res.json();
  if (!matchingIngestion(owner, data)) throw new Error('稿件保存状态尚未确认，请刷新工作台确认');
  if (!adoptIngestionResponse(owner, data) && sameWorkspaceContext(owner)) throw new Error('稿件保存状态已改变，请刷新工作台确认');
  // A failed import is still an authoritative, durable state.
  if (!res.ok && data.ingestion.status !== 'failed' && !data.ingestion.canResume) throw new Error(data.error || '稿件保存状态获取失败');
  return data;
}

async function createIngestion(file, context) {
  const verificationRunId = new URLSearchParams(globalThis.location?.search || '').get('verification');
  const owner = { ...context, operationId: newWorkOperationId(), name: file.name, size: file.size,
    purpose: verificationRunId ? 'verification' : 'editorial', verificationRunId: verificationRunId || undefined, file };
  if (!Number.isSafeInteger(owner.size) || owner.size < 0) {
    try { owner.buffer = await file.arrayBuffer(); owner.size = owner.buffer.byteLength; }
    catch { if (sameWorkspaceContext(owner)) toast('文件信息无法读取，请重新选择该稿件', 6000); return null; }
  }
  const body = JSON.stringify({ workspaceId: owner.workspaceId, operationId: owner.operationId, name: owner.name,
    size: owner.size, purpose: owner.purpose, verificationRunId: owner.verificationRunId });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!sameWorkspaceContext(owner)) return null;
    try {
      const res = await fetch('/api/ingestions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const data = await res.json();
      if (!matchingIngestion(owner, data)) {
        if (!res.ok) throw new Error(data.error || '稿件导入登记未确认');
        throw new Error('稿件导入登记未确认，请刷新工作台确认');
      }
      owner.ingestionId = data.ingestion.id;
      if (!adoptIngestionResponse(owner, data)) return null;
      ingestionFiles.set(ingestionKey(owner), owner);
      return { owner, data, ok: res.ok };
    } catch (error) {
      if (attempt === 1) {
        if (sameWorkspaceContext(owner)) { await refreshWorkspace(); toast(error.message, 6000); }
        return null;
      }
      // The response may have been lost. Replay exactly the same intent and operation.
    }
  }
  return null;
}

async function postIngestion(owner, resume = false) {
  let options;
  let path;
  if (resume) {
    path = '/api/resume-ingestion';
    options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: owner.ingestionId }) };
  } else {
    if (!owner.file) return null;
    if (!owner.buffer) owner.buffer = await owner.file.arrayBuffer();
    if (!sameWorkspaceContext(owner)) return null;
    path = `/api/upload?name=${encodeURIComponent(owner.name)}`;
    options = { method: 'POST', headers: { 'X-Ingestion-Id': owner.ingestionId,
      'X-Upload-Operation': owner.operationId, 'X-Workspace-Id': owner.workspaceId }, body: owner.buffer };
  }
  if (!sameWorkspaceContext(owner)) return null;
  const res = await fetch(path, options);
  const data = await res.json();
  if (!matchingIngestion(owner, data)) throw new Error('稿件保存结果尚未确认，请刷新工作台确认');
  if (!adoptIngestionResponse(owner, data) && sameWorkspaceContext(owner)) throw new Error('稿件保存状态已改变，请刷新工作台确认');
  return { data, ok: res.ok };
}

/** 查询未确认结果后，只续存原始文件或重传本页持有的相同字节。 */
async function saveIngestion(owner, initial = null) {
  const key = ingestionKey(owner);
  if (!sameWorkspaceContext(owner) || ingestionRequests.has(key)) return null;
  ingestionRequests.add(key); renderQueue();
  try {
    let data = initial || await readIngestion(owner);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!sameWorkspaceContext(owner)) return null;
      if (ingestionComplete(data)) return data;
      const ingestion = data.ingestion;
      if (ingestion.status === 'completed') {
        data = await readIngestion(owner);
        if (ingestionComplete(data)) return data;
        throw new Error('稿件已保存，载入结果尚未确认，请刷新工作台');
      }
      if (ingestion.status === 'failed' && ingestion.canResume !== true) {
        toast(uploadFailureMessage(data), 7000); return null;
      }
      const resume = ingestion.canResume === true;
      if (!resume && !owner.file) {
        toast('此稿件尚未保存原始文件，请点击“重新选择文件”选回该稿件', 6000); return null;
      }
      try {
        const result = await postIngestion(owner, resume);
        if (!result || !sameWorkspaceContext(owner)) return null;
        data = result.data;
        if (ingestionComplete(data)) return data;
        if (!result.ok) {
          toast(data.ingestion.canResume ? '原始文件已保存，请在队列中点击“继续保存”' : uploadFailureMessage(data), 7000);
          return null;
        }
      } catch {
        // Do not turn a lost response into a failed import or create another session.
        data = await readIngestion(owner);
        if (ingestionComplete(data)) return data;
      }
    }
    if (sameWorkspaceContext(owner)) toast('稿件保存尚未完成，请在队列中确认状态或继续保存', 6000);
    return null;
  } catch (error) {
    if (sameWorkspaceContext(owner)) toast(error.message || '导入结果尚未确认，请刷新工作台确认', 6000);
    return null;
  } finally { ingestionRequests.delete(key); if (sameWorkspaceContext(owner)) renderQueue(); }
}

async function retryIngestion(item, context = workspaceContext()) {
  if (!sameWorkspaceContext(context) || !item?.ingestionId) return;
  const captured = ingestionOwner(item, context);
  const cached = ingestionFiles.get(ingestionKey(captured));
  const owner = cached && cached.operationId === captured.operationId && sameWorkspaceContext(cached) ? cached : captured;
  const supported = await awaitIngestionCapability();
  if (!sameWorkspaceContext(context)) return;
  if (supported !== true) {
    // The existing operation may still be queried, but must never become a new legacy upload.
    try { await readIngestion(owner); } catch { /* Retain the existing pending identity and row. */ }
    if (sameWorkspaceContext(context)) unconfirmedIngestionMessage();
    return;
  }
  const activationSerial = state.activationSerial;
  const data = await saveIngestion(owner);
  if (data && sameWorkspaceContext(context) && state.activationSerial === activationSerial) {
    const saved = state.queue.find((entry) => entry.ingestionId === owner.ingestionId && entry.id === data.id);
    if (saved) await activateItem(saved);
  }
}

function chooseIngestionFile(item, context = workspaceContext(), newImport = false) {
  if (!sameWorkspaceContext(context)) return;
  pendingIngestionSelection = { ...ingestionOwner(item, context), newImport };
  $('#fileInput').click();
}

async function selectIngestionFile(files) {
  const binding = pendingIngestionSelection;
  pendingIngestionSelection = null;
  if (!binding || !sameWorkspaceContext(binding)) { toast('工作台已切换，请在当前队列重新选择文件'); return; }
  if (files.length !== 1) { toast('请为此稿件选择一个 .docx 文件'); return; }
  const file = files[0];
  if (binding.newImport) return importFiles([file]);
  const item = state.queue.find((entry) => entry.ingestionId === binding.ingestionId && entry.operationId === binding.operationId);
  if (!item) { toast('该稿件状态已改变，请刷新工作台确认'); return; }
  if (file.name !== binding.name || Number.isFinite(binding.size) && file.size !== binding.size) {
    toast('所选文件与待保存稿件不符，请选回原文件；其他稿件可用“导入稿件”导入', 6500); return;
  }
  const cached = ingestionFiles.get(ingestionKey(binding));
  if (cached?.buffer) {
    const selected = new Uint8Array(await file.arrayBuffer());
    const original = new Uint8Array(cached.buffer);
    if (!sameWorkspaceContext(binding)) return;
    if (selected.length !== original.length || selected.some((byte, index) => byte !== original[index])) {
      toast('所选文件内容已改变，请用“导入稿件”建立新的导入', 6500); return;
    }
  }
  const owner = cached && sameWorkspaceContext(cached) ? cached : { ...binding, file };
  if (!owner.buffer) owner.file = file;
  ingestionFiles.set(ingestionKey(owner), owner);
  return retryIngestion(item, binding);
}

async function importDurableFiles(files) {
  const list = [...files].filter((file) => /\.docx$/i.test(file.name));
  if (!list.length) { toast('请导入 .docx 格式（旧版 .doc 请先另存为 .docx）', 6000); return; }
  if (state.workspaceError || state.streaming || state.queueRunning) { toast('请先恢复工作台或等待当前审阅结束再导入'); return; }
  const context = workspaceContext();
  const activationSerial = ++state.activationSerial;
  closeIssueDetail();
  const confirmed = [];
  let unconfirmed = 0;
  const saved = [];
  // Register the entire selection before reading or uploading any file body.
  // Confirmed placeholders survive a page close while an earlier file is being saved.
  for (const file of list) {
    if (!sameWorkspaceContext(context)) return;
    const created = await createIngestion(file, context);
    if (!sameWorkspaceContext(context)) return;
    if (!created || !created.ok) {
      unconfirmed += 1;
      toast(`${file.name}：导入登记尚未确认，请刷新工作台核对后重试`, 6500);
      continue;
    }
    confirmed.push(created);
  }
  for (const created of confirmed) {
    if (!sameWorkspaceContext(context)) return;
    const data = await saveIngestion(created.owner, created.data);
    if (data) saved.push(data);
  }
  if (!sameWorkspaceContext(context)) return;
  if (saved.length && state.activationSerial === activationSerial) {
    const first = state.queue.find((item) => item.id === saved[0].id && item.ingestionId === saved[0].ingestion.id);
    if (first) await activateItem(first);
  }
  if (!sameWorkspaceContext(context) || state.activationSerial !== activationSerial && !saved.length) return;
  if (saved.length) toast(`稿件已保存并登记 ${saved.length}/${list.length} 篇`
    + (saved.length < confirmed.length ? '；已登记的其余稿件请在队列中继续处理' : '')
    + (unconfirmed ? `；${unconfirmed} 篇导入登记尚未确认，请刷新工作台核对` : ''), 6500);
}

async function recordUploadFailure(data, name) {
  if (state.ingestionSupported !== false) return false;
  const workspaceId = state.workspaceId;
  const entryId = `e${newWorkOperationId()}`;
  const error = uploadFailureMessage(data);
  if (await updateWorkspace({action: 'failure', entryId, name, error})) return true;
  if (state.workspaceId !== workspaceId) return false;
  state.queue.push({entryId, name, status: 'upload-failed', queueUnsaved: true, error, clean: data.clean || null});
  rememberPendingRegistrations(); renderQueue();
  toast('导入失败信息未登记，请重新导入稿件', 5000);
  return false;
}

function rememberPendingRegistrations() {
  try { localStorage.setItem('dsh.pendingRegistrations:' + state.workspaceId,
    JSON.stringify(state.queue.filter((item) => item.queueUnsaved).map(({ id, entryId, name, error, status }) => ({ id, entryId, name, error, status })))); } catch { /* 隐私模式 */ }
}
async function registerUploadedSession(data, name) {
  if (state.ingestionSupported === true) return data.registered === true;
  if (state.ingestionSupported !== false) return false;
  if (await updateWorkspace({ action: 'attach', sessionId: data.id })) return true;
  if (!state.queue.some((item) => item.id === data.id)) state.queue.push({ id: data.id, name: name || data.name,
    status: 'unregistered', queueUnsaved: true, doc: data.doc, workVersion: data.workVersion, history: data.history, clean: data.clean || null, legacy: data.legacy || null });
  rememberPendingRegistrations(); renderQueue();
  toast('稿件已保存，但队列登记失败。请在队列中点“重试登记”', 6000);
  return false;
}
async function retryRegistration(sessionId) {
  if (await awaitIngestionCapability() !== false) { unconfirmedIngestionMessage(); return; }
  if (await updateWorkspace({ action: 'attach', sessionId })) {
    rememberPendingRegistrations(); toast('队列登记已保存');
  } else toast('队列登记仍未保存，稿件保留在待登记列表', 5000);
}

function adoptWorkspace(workspace) {
  if (!workspace || workspace.id !== state.workspaceId) return;
  if (state.workspace?.id === workspace.id && Number.isInteger(state.workspace.revision)
      && Number.isInteger(workspace.revision) && workspace.revision < state.workspace.revision) return;
  const itemKey = (item) => item.ingestionId ? `ingestion:${item.ingestionId}` : item.id ? `session:${item.id}` : `entry:${item.entryId}`;
  const cached = new Map(state.queue.map((item) => [itemKey(item), item]));
  const attached = new Set((workspace.entries || []).map((entry) => entry.id).filter(Boolean));
  const attachedEntries = new Set((workspace.entries || []).map((entry) => entry.entryId).filter(Boolean));
  const pending = state.queue.filter((item) => item.queueUnsaved && !attached.has(item.id) && !attachedEntries.has(item.entryId));
  state.workspace = workspace;
  state.queue = (workspace.entries || []).map((entry) => {
    const old = cached.get(itemKey(entry));
    const sameVersion = old?.workVersion?.id === entry.workVersion?.id
      && (state.queueSupported !== true || old?.reviewRunId === entry.reviewRunId);
    const proof = old?.reviewTerminalProof;
    const sameTerminalOwner = state.queueSupported === true && sameVersion
      && proof?.runId === entry.reviewRunId && proof?.versionId === entry.workVersion?.id
      && (!proof?.jobId || proof.jobId === entry.reviewJobId)
      && Number.isSafeInteger(proof?.historyEpoch)
      && proof.historyEpoch === old?.history?.epoch && proof.historyEpoch === entry.history?.epoch;
    const next = { ...(sameVersion ? old : {}), ...entry, queueUnsaved: false,
      result: entry.hasResult && sameVersion ? old?.result : null };
    // Job progress may change without a workspace revision. Preserve only a
    // terminal status already accepted for this exact run, version and epoch.
    if (sameTerminalOwner && old.status === proof.status
        && ['queued', 'reviewing', 'running', 'publishing'].includes(entry.status)) {
      for (const key of ['status', 'result', 'hasResult', 'running', 'waiting', 'error', 'opts']) next[key] = old[key];
    }
    if (!sameTerminalOwner || next.status !== proof?.status) delete next.reviewTerminalProof;
    return next;
  }).concat(pending);
  if (state.queueSupported === true) {
    state.queueRunning = QUEUE_ACTIVE_STATES.has(workspace.queue?.state);
    state.queueStopRequested = ['pausing', 'cancelling'].includes(workspace.queue?.state);
    syncHistoryControls();
  }
  rememberPendingRegistrations();
  renderQueue();
}

async function refreshWorkspace() {
  const context = workspaceContext();
  const { workspaceId } = context;
  try {
    const res = await fetch('/api/workspace?id=' + encodeURIComponent(workspaceId));
    if (!sameWorkspaceContext(context)) return false;
    if (res.status === 404) { state.workspaceSupported = false; state.workspaceError = null; renderQueue(); return false; }
    const data = await res.json();
    if (!sameWorkspaceContext(context)) return false;
    if (!res.ok) {
      state.workspaceError = data.error || '工作台恢复失败，请重试';
      renderQueue(); return false;
    }
    if (!sameWorkspaceContext(context) || !data.workspace) return false;
    state.workspaceSupported = true;
    state.workspaceError = null;
    adoptWorkspace(data.queue ? { ...data.workspace, queue: data.queue } : data.workspace);
    return true;
  } catch {
    if (sameWorkspaceContext(context)) { state.workspaceError = '无法连接工作台，请重试恢复'; renderQueue(); }
    return false;
  }
}

let workspaceWriteChain = Promise.resolve();
function updateWorkspace(action) {
  const context = workspaceContext();
  const { workspaceId } = context;
  const update = async () => {
    if (!sameWorkspaceContext(context)) return false;
    if (state.workspaceError) { toast('工作台未能恢复，队列修改尚未保存，请先重试恢复', 5000); return false; }
    if (state.workspaceSupported !== true) return false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetch('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: workspaceId, expectedRevision: state.workspace?.revision,
            operationId: newWorkOperationId(), ...action }) });
        const data = await res.json();
        if (!sameWorkspaceContext(context)) return false;
        if (data.workspace) adoptWorkspace(data.queue ? { ...data.workspace, queue: data.queue } : data.workspace);
        if (res.ok) return true;
        if (res.status !== 409) { toast(data.error || '工作台保存失败', 5000); return false; }
      } catch { toast('工作台保存失败，请刷新确认队列', 5000); return false; }
    }
    toast('工作台已在其他页面改变，请刷新确认队列', 5000);
    return false;
  };
  workspaceWriteChain = workspaceWriteChain.then(update, update);
  return workspaceWriteChain;
}

async function restoreWorkspace() {
  const activationSerial = state.activationSerial;
  const nextWorkspaceId = new URLSearchParams(globalThis.location?.search || '').get('workspace') || 'wdefault';
  if (nextWorkspaceId !== state.workspaceId) {
    state.workspaceSerial += 1;
    state.workspace = null; state.queue = []; state.workspaceError = null;
    state.queueRunning = false; state.queueStopRequested = false; state.queueRequestPending = false; state.queueError = null;
    stopQueueObserver(); stopReviewObserver();
    pendingIngestionSelection = null;
  }
  state.workspaceId = nextWorkspaceId;
  const context = workspaceContext();
  try {
    const pending = state.ingestionSupported === false ? JSON.parse(localStorage.getItem('dsh.pendingRegistrations:' + state.workspaceId) || '[]') : [];
    state.queue = pending.filter((item) => item.id || item.entryId).map((item) => ({ ...item, queueUnsaved: true, status: item.id ? 'unregistered' : 'upload-failed' }));
  } catch { /* 忽略损坏的本地待登记缓存 */ }
  if (!await refreshWorkspace()) return false;
  if (state.queueSupported === true && sameWorkspaceContext(context)) startQueueObserver();
  if (!sameWorkspaceContext(context) || state.activationSerial !== activationSerial) return true;
  const options = state.workspace.queue?.options || {};
  for (const [field, selector, property] of [['model', '#model', 'value'], ['ruleMode', '#ruleMode', 'value'],
    ['useModel', '#useModel', 'checked'], ['useRecheck', '#selfVerify', 'checked'], ['useContext', '#useContext', 'checked'],
    ['useCases', '#useCases', 'checked'], ['verdictWithModel', '#verdictWithModel', 'checked']]) {
    if (Object.prototype.hasOwnProperty.call(options, field)) { const control = $(selector); if (control) control[property] = options[field]; }
  }
  syncSettingsSummary();
  const requested = new URLSearchParams(globalThis.location?.search || '').get('session');
  let id = requested || state.workspace.activeSessionId;
  if (!id && state.workspaceId === 'wdefault' && !state.queue.some((item) => item.id)) {
    try { id = localStorage.getItem('dsh.lastSession'); } catch { /* 隐私模式 */ }
  }
  if (state.ingestionSupported === false && id && !state.queue.some((item) => item.id === id)) {
    try {
      const data = await (await fetch('/api/session?id=' + encodeURIComponent(id))).json();
      if (data.exists) await updateWorkspace({ action: 'attach', sessionId: id });
    } catch { /* 不自动上传或审阅 */ }
  }
  const item = state.queue.find((entry) => entry.id === id) || state.queue.find((entry) => entry.id);
  if (item && sameWorkspaceContext(context) && state.activationSerial === activationSerial) await activateItem(item, { persist: false });
  return true;
}

/**
 * 刷新后恢复上次会话。
 *
 * 三种情况分别处理：
 *   · 会话不存在（服务重启 / 被 LRU 淘汰）→ 静默清理，让用户重新导入
 *   · 已有结果 → 直接把文档和批注渲染回来，一条模型额度都不重烧
 *   · 还在跑   → 恢复文档 + 显示进度条 + 轮询接管
 */
async function restoreSession() {
  const context = workspaceContext();
  const previousSessionId = state.sessionId;
  let id = new URLSearchParams(location.search).get('session');
  if (!id && state.workspaceId === 'wdefault') { try { id = localStorage.getItem('dsh.lastSession'); } catch { /* 隐私模式 */ } }
  if (!id) return;
  const activationSerial = ++state.activationSerial;
  closeIssueDetail();
  let data;
  try {
    const r = await fetch('/api/session?id=' + encodeURIComponent(id));
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }
  if (!sameWorkspaceContext(context) || state.sessionId !== previousSessionId || state.activationSerial !== activationSerial) return;
  // 会话已不在（服务重启 / 被 LRU 淘汰）：清掉记录，静默让用户重新导入
  if (!data.exists) { try { localStorage.removeItem('dsh.lastSession'); } catch { /* ignore */ } return; }

  state.sessionId = data.id;
  state.doc = data.doc;
  state.buffer = null;
  state.clean = data.clean || null; state.legacy = data.legacy || null; syncLegacyReviewButton();
  state.workVersion = data.workVersion || null;
  state.history = data.history || null;
  resetHumanState();
  adoptHumanContext(data);
  state.streaming = !!data.running || !!data.waiting;
  state.reviewWaiting = !!data.waiting;
  syncHistoryControls();
  /**
   * 还原「已修复」状态。
   *
   * 服务端记得这一轮里哪些条目被自动改写过（`appliedFixes`），
   * 当前服务把修改保存进工作版本字节，恢复时仍要把对应条目标为已修复。
   * 旧服务只保存文档结构和回放记录，未提供 workVersion 时继续兼容回放。
   */
  state.resolved = new Set(data.appliedFixes || []);
  state.appliedFixDetails = data.appliedFixDetails || [];
  state.issues = []; state.summary = null; state.anchorStats = null;
  resetReviewCoverage(); state.verdict = null; state.verdictModel = null; state.recheck = null; state.recheckStats = null;
  state.accepted.clear();
  // 原始字节流也要拿回来：批阅/Word 视图共用 docx-preview，它渲染的是
  // 原始 .docx（ArrayBuffer），只有文本骨架会渲染成空白文档区。
  try {
    if (!await loadWorkingVersion(data.id, data.workVersion)) return;
  } catch { /* 拿不到就退化为空文档区，不影响其余功能 */ }
  if (!sameWorkspaceContext(context) || state.sessionId !== data.id || state.activationSerial !== activationSerial) return;
  renderDocInfo();
  renderMarkupIssues(); renderMarkupStats();
  renderDocument();
  setProgress(currentCleanProgress(data.name));
  switchView('markup');
  $('#btnReview').disabled = false;
  $('#btnWorkingDocx').disabled = false;
  $('#btnReport').disabled = !data.result; $('#btnDocx').disabled = !data.result;

  if (data.result) {
    state.issues = data.result.issues || [];
    state.summary = data.result.summary || null;
    state.verdict = data.result.verdict || null;
    state.verdictModel = data.result.verdictModel || null;
    state.anchorStats = data.result.anchorStats || null;
    state.streamSeq = state.issues.length;
    finishReview(data.result, { status: data.status || null });
    toast(`已恢复上次审阅结果（${state.issues.length} 条）`, 4000);
    return;
  }
  if (data.running || data.waiting) {
    await resumeReview({ silent: false });
    return;
  }
  // 会话在、但没跑过也没结果：把稿件摆好，等用户点「开始审阅」
  $('#btnReview').textContent = '开始审阅';
  setProgress([
    ...currentCleanProgress(data.name),
    { cls: '', text: '点击「开始审阅」执行四维检查' },
  ]);
  syncLegacyReviewButton();
  toast('已恢复上次导入的稿件', 3600);
}

/* ==================================================================
   导入
   ================================================================== */
async function importFile(file) {
  if (pendingInfo?.dirty || pendingInfo?.saving) { requestCloseHumanPop(); toast('请先保存或取消当前批注，再导入稿件'); return; }
  const supported = await awaitIngestionCapability();
  if (supported === null) { unconfirmedIngestionMessage(); return; }
  if (supported === true) return importDurableFiles([file].filter(Boolean));
  if (state.workspaceError) { toast('工作台恢复失败，请先重试恢复再导入'); return; }
  if (!file || !/\.docx$/i.test(file.name)) { toast('请导入 .docx 格式（旧版 .doc 请先另存为 .docx）', 6000); return; }
  const activationSerial = ++state.activationSerial;
  closeIssueDetail();
  toast('正在解析稿件…', 6000);
  let uploadedSessionId = null;
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: buf });
    const data = await res.json();
    if (!res.ok || data.error || data.clean?.status === 'failed' || !data.id) {
      if (state.activationSerial !== activationSerial) return;
      const message = uploadFailureMessage(data);
      await recordUploadFailure(data, file.name);
      if (state.activationSerial !== activationSerial) return;
      setProgress([{ cls: 'err', text: `${file.name}：${message}` }]);
      toast(message, 9000); return;
    }
    uploadedSessionId = data.id;
    const registered = await registerUploadedSession(data, file.name);
    if (state.activationSerial !== activationSerial) return;
    resetHumanState();
    state.sessionId = data.id;
    // 记住会话 id（目标点 5 断线重连）。
    // 服务端会话是内存里的（上限 40 个、按 LRU 淘汰），所以只存 id 这个短字符串，
    // 不存文档内容 —— 刷新后拿 id 去 /api/review-status 问一句就知道
    // 「还在跑」「已跑完」「不存在」三种情况，分别对应接管进度 / 直接取结果 / 重新导入。
    try { localStorage.setItem('dsh.lastSession', data.id); } catch { /* 隐私模式 */ }
    state.doc = data.doc;
    state.clean = data.clean || null; state.legacy = data.legacy || null; syncLegacyReviewButton();
    state.workVersion = data.workVersion || null;
    state.history = data.history || null;
    adoptHumanContext(data);
    syncHistoryControls();
    state.showOriginal = false; state.originalBuffer = null;
    $('#btnOriginal').textContent = '查看原文';
    // 阅读器渲染**清洗后**的字节流（服务端已移除上一轮批注），而不是用户上传的原始字节流。
    // 否则上一轮责编批注会与本轮结论混在一起，分不清是谁提的意见。
    try {
      if (!await loadWorkingVersion(data.id, data.workVersion)) return;
    } catch { if (state.sessionId === data.id) state.buffer = null; }
    if (state.sessionId !== data.id) return;
    state.issues = [];
    state.accepted.clear();
    state.summary = null;
    resetReviewCoverage(); state.verdict = null;
    state.verdictModel = null;
    state.activeIssueKey = null;
    // 换稿件必须清掉上一份的「已修复」与锚点统计，否则新稿件的同键条目
    // 会被误显示成已修复（key 只由 ruleId|location|quote 组成，可能撞上）
    state.resolved.clear();
    state.appliedFixDetails = [];
    state.anchorStats = null;
    markIndex.clear();
    renderDocInfo();
    renderMarkupIssues();
    renderMarkupStats();
    renderDocument();
    switchView('markup');
    $('#btnReview').disabled = false;
    $('#btnReview').textContent = '开始审阅';
    $('#btnReport').disabled = true;
    $('#btnDocx').disabled = true;
    $('#btnWorkingDocx').disabled = false;
    $('#btnApply').disabled = true;
    setProgress([
      ...currentCleanProgress(file.name),
      { cls: '', text: '点击「开始审阅」执行四维检查' },
    ]);
    // 窄屏导入后自动收起左抽屉，让用户直接看到文档
    if (NARROW()) closeDrawer('left');
    // 同一份稿件此前审阅过（或还在跑）→ 直接恢复，不必重跑。
    // 这是「刷新页面不丢进度」的入口：新会话 id 不会有结果，
    // 但用户若重新导入同一文件、或页面在审阅中刷新后重新导入，就能接上。
    await resumeReview({ silent: true });
    if (state.sessionId === data.id) await updateWorkspace({ action: 'activate', sessionId: data.id });
    toast(registered ? '稿件已保存并登记到队列' : '稿件已保存，队列登记待重试', 4500);
  } catch (e) {
    if (uploadedSessionId) { if (state.activationSerial === activationSerial) toast('稿件已保存，界面载入失败，请刷新恢复', 6000); return; }
    const error = `导入结果未确认：${e.message}`;
    await recordUploadFailure({error}, file.name);
    if (state.activationSerial !== activationSerial) return;
    setProgress([{cls: 'err', text: `${file.name}：${error}`}]);
    toast(error, 6000);
  }
}

/* ==================================================================
   批量导入队列（B1）：一次选多篇，逐篇清洗，可逐篇切换 / 批量审阅
   ================================================================== */

/** 把队列里的某一篇切换为「当前稿件」 */
async function activateItem(item, { persist = true } = {}) {
  if (item?.id && (pendingInfo?.dirty || pendingInfo?.saving)) {
    requestCloseHumanPop(); toast('请先保存或取消当前批注，再切换稿件'); return false;
  }
  if (!item || !item.id) return;
  const context = workspaceContext();
  const activationSerial = ++state.activationSerial;
  const sessionId = item.id;
  const isCurrent = () => sameWorkspaceContext(context) && state.sessionId === sessionId && state.activationSerial === activationSerial;
  stopReveal();
  stopReviewObserver();
  clearInterval(resumeTimer); resumeTimer = null;
  resetHumanState();
  closeIssueDetail();
  state.issues = []; state.summary = null; state.anchorStats = null;
  resetReviewCoverage(); state.verdict = null; state.verdictModel = null; state.recheck = null; state.recheckStats = null;
  state.streaming = false; state.reviewWaiting = false;
  state.showOriginal = false; state.originalBuffer = null;
  $('#btnOriginal').textContent = '查看原文';
  state.sessionId = item.id;
  state.doc = item.doc;
  state.clean = null; state.legacy = null; syncLegacyReviewButton();
  state.workVersion = item.workVersion || null;
  state.history = item.history || null;
  syncHistoryControls();
  state.buffer = null;
  try { localStorage.setItem('dsh.lastSession', item.id); } catch { /* 隐私模式 */ }
  {
    try {
      const res = await fetch('/api/session?id=' + encodeURIComponent(item.id));
      const current = await res.json();
      if (!isCurrent()) return;
      if (res.ok && current.exists) {
        item.doc = current.doc || item.doc;
        state.doc = item.doc;
        item.clean = current.clean || null; item.legacy = current.legacy || null;
        state.clean = item.clean; state.legacy = item.legacy; syncLegacyReviewButton();
        item.workVersion = current.workVersion || null;
        state.workVersion = item.workVersion;
        item.history = current.history || null;
        state.history = item.history;
        syncHistoryControls();
        if (Object.prototype.hasOwnProperty.call(current, 'result')) item.result = current.result || null;
        state.streaming = !!current.running || !!current.waiting;
        state.reviewWaiting = !!current.waiting;
        item.appliedFixes = current.appliedFixes || [];
        item.appliedFixDetails = current.appliedFixDetails || [];
        adoptHumanContext(current);
      } else {
        throw new Error(current.error || '稿件不存在或已不可用');
      }
    } catch (error) {
      if (!isCurrent()) return;
      state.doc = null; state.buffer = null; state.issues = []; state.summary = null;
      $('#docInfo').innerHTML = `<div class="muted small">${esc(error.message)}</div>`;
      $('#btnReview').disabled = true; $('#btnReport').disabled = true; $('#btnDocx').disabled = true;
      renderMarkupIssues(); renderMarkupStats(); renderDocument(true);
      toast('稿件状态获取失败，请刷新工作台', 5000);
      return false;
    }
  }
  if (!isCurrent()) return;
  try {
    if (!await loadWorkingVersion(sessionId, item.workVersion)) return;
  } catch { if (isCurrent()) state.buffer = null; }
  if (!isCurrent()) return;
  // 换稿件：清掉上一份的结论与状态（key 只由 ruleId|location|quote 组成，可能撞上）
  state.issues = []; state.accepted.clear(); state.summary = null;
  resetReviewCoverage(); state.verdict = null; state.verdictModel = null; state.activeIssueKey = null; state.resolved.clear();
  state.anchorStats = null; state.recheck = null; state.recheckStats = null;
  state.resolved = new Set(item.appliedFixes || []);
  state.appliedFixDetails = item.appliedFixDetails || [];
  markIndex.clear();
  renderDocInfo(); renderMarkupIssues(); renderMarkupStats(); renderDocument();
  switchView('markup');
  $('#btnReview').disabled = state.streaming;
  $('#btnReview').textContent = item.result ? '重新审阅' : '开始审阅';
  $('#btnReport').disabled = !item.result;
  $('#btnDocx').disabled = !item.result;
  $('#btnWorkingDocx').disabled = false;
  $('#btnApply').disabled = true;
  renderQueue();
  setProgress([
    ...currentCleanProgress(item.name),
    { cls: item.result ? 'done' : '', text: item.result ? `已有审阅结果（${(item.result.issues || []).length} 条），可直接查看` : '点击「开始审阅」执行四维检查' },
  ]);
  syncLegacyReviewButton();
  if (item.result) {
    state.issues = item.result.issues || [];
    state.streamSeq = state.issues.length;
    state.anchorStats = item.result.anchorStats || null;
    finishReview(item.result, { status: item.status });
  }
  if (persist) await updateWorkspace({ action: 'activate', sessionId });
  if (!isCurrent()) return false;
  if (state.streaming && (state.queueSupported === true || !state.queueRunning)) await resumeReview({ silent: true });
  return true;
}

/** 服务器要求逐字回传的确认语句；页面不得改写，否则服务器拒绝释放名额。 */
const ARK_ABANDON_ACKNOWLEDGE = '我确认放弃这些未知结果，允许重新审核';

/**
 * 未知发送占满请求池时，错误信息要求「先核对请求记录」——
 * 这里把那些记录真正取回来（含所属审阅是否已被中止），
 * 否则「核对」在界面上是个死胡同，用户只能干等到有人手工清理数据。
 */
async function loadArkPoolBlock() {
  try {
    const response = await fetch('/api/review-requests');
    const data = await response.json().catch(() => ({}));
    state.arkPoolBlockError = response.ok ? null : `HTTP ${response.status}`;
    state.arkPoolBlock = response.ok && Array.isArray(data.unknowns) && data.unknowns.length ? data : null;
  } catch (error) {
    // 取不到记录时必须说出来：否则界面上会出现「已在左侧列出来源」却什么都没有的死胡同
    state.arkPoolBlock = null;
    state.arkPoolBlockError = String(error?.message || error);
  }
  state.arkPoolConfirm = false;
  renderQueue();
  return state.arkPoolBlock;
}

function arkPoolBlockNotice() {
  if (!state.arkPoolBlock && state.arkPoolBlockError) {
    return `<div class="q-status q-err q-notice">请求池核对视图获取失败：${esc(state.arkPoolBlockError)}
      <div class="muted small">拿不到记录就不能释放名额（这一步只能由人核对后决定，程序不会代劳）。</div>
      <div class="q-actions"><button class="link-btn q-ark-reload">重新获取记录</button></div></div>`;
  }
  const block = state.arkPoolBlock;
  if (!block) return '';
  const rows = block.unknowns.slice(0, 6).map((row) => `<div class="muted small">· ${esc(String(row.id).slice(0, 10))}… ${esc(row.model || '未知模型')} ${esc(String(row.sendingAt || row.queuedAt || '').replace('T', ' ').slice(0, 19))}${row.runCancelled ? ' · 所属审阅已被中止' : ''}</div>`).join('');
  const more = block.unknowns.length > 6 ? `<div class="muted small">…另有 ${block.unknowns.length - 6} 笔</div>` : '';
  const head = `请求池被 ${block.unknowns.length} 笔「发送结果未确认」的请求占满（并发上限 ${block.concurrency ?? '未知'}），模型审阅已暂停。
    <div class="muted small">这些请求已物理发出但没取回响应：结果与费用一律按未知处理，绝不自动重发，也不会计入本轮结论。</div>${rows}${more}`;
  if (!state.arkPoolConfirm) {
    return `<div class="q-status q-err q-notice">${head}
    <div class="q-actions"><button class="link-btn q-ark-abandon">核对完毕：放弃未知结果并释放名额</button><button class="link-btn q-ark-reload">刷新记录</button></div></div>`;
  }
  /**
   * 第二步确认刻意用页面内按钮，不用 `window.confirm`：
   * 浏览器在多次原生对话框之后会静默禁用它们（弹窗不再出现、返回值恒为 false），
   * 那时按钮就变成「点了没反应」——人工释放这种关键路径不能依赖原生对话框。
   */
  return `<div class="q-status q-err q-notice">${head}
    <div class="muted small">确认后立即释放名额：不确认响应内容、费用一律按未知处理、绝不自动重发；原始回执与发送字节保留以便追溯。</div>
    <div class="q-actions"><button class="link-btn q-ark-confirm">确认放弃并释放名额（${block.unknowns.length} 笔）</button><button class="link-btn q-ark-cancel">取消</button></div></div>`;
}

/**
 * 人工处置未知请求：核对 → 真人确认 → 释放名额。
 * 失败（含目标状态已变化）一律不自动重试，只提示重新核对，
 * 因为这一步的语义是「人已经看过并接受后果」，不能被程序代劳或反复代跑。
 */
async function resolveArkPoolBlock() {
  const block = state.arkPoolBlock || await loadArkPoolBlock();
  if (!block) { toast('当前没有待处置的未知请求，请刷新进度核对', 5000); return; }
  if (!state.arkPoolConfirm) {
    // 第一步：先把后果与逐笔来源摆在面板里，等用户再点一次「确认放弃」。不弹原生对话框。
    state.arkPoolConfirm = true;
    renderQueue();
    return;
  }
  const ids = block.unknowns.map((row) => row.id);
  state.arkPoolConfirm = false;
  let data = {};
  try {
    const response = await fetch('/api/review-requests/abandon', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptIds: ids, acknowledge: ARK_ABANDON_ACKNOWLEDGE }) });
    data = await response.json().catch(() => ({}));
    if (!response.ok) { toast(`未释放名额：${data.error || `HTTP ${response.status}`}；请刷新记录后重新核对`, 8000); await loadArkPoolBlock(); return; }
  } catch (error) { toast(`释放结果未确认：${error.message}；请刷新进度核对`, 7000); return; }
  state.arkPoolBlock = null;
  state.arkPoolBlockChecked = '';
  toast(`已放弃 ${Array.isArray(data.abandoned) ? data.abandoned.length : ids.length} 笔未知请求（费用与结果按未知处理、未重发），请求池已释放`, 8000);
  renderQueue();
  refreshWorkspace().catch(() => {});
}

function renderQueue() {
  const card = $('#queueCard');
  const list = $('#queueList');
  if (!card || !list) return;
  if (!state.queue.length && !state.workspaceError) { card.style.display = 'none'; return; }
  card.style.display = '';
  const cnt = $('#queueCount');
  if (cnt) cnt.textContent = state.workspaceError ? '—' : String(state.queue.length);
  const restoreError = state.workspaceError ? `<div class="muted small">工作台恢复失败：${esc(state.workspaceError)}。当前列表不能证明全部队列已恢复。<button class="link-btn q-refresh">重试恢复工作台</button></div>` : '';
  const context = workspaceContext();
  const displayedItems = [...state.queue];
  const queue = state.workspace?.queue || {};
  const counts = queue.counts || {};
  const queueMessage = state.queueSupported === true && queue.runId ? ({
    running: `服务器审阅中：已完成 ${counts.completed || 0}/${counts.total || 0} 篇；关闭页面后继续`,
    pausing: '正在暂停后续稿件，当前稿完成后停止', paused: `已暂停，等待审阅 ${counts.queued || 0} 篇`,
    cancelling: '正在取消本轮，等待服务器确认并保存各篇最终状态',
    completed: `本轮所选步骤已结束 ${counts.completed || 0} 篇`, partial: '本轮已结束，仍有稿件须重审或补审',
    cancelled: '本轮已取消，取消记录已保存', interrupted: '本轮已中断，请核对后手动继续', failed: '本轮审阅失败，请核对原因后重审',
  }[queue.state] || '批量进度尚未确认，请刷新核对') : state.queueSupported === true ? '选择稿件查看，或开始批量审阅' : '';
  const pauseReason = ['paused', 'pausing'].includes(queue.state) && typeof queue.pauseReason?.message === 'string'
    ? queue.pauseReason.code === 'ARK_EXECUTION_BLOCKED' && Number.isSafeInteger(queue.pauseReason.unknownSentCount) && queue.pauseReason.unknownSentCount > 0
      ? `有 ${queue.pauseReason.unknownSentCount} 笔模型请求结果尚未确认。请先核对请求记录，再继续批量审阅。`
      : queue.pauseReason.message : '';
  /**
   * 批量暂停原因是请求池被占满时，页面刷新后也应能直接看到处置入口；
   * 按暂停原因去重，避免每次渲染都重复拉取核对视图。
   */
  const blockSignature = `${queue.pauseReason?.code || ''}:${queue.pauseReason?.unknownSentCount ?? ''}`;
  if (queue.pauseReason?.code === 'ARK_EXECUTION_BLOCKED' && !state.arkPoolBlock && state.arkPoolBlockChecked !== blockSignature) {
    state.arkPoolBlockChecked = blockSignature;
    loadArkPoolBlock().catch(() => {});
  }
  list.innerHTML = restoreError + (queueMessage ? `<div class="muted small">${esc(queueMessage)}</div>` : '')
    + (pauseReason ? `<div class="q-status q-err q-notice">暂停原因：${esc(pauseReason)}</div>` : '')
    + arkPoolBlockNotice()
    + (state.queueError ? `<div class="q-status q-err q-notice">${esc(state.queueError)}；请刷新进度确认。</div>` : '') + displayedItems.map((x, i) => {
    const active = x.id && x.id === state.sessionId;
    const status = (QUEUE_STATUS[x.status] || x.status || '待审阅') + (x.error ? `：${x.error}` : '');
    const versionHint = Number.isInteger(x.workVersion?.revision)
      ? (x.workVersion.revision === 0 ? '导入版本' : `工作版本 ${x.workVersion.revision}`) : '';
    const cls = ['failed', 'interrupted', 'unavailable', 'upload-failed', 'partial', 'unregistered'].includes(x.status) ? 'q-err' : (x.status === 'complete' ? 'q-done' : 'q-wait');
    const unfinished = ['failed', 'cancelled', 'interrupted', 'partial'].includes(x.status) && x.id;
    const inspection = active ? currentReviewGapInspection() : null;
    const gapActions = unfinished && state.queueSupported === true
      ? `<button class="link-btn q-inspect-gaps" ${reviewGapRequests.has(x.id) ? 'disabled' : ''}>查看未完成项</button>${inspection?.action.canResumeText ? `<button class="link-btn q-resume-missing" ${reviewResumeRequests.has(x.id) || state.streaming ? 'disabled' : ''}>仅补审未完成文字任务</button>` : ''}` : '';
    const retry = unfinished && (state.queueSupported === false || inspection && !inspection.action.visualOnly)
      ? '<button class="link-btn q-retry" title="重新审阅整份稿件，会重新调用已配置模型">重审整份</button>' : '';
    const durable = !!x.ingestionId && !x.id;
    const saving = durable && ingestionRequests.has(ingestionKey(ingestionOwner(x, context)));
    const ingestionActions = durable ? saving ? '<span class="q-status muted small">正在确认并保存稿件…</span>'
      : `${x.canResume ? '<button class="link-btn q-resume-save">继续保存</button>' : ''}
        ${x.status === 'upload-pending' ? '<button class="link-btn q-select-file">重新选择文件</button>' : ''}
        ${x.status === 'upload-failed' && !x.canResume ? '<button class="link-btn q-new-import">重新导入</button>' : ''}
        <button class="link-btn q-confirm-save">确认保存状态</button>` : '';
    const actions = `${gapActions}${retry}${ingestionActions}${!durable && ['upload-failed', 'unavailable'].includes(x.status) ? '<button class="link-btn q-reimport">重新导入</button>' : ''}
      ${x.queueUnsaved && x.id ? '<button class="link-btn q-register">重试登记</button>' : ''}`;
    return `<div class="q-item${active ? ' q-active' : ''}" data-qi="${i}" title="${esc(x.name)}">
      <button type="button" class="q-name" ${x.id ? '' : 'disabled'} title="${esc(x.name)}">${esc(x.name)}</button>
      ${versionHint ? `<span class="q-status q-version muted small" title="当前稿件版本">${esc(versionHint)}</span>` : ''}
      <span class="q-status q-state ${cls}">${esc(status)}</span>
      ${x.queueUnsaved && !x.id ? '<span class="q-status q-unsaved q-err">仅保存在本地 · 失败信息待登记</span>' : ''}
      ${actions.trim() ? `<div class="q-actions">${actions}</div>` : ''}
    </div>`;
  }).join('');
  list.querySelector('.q-refresh')?.addEventListener('click', restoreWorkspace);
  list.querySelector('.q-ark-abandon')?.addEventListener('click', (event) => { event.stopPropagation(); resolveArkPoolBlock(); });
  list.querySelector('.q-ark-confirm')?.addEventListener('click', (event) => { event.stopPropagation(); resolveArkPoolBlock(); });
  list.querySelector('.q-ark-cancel')?.addEventListener('click', (event) => { event.stopPropagation(); state.arkPoolConfirm = false; renderQueue(); });
  list.querySelector('.q-ark-reload')?.addEventListener('click', (event) => { event.stopPropagation(); loadArkPoolBlock(); });
  list.querySelectorAll('.q-item').forEach((el) => {
    el.addEventListener('click', (event) => {
      if (!sameWorkspaceContext(context)) return;
      if (state.queueSupported !== true && (state.streaming || state.queueRunning)) { toast('请先中止当前审阅，再切换稿件'); return; }
      const shown = displayedItems[Number(el.dataset.qi)];
      const it = state.queue.find((item) => shown?.ingestionId ? item.ingestionId === shown.ingestionId && item.operationId === shown.operationId
        : shown?.id ? item.id === shown.id : item.entryId === shown?.entryId);
      if (event.target.closest?.('.q-select-file')) { if (it) chooseIngestionFile(it, context); return; }
      if (event.target.closest?.('.q-new-import')) { if (it) chooseIngestionFile(it, context, true); return; }
      if (event.target.closest?.('.q-resume-save') || event.target.closest?.('.q-confirm-save')) { if (it) retryIngestion(it, context); return; }
      if (event.target.closest?.('.q-register')) { if (it?.id) retryRegistration(it.id); return; }
      if (event.target.closest?.('.q-reimport')) { pendingIngestionSelection = null; $('#fileInput').click(); return; }
      if (event.target.closest?.('.q-inspect-gaps')) { if (it?.id) inspectReviewGaps(it.id); return; }
      if (event.target.closest?.('.q-resume-missing')) { if (it?.id) resumeMissingReviewTasks(it.id); return; }
      if (event.target.closest?.('.q-retry')) { if (it?.id) retryQueueItem(it.id); return; }
      if (it?.id) activateItem(it);
    });
  });
  const batch = $('#btnReviewQueue');
  if (batch) {
    const canResume = state.queueSupported === true ? queue.runId && queue.state === 'paused' : queue.state === 'paused';
    batch.textContent = state.queueSupported === true && queue.state === 'interrupted' ? '重新审阅未完成稿'
      : canResume && queue.pauseReason?.code === 'ARK_EXECUTION_BLOCKED' ? '核对后继续' : canResume ? '继续批量审阅' : '批量审阅';
    if (state.queueSupported === true) batch.disabled = state.queueRunning || state.queueRequestPending;
  }
  const pause = $('#btnPauseQueue');
  if (pause) {
    pause.disabled = !state.queueRunning || state.queueStopRequested;
    // 按钮被禁用时说明原因，否则看起来像「按钮坏了」
    pause.title = pause.disabled
      ? (state.queueStopRequested ? '正在暂停，等当前稿完成后停止' : '当前没有批量审阅在跑，无需暂停')
      : '暂停后续稿件，当前稿会继续完成';
  }
  const cancel = $('#btnCancelQueue');
  if (cancel) {
    cancel.classList.toggle('hidden', state.queueSupported !== true);
    cancel.textContent = queue.state === 'cancelling' ? '取消中…' : '取消本轮';
    cancel.disabled = !['running', 'pausing', 'paused'].includes(queue.state) || state.queueRequestPending;
    cancel.title = cancel.disabled
      ? (state.queueRequestPending ? '正在处理上一个队列操作' : '当前没有批量审阅在跑（本轮已结束或尚未开始），无需取消')
      : '取消本轮剩余稿件；已经在跑的那一篇会写完当前步骤再停';
  }
  const refresh = $('#btnRefreshQueue');
  if (refresh) refresh.classList.toggle('hidden', state.queueSupported !== true);
}

/**
 * 批量导入：逐篇上传+清洗，进队列，激活第一篇。
 * 单篇仍走原来的 `importFile`（含「恢复上次结果」逻辑），不改变既有行为。
 */
async function importFiles(files) {
  if (pendingInfo?.dirty || pendingInfo?.saving) { requestCloseHumanPop(); toast('请先保存或取消当前批注，再导入稿件'); return; }
  const supported = await awaitIngestionCapability();
  if (supported === null) { unconfirmedIngestionMessage(); return; }
  if (supported === true) return importDurableFiles(files);
  if (state.workspaceError) { toast('工作台恢复失败，请先重试恢复再导入'); return; }
  if (state.streaming || state.queueRunning) { toast('请先中止当前审阅，再导入稿件'); return; }
  const list = [...files].filter((f) => /\.docx$/i.test(f.name));
  if (!list.length) { toast('请导入 .docx 格式（旧版 .doc 请先另存为 .docx）', 6000); return; }
  if (list.length === 1) return importFile(list[0]);
  toast(`正在导入 ${list.length} 篇稿件…`, 8000);
  let saved = 0; let registered = 0;
  for (const f of list) {
    let uploadedSessionId = null;
    try {
      const buf = await f.arrayBuffer();
      const res = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: buf });
      const d = await res.json();
      if (!res.ok || d.error || d.clean?.status === 'failed' || !d.id) {
        await recordUploadFailure(d, f.name);
        continue;
      }
      uploadedSessionId = d.id;
      saved += 1;
      if (await registerUploadedSession(d, f.name)) registered += 1;
    } catch (e) {
      if (uploadedSessionId) toast('稿件已保存，队列登记尚未确认，请刷新恢复', 6000);
      else await recordUploadFailure({error: `导入结果未确认：${e.message}`}, f.name);
    }
  }
  renderQueue();
  const first = state.queue.find((x) => x.id && !x.result);
  if (first) await activateItem(first);
  if (NARROW()) closeDrawer('left');
  toast(`稿件已保存 ${saved} 篇，队列已登记 ${registered} 篇${saved > registered ? `；${saved - registered} 篇待重试登记` : ''}`, 5500);
}

let queueObserverTimer = null;
let queueObserverSerial = 0;
let queueCommandSerial = 0;
async function awaitQueueCapability() {
  if (healthReady) { try { await healthReady; } catch { /* Unknown stays blocked. */ } }
  return state.queueSupported === true ? true : state.queueSupported === false ? false : null;
}
function unconfirmedQueueMessage() { toast('尚未确认服务器审阅方式，请刷新页面重新连接后重试', 6000); }
function stopQueueObserver() {
  queueObserverSerial += 1;
  clearTimeout(queueObserverTimer); queueObserverTimer = null;
}
function adoptQueueResponse(data, context) {
  if (!sameWorkspaceContext(context) || !data.workspace) return false;
  const queue = data.workspace.queue?.runId ? data.workspace.queue : data.queue;
  adoptWorkspace(queue ? { ...data.workspace, queue } : data.workspace);
  return true;
}
async function refreshReviewQueue() {
  const context = workspaceContext();
  if (state.queueSupported !== true) return refreshWorkspace();
  if (state.queueRequestPending) return false;
  const commandSerial = queueCommandSerial;
  try {
    const response = await fetch('/api/review-queue?workspaceId=' + encodeURIComponent(context.workspaceId));
    const data = await response.json();
    if (!sameWorkspaceContext(context) || commandSerial !== queueCommandSerial) return false;
    if (!response.ok || !adoptQueueResponse(data, context)) throw new Error(data.error || '服务器任务状态未能恢复');
    state.queueError = null; renderQueue();
    const selectedJob = state.workspace?.queue?.items?.find((item) => item.sessionId === state.sessionId
      && item.versionId === state.workVersion?.id);
    if (selectedJob && !reviewObserverBinding) await resumeModernReview({ silent: true });
    return true;
  } catch (error) {
    if (sameWorkspaceContext(context) && commandSerial === queueCommandSerial) { state.queueError = `进度未确认：${error.message}`; renderQueue(); }
    return false;
  }
}
function startQueueObserver() {
  stopQueueObserver();
  if (state.queueSupported !== true || !QUEUE_ACTIVE_STATES.has(state.workspace?.queue?.state)) return;
  const context = workspaceContext();
  const observerSerial = queueObserverSerial;
  const tick = async () => {
    queueObserverTimer = null;
    if (!sameWorkspaceContext(context) || observerSerial !== queueObserverSerial) return;
    await refreshReviewQueue();
    if (sameWorkspaceContext(context) && observerSerial === queueObserverSerial
      && QUEUE_ACTIVE_STATES.has(state.workspace?.queue?.state)) queueObserverTimer = setTimeout(tick, 2500);
  };
  queueObserverTimer = setTimeout(tick, 2500);
}
async function requestReviewQueue(action) {
  const context = workspaceContext();
  const runId = state.workspace?.queue?.runId;
  if (await awaitQueueCapability() !== true) { unconfirmedQueueMessage(); return false; }
  if (!sameWorkspaceContext(context)) return false;
  if (state.workspaceError || state.queueRequestPending) return false;
  if (action !== 'start' && !runId) { toast('当前批次身份尚未确认，请刷新进度后重试'); return false; }
  const operationId = newWorkOperationId();
  const body = JSON.stringify({ workspaceId: context.workspaceId, operationId, action,
    ...(action !== 'start' ? { runId } : {}),
    ...(['start', 'resume'].includes(action) ? { options: reviewOptionsSnapshot() } : {}) });
  queueCommandSerial += 1;
  state.queueRequestPending = true; renderQueue();
  try {
    const { res: response, response: data } = await fetchWorkMutation('/api/review-queue', body, true);
    if (!sameWorkspaceContext(context)) return false;
    if (data.workspace) adoptQueueResponse(data, context);
    if (!response.ok) {
      const error = new Error(data.error || '服务器任务操作失败');
      const reason = state.workspace?.queue?.pauseReason;
      error.queueBlocked = action === 'resume' && response.status === 409 && state.workspace?.queue?.runId === runId
        && ['paused', 'pausing'].includes(state.workspace?.queue?.state)
        && ['ARK_EXECUTION_BLOCKED', 'REVIEW_QUEUE_CONFIG_CHANGED'].includes(reason?.code)
        && (!data.code || data.code === reason.code) && data.error === reason.message;
      throw error;
    }
    if (data.command?.operationId !== operationId || data.command.action !== action || !data.command.runId
      || action !== 'start' && data.command.runId !== runId) throw new Error('服务器未确认此次批次操作身份');
    state.queueError = null;
    startQueueObserver();
    const selectedJob = state.workspace?.queue?.items?.find((item) => item.sessionId === state.sessionId
      && item.versionId === state.workVersion?.id);
    if (selectedJob && !reviewObserverBinding && ['start', 'resume'].includes(action)) await resumeModernReview({ silent: true });
    const currentRunId = state.workspace?.queue?.runId;
    if (action === 'cancel' && data.command.runId === currentRunId && !state.workspace?.queue?.cancelRequested
      && !['cancelling', 'cancelled'].includes(state.workspace?.queue?.state)) {
      toast('任务已结束，未执行取消');
      return false;
    }
    if (action === 'pause' && data.command.runId === currentRunId && !['pausing', 'paused'].includes(state.workspace?.queue?.state)) {
      toast('任务已结束，未执行暂停');
      return false;
    }
    const terminalMessage = { completed: '本轮所选步骤已结束', partial: '本轮审阅部分完成，仍有稿件须处理',
      failed: '本轮审阅失败，请核对后重审', interrupted: '本轮审阅已中断，未自动重试', cancelled: '本轮已取消，记录已保存',
      paused: '服务器任务已保存，当前队列已暂停' }[state.workspace?.queue?.state];
    toast(data.command.runId !== currentRunId ? '此操作属于较早批次，已恢复当前服务器进度'
      : action === 'pause' ? '已暂停后续稿件，当前稿继续完成'
      : action === 'cancel' && state.workspace?.queue?.state === 'cancelling' ? '取消请求已保存，正在确认各篇最终状态'
      : action === 'cancel' ? '本轮取消已保存'
      : terminalMessage || '服务器任务已保存，关闭页面后仍会继续', 4500);
    return true;
  } catch (error) {
    if (sameWorkspaceContext(context)) { state.queueError = error.queueBlocked ? `队列保持暂停：${error.message}` : `操作结果未确认：${error.message}`; renderQueue(); toast(state.queueError, 5500); }
    return false;
  } finally {
    if (sameWorkspaceContext(context)) { state.queueRequestPending = false; renderQueue(); }
  }
}
async function cancelReviewQueue() { return requestReviewQueue('cancel'); }

/**
 * 「中止」的两步确认。
 *
 * 不用 `window.confirm`：浏览器在多次原生对话框之后会静默禁用它们
 * （弹窗不再出现、返回值恒为 false），那样点多少次「中止」都不会有任何反应。
 * 这里改成按钮自身进入待确认状态，再点一次才真的中止，并在提示里讲清后果。
 */
const cancelArm = { armed: false, timer: null, armedAt: 0 };
/** 两次点击之间的最短间隔：挡住「习惯性双击」，真正的确认点击不会这么快。 */
const CANCEL_CONFIRM_FLOOR_MS = 350;
function disarmCancelReview() {
  if (cancelArm.timer) clearTimeout(cancelArm.timer);
  cancelArm.armed = false; cancelArm.timer = null; cancelArm.armedAt = 0;
  const button = $('#btnCancel');
  if (button) button.textContent = '中止';
}
function armCancelReview() {
  const button = $('#btnCancel');
  if (!button) return;
  cancelArm.armed = true; cancelArm.armedAt = Date.now();
  button.textContent = '再点一次确认中止';
  if (cancelArm.timer) clearTimeout(cancelArm.timer);
  cancelArm.timer = setTimeout(disarmCancelReview, 10000);
}

async function cancelCurrentReview() {
  const context = workspaceContext();
  const sessionId = state.sessionId;
  const activationSerial = state.activationSerial;
  const binding = reviewObserverBinding ? { ...reviewObserverBinding } : null;
  if (binding && currentReviewBinding(binding) && !cancelArm.armed) {
    const seconds = timer.id ? Math.floor((Date.now() - timer.start) / 1000) : null;
    armCancelReview();
    toast(`再点一次「确认中止」才会中止。已发出的模型请求会变成「未知」并继续占用名额，必须人工核对请求记录后才能释放；`
      + (seconds == null ? '' : `本轮已进行 ${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒，`)
      + '模型阶段每个窗口约 30 秒–2 分钟，期间可以离开页面（服务器会继续跑）', 12000);
    return false;
  }
  if (binding && currentReviewBinding(binding) && Date.now() - cancelArm.armedAt < CANCEL_CONFIRM_FLOOR_MS) {
    // 双击的第一下刚把按钮切到待确认状态：这一下不算确认，保持待确认、等用户看清后再点。
    armCancelReview();
    return false;
  }
  disarmCancelReview();
  if (state.queueSupported === true) {
    if (!binding || !currentReviewBinding(binding)) { toast('此次审阅身份尚未确认，请刷新进度后重试'); return false; }
    const body = JSON.stringify({ id: sessionId, reviewRunId: binding.runId, reviewJobId: binding.jobId,
      workVersionId: binding.versionId, operationId: newWorkOperationId() });
    try {
      const { res: response, response: data } = await fetchWorkMutation('/api/cancel-review', body, true);
      if (!response.ok) throw new Error(data.error || '取消未能保存');
      if (typeof data.accepted !== 'boolean') throw new Error('服务器未确认取消是否受理');
      if (currentReviewBinding(binding)) {
        await resumeModernReview({ silent: true });
        if (currentReviewBinding(binding)) toast(data.accepted ? data.cancelled ? '取消记录已保存' : '取消请求已保存，正在确认最终状态'
          : data.publicationCommitted ? '结果正在提交，未执行取消' : '任务已结束，未执行取消');
      }
      await refreshWorkspace();
      return data.accepted;
    } catch (error) {
      if (currentReviewBinding(binding)) { setProgress([{ cls: 'warn', text: `取消结果未确认：${error.message}；请刷新进度确认` }]); toast('取消结果未确认，请刷新进度', 5000); }
      return false;
    }
  }
  if (state.queueSupported !== false) { unconfirmedQueueMessage(); return false; }
  if (state.queueRunning) {
    state.queueStopRequested = true;
    await updateWorkspace({ action: 'queue', state: 'paused', cursorSessionId: sessionId, options: reviewOptionsSnapshot() });
  }
  try { await fetch('/api/cancel-review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sessionId }) }); }
  catch { /* Legacy service cannot confirm durable cancellation. */ }
  if (sameWorkspaceContext(context) && state.sessionId === sessionId && state.activationSerial === activationSerial) toast('正在中止…');
  return true;
}

/** 现代服务由服务器推进；旧服务仍兼容页面逐篇流程。 */
async function reviewQueue() {
  const context = workspaceContext();
  const supported = await awaitQueueCapability();
  if (!sameWorkspaceContext(context)) return;
  if (supported === null) { unconfirmedQueueMessage(); return; }
  if (supported === true) {
    if (state.queueRequestPending || state.queueRunning) return;
    return requestReviewQueue(state.workspace?.queue?.runId && state.workspace?.queue?.state === 'paused' ? 'resume' : 'start');
  }
  if (state.streaming || state.queueRunning) return;
  await refreshWorkspace();
  if (state.workspaceError) { toast('工作台恢复失败，尚未启动批量审阅'); return; }
  const pending = state.queue.filter((x) => x.id && ['ready', 'failed', 'cancelled', 'interrupted', 'partial'].includes(x.status));
  if (!pending.length) { toast('队列中没有待审阅的稿件'); return; }
  const btn = $('#btnReviewQueue');
  btn.disabled = true;
  state.queueRunning = true;
  syncHistoryControls();
  state.queueStopRequested = false;
  $('#btnImport').disabled = true;
  await updateWorkspace({ action: 'queue', state: 'ready', cursorSessionId: pending[0]?.id, options: reviewOptionsSnapshot() });
  const modelOn = $('#useModel')?.checked;
  if (modelOn && pending.length > 1) {
    toast(`将逐篇审阅 ${pending.length} 篇（含模型审阅，耗时较长）`, 6000);
  }
  let ok = 0;
  for (const item of pending) {
    if (state.queueStopRequested) break;
    if (!await activateItem(item)) { item.status = 'unavailable'; renderQueue(); continue; }
    await updateWorkspace({ action: 'queue', state: 'ready', cursorSessionId: item.id, options: reviewOptionsSnapshot() });
    item.status = 'reviewing';
    renderQueue();
    try {
      const result = await runReview({ force: true });
      if (!result) {
        item.status = state.queueStopRequested ? 'cancelled' : 'failed';
        renderQueue();
        if (state.queueStopRequested) break;
        continue;
      }
      item.result = result;
      item.status = result.modelErrors?.length || result.recheck?.stats?.noReply ? 'partial' : 'complete';
      if (item.status === 'complete') ok += 1;
    } catch (e) {
      item.status = 'failed'; item.error = e.message;
    }
    await refreshWorkspace();
    renderQueue();
  }
  btn.disabled = false;
  state.queueRunning = false;
  syncHistoryControls();
  $('#btnImport').disabled = false;
  await refreshWorkspace();
  const remaining = state.queue.filter((item) => item.id && ['ready', 'failed', 'cancelled', 'interrupted', 'partial'].includes(item.status));
  const needsImport = state.queue.some((item) => ['upload-pending', 'upload-saving', 'upload-failed', 'unavailable'].includes(item.status) || item.queueUnsaved);
  await updateWorkspace({ action: 'queue', state: state.queueStopRequested || remaining.length || needsImport ? 'paused' : 'completed',
    cursorSessionId: remaining[0]?.id || null, options: reviewOptionsSnapshot() });
  toast(`本轮批量审阅结束：所选步骤已结束 ${ok}/${pending.length} 篇${remaining.length || needsImport ? '；剩余稿件须手动继续或重新导入' : ''}`, 5500);
}

function reviewOptionsSnapshot() {
  const useModel = $('#useModel')?.checked === true;
  return { model: $('#model')?.value || '', useModel,
    ruleMode: $('#ruleMode')?.value || 'all', useRecheck: useModel && $('#selfVerify')?.checked !== false,
    useContext: useModel && $('#useContext')?.checked !== false, useCases: useModel && $('#useCases')?.checked !== false,
    verdictWithModel: $('#verdictWithModel')?.checked === true };
}

async function pauseReviewQueue() {
  const supported = await awaitQueueCapability();
  if (supported === null) { unconfirmedQueueMessage(); return false; }
  if (supported === true) return requestReviewQueue('pause');
  if (!state.queueRunning) return;
  state.queueStopRequested = true;
  renderQueue();
  await updateWorkspace({ action: 'queue', state: 'paused', cursorSessionId: state.sessionId, options: reviewOptionsSnapshot() });
  toast('已暂停后续稿件；当前稿继续完成，恢复后须手动继续', 4500);
}

async function retryQueueItem(sessionId) {
  if (state.streaming || state.queueRunning) return;
  const item = state.queue.find((entry) => entry.id === sessionId);
  if (!item || !await activateItem(item)) return;
  await runReview({ force: true });
  await refreshWorkspace();
}

const reviewGapInspections = new Map(), reviewGapRequests = new Set(), reviewResumeRequests = new Set(), reviewResumeIntents = new Map();
function reviewGapContext() {
  return { ...workspaceContext(), sessionId:state.sessionId, activationSerial:state.activationSerial,
    versionId:state.workVersion?.id, workSha256:state.workVersion?.sha256, sourceSha256:state.workVersion?.sourceSha256,
    epoch:state.history?.epoch, runId:state.reviewRunId };
}
function sameReviewGapContext(context) {
  const current=reviewGapContext();
  return sameWorkspaceContext(context)&&['sessionId','activationSerial','versionId','workSha256','sourceSha256','epoch','runId'].every(key=>context[key]===current[key]);
}
function currentReviewGapInspection() {
  const inspection=reviewGapInspections.get(state.sessionId);
  return inspection&&sameReviewGapContext(inspection.context)?inspection:null;
}
/** A terminal label cannot authorize a new paid request. Use this source/run's durable plan and coverage. */
function reviewGapAction({status,execution,coverage,current}={}) {
  const view=normalizeReviewCoverageView(coverage),proof=view.sourceCoverage,plan=execution?.execution?.plan,requests=execution?.execution?.requests||{};
  const visualGaps=view.sourceCoverageGaps.filter(gap=>['unparsed_visual_content','textbox_text_not_primary'].includes(gap.reason));
  const primaryMissing=!!proof&&(proof.totals.pendingUtf16>0||proof.totals.completedTasks<proof.totals.expectedTasks||proof.totals.completedNodes<proof.totals.expectedNodes);
  const base={canResumeText:false,primaryMissing,visualGaps,visualOnly:!!proof&&proof.status==='complete'&&visualGaps.length>0&&!view.currentWorkChanged
    &&view.reviewedVersionId===current?.versionId&&view.currentWorkVersionId===current?.versionId,
    textGaps:proof?.sourceCoverageGaps||[],coverage:view};
  const blocked=(code,message)=>({...base,code,message});
  if(!current||!status||status.id!==current.sessionId||status.reviewRunId!==current.runId||!/^r[a-f0-9]{64}$/.test(current.runId||''))return blocked('identity-unconfirmed','审阅身份尚未确认，请刷新后核对');
  if(status.running||status.waiting||['queued','running','publishing'].includes(status.status))return blocked('active','当前任务尚未结束，请等待完成');
  if(!['partial','failed','cancelled','interrupted','completed','complete'].includes(status.status))return blocked('identity-unconfirmed','终态尚未确认，未发起补审');
  if(status.workVersionId!==current.versionId||status.history?.epoch!==current.epoch||view.currentWorkChanged
    ||view.reviewedVersionId!==current.versionId||view.currentWorkVersionId!==current.versionId)return blocked('source-changed','当前稿或修改历史已变化，不能复用旧文字任务');
  if(!view.options?.useModel||!proof||!plan||plan.schemaVersion!==1||!Array.isArray(plan.units)||!/^[a-f0-9]{64}$/.test(plan.planFingerprint||''))return blocked('plan-unconfirmed','该运行缺少可核验的文字检查点，不能自动补审');
  const binding=plan.identity?.binding;
  if(execution.id!==current.sessionId||execution.reviewRunId!==current.runId||execution.workVersionId!==current.versionId||plan.jobRunId!==current.runId
    ||!binding||binding.versionId!==current.versionId||binding.workSha256!==current.workSha256||binding.sourceSha256!==current.sourceSha256||binding.mutationEpoch!==current.epoch)
    return blocked('source-conflict','文字检查点不属于当前稿件、版本或修改历史');
  if(plan.unknownSent||requests.blockedUnknownCount||plan.units.some(unit=>['running','unknown_sent'].includes(unit.status)))return blocked('unknown-sent','存在发送结果未知或尚在执行的请求，请先人工核对请求记录；不会自动重发');
  if(['useContext','useCases','ruleMode'].some(key=>plan.config?.[key]!==view.options[key]))return blocked('options-unconfirmed','原审阅设置与检查点不一致，请核对后再选择审阅方式');
  const primary=plan.units.filter(unit=>unit.required!==false&&!unit.parentUnitId&&Array.isArray(unit.source?.primaryRanges)&&unit.source.primaryRanges.length);
  if(!primary.length||primary.some(unit=>unit.status==='completed'&&(unit.outputReceipt?.status!=='completed'
    ||!['inputSha256','outputSha256'].every(key=>/^[a-f0-9]{64}$/.test(unit.outputReceipt?.[key]||'')))))return blocked('checkpoint-unconfirmed','文字完成凭证尚未确认，未发起补审');
  const missing=primary.filter(unit=>unit.status!=='completed');
  if(!primaryMissing)return blocked('primary-complete',visualGaps.length?'文字主任务已完成；图片、文本框或公式仍待人工处理，不会重审整份':'文字主任务已完成；其他未结束步骤须单独核对，不会自动重审整份');
  if(!missing.length)return blocked('checkpoint-conflict','文字覆盖与检查点状态尚未一致，请刷新后核对');
  return {...base,canResumeText:true,code:'missing-text',missingTasks:missing.length,
    message:'沿用原模型与审阅设置，复用已完成文字任务，仅补齐未完成部分；原运行未结束的上下文或复核步骤也可能继续'};
}
async function inspectReviewGaps(sessionId) {
  if(state.queueSupported!==true||state.workspaceError||reviewGapRequests.has(sessionId))return null;
  const item=state.queue.find(entry=>entry.id===sessionId);if(!item)return null;
  let inspectionContext=null;
  reviewGapRequests.add(sessionId);renderQueue();
  try{
    if(!await activateItem(item,{persist:false}))return null;
    const context=reviewGapContext();inspectionContext=context;
    const statusResponse=await fetch('/api/review-status?id='+encodeURIComponent(sessionId)),status=await statusResponse.json();
    if(!sameReviewGapContext(context))return null;
    if(!statusResponse.ok||status.id!==sessionId||status.reviewRunId!==context.runId)throw Error(status.error||'审阅身份已变化，请刷新后核对');
    let execution=null;
    if(status.reviewRunId){const response=await fetch('/api/review-execution?'+new URLSearchParams({id:sessionId,runId:status.reviewRunId}));const data=await response.json();if(!sameReviewGapContext(context))return null;if(!response.ok)throw Error(data.error||'文字检查点未能读取');execution=data;}
    const action=reviewGapAction({status,execution,coverage:status.result?.reviewCoverage,current:context});
    const inspection={context,status,execution,action};reviewGapInspections.set(sessionId,inspection);
    renderQueue();renderMarkupStats();$('#reviewGapDetails')?.setAttribute?.('open','');
    $('#reviewGapDetails')?.scrollIntoView?.({block:'nearest',behavior:'smooth'});toast(action.message,5500);return inspection;
  }catch(error){if(inspectionContext&&sameReviewGapContext(inspectionContext))toast('未完成项尚未确认：'+error.message,5500);return null;}
  finally{reviewGapRequests.delete(sessionId);renderQueue();}
}
async function resumeMissingReviewTasks(sessionId) {
  if(state.queueSupported!==true||state.workspaceError||reviewResumeRequests.has(sessionId)||state.streaming||state.queueRunning)return false;
  let requestContext=null;
  reviewResumeRequests.add(sessionId);renderQueue();
  try{
    const inspection=await inspectReviewGaps(sessionId);if(!inspection||!sameReviewGapContext(inspection.context))return false;
    if(!inspection.action.canResumeText){toast(inspection.action.message,5500);return false;}
    const context=inspection.context;requestContext=context;const key=JSON.stringify([context.workspaceId,sessionId,context.runId,context.versionId,context.epoch]);
    const intent=reviewResumeIntents.get(key)||{body:JSON.stringify({id:sessionId,fromRunId:context.runId,baseVersionId:context.versionId,
      baseMutationEpoch:context.epoch,operationId:newWorkOperationId(),mode:'missing-only'})};reviewResumeIntents.set(key,intent);
    const {res,response:data}=await fetchWorkMutation('/api/review-resume',intent.body,true);
    if(!sameReviewGapContext(context))return false;
    if(!res.ok){reviewResumeIntents.delete(key);toast(data.error||'补审未执行，请核对原运行设置与来源',5500);return false;}
    if(data.accepted!==true||data.id!==sessionId||data.resumedFromRunId!==context.runId||data.workVersionId!==context.versionId
      ||!/^r[a-f0-9]{64}$/.test(data.reviewRunId||'')||data.reviewRunId===context.runId)throw Error('服务器未确认此次补审身份，请刷新进度核对');
    reviewResumeIntents.delete(key);reviewGapInspections.delete(sessionId);adoptHumanContext(data);stopReveal();closeIssueDetail();
    const binding={...context,runId:data.reviewRunId,jobId:data.reviewJobId||null};startReviewObserver(binding,data);
    await refreshWorkspace();return true;
  }catch(error){if(requestContext&&sameReviewGapContext(requestContext))toast('补审结果未确认：'+error.message+'；请刷新进度，原操作身份已保留',6000);return false;}
  finally{reviewResumeRequests.delete(sessionId);renderQueue();}
}
function reviewGapLabel(gap) {
  const location=gap.target==='footnote'?'脚注':gap.target==='endnote'?'尾注':'正文';
  return `${location}原始段序 ${gap.index??'未记录'}${gap.noteId!=null?`（注释ID ${gap.noteId}）`:''}：${gap.reason==='textbox_text_not_primary'?'文本框文字未进入主文字审阅':'图片、公式或嵌入对象未完成审阅'}`;
}
function showReviewGapPosition(index) {
  const inspection=currentReviewGapInspection(),gap=inspection?.action.visualGaps[index];if(!gap)return false;
  const target=gap.target,array=target==='footnote'?state.doc?.footnotes:target==='endnote'?state.doc?.endnotes:target==='paragraph'?state.doc?.paragraphs:null,node=array?.[gap.index];
  if(state.showOriginal||!node||gap.sourcePackageSha256!==state.workVersion?.sha256||gap.sourceVersionId!==state.workVersion?.id
    ||gap.sourceXmlNodeId!==node.sourceXmlNodeId||gap.pid!==(node._pid||node.id)||gap.noteId!=null&&String(gap.noteId)!==String(node.noteId)){
    toast('该缺口的当前正文位置尚未核对，请按来源记录人工查看');return false;
  }
  const paragraph=readerBoundParagraphs(activeDocHost(),target,gap.index)[0];
  if(!paragraph){toast('该缺口的页面位置尚未证实，请按来源记录人工查看');return false;}
  paragraph.scrollIntoView({block:'center',behavior:'smooth'});toast('已显示该对象所在段落；对象内容仍待人工处理');return true;
}
function renderReviewGapPanel() {
  const box=$('#mkStats');if(!box||!state.summary)return;
  const inspection=currentReviewGapInspection(),coverage=normalizeReviewCoverageView(currentReviewCoverage()),visual=coverage.sourceCoverageGaps.filter(gap=>['unparsed_visual_content','textbox_text_not_primary'].includes(gap.reason));
  if(!inspection&&coverage.executionStatus!=='partial'&&!visual.length)return;
  const action=inspection?.action;
  box.innerHTML+=`<details id="reviewGapDetails" class="review-steps"><summary>未完成内容${visual.length?` · 图片等 ${visual.length} 项待处理`:''}</summary>
    <div class="review-step-list">${action?`<div>${esc(action.message)}</div>`:'<div>先核对当前稿件的文字检查点和等待处理内容，查看不会发起模型请求。</div>'}
    <button type="button" class="link-btn review-inspect-gaps" ${reviewGapRequests.has(state.sessionId)?'disabled':''}>查看未完成项</button>
    ${action?.canResumeText?`<button type="button" class="link-btn review-resume-missing" ${reviewResumeRequests.has(state.sessionId)||state.streaming?'disabled':''}>仅补审未完成文字任务</button>`:''}
    ${visual.map((gap,index)=>`<div>${esc(reviewGapLabel(gap))} <button type="button" class="link-btn review-gap-position" data-gap-index="${index}" ${inspection?'':'disabled'}>查看所在段落</button><details><summary>来源记录</summary><div>${esc(gap.part||'部件未记录')} · ${esc(gap.objectPath||gap.sourceXmlNodeId||'对象身份未记录')}</div></details></div>`).join('')}
    ${visual.length?'<div>这些内容等待人工核对或后续专用处理；重复审阅整份文字不会消除这类缺口。</div>':''}</div></details>`;
  box.querySelector('.review-inspect-gaps')?.addEventListener('click',()=>inspectReviewGaps(state.sessionId));
  box.querySelector('.review-resume-missing')?.addEventListener('click',()=>resumeMissingReviewTasks(state.sessionId));
  box.querySelectorAll('.review-gap-position').forEach(button=>button.addEventListener('click',()=>showReviewGapPosition(Number(button.dataset.gapIndex))));
}

function renderDocInfo() {
  const d = state.doc;
  if (!d) return;
  const m = d.meta || {};
  const st = d.stats || {};
  const originalComments = d.originalCommentCount ?? state.clean?.originalCommentCount ?? '未提供';
  const cleanStatus = cleanPresentation(state.clean);
  const authors = m.author ? esc(m.author) : '—';
  /**
   * 各级标题识别结果（需求 6）。
   *
   * 「标题一定要识别准确」这件事，光靠规则跑不跑得对是不够的 ——
   * 编辑部必须能**当场核对**：这篇稿子被认成了几级、每级几条、
   * 判据是什么。所以把识别结果直接摆出来，按层级分组，
   * 点一条就跳到正文对应位置（复用 `scrollToIssueInDoc` 的定位链路）。
   *
   * 判据来源（`source`）也显示出来，便于判断误判根源：
   *   text      文本编号形态（`一、`/`（一）`/`1.`…）—— 最权威
   *   numbering numbering.xml 的编号定义
   *   style     段落样式的 outlineLvl（含 basedOn 继承）
   *   outline   段落级 w:outlineLvl
   *   format    字号/加粗/居中启发（弱信号，仅在前几种无结论时用）
   */
  const heads = Array.isArray(d.headings) ? d.headings : [];
  const byLevel = new Map();
  for (const h of heads) {
    if (!byLevel.has(h.level)) byLevel.set(h.level, []);
    byLevel.get(h.level).push(h);
  }
  const SOURCE_LABEL = {
    text: '编号', numbering: '编号链', style: '样式', outline: '大纲级别',
    format: '字号格式', 'text-trailing-punct': '编号(带句号)',
  };
  const headingHtml = heads.length
    ? `<details class="doc-heads">
        <summary>标题结构 <b>${heads.length}</b> 条（${byLevel.size} 级）</summary>
        <div class="head-levels">${[...byLevel.keys()].sort((a, b) => a - b).map((lv) => `
          <div class="head-group">
            <div class="head-lv">第 ${lv} 级 <span class="muted">${byLevel.get(lv).length} 条</span></div>
            ${byLevel.get(lv).map((h) => `<div class="head-item" data-head-idx="${h.index}" title="判据：${esc(SOURCE_LABEL[h.source] || h.source || '未知')}｜段落 ${h.index}">
              <span class="head-src">${esc(SOURCE_LABEL[h.source] || h.source || '?')}</span>
              <span class="head-text">${esc(h.text.slice(0, 48))}</span>
            </div>`).join('')}
          </div>`).join('')}</div>
      </details>`
    : '<div class="doc-heads-none muted small">未识别到标题</div>';
  $('#docInfo').innerHTML = `<div class="doc-meta">
    <div class="doc-title" title="${esc(m.title || d.label || '未识别')}">${esc(m.title || d.label || '未识别')}</div>
    <div class="doc-grid">
      <div>栏目：<b>${esc(m.column || '未标注')}</b></div>
      <div>作者：<b>${authors}</b></div>
      <div>字数：<b>${st.chars ?? '—'}</b></div>
      <div>段落：<b>${st.paragraphs ?? '—'}</b></div>
      <div>脚注：<b>${st.footnotes ?? 0}</b></div>
      <div>尾注：<b>${st.endnotes ?? 0}</b></div>
      <div>表格：<b>${st.tables ?? 0}</b></div>
      <div>图：<b>${st.figures ?? 0}</b>${(st.images ?? 0) ? `<span class="muted">（图片 ${st.images}）</span>` : ''}</div>
      <div>引用上标：<b>${(d.footnoteRefs || []).length}</b></div>
      <div>原稿批注：<b>${esc(originalComments)}</b></div>
      <div>当前稿批注：<b>${esc(st.comments ?? '未提供')}</b></div>
    </div>
    <div class="doc-path">${esc(cleanStatus.text)}</div>
    ${state.workVersion ? `<div class="doc-path">工作稿：${state.workVersion.revision ? `第 ${state.workVersion.revision} 次保存 · ${state.appliedFixDetails.length} 处修改` : '导入版本（未修改）'}</div>` : ''}
    ${headingHtml}
    <div class="doc-path">${esc(d.label || '')}</div>
  </div>`;
  // 点标题 → 跳到正文对应位置（与问题跳转共用同一条定位链路）
  $$('#docInfo .head-item').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.headIdx);
      const host = activeDocHost();
      const p = readerBoundParagraphs(host, 'paragraph', idx)[0];
      if (!p) { toast(state.showOriginal ? '原稿尚无对应定位数据，请返回当前稿定位' : '该标题尚未准确对应当前稿'); return; }
      p.scrollIntoView({ block: 'center', behavior: 'auto' });
      p.classList.add('mk-mark-flash');
      setTimeout(() => p.classList.remove('mk-mark-flash'), 1600);
    });
  });
  initHeadingSpy();
}

/**
 * 标题结构滚动联动（C1）：滚动正文时，高亮左栏「标题结构」里当前所在的标题。
 *
 * 为什么需要：长稿有几十条各级标题，用户滚到中段后就很难在「标题结构」面板里
 * 认出「我现在读到哪一节」。做成随滚动高亮的目录，长稿导航才真正能用。
 *
 * 实现要点：
 *   · 监听滚动容器 `.doc-scroll`；打印/极窄屏它退化为 overflow:visible，
 *     此时监听 window 兜底。用 rAF 节流，避免滚动时多次强制重排。
 *   · 每次重查 `#docInfo .head-item` 与对应正文段落 —— renderDocInfo 会整体
 *     重建这份 DOM，缓存旧引用会指向已脱离文档的节点、高亮失效。
 *   · 「当前标题」取位置最靠下、且顶端已越过阅读线（容器顶 + 12px）的那条。
 *   · 高亮项若移出「标题结构」面板可视区，同步滚动面板把它带回来。
 */
let headingSpy = null;
function initHeadingSpy() {
  if (headingSpy) {
    headingSpy.scroller?.removeEventListener?.('scroll', headingSpy.onScroll);
    headingSpy = null;
  }
  const host = $('#docHost');
  if (!host || !$('#docInfo .head-item')) return;
  const scroller = document.querySelector('.doc-scroll') || window;
  let raf = 0;
  const update = () => {
    raf = 0;
    const h = $('#docHost');
    const items = $$('#docInfo .head-item');
    if (!h || !items.length) return;
    const line = (scroller === window ? 0 : scroller.getBoundingClientRect().top) + 12;
    let active = null;
    let bestTop = -Infinity;
    for (const el of items) {
      const p = readerBoundParagraphs(h, 'paragraph', Number(el.dataset.headIdx))[0];
      if (!p) continue;
      const top = p.getBoundingClientRect().top;
      if (top <= line && top > bestTop) { bestTop = top; active = el; }
    }
    for (const el of items) el.classList.toggle('head-item-active', el === active);
    if (active) {
      const box = active.closest('.head-levels');
      if (box) {
        const ab = active.getBoundingClientRect();
        const bb = box.getBoundingClientRect();
        if (ab.top < bb.top || ab.bottom > bb.bottom) {
          box.scrollTop += (ab.top - bb.top) - box.clientHeight / 2 + ab.height / 2;
        }
      }
    }
  };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  headingSpy = { scroller, onScroll };
  update();
}

function setProgress(items) {
  $('#progress').innerHTML = items.map((i) => `<div class="prog-item"><span class="prog-dot ${i.cls}"></span><span>${esc(i.text)}</span></div>`).join('');
}

/* ==================================================================
   进度条（目标点 5：全程显示进度）
   ==================================================================
   后端 progress 事件带 current/total（已完成的窗口数 / 总窗口数），
   但只有模型阶段有确定的总数；规则扫描与准备阶段没有，所以那两段
   显示「不确定进度」的循环动画，而不是假的百分比。
*/
function setProgressBar({ current = 0, total = 0, label = '' } = {}) {
  const bar = $('#progressBar');
  if (!bar) return;
  const known = total > 0;
  bar.classList.remove('hidden');
  const fill = $('#progressBarFill');
  const pct = known ? Math.min(100, Math.round((current / total) * 100)) : 0;
  fill.classList.toggle('indet', !known);
  if (known) fill.style.width = pct + '%';
  const eta = known && current > 0 && current < total
    ? ` · 约剩 ${formatEta((Date.now() - timer.start) / current * (total - current))}`
    : '';
  $('#progressBarText').innerHTML = known
    ? `<span>${esc(label || '模型审阅')} <b>${current}/${total}</b> 窗口（${pct}%）${esc(eta)}</span>`
    : `<span>${esc(label || '处理中…')}</span>`;
}

function hideProgressBar() {
  const bar = $('#progressBar');
  if (bar) bar.classList.add('hidden');
}

/** 把毫秒格式化成「X 分 Y 秒」/「Y 秒」 */
function formatEta(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}

/* ==================================================================
   视图切换
   ================================================================== */
function switchView(view) {
  if (view === 'rules' && pendingInfo) { requestCloseHumanPop(); if (pendingInfo) return; }
  // 视图精简后只剩「批阅」与「规则」两态，其余一律归到批阅
  const v = view === 'rules' ? 'rules' : 'markup';
  state.view = v;
  $$('.tab').forEach((t) => t.classList.toggle('tab-on', t.dataset.view === v));
  $('#viewMarkup').classList.toggle('hidden', v !== 'markup');
  $('#viewRules').classList.toggle('hidden', v !== 'rules');
  if (v === 'markup') renderDocument();
  else if (v === 'rules') renderRules();
}

/* ==================================================================
   文档渲染（视图精简后，批阅视图是唯一的文档宿主）
   ================================================================== */
/** 只在换稿件、切换「原文/清洗稿」、或首次进入时重渲 */
const rendered = { markup: null };
let documentRenderSeq = 0;
const readerDocumentBindings = new WeakMap();
const readerNodeBindings = new WeakMap();
// Private AST ownership is required for displayed characters whose source raw
// value differs. Public dataset fields alone never license a substitution.
const readerCharacterBindings = new WeakMap();
const docxExportOwners = new WeakMap();
let readerAnnotationSeq = 0;

/** 取回已保存的当前稿字节；请求期间切稿时不写入新稿件的状态。 */
async function loadWorkingVersion(sessionId, workVersion) {
  const activationSerial = state.activationSerial;
  const context = workspaceContext();
  const res = await fetch('/api/session-file?id=' + encodeURIComponent(sessionId));
  if (!res.ok) throw new Error('当前稿获取失败');
  const returnedVersionId = res.headers?.get('X-Work-Version') || null;
  if (workVersion?.id && returnedVersionId !== workVersion.id) {
    throw new Error('当前稿版本已变化，请刷新页面恢复');
  }
  const buffer = await res.arrayBuffer();
  if (!sameWorkspaceContext(context) || state.sessionId !== sessionId || state.activationSerial !== activationSerial) return false;
  state.buffer = buffer;
  state.workVersion = workVersion || null;
  rendered.markup = null;
  syncHistoryControls();
  return true;
}

function documentRenderSignature() {
  const version = state.workVersion;
  const source = state.showOriginal ? 'orig' : `work:${version?.id || ''}:${version?.revision ?? ''}:${version?.sha256 || ''}`;
  return `${state.sessionId}|${source}|${state.showMarks ? 1 : 0}`;
}

/** 当前应渲染的字节流：原文视图用原稿，否则用清洗稿 */
function currentBuffer() {
  return (state.showOriginal && state.originalBuffer) ? state.originalBuffer : state.buffer;
}

async function renderDocument(force = false) {
  const host = $('#docHost');
  if (!host) return;
  const buf = currentBuffer();
  if (!buf) {
    documentRenderSeq += 1;
    rendered.markup = null;
    host.innerHTML = `<div class="empty">${state.sessionId ? '当前稿预览尚未载入，请刷新页面恢复。' : '导入稿件后，正文会显示在这里。'}</div>`;
    readerDocumentBindings.delete(host);
    renderMarkupStats();
    return;
  }
  const sig = documentRenderSignature();
  if (!force && rendered.markup === sig && host.querySelector('.docx-wrapper')) return;
  const renderSeq = ++documentRenderSeq;
  const sessionId = state.sessionId;
  const stagingHost = document.createElement('div');
  host.innerHTML = '<div class="empty">正在渲染文档…</div>';
  readerDocumentBindings.delete(host);
  renderMarkupStats();
  try {
    await renderDocx(stagingHost, { buffer: buf });
    if (state.sessionId !== sessionId || renderSeq !== documentRenderSeq || documentRenderSignature() !== sig) return;
    host.replaceChildren(...stagingHost.childNodes);
    const readerBinding = readerDocumentBindings.get(stagingHost);
    if (readerBinding) readerDocumentBindings.set(host, readerBinding);
    rendered.markup = sig;
    /**
     * 渲染完成后做「阅读器增强」：
     *   ① 给标题段打层级标记（需求 1：各级标题要能识别出来）；
     *   ② 给正文上标与文末注释建立双向跳转 + 悬停预览（需求 2/3）。
     * 原文视图下问题锚点是按**清洗稿**算的，对不上，所以不划问题线、不标层级。
     */
    if (state.showOriginal) {
      // 原文视图保留原稿样貌（供核对作者原稿），不做格式归一
      host.classList.remove('mk-clean');
      // 原稿保真渲染；当前稿 DTO 无法证明原稿节点，不借它补图、标题或标注。
      indexRenderedParagraphs(host);
    } else {
      /**
       * 统一阅读格式（需求：字体字号固定、不沿用原稿格式）。
       *
       * 两步走：
       *   ① `normalizeReaderFormatting` 在内联层剥掉原稿的**加粗 / 下划线 /
       *      高亮 / 颜色 / 字体 / 字号 / 行距 / 缩进**（保留斜体与上标）；
       *   ② styles.css 的 `.mk-clean` 排版层按刊例统一字体与版式。
       * 必须在 `highlightIssuesInDoc` 之前跑 —— 之后生成的 mk-mark 等是
       * 我们自己的标记，不应被当作原稿格式剥掉。
       */
      host.classList.add('mk-clean');
      normalizeReaderFormatting(host);
      indexRenderedParagraphs(host);
      replayAppliedFixes(host);
      // 先由 highlightIssuesInDoc 标注 data-pindex 并划线，再据它标标题层级
      highlightIssuesInDoc();
      renderMarkupIssues();
      markHeadingLevels();
      markTitleParagraph(host);
      wireCitations();
      /**
       * 回放人工圈画：`.human-mark` 只存在于 DOM，重渲（切原文、换稿）后会被抹掉，
       * 而审计日志里已经记下了。这里按记录把标注重新画回正文，避免「我标的东西没了」。
       */
      reapplyHumanMarks();
      // 图片最后补：它依赖上面标好的 data-pindex，且不该被格式归一误伤
      renderFigures(host);
    }
    renderMarkupStats();
  } catch (e) {
    if (state.sessionId !== sessionId || renderSeq !== documentRenderSeq || documentRenderSignature() !== sig) return;
    host.innerHTML = `<div class="empty">文档渲染失败：${esc(e.message)}</div>`;
    readerDocumentBindings.delete(host);
    renderMarkupStats();
  }
  // 渲染完文档骨架后再挂「标题结构滚动联动」（此时正文段落才存在）
  initHeadingSpy();
}

/**
 * 阅读器格式归一化（清洗稿）：剥掉原稿自带的**视觉格式**，交给统一排版层。
 *
 * ── 为什么在这一层做，而不是改字节流 ──
 * 规则引擎读的是**原始解析结果**（`src/docx.js` 的 doc），与渲染用的字节流
 * 是两条线；改字节流会同时影响「导出批注 Word」等下游，且需要重写 OOXML。
 * 这里只在**渲染后的 DOM** 上剥格式，既不影响审阅、也不改动导出。
 *
 * ── 剥什么、留什么 ──
 * 剥：加粗(font-weight)、下划线/删除线(text-decoration)、高亮(background*)、
 *     字色(color)、字体(font-family)、字号(font-size)、行距(line-height)、
 *     缩进与段距(text-indent/margin)——这些由版式层统一。
 * 留：斜体(font-style，刊例西文书名用斜体)、上标(vertical-align)、
 *     对齐(text-align，篇名/图表标题的居中是有意义的信息)。
 * 另把 `<b>/<strong>/<u>/<s>/<mark>` 这类纯表现标签**解包**（保留文字）。
 */
const READER_DROP_STYLE = /^(font|font-weight|font-family|font-size|color|background|background-color|background-image|background-position|background-repeat|text-decoration|text-decoration-line|text-decoration-color|text-decoration-style|text-shadow|line-height|text-indent|margin|margin-top|margin-bottom|margin-left|margin-right|margin-block|margin-inline|letter-spacing|-webkit-text-stroke|-webkit-text-stroke-width)$/;
const READER_UNWRAP = 'b,strong,u,s,strike,mark,font';

function normalizeReaderFormatting(host) {
  const content = host.querySelector('.docx-wrapper');
  if (!content) return null;
  let stripped = 0;
  for (const el of content.querySelectorAll('[style]')) {
    const raw = el.getAttribute('style') || '';
    const kept = [];
    for (const decl of raw.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      if (!prop) continue;
      if (READER_DROP_STYLE.test(prop)) { stripped += 1; continue; }
      kept.push(decl.trim());
    }
    if (kept.length) el.setAttribute('style', kept.join('; '));
    else el.removeAttribute('style');
  }
  let unwrapped = 0;
  for (const el of [...content.querySelectorAll(READER_UNWRAP)]) {
    // 我们自己加的标记（下划线/人工圈画/引文）绝不解包
    if (el.closest('.mk-mark,.human-mark,.cite-ref,.cite-note,.h-level')) continue;
    const parent = el.parentNode;
    if (!parent) continue;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    unwrapped += 1;
  }
  return { stripped, unwrapped };
}

/** 给「篇名」段打标记，使它在统一版式下仍大于各级标题（刊例：篇名最大） */
function markTitleParagraph(host) {
  const title = (state.doc && state.doc.meta && state.doc.meta.title || '').trim();
  if (!title || title.length < 4) return;
  const candidates = (state.doc.paragraphs || []).map((node, index) => ({node, index}))
    .filter(({node}) => normText(node.text) === normText(title));
  if (candidates.length !== 1) return;
  for (const p of readerBoundParagraphs(host, 'paragraph', candidates[0].index)) p.classList.add('rd-title');
}

/**
 * 稿件内嵌图片与图注的**后处理补齐**。
 *
 * 现状（实测）：docx-preview **会**渲染 `w:drawing` / `w:pict`，把图片变成
 * `<img src="data:…">`；但**会漏掉**两类内容 ——
 *   ① 落在修订标记（`w:moveTo` 等）里的图片；
 *   ② 图注段落（也常因落在修订里而被整段丢掉）。
 * 解析层已把每个 figure 的 `media[]`（ZIP 内条目名 / 外链 URL）与相邻图注
 * 下发，这里做两件事：
 *   · 把渲染器**漏掉**的图片补进 DOM（渲染器已画的不重复插入）；
 *   · 把图注显示出来（渲染器已排出来的加样式，被丢掉的用解析结果补 figcaption）。
 *
 * ── 为什么按「最近的有下标段落」定位 ──
 * `indexRenderedParagraphs` 只给**有文本**的段落写 `data-pindex`（空段跳过），
 * 而图片段落的文本通常是空的（图不产生文本）。所以找不到 `p[data-pindex=i]`
 * 时，退化为插到**后一个（优先）/ 前一个**有下标的段落旁边 —— 那个位置
 * 正好是图片段落在 DOM 里的位置（空段夹在中间），视觉顺序与 Word 一致。
 */
function figMediaUrl(m) {
  if (!m) return '';
  if (m.external) return m.path || '';
  return '/api/session-media?id=' + encodeURIComponent(state.sessionId || '')
    + '&name=' + encodeURIComponent(m.path || '');
}

/** 图注判据：以「图1 / 图 1 / 表1 / Figure 1 / Fig. 1 / 图一」开头 */
const FIG_CAPTION_RE = /^\s*(图|表|Figure|Fig\.?|Photo|Chart)\s*[0-9一二三四五六七八九十百]+/i;

function renderFigures(host) {
  const content = host && host.querySelector('.docx-wrapper');
  if (!content || !state.doc || state.showOriginal) return 0;
  const paras = state.doc.paragraphs || [];
  // ① 解析层：本稿所有「有图段落」及其媒体条目（文档顺序）
  const plan = [];
  for (let i = 0; i < paras.length; i += 1) {
    const items = [];
    for (const g of (paras[i].figures || [])) {
      const ms = (g.media || []).filter((m) => m && m.path);
      ms.forEach((m, idx) => {
        // 图上带的 EMU 显示尺寸（`wp:extent`）—— 给 <img> 定尺寸，
        // 既按 Word 里的显示大小还原，又预留版面、避免加载时的跳动。
        const ex = (g.extents || [])[idx] || (g.extents || [])[0] || null;
        items.push({ m, cx: (ex && ex.cx) || 0, cy: (ex && ex.cy) || 0 });
      });
    }
    if (items.length) plan.push({ i, items });
  }
  if (!plan.length) return 0;

  /**
   * ② docx-preview **会**渲染 `w:drawing` / `w:pict`（见其 `renderDrawing`
   *    / `renderImage` / `renderVmlPicture`），把图片变成 `<img src="data:…">`。
   *    本函数是渲染**之后**的后处理 —— 若无脑再插一遍，同一张图会出现
   *    **两次**（实测一篇 8 图稿会变成 16 张）。所以先把它渲染出的图片按
   *    文档顺序取出，与解析层**逐张**配对：
   *      · 渲染器已经给了 → 不重复插入，只在需要时补图注；
   *      · 渲染器漏掉了   → 由我们补出来（保底，杜绝「图片直接消失」）。
   *    `img:not(.rd-img)` 排除我们上一轮插入的，避免自我复制。
   */
  let added = 0;
  for (const job of plan) {
    const instances = readerBoundParagraphs(host, 'paragraph', job.i);
    if (!instances.length) continue;
    // Media belong to this proven physical paragraph, never a global image cursor.
    if (instances.every(p => p.querySelectorAll('img:not(.rd-img)').length >= job.items.length)) {
      for (const anchor of instances) addFigureCaption(host, anchor, paras, job.i);
      continue;
    }
    // A partially rendered media group cannot prove which item is missing.
    if (instances.some(p => p.querySelectorAll('img:not(.rd-img)').length)) continue;
    if (content.querySelector(`[data-fig-for="${job.i}"]`)) continue;
    const anchor = nearestIndexed(host, paras, job.i);
    if (!anchor) continue;
    const fig = document.createElement('figure');
    fig.className = 'rd-figure';
    fig.setAttribute('data-fig-for', String(job.i));
    for (const it of job.items) fig.appendChild(buildFigureImg(it));
    if (anchor.where === 'after') anchor.node.insertAdjacentElement('afterend', fig);
    else anchor.node.insertAdjacentElement('beforebegin', fig);
    addFigureCaption(host, fig, paras, job.i);
    added += 1;
  }
  return added;
}

/** Only the uniquely proven image paragraph can be an insertion site. */
function nearestIndexed(content, paras, i) {
  const self = readerBoundParagraphs(content, 'paragraph', i);
  return self.length === 1 ? { node: self[0], where: 'after' } : null;
}

/** 构造一个内嵌图片元素（EMU → px；加载失败落到占位样式） */
function buildFigureImg(it) {
  const m = it.m;
  const img = document.createElement('img');
  img.className = 'rd-img';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '稿件插图';
  // EMU → px（1 英寸 = 914400 EMU，96 dpi → 1px = 9525 EMU）
  if (it.cx > 0 && it.cy > 0) {
    img.width = Math.max(1, Math.round(it.cx / 9525));
    img.height = Math.max(1, Math.round(it.cy / 9525));
  }
  img.src = figMediaUrl(m);
  img.addEventListener('error', () => {
    img.classList.add('rd-img-fail');
    img.alt = '图片无法显示' + (m.ext ? `（${m.ext}）` : '');
  });
  return img;
}

/**
 * 给图片配图注（刊例：图注在图下方居中、小一号）。
 *
 * 图注常落在 `w:moveTo` / 修订标记里，而 docx-preview **不渲染这类内容**
 * （实测 `01-孟捷…【0818一审】`：图注「图2  基本经济制度的二元结构」在 XML 里
 * 存在、解析器也抽到了，渲染出的 DOM 却是**空 `<p>`**）。只加样式会让图注
 * **整条消失**，所以两路兜底：
 *   · 渲染器已经渲染出这一句 → 直接上图注样式（避免重复显示）；
 *   · 渲染器把它丢了 → 把解析结果补成 `<figcaption>`。
 * `anchorEl` 既可能是我们自己插的 `<figure>`，也可能是渲染器画的那张图的
 * `<p>`：前者就地追加 figcaption，后者在其后插一个只含图注的小 figure。
 */
function addFigureCaption(content, anchorEl, paras, i) {
  let hit = null;
  for (const k of [i + 1, i - 1]) {
    if (k < 0 || k >= paras.length) continue;
    const t = (paras[k].text || '').trim();
    if (t && FIG_CAPTION_RE.test(t)) { hit = { text: t, k }; break; }
  }
  if (!hit) return;
  // A missing caption is not proof of an insertion site. Style only its own node.
  for (const existing of readerBoundParagraphs(content, 'paragraph', hit.k)) existing.classList.add('rd-figcap');
}

/**
 * 调用 docx-preview 渲染。
 * 该库按 UMD 全局暴露 window.docx（HTML 里用 <script> 引入）。
 */
function renderDocx(host, opts = {}) {
  const lib = window.docx;
  if (!lib || typeof lib.renderAsync !== 'function') {
    return Promise.reject(new Error('docx-preview 未加载（检查 /node_modules/docx-preview 是否存在）'));
  }
  const options = {
    className: 'docx',
    inWrapper: true,
    ignoreWidth: false,
    ignoreHeight: true,
    breakPages: false,
    ignoreLastRenderedPageBreak: true,
    renderFootnotes: true,
    renderEndnotes: true,
    renderHeaders: !!opts.renderHeaders,
    renderFooters: !!opts.renderFooters,
    renderFootersFirstPage: false,
    useBase64URL: true,
  };
  // Capture independent bytes: ArrayBuffer is mutable, so never reuse a cached
  // hash of the caller's buffer. Digest and parse exactly this render snapshot.
  const input = opts.buffer || currentBuffer();
  const buffer = typeof input?.slice === 'function' ? input.slice(0) : input;
  const binding = { sessionId: state.sessionId, versionId: state.workVersion?.id || null,
    activationSerial: state.activationSerial, workspaceId: state.workspaceId, original: !!state.showOriginal,
    doc: state.doc, expectedPackageSha256: state.doc?.sourcePackageSha256 || null,
    versionPackageSha256: state.workVersion?.sha256 || null, packageSha256: null, sourceProven: false };
  // The installed renderer exposes no note ID on its <li> or <sup>. Annotate its
  // fresh in-memory model before rendering; source bytes and review DTOs stay intact.
  if (typeof lib.parseAsync === 'function' && typeof lib.renderDocument === 'function') {
    return (async () => {
      const cryptoApi = window.crypto || globalThis.crypto;
      if (cryptoApi?.subtle && buffer && typeof buffer === 'object') {
        const hash = await cryptoApi.subtle.digest('SHA-256', buffer);
        binding.packageSha256 = [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
      }
      binding.sourceProven = !binding.original && /^[a-f0-9]{64}$/.test(binding.packageSha256 || '')
        && binding.packageSha256 === binding.expectedPackageSha256 && binding.packageSha256 === binding.versionPackageSha256;
      const parsed = await lib.parseAsync(buffer, options);
      const metadata = prepareReaderNotes(parsed, binding);
      const nodes = await lib.renderDocument(parsed, options);
      if (!readerContextMatches(binding)) return parsed;
      host.replaceChildren(...nodes);
      stampReaderNotes(host, metadata, binding);
      return parsed;
    })();
  }
  return lib.renderAsync(buffer, host, null, options).then((parsed) => {
    readerDocumentBindings.set(host, { ...binding, noteProblems: new Map() });
    return parsed;
  });
}

function readerBindingMatches(binding) {
  return readerContextMatches(binding) && binding.sourceProven !== false;
}

function readerContextMatches(binding) {
  return !!binding && binding.sessionId === state.sessionId
    && binding.versionId === (state.workVersion?.id || null)
    && binding.activationSerial === state.activationSerial && binding.workspaceId === state.workspaceId
    && binding.original === !!state.showOriginal && binding.doc === state.doc
    && binding.expectedPackageSha256 === (state.doc?.sourcePackageSha256 || null)
    && binding.versionPackageSha256 === (state.workVersion?.sha256 || null);
}

/** Identity markers come from the current DOCX renderer model, never fuzzy text. */
function prepareReaderNotes(parsed, binding) {
  binding.sourceIndex = new Map();
  binding.tableParagraphs = new Map();
  for (const [target, list] of [['paragraph', binding.doc?.paragraphs], ['footnote', binding.doc?.footnotes], ['endnote', binding.doc?.endnotes]]) {
    (list || []).forEach((node, index) => {
      if (!binding.sourceIndex.has(node.sourceXmlNodeId)) binding.sourceIndex.set(node.sourceXmlNodeId, []);
      binding.sourceIndex.get(node.sourceXmlNodeId).push({ target, node, index });
      if (target === 'paragraph' && node.sourceXmlTableNodeId) {
        if (!binding.tableParagraphs.has(node.sourceXmlTableNodeId)) binding.tableParagraphs.set(node.sourceXmlTableNodeId, []);
        binding.tableParagraphs.get(node.sourceXmlTableNodeId).push(node);
      }
    });
  }
  const prefix = `dsh-reader-${++readerAnnotationSeq}-`;
  const paragraphs = [], references = [], bodyParagraphs = [], tables = [], characters = [], noteProblems = new Map();
  let serial = 0;
  const mark = (node) => { const token = prefix + serial++; node.className = [node.className, token].filter(Boolean).join(' '); return token; };
  const characterNodes = paragraph => {
    const visit = node => { for (const child of node.children || []) {
      if (child.type === 'paragraph') continue; // Nested textboxes own different XML paragraphs.
      if (['tab', 'noBreakHyphen'].includes(child.type) && child.dshSourceCharacter && typeof child.dshSourceCharacter === 'object') {
        characters.push({ ...child.dshSourceCharacter, token: mark(child) });
      }
      visit(child);
    } }; visit(paragraph);
  };
  const paragraphNodes = (children) => {
    const out = [];
    const walkTable = (node) => { for (const child of node.children || []) {
      if (child.type === 'paragraph') out.push(child); else walkTable(child);
    } };
    for (const child of children || []) {
      if (child.type === 'paragraph') out.push(child);
      else if (child.type === 'table') walkTable(child);
    }
    return out;
  };
  for (const kind of ['footnote', 'endnote']) {
    const notes = parsed?.[kind + 'sPart']?.notes || [];
    const counts = new Map();
    for (const note of notes) counts.set(String(note.id), (counts.get(String(note.id)) || 0) + 1);
    for (const note of notes) {
      const noteId = String(note.id ?? '');
      if (!noteId || /separator/i.test(note.noteType || '') || noteId === '-1' || noteId === '0') continue;
      if (counts.get(noteId) !== 1) {
        noteProblems.set(`${kind}:${noteId}`, '原稿中同一注释身份存在歧义，不能猜测位置');
        continue;
      }
      const nodes = paragraphNodes(note.children);
      nodes.forEach((node, ordinal) => {
        paragraphs.push({ token: mark(node), kind, noteId, ordinal, count: nodes.length,
          part: node.part, sourceXmlNodeId: node.sourceXmlNodeId, sourceXmlParagraphOrdinal: node.sourceXmlParagraphOrdinal });
        characterNodes(node);
      });
    }
  }
  const occurrences = new Map();
  const paragraphOccurrences = new WeakMap();
  const visit = (parent, owner = null) => {
    if (parent?.type === 'paragraph') owner = parent;
    (parent?.children || []).forEach((child, index) => {
      const kind = child.type === 'footnoteReference' ? 'footnote' : child.type === 'endnoteReference' ? 'endnote' : null;
      if (kind) {
        const noteId = String(child.id ?? '');
        const key = `${kind}:${noteId}`;
        const occurrence = occurrences.get(key) || 0;
        occurrences.set(key, occurrence + 1);
        const wrapper = { type: 'run', children: [child] };
        const referenceOrdinal = owner ? paragraphOccurrences.get(owner) || 0 : -1;
        if (owner) paragraphOccurrences.set(owner, referenceOrdinal + 1);
        references.push({ token: mark(wrapper), kind, noteId, occurrence, referenceOrdinal,
          part: owner?.part, sourceXmlNodeId: owner?.sourceXmlNodeId, sourceXmlParagraphOrdinal: owner?.sourceXmlParagraphOrdinal });
        parent.children[index] = wrapper;
      } else visit(child, owner);
    });
  };
  visit(parsed?.documentPart?.body);
  // Only business body/table paragraphs: never descend through runs/drawings into textboxes.
  const body = (children) => { for (const child of children || []) {
    if (child.type === 'paragraph') {
      bodyParagraphs.push({token: mark(child), part: child.part,
        sourceXmlNodeId: child.sourceXmlNodeId, sourceXmlParagraphOrdinal: child.sourceXmlParagraphOrdinal});
      characterNodes(child);
    }
    else if (child.type === 'table') {
      tables.push({token: mark(child), part: child.part, sourceXmlNodeId: child.sourceXmlNodeId, sourceXmlTableOrdinal: child.sourceXmlTableOrdinal});
      const cells = node => { for (const c of node.children || []) {
        if (c.type === 'cell') body(c.children); else cells(c);
      } }; cells(child);
    }
  } }; body(parsed?.documentPart?.body?.children);
  return { paragraphs, references, bodyParagraphs, tables, characters, noteProblems, binding };
}

function stampReaderNotes(host, metadata, binding) {
  const context = { ...binding, noteProblems: metadata.noteProblems };
  readerDocumentBindings.set(host, context);
  const instances = new Map();
  const stamp = (element, record) => {
    readerNodeBindings.set(element, { ...binding, source: record });
    Object.assign(element.dataset, { noteKind: record.kind, noteId: record.noteId,
      readerSession: String(binding.sessionId || ''), readerVersion: String(binding.versionId || ''),
      readerActivation: String(binding.activationSerial ?? ''), readerWorkspace: String(binding.workspaceId || ''),
      readerPackage: String(binding.packageSha256 || ''), readerXmlNode: record.sourceXmlNodeId || '' });
  };
  for (const record of metadata.bodyParagraphs || []) for (const p of host.querySelectorAll('p.' + record.token)) {
    readerNodeBindings.set(p, { ...binding, source: record });
    p.dataset.readerXmlNode = record.sourceXmlNodeId || '';
    p.dataset.readerPackage = String(binding.packageSha256 || '');
    p.dataset.readerWorkspace = String(binding.workspaceId || '');
  }
  for (const record of metadata.tables || []) for (const table of host.querySelectorAll('table.' + record.token)) {
    readerNodeBindings.set(table, { ...binding, source: record });
    table.dataset.readerXmlNode = record.sourceXmlNodeId || '';
    table.dataset.readerPackage = String(binding.packageSha256 || '');
    table.dataset.readerVersion = String(binding.versionId || '');
  }
  for (const record of metadata.paragraphs) for (const p of host.querySelectorAll('p.' + record.token)) {
    stamp(p, record);
    p.dataset.noteOrdinal = String(record.ordinal);
    p.dataset.noteParagraphCount = String(record.count);
    const li = renderedNoteContainer(p);
    if (li) {
      if (!instances.has(li)) instances.set(li, String(instances.size));
      stamp(li, record);
      p.dataset.renderInstance = instances.get(li);
      li.dataset.renderInstance = instances.get(li);
    }
  }
  for (const record of metadata.references) for (const element of host.querySelectorAll('span.' + record.token)) {
    const sup = element.querySelector('sup');
    if (!sup) continue;
    stamp(sup, record);
    sup.dataset.referenceOccurrence = String(record.occurrence);
  }
  for (const record of metadata.characters || []) for (const element of host.querySelectorAll('span.' + record.token)) {
    readerCharacterBindings.set(element, { ...binding, character: record });
    Object.assign(element.dataset, { readerCharacterKind: record.kind || '', readerCharacterId: record.characterNodeId || '',
      readerXmlNode: record.paragraphNodeId || '', readerPackage: binding.packageSha256 || '', readerVersion: binding.versionId || '' });
  }
}

function renderedNoteContainer(paragraph) {
  const li = paragraph.closest?.('li');
  return li?.parentElement?.tagName === 'OL' && li.parentElement.parentElement?.tagName === 'SECTION' ? li : null;
}

function indexReaderNotes(host) {
  const context = readerDocumentBindings.get(host);
  if (!readerBindingMatches(context)) return;
  const notes = new Map();
  for (const [kind, list] of [['footnote', state.doc?.footnotes], ['endnote', state.doc?.endnotes]]) {
    (list || []).forEach((p, index) => {
      if (p.isNoteSeparator || p.noteId == null || String(p.noteId) === '-1' || String(p.noteId) === '0') return;
      const key = `${kind}:${p.noteId}`;
      if (!notes.has(key)) notes.set(key, []);
      notes.get(key).push({ p, index, pid: String(p._pid || p.id || '') });
    });
  }
  for (const li of host.querySelectorAll('section > ol > li')) {
    const key = `${li.dataset.noteKind}:${li.dataset.noteId}`;
    const source = notes.get(key);
    const ps = readerNoteParagraphs(li);
    const valid = source?.length && !context.noteProblems.has(key)
      && ps.length === source.length && source.every(x => x.pid)
      && new Set(source.map(x => x.pid)).size === source.length
      && ps.every((p, ordinal) => readerBindingMatches(readerNodeBindings.get(p))
        && p.dataset.noteKind === li.dataset.noteKind && p.dataset.noteId === li.dataset.noteId
        && Number(p.dataset.noteOrdinal) === ordinal && Number(p.dataset.noteParagraphCount) === source.length
        && readerPhysicalMatches(readerNodeBindings.get(p)?.source, source[ordinal].p, context)
        && readerSourceProjection(p)?.sourceRaw === source[ordinal].p.text);
    if (!valid) continue;
    ps.forEach((p, ordinal) => {
      const item = source[ordinal];
      p.dataset[li.dataset.noteKind === 'endnote' ? 'eindex' : 'findex'] = String(item.index);
      p.dataset.notePid = item.pid;
    });
  }
}

function readerNoteTarget(paragraph) {
  const binding = readerNodeBindings.get(paragraph);
  if (!readerBindingMatches(binding)) return null;
  const kind = paragraph.dataset.noteKind;
  const index = Number(kind === 'endnote' ? paragraph.dataset.eindex : paragraph.dataset.findex);
  const node = (kind === 'endnote' ? state.doc?.endnotes : kind === 'footnote' ? state.doc?.footnotes : null)?.[index];
  return node && Number.isInteger(index) && !node.isNoteSeparator
    && String(node.noteId) === paragraph.dataset.noteId && String(node._pid || node.id || '') === paragraph.dataset.notePid
    && readerPhysicalMatches(binding.source, node, binding)
    && readerSourceProjection(paragraph)?.sourceRaw === node.text ? { target: kind, index } : null;
}

function readerNoteParagraphs(container) {
  return [...container.querySelectorAll('p')].filter(p => readerNodeBindings.get(p)?.source?.kind === container.dataset.noteKind);
}

function readerParagraphText(paragraph) {
  let text = '';
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest?.('p') !== paragraph) continue;
    const reference = node.parentElement?.closest?.('sup[data-note-kind]');
    if (!reference || !readerReferenceMatches(reference)) text += node.textContent || '';
  }
  return text;
}

function readerRawBoundary(text, offset) {
  return Number.isInteger(offset) && offset >= 0 && offset <= text.length
    && !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]));
}

/** Prove the entire source raw UTF-16 view against the actual rendered view.
 * Only independently identified XML characters may change their display glyph.
 * Every other unit, including ordinary U+2003/U+2011, stays literal. */
function readerSourceProjection(paragraph) {
  const binding = readerNodeBindings.get(paragraph), identity = binding?.source;
  if (!readerBindingMatches(binding) || binding.original) return null;
  const owners = binding.sourceIndex?.get(identity?.sourceXmlNodeId) || [];
  const source = owners.length === 1 ? owners[0].node : null;
  if (!readerPhysicalMatches(identity, source, binding) || typeof source.text !== 'string') return null;
  if (source.sourceCharacters != null && !Array.isArray(source.sourceCharacters)) return null;
  const expected = new Map(), offsets = new Set();
  for (const c of source.sourceCharacters || []) {
    const rawText = c.kind === 'tab' ? '\t' : c.kind === 'noBreakHyphen' ? '-' : null;
    const displayText = c.kind === 'tab' ? '\u2003' : c.kind === 'noBreakHyphen' ? '\u2011' : null;
    if (!rawText || c.schemaVersion !== 1 || c.part !== source.part || c.paragraphNodeId !== source.sourceXmlNodeId
      || c.sourceXmlParagraphOrdinal !== source.sourceXmlParagraphOrdinal || c.textView !== 'after' || c.offsetUnit !== 'utf16'
      || !Number.isInteger(c.sourceXmlCharacterOrdinal) || c.sourceXmlCharacterOrdinal < 0
      || c.characterNodeId !== `${c.part}:xml-${c.kind}:${c.sourceXmlCharacterOrdinal}`
      || c.rawText !== rawText || c.displayText !== displayText
      || !readerRawBoundary(source.text, c.rawStart) || c.rawEnd !== c.rawStart + rawText.length
      || source.text.slice(c.rawStart, c.rawEnd) !== rawText
      || expected.has(c.characterNodeId) || offsets.has(c.rawStart)) return null;
    expected.set(c.characterNodeId, c); offsets.add(c.rawStart);
  }
  const units = [], used = new Set(), characterText = new Map();
  let sourceRaw = '', displayText = '';
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest?.('p') !== paragraph) continue;
    const reference = node.parentElement?.closest?.('sup[data-note-kind]');
    if (reference && readerReferenceMatches(reference)) continue;
    let element = node.parentElement, characterBinding = null;
    while (element && element !== paragraph) {
      if (readerCharacterBindings.has(element)) { characterBinding = readerCharacterBindings.get(element); break; }
      element = element.parentElement;
    }
    const text = node.textContent || '';
    if (characterBinding) {
      const actual = characterBinding.character, c = expected.get(actual?.characterNodeId);
      if (!readerBindingMatches(characterBinding) || !c || !['schemaVersion', 'kind', 'part', 'paragraphNodeId',
        'sourceXmlParagraphOrdinal', 'characterNodeId', 'sourceXmlCharacterOrdinal', 'rawText', 'displayText', 'textView', 'offsetUnit']
        .every(key => actual[key] === c[key])) return null;
      characterText.set(element, (characterText.get(element) || '') + text);
      if (!text) continue;
      if (text !== c.displayText || sourceRaw.length !== c.rawStart || used.has(c.characterNodeId)) return null;
      used.add(c.characterNodeId);
      units.push({ node, offset: 0, sourceStart: c.rawStart, sourceEnd: c.rawEnd,
        displayStart: displayText.length, displayEnd: displayText.length + text.length, kind: c.kind, characterNodeId: c.characterNodeId });
      sourceRaw += c.rawText; displayText += text;
    } else {
      for (let offset = 0; offset < text.length; offset += 1) {
        units.push({ node, offset, sourceStart: sourceRaw.length, sourceEnd: sourceRaw.length + 1,
          displayStart: displayText.length, displayEnd: displayText.length + 1, kind: 'literal' });
        sourceRaw += text[offset]; displayText += text[offset];
      }
    }
  }
  if (sourceRaw !== source.text || used.size !== expected.size) return null;
  for (const [element, text] of characterText) if (element.textContent !== text || text !== readerCharacterBindings.get(element).character.displayText) return null;
  return { sourceRaw, displayText, units, source, binding };
}

function readerProjectionRange(projection, start, end) {
  if (!projection || !readerRawBoundary(projection.sourceRaw, start) || !readerRawBoundary(projection.sourceRaw, end) || end <= start) return null;
  const units = projection.units.filter(unit => unit.sourceStart >= start && unit.sourceEnd <= end);
  if (!units.length || units[0].sourceStart !== start || units.at(-1).sourceEnd !== end
    || units.some((unit, i) => i && unit.sourceStart !== units[i - 1].sourceEnd)) return null;
  return units;
}

/** Wrap within each text node, preserving private XML-character/style owners.
 * Cross-node extractContents would clone those owners and lose their proof. */
function readerWrapProjection(paragraph, projection, start, end, build) {
  const units = readerProjectionRange(projection, start, end);
  if (!units) return [];
  const chunks = [];
  for (const unit of units) {
    const last = chunks.at(-1);
    if (last?.node === unit.node && last.end === unit.offset) last.end = unit.offset + 1;
    else chunks.push({ node: unit.node, start: unit.offset, end: unit.offset + 1 });
  }
  const spans = [];
  for (const chunk of chunks.reverse()) {
    try {
      const range = document.createRange();
      range.setStart(chunk.node, chunk.start); range.setEnd(chunk.node, chunk.end);
      const frag = range.extractContents(), span = build();
      readerNodeBindings.set(span, readerNodeBindings.get(paragraph));
      span.appendChild(frag); range.insertNode(span); spans.push(span);
    } catch { /* Unsupported DOM boundaries remain unmarked. */ }
  }
  return spans;
}

function readerReferenceMatches(reference) {
  const binding = readerNodeBindings.get(reference), source = binding?.source;
  if (!readerBindingMatches(binding) || source?.part !== 'document.xml') return false;
  const owners = binding.sourceIndex?.get(source.sourceXmlNodeId) || [];
  const ref = owners.length === 1 && owners[0].target === 'paragraph'
    && readerPhysicalMatches(source, owners[0].node, binding) && owners[0].node.noteRefs?.[source.referenceOrdinal];
  return !!ref && ref.kind === source.kind && String(ref.id) === source.noteId;
}

function readerPhysicalMatches(source, node, binding) {
  return !!source && !!node && !!(node._pid || node.id)
    && node.textView === 'after' && node.offsetUnit === 'utf16'
    && node.paragraphIndexOwner === 'application-paragraph-index'
    && ['document.xml', 'footnotes.xml', 'endnotes.xml'].includes(source.part)
    && source.part === node.part && Number.isInteger(source.sourceXmlParagraphOrdinal)
    && source.sourceXmlParagraphOrdinal === node.sourceXmlParagraphOrdinal
    && source.sourceXmlNodeId === `${source.part}:xml-p:${source.sourceXmlParagraphOrdinal}`
    && source.sourceXmlNodeId === node.sourceXmlNodeId
    && binding.sourceIndex?.get(source.sourceXmlNodeId)?.length === 1
    && node.sourcePackageSha256 === binding.packageSha256;
}

function readerBodyTarget(paragraph) {
  const binding = readerNodeBindings.get(paragraph);
  if (!readerBindingMatches(binding) || binding.original || binding.source?.part !== 'document.xml') return null;
  const index = Number(paragraph.dataset.pindex);
  const node = state.doc?.paragraphs?.[index];
  return Number.isInteger(index) && readerPhysicalMatches(binding.source, node, binding)
    && readerSourceProjection(paragraph)?.sourceRaw === node.text ? { target: 'paragraph', index } : null;
}

/** Return every complete, proven rendering instance of this current source node. */
function readerBoundParagraphs(host, target, index) {
  if (!host || !Number.isInteger(index) || state.showOriginal) return [];
  const attr = target === 'paragraph' || target === 'body' ? 'data-pindex'
    : target === 'footnote' ? 'data-findex' : target === 'endnote' ? 'data-eindex' : null;
  if (!attr) return [];
  return [...host.querySelectorAll(`p[${attr}="${index}"]`)].filter(p => {
    const actual = target === 'paragraph' || target === 'body' ? readerBodyTarget(p) : readerNoteTarget(p);
    return actual?.index === index && actual.target === (target === 'body' ? 'paragraph' : target);
  });
}

function readerBoundTables(host, index) {
  const dto = state.doc?.tables?.[index];
  if (!host || state.showOriginal || !dto) return [];
  return [...host.querySelectorAll('table')].filter(table => {
    const binding = readerNodeBindings.get(table), source = binding?.source;
    if (!readerBindingMatches(binding) || source?.part !== 'document.xml' || source.part !== dto.part
      || !Number.isInteger(source.sourceXmlTableOrdinal) || source.sourceXmlTableOrdinal !== dto.sourceXmlTableOrdinal
      || source.sourceXmlNodeId !== `document.xml:xml-tbl:${source.sourceXmlTableOrdinal}`
      || source.sourceXmlNodeId !== dto.sourceXmlNodeId || dto.sourcePackageSha256 !== binding.packageSha256) return false;
    const expected = binding.tableParagraphs?.get(dto.sourceXmlNodeId) || [];
    const ps = [...table.querySelectorAll('p')].filter(p => p.closest?.('table') === table
      && readerNodeBindings.get(p)?.source?.part === 'document.xml');
    return ps.length === expected.length && expected.every(node => ps.some(p => readerBodyTarget(p)
      && readerNodeBindings.get(p)?.source?.sourceXmlNodeId === node.sourceXmlNodeId));
  });
}

function readerNoteIssueProblem(issue) {
  const anchors = issue?.anchors || (issue?.anchor ? [issue.anchor] : []);
  for (const a of anchors) {
    if (!['footnote', 'endnote'].includes(a?.target)) continue;
    const host = $('#docHost');
    const attr = a.target === 'endnote' ? 'data-eindex' : 'data-findex';
    const ps = host ? [...host.querySelectorAll(`p[${attr}="${a.index}"]`)] : [];
    const node = (a.target === 'endnote' ? state.doc?.endnotes : state.doc?.footnotes)?.[a.index];
    const name = a.target === 'endnote' ? '尾注' : '脚注';
    if (!ps.length || ps.some(p => readerNoteTarget(p)?.target !== a.target || readerNoteTarget(p)?.index !== a.index)) {
      const context = host && readerDocumentBindings.get(host);
      return context?.noteProblems.get(`${a.target}:${node?.noteId}`) || `${name}尚未准确对应当前稿，不能猜测位置`;
    }
    if (!Number.isInteger(a.start) || !Number.isInteger(a.end) || a.start < 0 || a.end <= a.start
      || a.end > node.text.length || node.text.slice(a.start, a.end) !== a.text) return `${name}原文范围与当前稿不一致，需重新定位`;
  }
  return null;
}

function onIssueMarkClick(ev) {
  const mark = ev.target.closest?.('.mk-mark');
  if (!mark || !mark.dataset.hitKeys || !$('#docHost')?.contains(mark)) return;
  const binding = readerNodeBindings.get(mark);
  if (binding && !readerBindingMatches(binding)) return;
  const key = String(mark.dataset.hitKeys).split(HIT_KEY_SEP)[0];
  if (key) selectIssue(key);
}

/* ---- 统计条 ---- */
function readerRenderedMarkStats() {
  const host = activeDocHost();
  const ready = state.view === 'markup' && !state.showOriginal && !!host
    && readerBindingMatches(readerDocumentBindings.get(host));
  const result = { segments: 0, issues: 0, shown: ready && !!state.showMarks, ready };
  if (!ready) return result;
  const currentKeys = new Set(visibleIssues().filter(it => !state.resolved.has(issueKey(it)) && !it.needsRelocation).map(issueKey));
  const issueKeys = new Set();
  for (const mark of new Set(host.querySelectorAll('.mk-mark'))) {
    if (!readerBindingMatches(readerNodeBindings.get(mark)) || !host.contains(mark)) continue;
    const keys = String(mark.dataset.hitKeys || '').split(HIT_KEY_SEP).filter(key => currentKeys.has(key));
    if (!keys.length) continue;
    result.segments += 1;
    keys.forEach(key => issueKeys.add(key));
  }
  result.issues = issueKeys.size;
  return result;
}

function resetReviewCoverage() {
  state.reviewCoverage = null;
  state.reviewCoverageScope = null;
  $('#humanPurposeLabel')?.classList.add('hidden');
}
function reviewCoverageScopeMatches(scope) {
  return !!scope && scope.sessionId === state.sessionId && scope.workVersionId === (state.workVersion?.id || null)
    && scope.reviewRunId === state.reviewRunId && scope.workspaceId === state.workspaceId
    && scope.activationSerial === state.activationSerial;
}
function currentReviewCoverage() {
  return reviewCoverageScopeMatches(state.reviewCoverageScope) ? state.reviewCoverage : null;
}
function normalizeReviewCoverageView(input) {
  const valid = input && input.schemaVersion === 1;
  const source = valid ? input : {};
  const statuses = ['completed', 'partial', 'failed', 'disabled', 'unavailable', 'unknown'];
  const steps = {};
  for (const name of ['rules', 'model', 'recheck', 'context', 'cases', 'consistency']) {
    const step = source.steps?.[name];
    steps[name] = { status: statuses.includes(step?.status) ? step.status : 'unknown',
      ...(typeof step?.reason === 'string' && step.reason ? { reason: step.reason } : {}),
      counts: step?.counts && typeof step.counts === 'object' && !Array.isArray(step.counts) ? { ...step.counts } : {} };
  }
  const proof = source.sourceCoverage, totals = proof?.totals;
  const sourceCoverage = proof?.schemaVersion === 1 && proof.basis === 'confirmed-primary-source-ranges'
    && proof.scope === 'parsed-after-text-body-table-footnote-endnote' && /^[a-f0-9]{64}$/.test(proof.manifestSha256 || '')
    && ['complete', 'partial'].includes(proof.status)
    && ['expectedNodes', 'completedNodes', 'expectedUtf16', 'coveredUtf16', 'pendingUtf16', 'expectedTasks', 'completedTasks'].every(k => Number.isSafeInteger(totals?.[k]) && totals[k] >= 0)
    && totals.coveredUtf16 + totals.pendingUtf16 === totals.expectedUtf16 && totals.completedTasks <= totals.expectedTasks && totals.completedNodes <= totals.expectedNodes
    && Array.isArray(proof.sourceCoverageGaps)
    && (proof.status !== 'complete' || totals.pendingUtf16 === 0 && totals.completedTasks === totals.expectedTasks && totals.completedNodes === totals.expectedNodes && !proof.sourceCoverageGaps.length)
      ? { schemaVersion: 1, status: proof.status, manifestSha256: proof.manifestSha256, basis: proof.basis, scope: proof.scope,
          totals: { ...totals }, sourceCoverageGaps: proof.sourceCoverageGaps.map(gap => ({ ...gap })) } : null;
  return { schemaVersion: 1,
    purpose: ['editorial', 'verification'].includes(source.purpose) ? source.purpose : 'unknown',
    options: source.options && typeof source.options === 'object' && !Array.isArray(source.options) ? { ...source.options } : null,
    steps, executionStatus: ['completed', 'partial'].includes(source.executionStatus) ? source.executionStatus : 'unknown',
    fullTextCoverage: ['partial', 'not_requested'].includes(source.fullTextCoverage) ? source.fullTextCoverage
      : source.fullTextCoverage === 'complete' && sourceCoverage?.status === 'complete' ? 'complete' : 'unverified',
    sourceCoverage,
    sourceCoverageGaps:Array.isArray(source.sourceCoverageGaps)?source.sourceCoverageGaps.filter(gap=>gap&&typeof gap==='object'&&!Array.isArray(gap)).map(gap=>({...gap})):[],
    qualityStatus: 'unverified', currentWorkChanged: source.currentWorkChanged === true,
    reviewedVersionId: typeof source.reviewedVersionId === 'string' ? source.reviewedVersionId : null,
    currentWorkVersionId: typeof source.currentWorkVersionId === 'string' ? source.currentWorkVersionId : null };
}
function reviewCoverageResultMatches(data) {
  const id = data?.sessionId || data?.id;
  const versionId = data?.reviewCoverage?.currentWorkVersionId || data?.human?.workVersionId;
  return (!id || id === state.sessionId)
    && (!versionId || !state.workVersion?.id || versionId === state.workVersion.id)
    && (!data?.reviewRunId || !state.reviewRunId || data.reviewRunId === state.reviewRunId);
}
function adoptReviewCoverage(data) {
  if (!data || !reviewCoverageResultMatches(data)) return false;
  state.reviewCoverage = normalizeReviewCoverageView(data.reviewCoverage);
  state.reviewCoverageScope = { sessionId: state.sessionId, workVersionId: state.workVersion?.id || null,
    reviewRunId: state.reviewRunId, workspaceId: state.workspaceId, activationSerial: state.activationSerial };
  $('#humanPurposeLabel')?.classList.toggle('hidden', state.reviewCoverage.purpose !== 'verification');
  return true;
}
function reviewCoveragePresentation(input) {
  const coverage = normalizeReviewCoverageView(input);
  const visualPending=coverage.sourceCoverage?.status==='complete'&&!coverage.currentWorkChanged&&coverage.reviewedVersionId===coverage.currentWorkVersionId
    &&coverage.sourceCoverageGaps.some(gap=>['unparsed_visual_content','textbox_text_not_primary'].includes(gap.reason));
  const labels = { rules: '规则引擎', model: '模型审阅', recheck: '模型复核', context: '全局上下文', cases: '历史批注参考', consistency: '全篇一致性终检' };
  const statusLabels = { completed: '所选步骤已结束', partial: '部分完成，须补审', failed: '请求失败，须补审',
    disabled: '未启用', unavailable: '未能执行，须补审', unknown: '执行情况未知' };
  // Only these counters have a declared unit and provenance in the server DTO.
  // Error records are not a count of unique failed windows or successful tasks.
  const countLabels = { model: { windows: '报告窗口数', reportedErrors: '错误记录数', blockedParagraphs: '被拦截正文段落数' },
    recheck: { total: '候选条目', checked: '已返回结论', skipped: '跳过', noReply: '未回结论',
      agree: '同意', disagree: '不同意', unsure: '拿不准', recovered: '回收结论', batches: '成功返回批次' }, cases: { used: '参考案例累计' } };
  const items = Object.entries(labels).map(([name, label]) => {
    const step = coverage.steps[name];
    const counts = Object.entries(countLabels[name] || {}).filter(([key]) => Number.isSafeInteger(step.counts[key]) && step.counts[key] >= 0)
      .map(([key, title]) => `${title} ${step.counts[key]}${name === 'model' && key === 'windows' ? ' 个' : name === 'model' && key === 'blockedParagraphs' ? ' 段' : name === 'recheck' && key === 'batches' ? ' 批' : name === 'cases' ? ' 次' : ' 条'}`);
    return { cls: step.status === 'completed' ? 'done' : step.status === 'failed' ? 'err' : 'warn',
      text: `${label}：${name==='model'&&visualPending?'文字主任务已完成，非文字内容待处理':statusLabels[step.status]}${step.reason ? `（${step.reason}）` : ''}${counts.length ? `；${counts.join('，')}` : ''}` };
  });
  const notices = [
    ...(coverage.purpose === 'verification' ? ['流程验证用途，不作稿件合格结论'] : []),
    ...(coverage.purpose === 'unknown' || !coverage.options ? ['本轮用途或覆盖情况未知，请核对实际审阅范围'] : []),
    ...(coverage.currentWorkChanged ? ['当前稿已修改，以下规则分来自送审版本，须重新审阅'] : []),
    '规则命中加权；低分不表示稿件合格',
    coverage.fullTextCoverage === 'partial' ? visualPending?'文字主任务已完成；图片、文本框或公式等仍待人工处理，重审整份文字不会消除这些缺口':'全文模型覆盖存在缺口，请先查看未完成项再选择补审'
      : coverage.fullTextCoverage === 'not_requested' ? '本轮未请求全文模型审阅'
      : coverage.fullTextCoverage === 'complete' ? '已解析的正文、表格、脚注和尾注范围送审完整' : '全文模型覆盖未证实',
    ...(coverage.sourceCoverage ? [`已解析文字覆盖 ${coverage.sourceCoverage.totals.expectedUtf16 ? Math.floor(100 * coverage.sourceCoverage.totals.coveredUtf16 / coverage.sourceCoverage.totals.expectedUtf16) : 100}%；本轮主任务 ${coverage.sourceCoverage.totals.completedTasks}/${coverage.sourceCoverage.totals.expectedTasks}${coverage.sourceCoverage.totals.pendingUtf16 ? '，仍有文字待补审' : ''}`] : []),
    '内容质量未验证，仍需人工确认',
  ];
  const execution = coverage.executionStatus === 'completed' ? '所选步骤已结束'
    : coverage.executionStatus === 'partial' ? visualPending?'文字主任务已完成，图片等内容仍待处理':'所选步骤部分完成，仍须补审' : '本轮已结束，步骤覆盖情况未知';
  const phases = Object.values(coverage.steps).map(step => step.status);
  const completed = phases.filter(status => status === 'completed').length;
  const disabled = phases.filter(status => status === 'disabled').length;
  const incomplete = phases.filter(status => ['partial', 'failed', 'unavailable'].includes(status)).length;
  const unknown = phases.filter(status => status === 'unknown').length;
  const stepSummary = [completed ? `已结束 ${completed} 项` : '', disabled ? `未启用 ${disabled} 项` : '',
    incomplete ? `${visualPending?'待核对':'须补审'} ${incomplete} 项` : '', unknown ? `待核对 ${unknown} 项` : ''].filter(Boolean).join(' · ');
  return { coverage, items, notices, execution, stepSummary };
}
function renderMarkupStats() {
  const box = $('#mkStats');
  if (!box) return;
  const s = state.summary;
  if (!s || !state.doc) { box.innerHTML = ''; return; }
  const chips = [
    ['格式', s.format, 'fmt'], ['语言', s.language, 'lang'],
    ['引文', s.citation, 'cite'], ['模型', s.modelBased, 'model'],
  ].filter(([, n]) => n).map(([l, n, c]) => `<span class="tag tag-${c}">${l} ${n}</span>`).join('');
  /**
   * 合格性判定（目标点 10）：阈值由「已过审（发排版）」语料标定，
   * 鼠标悬停给出判定理由，避免只给一个结论而无法核对。
   *
   * ⚠️ 提示里必须写清**判定口径**。判定分数只含规则问题，模型意见
   * 单独成块、不参与判定 —— 这是实测结论（模型问题数分不开「已过审」
   * 与「在审」两层，Welch t=−0.47；规则口径 t=−2.21）。
   * 不写清的话，用户看到「模型 156」和「基本合格」并排会以为
   * 系统把 156 条意见无视了，而实际是**有意分开呈现**。
   */
  const scopeMatches = !state.reviewCoverageScope || reviewCoverageScopeMatches(state.reviewCoverageScope);
  const v = scopeMatches ? state.verdict : null;
  const vTitle = v
    ? [
      ...(v.basis ? [`规则分依据：${v.basis}`] : []),
      '规则命中加权；低分不表示稿件合格',
    ].join(' / ')
    : '';
  const vBadge = v
    ? `<span class="verdict" title="${esc(vTitle)}">规则参考 ${esc(v.score)}分</span>`
    : '';
  /**
   * 「含模型复核」参考判定（E2，默认关）：仅当与主判定结论不同才额外显示，
   * 避免默认就并排两个分数造成口径混淆。它吃的是降级后的规则严重度。
   */
  const vm = scopeMatches ? state.verdictModel : null;
  const vmBadge = vm && vm.score !== v?.score
    ? `<span class="verdict verdict-model" title="计入模型复核后调整的规则参考分；不表示稿件内容质量。">复核后规则参考 ${esc(vm.score)}分</span>`
    : '';
  /**
   * 定位精度（需求 4）：把「有多少条问题能精确落到正文某处」摆出来。
   *
   * 这不是装饰 —— 需求要求「定位至少到标点、至多整段」，而这件事
   * 光看界面是看不全的（用户不会逐条点）。给出精确/标点级/整段的分布，
   * 编辑部一眼就能判断定位质量是否达标；`paragraph` 占比高说明
   * 有一批问题的锚点只能退到整段，值得单独查。
   */
  const as = state.anchorStats;
  const actual = readerRenderedMarkStats();
  const pendingCount = state.issues.filter(it => !state.resolved.has(issueKey(it)) && issueRangeProblem(it)).length;
  const display = state.showOriginal ? '原稿视图未显示当前稿问题标记'
    : !actual.ready ? '本页尚未完成当前稿对应，未显示问题标记'
    : !actual.shown ? `问题标记已隐藏（已绘制 ${actual.segments} 段，覆盖 ${actual.issues} 条问题）`
    : `本页已显示 ${actual.segments} 段标记，覆盖 ${actual.issues} 条问题`;
  const anchorChip = as && as.issues
    ? `<span class="anchor-chip" title="源锚点：精确 ${as.exact || 0} 条 · 标点级 ${as.punctuation || 0} 条 · 片段 ${as.quote || 0} 条 · 仅整段 ${as.paragraph || 0} 条 · 无法定位 ${as.none || 0} 条；位置待确认 ${pendingCount} 条。${display}">源定位 ${(as.exact || 0) + (as.punctuation || 0)}/${as.issues} · ${actual.shown ? `显示 ${actual.segments} 段` : '标记未显示'}</span>`
    : '';
  const relocationCount = state.issues.filter((it) => it.needsRelocation && !state.resolved.has(issueKey(it))).length;
  const relocationChip = relocationCount
    ? `<span class="anchor-chip" title="修改涉及原标注范围，暂不在正文猜测位置。请重新审阅当前稿确定位置。">需重新定位 ${relocationCount}</span>`
    : '';
  /**
   * 模型复核覆盖率（A4）：把「实际复核了多少条」摆出来。
   * 用户看到「不同意 1」时很容易以为全量都复核过；实际还有大量条目因
   * 「无可核对改法」被跳过、或因模型漏回而未得结论，二者可信度不同。
   */
  const declaredRecheck = currentReviewCoverage()?.steps?.recheck?.counts;
  const rs = declaredRecheck || state.recheckStats;
  const countKnown = value => Number.isSafeInteger(value) && value >= 0;
  const recheckDetails = rs ? [['同意', rs.agree], ['不同意', rs.disagree],
    ['拿不准', declaredRecheck ? rs.unsure : countKnown(rs.unsure) && countKnown(rs.noReply) ? Math.max(0, rs.unsure - rs.noReply) : undefined],
    ['无可核对改法跳过', rs.skipped], ['模型未回结论', rs.noReply]]
    .filter(([, value]) => countKnown(value)).map(([label, value]) => `${label} ${value} 条`).join('；') : '';
  const rcChip = rs && countKnown(rs.total) && rs.total > 0 && countKnown(rs.checked)
    ? `<span class="anchor-chip" title="${esc(recheckDetails)}">模型复核已返回 ${rs.checked}/${rs.total} 条</span>`
    : '';
  box.innerHTML = `${vBadge}${vmBadge}<b>${s.total}</b>条问题${chips}${anchorChip}${relocationChip}${rcChip}
    <span class="sev sev-高">高 ${s.bySeverity?.高 || 0}</span>
    <span class="sev sev-中">中 ${s.bySeverity?.中 || 0}</span>`;
  const coverage = reviewCoveragePresentation(currentReviewCoverage());
  box.innerHTML += `<div class="review-notices">${coverage.notices.map(esc).join('<br>')}</div>
    <details class="review-steps"><summary>本轮范围详情 · ${esc(coverage.stepSummary)}</summary>
      <div class="review-step-list">${coverage.items.map(item => `<div>${esc(item.text)}</div>`).join('')}</div></details>`;
  renderReviewGapPanel();
  syncRailBadges();
}

/* ---- 问题清单 ---- */
function visibleIssues() {
  return state.issues.filter((it) => {
    if (state.filterGroup !== 'all' && it.group !== state.filterGroup) return false;
    if (state.filterSeverity !== 'all' && it.severity !== state.filterSeverity) return false;
    if (state.onlyFixable && !isFixable(it)) return false;
    if (state.onlyAccepted && !state.accepted.has(issueKey(it))) return false;
    if (state.search) {
      // 搜索范围必须包含「问题」与「建议」正文。
      // 原先只搜 title/quote/ruleId/location，导致按问题描述搜不到东西
      // （例如归并条目里的「全文共 13 处」、或「未见页码」这类关键措辞）。
      const hay = `${it.title || ''}${it.quote || ''}${it.ruleId || ''}${it.location || ''}`
        + `${it.message || ''}${it.suggestion || ''}${it.basis || ''}`;
      if (!hay.includes(state.search)) return false;
    }
    return true;
  });
}

function renderMarkupIssues() {
  const list = $('#mkIssues');
  if (!list) return;
  const filtered = visibleIssues();
  const cnt = $('#issueCount');
  if (cnt) cnt.textContent = String(filtered.length);
  syncRailBadges();
  if (!state.issues.length) { list.innerHTML = '<div class="empty small muted">导入稿件并开始审阅后，问题会显示在这里。</div>'; return; }
  if (!filtered.length) { list.innerHTML = '<div class="empty small muted">当前筛选条件下没有问题。</div>'; return; }
  const order = { 高: 0, 中: 1, 低: 2 };
  const sorted = [...filtered].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  list.innerHTML = sorted.map((it) => {
    const k = issueKey(it);
    const a = state.accepted.has(k) ? 'checked' : '';
    // 复选框对所有条目可用：可自动修复的用于批量修复，其余用于「选择哪些批注导出」
    const dis = '';
    const done = state.resolved.has(k);
    const readerProblem = readerNoteIssueProblem(it);
    const rangeProblem = issueRangeProblem(it);
    /**
     * 逐条一键修改（需求 7）：可自动改写的条目直接给出「改」按钮，
     * 点一下只改这一条，不必先勾选再点底部批量按钮。
     *
     * 用 `title` 把「改成什么」讲清楚 —— 单字按钮信息量不足，
     * 用户需要知道这一下会把什么换成什么才敢点。
     */
    const fixBtn = isFixable(it)
      ? `<button class="issue-fix${done ? ' done' : ''}" data-fix-key="${esc(k)}" ${done ? 'disabled' : ''}
           title="${done ? '已修改' : `改为「${esc(it.autoFix.replace ?? '')}」`}">${done ? '✓' : '改'}</button>`
      : '';
    /**
     * 严重度徽标（目标点 13 延伸）：模型复核「不同意」的条目会被降一级，
     * 徽标上用 `↓` 并注明原优先级，避免用户以为优先级是规则原本给的。
     */
    const sevTitle = it.severityAdjusted
      ? `模型复核认为不必改，已由「${it.severityBase}」降为「${it.severity}」`
      : (it.modelOpinion || '');
    const sevHtml = `<span class="sev sev-${it.severity}${it.severityAdjusted ? ' sev-down' : ''}" title="${esc(sevTitle)}">${it.severity}${it.severityAdjusted ? '↓' : ''}</span>`;
    return `<div class="mk-issue${state.activeIssueKey === k ? ' active' : ''}${done ? ' resolved' : ''}" data-key="${esc(k)}" title="${esc(it.title || '')}">
      <input class="issue-check" type="checkbox" ${a} ${dis} title="${state.showOriginal ? '原稿仅供核对；返回当前稿后修改。勾选仍用于导出当前工作稿批注' : isFixable(it) ? '可自动修复，也可勾选用于导出批注' : '勾选后可用于导出批注 Word（该条不支持自动改写）'}" />
      <span class="tag tag-${GROUP_TAG[it.group] || 'model'}" title="${esc(modelTagTitle(it.group))}">${GROUP_LABEL[it.group] || it.group}</span>
      ${sevHtml}
      <span class="i-title">${esc(it.title)}</span>
      ${it.occurrenceCount ? `<span class="occ-badge" title="同类问题全文共 ${it.occurrenceCount} 处，已归并为一条">×${it.occurrenceCount}</span>` : ''}
      ${it.needsHuman ? `<span class="human-badge" title="${esc(it.modelOpinion || '需人工确认')}">人工</span>` : ''}
      ${state.showOriginal && it.autoFix?.find ? '<span class="human-badge" title="原稿仅供核对，请返回当前稿后修改">原稿只读</span>' : ''}
      ${it.needsRelocation ? `<span class="human-badge" title="${esc(it.relocationReason || '原标注范围已被修改')}；请重新审阅当前稿">需重新定位</span>` : ''}
      ${rangeProblem && !done ? `<span class="human-badge" title="${esc(rangeProblem)}；勾选仅用于导出，未确定位置可能跳过">位置待确认</span>` : ''}
      ${readerProblem && !state.showOriginal && !done && !it.needsRelocation ? `<span class="human-badge" title="${esc(readerProblem)}">页面未准确定位</span>` : ''}
      ${fixBtn}
      ${it.message ? `<span class="i-msg" title="${esc(it.message)}">${esc(String(it.message).slice(0, 80))}</span>` : ''}
    </div>`;
  }).join('');
  list.querySelectorAll('.mk-issue').forEach((el) => {
    el.addEventListener('click', (ev) => {
      const fixEl = ev.target.closest?.('.issue-fix');
      if (fixEl) {
        // 逐条修改：不要顺带选中该行，避免用户以为「点了只是查看」
        ev.stopPropagation();
        applyFixOne(fixEl.dataset.fixKey);
        return;
      }
      if (ev.target.classList.contains('issue-check')) {
        const k = el.dataset.key;
        if (ev.target.checked) state.accepted.add(k); else state.accepted.delete(k);
        updateApplyBtn();
        return;
      }
      selectIssue(el.dataset.key);
    });
  });
  updateApplyBtn();
}

function updateApplyBtn() {
  const btn = $('#btnApply');
  if (!btn) return;
  const n = selectedFixableKeys([...state.accepted]).length;
  btn.disabled = n === 0 || state.streaming || state.queueRunning || applyFixRequests.has(state.sessionId) || !!state.workspaceError;
  btn.textContent = n ? `应用勾选的自动修复（${n} 项）` : '应用勾选的自动修复';
}

/* ==================================================================
   正文内问题标记：像 Word 批注一样给问题文字加下划线 + 点击跳转
   ==================================================================

   需求是「问题清单里的条目可点击跳转」「问题定位至少到标点、至多整段」
   「像 Word 批注那样自动给问题部分加下划线」。

   现状是：`scrollToIssueInDoc()` 早就写好了但**从未被调用**（死代码），
   而旧的高亮实现 `highlightIssuesInDoc()` 只能按 `quote` 前 16 字模糊匹配，
   命中后给**整个 run 元素**加底色 —— 划出来的是「一段」，不是「问题本身」，
   且没有下划线、不支持范围。

   新实现分两步：

   ① **给渲染结果标注段落下标**。docx-preview 不产出任何索引，而问题只带
      `paragraphIndex`（数组下标），两者必须先对齐。做法是按**文本顺序**
      逐段比对（解析器文本 vs DOM 文本，去空白后比较），这样即使中间夹着
      空段、表格段、页眉页脚段也能对齐。

   ② **按锚点划范围**。服务端已经为每条问题算好 `anchor`（精确到标点、
      至多整段）。这里用 `anchor.text` 在段落内**重新检索**定位，而不是
      直接用服务端的字符偏移 —— 因为偏移是对解析器文本算的，而 DOM 是
      docx-preview 独立渲染的，空白/域代码/脚注引用处可能有差异。
      检索不到时退化为「整段」，正好是需求允许的上限。

   重叠处理：多个问题可能压在同一段文字上（如同一处既报半角标点又报
   术语问题）。做法是先按边界切分成**互不重叠的分段**，每段取最高严重度
   作为配色，并把覆盖该段的全部问题 key 记在 `data-hit-keys` 上 ——
   这样点任意一条相关问题时，这一段都会闪烁。
   ================================================================== */

/** key → 标记元素数组（当前视图内），供跳转与闪烁使用 */
const markIndex = new Map();

/**
 * `data-hit-keys` 里多个 key 的分隔符：U+001F（单元分隔符）。
 * 不能用空格 —— key 里的 `quote` 可能含空格，见 `applyMarksInParagraph`。
 */
const HIT_KEY_SEP = '\u001f';

const normText = (s) => String(s ?? '').replace(/\s+/g, '');

/**
 * 按序分块匹配得分：把 `a` 切成定长小块，**按先后顺序**在 `b` 里找，累计命中长度。
 *
 * ── 为什么光有前缀和包含判据不够 ──
 * 前面两个判据只能容忍**一处**插入。实测
 * `02-文化-吴子枫-无产阶级专政…`（256 段、**110 条脚注**）时整批失败：
 * `docx-preview` 把每条脚注引用都内联成上标数字，一段里有**两个以上**
 * 脚注引用时，解析器的段落文本被这些数字切成好几截 ——
 *   · `longer.includes(shorter)` 直接不成立（不再连续）
 *   · 公共前缀被第一个插入点打断
 * 得分掉到阈值以下，游标便跳过该段去匹配更靠后的段，
 * 一次跳段会把中间所有段一起跳过。实测 256 段里只对齐上 71 段，
 * 而 25 条问题里有 8 条恰好落在被跳过的段上 ——
 * 点得动但**划不出下划线**（需求 3/4 直接失效）。
 *
 * 分块匹配对「任意多处的插入」都成立：只要字符**按原顺序**还在，
 * 就照样命中，插入的数字只是被忽略。块长取 `ALIGN_CHUNK`（=6）——
 * ⚠️ 实测该取值在甲稿（18 脚注）与乙稿（110 脚注）上**不承重**：
 * 3~16 逐一扫描，对齐覆盖度与一致率一字不变（见 `ALIGN_CHUNK` 的说明）。
 * 复杂度是 O(n/6) 次 `indexOf`，对 300 字的段落约 50 次，可忽略。
 */
function chunkScore(a, b) {
  const CHUNK = ALIGN_CHUNK;
  if (!a || !b) return 0;
  let pos = 0;
  let hit = 0;
  for (let i = 0; i < a.length; i += CHUNK) {
    const piece = a.slice(i, i + CHUNK);
    const at = b.indexOf(piece, pos);
    if (at >= 0) {
      hit += piece.length;
      pos = at + piece.length;
    }
  }
  return hit;
}

/**
 * ── DOM ↔ 解析器文本对齐的常数（需求 C：必须给跨语料证据）──
 *
 * 全部集中在这里，方便按稿件族调整；改动前请先跑
 * `node tools/align-sensitivity.mjs`（用**真实 DOM 文本**扫描这些常数，
 * 不是模拟），它会报三个数：覆盖度、回退数、无歧义一致率。
 *
 * ── 实测（tools/align-sensitivity.mjs，两份真实稿件）──
 * 稿件甲 `samples/test.docx`（18 脚注，单点插入）
 * 稿件乙 `02-文化-吴子枫`（110 脚注，多点插入）
 *
 * 对齐质量（现行取值）：**两份稿件都是 0 回退、无歧义一致 100%**。
 * 覆盖度用「非空解析段落」作分母 ≈98%（96/98）——
 * ⚠️ 不要用「DOM 段落数」作分母：`#docHost` 里还渲染着脚注区段落，
 * 用它会算出 46.6% 这种假数字（实测踩过，110 条未匹配恰好等于脚注数）。
 *
 * `ALIGN_WINDOW = 16`：**唯一对结果有实质影响的常数**，且扫描结果非单调 ——
 *   稿件甲：窗口 1→覆盖 1，2→5，4→39，**8→51，16→51**，24→**24**（变差）
 *   稿件乙：窗口 1→5，2→5，4→35，**8→96，16→96，24→96**（不再变差）
 * 机制：窗口越大，`bestForward` 越可能选中更靠后的高分段落，游标一跳跃
 * 就跳过了中间段落，覆盖率反而塌掉。所以安全区间是 **[8, 16]**（两稿交集），
 * 16 是上边界、8 是下边界（再小就接不住被跳过的段落）。
 * 取 16 而非 8：两份稿件上两者打平，但 8 离「窗口 4」的下悬崖只差一档。
 *
 * `ALIGN_CHUNK = 6` / `ALIGN_HIT_RATIO = 0.6` / `ALIGN_PARA_MIN = 8`：
 * **在这两份稿件上取任何值结果都完全一样**（3/4/5/6/8/10/12/16、
 * 0.3~0.9、2/4/6/8/10/12/16 逐一扫描，覆盖度与一致率一字不变）。
 * 也就是说它们的取值在这两份稿件上**不承重** —— 差异全被
 * 「完全相等」「一方包含另一方」「共同前缀」三个信号吃掉了，
 * 分块打分只在**多处插入**把前缀也打断时才会成为决定项。
 * 保留它们是因为那个场景确实存在（脚注引用插在段首时前缀即失效），
 * 但**不要**声称 6 比 8 好：没有证据。要动就先补一份多插入稿件的 dump。
 */
const ALIGN_CHUNK = 6;
const ALIGN_HIT_RATIO = 0.6;
const ALIGN_PARA_MIN = 8;
const ALIGN_WINDOW = 16;

/**
 * 段落文本相似度打分（用于 DOM ↔ 解析器文本对齐）。
 *
 * 为什么不能用严格相等：`docx-preview` 会把**脚注引用**内联渲染进段落
 * （正文里多出一个上标数字），也可能在域代码、书签处插入额外文本，
 * 于是渲染出的 `textContent` 与解析器给出的 `paragraphs[i].text`
 * 不再逐字相等。实测 `samples/test.docx`：严格相等只能对齐 38/73 段，
 * 含脚注引用的段落全部对不上，导致这些段里的问题**划不出下划线**。
 * （`tools/.dbg-coverage.mjs` 复核：剥掉数字后，DOM 与解析的差异
 * 确实只剩脚注引用 —— 甲稿 40 条逐字相等 + 56 条剥数字后相等 = 96 条，
 * 与对齐覆盖数一致。）
 *
 * 打分口径（取最大者）：
 *   · 共同前缀长度 —— 脚注引用出现在段中时，前缀依然很长
 *   · 一方完整包含另一方 —— 长度差异全部来自插入的标记
 *   · **按序分块命中长度** —— 容忍多处插入（见 `chunkScore`）
 *   · 一方是另一方的前缀且长度接近 —— 截断差异
 */
function paraMatchScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return a.length + 1000;           // 完全相等，绝对优先
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  let score = 0;
  if (longer.includes(shorter)) score = shorter.length + 500;
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  if (pre > score) score = pre;
  /**
   * 分块得分**必须按比例**折算成排名分，不能直接当分数用 ——
   * 否则一段 300 字的长段落只要零散命中 10 个字就会压过
   * 一段 12 字短段落的完全匹配，把游标带偏。
   * 只有命中比例够高（≥60%）才认为「这就是同一段」，
   * 并给一个高于前缀分的排名值，保证它排在同窗口的劣质匹配前面。
   */
  const hit = chunkScore(shorter, longer);
  if (hit / Math.max(1, shorter.length) >= ALIGN_HIT_RATIO) {
    score = Math.max(score, hit + 300);
  }
  return score;
}

/**
 * 对齐时要求的最低分。
 *
 * 8 个字足以排除「都是短句但内容不同」的误配（如把 `中性国家` 配到
 * `市场经济`），同时又能接住「只有开头两个字相同」的极端情况之外的
 * 绝大多数真实段落。
 */
const PARA_MATCH_MIN = ALIGN_PARA_MIN;

/**
 * 脚注对齐的最低分：脚注可以很短（`参见前注。`），门槛要低于正文。
 *
 * ── 实测依据（`tools/audit-constants.mjs` ④，632 篇 / 25001 条脚注）──
 * 脚注长度 min=2 P50=53 P90=191 P99=389 max=925；**<8 字的只占 1.7%**。
 * 所以 4 与 8 的差别上限就是这 1.7% 脚注的模糊匹配 —— 不是"整批漏掉"。
 * 仍取 4 的理由：门槛只约束**模糊**匹配（逐字相等时 `paraMatchScore`
 * 返回 `长度+1000`，再短也过），而脚注极短时模糊匹配本就不可靠；
 * 门槛取高会把这几百条直接推给"无位置"，而脚注正是引文类规则
 * （CIT-008 等）的主战场 —— 宁可多匹配几次，也不要让引文问题失去定位。
 */
const NOTE_MATCH_MIN = 4;

/** 取当前视图的文档宿主元素（视图精简后只有批阅视图一个宿主） */
function activeDocHost() {
  return $('#docHost');
}

/** Physical AST/XML identity and complete after-text proof; no text search fallback. */
function indexRenderedParagraphs(host) {
  const doc = state.doc;
  if (!doc || !host) return;
  const context = readerDocumentBindings.get(host);
  for (const el of host.querySelectorAll('p')) {
    el.removeAttribute('data-pindex');
    el.removeAttribute('data-findex');
    el.removeAttribute('data-eindex');
    el.removeAttribute('data-note-pid');
    // Notes are a separate source part. A matching body sentence is never proof
    // that a note paragraph belongs to the body.
    if (renderedNoteContainer(el) || el.dataset.noteKind) continue;
    const binding = readerNodeBindings.get(el), source = binding?.source;
    if (!readerBindingMatches(context) || !readerBindingMatches(binding) || context.original
      || source?.part !== 'document.xml') continue;
    const matches = (context.sourceIndex.get(source.sourceXmlNodeId) || [])
      .filter(({target, node}) => target === 'paragraph' && readerPhysicalMatches(source, node, context));
    if (matches.length !== 1 || readerSourceProjection(el)?.sourceRaw !== matches[0].node.text) continue;
    el.dataset.pindex = String(matches[0].index);
    el.dataset.readerVersion = String(context.versionId || '');
    el.dataset.readerSession = String(context.sessionId || '');
    el.dataset.readerActivation = String(context.activationSerial ?? '');
  }
  indexReaderNotes(host);
}

/** 拆掉上一次划的所有标记，还原成纯文本节点 */
function clearMarks(host) {
  if (!host) return;
  host.querySelectorAll('.mk-mark').forEach((el) => {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize();
  });
}

/**
 * 在单个段落内按锚点划下划线。
 * @param {HTMLElement} pEl 段落元素
 * @param {Array<{key:string, anchor:object, severity:string}>} items 落在该段的问题
 */
function applyMarksInParagraph(pEl, items) {
  const projection = readerSourceProjection(pEl);
  if (!projection) return;

  const ranges = [];
  for (const { key, anchor, severity } of items) {
    if (['ambiguous', 'unmapped', 'unresolved'].includes(anchor?.resolutionStatus)) continue;
    if (anchor?.textView != null && anchor.textView !== 'after'
      || anchor?.offsetUnit != null && anchor.offsetUnit !== 'utf16'
      || anchor?.paragraphIndexOwner != null && anchor.paragraphIndexOwner !== 'application-paragraph-index') continue;
    const isNote = anchor.target === 'footnote' || anchor.target === 'endnote';
    const target = isNote ? readerNoteTarget(pEl) : readerBodyTarget(pEl);
    const node = (anchor.target === 'endnote' ? state.doc?.endnotes
      : anchor.target === 'footnote' ? state.doc?.footnotes : state.doc?.paragraphs)?.[anchor.index];
    const raw = node?.text;
    if (target?.target !== anchor.target || target.index !== anchor.index || typeof raw !== 'string'
      || !Number.isInteger(anchor.start) || !Number.isInteger(anchor.end)
      || anchor.start < 0 || anchor.end <= anchor.start || anchor.end > raw.length
      || raw.slice(anchor.start, anchor.end) !== anchor.text || projection.sourceRaw !== raw
      || anchor.pid != null && anchor.pid !== (node._pid || node.id)
      || anchor.sourceXmlNodeId != null && anchor.sourceXmlNodeId !== node.sourceXmlNodeId
      || anchor.sourceVersionId != null && anchor.sourceVersionId !== state.workVersion?.id
      || anchor.sourcePackageSha256 != null && anchor.sourcePackageSha256 !== state.doc?.sourcePackageSha256) continue;
    if (!readerProjectionRange(projection, anchor.start, anchor.end)) continue;
    ranges.push({ key, severity, start: anchor.start, end: anchor.end });
  }
  if (!ranges.length) return;

  // 切成互不重叠的分段：重叠处取最高严重度，key 合并
  const bounds = [...new Set(ranges.flatMap((r) => [r.start, r.end]))].sort((a, b) => a - b);
  const rank = { 高: 0, 中: 1, 低: 2 };
  const segs = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const s = bounds[i];
    const e = bounds[i + 1];
    if (e <= s) continue;
    const cover = ranges.filter((r) => r.start <= s && r.end >= e);
    if (!cover.length) continue;
    const sev = cover.map((c) => c.severity).sort((a, b) => (rank[a] ?? 3) - (rank[b] ?? 3))[0] || '中';
    segs.push({ start: s, end: e, keys: cover.map((c) => c.key), severity: sev });
  }

  // 从后往前包裹：后面的改动不影响前面已记录的下标
  for (const seg of segs.reverse()) {
    const current = readerSourceProjection(pEl);
    const spans = readerWrapProjection(pEl, current, seg.start, seg.end, () => {
      const span = document.createElement('span');
      span.className = `mk-mark sev-${seg.severity}`;
      /**
       * 多个 key 的分隔符用 **U+001F（单元分隔符）**，不能用空格。
       *
       * key 是 `ruleId|location|quote`，而 `quote` 是原文片段 ——
       * 里面**可以含空格**（英文摘要、`[内容提要] …` 之类）。
       * 用空格分隔时 `[data-hit-keys~="…"]` 会把一个 key 拆成两个词，
       * 导致「这一条有问题下划线却查不到」。
       * U+001F 是控制字符，不会出现在任何 Word 正文里。
       */
      span.dataset.hitKeys = seg.keys.join(HIT_KEY_SEP);
      if (seg.keys.length > 1) span.title = `此处有 ${seg.keys.length} 条问题`;
      return span;
    });
    for (const k of seg.keys) {
      if (!markIndex.has(k)) markIndex.set(k, []);
      markIndex.get(k).push(...spans);
    }
  }
}

/**
 * 应用「显示问题标记」开关：给两个文档宿主加/去 `marks-off` 类。
 * 用 CSS 收起标记，不重渲文档。
 */
function applyMarksVisibility() {
  const h = $('#docHost');
  if (h) h.classList.toggle('marks-off', !state.showMarks);
  renderMarkupStats();
}

/**
 * 主入口：在当前视图的正文里给所有**可见且未修复**的问题划下划线。
 */
function highlightIssuesInDoc() {
  // 规则视图/原文视图没有正文宿主，直接跳过（调用方不必各自判断视图）
  if (state.view !== 'markup' || state.showOriginal) { renderMarkupStats(); return; }
  const host = activeDocHost();
  if (!host || !host.querySelector('p')) { renderMarkupStats(); return; }
  markIndex.clear();
  clearMarks(host);
  indexRenderedParagraphs(host);

  const visible = visibleIssues();
  const byPara = new Map();
  const byNote = new Map();
  const byEndnote = new Map();
  for (const it of visible) {
    const k = issueKey(it);
    if (state.resolved.has(k) || it.needsRelocation) continue; // 已修复或待重新定位的问题不猜测位置
    const anchors = it.commentAnchors || it.anchors || (it.anchor ? [it.anchor] : []);
    for (const a of anchors) {
      if (!a) continue;
      if (['ambiguous', 'unmapped', 'unresolved'].includes(a.resolutionStatus)) continue;
      const bucket = a.target === 'footnote' ? byNote : a.target === 'endnote' ? byEndnote : (a.target === 'paragraph' ? byPara : null);
      if (!bucket) continue;
      const idx = a.index;
      if (!bucket.has(idx)) bucket.set(idx, []);
      bucket.get(idx).push({ key: k, anchor: a, severity: it.severity });
    }
  }
  for (const [idx, items] of byPara) {
    for (const el of readerBoundParagraphs(host, 'paragraph', idx)) applyMarksInParagraph(el, items);
  }
  for (const [idx, items] of byNote) {
    for (const el of host.querySelectorAll(`p[data-findex="${idx}"]`)) applyMarksInParagraph(el, items);
  }
  for (const [idx, items] of byEndnote) {
    for (const el of host.querySelectorAll(`p[data-eindex="${idx}"]`)) applyMarksInParagraph(el, items);
  }
  applyMarksVisibility();
}

/**
 * 滚动到某条问题在正文中的位置并闪烁提示。
 *
 * 优先按**下划线标记**定位（精确到问题文字）；没有标记时（如 `document`
 * 级问题、或该段未渲染出来）退化为按段落下标定位。
 */
function scrollToIssueInDoc(key) {
  const issue = state.issues.find((it) => issueKey(it) === key);
  if ((issue?.anchors || (issue?.anchor ? [issue.anchor] : [])).some(a => ['ambiguous', 'unmapped', 'unresolved'].includes(a.resolutionStatus))) {
    toast('该问题尚无准确文字范围，请核对候选位置后重新定位', 3600);
    return;
  }
  if (issue?.needsRelocation) {
    toast('该问题需重新定位，请重新审阅当前稿后确认位置', 3600);
    return;
  }
  const noteProblem = readerNoteIssueProblem(issue);
  if (noteProblem) { toast(noteProblem, 3600); return; }
  const host = activeDocHost();
  if (!host) return;
  let els = (markIndex.get(key) || []).filter(el => readerBindingMatches(readerNodeBindings.get(el)) && host.contains(el));
  if (!els.length) {
    const it = state.issues.find((x) => issueKey(x) === key);
    const a = it?.anchor;
    let el = null;
    if (a && ['paragraph', 'footnote', 'endnote'].includes(a.target)) el = readerBoundParagraphs(host, a.target, a.index)[0] || null;
    else if (a && a.target === 'table') el = readerBoundTables(host, a.index)[0] || null;
    else if (a && a.target === 'document') {
      /**
       * 整篇级问题（缺摘要、缺基金项目等）**没有**具体位置可跳。
       * 但不能什么都不做 —— 用户点了没反应会以为界面坏了。
       * 做法：滚回文首 + 明确提示「该问题针对整篇文档」。
       */
      host.scrollIntoView({ block: 'start', behavior: 'auto' });
      toast('该问题针对整篇文档，无具体位置可定位', 3200);
      return;
    }
    if (!el) {
      // 锚点目标在正文里没渲染出来（如表格未被 docx-preview 渲染）
      toast('该问题在正文中没有可定位的位置', 2800);
      return;
    }
    els = [el];
  }
  /**
   * 用**瞬时**滚动（`behavior:'auto'`），不用平滑滚动。
   *
   * 实测理由：本刊定稿渲染后正文高 8000–9000px，`behavior:'smooth'`
   * 从文首滚到文末要 1 秒以上，而且**连续点击会互相打断** ——
   * 用 Playwright 逐条点击 11 条问题时，只有 4 条滚进了视口，
   * 其余都停在半路（实测 scrollTop 只走到目标的 1/8 ~ 2/3）。
   *
   * 审稿的实际操作就是「在清单里一条条点过去」，平滑动画在这里
   * 不是体验加分，而是让人以为「点了没反应」。闪烁高亮已经足够
   * 把视线拉过去，滚动本身越快越确定越好。
   */
  els[0].scrollIntoView({ block: 'center', behavior: 'auto' });
  for (const el of els) el.classList.add('mk-mark-flash');
  setTimeout(() => { for (const el of els) el.classList.remove('mk-mark-flash'); }, 1600);
}

/* ==================================================================
   阅读器增强：标题层级标记 + 引文（正文上标 ↔ 文末注释）交互
   ================================================================== */

/**
 * 给渲染出的标题段打上层级标记。
 *
 * `state.doc.headings[*].index` 是段落在 `doc.paragraphs` 里的下标，与
 * `indexRenderedParagraphs()` 写在 `<p data-pindex>` 上的值同源，因此可以
 * 直接对应到 DOM。加 `h-lN` 类做分级样式，并在段首插一个 `HN` 徽标 ——
 * 此前「第几级标题」只存在于数据里，界面上完全看不出结构。
 *
 * ⚠️ 必须在 `highlightIssuesInDoc()` **之后**调用：`data-pindex` 是那一步
 * 里由 `indexRenderedParagraphs()` 写上的，先调用会一首都匹配不到。
 */
function markHeadingLevels() {
  const host = $('#docHost');
  const doc = state.doc;
  if (!host || !doc) return;
  host.querySelectorAll('p.h-level').forEach((el) => {
    el.classList.remove('h-level', ...Array.from({ length: 9 }, (_, i) => `h-l${i + 1}`));
    el.removeAttribute('data-head-level');
  });
  for (const h of doc.headings || []) {
    for (const el of readerBoundParagraphs(host, 'paragraph', h.index)) {
    const lv = Math.max(1, Math.min(9, h.level || 1));
    el.classList.add('h-level', `h-l${lv}`);
    /**
     * 层级徽标**用 CSS `::before` + 属性值**渲染，绝不往段落里插真实
     * 元素。原因：`indexRenderedParagraphs()` / `applyMarksInParagraph()`
     * 都按段落的 `textContent` 与解析文本对齐，一旦往 `<p>` 里塞一个
     * 「H1」文本节点，对齐结果就会被这多出来的字符带偏，下划线错位。
     */
    el.dataset.headLevel = `H${lv}`;
    el.title = `标题层级 ${lv}（判据：${HEAD_SOURCE_LABEL[h.source] || h.source || '未知'}）`;
    }
  }
}

/** 引文悬停预览的浮层（单例，惰性创建） */
let citeTip = null;
function citeTooltip() {
  if (!citeTip) {
    citeTip = document.createElement('div');
    citeTip.className = 'cite-tip hidden';
    document.body.appendChild(citeTip);
  }
  return citeTip;
}

/**
 * 引文一一对应：正文上标 ↔ 文末注释。
 *
 * docx-preview 把正文里每条 `w:footnoteReference` 内联渲染成一个
 * `<sup>N</sup>`（按出现顺序 1,2,3…），并把注释正文渲染成
 * `section > ol > li`（见 docx-preview `renderNotes()`）。
 *
 * 配对使用当前DOCX模型上记录的 kind/noteId，与已验证完整范围的注释实例。
 * 普通数字上标不冒充注号；缺身份、冲突身份或不完整范围不按文本或顺序猜配。
 * 合法的多引用实例保留各自的呈现身份，回调同时核对当前稿件和工作版本。
 *
 * 需求 3(a)：点正文上标 → 滚到文末对应注释并闪烁；
 * 需求 3(b)：悬停上标 → 浮层显示注释全文（引用文献全名）。
 * 反向也做了：点注释 → 滚回正文对应上标，便于来回核对。
 */
function wireCitations() {
  const host = $('#docHost');
  if (!host) return;
  const wrapper = host.querySelector('.docx-wrapper');
  if (!wrapper) return;

  const noteLis = [...wrapper.querySelectorAll('section > ol > li')].filter((li) =>
    readerBindingMatches(readerNodeBindings.get(li)) && readerNoteParagraphs(li).length
    && readerNoteParagraphs(li).every(p => readerNoteTarget(p)));
  const sups = [...wrapper.querySelectorAll('article sup')]
    .filter(s => readerReferenceMatches(s) && readerBodyTarget(s.closest?.('p'))
      && ['footnote', 'endnote'].includes(s.dataset.noteKind));

  wrapper.querySelectorAll('.cite-ref, .cite-note').forEach((el) => {
    el.classList.remove('cite-ref', 'cite-note');
    el.removeAttribute('data-cite');
    for (const event of ['click', 'mouseenter', 'mouseleave', 'focus', 'blur', 'keydown']) el['on' + event] = null;
  });
  const lisByIdentity = new Map();
  for (const li of noteLis) {
    const key = `${li.dataset.noteKind}:${li.dataset.noteId}`;
    if (!lisByIdentity.has(key)) lisByIdentity.set(key, []);
    lisByIdentity.get(key).push(li);
  }
  const pairs = sups.flatMap((sup) => {
    const candidates = lisByIdentity.get(`${sup.dataset.noteKind}:${sup.dataset.noteId}`) || [];
    // Every candidate proves the same complete source note. Multiple references
    // may render that note more than once; its occurrence chooses that instance.
    const li = candidates[Number(sup.dataset.referenceOccurrence)] || candidates[0];
    return li ? [[sup, li]] : [];
  });

  const tip = citeTooltip();
  const hideTip = () => tip.classList.add('hidden');
  const showTip = (target, text) => {
    tip.textContent = text;
    tip.classList.remove('hidden');
    const r = target.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - 380, Math.max(12, r.left))}px`;
    tip.style.top = `${r.bottom + 8}px`;
  };

  pairs.forEach(([sup, li], k) => {
    const binding = readerNodeBindings.get(sup);
    const current = () => readerBindingMatches(binding) && readerReferenceMatches(sup) && readerBodyTarget(sup.closest?.('p'))
      && host.contains(sup) && host.contains(li)
      && readerNoteParagraphs(li).every(p => readerNoteTarget(p));
    const text = (li.textContent || '').replace(/\s+/g, ' ').trim();
    sup.classList.add('cite-ref');
    sup.dataset.cite = String(k);
    // 键盘可达（C2）：上标可聚焦，focus/blur 与 mouseenter/leave 同效果
    sup.tabIndex = 0;
    li.classList.add('cite-note');
    li.id = li.id || `doc-note-${k}`;
    li.dataset.cite = String(k);
    sup.onclick = (ev) => {
      if (!current()) return;
      ev.preventDefault();
      li.scrollIntoView({ block: 'center', behavior: 'auto' });
      li.classList.add('mk-mark-flash');
      setTimeout(() => li.classList.remove('mk-mark-flash'), 1600);
    };
    const show = () => { if (current()) showTip(sup, text || `注释 ${k + 1}`); };
    sup.onmouseenter = show;
    sup.onfocus = show;
    sup.onmouseleave = hideTip;
    sup.onblur = hideTip;
    sup.onkeydown = (ev) => {
      if (!current()) return;
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); sup.click(); }
    };
    li.onclick = (ev) => {
      if (!current() || ev.target.closest?.('.cite-ref,.mk-mark,.human-mark,a')) return;
      sup.scrollIntoView({ block: 'center', behavior: 'auto' });
      sup.classList.add('cite-ref-flash');
      setTimeout(() => sup.classList.remove('cite-ref-flash'), 1600);
    };
  });

  // 文末注释区加一个标题，明确「引用文献集中在最下面」
  const firstOl = noteLis.length ? noteLis[0].parentElement : null;
  if (firstOl && firstOl.previousElementSibling?.className !== 'refs-title') {
    const t = document.createElement('div');
    t.className = 'refs-title';
    t.textContent = '注释与参考文献';
    firstOl.parentElement.insertBefore(t, firstOl);
  }
}

/**
 * 切换「查看原文 / 返回清洗稿」。
 *
 * 清洗稿是审阅与批注导出的基准；原文视图用于核对作者投稿时的原始样貌
 * （含上一轮责编批注）。原文字节流按需拉取一次并缓存，之后来回切换零下载。
 * 两种稿源必须各自重渲（docx-preview 渲染的是 ArrayBuffer）。
 */
async function toggleOriginal() {
  if (!state.sessionId) { toast('请先导入稿件'); return; }
  if (pendingInfo?.dirty || pendingInfo?.saving) { toast('请先保存或取消当前批注，再切换稿源'); return; }
  const sessionId = state.sessionId;
  const activationSerial = state.activationSerial;
  const context = workspaceContext();
  const isCurrent = () => state.sessionId === sessionId && state.activationSerial === activationSerial && sameWorkspaceContext(context);
  let originalFailed = false;
  state.showOriginal = !state.showOriginal;
  renderMarkupIssues();
  const activeIssue = state.issues.find(it => issueKey(it) === state.activeIssueKey);
  if (activeIssue) updateDetailFixBtn(activeIssue);
  const btn = $('#btnOriginal');
  if (state.showOriginal && !state.originalBuffer) {
    try {
      const fr = await fetch('/api/session-file?id=' + encodeURIComponent(sessionId) + '&original=1');
      const buffer = fr.ok ? await fr.arrayBuffer() : null;
      if (!isCurrent()) return;
      state.originalBuffer = buffer;
    } catch { /* 拿不到就仍显示清洗稿 */ }
  }
  if (!isCurrent()) return;
  if (state.showOriginal && !state.originalBuffer) {
    state.showOriginal = false;
    originalFailed = true;
    toast('原文获取失败，已保留当前稿', 3000);
  }
  btn.textContent = state.showOriginal ? '返回当前稿' : '查看原文';
  btn.classList.toggle('btn-primary', state.showOriginal);
  btn.classList.toggle('btn-ghost', !state.showOriginal);
  syncHistoryControls();
  renderMarkupIssues();
  if (activeIssue) updateDetailFixBtn(activeIssue);
  $('#btnDocx').title = '导出当前工作稿的批注版本；原稿视图仅供核对';
  $('#btnWorkingDocx').title = '导出当前工作稿字节，包含已保存修改；原稿视图仅供核对';
  rendered.markup = null;          // 稿源变了必须重渲
  await renderDocument(true);
  if (!isCurrent()) return;
  // Note fixes need the newly proven current DOM after returning from original.
  renderMarkupIssues();
  const currentIssue = state.issues.find(it => issueKey(it) === state.activeIssueKey);
  if (currentIssue) updateDetailFixBtn(currentIssue);
  if (!originalFailed) toast(state.showOriginal ? '正在查看投稿原稿（含上一轮批注）' : '已返回当前稿（含已保存修改）', 2600);
}

/* ==================================================================
   人工审阅模式（需求 6）：在正文里圈画、记录判断与经验
   ================================================================== */
/** 人工圈画的类别（与规则库分组口径一致，便于后续按类归因） */
const HUMAN_CATS = ['格式体例', '语言词汇', '引文注释', '内容语义', '其他'];

/** 规则下拉缓存（B3）：把人工标注关联到具体规则，审计数据即可直接归因到规则 */
let rulePickerCache = null;
async function rulePickerOptions() {
  if (rulePickerCache) return rulePickerCache;
  try {
    const data = await (await fetch('/api/rules')).json();
    const out = [];
    for (const g of ['format', 'language', 'citation']) {
      for (const r of (data[g]?.rules || [])) out.push({ id: r.id, title: r.title || '', category: { format: '格式体例', language: '语言词汇', citation: '引文注释' }[g] });
    }
    rulePickerCache = out;
  } catch { rulePickerCache = []; }
  return rulePickerCache;
}

/** 待记录的一段选区（保存时用于包裹） */
let pendingRange = null;
let pendingInfo = null;
let humanMarkDefaults = { category: '其他', severity: '中' };

function toggleHumanMode() {
  if (!state.sessionId) { toast('请先导入稿件'); return; }
  if (state.humanMode && pendingInfo) { requestCloseHumanPop(); if (pendingInfo) return; }
  state.humanMode = !state.humanMode;
  const btn = $('#btnHumanReview');
  const host = $('#docHost');
  btn.textContent = state.humanMode ? '退出人工审阅' : '人工审阅';
  btn.classList.toggle('btn-primary', state.humanMode);
  btn.classList.toggle('btn-ghost', !state.humanMode);
  host?.classList.toggle('human-mode', state.humanMode);
  if (!state.humanMode) closeHumanPop();
  toast(state.humanMode ? '人工审阅模式：用鼠标在正文里框选一段，即可记录你的判断' : '已退出人工审阅模式', 3200);
}

function closeHumanPop() {
  const pop = $('#humanPop');
  if (pop) { pop.classList.add('hidden'); pop.innerHTML = ''; }
  pendingRange = null;
  pendingInfo = null;
}

function humanPopError(message = '') {
  const error = $('#hpError');
  if (error) { error.textContent = message; error.classList.toggle('hidden', !message); }
}

function requestCloseHumanPop() {
  if (!pendingInfo) return;
  if (pendingInfo.saving) { humanPopError('正在保存，请稍候。'); return; }
  if (pendingInfo.dirty) {
    $('#hpDiscard')?.classList.remove('hidden');
    $('#hpKeep')?.focus();
    positionHumanPop();
    return;
  }
  closeHumanPop();
  $('#btnHumanReview')?.focus();
}

/** Measure the actual card; long rule names never determine its width. */
function positionHumanPop() {
  const pop = $('#humanPop');
  if (!pendingInfo || !pop || pop.classList.contains('hidden')) return;
  const box = pop.getBoundingClientRect(), selected = pendingInfo.rect;
  const margin = 12, width = box.width, height = box.height;
  const right = selected.right ?? selected.left;
  let left = window.innerWidth - width - margin;
  if (window.innerWidth > 640) {
    if (right + width + 24 <= window.innerWidth) left = right + 12;
    else if (selected.left >= width + 24) left = selected.left - width - 12;
  }
  pop.style.left = `${Math.max(margin, Math.min(window.innerWidth - width - margin, left))}px`;
  pop.style.top = `${window.innerWidth <= 640 ? Math.max(margin, window.innerHeight - height - margin)
    : Math.max(margin, Math.min(window.innerHeight - height - margin, Math.max(76, selected.top)))}px`;
}

/** Non-modal annotation card: full source first, opinion next, optional rule attribution last. */
function openHumanPop(info) {
  const pop = $('#humanPop');
  if (!pop) return;
  const catOpts = HUMAN_CATS.map((c) => `<option>${esc(c)}</option>`).join('');
  pop.innerHTML = `
    <div class="hp-head"><div><div class="hp-title" id="hpTitle">添加人工批注</div><div class="hp-subtitle">保存后标记原文，并记入审稿日志</div></div>
      <button type="button" class="icon-btn hp-close" id="hpClose" aria-label="关闭批注面板">×</button></div>
    <form id="hpForm" novalidate>
      <div class="hp-body">
        <div class="hp-source-head"><span>选中原文</span><span>${esc(info.location || '正文')} · ${[...info.text].length} 字符</span></div>
        <div class="hp-quote" tabindex="0" aria-label="选中原文全文">${esc(/\S/.test(info.text) ? info.text : '（已选中空白字符，按原稿范围记录）')}</div>
        <label class="hp-field" for="hpNote">批注意见 <span class="hp-required">必填</span></label>
        <textarea id="hpNote" class="hp-note" rows="4" required aria-describedby="hpNoteHint hpError" placeholder="说明问题、修改建议或需要核对的内容…"></textarea>
        <div class="hp-hint" id="hpNoteHint">Enter 换行 · Ctrl / ⌘ + Enter 保存</div>
        <div class="hp-grid">
          <div class="hp-field"><label for="hpCat">问题类别</label><select id="hpCat">${catOpts}</select></div>
          <div class="hp-field"><label for="hpSev">严重程度</label><select id="hpSev"><option>高</option><option>中</option><option>低</option></select></div>
        </div>
        <details class="hp-more" id="hpMore"><summary>关联规则与反馈性质 <span>选填</span></summary>
          <div class="hp-field"><label for="hpRule">关联规则</label><select id="hpRule"><option value="">不关联规则</option></select></div>
          <div class="hp-field"><label for="hpNature">反馈性质</label><select id="hpNature"><option value="其他">一般批注</option><option value="漏检">规则漏检</option><option value="误报">规则误报</option></select></div>
          <div class="hp-hint">规则按问题类别筛选；规则误报需选择具体规则。</div>
        </details>
        <div id="hpError" class="hp-error hidden" role="alert"></div>
        <div id="hpDiscard" class="hp-discard hidden"><p>这条批注尚未保存，是否放弃？</p><div><button type="button" class="btn btn-sm" id="hpKeep">继续编辑</button><button type="button" class="btn btn-sm" id="hpDrop">放弃本条</button></div></div>
      </div>
      <div class="hp-actions"><span class="hp-status" id="hpStatus" role="status">仅添加批注，原文不变</span><button type="button" class="btn" id="hpCancel">取消</button><button type="submit" class="btn btn-primary" id="hpSave">保存批注</button></div>
    </form>`;
  $('#hpCat').value = humanMarkDefaults.category;
  $('#hpSev').value = humanMarkDefaults.severity;
  pop.classList.remove('hidden');
  positionHumanPop();
  $('#hpNote')?.focus();
  $('#hpCancel')?.addEventListener('click', requestCloseHumanPop);
  $('#hpClose')?.addEventListener('click', requestCloseHumanPop);
  $('#hpKeep')?.addEventListener('click', () => { $('#hpDiscard').classList.add('hidden'); $('#hpNote').focus(); positionHumanPop(); });
  $('#hpDrop')?.addEventListener('click', () => { closeHumanPop(); $('#btnHumanReview')?.focus(); });
  $('#hpMore')?.addEventListener('toggle', positionHumanPop);
  $('#hpForm')?.addEventListener('submit', (event) => { event.preventDefault(); saveHumanMark(); });
  pop.onkeydown = (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); saveHumanMark(); }
  };
  for (const id of ['hpNote', 'hpCat', 'hpSev', 'hpRule', 'hpNature']) {
    $('#' + id)?.addEventListener(id === 'hpNote' ? 'input' : 'change', () => {
      if (pendingInfo !== info) return;
      info.dirty = true; humanPopError(); $('#hpNote').removeAttribute('aria-invalid');
      $('#hpDiscard').classList.add('hidden');
    });
  }
  const fillRules = () => {
    if (pendingInfo !== info || !sameHumanContext(info.context)) return;
    const sel = $('#hpRule'), chosen = sel.value;
    const opts = (info.rules || []).filter(option => option.category === $('#hpCat').value);
    sel.innerHTML = '<option value="">不关联规则</option>' + opts.map(o => `<option value="${esc(o.id)}">${esc(o.id)} ${esc(o.title)}</option>`).join('');
    if (opts.some(o => o.id === chosen)) sel.value = chosen;
    sel.title = sel.selectedOptions?.[0]?.textContent || '';
  };
  $('#hpCat')?.addEventListener('change', fillRules);
  $('#hpRule')?.addEventListener('change', () => { $('#hpRule').title = $('#hpRule').selectedOptions?.[0]?.textContent || ''; });
  // 异步填充规则下拉（B3）：把标注关联到具体规则，审计数据才能直接归因到规则
  rulePickerOptions().then((opts) => {
    if (pendingInfo !== info) return;
    info.rules = opts; fillRules();
  });
}

/** 把选区包成一个 `.human-mark`（textContent 不变，不影响后续下划线对齐） */
function wrapSelection(range, id) {
  try {
    const r2 = range.cloneRange();
    const frag = r2.extractContents();
    const span = document.createElement('span');
    span.className = 'human-mark';
    span.dataset.hm = id;
    span.appendChild(frag);
    r2.insertNode(span);
    return span;
  } catch { return null; }
}

async function saveHumanMark() {
  if (!pendingRange || !pendingInfo || pendingInfo.saving) return;
  const info = pendingInfo;
  if (!sameHumanContext(info.context)) { closeHumanPop(); toast('稿件版本已改变，请重新圈画'); return; }
  const cat = $('#hpCat')?.value || '其他';
  const sev = $('#hpSev')?.value || '中';
  const note = $('#hpNote')?.value.trim() || '';
  const ruleId = $('#hpRule')?.value || '';
  const nature = $('#hpNature')?.value || '其他';
  if (!note) {
    humanPopError('请填写批注意见后保存。'); $('#hpNote')?.setAttribute('aria-invalid', 'true'); $('#hpNote')?.focus(); return;
  }
  if (nature === '误报' && !ruleId) {
    $('#hpMore').open = true; humanPopError('记录规则误报时，请选择对应规则。'); $('#hpRule')?.focus(); positionHumanPop(); return;
  }
  const current = () => pendingInfo === info && sameHumanContext(info.context)
    && readerBindingMatches(info.readerBinding) && !state.showOriginal
    && $('#docHost')?.contains(info.paragraph)
    && readerSourceProjection(info.paragraph)?.source === info.sourceNode
    && info.sourceNode.text.slice(info.rawStart, info.rawEnd) === info.text;
  if (!current()) { closeHumanPop(); toast('这处正文已变化，请重新圈画'); return; }
  info.saving = true;
  humanPopError();
  const controls = [...$('#humanPop').querySelectorAll('button, input, textarea, select')];
  controls.forEach(control => { control.disabled = true; });
  const saveButton = $('#hpSave');
  if (saveButton) saveButton.textContent = '保存中…';
  if ($('#hpStatus')) $('#hpStatus').textContent = '正在核对原文并保存';
  try {
  const rawText = info.sourceNode.text;
  const rawNodeTextSha256 = await readerTextSha256(rawText);
  if (!current() || info.sourceNode.text !== rawText) return;
  if (!rawNodeTextSha256) { humanPopError('原文范围核对失败，请重试。批注意见已保留。'); return; }
  const saved = await saveHumanRecord('mark', { mark: { target: info.target, index: info.index,
    start: info.rawStart, end: info.rawEnd, offsetSpace: 'raw', quote: info.text, text: info.text,
    rawNodeTextSha256, textView: 'after', offsetUnit: 'utf16', paragraphIndexOwner: 'application-paragraph-index',
    sourceVersionId: info.readerBinding.versionId, sourcePackageSha256: info.readerBinding.packageSha256,
    part: info.sourceNode.part, sourceXmlNodeId: info.sourceNode.sourceXmlNodeId,
    sourceXmlParagraphOrdinal: info.sourceNode.sourceXmlParagraphOrdinal,
    ...(['footnote', 'endnote'].includes(info.target) ? { noteId: info.sourceNode.noteId } : {}),
    category: cat, severity: sev, note, ruleId, nature } });
  if (saved && sameHumanContext(info.context)) {
    humanMarkDefaults = { category: cat, severity: sev };
    closeHumanPop();
  } else if (pendingInfo === info) humanPopError('批注未保存，输入内容已保留。请核对提示后重试。');
  } catch {
    if (pendingInfo === info) humanPopError('批注保存失败，输入内容已保留，请重试。');
  } finally {
    info.saving = false;
    if (pendingInfo === info) {
      controls.forEach(control => { control.disabled = false; });
      if (saveButton) saveButton.textContent = '保存批注';
      if ($('#hpStatus')) $('#hpStatus').textContent = '尚未保存';
    }
  }
}

/**
 * 在段落内把一段文字包成指定元素（人工标注回放用）。
 * 与问题标记使用同一源字符投影。旧 normalized 记录仅由当前完整原文
 * 重新计算范围；其 cached raw 坐标可能属于旧解析器，不作定位凭证。
 */
function wrapTextInParagraph(pEl, needle, build, bounds) {
  const projection = readerSourceProjection(pEl);
  if (!projection || typeof needle !== 'string') return null;
  let start, end;
  if (bounds?.offsetSpace === 'raw') {
    start = bounds.start; end = bounds.end;
    if (bounds.rawStart != null && bounds.rawStart !== start || bounds.rawEnd != null && bounds.rawEnd !== end
      || projection.sourceRaw.slice(start, end) !== needle) return null;
  } else {
    const positions = [];
    for (let i = 0; i < projection.sourceRaw.length; i += 1) if (!/\s/.test(projection.sourceRaw[i])) positions.push(i);
    if (!Number.isInteger(bounds?.start) || !Number.isInteger(bounds.end) || bounds.start < 0
      || bounds.end <= bounds.start || bounds.end > positions.length
      || normText(projection.sourceRaw).slice(bounds.start, bounds.end) !== normText(needle)) return null;
    start = positions[bounds.start]; end = positions[bounds.end - 1] + 1;
  }
  return readerWrapProjection(pEl, projection, start, end, build)[0] || null;
}

/** 按已有记录把人工圈画重新画回正文（重渲后调用） */
function humanNodeForParagraph(paragraph) {
  if (!readerSourceProjection(paragraph)?.sourceRaw.length || state.showOriginal) return null;
  if (renderedNoteContainer(paragraph) || paragraph.dataset.noteKind) return readerNoteTarget(paragraph);
  const target = readerBodyTarget(paragraph);
  return target ? { target: 'body', index: target.index } : null;
}

/** Convert a proven DOM selection to its current source coordinates, excluding
 * generated note glyphs and nested textbox text. Unsupported endpoints refuse. */
function readerSelectionBounds(paragraph, range, raw) {
  const projection = readerSourceProjection(paragraph);
  if (!projection || projection.sourceRaw !== raw) return null;
  const units = projection.units;
  const boundary = (container, offset) => {
    if (container?.nodeType !== 3 || !Number.isInteger(offset)
      || offset < 0 || offset > container.textContent.length) return null;
    const before = units.find(unit => unit.node === container && unit.offset === offset);
    if (before) return before.sourceStart;
    const after = units.find(unit => unit.node === container && unit.offset + 1 === offset);
    return after?.sourceEnd ?? null;
  };
  let start = boundary(range.startContainer, range.startOffset), end = boundary(range.endContainer, range.endOffset);
  if ((start == null || end == null) && typeof range.comparePoint === 'function') {
    const selected = units.filter(point => range.comparePoint(point.node, point.offset) === 0 && range.comparePoint(point.node, point.offset + 1) === 0);
    if (!selected.length) return null;
    start = selected[0].sourceStart; end = selected.at(-1).sourceEnd;
    if (selected.some((point, i) => i && point.sourceStart !== selected[i - 1].sourceEnd)) return null;
  }
  if (!readerProjectionRange(projection, start, end)) return null;
  return { start: normText(raw.slice(0, start)).length, end: normText(raw.slice(0, end)).length,
    rawStart: start, rawEnd: end };
}

const readerTextHashes = new Map();
function readerTextSha256(text) {
  const cryptoApi = globalThis.crypto || window.crypto;
  if (!cryptoApi?.subtle || typeof TextEncoder !== 'function') return Promise.resolve(null);
  if (!readerTextHashes.has(text)) {
    // Bound the cache; immutable strings are safe cache keys across redraws.
    if (readerTextHashes.size >= 128) readerTextHashes.clear();
    readerTextHashes.set(text, cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(text))
      .then(hash => [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('')).catch(() => null));
  }
  return readerTextHashes.get(text);
}

async function reapplyHumanMarks() {
  const host = $('#docHost');
  if (!host || state.showOriginal) return;
  host.querySelectorAll('li p').forEach(humanNodeForParagraph);
  for (const hm of state.humanMarks) {
    const attr = hm.target === 'body' ? 'data-pindex' : hm.target === 'footnote' ? 'data-findex' : hm.target === 'endnote' ? 'data-eindex' : null;
    if (!attr || !Number.isInteger(hm.index)) continue;
    for (const el of readerBoundParagraphs(host, hm.target, hm.index)) {
    if (el.querySelector(`.human-mark[data-hm="${hm.id}"]`)) continue;
    const list = hm.target === 'body' ? state.doc?.paragraphs : hm.target === 'footnote' ? state.doc?.footnotes : state.doc?.endnotes;
    const source = list?.[hm.index], projection = readerSourceProjection(el), context = humanContext();
    if (!source || projection?.sourceRaw !== source.text) continue;
    if (hm.offsetSpace === 'raw' && (hm.sourceVersionId !== state.workVersion?.id
      || hm.sourcePackageSha256 !== projection.binding.packageSha256 || hm.part !== source.part
      || hm.sourceXmlNodeId !== source.sourceXmlNodeId || hm.sourceXmlParagraphOrdinal !== source.sourceXmlParagraphOrdinal
      || hm.textView !== 'after' || hm.offsetUnit !== 'utf16' || hm.paragraphIndexOwner !== 'application-paragraph-index'
      || !/^[a-f0-9]{64}$/.test(hm.rawNodeTextSha256 || '')
      || ['footnote', 'endnote'].includes(hm.target) && String(hm.noteId) !== String(source.noteId))) continue;
    const expectedHash = hm.offsetSpace === 'raw' ? hm.rawNodeTextSha256 : hm.nodeTextSha256;
    if (expectedHash) {
      const hash = await readerTextSha256(hm.offsetSpace === 'raw' ? source.text : normText(source.text));
      if (!hash || hash !== expectedHash || !sameHumanContext(context) || !state.humanMarks.includes(hm)
        || source.text !== projection.sourceRaw || !host.contains(el) || !readerBindingMatches(projection.binding)) continue;
    }
    if (el.querySelector(`.human-mark[data-hm="${hm.id}"]`)) continue;
    wrapTextInParagraph(el, hm.quote || hm.text, () => {
      const s = document.createElement('span');
      s.className = 'human-mark';
      s.dataset.hm = hm.id;
      s.title = `[人工] ${hm.category}·${hm.severity}${hm.note ? '：' + hm.note : ''}`;
      return s;
    }, hm);
    }
  }
}

/**
 * 人工审阅模式下监听选区：框选正文后弹出记录表单。
 * 只认落在 `#docHost` 正文里的选区，避免选中侧栏文字也弹窗。
 */
function onDocMouseUp() {
  if (!state.humanMode) return;
  if (pendingInfo?.saving || pendingInfo?.dirty) { toast('当前批注尚未保存，请先保存或取消后再选取下一处'); return; }
  if (state.showOriginal || state.streaming || applyFixRequests.has(state.sessionId)) { toast('请在当前稿保存和审阅完成后圈画标注'); return; }
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const host = $('#docHost');
  if (!host || !host.contains(range.commonAncestorContainer)) return;
  const closestParagraph = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest('p');
  const p = closestParagraph(range.startContainer);
  if (!p || p !== closestParagraph(range.endContainer)) { toast('请在同一段正文或注释中圈画，跨段内容请分开记录'); return; }
  const node = humanNodeForParagraph(p);
  const target = node?.target;
  const index = node?.index;
  const list = target === 'body' ? state.doc?.paragraphs : target === 'footnote' ? state.doc?.footnotes : state.doc?.endnotes;
  const projection = readerSourceProjection(p);
  if (!target || !Number.isInteger(index) || projection?.sourceRaw !== list?.[index]?.text) {
    toast('这处正文尚未准确对应稿件，不能保存圈画'); return;
  }
  const bounds = readerSelectionBounds(p, range, list[index].text);
  if (!bounds) {
    toast('选区坐标无法精确核对，请重新圈画'); return;
  }
  const rect = range.getBoundingClientRect();
  pendingRange = range.cloneRange();
  pendingInfo = {
    text: list[index].text.slice(bounds.rawStart, bounds.rawEnd),
    target, index, ...bounds,
    paragraph: p, sourceNode: list[index], readerBinding: projection.binding,
    context: humanContext(),
    rect,
    paragraphIndex: p?.dataset.pindex !== undefined ? Number(p.dataset.pindex) : null,
    wordIndex: null,
    location: target === 'footnote' ? `脚注 ${index + 1}` : target === 'endnote' ? `尾注 ${index + 1}` : `第 ${index + 1} 段`,
  };
  openHumanPop(pendingInfo);
}

/* ==================================================================
   审稿日志（需求 7）：本次操作 + 溯源 + 规则优化建议
   ================================================================== */
const KIND_LABEL = {
  'human-mark': '人工标注', 'human-decision': '人工处置', 'human-comment': '人工看法',
  'model-opinion': '模型观点', 'fix-apply': '自动修复', export: '导出',
};
const HD_LABEL = { accept: '采纳', reject: '不采纳', unsure: '存疑', mark: '圈画' };

function renderLegacyReview(data, name) {
  const legacy = data.legacy || {};
  const view = data.view || {};
  const issues = view.issues || [];
  const consistency = { verified: '历史来源内容已核对', mismatch: '历史来源内容不一致', unknown: '历史来源内容未验证' }[legacy.consistency] || '历史来源内容未验证';
  const captured = new Date(legacy.capturedAt);
  const capturedAt = Number.isNaN(captured.getTime()) ? '未记录'
    : captured.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const usage = view.usage;
  const usageHtml = usage ? `历史已记录用量：输入 ${esc(usage.input_tokens ?? '未记录')} / 输出 ${esc(usage.output_tokens ?? '未记录')} Token`
    : '历史未记录 Token 用量';
  const errors = view.modelErrors || [];
  const currentNotice = state.summary ? '当前稿已有本轮审阅结果，历史记录仅供对照，请以当前工作区结果为准。'
    : state.clean?.status === 'legacy-unverified' ? '请先验证当前稿清洗，再手动开始新的审阅。' : '当前稿需要显式重新审阅。';
  return `<div class="audit-sec"><h3>历史审阅记录：${esc(name || '')}</h3>
    <p>此处仅显示迁移前保存的历史记录。${esc(currentNotice)}历史意见不会标到当前正文或用于自动修改。</p>
    <div>${esc(consistency)}${legacy.reason ? `：${esc(legacy.reason)}` : ''}</div>
    <div class="muted small">来源：${esc(legacy.sourceBase || '未记录')} · 保存时间：${esc(capturedAt)}</div>
    <div>保存问题 ${issues.length} 条 · ${usageHtml}</div>
    ${view.recheck?.stats ? `<div>历史复核：已检查 ${esc(view.recheck.stats.checked ?? '未记录')} 条，未返回 ${esc(view.recheck.stats.noReply ?? '未记录')} 条</div>` : '<div class="muted small">历史未保存复核统计</div>'}
    ${errors.length ? `<div class="muted small">历史审阅有 ${errors.length} 个未完成窗口：${errors.map((error) => esc(error.message || '未记录原因')).join('；')}</div>` : ''}
    <details><summary>历史记录来源与保存凭证</summary><div>来源记录：${esc(legacy.sourceSessionId || '未记录')}</div><pre class="quote">${esc(JSON.stringify(data.captureHashes || {}, null, 2))}</pre></details>
  </div>
  ${issues.length ? issues.map((issue, index) => `<section class="audit-sec">
    <h4>${index + 1}. ${esc(issue.title || issue.ruleId || '历史问题')}</h4>
    <div class="muted small">${esc(issue.ruleId || '')} · ${esc(issue.location || '历史记录未保存位置')}</div>
    <div><b>历史原文：</b><div class="quote">${esc(issue.quote || '未记录')}</div></div>
    <div><b>历史问题：</b>${esc(issue.message || issue.detail || '未记录')}</div>
    <div><b>历史建议：</b>${esc(issue.suggestion || issue.fix || issue.proposed || (issue.autoFix ? `把「${issue.autoFix.find || ''}」改为「${issue.autoFix.replace ?? ''}」` : '未记录'))}</div>
    ${issue.proposed ? `<div><b>历史改写：</b>${esc(issue.proposed)}</div>` : ''}
    ${issue.modelOpinion ? `<div><b>历史复核意见：</b>${esc(issue.modelOpinion)}</div>` : ''}
  </section>`).join('') : '<div class="muted small">历史记录没有保存问题清单。</div>'}`;
}

async function openLegacyReview() {
  if (!state.sessionId || state.legacy?.historyAvailable !== true) return;
  const sessionId = state.sessionId;
  const activationSerial = state.activationSerial;
  const requestSerial = ++state.auditRequestSerial;
  state.auditView = 'legacy';
  $('#auditTitle').textContent = '历史审阅记录';
  $('#auditModal').classList.remove('hidden');
  const body = $('#auditBody');
  body.innerHTML = '<div class="muted small">正在读取已保存的历史审阅…</div>';
  const isCurrent = () => state.sessionId === sessionId && state.activationSerial === activationSerial
    && state.auditRequestSerial === requestSerial && state.auditView === 'legacy';
  const name = state.doc?.label || state.doc?.meta?.title || '';
  try {
    const res = await fetch('/api/legacy-review?id=' + encodeURIComponent(sessionId));
    const data = await res.json();
    if (!isCurrent()) return;
    if (!res.ok || data.error) throw new Error(data.error || '历史审阅读取失败');
    body.innerHTML = renderLegacyReview(data, name);
  } catch (error) {
    if (isCurrent()) body.innerHTML = `<div class="empty">历史审阅读取失败：${esc(error.message)}</div>`;
  }
}

async function openAuditModal() {
  const modal = $('#auditModal');
  const body = $('#auditBody');
  if (!modal || !body) return;
  const requestSerial = ++state.auditRequestSerial;
  state.auditView = 'audit';
  $('#auditTitle').textContent = '审稿日志与经验积累';
  modal.classList.remove('hidden');
  body.innerHTML = '<div class="muted small">加载中…</div>';
  try {
    const q = state.sessionId ? ('?id=' + encodeURIComponent(state.sessionId)) : '';
    const [log, sum] = await Promise.all([
      (await fetch('/api/audit' + q)).json(),
      (await fetch('/api/audit-summary')).json(),
    ]);
    if (state.auditRequestSerial !== requestSerial || state.auditView !== 'audit') return;
    body.innerHTML = auditToolbarHtml() + renderAuditHtml(log.entries || [], sum);
    bindAuditToolbar();
  } catch (e) {
    if (state.auditRequestSerial !== requestSerial || state.auditView !== 'audit') return;
    body.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

/** 审稿日志导出工具条（B2） */
function auditToolbarHtml() {
  return `<div class="audit-tools">
    <span class="muted small">导出审稿日志（可带出做后续规则 / 提示词迭代）</span>
    <label>范围 <select id="expScope"><option value="all">全部（累积）</option><option value="session">本次审阅</option></select></label>
    <label>格式 <select id="expFmt"><option value="csv">CSV（Excel）</option><option value="jsonl">JSONL</option></select></label>
    <button class="btn btn-sm btn-primary" id="expGo">导出</button>
  </div>`;
}
function bindAuditToolbar() {
  $('#expGo')?.addEventListener('click', () => {
    const fmt = $('#expFmt')?.value || 'csv';
    const scope = $('#expScope')?.value || 'all';
    const p = new URLSearchParams({ format: fmt });
    if (scope === 'session' && state.sessionId) p.set('id', state.sessionId);
    window.location.href = '/api/audit-export?' + p.toString();
  });
  /**
   * 规则优化闭环（E1）：把汇总出的建议一键写回该规则的 `optimizationNote`
   * 字段（只记录，不改检测行为）。这样「要不要改提示词」的结论落到了
   * 规则文件里，下次打开规则页就能看到。
   */
  document.querySelectorAll('#auditBody .opt-write').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.dataset.rule;
      const sug = b.dataset.sug;
      b.disabled = true;
      try {
        const note = `${sug}（写入于 ${new Date().toLocaleString('zh-CN', { hour12: false })}）`;
        const r = await (await fetch('/api/rules/update', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, patch: { optimizationNote: note } }),
        })).json();
        if (r.error) { toast(r.error, 5000); b.disabled = false; return; }
        toast(`已把优化备注写入规则 ${id}`, 3600);
        b.textContent = '已写入';
      } catch (e) { toast('写入失败：' + e.message, 5000); b.disabled = false; }
    });
  });
}

function renderAuditHtml(entries, sum) {
  const L = [];
  L.push(`<div class="audit-sec"><h3>一、本次审阅的操作与溯源（${entries.length} 条）</h3>`);
  if (!entries.length) {
    L.push('<div class="muted small">本次审阅还没有人工操作记录。开启「人工审阅」在正文里圈画，或在问题详情里做人工处置，都会记录到这里。</div>');
  } else {
    L.push('<table class="audit-table"><thead><tr><th>时间</th><th>类型</th><th>位置</th><th>原文</th><th>规则</th><th>模型观点</th><th>人工处置/意见</th></tr></thead><tbody>');
    for (const e of entries.slice().reverse()) {
      const t = new Date(e.ts).toLocaleString('zh-CN', { hour12: false });
      L.push(`<tr>
        <td class="nowrap">${esc(t)}</td>
        <td>${esc(KIND_LABEL[e.kind] || e.kind)}</td>
        <td>${esc(e.location || '—')}</td>
        <td class="q">${esc((e.quote || '').slice(0, 60))}${(e.quote || '').length > 60 ? '…' : ''}</td>
        <td>${esc(e.ruleId || '—')}</td>
        <td class="q">${esc((e.modelOpinion || '').slice(0, 60))}</td>
        <td class="q">${e.humanAction ? `<b>${esc(HD_LABEL[e.humanAction] || e.humanAction)}</b> ` : ''}${e.attributes?.nature && e.kind === 'human-mark' ? `<span class="q-nature">[${esc(e.attributes.nature)}]</span> ` : ''}${esc(e.humanOpinion || '')}</td>
      </tr>`);
    }
    L.push('</tbody></table>');
  }
  L.push('</div>');

  L.push('<div class="audit-sec"><h3>二、规则 / 提示词优化建议（累积自全部审稿日志）</h3>');
  const rules = (sum.rules || []).filter((r) => r.suggestion);
  if (!rules.length) {
    L.push(`<div class="muted small">暂无需要复核的规则（累计 ${sum.total || 0} 条审稿记录）。当某条规则被人工反复驳回、或被模型反复否决、或审稿人反复自行标注时，这里会自动给出建议。</div>`);
  } else {
    L.push('<table class="audit-table"><thead><tr><th>规则</th><th>驳回</th><th>模型异议</th><th>人工标注</th><th>建议</th><th>操作</th></tr></thead><tbody>');
    for (const r of rules.slice(0, 30)) {
      L.push(`<tr>
        <td>${esc(r.ruleId)}<div class="muted small">${esc((r.ruleTitle || '').slice(0, 30))}</div></td>
        <td>${r.reject}</td><td>${r.modelDisagree}</td><td>${r.humanMark}</td>
        <td class="q">${esc(r.suggestion)}</td>
        <td><button class="btn btn-sm opt-write" data-rule="${esc(r.ruleId)}" data-sug="${esc(r.suggestion)}">写入规则备注</button></td>
      </tr>`);
    }
    L.push('</tbody></table>');
  }
  L.push('</div>');
  return L.join('');
}

/* ==================================================================
   规则管理视图
   规则库同时支持两种形态：
     · 格式式（detect.type = regex/list/…）→ 规则引擎可直接比对
     · 提示词式（detect.type = model）    → 交模型逐条语义判断，输出 JSON 映射回批阅视图
   ================================================================== */
const rulesState = { data: null, loading: false, group: 'all', status: 'all', q: '', open: new Set(), editing: null };

const STATUS_LABEL = { auto: '规则引擎', model: '模型判断', manual: '人工复核' };
const STATUS_TIP = {
  auto: '已做成确定性检测，可直接机器比对',
  model: '提示词式规则，由大模型逐条语义判断',
  manual: '未做成自动检测，仅作为审稿要点提示',
};

async function loadRules() {
  if (rulesState.data || rulesState.loading) return;
  rulesState.loading = true;
  try {
    rulesState.data = await (await fetch('/api/rules')).json();
  } catch (e) {
    rulesState.data = { error: e.message };
  } finally {
    rulesState.loading = false;
  }
}

function allRules() {
  const d = rulesState.data;
  if (!d || d.error) return [];
  const out = [];
  const seen = new Set();
  const push = (r, group, groupLabel) => {
    // modelRules 是 language.rules 里 detect.type=model 的子集（同样的 LANG-* id），
    // 直接拼接会重复计数（144 vs 135），所以按 id 去重，保留先出现的分组。
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push({ ...r, group, groupLabel });
  };
  for (const [group, label] of [['format', '格式'], ['language', '语言'], ['citation', '引文']]) {
    const g = d[group];
    for (const r of (g && g.rules) || []) push(r, group, label);
  }
  // 兜底：modelRules 里若有 language 未收录的，仍然展示（标为模型）
  for (const r of d.modelRules || []) push(r, 'language', '语言');
  return out;
}

function ruleStatus(r) {
  return r.status || (r.detect && r.detect.type === 'model' ? 'model' : 'auto');
}

async function renderRules() {
  const box = $('#viewRules');
  if (!box) return;
  if (!rulesState.data) {
    box.innerHTML = '<div class="empty">正在加载规则库…</div>';
    await loadRules();
  }
  const d = rulesState.data;
  if (!d || d.error) {
    box.innerHTML = `<div class="empty">规则库加载失败：${esc(d?.error || '未知错误')}</div>`;
    return;
  }
  const all = allRules();
  const s = d.statusSummary || {};
  // 分组计数按去重后的实际条数算，避免与 statusSummary 口径不一致
  const groupCount = (g) => (g === 'all' ? all.length : all.filter((r) => r.group === g).length);
  const statusCount = (k) => (k === 'all' ? all.length : all.filter((r) => ruleStatus(r) === k).length);
  const groups = [['all', '全部'], ['format', '格式'], ['language', '语言'], ['citation', '引文']];
  // 「未触发」必须单独成一档：它既不是「模型判断」也不是「人工复核」，
  // 而是「判据有效但本语料上不可能触发」。不给它一档的话，
  // 这类规则在按状态筛选时无处可去，用户看不出它们其实从没跑出过结果。
  const statuses = [
    ['all', '全部'], ['auto', '规则引擎'], ['auto-未触发', '未触发'],
    ['model', '模型判断'], ['manual', '人工复核'],
  ];

  const filtered = all.filter((r) => {
    if (rulesState.group !== 'all' && r.group !== rulesState.group) return false;
    if (rulesState.status !== 'all' && ruleStatus(r) !== rulesState.status) return false;
    if (rulesState.q) {
      const hay = `${r.id || ''}${r.title || ''}${r.rule || r.detail || r.normative || ''}${r.category || ''}${r.basis || ''}`;
      if (!hay.includes(rulesState.q)) return false;
    }
    return true;
  });

  box.innerHTML = `
    <div class="rules-wrap">
      <div class="rules-head">
        <div class="rules-stats">
          <span><b>${all.length}</b> 条规则</span>
          <span class="tag tag-auto">规则引擎 ${statusCount('auto')}</span>
          <span class="tag tag-dormant">未触发 ${statusCount('auto-未触发')}</span>
          <span class="tag tag-model">模型判断 ${statusCount('model')}</span>
          <span class="tag tag-manual">人工复核 ${statusCount('manual')}</span>
        </div>
        <div class="rules-note muted small">${esc(s.note || '')}</div>
        <div class="rules-controls">
          <input id="rulesSearch" class="search" placeholder="搜索规则编号 / 标题 / 说明" value="${esc(rulesState.q)}" />
          <div class="filter-row" id="rulesGroup">
            ${groups.map(([k, l]) => `<button class="chip${rulesState.group === k ? ' chip-on' : ''}" data-g="${k}">${l} ${groupCount(k)}</button>`).join('')}
          </div>
          <div class="filter-row" id="rulesStatus">
            ${statuses.map(([k, l]) => `<button class="chip${rulesState.status === k ? ' chip-on' : ''}" data-s="${k}">${l} ${statusCount(k)}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="rules-list">
        ${filtered.length ? filtered.map(ruleCard).join('') : '<div class="empty">没有符合条件的规则。</div>'}
      </div>
    </div>`;

  // 事件
  box.querySelector('#rulesSearch').addEventListener('input', (e) => {
    rulesState.q = e.target.value.trim();
    clearTimeout(renderRules._t);
    renderRules._t = setTimeout(renderRules, 200);
  });
  box.querySelector('#rulesGroup').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    rulesState.group = c.dataset.g; renderRules();
  });
  box.querySelector('#rulesStatus').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    rulesState.status = c.dataset.s; renderRules();
  });
  box.querySelectorAll('.rule-card-head').forEach((h) => {
    h.addEventListener('click', () => {
      const id = h.parentElement.dataset.id;
      if (rulesState.open.has(id)) rulesState.open.delete(id); else rulesState.open.add(id);
      h.parentElement.classList.toggle('open', rulesState.open.has(id));
    });
  });
  // 规则编辑（需求：所有规则都要可以查看编辑）
  box.querySelectorAll('.rule-edit-btn').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.edit;
      rulesState.editing = id;
      rulesState.open.add(id);
      renderRules();
      const card = box.querySelector(`.rule-card[data-id="${CSS.escape(id)}"]`);
      card?.querySelector('[data-field="title"]')?.focus();
    });
  });
  box.querySelectorAll('.rule-cancel-btn').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      rulesState.editing = null;
      renderRules();
    });
  });
  box.querySelectorAll('.rule-save-btn').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      saveRuleEdit(b.dataset.id);
    });
  });
}

/**
 * 保存规则编辑：POST /api/rules/update → 重新拉取规则库 → 重渲。
 *
 * 保存后**重新拉取**而不是就地改本地对象：执行状态（auto/model/manual）
 * 由后端按「detect.type + 源码实现」现算，就地改会与服务端口径脱节。
 */
async function saveRuleEdit(id) {
  const card = [...document.querySelectorAll('.rule-card')].find((c) => c.dataset.id === id);
  if (!card) return;
  const val = (f) => {
    const el = card.querySelector(`[data-field="${CSS.escape(f)}"]`);
    return el ? el.value : undefined;
  };
  const patch = {
    title: val('title'), category: val('category'), severity: val('severity'), basis: val('basis'),
    rule: val('rule'), detail: val('detail'), fix: val('fix'),
    detect: { type: val('detect.type'), method: val('detect.method'), patterns: val('detect.patterns') },
    badExamples: val('badExamples'), goodExamples: val('goodExamples'),
  };
  const occ = val('occurrences');
  if (occ !== undefined && occ !== '') patch.occurrences = occ;
  const btn = card.querySelector('.rule-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const res = await fetch('/api/rules/update', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, patch }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    rulesState.editing = null;
    rulesState.data = null;
    await loadRules();
    await renderRules();
    toast(`规则 ${id} 已保存`);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
    toast(`保存失败：${e.message}`, 4000);
  }
}

function ruleCard(r) {
  const st = ruleStatus(r);
  const open = rulesState.open.has(r.id);
  const editing = open && rulesState.editing === r.id;
  const det = r.detect || {};
  const typeLabel = det.type === 'model' ? '提示词式（大模型语义判断）'
    : det.type === 'manual' ? '人工复核'
    : det.type ? `格式式（${esc(det.type)}）` : '—';
  return `<div class="rule-card${open ? ' open' : ''}${editing ? ' editing' : ''}" data-id="${esc(r.id)}">
    <div class="rule-card-head">
      <span class="rule-id">${esc(r.id)}</span>
      <span class="tag tag-${GROUP_TAG[r.group] || 'model'}">${esc(r.groupLabel)}</span>
      <span class="sev sev-${r.severity}">${esc(r.severity || '')}</span>
      <span class="rule-title">${esc(r.title || '')}</span>
      <span class="tag tag-status tag-${st}" title="${esc(STATUS_TIP[st] || '')}">${STATUS_LABEL[st] || st}</span>
      ${r.occurrences ? `<span class="muted small rule-occ">历史出现 ${r.occurrences} 次</span>` : ''}
      <button class="rule-edit-btn" data-edit="${esc(r.id)}" title="编辑这条规则">${editing ? '编辑中' : '编辑'}</button>
      <span class="rule-caret">${open ? '−' : '+'}</span>
    </div>
    <div class="rule-card-body">
      ${editing ? ruleEditor(r) : ruleView(r, typeLabel, det)}
    </div>
  </div>`;
}

/** 规则的只读展示（默认形态） */
function ruleView(r, typeLabel, det) {
  return `<div class="detail-block"><label>类别</label><div>${esc(r.category || '—')}</div></div>
      <div class="detail-block"><label>规则</label><div>${esc(r.rule || r.detail || r.normative || r.title || '—')}</div></div>
      ${r.basis ? `<div class="detail-block"><label>依据</label><div>${esc(r.basis)}</div></div>` : ''}
      ${(r.evidence || []).length ? `<div class="detail-block"><label>历史批注证据</label><div>${r.evidence.map((e) => `${esc(e.file || '')}<br />${esc(e.comment || '')}`).join('<br /><br />')}</div></div>` : ''}
      ${(r.badExamples || []).length ? `<div class="detail-block"><label>反例</label><div>${r.badExamples.map((x) => esc(x)).join('<br />')}</div></div>` : ''}
      ${(r.goodExamples || []).length ? `<div class="detail-block"><label>正例</label><div>${r.goodExamples.map((x) => esc(x)).join('<br />')}</div></div>` : ''}
      <div class="detail-block"><label>修改建议</label><div>${esc(r.fix || '—')}</div></div>
      <div class="detail-block"><label>检测方式</label><div>${typeLabel}</div></div>
      ${det.method ? `<div class="detail-block"><label>判断要点</label><div>${esc(det.method)}</div></div>` : ''}
      ${(det.patterns || []).length ? `<div class="detail-block"><label>违例模式</label><div class="mono">${det.patterns.map((x) => esc(String(x))).join('<br />')}</div></div>` : ''}
      ${r.statusNote ? `<div class="detail-block"><label>状态说明</label><div class="muted small">${esc(r.statusNote)}</div></div>` : ''}`;
}

/** 规则的可编辑表单：字段保存后写入规则库文件并立即生效 */
function ruleEditor(r) {
  const det = r.detect || {};
  const raw = (v) => esc(v == null ? '' : String(v));
  const opt = (v, list) => {
    const vals = list.includes(v) || !v ? list : [v, ...list];
    return vals.map((o) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('');
  };
  return `<div class="rule-editor">
    <div class="rule-edit-grid">
      <label>标题<input data-field="title" value="${raw(r.title)}" /></label>
      <label>类别<input data-field="category" value="${raw(r.category)}" /></label>
      <label>严重度<select data-field="severity">${opt(r.severity, ['高', '中', '低'])}</select></label>
      <label>检测类型<select data-field="detect.type">${opt(det.type, ['regex', 'list', 'structure', 'model', 'manual'])}</select></label>
      <label>依据<input data-field="basis" value="${raw(r.basis)}" /></label>
      <label>历史出现次数<input data-field="occurrences" value="${raw(r.occurrences)}" inputmode="numeric" /></label>
    </div>
    <label class="rule-edit-full">规则说明<textarea data-field="rule" rows="3">${raw(r.rule)}</textarea></label>
    <label class="rule-edit-full">问题说明<textarea data-field="detail" rows="2">${raw(r.detail)}</textarea></label>
    <label class="rule-edit-full">修改建议<textarea data-field="fix" rows="2">${raw(r.fix)}</textarea></label>
    <label class="rule-edit-full">判断要点（模型判断用）<textarea data-field="detect.method" rows="2">${raw(det.method)}</textarea></label>
    <label class="rule-edit-full">违例模式（每行一条正则）<textarea data-field="detect.patterns" rows="3" class="mono">${raw((det.patterns || []).join('\n'))}</textarea></label>
    <div class="rule-edit-grid">
      <label>反例（每行一条）<textarea data-field="badExamples" rows="3">${raw((r.badExamples || []).join('\n'))}</textarea></label>
      <label>正例（每行一条）<textarea data-field="goodExamples" rows="3">${raw((r.goodExamples || []).join('\n'))}</textarea></label>
    </div>
    <div class="rule-edit-actions">
      <button class="rule-save-btn" data-id="${esc(r.id)}">保存</button>
      <button class="rule-cancel-btn">取消</button>
      <span class="muted small">保存后写入 <code>rules/</code> 规则库文件，立即生效（下次审阅即用新规则）。</span>
    </div>
  </div>`;
}

/* ---- 选中问题 ---- */
function selectIssue(key) {
  const it = state.issues.find((x) => issueKey(x) === key);
  if (!it) return;
  state.activeIssueKey = key;
  $$('.mk-issue').forEach((el) => el.classList.toggle('active', el.dataset.key === key));
  const d = $('#detail');
  d.classList.remove('hidden');
  $('#detailTitle').textContent = it.title;
  $('#detailAsk').disabled = false;
  const readerProblem = readerNoteIssueProblem(it);
  $('#detailMeta').textContent = `${it.ruleId} · ${GROUP_LABEL[it.group] || it.group} · ${it.severity} · ${it.location}${it.needsRelocation ? ' · 需重新定位' : readerProblem ? ' · 页面未准确定位' : ''}`;
  $('#detailQuote').textContent = (it.needsRelocation ? '（审阅时原文，当前位置需重新定位）' : '') + (it.quote || '（无原文片段）');
  /**
   * 「错在哪、怎么改」要用**本条的具体判定/具体改法**：
   *   问题 → it.message（本条具体命中，如「中文语境下使用了半角标点「,」」），
   *          没有则退到规则说明 it.detail；
   *   建议 → it.suggestion（本条具体改法，如「改为全角「，」」），
   *          没有则退到规则级 it.fix。
   * 否则同一规则下几十条都显示同一句泛泛的规则原文，等于没说清。
   * 规则原文保留在 title 悬浮里，便于回看判据。
   */
  $('#detailProblem').textContent = (it.message || it.detail || '—')
    + (it.needsRelocation ? `；需重新定位：${it.relocationReason || '修改已涉及原标注范围'}。请重新审阅当前稿确认位置。` : readerProblem ? `；${readerProblem}` : '');
  $('#detailProblem').title = it.detail || '';
  $('#detailFix').textContent = it.suggestion || it.fix || '—';
  $('#detailFix').title = it.fix || '';
  $('#detailProposedWrap').classList.toggle('hidden', !it.proposed);
  $('#detailProposed').textContent = it.proposed || '';
  $('#detailBasis').textContent = it.basis || '—';
  renderRecheck(it);
  updateDetailFixBtn(it);
  $('#detailAnswer').classList.add('hidden');
  $('#detailAnswer').textContent = '';
  /**
   * 点击清单条目 → 正文跳到该问题位置（需求 3）。
   *
   * `scrollToIssueInDoc()` 在旧代码里已经写好却**没有任何调用点**，
   * 所以「可点击跳转」这件事此前等于没实现。这里把它接上。
   * 位置：详情面板填充之后、开抽屉之前 —— 抽屉打开会改变布局，
   * 先滚动再开抽屉在窄屏上会滚偏。
   */
  scrollToIssueInDoc(key);
  // 窄屏：详情在右抽屉里，自动打开
  if (NARROW() && !$('#rightPanel').classList.contains('open')) openDrawer('right');
}

/** 详情面板底部的「一键修改」按钮：只有可直接改写、且未修复时才可用 */
function updateDetailFixBtn(it) {
  const btn = $('#detailFixOne');
  if (!btn) return;
  const key = issueKey(it);
  const done = state.resolved.has(key);
  const fixable = isFixable(it);
  btn.classList.toggle('hidden', !fixable && !done);
  btn.disabled = !fixable || done;
  btn.dataset.key = key;
  btn.textContent = done ? '已修改' : '一键修改';
  btn.title = state.showOriginal ? '原稿仅供核对，请返回当前稿后修改'
    : it.needsRelocation ? '该问题需重新定位，请重新审阅当前稿'
    : issueRangeProblem(it) || readerNoteIssueProblem(it) || (fixable
    ? `把「${it.autoFix.find}」改为「${it.autoFix.replace ?? ''}」`
    : '该条不支持自动修改');
}

/**
 * 渲染「模型复核」块（目标点 13：每次修改都要有模型复核是否正确）。
 *
 * 后端一直在算 `recheck.byKey`（key 与 `issueKey()` 同构），但前端从来没显示过。
 * 用户看不到「这条改法模型认不认」，复核就等于白跑 ——
 * 而这正是目标点 13 明确要求的一步。
 *
 * 三种结论的措辞要分清楚，不能含糊成「已复核」：
 *   agree    → 模型认为改法正确
 *   disagree → 模型认为改法不对，并给出更好的写法（`better`）
 *   unsure   → 模型没给结论 / 说不好判断（**不是「正确」**，必须显式区分）
 */
function renderRecheck(it) {
  const wrap = $('#detailRecheckWrap');
  const box = $('#detailRecheck');
  if (!wrap || !box) return;
  const key = issueKey(it);
  const boundContext = humanContext();
  const boundActivationSerial = state.activationSerial;
  const bindingIsCurrent = () => sameHumanContext(boundContext) && state.activationSerial === boundActivationSerial
    && state.activeIssueKey === key;
  const r = state.recheck?.[key];
  const META = {
    agree: ['复核通过', 'rc-agree', '模型认为这条改法正确'],
    disagree: ['复核有异议', 'rc-disagree', '模型认为这条不必改'],
    unsure: ['无法判断', 'rc-unsure', '模型未能给出明确结论'],
  };
  const v = it.modelVerdict || r?.verdict;
  const [label, cls, hint] = META[v] || ['已复核', 'rc-unsure', ''];
  const parts = [];
  /**
   * 模型观点块（有复核结论或模型观点时才显示）。
   * 即便没有，下面的「人工处置」也照常给出 —— 需求明确要求
   * 「给人为审阅留出空间」，不该因为没跑模型复核就把人工入口也藏起来。
   */
  if (v || it.modelOpinion) {
    parts.push(`<div class="rc-head"><span class="rc-tag ${cls}">${esc(label)}</span>${hint ? ` <span class="muted small">${esc(hint)}</span>` : ''}</div>`);
    parts.push(`<div class="rc-reason">${esc(it.modelOpinion || r?.reason || '（模型未给理由）')}</div>`);
    const better = it.modelBetter || r?.better;
    if (better) parts.push(`<div class="rc-better"><label>模型建议的更好改法</label><div class="proposed">${esc(better)}</div></div>`);
  } else {
    parts.push('<div class="muted small">本条未运行模型复核（可在审阅设置里打开「模型深度审阅」）。</div>');
  }
  if (it.needsHuman) {
    parts.push(`<div class="rc-need-human">⚠️ 该条需人工确认${it.severityAdjusted ? `（已由「${esc(it.severityBase || '')}」降为「${esc(it.severity)}」，为人工审阅留出空间）` : ''}</div>`);
  }
  /**
   * 人工处置（需求 5/6）：审稿人对这条结论的最终态度 + 追加经验。
   * 记录进后台审计日志，形成「规则/模型结论 vs 人工判断」的对照数据，
   * 后续据此判断要不要改规则或提示词。
   */
  const cur = state.humanDecisions.get(key) || {};
  const humanDisabled = state.workspaceError || !state.reviewRunId || state.streaming || !Number.isInteger(state.humanRevision) ? 'disabled' : '';
  parts.push(`<div class="rc-human">
    <label>人工处置与经验记录</label>
    <div class="rc-human-actions">
      <button class="chip ${cur.action === 'accept' ? 'chip-on' : ''}" data-hd="accept" ${humanDisabled}>采纳规则建议</button>
      <button class="chip ${cur.action === 'reject' ? 'chip-on' : ''}" data-hd="reject" ${humanDisabled}>不采纳（保留原样）</button>
      <button class="chip ${cur.action === 'unsure' ? 'chip-on' : ''}" data-hd="unsure" ${humanDisabled}>存疑待定</button>
    </div>
    <input class="rc-human-note" id="rcHumanNote" ${humanDisabled} placeholder="追加判断或经验，成功保存后记入审稿日志" value="${esc(cur.opinion || '')}" />
  </div>`);
  wrap.classList.remove('hidden');
  box.innerHTML = parts.join('');

  box.querySelectorAll('[data-hd]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!bindingIsCurrent()) return;
      const action = b.dataset.hd;
      const note = box.querySelector('#rcHumanNote')?.value.trim() || '';
      await saveHumanRecord('decision', { issueKey: key, action, opinion: note });
    });
  });
  box.querySelector('#rcHumanNote')?.addEventListener('change', async (e) => {
    if (!bindingIsCurrent()) return;
    const note = e.target.value.trim();
    const prev = state.humanDecisions.get(key) || {};
    await saveHumanRecord('decision', { issueKey: key, action: prev.action || '', opinion: note });
  });
}

/* ==================================================================
   审阅流水线
   ================================================================== */
const timer = {
  id: null, start: 0, el: null,
  run() {
    this.stop(); this.start = Date.now(); this.el = $('#progressTimer');
    this.el.classList.remove('hidden'); this.el.textContent = '0:00';
    this.id = setInterval(() => {
      const s = Math.floor((Date.now() - this.start) / 1000);
      this.el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
  },
  stop() { if (this.id) clearInterval(this.id); this.id = null; if (this.el) this.el.classList.add('hidden'); },
};

/* ---- 流式「逐条揭示」：把成批到达的批注按固定节奏一条条显示出来 ---- */
let revealTimer = null;
let pendingAuth = null;   // done 到达后的权威清单；等队列排空再整体替换
const REVEAL_INTERVAL_MS = 130;

/** 停止揭示并清空队列（审阅结束/中止/重跑时调用） */
function stopReveal() {
  if (revealTimer) { clearInterval(revealTimer); revealTimer = null; }
  state.revealQueue = [];
  pendingAuth = null;
}

/**
 * 服务端是「每完成一个模型窗口就把该窗口的批注成批推来」，一批可能十几条，
 * 直接渲染会一下子冒出一大堆，看不出「逐条找出来」的过程。
 * 这里把到达的批注先入队，再按 ~130ms 一条的节奏揭示：
 *   · 列表逐条出现，rail 徽标同步跳动，观感顺滑；
 *   · 正文下划线每 4 条刷新一次，兼顾观感与重排开销。
 * 队列排空后，若有 done 权威清单待应用，则整体替换以与服务端结果完全一致。
 */
function startReveal() {
  if (revealTimer) return;
  revealTimer = setInterval(() => {
    if (!state.revealQueue.length) {
      clearInterval(revealTimer); revealTimer = null;
      if (pendingAuth) {
        state.issues = pendingAuth; pendingAuth = null;
        renderMarkupIssues(); renderMarkupStats(); highlightIssuesInDoc();
      }
      return;
    }
    const it = state.revealQueue.shift();
    state.issues.push(it);
    state.streamSeq += 1;
    renderMarkupIssues();
    syncRailBadges();
    if (state.streamSeq % 4 === 0) highlightIssuesInDoc();
  }, REVEAL_INTERVAL_MS);
}

let reviewObserverTimer = null;
let reviewObserverSerial = 0;
let reviewObserverBinding = null;
function stopReviewObserver() {
  reviewObserverSerial += 1;
  clearTimeout(reviewObserverTimer); reviewObserverTimer = null;
  reviewObserverBinding = null;
}
function currentReviewBinding(binding) {
  return sameWorkspaceContext(binding) && state.sessionId === binding.sessionId
    && state.activationSerial === binding.activationSerial && state.workVersion?.id === binding.versionId;
}
function matchingReviewStatus(binding, status) {
  return currentReviewBinding(binding) && status.id === binding.sessionId
    && status.reviewRunId === binding.runId && status.workVersionId === binding.versionId
    && (!binding.jobId || status.reviewJobId === binding.jobId);
}
/** Adopt this run's row alongside its reader result; batch history is refreshed separately. */
function syncModernReviewQueueEntry(binding, status) {
  if (!matchingReviewStatus(binding, status)) return false;
  const item = state.queue.find(entry => entry.id === binding.sessionId);
  if (!item || item.workVersion?.id && item.workVersion.id !== binding.versionId) return false;
  item.status = ['complete', 'completed'].includes(status.status) ? 'complete'
    : ['running', 'publishing'].includes(status.status) ? 'reviewing' : status.status;
  item.reviewRunId = binding.runId;
  item.result = status.result || null;
  item.hasResult = !!status.result;
  item.running = !!status.running;
  item.waiting = !!status.waiting;
  item.error = status.error || null;
  if (status.workVersion?.id === binding.versionId) item.workVersion = status.workVersion;
  if (status.history) item.history = status.history;
  if (['complete', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(status.status)
      && Number.isSafeInteger(status.history?.epoch)) {
    item.reviewTerminalProof = { runId: binding.runId, jobId: binding.jobId || status.reviewJobId || null,
      versionId: binding.versionId, historyEpoch: status.history.epoch, status: item.status };
  } else delete item.reviewTerminalProof;
  if (status.result?.reviewOptions) item.opts = { ...status.result.reviewOptions };
  renderQueue();
  return true;
}
function showModernReviewStatus(binding, status) {
  if (!matchingReviewStatus(binding, status)) return false;
  const busy = ['queued', 'running', 'publishing'].includes(status.status) || status.waiting || status.running;
  state.streaming = !!busy; state.reviewWaiting = status.status === 'queued' || !!status.waiting;
  state.history = status.history || state.history;
  adoptDocumentProvenance(status);
  if (Array.isArray(status.appliedFixes)) state.resolved = new Set(status.appliedFixes);
  if (Array.isArray(status.appliedFixDetails)) state.appliedFixDetails = status.appliedFixDetails;
  $('#btnReview').disabled = !!busy;
  $('#btnReview').textContent = state.reviewWaiting ? '等待服务器审阅…' : busy ? '审阅中…' : state.issues.length ? '重新审阅' : '开始审阅';
  $('#btnCancel').classList.toggle('hidden', !busy);
  syncHistoryControls();
  if (busy) {
    state.issues = []; state.summary = null; state.anchorStats = null;
    resetReviewCoverage(); state.verdict = null; state.verdictModel = null; state.recheck = null; state.recheckStats = null;
    $('#btnReport').disabled = true; $('#btnDocx').disabled = true;
    const progress = status.progress || {};
    const phase = String(progress.phase || '');
    setProgressBar({ current: progress.current || progress.done || 0, total: progress.total || 0,
      label: state.reviewWaiting ? '等待审阅' : status.status === 'publishing' ? '保存结果'
        : phase.startsWith('model') ? '模型审阅' : phase.startsWith('recheck') ? '模型复核' : '规则扫描' });
    setProgress([{ cls: 'run', text: state.reviewWaiting ? '已保存服务器任务，正在等待审阅' : progress.message || '服务器审阅中…' },
      { cls: '', text: '关闭页面后继续审阅，可切换查看其他稿件' }]);
    timer.run();
    syncModernReviewQueueEntry(binding, status);
    return true;
  }
  stopReveal(); timer.stop(); hideProgressBar();
  adoptHumanContext(status);
  if (['complete', 'completed', 'partial'].includes(status.status) && status.result) {
    const result = status.result;
    if (result.workVersionId && result.workVersionId !== binding.versionId
      || result.reviewRunId && result.reviewRunId !== binding.runId) return false;
    state.issues = result.issues || []; state.streamSeq = state.issues.length;
    state.anchorStats = result.anchorStats || null;
    if (finishReview(result, { status: status.status }) === false) return false;
  } else {
    state.issues = []; state.summary = null; state.anchorStats = null;
    resetReviewCoverage(); state.verdict = null; state.verdictModel = null; state.recheck = null; state.recheckStats = null;
    $('#btnReport').disabled = true; $('#btnDocx').disabled = true;
    const label = QUEUE_STATUS[status.status] || (status.cancelled ? '已中止' : status.interrupted ? '已中断' : '审阅未完成');
    setProgress([{ cls: status.error ? 'err' : 'warn', text: label + (status.error ? `：${status.error}` : '') }]);
    renderMarkupIssues(); renderMarkupStats(); highlightIssuesInDoc();
  }
  syncModernReviewQueueEntry(binding, status);
  return true;
}
function startReviewObserver(binding, firstStatus = null) {
  stopReviewObserver();
  const observerSerial = reviewObserverSerial;
  reviewObserverBinding = binding;
  const tick = async () => {
    reviewObserverTimer = null;
    if (observerSerial !== reviewObserverSerial || !currentReviewBinding(binding)) return;
    try {
      const response = await fetch('/api/review-status?' + new URLSearchParams({ id: binding.sessionId, runId: binding.runId }));
      const status = await response.json();
      if (observerSerial !== reviewObserverSerial || !currentReviewBinding(binding)) return;
      if (!response.ok) throw new Error(status.error || '审阅进度获取失败');
      if (!matchingReviewStatus(binding, status)) { stopReviewObserver(); return; }
      showModernReviewStatus(binding, status);
      if (!state.streaming) { stopReviewObserver(); await refreshWorkspace(); return; }
    } catch {
      if (observerSerial !== reviewObserverSerial || !currentReviewBinding(binding)) return;
      setProgress([{ cls: 'warn', text: '进度暂未确认，服务器任务仍可继续；正在重新连接' }]);
    }
    if (observerSerial === reviewObserverSerial && currentReviewBinding(binding)) reviewObserverTimer = setTimeout(tick, 2500);
  };
  if (firstStatus && matchingReviewStatus(binding, firstStatus)) showModernReviewStatus(binding, firstStatus);
  if (!firstStatus || !firstStatus.status || firstStatus.accepted || state.streaming) tick();
}
async function runModernReview({ force = true } = {}) {
  if (!state.sessionId || state.workspaceError || state.streaming || state.clean?.status === 'legacy-unverified') {
    if (state.clean?.status === 'legacy-unverified') { syncLegacyReviewButton(); toast('请先验证当前稿的清洗状态'); }
    return null;
  }
  const context = workspaceContext();
  const sessionId = state.sessionId;
  const activationSerial = state.activationSerial;
  const versionId = state.workVersion?.id;
  if (!versionId || !Number.isSafeInteger(state.history?.epoch)) { toast('当前稿版本尚未确认，请刷新恢复后重试'); return null; }
  const provisional = { ...context, sessionId, activationSerial, versionId };
  const body = JSON.stringify({ id: sessionId, operationId: newWorkOperationId(), baseVersionId: versionId,
    baseMutationEpoch: state.history.epoch, async: true, force, ...reviewOptionsSnapshot() });
  state.streaming = true; state.reviewWaiting = true;
  resetHumanState({ keepMarks: true }); stopReveal(); closeIssueDetail();
  state.issues = []; state.summary = null; state.recheck = null; state.recheckStats = null;
  resetReviewCoverage(); state.verdict = null; state.verdictModel = null; state.anchorStats = null;
  state.resolved.clear(); state.appliedFixDetails = []; state.accepted.clear();
  $('#btnReview').disabled = true; $('#btnReport').disabled = true; $('#btnDocx').disabled = true;
  syncHistoryControls(); renderMarkupIssues(); renderMarkupStats();
  setProgress([{ cls: 'run', text: '正在保存服务器审阅任务…' }]);
  try {
    const { res: response, response: data } = await fetchWorkMutation('/api/review', body, true);
    if (!currentReviewBinding(provisional)) return null;
    if (!response.ok) throw reviewStartRejection(response, data);
    if (data.id !== sessionId || !data.reviewRunId || data.workVersionId !== versionId) throw new Error('服务器未确认此次审阅身份，请刷新恢复');
    const binding = { ...provisional, runId: data.reviewRunId, jobId: data.reviewJobId || null };
    // 服务器受理即证明请求池已不再拦截，清掉上一次的核对面板，避免留下过期提示。
    state.arkPoolBlock = null; state.arkPoolBlockChecked = '';
    startReviewObserver(binding, data);
    // 审阅已被服务器受理。此处的工作台刷新失败与「审阅是否启动」无关，不得改写结论。
    try { await refreshWorkspace(); }
    catch { if (currentReviewBinding(provisional)) setProgress([{ cls: 'warn', text: '服务器审阅已受理，但工作台刷新失败；稍后可手动刷新进度' }]); }
    return data;
  } catch (error) {
    if (currentReviewBinding(provisional)) {
      state.streaming = false; state.reviewWaiting = false; syncHistoryControls();
      $('#btnReview').disabled = false;
      reportReviewStartFailure(error);
    }
    return null;
  }
}
/** 服务器明确拒绝（4xx）与「传输结果未知」处置完全不同：前者刷新重试无效。 */
function reviewStartRejection(response, data) {
  const error = new Error(data?.error || `审阅任务未能启动：HTTP ${response.status}`);
  error.status = response.status;
  error.code = data?.code || null;
  if (Number.isInteger(data?.unknownSentCount)) error.unknownSentCount = data.unknownSentCount;
  return error;
}
function reportReviewStartFailure(error) {
  const rejected = Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
  if (!rejected) {
    setProgress([{ cls: 'err', text: `审阅任务结果未确认：${error.message}` }]);
    toast('审阅任务结果未确认，请刷新进度后重试', 5500);
    return;
  }
  if (error.code === 'ARK_EXECUTION_BLOCKED') {
    const count = Number.isInteger(error.unknownSentCount) ? `（${error.unknownSentCount} 笔）` : '';
    setProgress([{ cls: 'err', text: `审阅未启动：${error.message}${count}；刷新重试无效，请在左侧队列的请求记录里核对后处置` }]);
    toast('审阅未启动：模型请求池被未确认的请求占满，请刷新重试无效；已在左侧列出来源，核对后可人工释放名额', 8000);
    // 把「核对请求记录」落成可点的入口，而不是让用户停在死胡同里。
    loadArkPoolBlock().catch(() => {});
    return;
  }
  setProgress([{ cls: 'err', text: `审阅未启动：${error.message}` }]);
  toast(`审阅未启动：${error.message}`, 6500);
}
async function runReview(options = {}) {
  if (pendingInfo?.dirty || pendingInfo?.saving) { requestCloseHumanPop(); toast('请先保存或取消当前批注，再开始审阅'); return; }
  const context = workspaceContext();
  const sessionId = state.sessionId;
  const activationSerial = state.activationSerial;
  const supported = await awaitQueueCapability();
  if (!sameWorkspaceContext(context) || state.sessionId !== sessionId || state.activationSerial !== activationSerial) return null;
  if (supported === null) { unconfirmedQueueMessage(); return null; }
  return supported === true ? runModernReview(options) : runLegacyReview(options);
}
async function runLegacyReview({ force = true } = {}) {
  if (state.workspaceError) { toast('工作台恢复失败，尚未启动审阅'); return; }
  if (state.clean?.status === 'legacy-unverified') {
    syncLegacyReviewButton(); $('#btnVerifyClean')?.focus();
    toast('请先点击“验证清洗”，确认历史稿的当前工作版本后再开始审阅', 5000);
    return;
  }
  if (!state.sessionId) return;
  const sessionId = state.sessionId;
  const activationSerial = state.activationSerial;
  const context = workspaceContext();
  const versionId = state.workVersion?.id || null;
  const isCurrent = () => sameWorkspaceContext(context) && state.sessionId === sessionId
    && state.activationSerial === activationSerial && (state.workVersion?.id || null) === versionId;
  resetHumanState({ keepMarks: true });
  let completedResult = null;
  const useModel = $('#useModel').checked;
  // 判定口径（E2）：可选把模型复核结论计入参考判定，默认关
  const verdictWithModel = $('#verdictWithModel')?.checked === true;
  // 第二轮自证：默认开（映射到后端 useRecheck），关掉则不做第二轮核对
  const selfVerify = useModel && $('#selfVerify')?.checked !== false;
  // 全局上下文：默认开（映射到后端 useContext），关掉则不生成纲要、不带邻段
  const useContext = useModel && $('#useContext')?.checked !== false;
  // 历史批注案例库：默认开（映射到后端 useCases），关掉则不检索历史批注参考
  const useCases = useModel && $('#useCases')?.checked !== false;
  state.streaming = true; state.streamSeq = 0;
  syncHistoryControls();
  state.issues = []; state.summary = null; state.activeIssueKey = null;
  resetReviewCoverage(); state.verdict = null; state.verdictModel = null;
  stopReveal();
  state.recheck = null;
  state.recheckStats = null;
  state.accepted.clear();
  // 重新审阅 = 在**原始**文本上重跑，上一轮的「已修复」不再适用
  state.resolved.clear();
  state.appliedFixDetails = [];
  state.anchorStats = null;
  markIndex.clear();
  $('#btnReview').disabled = true; $('#btnReview').textContent = '审阅中…';
  $('#btnCancel').classList.remove('hidden');
  $('#btnReport').disabled = true; $('#btnDocx').disabled = true; $('#btnApply').disabled = true;
  $('#btnImport').disabled = true;
  timer.run();
  // 立刻显示进度条（不确定进度动画）。
  // 规则扫描阶段后端不报 current/total（它是一次性算完的，没有「窗口」概念），
  // 所以先给不确定进度，等 model 阶段的第一条 progress 事件到了再切成真实百分比。
  setProgressBar({ current: 0, total: 0, label: '规则扫描' });
  setProgress([
    { cls: 'done', text: '稿件解析完成' },
    { cls: 'run', text: '规则扫描中…' },
  ]);
  renderMarkupIssues();
  renderMarkupStats();

  const seen = new Set();
  const params = new URLSearchParams({
    id: sessionId,
    useModel: String(useModel),
    model: $('#model').value,
    // 提示词式规则的匹配方式（目标点 12）：默认 all（整段通读）
    ruleMode: $('#ruleMode')?.value || 'all',
    // 判定口径（E2）：是否额外计一版含模型复核结论的参考判定
    verdictWithModel: String(verdictWithModel),
    // 第二轮自证：是否让模型逐条核对自己报出的问题是否属实
    useRecheck: String(selfVerify),
    // 全局上下文：是否先生成全文纲要并给每段带上前后邻段
    useContext: String(useContext),
    // 历史批注案例库：是否检索历史批注作为本刊尺度参考
    useCases: String(useCases),
    // 断线重连（目标点 5）：detach=1 时客户端断开**不再中止**服务端审阅。
    // 一篇稿件的模型审阅要 560—890 秒，刷新页面就白跑代价太大。
    detach: '1',
    force: force ? '1' : '0',
  });
  try {
    const out = await consumeStream('/api/review-stream?' + params, {
      onDoc: (d) => { if (!isCurrent()) return; adoptHumanContext(d); if (d.doc) { state.doc = d.doc; renderDocInfo(); } },
      onProgress: (p) => {
        if (!isCurrent()) return;
        /**
         * 模型阶段的进度标签要分三段看，不能只看 phase：
         *   model-prepare 且还没完成任何窗口 → 「模型准备」
         *   已有窗口完成（current > 0）      → 「模型审阅」（此时有真实百分比）
         *   其余（规则扫描等）               → 「规则扫描」
         *
         * 第一版按 `phase === 'model'` 判断，结果 model-prepare 之后
         * 后端已经在逐窗跑模型了，前端还一直显示「模型准备」——
         * 实测 50 秒后进度条仍停在准备阶段，用户会以为卡住了。
         */
        const phase = String(p.phase || '');
        const started = (p.current || 0) > 0;
        const label = phase.startsWith('model')
          ? (started ? '模型审阅' : '模型准备')
          : (phase.startsWith('recheck') ? '模型复核' : '规则扫描');
        setProgressBar({ current: p.current || 0, total: p.total || 0, label });
        setProgress([
          { cls: 'done', text: '稿件解析完成' },
          { cls: 'done', text: '规则扫描完成' },
          { cls: 'run', text: p.message || '' },
          { cls: '', text: useModel ? '模型审阅中，可随时中止' : '' },
        ].filter((x) => x.text));
      },
      onIssue: (ev) => {
        if (!isCurrent()) return;
        const k = issueKey(ev.issue);
        if (seen.has(k)) return;
        seen.add(k);
        // 入队后按节奏逐条揭示，而不是成批一次性刷出
        state.revealQueue.push(ev.issue);
        startReveal();
      },
      onDone: (data) => {
        if (!isCurrent()) return;
        // 完成时立即提交完整结果。动画不得延后结果保存或跨稿件继续写入。
        stopReveal();
        completedResult = data;
        state.issues = data.issues || [];
        state.streamSeq = state.issues.length;
        state.summary = data.summary;
        state.verdict = data.verdict || null;
        state.verdictModel = data.verdictModel || null;
        state.anchorStats = data.anchorStats || null;
        finishReview(data);
      },
      onCancelled: () => {
        if (!isCurrent()) return;
        stopReveal();
        timer.stop();
        hideProgressBar();
        setProgress([{ cls: 'warn', text: `已中止（已收到 ${state.streamSeq} 条）` }]);
        toast('已中止审阅');
      },
      // 服务端已有同一份稿件的审阅在跑（detach 模式）：不报错，转去轮询接管
      onAlreadyRunning: () => { if (isCurrent()) resumeReview({ silent: false }); },
      onError: (msg) => { throw new Error(msg); },
    });
  } catch (e) {
    if (!isCurrent()) return null;
    // 连接中断时先尝试接管服务端仍在跑的审阅，而不是直接报错。
    // detach 模式下服务端不受客户端断开影响，所以多数情况下能救回来。
    const resumed = await resumeReview({ silent: true });
    if (!resumed) {
      toast(`审阅出错：${e.message}`, 5000);
      hideProgressBar();
      setProgress([{ cls: 'err', text: String(e.message) }]);
    }
  } finally {
    if (isCurrent()) {
      state.streaming = false; timer.stop();
      syncHistoryControls();
      $('#btnImport').disabled = state.queueRunning;
      $('#btnCancel').classList.add('hidden');
      $('#btnReview').disabled = false;
      $('#btnReview').textContent = state.issues.length ? '重新审阅' : '开始审阅';
      renderMarkupIssues();
      renderMarkupStats();
      highlightIssuesInDoc();
    }
  }
  // 断线接管会先返回“正在审阅”。批量流程必须等完整结果，才能进入下一篇。
  while (!completedResult && state.queueRunning && !state.queueStopRequested) {
    const st = await (await fetch('/api/review-status?id=' + encodeURIComponent(sessionId))).json();
    if (!isCurrent()) return null;
    if (st.error) throw new Error(st.error);
    if (!st.running) {
      if (st.result && !st.cancelled) {
        completedResult = st.result;
        stopReveal();
        state.issues = st.result.issues || [];
        state.streamSeq = state.issues.length;
        state.anchorStats = st.result.anchorStats || null;
        finishReview(st.result);
      }
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  return completedResult;
}

function renderReviewResultProgress(data) {
  if (!data) {
    setProgress([cleanPresentation(state.clean), { cls: 'warn', text: '当前稿没有可用审阅结果，请重新审阅' }]);
    return true;
  }
  if (!reviewCoverageResultMatches(data)) return false;
  const s = data.summary || {};
  const coverage = reviewCoveragePresentation(currentReviewCoverage());
  setProgress([
    cleanPresentation(state.clean),
    { cls: coverage.coverage.executionStatus === 'completed' ? 'done' : 'warn', text: coverage.execution },
    ...coverage.notices.map(text => ({ cls: 'warn', text })),
    ...coverage.items,
    { cls: 'done', text: `规则引擎：${s.ruleBased ?? 0} 条` },
    ...(s.modelBased ? [{ cls: 'done', text: `模型待确认线索：${s.modelBased} 条` }] : []),
    { cls: 'done', text: `共计 ${s.total ?? state.issues.length} 条问题` },
    ...(data.usage ? [{ cls: 'done', text: `已返回用量：输入 ${data.usage.input_tokens || 0} / 输出 ${data.usage.output_tokens || 0} Token${data.usageBreakdown?.recheck ? '（含模型自证及补问）' : ''}` }] : []),
    ...(data.modelErrors?.length ? [{ cls: 'warn', text: `有 ${data.modelErrors.length} 条模型执行错误记录，相关范围须人工补审。${data.modelErrors.map((e) => `${e.window > 0 ? `窗口 ${e.window}` : '执行范围'}${e.rule ? `／规则 ${e.rule}` : ''}：${/timeout/i.test(e.message || '') ? '请求超时' : e.message}`).join('；')}` }] : []),
    ...(data.recheck?.stats?.noReply ? [{ cls: 'warn', text: `模型未返回 ${data.recheck.stats.noReply} 条复核结论，须人工确认` }] : []),
  ]);
  return true;
}

function finishReview(data, { status = null } = {}) {
  if (!reviewCoverageResultMatches(data)) return false;
  adoptDocumentProvenance(data);
  adoptHumanContext(data);
  adoptReviewCoverage(data);
  syncHistoryControls();
  state.summary = data.summary;
  state.verdict = data.verdict || null;
  state.verdictModel = data.verdictModel || null;
  // 模型复核结论（目标点 13）：byKey 的 key 与 issueKey() 同构，直接按 key 查
  state.recheck = data.recheck?.byKey || null;
  state.recheckStats = data.recheck?.stats || null;
  timer.stop();
  hideProgressBar();
  // 必须停掉重连轮询：否则接管成功后定时器还在跑，会反复 fetch 并重复渲染
  clearInterval(resumeTimer);
  resumeTimer = null;
  const s = data.summary || {};
  const coverage = reviewCoveragePresentation(currentReviewCoverage());
  renderReviewResultProgress(data);
  $('#btnReport').disabled = false;
  $('#btnDocx').disabled = false;
  toast(status === 'partial' || coverage.coverage.executionStatus === 'partial'
    ? `所选步骤部分完成，共 ${s.total ?? state.issues.length} 条问题，仍须补审`
    : `${coverage.execution}，共 ${s.total ?? state.issues.length} 条问题`);
  renderMarkupStats();
  renderMarkupIssues();
  highlightIssuesInDoc();
  // 复算问题后重标注，标题层级/引文交互需跟着刷新
  markHeadingLevels();
  wireCitations();
}

/* ---- SSE 消费 ---- */
async function consumeStream(url, handlers) {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* 非 JSON */ }
    handlers.onError?.(msg);
    return;
  }
  /**
   * detach 模式下服务端有三种非流式响应，必须在这里分流，
   * 否则 `res.body.getReader()` 会把一段 JSON 当 SSE 解析，最后报
   * 「审阅连接意外中断」——明明是正常情况却显示成故障。
   *   202 {accepted, running:true, progress}  → 已有审阅在跑，转轮询
   *   200 {reused:true, result}              → 已有结果，直接渲染
   */
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('text/event-stream')) {
    let j = null;
    try { j = await res.json(); } catch { /* ignore */ }
    if (j?.reused && j.result) { handlers.onDone?.(j.result); return; }
    if (j?.running) { handlers.onAlreadyRunning?.(j); return; }
    handlers.onError?.(j?.error || '服务端返回了非流式响应');
    return;
  }
  if (!res.body) { handlers.onError?.('浏览器不支持流式响应'); return; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let sawDone = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let ev = 'message';
      const dataLines = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;
      let data = null;
      try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }
      if (ev === 'issue') handlers.onIssue?.(data);
      else if (ev === 'progress') handlers.onProgress?.(data);
      else if (ev === 'doc') handlers.onDoc?.(data);
      else if (ev === 'done') { sawDone = true; handlers.onDone?.(data); }
      else if (ev === 'cancelled') { sawDone = true; handlers.onCancelled?.(data); }
      else if (ev === 'error') handlers.onError?.(data.message || '审阅失败');
    }
  }
  if (!sawDone) handlers.onError?.('审阅连接意外中断，请重试');
}

/* ==================================================================
   断线重连（目标点 5）
   ==================================================================
   场景：一篇稿件的模型审阅要 560—890 秒。用户在这期间刷新页面、
   切换标签页被系统回收、或笔记本休眠，流就断了。
   detach 模式下服务端审阅**继续跑完**并把结果落在 s.result，
   所以这里可以：
     · 若已有结果 → 直接取回来渲染，不重复烧模型额度
     · 若还在跑   → 显示进度条并轮询，跑完自动接管
*/
async function resumeModernReview({ silent = false } = {}) {
  if (!state.sessionId || !state.workVersion?.id) return false;
  const provisional = { ...workspaceContext(), sessionId: state.sessionId,
    activationSerial: state.activationSerial, versionId: state.workVersion.id };
  const observerSerial = reviewObserverSerial;
  try {
    const response = await fetch('/api/review-status?id=' + encodeURIComponent(provisional.sessionId));
    const status = await response.json();
    if (observerSerial !== reviewObserverSerial || !currentReviewBinding(provisional)) return false;
    if (!response.ok || status.id !== provisional.sessionId || !status.reviewRunId
      || status.workVersionId !== provisional.versionId) return false;
    const binding = { ...provisional, runId: status.reviewRunId, jobId: status.reviewJobId || null };
    startReviewObserver(binding, status);
    return true;
  } catch { if (!silent && currentReviewBinding(provisional)) toast('无法确认服务器审阅进度，请刷新恢复'); return false; }
}
async function resumeReview(options = {}) {
  if (state.queueSupported === true) return resumeModernReview(options);
  if (state.queueSupported === null) return false;
  return resumeLegacyReview(options);
}
async function resumeLegacyReview({ silent = false } = {}) {
  if (!state.sessionId) return false;
  const sessionId = state.sessionId;
  const activationSerial = state.activationSerial;
  const context = workspaceContext();
  const isCurrent = () => sameWorkspaceContext(context) && state.sessionId === sessionId && state.activationSerial === activationSerial;
  let st;
  try {
    st = await (await fetch('/api/review-status?id=' + encodeURIComponent(sessionId))).json();
  } catch {
    if (!silent) toast('无法连接服务端');
    return false;
  }
  if (!isCurrent()) return false;
  if (st.error) return false;
  state.streaming = !!st.running;
  state.history = st.history || null;
  adoptDocumentProvenance(st);
  adoptHumanContext(st);
  const queued = state.queue.find((item) => item.id === sessionId);
  if (queued) queued.history = state.history;
  syncHistoryControls();
  if (st.workVersion && st.workVersion.id !== state.workVersion?.id) {
    try {
      if (!await loadWorkingVersion(sessionId, st.workVersion)) return false;
      if (st.doc) state.doc = st.doc;
      await renderDocument(true);
    } catch { if (!silent) toast('当前稿获取失败，请刷新页面恢复'); return false; }
    if (!isCurrent()) return false;
  }
  // 已修复状态与 /api/session 同源：断线重连也要还原，否则改过的条目
  // 会重新显示成未修复
  if (Array.isArray(st.appliedFixes)) state.resolved = new Set(st.appliedFixes);
  if (Array.isArray(st.appliedFixDetails)) state.appliedFixDetails = st.appliedFixDetails;

  if (st.hasResult && st.result && !st.running) {
    // 服务端已有完整结果：直接接管，不必重跑
    state.issues = st.result.issues || [];
    state.summary = st.result.summary || null;
    state.verdict = st.result.verdict || null;
    state.verdictModel = st.result.verdictModel || null;
    state.anchorStats = st.result.anchorStats || null;
    state.streamSeq = state.issues.length;
    finishReview(st.result);
    toast(`已恢复上次审阅结果（${state.issues.length} 条）`);
    return true;
  }

  if (st.running) {
    state.issues = []; state.summary = null; state.anchorStats = null;
    resetReviewCoverage(); state.verdict = null; state.verdictModel = null; state.recheck = null; state.recheckStats = null;
    renderMarkupIssues(); renderMarkupStats();
    // 还在跑：显示进度并轮询
    state.streaming = true;
    syncHistoryControls();
    $('#btnReview').disabled = true; $('#btnReview').textContent = '审阅中…';
    $('#btnCancel').classList.remove('hidden');
    timer.run();
    const p = st.progress || {};
    setProgressBar({
      current: p.current || 0, total: p.total || 0,
      label: p.phase === 'model' ? '模型审阅' : '处理中',
    });
    setProgress([
      { cls: 'done', text: '稿件解析完成' },
      { cls: 'run', text: p.message || '服务端审阅中…' },
      { cls: '', text: '页面刷新不会中断审阅，可继续等待' },
    ]);
    if (!silent) toast('检测到服务端正在审阅，已接管进度');
    clearInterval(resumeTimer);
    resumeTimer = setInterval(async () => {
      try {
        const s2 = await (await fetch('/api/review-status?id=' + encodeURIComponent(sessionId))).json();
        if (!isCurrent()) return;
        state.history = s2.history || null;
        adoptDocumentProvenance(s2);
        adoptHumanContext(s2);
        const queued = state.queue.find((item) => item.id === sessionId);
        if (queued) queued.history = state.history;
        syncHistoryControls();
        if (s2.workVersion && s2.workVersion.id !== state.workVersion?.id) {
          if (!await loadWorkingVersion(sessionId, s2.workVersion)) return;
          if (s2.doc) state.doc = s2.doc;
          await renderDocument(true);
          if (!isCurrent()) return;
        }
        const q = s2.progress || {};
        setProgressBar({ current: q.current || 0, total: q.total || 0, label: q.phase === 'model' ? '模型审阅' : '处理中' });
        setProgress([
          { cls: 'done', text: '稿件解析完成' },
          { cls: 'run', text: q.message || '服务端审阅中…' },
        ]);
        if (s2.error) {
          clearInterval(resumeTimer);
          state.streaming = false; timer.stop(); hideProgressBar();
          syncHistoryControls();
          setProgress([{ cls: 'err', text: s2.error }]);
          return;
        }
        if (s2.hasResult && s2.result && !s2.running) {
          clearInterval(resumeTimer);
          state.streaming = false;
          syncHistoryControls();
          state.issues = s2.result.issues || [];
          state.summary = s2.result.summary || null;
          state.verdict = s2.result.verdict || null;
          state.verdictModel = s2.result.verdictModel || null;
          state.anchorStats = s2.result.anchorStats || null;
          state.streamSeq = state.issues.length;
          finishReview(s2.result);
        } else if (!s2.running && !s2.hasResult) {
          state.issues = []; state.summary = null; state.anchorStats = null;
          resetReviewCoverage(); state.verdict = null; state.verdictModel = null; state.recheck = null; state.recheckStats = null;
          renderMarkupIssues(); renderMarkupStats();
          clearInterval(resumeTimer);
          state.streaming = false; timer.stop(); hideProgressBar();
          syncHistoryControls();
          setProgress([{ cls: 'warn', text: '服务端审阅已结束但没有结果，请重新审阅' }]);
        }
      } catch { /* 轮询失败不致命，下一轮再试 */ }
    }, 2500);
    return true;
  }

  return false;
}

/* ==================================================================
   报告导出 / 应用修复
   ================================================================== */
async function exportReport() {
  if (!state.sessionId) return;
  const sessionId = state.sessionId, activationSerial = state.activationSerial;
  const baseVersionId = state.workVersion?.id || null, baseReviewRunId = state.reviewRunId || null;
  const reportTitle = String(state.doc?.meta?.title || 'report').replace(/[\\/:*?"<>|]/g, '_');
  const isCurrent = () => state.sessionId === sessionId && state.activationSerial === activationSerial
    && (state.workVersion?.id || null) === baseVersionId && (state.reviewRunId || null) === baseReviewRunId;
  if (!baseVersionId || !baseReviewRunId) { toast('请核对当前审阅记录后再导出报告'); return; }
  try {
    const r = await (await fetch('/api/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId, baseVersionId, baseReviewRunId }),
    })).json();
    if (!isCurrent()) return;
    if (r.error) { toast(r.error); return; }
    /**
     * ⚠️ 服务端 `/api/report` 返回的是 `{ markdown, savedTo }`，**不是** `report`。
     * 旧代码取 `r.report` → `undefined` → 导出的文件内容就是字符串「undefined」
     * （浏览器实测：导出 9 字节、内容为 undefined、`hasHeading=false`，
     * 而界面仍提示「报告已导出」）。这类缺陷纯接口测试发现不了，
     * 必须真实点「导出报告」并读取下载的 Blob 才能暴露。
     */
    const md = r.markdown ?? r.report ?? '';
    if (typeof md !== 'string' || !md) { toast('报告为空，请先完成审阅'); return; }
    if (r.receipt?.schemaVersion !== 1 || r.receipt?.artifactType !== 'markdown-report'
      || r.receipt?.sessionId !== sessionId || r.receipt?.reviewRunId !== baseReviewRunId
      || r.receipt?.workVersion?.id !== baseVersionId) { toast('报告版本尚未核对，请重新审阅后导出'); return; }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(md));
    const actualSha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (actualSha256 !== r.receipt.outputSha256) { toast('报告文件校验失败，请重新导出'); return; }
    if (!isCurrent()) return;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${reportTitle}_审校报告.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('报告已导出');
  } catch { toast('导出失败'); }
}

/**
 * 导出「带批注的 Word 文档」。
 *
 * 只导出右侧清单中**已勾选**的批注（`state.accepted`）；一条都没勾则全部导出。
 * 服务端在当前工作版本上注入真正的 Word 批注（右侧页边距可见、可回复/采纳），
 * 并回传实际写入/跳过的条数。
 */
function commentExportPlacementMessage(receipt) {
  if (receipt?.placementSchemaVersion !== 1) return '';
  const notes = (receipt.placements || []).filter(p => ['footnote', 'endnote'].includes(p.source?.target)
    && p.degradation?.code === 'word-note-comments-unsupported' && p.targets?.length);
  const targets = notes.reduce((count, p) => count + p.targets.length, 0);
  const reasons = [...new Set((receipt.skippedDetails || []).map(p => p.reason).filter(Boolean))];
  return [notes.length ? `${notes.length} 条脚注/尾注问题挂在正文注号的 ${targets} 处；原注身份和注内原文范围见批注，注号处为替代位置` : '',
    reasons.length ? `未导出原因：${reasons.join('；')}` : ''].filter(Boolean).join('。');
}

async function exportDocx() {
  if (!state.sessionId) return;
  const sessionId = state.sessionId;
  const baseVersionId = state.workVersion?.id || null;
  const baseReviewRunId = state.reviewRunId || null;
  const activationSerial = state.activationSerial;
  const context = workspaceContext();
  const isCurrent = () => sameWorkspaceContext(context) && state.sessionId === sessionId
    && state.activationSerial === activationSerial && (state.workVersion?.id || null) === baseVersionId
    && (state.reviewRunId || null) === baseReviewRunId;
  const verificationRunId = new URLSearchParams(globalThis.location?.search || '').get('verification');
  const safeTitle = String(state.doc?.meta?.title || 'report').replace(/[\\/:*?"<>|]/g, '_');
  const btn = $('#btnDocx');
  const old = btn.textContent;
  const owner = {};
  docxExportOwners.set(btn, owner);
  btn.disabled = true; btn.textContent = '导出中…';
  try {
    const accepted = [...state.accepted];
    const res = await fetch('/api/export-docx', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId, accepted: accepted.length ? accepted : undefined,
        baseVersionId: baseVersionId || undefined, baseReviewRunId: baseReviewRunId || undefined,
        purpose: verificationRunId ? 'verification' : 'editorial', verificationRunId: verificationRunId || undefined }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const placementSchema = res.headers.get('X-Export-Placement-Schema');
    const exportedVersion = res.headers.get('X-Work-Version');
    const exportedRun = res.headers.get('X-Review-Run');
    if (baseVersionId && (exportedVersion && exportedVersion !== baseVersionId
      || placementSchema === '1' && !exportedVersion)) throw new Error('导出工作版本与点击时的当前稿不一致');
    if (placementSchema === '1' && baseReviewRunId && exportedRun !== baseReviewRunId) throw new Error('导出审阅记录与点击时的记录不一致');
    const blob = await res.blob();
    const added = res.headers.get('X-Comments-Added') || '?';
    const skipped = Number(res.headers.get('X-Comments-Skipped') || 0);
    const addedIssues = res.headers.get('X-Comments-Added-Issues');
    const noteSources = Number(res.headers.get('X-Comments-Note-Sources') || 0);
    const exportId = res.headers.get('X-Export-Id');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${safeTitle}_批注稿.docx`;
    a.click();
    URL.revokeObjectURL(a.href);
    let placementText = '', metadataUnavailable = false;
    if (placementSchema === '1' && isCurrent()) {
      try {
        if (!exportId) throw new Error('缺少导出凭证身份');
        const metadata = await fetch('/api/export-placement?id=' + encodeURIComponent(sessionId) + '&exportId=' + encodeURIComponent(exportId));
        if (!metadata.ok) throw new Error('位置凭证未载入');
        const receipt = await metadata.json();
        if (receipt.schemaVersion !== 1 || receipt.exportId !== exportId || receipt.placementSchemaVersion !== 1
          || receipt.workVersion?.id !== exportedVersion || (receipt.reviewRunId || null) !== (exportedRun || null)
          || receipt.outputSha256 !== res.headers.get('X-Content-SHA256')) throw new Error('位置凭证与导出身份不符');
        placementText = commentExportPlacementMessage(receipt);
      } catch { metadataUnavailable = true; }
    }
    if (isCurrent()) {
      const noteFallback = noteSources ? '脚注/尾注采用正文注号作为替代批注位置，注内原文范围见批注' : '';
      toast(`已导出批注 Word：${added} 处批注${addedIssues !== null ? `，来自 ${addedIssues} 条问题` : ''}${skipped ? `；${skipped} 条未导出` : ''}`
        + (placementText ? `。${placementText}` : placementSchema === '1' && noteFallback ? `。${noteFallback}` : '')
        + (metadataUnavailable ? '。详细位置凭证暂未载入，不能确认各处对应' : ''), 6500);
    }
  } catch (e) {
    if (isCurrent()) toast(`导出失败：${e.message}`, 4000);
  } finally {
    if (docxExportOwners.get(btn) === owner) {
      docxExportOwners.delete(btn);
      btn.textContent = old;
      if (isCurrent()) btn.disabled = !state.summary;
    }
  }
}

/** 导出当前工作版本：包含已经保存的文字修改，不添加问题批注。 */
async function exportWorkingDocx() {
  if (!state.sessionId) return;
  const sessionId = state.sessionId;
  const safeTitle = String(state.doc?.meta?.title || 'manuscript').replace(/[\\/:*?"<>|]/g, '_');
  const btn = $('#btnWorkingDocx');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '导出中…';
  try {
    const res = await fetch('/api/export-working-docx?id=' + encodeURIComponent(sessionId));
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${safeTitle}_当前修改稿.docx`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出当前修改稿（含已保存修改）', 3600);
  } catch (e) { toast(`导出失败：${e.message}`, 4000); }
  finally { btn.disabled = !state.sessionId; btn.textContent = old; }
}

/* ==================================================================
   自动修改：逐条一键改（需求 7）+ 批量改
   ==================================================================

   旧实现只有底部一个批量按钮，而且**丢弃了服务端返回的 `doc`** ——
   改完之后界面上的原文一个字都没变，只能靠用户自己点「重新审阅」
   重跑一遍（还要再烧一次模型额度）才看得到效果。

   现在：
     · 每条可改写的问题在清单里各有「改」按钮，点一下只改这一条；
     · 详情面板里也有「一键修改」；
     · 改完立即把结果**落到正文 DOM 上**（替换文字 + 撤掉该条下划线），
       并把该条标记为已修复，不必重跑审阅。
   ================================================================== */

/**
 * 把一次 `find → replace` 落到正文 DOM 上。
 *
 * 为什么在 DOM 上做替换、而不是重渲染整篇：预览是从 `state.buffer`
 * （**原始 docx 字节**）渲染的，而服务端改的是它解析出来的文档结构 ——
 * 字节流没变，重渲染只会把旧文本画回来。所以改动必须直接落到 DOM。
 *
 * 只在**单个文本节点内**做替换：自动改写绝大多数是标点级替换
 * （`find` 是 1 个字符），必然落在同一个 run 里；跨节点的长串替换
 * 交给「重新审阅」处理，避免这里改出半截。
 */
function replaceTextInDom(host, find, replace, offset = null) {
  if (!host || !find) return false;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let text = '';
  while (walker.nextNode()) {
    const node = walker.currentNode;
    nodes.push({ node, start: text.length, end: text.length + (node.textContent || '').length });
    text += node.textContent || '';
  }
  const at = Number.isInteger(offset) && text.startsWith(find, offset) ? offset : text.indexOf(find);
  if (at < 0) return false;
  const start = nodes.find((n) => n.start <= at && n.end > at);
  const endAt = at + find.length;
  const end = nodes.find((n) => n.start < endAt && n.end >= endAt);
  if (!start || !end) return false;
  const range = document.createRange();
  range.setStart(start.node, at - start.start);
  range.setEnd(end.node, endAt - end.start);
  range.deleteContents();
  range.insertNode(document.createTextNode(replace ?? ''));
  return true;
}

/** 修复只作用于它所属段落；切稿、刷新、切回清洗稿时重放已保存的改动。 */
function fixDomTarget(host, applied) {
  const issue = state.issues.find((it) => issueKey(it) === applied.key);
  const target = applied.target || issue?.anchor?.target;
  const index = applied.index ?? issue?.anchor?.index;
  if (!Number.isInteger(index)) return null;
  const attr = target === 'paragraph' ? 'data-pindex' : target === 'footnote' ? 'data-findex' : target === 'endnote' ? 'data-eindex' : null;
  return attr ? readerBoundParagraphs(host, target, index)[0] || null : null;
}

function replayAppliedFixes(host) {
  // 新服务已把修改写进工作版本字节，重复 DOM 回放会再次替换相同文字。
  if (state.workVersion) return;
  for (const a of state.appliedFixDetails) {
    const target = fixDomTarget(host, a);
    if (target) replaceTextInDom(target, a.find, a.replace, a.offset);
  }
}

/** 同步更新本地文档模型里的段落文本，让对比视图/搜索保持一致 */
function syncDocText(paragraphIndex, find, replace) {
  const p = state.doc?.paragraphs?.[paragraphIndex];
  if (!p || !find) return;
  const at = (p.text || '').indexOf(find);
  if (at < 0) return;
  p.text = p.text.slice(0, at) + (replace ?? '') + p.text.slice(at + find.length);
}

const applyFixRequests = new Set();

/** 历史按钮和当前稿版本只由服务端历史及当前任务状态驱动。 */
function syncHistoryControls() {
  const busy = !state.sessionId || state.workspaceError || state.streaming || state.queueRunning || applyFixRequests.has(state.sessionId);
  const supported = !!state.workVersion?.id && !!state.history;
  const undo = $('#btnUndoFixes');
  const redo = $('#btnRedoFixes');
  if (undo) undo.disabled = busy || !supported || !state.history.canUndo;
  if (redo) redo.disabled = busy || !supported || !state.history.canRedo;
  const label = $('#workVersionLabel');
  if (label) {
    label.textContent = !state.sessionId ? '未导入稿件' : state.showOriginal ? '投稿原稿'
      : state.workVersion ? `当前稿 · 版本 ${state.workVersion.revision ?? 0}` : '当前稿';
    label.title = state.history ? `当前修改步骤 ${state.history.cursor ?? 0}/${state.history.total ?? 0}` : '';
  }
  syncLegacyReviewButton();
}

/** 先更新所属稿件缓存，再决定响应是否仍属于当前工作区。 */
function adoptWorkResponse(sessionId, response, { activationSerial = state.activationSerial } = {}) {
  const applied = response.applied || [];
  const hasResult = Object.prototype.hasOwnProperty.call(response, 'result');
  const item = state.queue.find((x) => x.id === sessionId);
  if (item) {
    delete item.reviewTerminalProof;
    if (response.doc) item.doc = response.doc;
    if (hasResult) {
      item.result = response.result || null;
      item.status = response.result ? `所选步骤已结束（${(response.result.issues || []).length} 条）` : '待重新审阅';
    }
    item.workVersion = response.workVersion || null;
    item.history = response.history || null;
    if (Object.prototype.hasOwnProperty.call(response, 'clean')) item.clean = response.clean || null;
    if (Object.prototype.hasOwnProperty.call(response, 'legacy')) item.legacy = response.legacy || null;
    item.appliedFixDetails = response.appliedFixDetails || [...(item.appliedFixDetails || []), ...applied];
    item.appliedFixes = Array.isArray(response.appliedFixes) ? response.appliedFixes
      : [...new Set([...(item.appliedFixes || []), ...applied.map((a) => a.key).filter(Boolean)])];
  }
  if (state.sessionId !== sessionId || state.activationSerial !== activationSerial) return false;
  if (response.workVersion) {
    // The response confirms saved version metadata before coverage is bound.
    state.workVersion = response.workVersion;
    state.buffer = null;
    rendered.markup = null;
    documentRenderSeq += 1;
  }
  if (response.doc) state.doc = response.doc;
  if (hasResult) {
    state.issues = response.result?.issues || [];
    state.anchorStats = response.result?.anchorStats || null;
    state.summary = response.result?.summary || null;
    state.verdict = response.result?.verdict || null;
    state.verdictModel = response.result?.verdictModel || null;
    state.recheck = response.result?.recheck?.byKey || null;
    state.recheckStats = response.result?.recheck?.stats || null;
    state.streamSeq = state.issues.length;
    if (!state.issues.some((issue) => issueKey(issue) === state.activeIssueKey)) {
      state.activeIssueKey = null;
      $('#detail').classList.add('hidden');
    }
    $('#btnReport').disabled = !response.result;
    $('#btnDocx').disabled = !response.result;
  }
  state.history = response.history || null;
  adoptDocumentProvenance(response);
  adoptHumanContext(response);
  if (hasResult) {
    if (response.result) adoptReviewCoverage(response.result);
    else resetReviewCoverage();
    renderReviewResultProgress(response.result);
  }
  state.appliedFixDetails = response.appliedFixDetails || [...state.appliedFixDetails, ...applied];
  if (Array.isArray(response.appliedFixes)) state.resolved = new Set(response.appliedFixes);
  else for (const patch of applied) if (patch.key) state.resolved.add(patch.key);
  if (item) {
    item.doc = state.doc;
    item.appliedFixDetails = state.appliedFixDetails;
    item.appliedFixes = [...state.resolved];
  }
  syncHistoryControls();
  return true;
}

/** 修改、撤销和重做共用版本校验、正文重载及失败显示。 */
async function refreshWorkResponse(sessionId, response, completedText, activationSerial = state.activationSerial) {
  const isCurrent = () => state.sessionId === sessionId && state.activationSerial === activationSerial;
  if (!isCurrent()) return null;
  let previewFailed = false;
  if (response.workVersion) {
    state.buffer = null;
    state.workVersion = response.workVersion;
    state.showOriginal = false;
    rendered.markup = null;
    documentRenderSeq += 1;
    const originalBtn = $('#btnOriginal');
    originalBtn.textContent = '查看原文';
    originalBtn.classList.remove('btn-primary');
    originalBtn.classList.add('btn-ghost');
    $('#docHost').innerHTML = '<div class="empty">正在载入已保存的稿件版本…</div>';
    try {
      if (!await loadWorkingVersion(sessionId, response.workVersion)) return null;
      markIndex.clear();
      renderDocInfo();
      await renderDocument(true);
      if (!isCurrent()) return null;
    } catch {
      if (!isCurrent()) return null;
      previewFailed = true;
      state.workVersion = response.workVersion;
      state.buffer = null;
      rendered.markup = null;
      $('#docHost').innerHTML = `<div class="empty">${esc(completedText)}，当前稿预览获取失败。请刷新页面恢复。</div>`;
    }
  } else {
    // 兼容旧服务：未提供工作版本时才在原字节预览上回放修改。
    state.workVersion = null;
    const hosts = [$('#docHost')].filter(Boolean);
    for (const patch of response.applied || []) {
      for (const host of hosts) {
        const target = fixDomTarget(host, patch);
        if (target) replaceTextInDom(target, patch.find, patch.replace, patch.offset);
      }
      const issue = state.issues.find((x) => issueKey(x) === patch.key);
      if (!response.doc && issue?.anchor?.target === 'paragraph') syncDocText(issue.anchor.index, patch.find, patch.replace);
    }
    markIndex.clear();
    for (const host of hosts) clearMarks(host);
    for (const host of hosts) indexRenderedParagraphs(host);
    if (state.view === 'markup') highlightIssuesInDoc();
    markHeadingLevels();
  }
  if (Object.prototype.hasOwnProperty.call(response, 'result')) {
    if (response.result) adoptReviewCoverage(response.result);
    else resetReviewCoverage();
    renderReviewResultProgress(response.result);
  }
  renderMarkupStats();
  renderMarkupIssues();
  renderQueue();
  const active = state.activeIssueKey && state.issues.find((x) => issueKey(x) === state.activeIssueKey);
  if (active) {
    if (response.result) selectIssue(issueKey(active));
    else updateDetailFixBtn(active);
  }
  syncHistoryControls();
  return { previewFailed };
}

function newWorkOperationId() {
  return globalThis.crypto?.randomUUID?.()
    || `work-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** 网络异常最多重试一次，沿用完全相同的操作号和基础版本。 */
async function fetchWorkMutation(path, body, retryable) {
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
  const attempts = retryable ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetch(path, options);
      const response = await res.json();
      return { res, response };
    } catch (error) {
      if (attempt === attempts - 1) throw error;
    }
  }
}

/** 同稿串行保存；每次请求固定稿件、基础版本和幂等操作号。 */
async function requestWorkMutation(path, payload, { kind = 'apply', single = false } = {}) {
  if (state.workspaceError) { toast('工作台恢复失败，请先重试恢复再修改稿件'); return; }
  if (!state.sessionId) return;
  const sessionId = state.sessionId;
  const activationSerial = state.activationSerial;
  const baseReviewRunId = state.reviewRunId || null;
  const isCurrent = () => state.sessionId === sessionId && state.activationSerial === activationSerial
    && (kind !== 'apply' || (state.reviewRunId || null) === baseReviewRunId);
  const baseVersionId = state.workVersion?.id;
  const baseMutationEpoch = state.history?.epoch;
  const operationId = newWorkOperationId();
  const actionLabel = kind === 'undo' ? '撤销' : kind === 'redo' ? '重做' : kind === 'clean' ? '清洗验证' : '修改';
  const completedText = kind === 'apply' ? '修改已保存' : `${actionLabel}已完成`;
  if (state.streaming || state.queueRunning) { toast('请等待当前审阅完成后再修改稿件'); return; }
  if (kind === 'apply' && !baseReviewRunId) { toast('请核对当前审阅记录后再修改稿件'); return; }
  if (applyFixRequests.has(sessionId)) { toast('当前修改正在保存，请稍候'); return; }
  applyFixRequests.add(sessionId);
  syncHistoryControls();
  try {
    const body = JSON.stringify({ ...payload, id: sessionId, baseVersionId, baseMutationEpoch, operationId,
      ...(kind === 'apply' ? { baseReviewRunId } : {}) });
    // 只有声明了历史 epoch 的服务才能保证操作号幂等，旧服务不重试写入。
    const retryable = !!baseVersionId && baseMutationEpoch !== undefined && baseMutationEpoch !== null;
    const { res, response } = await fetchWorkMutation(path, body, retryable);
    if (response.error || !res.ok) {
      if (isCurrent()) toast(response.error || `${actionLabel}失败：HTTP ${res.status}`, 6000);
      return;
    }
    if (kind === 'apply' && state.sessionId === sessionId && !isCurrent()) return;
    if (kind === 'apply') {
      const entry = state.queue.find(item => item.id === sessionId);
      if (entry?.reviewRunId != null && entry.reviewRunId !== baseReviewRunId) return;
    }
    if (!adoptWorkResponse(sessionId, response, { activationSerial })) return;
    const refreshed = await refreshWorkResponse(sessionId, response, completedText, activationSerial);
    if (!refreshed || !isCurrent()) return;
    const applied = response.applied || [];
    const skipped = response.skipped || [];
    if (refreshed.previewFailed) toast(`${completedText}，预览获取失败，请刷新页面恢复`, 6000);
    else if (kind === 'clean') toast('清洗验证已完成，当前稿已载入；可手动开始审阅');
    else if (kind !== 'apply') toast(`已${actionLabel}修改，当前稿已恢复到对应保存版本`);
    else if (single) toast(applied.length ? `已修改：${applied[0].find} → ${applied[0].replace || '（删除）'}` : (skipped[0]?.reason || '未产生变化'));
    else toast(`已应用 ${applied.length} 项自动修复${skipped.length ? `，${skipped.length} 项跳过` : ''}`);
    if (kind !== 'apply' || !single) {
      state.accepted.clear();
      $$('#mkIssues .issue-check').forEach((box) => { box.checked = false; });
    }
    updateApplyBtn();
    $('#btnReview').textContent = state.summary ? '重新审阅' : '开始审阅';
  } catch { if (isCurrent()) toast(`${actionLabel}失败`); }
  finally {
    applyFixRequests.delete(sessionId);
    syncHistoryControls();
    updateApplyBtn();
  }
}

/** 单条、批量修改与历史操作使用同一份服务器响应采纳逻辑。 */
async function postApplyFixes(keys, { single = false } = {}) {
  if (!keys.length || !state.sessionId) return;
  if (state.showOriginal) { toast('正在查看原稿，请返回当前稿后再修改'); return; }
  const pendingCount = keys.filter(key => issueRangeProblem(state.issues.find(it => issueKey(it) === key))).length;
  if (pendingCount) toast(`${pendingCount} 条问题的位置待确认，未提交自动修改`, 4200);
  keys = keys.filter(key => !issueRangeProblem(state.issues.find(it => issueKey(it) === key)));
  const noteProblem = keys.map(key => readerNoteIssueProblem(state.issues.find(it => issueKey(it) === key))).find(Boolean);
  if (noteProblem) { toast(`所选注释未准确定位，未执行修改：${noteProblem}`, 4200); return; }
  keys = selectedFixableKeys(keys);
  if (!keys.length) { toast(pendingCount ? '所选问题的位置待确认，未执行修改' : '所选问题没有可自动修改项，需核对位置或改法'); return; }
  return requestWorkMutation('/api/apply-fixes', { accepted: keys }, { single });
}

async function postFixHistory(kind) {
  if (kind !== 'undo' && kind !== 'redo') return;
  const available = kind === 'undo' ? state.history?.canUndo : state.history?.canRedo;
  if (!available || !state.workVersion?.id) { syncHistoryControls(); return; }
  return requestWorkMutation(`/api/${kind}-fixes`, {}, { kind });
}

/** 逐条一键修改（需求 7） */
function applyFixOne(key) {
  const it = state.issues.find((x) => issueKey(x) === key);
  if (!it) return;
  if (it.needsRelocation) { toast('该问题需重新定位，请重新审阅当前稿'); return; }
  const rangeProblem = issueRangeProblem(it);
  if (rangeProblem) { toast(rangeProblem, 3600); return; }
  const noteProblem = readerNoteIssueProblem(it);
  if (noteProblem) { toast(noteProblem, 3600); return; }
  if (!isFixable(it)) { toast('该条不支持自动修改，需人工处理'); return; }
  return postApplyFixes([key], { single: true });
}

/** 批量：底部「应用勾选的自动修复」 */
function applyFixes() {
  const accepted = [...state.accepted];
  if (!accepted.length) { toast('未勾选可修复项'); return; }
  return postApplyFixes(accepted);
}

/* ==================================================================
   初始化
   ================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  initPanels();
  boot();

  $('#btnImport').addEventListener('click', () => { pendingIngestionSelection = null; $('#fileInput').click(); });
  $('#dropzone').addEventListener('click', () => { pendingIngestionSelection = null; $('#fileInput').click(); });
  // 一次可选多篇（批量导入队列）；单篇仍走 importFile
  $('#fileInput').addEventListener('change', (e) => {
    const fs = [...e.target.files];
    if (fs.length) { if (pendingIngestionSelection) selectIngestionFile(fs); else importFiles(fs); }
    e.target.value = '';   // 允许重复选同一文件
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const fs = [...(e.dataTransfer?.files || [])];
    if (fs.length) { pendingIngestionSelection = null; importFiles(fs); }
  });

  $('#btnReviewQueue').addEventListener('click', reviewQueue);
  $('#btnPauseQueue').addEventListener('click', pauseReviewQueue);
  $('#btnCancelQueue')?.addEventListener('click', cancelReviewQueue);
  $('#btnRefreshQueue')?.addEventListener('click', async () => { await refreshReviewQueue(); startQueueObserver(); if (state.sessionId) await resumeReview({ silent: true }); });

  $('#btnReview').addEventListener('click', runReview);
  $('#btnCancel').addEventListener('click', cancelCurrentReview);
  $('#btnReport').addEventListener('click', exportReport);
  $('#btnDocx').addEventListener('click', exportDocx);
  $('#btnWorkingDocx').addEventListener('click', exportWorkingDocx);
  $('#btnUndoFixes').addEventListener('click', () => postFixHistory('undo'));
  $('#btnRedoFixes').addEventListener('click', () => postFixHistory('redo'));
  $('#btnApply').addEventListener('click', applyFixes);
  // 详情面板里的「一键修改」（需求 7）
  $('#detailFixOne')?.addEventListener('click', (e) => {
    const k = e.currentTarget.dataset.key;
    if (k) applyFixOne(k);
  });
  $('#detailClose').addEventListener('click', closeIssueDetail);

  $('#viewTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) switchView(b.dataset.view);
  });
  /**
   * 「显示问题标记」开关。
   *
   * 旧实现是 `rendered.markup = null; renderDocument(true)` —— 为了隐藏
   * 几个标记把**整篇文档重渲一遍**（本刊定稿渲染后高 8000–9000px，
   * 重渲有明显卡顿），而且它其实什么也没隐藏（当时根本没有标记元素）。
   *
   * 现在下划线是真的了，开关就真的开关：加一个 class 让 CSS 收起标记，
   * 零重渲。
   */
  $('#showMarks').addEventListener('change', (e) => {
    state.showMarks = e.target.checked;
    applyMarksVisibility();
  });

  // 「查看原文」：在清洗稿 ↔ 投稿原稿之间切换（需求：需要看原文时用按钮，不再单开视图）
  $('#btnOriginal').addEventListener('click', toggleOriginal);
  // 人工审阅模式 + 审稿日志（需求 6/7）
  $('#btnHumanReview').addEventListener('click', toggleHumanMode);
  $('#btnAudit').addEventListener('click', openAuditModal);
  $('#btnLegacyReview').addEventListener('click', openLegacyReview);
  $('#btnVerifyClean').addEventListener('click', verifyLegacyClean);
  $('#btnAuditClose').addEventListener('click', () => { state.auditRequestSerial += 1; $('#auditModal').classList.add('hidden'); });
  $('#docHost').addEventListener('mouseup', onDocMouseUp);
  window.addEventListener('resize', positionHumanPop);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    requestCloseHumanPop();
    $('#auditModal').classList.add('hidden');
  });

  // 筛选：更多筛选展开
  $('#btnFilterToggle').addEventListener('click', (e) => {
    const more = $('#filtersMore');
    const open = more.classList.toggle('hidden') === false;
    e.currentTarget.setAttribute('aria-expanded', String(open));
    e.currentTarget.classList.toggle('chip-on', open);
  });
  $('#filterGroup').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    state.filterGroup = c.dataset.group;
    $$('#filterGroup .chip').forEach((x) => x.classList.toggle('chip-on', x === c));
    renderMarkupIssues(); highlightIssuesInDoc();
  });
  $('#filterSeverity').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    state.filterSeverity = c.dataset.sev;
    $$('#filterSeverity .chip').forEach((x) => x.classList.toggle('chip-on', x === c));
    renderMarkupIssues(); highlightIssuesInDoc();
  });
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value.trim();
    renderMarkupIssues(); highlightIssuesInDoc();
  });
  $('#chipFixable').addEventListener('click', (e) => {
    state.onlyFixable = !state.onlyFixable;
    e.currentTarget.classList.toggle('chip-on', state.onlyFixable);
    renderMarkupIssues(); highlightIssuesInDoc();
  });
  $('#chipAccepted').addEventListener('click', (e) => {
    state.onlyAccepted = !state.onlyAccepted;
    e.currentTarget.classList.toggle('chip-on', state.onlyAccepted);
    renderMarkupIssues(); highlightIssuesInDoc();
  });
  $('#btnSelectFixable').addEventListener('click', () => {
    visibleIssues().forEach((it) => { if (isFixable(it)) state.accepted.add(issueKey(it)); });
    renderMarkupIssues();
    updateApplyBtn();
    toast(`已勾选 ${selectedFixableKeys([...state.accepted]).length} 项可自动修复`);
  });

  // 追问模型
  $('#detailAsk').addEventListener('click', async () => {
    const key = state.activeIssueKey;
    if (!key) return;
    const it = state.issues.find((x) => issueKey(x) === key);
    if (!it) return;
    const box = $('#detailAnswer');
    box.classList.remove('hidden');
    box.textContent = '正在追问模型…';
    try {
      const r = await (await fetch('/api/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.sessionId, question: it.title, context: it.quote, ruleId: it.ruleId, location: it.location, useModel: true }),
      })).json();
      box.textContent = r.answer || r.error || '无回复';
    } catch { box.textContent = '追问失败'; }
  });

  updateApplyBtn();
});
