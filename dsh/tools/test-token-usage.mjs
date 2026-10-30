import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { addTokenUsage, sumTokenUsage } from '../src/token-usage.js';

assert.equal(sumTokenUsage(null, undefined), null);
assert.deepEqual(sumTokenUsage({ input_tokens: 5, output_tokens: 7 }, { input_tokens: 11, output_tokens: 13, cached_tokens: 3 }),
  { input_tokens: 16, output_tokens: 20, cached_tokens: 3 });
assert.deepEqual(addTokenUsage({ input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
  { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } }),
  { input_tokens: 10, output_tokens: 2, cached_tokens: 4 });

let calls = 0;
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const count = Number(String(body.input).match(/复核以下 (\d+) 条/)?.[1] || 0);
  calls += 1;
  const results = Array.from({ length: calls === 1 ? 1 : count }, (_, i) => ({ i, verdict: 'agree', reason: 'fixture' }));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ output_text: JSON.stringify({ results }),
    usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 25 } } }));
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
// 使用本地固定响应验证记账，不调用真实模型。
process.env.ARK_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
process.env.ARK_API_KEY = 'local-test-only';
try {
  const { recheckFixes } = await import('../src/recheck.js');
  const issues = Array.from({ length: 4 }, (_, i) => ({ ruleId: 'FMT-014', location: `paragraph:${i}`, quote: 'fixture', suggestion: 'fixture' }));
  const checked = await recheckFixes(issues);
  assert.equal(calls, 2, '残缺响应须精简补问');
  assert.equal(checked.stats.checked, 4);
  assert.deepEqual(checked.usage, { input_tokens: 200, output_tokens: 20, cached_tokens: 50 }, '两次调用均须计入');
  const { fullReview, streamingReview, parseDocxBuffer, buildReport } = await import('../src/review.js');
  const doc = parseDocxBuffer(readFileSync(new URL('../samples/test.docx', import.meta.url)));
  for (const review of [fullReview, streamingReview]) {
    const before = calls;
    const r = await review(doc, { useModel: false, useRecheck: true });
    assert.ok(calls > before, '规则扫描后的自证须调用接口');
    assert.deepEqual(r.usage, r.recheck.usage, '没有深度审阅时也须报告自证用量');
    assert.deepEqual(r.usage, { input_tokens: (calls - before) * 100, output_tokens: (calls - before) * 10, cached_tokens: (calls - before) * 25 });
    assert.equal(r.usageBreakdown.review, null);
    assert.deepEqual(r.usageBreakdown.recheck, r.recheck.usage);
    r.modelResult = { errors: [{ window: 1, paragraphs: [0, 2], message: 'fixture timeout' }] };
    const report = buildReport(r, doc);
    assert.match(report, /有 1 个窗口未完成/);
    assert.match(report, /正文第 1、3 段/);
  }
  console.log('Token 用量回归通过：完整调用、精简补问、同步与流式审阅均计入复核用量');
} finally {
  await new Promise(resolve => mock.close(resolve));
}
