import { afterEach, expect, it, vi } from 'vitest';
import { AccountDO } from './account-do.js';
import { JobDO } from './job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';

afterEach(() => vi.useRealTimers());

async function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const env = { ENVIRONMENT: 'local', RUN_QUEUE: { send: async () => {} } };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  const job = (op, args) => rpc(env.JOBS, 'a:j', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 10000 });
  await account('mutate', { account: 'a', id: 'defs', operations: [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com' } },
    { kind: 'jobs', name: 'j', value: { action: 'ping', cron: '0 * * * *' } }
  ] });
  await account('sync-jobs');
  await job('start', { id: 'run', input: {}, trigger: 'manual' });
  await job('result', { id: 'run', result: { status: 'success' } });
  return { env, account, job, object: env.JOBS.get('a:j') };
}

it('preserves completed outcomes through edits, deposits and cold configuration replay', async () => {
  const { env, account, job, object } = await setup();
  await account('mutate', { account: 'a', id: 'edit', operations: [{ kind: 'actions', name: 'ping', value: { url: 'https://example.com/edited' } }] });
  await account('sync-jobs');
  await account('deposit', { id: 'top-up', amount: 1000 }); await account('sync-jobs');
  env.JOBS.objects.set('a:j', new JobDO({ storage: object.storage, blockConcurrencyWhile: fn => fn() }, env));
  const settings = await job('status');
  const put = vi.spyOn(object.storage, 'put');
  const accountPut = vi.spyOn(env.ACCOUNTS.get('a').storage, 'put');
  await job('configure', { account: 'a', name: 'j', job: settings.job });
  expect(put).not.toHaveBeenCalled(); expect(accountPut).not.toHaveBeenCalled();
  expect(await job('status')).toMatchObject({ last_outcome: 'success', next_fire: settings.next_fire });
  expect((await account('account')).job_runtime.j.last_outcome).toBe('success');
});

it('publishes a resumed balance pause immediately and repairs publication on repeated wake', async () => {
  const { env, account, job, object } = await setup();
  const settings = { ...await job('status'), paused: 'insufficient_balance', resume_at: Date.now() + 86400000 };
  await object.storage.put('settings', settings); await object.publish(settings);
  const dispatch = env.ACCOUNTS.get('a').dispatch.bind(env.ACCOUNTS.get('a'));
  const fault = vi.spyOn(env.ACCOUNTS.get('a'), 'dispatch').mockImplementation(async (tx, args) => {
    if (args.op === 'job-runtime') throw new Error('publication unavailable');
    return dispatch(tx, args);
  });
  await expect(job('wake')).rejects.toMatchObject({ status: 500 }); fault.mockRestore();
  await job('wake');
  expect(await job('status')).toMatchObject({ paused: null, last_outcome: 'success' });
  expect(await job('status')).not.toHaveProperty('resume_at');
  expect((await account('account')).job_runtime.j).toMatchObject({ paused: null, last_outcome: 'success', next_fire: Date.parse('2026-11-16T13:00:00Z') });
});

it('keeps a pause durable if configuration lookup fails during a wake', async () => {
  const { env, job, object } = await setup();
  const settings = { ...await job('status'), paused: 'insufficient_balance' };
  await object.storage.put('settings', settings);
  const dispatch = env.ACCOUNTS.get('a').dispatch.bind(env.ACCOUNTS.get('a'));
  const fault = vi.spyOn(env.ACCOUNTS.get('a'), 'dispatch').mockImplementation(async (tx, args) => {
    if (args.op === 'config') throw new Error('configuration unavailable');
    return dispatch(tx, args);
  });
  await expect(job('wake')).rejects.toMatchObject({ status: 500 }); fault.mockRestore();
  expect(await job('status')).toEqual(settings);
  await job('wake'); expect((await job('status')).paused).toBe(null);
});

it('publishes analytics cost pauses and repairs publication without repeated writes', async () => {
  const { env, account, job, object } = await setup();
  env.SAFETY = { idFromName: id => id, get: () => ({ fetch: async () => Response.json({ brake: true }) }) };
  const settings = { ...await job('status'), paused: 'budget_day', resume_at: Date.now() + 60000 };
  await object.storage.put('settings', settings); await object.publish(settings);
  const before = await account('account');
  const fault = vi.spyOn(object, 'publish').mockRejectedValueOnce(new Error('publication unavailable'));
  await expect(job('start', { id: 'blocked', input: {}, trigger: 'manual' })).rejects.toMatchObject({ status: 500 });
  fault.mockRestore();
  env.JOBS.objects.set('a:j', new JobDO({ storage: object.storage, blockConcurrencyWhile: fn => fn() }, env));
  const put = vi.spyOn(object.storage, 'put');
  const alarm = vi.spyOn(object.storage, 'setAlarm');
  for (const id of ['blocked', 'again']) await expect(job('start', { id, input: {}, trigger: 'manual' })).rejects.toMatchObject({ status: 503, code: 'cost_brake' });
  expect(put).not.toHaveBeenCalled(); expect(alarm).not.toHaveBeenCalled();
  const paused = await job('status');
  expect(paused).toMatchObject({ paused: 'cost_brake', last_outcome: 'success' });
  expect(paused).not.toHaveProperty('resume_at');
  const after = await account('account');
  expect(after.job_runtime.j.paused).toBe('cost_brake');
  expect(after.balance_microdollars).toBe(before.balance_microdollars);
  expect(after.held_microdollars).toBe(0);
  expect((await job('runs')).items).toHaveLength(1);
});

