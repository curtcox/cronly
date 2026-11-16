import { afterEach, it, expect, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from './account-do.js';
import { JobDO } from './job-do.js';
import { SafetyDO } from './safety-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { consume } from '../executor/consumer.js';
import { COST_POLICY } from '../utils/cost-policy.js';

afterEach(() => vi.useRealTimers());

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

for (const mode of ['schedule', 'manual', 'test', 'hook']) {
  it(`bounds full ${mode} run bookkeeping with redirects, cold history and pruning`, async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
    const usage = { writes: 0, requests: 0, reads: 0 }; const messages = []; let fetches = 0;
    const env = { ENVIRONMENT: 'local', TOKEN_SIGNING_KEY: 'test', APP_ORIGIN: 'https://cronly.org', RUN_QUEUE: { send: async body => messages.push(body) }, OUTBOUND_FETCH: async () => ++fetches <= 5 ? new Response(null, { status: 302, headers: { location: `https://example.com/${fetches}` } }) : new Response('ok') };
    env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
    env.SAFETY = namespace(SafetyDO, env);
    meter(env.ACCOUNTS, usage); meter(env.JOBS, usage); meter(env.SAFETY, usage);
    await rpc(env.SAFETY, 'global', 'record', { report: { checked_at: Date.now(), brake: false } });
    const account = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
    const api = async (path, headers = { Authorization: 'LocalDev a' }) => {
      const response = await worker.fetch(new Request(`https://cronly.org${path}`, { method: 'POST', headers, body: '{}' }), env);
      expect(response.status).toBe(200); return response.json();
    };
    await account('init', { account: 'a' }); await account('deposit', { id: 'fund', amount: 100000 });
    await account('mutate', { account: 'a', id: 'defs', operations: [{ kind: 'actions', name: 'ping', value: { url: 'https://example.com', follow_redirects: true } }, { kind: 'jobs', name: 'j', value: { action: 'ping', cron: '* * * * *' } }] });
    await account('sync-jobs');
    const token = mode === 'hook' ? (await api('/api/jobs/j/triggers')).token : null;
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
    await env.ACCOUNTS.get('a').storage.deleteAlarm(); // Include a fresh hold's expiry alarm.
    usage.writes = 0; usage.requests = 0; usage.reads = 0;
    if (mode === 'schedule') { job.storage.alarm = null; usage.requests++; await job.alarm(); }
    else await api(mode === 'test' ? '/api/actions/ping/test' : mode === 'hook' ? `/hook/${token}` : '/api/jobs/j/run', mode === 'hook' ? {} : undefined);
    expect(messages).toHaveLength(1);
    await consume({ body: messages[0], ack() {} }, env, {});
    expect(fetches).toBe(6);
    const measured = { ...usage };
    expect(measured.writes, JSON.stringify(measured)).toBeLessThanOrEqual(COST_POLICY.runRowWrites + (mode === 'hook' ? 1 : 0));
    expect(measured.requests, JSON.stringify(measured)).toBeLessThanOrEqual(COST_POLICY.runDoRequests);
    expect(measured.reads, JSON.stringify(measured)).toBeLessThanOrEqual(3000);
    expect(await job.storage.get('run:old')).toBeUndefined();
    expect((await account('account')).held_microdollars).toBe(0);
  });
}
