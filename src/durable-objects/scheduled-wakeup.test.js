import { afterEach, expect, it, vi } from 'vitest';
import { AccountDO } from './account-do.js';
import { JobDO } from './job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { PRICES } from '../utils/pricing.js';

afterEach(() => vi.useRealTimers());

async function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const messages = [];
  const env = { ENVIRONMENT: 'local', RUN_QUEUE: { send: async body => {
    messages.push(body);
    await vi.advanceTimersByTimeAsync(20);
  } } };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 10000 });
  await account('mutate', { account: 'a', id: 'defs', operations: [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com' } },
    { kind: 'jobs', name: 'j', value: { action: 'ping', cron: '* * * * *' } }
  ] });
  await account('sync-jobs');
  const job = env.JOBS.get('a:j'); const settings = await job.storage.get('settings');
  settings.next_fire = Date.now(); await job.storage.put('settings', settings);
  await job.storage.deleteAlarm();
  return { env, account, job, messages, due: settings.next_fire };
}

it('rearms scheduled dispatch once after advancement while preserving the atomic outbox wakeup', async () => {
  const { job, account, messages, due } = await setup();
  const arm = vi.spyOn(job, 'arm'); const alarm = vi.spyOn(job.storage, 'setAlarm');
  await job.alarm();
  expect(messages).toHaveLength(1); expect(arm).toHaveBeenCalledTimes(1);
  expect(alarm.mock.calls.map(([time]) => time)).toEqual([due + 1000, due + 60000]);
  expect((await account('account')).job_runtime.j.next_fire).toBe(due + 60000);
  expect((await job.readRun(messages[0].id)).expires_at).toBe(due + 120000);
});

for (const failure of ['enqueue', 'advancement', 'rearm']) {
  it(`recovers scheduled dispatch after failed ${failure} and restart without another reservation`, async () => {
    const { env, account, job, messages, due } = await setup();
    let fault;
    if (failure === 'enqueue') fault = vi.spyOn(env.RUN_QUEUE, 'send').mockRejectedValueOnce(new Error('queue unavailable'));
    else if (failure === 'rearm') fault = vi.spyOn(job, 'arm').mockRejectedValueOnce(new Error('alarm unavailable'));
    else {
      const put = job.storage.put.bind(job.storage);
      fault = vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
        if (key === 'settings' && value.next_fire > due) throw new Error('advancement unavailable');
        return put(key, value);
      });
    }
    await expect(job.alarm()).rejects.toThrow(); fault.mockRestore();
    expect(await job.storage.getAlarm()).toBe(due + 1000);
    expect((await account('account')).held_microdollars).toBe(PRICES.run);
    vi.setSystemTime(due + 1000);
    const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
    env.JOBS.objects.set('a:j', cold); await cold.alarm();
    expect(messages).toHaveLength(1);
    expect((await cold.storage.get('settings')).next_fire).toBe(due + 60000);
    expect(await cold.storage.getAlarm()).toBe(due + 60000);
    expect((await account('account')).held_microdollars).toBe(PRICES.run);
    await cold.result({ id: messages[0].id, result: { status: 'success' } });
    expect(await account('account')).toMatchObject({ held_microdollars: 0, spent_today_microdollars: 200 + PRICES.run });
  });
}
