import { expect, it, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';

async function setup(enabled) {
  const env = { ENVIRONMENT: 'local' }; env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 10000 });
  const job = { action: 'ping', cron: null, enabled, budget: { day: 1000 } };
  await account('mutate', { account: 'a', id: 'setup', operations: [{ kind: 'actions', name: 'ping', value: { url: 'https://example.com' } }, { kind: 'jobs', name: 'j', value: job }] });
  await account('sync-jobs');
  const api = async (operation, dry = false) => {
    const response = await worker.fetch(new Request(`https://cronly.org/api/jobs/j/${operation}${dry ? '?dry_run=1' : ''}`, {
      method: 'POST', headers: { Authorization: 'LocalDev a', 'Idempotency-Key': 'toggle' }, body: '{}'
    }), env);
    return { status: response.status, ...await response.json() };
  };
  const cold = () => { const storage = env.ACCOUNTS.get('a').storage; env.ACCOUNTS.objects.set('a', new AccountDO({ storage }, env)); };
  return { env, account, api, cold, job };
}

for (const operation of ['pause', 'resume']) {
  it(`replays ${operation} after a lost response without overwriting later job edits`, async () => {
    const { env, account, api, cold, job } = await setup(operation === 'pause');
    const object = env.ACCOUNTS.get('a'); const fetch = object.fetch.bind(object); let original;
    vi.spyOn(object, 'fetch').mockImplementation(async request => {
      const response = await fetch(request); const value = await response.clone().json();
      if (value.changes?.length) { original = { status: response.status, ...value }; throw new Error('reply lost'); }
      return response;
    });
    expect((await api(operation)).status).toBe(500); cold();
    await account('mutate', { account: 'a', id: 'edit', operations: [{ kind: 'jobs', name: 'j', value: { ...job, budget: { day: 5000 } } }] });
    expect(await api(operation)).toEqual(original);
    expect((await account('config')).jobs.j).toMatchObject({ enabled: job.enabled, budget: { day: 5000 } });
    expect(await rpc(env.JOBS, 'a:j', 'status')).toMatchObject({ job: { enabled: job.enabled, budget: { day: 5000 } } });
    expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.kind === 'change')).toHaveLength(3);
  });
}

it('rejects opposite toggles sharing a key while allowing current-state dry-run quotes', async () => {
  const { api, account } = await setup(true);
  expect((await api('pause')).cost_microdollars).toBe(100);
  expect(await api('resume')).toMatchObject({ status: 409, code: 'idempotency_conflict' });
  expect(await api('resume', true)).toMatchObject({ status: 200, cost_microdollars: 0, quote_microdollars: 100 });
  expect((await account('config')).jobs.j.enabled).toBe(false);
});

it('recovers a completed toggle even after the job was deleted', async () => {
  const { api, account, cold } = await setup(true);
  const original = await api('pause');
  await account('mutate', { account: 'a', id: 'delete', operations: [{ kind: 'jobs', name: 'j', delete: true }] });
  cold(); expect(await api('pause')).toEqual(original);
  expect((await account('config')).jobs).toEqual({});
});

it('keeps a failed publication in the durable outbox and recovers once after restart', async () => {
  const { env, api, account, cold } = await setup(true);
  const job = env.JOBS.get('a:j');
  const fault = vi.spyOn(job, 'fetch').mockRejectedValue(new Error('job unavailable'));
  const saved = await api('pause'); expect(saved).toMatchObject({ status: 200, cost_microdollars: 100 });
  expect(await env.ACCOUNTS.get('a').storage.get('sync:j')).toBeDefined();
  fault.mockRestore(); cold();
  await env.ACCOUNTS.get('a').alarm();
  expect(await rpc(env.JOBS, 'a:j', 'status')).toMatchObject({ job: { enabled: false } });
  expect(await env.ACCOUNTS.get('a').storage.get('sync:j')).toBeUndefined();
  expect(await api('pause')).toEqual(saved);
  expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.kind === 'change')).toHaveLength(2);
});

it('rolls back the toggle, charge and sync outbox when its receipt cannot persist', async () => {
  const { env, api, account, cold } = await setup(true);
  const storage = env.ACCOUNTS.get('a').storage; const put = storage.put.bind(storage);
  const fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
    if (key.startsWith('job-toggle:')) throw new Error('receipt unavailable');
    return put(key, value);
  });
  expect((await api('pause')).status).toBe(500); fault.mockRestore(); cold();
  expect((await account('config')).jobs.j.enabled).toBe(true);
  expect((await account('account')).balance_microdollars).toBe(9800);
  expect(await storage.get('sync:j')).toBeUndefined();
  expect((await api('pause')).cost_microdollars).toBe(100);
});
