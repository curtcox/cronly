/**
 * Online decisions for devicebasedauth.org grants that only DBA can decide: step-up, gates,
 * `limits.uses`, `require.online`, and actions whose cronly.org catalog policy requires gates
 * (ported from hashbin's authorizeDbaOnline). Only the scope the route needs is asked for.
 *
 * DBA bills cronly.org for every decision, including denials, so the `dba_decision` price is
 * held from the caller (under the credential's monthly cap) before DBA is asked, charged once DBA
 * has decided, and released when it could not.
 */
import { PUBLIC, SESSION, ACCOUNT_SESSION, USER_SCOPES, canAccess } from './scopes.js';
import { DBA_NAMESPACE, dbaVerifier } from './dba.js';
import { ApiError } from '../utils/errors.js';
import { rpc } from '../utils/rpc.js';
import { price } from '../utils/pricing.js';

/** The scope a route needs that this credential could get only online, or null. */
export function onlineScopeFor(auth, access) {
  const online = auth?.dba?.online_scopes || [];
  if (!online.length || access === PUBLIC) return null;
  // ACCOUNT_SESSION never accepts a device session, so asking DBA for one would be wasted.
  if (access === ACCOUNT_SESSION) return null;
  if (access === SESSION) return !auth.session && online.includes('session') ? 'session' : null;
  const anyOf = Array.isArray(access) ? access : [access];
  if (anyOf.some(scope => auth.scopes?.includes(scope))) return null;
  return anyOf.find(scope => online.includes(scope)) || (online.includes('session') ? 'session' : null);
}

const JOB_NAME = /^[a-z0-9-]{1,64}$/;
/**
 * The resource a request acts on, for grants restricted by `resources`: `job:<name>` for the
 * routes on one job (definition, run, pause/resume, triggers) and for runs filtered to one job.
 * Null everywhere else (including action-test histories), so resource-scoped grants reach nothing more.
 */
export function dbaResource(route, url) {
  const name = route.path.startsWith('/api/jobs/:name') ? route.params?.name : route.handler === 'runs' ? url.searchParams.get('job') : null;
  return typeof name === 'string' && JOB_NAME.test(name) ? `job:${name}` : null;
}

/**
 * Authorize a devicebasedauth.org credential for a route its unrestricted offline grants do not
 * cover, cheapest first: a grant restricted to the route's resource, decided offline (free); a
 * grant only DBA can decide (`online_scopes`); then a resource-restricted grant only DBA can
 * decide. An allowed scope is added to `auth` for this request. Returns the µ$ charged; throws as
 * `authorizeDbaOnline` does. Leaves `auth` unchanged when nothing applies.
 */
export async function authorizeDba(request, env, auth, route) {
  if (canAccess(auth, route.access)) return 0;
  const resource = auth.dba.decide ? dbaResource(route, new URL(request.url)) : null;
  const scopes = resource ? (Array.isArray(route.access) ? route.access : [route.access]).filter(scope => USER_SCOPES.includes(scope)) : [];
  const decisions = scopes.map(scope => ({ scope, ...auth.dba.decide(scope, resource) }));
  const offline = decisions.find(decision => decision.allow);
  if (offline) { auth.scopes = [...auth.scopes, offline.scope]; return 0; }
  if (onlineScopeFor(auth, route.access)) return authorizeDbaOnline(request, env, auth, route.access);
  const online = decisions.find(decision => decision.online_required);
  if (!online) return 0;
  const charged = await decideOnline(request, env, auth, online.scope, resource);
  auth.scopes = [...auth.scopes, online.scope]; auth.dba.online_scopes = [];
  return charged;
}

/**
 * Ask DBA for the scope this route needs, if the credential could get it only online. On an
 * allow the scope (or the device session) is added to `auth`. Returns the µ$ charged; throws
 * 403 `gate_pending` (with DBA's `gate_request`) until the grant's gates settle, 403 `dba_denied`
 * when DBA refuses, and 403 `online_required` when cronly has no DBA_API_KEY.
 */
export async function authorizeDbaOnline(request, env, auth, access) {
  const scope = onlineScopeFor(auth, access);
  if (!scope) return 0;
  const charged = await decideOnline(request, env, auth, scope);
  if (scope === 'session') Object.assign(auth, { session: true, device_session: true, scopes: [...USER_SCOPES] });
  else auth.scopes = [...auth.scopes, scope];
  auth.dba.online_scopes = [];
  return charged;
}

/** One billed online decision of `scope` (on `resource`, if any); returns the µ$ charged on an allow, else throws. */
async function decideOnline(request, env, auth, scope, resource) {
  const action = `${DBA_NAMESPACE}:${scope}`;
  // Dry runs are free and change nothing, so they never buy a decision; they also must not
  // reveal anything the grant's gates have not approved.
  if (new URL(request.url).searchParams.get('dry_run') === '1') throw new ApiError(403, 'online_decision_required', `${action} needs a devicebasedauth.org decision, which dry runs do not make; send the request without dry_run`);
  if (!env.DBA_API_KEY) throw new ApiError(403, 'online_required', `This devicebasedauth.org grant for ${action} needs an online check, which cronly.org has not enabled`);
  const id = `dba-decision:${crypto.randomUUID()}`; const amount = price('dba_decision');
  await rpc(env.ACCOUNTS, auth.account, 'reserve', { id, amount, kind: 'dba_decision', key_id: auth.key_id, ttl_ms: 60000 });
  let result;
  try { result = await dbaVerifier(env).verifyOnline(request, { action, ...(resource ? { resource } : {}) }); }
  catch {
    await rpc(env.ACCOUNTS, auth.account, 'settle', { id, actual: 0 });
    throw new ApiError(503, 'dba_unavailable', 'Could not reach devicebasedauth.org for an online check');
  }
  // DBA decided (and billed cronly) only when it allowed (200), refused the action (403) or the
  // credential (401). Anything else, including 429, 5xx and its 402 (reported as 503), is no decision.
  const decided = [200, 401, 403].includes(result.status);
  const charged = (await rpc(env.ACCOUNTS, auth.account, 'settle', { id, actual: decided ? amount : 0 })).charged;
  const details = { cost_microdollars: charged };
  if (result.allow) return charged;
  if (result.code === 'gate_pending') throw new ApiError(403, 'gate_pending', 'Waiting for this grant\'s gates to approve; retry with a fresh proof', { ...details, gate_request: result.gate_request });
  if (!decided) throw new ApiError(503, 'dba_unavailable', 'devicebasedauth.org could not decide', { ...details, dba_code: result.code });
  if (result.status === 401) throw new ApiError(401, 'invalid_auth', result.message || 'devicebasedauth.org refused the credential', { ...details, dba_code: result.code });
  throw new ApiError(403, 'dba_denied', `devicebasedauth.org did not allow ${action}`, { ...details, dba_code: result.code || 'forbidden', reasons: result.reasons || [] });
}
