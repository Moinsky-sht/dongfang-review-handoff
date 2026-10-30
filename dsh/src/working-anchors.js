/**
 * Rebase source-version issue anchors onto the current working DOCX.
 * Saved input issues and reviewed autoFix declarations stay immutable; no substring search is used.
 * Package-bound fixes in the cloned DTO use verified current geometry, with their
 * original declarations retained as reviewedAutoFix. Unbound legacy fixes retain their shape.
 */

const TARGET = { body: 'paragraph', paragraph: 'paragraph', footnote: 'footnote', endnote: 'endnote' };
const TEXTS = { paragraph: 'paragraphs', footnote: 'footnotes', endnote: 'endnotes' };
const keyOf = (issue) => issue.issueKey || `${issue.ruleId}|${issue.location}|${issue.quote || ''}`;

function patchHistory(patches, sourceVersionId) {
  const groups = new Map();
  const seen = new Map();
  for (const patch of patches || []) {
    if (patch.sourceVersionId !== sourceVersionId) continue;
    const target = TARGET[patch.target];
    if (!target || !Number.isInteger(patch.index)) continue;
    const groupKey = `${target}:${patch.index}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { ranges: [], invalid: false });
    const group = groups.get(groupKey);
    if (patch.textView != null && patch.textView !== 'after'
      || patch.offsetUnit != null && patch.offsetUnit !== 'utf16'
      || patch.paragraphIndexOwner != null && patch.paragraphIndexOwner !== 'application-paragraph-index'
      || patch.owner != null && !['after', 'application-paragraph-index'].includes(patch.owner)
      || !Number.isInteger(patch.sourceOffset) || patch.sourceOffset < 0
      || typeof patch.find !== 'string' || !patch.find || typeof patch.replace !== 'string') {
      group.invalid = true;
      continue;
    }
    const signature = JSON.stringify([groupKey, patch.sourceOffset, patch.find, patch.replace, patch.key]);
    if (patch.patchId && seen.has(patch.patchId)) {
      if (seen.get(patch.patchId).signature !== signature) {
        group.invalid = true;
        seen.get(patch.patchId).group.invalid = true;
      }
      continue;
    }
    if (patch.patchId) seen.set(patch.patchId, { signature, group });
    group.ranges.push({ ...patch, start: patch.sourceOffset, end: patch.sourceOffset + patch.find.length,
      delta: patch.replace.length - patch.find.length });
  }
  for (const group of groups.values()) {
    group.ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < group.ranges.length; i += 1) {
      if (group.ranges[i].start < group.ranges[i - 1].end) group.invalid = true;
    }
  }
  return groups;
}

function mappedAnchor(anchor, issueKey, currentDoc, groups, sourceVersionId) {
  if (['ambiguous', 'unmapped', 'unresolved'].includes(anchor?.resolutionStatus)) return { reason: 'unresolved_source_range' };
  if (anchor?.target === 'document' || anchor?.target === 'table') return { anchor: { ...anchor } };
  if (anchor?.textView != null && anchor.textView !== 'after') return { reason: 'unsupported_text_view' };
  if (anchor?.offsetUnit != null && anchor.offsetUnit !== 'utf16') return { reason: 'unsupported_offset_unit' };
  if (anchor?.paragraphIndexOwner != null && anchor.paragraphIndexOwner !== 'application-paragraph-index') return { reason: 'unsupported_index_owner' };
  if (anchor?.owner != null && !['after', 'application-paragraph-index'].includes(anchor.owner)) return { reason: 'unsupported_source_owner' };
  if (anchor?.sourceVersionId != null && anchor.sourceVersionId !== sourceVersionId) return { reason: 'source_version_mismatch' };
  const listKey = TEXTS[anchor?.target];
  if (!listKey || !Number.isInteger(anchor.index) || !Number.isInteger(anchor.start)
    || !Number.isInteger(anchor.end) || anchor.start < 0 || anchor.end < anchor.start
    || typeof anchor.text !== 'string' || anchor.text.length !== anchor.end - anchor.start) {
    return { reason: 'invalid_anchor' };
  }
  const node = currentDoc?.[listKey]?.[anchor.index];
  const text = node?.text;
  if (typeof text !== 'string') return { reason: 'missing_target' };
  for (const [field, actual] of [['pid', node.id], ['sourceXmlNodeId', node.sourceXmlNodeId],
    ['sourceXmlParagraphOrdinal', node.sourceXmlParagraphOrdinal], ['noteId', node.noteId]]) {
    if (anchor[field] == null) continue;
    if (actual == null) return { reason: 'current_source_identity_unverified' };
    if (String(anchor[field]) !== String(actual)) return { reason: 'source_identity_mismatch' };
  }
  if (anchor.part != null && ![node.part, node.part && 'word/' + node.part].includes(anchor.part)) return { reason: 'source_identity_mismatch' };
  const history = groups.get(`${anchor.target}:${anchor.index}`);
  if (history?.invalid) return { reason: 'invalid_history' };
  const patches = history?.ranges || [];
  const overlaps = patches.filter((p) => p.start < anchor.end && anchor.start < p.end);
  const delta = patches.filter((p) => p.end <= anchor.start).reduce((sum, p) => sum + p.delta, 0);
  const start = anchor.start + delta;
  let end = anchor.end + delta;
  let expected = anchor.text;
  let precision = anchor.precision;
  if (overlaps.length) {
    const exact = overlaps.length === 1 && overlaps[0].start === anchor.start && overlaps[0].end === anchor.end;
    const patch = overlaps[0];
    if (!exact || (patch.key != null && patch.key !== issueKey) || patch.find !== anchor.text) return { reason: 'changed_range' };
    expected = patch.replace;
    end = start + expected.length;
    precision = 'exact';
  }
  if (start < 0 || end > text.length || text.slice(start, end) !== expected) return { reason: 'text_mismatch' };
  return { anchor: { ...anchor, start, end, text: expected, precision,
    ...(node.id != null ? { pid: node.id } : {}), ...(node.part != null ? { part: node.part } : {}),
    ...(node.sourceXmlNodeId != null ? { sourceXmlNodeId: node.sourceXmlNodeId } : {}),
    ...(Number.isInteger(node.sourceXmlParagraphOrdinal) ? { sourceXmlParagraphOrdinal: node.sourceXmlParagraphOrdinal } : {}),
    sourceReviewedPackageSha256: anchor.sourceReviewedPackageSha256 ?? anchor.sourcePackageSha256 ?? null,
    sourceReviewedVersionId: anchor.sourceReviewedVersionId ?? anchor.sourceVersionId ?? sourceVersionId,
    sourcePackageSha256: currentDoc?.sourcePackageSha256 ?? null,
    sourceVersionId: currentDoc?.sourceVersionId ?? null,
    textView: 'after', offsetUnit: 'utf16', paragraphIndexOwner: 'application-paragraph-index',
    rangeProof: 'verified-committed-patch-history' } };
}

/** Project only a verified, package-bound fix; its original declaration stays separate. */
function projectedFix(fix, source, current) {
  if (!fix || !source || !current || !/^[a-f0-9]{64}$/.test(fix.sourcePackageSha256 || '')
    || fix.sourcePackageSha256 !== source.sourcePackageSha256 || !/^[a-f0-9]{64}$/.test(current.sourcePackageSha256 || '')
    || fix.workSha256 != null && fix.workSha256 !== source.sourcePackageSha256
    || fix.workVersionId != null && fix.workVersionId !== source.sourceVersionId
    || fix.versionId != null && fix.versionId !== source.sourceVersionId
    || fix.find !== source.text || fix.offset != null && fix.offset !== source.start
    || fix.textView != null && fix.textView !== 'after' || fix.offsetUnit != null && fix.offsetUnit !== 'utf16'
    || fix.paragraphIndexOwner != null && fix.paragraphIndexOwner !== 'application-paragraph-index'
    || fix.owner != null && !['after','application-paragraph-index'].includes(fix.owner)
    || fix.sourceVersionId != null && fix.sourceVersionId !== source.sourceVersionId
    || ['pid','noteId','sourceXmlNodeId','sourceXmlParagraphOrdinal'].some(key => fix[key] != null && String(fix[key]) !== String(source[key]))
    || fix.part != null && String(fix.part).replace(/^word\//,'') !== String(source.part).replace(/^word\//,'')) return null;
  const alreadyApplied = current.text !== source.text;
  return { ...fix, find: current.text, offset: current.start,
    sourcePackageSha256: current.sourcePackageSha256, sourceVersionId: current.sourceVersionId,
    ...(fix.workSha256 != null ? { workSha256: current.sourcePackageSha256 } : {}),
    ...(fix.workVersionId != null ? { workVersionId: current.sourceVersionId } : {}),
    ...(fix.versionId != null ? { versionId: current.sourceVersionId } : {}),
    sourceReviewedPackageSha256: source.sourcePackageSha256, sourceReviewedVersionId: source.sourceVersionId,
    alreadyApplied, reusable: !alreadyApplied && fix.find !== fix.replace,
    rangeProof: 'verified-committed-patch-history' };
}

/**
 * @param {Array} issues Issues anchored against their immutable reviewed text.
 * @param {object} currentDoc Current parseDocxBuffer document.
 * @param {Array} patches Verified committed patches, carrying sourceOffset.
 * @param {string} sourceVersionId The version used to compute the source anchors.
 * @returns {Array} Deep-cloned issues retaining keys and reviewedAutoFix declarations;
 * package-bound autoFix fields are a verified current-version projection, never a saved-input mutation.
 * If any occurrence is uncertain, the whole issue requires relocation and carries
 * no actionable anchors. Resolved deletions may carry a verified empty range.
 */
export function rebaseIssueAnchors(issues, currentDoc, patches, sourceVersionId) {
  const clones = structuredClone(issues || []);
  const groups = patchHistory(patches, sourceVersionId);
  return clones.map((issue) => {
    const sourceAnchors = Array.isArray(issue.anchors) ? issue.anchors : issue.anchor ? [issue.anchor] : [];
    if (!sourceAnchors.length) return issue;
    const mapped = sourceAnchors.map((anchor) => mappedAnchor(anchor, keyOf(issue), currentDoc, groups, sourceVersionId));
    const failure = mapped.find((result) => result.reason);
    if (failure) {
      issue.anchors = [];
      issue.anchor = null;
      issue.needsRelocation = true;
      issue.relocationReason = failure.reason;
    } else {
      issue.anchors = mapped.map((result) => result.anchor);
      issue.anchor = issue.anchors[0];
      const fix = projectedFix(issue.autoFix, sourceAnchors[0], issue.anchor);
      if (fix) { issue.reviewedAutoFix = structuredClone(issue.autoFix); issue.autoFix = fix; }
      for (const [index, occurrence] of (issue.occurrences || []).entries()) {
        const anchorIndex = sourceAnchors.findIndex(anchor => anchor.occurrenceIndex === index);
        const projected = projectedFix(occurrence.autoFix, sourceAnchors[anchorIndex], issue.anchors[anchorIndex]);
        if (projected) { occurrence.reviewedAutoFix = structuredClone(occurrence.autoFix); occurrence.autoFix = projected; }
      }
      issue.needsRelocation = false;
      delete issue.relocationReason;
    }
    return issue;
  });
}
