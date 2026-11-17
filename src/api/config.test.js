import { expect, it, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';

async function setup() {
  const env = { ENVIRONMENT: 'local', TOKEN_SIGNING_KEY: 'test', SECRETS_MASTER_KEY: 'test-master' };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const api = async (body, id = 'import', dry = false, token) => {
    const response = await worker.fetch(new Request(`https://cronly.org/api/config${dry ? '?dry_run=1' : ''}`, {
      method: 'PUT', headers: { Authorization: token ? `ApiKey ${token}` : 'LocalDev a', 'Idempotency-Key': id }, body: JSON.stringify(body)
    }), env);
    return { status: response.status, ...await response.json() };
  };
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 100000 });
  const cold = () => { const storage = env.ACCOUNTS.get('a').storage; env.ACCOUNTS.objects.set('a', new AccountDO({ storage }, env)); };
  return { env, account, api, cold };
}

it('replays the original import after a lost response, account edits and a cold restart', async () => {
  const { env, account, api, cold } = await setup();
  const desired = { variables: { greeting: 'hello' } };
  const object = env.ACCOUNTS.get('a'); const fetch = object.fetch.bind(object); let committed;
  vi.spyOn(object, 'fetch').mockImplementation(async request => {
    const response = await fetch(request);
    if (request.method === 'POST' && response.ok) {
      const value = await response.clone().json();
      if (value.changes?.length) { committed = { status: response.status, ...value }; throw new Error('response lost'); }
    }
    return response;
  });
  expect((await api(desired)).status).toBe(500);
  expect(committed.cost_microdollars).toBe(100); cold();
  expect(await api(desired)).toEqual(committed);
  await account('mutate', { account: 'a', id: 'later', operations: [{ kind: 'variables', name: 'greeting', value: { value: 'edited' } }] });
  expect(await api(desired)).toEqual(committed);
  expect((await account('config')).variables.greeting).toBe('edited');
  expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.kind === 'change')).toHaveLength(2);
});

it('rejects reuse with a different import even when its diff is now empty', async () => {
  const { api, account, cold } = await setup();
  expect((await api({ variables: { greeting: 'hello' } })).cost_microdollars).toBe(100);
  cold();
  expect(await api({})).toMatchObject({ status: 409, code: 'idempotency_conflict' });
  expect((await account('config')).variables.greeting).toBe('hello');
});

it('remembers a successful no-op without applying it later after account edits', async () => {
  const { api, account, cold } = await setup();
  const first = await api({ variables: {} });
  expect(first).toMatchObject({ status: 200, changes: [], cost_microdollars: 0 });
  await account('mutate', { account: 'a', id: 'later', operations: [{ kind: 'variables', name: 'greeting', value: { value: 'edited' } }] });
  cold(); expect(await api({ variables: {} })).toEqual(first);
  expect((await account('config')).variables.greeting).toBe('edited');
});

it('dry runs quote current changes without consuming the import idempotency key', async () => {
  const { api, account } = await setup();
  const desired = { variables: { greeting: 'hello' } };
  expect(await api(desired, 'import', true)).toMatchObject({ status: 200, cost_microdollars: 0, quote_microdollars: 100 });
  expect((await account('config')).variables).toEqual({});
  expect((await api(desired)).cost_microdollars).toBe(100);
  expect(await api(desired, 'import', true)).toMatchObject({ status: 200, changes: [], cost_microdollars: 0 });
});

it('quotes a changed account afresh after a paid import without replaying its charge', async () => {
  const { api, account } = await setup();
  const desired = { variables: { greeting: 'hello' } };
  await api(desired);
  await account('mutate', { account: 'a', id: 'later', operations: [{ kind: 'variables', name: 'extra', value: { value: 'later' } }] });
  const before = await account('account');
  expect(await api(desired, 'import', true)).toMatchObject({ status: 200, cost_microdollars: 0, quote_microdollars: 100, changes: [{ kind: 'variables', name: 'extra', operation: 'delete' }] });
  expect(await account('account')).toEqual(before);
  expect((await account('config')).variables.extra).toBe('later');
});

it('serializes concurrent duplicate imports and rolls back failed imports with their receipts', async () => {
  const { env, api, account, cold } = await setup();
  const desired = { variables: { greeting: 'hello' } };
  const storage = env.ACCOUNTS.get('a').storage; const put = storage.put.bind(storage);
  const fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
    if (key.startsWith('config-import:')) throw new Error('receipt unavailable');
    return put(key, value);
  });
  expect((await api(desired)).status).toBe(500); fault.mockRestore(); cold();
  expect((await account('config')).variables).toEqual({});
  expect((await account('account')).balance_microdollars).toBe(100000);
  const [first, replay] = await Promise.all([api(desired), api(desired)]);
  expect(first).toMatchObject({ status: 200, cost_microdollars: 100 }); expect(replay).toEqual(first);
  expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.kind === 'change')).toHaveLength(1);
});

it('keeps secret deletion scopes and daily key caps inside the import transaction', async () => {
  const { env, api, account } = await setup();
  await account('mutate', { account: 'a', id: 'secret', operations: [{ kind: 'secrets', name: 'token', value: { value: 'private-token' } }] });
  const response = await worker.fetch(new Request('https://cronly.org/api/keys', { method: 'POST', headers: { Authorization: 'LocalDev a' }, body: JSON.stringify({ scopes: ['change'], daily_spend_microdollars: 100 }) }), env);
  const { token } = await response.json();
  expect(await api({ secrets: {} }, 'denied', false, token)).toMatchObject({ status: 403, code: 'insufficient_scope' });
  expect(await api({ variables: { greeting: 'hello' } }, 'first', false, token)).toMatchObject({ status: 200, cost_microdollars: 100 });
  expect(await api({ variables: { greeting: 'other' } }, 'second', false, token)).toMatchObject({ status: 402, code: 'key_budget_day' });
  expect((await account('config')).secrets).toHaveProperty('token');
  expect((await account('config')).variables.greeting).toBe('hello');
});

it('separates import billing from named-definition idempotency keys', async () => {
  const { api, account } = await setup();
  await account('mutate', { account: 'a', id: 'import', operations: [{ kind: 'variables', name: 'greeting', value: { value: 'before' } }] });
  expect(await api({ variables: { greeting: 'after' } })).toMatchObject({ status: 200, cost_microdollars: 100 });
  expect((await account('account')).balance_microdollars).toBe(99800);
  expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.kind === 'change')).toHaveLength(2);
});
