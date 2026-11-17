import { expect, it, vi } from 'vitest';
import { verifyProduction } from './verify-production.mjs';

const sha = 'a'.repeat(40);
const release = { EXPECTED_GIT_SHA: sha };
function service() {
  return vi.fn(async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/health') return Response.json({ environment: 'production', git_sha: sha });
    if (path === '/api/public/config') return Response.json({ local: false, clerk_publishable_key: 'pk_live_fixture' });
    if (path === '/openapi.json') return Response.json({ openapi: '3.1.0' });
    if (path === '/api/account') return options.headers.Authorization?.startsWith('ApiKey ') ? Response.json({ balance_microdollars: 1000 }) : Response.json({ error: 'Unauthorized' }, { status: 401 });
    return new Response('public page');
  });
}

it('verifies the release, public surfaces and access denials without a billed read by default', async () => {
  const fetchImpl = service(); const wait = vi.fn();
  await verifyProduction(release, { fetchImpl, wait });
  expect(wait).not.toHaveBeenCalled();
  expect(fetchImpl.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    '/health', '/api/public/config', '/openapi.json', '/', '/app.html', '/pricing.html', '/docs/index.html', '/docs/agents.html', '/llms.txt', '/sdk/v1/cronly.js', '/terms.html', '/privacy.html', '/api/account', '/api/account'
  ]);
  expect(fetchImpl.mock.calls.filter(([, options]) => options.headers.Authorization)).toHaveLength(1);
  for (const [url, options] of fetchImpl.mock.calls) {
    expect(new URL(url).origin).toBe('https://cronly.org');
    expect(options).toMatchObject({ redirect: 'manual', cache: 'no-store' });
  }
});

it('waits for code and secret propagation before a single optional billed read', async () => {
  const healthy = service(); let healthCalls = 0; let configCalls = 0;
  const fetchImpl = vi.fn(async (url, options) => {
    if (url.endsWith('/health') && ++healthCalls === 1) return Response.json({ environment: 'production', git_sha: 'b'.repeat(40) });
    if (url.endsWith('/api/public/config') && ++configCalls === 1) return Response.json({ local: false, clerk_publishable_key: '' });
    return healthy(url, options);
  });
  const wait = vi.fn();
  await verifyProduction({ ...release, CRONLY_API_KEY: 'private-key' }, { fetchImpl, wait });
  expect(wait.mock.calls).toEqual([[2000], [2000]]);
  expect(fetchImpl.mock.calls.filter(([, options]) => options.headers.Authorization === 'ApiKey private-key')).toHaveLength(1);
});

it('bounds persistent public failures and never attempts the billed read', async () => {
  const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503 }));
  const wait = vi.fn();
  await expect(verifyProduction({ ...release, CRONLY_API_KEY: 'private-key' }, { fetchImpl, wait, attempts: 3 })).rejects.toThrow('/health: HTTP 503, expected 200');
  expect(fetchImpl).toHaveBeenCalledTimes(3); expect(wait).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls.every(([, options]) => !options.headers.Authorization)).toBe(true);
});

it('waits for public assets before the billed read and cancels unused response bodies', async () => {
  const healthy = service(); const wait = vi.fn(); let termsCalls = 0;
  const responses = [];
  const fetchImpl = vi.fn(async (url, options) => {
    const response = url.endsWith('/terms.html') && ++termsCalls === 1 ? new Response('not yet', { status: 404 }) : await healthy(url, options);
    if (!['/health', '/api/public/config', '/openapi.json'].includes(new URL(url).pathname) && !options.headers.Authorization?.startsWith('ApiKey ')) responses.push(response);
    return response;
  });
  await verifyProduction({ ...release, CRONLY_API_KEY: 'private-key', CRONLY_ORIGIN: 'https://acceptance.example/' }, { fetchImpl, wait });
  expect(wait).toHaveBeenCalledOnce();
  expect(termsCalls).toBe(2);
  expect(fetchImpl.mock.calls.at(-1)[1].headers.Authorization).toBe('ApiKey private-key');
  expect(fetchImpl.mock.calls.every(([url]) => new URL(url).origin === 'https://acceptance.example')).toBe(true);
  expect(responses.every(response => response.bodyUsed)).toBe(true);
});

