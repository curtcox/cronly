import { expect, it, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { price } from '../utils/pricing.js';
import { signToken } from '../auth/crypto.js';

for (const hook of [false, true]) {
  it(`reports the missing balance across AccountDO and JobDO for ${hook ? 'webhook' : 'manual'} runs`, async () => {
    const env = { ENVIRONMENT: 'local', TOKEN_SIGNING_KEY: 'test', RUN_QUEUE: { send: vi.fn() } };
    env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
    const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
    await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 280 });
    await account('mutate', { account: 'a', id: 'defs', operations: [
      { kind: 'actions', name: 'ping', value: { url: 'https://example.com' } },
      { kind: 'jobs', name: 'j', value: { action: 'ping', cron: null } }
    ] });
    await account('sync-jobs');
    let path = '/api/jobs/j/run';
    if (hook) {
      await env.JOBS.get('a:j').storage.put('trigger:t', { id: 't', rate: 1, revoked: false });
      path = `/hook/${await signToken('tk_', { account: 'a', job: 'j', id: 't' }, env.TOKEN_SIGNING_KEY)}`;
    }
    const response = await worker.fetch(new Request(`https://cronly.org${path}`, { method: 'POST', headers: hook ? {} : { Authorization: 'LocalDev a' }, body: '{}' }), env);
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: 'Insufficient balance', code: 'insufficient_balance', cost_microdollars: 0,
      needed_microdollars: price(hook ? 'hook' : 'run') - 80,
      ...(!hook ? { balance_microdollars: 80 } : {})
    });
    expect(await account('account')).toMatchObject({ balance_microdollars: 80, held_microdollars: 0 });
    expect(env.RUN_QUEUE.send).not.toHaveBeenCalled();
  });
}
