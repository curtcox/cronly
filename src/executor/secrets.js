import { base64url, unbase64url, digest } from '../auth/crypto.js';
import { secretKeyring, secretMaster } from './secret-keys.js';
import { assert } from '../utils/errors.js';
import { createRedactor } from './redaction.js';
const enc = new TextEncoder();
async function key(master, account, info = 'cronly:secrets:v1') {
  if (!master) throw new Error('Missing master key');
  const material = await crypto.subtle.importKey('raw', enc.encode(master), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(account), info: enc.encode(info) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
/** Encrypt per account with a fresh IV; bind the name to prevent ciphertext swaps. */
export async function encryptSecret(env, account, name, value) {
  if (typeof env === 'string') env = { SECRETS_MASTER_KEY: env };
  const { active: key_version } = secretKeyring(env);
  const master = secretMaster(env, key_version);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(JSON.stringify([account, name, key_version])) }, await key(master, account, 'cronly:secrets:v2'), enc.encode(value));
  return { version: 2, key_version, iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)), fingerprint: (await digest(value)).slice(0, 12), updated_at: Date.now() };
}
/** Only executor modules decrypt secrets, for execution or held re-encryption. */
export async function decryptSecret(env, account, name, record) {
  if (typeof env === 'string') env = { SECRETS_MASTER_KEY: env };
  assert(record?.version === 1 || record?.version === 2, 'invalid_secret_record', 'Unsupported secret encryption format', 503);
  const legacy = record.version === 1;
  const master = secretMaster(env, legacy ? 'v1' : record.key_version);
  const additionalData = enc.encode(legacy ? name : JSON.stringify([account, name, record.key_version]));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64url(record.iv), additionalData }, await key(master, account, legacy ? 'cronly:secrets:v1' : 'cronly:secrets:v2'), unbase64url(record.ciphertext)));
}
/** Strip ciphertext and IV from every public secret response. */
export function secretMetadata(record) { return { fingerprint: record.fingerprint, updated_at: record.updated_at, version: record.version, key_version: record.key_version || 'v1' }; }
/** Redact raw, encoded and JSON-escaped secret representations before storage. */
export function redact(text, secrets) {
  return createRedactor(secrets)(text);
}
