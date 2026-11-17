import { it, expect, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { worstCaseCost } from '../utils/cost-policy.js';
it('restricts hooks to a signed single-job token and supports CORS and revocation', async () => {
  const queued = []; const env = { ENVIRONMENT: 'local', TOKEN_SIGNING_KEY: 'test', APP_ORIGIN: 'https://cronly.org', RUN_QUEUE: { send: async body => queued.push(body) } };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const api = async (path, method, body, headers = { Authorization: 'LocalDev a' }) => worker.fetch(new Request(`https://cronly.org${path}`, { method, headers, body: body && JSON.stringify(body) }), env);
  await api('/api/dev/deposit', 'POST', { amount_microdollars: 2000 });
  await api('/api/actions/ping', 'PUT', { url: 'https://example.com/{{input.message}}' });
  await api('/api/jobs/pinger', 'PUT', { action: 'ping', cron: null });
  const trigger = await (await api('/api/jobs/pinger/triggers', 'POST', {})).json();
  const response = await api(`/hook/${trigger.token}`, 'POST', { message: 'hello' }, {});
  expect(response.status).toBe(200); expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*'); expect(queued).toHaveLength(1);
  expect((await api(`/hook/${trigger.token}x`, 'POST', {}, {})).status).toBe(401);
  await api(`/api/jobs/pinger/triggers/${trigger.id}`, 'DELETE');
  expect((await api(`/hook/${trigger.token}`, 'POST', {}, {})).status).toBe(401);
  expect((await api('/api/account', 'GET')).headers.has('Access-Control-Allow-Origin')).toBe(false);
});

async function setup() {
  const env = { ENVIRONMENT: 'local', TOKEN_SIGNING_KEY: 'test', APP_ORIGIN: 'https://cronly.org', RUN_QUEUE: { send: async () => {} } };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 10000 });
  await account('mutate', { account: 'a', id: 'defs', operations: [{ kind: 'actions', name: 'ping', value: { url: 'https://example.com' } }, { kind: 'jobs', name: 'j', value: { action: 'ping', cron: null } }] });
  await account('sync-jobs');
  const api = async (path = '/api/jobs/j/triggers', method = 'POST', body = { rate_per_minute: 23 }, authorization = 'LocalDev a', id = 'trigger') => {
    const response = await worker.fetch(new Request(`https://cronly.org${path}`, {
      method, headers: { Authorization: authorization, 'Idempotency-Key': id },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
    }), env);
    return { status: response.status, ...await response.json() };
  };
  const cold = () => {
    for (const [ns, id, Class] of [[env.ACCOUNTS, 'a', AccountDO], [env.JOBS, 'a:j', JobDO]]) {
      const storage = ns.get(id).storage; ns.objects.set(id, new Class({ storage, blockConcurrencyWhile: fn => fn() }, env));
    }
  };
  return { env, account, api, cold };
}

for (const failure of ['billing-reply', 'trigger-write']) {
  it(`binds trigger creation to its paid rate after a lost ${failure} and restart`, async () => {
    const { env, account, api, cold } = await setup(); let paid; let fault;
    if (failure === 'billing-reply') {
      const object = env.ACCOUNTS.get('a'); const fetch = object.fetch.bind(object);
      fault = vi.spyOn(object, 'fetch').mockImplementation(async request => {
        const { op } = await request.clone().json(); const response = await fetch(request);
        if (op === 'bill-change' && response.ok) { paid = await response.json(); throw new Error('reply lost'); }
        return response;
      });
    } else {
      const storage = env.JOBS.get('a:j').storage; const put = storage.put.bind(storage);
      fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
        if (key.startsWith('trigger:')) throw new Error('trigger unavailable');
        return put(key, value);
      });
    }
    expect((await api()).status).toBe(500); fault.mockRestore(); cold();
    expect((await api('/api/jobs/j/triggers', 'GET')).items).toEqual([]);
    expect(await api('/api/jobs/j/triggers', 'POST', { rate_per_minute: 24 })).toMatchObject({ status: 409, code: 'idempotency_conflict' });
    expect((await api('/api/jobs/j/triggers', 'GET')).items).toEqual([]);
    const recovered = await api();
    expect(recovered).toMatchObject({ status: 200, cost_microdollars: 100, balance_microdollars: 9700, token: expect.stringMatching(/^tk_/) });
    if (paid) expect(recovered).toMatchObject(paid);
    expect((await api('/api/jobs/j/triggers', 'GET')).items).toEqual([{ id: recovered.id, rate_per_minute: 23, revoked: false }]);
    cold(); expect(await api()).toEqual(recovered);
    expect((await account('account')).balance_microdollars).toBe(9700);
    expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.id.startsWith('trigger:'))).toHaveLength(1);
  });
}

it('replays creation after revocation without changing the paid rate or reactivating the token', async () => {
  const { env, account, api, cold } = await setup(); const created = await api();
  const storage = env.JOBS.get('a:j').storage;
  const revoked = await api(`/api/jobs/j/triggers/${created.id}`, 'DELETE'); cold();
  const put = vi.spyOn(storage, 'put');
  expect(await api()).toEqual(created);
  expect(await api(`/api/jobs/j/triggers/${created.id}`, 'DELETE')).toEqual(revoked);
  expect(put).not.toHaveBeenCalled();
  expect((await api('/api/jobs/j/triggers', 'GET')).items).toEqual([{ id: created.id, rate_per_minute: 23, revoked: true }]);
  const denied = await worker.fetch(new Request(created.url, { method: 'POST', body: '{}' }), env);
  expect(denied.status).toBe(401);
  expect((await account('account')).balance_microdollars).toBe(9600);
});

