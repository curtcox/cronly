// devicebasedauth.org grants restricted to resources (`job:<name>`): decided per route with the
// job the route acts on, offline first, then online when the grant needs DBA (dba-online.js).
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../index.js';
import { dbaResource } from './dba-online.js';
import { matchRoute } from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { DbaLinkDO } from '../durable-objects/dba-link-do.js';
import { namespace } from '../../test-utils/storage.js';
import { fakeDbaIssuer, dbaObjects } from '../../test-utils/dba-issuer.js';
import { rpc } from '../utils/rpc.js';
import { price } from '../utils/pricing.js';

const ORIGIN = 'https://cronly.org';
const DECISION = price('dba_decision');
let env; let dba;
beforeEach(async () => {
  dba = await fakeDbaIssuer(); vi.stubGlobal('fetch', (...args) => dba.fetch(...args));
  env = { ENVIRONMENT: 'production', APP_ORIGIN: ORIGIN, DBA_ISSUER: dba.issuer, RUN_QUEUE: { send: vi.fn() } };
  Object.assign(env, { ACCOUNTS: namespace(AccountDO, env), JOBS: namespace(JobDO, env), DBA_LINKS: namespace(DbaLinkDO, env) }, dbaObjects(env));
  await rpc(env.ACCOUNTS, 'alice', 'init', { account: 'alice' });
  await rpc(env.DBA_LINKS, 'dba_alice', 'claim', { account: 'alice' });
  await rpc(env.ACCOUNTS, 'alice', 'dba-link-set', { dba_account: 'dba_alice', subject: 'dba_alice', issuer: dba.issuer });
  await rpc(env.ACCOUNTS, 'alice', 'deposit', { id: 'deposit-1', amount: 1000000 });
  await rpc(env.ACCOUNTS, 'alice', 'mutate', { account: 'alice', id: 'defs', operations: [{ kind: 'actions', name: 'ping', value: { url: 'https://example.com' } }, ...['nightly-report', 'weekly'].map(name => ({ kind: 'jobs', name, value: { action: 'ping', cron: null } }))] });
  await rpc(env.ACCOUNTS, 'alice', 'sync-jobs');
});
afterEach(() => { vi.unstubAllGlobals(); });

async function send(device, method, path, body) {
  const url = `${ORIGIN}${path}`;
  const response = await worker.fetch(new Request(url, { method, headers: { ...await device.headers(method, url), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: response.status, body: await response.json() };
}
const nightly = extra => dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:read', 'cronly:run'], resources: ['job:nightly-*'], ...extra }] });

it('names the job a route acts on, and nothing for other routes', () => {
  const resource = (method, path) => dbaResource(matchRoute(method, path.split('?')[0]), new URL(`${ORIGIN}${path}`));
  expect(resource('POST', '/api/jobs/nightly-report/run')).toBe('job:nightly-report');
  expect(resource('PUT', '/api/jobs/nightly-report')).toBe('job:nightly-report');
  expect(resource('DELETE', '/api/jobs/nightly-report/triggers/t1')).toBe('job:nightly-report');
  expect(resource('GET', '/api/runs?job=weekly')).toBe('job:weekly');
  // Action-test histories, unfiltered runs and other definitions have no job resource.
  expect(resource('GET', '/api/runs?job=_test:ping')).toBe(null);
  expect(resource('GET', '/api/runs')).toBe(null);
  expect(resource('POST', '/api/actions/ping/test')).toBe(null);
  expect(resource('PUT', '/api/actions/nightly-report')).toBe(null);
  expect(resource('GET', '/api/runs/alice:nightly-report:1')).toBe(null);
});

it('allows a resource-scoped grant only on the jobs it names', async () => {
  const device = await nightly();
  expect((await send(device, 'POST', '/api/jobs/nightly-report/run', {})).status).toBe(200);
  expect(env.RUN_QUEUE.send).toHaveBeenCalledTimes(1);
  expect((await send(device, 'GET', '/api/jobs/nightly-report')).status).toBe(200);
  expect((await send(device, 'GET', '/api/runs?job=nightly-report')).status).toBe(200);
  for (const [method, path, body] of [['POST', '/api/jobs/weekly/run', {}], ['GET', '/api/runs?job=weekly'], ['GET', '/api/runs'], ['GET', '/api/account'], ['GET', '/api/jobs/weekly'], ['POST', '/api/actions/ping/test', {}]]) {
    expect(await send(device, method, path, body)).toMatchObject({ status: 403, body: { code: 'insufficient_scope' } });
  }
  // The grant gives read and run on those jobs, not change.
  expect(await send(device, 'PUT', '/api/jobs/nightly-report', { action: 'ping', cron: null })).toMatchObject({ status: 403, body: { code: 'insufficient_scope' } });
  expect(env.RUN_QUEUE.send).toHaveBeenCalledTimes(1);
  expect(dba.online.calls).toHaveLength(0);
});

it('keeps the other constraints of a resource-scoped grant', async () => {
  const expired = await nightly({ when: { not_after: Math.floor(Date.now() / 1000) - 60 } });
  expect(await send(expired, 'POST', '/api/jobs/nightly-report/run', {})).toMatchObject({ status: 403, body: { code: 'insufficient_scope' } });
  expect(env.RUN_QUEUE.send).not.toHaveBeenCalled();
});

it('asks DBA, with the resource, for a resource-scoped grant only DBA can decide', async () => {
  const device = await nightly({ require: { online: true } });
  expect(await send(device, 'POST', '/api/jobs/nightly-report/run', {})).toMatchObject({ status: 403, body: { code: 'online_required', cost_microdollars: 0 } });
  env.DBA_API_KEY = 'test-online-key';
  const run = await send(device, 'POST', '/api/jobs/nightly-report/run', {});
  expect(run.status).toBe(200);
  expect(run.body.cost_microdollars).toBeGreaterThanOrEqual(DECISION);
  expect(dba.online.calls).toEqual([expect.objectContaining({ action: 'cronly:run', resource: 'job:nightly-report' })]);
  // A job outside the grant's resources is refused without buying a decision.
  expect(await send(device, 'POST', '/api/jobs/weekly/run', {})).toMatchObject({ status: 403, body: { code: 'insufficient_scope', cost_microdollars: 0 } });
  expect(dba.online.calls).toHaveLength(1);
});

it('prefers a free offline resource grant over an online-only unrestricted one', async () => {
  env.DBA_API_KEY = 'test-online-key';
  const device = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:run'], require: { online: true } }, { actions: ['cronly:run'], resources: ['job:nightly-report'] }] });
  expect(await send(device, 'POST', '/api/jobs/nightly-report/run', {})).toMatchObject({ status: 200 });
  expect(dba.online.calls).toHaveLength(0);
  // Elsewhere the unrestricted online grant still applies.
  expect((await send(device, 'POST', '/api/jobs/weekly/run', {})).status).toBe(200);
  expect(dba.online.calls).toEqual([expect.objectContaining({ action: 'cronly:run' })]);
  expect(dba.online.calls[0].resource).toBeUndefined();
});
