/**
 * devicebasedauth.org ("DBA") credentials: device-bound keys presented as
 * `Authorization: DBA <credential>` + `DPoP: <proof>`, or short-lived access tokens presented as
 * `Authorization: Bearer <token>` (JWS typ `dba-access+jwt`). Ported from hashbin's
 * src/auth/dba.js and dba-auth.js; see todo/dba_integration.md and docs/devicebasedauth.md.
 *
 * Verification is offline with the vendored @devicebasedauth/verify: DBA's JWKS, status lists
 * and the cronly.org action catalog are cached per isolate, and failing to fetch any of them
 * fails closed. DPoP proofs are claimed once across every isolate (DBA_REPLAY), and revocations
 * DBA pushes to the webhook (DBA_REVOCATIONS) apply within 30 seconds.
 */
import { createOidcClient } from '../vendor/devicebasedauth/site.js';
import { createVerifier, credentialFromRequest } from '../vendor/devicebasedauth/verifier.js';
import { durableReplayCache } from '../vendor/devicebasedauth/replay-do.js';
import { USER_SCOPES } from './scopes.js';
import { assert } from '../utils/errors.js';
import { rpc } from '../utils/rpc.js';

/** cronly's audience, action namespace and OIDC client id at devicebasedauth.org. */
export const DBA_AUDIENCE = 'cronly.org';
export const DBA_NAMESPACE = 'cronly';
export const DBA_DEFAULT_ISSUER = 'https://devicebasedauth.org';
/** The DBA actions cronly understands: `cronly:<scope>` for every user scope, and `cronly:session`. */
export const DBA_SCOPES = Object.freeze([...USER_SCOPES, 'session']);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The DBA issuer this deployment trusts: DBA_ISSUER, or https://devicebasedauth.org. It must be
 * an https origin; local mode also accepts http on localhost (a local DBA). Null otherwise.
 */
export function dbaIssuer(env) {
  let url;
  try { url = new URL(env?.DBA_ISSUER || DBA_DEFAULT_ISSUER); } catch { return null; }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
  const local = env?.ENVIRONMENT === 'local' && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  return url.protocol === 'https:' || local ? url.origin : null;
}
function issuerOf(env) {
  const issuer = dbaIssuer(env);
  assert(issuer, 'dba_unavailable', 'DBA_ISSUER is not a valid devicebasedauth.org issuer', 503);
  return issuer;
}

// Resolve fetch per call so tests (and a future instrumented fetch) can replace the global.
const fetcher = (...args) => globalThis.fetch(...args);
// Kept for the life of the isolate so DBA's JWKS, status lists, catalog and OIDC discovery
// survive across requests. The vendored client caches only successful responses.
const verifiers = new Map();
const oidcClients = new Map();

/**
 * The shared verifier for this deployment's issuer. The catalog is DBA's cronly.org record, so
 * actions whose policy requires gates go online; DBA_API_KEY (a secret) enables those online
 * decisions (src/auth/dba-online.js), each billed to cronly.org and held from the caller first.
 */
export function dbaVerifier(env) {
  const issuer = issuerOf(env);
  const key = `${issuer} ${env.DBA_API_KEY ? 'online' : 'offline'} ${env.DBA_REPLAY ? 'shared' : 'isolate'}`;
  if (!verifiers.has(key)) {
    verifiers.set(key, createVerifier({
      audience: DBA_AUDIENCE, issuer, catalog: true, fetch: fetcher,
      ...(env.DBA_REPLAY ? { replay: durableReplayCache(env.DBA_REPLAY) } : {}),
      ...(env.DBA_API_KEY ? { online: { apiKey: env.DBA_API_KEY } } : {})
    }));
  }
  return verifiers.get(key);
}

/** OIDC client for linking a cronly account to a DBA account (authorization code + PKCE). */
export function dbaOidc(env) {
  const issuer = issuerOf(env); const redirectUri = `${env.APP_ORIGIN}/auth/dba/callback`;
  const key = `${issuer} ${redirectUri}`;
  if (!oidcClients.has(key)) oidcClients.set(key, createOidcClient({ clientId: DBA_AUDIENCE, redirectUri, issuer, fetch: fetcher }));
  return oidcClients.get(key);
}

/** Grants state USD per month; cronly caps are integer µ$, rounded down so a cap never loosens. */
export function monthlyMicrodollars(usd) {
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? Math.floor(usd * 1000000 + 1e-6) : null;
}
/** The tightest monthly cap on cronly's grants; caps on other sites' grants are theirs. */
function monthlyCap(payload) {
  const ours = (payload.grants || []).filter(g => Array.isArray(g.actions) && g.actions.some(a => a.startsWith(`${DBA_NAMESPACE}:`)));
  const caps = ours.map(g => g.limits?.spend_usd_per_month).filter(v => typeof v === 'number');
  return caps.length ? monthlyMicrodollars(Math.min(...caps)) : null;
}