it('quotes changed trigger rates without replaying or consuming a billed receipt', async () => {
  const { api, account } = await setup();
  const dry = await api('/api/jobs/j/triggers?dry_run=1');
  expect(dry).toMatchObject({ status: 200, quote_microdollars: 100, cost_microdollars: 0 });
  expect(dry).not.toHaveProperty('token'); expect(dry).not.toHaveProperty('url');
  const created = await api('/api/jobs/j/triggers', 'POST', { rate_per_minute: 24 });
  expect(created).toMatchObject({ status: 200, cost_microdollars: 100 });
  expect(await api('/api/jobs/j/triggers?dry_run=1', 'POST', { rate_per_minute: 25 })).toMatchObject({ status: 200, quote_microdollars: 100, cost_microdollars: 0 });
  expect(await api('/api/jobs/j/triggers', 'POST', { rate_per_minute: 25 })).toMatchObject({ status: 409, code: 'idempotency_conflict' });
  expect((await account('account')).balance_microdollars).toBe(9700);
});

for (const failure of ['billing-reply', 'trigger-write']) {
  it(`recovers trigger revocation after a lost ${failure} without another charge`, async () => {
    const { env, api, account, cold } = await setup(); const created = await api(); let fault;
    if (failure === 'billing-reply') {
      const object = env.ACCOUNTS.get('a'); const fetch = object.fetch.bind(object);
      fault = vi.spyOn(object, 'fetch').mockImplementation(async request => {
        const { op } = await request.clone().json(); const response = await fetch(request);
        if (op === 'bill-change' && response.ok) throw new Error('reply lost');
        return response;
      });
    } else {
      const storage = env.JOBS.get('a:j').storage; const put = storage.put.bind(storage);
      fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
        if (key.startsWith('trigger:')) throw new Error('trigger unavailable');
        return put(key, value);
      });
    }
    const path = `/api/jobs/j/triggers/${created.id}`;
    expect((await api(path, 'DELETE')).status).toBe(500); fault.mockRestore(); cold();
    const recovered = await api(path, 'DELETE');
    expect(recovered).toMatchObject({ status: 200, cost_microdollars: 100, balance_microdollars: 9600 });
    cold(); expect(await api(path, 'DELETE')).toEqual(recovered);
    expect((await api('/api/jobs/j/triggers', 'GET')).items).toEqual([{ id: created.id, rate_per_minute: 23, revoked: true }]);
    expect((await account('account')).balance_microdollars).toBe(9600);
    expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.id.startsWith('trigger:'))).toHaveLength(2);
  });
}

it('rolls back trigger billing on an account write failure before exposing a token', async () => {
  const { env, api, account, cold } = await setup(); const storage = env.ACCOUNTS.get('a').storage; const put = storage.put.bind(storage);
  const fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
    if (key.startsWith('audit:') && value.kind === 'trigger') throw new Error('audit unavailable');
    return put(key, value);
  });
  expect((await api()).status).toBe(500); fault.mockRestore(); cold();
  expect((await account('account')).balance_microdollars).toBe(9800);
  expect((await api('/api/jobs/j/triggers', 'GET')).items).toEqual([]);
  expect((await api()).cost_microdollars).toBe(100);
});

it('recovers a paid trigger after its delegated key has spent its entire daily cap', async () => {
  const { env, api, account, cold } = await setup();
  const key = await api('/api/keys', 'POST', { scopes: ['change'], daily_spend_microdollars: 100 });
  const authorization = `ApiKey ${key.token}`;
  const storage = env.JOBS.get('a:j').storage; const put = storage.put.bind(storage);
  const fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
    if (key.startsWith('trigger:')) throw new Error('trigger unavailable');
    return put(key, value);
  });
  expect((await api(undefined, 'POST', undefined, authorization)).status).toBe(500); fault.mockRestore(); cold();
  const recovered = await api(undefined, 'POST', undefined, authorization);
  expect(recovered).toMatchObject({ status: 200, cost_microdollars: 100 });
  expect(await api(undefined, 'POST', undefined, authorization)).toEqual(recovered);
  expect(await api(undefined, 'POST', undefined, authorization, 'another')).toMatchObject({ status: 402, code: 'key_budget_day' });
  expect((await account('account')).balance_microdollars).toBe(9600);
  expect((await api('/api/jobs/j/triggers', 'GET')).items).toEqual([{ id: recovered.id, rate_per_minute: 23, revoked: false }]);
});

it('keeps trigger creation and revocation writes within the existing change allowance', async () => {
  const { env, api } = await setup();
  const spies = [env.ACCOUNTS.get('a').storage, env.JOBS.get('a:j').storage].flatMap(storage => ['put', 'delete', 'setAlarm', 'deleteAlarm'].map(method => vi.spyOn(storage, method)));
  const created = await api();
  expect(created.status).toBe(200);
  expect(spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBeLessThanOrEqual(worstCaseCost('change'));
  spies.forEach(spy => spy.mockClear());
  expect((await api(`/api/jobs/j/triggers/${created.id}`, 'DELETE')).status).toBe(200);
  expect(spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBeLessThanOrEqual(worstCaseCost('change'));
});
