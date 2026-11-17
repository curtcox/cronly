import { expect, it, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { price } from '../utils/pricing.js';

async function setup() {
  const env = { ENVIRONMENT: 'local', TOKEN_SIGNING_KEY: 'test', APP_ORIGIN: 'https://cronly.org', RUN_QUEUE: { send: vi.fn() } };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 10000 });
  await account('mutate', { account: 'a', id: 'defs', operations: [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com/{{input.message}}' } },
    { kind: 'jobs', name: 'j', value: { action: 'ping', cron: null } }
  ] });
  await account('sync-jobs');
  const response = await worker.fetch(new Request('https://cronly.org/api/jobs/j/triggers', { method: 'POST', headers: { Authorization: 'LocalDev a' }, body: '{"rate_per_minute":1}' }), env);
  const trigger = await response.json();
  const call = async (input, dry = true, method = 'POST') => {
    const response = await worker.fetch(new Request(`${trigger.url}${dry ? '?dry_run=1' : ''}`, {
      method, headers: { 'Idempotency-Key': 'same-operation' }, ...(method === 'POST' ? { body: JSON.stringify(input) } : {})
    }), env);
    return { status: response.status, ...await response.json() };
  };
  return { env, account, trigger, call };
}

for (const [input, code] of [[{}, 'missing_input'], [{ message: 1 }, 'invalid_input'], [[], 'invalid_json'], [{ message: 'x'.repeat(2049) }, 'invalid_input']]) {
  it(`validates hook preview input (${code}, ${Array.isArray(input) ? 'array' : typeof input.message}) without changing durable state`, async () => {
    const { env, call } = await setup();
    const stores = [env.ACCOUNTS.get('a').storage, env.JOBS.get('a:j').storage];
    const snapshots = stores.map(storage => structuredClone(storage.rows));
    expect(await call(input)).toMatchObject({ status: 400, code, cost_microdollars: 0 });
    expect(stores.map(storage => storage.rows)).toEqual(snapshots);
    expect(env.RUN_QUEUE.send).not.toHaveBeenCalled();
  });
}

it('validates GET hook previews with the same empty input as a real GET trigger', async () => {
  const { call } = await setup();
  expect(await call(undefined, true, 'GET')).toMatchObject({ status: 400, code: 'missing_input' });
});

for (const deleted of [false, true]) {
  it(`checks the current ${deleted ? 'deleted' : 'disabled'} job before its scheduling update is delivered`, async () => {
    const { env, account, call } = await setup();
    await account('mutate', { account: 'a', id: 'edit', operations: [{ kind: 'jobs', name: 'j', ...(deleted ? { delete: true } : { value: { action: 'ping', cron: null, enabled: false } }) }] });
    expect((await rpc(env.JOBS, 'a:j', 'status')).job.enabled).toBe(true);
    expect(await call({ message: 'hello' })).toMatchObject({ status: deleted ? 404 : 409, code: deleted ? 'not_found' : 'job_disabled' });
    expect((await account('account')).held_microdollars).toBe(0);
    expect(env.RUN_QUEUE.send).not.toHaveBeenCalled();
  });
}

it('quotes current input on replay and leaves the token allowance available for execution', async () => {
  const { env, account, trigger, call } = await setup();
  const before = await account('account');
  expect(await call({ message: 'hello' })).toMatchObject({ status: 200, quote_microdollars: price('hook'), cost_microdollars: 0 });
  expect(await env.JOBS.get('a:j').storage.get(`trigger-rate:${trigger.id}`)).toBeUndefined();
  expect(await account('account')).toEqual(before);
  expect((await call({ message: 'hello' }, false)).status).toBe(200);
  // A preview sharing a real run's identity must still validate the new input.
  expect(await call({ message: 1 })).toMatchObject({ status: 400, code: 'invalid_input' });
  expect(env.RUN_QUEUE.send).toHaveBeenCalledOnce();
});
