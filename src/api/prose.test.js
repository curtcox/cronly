import { it, expect, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
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
it('refuses unconfigured prose before billing while free deterministic cron remains available', async () => {
  const { api, env } = setup(); delete env.ANTHROPIC_API_KEY;
  await api('/api/dev/deposit', 'POST', { amount_microdollars: 5000000 });
  const before = await api('/api/account');
  for (const mode of ['to-cron', 'ask', 'change']) {
    expect(await api(`/api/prose/${mode}`, 'POST', { text: 'Weekdays at nine' }))
      .toMatchObject({ status: 503, code: 'prose_unavailable', cost_microdollars: 0 });
  }
  expect(await api('/api/account')).toEqual(before);
  expect(env.LLM_FETCH).not.toHaveBeenCalled();
  expect(await api('/api/cron/explain', 'POST', { cron: '0 9 * * 1-5', timezone: 'UTC' }))
    .toMatchObject({ status: 200, cost_microdollars: 0 });
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

it('returns normalized before/after changes from the reserved snapshot and replays the original diff', async () => {
  const { api, env, output } = setup();
  await api('/api/dev/deposit', 'POST', { amount_microdollars: 5000000 });
  await api('/api/variables/constructor', 'PUT', { value: 'original' });
  await api('/api/variables/remove', 'PUT', { value: 'obsolete' });
  output({ explanation: 'Review these changes', operations: [
    { kind: 'variables', name: 'constructor', delete: false, value_json: '{"value":"updated"}' },
    { kind: 'variables', name: 'remove', delete: true, value_json: '{}' },
    { kind: 'actions', name: 'ping', delete: false, value_json: '{"url":"https://example.com"}' },
    { kind: 'jobs', name: 'pinger', delete: false, value_json: '{"action":"ping","cron":null}' },
    { kind: 'variables', name: 'constructor', delete: false, value_json: '{"value":"final"}' }
  ] });
  const headers = { 'Idempotency-Key': 'diff' };
  const proposal = await api('/api/prose/change', 'POST', { text: 'Update my definitions' }, headers);
  expect(proposal).toMatchObject({ status: 200, quote_microdollars: 500, diff: [
    { kind: 'variables', name: 'constructor', operation: 'update', before: 'original', after: 'updated' },
    { kind: 'variables', name: 'remove', operation: 'delete', before: 'obsolete', after: null },
    { kind: 'actions', name: 'ping', operation: 'create', before: null, after: { type: 'http', method: 'GET', timeout_seconds: 10, body: '', url: 'https://example.com' } },
    { kind: 'jobs', name: 'pinger', operation: 'create', before: null, after: { action: 'ping', cron: null, enabled: true, timezone: 'UTC', retries: 0 } },
    { kind: 'variables', name: 'constructor', operation: 'update', before: 'updated', after: 'final' }
  ] });
  expect((await api('/api/variables/constructor')).value).toBe('original');
  expect((await api('/api/variables/remove')).value).toBe('obsolete');
  expect((await api('/api/actions/ping')).status).toBe(404);
  await api('/api/variables/constructor', 'PUT', { value: 'edited later' });
  const replay = await api('/api/prose/change', 'POST', { text: 'Update my definitions' }, headers);
  expect(replay).toMatchObject({ id: proposal.id, diff: proposal.diff, quote_microdollars: proposal.quote_microdollars, cost_microdollars: proposal.cost_microdollars });
  expect(env.LLM_FETCH).toHaveBeenCalledTimes(1);
  expect((await api(`/api/changes/${encodeURIComponent(proposal.id)}/apply`, 'POST', { quote_microdollars: 500 })).code).toBe('stale_proposal');
});

it('keeps proposal review values tied to the snapshot when definitions change during generation', async () => {
  const { api, env, output } = setup();
  await api('/api/dev/deposit', 'POST', { amount_microdollars: 5000000 });
  await api('/api/variables/greeting', 'PUT', { value: 'snapshot value' });
  output({ explanation: 'Update greeting', operations: [{ kind: 'variables', name: 'greeting', delete: false, value_json: '{"value":"proposed"}' }] });
  const fetchModel = env.LLM_FETCH.getMockImplementation();
  env.LLM_FETCH.mockImplementation(async (...args) => {
    await api('/api/variables/greeting', 'PUT', { value: 'concurrent edit' });
    return fetchModel(...args);
  });
  const proposal = await api('/api/prose/change', 'POST', { text: 'Update greeting' });
  expect(proposal).toMatchObject({ status: 200, diff: [{ kind: 'variables', name: 'greeting', before: 'snapshot value', after: 'proposed' }] });
  expect((await api('/api/variables/greeting')).value).toBe('concurrent edit');
  expect((await api(`/api/changes/${encodeURIComponent(proposal.id)}/apply`, 'POST', {})).code).toBe('stale_proposal');
});

it('refuses invalid translation time zones before billing, including previews and unfunded accounts', async () => {
  const { api, env } = setup();
  const headers = { 'Idempotency-Key': 'translation-timezone' };
  for (const funded of [false, true]) {
    if (funded) await api('/api/dev/deposit', 'POST', { amount_microdollars: 5000000 });
    const before = await api('/api/account');
    for (const timezone of ['bad/zone', '+01:00', '', null, false, 0, [], {}]) {
      for (const suffix of ['', '?dry_run=1']) {
        expect(await api(`/api/prose/to-cron${suffix}`, 'POST', { text: 'Weekdays at nine', timezone }, headers))
          .toMatchObject({ status: 400, code: 'invalid_cron', cost_microdollars: 0 });
      }
    }
    expect(await api('/api/account')).toEqual(before);
  }
  expect(env.LLM_FETCH).not.toHaveBeenCalled();
  expect(await rpc(env.ACCOUNTS, 'a', 'get', { key: 'prose:prose:session:translation-timezone' })).toEqual({});
  // Validation does not consume the key: correcting the zone can still proceed.
  expect(await api('/api/prose/to-cron', 'POST', { text: 'Weekdays at nine', timezone: 'America/Chicago' }, headers))
    .toMatchObject({ status: 200, timezone: 'America/Chicago', cost_microdollars: 4436 });
  const input = JSON.parse(JSON.parse(env.LLM_FETCH.mock.calls[0][1].body).messages[0].content);
  expect(input.timezone).toBe('America/Chicago');
  expect(env.LLM_FETCH).toHaveBeenCalledTimes(1);
});

it('defaults an omitted translation time zone to UTC for quotes and paid results', async () => {
  const { api, env } = setup();
  expect(await api('/api/prose/to-cron?dry_run=1', 'POST', { text: 'Weekdays at nine' }))
    .toMatchObject({ status: 200, cost_microdollars: 0 });
  expect(env.LLM_FETCH).not.toHaveBeenCalled();
  await api('/api/dev/deposit', 'POST', { amount_microdollars: 5000000 });
  expect(await api('/api/prose/to-cron', 'POST', { text: 'Weekdays at nine' }))
    .toMatchObject({ status: 200, timezone: 'UTC', cost_microdollars: 4436 });
});
