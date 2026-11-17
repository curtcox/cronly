import { afterEach, expect, it, vi } from 'vitest';
import { AccountDO } from './account-do.js';
import { JobDO } from './job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';

afterEach(() => vi.useRealTimers());

async function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const env = { ENVIRONMENT: 'local' };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' });
  await account('deposit', { id: 'fund', amount: 10000 });
  await account('mutate', { account: 'a', id: 'defs', operations: [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com' } },
    { kind: 'jobs', name: 'j', value: { action: 'ping', cron: '0 * * * *' } }
  ] });
  const storage = env.ACCOUNTS.get('a').storage;
  const cold = () => {
    const object = new AccountDO({ storage }, env);
    env.ACCOUNTS.objects.set('a', object); return object;
  };
  const deliver = async () => { await storage.deleteAlarm(); await cold().alarm(); };
  return { env, account, storage, deliver };
}

for (const recovery of ['configure', 'wake']) for (const arriving of [false, true]) for (const ttl of [10000, 120000]) {
  it(`preserves the earliest wakeup when ${recovery} fails with ${arriving ? 'a newly arriving' : 'an existing'} ${ttl}ms hold`, async () => {
    const { env, account, storage, deliver } = await setup();
    if (recovery === 'wake') { await account('sync-jobs'); await account('resume-cost-jobs'); }
    const pendingKey = recovery === 'wake' ? 'wake:cost_brake' : 'sync:j';
    const start = Date.now();
    const reserve = () => account('reserve', { id: 'held', amount: 50, kind: 'run', ttl_ms: ttl });
    if (!arriving) await reserve();
    const fault = vi.spyOn(env.JOBS.get('a:j'), 'fetch').mockImplementation(async () => {
      if (arriving) await reserve();
      throw new Error('synchronization unavailable');
    });
    await deliver();
    expect(await storage.getAlarm()).toBe(start + Math.min(ttl, 60000));
    expect(await storage.get(pendingKey)).toBeDefined();
    expect(await account('account')).toMatchObject({ balance_microdollars: 9800, held_microdollars: 50 });
    fault.mockRestore();
    vi.setSystemTime(await storage.getAlarm()); await deliver();
    expect(await storage.get(pendingKey)).toBeUndefined();
    expect((await env.JOBS.get('a:j').storage.get('settings')).job.action).toBe('ping');
    if (ttl > 60000) {
      expect(await storage.getAlarm()).toBe(start + ttl);
      expect((await account('account')).held_microdollars).toBe(50);
      vi.setSystemTime(start + ttl); await deliver();
    }
    expect(await account('account')).toMatchObject({ balance_microdollars: 9750, held_microdollars: 0 });
    expect(await storage.get('receipt:held')).toMatchObject({ settled: true, charged: 50 });
    await deliver();
    expect((await account('account')).balance_microdollars).toBe(9750);
  });
}

for (const op of ['deposit', 'dev-deposit', 'resume-cost-jobs']) for (const deadline of [null, 500, 60000]) {
  it(`coalesces ${op} with ${deadline === null ? 'an absent wakeup' : `a ${deadline}ms wakeup`} and recovers after restart`, async () => {
    const { account, storage, deliver } = await setup();
    if (deadline === null) await storage.deleteAlarm();
    else await storage.setAlarm(Date.now() + deadline);
    const alarm = vi.spyOn(storage, 'setAlarm');
    const args = op === 'resume-cost-jobs' ? {} : { id: 'top-up', amount: 1000 };
    await account(op, args);
    expect(await storage.getAlarm()).toBe(Date.now() + Math.min(deadline ?? Infinity, 1000));
    expect(alarm).toHaveBeenCalledTimes(deadline === 500 ? 0 : 1);
    const wakeKey = `wake:${op === 'resume-cost-jobs' ? 'cost_brake' : 'insufficient_balance'}`;
    expect(await storage.get(wakeKey)).toMatchObject({ account: 'a', names: ['j'] });
    // A wakeup does not supersede an outstanding definition edit.
    expect(await storage.get('sync:j')).toBeDefined();
    if (op !== 'resume-cost-jobs') {
      await account(op, args);
      expect(alarm).toHaveBeenCalledTimes(deadline === 500 ? 0 : 1);
    }
    vi.setSystemTime(await storage.getAlarm()); await deliver();
    expect(await storage.get('sync:j')).toBeUndefined();
    expect(await storage.list({ prefix: 'wake:' })).toHaveLength(0);
    expect((await account('account')).balance_microdollars).toBe(op === 'resume-cost-jobs' ? 9800 : 10800);
    expect((await account('account')).job_runtime.j).toMatchObject({ paused: null, next_fire: Date.parse('2026-11-16T13:00:00Z') });
  });
}