it('keeps the operator hard stop stateless so removing it permits scheduled work', async () => {
  const { env, job, object } = await setup();
  env.COST_SAFETY_HARD_STOP = 'true';
  const before = await job('status');
  const put = vi.spyOn(object.storage, 'put');
  const send = vi.spyOn(env.RUN_QUEUE, 'send');
  await expect(job('start', { id: 'blocked', input: {}, trigger: 'schedule' })).rejects.toMatchObject({ status: 503, code: 'cost_brake' });
  expect(put).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(await job('status')).toEqual(before);
  env.COST_SAFETY_HARD_STOP = 'false';
  await vi.advanceTimersByTimeAsync(3600000); await object.alarm();
  expect(send).toHaveBeenCalledTimes(1);
  expect((await job('status')).paused).toBe(null);
});

for (const reason of ['insufficient_balance', 'cost_brake']) for (const failure of ['publication', 'settings', 'alarm']) {
  it(`recovers a ${reason} wake after failed ${failure} and a cold restart`, async () => {
    const { env, account, job, object } = await setup();
    const paused = { ...await job('status'), paused: reason };
    await object.storage.put('settings', paused); await object.publish(paused);
    await object.storage.deleteAlarm();
    const fault = failure === 'publication' ? vi.spyOn(object, 'publish').mockRejectedValueOnce(new Error('publication unavailable'))
      : failure === 'settings' ? vi.spyOn(object.storage, 'put').mockRejectedValueOnce(new Error('settings unavailable'))
        : vi.spyOn(object.storage, 'setAlarm').mockRejectedValueOnce(new Error('alarm unavailable'));
    await expect(job('wake', { reason })).rejects.toMatchObject({ status: 500 }); fault.mockRestore();
    if (failure !== 'alarm') expect(await job('status')).toEqual(paused);
    env.JOBS.objects.set('a:j', new JobDO({ storage: object.storage, blockConcurrencyWhile: fn => fn() }, env));
    await job('wake', { reason });
    expect(await job('status')).toMatchObject({ paused: null, last_outcome: 'success' });
    expect((await account('account')).job_runtime.j).toMatchObject({ paused: null, next_fire: Date.parse('2026-11-16T13:00:00Z') });
    // Retained logs can wake sooner, but the schedule must have a durable alarm.
    expect(await object.storage.getAlarm()).toBe(Date.parse('2026-11-16T13:00:00Z'));
    const put = vi.spyOn(object.storage, 'put'); const alarm = vi.spyOn(object.storage, 'setAlarm');
    await job('wake', { reason });
    expect(put).not.toHaveBeenCalled(); expect(alarm).not.toHaveBeenCalled();
  });
}

for (const paused of ['budget_day', 'budget_month', 'cost_brake', 'deleted']) {
  it(`preserves a ${paused} pause and its alarm on a balance wake`, async () => {
    const { job, object } = await setup();
    const settings = { ...await job('status'), paused, resume_at: Date.now() + 60000 };
    await object.storage.put('settings', settings); await object.publish(settings); await object.arm();
    const before = await object.storage.getAlarm();
    const put = vi.spyOn(object.storage, 'put'); const alarm = vi.spyOn(object.storage, 'setAlarm');
    await job('wake', { reason: 'insufficient_balance' });
    expect(await job('status')).toEqual(settings);
    expect(await object.storage.getAlarm()).toBe(before);
    expect(put).not.toHaveBeenCalled(); expect(alarm).not.toHaveBeenCalled();
  });
}

it('ignores property ordering in configuration replay while persisting real job changes', async () => {
  const { job, object } = await setup();
  const settings = await job('status');
  const reordered = Object.fromEntries(Object.entries(settings.job).reverse());
  const put = vi.spyOn(object.storage, 'put');
  await job('configure', { account: 'a', name: 'j', job: reordered });
  expect(put).not.toHaveBeenCalled();
  await job('configure', { account: 'a', name: 'j', job: { ...reordered, budget: { day: 100 } } });
  expect(put.mock.calls.filter(([key]) => key === 'settings')).toHaveLength(1);
  expect(await job('status')).toMatchObject({ job: { budget: { day: 100 } }, last_outcome: 'success' });
});
