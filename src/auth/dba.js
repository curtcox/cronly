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
import { createVerifier, credentialFromRequest, networkLocation } from '../vendor/devicebasedauth/verifier.js';
import { durableReplayCache } from '../vendor/devicebasedauth/replay-do.js';
import { createDohResolver, grantDnsNames } from '../vendor/devicebasedauth/dns.js';
import { createRttChallenger, rttChallengeNeeded } from '../vendor/devicebasedauth/rtt.js';
import { DBA_MAX_VERIFICATIONS } from '../utils/cost-policy.js';
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
const resolvers = new Map();
const challengers = new Map();
// Passing round trips a grant's latency.reuse_s lets us remember: "jkt peer" -> { rtt_ms, until (ms) }.
const rttReuse = new Map(); const RTT_REUSE_MAX = 10000;

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

/**
 * Host names in cronly's grants' `net.client.addresses.dns`, resolved over DNS-over-HTTPS
 * (1.1.1.1) and cached per isolate for the answer's TTL (30–300 s). A name that cannot be
 * resolved matches nothing, so DNS trouble only ever refuses. Names in other sites' grants are
 * theirs to resolve. Keyed by issuer only so each test's fake issuer gets a fresh cache.
 */
async function resolvedNames(env, payload) {
  const names = grantDnsNames(ourGrants(payload));
  if (!names.length) return {};
  const issuer = issuerOf(env);
  if (!resolvers.has(issuer)) resolvers.set(issuer, createDohResolver({ fetch: fetcher }));
  return { dns: await resolvers.get(issuer).resolveAll(names) };
}

/**
 * The timed-nonce challenger for `net.client.latency`, or null when DBA_RTT_SECRET (at least 32
 * characters, the same in every isolate, since a device's retry may land anywhere) is not set.
 * Without it latency rules are never measured, so grants with them refuse.
 */
function rttChallenger(env) {
  const secret = env.DBA_RTT_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return null;
  if (!challengers.has(secret)) challengers.set(secret, createRttChallenger({ secret }));
  return challengers.get(secret);
}

/**
 * Time the device's round trip from the timed DPoP nonce its proof answers (DBA B10 N2): the
 * nonce is HMAC-sealed to its key and peer address, so only our own recent challenge counts. A
 * passing measurement a grant allows reusing (`latency.reuse_s`) stands in for later requests
 * from the same key and address. Returns { rtt, network (with rtt_ms when measured), fresh,
 * rounds (challenges answered), bind, reuseKey }, or null without a challenger or device key.
 */
async function timing(env, auth, request) {
  const rtt = auth.kind === 'device' ? rttChallenger(env) : null;
  if (!rtt) return null;
  const network = networkLocation(request) ?? {};
  const bind = { jkt: auth.payload.cnf.jkt, peer: network.ip };
  const reuseKey = `${bind.jkt} ${bind.peer ?? ''}`; const remembered = rttReuse.get(reuseKey);
  if (remembered && remembered.until <= Date.now()) rttReuse.delete(reuseKey);
  const fresh = await rtt.check(auth.proof?.nonce, bind);
  const measured = fresh ?? (remembered && remembered.until > Date.now() ? { rtt_ms: remembered.rtt_ms } : null);
  // Each challenge this request answered was a refused request verified like this one.
  const rounds = fresh ? Math.min(fresh.samples, DBA_MAX_VERIFICATIONS - 1) : 0;
  return { rtt, network: measured ? { ...network, rtt_ms: measured.rtt_ms } : network, fresh, rounds, bind, reuseKey };
}

/** Remember a passing fresh measurement for as long as the grant that used it allows. */
function rememberRtt(timed, decision) {
  const reuse = decision.grant?.net?.client?.latency?.reuse_s ?? 0;
  if (!timed?.fresh || reuse <= 0) return;
  if (rttReuse.size >= RTT_REUSE_MAX) rttReuse.delete(rttReuse.keys().next().value);
  rttReuse.set(timed.reuseKey, { rtt_ms: timed.fresh.rtt_ms, until: Date.now() + reuse * 1000 });
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
/** The grants naming a `cronly:` action; other sites' grants (and their limits) are theirs. */
function ourGrants(payload) {
  return (payload.grants || []).filter(g => Array.isArray(g.actions) && g.actions.some(a => typeof a === 'string' && a.startsWith(`${DBA_NAMESPACE}:`)));
}
/** The tightest monthly cap on cronly's grants. */
function monthlyCap(payload) {
  const caps = ourGrants(payload).map(g => g.limits?.spend_usd_per_month).filter(v => typeof v === 'number');
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
  // `net.client` address rules: CIDRs match CF-Connecting-IP inside decide; DNS names are
  // looked up first. Latency rules use the round trip a timed DPoP nonce measured (if any).
  const context = { request, proof, confirmation, resolved: await resolvedNames(env, payload) };
  const timed = await timing(env, auth, request);
  const location = timed ? { network: timed.network } : undefined;
  const offline = []; const online = []; const challenges = {};
  for (const scope of DBA_SCOPES) {
    const decision = verifier.decide(payload, { action: `${DBA_NAMESPACE}:${scope}`, location }, context);
    if (decision.allow) { offline.push(scope); rememberRtt(timed, decision); } else if (decision.online_required) online.push(scope);
    else if (timed) { const needed = rttChallengeNeeded(payload.grants, decision.reasons, timed.fresh); if (needed) challenges[scope] = needed; }
  }
  const session = offline.includes('session');
  await rpc(env.ACCOUNTS, account, 'dba-authenticate', {
    dba_account: payload.acct, credential_id: payload.cid, device_id: payload.sub,
    device_name: typeof payload.device?.name === 'string' ? payload.device.name.slice(0, 64) : null,
    expires_at: payload.exp * 1000, monthly_spend_microdollars: monthlyCap(payload), status: { uri: status.uri, idx: status.idx }
  });
  const dba = { account: payload.acct, device_id: payload.sub, credential_id: payload.cid, kind: auth.kind, online_scopes: session ? [] : online, ...(timed?.rounds ? { verifications: 1 + timed.rounds } : {}) };
  // Scopes a timed challenge could still open; the route that needs one answers with it.
  const timedScopes = session ? [] : Object.keys(challenges);
  if (timedScopes.length) {
    Object.defineProperty(dba, 'timed_scopes', { value: timedScopes });
    Object.defineProperty(dba, 'challenge', { value: () => timed.rtt.issue({ ...timed.bind, samples: timed.fresh?.samples ?? 0, best_ms: timed.fresh?.rtt_ms }) });
  }
  // Grants restricted to `resources` were decided above without one, so they granted nothing.
  // A route acting on one job decides them again with its resource (src/auth/dba-online.js).
  // Non-enumerable, so forwarded MCP identities and serialized copies drop it and fail closed.
  if (!session) Object.defineProperty(dba, 'decide', { value: (scope, resource) => verifier.decide(payload, { action: `${DBA_NAMESPACE}:${scope}`, resource, location }, context) });
  return {
    account, key_id: payload.cid, scopes: session ? [...USER_SCOPES] : offline.filter(scope => scope !== 'session'),
    session, ...(session ? { device_session: true } : {}), dba
  };
}
