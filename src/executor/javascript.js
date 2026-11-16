import { assert, readJson } from '../utils/errors.js';
import { digest, signToken } from '../auth/crypto.js';
import { redact } from './secrets.js';

// User code is imported only after the log sink is locked. This wrapper never receives
// platform secrets; its env contains just the narrowly scoped outbound capability.
export const SANDBOX_WRAPPER = `
const stringify = JSON.stringify.bind(JSON);
const parse = JSON.parse.bind(JSON);
let log = '';
const capture = (...args) => { if (log.length < 6000) log += args.map(x => typeof x === 'string' ? x : stringify(x)).join(' ').slice(0, 6000 - log.length) + '\\n'; };
Object.defineProperty(globalThis, 'console', { value: Object.freeze(Object.fromEntries(['log','info','warn','error','debug','trace','dir','table','assert','time','timeEnd','count'].map(name => [name, capture]))), writable: false, configurable: false });
export default { async fetch(request, env) {
  log = '';
  const input = parse(await request.text());
  const gateway = env.GATEWAY;
  const capability = input.capability;
  const context = { ...input.context, fetch: async (url, options) => {
    const req = new Request(url, options); const headers = new Headers(req.headers);
    headers.set('x-cronly-capability', capability);
    return gateway.fetch(new Request(req, { headers, redirect: 'manual' }));
  } };
  try {
    const { default: run } = await import('./user.js');
    if (typeof run !== 'function') throw new Error('Default export must be a function');
    const result = await run(context);
    return new Response(stringify({ status: 'success', value_text: stringify(result ?? null).slice(0, 6000), console: log }), { headers: { 'content-type': 'application/json' } });
  } catch { return new Response(stringify({ status: 'failure', error: 'JavaScript action failed', console: log })); }
} };
`;
/** Use a content-addressed isolate, enforced limits and zero native network access. */
export async function executeJavaScript(execution, context, env, ctx, secrets) {
  assert(env.LOADER && ctx?.exports?.OutboundGateway, 'sandbox_unavailable', 'Sandbox is not configured', 503);
  const action = execution.action; const version = await digest(JSON.stringify([SANDBOX_WRAPPER, action]));
  const gateway = ctx.exports.OutboundGateway({ props: { account: context.account.id } });
  const sandbox = env.LOADER.get(`${context.account.id}:${version}`, async () => ({
    compatibilityDate: '2026-10-30', mainModule: 'wrapper.js', modules: { 'wrapper.js': SANDBOX_WRAPPER, 'user.js': action.source },
    env: { GATEWAY: gateway }, globalOutbound: null, limits: { cpuMs: action.cpu_ms, subRequests: action.subrequests + 1 }
  }));
  const capability = await signToken('eg_', { account: context.account.id, id: context.run.id }, env.TOKEN_SIGNING_KEY);
  const response = await sandbox.getEntrypoint(null, { limits: { cpuMs: action.cpu_ms, subRequests: action.subrequests + 1 } }).fetch(new Request('https://sandbox/run', { method: 'POST', body: JSON.stringify({ capability, context: { vars: execution.vars, secrets, run: context.run, input: execution.input, job: context.job, account: context.account } }), signal: AbortSignal.timeout(60000) }));
  const output = await readJson(response, 131072);
  assert(['success', 'failure'].includes(output.status), 'invalid_sandbox_result', 'Invalid sandbox result', 502);
  return { status: output.status, error: output.error ? 'JavaScript action failed' : undefined, return_value: redact(String(output.value_text || ''), secrets).slice(0, 8000), console: redact(String(output.console || ''), secrets).slice(0, 8000), cpu_limit_ms: action.cpu_ms, subrequest_limit: action.subrequests };
}
