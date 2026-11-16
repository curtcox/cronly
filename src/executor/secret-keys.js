import { assert } from '../utils/errors.js';

/** Parse the single atomic keyring binding; legacy deployments keep reading v1. */
export function secretKeyring(env) {
  let ring;
  try { ring = env.SECRETS_KEYRING ? JSON.parse(env.SECRETS_KEYRING) : { active: 'v1', keys: { v1: env.SECRETS_MASTER_KEY } }; }
  catch { assert(false, 'invalid_secret_keyring', 'Secret key configuration is invalid', 503); }
  const validVersion = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value);
  assert(ring && validVersion(ring.active) && ring.keys && typeof ring.keys === 'object' && !Array.isArray(ring.keys), 'invalid_secret_keyring', 'Secret key configuration is invalid', 503);
  const entries = Object.entries(ring.keys);
  assert(entries.length > 0 && entries.length <= 16 && entries.every(([version, master]) => validVersion(version) && typeof master === 'string' && master.length > 0 && (env.ENVIRONMENT !== 'production' || new TextEncoder().encode(master).length >= 32)) && Object.hasOwn(ring.keys, ring.active), 'invalid_secret_keyring', 'Secret key configuration is invalid', 503);
  return ring;
}

/** Resolve exactly the stored version, never try another key on decryption failure. */
export function secretMaster(env, version) {
  const ring = secretKeyring(env);
  assert(Object.hasOwn(ring.keys, version), 'secret_key_unavailable', 'A required secret key is unavailable', 503);
  return ring.keys[version];
}
