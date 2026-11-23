import { afterEach, expect, it, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { price } from '../utils/pricing.js';

afterEach(() => vi.useRealTimers());

const tool = (name, id = name) => ({ type: 'tool_use', name, id, input: {} });
const reply = content => Response.json({ usage: { input_tokens: 100, output_tokens: 100 }, content, stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn' });
const answer = citations => reply([{ type: 'text', text: JSON.stringify({ answer: 'Here is your account activity.', citations }) }]);

async function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const env = { ENVIRONMENT: 'local', ANTHROPIC_API_KEY: 'test-not-a-real-key', LLM_FETCH: vi.fn() };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 5000000 });
  await account('mutate', { id: 'defs', account: 'a', operations: [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com' } },
    ...['older', 'newer'].map(name => ({ kind: 'jobs', name, value: { action: 'ping', cron: null } }))
  ] });
  await account('sync-jobs');
  await env.ACCOUNTS.get('a').storage.put('recent-jobs', { items: [['older', null], ['newer', null]] });
  for (const name of ['older', 'newer']) for (let index = 0; index < 12; index++) {
    await env.JOBS.get(`a:${name}`).history({ id: `${name}-${String(index).padStart(2, '0')}`, job: name, status: 'success', created_at: Date.now() - (name === 'older' ? 60000 : 0) - index });
  }
  const request = async (path = '/api/prose/ask') => {
    const response = await worker.fetch(new Request(`https://cronly.org${path}`, {
      method: path.endsWith('/ask') ? 'POST' : 'GET', headers: { Authorization: 'LocalDev a', 'Idempotency-Key': 'ask' },
      ...(path.endsWith('/ask') ? { body: JSON.stringify({ text: 'What happened recently and what will it cost?' }) } : {})
    }), env);
    return { status: response.status, ...await response.json() };
  };
  return { env, account, request };
}

it('returns the newest ten runs across jobs and reuses that history through retention and repeated tools', async () => {
  const { env, account, request } = await setup();
  const reads = [...env.JOBS.objects.values()].map(job => vi.spyOn(job, 'fetch'));
  let first;
  env.LLM_FETCH.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    if (messages.length === 1) return reply([tool('recent_runs')]);
    const items = JSON.parse(messages.at(-1).content[0].content);
    expect(items.map(run => run.id)).toEqual(Array.from({ length: 10 }, (_, index) => `newer-${String(index).padStart(2, '0')}`));
    if (messages.length === 3) {
      first = items;
      // Retention/new deliveries can replace the live history during a provider call.
      const job = env.JOBS.get('a:newer');
      for (const run of items) await job.storage.delete(`history:${run.id}`);
      job.historyCache = null;
      return reply([tool('recent_runs', 'again')]);
    }
    expect(items).toEqual(first);
    return answer([items[0].id]);
  });
  expect(await request()).toMatchObject({ status: 200, citations: ['newer-00'], cost_microdollars: 12308 });
  for (const read of reads) expect(read).toHaveBeenCalledTimes(1);
  expect((await account('account')).held_microdollars).toBe(0);
});

it('includes permanent webhook activity in the same forecast as the projection API', async () => {
  const { env, account, request } = await setup();
  // Activity outlives retained logs, and must not be inferred from their sample.
  const state = await env.ACCOUNTS.get('a').storage.get('balance');
  state.summaries.day.run_count_by_job = { older: 14, newer: 7 };
  await env.ACCOUNTS.get('a').storage.put('balance', state);
  let expected;
  const dispatch = vi.spyOn(env.ACCOUNTS.get('a'), 'dispatch');
  env.LLM_FETCH.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    if (messages.length === 1) {
      const { status: _status, cost_microdollars: _cost, balance_microdollars: _balance, ...value } = await request('/api/projection');
      expected = value;
      // At noon the 30-day window includes two half UTC days. Each job's
      // estimated charge rounds up per day, including the webhook surcharge.
      const charge = price('hook', { type: 'http' });
      // 29 whole days plus two half days at 2 (older) and 1 (newer) webhook runs a day.
      const job = rate => 29 * Math.ceil(rate * charge) + 2 * Math.ceil(rate / 2 * charge);
      expect(expected.monthly_microdollars).toBe(job(2) + job(1));
      dispatch.mockClear();
      return reply([tool('projection'), tool('projection', 'repeat')]);
    }
    for (const result of messages.at(-1).content) expect(JSON.parse(result.content)).toEqual(expected);
    return answer(['older']);
  });
  expect((await request()).status).toBe(200);
  expect(dispatch.mock.calls.filter(([, args]) => args.op === 'activity')).toHaveLength(1);
  expect(dispatch.mock.calls.filter(([, args]) => args.op === 'read-plan')).toHaveLength(0);
  expect((await account('account')).held_microdollars).toBe(0);
});

it('rejects unknown citations even when the model did not request history', async () => {
  const { env, account, request } = await setup();
  const dispatch = vi.spyOn(env.ACCOUNTS.get('a'), 'dispatch');
  env.LLM_FETCH.mockImplementation(async () => answer(['missing-run']));
  expect(await request()).toMatchObject({ status: 502, code: 'invalid_citation', cost_microdollars: 4436 });
  expect(dispatch.mock.calls.filter(([, args]) => args.op === 'read-plan')).toHaveLength(1);
  expect((await account('account')).held_microdollars).toBe(0);
});
