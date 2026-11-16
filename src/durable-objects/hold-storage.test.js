import { afterEach, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../../test-utils/storage.js';
import { accountMoney, accountMetric } from './account-money.js';
import { getHold, listHolds, putHold } from './hold-storage.js';
import { deposit, funds, reserve, settle } from './ledger.js';
import { AccountDO } from './account-do.js';
import { claimRun, prepareRun } from './runs.js';

const now = Date.parse('2026-11-16T12:00:00Z');
const size = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const args = (id, extra = {}) => ({ id, amount: 100, kind: 'run', job: id, ...extra });
async function setup() {
  const storage = new MemoryStorage();
  await storage.transaction(tx => deposit(tx, 'fund', 10000, now));
  return storage;
}
afterEach(() => vi.useRealTimers());

it('settles a compact hold with the balance/receipt puts and no separate deletion', async () => {
  const storage = await setup();
  await storage.transaction(tx => reserve(tx, args('__proto__'), now));
  expect(await storage.get('hold:__proto__')).toBeUndefined();
  expect(await getHold(storage, '__proto__')).toMatchObject({ amount: 100 });
  const put = vi.spyOn(storage, 'put'); const remove = vi.spyOn(storage, 'delete');
  await storage.transaction(tx => settle(tx, '__proto__', 30, now));
  expect(put).toHaveBeenCalledTimes(2); expect(remove).not.toHaveBeenCalled();
  expect(await getHold(storage, '__proto__')).toBeUndefined();
  expect((await accountMoney(storage)).holds).toEqual([]);
  expect(await storage.get('receipt:__proto__')).toMatchObject({ charged: 30 });
  put.mockClear();
  expect(await storage.transaction(tx => reserve(tx, args('__proto__'), now))).toMatchObject({ duplicate: true, settled: true });
  expect(await storage.transaction(tx => settle(tx, '__proto__', 100, now))).toMatchObject({ charged: 30 });
  expect(put).not.toHaveBeenCalled();
});

it('enforces funds and both UTC budgets across compact and standalone holds', async () => {
  const storage = await setup(); const budget = { day: 200, month: 250 };
  const common = { job: 'j', key_id: 'k', budget, key_budget: budget };
  await storage.transaction(tx => reserve(tx, args('small', common), now));
  await storage.transaction(tx => reserve(tx, args('large', { ...common, execution: { input: { private: '😀'.repeat(2500) } } }), now));
  expect((await accountMoney(storage)).holds.map(hold => hold.id)).toEqual(['small']);
  expect(await storage.get('hold:large')).toBeDefined();
  for (const [extra, code] of [[common, 'budget_day'], [{ key_id: 'k', key_budget: budget }, 'key_budget_day'], [{ amount: 9801 }, 'insufficient_balance']]) {
    await expect(storage.transaction(tx => reserve(tx, args('refused', { amount: 1, ...extra }), now))).rejects.toMatchObject({ code });
  }
  await storage.transaction(tx => settle(tx, 'small', 30, now));
  await expect(storage.transaction(tx => reserve(tx, args('month-refused', { ...common, amount: 121, budget: { month: 250 }, key_budget: {} }), now))).rejects.toMatchObject({ code: 'budget_month' });
  expect(await funds(storage)).toMatchObject({ balance_microdollars: 9970, held_microdollars: 100 });
  expect(await listHolds(storage)).toHaveLength(1);
});

it('keeps legacy holds standalone and counts them beside newly compacted holds', async () => {
  const storage = new MemoryStorage(); await storage.put('balance', 1000);
  const old = { ...args('old', { key_id: 'k' }), day: '2026-11-16', month: '2026-11', expires_at: now + 1000, created_at: now, settled: false };
  await storage.put('hold:old', old);
  await storage.transaction(tx => reserve(tx, args('new'), now));
  await storage.transaction(tx => putHold(tx, { ...old, claimed: true }));
  expect((await accountMoney(storage)).holds.map(hold => hold.id)).toEqual(['new']);
  expect(await getHold(storage, 'old')).toMatchObject({ claimed: true });
  expect(await funds(storage)).toMatchObject({ held_microdollars: 200 });
  await storage.transaction(tx => deposit(tx, 'more', 50, now));
  await storage.transaction(tx => settle(tx, 'old', 20, now));
  expect(await storage.get('hold:old')).toBeUndefined();
  expect(await funds(storage)).toMatchObject({ balance_microdollars: 1030, held_microdollars: 100 });
  expect(await getHold(storage, 'new')).toBeDefined();
});

it('bounds UTF-8 snapshots beside full summaries and ledger and preserves update headroom', async () => {
  const storage = await setup();
  for (let index = 0; index < 20; index++) {
    await storage.transaction(tx => reserve(tx, args(`r${index}`, { execution: { input: { event: '😀'.repeat(50) } } }), now));
  }
  let state = await accountMoney(storage);
  expect(state.holds.length).toBeGreaterThan(0); expect(state.holds.length).toBeLessThan(20);
  const standalone = await storage.list({ prefix: 'hold:' });
  for (const hold of state.holds) await storage.transaction(tx => putHold(tx, { ...hold, claimed: true, actual_price: Number.MAX_SAFE_INTEGER, gateway_count: 100, activation_day: '2026-11-16' }));
  state = await accountMoney(storage); expect(size(state.holds)).toBeLessThanOrEqual(8000);
  for (const [slot, period] of [['day', '2026-11-16'], ['month', '2026-11']]) state.summaries[slot] = { period, padding: 'x'.repeat(49900) };
  state.ledger.items = [['ledger:large', { padding: 'x'.repeat(15900) }]];
  await storage.put('balance', state);
  expect(size(await storage.get('balance'))).toBeLessThan(128 * 1024);
  expect(await listHolds(storage)).toHaveLength(20);
  for (const hold of state.holds) await storage.transaction(tx => settle(tx, hold.id, 0, now));
  // Free compact space does not force an extra migration when a large/legacy hold
  // is claimed later; its original standalone row remains the authoritative copy.
  const [key, hold] = [...standalone][0];
  const put = vi.spyOn(storage, 'put');
  await storage.transaction(tx => putHold(tx, { ...hold, claimed: true }));
  expect(put).toHaveBeenCalledTimes(1); expect(put.mock.calls[0][0]).toBe(key);
});

it('expires mixed holds after restart, retaining later holds and reserved UTC periods', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const storage = await setup();
  await storage.transaction(tx => reserve(tx, args('small', { ttl_ms: 1000 }), now));
  await storage.transaction(tx => reserve(tx, args('large', { ttl_ms: 1000, execution: { input: { event: 'x'.repeat(9000) } } }), now));
  await storage.transaction(tx => reserve(tx, args('later', { ttl_ms: 3000 }), now));
  vi.setSystemTime(now + 1000);
  const object = new AccountDO({ storage }, {});
  await object.alarm();
  expect(await funds(storage)).toMatchObject({ balance_microdollars: 9800, held_microdollars: 100 });
  expect(await storage.getAlarm()).toBe(now + 3000);
  await object.alarm(); // A replay cannot double charge either storage format.
  vi.setSystemTime(now + 3000); await object.alarm();
  expect(await funds(storage)).toMatchObject({ balance_microdollars: 9700, held_microdollars: 0 });
  expect(await accountMetric(storage, '2026-11-16')).toMatchObject({ spent_microdollars: 300 });
});

