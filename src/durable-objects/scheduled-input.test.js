import { afterEach, expect, it, vi } from 'vitest';
import { AccountDO } from './account-do.js';
import { JobDO } from './job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { consume } from '../executor/consumer.js';
import { PRICES } from '../utils/pricing.js';

afterEach(() => vi.useRealTimers());

async function setup(reason = 'missing_input') {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const messages = [];
  const env = { ENVIRONMENT: 'local', RUN_QUEUE: { send: async body => messages.push(body) }, OUTBOUND_FETCH: vi.fn(async () => new Response('ok')) };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 10000 });
  await account('mutate', { account: 'a', id: 'defs', operations: [
    { kind: 'actions', name: 'ping', value: { url: reason === 'missing_input' ? 'https://example.com/{{input.event}}' : 'https://example.com' } },
    { kind: 'jobs', name: 'j', value: { action: 'ping', cron: '* * * * *', budget: reason === 'budget_day' ? { day: 0 } : reason === 'budget_month' ? { month: 0 } : {} } }
  ] });
  await account('sync-jobs');
  if (reason === 'insufficient_balance') {
    const storage = env.ACCOUNTS.get('a').storage; const state = await storage.get('balance');
    await storage.put('balance', { ...state, balance_microdollars: 0 });
  }
  const job = env.JOBS.get('a:j'); const due = (await job.storage.get('settings')).next_fire;
  vi.setSystemTime(due); await job.storage.deleteAlarm();
  return { env, account, messages, job, due };
}

it('pauses an input-dependent schedule once, preserves it across deposits, and resumes after a corrected job edit', async () => {
  const { env, account, messages, job, due } = await setup();
  const before = await account('account');
  await job.alarm();
  expect(await job.storage.get('settings')).toMatchObject({ paused: 'missing_input', next_fire: due });
  expect((await account('account')).job_runtime.j.paused).toBe('missing_input');
  expect(await account('account')).toMatchObject({ balance_microdollars: before.balance_microdollars, held_microdollars: 0 });
  const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
  env.JOBS.objects.set('a:j', cold);
  const put = vi.spyOn(job.storage, 'put'); const alarm = vi.spyOn(job.storage, 'setAlarm');
  for (let index = 0; index < 3; index++) { vi.setSystemTime(Date.now() + 1000); await cold.alarm(); }
  expect(put).not.toHaveBeenCalled(); expect(alarm).not.toHaveBeenCalled();
  expect(messages).toHaveLength(0); expect(env.OUTBOUND_FETCH).not.toHaveBeenCalled();
  expect((await cold.dispatch({ op: 'runs' })).items).toMatchObject([{ status: 'paused', reason: 'missing_input', cost_microdollars: 0 }]);
  expect(await cold.storage.getAlarm()).toBe(due + 30 * 86400000);
  await account('deposit', { id: 'top-up', amount: 100 }); await account('sync-jobs');
  await account('resume-cost-jobs'); await account('sync-jobs');
  expect((await cold.storage.get('settings')).paused).toBe('missing_input');
  // Manual runs can supply input without restarting the invalid cron schedule.
  await rpc(env.JOBS, 'a:j', 'start', { id: 'manual', trigger: 'manual', input: { event: 'supplied' } });
  await consume({ body: messages[0], ack() {} }, env, {});
  expect(env.OUTBOUND_FETCH.mock.calls[0][0].url).toBe('https://example.com/supplied');
  expect((await cold.storage.get('settings')).paused).toBe('missing_input');
  await account('mutate', { account: 'a', id: 'correct', operations: [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com/corrected' } },
    { kind: 'jobs', name: 'j', value: { action: 'ping', cron: '* * * * *' } }
  ] });
  await account('sync-jobs');
  expect((await cold.storage.get('settings')).paused).toBe(null);
  vi.setSystemTime(due + 120000); await cold.storage.deleteAlarm(); await cold.alarm();
  expect(messages).toHaveLength(2);
  await consume({ body: messages[1], ack() {} }, env, {});
  expect(env.OUTBOUND_FETCH.mock.calls[1][0].url).toBe('https://example.com/corrected');
  expect((await cold.dispatch({ op: 'runs' })).items.filter(run => run.status === 'success')).toHaveLength(2);
  expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.kind === 'run').map(row => row.amount_microdollars)).toEqual([-PRICES.run, -PRICES.run]);
});

it('rejects missing manual input without pausing a valid schedule or recording an unpaid run', async () => {
  const { env, account, job } = await setup();
  await expect(rpc(env.JOBS, 'a:j', 'start', { id: 'manual', trigger: 'manual', input: {} })).rejects.toMatchObject({ status: 400, code: 'missing_input' });
  expect((await job.storage.get('settings')).paused).toBe(null);
  expect((await account('account')).job_runtime.j.paused).toBe(null);
  expect((await job.dispatch({ op: 'runs' })).items).toEqual([]);
});

for (const reason of ['missing_input', 'insufficient_balance', 'budget_day', 'budget_month']) for (const failure of ['publication', 'history', 'settings', 'alarm']) {
  it(`recovers a scheduled ${reason} pause after failed ${failure} and restart`, async () => {
    const { env, account, messages, job } = await setup(reason);
    const put = job.storage.put.bind(job.storage);
    const fault = failure === 'publication' ? vi.spyOn(job, 'publish').mockRejectedValueOnce(new Error('publication unavailable'))
      : failure === 'alarm' ? vi.spyOn(job.storage, 'setAlarm').mockRejectedValueOnce(new Error('alarm unavailable'))
        : vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
          if (failure === 'settings' ? key === 'settings' : key.startsWith('history:')) throw new Error('storage unavailable');
          return put(key, value);
        });
    await expect(job.alarm()).rejects.toThrow(); fault.mockRestore();
    const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
    env.JOBS.objects.set('a:j', cold); await cold.alarm();
    const settings = await cold.storage.get('settings');
    expect(settings.paused).toBe(reason);
    expect((await account('account')).job_runtime.j.paused).toBe(reason);
    expect((await cold.dispatch({ op: 'runs' })).items).toHaveLength(1);
    expect(messages).toHaveLength(0);
    expect(await cold.storage.getAlarm()).toBe(settings.resume_at || Date.now() + 30 * 86400000);
    expect((await account('account')).held_microdollars).toBe(0);
  });
}
