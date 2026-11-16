import { it, expect, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
function setup() {
  let output = { cron: '0 9 * * 1-5', confidence: 0.95, alternatives: [] };
  const env = { ENVIRONMENT: 'local', ANTHROPIC_API_KEY: 'test-not-a-real-key', LLM_FETCH: vi.fn(async () => Response.json({ usage: { input_tokens: 100, output_tokens: 100 }, content: [{ type: 'text', text: JSON.stringify(output) }], stop_reason: 'end_turn' })) };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const api = async (path, method = 'GET', body, headers) => {
    const response = await worker.fetch(new Request(`https://cronly.org${path}`, { method, headers: { Authorization: 'LocalDev a', ...headers }, body: body && JSON.stringify(body) }), env);
    return { status: response.status, ...await response.json() };
  };
  return { env, api, output: value => { output = value; } };
}
it('quotes without calling Claude, holds first, uses actual usage and regenerates cron explanation', async () => {
  const { api, env } = setup();
  const quote = await api('/api/prose/to-cron?dry_run=1', 'POST', { text: 'Weekdays at nine' });
  expect(quote.quote_microdollars).toBeGreaterThan(0); expect(env.LLM_FETCH).not.toHaveBeenCalled();
  expect((await api('/api/prose/to-cron', 'POST', { text: 'Weekdays at nine' })).status).toBe(402);
  await api('/api/dev/deposit', 'POST', { amount_microdollars: 5000000 });
  const result = await api('/api/prose/to-cron', 'POST', { text: 'Weekdays at nine' }, { 'Idempotency-Key': 'translation' });
  expect(result).toMatchObject({ status: 200, cron: '0 9 * * 1-5', token_cost_microdollars: 2400, cost_microdollars: 4436 });
  expect(result.explanation).toContain('09:00');
  await api('/api/prose/to-cron', 'POST', { text: 'Weekdays at nine' }, { 'Idempotency-Key': 'translation' }); expect(env.LLM_FETCH).toHaveBeenCalledTimes(1);
});
it('proposes without mutating and requires a separate application against an unchanged config', async () => {
  const { api, output } = setup(); await api('/api/dev/deposit', 'POST', { amount_microdollars: 5000000 });
  output({ explanation: 'Set greeting', operations: [{ kind: 'variables', name: 'greeting', delete: false, value_json: '{"value":"hello"}' }] });
  const proposal = await api('/api/prose/change', 'POST', { text: 'Set greeting to hello' });
  expect(proposal.status).toBe(200); expect((await api('/api/variables/greeting')).status).toBe(404);
  const applied = await api(`/api/changes/${encodeURIComponent(proposal.id)}/apply`, 'POST', {});
  expect(applied.cost_microdollars).toBe(100); expect((await api('/api/variables/greeting')).value).toBe('hello');
  const stale = await api('/api/prose/change', 'POST', { text: 'Set greeting again' });
  await api('/api/variables/other', 'PUT', { value: 'changed' });
  expect((await api(`/api/changes/${encodeURIComponent(stale.id)}/apply`, 'POST', {})).status).toBe(409);
});
