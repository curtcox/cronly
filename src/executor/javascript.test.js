import { it, expect, vi } from 'vitest';
import { executeJavaScript, SANDBOX_WRAPPER } from './javascript.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { price, PRICES } from '../utils/pricing.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createContext, runInContext } from 'node:vm';
import { createRedactor } from './redaction.js';
import { javascriptVersion } from './javascript.js';

// Execute the real wrapper in a separate global so locking console cannot affect
// Vitest. Only module loading is substituted; sink/serialization code is unchanged.
function wrapper(source) {
  const sandbox = createContext({ AsyncLocalStorage, Request, Response, TextEncoder, TextDecoder, btoa });
  sandbox.loadUser = () => runInContext(`(async () => { ${source} })()`, sandbox);
  const script = SANDBOX_WRAPPER
    .replace("import { AsyncLocalStorage } from 'node:async_hooks';", '')
    .replace("import { createRedactor } from './redaction.js';", `const createRedactor = ${createRedactor.toString()};`)
    .replace('export default ', 'const handler = ')
    .replace("await import('./user.js')", 'await loadUser()');
  const handler = runInContext(`${script}\n;handler;`, sandbox);
  return async secrets => (await handler.fetch(new Request('https://sandbox/run', { method: 'POST', body: JSON.stringify({ context: { secrets }, capability: 'test' }) }), {})).json();
}

for (const format of ['raw', 'object', 'url', 'base64']) it(`redacts ${format} console and return values before the sandbox cutoff`, async () => {
  const token = `PRIVATE-START-"\\\n${'a'.repeat(8100)}-PRIVATE-END`;
  const value = { raw: 'ctx.secrets.token', object: '{ token: ctx.secrets.token }', url: 'encodeURIComponent(ctx.secrets.token)', base64: 'btoa(ctx.secrets.token)' }[format];
  const execute = wrapper(`return { default: async ctx => { const value = ${value}; console.log(value); return value; } };`);
  const result = await execute({ token });
  expect(result.status).toBe('success');
  expect(result.console).toContain('«secret:token»');
  expect(result.value_text).toContain('«secret:token»');
  expect(JSON.stringify(result)).not.toContain('PRIVATE-START');
  expect(result.console.length).toBeLessThan(100);
  expect(result.value_text.length).toBeLessThan(100);
});

it('keeps secrets crossing the remaining console budget out of both output fields', async () => {
  const execute = wrapper('return { default: async ctx => { console.log("x".repeat(5980)); console.log(ctx.secrets.token); return "y".repeat(5980) + ctx.secrets.token; } };');
  const result = await execute({ token: 'PRIVATE-START-' + 'z'.repeat(100) });
  expect(result.status).toBe('success');
  expect(JSON.stringify(result)).not.toContain('PRIVATE-START');
  expect(result.console.length).toBeLessThanOrEqual(6001);
  expect(result.value_text.length).toBeLessThanOrEqual(6000);
});

it('redacts logs preceding action failure and isolates concurrent secret sets', async () => {
  const execute = wrapper('return { default: async ctx => { await Promise.resolve(); console.error({ token: ctx.secrets.token }); throw new Error(ctx.secrets.token); } };');
  const results = await Promise.all(['first-"value"\\path', 'second-"value"\\path'].map(token => execute({ token })));
  for (const result of results) {
    expect(result).toMatchObject({ status: 'failure', error: 'JavaScript action failed', console: '{"token":"«secret:token»"}\n' });
  }
});
it('loads a content-addressed isolate with no network and only the gateway capability', async () => {
  let code; let limits;
  const env = { TOKEN_SIGNING_KEY: 'test', LOADER: { get: vi.fn((id, callback) => ({ getEntrypoint(_name, options) { limits = options.limits; return { async fetch() { code = await callback(); return Response.json({ status: 'success', console: 'private-token', value_text: 'ok' }); } }; } })) } };
  const gateway = {}; const ctx = { exports: { OutboundGateway: vi.fn(() => gateway) } };
  const action = { type: 'javascript', source: 'export default async () => 1', cpu_ms: 100, subrequests: 5 };
  const context = { account: { id: 'a' }, job: { name: 'j' }, run: { id: 'r' } };
  const result = await executeJavaScript({ action, vars: {}, input: {} }, context, env, ctx, { token: 'private-token' });
  expect(code.globalOutbound).toBe(null); expect(code.env).toEqual({ GATEWAY: gateway }); expect(code.modules['wrapper.js']).toBe(SANDBOX_WRAPPER);
  expect(code.modules['redaction.js']).toBe(`export ${createRedactor.toString()}`);
  expect(env.LOADER.get.mock.calls[0][0]).toBe(`a:${await javascriptVersion(action)}`);
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
