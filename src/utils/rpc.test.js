import { expect, it, vi } from 'vitest';
import { rpc } from './rpc.js';
import { ApiError, errorResponse } from './errors.js';

it('preserves safe error details through multiple internal object boundaries', async () => {
  const origin = new ApiError(402, 'insufficient_balance', 'Insufficient balance', { needed_microdollars: 35, cost_microdollars: 0 });
  const namespace = { idFromName: id => id, get: () => ({ fetch: vi.fn(async () => errorResponse(origin)) }) };
  let forwarded;
  try { await rpc(namespace, 'account', 'reserve'); } catch (error) { forwarded = error; }
  expect(forwarded).toMatchObject({ status: 402, code: origin.code, message: origin.message, details: origin.details });
  namespace.get = () => ({ fetch: async () => errorResponse(forwarded) });
  await expect(rpc(namespace, 'job', 'start')).rejects.toMatchObject({ status: 402, details: origin.details });
});

it('keeps errors without additional details usable and successful responses intact', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Not found', code: 'not_found' }, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ balance_microdollars: 80 }));
  const namespace = { idFromName: id => id, get: () => ({ fetch }) };
  await expect(rpc(namespace, 'a', 'missing')).rejects.toMatchObject({ status: 404, code: 'not_found', details: {} });
  expect(await rpc(namespace, 'a', 'account')).toEqual({ balance_microdollars: 80 });
});
