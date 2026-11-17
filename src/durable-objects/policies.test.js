import { getHold } from './hold-storage.js';
import { PRICES } from '../utils/pricing.js';
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
  expect(runs.every(r => r.status === 'failure' && r.cost_microdollars === PRICES.run)).toBe(true);
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
  expect((await call('account')).held_microdollars).toBe(PRICES.run);
  expect(job.storage.alarm).toBe(Date.now() + 1000);
  await vi.advanceTimersByTimeAsync(1000); await job.alarm();
  expect(messages).toHaveLength(1);
  await consume({ body: messages[0], ack() {} }, env, {});
  await job.alarm(); expect(messages).toHaveLength(1);
  expect(await call('account')).toMatchObject({ held_microdollars: 0 });
  expect((await job.readRun('r')).cost_microdollars).toBe(PRICES.run);
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

it('restores a compact pending run after a cold restart without exposing its outbox', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const { env, job, messages, call } = await setup();
  const send = env.RUN_QUEUE.send;
  env.RUN_QUEUE.send = vi.fn().mockRejectedValueOnce(new Error('queue unavailable')).mockImplementation(send);
  await expect(rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: {}, trigger: 'manual' })).rejects.toThrow();
  expect(await job.storage.get('run:r')).toBeUndefined();
  const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
  env.JOBS.objects.set('a:j', cold);
  expect(await rpc(env.JOBS, 'a:j', 'run', { id: 'r' })).toMatchObject({ id: 'r', status: 'queued', reserved_microdollars: PRICES.run, expires_at: Date.now() + 120000 });
  const summary = (await rpc(env.JOBS, 'a:j', 'runs', { summary: true })).items[0];
  expect(summary).not.toHaveProperty('pending'); expect(summary).not.toHaveProperty('key_id');
  await vi.advanceTimersByTimeAsync(1000); await cold.alarm();
  expect(messages).toHaveLength(1);
  expect(await rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: {}, trigger: 'manual' })).toMatchObject({ duplicate: true });
  expect(messages).toHaveLength(1);
  await consume({ body: messages[0], ack() {} }, env, {});
  expect((await rpc(env.JOBS, 'a:j', 'run', { id: 'r' })).status).toBe('failure');
  expect(await call('account')).toMatchObject({ held_microdollars: 0 });
});

it('recovers a legacy outbox with metadata in a separate run row', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const { env, job, messages } = await setup();
  await rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: {}, trigger: 'manual' });
  const { pending, ...summary } = await job.storage.get('history:r');
  await job.storage.put('run:r', { ...summary, ...pending, enqueued: false });
  await job.storage.put('history:r', summary); messages.length = 0;
  const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
  env.JOBS.objects.set('a:j', cold);
  await cold.alarm(); expect(messages).toHaveLength(1);
  // The compact row supersedes the old body's stale enqueue flag.
  await cold.alarm(); expect(messages).toHaveLength(1);
  await consume({ body: messages[0], ack() {} }, env, {});
  expect((await job.readRun('r')).status).toBe('failure');
});

it('rolls back final metadata and retries settlement once without rewriting the staged log', async () => {
  const { env, job, call } = await setup();
  await rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: {}, trigger: 'manual' });
  const before = (await call('account')).balance_microdollars;
  const put = job.storage.put.bind(job.storage);
  const spy = vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
    if (key === 'history:r' && value.status === 'success') throw new Error('index failure');
    return put(key, value);
  });
  const args = { id: 'r', result: { status: 'success', response_body: 'ok' } };
  await expect(job.result(args)).rejects.toThrow('index failure');
  expect(await job.storage.get('run:r')).toMatchObject({ status: 'queued', completion: args.result });
  expect((await job.summaries())[0].status).toBe('queued');
  spy.mockRestore();
  await job.result(args);
  expect((await job.readRun('r')).response_body).toBe('ok');
  expect((await job.summaries())[0].status).toBe('success');
  expect((await call('account')).balance_microdollars).toBe(before - PRICES.run);
});

