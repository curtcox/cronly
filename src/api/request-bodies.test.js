import { expect, it, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';

async function setup() {
  const env = { ENVIRONMENT: 'local', RUN_QUEUE: { send: vi.fn() }, LLM_FETCH: vi.fn() };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' });
  await account('deposit', { id: 'fund', amount: 5000000 });
  await account('mutate', { account: 'a', id: 'setup', operations: [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com' } },
    { kind: 'jobs', name: 'j', value: { action: 'ping', cron: null } }
  ] });
  await account('sync-jobs');
  const request = (path, body, method = 'POST') => worker.fetch(new Request(`https://cronly.org${path}`, {
    method, headers: { Authorization: 'LocalDev a' }, body: JSON.stringify(body)
  }), env);
  return { env, account, request };
}

it('rejects non-object JSON across request handlers before any charge or external work', async () => {
  const { env, account, request } = await setup();
  const before = await account('account');
  for (const body of [null, [], false, 0, 'text']) {
    for (const [method, path] of [
      ['POST', '/api/cron/explain'], ['POST', '/api/dev/deposit'],
      ['PUT', '/api/variables/message'], ['PUT', '/api/config'],
      ['POST', '/api/jobs/j/run'], ['POST', '/api/actions/ping/test'],
      ['POST', '/api/jobs/j/triggers'], ['POST', '/api/keys'],
      ['POST', '/api/payments/checkout'], ['POST', '/api/prose/to-cron'],
      ['POST', '/api/changes/missing/apply']
    ]) {
      const response = await request(path, body, method);
      expect(response.status, `${method} ${path}: ${JSON.stringify(body)}`).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'invalid_json', cost_microdollars: 0 });
    }
  }
  expect(await account('account')).toEqual(before);
  expect(env.RUN_QUEUE.send).not.toHaveBeenCalled();
  expect(env.LLM_FETCH).not.toHaveBeenCalled();
  expect((await account('config')).variables).toEqual({});
});

for (const path of ['/api/jobs/j/run', '/api/actions/ping/test']) {
  it(`rejects explicit invalid input on ${path}, including dry runs`, async () => {
    const { env, account, request } = await setup();
    const before = await account('account');
    for (const input of [null, false, 0, '', [], { event: 42 }]) {
      for (const suffix of ['', '?dry_run=1']) {
        const response = await request(path + suffix, { input });
        expect(response.status, `${suffix}: ${JSON.stringify(input)}`).toBe(400);
        expect(await response.json()).toMatchObject({ code: 'invalid_input', cost_microdollars: 0 });
      }
    }
    expect(await account('account')).toEqual(before);
    expect(env.RUN_QUEUE.send).not.toHaveBeenCalled();
    // Omitting optional input continues to mean an empty object.
    expect((await request(`${path}?dry_run=1`, {})).status).toBe(200);
    expect((await request(path, {})).status).toBe(200);
    expect(env.RUN_QUEUE.send).toHaveBeenCalledTimes(1);
  });
}
