import { afterEach, expect, it, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';

afterEach(() => vi.useRealTimers());

async function setup() {
  const env = { ENVIRONMENT: 'local', TOKEN_SIGNING_KEY: 'test' }; env.ACCOUNTS = namespace(AccountDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 10000 });
  const api = async (path = '/api/keys', method = 'POST', body = { scopes: ['read'] }, id = 'create') => {
    const response = await worker.fetch(new Request(`https://cronly.org${path}`, {
      method, headers: { Authorization: 'LocalDev a', 'Idempotency-Key': id },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
    }), env);
    return { status: response.status, ...await response.json() };
  };
  const cold = () => { const storage = env.ACCOUNTS.get('a').storage; env.ACCOUNTS.objects.set('a', new AccountDO({ storage }, env)); };
  return { env, account, api, cold };
}

it('recovers the original API key and charge after a lost reply, revocation and restart', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const { env, api, account, cold } = await setup();
  const object = env.ACCOUNTS.get('a'); const fetch = object.fetch.bind(object); let original;
  vi.spyOn(object, 'fetch').mockImplementation(async request => {
    const op = (await request.clone().json()).op;
    const response = await fetch(request);
    if (op === 'create-key') {
      original = await response.json(); throw new Error('reply lost');
    }
    return response;
  });
  expect((await api()).status).toBe(500); cold();
  await api(`/api/keys/${original.id}`, 'DELETE', undefined, 'revoke');
  vi.advanceTimersByTime(86400000); cold();
  const replay = await api();
  expect(replay).toEqual({ status: 200, ...original, token: expect.stringMatching(/^crk_/) });
  expect(await api()).toEqual(replay);
  expect(replay).not.toHaveProperty('request_hash'); expect(replay).not.toHaveProperty('hash');
  expect((await api('/api/keys', 'GET')).items).toEqual([{ id: original.id, name: '', scopes: ['read'], daily_spend_microdollars: null, expires_at: original.expires_at, revoked: true }]);
  expect((await account('account')).balance_microdollars).toBe(9800);
  const rejected = await worker.fetch(new Request('https://cronly.org/api/account', { headers: { Authorization: `ApiKey ${replay.token}` } }), env);
  expect(rejected.status).toBe(401);
});

it('quotes and validates API key dry runs without replaying or consuming receipts', async () => {
  const { api, account } = await setup(); const original = await api();
  expect(await api('/api/keys?dry_run=1', 'POST', { scopes: ['run'] })).toMatchObject({ status: 200, quote_microdollars: 100, cost_microdollars: 0 });
  expect(await api('/api/keys?dry_run=1', 'POST', { scopes: ['unknown'] })).toMatchObject({ status: 400, code: 'invalid_scopes' });
  expect(await api('/api/keys', 'POST', { scopes: ['run'] })).toMatchObject({ status: 409, code: 'idempotency_conflict' });
  expect(await api('/api/keys?dry_run=1', 'POST', { scopes: ['read'] }, 'next')).toMatchObject({ cost_microdollars: 0 });
  expect(await api('/api/keys', 'POST', { scopes: ['run'] }, 'next')).toMatchObject({ status: 200, scopes: ['run'], cost_microdollars: 100 });
  expect(await api()).toEqual(original);
  expect((await account('account')).balance_microdollars).toBe(9800);
});

it('serializes identical key creation and preserves legacy key replay charges', async () => {
  const { env, api, account, cold } = await setup();
  const results = await Promise.all([api(), api()]); expect(results[0]).toEqual(results[1]);
  const storage = env.ACCOUNTS.get('a').storage; const record = await storage.get(`key:${results[0].id}`);
  delete record.creation_response; await storage.put(`key:${record.id}`, record); cold();
  expect(await api()).toEqual({ ...results[0], balance_microdollars: 9900 });
  expect((await account('account')).balance_microdollars).toBe(9900);
});

it('rolls back key creation and billing when the key record cannot persist', async () => {
  const { env, api, account, cold } = await setup(); const storage = env.ACCOUNTS.get('a').storage; const put = storage.put.bind(storage);
  const fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
    if (key.startsWith('key:')) throw new Error('key unavailable');
    return put(key, value);
  });
  expect((await api()).status).toBe(500); fault.mockRestore(); cold();
  expect((await account('account')).balance_microdollars).toBe(10000);
  expect((await api()).cost_microdollars).toBe(100);
});

it('replays key revocation and binds its idempotency key to its target', async () => {
  const { env, api, account, cold } = await setup();
  const first = await api(); const second = await api('/api/keys', 'POST', { scopes: ['run'] }, 'second');
  const object = env.ACCOUNTS.get('a'); const fetch = object.fetch.bind(object);
  vi.spyOn(object, 'fetch').mockImplementation(async request => {
    const op = (await request.clone().json()).op;
    const response = await fetch(request);
    if (op === 'revoke-key') throw new Error('reply lost');
    return response;
  });
  expect((await api(`/api/keys/${first.id}`, 'DELETE', undefined, 'revoke')).status).toBe(500); cold();
  expect(await api(`/api/keys/${first.id}`, 'DELETE', undefined, 'revoke')).toEqual({ status: 200, cost_microdollars: 100, balance_microdollars: 9700 });
  expect(await api(`/api/keys/${second.id}`, 'DELETE', undefined, 'revoke')).toMatchObject({ status: 409, code: 'idempotency_conflict' });
  expect(await api(`/api/keys/${second.id}?dry_run=1`, 'DELETE', undefined, 'revoke')).toMatchObject({ status: 200, quote_microdollars: 100, cost_microdollars: 0 });
  expect(await api(`/api/keys/${first.id}?dry_run=1`, 'DELETE', undefined, 'revoke')).toMatchObject({ status: 200, quote_microdollars: 0, cost_microdollars: 0 });
  expect(await api(`/api/keys/${first.id}`, 'DELETE', undefined, 'noop')).toMatchObject({ status: 200, cost_microdollars: 0 });
  expect((await account('account')).balance_microdollars).toBe(9700);
  expect((await api('/api/keys', 'GET')).items.find(key => key.id === second.id).revoked).toBeUndefined();
});

it('rolls back key revocation and its charge when the response receipt fails', async () => {
  const { env, api, account, cold } = await setup(); const created = await api();
  const storage = env.ACCOUNTS.get('a').storage; const put = storage.put.bind(storage);
  const fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
    if (key.startsWith('key-revoke:')) throw new Error('receipt unavailable');
    return put(key, value);
  });
  expect((await api(`/api/keys/${created.id}`, 'DELETE')).status).toBe(500); fault.mockRestore(); cold();
  expect((await account('account')).balance_microdollars).toBe(9900);
  expect((await api('/api/keys', 'GET')).items[0].revoked).toBeUndefined();
  expect(await api(`/api/keys/${created.id}`, 'DELETE')).toMatchObject({ status: 200, cost_microdollars: 100 });
});
