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
import { JobDO } from './durable-objects/job-do.js';
import { namespace } from '../test-utils/storage.js';
import { rpc } from './utils/rpc.js';
it('declares access for every dispatchable route', () => {
  expect(new Set(API_ROUTES.map(r => `${r.method} ${r.path}`)).size).toBe(API_ROUTES.length);
  for (const route of API_ROUTES) {
    for (const access of [route.access].flat()) expect([PUBLIC, SESSION, ...USER_SCOPES]).toContain(access);
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

it('rejects absent prototype-named definitions before dispatching job operations', async () => {
  const env = { ENVIRONMENT: 'local' }; env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  for (const name of ['constructor', 'toString', '__proto__']) {
    for (const [method, path] of [
      ['POST', `/api/jobs/${name}/run`], ['POST', `/api/jobs/${name}/pause`], ['POST', `/api/jobs/${name}/resume`],
      ['GET', `/api/jobs/${name}/triggers`], ['POST', `/api/jobs/${name}/triggers`],
      ['POST', `/api/actions/${name}/test`], ['GET', `/api/quote?op=run&job=${name}`]
    ]) {
      const response = await worker.fetch(new Request(`http://localhost${path}`, { method, headers: { Authorization: 'LocalDev alice' }, ...(method === 'POST' ? { body: '{}' } : {}) }), env);
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'not_found' });
    }
  }
  expect(env.JOBS.objects.size).toBe(0);
});

it('keeps a deleted constructor-named job deleted during reconciliation', async () => {
  const env = { ENVIRONMENT: 'local' }; env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const call = (op, args) => rpc(env.ACCOUNTS, 'alice', op, args);
  await call('init', { account: 'alice' });
  await rpc(env.JOBS, 'alice:constructor', 'configure', { account: 'alice', name: 'constructor', job: { enabled: false, cron: null } });
  await rpc(env.JOBS, 'alice:constructor', 'wake', { force: true });
  expect(await rpc(env.JOBS, 'alice:constructor', 'status')).toMatchObject({ job: null, paused: 'deleted', next_fire: null });
});