it('preserves retry input privately across settlement and a failed completion commit', async () => {
  const { env, job, messages, call } = await setup({ retries: 1 });
  await call('mutate', { account: 'a', id: 'input-action', operations: [{ kind: 'actions', name: 'ping', value: { url: 'https://example.com', headers: { 'X-Event': '{{input.event}}' } } }] });
  await rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: { event: 'private-event' }, trigger: 'webhook' });
  for (const options of [{}, { summary: true }]) expect(JSON.stringify(await rpc(env.JOBS, 'a:j', 'runs', options))).not.toContain('private-event');
  expect(JSON.stringify(await rpc(env.JOBS, 'a:j', 'run', { id: 'r' }))).not.toContain('private-event');
  const put = job.storage.put.bind(job.storage);
  const failure = vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
    if (key === 'history:r' && value.status === 'failure') throw new Error('completion failure');
    return put(key, value);
  });
  const args = { id: 'r', result: { status: 'failure' } };
  await expect(job.result(args)).rejects.toThrow('completion failure');
  expect(await getHold(env.ACCOUNTS.get('a').storage, 'r')).toBeUndefined();
  failure.mockRestore();
  const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
  env.JOBS.objects.set('a:j', cold);
  await cold.result(args);
  expect(messages).toHaveLength(2);
  expect((await getHold(env.ACCOUNTS.get('a').storage, 'r:retry')).execution.input).toEqual({ event: 'private-event' });
  expect(await job.storage.get('history:r')).not.toHaveProperty('retry');
  env.OUTBOUND_FETCH = vi.fn(async () => new Response('ok'));
  await consume({ body: messages[1], ack() {} }, env, {});
  expect(env.OUTBOUND_FETCH.mock.calls[0][0].headers.get('X-Event')).toBe('private-event');
  expect((await call('account')).held_microdollars).toBe(0);
});

for (const cap of ['job', 'key']) {
  it(`clears an unfunded retry outbox when its ${cap} budget refuses the next attempt`, async () => {
    const { env, job, messages, call } = await setup({ retries: 1, ...(cap === 'job' ? { budget: { day: PRICES.run } } : {}) });
    if (cap === 'key') await call('create-key', { id: 'k', hash: 'hash', request_hash: 'k', name: 'capped', scopes: ['run'], daily_spend_microdollars: PRICES.run, expires_at: Date.now() + 86400000 });
    await rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: {}, trigger: 'manual', ...(cap === 'key' ? { key_id: 'k' } : {}) });
    await consume({ body: messages[0], ack() {} }, env, {});
    expect(messages).toHaveLength(1);
    expect(await job.storage.get('history:r')).not.toHaveProperty('retry');
    expect((await job.storage.get('settings')).paused).toBe(cap === 'job' ? 'budget_day' : null);
    expect((await call('account')).held_microdollars).toBe(0);
    await rpc(env.JOBS, 'a:j', 'recover-result', { id: 'r' });
    expect(messages).toHaveLength(1);
  });
}

it('skips unchanged completion settings and commits a changed outcome with its log', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const { env, job, call } = await setup();
  await rpc(env.JOBS, 'a:j', 'start', { id: 'first', input: {}, trigger: 'manual' });
  await job.result({ id: 'first', result: { status: 'success' } });
  await vi.advanceTimersByTimeAsync(60000);
  await rpc(env.JOBS, 'a:j', 'start', { id: 'second', input: {}, trigger: 'manual' });
  const put = vi.spyOn(job.storage, 'put');
  await job.result({ id: 'second', result: { status: 'success' } });
  expect(put.mock.calls.some(([key]) => key === 'settings')).toBe(false);
  put.mockRestore();
  await vi.advanceTimersByTimeAsync(60000);
  await rpc(env.JOBS, 'a:j', 'start', { id: 'third', input: {}, trigger: 'manual' });
  const original = job.storage.put.bind(job.storage);
  const failure = vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
    if (key === 'settings') throw new Error('settings failure');
    return original(key, value);
  });
  const args = { id: 'third', result: { status: 'failure' } };
  await expect(job.result(args)).rejects.toThrow('settings failure');
  expect(await job.storage.get('run:third')).toMatchObject({ status: 'queued', completion: args.result });
  expect((await job.summaries()).find(r => r.id === 'third').status).toBe('queued');
  expect((await job.storage.get('settings')).last_outcome).toBe('success');
  failure.mockRestore();
  const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
  await cold.result(args);
  expect((await cold.storage.get('settings')).last_outcome).toBe('failure');
  expect((await call('account')).job_runtime.j.last_outcome).toBe('failure');
  const ledger = (await call('list', { prefix: 'ledger:' })).items;
  expect(ledger.filter(row => row.id === 'third')).toHaveLength(1);
});

it('recovers a lost atomic settlement response after restart without billing again', async () => {
  const { env, job, call } = await setup();
  await rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: {}, trigger: 'manual' });
  const object = env.ACCOUNTS.get('a'); const fetch = object.fetch.bind(object);
  const publication = vi.spyOn(object, 'fetch').mockImplementation(async request => {
    const { op } = await request.clone().json(); const response = await fetch(request);
    if (op === 'settle' && response.ok) throw new Error('settlement response lost');
    return response;
  });
  const args = { id: 'r', result: { status: 'success' } };
  await expect(job.result(args)).rejects.toThrow('settlement response lost');
  expect((await job.readRun('r')).status).toBe('queued');
  expect((await call('account')).job_runtime.j.last_outcome).toBe('success');
  publication.mockRestore();
  const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
  const balance = (await call('account')).balance_microdollars;
  expect(await cold.result(args)).toMatchObject({ status: 'success', cost_microdollars: PRICES.run });
  expect((await call('account')).job_runtime.j.last_outcome).toBe('success');
  expect((await call('account')).balance_microdollars).toBe(balance);
  expect(await cold.result(args)).toEqual({ duplicate: true });
  expect((await call('list', { prefix: 'ledger:' })).items.filter(row => row.id === 'r')).toHaveLength(1);
});

