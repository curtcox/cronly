import { it, expect, vi } from 'vitest';
import { MemoryStorage } from '../../test-utils/storage.js';
import { accountMoney, accountMetric, updateAccountMetric } from './account-money.js';
import { charge, deposit } from './ledger.js';

it('reads legacy scalar balances and migrates existing summaries without losing numeric totals', async () => {
  const storage = new MemoryStorage(); const now = Date.parse('2026-11-16T12:00:00Z');
  await storage.put('balance', 1000);
  await storage.put('spent:account:self:2026-11-16', { period: '2026-11-16', spent_microdollars: 50, by_job: { old: 50 }, estimated_cost_microdollars: 25 });
  await storage.put('spent:account:self:2026-11', 60);
  await storage.transaction(tx => charge(tx, { id: 'new', amount: 20, kind: 'read' }, now));
  expect(await accountMoney(storage)).toMatchObject({ balance_microdollars: 980 });
  expect(await accountMetric(storage, '2026-11-16')).toMatchObject({ spent_microdollars: 70, by_job: { old: 50, read: 20 }, estimated_cost_microdollars: 37 });
  expect(await accountMetric(storage, '2026-11')).toMatchObject({ spent_microdollars: 80 });
  // Stale legacy rows remain untouched, but never override the compact state.
  expect((await storage.get('spent:account:self:2026-11-16')).spent_microdollars).toBe(50);
  await storage.transaction(tx => deposit(tx, 'd', 100, now));
  expect((await accountMoney(storage)).balance_microdollars).toBe(1080);
  expect((await accountMetric(storage, '2026-11')).spent_microdollars).toBe(80);
});

it('keeps large periods standalone and bounds archival writes when compact periods roll over', async () => {
  const storage = new MemoryStorage();
  const state = { balance_microdollars: 100, summaries: { day: { period: '2026-11-15', spent_microdollars: 10 } } };
  const large = { period: '2026-11-16', by_job: { ['😀'.repeat(13000)]: 20 }, spent_microdollars: 20 };
  const put = vi.spyOn(storage, 'put');
  await updateAccountMetric(storage, state, large);
  expect(put).toHaveBeenCalledTimes(1);
  await storage.put('balance', state);
  expect(await accountMetric(storage, '2026-11-15')).toMatchObject({ spent_microdollars: 10 });
  expect(await accountMetric(storage, '2026-11-16')).toEqual(large);
  put.mockClear();
  await updateAccountMetric(storage, state, { period: '2026-11-17', spent_microdollars: 30 });
  expect(put).toHaveBeenCalledTimes(1); // Archive only the previously compact day.
  await storage.put('balance', state);
  for (const [day, spent] of [['15', 10], ['16', 20], ['17', 30]]) expect((await accountMetric(storage, `2026-11-${day}`)).spent_microdollars).toBe(spent);
});

it('stops compacting a growing summary before it exceeds the storage value limit', async () => {
  const storage = new MemoryStorage();
  const state = { balance_microdollars: 100, summaries: { month: { period: '2026-11', spent_microdollars: 10 } } };
  const metric = { period: '2026-11', by_job: { ['x'.repeat(50000)]: 20 }, spent_microdollars: 20 };
  await updateAccountMetric(storage, state, metric);
  await storage.put('balance', state);
  expect(state.summaries.month).toBeUndefined();
  expect(await accountMetric(storage, '2026-11')).toEqual(metric);
});
