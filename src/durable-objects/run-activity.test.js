import { afterEach, expect, it, vi } from 'vitest';
import { MemoryStorage, namespace } from '../../test-utils/storage.js';
import { runActivity, lastRun, recordRun } from './run-activity.js';
import { AccountDO } from './account-do.js';
import { getHold } from './hold-storage.js';
import { rpc } from '../utils/rpc.js';
import { PRICES } from '../utils/pricing.js';

afterEach(() => vi.useRealTimers());

async function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const env = { ENVIRONMENT: 'local' }; env.ACCOUNTS = namespace(AccountDO, env);
  const call = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await call('init', { account: 'a' }); await call('deposit', { id: 'fund', amount: 100000 });
  await call('mutate', { account: 'a', id: 'defs', operations: [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com' } },
    ...['j', 'k'].map(name => ({ kind: 'jobs', name, value: { action: 'ping', cron: null, overlap: 'allow' } }))
  ] });
  return { env, call, storage: env.ACCOUNTS.get('a').storage, start: (id, name = 'j', extra = {}) => call('prepare-run', { id, name, account: 'a', input: {}, trigger: 'manual', ...extra }) };
}

it('migrates legacy recent names lazily and preserves standalone cooldowns', async () => {
  const { call, storage, start } = await setup();
  await storage.put('recent-jobs', ['j', 'deleted']);
  await storage.put('last-run:j', Date.now() - 30000);
  expect(await call('read-plan')).toEqual({ names: ['j', 'deleted'] });
  await expect(start('too-soon')).rejects.toMatchObject({ code: 'run_rate_limit' });
  expect(await storage.get('recent-jobs')).toEqual(['j', 'deleted']);
  await vi.advanceTimersByTimeAsync(30000);
  await start('allowed');
  expect(await storage.get('recent-jobs')).toEqual({ items: [['j', Date.now()], ['deleted', null]] });
  await expect(start('compact-too-soon')).rejects.toMatchObject({ code: 'run_rate_limit' });
});

it('shares one cooldown/index write when switching jobs and retains timestamps after restart', async () => {
  const { env, call, storage, start } = await setup();
  await start('first');
  const put = vi.spyOn(storage, 'put');
  await start('second', 'k');
  const activityWrites = put.mock.calls.filter(([key]) => key === 'recent-jobs' || key.startsWith('last-run:'));
  expect(activityWrites).toHaveLength(1);
  expect(await call('read-plan')).toEqual({ names: ['k', 'j'] });
  env.ACCOUNTS.objects.set('a', new AccountDO({ storage }, env));
  await expect(start('cold-too-soon')).rejects.toMatchObject({ code: 'run_rate_limit' });
  await call('settle', { id: 'first', actual: PRICES.run });
  await call('settle', { id: 'second', actual: PRICES.run });
  const metered = await call('meter-read', { id: 'read', resource: 'runs' });
  expect(metered).toMatchObject({ names: ['k', 'j'], cost_microdollars: PRICES.read + 2 * PRICES.readJob });
  expect((await call('account')).held_microdollars).toBe(0);
});

it('does not change activity on dry runs, duplicates or balance refusals', async () => {
  const { call, storage, start } = await setup();
  await start('first'); const before = await storage.get('recent-jobs');
  expect(await start('first', 'k')).toMatchObject({ duplicate: true });
  expect(await start('dry', 'k', { dry_run: true })).toMatchObject({ cost_microdollars: 0 });
  const state = await storage.get('balance'); await storage.put('balance', { ...state, balance_microdollars: PRICES.run });
  await expect(start('refused', 'k')).rejects.toMatchObject({ code: 'insufficient_balance' });
  expect(await storage.get('recent-jobs')).toEqual(before);
  expect(await getHold(storage, 'refused')).toBeUndefined();
  expect((await call('account')).held_microdollars).toBe(PRICES.run);
});

for (const failure of ['index', 'eviction']) it(`rolls back reservation and cooldown together after an ${failure} write failure`, async () => {
  const { call, storage, start } = await setup();
  const items = Array.from({ length: 100 }, (_, index) => [`old-${index}`, Date.now() - 1000]);
  await storage.put('recent-jobs', { items });
  const before = structuredClone(storage.rows); const alarm = await storage.getAlarm();
  const put = storage.put.bind(storage);
  const fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
    if (key === (failure === 'index' ? 'recent-jobs' : 'last-run:old-99')) throw new Error('write unavailable');
    return put(key, value);
  });
  await expect(start('failed')).rejects.toMatchObject({ status: 500 }); fault.mockRestore();
  expect(storage.rows).toEqual(before); expect(await storage.getAlarm()).toBe(alarm);
  expect((await call('account')).held_microdollars).toBe(0);
  await start('failed');
  expect((await call('account')).held_microdollars).toBe(PRICES.run);
  expect(await storage.get('last-run:old-99')).toBe(Date.now() - 1000);
});

it('keeps evicted cooldowns and bounds the index with maximum length names', async () => {
  const storage = new MemoryStorage(); const now = Date.now();
  const items = Array.from({ length: 100 }, (_, index) => [`_test:${String(index).padStart(64, 'x')}`, now]);
  const put = vi.spyOn(storage, 'put');
  await storage.transaction(tx => recordRun(tx, 'new', now, items));
  expect(put).toHaveBeenCalledTimes(2);
  expect(await lastRun(storage, items.at(-1)[0], await runActivity(storage))).toBe(now);
  const activity = await runActivity(storage);
  expect(activity).toHaveLength(100); expect(activity[0]).toEqual(['new', now]);
  expect(new TextEncoder().encode(JSON.stringify(await storage.get('recent-jobs'))).byteLength).toBeLessThan(10000);
});

it('enforces an evicted job cooldown after restarting the account', async () => {
  const { env, call, storage, start } = await setup();
  const timestamp = Date.now();
  const items = [...Array.from({ length: 99 }, (_, index) => [`deleted-${index}`, null]), ['j', timestamp]];
  await storage.put('recent-jobs', { items });
  await start('other-job', 'k');
  env.ACCOUNTS.objects.set('a', new AccountDO({ storage }, env));
  expect((await call('read-plan')).names).not.toContain('j');
  await expect(start('evicted-too-soon')).rejects.toMatchObject({ code: 'run_rate_limit' });
  await vi.advanceTimersByTimeAsync(60000);
  await start('evicted-allowed');
  expect((await call('read-plan')).names[0]).toBe('j');
  expect(await storage.get('last-run:j')).toBe(timestamp);
});

it('preserves retry cooldown overrides across eviction, legacy rows and backwards clocks', async () => {
  const { storage, start } = await setup(); const original = Date.now();
  await storage.put('last-run:j', original + 600000);
  await start('retry', 'j', { retry: true });
  expect(await lastRun(storage, 'j', await runActivity(storage))).toBe(original);
  const items = [['j', original], ...Array.from({ length: 99 }, (_, index) => [`old-${index}`, null])];
  // Move j to the tail, then evict it after its compact timestamp expires. The
  // stale future legacy timestamp must not become authoritative again.
  await vi.advanceTimersByTimeAsync(61000);
  await recordRun(storage, 'new', Date.now(), [...items.slice(1), items[0]]);
  expect(await storage.get('last-run:j')).toBe(original);
  await start('after-eviction');
  vi.setSystemTime(original + 30000);
  await expect(start('clock-backwards')).rejects.toMatchObject({ code: 'run_rate_limit' });
});
