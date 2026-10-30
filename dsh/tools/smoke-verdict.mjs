import { applyModelVerdicts, verdictLabel } from '../src/recheck.js';

const issues = [
  { ruleId: 'R1', location: '第1段', quote: '甲', severity: '高' },
  { ruleId: 'R2', location: '第2段', quote: '乙', severity: '中' },
  { ruleId: 'R3', location: '第3段', quote: '丙', severity: '高' },
  { ruleId: 'R4', location: '第4段', quote: '丁', severity: '低' }, // 无复核 => 不动
];
const byKey = new Map([
  ['R1|第1段|甲', { verdict: 'agree', reason: '确实不合规范', better: '' }],
  ['R2|第2段|乙', { verdict: 'disagree', reason: '规范允许该写法', better: '可保留' }],
  ['R3|第3段|丙', { verdict: 'unsure', reason: '拿不准', better: '' }],
]);
const out = applyModelVerdicts(issues, { byKey });
const byId = Object.fromEntries(out.map((i) => [i.ruleId, i]));

const checks = [
  ['R1 保留高', byId.R1.severity === '高' && !byId.R1.severityAdjusted],
  ['R1 观点', /同意/.test(byId.R1.modelOpinion)],
  ['R2 降为低', byId.R2.severity === '低' && byId.R2.severityAdjusted === true],
  ['R2 需人工', byId.R2.needsHuman === true],
  ['R2 原优先级', byId.R2.severityBase === '中'],
  ['R2 观点含不必改', /不必改/.test(byId.R2.modelOpinion)],
  ['R3 存疑保高', byId.R3.severity === '高' && byId.R3.needsHuman === true],
  ['R4 未复核不动', byId.R4.severity === '低' && !byId.R4.modelVerdict],
];
let pass = 0;
for (const [name, ok] of checks) { console.log(`${ok ? '✓' : '✗'} ${name}`); if (ok) pass += 1; }
console.log(`\n═══ 结果：${pass} 通过 / ${checks.length - pass} 失败 ═══`);
console.log('verdictLabel agree =', verdictLabel('agree'));
process.exit(pass === checks.length ? 0 : 1);
