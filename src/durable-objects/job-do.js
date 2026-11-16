import { assert, errorResponse } from '../utils/errors.js';
import { rpc } from '../utils/rpc.js';
import { nextFires } from '../services/cron.js';

const DAY = 86400000;
/** Per-job alarm and run log. Never waits for customer HTTP inside the DO. */
export class JobDO {
  constructor(ctx, env) { this.ctx = ctx; this.storage = ctx.storage; this.env = env; }
  async fetch(request) {
    try {
      const args = await request.json();
      // Serialize short orchestration turns, including queue dispatch and outbox completion.
      const result = await this.ctx.blockConcurrencyWhile(() => this.dispatch(args));
      return Response.json(result ?? {});
    } catch (error) { return errorResponse(error); }
  }
  async dispatch(args) {
    switch (args.op) {
      case 'configure': {
        const prior = await this.storage.get('settings');
        const settings = { account: args.account, name: args.name, job: args.job, paused: null };
        settings.next_fire = args.job?.enabled && args.job.cron ? (prior?.job?.cron === args.job.cron && prior?.job?.timezone === args.job.timezone && prior.next_fire > Date.now() ? prior.next_fire : Date.parse(nextFires(args.job.cron, args.job.timezone, 1)[0])) : null;
        await this.storage.put('settings', settings); await this.arm(); return settings;
      }
      case 'status': return await this.storage.get('settings') || {};
      case 'start': return this.start(args);
      case 'result': return this.result(args);
      case 'wake': {
        const settings = await this.storage.get('settings'); if (!settings?.job) return {};
        if (settings.paused === 'insufficient_balance' || args.force) { settings.paused = null; await this.storage.put('settings', settings); await this.reconcile(); }
        return {};
      }
      case 'runs': return { items: [...(await this.storage.list({ prefix: 'run:', reverse: true, limit: 1000 })).values()].sort((a, b) => b.created_at - a.created_at) };
      case 'run': return (await this.storage.get(`run:${args.id}`)) || {};
      default: assert(false, 'unknown_operation', 'Unknown job operation', 404);
    }
  }
  async arm() {
    const settings = await this.storage.get('settings');
    const pending = [...(await this.storage.list({ prefix: 'run:' })).values()].filter(r => r.status === 'queued' || r.status === 'running');
    const timers = pending.map(r => r.enqueued ? r.expires_at : Date.now() + 1000);
    if (settings?.job?.enabled && !settings.paused && settings.next_fire) timers.push(settings.next_fire);
    if (settings?.resume_at) timers.push(settings.resume_at);
    // Once disabled, old logs get one final cleanup alarm, then hibernate indefinitely.
    const records = [...(await this.storage.list({ prefix: 'run:' })).values()];
    if (records.length) timers.push(Math.min(...records.map(r => r.created_at + 30 * DAY)));
    if (timers.length) await this.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(...timers)));
    else await this.storage.deleteAlarm();
  }
  async reconcile() {
    const settings = await this.storage.get('settings'); if (!settings) return;
    const config = await rpc(this.env.ACCOUNTS, settings.account, 'config');
    settings.job = config.jobs[settings.name] || null;
    if (!settings.job) { settings.next_fire = null; settings.paused = 'deleted'; }
    if (settings.job?.enabled && settings.job.cron && !settings.paused) settings.next_fire = Date.parse(nextFires(settings.job.cron, settings.job.timezone, 1)[0]);
    await this.storage.put('settings', settings); await this.arm();
  }
  async start(args) {
    assert(this.env.COST_SAFETY_HARD_STOP !== 'true', 'cost_brake', 'Runs are paused by the operator', 503);
    const settings = await this.storage.get('settings'); assert(settings?.job, 'not_found', 'Job not found', 404);
    const prior = await this.storage.get(`run:${args.id}`); if (prior) return { run: prior, duplicate: true, cost_microdollars: 0 };
    let reservation;
    try {
      reservation = await rpc(this.env.ACCOUNTS, settings.account, 'prepare-run', { ...args, name: settings.name });
    } catch (error) {
      if (error.status === 402) {
        settings.paused = error.code;
        if (error.code === 'budget_day') settings.resume_at = Date.parse(new Date(Date.now() + DAY).toISOString().slice(0, 10));
        if (error.code === 'budget_month') { const date = new Date(); settings.resume_at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1); }
        await this.storage.put('settings', settings);
        await this.storage.put(`run:${args.id}`, { id: args.id, status: 'paused', reason: error.code, created_at: Date.now(), cost_microdollars: 0, job: settings.name });
        await this.arm();
      }
      throw error;
    }
    if (reservation.duplicate) return { id: args.id, duplicate: true, cost_microdollars: 0 };
    const run = { id: args.id, job: settings.name, trigger: args.trigger, scheduled_at: args.scheduled_at, created_at: Date.now(), expires_at: Date.now() + 120000, status: 'queued', reserved_microdollars: reservation.amount, attempt: args.attempt || 0, input: args.input, key_id: args.key_id };
    await this.storage.put(`run:${args.id}`, run);
    // A failed enqueue is retried from the durable pending row, without a second hold.
    await this.arm();
    await this.send(run, settings);
    await this.arm(); return { run, cost_microdollars: 0, reserved_microdollars: reservation.amount };
  }
  async send(run, settings) {
    await this.env.RUN_QUEUE.send({ account: settings.account, name: settings.name, id: run.id });
    await this.storage.put(`run:${run.id}`, { ...run, enqueued: true });
  }
  async result(args) {
    const run = await this.storage.get(`run:${args.id}`); assert(run, 'not_found', 'Run not found', 404);
    if (run.status === 'success' || run.status === 'failure' || run.status === 'expired') return { duplicate: true };
    const settings = await this.storage.get('settings');
    const receipt = await rpc(this.env.ACCOUNTS, settings.account, 'settle', { id: args.id, actual: run.reserved_microdollars });
    const result = { ...run, ...args.result, id: run.id, job: run.job, cost_microdollars: receipt.charged, finished_at: Date.now() };
    delete result.input; delete result.key_id;
    await this.storage.put(`run:${args.id}`, result);
    if (result.status === 'failure' && run.attempt < (settings.job?.retries || 0)) {
      try { await this.start({ id: `${args.id}:retry`, trigger: run.trigger, scheduled_at: run.scheduled_at, input: run.input, key_id: run.key_id, retry: true, attempt: run.attempt + 1 }); }
      catch { /* Refusal has paused the job or capped the retry; never retry unfunded work. */ }
    }
    await this.prune(); await this.arm(); return result;
  }
  async prune() {
    const records = [...(await this.storage.list({ prefix: 'run:' }))].sort(([, a], [, b]) => b.created_at - a.created_at);
    for (const [index, [key, run]] of records.entries()) if (index >= 1000 || run.created_at < Date.now() - 30 * DAY) await this.storage.delete(key);
  }
  async alarm() {
    return this.ctx.blockConcurrencyWhile(async () => {
      let settings = await this.storage.get('settings'); if (!settings) return;
      for (const run of (await this.storage.list({ prefix: 'run:' })).values()) {
        if (!['queued', 'running'].includes(run.status)) continue;
        if (run.expires_at <= Date.now()) await this.result({ id: run.id, result: { status: 'expired', error: 'Result was not received before the deadline' } });
        else if (!run.enqueued) await this.send(run, settings);
      }
      if (settings.resume_at && settings.resume_at <= Date.now()) { settings.paused = null; settings.resume_at = null; await this.storage.put('settings', settings); }
      const due = settings.next_fire;
      if (!settings.paused && settings.job?.enabled && due && due <= Date.now()) {
        // Persist advancement after reserving/enqueuing; deterministic IDs survive alarm retries.
        const late = Date.now() - due > 60000;
        if (!late || settings.job.missed === 'run_once') {
          try { await this.start({ id: `${settings.account}:${settings.name}:${due}`, trigger: 'schedule', scheduled_at: new Date(due).toISOString(), input: {} }); }
          catch (error) { if (![402, 409, 429, 503].includes(error.status)) throw error; }
        }
        settings = await this.storage.get('settings');
        if (!settings.paused) settings.next_fire = Date.parse(nextFires(settings.job.cron, settings.job.timezone, 1)[0]);
        await this.storage.put('settings', settings);
      }
      await this.prune(); await this.arm();
    });
  }
}
