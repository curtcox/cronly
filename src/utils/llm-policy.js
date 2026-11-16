// Verified https://platform.claude.com/docs/en/about-claude/pricing, 2026-11-15.
export const LLM_MODELS = Object.freeze({
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, maxInput: 8 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, maxInput: 0.2 }
});
export const LLM_POLICY = Object.freeze({ model: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, maxInput: 8, maxOutputTokens: 2048, maxInputBytes: 65536, maxTurns: 3 });
/** Calculate actual token cost in integer micro-dollars, including cache activity. */
export function tokenCost(usage) {
  return Math.ceil((usage.input_tokens || 0) * LLM_POLICY.input + (usage.output_tokens || 0) * LLM_POLICY.output + (usage.cache_read_input_tokens || 0) * LLM_POLICY.cacheRead + (usage.cache_creation_input_tokens || 0) * LLM_POLICY.cacheWrite);
}
