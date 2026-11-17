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

for (const arriving of [false, true]) for (const ttl of [10000, 120000]) {
  it(`preserves the earliest wakeup when synchronization fails with ${arriving ? 'a newly arriving' : 'an existing'} ${ttl}ms hold`, async () => {
    const { env, account, storage, deliver } = await setup();
    const start = Date.now();
    const reserve = () => account('reserve', { id: 'held', amount: 50, kind: 'run', ttl_ms: ttl });
    if (!arriving) await reserve();
    const fault = vi.spyOn(env.JOBS.get('a:j'), 'fetch').mockImplementation(async () => {
      if (arriving) await reserve();
      throw new Error('synchronization unavailable');
    });
    await deliver();
    expect(await storage.getAlarm()).toBe(start + Math.min(ttl, 60000));
    expect(await storage.get('sync:j')).toBeDefined();
    expect(await account('account')).toMatchObject({ balance_microdollars: 9800, held_microdollars: 50 });
    fault.mockRestore();
    vi.setSystemTime(await storage.getAlarm()); await deliver();
    expect(await storage.get('sync:j')).toBeUndefined();
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
