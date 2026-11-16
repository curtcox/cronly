import { it, expect, vi } from 'vitest';
import { MemoryStorage } from '../../test-utils/storage.js';
import { charge, deposit, reserve, settle, funds } from './ledger.js';
import { accountMoney, accountMetric } from './account-money.js';
import { listLedger } from './ledger-history.js';

const now = Date.parse('2026-11-16T12:00:00Z');
const compare = ([a], [b]) => a < b ? -1 : a > b ? 1 : 0;
async function setup(count = 0, id = index => `read-${index}`) {
  const storage = new MemoryStorage();
  await storage.transaction(tx => deposit(tx, 'fund', 100000, now));
  for (let index = 0; index < count; index++) await storage.transaction(tx => charge(tx, { id: id(index), amount: 21, kind: 'read' }, now + index));
  return storage;
}
async function allEntries(storage) {
  return [
    ...(await storage.list({ prefix: 'ledger:' })),
    ...[...(await storage.list({ prefix: 'ledger-page:' })).values()].flat(),
    ...(await accountMoney(storage)).ledger.items
  ].sort(compare);
}

it('saves ordinary history writes and archives only bounded, immutable pages', async () => {
  const storage = await setup(99);
  const put = vi.spyOn(storage, 'put');
  await storage.transaction(tx => charge(tx, { id: 'boundary', amount: 21, kind: 'read' }, now + 100));
  expect(put).toHaveBeenCalledTimes(3); // Archive, compact balance and receipt.
  const pages = await storage.list({ prefix: 'ledger-page:' });
  expect(pages.size).toBe(1); expect([...pages.values()][0]).toHaveLength(100);
  put.mockClear();
  await storage.transaction(tx => charge(tx, { id: 'ordinary', amount: 21, kind: 'read' }, now + 101));
  expect(put).toHaveBeenCalledTimes(2);
  expect(await storage.list({ prefix: 'ledger-page:' })).toEqual(pages);
  expect((await storage.list({ prefix: 'ledger:' })).size).toBe(0);
  expect((await listLedger(storage)).items).toHaveLength(102);
  expect((await accountMetric(storage, '2026-11-16')).spent_microdollars).toBe(2121);
});

for (const reverse of [false, true]) for (const limit of [1, 7, 1000]) {
  it(`pages mixed legacy, archived and buffered history (${reverse ? 'reverse' : 'forward'}, ${limit} entries)`, async () => {
    const storage = await setup(235);
    for (let index = 0; index < 60; index++) {
      const timestamp = now - 10 + index * 4;
      await storage.put(`ledger:${timestamp}:legacy-${index}`, { id: `legacy-${index}`, created_at: timestamp, amount_microdollars: -1 });
    }
    const expected = await allEntries(storage); if (reverse) expected.reverse();
    const result = []; let cursor;
    do {
      const page = await listLedger(storage, { limit, reverse, cursor });
      result.push(...page.items); cursor = page.next_cursor;
      expect(result.length).toBeLessThanOrEqual(expected.length);
    } while (cursor);
    expect(result).toEqual(expected.map(([, value]) => value));
    // Cursors issued by the old standalone ledger stay valid inside any page.
    const oldCursor = `ledger:${now + 88}:legacy-25`;
    const filtered = expected.filter(([key]) => reverse ? key < oldCursor : key > oldCursor);
    expect((await listLedger(storage, { limit, reverse, cursor: oldCursor })).items).toEqual(filtered.slice(0, limit).map(([, value]) => value));
  });
}

it('keeps equal-time and backwards-clock entries distinct and resumable after restart', async () => {
  const storage = await setup();
  for (const [id, timestamp] of [['z', now], ['a', now], ['b', now - 1000]]) {
    await storage.transaction(tx => charge(tx, { id, amount: 21, kind: 'read' }, timestamp));
  }
  const first = await listLedger(storage, { limit: 2 });
  expect(first.items.map(row => row.id)).toEqual(['fund', 'z']);
  const cold = new MemoryStorage(); cold.rows = structuredClone(storage.rows);
  const rest = await listLedger(cold, { cursor: first.next_cursor });
  expect(rest.items.map(row => row.id)).toEqual(['a', 'b']);
  expect(rest.items[1].created_at).toBe(now - 1000);
  const before = await allEntries(cold);
  await cold.transaction(tx => charge(tx, { id: 'b', amount: 21, kind: 'read' }, now + 100));
  await cold.transaction(tx => deposit(tx, 'fund', 100000, now + 100));
  expect(await allEntries(cold)).toEqual(before);
});

it('bounds UTF-8 page bytes and leaves space beside both compact summaries', async () => {
  const storage = await setup(90, index => `${index}-${'😀'.repeat(160)}`);
  const state = await accountMoney(storage);
  const pages = [...(await storage.list({ prefix: 'ledger-page:' })).values(), state.ledger.items];
  expect(pages.length).toBeGreaterThan(2);
  for (const page of pages) expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(16000);
  for (const [slot, period] of [['day', '2026-11-16'], ['month', '2026-11']]) state.summaries[slot] = { period, by_job: { ['x'.repeat(49000)]: 1 } };
  expect(new TextEncoder().encode(JSON.stringify(state)).byteLength).toBeLessThan(128 * 1024);
  expect((await listLedger(storage)).items).toHaveLength(91);
});

for (const failure of ['ledger-page:', 'balance', 'receipt:finish']) {
  it(`rolls back archival and settlement together when ${failure} fails`, async () => {
    const storage = await setup(99);
    await storage.transaction(tx => reserve(tx, { id: 'finish', amount: 80, kind: 'run', job: 'j' }, now));
    const before = structuredClone(storage.rows); const put = storage.put.bind(storage);
    const fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
      if (key.startsWith(failure)) throw new Error('ledger write unavailable');
      return put(key, value);
    });
    await expect(storage.transaction(tx => settle(tx, 'finish', 30, now + 100))).rejects.toThrow('ledger write unavailable');
    expect(storage.rows).toEqual(before);
    fault.mockRestore();
    await storage.transaction(tx => settle(tx, 'finish', 30, now + 100));
    await storage.transaction(tx => settle(tx, 'finish', 80, now + 101));
    expect((await listLedger(storage)).items.filter(row => row.id === 'finish')).toHaveLength(1);
    expect(await funds(storage)).toMatchObject({ balance_microdollars: 97891, held_microdollars: 0 });
  });
}

it('reads bounded pages without loading the full permanent history', async () => {
  const storage = await setup(800);
  const list = vi.spyOn(storage, 'list');
  const page = await listLedger(storage, { limit: 100, reverse: true });
  expect(page.items).toHaveLength(100);
  expect(list).toHaveBeenCalledTimes(2); // Legacy range plus one archived page.
  expect(page.items[0].id).toBe('read-799');
});
