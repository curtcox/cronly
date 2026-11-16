import { it, expect, vi } from 'vitest';
import { MemoryStorage } from '../../test-utils/storage.js';
import { reserve, settle, deposit, funds, charge } from './ledger.js';

const time = Date.parse('2026-11-30T23:59:00Z');
async function setup() {
  const storage = new MemoryStorage();
  await storage.transaction(tx => deposit(tx, 'fund', 10000, time));
  return { storage, hold: args => storage.transaction(tx => reserve(tx, args, time)), charge: (id, amount, now = time) => storage.transaction(tx => settle(tx, id, amount, now)) };
}

it('settles job and key budgets in the account summaries without separate counter writes', async () => {
  const { storage, hold, charge } = await setup();
  await hold({ id: 'r', amount: 80, kind: 'run', job: 'j', key_id: 'k', budget: { day: 100 }, key_budget: { day: 100 } });
  const put = vi.spyOn(storage, 'put');
  await charge('r', 30);
  expect(put).toHaveBeenCalledTimes(5); // Balance, two summaries, receipt and ledger.
  expect(put.mock.calls.some(([key]) => key.startsWith('spent:job:') || key.startsWith('spent:key:'))).toBe(false);
  for (const period of ['2026-11-30', '2026-11']) expect(await storage.get(`spent:account:self:${period}`)).toMatchObject({ budget_spent: { job: { j: 30 }, key: { k: 30 } }, spent_microdollars: 30 });
  put.mockClear(); await charge('r', 80); expect(put).not.toHaveBeenCalled();
  await hold({ id: 'pending', amount: 60, kind: 'run', job: 'j', key_id: 'k' });
  await expect(hold({ id: 'job-refused', amount: 11, job: 'j', budget: { day: 100 } })).rejects.toMatchObject({ code: 'budget_day' });
  await expect(hold({ id: 'key-refused', amount: 11, key_id: 'k', key_budget: { day: 100 } })).rejects.toMatchObject({ code: 'key_budget_day' });
  expect(await funds(storage)).toMatchObject({ balance_microdollars: 9970, held_microdollars: 60 });
});

it('lazily carries forward legacy budgets independently of reporting groups', async () => {
  const { storage, hold, charge } = await setup();
  for (const period of ['2026-11-30', '2026-11']) {
    await storage.put(`spent:job:change:${period}`, 40);
    await storage.put(`spent:key:k:${period}`, 50);
    // A reporting group can mix a job named "change" with ordinary changes.
    await storage.put(`spent:account:self:${period}`, { period, spent_microdollars: 500, by_job: { change: 500 } });
  }
  await expect(hold({ id: 'refused', amount: 61, job: 'change', budget: { day: 100 } })).rejects.toMatchObject({ code: 'budget_day' });
  await expect(hold({ id: 'key-refused', amount: 51, key_id: 'k', key_budget: { day: 100 } })).rejects.toMatchObject({ code: 'key_budget_day' });
  await hold({ id: 'r', amount: 60, kind: 'run', job: 'change', key_id: 'k' });
  await charge('r', 30);
  await hold({ id: 'change', amount: 100, kind: 'change', key_id: 'k' });
  await charge('change', 100);
  for (const period of ['2026-11-30', '2026-11']) expect(await storage.get(`spent:account:self:${period}`)).toMatchObject({ budget_spent: { job: { change: 70 }, key: { k: 180 } }, by_job: { change: 630 } });
  await expect(hold({ id: 'month-refused', amount: 31, job: 'change', budget: { month: 100 } })).rejects.toMatchObject({ code: 'budget_month' });
  await expect(hold({ id: 'month-key-refused', amount: 21, key_id: 'k', key_budget: { month: 200 } })).rejects.toMatchObject({ code: 'key_budget_month' });
});

it('charges expired work to its reserved UTC periods across a month boundary', async () => {
  const { storage, hold, charge } = await setup();
  const args = { amount: 60, kind: 'run', job: 'j', key_id: 'k', budget: { day: 60, month: 60 }, key_budget: { day: 60 } };
  await hold({ ...args, id: 'old' });
  const next = Date.parse('2026-12-01T00:01:00Z');
  await storage.transaction(tx => reserve(tx, { ...args, id: 'new' }, next));
  await charge('old', 60, next);
  await charge('new', 20, next);
  expect((await storage.get('spent:account:self:2026-11')).budget_spent).toEqual({ job: { j: 60 }, key: { k: 60 } });
  expect((await storage.get('spent:account:self:2026-12')).budget_spent).toEqual({ job: { j: 20 }, key: { k: 20 } });
  expect(await funds(storage)).toMatchObject({ balance_microdollars: 9920, held_microdollars: 0 });
});

