import { afterEach, expect, it, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { digest } from '../auth/crypto.js';

afterEach(() => vi.useRealTimers());

async function setup(empty = false) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const env = { ENVIRONMENT: 'local' };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 10000 });
  await account('save-proposal', { id: 'proposal', operations: empty ? [] : [{ kind: 'variables', name: 'greeting', value: { value: 'hello' } }], base_hash: await digest(JSON.stringify(await account('config'))) });
  const api = async (dry = false) => {
    const response = await worker.fetch(new Request(`https://cronly.org/api/changes/proposal/apply${dry ? '?dry_run=1' : ''}`, {
      method: 'POST', headers: { Authorization: 'LocalDev a' }, body: '{}'
    }), env);
    return { status: response.status, ...await response.json() };
  };
  const cold = () => { const storage = env.ACCOUNTS.get('a').storage; env.ACCOUNTS.objects.set('a', new AccountDO({ storage }, env)); };
  return { env, account, api, cold };
}

for (const empty of [false, true]) {
  it(`retains a ${empty ? 'no-op' : 'paid'} application receipt after a lost reply, edits, cleanup and restart`, async () => {
    const { env, account, api, cold } = await setup(empty);
    const object = env.ACCOUNTS.get('a'); const fetch = object.fetch.bind(object); let saved;
    vi.spyOn(object, 'fetch').mockImplementation(async request => {
      const { op } = await request.clone().json(); const response = await fetch(request);
      if (op === 'apply-proposal' && response.ok) { saved = { status: response.status, ...await response.json() }; throw new Error('reply lost'); }
      return response;
    });
    expect((await api()).status).toBe(500); cold();
    await account('mutate', { account: 'a', id: 'later', operations: [{ kind: 'variables', name: 'greeting', value: { value: 'edited' } }] });
    vi.advanceTimersByTime(32 * 86400000); await account('maintenance'); cold();
    const before = await account('account');
    expect(await api()).toEqual(saved);
    expect((await account('config')).variables.greeting).toBe('edited');
    expect(await account('account')).toEqual(before);
    expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.kind === 'change')).toHaveLength(empty ? 1 : 2);
  });
}

it('quotes an applied proposal as a free no-op without dispatching synchronization', async () => {
  const { env, account, api } = await setup();
  expect(await api(true)).toMatchObject({ status: 200, cost_microdollars: 0, quote_microdollars: 100 });
  expect((await account('config')).variables).toEqual({});
  expect((await api()).cost_microdollars).toBe(100);
  const sync = vi.spyOn(env.ACCOUNTS.get('a'), 'syncJobs');
  const before = await account('account');
  expect(await api(true)).toMatchObject({ status: 200, changes: [], cost_microdollars: 0, quote_microdollars: 0, balance_microdollars: before.balance_microdollars });
  expect(sync).not.toHaveBeenCalled();
  expect(await account('account')).toEqual(before);
});

it('preserves legacy applied proposals through expiry cleanup', async () => {
  const { env, account, api, cold } = await setup();
  const storage = env.ACCOUNTS.get('a').storage; const legacy = await storage.get('proposal:proposal');
  const saved = await api();
  await storage.put('proposal:proposal', { ...legacy, applied: Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'status')) });
  vi.advanceTimersByTime(2 * 86400000); await account('maintenance'); cold();
  expect(await api()).toEqual(saved);
});

it('rolls back changes and charges if the application receipt cannot persist', async () => {
  const { env, account, api, cold } = await setup();
  const storage = env.ACCOUNTS.get('a').storage; const put = storage.put.bind(storage);
  const fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
    if (key === 'proposal:proposal' && value.applied) throw new Error('receipt unavailable');
    return put(key, value);
  });
  expect((await api()).status).toBe(500); fault.mockRestore(); cold();
  expect((await account('config')).variables).toEqual({});
  expect((await account('account')).balance_microdollars).toBe(10000);
  const [first, replay] = await Promise.all([api(), api()]);
  expect(first).toMatchObject({ status: 200, cost_microdollars: 100 }); expect(replay).toEqual(first);
});

it('still expires unapplied proposals without changing definitions or balance', async () => {
  const { account, api } = await setup();
  vi.advanceTimersByTime(86400001);
  expect(await api()).toMatchObject({ status: 409, code: 'proposal_expired' });
  expect(await api(true)).toMatchObject({ status: 409, code: 'proposal_expired' });
  await account('maintenance');
  expect(await api()).toMatchObject({ status: 404, code: 'not_found' });
  expect((await account('config')).variables).toEqual({});
  expect((await account('account')).balance_microdollars).toBe(10000);
});