/** The key a revoked status entry is known by (spec/events.md: the status entry is what is revoked). */
export function dbaStatusKey(status) {
  return status && typeof status.uri === 'string' && Number.isSafeInteger(status.idx) ? `${status.uri}#${status.idx}` : null;
}
const PUSHED_TTL_MS = 30000;
let pushed = null;
/**
 * Status entries DBA pushed to the webhook as revoked, cached for 30 seconds per isolate. The
 * status lists stay authoritative, so an unreadable object counts as "nothing pushed".
 */
export async function pushedDbaRevocations(env) {
  if (!env?.DBA_REVOCATIONS) return new Set();
  if (pushed && pushed.binding === env.DBA_REVOCATIONS && pushed.until > Date.now()) return pushed.keys;
  try {
    const keys = new Set((await rpc(env.DBA_REVOCATIONS, 'global', 'revoked')).revoked);
    pushed = { binding: env.DBA_REVOCATIONS, keys, until: Date.now() + PUSHED_TTL_MS };
    return keys;
  } catch { return new Set(); }
}
/** Forget the cached pushed revocations (after a webhook delivery, and in tests). */
export function forgetPushedDbaRevocations() { pushed = null; }

/**
 * Is this credential's status entry revoked (pushed, or set in DBA's status list)? Throws when
 * the status list cannot be fetched, so callers fail closed.
 */
export async function dbaStatusRevoked(env, status) {
  const key = dbaStatusKey(status);
  if (!key) return true;
  if ((await pushedDbaRevocations(env)).has(key)) return true;
  return dbaVerifier(env).isRevoked({ status: { status_list: status } });
}

/**
 * Authenticate a DBA credential or access token. Returns null when the request carries neither,
 * so Clerk and API keys keep working.
 *
 * Each `cronly:<scope>` the grants allow offline now is a scope; ones allowed only online
 * (gates, step-up, use counts, require.online, gated catalog actions) are `dba.online_scopes`,
 * decided by DBA when a route needs one. `cronly:session` makes a device session: every scope
 * and SESSION routes, never ACCOUNT_SESSION ones. The credential id is the key id, so reads are
 * metered, holds count against the grant's monthly cap and queued retries re-check it.
 */
export async function authenticateDba(request, env) {
  if (!credentialFromRequest(request)) return null;
  const verifier = dbaVerifier(env);
  let auth;
  try { auth = await verifier.authenticateRequest(request); } catch { assert(false, 'dba_unavailable', 'Could not verify the devicebasedauth.org credential', 503); }
  assert(auth.ok, auth.code, auth.message || 'Invalid devicebasedauth.org credential', auth.status);
  const { payload, proof, confirmation } = auth; const status = payload.status.status_list;
  assert(!(await pushedDbaRevocations(env)).has(dbaStatusKey(status)), 'revoked', 'This devicebasedauth.org credential was revoked', 401);
  const notLinked = [`Link devicebasedauth.org account ${payload.acct} to your cronly account first`, 403, { dba_account: payload.acct }];
  // The index names the account; the account's dba-authenticate must confirm it.
  const account = env.DBA_LINKS ? (await rpc(env.DBA_LINKS, payload.acct, 'get')).account : null;
  assert(account, 'account_not_linked', ...notLinked);
  const offline = []; const online = [];
  for (const scope of DBA_SCOPES) {
    const decision = verifier.decide(payload, { action: `${DBA_NAMESPACE}:${scope}` }, { request, proof, confirmation });
    if (decision.allow) offline.push(scope); else if (decision.online_required) online.push(scope);
  }
  const session = offline.includes('session');
  await rpc(env.ACCOUNTS, account, 'dba-authenticate', {
    dba_account: payload.acct, credential_id: payload.cid, device_id: payload.sub,
    device_name: typeof payload.device?.name === 'string' ? payload.device.name.slice(0, 64) : null,
    expires_at: payload.exp * 1000, monthly_spend_microdollars: monthlyCap(payload), status: { uri: status.uri, idx: status.idx }
  });
  const dba = { account: payload.acct, device_id: payload.sub, credential_id: payload.cid, kind: auth.kind, online_scopes: session ? [] : online };
  // Grants restricted to `resources` were decided above without one, so they granted nothing.
  // A route acting on one job decides them again with its resource (src/auth/dba-online.js).
  // Non-enumerable, so forwarded MCP identities and serialized copies drop it and fail closed.
  if (!session) Object.defineProperty(dba, 'decide', { value: (scope, resource) => verifier.decide(payload, { action: `${DBA_NAMESPACE}:${scope}`, resource }, { request, proof, confirmation }) });
  return {
    account, key_id: payload.cid, scopes: session ? [...USER_SCOPES] : offline.filter(scope => scope !== 'session'),
    session, ...(session ? { device_session: true } : {}), dba
  };
}
