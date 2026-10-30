/** Saved-byte history and the review context valid for each working version. */
export function initializeFixHistory(session) {
  if (!session.history) session.history = { entries: [{ versionId: session.workVersion.id, appliedFixes: structuredClone(session.appliedFixes || []) }], cursor: 0 };
  session.mutationEpoch ??= 0;
  session.maxVersionRevision ??= session.workVersion.revision;
  return session.history;
}

export function fixHistoryStatus(session) {
  const h = initializeFixHistory(session);
  return { cursor: h.cursor, total: h.entries.length - 1, canUndo: h.cursor > 0, canRedo: h.cursor < h.entries.length - 1, epoch: session.mutationEpoch };
}

export function appendedFixState(session, version, applied) {
  const h = initializeFixHistory(session);
  const patches = [...(session.appliedFixes || []), ...applied];
  const entries = [...h.entries.slice(0, h.cursor + 1), { versionId: version.id, appliedFixes: patches }];
  return { history: { entries, cursor: entries.length - 1 }, appliedFixes: patches, mutationEpoch: session.mutationEpoch + 1, maxVersionRevision: Math.max(session.maxVersionRevision, version.revision) };
}

export function historyStep(session, operation) {
  const h = initializeFixHistory(session);
  const cursor = h.cursor + (operation === 'undo' ? -1 : 1);
  if (!['undo', 'redo'].includes(operation)) throw new Error('未知修改历史操作');
  if (cursor < 0 || cursor >= h.entries.length) return null;
  return { cursor, entry: h.entries[cursor] };
}

/** Keep completed runs independently of the current display pointer. */
export function rememberCompletedReview(session) {
  if (!session.result) return;
  session.reviewRecords ||= [];
  if (!session.resultRunId) {
    const previous = session.reviewRecords.find((r) => r.versionId === session.resultVersionId && r.result?.generatedAt === session.result.generatedAt);
    session.resultRunId = previous?.id || `${session.resultVersionId}:${session.result.generatedAt || 'legacy'}`;
  }
  const id = session.resultRunId;
  if (session.reviewRecords.some((record) => record.id === id)) return;
  session.reviewRecords.push({ id, versionId: session.resultVersionId, result: session.result,
    texts: session.resultTexts, options: session.resultOptions, recipe: session.resultRecipe || null, completedAt: new Date().toISOString() });
}

/** Never show a later-version run as a restored earlier manuscript's result. */
export function selectReviewForHistory(session) {
  const h = initializeFixHistory(session);
  let record = null;
  for (let cursor = h.cursor; cursor >= 0 && !record; cursor -= 1) {
    record = [...(session.reviewRecords || [])].reverse().find((r) => r.versionId === h.entries[cursor].versionId && r.result && !r.cleanBlocked);
  }
  session.result = record?.result || null;
  session.resultRunId = record?.id || null;
  session.resultVersionId = record?.versionId || null;
  session.resultTexts = record?.texts || null;
  session.resultOptions = record?.options || null;
  session.resultRecipe = record?.recipe || null;
  session.reviewRunId = record?.id || null;
  session.reviewVersionId = record?.versionId || null;
  session.reviewTexts = record?.texts || null;
  session.reviewError = null;
  session.interrupted = false;
  session.cancelled = false;
  const partial = record?.result?.completionStatus === 'partial' || (record?.result?.modelResult?.errors || []).length > 0;
  session.reviewProgress = record ? { phase: partial ? 'partial' : 'done', done: 1, total: 1, message: partial ? '已恢复部分审阅记录，仍有窗口需补审' : '已恢复对应版本审阅记录' }
    : { phase: 'unreviewed', done: 0, total: 0, message: '此工作版本尚无可用审阅记录' };
}
