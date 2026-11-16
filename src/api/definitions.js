import { rpc } from '../utils/rpc.js';
import { assert, readJson } from '../utils/errors.js';
import { digest, signToken } from '../auth/crypto.js';
import { validateName } from '../services/definitions.js';
/** Read or atomically update named definitions; metadata is the only secret read surface. */
export async function definitions(route, request, env, auth) {
  const { kind, name } = route.params; validateName(name);
  if (request.method === 'GET') {
    const config = await rpc(env.ACCOUNTS, auth.account, 'config');
    assert(Object.hasOwn(config[kind], name), 'not_found', 'Definition not found', 404);
    return { name, value: config[kind][name] };
  }
  const value = request.method === 'DELETE' ? undefined : await readJson(request);
  const result = await rpc(env.ACCOUNTS, auth.account, 'mutate', {
    account: auth.account, key_id: auth.key_id, id: request.headers.get('Idempotency-Key') || crypto.randomUUID(), dry_run: new URL(request.url).searchParams.get('dry_run') === '1',
    operations: [{ kind, name, value, delete: request.method === 'DELETE' }]
  });
  if (!new URL(request.url).searchParams.has('dry_run')) {
    // The durable outbox retries if this best-effort immediate sync is interrupted.
    try { await rpc(env.ACCOUNTS, auth.account, 'sync-jobs'); } catch { /* Alarm drains the outbox. */ }
  }
  return result;
}
/** API keys are self-routing signed credentials; only hashes are persisted. */
export async function keys(route, request, env, auth) {
  if (request.method === 'GET') {
    const result = await rpc(env.ACCOUNTS, auth.account, 'list', { prefix: 'key:' });
    return { items: result.items.map(({ hash: _hash, request_hash: _requestHash, ...key }) => key) };
  }
  const dry_run = new URL(request.url).searchParams.get('dry_run') === '1';
  if (request.method === 'DELETE') return rpc(env.ACCOUNTS, auth.account, 'revoke-key', { id: route.params.id, dry_run });
  const body = await readJson(request); const idempotency = request.headers.get('Idempotency-Key') || crypto.randomUUID();
  const id = (await digest(`${auth.account}:${idempotency}`)).slice(0, 32);
  const token = await signToken('crk_', { account: auth.account, id }, env.TOKEN_SIGNING_KEY);
  const result = await rpc(env.ACCOUNTS, auth.account, 'create-key', { id, hash: await digest(token), request_hash: await digest(JSON.stringify(body)), name: String(body.name || '').slice(0, 64), scopes: body.scopes, daily_spend_microdollars: body.daily_spend_microdollars ?? null, expires_at: body.expires_at ? Date.parse(body.expires_at) : Date.now() + 90 * 86400000, dry_run });
  return { ...result, token: dry_run ? undefined : token };
}
