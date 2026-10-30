/** Stable issue identity: legacy keys remain unchanged; model source claims are distinct. */
import {createHash} from 'node:crypto';
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
  return value;
};
export function issueIdentity(issue) {
  if (typeof issue?.issueKey === 'string' && issue.issueKey) return issue.issueKey;
  const base = `${issue?.ruleId || ''}|${issue?.location || ''}|${issue?.quote || ''}`;
  const resolution = issue?.modelSourceResolution;
  if (!resolution && !issue?.modelSourceDeclaration) return base;
  const anchor = issue.anchor || {}, source = resolution?.source || {};
  const geometry = ['target','index','part','pid','noteId','sourceXmlNodeId',
    'sourceXmlParagraphOrdinal','sourcePackageSha256','sourceVersionId','start','end']
    .map(key => anchor[key] ?? source[key] ?? null);
  const proof = resolution?.contextProof || {};
  const sourceClaim = resolution?.status === 'resolved'
    ? {status:'resolved',geometry}
    : {status:resolution?.status || 'unmapped',declaration:issue.modelSourceDeclaration || null,
      sourcePackageSha256:proof.sourcePackageSha256 ?? null,kind:proof.kind ?? null,
      window:proof.window ?? resolution?.window ?? null,exposedSources:proof.exposedSources || [],
      candidates:resolution?.candidates || []};
  const payload = stable({sourceClaim,ruleId:issue.ruleId,quote:issue.quote || '',
    judgment:[issue.title || '',issue.detail || '',issue.fix || '',issue.proposed || '',issue.severity || '']});
  return base+'|m:'+createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0,24);
}
export function withIssueIdentity(issue) {return {...issue,issueKey:issueIdentity(issue)};}
