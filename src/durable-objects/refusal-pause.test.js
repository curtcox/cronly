import { afterEach, expect, it, vi } from 'vitest';
import { AccountDO } from './account-do.js';
import { JobDO } from './job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';

afterEach(() => vi.useRealTimers());

async function setup(reason) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const env = { ENVIRONMENT: 'local', RUN_QUEUE: { send: vi.fn() } };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  const start = id => rpc(env.JOBS, 'a:j', 'start', { id, input: {}, trigger: 'manual' });
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 1000 });
  await account('mutate', { account: 'a', id: 'defs', operations: [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com' } },
    { kind: 'jobs', name: 'j', value: { action: 'ping', cron: '0 0 1 * *', budget: reason === 'budget_day' ? { day: 0 } : reason === 'budget_month' ? { month: 0 } : {} } }
  ] });
  await account('sync-jobs');
  const accountStorage = env.ACCOUNTS.get('a').storage;
  if (reason === 'insufficient_balance') {
    const state = await accountStorage.get('balance');
    await accountStorage.put('balance', { ...state, balance_microdollars: 0 });
  }
  return { env, account, start, object: env.JOBS.get('a:j'), accountStorage };
}

for (const reason of ['insufficient_balance', 'budget_day', 'budget_month']) {
  it(`keeps repeated ${reason} refusals write-free after restart, with one pause log`, async () => {
    const { env, account, start, object, accountStorage } = await setup(reason);
    await expect(start('first')).rejects.toMatchObject({ status: 402, code: reason });
    const alarm = await object.storage.getAlarm();
    const settings = await object.storage.get('settings');
    if (reason.startsWith('budget')) expect(alarm).toBe(settings.resume_at);
    env.JOBS.objects.set('a:j', new JobDO({ storage: object.storage, blockConcurrencyWhile: fn => fn() }, env));
    const jobPut = vi.spyOn(object.storage, 'put');
    const accountPut = vi.spyOn(accountStorage, 'put');
    const alarmPut = vi.spyOn(object.storage, 'setAlarm');
    for (let index = 0; index < 5; index++) {
      await vi.advanceTimersByTimeAsync(1000);
      await expect(start(`refused-${index}`)).rejects.toMatchObject({ status: 402, code: reason });
    }
    expect(jobPut).not.toHaveBeenCalled(); expect(accountPut).not.toHaveBeenCalled(); expect(alarmPut).not.toHaveBeenCalled();
    expect(await object.storage.getAlarm()).toBe(alarm);
    const runs = await rpc(env.JOBS, 'a:j', 'runs');
    expect(runs.items).toHaveLength(1); expect(runs.items[0]).toMatchObject({ id: 'first', status: 'paused', reason, cost_microdollars: 0 });
    expect((await account('account')).held_microdollars).toBe(0);
    expect(env.RUN_QUEUE.send).not.toHaveBeenCalled();
  });
}

for (const failure of ['settings', 'history:first', 'alarm']) {
  it(`rolls back a pause, log and budget wakeup together after a failed ${failure} write`, async () => {
    const { start, object } = await setup('budget_day');
    await object.storage.deleteAlarm();
    const before = structuredClone(object.storage.rows);
    const put = object.storage.put.bind(object.storage);
    const fault = failure === 'alarm' ? vi.spyOn(object.storage, 'setAlarm').mockRejectedValue(new Error('alarm unavailable')) : vi.spyOn(object.storage, 'put').mockImplementation(async (key, value) => {
      if (key === failure) throw new Error('storage unavailable');
      return put(key, value);
    });
    await expect(start('first')).rejects.toMatchObject({ status: 500 }); fault.mockRestore();
    expect(object.storage.rows).toEqual(before); expect(await object.storage.getAlarm()).toBe(null);
    expect(await object.summaries()).toEqual([]);
    await expect(start('first')).rejects.toMatchObject({ code: 'budget_day' });
    expect(await object.storage.get('history:first')).toMatchObject({ status: 'paused', reason: 'budget_day' });
    expect(await object.storage.getAlarm()).toBe(Date.parse('2026-11-17T00:00:00Z'));
  });
}

it('repairs failed pause publication on another refusal without another pause log', async () => {
  const { env, account, start, object } = await setup('budget_day');
  const accountObject = env.ACCOUNTS.get('a'); const dispatch = accountObject.dispatch.bind(accountObject);
  const fault = vi.spyOn(accountObject, 'dispatch').mockImplementation(async (tx, args) => {
    if (args.op === 'job-runtime') throw new Error('publication unavailable');
    return dispatch(tx, args);
  });
  await expect(start('first')).rejects.toMatchObject({ status: 500 }); fault.mockRestore();
  await expect(start('again')).rejects.toMatchObject({ code: 'budget_day' });
  expect((await account('account')).job_runtime.j.paused).toBe('budget_day');
  expect((await object.summaries()).map(run => run.id)).toEqual(['first']);
});

it('records a new pause reason and resumes at the next budget window', async () => {
  const { env, account, start, object, accountStorage } = await setup('budget_day');
  const state = await accountStorage.get('balance');
  await accountStorage.put('balance', { ...state, balance_microdollars: 0 });
  await expect(start('no-balance')).rejects.toMatchObject({ code: 'insufficient_balance' });
  await account('deposit', { id: 'top-up', amount: 1000 });
  await expect(start('no-budget')).rejects.toMatchObject({ code: 'budget_day' });
  expect((await object.summaries()).map(run => run.reason).sort()).toEqual(['budget_day', 'insufficient_balance']);
  vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
  await object.alarm();
  expect(await object.storage.get('settings')).toMatchObject({ paused: null, resume_at: null });
  expect((await account('account')).job_runtime.j.paused).toBe(null);
  // The new window permits a fresh pause transition if its budget is still zero.
  await expect(start('next-day')).rejects.toMatchObject({ code: 'budget_day' });
  expect(await object.summaries()).toHaveLength(3);
  expect(await object.storage.getAlarm()).toBe(Date.parse('2026-11-18T00:00:00Z'));
  expect(env.RUN_QUEUE.send).not.toHaveBeenCalled();
});

for (const failure of ['publication', 'settings']) {
  it(`retries a budget reset after failed ${failure} without stranding the pause`, async () => {
    const { env, account, start, object } = await setup('budget_day');
    await expect(start('first')).rejects.toMatchObject({ code: 'budget_day' });
    const deadline = (await object.storage.get('settings')).resume_at;
    vi.setSystemTime(deadline);
    const fault = failure === 'publication' ? vi.spyOn(object, 'publish').mockRejectedValue(new Error('publication unavailable')) : vi.spyOn(object.storage, 'put').mockRejectedValue(new Error('storage unavailable'));
    await expect(object.alarm()).rejects.toThrow(); fault.mockRestore();
    expect(await object.storage.get('settings')).toMatchObject({ paused: 'budget_day', resume_at: deadline });
    const cold = new JobDO({ storage: object.storage, blockConcurrencyWhile: fn => fn() }, env);
    env.JOBS.objects.set('a:j', cold); await cold.alarm();
    expect(await object.storage.get('settings')).toMatchObject({ paused: null, resume_at: null });
    expect((await account('account')).job_runtime.j.paused).toBe(null);
    expect(await cold.summaries()).toHaveLength(1);
  });
}
