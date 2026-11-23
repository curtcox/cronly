import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../index.js';
import { authenticate } from './middleware.js';
import { monthlyMicrodollars } from './dba.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { DbaLinkDO } from '../durable-objects/dba-link-do.js';
import { namespace } from '../../test-utils/storage.js';
import { fakeDbaIssuer } from '../../test-utils/dba-issuer.js';
import { rpc } from '../utils/rpc.js';
import { price } from '../utils/pricing.js';

const ORIGIN = 'https://cronly.org';
// A read by a DBA credential also pays for verifying it (pricing.js dbaRequest).
const READ = price('read', {}, { dba: true });
let env; let dba;
beforeEach(async () => {
  dba = await fakeDbaIssuer(); vi.stubGlobal('fetch', (...args) => dba.fetch(...args));
  env = { ENVIRONMENT: 'production', APP_ORIGIN: ORIGIN, DBA_ISSUER: dba.issuer };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env); env.DBA_LINKS = namespace(DbaLinkDO, env);
  await linkAccount('alice', 'dba_alice');
  await rpc(env.ACCOUNTS, 'alice', 'deposit', { id: 'deposit-1', amount: 1000000 });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function linkAccount(account, dbaAccount) {
  await rpc(env.ACCOUNTS, account, 'init', { account });
  await rpc(env.DBA_LINKS, dbaAccount, 'claim', { account });
  await rpc(env.ACCOUNTS, account, 'dba-link-set', { dba_account: dbaAccount, subject: dbaAccount, issuer: dba.issuer });
}
const grants = (...scopes) => [{ actions: scopes.map(scope => `cronly:${scope}`) }];
async function send(device, method, path, { body, headers } = {}) {
  const url = `${ORIGIN}${path}`;
  const response = await worker.fetch(new Request(url, { method, headers: { ...(headers || await device.headers(method, url)), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: response.status, body: await response.json() };
}

it('turns a linked device credential into the granted cronly scopes', async () => {
  const device = await dba.device({ acct: 'dba_alice', grants: [...grants('read', 'run'), { actions: ['hashbin:content:write'] }] });
  const url = `${ORIGIN}/api/account`;
  const auth = await authenticate(new Request(url, { headers: await device.headers('GET', url) }), env);
  expect(auth).toEqual({ account: 'alice', key_id: device.payload.cid, scopes: ['read', 'run'], session: false, dba: { account: 'dba_alice', device_id: device.payload.sub, credential_id: device.payload.cid, kind: 'device', online_scopes: [] } });

  expect(await send(device, 'GET', '/api/account')).toMatchObject({ status: 200, body: { id: 'alice' } });
  // Without cronly:session, SESSION routes (keys, payments, linking) stay out of reach.
  expect(await send(device, 'GET', '/api/keys')).toMatchObject({ status: 403, body: { code: 'insufficient_scope' } });
  expect(await send(device, 'POST', '/api/dba/link/start')).toMatchObject({ status: 403, body: { code: 'insufficient_scope' } });
  const status = await rpc(env.ACCOUNTS, 'alice', 'dba-link-status');
  expect(status.credentials).toEqual([expect.objectContaining({ id: device.payload.cid, dba_account: 'dba_alice', device_id: device.payload.sub, device_name: 'Test laptop', monthly_spend_microdollars: null, expires_at: device.payload.exp * 1000 })]);
});

it('refuses routes whose scope the credential does not grant', async () => {
  const device = await dba.device({ acct: 'dba_alice', grants: grants('read') });
  expect(await send(device, 'PUT', '/api/variables/region', { body: { value: 'us' } })).toMatchObject({ status: 403, body: { code: 'insufficient_scope' } });
  expect(await send(device, 'POST', '/api/jobs/nightly/run', { body: {} })).toMatchObject({ status: 403, body: { code: 'insufficient_scope' } });
  // Grants for another site's namespace, or for another audience, grant nothing here.
  const other = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['hashbin:*'] }] });
  expect(await send(other, 'GET', '/api/account')).toMatchObject({ status: 403, body: { code: 'insufficient_scope' } });
  const elsewhere = await dba.device({ acct: 'dba_alice', aud: ['hashbin.org'], grants: grants('read') });
  expect(await send(elsewhere, 'GET', '/api/account')).toMatchObject({ status: 401, body: { code: 'wrong_audience' } });
  const wide = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:*'] }] });
  expect((await send(wide, 'PUT', '/api/variables/region', { body: { value: 'us' } })).status).toBe(200);
});

