import { afterEach, expect, it, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { consume } from '../executor/consumer.js';
import { price } from '../utils/pricing.js';

afterEach(() => vi.useRealTimers());

async function setup(rate = 1) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const messages = []; const env = { ENVIRONMENT: 'local', TOKEN_SIGNING_KEY: 'test', APP_ORIGIN: 'https://cronly.org', RUN_QUEUE: { send: vi.fn(async body => messages.push(body)) }, OUTBOUND_FETCH: vi.fn(async () => new Response('ok')) };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 10000 });
  await account('mutate', { account: 'a', id: 'defs', operations: [{ kind: 'actions', name: 'ping', value: { url: 'https://example.com/{{input.message}}' } }, { kind: 'jobs', name: 'j', value: { action: 'ping', cron: null } }] });
  await account('sync-jobs');
  const response = await worker.fetch(new Request('https://cronly.org/api/jobs/j/triggers', { method: 'POST', headers: { Authorization: 'LocalDev a' }, body: JSON.stringify({ rate_per_minute: rate }) }), env);
  const trigger = await response.json();
  const api = async (id = 'original', input = { message: 'original' }, dry = false) => {
    const response = await worker.fetch(new Request(`${trigger.url}${dry ? '?dry_run=1' : ''}`, { method: 'POST', headers: { 'Idempotency-Key': id }, body: JSON.stringify(input) }), env);
    return { status: response.status, ...await response.json() };
  };
  const cold = () => {
    for (const [ns, id, Class] of [[env.ACCOUNTS, 'a', AccountDO], [env.JOBS, 'a:j', JobDO]]) {
      const storage = ns.get(id).storage; ns.objects.set(id, new Class({ storage, blockConcurrencyWhile: fn => fn() }, env));
    }
  };
  return { env, account, messages, trigger, api, cold };
}

it('replays queued and completed hooks at the token limit without another rate write or charge', async () => {
  const { env, account, messages, trigger, api, cold } = await setup();
  expect((await api()).status).toBe(200); cold();
  const put = vi.spyOn(env.JOBS.get('a:j').storage, 'put');
  expect(await api()).toMatchObject({ status: 200, duplicate: true });
  expect(put.mock.calls.filter(([key]) => key === `trigger-rate:${trigger.id}`)).toHaveLength(0);
  await consume({ body: messages[0], ack() {} }, env, {}); cold();
  expect(await api()).toMatchObject({ status: 200, duplicate: true });
  expect(await api('different')).toMatchObject({ status: 429, code: 'rate_limited' });
  expect(messages).toHaveLength(1); expect(env.OUTBOUND_FETCH).toHaveBeenCalledTimes(1);
  expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.kind === 'run')).toHaveLength(1);
  expect((await account('account')).held_microdollars).toBe(0);
});

for (const failure of ['reservation-reply', 'pending-write', 'enqueue', 'rate-reply']) {
  it(`recovers a hook at the token limit after a lost ${failure} and restart`, async () => {
    const { env, account, messages, api, cold } = await setup(); let fault;
    if (failure === 'reservation-reply') {
      const object = env.ACCOUNTS.get('a'); const fetch = object.fetch.bind(object);
      fault = vi.spyOn(object, 'fetch').mockImplementation(async request => {
        const { op } = await request.clone().json(); const response = await fetch(request);
        if (op === 'prepare-run' && response.ok) throw new Error('reply lost');
        return response;
      });
    } else if (failure === 'enqueue') fault = vi.spyOn(env.RUN_QUEUE, 'send').mockRejectedValue(new Error('queue unavailable'));
    else {
      const storage = env.JOBS.get('a:j').storage; const put = storage.put.bind(storage);
      fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
        if (failure === 'pending-write' && key.startsWith('history:')) throw new Error('pending unavailable');
        await put(key, value);
        if (failure === 'rate-reply' && key.startsWith('trigger-rate:')) throw new Error('rate acknowledgement lost');
      });
    }
    expect((await api()).status).toBe(500); fault.mockRestore(); cold();
    expect((await api()).status).toBe(200);
    if (!messages.length) await env.JOBS.get('a:j').alarm();
    expect(messages).toHaveLength(1);
    await consume({ body: messages[0], ack() {} }, env, {});
    expect(env.OUTBOUND_FETCH.mock.calls[0][0].url).toBe('https://example.com/original');
    expect(await api()).toMatchObject({ status: 200, duplicate: true });
    const runs = (await account('list', { prefix: 'ledger:' })).items.filter(row => row.kind === 'run');
    expect(runs).toHaveLength(1); expect(runs[0].amount_microdollars).toBe(-price('hook'));
    expect((await account('account')).held_microdollars).toBe(0);
  });
}

