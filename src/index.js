import { worstCaseCost } from './utils/cost-policy.js';
import { runCostMonitor } from './services/cost-monitor.js';
import { proseQuote } from './services/llm.js';
import { openapi } from './services/openapi.js';
import { prose, applyProposal } from './api/prose.js';
import { putConfig } from './api/config.js';
import { mcp } from './api/mcp.js';
import { reports } from './api/reporting.js';
import { hook, triggers } from './auth/triggers.js';
import { runJob, toggleJob, testAction } from './api/jobs.js';
import { consume } from './executor/consumer.js';
import { rotateSecret } from './executor/rotate-secret.js';
import { definitions, keys } from './api/definitions.js';
import { clerkWebhook } from './auth/clerk-webhook.js';
import { checkout, stripeWebhook } from './api/payments.js';
import { dbaLink } from './api/dba.js';
import { dbaEvent } from './api/dba-events.js';
import { authorizeDba } from './auth/dba-online.js';
import { dbaIssuer } from './auth/dba.js';
import { dbaPreflight, withDbaCors } from './auth/dba-cors.js';
import { explainCron } from './services/cron.js';
import { PUBLIC, SESSION, ACCOUNT_SESSION, USER_SCOPES, canAccess } from './auth/scopes.js';
import { authenticate, forwardAuth } from './auth/middleware.js';
import { money } from './durable-objects/ledger.js';
import { errorResponse, assert, readJson } from './utils/errors.js';
import { rpc } from './utils/rpc.js';
import { price, PRICES } from './utils/pricing.js';
export { SafetyDO } from './durable-objects/safety-do.js';
export { AccountDO } from './durable-objects/account-do.js';
export { JobDO } from './durable-objects/job-do.js';
export { DbaLinkDO } from './durable-objects/dba-link-do.js';
export { DbaRevocationsDO } from './durable-objects/dba-revocations-do.js';
export { ReplayCacheDO as DbaReplayCacheDO } from './vendor/devicebasedauth/replay-do.js';

