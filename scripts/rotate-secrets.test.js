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
