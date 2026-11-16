import { afterEach, it, expect, vi } from 'vitest';
import { AccountDO } from './account-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { reports } from '../api/reporting.js';
const setup = () => { const ns = namespace(AccountDO, { ENVIRONMENT: 'local' }); return (op, args) => rpc(ns, 'alice', op, args); };
afterEach(() => vi.useRealTimers());
it('serializes competing holds, never overspends, and settles once', async () => {
  const call = setup(); await call('init', { account: 'alice' }); await call('dev-deposit', { id: 'd1', amount: 100 });
  const results = await Promise.allSettled([call('reserve', { id: 'a', amount: 80 }), call('reserve', { id: 'b', amount: 80 })]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  await call('settle', { id: 'a', actual: 30 }); await call('settle', { id: 'a', actual: 80 });
  expect(await call('account')).toMatchObject({ balance_microdollars: 70, held_microdollars: 0 });
  expect(await call('reserve', { id: 'a', amount: 80 })).toMatchObject({ duplicate: true, charged: 30 });
});
it('deduplicates deposits and includes pending work in UTC budgets', async () => {
  const call = setup(); await call('init', { account: 'alice' });
  await call('deposit', { id: 'stripe:123', amount: 1000 }); await call('deposit', { id: 'stripe:123', amount: 1000 });
  await call('reserve', { id: 'a', amount: 60, job: 'j', budget: { day: 100 } });
  await expect(call('reserve', { id: 'b', amount: 60, job: 'j', budget: { day: 100 } })).rejects.toMatchObject({ status: 402, code: 'budget_day' });
  expect((await call('account')).balance_microdollars).toBe(1000);
});
it('expires a lost result at the full hold and rejects production dev deposits', async () => {
  const ns = namespace(AccountDO, { ENVIRONMENT: 'production' }); const call = (op, args) => rpc(ns, 'a', op, args);
  await call('init', { account: 'a' }); await expect(call('dev-deposit', { id: 'd', amount: 100 })).rejects.toMatchObject({ status: 404 });
  await call('deposit', { id: 'paid', amount: 100 }); await call('reserve', { id: 'r', amount: 30, ttl_ms: -1 });
  await ns.get('a').alarm(); expect((await call('account')).balance_microdollars).toBe(70);
});

it('reports compact and archived spend after restart without duplicating legacy rows', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-30T23:59:00Z'));
  const ns = namespace(AccountDO, { ENVIRONMENT: 'local' }); const call = (op, args) => rpc(ns, 'a', op, args);
  await call('init', { account: 'a' }); await call('deposit', { id: 'd', amount: 1000 });
  const storage = ns.get('a').storage;
  await storage.put('spent:account:self:2026-11-30', { period: '2026-11-30', spent_microdollars: 10, run_count_by_job: { j: 1 }, by_job: { j: 10 } });
  await call('reserve', { id: 'old', amount: 80, kind: 'run', job: 'j', action: 'ping' });
  await call('settle', { id: 'old', actual: 30 });
  const cold = () => ns.objects.set('a', new AccountDO({ storage, blockConcurrencyWhile: fn => fn() }, { ENVIRONMENT: 'local' }));
  cold();
  expect(await call('account')).toMatchObject({ balance_microdollars: 970, spent_today_microdollars: 40, spent_month_microdollars: 30, spend_today_by_job: { j: 40 } });
  const costs = await call('costs', { from: '2026-11-29', to: '2026-12-02' });
  expect(costs.items).toHaveLength(1); expect(costs.items[0].spent_microdollars).toBe(40);
  expect((await call('costs', { from: '2026-11-29', to: '2026-11-29' })).items).toHaveLength(0);
  vi.setSystemTime(new Date('2026-12-01T00:01:00Z'));
  expect(await call('account')).toMatchObject({ spent_today_microdollars: 0, spent_month_microdollars: 0 });
  // The monitor can still read yesterday while the account is idle after midnight.
  expect(await call('metrics', { period: '2026-11-30' })).toMatchObject({ spent_microdollars: 40 });
  await call('reserve', { id: 'new', amount: 80, kind: 'run', job: 'j', action: 'ping' });
  await call('settle', { id: 'new', actual: 20 });
  cold();
  expect((await call('costs', { from: '2026-11-29', to: '2026-12-02' })).items.map(row => [row.period, row.spent_microdollars])).toEqual([['2026-11-30', 40], ['2026-12-01', 20]]);
  expect(await call('account')).toMatchObject({ balance_microdollars: 950, spent_today_microdollars: 20, spent_month_microdollars: 20, spend_by_job: { j: 20 } });
  expect(await call('activity')).toEqual({ counts: { j: 3 } });
  expect(await call('metrics', { period: '2026-11' })).toMatchObject({ spent_microdollars: 30 });
});

it('reports numeric constructor-named activity and costs across UTC days after restart', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
  const env = { ENVIRONMENT: 'local' }; const ns = namespace(AccountDO, env); env.ACCOUNTS = ns;
  const call = (op, args) => rpc(ns, 'a', op, args);
  await call('init', { account: 'a' }); await call('deposit', { id: 'fund', amount: 1000 });
  for (const [id, amount] of [['first', 30], ['second', 60]]) {
    await call('reserve', { id, amount, kind: 'run', job: 'constructor', action: 'constructor', budget: { day: 100, month: 100 } });
    await call('settle', { id, actual: amount });
    vi.advanceTimersByTime(86400000);
  }
  const storage = ns.get('a').storage;
  ns.objects.set('a', new AccountDO({ storage, blockConcurrencyWhile: fn => fn() }, env));
  expect(await call('activity')).toEqual({ counts: { constructor: 2 } });
  expect(await call('account')).toMatchObject({ spend_by_job: { constructor: 90 }, balance_microdollars: 910 });
  for (const group of ['job', 'action']) {
    const result = await reports({ handler: 'costs' }, new Request(`https://cronly.org/api/costs?group=${group}`), env, { account: 'a' });
    expect(result).toMatchObject({ items: [{ name: 'constructor', cost_microdollars: 90 }], total_microdollars: 90 });
  }
  await expect(call('reserve', { id: 'capped', amount: 11, job: 'constructor', budget: { month: 100 } })).rejects.toMatchObject({ code: 'budget_month' });
});