for (const op of ['deposit', 'dev-deposit', 'resume-cost-jobs']) {
  it(`does not wake an account without scheduling work for ${op}`, async () => {
    const { account, storage } = await setup();
    await account('sync-jobs');
    await account('mutate', { account: 'a', id: 'delete', operations: [{ kind: 'jobs', name: 'j', delete: true }] });
    await account('sync-jobs'); await storage.deleteAlarm();
    const alarm = vi.spyOn(storage, 'setAlarm');
    await account(op, { id: 'empty', amount: 1000 });
    expect(alarm).not.toHaveBeenCalled();
    expect(await storage.getAlarm()).toBeNull();
  });
}

for (const op of ['deposit', 'dev-deposit', 'resume-cost-jobs']) for (const failure of ['outbox', 'alarm']) {
  it(`rolls back ${op} and its wake batch if the ${failure} write fails`, async () => {
    const { account, storage, deliver } = await setup();
    await account('sync-jobs'); await storage.deleteAlarm();
    const before = structuredClone(storage.rows);
    const put = storage.put.bind(storage);
    const fault = failure === 'alarm' ? vi.spyOn(storage, 'setAlarm').mockRejectedValueOnce(new Error('wakeup unavailable'))
      : vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
        if (key.startsWith('wake:')) throw new Error('outbox unavailable');
        return put(key, value);
      });
    const args = { id: 'retry', amount: 1000 };
    await expect(account(op, args)).rejects.toMatchObject({ status: 500 });
    expect(storage.rows).toEqual(before); expect(await storage.getAlarm()).toBeNull();
    fault.mockRestore();
    await account(op, args);
    expect(await storage.get(`wake:${op === 'resume-cost-jobs' ? 'cost_brake' : 'insufficient_balance'}`)).toBeDefined();
    vi.setSystemTime(await storage.getAlarm()); await deliver();
    expect(await storage.get('sync:j')).toBeUndefined();
    expect(await storage.list({ prefix: 'wake:' })).toHaveLength(0);
    expect((await account('account')).balance_microdollars).toBe(op === 'resume-cost-jobs' ? 9800 : 10800);
  });
}

for (const op of ['deposit', 'resume-cost-jobs']) {
  it(`uses constant account row writes for ${op} with 100 healthy jobs`, async () => {
    const { env, account, storage } = await setup();
    await storage.put('profile', { id: 'a', created_at: Date.now() - 8 * 86400000 });
    await account('deposit', { id: 'more-funds', amount: 100000 });
    await account('mutate', { account: 'a', id: 'more-jobs', operations: Array.from({ length: 99 }, (_, index) => ({ kind: 'jobs', name: `job-${index}`, value: { action: 'ping', cron: '0 * * * *' } })) });
    await account('sync-jobs'); await storage.deleteAlarm();
    const jobs = [...env.JOBS.objects.values()];
    const before = structuredClone(jobs.map(job => [job.storage.rows, job.storage.alarm]));
    const jobWrites = jobs.map(job => vi.spyOn(job.storage, 'put'));
    const put = vi.spyOn(storage, 'put'); const remove = vi.spyOn(storage, 'delete'); const alarm = vi.spyOn(storage, 'setAlarm');
    await account(op, { id: 'top-up', amount: 1000 });
    const pending = [...(await storage.list({ prefix: 'wake:' })).values()];
    expect(pending).toHaveLength(1); expect(pending[0].names).toHaveLength(100);
    expect(await storage.list({ prefix: 'sync:' })).toHaveLength(0);
    await account('sync-jobs');
    // Two deposit writes, one batch row, one wakeup and one acknowledgement;
    // recovery without a deposit only needs the last three.
    expect(put.mock.calls.length + remove.mock.calls.length + alarm.mock.calls.length).toBe(op === 'deposit' ? 5 : 3);
    expect(jobWrites.every(write => !write.mock.calls.length)).toBe(true);
    expect(jobs.map(job => [job.storage.rows, job.storage.alarm])).toEqual(before);
    expect(await storage.list({ prefix: 'wake:' })).toHaveLength(0);
  });
}

for (const op of ['deposit', 'resume-cost-jobs']) for (const paused of ['insufficient_balance', 'cost_brake', 'budget_day', 'budget_month']) {
  it(`only resumes the relevant ${paused} pause for ${op}`, async () => {
    const { env, account, storage, deliver } = await setup();
    await account('sync-jobs');
    const job = env.JOBS.get('a:j');
    const settings = { ...await job.storage.get('settings'), paused, last_outcome: 'failure', ...(paused.startsWith('budget_') ? { resume_at: Date.now() + 60000 } : {}) };
    await job.storage.put('settings', settings); await job.publish(settings); await job.arm();
    const before = await job.storage.getAlarm();
    await account(op, { id: 'top-up', amount: 1000 });
    vi.setSystemTime(await storage.getAlarm()); await deliver();
    const shouldResume = paused === (op === 'deposit' ? 'insufficient_balance' : 'cost_brake');
    const after = await job.storage.get('settings');
    expect(after).toMatchObject({ paused: shouldResume ? null : paused, last_outcome: 'failure' });
    if (!shouldResume) { expect(after).toEqual(settings); expect(await job.storage.getAlarm()).toBe(before); }
    expect((await account('account')).job_runtime.j.paused).toBe(shouldResume ? null : paused);
    expect(await storage.list({ prefix: 'wake:' })).toHaveLength(0);
  });
}

