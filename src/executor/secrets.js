import { base64url, unbase64url, digest } from '../auth/crypto.js';
const enc = new TextEncoder();
async function key(master, account) {
  if (!master) throw new Error('Missing master key');
  const material = await crypto.subtle.importKey('raw', enc.encode(master), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(account), info: enc.encode('cronly:secrets:v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
/** Encrypt per account with a fresh IV; bind the name to prevent ciphertext swaps. */
export async function encryptSecret(master, account, name, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(name) }, await key(master, account), enc.encode(value));
  return { version: 1, iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)), fingerprint: (await digest(value)).slice(0, 12), updated_at: Date.now() };
}
/** Only the executor calls this function, for the secrets needed by this run. */
export async function decryptSecret(master, account, name, record) {
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64url(record.iv), additionalData: enc.encode(name) }, await key(master, account), unbase64url(record.ciphertext)));
}
/** Strip ciphertext and IV from every public secret response. */
export function secretMetadata(record) { return { fingerprint: record.fingerprint, updated_at: record.updated_at, version: record.version }; }
/** Redact raw, URL-encoded and base64 secret representations before storage. */
export function redact(text, secrets) {
  let result = String(text);
  const replacements = Object.entries(secrets).flatMap(([name, value]) => {
    const bytes = new TextEncoder().encode(value); const base64 = btoa(String.fromCharCode(...bytes));
    return [...new Set([value, encodeURIComponent(value), base64, base64url(bytes)])].filter(Boolean).map(pattern => ({ pattern, name }));
  }).sort((a, b) => b.pattern.length - a.pattern.length);
  for (const { pattern, name } of replacements) result = result.split(pattern).join(`«secret:${name}»`);
  return result;
}
