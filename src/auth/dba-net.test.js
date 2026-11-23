// devicebasedauth.org `net.client` grant rules (DBA spec/evaluation.md §3.10): address rules match
// the peer address Cloudflare reports (CF-Connecting-IP), DNS names are resolved over DoH first,
// and latency rules are timed with stateless DPoP nonces when DBA_RTT_SECRET is set.
import { it, expect, beforeEach, afterEach, vi, describe } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { DbaLinkDO } from '../durable-objects/dba-link-do.js';
import { namespace } from '../../test-utils/storage.js';
import { fakeDbaIssuer } from '../../test-utils/dba-issuer.js';
import { rpc } from '../utils/rpc.js';
import { DNS_DEFAULTS } from '../vendor/devicebasedauth/dns.js';
import { price, PRICES } from '../utils/pricing.js';

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

it('refuses latency rules without DBA_RTT_SECRET, which cronly then cannot measure', async () => {
  const near = await device({ latency: { max_rtt_ms: 50 } });
  expect(await read(near, '203.0.113.7')).toMatchObject({ status: 403, body: { code: 'insufficient_scope' } });
});

describe('timed DPoP challenges (net.client.latency)', () => {
  const IP = '203.0.113.7';
  beforeEach(() => { env.DBA_RTT_SECRET = 'x'.repeat(32); vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] }); });
  afterEach(() => { vi.useRealTimers(); });
  const balance = async () => (await rpc(env.ACCOUNTS, 'alice', 'account')).balance_microdollars;
  // Send, and when challenged, answer after `delays[i]` ms with the nonce (as DBA's CLI does).
  async function timed(credential, delays, { ip = IP, path = '/api/account', method = 'GET', answerWith = credential } = {}) {
    const url = `${ORIGIN}${path}`; const seen = [];
    let nonce;
    for (let i = 0; ; i++) {
      const headers = { ...await (i ? answerWith : credential).headers(method, url, nonce ? { nonce } : {}), 'CF-Connecting-IP': ip };
      const response = await worker.fetch(new Request(url, { method, headers, body: method === 'GET' ? undefined : '{}' }), env);
      const body = await response.json(); seen.push(response.status);
      if (response.status !== 401 || body.code !== 'use_dpop_nonce' || i >= delays.length) return { status: response.status, body, seen, response };
      expect(response.headers.get('DPoP-Nonce')).toBe(body.dpop_nonce);
      expect(response.headers.get('WWW-Authenticate')).toMatch(/use_dpop_nonce/);
      nonce = body.dpop_nonce; vi.setSystemTime(Date.now() + delays[i]);
    }
  }

  it('challenges, times the retry and charges one more dbaRequest per answered challenge', async () => {
    const near = await device({ latency: { max_rtt_ms: 50 } });
    const before = await balance();
    const result = await timed(near, [20]);
    expect(result.seen).toEqual([401, 200]);
    expect(result.body.cost_microdollars).toBe(price('read', {}, { dba: 2 }));
    expect(price('read', {}, { dba: 2 })).toBe(PRICES.read + 2 * PRICES.dbaRequest);
    // The challenge itself charged nothing.
    expect(before - await balance()).toBe(result.body.cost_microdollars);
  });

  it('refuses a slow answer, and takes the best of a grant\'s samples', async () => {
    expect((await timed(await device({ latency: { max_rtt_ms: 50 } }), [120])).seen).toEqual([401, 403]);
    const result = await timed(await device({ latency: { max_rtt_ms: 50, samples: 3 } }), [120, 90, 10]);
    expect(result.seen).toEqual([401, 401, 401, 200]);
    expect(result.body.cost_microdollars).toBe(price('read', {}, { dba: 4 }));
  });

  it('binds a nonce to the key and the peer address it was issued to', async () => {
    const near = await device({ latency: { max_rtt_ms: 50 } });
    expect((await timed(near, [10], { answerWith: await device({ latency: { max_rtt_ms: 50 } }) })).seen).toEqual([401, 401]);
    const url = `${ORIGIN}/api/account`;
    const first = await worker.fetch(new Request(url, { headers: { ...await near.headers('GET', url), 'CF-Connecting-IP': IP } }), env);
    const nonce = (await first.json()).dpop_nonce;
    const moved = await worker.fetch(new Request(url, { headers: { ...await near.headers('GET', url, { nonce }), 'CF-Connecting-IP': '198.51.100.9' } }), env);
    expect(moved.status).toBe(401);
  });

  it('reuses a passing measurement for the grant\'s reuse_s', async () => {
    const near = await device({ latency: { max_rtt_ms: 50, reuse_s: 60 } });
    expect((await timed(near, [10])).seen).toEqual([401, 200]);
    const again = await timed(near, []);
    expect(again).toMatchObject({ status: 200, body: { cost_microdollars: price('read', {}, { dba: true }) } });
    vi.setSystemTime(Date.now() + 61000);
    expect((await timed(near, [])).status).toBe(401);
  });

  it('quotes runs with the challenges answered and leaves untimed scopes alone', async () => {
    await rpc(env.ACCOUNTS, 'alice', 'mutate', { account: 'alice', id: 'defs', operations: [{ kind: 'actions', name: 'ping', value: { url: 'https://example.com' } }, { kind: 'jobs', name: 'nightly', value: { action: 'ping', cron: null } }] });
    await rpc(env.ACCOUNTS, 'alice', 'sync-jobs');
    const credential = await dba.device({ acct: 'dba_alice', grants: [{ actions: ['cronly:run'], net: { client: { latency: { max_rtt_ms: 50 } } } }, { actions: ['cronly:read'] }] });
    // Reads come from the untimed grant: no challenge.
    expect((await timed(credential, [10])).seen).toEqual([200]);
    const run = await timed(credential, [10], { method: 'POST', path: '/api/jobs/nightly/run?dry_run=1' });
    expect(run.seen).toEqual([401, 200]);
    expect(run.body.quote_microdollars).toBe(price('run', { type: 'http' }, { dba: 2 }));
    expect(run.response.headers.get('Access-Control-Expose-Headers')).toContain('DPoP-Nonce');
  });
});