it('retains the attempt limit for refused operations while allowing the same operation to retry', async () => {
  const { api, account } = await setup(2);
  expect(await api('first', {})).toMatchObject({ status: 400, code: 'missing_input' });
  expect(await api('second', {})).toMatchObject({ status: 400, code: 'missing_input' });
  expect(await api('third', {})).toMatchObject({ status: 429, code: 'rate_limited' });
  expect(await api('first', {})).toMatchObject({ status: 400, code: 'missing_input' });
  expect((await account('account')).held_microdollars).toBe(0);
});

it('preserves legacy counters and resets remembered operations at the next window', async () => {
  const { env, trigger, api, cold } = await setup();
  const storage = env.JOBS.get('a:j').storage;
  await storage.put(`trigger-rate:${trigger.id}`, { count: 1, reset: Date.now() + 60000 }); cold();
  expect(await api()).toMatchObject({ status: 429, code: 'rate_limited' });
  vi.advanceTimersByTime(60000);
  expect((await api()).status).toBe(200);
  expect((await storage.get(`trigger-rate:${trigger.id}`)).count).toBe(1);
  expect(await api('different')).toMatchObject({ status: 429, code: 'rate_limited' });
});

it('keeps dry runs free of rate writes and checks revocation before a known replay', async () => {
  const { env, trigger, api, messages } = await setup();
  expect(await api('preview', undefined, true)).toMatchObject({ status: 200, cost_microdollars: 0, quote_microdollars: price('hook') });
  const storage = env.JOBS.get('a:j').storage;
  expect(await storage.get(`trigger-rate:${trigger.id}`)).toBeUndefined();
  expect((await api()).status).toBe(200);
  await storage.put(`trigger:${trigger.id}`, { id: trigger.id, rate: 1, revoked: true });
  expect(await api()).toMatchObject({ status: 401, code: 'invalid_trigger' });
  expect(messages).toHaveLength(1);
});

it('bounds remembered attempts at sixty and discards them when the window resets', async () => {
  const { env, trigger, api } = await setup(60);
  for (let index = 0; index < 60; index++) expect(await api(`attempt-${index}`, {})).toMatchObject({ status: 400, code: 'missing_input' });
  expect(await api('over-limit', {})).toMatchObject({ status: 429, code: 'rate_limited' });
  expect(await api('attempt-0', {})).toMatchObject({ status: 400, code: 'missing_input' });
  const storage = env.JOBS.get('a:j').storage;
  const bucket = await storage.get(`trigger-rate:${trigger.id}`);
  expect(bucket.count).toBe(60);
  expect(new TextEncoder().encode(JSON.stringify(bucket)).byteLength).toBeLessThan(5000);
  vi.advanceTimersByTime(60000);
  expect(await api('next-window', {})).toMatchObject({ status: 400, code: 'missing_input' });
  expect((await storage.get(`trigger-rate:${trigger.id}`)).count).toBe(1);
  expect(new TextEncoder().encode(JSON.stringify(await storage.get(`trigger-rate:${trigger.id}`))).byteLength).toBeLessThan(200);
});
