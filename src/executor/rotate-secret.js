import { rpc } from '../utils/rpc.js';
import { ApiError, assert } from '../utils/errors.js';
import { decryptSecret, encryptSecret } from './secrets.js';

/** Re-encrypt a held ciphertext without sending plaintext through an API or DO. */
export async function rotateSecret(request, env, auth, name) {
  const args = { account: auth.account, key_id: auth.key_id, name, id: request.headers.get('Idempotency-Key') || crypto.randomUUID(), dry_run: new URL(request.url).searchParams.get('dry_run') === '1' };
  const prepared = await rpc(env.ACCOUNTS, auth.account, 'begin-secret-rotation', args);
  let result = prepared.result;
  if (!result) {
    let record;
    try {
      const value = await decryptSecret(env, auth.account, name, prepared.record);
      record = await encryptSecret(env, auth.account, name, value);
      assert(record.key_version === prepared.target_version, 'secret_rotation_failed', 'Secret key configuration changed', 409);
      record.updated_at = prepared.record.updated_at;
    } catch { record = undefined; }
    result = await rpc(env.ACCOUNTS, auth.account, 'finish-secret-rotation', { ...args, record });
  }
  if (result.error) throw new ApiError(result.error.status, result.error.code, result.error.message, result.response);
  return result.response;
}
