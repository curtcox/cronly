import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { DbaLinkDO } from '../durable-objects/dba-link-do.js';
import { DBA_STATE_TTL_MS } from '../durable-objects/dba-account.js';
import { namespace } from '../../test-utils/storage.js';
import { fakeDbaIssuer } from '../../test-utils/dba-issuer.js';
import { rpc } from '../utils/rpc.js';
import { price } from '../utils/pricing.js';

let env; let dba; let funded;
beforeEach(async () => {
  funded = new Set();
  dba = await fakeDbaIssuer(); vi.stubGlobal('fetch', (...args) => dba.fetch(...args));
  env = { ENVIRONMENT: 'local', APP_ORIGIN: 'https://cronly.org', DBA_ISSUER: dba.issuer };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env); env.DBA_LINKS = namespace(DbaLinkDO, env);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

// Starting a link is a paid change, so every caller here has credit unless a test says otherwise.
const fund = async user => { await rpc(env.ACCOUNTS, user, 'init', { account: user }); await rpc(env.ACCOUNTS, user, 'deposit', { id: `fund-${user}`, amount: 1000000 }); };
const call = async (user, method, path, body) => {
  if (!funded.has(user)) { funded.add(user); await fund(user); }
  const response = await worker.fetch(new Request(`https://cronly.org${path}`, { method, headers: { Authorization: `LocalDev ${user}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: response.status, body: await response.json() };
};
async function link(user, acct) {
  const start = await call(user, 'POST', '/api/dba/link/start');
  expect(start.status).toBe(200);
  return call(user, 'POST', '/api/dba/link/finish', dba.authorize(start.body.url, { acct }));
}

it('links, reports and unlinks a devicebasedauth.org account through OIDC with PKCE', async () => {
  const start = await call('alice', 'POST', '/api/dba/link/start');
  const query = Object.fromEntries(new URL(start.body.url).searchParams);
  expect(start.body.url.startsWith(`${dba.issuer}/oauth/authorize?`)).toBe(true);
  expect(query).toMatchObject({ response_type: 'code', client_id: 'cronly.org', redirect_uri: 'https://cronly.org/auth/dba/callback', code_challenge_method: 'S256' });
  // The PKCE verifier and nonce stay server-side.
  expect(JSON.stringify(start.body)).not.toContain('verifier');
  // Charged as a change before devicebasedauth.org bills cronly.org for the sign-in.
  expect(start.body).toMatchObject({ cost_microdollars: price('dba_link'), balance_microdollars: 1000000 - price('dba_link') });
  expect((await call('alice', 'GET', '/api/transactions')).body.items[0]).toMatchObject({ kind: 'change', amount_microdollars: -price('dba_link') });

  const finish = await call('alice', 'POST', '/api/dba/link/finish', dba.authorize(start.body.url, { acct: 'dba_alice' }));
  expect(finish).toMatchObject({ status: 200, body: { linked: true, dba_account: 'dba_alice', issuer: dba.issuer, credentials: [], cost_microdollars: 0 } });
  expect(await rpc(env.DBA_LINKS, 'dba_alice', 'get')).toEqual({ account: 'alice' });
  expect((await call('alice', 'GET', '/api/dba/link')).body).toMatchObject({ linked: true, dba_account: 'dba_alice' });
  expect((await call('alice', 'GET', '/api/audit')).body.items).toEqual([expect.objectContaining({ kind: 'link_dba', dba_account: 'dba_alice' })]);

  const unlinked = await call('alice', 'DELETE', '/api/dba/link');
  expect(unlinked).toMatchObject({ status: 200, body: { linked: false, dba_account: null } });
  expect(await rpc(env.DBA_LINKS, 'dba_alice', 'get')).toEqual({ account: null });
});

it('links one devicebasedauth.org account to at most one cronly account', async () => {
  expect((await link('alice', 'dba_shared')).status).toBe(200);
  expect(await link('bob', 'dba_shared')).toMatchObject({ status: 409, body: { code: 'dba_account_linked' } });
  expect((await call('bob', 'GET', '/api/dba/link')).body).toMatchObject({ linked: false });
  await call('alice', 'DELETE', '/api/dba/link');
  expect(await link('bob', 'dba_shared')).toMatchObject({ status: 200, body: { linked: true, dba_account: 'dba_shared' } });
});

it('takes over a claim that its holder no longer confirms, and releases the old account on relink', async () => {
  // An interrupted link: the index names alice, but alice's account never recorded it.
  await rpc(env.DBA_LINKS, 'dba_orphan', 'claim', { account: 'alice' });
  expect(await link('bob', 'dba_orphan')).toMatchObject({ status: 200, body: { linked: true } });
  expect(await rpc(env.DBA_LINKS, 'dba_orphan', 'get')).toEqual({ account: 'bob' });

  expect((await link('bob', 'dba_next')).body).toMatchObject({ linked: true, dba_account: 'dba_next' });
  expect(await rpc(env.DBA_LINKS, 'dba_orphan', 'get')).toEqual({ account: null });
});

it('reports a link superseded in the index as not linked', async () => {
  await link('alice', 'dba_raced');
  await rpc(env.DBA_LINKS, 'dba_raced', 'claim', { account: 'bob', replace: 'alice' });
  expect((await call('alice', 'GET', '/api/dba/link')).body).toMatchObject({ linked: false, superseded: true, dba_account: 'dba_raced' });
});

it('uses each OIDC state once, expires it, and rejects malformed or refused callbacks', async () => {
  const start = await call('alice', 'POST', '/api/dba/link/start');
  const grant = dba.authorize(start.body.url, { acct: 'dba_alice' });
  expect(await call('alice', 'POST', '/api/dba/link/finish', { code: grant.code, state: 'unknown' })).toMatchObject({ status: 400, body: { code: 'invalid_state' } });
  expect(await call('bob', 'POST', '/api/dba/link/finish', grant)).toMatchObject({ status: 400, body: { code: 'invalid_state' } });
  expect((await call('alice', 'POST', '/api/dba/link/finish', grant)).status).toBe(200);
  expect(await call('alice', 'POST', '/api/dba/link/finish', grant)).toMatchObject({ status: 400, body: { code: 'invalid_state' } });
  expect(await call('alice', 'POST', '/api/dba/link/finish', { state: 'x' })).toMatchObject({ status: 400, body: { code: 'invalid_code' } });

  // A code devicebasedauth.org does not recognize (or one for another PKCE verifier).
  const second = await call('alice', 'POST', '/api/dba/link/start');
  const state = new URL(second.body.url).searchParams.get('state');
  expect(await call('alice', 'POST', '/api/dba/link/finish', { code: 'forged', state })).toMatchObject({ status: 400, body: { code: 'dba_link_failed', reason: 'invalid_grant' } });

  vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
  const third = await call('alice', 'POST', '/api/dba/link/start');
  vi.setSystemTime(Date.now() + DBA_STATE_TTL_MS + 1);
  expect(await call('alice', 'POST', '/api/dba/link/finish', dba.authorize(third.body.url, { acct: 'dba_alice' }))).toMatchObject({ status: 400, body: { code: 'invalid_state' } });
});

it('bounds pending link requests, quotes dry runs and reports an unreachable issuer', async () => {
  expect(await call('alice', 'POST', '/api/dba/link/start?dry_run=1')).toMatchObject({ status: 200, body: { quote_microdollars: price('dba_link'), cost_microdollars: 0 } });
  for (let i = 0; i < 10; i++) expect((await call('alice', 'POST', '/api/dba/link/start')).status).toBe(200);
  expect(await call('alice', 'POST', '/api/dba/link/start')).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
  // Discovery is cached per issuer once fetched; an issuer never reached answers 502.
  vi.stubGlobal('fetch', async () => { throw new TypeError('network down'); });
  env.DBA_ISSUER = 'https://dba-unreachable.test';
  expect(await call('bob', 'POST', '/api/dba/link/start')).toMatchObject({ status: 502, body: { code: 'dba_unavailable' } });
});

it('refuses to start a link without credit for its change, and finishing or unlinking costs nothing', async () => {
  funded.add('carol'); await rpc(env.ACCOUNTS, 'carol', 'init', { account: 'carol' });
  expect(await call('carol', 'POST', '/api/dba/link/start')).toMatchObject({ status: 402, body: { code: 'insufficient_balance' } });
  expect((await rpc(env.ACCOUNTS, 'carol', 'list', { prefix: 'dba-oidc:' })).items).toEqual([]);
  const start = await call('alice', 'POST', '/api/dba/link/start');
  const finish = await call('alice', 'POST', '/api/dba/link/finish', dba.authorize(start.body.url, { acct: 'dba_alice' }));
  expect(finish.body).toMatchObject({ cost_microdollars: 0, balance_microdollars: 1000000 - price('dba_link') });
  expect((await call('alice', 'DELETE', '/api/dba/link')).body).toMatchObject({ cost_microdollars: 0, balance_microdollars: 1000000 - price('dba_link') });
});

it('serves the workspace at the registered callback URL', async () => {
  const seen = [];
  env.ASSETS = { fetch: request => { seen.push(new URL(request.url).pathname); return new Response('app'); } };
  expect((await worker.fetch(new Request('https://cronly.org/auth/dba/callback?code=c&state=s'), env)).status).toBe(200);
  expect(seen).toEqual(['/app.html']);
});
