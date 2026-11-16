import { runJob } from './api/jobs.js';
import { consume } from './executor/consumer.js';
import { definitions, keys } from './api/definitions.js';
import { clerkWebhook } from './auth/clerk-webhook.js';
import { checkout, stripeWebhook } from './api/payments.js';
import { explainCron } from './services/cron.js';
import { PUBLIC, SESSION, canAccess } from './auth/scopes.js';
import { authenticate } from './auth/middleware.js';
import { errorResponse, assert, readJson } from './utils/errors.js';
import { rpc } from './utils/rpc.js';
import { price } from './utils/pricing.js';
export { AccountDO } from './durable-objects/account-do.js';
export { JobDO } from './durable-objects/job-do.js';

// Routes are the sole dispatch source: an undeclared endpoint cannot execute.
export const API_ROUTES = [
  { method: 'GET', path: '/health', access: PUBLIC, handler: 'health' },
  { method: 'GET', path: '/api/account', access: 'read', handler: 'account' },
  { method: 'GET', path: '/api/quote', access: PUBLIC, handler: 'quote' },
  { method: 'POST', path: '/api/dev/deposit', access: SESSION, handler: 'dev-deposit' },
  { method: 'POST', path: '/webhooks/clerk', access: PUBLIC, handler: 'clerk-webhook' },
  { method: 'POST', path: '/webhooks/stripe', access: PUBLIC, handler: 'stripe-webhook' },
  { method: 'POST', path: '/api/payments/checkout', access: SESSION, handler: 'checkout' },
  { method: 'GET', path: '/api/transactions', access: 'read', handler: 'transactions' },
  { method: 'GET', path: '/api/audit', access: 'read', handler: 'audit' },
  { method: 'POST', path: '/api/jobs/:name/run', access: 'run', handler: 'run-job' },
  { method: 'GET', path: '/api/keys', access: SESSION, handler: 'keys' },
  { method: 'POST', path: '/api/keys', access: SESSION, handler: 'keys' },
  { method: 'DELETE', path: '/api/keys/:id', access: SESSION, handler: 'keys' },
  { method: 'POST', path: '/api/cron/explain', access: PUBLIC, handler: 'cron-explain' },
  ...['variables', 'secrets', 'actions', 'jobs'].flatMap(kind => ['GET', 'PUT', 'DELETE'].map(method => ({ method, path: `/api/${kind}/:name`, access: method === 'GET' ? 'read' : kind === 'secrets' ? 'secrets:write' : 'change', handler: 'definitions', kind })))
];
/** Match declared routes with named segments only. */
export function matchRoute(method, path) {
  for (const route of API_ROUTES) {
    if (route.method !== method) continue;
    const names = [];
    const pattern = route.path.replace(/:[a-z_]+/g, name => { names.push(name.slice(1)); return '([^/]+)'; });
    const match = path.match(new RegExp(`^${pattern}$`));
    if (match) return { ...route, params: { ...(route.kind ? { kind: route.kind } : {}), ...Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1])])) } };
  }
  return null;
}
async function handle(route, request, env, auth) {
  const url = new URL(request.url); const dryRun = url.searchParams.get('dry_run') === '1';
  switch (route.handler) {
    case 'run-job': return runJob(route, request, env, auth);
    case 'definitions': return definitions(route, request, env, auth);
    case 'keys': return keys(route, request, env, auth);
    case 'clerk-webhook': return clerkWebhook(request, env);
    case 'stripe-webhook': return stripeWebhook(request, env);
    case 'checkout': return checkout(request, env, auth, dryRun);
    case 'transactions': return rpc(env.ACCOUNTS, auth.account, 'list', { prefix: 'ledger:', reverse: true });
    case 'audit': return rpc(env.ACCOUNTS, auth.account, 'list', { prefix: 'audit:', reverse: true });
    case 'cron-explain': { const body = await readJson(request); return { ...explainCron(body.cron, body.timezone), cost_microdollars: 0 }; }
    case 'health': return { status: 'ok', environment: env.ENVIRONMENT, git_sha: env.GIT_SHA || 'local' };
    case 'quote': return { quote_microdollars: price(new URL(request.url).searchParams.get('op')), cost_microdollars: 0 };
    case 'account': return rpc(env.ACCOUNTS, auth.account, 'account');
    case 'dev-deposit': {
      assert(env.ENVIRONMENT === 'local', 'not_found', 'Not found', 404);
      const body = await readJson(request);
      return rpc(env.ACCOUNTS, auth.account, 'dev-deposit', { id: request.headers.get('Idempotency-Key') || crypto.randomUUID(), amount: body.amount_microdollars });
    }
  }
}
/** Main Worker: access checks happen before every handler. */
export default {
  async queue(batch, env, ctx) {
    for (const message of batch.messages) { try { await consume(message, env, ctx); } catch { message.retry(); } }
  },
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      const route = matchRoute(request.method, path);
      if (!route && !path.startsWith('/api/') && env.ASSETS && request.method === 'GET') return env.ASSETS.fetch(request);
      assert(route, 'not_found', 'Not found', 404);
      const auth = route.access === PUBLIC ? null : await authenticate(request, env);
      assert(canAccess(auth, route.access), 'insufficient_scope', 'Credential does not allow this operation', 403);
      if (auth) await rpc(env.ACCOUNTS, auth.account, 'rate-limit', { id: 'api', limit: 120 });
      let cost = 0;
      if (auth?.key_id && request.method === 'GET' && !new URL(request.url).searchParams.has('dry_run')) {
        const metered = await rpc(env.ACCOUNTS, auth.account, 'meter-read', { id: `read:${crypto.randomUUID()}`, key_id: auth.key_id }); cost = metered.cost_microdollars;
      }
      const data = await handle(route, request, env, auth);
      const balance = auth ? await rpc(env.ACCOUNTS, auth.account, 'account') : {};
      return Response.json({ cost_microdollars: cost, balance_microdollars: balance.balance_microdollars, ...data });
    } catch (error) { return errorResponse(error); }
  }
};
