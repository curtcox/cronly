import { afterEach, expect, it, vi } from 'vitest';
import { AccountDO } from './account-do.js';
import { JobDO } from './job-do.js';
import { MemoryStorage, namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { consume } from '../executor/consumer.js';
import { PRICES } from '../utils/pricing.js';

afterEach(() => vi.useRealTimers());

for (const status of ['queued', 'running', 'failure']) {
  for (const limit of ['age', 'count']) {
    it(`preserves a ${status} recovery outbox beyond the retention ${limit} after restart`, async () => {
      const storage = new MemoryStorage(); const ctx = { storage, blockConcurrencyWhile: fn => fn() };
      const job = new JobDO(ctx, {});
      const created_at = Date.now() - (limit === 'age' ? 31 * 86400000 : 10000);
      const run = { id: 'recover', status, created_at };
      await storage.put('run:recover', run);
      await job.history(run, false, null, status === 'failure' ? { dispatch: true, input: { event: 'private' } } : undefined);
      if (limit === 'count') for (let index = 0; index < 1000; index++) await job.history({ id: `new-${index}`, status: 'success', created_at: Date.now() - index });
      const cold = new JobDO(ctx, {});
      await cold.prune();
      expect(await storage.get('history:recover')).toBeDefined();
      expect(await cold.readRun('recover')).toMatchObject(run);
      const summary = await storage.get('history:recover');
      if (status === 'failure') delete summary.retry;
      else { summary.status = 'expired'; delete summary.pending; }
      await storage.put('history:recover', summary);
      const finished = new JobDO(ctx, {});
      await finished.prune();
      expect(await storage.get('history:recover')).toBeUndefined();
      expect(await storage.get('run:recover')).toBeUndefined();
    });
  }
}

it('rolls back retention deletes together and retries without losing the cached log', async () => {
  const storage = new MemoryStorage();
  const job = new JobDO({ storage, blockConcurrencyWhile: fn => fn() }, {});
  const run = { id: 'old', status: 'success', created_at: Date.now() - 31 * 86400000, response_excerpt: 'saved result' };
  await storage.put('run:old', run); await job.history(run); await job.summaries();
  const remove = storage.delete.bind(storage);
  const fault = vi.spyOn(storage, 'delete').mockImplementation(async key => {
    if (key === 'history:old') throw new Error('retention unavailable');
    return remove(key);
  });
  await expect(job.prune()).rejects.toThrow('retention unavailable');
  expect(await job.readRun('old')).toEqual(run);
  expect(await job.summaries()).toHaveLength(1);
  fault.mockRestore(); await job.prune();
  expect(await job.summaries()).toEqual([]);
  expect(await storage.get('history:old')).toBeUndefined();
  expect(await storage.get('run:old')).toBeUndefined();
});

it('recovers a staged outcome and private retry after a prolonged outage and pruning', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const messages = [];
  const env = { ENVIRONMENT: 'local', RUN_QUEUE: { send: async body => messages.push(body) }, OUTBOUND_FETCH: vi.fn(async () => new Response('failed', { status: 500 })) };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 10000 });
  await account('mutate', { account: 'a', id: 'defs', operations: [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com', headers: { 'X-Event': '{{input.event}}' } } },
    { kind: 'jobs', name: 'j', value: { action: 'ping', cron: null, retries: 1 } }
  ] });
  await account('sync-jobs');
  await rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: { event: 'original' }, trigger: 'manual' });
  const job = env.JOBS.get('a:j'); const put = job.storage.put.bind(job.storage);
  const fault = vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
    if (key === 'history:r' && value.status === 'failure') throw new Error('completion unavailable');
    return put(key, value);
  });
  await expect(consume({ body: messages[0], ack() {} }, env, {})).rejects.toMatchObject({ status: 500 });
  fault.mockRestore();
  const before = (await account('account')).balance_microdollars;
  await vi.advanceTimersByTimeAsync(31 * 86400000);
  const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
  env.JOBS.objects.set('a:j', cold);
  await cold.prune(); await cold.alarm();
  expect(messages).toHaveLength(2);
  await consume({ body: messages[1], ack() {} }, env, {});
  expect(env.OUTBOUND_FETCH).toHaveBeenCalledTimes(2);
  expect(env.OUTBOUND_FETCH.mock.calls[1][0].headers.get('X-Event')).toBe('original');
  expect(await account('account')).toMatchObject({ balance_microdollars: before - PRICES.run, held_microdollars: 0 });
  expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.id === 'r')).toHaveLength(1);
  expect(await cold.storage.get('history:r')).toBeUndefined();
  expect(await cold.readRun('r:retry')).toMatchObject({ status: 'failure', cost_microdollars: PRICES.run });
});
