import { verifyToken as verifyClerkToken } from '@clerk/backend';
import { assert } from '../utils/errors.js';
import { rpc } from '../utils/rpc.js';
import { digest, verifyToken } from './crypto.js';
/** Authenticate local, Clerk and signed self-routing API credentials (hashbin pattern). */
export async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (header.startsWith('LocalDev ')) {
    const account = header.slice(9).trim();
    assert(env.ENVIRONMENT === 'local', 'invalid_auth', 'Local authentication is disabled', 401);
    assert(/^[a-zA-Z0-9_-]{1,128}$/.test(account), 'invalid_auth', 'Invalid local user', 401);
    await rpc(env.ACCOUNTS, account, 'init', { account });
    return { account, session: true };
  }
  if (header.startsWith('Bearer ')) {
    try {
      const claims = await verifyClerkToken(header.slice(7), { secretKey: env.CLERK_SECRET_KEY, authorizedParties: [env.APP_ORIGIN] });
      assert(claims.sub && claims.sid, 'invalid_auth', 'Invalid session', 401);
      await rpc(env.ACCOUNTS, claims.sub, 'init', { account: claims.sub });
      return { account: claims.sub, session: true };
    } catch { assert(false, 'invalid_auth', 'Invalid session', 401); }
  }
  if (header.startsWith('ApiKey ')) {
    const token = header.slice(7); const payload = await verifyToken(token, 'crk_', env.TOKEN_SIGNING_KEY);
    assert(payload, 'invalid_auth', 'Invalid API key', 401);
    const key = await rpc(env.ACCOUNTS, payload.account, 'authenticate-key', { id: payload.id, hash: await digest(token) });
    return { account: payload.account, key_id: payload.id, scopes: key.scopes, session: false };
  }
  assert(false, 'auth_required', 'Authentication required', 401);
}
