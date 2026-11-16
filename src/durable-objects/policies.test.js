import { afterEach, it, expect, vi } from 'vitest';
import { AccountDO } from './account-do.js';
import { JobDO } from './job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { consume } from '../executor/consumer.js';
afterEach(() => vi.useRealTimers());
async function setup(job = {}) {
  const messages = []; const env = { ENVIRONMENT: 'local', RUN_QUEUE: { send: async body => messages.push(body) }, OUTBOUND_FETCH: async () => new Response('failed', { status: 500 }) };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const call = (op, args) => rpc(env.ACCOUNTS, 'a', op, args);
  await call('init', { account: 'a' }); await call('deposit', { id: 'd', amount: 100000 });
  await call('mutate', { account: 'a', id: 'defs', operations: [{ kind: 'actions', name: 'ping', value: { url: 'https://example.com' } }, { kind: 'jobs', name: 'j', value: { action: 'ping', cron: '* * * * *', ...job } }] });
  await call('sync-jobs');
  return { env, messages, call, job: env.JOBS.get('a:j') };
}
it('reserves and separately charges each immediate retry', async () => {
  const { env, messages, call } = await setup({ retries: 2 });
  await rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: {}, trigger: 'manual' });
  for (let index = 0; index < 3; index++) await consume({ body: messages[index], ack() {} }, env, {});
  expect(messages).toHaveLength(3);
  const runs = (await rpc(env.JOBS, 'a:j', 'runs')).items;
  expect(runs.every(r => r.status === 'failure' && r.cost_microdollars === 80)).toBe(true);
  expect((await call('account')).held_microdollars).toBe(0);
});
it('pauses a daily budget until the next UTC window', async () => {
  const { env, job } = await setup({ budget: { day: 0 } });
  await expect(rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: {}, trigger: 'schedule' })).rejects.toMatchObject({ code: 'budget_day' });
  const settings = await job.storage.get('settings'); expect(settings.paused).toBe('budget_day'); expect(settings.resume_at).toBeGreaterThan(Date.now());
  expect(new Date(settings.resume_at).toISOString()).toMatch(/T00:00:00.000Z$/);
});
it('a capped run key cannot pause a schedule it has no change authority over', async () => {
  const { env, call, job } = await setup();
  await call('create-key', { id: 'k', hash: 'hash', request_hash: 'x', name: 'capped', scopes: ['run'], daily_spend_microdollars: 0, expires_at: Date.now() + 86400000 });
  await expect(rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: {}, trigger: 'manual', key_id: 'k' })).rejects.toMatchObject({ code: 'key_budget_day' });
  expect((await job.storage.get('settings')).paused).toBe(null);
});
it('skips missed runs or runs once, and deduplicates repeated alarm delivery', async () => {
  const { env, messages, job } = await setup({ missed: 'run_once' });
  const settings = await job.storage.get('settings'); settings.next_fire = Date.now() - 300000; await job.storage.put('settings', settings);
  await job.alarm(); expect(messages).toHaveLength(1); await job.alarm(); expect(messages).toHaveLength(1);
  const skipped = await setup({ missed: 'skip' }); const s = await skipped.job.storage.get('settings'); s.next_fire = Date.now() - 300000; await skipped.job.storage.put('settings', s);
  await skipped.job.alarm(); expect(skipped.messages).toHaveLength(0); expect(env).toBeDefined();
});
it('prunes expired and excess logs while preserving recent history', async () => {
  const { job } = await setup();
  for (let i = 0; i < 1005; i++) { const run = { id: String(i), created_at: Date.now() - i, status: 'success' }; await job.storage.put(`run:${i}`, run); await job.history(run); }
  const old = { id: 'old', created_at: Date.now() - 31 * 86400000, status: 'success' }; await job.storage.put('run:old', old); await job.history(old);
  await job.prune(); expect((await job.storage.list({ prefix: 'run:' })).size).toBe(1000); expect(await job.storage.get('run:old')).toBeUndefined();
});
it('keeps the total redacted log within the paid byte limit', async () => {
  const { boundLog } = await import('../executor/logs.js'); const result = boundLog({ status: 'success', console: '😀'.repeat(8000), return_value: '\\'.repeat(8000) });
  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(15000); expect(result.truncated).toBe(true);
});

it('leaves an unchanged alarm and runtime alone, and clears the final alarm once', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const { env, job } = await setup();
  const setAlarm = vi.spyOn(job.storage, 'setAlarm');
  await job.arm(); await job.arm(); expect(setAlarm).not.toHaveBeenCalled();
  const accountPut = vi.spyOn(env.ACCOUNTS.get('a').storage, 'put');
  await job.publish(await job.storage.get('settings')); expect(accountPut).not.toHaveBeenCalled();
  const settings = await job.storage.get('settings'); settings.job.enabled = false;
  await job.storage.put('settings', settings);
  const deleteAlarm = vi.spyOn(job.storage, 'deleteAlarm');
  await job.arm(); await job.arm(); expect(deleteAlarm).toHaveBeenCalledTimes(1);
});

it('recovers a failed queue send from its prepaid outbox without another hold', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const { env, job, messages, call } = await setup();
  const send = env.RUN_QUEUE.send;
  env.RUN_QUEUE.send = vi.fn().mockRejectedValueOnce(new Error('queue unavailable')).mockImplementation(send);
  await expect(rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: {}, trigger: 'manual' })).rejects.toThrow();
  expect((await call('account')).held_microdollars).toBe(80);
  expect(job.storage.alarm).toBe(Date.now() + 1000);
  await vi.advanceTimersByTimeAsync(1000); await job.alarm();
  expect(messages).toHaveLength(1);
  await consume({ body: messages[0], ack() {} }, env, {});
  await job.alarm(); expect(messages).toHaveLength(1);
  expect(await call('account')).toMatchObject({ held_microdollars: 0 });
  expect((await job.storage.get('run:r')).cost_microdollars).toBe(80);
});

it('keeps an expired outcome when the same alarm advances the schedule', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const { env, job, call } = await setup();
  await rpc(env.JOBS, 'a:j', 'start', { id: 'old', input: {}, trigger: 'manual' });
  await vi.advanceTimersByTimeAsync(180000);
  const settings = await job.storage.get('settings'); settings.next_fire = Date.now();
  await job.storage.put('settings', settings);
  await job.alarm();
  expect((await job.storage.get('settings')).last_outcome).toBe('expired');
  expect((await call('account')).job_runtime.j.last_outcome).toBe('expired');
});
