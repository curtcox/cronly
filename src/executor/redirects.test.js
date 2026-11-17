import { expect, it, vi } from 'vitest';
import { guardedFetch } from './http.js';

function environment(outbound) {
  const rates = vi.fn(async () => Response.json({}));
  return { ACCOUNTS: { idFromName: id => id, get: () => ({ fetch: rates }) }, OUTBOUND_FETCH: vi.fn(outbound), rates };
}

for (const [status, method, expected] of [
  [301, 'POST', 'GET'], [302, 'POST', 'GET'], [303, 'POST', 'GET'], [303, 'PUT', 'GET'],
  [303, 'HEAD', 'HEAD'], [303, 'GET', 'GET'], [301, 'PUT', 'PUT'], [302, 'PUT', 'PUT'],
  [307, 'POST', 'POST'], [308, 'POST', 'POST']
]) {
  it(`follows ${status} redirects from ${method} as ${expected} with consistent body headers`, async () => {
    const headers = { Authorization: 'customer-token', 'X-Custom': 'value', 'Content-Type': 'application/json', 'Content-Encoding': 'identity', 'Content-Language': 'en', 'Content-Location': '/payload' };
    const body = ['GET', 'HEAD'].includes(method) ? undefined : '{"hello":"world"}';
    const env = environment(async request => request.url.endsWith('/first') ? new Response('redirect body', { status, headers: { location: '/next' } }) : new Response(null));
    const result = await guardedFetch(new Request('https://example.com/first', { method, headers, body }), env, 'a', undefined, 5);
    expect(result.subrequests).toBe(2);
    expect(env.rates).toHaveBeenCalledTimes(2);
    const request = env.OUTBOUND_FETCH.mock.calls[1][0];
    expect(request.method).toBe(expected);
    expect(await request.text()).toBe(expected === 'GET' || expected === 'HEAD' ? '' : body);
    expect(request.headers.get('Authorization')).toBe('customer-token');
    expect(request.headers.get('X-Custom')).toBe('value');
    for (const header of ['Content-Type', 'Content-Encoding', 'Content-Language', 'Content-Location']) {
      expect(request.headers.get(header)).toBe(method === expected ? headers[header] : null);
    }
  });
}

for (const location of ['http://127.1/', 'https://cronly.org/', 'https://user:pass@example.com/', 'http://[', 'file:///tmp/private']) {
  it(`cancels the response body when refusing redirect to ${location}`, async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status: 302, headers: { location } });
    const env = environment(async () => response);
    await expect(guardedFetch(new Request('https://example.com/'), env, 'a', undefined, 5)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(env.OUTBOUND_FETCH).toHaveBeenCalledTimes(1);
    expect(env.rates).toHaveBeenCalledTimes(1);
  });
}

it('strips credentials and custom headers across origins and never restores them on return', async () => {
  const env = environment(async request => {
    if (request.url === 'https://example.com/first') return new Response(null, { status: 302, headers: { location: 'https://other.example.com/next' } });
    if (request.url === 'https://other.example.com/next') return new Response(null, { status: 302, headers: { location: 'https://example.com/last' } });
    return new Response(null);
  });
  await guardedFetch(new Request('https://example.com/first', { headers: { Authorization: 'private', Cookie: 'private', 'X-Api-Key': 'private' } }), env, 'a', undefined, 5);
  expect(env.OUTBOUND_FETCH).toHaveBeenCalledTimes(3);
  for (const [request] of env.OUTBOUND_FETCH.mock.calls.slice(1)) expect([...request.headers]).toEqual([]);
});

it('checks the subrequest allowance before consuming a destination-rate attempt', async () => {
  const cancel = vi.fn();
  const env = environment(async () => new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: '/next' } }));
  await expect(guardedFetch(new Request('https://example.com/'), env, 'a', undefined, 5, 1)).rejects.toMatchObject({ code: 'subrequest_limit' });
  expect(env.OUTBOUND_FETCH).toHaveBeenCalledTimes(1);
  expect(env.rates).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});