// Routes are the sole dispatch source: an undeclared endpoint cannot execute.
export const API_ROUTES = [
  { method: 'GET', path: '/openapi.json', access: PUBLIC, handler: 'openapi' },
  { method: 'GET', path: '/api/public/config', access: PUBLIC, handler: 'public-config' },
  { method: 'GET', path: '/health', access: PUBLIC, handler: 'health' },
  ...['upcoming', 'projection', 'costs', 'runs'].map(handler => ({ method: 'GET', path: `/api/${handler}`, access: 'read', handler })),
  { method: 'GET', path: '/api/runs/:id', access: 'read', handler: 'run-detail' },
  { method: 'POST', path: '/api/prose/:mode', access: 'prose', handler: 'prose' },
  { method: 'POST', path: '/api/changes/:id/apply', access: 'change', handler: 'apply-proposal' },
  { method: 'PUT', path: '/api/config', access: 'change', handler: 'config-write' },
  ...['GET', 'POST'].map(method => ({ method, path: '/mcp', access: USER_SCOPES, handler: 'mcp' })),
  { method: 'GET', path: '/api/config', access: 'read', handler: 'config-read' },
  { method: 'GET', path: '/api/account', access: 'read', handler: 'account' },
  { method: 'GET', path: '/api/quote', access: PUBLIC, handler: 'quote' },
  { method: 'POST', path: '/api/dev/deposit', access: SESSION, handler: 'dev-deposit' },
  { method: 'POST', path: '/webhooks/clerk', access: PUBLIC, handler: 'clerk-webhook' },
  { method: 'POST', path: '/webhooks/stripe', access: PUBLIC, handler: 'stripe-webhook' },
  { method: 'POST', path: '/api/payments/checkout', access: SESSION, handler: 'checkout' },
  { method: 'GET', path: '/api/transactions', access: 'read', handler: 'transactions' },
  { method: 'GET', path: '/api/audit', access: 'read', handler: 'audit' },
  ...['GET', 'POST'].map(method => ({ method, path: '/api/jobs/:name/triggers', access: method === 'GET' ? 'read' : 'change', handler: 'triggers' })),
  { method: 'DELETE', path: '/api/jobs/:name/triggers/:id', access: 'change', handler: 'triggers' },
  ...['GET', 'POST'].map(method => ({ method, path: '/hook/:token', access: PUBLIC, handler: 'hook' })),
  ...['pause', 'resume'].map(op => ({ method: 'POST', path: `/api/jobs/:name/${op}`, access: 'change', handler: `${op}-job` })),
  { method: 'POST', path: '/api/actions/:name/test', access: 'run', handler: 'test-action' },
  { method: 'POST', path: '/api/jobs/:name/run', access: 'run', handler: 'run-job' },
  { method: 'POST', path: '/api/secrets/:name/rotate', access: 'secrets:write', handler: 'rotate-secret' },
  { method: 'GET', path: '/api/keys', access: SESSION, handler: 'keys' },
  { method: 'POST', path: '/api/keys', access: ACCOUNT_SESSION, handler: 'keys' },
  { method: 'DELETE', path: '/api/keys/:id', access: ACCOUNT_SESSION, handler: 'keys' },
  { method: 'GET', path: '/api/dba/link', access: SESSION, handler: 'dba-link-status' },
  { method: 'POST', path: '/api/dba/link/start', access: ACCOUNT_SESSION, handler: 'dba-link-start' },
  { method: 'POST', path: '/api/dba/link/finish', access: ACCOUNT_SESSION, handler: 'dba-link-finish' },
  { method: 'DELETE', path: '/api/dba/link', access: ACCOUNT_SESSION, handler: 'dba-link-delete' },
  // devicebasedauth.org's revocation webhook: public, but only an issuer-signed event applies.
  { method: 'POST', path: '/api/dba/events', access: PUBLIC, handler: 'dba-events' },
  { method: 'POST', path: '/api/cron/explain', access: PUBLIC, handler: 'cron-explain' },
  ...['variables', 'secrets', 'actions', 'jobs'].flatMap(kind => ['GET', 'PUT', 'DELETE'].map(method => ({ method, path: `/api/${kind}/:name`, access: method === 'GET' ? 'read' : kind === 'secrets' ? 'secrets:write' : 'change', handler: 'definitions', kind })))
];
/** Match declared routes with named segments only. */
export function matchRoute(method, path) {
  for (const route of API_ROUTES) {
    if (route.method !== method) continue;
    const names = [];
    const pattern = route.path.split('/').map(part => { if (part.startsWith(':')) { names.push(part.slice(1)); return '([^/]+)'; } return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('/');
    const match = path.match(new RegExp(`^${pattern}$`));
    if (match) return { ...route, params: { ...(route.kind ? { kind: route.kind } : {}), ...Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1])])) } };
  }
  return null;
}
async function handle(route, request, env, auth) {
  const url = new URL(request.url); const dryRun = url.searchParams.get('dry_run') === '1';
  switch (route.handler) {
    case 'prose': return prose(route, request, env, auth);
    case 'apply-proposal': return applyProposal(route, request, env, auth);
    case 'config-write': return putConfig(request, env, auth);
    case 'config-read': case 'upcoming': case 'projection': case 'costs': case 'runs': case 'run-detail': return reports(route, request, env, auth);
    case 'hook': return hook(route, request, env);
    case 'triggers': return triggers(route, request, env, auth);
    case 'pause-job': case 'resume-job': return toggleJob(route, request, env, auth);
    case 'test-action': return testAction(route, request, env, auth);
    case 'run-job': return runJob(route, request, env, auth);
    case 'rotate-secret': return rotateSecret(request, env, auth, route.params.name);
    case 'definitions': return definitions(route, request, env, auth);
    case 'keys': return keys(route, request, env, auth);
    case 'dba-link-status': case 'dba-link-start': case 'dba-link-finish': case 'dba-link-delete': return dbaLink(route, request, env, auth);
    case 'clerk-webhook': return clerkWebhook(request, env);
    case 'stripe-webhook': return stripeWebhook(request, env);
    case 'checkout': return checkout(request, env, auth, dryRun);
    case 'transactions': return rpc(env.ACCOUNTS, auth.account, 'list', { prefix: 'ledger:', reverse: true, cursor: url.searchParams.get('cursor') });
    case 'audit': return rpc(env.ACCOUNTS, auth.account, 'list', { prefix: 'audit:', reverse: true, cursor: url.searchParams.get('cursor') });
    case 'cron-explain': { const body = await readJson(request); return { ...explainCron(body.cron, body.timezone), cost_microdollars: 0 }; }
    case 'openapi': return openapi(API_ROUTES);
    case 'public-config': return { local: env.ENVIRONMENT === 'local', clerk_publishable_key: env.CLERK_PUBLISHABLE_KEY || null, dba_issuer: dbaIssuer(env), prices: PRICES, costs: { ...Object.fromEntries(['run', 'hook', 'change', 'read', 'dba_link', 'dba_decision'].map(op => [op, Math.ceil(worstCaseCost(op))])), dba_request: Math.ceil(worstCaseCost('read', {}, { dba: true }) - worstCaseCost('read')) } };
    case 'health': return { status: 'ok', environment: env.ENVIRONMENT, git_sha: env.GIT_SHA || 'local' };
    case 'quote': {
      const op = url.searchParams.get('op'); assert(['run', 'hook', 'change', 'read', 'prose'].includes(op), 'invalid_operation', 'Unknown operation');
      let action = {};
      if (op === 'read' && url.searchParams.get('resource') === 'runs') { const caller = await authenticate(request, env); assert(canAccess(caller, 'read'), 'insufficient_scope', 'read scope required', 403); action.job_count = url.searchParams.has('job') ? 1 : (await rpc(env.ACCOUNTS, caller.account, 'read-plan')).names.length; }
      if (url.searchParams.has('job') && ['run', 'hook'].includes(op)) {
        const caller = await authenticate(request, env); assert(canAccess(caller, ['read', 'run']), 'insufficient_scope', 'read scope required', 403);
        const config = await rpc(env.ACCOUNTS, caller.account, 'config'); const name = url.searchParams.get('job'); assert(Object.hasOwn(config.jobs, name), 'not_found', 'Job not found', 404); action = config.actions[config.jobs[name].action];
      }
      return { quote_microdollars: op === 'prose' ? proseQuote('ask') : price(op, action), cost_microdollars: 0 };
    }
    case 'account': return rpc(env.ACCOUNTS, auth.account, 'account');
    case 'dev-deposit': {
      assert(env.ENVIRONMENT === 'local', 'not_found', 'Not found', 404);
      const body = await readJson(request); money(body.amount_microdollars);
      if (dryRun) return { quote_microdollars: 0, cost_microdollars: 0, development_credit_microdollars: body.amount_microdollars };
      return rpc(env.ACCOUNTS, auth.account, 'dev-deposit', { id: request.headers.get('Idempotency-Key') || crypto.randomUUID(), amount: body.amount_microdollars });
    }
  }
}
/** Main Worker: access checks happen before every handler. */
const worker = {
  async scheduled(_event, env, ctx) { ctx.waitUntil(runCostMonitor(env)); },
  async queue(batch, env, ctx) {
    for (const message of batch.messages) { try { await consume(message, env, ctx); } catch (error) { console.error('Queue operation failed', error.code || 'internal_error'); message.retry(); } }
  },
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    return withDbaCors(request, path, await worker.respond(request, env, path));
  },
  async respond(request, env, path) {
    let cost = 0; let auth = null;
    try {
      if (env.PUBLIC_LIMITER && (path.startsWith('/api/') || path.startsWith('/webhooks/') || path.startsWith('/hook/') || path === '/mcp')) { const limit = await env.PUBLIC_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' }); assert(limit.success, 'rate_limited', 'Request rate exceeded', 429); }
      const idempotency = request.headers.get('Idempotency-Key'); assert(!idempotency || idempotency.length <= 128, 'invalid_idempotency_key', 'Idempotency-Key must be at most 128 characters');
      const preflight = dbaPreflight(request, path); if (preflight) return preflight;
      if (path.startsWith('/hook/') && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key', 'Access-Control-Max-Age': '86400' } });
      const route = matchRoute(request.method, path);
      if (!route && !path.startsWith('/api/') && env.ASSETS && request.method === 'GET') {
        // Explicit HTML handling avoids canonical redirects; resolve directory
        // indexes internally so the home page and docs retain their public URLs.
        const assetUrl = new URL(request.url);
        if (path.endsWith('/')) assetUrl.pathname += 'index.html';
        // The registered devicebasedauth.org redirect URI is extensionless; the workspace handles it.
        if (path === '/auth/dba/callback') assetUrl.pathname = '/app.html';
        return env.ASSETS.fetch(new Request(assetUrl, request));
      }
      assert(route, 'not_found', 'Not found', 404);
      if (route.handler === 'dba-events') { await dbaEvent(request, env); return new Response(null, { status: 204 }); }
      auth = route.access === PUBLIC ? null : await authenticate(request, env);
      // Resource-scoped grants (job:<name>) and grants only devicebasedauth.org can decide (billed) come next.
      if (auth?.dba && !canAccess(auth, route.access)) cost += await authorizeDba(request, env, auth, route);
      assert(canAccess(auth, route.access), 'insufficient_scope', 'Credential does not allow this operation', 403);
      if (route.handler === 'mcp') return mcp(request, env, auth, (path, method, body) => {
        const inner = new Request(new URL(path, request.url), { method, headers: { Authorization: request.headers.get('Authorization'), 'Content-Type': 'application/json', 'Idempotency-Key': request.headers.get('Idempotency-Key') || crypto.randomUUID() }, body: method === 'GET' ? undefined : JSON.stringify(body) });
        // A device credential's DPoP proof was spent on /mcp; tool calls reuse its verified identity.
        return worker.fetch(auth.dba ? forwardAuth(inner, auth) : inner, env);
      });
      if (auth) await rpc(env.ACCOUNTS, auth.account, 'rate-limit', { id: 'api', limit: 120 });
      if (auth?.key_id && request.method === 'GET') {
        const metered = await rpc(env.ACCOUNTS, auth.account, 'meter-read', { id: `read:${crypto.randomUUID()}`, key_id: auth.key_id, resource: route.handler === 'runs' ? 'runs' : null, job: new URL(request.url).searchParams.get('job'), ...(auth.dba ? { dba: auth.dba.verifications || true } : {}) }); cost += metered.cost_microdollars; auth.read_names = metered.names;
      }
      const data = await handle(route, request, env, auth);
      const balance = auth ? await rpc(env.ACCOUNTS, auth.account, 'account') : {};
      if (route.handler === 'runs' && new URL(request.url).searchParams.get('format') === 'ndjson') return new Response(data.items.map(item => JSON.stringify(item)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson', 'X-Next-Before': String(data.next_before || ''), 'X-Next-Cursor': data.next_cursor || '', 'X-Cost-Microdollars': String(cost), 'X-Balance-Microdollars': String(balance.balance_microdollars) } });
      return Response.json({ balance_microdollars: balance.balance_microdollars, ...data, cost_microdollars: cost + (Number.isSafeInteger(data?.cost_microdollars) ? data.cost_microdollars : 0) }, { headers: path.startsWith('/hook/') ? { 'Access-Control-Allow-Origin': '*' } : {} });
    } catch (error) {
      let balance; if (auth) { try { balance = (await rpc(env.ACCOUNTS, auth.account, 'account')).balance_microdollars; } catch { /* Preserve the original failure. */ } }
      error.details = { cost_microdollars: cost, balance_microdollars: balance, ...error.details };
      const response = errorResponse(error); if (new URL(request.url).pathname.startsWith('/hook/')) response.headers.set('Access-Control-Allow-Origin', '*'); return response; }
  }
};

export default worker;
