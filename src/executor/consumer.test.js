import { price, PRICES } from '../utils/pricing.js';
import { afterEach, it, expect, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { consume } from './consumer.js';
afterEach(() => vi.useRealTimers());
async function setup(balance = 2000) {
  const messages = [];
  const env = { ENVIRONMENT: 'local', SECRETS_MASTER_KEY: 'test', RUN_QUEUE: { send: async body => messages.push(body) }, OUTBOUND_FETCH: vi.fn(async () => new Response('secret-token', { status: 200 })) };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const api = async (path, method = 'GET', body, headers) => {
    const response = await worker.fetch(new Request(`https://cronly.org${path}`, { method, body: body && JSON.stringify(body), headers: { Authorization: 'LocalDev a', ...headers } }), env);
    return { status: response.status, ...await response.json() };
  };
  await api('/api/dev/deposit', 'POST', { amount_microdollars: balance });
  await api('/api/secrets/token', 'PUT', { value: 'secret-token' });
  await api('/api/actions/ping', 'PUT', { url: 'https://example.com', headers: { Authorization: 'Bearer {{secret.token}}' } });
  await api('/api/jobs/pinger', 'PUT', { action: 'ping', cron: '* * * * *' });
  return { env, api, messages };
}
it('queues only after holding funds, redacts output, and deduplicates delivery', async () => {
  const { api, messages, env } = await setup();
  const first = await api('/api/jobs/pinger/run', 'POST', {}, { 'Idempotency-Key': 'r1' });
  expect(first.status).toBe(200); expect(messages).toHaveLength(1);
  expect((await api('/api/account')).held_microdollars).toBe(PRICES.run);
  const ack = vi.fn(); const message = { body: messages[0], ack };
  await consume(message, env, {}); await consume(message, env, {});
  expect(env.OUTBOUND_FETCH).toHaveBeenCalledTimes(1);
  const runs = await rpc(env.JOBS, 'a:pinger', 'runs');
  expect(runs.items[0]).toMatchObject({ status: 'success', cost_microdollars: PRICES.run });
  expect(JSON.stringify(runs)).not.toContain('secret-token');
  expect((await api('/api/account')).held_microdollars).toBe(0);
  await api('/api/jobs/pinger/run', 'POST', {}, { 'Idempotency-Key': 'r1' }); expect(messages).toHaveLength(1);
});
it('pauses an unfunded schedule with no recurring alarm and never sends it', async () => {
  const { api, messages, env } = await setup(300);
  expect((await api('/api/jobs/pinger/run', 'POST', {})).status).toBe(402);
  expect(messages).toHaveLength(0);
  const settings = await rpc(env.JOBS, 'a:pinger', 'status'); expect(settings.paused).toBe('insufficient_balance');
  expect(env.JOBS.get('a:pinger').storage.alarm).toBeGreaterThan(Date.now() + 86400000);
});
it('freezes definitions at reservation and blocks concurrent overlap', async () => {
  const { api, messages, env } = await setup();
  await api('/api/jobs/pinger/run', 'POST', {});
  expect((await api('/api/jobs/pinger/run', 'POST', {})).status).toBe(409);
  await api('/api/actions/ping', 'PUT', { url: 'https://other.example.com' });
  await consume({ body: messages[0], ack() {} }, env, {});
  expect(env.OUTBOUND_FETCH.mock.calls[0][0].url).toBe('https://example.com/');
});
it('executes an old-key snapshot after the active key and stored secret change', async () => {
  const { api, messages, env } = await setup();
  await api('/api/jobs/pinger/run', 'POST', {});
  env.SECRETS_KEYRING = JSON.stringify({ active: 'v2', keys: { v1: 'test', v2: 'new-master' } });
  expect((await api('/api/secrets/token/rotate', 'POST')).status).toBe(200);
  await api('/api/secrets/token', 'PUT', { value: 'replacement-token' });
  await consume({ body: messages[0], ack() {} }, env, {});
  expect(env.OUTBOUND_FETCH.mock.calls[0][0].headers.get('Authorization')).toBe('Bearer secret-token');
  const runs = await rpc(env.JOBS, 'a:pinger', 'runs');
  expect(runs.items[0].status).toBe('success');
  expect(JSON.stringify(runs)).not.toContain('secret-token');
});

it('recovers committed completion publication on Queue redelivery after restart', async () => {
  const { api, messages, env } = await setup();
  await api('/api/jobs/pinger/run', 'POST', {});
  const job = env.JOBS.get('a:pinger');
  const publication = vi.spyOn(job, 'publish').mockRejectedValueOnce(new Error('account unavailable'));
  const ack = vi.fn(); const message = { body: messages[0], ack };
  await expect(consume(message, env, {})).rejects.toMatchObject({ status: 500 });
  expect(ack).not.toHaveBeenCalled();
  expect((await job.readRun(message.body.id)).status).toBe('success');
  const before = await api('/api/account');
  expect(before.held_microdollars).toBe(0);
  expect(before.job_runtime.pinger.last_outcome).toBe(null);
  publication.mockRestore();
  const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
  env.JOBS.objects.set('a:pinger', cold);
  const list = vi.spyOn(cold.storage, 'list');
  // A second reporting outage must still leave the delivery unacknowledged.
  vi.spyOn(cold, 'publish').mockRejectedValueOnce(new Error('still unavailable'));
  await expect(consume(message, env, {})).rejects.toMatchObject({ status: 500 });
  expect(ack).not.toHaveBeenCalled();
  await consume(message, env, {});
  expect(ack).toHaveBeenCalledTimes(1);
  expect(env.OUTBOUND_FETCH).toHaveBeenCalledTimes(1);
  const after = await api('/api/account');
  expect(after.balance_microdollars).toBe(before.balance_microdollars);
  expect(after.job_runtime.pinger.last_outcome).toBe('success');
  expect(list.mock.calls.some(([options]) => options?.prefix === 'history:')).toBe(false);
});

it('still dispatches a configured action retry when completion publication fails', async () => {
  const { api, messages, env } = await setup();
  await api('/api/jobs/pinger', 'PUT', { action: 'ping', cron: '* * * * *', retries: 1 });
  env.OUTBOUND_FETCH.mockImplementation(async () => new Response('failed', { status: 500 }));
  await api('/api/jobs/pinger/run', 'POST', {});
  const job = env.JOBS.get('a:pinger');
  vi.spyOn(job, 'publish').mockRejectedValueOnce(new Error('account unavailable'));
  const ack = vi.fn(); const message = { body: messages[0], ack };
  await expect(consume(message, env, {})).rejects.toMatchObject({ status: 500 });
  expect(messages).toHaveLength(2);
  expect(messages[1].id).toBe(`${messages[0].id}:retry`);
  await consume(message, env, {});
  await consume({ body: messages[1], ack }, env, {});
  expect(env.OUTBOUND_FETCH).toHaveBeenCalledTimes(2);
  const runs = (await rpc(env.JOBS, 'a:pinger', 'runs')).items;
  expect(runs).toHaveLength(2);
  expect(runs.every(run => run.status === 'failure' && run.cost_microdollars === PRICES.run)).toBe(true);
  expect((await api('/api/account')).held_microdollars).toBe(0);
});

it('acknowledges an unknown expired delivery without fabricating a run', async () => {
  const { env } = await setup(); const ack = vi.fn();
  await consume({ body: { account: 'a', name: 'pinger', id: 'unknown' }, ack }, env, {});
  expect(ack).toHaveBeenCalledOnce();
  expect(env.OUTBOUND_FETCH).not.toHaveBeenCalled();
  expect((await rpc(env.JOBS, 'a:pinger', 'runs')).items).toEqual([]);
});

it('refunds a braked JS run without discounting the next actual sandbox activation', async () => {
  const { api, messages, env } = await setup(10000);
  const action = { type: 'javascript', source: 'export default () => 1', cpu_ms: 100, subrequests: 0 };
  await api('/api/actions/ping', 'PUT', action);
  await api('/api/jobs/pinger', 'PUT', { action: 'ping', cron: null });
  await api('/api/jobs/next', 'PUT', { action: 'ping', cron: null });
  await api('/api/jobs/pinger/run', 'POST', {});
  let brake = true;
  env.SAFETY = { idFromName: id => id, get: () => ({ fetch: async () => Response.json({ brake }) }) };
  const invoke = vi.fn(async () => Response.json({ status: 'success', value_text: '1' }));
  env.LOADER = { get: () => ({ getEntrypoint: () => ({ fetch: invoke }) }) };
  env.TOKEN_SIGNING_KEY = 'test';
  const ctx = { exports: { OutboundGateway: () => ({}) } };
  await consume({ body: messages[0], ack() {} }, env, ctx);
  expect(invoke).not.toHaveBeenCalled();
  expect(await rpc(env.JOBS, 'a:pinger', 'run', { id: messages[0].id })).toMatchObject({ cost_microdollars: 0 });
  brake = false;
  await api('/api/jobs/next/run', 'POST', {});
  await consume({ body: messages[1], ack() {} }, env, ctx);
  await consume({ body: messages[1], ack() {} }, env, ctx);
  expect(invoke).toHaveBeenCalledOnce();
  expect(await rpc(env.JOBS, 'a:next', 'run', { id: messages[1].id })).toMatchObject({ status: 'success', cost_microdollars: price('run', action) });
  expect((await api('/api/account')).held_microdollars).toBe(0);
});

for (const failureAt of ['settle', 'completion']) {
  it(`recovers a staged outcome after ${failureAt} fails without repeating the outbound request`, async () => {
    const { api, messages, env } = await setup();
    await api('/api/jobs/pinger/run', 'POST', {});
    const job = env.JOBS.get('a:pinger'); const account = env.ACCOUNTS.get('a');
    const dispatch = account.dispatch.bind(account); const put = job.storage.put.bind(job.storage);
    const fault = failureAt === 'settle' ? vi.spyOn(account, 'dispatch').mockImplementation(async (tx, args) => {
      if (args.op === 'settle') throw new Error('settlement unavailable');
      return dispatch(tx, args);
    }) : vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
      if (key.startsWith('history:') && value.status === 'success') throw new Error('completion unavailable');
      return put(key, value);
    });
    const ack = vi.fn(); const message = { body: messages[0], ack };
    const before = (await api('/api/account')).balance_microdollars;
    await expect(consume(message, env, {})).rejects.toMatchObject({ status: 500 });
    expect(ack).not.toHaveBeenCalled();
    const pending = await rpc(env.JOBS, 'a:pinger', 'run', { id: message.body.id });
    expect(pending.status).toBe('queued'); expect(pending).not.toHaveProperty('completion');
    fault.mockRestore();
    const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
    env.JOBS.objects.set('a:pinger', cold);
    await consume(message, env, {}); await consume(message, env, {});
    expect(ack).toHaveBeenCalledTimes(2); expect(env.OUTBOUND_FETCH).toHaveBeenCalledOnce();
    expect(await rpc(env.JOBS, 'a:pinger', 'run', { id: message.body.id })).toMatchObject({ status: 'success', cost_microdollars: PRICES.run });
    expect(await api('/api/account')).toMatchObject({ balance_microdollars: before - PRICES.run, held_microdollars: 0 });
  });
}

