import { afterEach, expect, it, vi } from 'vitest';
import { OutboundGateway } from './platform.js';
import { AccountDO } from './durable-objects/account-do.js';
import { namespace } from '../test-utils/storage.js';
import { rpc } from './utils/rpc.js';
import { signToken } from './auth/crypto.js';
import { guardedFetch } from './executor/http.js';

vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shares canonical destination limits between HTTP and sandbox egress after restart', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const env = { ENVIRONMENT: 'local', TOKEN_SIGNING_KEY: 'test', OUTBOUND_FETCH: vi.fn(async () => new Response(null)) };
  env.ACCOUNTS = namespace(AccountDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'd', amount: 100000 });
  await account('mutate', { account: 'a', id: 'defs', operations: [
    { kind: 'actions', name: 'js', value: { type: 'javascript', source: 'export default () => 1', cpu_ms: 10, subrequests: 2 } },
    { kind: 'jobs', name: 'j', value: { action: 'js', cron: null } }
  ] });
  await account('prepare-run', { id: 'r', name: 'j', input: {}, trigger: 'manual' });
  await account('claim-run', { id: 'r' });
  for (let index = 0; index < 59; index++) await guardedFetch(new Request('https://example.com/'), env, 'a');
  const fetch = vi.fn(async () => new Response('ok')); vi.stubGlobal('fetch', fetch);
  const gateway = new OutboundGateway(); gateway.env = env; gateway.ctx = { props: { account: 'a' } };
  const capability = await signToken('eg_', { account: 'a', id: 'r' }, env.TOKEN_SIGNING_KEY);
  const request = host => new Request(`https://${host}/`, { headers: { 'x-cronly-capability': capability, Authorization: 'customer-token' } });
  expect((await gateway.fetch(request('EXAMPLE.com.'))).status).toBe(200);
  expect(fetch.mock.calls[0][0].url).toBe('https://example.com./');
  expect(fetch.mock.calls[0][0].headers.has('x-cronly-capability')).toBe(false);
  expect(fetch.mock.calls[0][0].headers.get('Authorization')).toBe('customer-token');
  const storage = env.ACCOUNTS.get('a').storage;
  env.ACCOUNTS.objects.set('a', new AccountDO({ storage }, env));
  for (const host of ['example.com', 'example.com.']) {
    const refusal = await gateway.fetch(request(host));
    expect(refusal.status).toBe(429);
    expect(await refusal.json()).toMatchObject({ code: 'destination_rate_limit' });
    await expect(guardedFetch(request(host), env, 'a')).rejects.toMatchObject({ status: 429 });
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await storage.get('rate:destination:example.com')).toMatchObject({ count: 60 });
  expect(await storage.get('rate:destination:example.com.')).toBeUndefined();
  // A rate refusal must not consume the remaining paid sandbox subrequest.
  expect((await gateway.fetch(request('other.example.com'))).status).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(2);
});
