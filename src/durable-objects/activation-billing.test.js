import { afterEach, expect, it, vi } from 'vitest';
import { AccountDO } from './account-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { price, PRICES } from '../utils/pricing.js';
import { accountMetric } from './account-money.js';
import { getHold, putHold } from './hold-storage.js';

afterEach(() => vi.useRealTimers());

async function setup(mode) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-30T23:58:00Z'));
  const env = { ENVIRONMENT: 'local' }; env.ACCOUNTS = namespace(AccountDO, env);
  const call = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await call('init', { account: 'a' }); await call('deposit', { id: 'fund', amount: 100000 });
  const action = { type: 'javascript', source: `export default () => 1;\n//${mode === 'standalone' ? 'x'.repeat(9000) : ''}`, cpu_ms: 10, subrequests: 0 };
  await call('mutate', { account: 'a', id: 'defs', operations: [
    { kind: 'actions', name: 'js', value: action },
    { kind: 'jobs', name: 'j', value: { action: 'js', cron: null, overlap: 'allow', budget: { day: 50000, month: 50000 } } }
  ] });
  const prepare = id => call('prepare-run', { id, name: 'j', input: {}, trigger: 'manual', retry: true });
  const storage = env.ACCOUNTS.get('a').storage;
  const cold = () => env.ACCOUNTS.objects.set('a', new AccountDO({ storage }, env));
  return { call, prepare, storage, cold, maximum: price('run', action) };
}

for (const mode of ['compact', 'standalone']) {
  it(`bills activation on the execution day while preserving reserved UTC budgets (${mode})`, async () => {
    const { call, prepare, storage, cold, maximum } = await setup(mode);
    await prepare('warm'); await call('claim-run', { id: 'warm' });
    await call('settle', { id: 'warm', actual: maximum });
    vi.setSystemTime(new Date('2026-11-30T23:59:30Z'));
    await prepare('delayed');
    expect(Boolean(await storage.get('hold:delayed'))).toBe(mode === 'standalone');
    vi.setSystemTime(new Date('2026-12-01T00:00:05Z')); cold();
    expect(await call('claim-run', { id: 'delayed' })).toMatchObject({ actual_price: maximum });
    expect(await call('settle', { id: 'delayed', actual: maximum })).toMatchObject({ charged: maximum, day: '2026-11-30', activation_day: '2026-12-01' });
    await prepare('today');
    expect(await call('claim-run', { id: 'today' })).toMatchObject({ actual_price: maximum - PRICES.jsActivation });
    expect(await call('settle', { id: 'today', actual: maximum })).toMatchObject({ charged: maximum - PRICES.jsActivation });
    for (const period of ['2026-11-30', '2026-11']) expect((await accountMetric(storage, period)).budget_spent.job.j).toBe(2 * maximum);
    for (const period of ['2026-12-01', '2026-12']) expect((await accountMetric(storage, period)).budget_spent.job.j).toBe(maximum - PRICES.jsActivation);
    expect((await storage.list({ prefix: 'activation:' })).size).toBe(2);
    expect((await call('account')).held_microdollars).toBe(0);
  });

  for (const first of ['left', 'right']) it(`settles one paid activation across concurrent claims and a refund (${mode}, ${first} first)`, async () => {
    const { call, prepare, storage, cold, maximum } = await setup(mode);
    for (const id of ['refunded', 'left', 'right']) {
      await prepare(id);
      expect(await call('claim-run', { id })).toMatchObject({ actual_price: maximum });
    }
    expect((await storage.list({ prefix: 'activation:' })).size).toBe(0);
    await call('settle', { id: 'refunded', actual: 0 }); cold();
    expect((await storage.list({ prefix: 'activation:' })).size).toBe(0);
    expect(await call('settle', { id: first, actual: maximum })).toMatchObject({ charged: maximum });
    const second = first === 'left' ? 'right' : 'left';
    expect(await call('settle', { id: second, actual: maximum })).toMatchObject({ charged: maximum - PRICES.jsActivation });
    cold();
    const put = vi.spyOn(storage, 'put');
    expect(await call('settle', { id: second, actual: maximum })).toMatchObject({ charged: maximum - PRICES.jsActivation });
    expect(put).not.toHaveBeenCalled();
    const day = await accountMetric(storage, '2026-11-30');
    expect(day.by_job.j).toBe(2 * maximum - PRICES.jsActivation);
    const ledger = (await call('list', { prefix: 'ledger:' })).items.filter(row => row.kind === 'run');
    expect(ledger.map(row => row.amount_microdollars).sort((a, b) => a - b)).toEqual([-maximum, -(maximum - PRICES.jsActivation), 0]);
    expect((await call('account')).held_microdollars).toBe(0);
  });

  it(`rolls back activation payment together with the ledger and receipt (${mode})`, async () => {
    const { call, prepare, storage, cold, maximum } = await setup(mode);
    await prepare('first'); await call('claim-run', { id: 'first' });
    const before = structuredClone(storage.rows); const put = storage.put.bind(storage);
    const fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
      if (key === 'receipt:first') throw new Error('receipt unavailable');
      return put(key, value);
    });
    await expect(call('settle', { id: 'first', actual: maximum })).rejects.toMatchObject({ status: 500 });
    expect(storage.rows).toEqual(before); fault.mockRestore(); cold();
    expect(await call('settle', { id: 'first', actual: maximum })).toMatchObject({ charged: maximum });
    await prepare('next'); await call('claim-run', { id: 'next' });
    expect(await call('settle', { id: 'next', actual: maximum })).toMatchObject({ charged: maximum - PRICES.jsActivation });
  });

  it(`preserves the promised price of a legacy claimed reservation (${mode})`, async () => {
    const { call, prepare, storage, maximum } = await setup(mode);
    await prepare('legacy');
    const hold = await getHold(storage, 'legacy');
    await storage.transaction(tx => putHold(tx, { ...hold, claimed: true, actual_price: maximum - PRICES.jsActivation }));
    expect(await call('claim-run', { id: 'legacy' })).toEqual({ duplicate: true });
    expect(await call('settle', { id: 'legacy', actual: maximum })).toMatchObject({ charged: maximum - PRICES.jsActivation });
  });
}
