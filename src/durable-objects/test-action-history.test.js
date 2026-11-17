import { afterEach, expect, it, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from './account-do.js';
import { JobDO } from './job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { consume } from '../executor/consumer.js';
import { PRICES } from '../utils/pricing.js';

afterEach(() => vi.useRealTimers());

async function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const messages = [];
  const env = { ENVIRONMENT: 'local', RUN_QUEUE: { send: async body => messages.push(body) }, OUTBOUND_FETCH: vi.fn(async () => new Response('ok')) };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  const api = async (path, method = 'GET', id) => {
    const response = await worker.fetch(new Request(`https://cronly.org${path}`, { method, headers: { Authorization: 'LocalDev a', ...(id ? { 'Idempotency-Key': id } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) }), env);
    return { status: response.status, ...await response.json() };
  };
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 10000 });
  await account('mutate', { account: 'a', id: 'action', operations: [{ kind: 'actions', name: 'ping', value: { url: 'https://example.com' } }] });
  return { env, account, api, messages, storage: env.ACCOUNTS.get('a').storage };
}

it('creates the action-test history index once and keeps cold subsequent runs discoverable', async () => {
  const { env, account, api, messages, storage } = await setup();
  const put = vi.spyOn(storage, 'put');
  const calls = vi.spyOn(env.JOBS.get('a:_test:ping'), 'fetch');
  const first = await api('/api/actions/ping/test', 'POST', 'first');
  expect(first.status).toBe(200);
  expect(calls).toHaveBeenCalledTimes(1);
  const index = await storage.get('job-index:_test:ping');
  expect(index).toMatchObject({ name: '_test:ping', account: 'a', updated_at: Date.now() });
  expect(put.mock.calls.filter(([key]) => key === 'job-index:_test:ping')).toHaveLength(1);
  await consume({ body: messages[0], ack() {} }, env, {});
  vi.advanceTimersByTime(60000);
  env.ACCOUNTS.objects.set('a', new AccountDO({ storage }, env));
  put.mockClear(); calls.mockClear();
  const second = await api('/api/actions/ping/test', 'POST', 'second');
  expect(second.status).toBe(200);
  expect(calls).toHaveBeenCalledTimes(1);
  await consume({ body: messages[1], ack() {} }, env, {});
  expect(put.mock.calls.some(([key]) => key === 'job-index:_test:ping')).toBe(false);
  expect(await storage.get('job-index:_test:ping')).toEqual(index);
  expect(await account('activity')).toMatchObject({ counts: { '_test:ping': 2 } });
  expect(await account('read-plan')).toEqual({ names: ['_test:ping'] });
  expect((await api('/api/runs?job=_test:ping')).items.map(run => run.id)).toEqual([second.run.id, first.run.id]);
  expect((await api(`/api/runs/${encodeURIComponent(second.run.id)}`)).run).toMatchObject({ status: 'success', cost_microdollars: PRICES.run });
  await account('mutate', { account: 'a', id: 'delete', operations: [{ kind: 'actions', name: 'ping', delete: true }] });
  expect((await api('/api/runs?job=_test:ping')).items).toHaveLength(2);
});

for (const failure of ['settings', 'history', 'response']) {
  it(`recovers combined action-test setup/start after a lost ${failure} write or reply`, async () => {
    const { env, account, api, messages } = await setup();
    const job = env.JOBS.get('a:_test:ping');
    let fault;
    if (failure === 'response') {
      const fetch = job.fetch.bind(job);
      fault = vi.spyOn(job, 'fetch').mockImplementation(async request => {
        const response = await fetch(request);
        if (response.ok) throw new Error('reply lost');
        return response;
      });
    } else {
      const put = job.storage.put.bind(job.storage);
      fault = vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
        if (failure === 'settings' ? key === 'settings' : key.startsWith('history:')) throw new Error('write unavailable');
        return put(key, value);
      });
    }
    expect((await api('/api/actions/ping/test', 'POST', 'recover')).status).toBe(500);
    expect((await account('account')).held_microdollars).toBe(failure === 'settings' ? 0 : PRICES.run);
    fault.mockRestore();
    env.JOBS.objects.set('a:_test:ping', new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env));
    expect((await api('/api/actions/ping/test', 'POST', 'recover')).status).toBe(200);
    expect(messages).toHaveLength(1);
    // Both old and new deliveries use the original single reservation.
    await consume({ body: messages[0], ack() {} }, env, {});
    await consume({ body: messages[0], ack() {} }, env, {});
    expect((await api('/api/actions/ping/test', 'POST', 'recover')).duplicate).toBe(true);
    expect(messages).toHaveLength(1); expect(env.OUTBOUND_FETCH).toHaveBeenCalledTimes(1);
    expect(await account('account')).toMatchObject({ held_microdollars: 0, balance_microdollars: 10000 - PRICES.change - PRICES.run });
    expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.kind === 'run')).toHaveLength(1);
    expect((await api('/api/runs?job=_test:ping')).items).toMatchObject([{ status: 'success', cost_microdollars: PRICES.run }]);
  });
}

it('keeps action-test previews and failed reservations from creating a history index', async () => {
  const { account, api, storage } = await setup();
  expect(await api('/api/actions/ping/test?dry_run=1', 'POST')).toMatchObject({ status: 200, cost_microdollars: 0 });
  expect(await storage.get('job-index:_test:ping')).toBeUndefined();
  const put = storage.put.bind(storage);
  const fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
    if (key === 'balance') throw new Error('reservation unavailable');
    return put(key, value);
  });
  expect((await api('/api/actions/ping/test', 'POST', 'retry')).status).toBe(500);
  fault.mockRestore();
  expect(await storage.get('job-index:_test:ping')).toBeUndefined();
  expect((await account('account')).held_microdollars).toBe(0);
  expect((await api('/api/actions/ping/test', 'POST', 'retry')).status).toBe(200);
  expect(await storage.get('job-index:_test:ping')).toBeDefined();
});