for (const path of ['/health', '/api/public/config', '/openapi.json']) {
  it(`bounds malformed public JSON from ${path}`, async () => {
    const healthy = service(); const wait = vi.fn();
    const fetchImpl = vi.fn(async (url, options) => url.endsWith(path) ? new Response('private transport detail') : healthy(url, options));
    await expect(verifyProduction(release, { fetchImpl, wait, attempts: 2 })).rejects.toThrow(`${path}: invalid JSON`);
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith(path))).toHaveLength(2);
    expect(wait).toHaveBeenCalledOnce();
  });
}

for (const authorization of [undefined, 'LocalDev production-check']) {
  it(`refuses a service that accepts ${authorization ? 'LocalDev' : 'unauthenticated'} account reads`, async () => {
    const healthy = service();
    const fetchImpl = vi.fn(async (url, options) => url.endsWith('/api/account') && options.headers.Authorization === authorization ? Response.json({ balance_microdollars: 0 }) : healthy(url, options));
    await expect(verifyProduction({ ...release, CRONLY_API_KEY: 'private-key' }, { fetchImpl, attempts: 1 })).rejects.toThrow('/api/account: HTTP 200, expected 401');
    expect(fetchImpl.mock.calls.every(([, options]) => options.headers.Authorization !== 'ApiKey private-key')).toBe(true);
  });
}

it('retries a public transport failure without exposing private transport details', async () => {
  const healthy = service(); const wait = vi.fn();
  const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('private transport detail')).mockImplementation(healthy);
  await verifyProduction(release, { fetchImpl, wait });
  expect(wait).toHaveBeenCalledOnce();
  const failed = vi.fn(async () => { throw new Error('private transport detail'); });
  await expect(verifyProduction(release, { fetchImpl: failed, wait, attempts: 1 })).rejects.toThrow('/health: request failed');
});

for (const failure of ['transport', 'redirect', 'invalid-json', 'invalid-balance', 'server-error']) {
  it(`does not retry an optional billed read after ${failure}`, async () => {
    const healthy = service(); const wait = vi.fn();
    const fetchImpl = vi.fn(async (url, options) => {
      if (options.headers.Authorization === 'ApiKey private-key') {
        if (failure === 'transport') throw new Error('private-key');
        if (failure === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://other.example' } });
        if (failure === 'invalid-json') return new Response('private-key');
        if (failure === 'invalid-balance') return Response.json({ balance_microdollars: 'private-key' });
        return new Response('private-key', { status: 503 });
      }
      return healthy(url, options);
    });
    const error = await verifyProduction({ ...release, CRONLY_API_KEY: 'private-key' }, { fetchImpl, wait }).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error.message).not.toContain('private-key');
    expect(fetchImpl.mock.calls.filter(([, options]) => options.headers.Authorization === 'ApiKey private-key')).toHaveLength(1);
    expect(wait).not.toHaveBeenCalled();
  });
}

it('rejects invalid origins and release identities before making any requests', async () => {
  const fetchImpl = service();
  for (const CRONLY_ORIGIN of ['http://cronly.org', 'https://private-key@cronly.org', 'https://cronly.org/app.html', 'https://cronly.org?private-key', 'https://cronly.org#private-key', 'private-key']) {
    await expect(verifyProduction({ CRONLY_ORIGIN }, { fetchImpl })).rejects.toThrow('CRONLY_ORIGIN must be an HTTPS origin.');
  }
  await expect(verifyProduction({ EXPECTED_GIT_SHA: 'private-key' }, { fetchImpl })).rejects.toThrow('EXPECTED_GIT_SHA must be a full release SHA.');
  expect(fetchImpl).not.toHaveBeenCalled();
});