for (const failure of ['delivery', 'acknowledgement']) {
  it(`replays a partially delivered wake batch after failed ${failure} and a cold restart`, async () => {
    const { env, account, storage, deliver } = await setup();
    await account('mutate', { account: 'a', id: 'second', operations: [{ kind: 'jobs', name: 'j2', value: { action: 'ping', cron: '0 * * * *' } }] });
    await account('sync-jobs');
    for (const name of ['j', 'j2']) {
      const job = env.JOBS.get(`a:${name}`); const settings = { ...await job.storage.get('settings'), paused: 'insufficient_balance' };
      await job.storage.put('settings', settings); await job.publish(settings); await job.arm();
    }
    await account('deposit', { id: 'top-up', amount: 1000 });
    const remove = storage.delete.bind(storage);
    const fault = failure === 'delivery' ? vi.spyOn(env.JOBS.get('a:j2'), 'fetch').mockRejectedValueOnce(new Error('job unavailable'))
      : vi.spyOn(storage, 'delete').mockImplementation(async key => {
        if (key === 'wake:insufficient_balance') throw new Error('acknowledgement unavailable');
        return remove(key);
      });
    vi.setSystemTime(await storage.getAlarm()); await deliver();
    expect(await storage.get('wake:insufficient_balance')).toBeDefined();
    expect((await env.JOBS.get('a:j').storage.get('settings')).paused).toBeNull();
    expect(await storage.getAlarm()).toBe(Date.now() + 60000);
    fault.mockRestore();
    for (const [id, object] of env.JOBS.objects) env.JOBS.objects.set(id, new JobDO({ storage: object.storage, blockConcurrencyWhile: fn => fn() }, env));
    vi.setSystemTime(await storage.getAlarm()); await deliver();
    expect(await storage.get('wake:insufficient_balance')).toBeUndefined();
    const summary = await account('account');
    expect(summary.balance_microdollars).toBe(10700);
    for (const name of ['j', 'j2']) expect(summary.job_runtime[name]).toMatchObject({ paused: null, next_fire: Date.parse('2026-11-16T13:00:00Z') });
    expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.id === 'top-up')).toHaveLength(1);
  });
}

it('does not acknowledge a newer deposit arriving during an older wake batch', async () => {
  const { env, account, storage, deliver } = await setup();
  await account('sync-jobs');
  await account('deposit', { id: 'first', amount: 1000 });
  const older = await storage.get('wake:insufficient_balance');
  const object = env.JOBS.get('a:j'); const fetch = object.fetch.bind(object);
  const fault = vi.spyOn(object, 'fetch').mockImplementationOnce(async request => {
    await account('deposit', { id: 'newer', amount: 2000 });
    return fetch(request);
  });
  await account('sync-jobs'); fault.mockRestore();
  const newer = await storage.get('wake:insufficient_balance');
  expect(newer.version).not.toBe(older.version);
  vi.setSystemTime(await storage.getAlarm()); await deliver();
  expect(await storage.get('wake:insufficient_balance')).toBeUndefined();
  expect((await account('account')).balance_microdollars).toBe(12800);
});

it('preserves explicit edits and deletions alongside independent balance and cost wake batches', async () => {
  const { env, account, storage, deliver } = await setup();
  await account('sync-jobs');
  await account('mutate', { account: 'a', id: 'second', operations: [{ kind: 'jobs', name: 'j2', value: { action: 'ping', cron: null } }] });
  await account('sync-jobs');
  await account('deposit', { id: 'top-up', amount: 1000 });
  await account('resume-cost-jobs');
  await account('mutate', { account: 'a', id: 'edit-delete', operations: [
    { kind: 'jobs', name: 'j', value: { action: 'ping', cron: '0 7 * * *' } },
    { kind: 'jobs', name: 'j2', delete: true }
  ] });
  expect(await storage.list({ prefix: 'sync:' })).toHaveLength(2);
  expect(await storage.list({ prefix: 'wake:' })).toHaveLength(2);
  vi.setSystemTime(await storage.getAlarm()); await deliver();
  expect(await env.JOBS.get('a:j').storage.get('settings')).toMatchObject({ job: { cron: '0 7 * * *' }, next_fire: Date.parse('2026-11-17T07:00:00Z') });
  expect(await env.JOBS.get('a:j2').storage.get('settings')).toMatchObject({ job: null, next_fire: null });
  expect(await storage.list({ prefix: 'sync:' })).toHaveLength(0);
  expect(await storage.list({ prefix: 'wake:' })).toHaveLength(0);
});
