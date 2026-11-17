import { afterEach, expect, it, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { proseQuote } from '../services/llm.js';

afterEach(() => vi.useRealTimers());

async function setup(mode, failed = false) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const output = {
    'to-cron': { cron: '0 9 * * 1-5', confidence: 0.95, alternatives: [] },
    ask: { answer: 'No jobs are configured.', citations: [] },
    change: { explanation: 'Set greeting', operations: [{ kind: 'variables', name: 'greeting', delete: false, value_json: '{"value":"hello"}' }] }
  }[mode];
  const env = { ENVIRONMENT: 'local', ANTHROPIC_API_KEY: 'test-not-a-real-key', LLM_FETCH: vi.fn(async () => Response.json({
    usage: { input_tokens: 100, output_tokens: 100 }, content: [{ type: 'text', text: failed ? 'invalid json' : JSON.stringify(output) }], stop_reason: 'end_turn'
  })) };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 5000000 });
  const id = 'prose:session:recover';
  const api = async () => {
    const response = await worker.fetch(new Request(`https://cronly.org/api/prose/${mode}`, {
      method: 'POST', headers: { Authorization: 'LocalDev a', 'Idempotency-Key': 'recover' }, body: JSON.stringify({ text: 'Help with my schedule' })
    }), env);
    return { status: response.status, ...await response.json() };
  };
  const cold = () => { const storage = env.ACCOUNTS.get('a').storage; env.ACCOUNTS.objects.set('a', new AccountDO({ storage }, env)); };
  return { env, account, api, cold, id };
}

for (const mode of ['to-cron', 'ask', 'change']) for (const failed of [false, true]) {
  it(`recovers a committed ${mode} ${failed ? 'failure' : 'success'} after a lost finalization response`, async () => {
    const { env, account, api, cold, id } = await setup(mode, failed);
    const object = env.ACCOUNTS.get('a'); const fetch = object.fetch.bind(object); let finishes = 0;
    const finish = vi.spyOn(object, 'fetch').mockImplementation(async request => {
      const { op } = await request.clone().json(); const response = await fetch(request);
      if (op === 'finish-prose' && response.ok) { finishes++; throw new Error('finalization response lost'); }
      return response;
    });
    expect((await api()).status).toBe(500);
    expect(finishes).toBe(1);
    const saved = await account('get', { key: `prose:${id}` });
    expect(Boolean(saved.response.failed)).toBe(failed);
    if (!failed) expect(saved.response).toMatchObject(mode === 'change' ? { operations: expect.any(Array) } : mode === 'ask' ? { answer: expect.any(String) } : { cron: '0 9 * * 1-5' });
    const balance = await account('account');
    finish.mockRestore(); cold();
    const recovered = await api();
    expect(recovered).toMatchObject({ status: failed ? 502 : 200, cost_microdollars: 4436 });
    expect(env.LLM_FETCH).toHaveBeenCalledTimes(1);
    expect(await account('account')).toMatchObject({ balance_microdollars: balance.balance_microdollars, held_microdollars: 0 });
    expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.id === id)).toHaveLength(1);
    if (mode === 'change') expect((await account('config')).variables).toEqual({});
    // A contradictory late completion cannot rewrite the original response.
    expect(await account('finish-prose', { id, actual: proseQuote(mode), response: { failed: !failed } })).toEqual(saved.response);
  });
}

it('reports the settled charge when the hold expired before prose finalization', async () => {
  const { env, account, api, cold, id } = await setup('to-cron');
  const provider = env.LLM_FETCH.getMockImplementation();
  env.LLM_FETCH.mockImplementation(async (...args) => {
    vi.advanceTimersByTime(240001);
    await env.ACCOUNTS.get('a').alarm();
    return provider(...args);
  });
  const result = await api();
  expect(result).toMatchObject({ status: 200, cost_microdollars: proseQuote('to-cron') });
  const receipt = await account('get', { key: `receipt:${id}` });
  expect(result.cost_microdollars).toBe(receipt.charged);
  cold(); expect((await api()).cost_microdollars).toBe(receipt.charged);
  expect(env.LLM_FETCH).toHaveBeenCalledTimes(1);
});

it('rolls back settlement and response together if the final response cannot persist', async () => {
  const { env, account, api, id } = await setup('to-cron');
  const storage = env.ACCOUNTS.get('a').storage; const put = storage.put.bind(storage);
  const fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
    if (key === `prose:${id}` && value.response) throw new Error('response unavailable');
    return put(key, value);
  });
  expect((await api()).status).toBe(500); fault.mockRestore();
  expect(await account('account')).toMatchObject({ balance_microdollars: 5000000, held_microdollars: proseQuote('to-cron') });
  expect(await storage.get(`receipt:${id}`)).toBeUndefined();
  expect((await api()).status).toBe(409);
  expect(env.LLM_FETCH).toHaveBeenCalledTimes(1);
});
