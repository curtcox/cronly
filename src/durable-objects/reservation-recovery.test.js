import { afterEach, expect, it, vi } from 'vitest';
import { AccountDO } from './account-do.js';
import { JobDO } from './job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { consume } from '../executor/consumer.js';
import { PRICES } from '../utils/pricing.js';

afterEach(() => vi.useRealTimers());

async function setup(failure, cap = PRICES.run + PRICES.hook) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const messages = [];
  const env = { ENVIRONMENT: 'local', RUN_QUEUE: { send: async body => messages.push(body) }, OUTBOUND_FETCH: vi.fn(async () => new Response('failed', { status: 500 })) };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 10000 });
  await account('mutate', { account: 'a', id: 'defs', operations: [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com', headers: { 'X-Event': '{{input.event}}' } } },
    { kind: 'jobs', name: 'j', value: { action: 'ping', cron: null, retries: 1 } }
  ] });
  await account('create-key', { id: 'k', hash: 'hash', request_hash: 'k', name: 'capped', scopes: ['run'], daily_spend_microdollars: cap, expires_at: Date.now() + 86400000 });
  await account('sync-jobs');
  const job = env.JOBS.get('a:j'); let fault;
  if (failure === 'response') {
    const object = env.ACCOUNTS.get('a'); const fetch = object.fetch.bind(object);
    fault = vi.spyOn(object, 'fetch').mockImplementation(async request => {
      const { op } = await request.clone().json(); const response = await fetch(request);
      if (op === 'prepare-run' && response.ok) throw new Error('reservation response lost');
      return response;
    });
  } else if (failure === 'alarm') {
    fault = vi.spyOn(job.storage, 'setAlarm').mockRejectedValue(new Error('alarm write failed'));
  } else {
    const put = job.storage.put.bind(job.storage);
    fault = vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
      if (key === 'history:r') throw new Error('pending write failed');
      return put(key, value);
    });
  }
  const args = { id: 'r', trigger: 'webhook', scheduled_at: new Date().toISOString(), input: { event: 'original' }, key_id: 'k' };
  await expect(rpc(env.JOBS, 'a:j', 'start', args)).rejects.toThrow();
  fault.mockRestore();
  expect(messages).toHaveLength(0); expect(await job.storage.get('history:r')).toBeUndefined();
  const hold = await env.ACCOUNTS.get('a').storage.get('hold:r');
  const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
  env.JOBS.objects.set('a:j', cold);
  return { env, account, messages, job: cold, hold, args };
}

for (const failure of ['response', 'pending', 'alarm']) {
  it(`recovers a reserved run after a lost ${failure} with its original deadline, input and key cap`, async () => {
    const { env, account, messages, hold, args } = await setup(failure);
    await vi.advanceTimersByTimeAsync(30000);
    const recovered = await rpc(env.JOBS, 'a:j', 'start', { ...args, trigger: 'manual', scheduled_at: new Date().toISOString(), input: { event: 'changed' }, key_id: undefined });
    expect(recovered.run).toMatchObject({ created_at: hold.created_at, expires_at: hold.expires_at, trigger: args.trigger, scheduled_at: args.scheduled_at, key_id: 'k' });
    expect(JSON.stringify(recovered)).not.toContain('original');
    expect((await account('account')).held_microdollars).toBe(hold.amount);
    await consume({ body: messages[0], ack() {} }, env, {});
    // The retry is refused by the original key's cap, even though the replay omitted it.
    expect(messages).toHaveLength(1); expect(env.OUTBOUND_FETCH).toHaveBeenCalledOnce();
    expect(env.OUTBOUND_FETCH.mock.calls[0][0].headers.get('X-Event')).toBe('original');
    expect((await account('account')).held_microdollars).toBe(0);
    const ledger = (await account('list', { prefix: 'ledger:' })).items;
    expect(ledger.filter(row => row.id === 'r')).toHaveLength(1);
  });

  it(`does not enqueue an expired reservation when recovering a lost ${failure}`, async () => {
    const { env, account, messages, job, args, hold } = await setup(failure);
    await vi.advanceTimersByTimeAsync(121000);
    await rpc(env.JOBS, 'a:j', 'start', args);
    expect(messages).toHaveLength(0); expect(env.OUTBOUND_FETCH).not.toHaveBeenCalled();
    expect(await rpc(env.JOBS, 'a:j', 'run', { id: 'r' })).toMatchObject({ status: 'expired', expires_at: hold.expires_at, cost_microdollars: hold.amount });
    expect((await account('account')).held_microdollars).toBe(0);
    await job.alarm();
    await rpc(env.JOBS, 'a:j', 'start', args);
    expect(messages).toHaveLength(0);
    expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.id === 'r')).toHaveLength(1);
  });

  it(`preserves private retry input after recovering a lost ${failure}`, async () => {
    const { env, account, messages, args } = await setup(failure, 1000);
    await rpc(env.JOBS, 'a:j', 'start', { ...args, input: { event: 'changed' } });
    await consume({ body: messages[0], ack() {} }, env, {});
    expect(messages).toHaveLength(2);
    const retry = await env.ACCOUNTS.get('a').storage.get('hold:r:retry');
    expect(retry.execution.input).toEqual(args.input); expect(retry.key_id).toBe('k');
    await consume({ body: messages[1], ack() {} }, env, {});
    expect(env.OUTBOUND_FETCH.mock.calls.map(([request]) => request.headers.get('X-Event'))).toEqual(['original', 'original']);
    expect(JSON.stringify(await rpc(env.JOBS, 'a:j', 'runs', { summary: true }))).not.toContain('original');
    for (const run of (await rpc(env.JOBS, 'a:j', 'runs')).items) {
      expect(run).not.toHaveProperty('input'); expect(run).not.toHaveProperty('retry');
    }
    expect((await account('account')).held_microdollars).toBe(0);
  });
}
