import { afterEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../index.js';
import { AccountDO } from './account-do.js';
import { JobDO } from './job-do.js';
import { SafetyDO } from './safety-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { consume } from '../executor/consumer.js';
import { COST_POLICY } from '../utils/cost-policy.js';
import { PRICES } from '../utils/pricing.js';

afterEach(() => vi.useRealTimers());
const queueRetries = Number(readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8').match(/max_retries\s*=\s*(\d+)/)[1]);

// Count operations, including deletes and alarm writes, rather than just final rows.
function meter(ns, usage) {
  const get = ns.get.bind(ns); const seen = new Set();
  ns.get = id => {
    const object = get(id);
    if (!seen.has(id)) {
      seen.add(id);
      const fetch = object.fetch.bind(object);
      object.fetch = async (...args) => { usage.requests++; return fetch(...args); };
      const getRow = object.storage.get.bind(object.storage);
      object.storage.get = async (...args) => { usage.reads++; return getRow(...args); };
      const list = object.storage.list.bind(object.storage);
      object.storage.list = async (...args) => { const rows = await list(...args); usage.reads += rows.size; return rows; };
      for (const method of ['put', 'delete', 'setAlarm', 'deleteAlarm']) {
        const original = object.storage[method].bind(object.storage);
        object.storage[method] = async (...args) => { usage.writes++; return original(...args); };
      }
    }
    return object;
  };
}

for (const activityMode of ['ordinary', 'eviction']) for (const holdMode of ['compact', 'standalone']) for (const summaryMode of ['compact', 'rollover', 'large-periods']) {
  for (const mode of ['schedule', 'manual', 'test', 'hook']) {
    for (const recovery of ['normal', 'settlement', 'runtime', 'settlement-response', 'completion', ...(mode === 'test' ? [] : ['retry', 'retry-dispatch', 'retry-cleanup', 'retry-budget', 'retry-budget-runtime', 'retry-budget-settlement-response'])]) {
      it(`bounds full ${mode}/${recovery}/${summaryMode}/${holdMode}/${activityMode} bookkeeping with redirects, redelivery, cold history and pruning`, async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-30T23:59:00Z'));
        const usage = { writes: 0, requests: 0, reads: 0, workerRequests: 0 }; const messages = []; let fetches = 0;
        const withRetry = recovery.startsWith('retry'); const refusedRetry = recovery.startsWith('retry-budget');
        const env = { ENVIRONMENT: 'local', TOKEN_SIGNING_KEY: 'test', APP_ORIGIN: 'https://cronly.org', RUN_QUEUE: { send: async body => messages.push(body) }, OUTBOUND_FETCH: async () => ++fetches % 6 ? new Response(null, { status: 302, headers: { location: `https://example.com/${fetches}` } }) : new Response('ok', { status: withRetry && fetches === 6 ? 500 : 200 }) };
        env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
        env.SAFETY = namespace(SafetyDO, env);
        meter(env.ACCOUNTS, usage); meter(env.JOBS, usage); meter(env.SAFETY, usage);
        await rpc(env.SAFETY, 'global', 'record', { report: { checked_at: Date.now(), brake: false } });
        const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
        const api = async (path, headers = { Authorization: 'LocalDev a' }) => {
          usage.workerRequests++;
          const response = await worker.fetch(new Request(`https://cronly.org${path}`, { method: 'POST', headers, body: '{}' }), env);
          expect(response.status).toBe(200); return response.json();
        };
        await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 100000 });
        await account('mutate', { account: 'a', id: 'defs', operations: [{ kind: 'actions', name: 'ping', value: { url: 'https://example.com', follow_redirects: true, ...(holdMode === 'standalone' ? { method: 'POST', body: 'x'.repeat(9000) } : {}) } }, { kind: 'jobs', name: 'j', value: { action: 'ping', cron: '* * * * *', retries: withRetry ? 1 : 0, ...(refusedRetry ? { budget: { day: PRICES.run + (mode === 'hook' ? PRICES.hook : 0) } } : {}) } }] });
        await account('sync-jobs');
        const token = mode === 'hook' ? (await api('/api/jobs/j/triggers')).token : null;
        if (summaryMode !== 'compact') vi.setSystemTime(new Date('2026-12-01T00:01:00Z'));
        if (summaryMode === 'large-periods') {
          // Prior periods remain compact while the new periods exceed the compact
          // byte limit. Neither their archival nor extra writes may be hidden.
          const storage = env.ACCOUNTS.get('a').storage; const state = await storage.get('balance');
          const by_job = Object.fromEntries(Array.from({ length: 800 }, (_, index) => [String(index).padStart(64, 'j'), 1]));
          for (const [slot, period] of [['day', '2026-12-01'], ['month', '2026-12']]) {
            const metric = { ...state.summaries[slot], period, by_job };
            expect(new TextEncoder().encode(JSON.stringify(metric)).byteLength).toBeGreaterThan(50000);
            await storage.put(`spent:account:self:${period}`, metric);
          }
        }
        const name = mode === 'test' ? '_test:ping' : 'j';
        const job = env.JOBS.get(`a:${name}`);
        if (mode === 'schedule') {
          const settings = await job.storage.get('settings'); settings.next_fire = Date.now();
          await job.storage.put('settings', settings); await job.publish(settings);
        }
        const old = { id: 'old', created_at: Date.now() - 31 * 86400000, status: 'success' };
        await job.storage.put('run:old', old); await job.history(old);
        for (let index = 0; index < 999; index++) {
          const run = { id: `recent-${index}`, created_at: Date.now() - index - 1, status: 'success' };
          await job.storage.put(`run:${run.id}`, run); await job.history(run);
        }
        job.historyCache = null; // Include the cold object's index scan.
        const accountStorage = env.ACCOUNTS.get('a').storage;
        if (activityMode === 'eviction') await accountStorage.put('recent-jobs', { items: Array.from({ length: 100 }, (_, index) => [`old-${index}`, Date.now() - 1000]) });
        // Include a full ledger buffer: this run must archive a page as well as
        // roll over/archive money summaries in the corresponding scenarios.
        const state = await accountStorage.get('balance');
        while (state.ledger.items.length < 100) {
          const sequence = ++state.ledger.sequence;
          state.ledger.items.push([`ledger:${state.ledger.timestamp}:~${String(sequence).padStart(16, '0')}:seed`, { id: `seed-${sequence}`, amount_microdollars: 0, created_at: state.ledger.timestamp }]);
        }
        await accountStorage.put('balance', state);
        await accountStorage.deleteAlarm(); // Include a fresh hold's expiry alarm.
        usage.writes = 0; usage.requests = 0; usage.reads = 0; usage.workerRequests = 0;
        if (mode === 'schedule') { job.storage.alarm = null; usage.requests++; await job.alarm(); }
        else await api(mode === 'test' ? '/api/actions/ping/test' : mode === 'hook' ? `/hook/${token}` : '/api/jobs/j/run', mode === 'hook' ? {} : undefined);
        expect(messages).toHaveLength(1);
        let fault;
        if (recovery === 'settlement') {
          const object = env.ACCOUNTS.get('a'); const dispatch = object.dispatch.bind(object);
          fault = vi.spyOn(object, 'dispatch').mockImplementation(async (tx, args) => {
            if (args.op === 'settle') throw new Error('settlement unavailable');
            return dispatch(tx, args);
          });
        } else if (recovery.endsWith('runtime')) {
          const storage = env.ACCOUNTS.get('a').storage; const put = storage.put.bind(storage);
          fault = vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
            if (key === `runtime:${name}`) throw new Error('runtime unavailable');
            return put(key, value);
          });
        } else if (recovery.endsWith('settlement-response')) {
          const object = env.ACCOUNTS.get('a'); const fetch = object.fetch.bind(object);
          fault = vi.spyOn(object, 'fetch').mockImplementation(async request => {
            const { op } = await request.clone().json(); const response = await fetch(request);
            if (op === 'settle' && response.ok) throw new Error('settlement response lost');
            return response;
          });
        } else if (recovery === 'retry-dispatch') {
          const start = job.start.bind(job);
          fault = vi.spyOn(job, 'start').mockImplementation(async args => {
            if (args.retry) throw new Error('dispatch unavailable');
            return start(args);
          });
        } else if (['completion', 'retry-cleanup'].includes(recovery)) {
          const put = job.storage.put.bind(job.storage);
          fault = vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
            if (key === `history:${messages[0].id}` && (recovery === 'completion' ? value.status === 'success' : value.status === 'failure' && !value.retry)) throw new Error('completion unavailable');
            return put(key, value);
          });
        }
        for (let index = 0; index < messages.length; index++) for (let attempt = 0; attempt <= queueRetries; attempt++) {
          usage.workerRequests++; // Include a separate consumer invocation for each delivery.
          const delivery = consume({ body: messages[index], ack() {} }, env, {});
          if (fault) { await expect(delivery).rejects.toMatchObject({ status: 500 }); fault.mockRestore(); fault = null; }
          else await delivery;
        }
        const runs = withRetry && !refusedRetry ? 2 : 1;
        expect(messages).toHaveLength(runs); expect(fetches).toBe(6 * runs);
        const measured = { ...usage };
        expect(measured.writes, JSON.stringify(measured)).toBeLessThanOrEqual(runs * (COST_POLICY.runRowWrites - (holdMode === 'compact' ? 2 : 0)) + (mode === 'hook' ? 1 : 0) + (activityMode === 'eviction' ? 1 : 0));
        expect(measured.requests, JSON.stringify(measured)).toBeLessThanOrEqual(runs * COST_POLICY.runDoRequests);
        expect(measured.workerRequests, JSON.stringify(measured)).toBeLessThanOrEqual(runs * COST_POLICY.runWorkerRequests);
        expect(measured.reads, JSON.stringify(measured)).toBeLessThanOrEqual(runs * 3000);
        expect(await job.storage.get('run:old')).toBeUndefined();
        expect((await account('account')).held_microdollars).toBe(0);
      });
    }
  }
}
