import { COLLECTIONS, normalize, validateConfig, validateName } from '../services/definitions.js';
import { assert } from '../utils/errors.js';
import { encryptSecret, secretMetadata } from '../executor/secrets.js';
import { digest } from '../auth/crypto.js';
import { charge, funds } from './ledger.js';
import { price } from '../utils/pricing.js';
import { configDiff } from '../services/config.js';
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
/** Bind imports to the submitted document, never a diff recomputed on retry. */
export async function putConfig(tx, args, env) {
  const requestHash = await digest(JSON.stringify(args.config));
  const receiptKey = `config-import:${args.key_id || 'session'}:${args.id}`;
  if (!args.dry_run) {
    const prior = await tx.get(receiptKey);
    if (prior) { assert(prior.request_hash === requestHash, 'idempotency_conflict', 'Idempotency key used for a different import', 409); return prior.response; }
  }
  const operations = configDiff(await loadConfig(tx, true), args.config);
  if (operations.some(op => op.kind === 'secrets')) assert(args.can_delete_secrets, 'insufficient_scope', 'secrets:write is required to remove secrets', 403);
  // Use the existing mutation receipt for paid imports: this keeps the ordinary
  // write allowance and commits the original response with billing and settings.
  if (operations.length) return mutate(tx, { ...args, operations }, env, { requestHash, receiptKey, chargeId: receiptKey });
  const response = { changes: [], quote_microdollars: 0, cost_microdollars: 0, balance_microdollars: (await funds(tx)).balance_microdollars };
  // An empty import must also be final; replay must not remove definitions that
  // someone created later. Quotes never consume the caller's idempotency key.
  if (!args.dry_run) await tx.put(receiptKey, { request_hash: requestHash, response });
  return response;
}
/** Toggle only enabled, preserving settings edited before this transaction. */
export async function toggleJob(tx, args, env) {
  const requestHash = await digest(JSON.stringify({ name: args.name, enabled: args.enabled }));
  const receiptKey = `job-toggle:${args.key_id || 'session'}:${args.id}`;
  if (!args.dry_run) {
    const prior = await tx.get(receiptKey);
    if (prior) { assert(prior.request_hash === requestHash, 'idempotency_conflict', 'Idempotency key used for a different job toggle', 409); return prior.response; }
  }
  const job = await tx.get(`def:jobs:${args.name}`);
  assert(job, 'not_found', 'Job not found', 404);
  return mutate(tx, { ...args, operations: [{ kind: 'jobs', name: args.name, value: { ...job, enabled: args.enabled } }] }, env, { requestHash, receiptKey, chargeId: receiptKey });
}
/** Validate, quote and atomically bill a definition batch; dry runs write nothing. */
export async function mutate(tx, args, env, receipt = {}) {
  assert(Array.isArray(args.operations) && args.operations.length > 0 && args.operations.length <= 400, 'invalid_changes', 'Expected 1–400 changes');
  const requestHash = receipt.requestHash || await digest(JSON.stringify(args.operations));
  const receiptKey = receipt.receiptKey || `idempotency:${args.key_id || 'session'}:${args.id}`;
  const prior = !args.dry_run && await tx.get(receiptKey);
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
  await charge(tx, { id: receipt.chargeId || `change:${args.id}:${args.key_id || 'session'}`, amount: quote, kind: 'change', ...await keyBudget(tx, args.key_id) });
  for (const operation of args.operations) {
    const { kind, name } = operation;
    if (kind === 'jobs') await tx.put(`job-index:${name}`, { name, account: args.account, updated_at: Date.now() });
    if (operation.delete) await tx.delete(`def:${kind}:${name}`);
    else await tx.put(`def:${kind}:${name}`, config[kind][name]);
    // Only explicit job edits change scheduling state. Reservations load the
    // current action, and public reads derive its quote without rewriting jobs.
    if (kind === 'jobs') await tx.put(`sync:${name}`, { name, account: args.account, version: crypto.randomUUID() });
  }
  await tx.put(`audit:${Date.now()}:${receipt.chargeId || args.id}`, { id: receipt.chargeId || args.id, changes, created_at: Date.now(), key_id: args.key_id || null });
  const result = { changes, quote_microdollars: quote, cost_microdollars: quote, balance_microdollars: balance_microdollars - quote };
  await tx.put(receiptKey, { request_hash: requestHash, response: result });
  if (changes.some(change => change.kind === 'jobs')) {
    const next = Date.now() + 1000; const alarm = await tx.getAlarm();
    // Non-job definitions have no scheduling outbox. Explicit job edits need a
    // wakeup, but must not postpone an earlier prepaid hold's expiry.
    if (alarm === null || alarm > next) await tx.setAlarm(next);
  }
  return result;
}
