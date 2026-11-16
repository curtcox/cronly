import { it, expect, vi } from 'vitest';
import { executeJavaScript, SANDBOX_WRAPPER } from './javascript.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { price, PRICES } from '../utils/pricing.js';
it('loads a content-addressed isolate with no network and only the gateway capability', async () => {
  let code; let limits;
  const env = { TOKEN_SIGNING_KEY: 'test', LOADER: { get: vi.fn((id, callback) => ({ getEntrypoint(_name, options) { limits = options.limits; return { async fetch() { code = await callback(); return Response.json({ status: 'success', console: 'private-token', value_text: 'ok' }); } }; } })) } };
  const gateway = {}; const ctx = { exports: { OutboundGateway: vi.fn(() => gateway) } };
  const action = { type: 'javascript', source: 'export default async () => 1', cpu_ms: 100, subrequests: 5 };
  const context = { account: { id: 'a' }, job: { name: 'j' }, run: { id: 'r' } };
  const result = await executeJavaScript({ action, vars: {}, input: {} }, context, env, ctx, { token: 'private-token' });
  expect(code.globalOutbound).toBe(null); expect(code.env).toEqual({ GATEWAY: gateway }); expect(code.modules['wrapper.js']).toBe(SANDBOX_WRAPPER);
  expect(limits).toEqual({ cpuMs: 100, subRequests: 6 }); expect(result.console).toBe('«secret:token»');
});
it('reserves daily activation before loading and releases it on later invocations', async () => {
  const env = { ENVIRONMENT: 'local' }; env.ACCOUNTS = namespace(AccountDO, env); const call = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await call('init', { account: 'a' }); await call('deposit', { id: 'd', amount: 100000 });
  const action = { type: 'javascript', source: 'export default () => 1', cpu_ms: 10, subrequests: 1 };
  await call('mutate', { account: 'a', id: 'defs', operations: [{ kind: 'actions', name: 'js', value: action }, { kind: 'jobs', name: 'j', value: { action: 'js', cron: null, overlap: 'allow' } }] });
  for (const id of ['r1', 'r2']) {
    await call('prepare-run', { id, name: 'j', input: {}, trigger: 'manual', retry: id === 'r2' });
    const execution = await call('claim-run', { id });
    expect(execution.actual_price).toBe(price('run', action) - (id === 'r2' ? PRICES.jsActivation : 0));
    await call('gateway-request', { id, host: 'example.com' });
    await expect(call('gateway-request', { id, host: 'example.com' })).rejects.toMatchObject({ code: 'subrequest_limit' });
    await call('settle', { id, actual: price('run', action) });
  }
});
