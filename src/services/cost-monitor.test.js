import { afterEach, it, expect, vi } from 'vitest';
import { SafetyDO } from '../durable-objects/safety-do.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { measuredCost, runCostMonitor } from './cost-monitor.js';
afterEach(() => vi.useRealTimers());
it('fails closed on missing or stale analytics and missing credentials', async () => {
  const env = { ENVIRONMENT: 'production' }; env.SAFETY = namespace(SafetyDO, env);
  expect((await rpc(env.SAFETY, 'global', 'status')).brake).toBe(true);
  await rpc(env.SAFETY, 'global', 'record', { report: { checked_at: Date.now() - 48 * 3600000, brake: false } });
  expect((await rpc(env.SAFETY, 'global', 'status')).brake).toBe(true);
  expect((await runCostMonitor(env)).brake).toBe(true);
  expect(() => measuredCost({ workers: [] })).toThrow();
});
it('computes actual billable totals and rejects truncated datasets', () => {
  const account = { workers: [{ sum: { requests: 100, cpuTimeUs: 100000 } }], invocations: [{ sum: { requests: 100 } }], periodic: [{ sum: { duration: 1, rowsRead: 1000, rowsWritten: 10 } }], storage: [{ max: { storedBytes: 1000000 } }] };
  expect(measuredCost(account)).toBeGreaterThan(50);
  account.workers = Array(10).fill(account.workers[0]); expect(() => measuredCost(account)).toThrow();
});

async function recoverySetup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const env = {
    ENVIRONMENT: 'production', CLOUDFLARE_ANALYTICS_TOKEN: 'test', CLOUDFLARE_ACCOUNT_ID: 'test', COST_SAFETY_DO_NAMESPACES: 'accounts,jobs,safety',
    ANALYTICS_FETCH: vi.fn(async () => Response.json({ data: { viewer: { accounts: [{ workers: [], invocations: [], periodic: [], storage: [] }] } } }))
  };
  env.SAFETY = namespace(SafetyDO, env); env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  for (const account of ['a', 'b', 'c']) {
    const call = (op, args) => rpc(env.ACCOUNTS, account, op, args);
    await call('init', { account }); await call('deposit', { id: 'fund', amount: 10000 });
    await call('mutate', { account, id: 'defs', operations: [
      { kind: 'actions', name: 'ping', value: { url: 'https://example.com' } },
      { kind: 'jobs', name: 'j', value: { action: 'ping', cron: '0 * * * *' } }
    ] });
    await call('sync-jobs');
    const job = env.JOBS.get(`${account}:j`); const settings = await job.storage.get('settings');
    await job.storage.put('settings', { ...settings, paused: 'cost_brake' });
  }
  await rpc(env.SAFETY, 'global', 'record', { report: { checked_at: Date.now(), brake: true } });
  return env;
}

for (const failure of ['enqueue', 'acknowledgement']) {
  it(`finishes cost-brake recovery after failed ${failure} and a cold monitor restart`, async () => {
    const env = await recoverySetup();
    const first = vi.spyOn(env.ACCOUNTS.get('a'), 'dispatch');
    const safety = env.SAFETY.get('global');
    const account = env.ACCOUNTS.get('b'); const dispatch = account.dispatch.bind(account);
    const remove = safety.storage.delete.bind(safety.storage);
    const fault = failure === 'enqueue' ? vi.spyOn(account, 'dispatch').mockImplementation(async (tx, args) => {
      if (args.op === 'resume-cost-jobs') throw new Error('account unavailable');
      return dispatch(tx, args);
    }) : vi.spyOn(safety.storage, 'delete').mockImplementation(async key => {
      if (key === 'resume:b') throw new Error('acknowledgement unavailable');
      return remove(key);
    });
    await expect(runCostMonitor(env)).rejects.toMatchObject({ status: 500 });
    expect((await rpc(env.SAFETY, 'global', 'status')).brake).toBe(false);
    expect((await rpc(env.SAFETY, 'global', 'resume-accounts')).items.map(item => item.account)).toEqual(['b', 'c']);
    fault.mockRestore();
    env.SAFETY.objects.set('global', new SafetyDO({ storage: safety.storage }, env));
    expect((await runCostMonitor(env)).brake).toBe(false);
    expect((await rpc(env.SAFETY, 'global', 'resume-accounts')).items).toEqual([]);
    expect(first.mock.calls.filter(([, args]) => args.op === 'resume-cost-jobs')).toHaveLength(1);
    for (const name of ['a', 'b', 'c']) {
      const object = env.ACCOUNTS.get(name);
      expect(await object.storage.get('sync:j')).toBeDefined();
      await object.alarm();
      expect(await rpc(env.JOBS, `${name}:j`, 'status')).toMatchObject({ paused: null });
      expect((await rpc(env.ACCOUNTS, name, 'account')).job_runtime.j.paused).toBe(null);
    }
    first.mockClear(); await runCostMonitor(env);
    expect(first.mock.calls.filter(([, args]) => args.op === 'resume-cost-jobs')).toEqual([]);
  });
}

it('commits a healthy report and all resume outboxes atomically', async () => {
  const env = await recoverySetup(); const safety = env.SAFETY.get('global');
  const put = safety.storage.put.bind(safety.storage);
  const fault = vi.spyOn(safety.storage, 'put').mockImplementation(async (key, value) => {
    if (key === 'resume:b') throw new Error('storage unavailable');
    return put(key, value);
  });
  await expect(runCostMonitor(env)).rejects.toMatchObject({ status: 500 });
  expect((await rpc(env.SAFETY, 'global', 'status')).brake).toBe(true);
  expect((await rpc(env.SAFETY, 'global', 'resume-accounts')).items).toEqual([]);
  fault.mockRestore();
  expect((await runCostMonitor(env)).brake).toBe(false);
  expect((await rpc(env.SAFETY, 'global', 'resume-accounts')).items).toEqual([]);
});

it('retains a newer recovery when an earlier monitor acknowledges late', async () => {
  const env = await recoverySetup();
  const safety = (op, args) => rpc(env.SAFETY, 'global', op, args);
  const record = brake => safety('record', { report: { checked_at: Date.now(), brake } });
  await record(false);
  const older = (await safety('resume-accounts')).items[0];
  await record(true); await record(false);
  const newer = (await safety('resume-accounts')).items[0];
  expect(newer.version).not.toBe(older.version);
  await safety('resumed-account', older);
  expect((await safety('resume-accounts')).items[0]).toEqual(newer);
  await safety('resumed-account', newer);
  expect((await safety('resume-accounts')).items.map(item => item.account)).toEqual(['b', 'c']);
});

it('recovers from stale or malformed reports and leaves pending work through a new brake', async () => {
  const env = await recoverySetup();
  const safety = (op, args) => rpc(env.SAFETY, 'global', op, args);
  await safety('record', { report: { brake: false } });
  expect(await safety('status')).toMatchObject({ brake: true, stale: true });
  await safety('record', { report: { checked_at: Date.now(), brake: false } });
  const pending = (await safety('resume-accounts')).items;
  expect(pending).toHaveLength(3);
  await safety('record', { report: { checked_at: Date.now(), brake: true } });
  expect((await safety('resume-accounts')).items).toEqual(pending);
  await safety('record', { report: { checked_at: Date.now(), brake: false } });
  await vi.advanceTimersByTimeAsync(37 * 3600000);
  expect(await safety('status')).toMatchObject({ brake: true, stale: true });
  expect((await runCostMonitor(env)).brake).toBe(false);
  expect((await safety('resume-accounts')).items).toEqual([]);
});