for (const failureAt of ['dispatch', 'cleanup']) {
  it(`recovers retry ${failureAt} after restart with the original input and one charge per attempt`, async () => {
    const { api, messages, env } = await setup(10000);
    await api('/api/actions/ping', 'PUT', { url: 'https://example.com', headers: { 'X-Event': '{{input.event}}' } });
    await api('/api/jobs/pinger', 'PUT', { action: 'ping', cron: null, retries: 1 });
    env.OUTBOUND_FETCH.mockImplementation(async () => new Response('failed', { status: 500 }));
    await api('/api/jobs/pinger/run', 'POST', { input: { event: 'original-event' } });
    const job = env.JOBS.get('a:pinger'); const start = job.start.bind(job); const put = job.storage.put.bind(job.storage);
    const fault = failureAt === 'dispatch' ? vi.spyOn(job, 'start').mockImplementation(async args => {
      if (args.retry) throw new Error('retry dispatch unavailable');
      return start(args);
    }) : vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
      if (key === `history:${messages[0].id}` && value.status === 'failure' && !value.retry) throw new Error('retry cleanup unavailable');
      return put(key, value);
    });
    const ack = vi.fn(); const message = { body: messages[0], ack };
    const before = (await api('/api/account')).balance_microdollars;
    await expect(consume(message, env, {})).rejects.toMatchObject({ status: 500 });
    expect(ack).not.toHaveBeenCalled();
    const pendingRetry = await job.storage.get(`history:${message.body.id}`);
    expect(pendingRetry.retry).toMatchObject({ dispatch: true, input: { event: 'original-event' } });
    for (const options of [{}, { summary: true }]) {
      const runs = await rpc(env.JOBS, 'a:pinger', 'runs', options);
      expect(runs.items.every(run => !Object.hasOwn(run, 'retry') && !Object.hasOwn(run, 'completion'))).toBe(true);
    }
    fault.mockRestore();
    const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
    env.JOBS.objects.set('a:pinger', cold);
    await consume(message, env, {}); await consume(message, env, {});
    expect(messages).toHaveLength(2);
    await consume({ body: messages[1], ack() {} }, env, {});
    await consume(message, env, {});
    expect(env.OUTBOUND_FETCH).toHaveBeenCalledTimes(2);
    expect(env.OUTBOUND_FETCH.mock.calls[1][0].headers.get('X-Event')).toBe('original-event');
    expect((await job.storage.get(`history:${message.body.id}`)).retry).toBeUndefined();
    expect(await api('/api/account')).toMatchObject({ balance_microdollars: before - 2 * PRICES.run, held_microdollars: 0 });
  });
}

