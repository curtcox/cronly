// Device sessions, online decisions, the revocation webhook, the shared replay cache, CORS and
// queued retries for devicebasedauth.org credentials (src/auth/dba-online.js, dba-cors.js,
// src/api/dba-events.js, DbaRevocationsDO).
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../index.js';
import { forgetPushedDbaRevocations } from './dba.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { DbaLinkDO } from '../durable-objects/dba-link-do.js';
import { namespace } from '../../test-utils/storage.js';
import { fakeDbaIssuer, dbaObjects } from '../../test-utils/dba-issuer.js';
import { consume } from '../executor/consumer.js';
import { rpc } from '../utils/rpc.js';
import { price } from '../utils/pricing.js';

const ORIGIN = 'https://cronly.org';
const READ = price('read', {}, { dba: true }); const DECISION = price('dba_decision');
const START = 1000000;
let env; let dba;
beforeEach(async () => {
  dba = await fakeDbaIssuer(); vi.stubGlobal('fetch', (...args) => dba.fetch(...args));
  env = { ENVIRONMENT: 'production', APP_ORIGIN: ORIGIN, DBA_ISSUER: dba.issuer };
  Object.assign(env, { ACCOUNTS: namespace(AccountDO, env), JOBS: namespace(JobDO, env), DBA_LINKS: namespace(DbaLinkDO, env) }, dbaObjects(env));
  await rpc(env.ACCOUNTS, 'alice', 'init', { account: 'alice' });
  await rpc(env.DBA_LINKS, 'dba_alice', 'claim', { account: 'alice' });
  await rpc(env.ACCOUNTS, 'alice', 'dba-link-set', { dba_account: 'dba_alice', subject: 'dba_alice', issuer: dba.issuer });
  await rpc(env.ACCOUNTS, 'alice', 'deposit', { id: 'deposit-1', amount: START });
});
afterEach(() => { vi.unstubAllGlobals(); forgetPushedDbaRevocations(); });