it('refuses credentials from unlinked or unconfirmed DBA accounts', async () => {
  const stranger = await dba.device({ acct: 'dba_stranger', grants: grants('read') });
  expect(await send(stranger, 'GET', '/api/account')).toMatchObject({ status: 403, body: { code: 'account_not_linked', dba_account: 'dba_stranger' } });
  // An index claim the account does not confirm (an interrupted link) authorizes nothing.
  await rpc(env.DBA_LINKS, 'dba_half', 'claim', { account: 'alice' });
  const half = await dba.device({ acct: 'dba_half', grants: grants('read') });
  expect(await send(half, 'GET', '/api/account')).toMatchObject({ status: 403, body: { code: 'account_not_linked' } });

  const device = await dba.device({ acct: 'dba_alice', grants: grants('read', 'run') });
  expect((await send(device, 'GET', '/api/account')).status).toBe(200);
  await rpc(env.ACCOUNTS, 'alice', 'dba-unlink');
  expect(await send(device, 'GET', '/api/account')).toMatchObject({ status: 403, body: { code: 'account_not_linked' } });
  // Work queued by the credential re-checks it, so unlinking also refuses its reservations.
  await expect(rpc(env.ACCOUNTS, 'alice', 'reserve', { id: 'later', amount: 85, kind: 'run', key_id: device.payload.cid })).rejects.toMatchObject({ status: 401, code: 'invalid_auth' });
});

it('refuses a revoked credential, including within the status-list cache lifetime once it refreshes', async () => {
  const revoked = await dba.device({ acct: 'dba_alice', grants: grants('read') });
  dba.revoke(revoked.payload);
  expect(await send(revoked, 'GET', '/api/account')).toMatchObject({ status: 401, body: { code: 'revoked' } });

  vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
  const device = await dba.device({ acct: 'dba_alice', grants: grants('read') });
  expect((await send(device, 'GET', '/api/account')).status).toBe(200);
  dba.revoke(device.payload);
  vi.setSystemTime(Date.now() + 61000);
  expect(await send(device, 'GET', '/api/account')).toMatchObject({ status: 401, body: { code: 'revoked' } });
});

it('requires a fresh DPoP proof from the credential key for this request', async () => {
  const device = await dba.device({ acct: 'dba_alice', grants: grants('read') });
  const url = `${ORIGIN}/api/account`; const thief = await dba.device({ acct: 'dba_alice', grants: grants('read') });
  expect(await send(device, 'GET', '/api/account', { headers: { Authorization: `DBA ${device.credential}` } })).toMatchObject({ status: 401, body: { code: 'proof_required' } });
  expect(await send(device, 'GET', '/api/account', { headers: await device.headers('GET', url, { privateKey: thief.privateKey, publicJwk: thief.publicJwk }) })).toMatchObject({ status: 401, body: { code: 'key_mismatch' } });
  expect(await send(device, 'GET', '/api/account', { headers: await device.headers('GET', url, { url: `${ORIGIN}/api/config` }) })).toMatchObject({ status: 401, body: { code: 'invalid_proof' } });
  expect(await send(device, 'GET', '/api/account', { headers: await device.headers('GET', url, { method: 'POST' }) })).toMatchObject({ status: 401, body: { code: 'invalid_proof' } });
  const lower = await device.headers('GET', url);
  expect((await send(device, 'GET', '/api/account', { headers: { ...lower, Authorization: lower.Authorization.replace('DBA ', 'dba ') } })).status).toBe(200);
  const headers = await device.headers('GET', url);
  expect((await send(device, 'GET', '/api/account', { headers })).status).toBe(200);
  expect(await send(device, 'GET', '/api/account', { headers })).toMatchObject({ status: 401, body: { code: 'replayed_proof' } });
});

