import { getHold, putHold } from '../durable-objects/hold-storage.js';
import { it, expect, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { decryptSecret, encryptSecret } from './secrets.js';

async function setup(balance = 10000) {
  const env = { ENVIRONMENT: 'local', TOKEN_SIGNING_KEY: 'signing', SECRETS_MASTER_KEY: 'old-master' };
  env.ACCOUNTS = namespace(AccountDO, env);
  const api = async (path, method = 'POST', body, headers) => {
    const response = await worker.fetch(new Request(`https://cronly.org${path}`, { method, body: body && JSON.stringify(body), headers: { Authorization: 'LocalDev alice', ...headers } }), env);
    return { status: response.status, ...await response.json() };
  };
  await api('/api/dev/deposit', 'POST', { amount_microdollars: balance });
  await api('/api/secrets/token', 'PUT', { value: 'private-token' });
  const original = (await rpc(env.ACCOUNTS, 'alice', 'config', { public_view: false })).secrets.token;
  env.SECRETS_KEYRING = JSON.stringify({ active: 'v2', keys: { v1: 'old-master', v2: 'new-master' } });
  const stored = async () => (await rpc(env.ACCOUNTS, 'alice', 'config', { public_view: false })).secrets.token;
  return { api, env, original, stored };
}

it('quotes without writing, re-encrypts once, and preserves value and user metadata', async () => {
  const { api, env, original, stored } = await setup();
  const before = await rpc(env.ACCOUNTS, 'alice', 'account');
  const headers = { 'Idempotency-Key': 'rotate-token' };
  expect(await api('/api/secrets/token/rotate?dry_run=1', 'POST', undefined, headers)).toMatchObject({ status: 200, needs_rotation: true, quote_microdollars: 100, cost_microdollars: 0 });
  expect(await stored()).toEqual(original);
  expect((await rpc(env.ACCOUNTS, 'alice', 'account')).held_microdollars).toBe(0);
  const result = await api('/api/secrets/token/rotate', 'POST', undefined, headers);
  expect(result).toMatchObject({ status: 200, rotated: true, key_version: 'v2', cost_microdollars: 100, balance_microdollars: before.balance_microdollars - 100 });
  const encrypted = await stored();
  expect(encrypted).toMatchObject({ key_version: 'v2', fingerprint: original.fingerprint, updated_at: original.updated_at });
  expect(encrypted.ciphertext).not.toBe(original.ciphertext);
  expect(await decryptSecret(env, 'alice', 'token', encrypted)).toBe('private-token');
  expect(await api('/api/secrets/token/rotate', 'POST', undefined, headers)).toEqual(result);
  expect((await api('/api/secrets/token/rotate?dry_run=1', 'POST', undefined, headers)).cost_microdollars).toBe(0);
  expect((await api('/api/secrets/token/rotate')).cost_microdollars).toBe(0);
  expect((await rpc(env.ACCOUNTS, 'alice', 'account')).balance_microdollars).toBe(before.balance_microdollars - 100);
  expect((await api('/api/secrets/other/rotate', 'POST', undefined, headers)).code).toBe('idempotency_conflict');
  const audit = await rpc(env.ACCOUNTS, 'alice', 'list', { prefix: 'audit:' });
  expect(audit.items.filter(item => item.kind === 'rotate_secret')).toHaveLength(1);
  expect(JSON.stringify({ result, audit })).not.toMatch(/private-token|ciphertext|old-master|new-master/);
  env.SECRETS_KEYRING = JSON.stringify({ active: 'v2', keys: { v2: 'new-master' } });
  expect(await decryptSecret(env, 'alice', 'token', encrypted)).toBe('private-token');
});

it('requires secret authority, balance and key budget before re-encryption', async () => {
  const empty = await setup(100);
  expect((await empty.api('/api/secrets/token/rotate')).status).toBe(402);
  expect(await empty.stored()).toEqual(empty.original);
  const { api, env, stored } = await setup();
  await api('/api/secrets/second', 'PUT', { value: 'another-token' });
  // Simulate an existing old-key record without changing the customer's secret value.
  await env.ACCOUNTS.get('alice').storage.put('def:secrets:second', await encryptSecret({ SECRETS_MASTER_KEY: 'old-master' }, 'alice', 'second', 'another-token'));
  const restricted = await api('/api/keys', 'POST', { scopes: ['change'] });
  expect((await api('/api/secrets/token/rotate', 'POST', undefined, { Authorization: `ApiKey ${restricted.token}` })).status).toBe(403);
  const capped = await api('/api/keys', 'POST', { scopes: ['secrets:write'], daily_spend_microdollars: 100 });
  const headers = { Authorization: `ApiKey ${capped.token}` };
  expect((await api('/api/secrets/token/rotate', 'POST', undefined, headers)).status).toBe(200);
  expect((await api('/api/secrets/second/rotate', 'POST', undefined, headers)).code).toBe('key_budget_day');
  expect((await stored()).key_version).toBe('v2');
});

it('releases the hold on an edit/delete race and never overwrites the newer secret', async () => {
  for (const method of ['PUT', 'DELETE']) {
    const { api, env, original, stored } = await setup();
    const args = { account: 'alice', name: 'token', id: 'race' };
    await rpc(env.ACCOUNTS, 'alice', 'begin-secret-rotation', args);
    expect((await rpc(env.ACCOUNTS, 'alice', 'account')).held_microdollars).toBe(100);
    expect(await rpc(env.ACCOUNTS, 'alice', 'begin-secret-rotation', args)).toEqual({ record: original, target_version: 'v2' });
    const record = { ...await encryptSecret(env, 'alice', 'token', 'private-token'), updated_at: original.updated_at };
    await api('/api/secrets/token', method, method === 'PUT' ? { value: 'new-value' } : undefined);
    const before = await rpc(env.ACCOUNTS, 'alice', 'account');
    const finished = await rpc(env.ACCOUNTS, 'alice', 'finish-secret-rotation', { ...args, record });
    expect(finished).toMatchObject({ error: { code: 'secret_conflict', status: 409 }, response: { cost_microdollars: 0 } });
    expect((await rpc(env.ACCOUNTS, 'alice', 'account'))).toMatchObject({ held_microdollars: 0, balance_microdollars: before.balance_microdollars });
    if (method === 'PUT') expect(await decryptSecret(env, 'alice', 'token', await stored())).toBe('new-value');
    else expect(await stored()).toBeUndefined();
    expect((await api('/api/secrets/token/rotate', 'POST', undefined, { 'Idempotency-Key': 'race' })).code).toBe('secret_conflict');
  }
});

it('fails safely and settles zero when the old ciphertext cannot be authenticated', async () => {
  const { api, env, original, stored } = await setup();
  env.SECRETS_KEYRING = JSON.stringify({ active: 'v2', keys: { v1: 'wrong-old-master', v2: 'new-master' } });
  const before = await rpc(env.ACCOUNTS, 'alice', 'account');
  const headers = { 'Idempotency-Key': 'failed' };
  const failed = await api('/api/secrets/token/rotate', 'POST', undefined, headers);
  expect(failed).toMatchObject({ status: 503, code: 'secret_rotation_failed', cost_microdollars: 0 });
  expect(await api('/api/secrets/token/rotate', 'POST', undefined, headers)).toEqual(failed);
  expect(await stored()).toEqual(original);
  expect(await rpc(env.ACCOUNTS, 'alice', 'account')).toMatchObject({ held_microdollars: 0, balance_microdollars: before.balance_microdollars });
  expect(JSON.stringify(failed)).not.toMatch(/wrong-old-master|private-token|ciphertext/);
});

it('refuses a stale target key and expired reservations', async () => {
  const { env, original, stored } = await setup();
  const args = { account: 'alice', name: 'token', id: 'target-race' };
  await rpc(env.ACCOUNTS, 'alice', 'begin-secret-rotation', args);
  const record = { ...await encryptSecret(env, 'alice', 'token', 'private-token'), updated_at: original.updated_at };
  env.SECRETS_KEYRING = JSON.stringify({ active: 'v1', keys: { v1: 'old-master', v2: 'new-master' } });
  expect(await rpc(env.ACCOUNTS, 'alice', 'finish-secret-rotation', { ...args, record })).toMatchObject({ error: { status: 409 }, response: { cost_microdollars: 0 } });
  expect(await stored()).toEqual(original);
  env.SECRETS_KEYRING = JSON.stringify({ active: 'v2', keys: { v1: 'old-master', v2: 'new-master' } });
  args.id = 'expired';
  await rpc(env.ACCOUNTS, 'alice', 'begin-secret-rotation', args);
  const storage = env.ACCOUNTS.get('alice').storage;
  const id = 'secret-rotation:session:expired';
  await storage.transaction(async tx => putHold(tx, { ...await getHold(tx, id), expires_at: Date.now() - 1 }));
  await expect(rpc(env.ACCOUNTS, 'alice', 'finish-secret-rotation', { ...args, record })).rejects.toMatchObject({ code: 'rotation_expired' });
  expect(await stored()).toEqual(original);
});

for (const failure of ['begin-reply', 'finish-write', 'finish-reply']) {
  it(`recovers rotation after a lost ${failure} and restart at an exhausted key cap`, async () => {
    const { api, env, stored, original } = await setup();
    const key = await api('/api/keys', 'POST', { scopes: ['secrets:write'], daily_spend_microdollars: 100 });
    const headers = { Authorization: `ApiKey ${key.token}`, 'Idempotency-Key': 'recover' };
    const object = env.ACCOUNTS.get('alice'); const storage = object.storage;
    const before = await rpc(env.ACCOUNTS, 'alice', 'account');
    let fault;
    if (failure === 'finish-write') {
      const put = storage.put.bind(storage);
      fault = vi.spyOn(storage, 'put').mockImplementation(async (name, value) => {
        if (name.startsWith('secret-rotation:') && value.result) throw new Error('receipt unavailable');
        return put(name, value);
      });
    } else {
      const fetch = object.fetch.bind(object);
      fault = vi.spyOn(object, 'fetch').mockImplementation(async request => {
        const { op } = await request.clone().json(); const response = await fetch(request);
        if (op === (failure === 'begin-reply' ? 'begin-secret-rotation' : 'finish-secret-rotation') && response.ok) throw new Error('reply lost');
        return response;
      });
    }
    expect((await api('/api/secrets/token/rotate', 'POST', undefined, headers)).status).toBe(500);
    fault.mockRestore();
    const pending = await rpc(env.ACCOUNTS, 'alice', 'account');
    expect(pending.held_microdollars).toBe(failure === 'finish-reply' ? 0 : 100);
    if (failure !== 'finish-reply') expect(await stored()).toEqual(original);
    env.ACCOUNTS.objects.set('alice', new AccountDO({ storage }, env));
    const recovered = await api('/api/secrets/token/rotate', 'POST', undefined, headers);
    expect(recovered).toMatchObject({ status: 200, rotated: true, key_version: 'v2', cost_microdollars: 100, balance_microdollars: before.balance_microdollars - 100 });
    expect(await api('/api/secrets/token/rotate', 'POST', undefined, headers)).toEqual(recovered);
    expect(await stored()).toMatchObject({ key_version: 'v2', fingerprint: original.fingerprint, updated_at: original.updated_at });
    expect(await decryptSecret(env, 'alice', 'token', await stored())).toBe('private-token');
    expect((await rpc(env.ACCOUNTS, 'alice', 'account')).held_microdollars).toBe(0);
    const audit = await rpc(env.ACCOUNTS, 'alice', 'list', { prefix: 'audit:' });
    expect(audit.items.filter(item => item.kind === 'rotate_secret')).toHaveLength(1);
    const ledger = await rpc(env.ACCOUNTS, 'alice', 'list', { prefix: 'ledger:' });
    expect(ledger.items.filter(item => item.id.startsWith('secret-rotation:'))).toHaveLength(1);
    expect(JSON.stringify(recovered)).not.toMatch(/private-token|ciphertext|old-master|new-master/);
  });
}

for (const method of ['PUT', 'DELETE']) {
  it(`refunds a recovered rotation after a concurrent ${method} and preserves that failure`, async () => {
    const { api, env, stored } = await setup();
    await rpc(env.ACCOUNTS, 'alice', 'begin-secret-rotation', { name: 'token', id: 'changed' });
    await api('/api/secrets/token', method, method === 'PUT' ? { value: 'new-value' } : undefined);
    const before = await rpc(env.ACCOUNTS, 'alice', 'account');
    const headers = { 'Idempotency-Key': 'changed' };
    const result = await api('/api/secrets/token/rotate', 'POST', undefined, headers);
    expect(result).toMatchObject({ status: 409, code: 'secret_conflict', cost_microdollars: 0, balance_microdollars: before.balance_microdollars });
    expect((await rpc(env.ACCOUNTS, 'alice', 'account')).held_microdollars).toBe(0);
    if (method === 'PUT') expect(await decryptSecret(env, 'alice', 'token', await stored())).toBe('new-value');
    else expect(await stored()).toBeUndefined();
    await api('/api/secrets/token', 'PUT', { value: 'even-newer' });
    expect(await api('/api/secrets/token/rotate', 'POST', undefined, headers)).toEqual(result);
  });
}

it('refunds recovery when the active key changed without starting a different rotation', async () => {
  const { api, env, original, stored } = await setup();
  await rpc(env.ACCOUNTS, 'alice', 'begin-secret-rotation', { name: 'token', id: 'key-changed' });
  env.SECRETS_KEYRING = JSON.stringify({ active: 'v1', keys: { v1: 'old-master', v2: 'new-master' } });
  const headers = { 'Idempotency-Key': 'key-changed' };
  const result = await api('/api/secrets/token/rotate', 'POST', undefined, headers);
  expect(result).toMatchObject({ status: 409, code: 'secret_rotation_failed', cost_microdollars: 0 });
  expect(await stored()).toEqual(original);
  expect((await rpc(env.ACCOUNTS, 'alice', 'account')).held_microdollars).toBe(0);
  env.SECRETS_KEYRING = JSON.stringify({ active: 'v2', keys: { v1: 'old-master', v2: 'new-master' } });
  expect(await api('/api/secrets/token/rotate', 'POST', undefined, headers)).toEqual(result);
});

it('persists no-op rotation receipts while dry runs quote current state', async () => {
  const { api, env, stored } = await setup();
  await api('/api/secrets/token/rotate', 'POST');
  const headers = { 'Idempotency-Key': 'no-op' };
  const result = await api('/api/secrets/token/rotate', 'POST', undefined, headers);
  expect(result).toMatchObject({ status: 200, needs_rotation: false, key_version: 'v2', cost_microdollars: 0 });
  env.SECRETS_KEYRING = JSON.stringify({ active: 'v3', keys: { v2: 'new-master', v3: 'third-master' } });
  const storage = env.ACCOUNTS.get('alice').storage;
  env.ACCOUNTS.objects.set('alice', new AccountDO({ storage }, env));
  expect(await api('/api/secrets/token/rotate', 'POST', undefined, headers)).toEqual(result);
  expect((await stored()).key_version).toBe('v2');
  expect(await api('/api/secrets/token/rotate?dry_run=1', 'POST', undefined, headers)).toMatchObject({ status: 200, needs_rotation: true, key_version: 'v3', quote_microdollars: 100, cost_microdollars: 0 });
  expect((await api('/api/secrets/other/rotate', 'POST', undefined, headers)).code).toBe('idempotency_conflict');
  await api('/api/secrets/token', 'DELETE');
  expect(await api('/api/secrets/token/rotate', 'POST', undefined, headers)).toEqual(result);
});

it('concurrent retries share a single rotation receipt, charge and audit entry', async () => {
  const { api, env, original, stored } = await setup();
  const headers = { 'Idempotency-Key': 'concurrent' };
  const results = await Promise.all(Array.from({ length: 3 }, () => api('/api/secrets/token/rotate', 'POST', undefined, headers)));
  expect(results[0]).toMatchObject({ status: 200, rotated: true, cost_microdollars: 100 });
  expect(results.every(result => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
  expect(await stored()).toMatchObject({ key_version: 'v2', fingerprint: original.fingerprint });
  const audit = await rpc(env.ACCOUNTS, 'alice', 'list', { prefix: 'audit:' });
  expect(audit.items.filter(item => item.kind === 'rotate_secret')).toHaveLength(1);
  const ledger = await rpc(env.ACCOUNTS, 'alice', 'list', { prefix: 'ledger:' });
  expect(ledger.items.filter(item => item.id.startsWith('secret-rotation:'))).toHaveLength(1);
});

it('does not resume an expired rotation or overwrite its original ciphertext', async () => {
  const { api, env, stored, original } = await setup();
  await rpc(env.ACCOUNTS, 'alice', 'begin-secret-rotation', { name: 'token', id: 'expired-retry' });
  const storage = env.ACCOUNTS.get('alice').storage;
  const id = 'secret-rotation:session:expired-retry';
  await storage.transaction(async tx => putHold(tx, { ...await getHold(tx, id), expires_at: Date.now() - 1 }));
  expect(await api('/api/secrets/token/rotate', 'POST', undefined, { 'Idempotency-Key': 'expired-retry' })).toMatchObject({ status: 409, code: 'rotation_expired' });
  expect(await stored()).toEqual(original);
});