for (const failure of ['balance', 'alarm', 'receipt:r']) {
  it(`rolls back compact reservations and money on a failed ${failure} write`, async () => {
    const storage = await setup();
    if (failure === 'receipt:r') await storage.transaction(tx => reserve(tx, args('r'), now));
    const before = structuredClone(storage.rows); const beforeAlarm = await storage.getAlarm();
    const original = storage.put.bind(storage);
    const fault = failure === 'alarm' ? vi.spyOn(storage, 'setAlarm').mockRejectedValue(new Error('unavailable')) : vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
      if (key === failure) throw new Error('unavailable');
      return original(key, value);
    });
    const operation = () => storage.transaction(tx => failure === 'receipt:r' ? settle(tx, 'r', 30, now) : reserve(tx, args('r'), now));
    await expect(operation()).rejects.toThrow('unavailable');
    expect(storage.rows).toEqual(before); expect(await storage.getAlarm()).toBe(beforeAlarm);
    fault.mockRestore(); await operation();
    expect(await funds(storage)).toMatchObject(failure === 'receipt:r' ? { balance_microdollars: 9970, held_microdollars: 0 } : { balance_microdollars: 10000, held_microdollars: 100 });
  });
}

it('keeps compact claim, gateway accounting and private snapshots intact across restart', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const storage = await setup();
  await storage.put('profile', { id: 'a' });
  await storage.put('def:actions:js', { type: 'javascript', source: 'private-code', cpu_ms: 10, subrequests: 1 });
  await storage.put('def:jobs:j', { action: 'js', enabled: true, overlap: 'skip', retries: 1, budget: {} });
  await storage.put('def:variables:private', 'private-value');
  await storage.transaction(tx => prepareRun(tx, { id: 'r', name: 'j', input: { private: 'private-input' }, trigger: 'manual' }));
  const cold = new MemoryStorage(); cold.rows = structuredClone(storage.rows); cold.alarm = storage.alarm;
  const object = new AccountDO({ storage: cold }, {});
  const publicAccount = await cold.transaction(tx => object.dispatch(tx, { op: 'account' }));
  expect(JSON.stringify(publicAccount)).not.toMatch(/private-code|private-value|private-input|execution/);
  expect(await cold.transaction(tx => claimRun(tx, 'r'))).toMatchObject({ vars: { private: 'private-value' }, input: { private: 'private-input' } });
  expect(await cold.transaction(tx => claimRun(tx, 'r'))).toEqual({ duplicate: true });
  expect(await cold.transaction(tx => object.dispatch(tx, { op: 'gateway-request', id: 'r', host: 'example.com' }))).toEqual({ subrequests: 1 });
  await expect(cold.transaction(tx => object.dispatch(tx, { op: 'gateway-request', id: 'r', host: 'example.com' }))).rejects.toMatchObject({ code: 'subrequest_limit' });
  expect(await getHold(cold, 'r')).toMatchObject({ claimed: true, gateway_count: 1 });
  await cold.transaction(tx => settle(tx, 'r', 30, now));
  expect(await storage.get('hold:r')).toBeUndefined();
  expect(await getHold(cold, 'r')).toBeUndefined();
  expect(await cold.get('receipt:r')).not.toHaveProperty('execution');
});