it('finalizes a staged log once and overlays authoritative billing after restart', async () => {
  const { env, job, call } = await setup();
  await rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: {}, trigger: 'manual' });
  const put = vi.spyOn(job.storage, 'put');
  // Billing clamps to the original maximum, even if a reported charge is higher.
  const outcome = { status: 'success', response_excerpt: 'retained output', subrequests: 6, charge_microdollars: PRICES.run + 100 };
  const result = await job.result({ id: 'r', result: outcome });
  expect(result).toMatchObject({ status: 'success', cost_microdollars: PRICES.run, subrequests: 6 });
  expect(put.mock.calls.filter(([key]) => key === 'run:r')).toHaveLength(1);
  const staged = await job.storage.get('run:r');
  expect(staged).toMatchObject({ status: 'queued', completion: outcome });
  const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
  const record = await cold.readRun('r');
  expect(record).toEqual(result);
  for (const options of [{}, { summary: true }]) {
    const items = (await cold.dispatch({ op: 'runs', ...options })).items;
    expect(items[0]).toMatchObject({ status: 'success', cost_microdollars: PRICES.run });
    for (const field of ['completion', 'settlement', 'pending', 'retry', 'key_id', 'input']) expect(items[0]).not.toHaveProperty(field);
  }
  await cold.result({ id: 'r', result: { status: 'failure' } });
  expect(await job.storage.get('run:r')).toEqual(staged);
  expect((await call('list', { prefix: 'ledger:' })).items.filter(row => row.id === 'r')).toHaveLength(1);
});

it('reads legacy completed bodies beside finalized staged logs', async () => {
  const { job } = await setup();
  const legacy = { id: 'legacy', job: 'j', status: 'success', created_at: Date.now() - 1000, cost_microdollars: 60, subrequests: 3, response_excerpt: 'old output' };
  await job.storage.put('run:legacy', legacy); await job.history(legacy);
  const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, job.env);
  expect(await cold.readRun('legacy')).toEqual(legacy);
  expect((await cold.dispatch({ op: 'runs' })).items).toEqual([legacy]);
});

it('does not bill before the observed result is durable', async () => {
  const { env, job, call, messages } = await setup();
  await rpc(env.JOBS, 'a:j', 'start', { id: 'r', input: {}, trigger: 'manual' });
  const before = await call('account');
  const original = job.storage.put.bind(job.storage);
  const fault = vi.spyOn(job.storage, 'put').mockImplementation(async (key, value) => {
    if (key === 'run:r') throw new Error('log unavailable');
    return original(key, value);
  });
  await expect(consume({ body: messages[0], ack() {} }, env, {})).rejects.toMatchObject({ status: 500 });
  expect(await job.storage.get('run:r')).toBeUndefined();
  expect(await call('account')).toMatchObject({ balance_microdollars: before.balance_microdollars, held_microdollars: PRICES.run });
  fault.mockRestore();
  // An unrecorded external outcome remains uncertain; expiry charges the hold.
  await job.result({ id: 'r', result: { status: 'expired' } });
  expect(await job.readRun('r')).toMatchObject({ status: 'expired', cost_microdollars: PRICES.run });
});

it('uses settled gateway counts and discounted activation in finalized JS logs', async () => {
  const { env, job, call } = await setup();
  await call('mutate', { account: 'a', id: 'js', operations: [{ kind: 'actions', name: 'ping', value: { type: 'javascript', source: 'export default () => 1', cpu_ms: 10, subrequests: 2 } }] });
  const charges = [];
  for (const id of ['first-js', 'second-js']) {
    await rpc(env.JOBS, 'a:j', 'start', { id, input: {}, trigger: 'manual', retry: true });
    const execution = await call('claim-run', { id });
    await call('gateway-request', { id, host: 'example.com' });
    const result = await job.result({ id, result: { status: 'success', return_value: '1', subrequests: 99 } });
    const cold = new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env);
    expect(await cold.readRun(id)).toEqual(result);
    expect(result).toMatchObject({ subrequests: 1, cost_microdollars: execution.actual_price });
    charges.push(result.cost_microdollars);
  }
  expect(charges[0] - charges[1]).toBe(PRICES.jsActivation);
});
