import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PROSE_SYSTEM, PROSE_SCHEMAS } from '../src/services/llm.js';
import { LLM_MODELS } from '../src/utils/llm-policy.js';
import { nextFires } from '../src/services/cron.js';
assert(process.env.ANTHROPIC_API_KEY, 'Provide ANTHROPIC_API_KEY through a secret manager.');
assert(process.env.CRONLY_EVAL_CONFIRMED === '1', 'Set CRONLY_EVAL_CONFIRMED=1 to authorize this paid two-model eval, bounded to $10 total.');
const cases = JSON.parse(await readFile(new URL('../docs/evals/to-cron.json', import.meta.url), 'utf8'));
const results = []; let spent = 0;
for (const [model, rates] of Object.entries(LLM_MODELS)) {
  for (const [index, sample] of cases.entries()) {
    const body = JSON.stringify({ model, max_tokens: 1024, system: PROSE_SYSTEM, messages: [{ role: 'user', content: JSON.stringify({ text: sample.text, timezone: sample.timezone }) }], output_config: { effort: 'low', format: { type: 'json_schema', schema: PROSE_SCHEMAS['to-cron'] } } });
    const maximum = (new TextEncoder().encode(body).length + 4096) * rates.maxInput + 1024 * rates.output;
    assert(spent + maximum <= 10000000, 'Eval budget exhausted; results so far remain in the output file.');
    const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(60000) });
    assert(response.ok, `Provider error HTTP ${response.status}; no automatic retry.`);
    const data = await response.json(); const usage = data.usage; assert(usage, 'Missing usage');
    const cost = Math.ceil((usage.input_tokens || 0) * rates.input + (usage.output_tokens || 0) * rates.output + (usage.cache_read_input_tokens || 0) * rates.cacheRead + (usage.cache_creation_input_tokens || 0) * rates.cacheWrite); spent += cost;
    let output; let passed = false;
    try {
      output = JSON.parse(data.content.filter(block => block.type === 'text').map(block => block.text).join(''));
      if (sample.ambiguous) passed = output.confidence <= 0.5 && output.alternatives.length > 0;
      else passed = ['2026-03-01T00:00Z', '2026-10-20T00:00Z'].every(from => JSON.stringify(nextFires(output.cron, sample.timezone, 20, new Date(from))) === JSON.stringify(nextFires(sample.cron, sample.timezone, 20, new Date(from))));
    } catch { /* Record malformed output as an eval failure. */ }
    results.push({ model, case: index, passed, output, usage, cost_microdollars: cost });
    await writeFile(process.env.CRONLY_EVAL_OUTPUT || '/tmp/cronly-prose-eval.json', JSON.stringify({ spent_microdollars: spent, results }, null, 2));
  }
}
for (const model of Object.keys(LLM_MODELS)) console.log(`${model}: ${results.filter(r => r.model === model && r.passed).length}/${cases.length} passed`);
console.log(`Total provider cost: ${(spent / 1000000).toFixed(6)} USD. Review /tmp/cronly-prose-eval.json; do not change the default automatically.`);
