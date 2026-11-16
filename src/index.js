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
  { method: 'POST', path: '/api/dev/deposit', access: SESSION, handler: 'dev-deposit' }
];
/** Match declared routes with named segments only. */
export function matchRoute(method, path) {
  for (const route of API_ROUTES) {
    if (route.method !== method) continue;
    const names = [];
    const pattern = route.path.replace(/:[a-z_]+/g, name => { names.push(name.slice(1)); return '([^/]+)'; });
    const match = path.match(new RegExp(`^${pattern}$`));
    if (match) return { ...route, params: Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1])])) };
  }
  return null;
}
async function handle(route, request, env, auth) {
  switch (route.handler) {
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
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      const route = matchRoute(request.method, path);
      if (!route && !path.startsWith('/api/') && env.ASSETS && request.method === 'GET') return env.ASSETS.fetch(request);
      assert(route, 'not_found', 'Not found', 404);
      const auth = route.access === PUBLIC ? null : await authenticate(request, env);
      assert(canAccess(auth, route.access), 'insufficient_scope', 'Credential does not allow this operation', 403);
      return Response.json(await handle(route, request, env, auth));
    } catch (error) { return errorResponse(error); }
  }
};
