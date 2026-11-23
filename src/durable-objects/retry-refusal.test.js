import { afterEach, expect, it, vi } from 'vitest';
import { AccountDO } from './account-do.js';
import { JobDO } from './job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { consume } from '../executor/consumer.js';
import { PRICES } from '../utils/pricing.js';

afterEach(() => vi.useRealTimers());

async function setup(holdMode) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const messages = [];
  const env = { ENVIRONMENT: 'local', RUN_QUEUE: { send: async body => messages.push(body) }, OUTBOUND_FETCH: vi.fn(async () => new Response('failed', { status: 500 })) };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 10000 });
  await account('mutate', { account: 'a', id: 'defs', operations: [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com', ...(holdMode === 'standalone' ? { method: 'POST', body: 'x'.repeat(9000) } : {}) } },
    { kind: 'jobs', name: 'j', value: { action: 'ping', cron: '0 0 1 * *', retries: 1 } }
  ] });
  await account('create-key', { id: 'k', hash: 'hash', request_hash: 'k', name: 'runner', scopes: ['run'], daily_spend_microdollars: 1000, expires_at: Date.now() + 1000 });
  await account('sync-jobs');
  await rpc(env.JOBS, 'a:j', 'start', { id: 'parent', input: { event: 'private-retry-input' }, key_id: 'k', trigger: 'manual' });
  return { env, account, messages, job: env.JOBS.get('a:j') };
}

for (const holdMode of ['compact', 'standalone']) for (const refusal of ['revoked', 'expired', 'missing_input']) for (const failure of ['none', 'cleanup']) {
  it(`ends a ${refusal} retry (${holdMode}, ${failure}) without recurring work, another charge or a job pause`, async () => {
    const { env, account, messages, job } = await setup(holdMode);
    const nextFire = (await job.storage.get('settings')).next_fire;
    if (refusal === 'revoked') await account('revoke-key', { id: 'k' });
    else if (refusal === 'expired') vi.setSystemTime(Date.now() + 1000);
    else await account('mutate', { account: 'a', id: 'new-input', operations: [
      { kind: 'actions', name: 'ping', value: { url: 'https://example.com/{{input.missing}}' } }
    ] });
    const before = await account('account');
    const put = job.storage.put.bind(job.storage);
    const fault = failure === 'cleanup' ? vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
      if (key === 'history:parent' && value.status === 'failure' && !value.retry) throw new Error('cleanup unavailable');
      return put(key, value);
    }) : null;
    const ack = vi.fn(); const message = { body: messages[0], ack };
    if (fault) {
      await expect(consume(message, env, {})).rejects.toMatchObject({ status: 500 });
      expect(ack).not.toHaveBeenCalled();
      expect((await job.storage.get('history:parent')).retry).toMatchObject({ dispatch: true, input: { event: 'private-retry-input' } });
      fault.mockRestore();
    } else await consume(message, env, {});
    const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
    env.JOBS.objects.set('a:j', cold);
    await consume(message, env, {});
    expect(ack).toHaveBeenCalledTimes(failure === 'cleanup' ? 1 : 2);
    expect(messages).toHaveLength(1); expect(env.OUTBOUND_FETCH).toHaveBeenCalledOnce();
    expect(await account('account')).toMatchObject({ balance_microdollars: before.balance_microdollars - PRICES.run, held_microdollars: 0 });
    expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.kind === 'run')).toHaveLength(1);
    expect((await job.storage.get('history:parent')).retry).toBeUndefined();
    expect(await cold.dispatch({ op: 'runs' })).toMatchObject({ items: [{ id: 'parent', status: 'failure', cost_microdollars: PRICES.run }] });
    expect(JSON.stringify(await cold.dispatch({ op: 'runs', summary: true }))).not.toContain('private-retry-input');
    // A cleanup outage can leave the original funded expiry alarm in place.
    // Once delivered, it must retain only the normal schedule/retention wakeup.
    vi.setSystemTime(Date.now() + 121000); await cold.alarm();
    expect(await cold.storage.get('settings')).toMatchObject({ paused: null, next_fire: nextFire });
    expect(await cold.storage.getAlarm()).toBe(nextFire);
    const writes = vi.spyOn(cold.storage, 'put');
    await consume(message, env, {});
    expect(writes).not.toHaveBeenCalled(); expect(messages).toHaveLength(1);
  });
}

it('pauses a budget-refused retry with one rearm, leaving the resumption wakeup', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const messages = [];
  const env = { ENVIRONMENT: 'local', RUN_QUEUE: { send: async body => messages.push(body) }, OUTBOUND_FETCH: vi.fn(async () => new Response('failed', { status: 500 })) };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 10000 });
  await account('mutate', { account: 'a', id: 'defs', operations: [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com' } },
    { kind: 'jobs', name: 'j', value: { action: 'ping', cron: '0 0 1 * *', retries: 1, budget: { day: PRICES.run } } }
  ] });
  await account('sync-jobs');
  await rpc(env.JOBS, 'a:j', 'start', { id: 'parent', input: {}, trigger: 'manual' });
  const job = env.JOBS.get('a:j'); const alarms = vi.spyOn(job.storage, 'setAlarm');
  await consume({ body: messages[0], ack() {} }, env, {});
  // S4: the pause commits its wakeup; completion arms once instead of also rearming inside start().
  const tomorrow = Date.parse('2026-11-17T00:00:00Z');
  expect(alarms.mock.calls.map(([time]) => time)).toEqual([tomorrow]);
  expect(await job.storage.getAlarm()).toBe(tomorrow);
  expect(await job.storage.get('settings')).toMatchObject({ paused: 'budget_day', resume_at: tomorrow });
  expect((await job.storage.get('history:parent')).retry).toBeUndefined();
  expect(messages).toHaveLength(1);
});