it('serializes concurrent reservations against all outstanding funds', async () => {
  const storage = await setup();
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => storage.transaction(tx => reserve(tx, args(`r${index}`, { amount: 1000 }), now))));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(10);
  expect(results.filter(result => result.status === 'rejected').map(result => result.reason.code)).toEqual(['insufficient_balance', 'insufficient_balance']);
  expect(await funds(storage)).toMatchObject({ balance_microdollars: 10000, held_microdollars: 10000 });
});

it('applies overlap and account concurrency limits to both storage formats together', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const storage = await setup();
  await storage.put('def:actions:ping', { type: 'http', url: 'https://example.com' });
  await storage.put('def:jobs:j', { action: 'ping', enabled: true, overlap: 'skip' });
  await storage.transaction(tx => reserve(tx, args('active', { job: 'j' }), now));
  const start = () => storage.transaction(tx => prepareRun(tx, { id: 'new', name: 'j', input: {} }));
  await expect(start()).rejects.toMatchObject({ code: 'overlap' });
  for (let index = 0; index < 9; index++) await storage.transaction(tx => reserve(tx, args(`r${index}`, { execution: { padding: 'x'.repeat(index % 2 ? 9000 : 0) } }), now));
  expect((await storage.list({ prefix: 'hold:' })).size).toBeGreaterThan(0);
  await expect(start()).rejects.toMatchObject({ code: 'concurrency_limit' });
  await storage.transaction(tx => settle(tx, 'active', 0, now));
  await expect(start()).resolves.toMatchObject({ id: 'new' });
});

for (const operation of ['claim', 'gateway']) {
  it(`rolls back compact ${operation} and its activation/rate writes together`, async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const storage = await setup();
    const action = { type: 'javascript', cpu_ms: 10, subrequests: 1 };
    await storage.transaction(tx => reserve(tx, args('r', { execution: { action, version: 'hash' }, claimed: operation === 'gateway' }), now));
    const object = new AccountDO({ storage }, {});
    const before = structuredClone(storage.rows); const original = storage.put.bind(storage);
    const fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
      if (key === 'balance') throw new Error('unavailable');
      return original(key, value);
    });
    const invoke = () => storage.transaction(tx => operation === 'claim' ? claimRun(tx, 'r') : object.dispatch(tx, { op: 'gateway-request', id: 'r', host: 'example.com' }));
    await expect(invoke()).rejects.toThrow('unavailable');
    expect(storage.rows).toEqual(before);
    fault.mockRestore(); await invoke();
    expect(await getHold(storage, 'r')).toMatchObject(operation === 'claim' ? { claimed: true, actual_price: 100 } : { gateway_count: 1 });
  });
}
