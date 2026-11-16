import { describe, it, expect } from 'vitest';
import worker from './index.js';
describe('Worker', () => {
  it('reports health without credentials', async () => {
    const response = await worker.fetch(new Request('https://cronly.org/health'), { ENVIRONMENT: 'local' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', environment: 'local' });
  });
  it('returns structured errors', async () => {
    const response = await worker.fetch(new Request('https://cronly.org/missing'), {});
    expect(response.status).toBe(404);
    expect(await response.json()).toHaveProperty('code', 'not_found');
  });
});

import { API_ROUTES, matchRoute } from './index.js';
import { PUBLIC, SESSION, USER_SCOPES } from './auth/scopes.js';
import { AccountDO } from './durable-objects/account-do.js';
import { namespace } from '../test-utils/storage.js';
it('declares access for every dispatchable route', () => {
  expect(new Set(API_ROUTES.map(r => `${r.method} ${r.path}`)).size).toBe(API_ROUTES.length);
  for (const route of API_ROUTES) {
    expect([PUBLIC, SESSION, ...USER_SCOPES]).toContain(route.access);
    expect(matchRoute(route.method, route.path.replaceAll(/:[a-z_]+/g, 'example'))?.handler).toBe(route.handler);
  }
});
it('supports local accounts and dev deposits only in local mode', async () => {
  const env = { ENVIRONMENT: 'local' }; env.ACCOUNTS = namespace(AccountDO, env);
  const req = (path, options = {}) => new Request(`http://localhost${path}`, { ...options, headers: { Authorization: 'LocalDev alice', ...options.headers } });
  expect((await worker.fetch(req('/api/account'), env)).status).toBe(200);
  const result = await worker.fetch(req('/api/dev/deposit', { method: 'POST', body: JSON.stringify({ amount_microdollars: 5000000 }) }), env);
  expect(await result.json()).toHaveProperty('balance_microdollars', 5000000);
  env.ENVIRONMENT = 'production'; expect((await worker.fetch(req('/api/account'), env)).status).toBe(401);
});
