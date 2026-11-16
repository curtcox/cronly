import { COLLECTIONS, normalize, validateConfig, validateName } from '../services/definitions.js';
import { assert } from '../utils/errors.js';
import { encryptSecret, secretMetadata } from '../executor/secrets.js';
import { digest } from '../auth/crypto.js';
import { reserve, settle, funds } from './ledger.js';
import { price } from '../utils/pricing.js';
/** Assemble the bounded account graph from individually stored definitions. */
export async function loadConfig(tx, publicView = false) {
  const config = {};
  for (const kind of COLLECTIONS) {
    config[kind] = Object.fromEntries([...(await tx.list({ prefix: `def:${kind}:` }))].map(([key, value]) => [key.slice(`def:${kind}:`.length), kind === 'secrets' && publicView ? secretMetadata(value) : value]));
  }
  // Quotes follow current prices even when a definition predates a price change.
  // Queued executions keep their already-reserved amount in the hold instead.
  for (const job of Object.values(config.jobs)) job.max_run_microdollars = price('run', config.actions[job.action]);
  return config;
}
/** Apply the same budget restrictions to every operation delegated through a key. */
export async function keyBudget(tx, id) {
  if (!id) return {};
  const key = await tx.get(`key:${id}`);
  assert(key && !key.revoked && key.expires_at > Date.now(), 'invalid_auth', 'API key revoked or expired', 401);
  return { key_id: id, key_budget: key.daily_spend_microdollars === null ? {} : { day: key.daily_spend_microdollars } };
}
/** Validate, quote and atomically bill a definition batch; dry runs write nothing. */
export async function mutate(tx, args, env) {
  assert(Array.isArray(args.operations) && args.operations.length > 0 && args.operations.length <= 400, 'invalid_changes', 'Expected 1–400 changes');
  const requestHash = await digest(JSON.stringify(args.operations));
  const receiptKey = `idempotency:${args.key_id || 'session'}:${args.id}`;
  const prior = await tx.get(receiptKey);
  if (prior) { assert(prior.request_hash === requestHash, 'idempotency_conflict', 'Idempotency key used for a different request', 409); return prior.response; }
  const config = await loadConfig(tx);
  if (args.expected_config_hash) assert(await digest(JSON.stringify(await loadConfig(tx, true))) === args.expected_config_hash, 'config_conflict', 'Configuration changed while preparing the import; retry its quote', 409);
  const changes = [];
  for (const operation of args.operations) {
    const { kind, name, delete: deleting, value } = operation;
    assert(COLLECTIONS.includes(kind), 'invalid_kind', 'Unknown definition kind'); validateName(name);
    if (deleting) {
      assert(Object.hasOwn(config[kind], name), 'not_found', `${kind}/${name} not found`, 404);
      delete config[kind][name];
    } else {
      const normalized = normalize(kind, value);
      config[kind][name] = kind === 'secrets' ? await encryptSecret(env, args.account, name, normalized) : normalized;
    }
    changes.push({ kind, name, operation: deleting ? 'delete' : 'put' });
  }
  for (const kind of COLLECTIONS) assert(Object.keys(config[kind]).length <= 100, 'definition_limit', `Maximum 100 ${kind}`);
  validateConfig(config, await tx.get('profile'));
  const quote = changes.length * price('change');
  const { balance_microdollars } = await funds(tx);
  if (args.dry_run) return { changes, quote_microdollars: quote, cost_microdollars: 0, balance_microdollars };
  const hold = await reserve(tx, { id: `change:${args.id}:${args.key_id || 'session'}`, amount: quote, kind: 'change', ...await keyBudget(tx, args.key_id) });
  for (const operation of args.operations) {
    const { kind, name } = operation;
    if (kind === 'jobs') await tx.put(`job-index:${name}`, { name, account: args.account, updated_at: Date.now() });
    if (operation.delete) await tx.delete(`def:${kind}:${name}`);
    else await tx.put(`def:${kind}:${name}`, config[kind][name]);
    // Job metadata is recalculated after action edits too.
    if (kind === 'jobs') await tx.put(`sync:${name}`, { name, account: args.account, version: crypto.randomUUID() });
  }
  if (args.operations.some(op => op.kind === 'actions')) for (const [name, job] of Object.entries(config.jobs)) {
    await tx.put(`def:jobs:${name}`, job); await tx.put(`sync:${name}`, { name, account: args.account, version: crypto.randomUUID() });
  }
  await tx.put(`audit:${Date.now()}:${args.id}`, { id: args.id, changes, created_at: Date.now(), key_id: args.key_id || null });
  await settle(tx, hold.id, quote);
  const result = { changes, quote_microdollars: quote, cost_microdollars: quote, balance_microdollars: balance_microdollars - quote };
  await tx.put(receiptKey, { request_hash: requestHash, response: result });
  await tx.setAlarm(Date.now() + 1000);
  return result;
}
