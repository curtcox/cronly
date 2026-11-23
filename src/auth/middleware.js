import { verifyToken as verifyClerkToken } from '@clerk/backend';
import { assert } from '../utils/errors.js';
import { rpc } from '../utils/rpc.js';
import { digest, verifyToken } from './crypto.js';
import { authenticateDba } from './dba.js';
// Identities already verified for in-process requests (MCP tool calls). Only code holding the
// Request object can add one, so no caller can claim an identity through a header.
const forwarded = new WeakMap();
/**
 * Let an internal sub-request reuse its parent's verified identity (DPoP proofs are single use).
 * It gets no online devicebasedauth.org decisions: the parent's proof names the parent's URL.
 */
export function forwardAuth(request, auth) { forwarded.set(request, { ...auth, ...(auth.dba ? { dba: { ...auth.dba, online_scopes: [] } } : {}) }); return request; }
/** Authenticate local, Clerk, devicebasedauth.org and signed self-routing API credentials (hashbin pattern). */
export async function authenticate(request, env) {
  if (forwarded.has(request)) return forwarded.get(request);
  const header = request.headers.get('Authorization') || '';
  // DBA first: a Bearer token is Clerk's unless its JWS header says dba-access+jwt. Schemes are
  // case-insensitive (RFC 9110), as in the vendored verifier.
  if (/^(dba|bearer) /i.test(header)) { const dba = await authenticateDba(request, env); if (dba) return dba; }
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
