import { expect, it, vi } from 'vitest';
import { executeHttp, guardedFetch } from './http.js';
import { normalize } from '../services/definitions.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { namespace } from '../../test-utils/storage.js';

it('limits dotted and undotted HTTP destinations together across a cold restart', async () => {
  const env = { OUTBOUND_FETCH: vi.fn(async () => new Response(null)) };
  env.ACCOUNTS = namespace(AccountDO, env);
  for (let index = 0; index < 60; index++) {
    await guardedFetch(new Request(`https://example.com${index % 2 ? '.' : ''}/`), env, 'a');
  }
  const storage = env.ACCOUNTS.get('a').storage;
  expect(await storage.get('rate:destination:example.com')).toMatchObject({ count: 60 });
  expect(await storage.get('rate:destination:example.com.')).toBeUndefined();
  env.ACCOUNTS.objects.set('a', new AccountDO({ storage }, env));
  for (const host of ['example.com', 'example.com.']) {
    await expect(guardedFetch(new Request(`https://${host}/`), env, 'a')).rejects.toMatchObject({ status: 429 });
  }
  expect(env.OUTBOUND_FETCH).toHaveBeenCalledTimes(60);
});

it('redacts JSON-escaped HTTP request and response fields before truncating logs', async () => {
  const token = 'test-"quoted"\\path\n\t雪';
  const header = 'test-"header"\\path';
  const secrets = { token, header };
  const action = normalize('actions', { method: 'POST', url: 'https://example.com', headers: { Authorization: '{{secret.header}}' }, body: 'x'.repeat(3900) + '{{secret.token}}' });
  const env = {
    ACCOUNTS: { idFromName: id => id, get: () => ({ fetch: async () => Response.json({}) }) },
    OUTBOUND_FETCH: vi.fn(async () => new Response(JSON.stringify({ token }), { headers: { 'X-Echo': header } }))
  };
  const result = await executeHttp({ action }, { secret: secrets, account: { id: 'a' } }, env, secrets);
  expect(result.status).toBe('success');
  expect(result.response_excerpt).toBe('{"token":"«secret:token»"}');
  expect(result.response_headers).toContain('«secret:header»');
  expect(result.request).toContain('«secret:header»');
  expect(result.request).toContain('«secret:token»');
  const serialized = JSON.stringify(result);
  for (const prefix of ['test-', 'quoted', '\\\\path']) expect(serialized).not.toContain(prefix);
  const request = env.OUTBOUND_FETCH.mock.calls[0][0];
  expect(await request.text()).toBe(action.body.replace('{{secret.token}}', token));
  expect(request.headers.get('Authorization')).toBe(header);
});
