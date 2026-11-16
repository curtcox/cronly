import { PRICES } from '../utils/pricing.js';
import { it, expect } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { namespace } from '../../test-utils/storage.js';
import { decryptSecret } from '../executor/secrets.js';
import { rpc } from '../utils/rpc.js';
function setup() {
  const env = { ENVIRONMENT: 'local', TOKEN_SIGNING_KEY: 'test', SECRETS_MASTER_KEY: 'test-master' }; env.ACCOUNTS = namespace(AccountDO, env);
  const api = async (path, method = 'GET', body, extra = {}) => {
    const response = await worker.fetch(new Request(`https://cronly.org${path}`, { method, body: body && JSON.stringify(body), headers: { Authorization: 'LocalDev alice', ...extra } }), env);
    return { status: response.status, ...await response.json() };
  };
  return { env, api };
}
it('dry runs validate references, charge nothing, and writes are idempotent', async () => {
  const { api } = setup();
  await api('/api/dev/deposit', 'POST', { amount_microdollars: 1000 });
  expect(await api('/api/variables/base?dry_run=1', 'PUT', { value: 'https://example.com' })).toMatchObject({ quote_microdollars: 100, cost_microdollars: 0, balance_microdollars: 1000 });
  expect((await api('/api/variables/base')).status).toBe(404);
  const headers = { 'Idempotency-Key': 'put-base' };
  await api('/api/variables/base', 'PUT', { value: 'https://example.com' }, headers);
  expect((await api('/api/variables/base', 'PUT', { value: 'https://example.com' }, headers)).balance_microdollars).toBe(900);
  expect((await api('/api/variables/base', 'PUT', { value: 'different' }, headers)).status).toBe(409);
  expect((await api('/api/actions/ping', 'PUT', { url: '{{var.missing}}' })).status).toBe(400);
  expect((await api('/api/actions/ping', 'PUT', { url: '{{var.base}}/ping' })).status).toBe(200);
  expect((await api('/api/variables/base', 'DELETE')).status).toBe(400);
});
it('encrypts write-only secrets and binds ciphertext to account and name', async () => {
  const { api, env } = setup(); await api('/api/dev/deposit', 'POST', { amount_microdollars: 1000 });
  await api('/api/secrets/token', 'PUT', { value: 'secret-value' });
  const publicResult = await api('/api/secrets/token');
  expect(JSON.stringify(publicResult)).not.toContain('secret-value'); expect(publicResult.value).not.toHaveProperty('ciphertext');
  const config = await rpc(env.ACCOUNTS, 'alice', 'config', { public_view: false });
  expect(await decryptSecret('test-master', 'alice', 'token', config.secrets.token)).toBe('secret-value');
  await expect(decryptSecret('test-master', 'bob', 'token', config.secrets.token)).rejects.toThrow();
});
it('enforces scoped keys and includes read spending in daily caps', async () => {
  const { api, env } = setup(); await api('/api/dev/deposit', 'POST', { amount_microdollars: 1000 });
  const key = await api('/api/keys', 'POST', { scopes: ['read'], daily_spend_microdollars: 20 });
  expect(key.token).toMatch(/^crk_/);
  const request = (path, method = 'GET') => worker.fetch(new Request(`https://cronly.org${path}`, { method, headers: { Authorization: `ApiKey ${key.token}` } }), env);
  expect((await request('/api/account')).status).toBe(200);
  expect((await request('/api/account?dry_run=1')).status).toBe(402);
  expect((await request('/api/variables/x', 'PUT')).status).toBe(403);
  await api(`/api/keys/${key.id}`, 'DELETE'); expect((await request('/api/account')).status).toBe(401);
});

it('quotes current prices for persisted jobs while honoring an older queued hold', async () => {
  const { api, env } = setup();
  await api('/api/dev/deposit', 'POST', { amount_microdollars: 1000 });
  await api('/api/actions/ping', 'PUT', { url: 'https://example.com' });
  const storage = env.ACCOUNTS.get('alice').storage;
  await storage.put('def:jobs:j', { action: 'ping', cron: null, enabled: true, budget: {}, max_run_microdollars: 60 });
  await rpc(env.ACCOUNTS, 'alice', 'reserve', { id: 'old', amount: 60, kind: 'run', job: 'j' });
  expect((await api('/api/jobs/j')).value.max_run_microdollars).toBe(PRICES.run);
  expect((await api('/api/quote?op=run&job=j')).quote_microdollars).toBe(PRICES.run);
  expect(await rpc(env.ACCOUNTS, 'alice', 'settle', { id: 'old', actual: PRICES.run })).toMatchObject({ charged: 60 });
  // A hold above today's quote also keeps its original maximum.
  await rpc(env.ACCOUNTS, 'alice', 'reserve', { id: 'higher', amount: 100, kind: 'run', job: 'j' });
  expect(await rpc(env.ACCOUNTS, 'alice', 'settle', { id: 'higher', actual: 100 })).toMatchObject({ charged: 100 });
});