it('rolls back summaries and money together if a settlement write fails', async () => {
  const { storage, hold, charge } = await setup();
  await hold({ id: 'r', amount: 60, kind: 'run', job: 'j', key_id: 'k' });
  const put = storage.put.bind(storage);
  vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
    if (key === 'spent:account:self:2026-11') throw new Error('storage failure');
    return put(key, value);
  });
  await expect(charge('r', 30)).rejects.toThrow('storage failure');
  expect(await storage.get('spent:account:self:2026-11-30')).toBeUndefined();
  expect(await storage.get('receipt:r')).toBeUndefined();
  expect(await funds(storage)).toMatchObject({ balance_microdollars: 10000, held_microdollars: 60 });
});

it('charges transactional work once without a transient hold or expiry alarm', async () => {
  const { storage, hold } = await setup();
  await hold({ id: 'pending', amount: 80, kind: 'run', job: 'j', key_id: 'k' });
  const alarm = await storage.getAlarm();
  const put = vi.spyOn(storage, 'put'); const remove = vi.spyOn(storage, 'delete');
  const setAlarm = vi.spyOn(storage, 'setAlarm');
  const args = { id: 'read', amount: 20, kind: 'read', key_id: 'k', key_budget: { day: 100 } };
  const billed = await storage.transaction(tx => charge(tx, args, time));
  expect(billed).toMatchObject({ settled: true, charged: 20 });
  expect(put).toHaveBeenCalledTimes(5);
  expect(remove).not.toHaveBeenCalled(); expect(setAlarm).not.toHaveBeenCalled();
  expect(await storage.getAlarm()).toBe(alarm);
  expect(await funds(storage)).toMatchObject({ balance_microdollars: 9980, held_microdollars: 80 });
  put.mockClear();
  expect(await storage.transaction(tx => charge(tx, args, time))).toMatchObject({ duplicate: true, charged: 20 });
  expect(await hold(args)).toMatchObject({ duplicate: true, settled: true });
  expect(put).not.toHaveBeenCalled();
  await expect(storage.transaction(tx => charge(tx, { ...args, id: 'capped', amount: 1 }, time))).rejects.toMatchObject({ code: 'key_budget_day' });
  await expect(storage.transaction(tx => charge(tx, { id: 'unfunded', amount: 9901, kind: 'change' }, time))).rejects.toMatchObject({ code: 'insufficient_balance' });
  await expect(storage.transaction(tx => charge(tx, { id: 'external', amount: 1, kind: 'run' }, time))).rejects.toMatchObject({ code: 'invalid_charge' });
});

it('rolls back an immediate charge when its definition write fails', async () => {
  const { storage } = await setup();
  await expect(storage.transaction(async tx => {
    await charge(tx, { id: 'change', amount: 100, kind: 'change' }, time);
    await tx.put('def:variables:value', 'new');
    throw new Error('definition failure');
  })).rejects.toThrow('definition failure');
  expect(await funds(storage)).toMatchObject({ balance_microdollars: 10000, held_microdollars: 0 });
  expect(await storage.get('receipt:change')).toBeUndefined();
  expect(await storage.get('spent:account:self:2026-11')).toBeUndefined();
  expect(await storage.get('def:variables:value')).toBeUndefined();
  expect((await storage.list({ prefix: 'ledger:' })).size).toBe(1); // Original deposit only.
  expect(await storage.getAlarm()).toBeNull();
});

it('finishes an existing durable reservation through the immediate path', async () => {
  const { storage, hold } = await setup();
  const args = { id: 'legacy', amount: 20, kind: 'read' };
  await hold(args);
  expect(await storage.transaction(tx => charge(tx, args, time))).toMatchObject({ settled: true, charged: 20 });
  expect(await funds(storage)).toMatchObject({ balance_microdollars: 9980, held_microdollars: 0 });
  expect(await storage.get('hold:legacy')).toBeUndefined();
});
