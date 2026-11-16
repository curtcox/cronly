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
