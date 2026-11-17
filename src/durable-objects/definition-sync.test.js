import { afterEach, expect, it, vi } from 'vitest';
import { AccountDO } from './account-do.js';
import { JobDO } from './job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { PRICES, price } from '../utils/pricing.js';
import { COST_POLICY, worstCaseCost } from '../utils/cost-policy.js';
import { getHold } from './hold-storage.js';

afterEach(() => vi.useRealTimers());

async function setup(count = 3) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const messages = [];
  const env = { ENVIRONMENT: 'local', RUN_QUEUE: { send: async body => messages.push(body) } };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  const mutate = (id, operations, extra = {}) => account('mutate', { account: 'a', id, operations, ...extra });
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 100000 });
  const storage = env.ACCOUNTS.get('a').storage;
  await storage.put('profile', { id: 'a', created_at: Date.now() - 8 * 86400000 });
  await mutate('defs', [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com/original' } },
    ...Array.from({ length: count }, (_, index) => ({ kind: 'jobs', name: `j-${index}`, value: { action: 'ping', cron: '* * * * *', budget: index === 2 ? { day: PRICES.run } : {} } }))
  ]);
  await account('sync-jobs');
  return { env, account, mutate, storage, messages };
}

for (const operation of ['create', 'update', 'delete']) {
  it(`keeps a single action ${operation} within its change allowance with 100 jobs`, async () => {
    const { env, account, mutate, storage } = await setup(100);
    if (operation === 'delete') await mutate('unused', [{ kind: 'actions', name: 'unused', value: { url: 'https://example.com' } }]);
    await account('sync-jobs');
    const jobs = structuredClone([...env.JOBS.objects].map(([name, job]) => [name, job.storage.rows, job.storage.alarm]));
    const put = vi.spyOn(storage, 'put'); const remove = vi.spyOn(storage, 'delete'); const alarm = vi.spyOn(storage, 'setAlarm');
    const configure = [...env.JOBS.objects.values()].map(job => vi.spyOn(job, 'fetch'));
    const result = await mutate('action', [{ kind: 'actions', name: operation === 'update' ? 'ping' : 'unused', ...(operation === 'delete' ? { delete: true } : { value: { url: 'https://example.com/edited' } }) }]);
    await account('sync-jobs');
    expect(result).toMatchObject({ cost_microdollars: PRICES.change });
    expect(put.mock.calls.some(([key]) => key.startsWith('def:jobs:') || key.startsWith('sync:'))).toBe(false);
    expect(configure.every(fetch => fetch.mock.calls.length === 0)).toBe(true);
    expect([...env.JOBS.objects].map(([name, job]) => [name, job.storage.rows, job.storage.alarm])).toEqual(jobs);
    // Count all mutation/outbox writes, not just the rows left after commit.
    const writes = put.mock.calls.length + remove.mock.calls.length + alarm.mock.calls.length;
    expect(writes).toBeLessThanOrEqual(worstCaseCost('change'));
    expect(result.cost_microdollars * COST_POLICY.revenueKept).toBeGreaterThanOrEqual(writes * COST_POLICY.minimumMargin);
    expect(await storage.list({ prefix: 'sync:' })).toHaveLength(0);
  });
}

it('uses edited action prices and limits for new runs while preserving prepaid snapshots and job pauses', async () => {
  const { env, account, mutate, storage, messages } = await setup();
  const start = (name, id) => rpc(env.JOBS, `a:${name}`, 'start', { id, input: {}, trigger: 'manual' });
  await start('j-0', 'old');
  // A pause and its reset deadline must survive an unrelated action edit.
  const pausedJob = env.JOBS.get('a:j-2');
  await pausedJob.result({ id: (await start('j-2', 'budget')).run.id, result: { status: 'success' } });
  vi.advanceTimersByTime(60000);
  await expect(start('j-2', 'refused')).rejects.toMatchObject({ code: 'budget_day' });
  const paused = await pausedJob.storage.get('settings'); const wake = await pausedJob.storage.getAlarm();
  const edited = { type: 'javascript', source: 'export default () => 2', cpu_ms: 1000, subrequests: 3 };
  await mutate('edit', [{ kind: 'actions', name: 'ping', value: edited }]);
  await account('sync-jobs');
  expect(await pausedJob.storage.get('settings')).toEqual(paused);
  expect(await pausedJob.storage.getAlarm()).toBe(wake);
  const cold = env.JOBS.get('a:j-1');
  env.JOBS.objects.set('a:j-1', new JobDO({ storage: cold.storage, blockConcurrencyWhile: fn => fn() }, env));
  expect((await account('config')).jobs['j-1'].max_run_microdollars).toBe(price('run', edited));
  expect(await start('j-1', 'new')).toMatchObject({ reserved_microdollars: price('run', edited) });
  expect(await account('claim-run', { id: 'old' })).toMatchObject({ action: { type: 'http', url: 'https://example.com/original' }, amount: PRICES.run });
  expect(await account('claim-run', { id: 'new' })).toMatchObject({ action: edited, amount: price('run', edited) });
  expect((await getHold(storage, 'old')).execution.action.type).toBe('http');
  await expect(start('j-2', 'new-budget')).rejects.toMatchObject({ code: 'budget_day' });
  expect(messages).toHaveLength(3);
});

it('keeps explicit job edits and deletions in the durable outbox in a mixed action batch', async () => {
  const { env, account, mutate, storage } = await setup();
  const untouched = structuredClone(env.JOBS.get('a:j-2').storage.rows);
  await mutate('batch', [
    { kind: 'actions', name: 'replacement', value: { url: 'https://example.com/new' } },
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com/edited' } },
    { kind: 'jobs', name: 'j-0', value: { action: 'replacement', cron: '0 * * * *', budget: { day: 500 } } },
    { kind: 'jobs', name: 'j-1', delete: true }
  ]);
  expect([...(await storage.list({ prefix: 'sync:' })).keys()]).toEqual(['sync:j-0', 'sync:j-1']);
  const object = env.ACCOUNTS.get('a');
  env.ACCOUNTS.objects.set('a', new AccountDO({ storage: object.storage }, env));
  await account('sync-jobs');
  expect(await env.JOBS.get('a:j-0').storage.get('settings')).toMatchObject({ job: { action: 'replacement', cron: '0 * * * *', budget: { day: 500 } } });
  expect(await env.JOBS.get('a:j-1').storage.get('settings')).toMatchObject({ job: null, next_fire: null });
  expect(env.JOBS.get('a:j-2').storage.rows).toEqual(untouched);
});
