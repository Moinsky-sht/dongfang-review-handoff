/** 累加接口实际返回的用量，含复核与补问；缓存 token 属于输入 token 的子集。 */
export function addTokenUsage(total, usage) {
  if (!usage) return total;
  total.input_tokens += Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  total.output_tokens += Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  total.cached_tokens += Number(usage.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens ?? 0) || 0;
  return total;
}

export function sumTokenUsage(...usages) {
  if (!usages.some(Boolean)) return null;
  return usages.reduce(addTokenUsage, { input_tokens: 0, output_tokens: 0, cached_tokens: 0 });
}