it('accepts short-lived DBA access tokens as Bearer and leaves other bearer tokens to Clerk', async () => {
  const { token, payload } = await dba.accessToken({ acct: 'dba_alice', grants: grants('read') });
  const result = await send(null, 'GET', '/api/account', { headers: { Authorization: `Bearer ${token}` } });
  expect(result).toMatchObject({ status: 200, body: { id: 'alice', cost_microdollars: READ } });
  expect(await authenticate(new Request(`${ORIGIN}/api/account`, { headers: { Authorization: `Bearer ${token}` } }), env)).toMatchObject({ account: 'alice', key_id: payload.cid, scopes: ['read'], session: false });
  const fresh = await fakeDbaIssuer(); // same kid, different key: it must not verify here
  const foreign = await fresh.accessToken({ acct: 'dba_alice', grants: grants('read') });
  expect(await send(null, 'GET', '/api/account', { headers: { Authorization: `Bearer ${foreign.token}` } })).toMatchObject({ status: 401, body: { code: 'invalid_signature' } });
  expect(await send(null, 'GET', '/api/account', { headers: { Authorization: 'Bearer not-a-dba-token' } })).toMatchObject({ status: 401, body: { code: 'invalid_auth' } });
});

it('meters reads like API keys and enforces the grant spend cap as a monthly key budget', async () => {
  expect(monthlyMicrodollars(0.57)).toBe(570000); expect(monthlyMicrodollars(undefined)).toBe(null);
  const device = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:read', 'cronly:run'], limits: { spend_usd_per_month: 0.00005 } }] });
  const first = await send(device, 'GET', '/api/account');
  expect(first).toMatchObject({ status: 200, body: { cost_microdollars: READ, balance_microdollars: 1000000 - READ } });
  expect((await rpc(env.ACCOUNTS, 'alice', 'dba-link-status')).credentials[0]).toMatchObject({ monthly_spend_microdollars: 50 });
  // 28 µ$ spent; a second read would pass 50 µ$ this UTC month.
  expect(await send(device, 'GET', '/api/transactions')).toMatchObject({ status: 402, body: { code: 'key_budget_month' } });
  expect((await rpc(env.ACCOUNTS, 'alice', 'list', { prefix: 'ledger:' })).items.at(-1)).toMatchObject({ kind: 'read', amount_microdollars: -READ });
  await expect(rpc(env.ACCOUNTS, 'alice', 'reserve', { id: 'run-1', amount: 85, kind: 'run', key_id: device.payload.cid })).rejects.toMatchObject({ status: 402, code: 'key_budget_month' });
  // The cap belongs to that credential; another credential of the same device owner has its own.
  const uncapped = await dba.device({ acct: 'dba_alice', grants: grants('read') });
  expect(await send(uncapped, 'GET', '/api/account')).toMatchObject({ status: 200, body: { cost_microdollars: READ } });
});

it('serves MCP tool calls to a device credential through its single verified proof', async () => {
  const device = await dba.device({ acct: 'dba_alice', grants: grants('read') });
  const result = await send(device, 'POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'balance', arguments: {} } } });
  expect(result.status).toBe(200);
  expect(result.body.result.isError).toBe(false);
  expect(JSON.parse(result.body.result.content[0].text)).toMatchObject({ id: 'alice', cost_microdollars: READ });
});

it('fails closed when devicebasedauth.org cannot be reached', async () => {
  const device = await dba.device({ acct: 'dba_alice', grants: grants('read') });
  vi.stubGlobal('fetch', async () => new Response('unavailable', { status: 503 }));
  expect(await send(device, 'GET', '/api/account')).toMatchObject({ status: 503, body: { code: 'jwks_unavailable' } });
});

it('runs jobs for a device credential under its monthly cap, holding the run against the credential', async () => {
  env.RUN_QUEUE = { send: vi.fn() };
  await rpc(env.ACCOUNTS, 'alice', 'mutate', { account: 'alice', id: 'defs', operations: [{ kind: 'actions', name: 'ping', value: { url: 'https://example.com' } }, { kind: 'jobs', name: 'j', value: { action: 'ping', cron: null } }] });
  await rpc(env.ACCOUNTS, 'alice', 'sync-jobs');
  const capped = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:run'], limits: { spend_usd_per_month: 0.00005 } }] });
  expect(await send(capped, 'POST', '/api/jobs/j/run', { body: {} })).toMatchObject({ status: 402, body: { code: 'key_budget_month' } });
  const device = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:run'], limits: { spend_usd_per_month: 1 } }] });
  expect((await send(device, 'POST', '/api/jobs/j/run', { body: {} })).status).toBe(200);
  expect(env.RUN_QUEUE.send).toHaveBeenCalledTimes(1);
  const { holds } = await rpc(env.ACCOUNTS, 'alice', 'account');
  expect(holds).toHaveLength(1);
  expect(holds[0].id).toContain(`:manual:${device.payload.cid}:`);
});
