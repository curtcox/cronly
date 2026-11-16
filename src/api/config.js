import { digest } from '../auth/crypto.js';
import { assert, readJson } from '../utils/errors.js';
import { rpc } from '../utils/rpc.js';
import { normalize, COLLECTIONS } from '../services/definitions.js';
/** Build a concrete diff; secrets export as metadata and must be set separately. */
export function configDiff(current, desired) {
  assert(desired && typeof desired === 'object' && !Array.isArray(desired), 'invalid_config', 'Expected a config object');
  const changes = [];
  for (const kind of COLLECTIONS) {
    const collection = desired[kind] ?? current[kind];
    assert(collection && typeof collection === 'object' && !Array.isArray(collection), 'invalid_config', `Expected ${kind} object`);
    for (const name of Object.keys(current[kind])) if (!Object.hasOwn(collection, name)) changes.push({ kind, name, delete: true });
    for (const [name, value] of Object.entries(collection)) {
      if (kind === 'secrets') { assert(Object.hasOwn(current.secrets, name), 'write_only_secret', 'Set new secret values through /api/secrets/{name}'); continue; }
      const normalized = normalize(kind, kind === 'variables' ? { value } : value);
      const prior = kind === 'jobs' && current[kind][name] ? { ...current[kind][name] } : current[kind][name];
      if (kind === 'jobs' && prior) delete prior.max_run_microdollars;
      if (JSON.stringify(prior) !== JSON.stringify(normalized)) changes.push({ kind, name, value: kind === 'variables' ? { value } : value });
    }
  }
  return changes;
}
/** Apply the complete account diff in one ledger/definition transaction. */
export async function putConfig(request, env, auth) {
  const body = await readJson(request, 1048576); const current = await rpc(env.ACCOUNTS, auth.account, 'config');
  const operations = configDiff(current, body.config || body);
  if (operations.some(op => op.kind === 'secrets')) assert(auth.session || auth.scopes.includes('secrets:write'), 'insufficient_scope', 'secrets:write is required to remove secrets', 403);
  if (!operations.length) return { changes: [], quote_microdollars: 0, cost_microdollars: 0 };
  const result = await rpc(env.ACCOUNTS, auth.account, 'mutate', { account: auth.account, key_id: auth.key_id, expected_config_hash: await digest(JSON.stringify(current)), id: request.headers.get('Idempotency-Key') || crypto.randomUUID(), dry_run: new URL(request.url).searchParams.get('dry_run') === '1', operations });
  try { await rpc(env.ACCOUNTS, auth.account, 'sync-jobs'); } catch { /* The durable outbox handles recovery. */ }
  return result;
}
