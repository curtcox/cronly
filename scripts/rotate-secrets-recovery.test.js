import { expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { AccountDO } from '../src/durable-objects/account-do.js';
import { namespace } from '../test-utils/storage.js';
import { rpc } from '../src/utils/rpc.js';
import { decryptSecret } from '../src/executor/secrets.js';
import { PRICES } from '../src/utils/pricing.js';
import { rotateAccountSecrets } from './rotate-secrets.mjs';

for (const failure of ['begin-reply', 'finish-write', 'finish-reply']) {
  it(`finishes CLI rotation after a lost ${failure} and cold restart without another charge`, async () => {
    const env = { ENVIRONMENT: 'local', TOKEN_SIGNING_KEY: 'signing', SECRETS_MASTER_KEY: 'old-master' };
    env.ACCOUNTS = namespace(AccountDO, env);
    const api = async (path, body) => {
      const response = await worker.fetch(new Request(`https://cronly.org${path}`, { method: path.includes('/secrets/') ? 'PUT' : 'POST', headers: { Authorization: 'LocalDev alice' }, body: JSON.stringify(body) }), env);
      expect(response.status).toBe(200); return response.json();
    };
    await api('/api/dev/deposit', { amount_microdollars: 10000 });
    await api('/api/secrets/token', { value: 'private-token' });
    const key = await api('/api/keys', { scopes: ['read', 'secrets:write'], daily_spend_microdollars: PRICES.read + PRICES.change });
    env.SECRETS_KEYRING = JSON.stringify({ active: 'v2', keys: { v1: 'old-master', v2: 'new-master' } });
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
        const { op, dry_run } = await request.clone().json(); const response = await fetch(request);
        if (!dry_run && op === (failure === 'begin-reply' ? 'begin-secret-rotation' : 'finish-secret-rotation') && response.ok) throw new Error('reply lost');
        return response;
      });
    }
    const log = vi.fn();
    const pause = vi.fn(async () => {
      fault.mockRestore();
      env.ACCOUNTS.objects.set('alice', new AccountDO({ storage }, env));
    });
    const result = await rotateAccountSecrets({ origin: 'https://cronly.org', token: key.token, apply: true, log, pause, request: (url, options) => worker.fetch(new Request(url, options), env) });
    expect(result).toEqual({ pending: 1, rotated: 1, quote_microdollars: PRICES.change, cost_microdollars: PRICES.read + PRICES.change });
    expect(pause).toHaveBeenCalledExactlyOnceWith(1000);
    expect(await rpc(env.ACCOUNTS, 'alice', 'account')).toMatchObject({ balance_microdollars: before.balance_microdollars - result.cost_microdollars, held_microdollars: 0 });
    const config = await rpc(env.ACCOUNTS, 'alice', 'config', { public_view: false });
    expect(config.secrets.token.key_version).toBe('v2');
    expect(await decryptSecret(env, 'alice', 'token', config.secrets.token)).toBe('private-token');
    const ledger = await rpc(env.ACCOUNTS, 'alice', 'list', { prefix: 'ledger:' });
    expect(ledger.items.filter(row => row.id.startsWith('secret-rotation:'))).toHaveLength(1);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-token|old-master|new-master|crk_/);
  });
}