const grants = (...scopes) => [{ actions: scopes.map(scope => `cronly:${scope}`) }];
async function raw(method, path, headers = {}, body) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body }), env);
}
async function send(device, method, path, { body, headers } = {}) {
  const response = await raw(method, path, headers || await device.headers(method, `${ORIGIN}${path}`), body === undefined ? undefined : JSON.stringify(body));
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const balance = async () => (await rpc(env.ACCOUNTS, 'alice', 'account')).balance_microdollars;

it('gives cronly:session SESSION routes and every scope, never key or link management', async () => {
  const device = await dba.device({ acct: 'dba_alice', grants: grants('session') });
  expect(await send(device, 'GET', '/api/keys')).toMatchObject({ status: 200, body: { cost_microdollars: READ } });
  expect((await send(device, 'PUT', '/api/variables/region', { body: { value: 'us' } })).status).toBe(200);
  expect(await send(device, 'GET', '/api/dba/link')).toMatchObject({ status: 200, body: { linked: true } });
  // A stolen device session must not mint long-lived keys or move the DBA link.
  for (const [method, path] of [['POST', '/api/keys'], ['DELETE', '/api/keys/key_1'], ['POST', '/api/dba/link/start'], ['POST', '/api/dba/link/finish'], ['DELETE', '/api/dba/link']]) {
    expect(await send(device, method, path, { body: {} })).toMatchObject({ status: 403, body: { code: 'insufficient_scope' } });
  }
});

it('refuses online-only grants when cronly.org has no DBA_API_KEY, without charging', async () => {
  const device = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:read'], require: { online: true } }] });
  expect(await send(device, 'GET', '/api/account')).toMatchObject({ status: 403, body: { code: 'online_required', cost_microdollars: 0 } });
  expect(dba.online.calls).toHaveLength(0);
  expect(await balance()).toBe(START);
});

it('asks DBA for online-only scopes and charges the decision on top of the request', async () => {
  env.DBA_API_KEY = 'test-online-key';
  const device = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:read'], limits: { uses: { count: 5, per: 'day' } } }] });
  expect(await send(device, 'GET', '/api/account')).toMatchObject({ status: 200, body: { cost_microdollars: DECISION + READ, balance_microdollars: START - DECISION - READ } });
  expect(dba.online.calls).toEqual([expect.objectContaining({ audience: 'cronly.org', action: 'cronly:read', authorization: 'ApiKey test-online-key' })]);
  expect((await rpc(env.ACCOUNTS, 'alice', 'list', { prefix: 'ledger:' })).items.map(e => e.kind)).toContain('dba_decision');
  // Scopes the credential has offline are never asked about.
  const offline = await dba.device({ acct: 'dba_alice', grants: grants('read') });
  expect((await send(offline, 'GET', '/api/account')).status).toBe(200);
  expect(dba.online.calls).toHaveLength(1);
});

it('charges decisions DBA made, including gate waits and denials, and releases ones it could not make', async () => {
  env.DBA_API_KEY = 'test-online-key';
  const device = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:read'], require: { step_up: true } }] });
  const cases = [
    [{ allow: false, code: 'gate_pending', gate_request: { id: 'gr_1' } }, 200, 403, { code: 'gate_pending', gate_request: { id: 'gr_1' } }, DECISION],
    [{ allow: false, reasons: ['use_limit'] }, 200, 403, { code: 'dba_denied', reasons: ['use_limit'] }, DECISION],
    [{ code: 'revoked', error: 'Credential revoked' }, 401, 401, { code: 'invalid_auth', dba_code: 'revoked' }, DECISION],
    [{ code: 'internal', error: 'boom' }, 500, 503, { code: 'dba_unavailable' }, 0],
    [{ code: 'payment_required', error: 'unfunded' }, 402, 503, { code: 'dba_unavailable' }, 0],
    [{ code: 'rate_limited', error: 'slow down' }, 429, 503, { code: 'dba_unavailable' }, 0],
    [{ code: 'invalid_request', error: 'bad' }, 400, 503, { code: 'dba_unavailable' }, 0]
  ];
  for (const [answer, status, expected, body, charged] of cases) {
    Object.assign(dba.online, { answer, status });
    const before = await balance();
    expect(await send(device, 'GET', '/api/account')).toMatchObject({ status: expected, body: { ...body, cost_microdollars: charged } });
    expect(await balance()).toBe(before - charged);
  }
  vi.stubGlobal('fetch', (url, init) => String(url).endsWith('/api/v1/authorize') ? Promise.reject(new Error('offline')) : dba.fetch(url, init));
  expect(await send(device, 'GET', '/api/account')).toMatchObject({ status: 503, body: { code: 'dba_unavailable', cost_microdollars: 0 } });
  expect((await rpc(env.ACCOUNTS, 'alice', 'account')).held_microdollars).toBe(0);
});

it('never buys a decision for a dry run', async () => {
  env.DBA_API_KEY = 'test-online-key';
  const device = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:change'], require: { step_up: true } }] });
  expect(await send(device, 'PUT', '/api/variables/region?dry_run=1', { body: { value: 'us' } })).toMatchObject({ status: 403, body: { code: 'online_decision_required', cost_microdollars: 0 } });
  expect(dba.online.calls).toHaveLength(0);
  expect(await balance()).toBe(START);
});

it('holds the decision under the credential cap before asking DBA', async () => {
  env.DBA_API_KEY = 'test-online-key';
  const device = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:read'], require: { online: true }, limits: { spend_usd_per_month: 0.00005 } }] });
  expect(await send(device, 'GET', '/api/account')).toMatchObject({ status: 402, body: { code: 'key_budget_month' } });
  expect(dba.online.calls).toHaveLength(0);
  expect(await balance()).toBe(START);
});

it('asks DBA for an online-only device session on SESSION routes only', async () => {
  env.DBA_API_KEY = 'test-online-key';
  const device = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:session'], require: { step_up: true } }] });
  expect(await send(device, 'GET', '/api/keys')).toMatchObject({ status: 200, body: { cost_microdollars: DECISION + READ } });
  expect(dba.online.calls.map(call => call.action)).toEqual(['cronly:session']);
  // ACCOUNT_SESSION routes never accept a device session, so DBA is not asked (or paid).
  expect(await send(device, 'POST', '/api/keys', { body: {} })).toMatchObject({ status: 403, body: { code: 'insufficient_scope', cost_microdollars: 0 } });
  expect(dba.online.calls).toHaveLength(1);
});

it('makes actions online-only when the cronly.org catalog requires gates for them', async () => {
  dba.catalog.push({ action: 'cronly:run', gates: { require: true } });
  const device = await dba.device({ acct: 'dba_alice', grants: grants('read', 'run') });
  expect((await send(device, 'GET', '/api/account')).status).toBe(200);
  expect(await send(device, 'POST', '/api/jobs/nightly/run', { body: {} })).toMatchObject({ status: 403, body: { code: 'online_required' } });
});

it('records revocations DBA pushes to the webhook and refuses those credentials', async () => {
  const device = await dba.device({ acct: 'dba_alice', grants: grants('read') });
  const other = await dba.device({ acct: 'dba_alice', grants: grants('read') });
  expect((await send(device, 'GET', '/api/account')).status).toBe(200);
  const { cid, jti, exp, status } = { ...device.payload, status: device.payload.status.status_list };
  const event = await dba.signEvent({ type: 'credentials.revoked', credentials: [{ cid, jti, exp, status }] });
  const delivered = await raw('POST', '/api/dba/events', { 'Content-Type': 'application/jwt' }, event);
  expect(delivered.status).toBe(204);
  // A redelivery is recorded again rather than skipped (an earlier write may have failed).
  expect((await raw('POST', '/api/dba/events', { 'Content-Type': 'application/jwt' }, event)).status).toBe(204);
  expect((await rpc(env.DBA_REVOCATIONS, 'global', 'revoked')).revoked).toEqual([`${status.uri}#${status.idx}`]);
  expect(await send(device, 'GET', '/api/account')).toMatchObject({ status: 401 });
  expect((await send(other, 'GET', '/api/account')).status).toBe(200);

  expect((await raw('POST', '/api/dba/events', {}, await dba.signEvent({ type: 'webhook.test' }))).status).toBe(204);
  // DBA may batch more entries than one DbaRevocationsDO call takes; all of them are recorded.
  const many = Array.from({ length: 150 }, (_, idx) => ({ cid: `crd_${idx}`, jti: `crd_${idx}.1`, exp, status: { uri: status.uri, idx: 1000 + idx } }));
  expect((await raw('POST', '/api/dba/events', {}, await dba.signEvent({ type: 'credentials.revoked', credentials: many }))).status).toBe(204);
  expect((await rpc(env.DBA_REVOCATIONS, 'global', 'revoked')).revoked).toHaveLength(151);
  expect(await (await raw('POST', '/api/dba/events', {}, 'not-a-jws')).json()).toMatchObject({ code: 'invalid_event', dba_code: 'invalid_format' });
  const foreign = await (await fakeDbaIssuer()).signEvent({ type: 'webhook.test' });
  expect((await raw('POST', '/api/dba/events', {}, foreign)).status).toBe(400);
  expect((await raw('POST', '/api/dba/events', {}, await dba.signEvent({ type: 'webhook.test', aud: 'hashbin.org' }))).status).toBe(400);
});

it('refuses credentials recorded as revoked by another isolate', async () => {
  const device = await dba.device({ acct: 'dba_alice', grants: grants('read') });
  expect((await send(device, 'GET', '/api/account')).status).toBe(200);
  const { status_list: status } = device.payload.status;
  await rpc(env.DBA_REVOCATIONS, 'global', 'revoke', { credentials: [{ cid: device.payload.cid, exp: device.payload.exp, status }] });
  forgetPushedDbaRevocations();
  expect(await send(device, 'GET', '/api/account')).toMatchObject({ status: 401, body: { code: 'revoked' } });
});

it('claims each DPoP proof once across verifiers that share the replay cache', async () => {
  const device = await dba.device({ acct: 'dba_alice', grants: grants('read') });
  const headers = await device.headers('GET', `${ORIGIN}/api/account`);
  expect((await send(device, 'GET', '/api/account', { headers })).status).toBe(200);
  // DBA_API_KEY selects a different verifier instance with its own in-memory replay set, as
  // another isolate would have; only the shared cache can catch the replay.
  env.DBA_API_KEY = 'test-online-key';
  expect(await send(device, 'GET', '/api/account', { headers })).toMatchObject({ status: 401, body: { code: 'replayed_proof' } });
});

it('adds any-origin CORS for device credentials only', async () => {
  const preflight = await raw('OPTIONS', '/api/account', { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization, dpop' });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('DPoP');
  expect((await raw('OPTIONS', '/api/account', { 'Access-Control-Request-Headers': 'authorization' })).headers.get('Access-Control-Allow-Origin')).toBe(null);

  const device = await dba.device({ acct: 'dba_alice', grants: grants('read') });
  const ok = await send(device, 'GET', '/api/account');
  expect([ok.headers.get('Access-Control-Allow-Origin'), ok.headers.get('Access-Control-Expose-Headers')]).toEqual(['*', 'X-Next-Before, DPoP-Nonce, WWW-Authenticate']);
  expect((await send(device, 'PUT', '/api/variables/region', { body: { value: 'us' } })).headers.get('Access-Control-Allow-Origin')).toBe('*');
  // Bearer access tokens are exportable, so they get no CORS.
  const { token } = await dba.accessToken({ acct: 'dba_alice', grants: grants('read') });
  const bearer = await send(null, 'GET', '/api/account', { headers: { Authorization: `Bearer ${token}` } });
  expect(bearer.status).toBe(200);
  expect(bearer.headers.get('Access-Control-Allow-Origin')).toBe(null);
});

it('drops a queued retry whose credential DBA has since revoked', async () => {
  const messages = []; env.RUN_QUEUE = { send: async body => messages.push(body) };
  env.OUTBOUND_FETCH = async () => new Response('failed', { status: 500 });
  await rpc(env.ACCOUNTS, 'alice', 'mutate', { account: 'alice', id: 'defs', operations: [{ kind: 'actions', name: 'ping', value: { url: 'https://example.com' } }, { kind: 'jobs', name: 'j', value: { action: 'ping', cron: null, retries: 1 } }, { kind: 'jobs', name: 'k', value: { action: 'ping', cron: null, retries: 1 } }] });
  await rpc(env.ACCOUNTS, 'alice', 'sync-jobs');

  const live = await dba.device({ acct: 'dba_alice', grants: grants('run') });
  expect((await send(live, 'POST', '/api/jobs/j/run', { body: {} })).status).toBe(200);
  await consume({ body: messages[0], ack() {} }, env, {});
  expect(messages).toHaveLength(2); // the live credential's retry was queued
  await consume({ body: messages[1], ack() {} }, env, {});

  const revoked = await dba.device({ acct: 'dba_alice', grants: grants('run') });
  expect((await send(revoked, 'POST', '/api/jobs/k/run', { body: {} })).status).toBe(200);
  await rpc(env.DBA_REVOCATIONS, 'global', 'revoke', { credentials: [{ cid: revoked.payload.cid, exp: revoked.payload.exp, status: revoked.payload.status.status_list }] });
  forgetPushedDbaRevocations();
  await consume({ body: messages[2], ack() {} }, env, {});
  expect(messages).toHaveLength(3);
  expect((await rpc(env.ACCOUNTS, 'alice', 'dba-key-status', { credential_id: revoked.payload.cid })).revoked).toBe(true);
  expect((await rpc(env.ACCOUNTS, 'alice', 'account')).held_microdollars).toBe(0);
});
