import { digest } from '../auth/crypto.js';
import { secretKeyring, secretMaster } from '../executor/secret-keys.js';
import { validateName } from '../services/definitions.js';
import { assert } from '../utils/errors.js';
import { price } from '../utils/pricing.js';
import { keyBudget } from './definitions.js';
import { funds, reserve, settle } from './ledger.js';

const rotationId = args => `secret-rotation:${args.key_id || 'session'}:${args.id}`;

/** Hold a normal change price before handing ciphertext to the rotation executor. */
export async function beginSecretRotation(tx, args, env) {
  validateName(args.name);
  const id = rotationId(args);
  const prior = await tx.get(id);
  if (prior && !args.dry_run) {
    assert(prior.name === args.name, 'idempotency_conflict', 'Idempotency key used for a different request', 409);
    if (prior.result) return { result: prior.result };
    const hold = await tx.get(`hold:${id}`);
    assert(hold && hold.expires_at > Date.now(), 'rotation_expired', 'Rotation expired; retry with a new idempotency key', 409);
    assert(false, 'rotation_in_progress', 'Rotation is already in progress', 409);
  }
  const record = await tx.get(`def:secrets:${args.name}`);
  assert(record, 'not_found', 'Secret not found', 404);
  const { active } = secretKeyring(env);
  secretMaster(env, record.version === 1 ? 'v1' : record.key_version);
  const needs_rotation = record.version !== 2 || record.key_version !== active;
  const quote = needs_rotation ? price('change') : 0;
  const { balance_microdollars } = await funds(tx);
  const response = { name: args.name, needs_rotation, key_version: active, quote_microdollars: quote, cost_microdollars: 0, balance_microdollars };
  if (args.dry_run || !needs_rotation) return { result: { response } };
  await reserve(tx, { id, amount: quote, kind: 'change', ...await keyBudget(tx, args.key_id) });
  await tx.put(id, { name: args.name, target_version: active, source_hash: await digest(JSON.stringify(record)) });
  return { record, target_version: active };
}

/** Compare the encrypted snapshot before replacing it; concurrent edits always win. */
export async function finishSecretRotation(tx, args, env) {
  const id = rotationId(args);
  const rotation = await tx.get(id);
  assert(rotation && rotation.name === args.name, 'not_found', 'Rotation not found', 404);
  if (rotation.result) return rotation.result;
  const hold = await tx.get(`hold:${id}`);
  assert(hold && hold.expires_at > Date.now(), 'rotation_expired', 'Rotation expired; retry with a new idempotency key', 409);
  const current = await tx.get(`def:secrets:${args.name}`);
  let error;
  if (!args.record) error = { code: 'secret_rotation_failed', message: 'Secret rotation failed', status: 503 };
  else if (!current || await digest(JSON.stringify(current)) !== rotation.source_hash) error = { code: 'secret_conflict', message: 'Secret changed during rotation; retry with a new idempotency key', status: 409 };
  else if (secretKeyring(env).active !== rotation.target_version || args.record.version !== 2 || args.record.key_version !== rotation.target_version || args.record.fingerprint !== current.fingerprint || args.record.updated_at !== current.updated_at) error = { code: 'secret_rotation_failed', message: 'Secret rotation configuration changed; retry with a new idempotency key', status: 409 };
  const cost = error ? 0 : hold.amount;
  if (!error) {
    await tx.put(`def:secrets:${args.name}`, args.record);
    await tx.put(`audit:${Date.now()}:${id}`, { kind: 'rotate_secret', name: args.name, from_key_version: current.key_version || 'v1', to_key_version: rotation.target_version, created_at: Date.now(), key_id: args.key_id || null });
  }
  await settle(tx, id, cost);
  const result = { response: { name: args.name, rotated: !error, key_version: rotation.target_version, quote_microdollars: hold.amount, cost_microdollars: cost, balance_microdollars: (await funds(tx)).balance_microdollars }, ...(error ? { error } : {}) };
  await tx.put(id, { ...rotation, result });
  return result;
}
