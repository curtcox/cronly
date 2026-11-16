import { it, expect } from 'vitest';
import { base64url } from '../auth/crypto.js';
import { decryptSecret, encryptSecret, secretMetadata } from './secrets.js';
import { secretKeyring } from './secret-keys.js';

const ring = (active = 'v2') => ({ SECRETS_KEYRING: JSON.stringify({ active, keys: { v1: 'old-master', v2: 'new-master' } }) });

it('reads the original v1 ciphertext format after switching active keys', async () => {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode('old-master'), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('alice'), info: enc.encode('cronly:secrets:v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('token') }, key, enc.encode('original-secret'));
  const legacy = { version: 1, iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)) };
  expect(await decryptSecret(ring(), 'alice', 'token', legacy)).toBe('original-secret');
  await expect(decryptSecret(ring(), 'bob', 'token', legacy)).rejects.toThrow();
});

it('authenticates the account, name and key version and uses fresh nonces', async () => {
  const first = await encryptSecret(ring(), 'alice', 'token', 'private-value');
  const second = await encryptSecret(ring(), 'alice', 'token', 'private-value');
  expect(first).toMatchObject({ version: 2, key_version: 'v2' });
  expect(first.iv).not.toBe(second.iv);
  expect(await decryptSecret(ring('v1'), 'alice', 'token', first)).toBe('private-value');
  for (const [account, name] of [['bob', 'token'], ['alice', 'other']]) await expect(decryptSecret(ring(), account, name, first)).rejects.toThrow();
  const sameKeys = { SECRETS_KEYRING: JSON.stringify({ active: 'v2', keys: { v1: 'new-master', v2: 'new-master' } }) };
  await expect(decryptSecret(sameKeys, 'alice', 'token', { ...first, key_version: 'v1' })).rejects.toThrow();
  await expect(decryptSecret(ring(), 'alice', 'token', { ...first, version: 3 })).rejects.toMatchObject({ code: 'invalid_secret_record' });
  expect(secretMetadata(first).key_version).toBe('v2');
  expect(JSON.stringify(secretMetadata(first))).not.toMatch(/ciphertext|private-value|iv/);
});

it('fails closed on missing or malformed keys without exposing configuration', async () => {
  const record = await encryptSecret(ring(), 'alice', 'token', 'value');
  await expect(decryptSecret({ SECRETS_MASTER_KEY: 'old-master' }, 'alice', 'token', record)).rejects.toMatchObject({ code: 'secret_key_unavailable' });
  for (const value of ['bad-private-json', 'null', '[]', '{"active":"v2","keys":{"v1":"private-master"}}']) {
    expect(() => secretKeyring({ SECRETS_KEYRING: value })).toThrow('Secret key configuration is invalid');
  }
  expect(() => secretKeyring({ ...ring(), ENVIRONMENT: 'production' })).toThrow('Secret key configuration is invalid');
});
