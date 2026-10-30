/** Immutable review-time source identities. Text equality is never version proof. */
const lists = { body: 'paragraphs', footnote: 'footnotes', endnote: 'endnotes' };
const shaPattern = /^[a-f0-9]{64}$/;

export function sourceNodeIdentity(node) {
  return { id: node.id, part: node.part, index: node.index,
    sourceXmlParagraphOrdinal: node.sourceXmlParagraphOrdinal, sourceXmlNodeId: node.sourceXmlNodeId,
    sourceXmlTableNodeId: node.sourceXmlTableNodeId ?? null,
    sourcePackageSha256: node.sourcePackageSha256, textView: node.textView, offsetUnit: node.offsetUnit,
    paragraphIndexOwner: node.paragraphIndexOwner };
}

export function captureReviewSource(doc, version = null) {
  const snapshot = { sourceSchemaVersion: 1, sourcePackageSha256: doc.sourcePackageSha256,
    sourceVersionId: version?.id || null, sourceNodes: {} };
  if (!shaPattern.test(snapshot.sourcePackageSha256 || '')
    || version && version.sha256 !== snapshot.sourcePackageSha256) throw new Error('审核原文与工作版本校验不一致');
  for (const [key, list] of Object.entries(lists)) {
    const nodes = doc[list] || [];
    snapshot[key] = nodes.map(node => node.text);
    snapshot.sourceNodes[key] = nodes.map(node => ({ ...sourceNodeIdentity(node), text: node.text,
      noteId: node.noteId ?? null, noteType: node.noteType || '', isNoteSeparator: !!node.isNoteSeparator,
      inTable: !!node.inTable, tableIdx: node.tableIdx ?? null }));
  }
  return snapshot;
}

export function reviewTextVectorsMatch(snapshot, doc) {
  return !!snapshot && Object.entries(lists).every(([key, list]) => Array.isArray(snapshot[key])
    && snapshot[key].length === (doc[list] || []).length
    && snapshot[key].every((text, index) => typeof text === 'string' && text === doc[list][index].text));
}

/** Validate a sidecar, or safely recover an old text-only snapshot from exact saved bytes. */
export function reviewedSourceDocument(snapshot, { savedDoc = null, versionId = null } = {}) {
  let source = snapshot;
  if (!source?.sourceNodes && savedDoc && reviewTextVectorsMatch(source, savedDoc)) {
    source = captureReviewSource(savedDoc);
    source.sourceVersionId = versionId;
  }
  const invalid = reason => ({ verified: false, reason, source: snapshot, doc: null });
  if (!source?.sourceNodes || source.sourceSchemaVersion !== 1
    || !shaPattern.test(source.sourcePackageSha256 || '')) return invalid('review_source_unverified');
  if (versionId && source.sourceVersionId !== versionId) return invalid('review_source_version_mismatch');
  if (savedDoc && source.sourcePackageSha256 !== savedDoc.sourcePackageSha256) return invalid('review_source_sha_mismatch');
  const doc = { sourcePackageSha256: source.sourcePackageSha256, sourceVersionId: source.sourceVersionId };
  for (const [key, list] of Object.entries(lists)) {
    const nodes = source.sourceNodes[key];
    const part = key === 'body' ? 'document.xml' : key === 'footnote' ? 'footnotes.xml' : 'endnotes.xml';
    if (!Array.isArray(nodes) || !Array.isArray(source[key]) || nodes.length !== source[key].length) return invalid('review_source_vector_mismatch');
    const physicalIds = new Set();
    for (const [index, node] of nodes.entries()) {
      if (!node || node.id !== `${part}:${index}` || node.part !== part || node.index !== index
        || typeof node.text !== 'string' || node.text !== source[key][index]
        || node.textView !== 'after' || node.offsetUnit !== 'utf16'
        || node.paragraphIndexOwner !== 'application-paragraph-index'
        || !Number.isSafeInteger(node.sourceXmlParagraphOrdinal) || node.sourceXmlParagraphOrdinal < 0
        || node.sourceXmlNodeId !== `${part}:xml-p:${node.sourceXmlParagraphOrdinal}`
        || node.sourceXmlTableNodeId != null && !new RegExp(`^${part.replace('.', '\\.')}\\:xml-tbl:\\d+$`).test(node.sourceXmlTableNodeId)
        || node.sourcePackageSha256 !== source.sourcePackageSha256 || physicalIds.has(node.sourceXmlNodeId)) return invalid('review_source_identity_mismatch');
      physicalIds.add(node.sourceXmlNodeId);
      if (savedDoc) {
        const actual = savedDoc[list]?.[index];
        if (!actual || actual.text !== node.text || actual.sourceXmlNodeId !== node.sourceXmlNodeId
          || node.sourceXmlTableNodeId != null && node.sourceXmlTableNodeId !== actual.sourceXmlTableNodeId
          || (node.noteId ?? null) !== (actual.noteId ?? null) || (node.noteType || '') !== (actual.noteType || '')
          || !!node.isNoteSeparator !== !!actual.isNoteSeparator || !!node.inTable !== !!actual.inTable
          || (node.tableIdx ?? null) !== (actual.tableIdx ?? null)) return invalid('review_source_saved_node_mismatch');
      }
    }
    doc[list] = structuredClone(nodes);
  }
  return { verified: true, reason: null, source, doc };
}
