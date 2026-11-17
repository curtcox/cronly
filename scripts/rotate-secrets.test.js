import { it, expect, vi } from 'vitest';
import { rotateAccountSecrets } from './rotate-secrets.mjs';

function setup() {
  const request = vi.fn(async (url, options) => {
    if (url.pathname === '/api/config') return Response.json({ config: { secrets: { token: {}, current: {} } }, cost_microdollars: 20 });
    if (url.searchParams.has('dry_run')) return Response.json({ needs_rotation: url.pathname.includes('/token/'), quote_microdollars: url.pathname.includes('/token/') ? 100 : 0 });
    expect(options.headers['Idempotency-Key']).toBeTruthy();
    return Response.json({ rotated: true, cost_microdollars: 100 });
  });
  return { origin: 'https://cronly.org', token: 'private-api-key', request, log: vi.fn() };
}

it('quotes by default and applies only pending secrets when explicitly requested', async () => {
  const options = setup();
  expect(await rotateAccountSecrets(options)).toMatchObject({ pending: 1, rotated: 0, quote_microdollars: 100, cost_microdollars: 20 });
  expect(options.request).toHaveBeenCalledTimes(3);
  options.request.mockClear();
  expect(await rotateAccountSecrets({ ...options, apply: true })).toMatchObject({ pending: 1, rotated: 1, cost_microdollars: 120 });
  expect(options.request).toHaveBeenCalledTimes(4);
  expect(JSON.stringify(options.log.mock.calls)).not.toContain(options.token);
  for (const [, args] of options.request.mock.calls) expect(args.redirect).toBe('error');
});

it('retries rate refusals with the same idempotency key without leaking error bodies', async () => {
  const options = setup(); const initial = options.request.getMockImplementation();
  let attempts = 0;
  options.request.mockImplementation(async (url, args) => {
    if (url.pathname.includes('/token/') && !url.search && attempts++ === 0) return Response.json({ code: 'rate_limited' }, { status: 429 });
    return initial(url, args);
  });
  const pause = vi.fn(async () => {});
  await rotateAccountSecrets({ ...options, apply: true, pause });
  expect(pause).toHaveBeenCalledWith(60000);
  const writes = options.request.mock.calls.filter(([url]) => url.pathname.includes('/token/') && !url.search);
  expect(writes).toHaveLength(2);
  expect(writes[0][1].headers['Idempotency-Key']).toBe(writes[1][1].headers['Idempotency-Key']);
  options.request.mockResolvedValue(Response.json({ code: 'key_budget_day', error: 'private-response-data' }, { status: 402 }));
  await expect(rotateAccountSecrets(options)).rejects.toThrow('Rotation request refused (402, key_budget_day)');
});

it('rejects credential-bearing and insecure origins before sending a request', async () => {
  const options = setup();
  for (const origin of ['http://cronly.org', 'https://user:pass@cronly.org', 'https://cronly.org/path', 'https://cronly.org?token=bad']) await expect(rotateAccountSecrets({ ...options, origin })).rejects.toThrow();
  expect(options.request).not.toHaveBeenCalled();
});

for (const failure of ['transport', 'json', 500, 502, 503, 504]) {
  it(`recovers a ${failure} interruption using the same mutation identity`, async () => {
    const options = setup(); const initial = options.request.getMockImplementation();
    let attempts = 0;
    options.request.mockImplementation(async (url, args) => {
      if (url.pathname.includes('/token/') && !url.search && attempts++ === 0) {
        if (failure === 'transport') throw new Error(`private error ${options.token}`);
        if (failure === 'json') return new Response('incomplete response');
        return new Response('private outage details', { status: failure });
      }
      return initial(url, args);
    });
    const pause = vi.fn(async () => {});
    expect(await rotateAccountSecrets({ ...options, apply: true, pause })).toMatchObject({ rotated: 1, cost_microdollars: 120 });
    const writes = options.request.mock.calls.filter(([url]) => url.pathname.includes('/token/') && !url.search);
    expect(writes).toHaveLength(2);
    expect(new Set(writes.map(([, args]) => args.headers['Idempotency-Key'])).size).toBe(1);
    expect(pause).toHaveBeenCalledExactlyOnceWith(1000);
    expect(JSON.stringify(options.log.mock.calls)).not.toMatch(/private/);
  });
}

it('bounds transport retries and hides private transport details', async () => {
  const options = setup(); const initial = options.request.getMockImplementation();
  options.request.mockImplementation(async (url, args) => {
    if (url.pathname.includes('/token/') && !url.search) throw new Error(`private ${options.token}`);
    return initial(url, args);
  });
  const pause = vi.fn(async () => {});
  await expect(rotateAccountSecrets({ ...options, apply: true, pause })).rejects.toThrow('Rotation request interrupted; check secret metadata before starting again');
  const writes = options.request.mock.calls.filter(([url]) => url.pathname.includes('/token/') && !url.search);
  expect(writes).toHaveLength(3);
  expect(new Set(writes.map(([, args]) => args.headers['Idempotency-Key'])).size).toBe(1);
  expect(pause.mock.calls).toEqual([[1000], [2000]]);
  expect(JSON.stringify(options.log.mock.calls)).not.toMatch(/private/);
});

it('does not retry a lost billed config read', async () => {
  const options = setup(); const pause = vi.fn(async () => {});
  options.request.mockRejectedValue(new Error(`private ${options.token}`));
  await expect(rotateAccountSecrets({ ...options, apply: true, pause })).rejects.toThrow('Rotation request interrupted; check secret metadata before starting again');
  expect(options.request).toHaveBeenCalledTimes(1); expect(pause).not.toHaveBeenCalled();
});

it('stops on definitive mutation refusals without exposing their body', async () => {
  const options = setup(); const initial = options.request.getMockImplementation();
  options.request.mockImplementation(async (url, args) => {
    if (url.pathname.includes('/token/') && !url.search) return Response.json({ code: 'private-response-data\nsecret', error: options.token }, { status: 409 });
    return initial(url, args);
  });
  const pause = vi.fn(async () => {});
  await expect(rotateAccountSecrets({ ...options, apply: true, pause })).rejects.toThrow('Rotation request refused (409, unknown_error)');
  expect(pause).not.toHaveBeenCalled();
});

it('does not retry a refunded rotation failure', async () => {
  const options = setup(); const initial = options.request.getMockImplementation();
  options.request.mockImplementation(async (url, args) => {
    if (url.pathname.includes('/token/') && !url.search) return Response.json({ code: 'secret_rotation_failed', cost_microdollars: 0 }, { status: 503 });
    return initial(url, args);
  });
  const pause = vi.fn(async () => {});
  await expect(rotateAccountSecrets({ ...options, apply: true, pause })).rejects.toThrow('Rotation request refused (503, secret_rotation_failed)');
  expect(pause).not.toHaveBeenCalled();
});
