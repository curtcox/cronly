import { signToken, verifyToken, digest } from './crypto.js';
import { rpc } from '../utils/rpc.js';
import { assert, readJson } from '../utils/errors.js';
/** Manage signed job-only credentials; revocation state stays with the job. */
export async function triggers(route, request, env, auth) {
  const name = route.params.name; const config = await rpc(env.ACCOUNTS, auth.account, 'config');
  assert(config.jobs[name], 'not_found', 'Job not found', 404);
  if (request.method === 'GET') return rpc(env.JOBS, `${auth.account}:${name}`, 'triggers');
  const idempotency = request.headers.get('Idempotency-Key') || crypto.randomUUID();
  const id = route.params.id || (await digest(`${auth.account}:${name}:${idempotency}`)).slice(0, 32);
  const body = request.method === 'DELETE' ? {} : await readJson(request);
  const rate = body.rate_per_minute ?? 10;
  assert(Number.isInteger(rate) && rate >= 1 && rate <= 60, 'invalid_rate', 'Trigger rate must be 1–60 per minute');
  const result = await rpc(env.JOBS, `${auth.account}:${name}`, 'change-trigger', { id, rate, revoke: request.method === 'DELETE', key_id: auth.key_id, dry_run: new URL(request.url).searchParams.get('dry_run') === '1' });
  const token = request.method === 'DELETE' || new URL(request.url).searchParams.get('dry_run') === '1' ? undefined : await signToken('tk_', { account: auth.account, job: name, id }, env.TOKEN_SIGNING_KEY);
  return { ...result, token, url: token ? `${env.APP_ORIGIN}/hook/${token}` : undefined };
}
/** Authenticate a stateless route before visiting the job or parsing its input. */
export async function hook(route, request, env) {
  const token = await verifyToken(route.params.token, 'tk_', env.TOKEN_SIGNING_KEY);
  assert(token && typeof token.job === 'string', 'invalid_trigger', 'Invalid trigger token', 401);
  const input = request.method === 'POST' ? await readJson(request, 8192) : {};
  return rpc(env.JOBS, `${token.account}:${token.job}`, 'hook', { token_id: token.id, id: `${token.account}:${token.job}:webhook:${token.id}:${request.headers.get('Idempotency-Key') || crypto.randomUUID()}`, input, dry_run: new URL(request.url).searchParams.get('dry_run') === '1' });
}
