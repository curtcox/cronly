import { it, expect } from 'vitest';
import { AccountDO } from './account-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
const setup = () => { const ns = namespace(AccountDO, { ENVIRONMENT: 'local' }); return (op, args) => rpc(ns, 'alice', op, args); };
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