it('uses the pending alarm to recover a staged failure and its retry without Queue redelivery', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const { api, messages, env } = await setup(10000);
  await api('/api/jobs/pinger', 'PUT', { action: 'ping', cron: null, retries: 1 });
  env.OUTBOUND_FETCH.mockImplementation(async () => new Response('failed', { status: 500 }));
  await api('/api/jobs/pinger/run', 'POST', {});
  const job = env.JOBS.get('a:pinger'); const put = job.storage.put.bind(job.storage);
  const fault = vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
    if (key.startsWith('history:') && value.status === 'failure') throw new Error('completion unavailable');
    return put(key, value);
  });
  await expect(consume({ body: messages[0], ack() {} }, env, {})).rejects.toMatchObject({ status: 500 });
  fault.mockRestore();
  const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
  env.JOBS.objects.set('a:pinger', cold);
  await vi.advanceTimersByTimeAsync(121000); await cold.alarm();
  expect(messages).toHaveLength(2);
  expect(await rpc(env.JOBS, 'a:pinger', 'run', { id: messages[0].id })).toMatchObject({ status: 'failure' });
  await consume({ body: messages[1], ack() {} }, env, {});
  expect(env.OUTBOUND_FETCH).toHaveBeenCalledTimes(2);
  expect((await api('/api/account')).held_microdollars).toBe(0);
});
