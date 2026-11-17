import { afterEach, it, expect, vi } from 'vitest';
import probe, { PROBE_CASES } from './sandbox-probe-worker.js';
import { verifyProbe, requestProbe } from './probe-sandbox-live.mjs';

vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('waits for secret propagation but never repeats requests that reached execution', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const pending = requestProbe('https://probe', 'smoke', 'private');
  await vi.runAllTimersAsync(); expect((await pending).status).toBe(200); expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockReset().mockResolvedValue(new Response(null, { status: 500 }));
  expect((await requestProbe('https://probe', 'cpu-limit', 'private')).status).toBe(500); expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockReset().mockResolvedValue(new Response(null, { status: 401 }));
  const refused = requestProbe('https://probe', 'smoke', 'private');
  await vi.runAllTimersAsync(); expect((await refused).status).toBe(401); expect(fetch).toHaveBeenCalledTimes(8);
});

it('keeps the probe closed without a valid, unexpired credential and a fixed case', async () => {
  const limit = vi.fn(async () => ({ success: true }));
  const env = { PROBE_TOKEN: 'private', PROBE_EXPIRES_AT: String(Date.now() + 60000), PROBE_LIMITER: { limit } };
  const request = (path = 'smoke', token = 'private', method = 'POST') => new Request(`https://probe/${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  for (const changed of [{ PROBE_TOKEN: '' }, { PROBE_EXPIRES_AT: '' }, { PROBE_EXPIRES_AT: 'bad' }, { PROBE_EXPIRES_AT: String(Date.now() - 1) }]) expect((await probe.fetch(request(), { ...env, ...changed }, {})).status).toBe(401);
  expect((await probe.fetch(request('smoke', 'wrong'), env, {})).status).toBe(401);
  expect((await probe.fetch(request('arbitrary-source'), env, {})).status).toBe(404);
  expect((await probe.fetch(request('constructor'), env, {})).status).toBe(404);
  expect((await probe.fetch(request('smoke', 'private', 'GET'), env, {})).status).toBe(404);
  expect(limit).not.toHaveBeenCalled();
  limit.mockResolvedValueOnce({ success: false });
  expect((await probe.fetch(request(), env, {})).status).toBe(429);
  expect(Object.keys(PROBE_CASES)).toHaveLength(8);
});

it('requires explicit CPU/subrequest rejection rather than an arbitrary failed action', () => {
  for (const name of ['cpu-limit', 'subrequest-limit']) {
    expect(() => verifyProbe(name, { case: name, result: { status: 'failure' } })).toThrow();
    expect(() => verifyProbe(name, { case: name, runtime_error: { message: 'Invalid module' } })).toThrow();
  }
  expect(() => verifyProbe('cpu-limit', { case: 'cpu-limit', runtime_error: { message: 'Worker exceeded CPU time limit' } })).not.toThrow();
  expect(() => verifyProbe('subrequest-limit', { case: 'subrequest-limit', runtime_error: { message: 'Too many subrequests' } })).not.toThrow();
  expect(() => verifyProbe('subrequest-limit', { case: 'subrequest-limit', result: { status: 'success', return_value: JSON.stringify({ native_error: 'Too many subrequests by single Worker invocation.' }) } })).not.toThrow();
  expect(() => verifyProbe('cpu-limit', { case: 'cpu-limit', result: { status: 'success', return_value: '666666661666.567' } })).toThrow();
  expect(() => verifyProbe('cpu-control', { case: 'cpu-control', result: { status: 'failure' } })).toThrow();
  expect(() => verifyProbe('native-fetch', { case: 'native-fetch', result: { status: 'success', return_value: 'false' } })).toThrow();
});

it('rejects mixed concurrent logs and unredacted synthetic secrets', () => {
  const result = ['left', 'right'].map(marker => ({ status: 'success', return_value: JSON.stringify(marker), console: `${marker} «secret:token»` }));
  expect(() => verifyProbe('isolation', { case: 'isolation', result })).not.toThrow();
  for (const console of ['left right «secret:token»', 'left probe-private-marker «secret:token»']) expect(() => verifyProbe('isolation', { case: 'isolation', result: [{ ...result[0], console }, result[1]] })).toThrow();
});
