// devicebasedauth.org `net.client` grant rules (DBA spec/evaluation.md §3.10): address rules match
// the peer address Cloudflare reports (CF-Connecting-IP), DNS names are resolved over DoH first,
// and latency rules are not measured here, so they refuse.
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { DbaLinkDO } from '../durable-objects/dba-link-do.js';
import { namespace } from '../../test-utils/storage.js';
import { fakeDbaIssuer } from '../../test-utils/dba-issuer.js';
import { rpc } from '../utils/rpc.js';
import { DNS_DEFAULTS } from '../vendor/devicebasedauth/dns.js';

const ORIGIN = 'https://cronly.org';
let env; let dba;
beforeEach(async () => {
  dba = await fakeDbaIssuer(); vi.stubGlobal('fetch', (...args) => dba.fetch(...args));
  env = { ENVIRONMENT: 'production', APP_ORIGIN: ORIGIN, DBA_ISSUER: dba.issuer };
  Object.assign(env, { ACCOUNTS: namespace(AccountDO, env), JOBS: namespace(JobDO, env), DBA_LINKS: namespace(DbaLinkDO, env) });
  await rpc(env.ACCOUNTS, 'alice', 'init', { account: 'alice' });
  await rpc(env.DBA_LINKS, 'dba_alice', 'claim', { account: 'alice' });
  await rpc(env.ACCOUNTS, 'alice', 'dba-link-set', { dba_account: 'dba_alice', subject: 'dba_alice', issuer: dba.issuer });
  await rpc(env.ACCOUNTS, 'alice', 'deposit', { id: 'deposit-1', amount: 1000000 });
});
afterEach(() => { vi.unstubAllGlobals(); });

async function read(device, ip) {
  const url = `${ORIGIN}/api/account`;
  const headers = { ...await device.headers('GET', url), ...(ip ? { 'CF-Connecting-IP': ip } : {}) };
  const response = await worker.fetch(new Request(url, { headers }), env);
  return { status: response.status, body: await response.json() };
}
const device = net => dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:read'], net: { client: net } }] });
const dohCalls = () => dba.calls.filter(url => url.startsWith(DNS_DEFAULTS.endpoint));

it('accepts vocabulary 2 credentials and allows a CIDR rule only from inside its ranges', async () => {
  const office = await device({ addresses: { cidrs: ['203.0.113.0/24', '2001:db8::/32'] } });
  expect(office.payload.ver).toBe(2);
  expect((await read(office, '203.0.113.7')).status).toBe(200);
  expect((await read(office, '2001:DB8:0::1')).status).toBe(200);
  expect(await read(office, '198.51.100.7')).toMatchObject({ status: 403, body: { code: 'insufficient_scope' } });
  // No peer address (never the case behind Cloudflare) is address_unavailable: refused.
  expect((await read(office)).status).toBe(403);
  // Other grants without net still work from anywhere.
  const mixed = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:run'], net: { client: { addresses: { cidrs: ['203.0.113.0/24'] } } } }, { actions: ['cronly:read'] }] });
  expect((await read(mixed, '198.51.100.7')).status).toBe(200);
  expect(dohCalls()).toEqual([]);
});

it('resolves DNS names in cronly grants over DoH, caches them, and refuses when they do not resolve', async () => {
  Object.assign(dba.dns, { 'vpn.example.com': ['192.0.2.10', '2001:db8::10'] });
  const vpn = await device({ addresses: { dns: { names: ['vpn.example.com', 'gone.example.com'] } } });
  expect((await read(vpn, '192.0.2.10')).status).toBe(200);
  expect((await read(vpn, '2001:db8::10')).status).toBe(200);
  expect((await read(vpn, '192.0.2.11')).status).toBe(403);
  // One A and one AAAA query per name, then the answers are cached for their TTL.
  expect(dohCalls()).toHaveLength(4);
  // A name that requires DNSSEC refuses an answer the resolver did not validate.
  const strict = await device({ addresses: { dns: { names: ['vpn.example.com'], dnssec: true } } });
  expect((await read(strict, '192.0.2.10')).status).toBe(403);
});

it('fails closed when DNS is unavailable and leaves other sites\' names alone', async () => {
  dba.dns.fail = true;
  const vpn = await device({ addresses: { dns: { names: ['down.example.com'] } } });
  expect((await read(vpn, '192.0.2.10')).status).toBe(403);
  dba.dns.fail = false; dba.calls.length = 0;
  const other = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:read'] }, { actions: ['hashbin:*'], net: { client: { addresses: { dns: { names: ['hashbin-only.example.com'] } } } } }] });
  expect((await read(other, '192.0.2.10')).status).toBe(200);
  expect(dohCalls()).toEqual([]);
});

it('refuses latency rules, which cronly does not measure', async () => {
  const near = await device({ latency: { max_rtt_ms: 50 } });
  expect(await read(near, '203.0.113.7')).toMatchObject({ status: 403, body: { code: 'insufficient_scope' } });
});
