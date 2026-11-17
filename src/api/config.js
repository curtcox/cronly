import { readJson } from '../utils/errors.js';
import { rpc } from '../utils/rpc.js';
/** Apply the complete account diff in one ledger/definition transaction. */
export async function putConfig(request, env, auth) {
  const body = await readJson(request, 1048576); const dry_run = new URL(request.url).searchParams.get('dry_run') === '1';
  const result = await rpc(env.ACCOUNTS, auth.account, 'put-config', {
    account: auth.account, key_id: auth.key_id, config: body?.config || body,
    can_delete_secrets: auth.session || auth.scopes.includes('secrets:write'),
    id: request.headers.get('Idempotency-Key') || crypto.randomUUID(), dry_run
  });
  if (!dry_run) {
    try { await rpc(env.ACCOUNTS, auth.account, 'sync-jobs'); } catch { /* The durable outbox handles recovery. */ }
  }
  return result;
}
