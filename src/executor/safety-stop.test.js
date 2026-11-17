import { afterEach, expect, it, vi } from 'vitest';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { price } from '../utils/pricing.js';
import { consume } from './consumer.js';

afterEach(() => vi.useRealTimers());

for (const stop of ['operator', 'analytics']) for (const type of ['http', 'javascript']) {
  for (const hold of ['compact', 'standalone']) for (const failure of ['none', 'settlement', 'completion']) {
    it(`refunds queued ${type}/${hold} work stopped by ${stop}, recovering ${failure} without execution or activation`, async () => {
      vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
      const messages = [];
      const invoke = vi.fn(async () => Response.json({ status: 'success', value_text: '1' }));
      const env = {
        ENVIRONMENT: 'local', TOKEN_SIGNING_KEY: 'test',
        RUN_QUEUE: { send: async body => messages.push(body) },
        OUTBOUND_FETCH: vi.fn(async () => new Response('ok')),
        LOADER: { get: vi.fn(() => ({ getEntrypoint: () => ({ fetch: invoke }) })) }
      };
      env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
      const ctx = { exports: { OutboundGateway: () => ({}) } };
      const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
      const action = type === 'http'
        ? { url: 'https://example.com', ...(hold === 'standalone' ? { method: 'POST', body: 'x'.repeat(9000) } : {}) }
        : { type, source: `export default () => 1;${hold === 'standalone' ? `/*${'x'.repeat(9000)}*/` : ''}`, cpu_ms: 100, subrequests: 0 };
      await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 100000 });
      await account('mutate', { account: 'a', id: 'defs', operations: [
        { kind: 'actions', name: 'ping', value: action },
        { kind: 'jobs', name: 'j', value: { action: 'ping', cron: null, retries: 1 } },
        { kind: 'jobs', name: 'next', value: { action: 'ping', cron: null } }
      ] });
      await account('sync-jobs');
      await rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: {}, trigger: 'manual' });
      const storage = env.ACCOUNTS.get('a').storage;
      expect(Boolean(await storage.get('hold:r'))).toBe(hold === 'standalone');
      const before = await account('account');
      expect(before.held_microdollars).toBe(price('run', action));

      // Enable the brake only after a fully authorized run reaches the Queue.
      if (stop === 'operator') env.COST_SAFETY_HARD_STOP = 'true';
      const safety = vi.fn(async () => {
        if (stop === 'operator') throw new Error('analytics unavailable');
        return Response.json({ brake: true });
      });
      env.SAFETY = { idFromName: id => id, get: () => ({ fetch: safety }) };
      const job = env.JOBS.get('a:j');
      const report = vi.spyOn(job, 'fetch');
      let fault;
      if (failure === 'settlement') {
        const dispatch = env.ACCOUNTS.get('a').dispatch.bind(env.ACCOUNTS.get('a'));
        fault = vi.spyOn(env.ACCOUNTS.get('a'), 'dispatch').mockImplementation(async (tx, args) => {
          if (args.op === 'settle') throw new Error('billing unavailable');
          return dispatch(tx, args);
        });
      } else if (failure === 'completion') {
        const put = job.storage.put.bind(job.storage);
        fault = vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
          if (key === 'history:r' && value.status === 'failure') throw new Error('completion unavailable');
          return put(key, value);
        });
      }
      const ack = vi.fn(); const message = { body: messages[0], ack };
      if (fault) {
        await expect(consume(message, env, ctx)).rejects.toMatchObject({ status: 500 });
        expect(report).toHaveBeenCalledOnce();
        expect(ack).not.toHaveBeenCalled(); fault.mockRestore();
        env.JOBS.objects.set('a:j', new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env));
      }
      await consume(message, env, ctx); await consume(message, env, ctx);
      expect(ack).toHaveBeenCalledTimes(2);
      expect(env.OUTBOUND_FETCH).not.toHaveBeenCalled(); expect(env.LOADER.get).not.toHaveBeenCalled();
      if (stop === 'operator') expect(safety).not.toHaveBeenCalled();
      expect(messages).toHaveLength(1);
      expect(await rpc(env.JOBS, 'a:j', 'run', { id: 'r' })).toMatchObject({ status: 'failure', cost_microdollars: 0, error: 'Paused by cost safety brake' });
      expect((await job.storage.get('history:r')).retry).toBeUndefined();
      expect(await account('account')).toMatchObject({ balance_microdollars: before.balance_microdollars, held_microdollars: 0, spent_today_microdollars: before.spent_today_microdollars });
      expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.id === 'r')).toMatchObject([{ amount_microdollars: 0 }]);
      expect((await storage.list({ prefix: 'activation:' })).size).toBe(0);

      // A skipped isolate must not discount the first actual activation later.
      delete env.COST_SAFETY_HARD_STOP;
      safety.mockImplementation(async () => Response.json({ brake: false }));
      await rpc(env.JOBS, 'a:next', 'start', { id: 'actual', input: {}, trigger: 'manual' });
      await consume({ body: messages[1], ack() {} }, env, ctx);
      expect(await rpc(env.JOBS, 'a:next', 'run', { id: 'actual' })).toMatchObject({ status: 'success', cost_microdollars: price('run', action) });
      expect(type === 'http' ? env.OUTBOUND_FETCH : invoke).toHaveBeenCalledOnce();
      expect(await account('account')).toMatchObject({ balance_microdollars: before.balance_microdollars - price('run', action), held_microdollars: 0 });
    });
  }
}
