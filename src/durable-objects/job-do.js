import { assert, errorResponse } from '../utils/errors.js';
import { rpc } from '../utils/rpc.js';
import { price } from '../utils/pricing.js';
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
        await this.storage.put('settings', settings); await this.publish(settings); await this.arm(); return settings;
      }
      case 'triggers': return { items: [...(await this.storage.list({ prefix: 'trigger:' })).values()].map(({ id, rate, revoked }) => ({ id, rate_per_minute: rate, revoked })) };
      case 'change-trigger': {
        const settings = await this.storage.get('settings'); assert(settings?.job, 'not_found', 'Job not found', 404);
        const prior = await this.storage.get(`trigger:${args.id}`);
        if (args.revoke) assert(prior, 'not_found', 'Trigger not found', 404);
        else assert(!prior || prior.rate === args.rate, 'idempotency_conflict', 'Trigger id already used', 409);
        assert(prior || (await this.storage.list({ prefix: 'trigger:' })).size < 100, 'trigger_limit', 'Maximum 100 triggers per job');
        const result = await rpc(this.env.ACCOUNTS, settings.account, 'bill-change', { id: `trigger:${settings.name}:${args.id}:${args.revoke ? 'revoke' : 'create'}`, key_id: args.key_id, dry_run: args.dry_run });
        if (!args.dry_run) await this.storage.put(`trigger:${args.id}`, { id: args.id, rate: args.rate, revoked: args.revoke || prior?.revoked || false });
        return { ...result, id: args.id };
      }
      case 'hook': {
        const settings = await this.storage.get('settings'); const trigger = await this.storage.get(`trigger:${args.token_id}`);
        assert(settings?.job && trigger && !trigger.revoked, 'invalid_trigger', 'Invalid trigger token', 401);
        if (args.dry_run) { const config = await rpc(this.env.ACCOUNTS, settings.account, 'config'); return { quote_microdollars: price('hook', config.actions[settings.job.action]), cost_microdollars: 0 }; }
        let bucket = await this.storage.get(`trigger-rate:${args.token_id}`); const now = Date.now();
        if (!bucket || bucket.reset <= now) bucket = { count: 0, reset: now + 60000 };
        assert(bucket.count < trigger.rate, 'rate_limited', 'Trigger rate exceeded', 429);
        bucket.count++; await this.storage.put(`trigger-rate:${args.token_id}`, bucket);
        return this.start({ ...args, trigger: 'webhook', scheduled_at: new Date().toISOString() });
      }
      case 'status': return await this.storage.get('settings') || {};
      case 'start': return this.start(args);
      case 'result': return this.result(args);
      case 'wake': {
        const settings = await this.storage.get('settings'); if (!settings?.job) return {};
        if (settings.paused === 'insufficient_balance' || args.force) { settings.paused = null; await this.storage.put('settings', settings); await this.reconcile(); }
        return {};
      }
      case 'runs': {
        const limit = Math.min(args.limit || 100, 100); const before = args.before || Infinity;
        const entries = (await this.summaries()).filter(r => r.created_at < before && (!args.status || r.status === args.status) && (!args.from || r.created_at >= args.from) && (!args.to || r.created_at <= args.to)).sort((a, b) => b.created_at - a.created_at);
        const page = entries.slice(0, limit); const items = args.summary ? page : await Promise.all(page.map(r => this.storage.get(`run:${r.id}`)));
        return { items: items.filter(Boolean), next_before: entries.length > limit ? page.at(-1).created_at : null };
      }
      case 'run': return (await this.storage.get(`run:${args.id}`)) || {};
      default: assert(false, 'unknown_operation', 'Unknown job operation', 404);
    }
  }
  async arm() {
    const settings = await this.storage.get('settings');
    const summaries = (await this.summaries());
    const pending = await Promise.all(summaries.filter(r => r.status === 'queued' || r.status === 'running').map(r => this.storage.get(`run:${r.id}`)));
    const timers = pending.map(r => r.enqueued ? r.expires_at : Date.now() + 1000);
    if (settings?.job?.enabled && !settings.paused && settings.next_fire) timers.push(settings.next_fire);
    if (settings?.resume_at) timers.push(settings.resume_at);
    // Once disabled, old logs get one final cleanup alarm, then hibernate indefinitely.
    const records = summaries;
    if (records.length) timers.push(Math.min(...records.map(r => r.created_at + 30 * DAY)));
    const alarm = await this.storage.getAlarm();
    if (timers.length) {
      const next = Math.max(Date.now() + 1000, Math.min(...timers));
      if (alarm !== next) await this.storage.setAlarm(next);
    } else if (alarm !== null) await this.storage.deleteAlarm();
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
    if (this.env.SAFETY) { const safety = await rpc(this.env.SAFETY, 'global', 'status'); if (safety.brake) { const settings = await this.storage.get('settings'); if (settings) { settings.paused = 'cost_brake'; await this.storage.put('settings', settings); await this.arm(); } assert(false, 'cost_brake', 'Runs are paused pending cost reconciliation', 503); } }
    const settings = await this.storage.get('settings'); assert(settings?.job, 'not_found', 'Job not found', 404);
    const prior = await this.storage.get(`run:${args.id}`); if (prior) return { run: prior, duplicate: true, cost_microdollars: 0 };
    let reservation;
    try {
      reservation = await rpc(this.env.ACCOUNTS, settings.account, 'prepare-run', { ...args, name: settings.name, account: settings.account, test_action: settings.job.test_action });
    } catch (error) {
      if (error.status === 402 && ['insufficient_balance', 'budget_day', 'budget_month'].includes(error.code)) {
        settings.paused = error.code;
        if (error.code === 'budget_day') settings.resume_at = Date.parse(new Date(Date.now() + DAY).toISOString().slice(0, 10));
        if (error.code === 'budget_month') { const date = new Date(); settings.resume_at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1); }
        await this.storage.put('settings', settings); await this.publish(settings);
        const pausedRun = { id: args.id, status: 'paused', reason: error.code, created_at: Date.now(), cost_microdollars: 0, job: settings.name };
        await this.storage.put(`run:${args.id}`, pausedRun); await this.history(pausedRun);
        await this.arm();
      }
      throw error;
    }
    if (reservation.duplicate && reservation.settled) return { id: args.id, duplicate: true, cost_microdollars: 0 };
    const run = { id: args.id, job: settings.name, trigger: args.trigger, scheduled_at: args.scheduled_at, created_at: Date.now(), expires_at: Date.now() + 120000, status: 'queued', reserved_microdollars: reservation.amount, attempt: args.attempt || 0, key_id: args.key_id };
    await this.storage.put(`run:${args.id}`, run); await this.history(run);
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
    const retryData = args.result.status === 'failure' && run.attempt < (settings.job?.retries || 0) ? await rpc(this.env.ACCOUNTS, settings.account, 'retry-data', { id: args.id }) : {};
    const receipt = await rpc(this.env.ACCOUNTS, settings.account, 'settle', { id: args.id, actual: args.result.charge_microdollars ?? run.reserved_microdollars });
    const result = { ...run, ...args.result, id: run.id, job: run.job, cost_microdollars: receipt.charged, subrequests: receipt.gateway_count ?? args.result.subrequests ?? 0, finished_at: Date.now() };
    delete result.input; delete result.key_id;
    await this.storage.put(`run:${args.id}`, result); await this.history(result);
    settings.last_outcome = result.status; await this.storage.put('settings', settings); await this.publish(settings);
    if (result.status === 'failure' && run.attempt < (settings.job?.retries || 0)) {
      try { await this.start({ id: `${args.id}:retry`, trigger: run.trigger, scheduled_at: run.scheduled_at, input: retryData.input || {}, key_id: run.key_id, retry: true, attempt: run.attempt + 1 }); }
      catch { /* Refusal has paused the job or capped the retry; never retry unfunded work. */ }
    }
    await this.prune(); await this.arm(); return result;
  }
  async summaries() {
    if (!this.historyCache) this.historyCache = [...(await this.storage.list({ prefix: 'history:' })).values()];
    return this.historyCache;
  }
  async history(run) {
    const { id, job, status, created_at, trigger, scheduled_at, finished_at, cost_microdollars, http_status, reason } = run;
    const summary = { id, job, status, created_at, trigger, scheduled_at, finished_at, cost_microdollars, http_status, reason };
    await this.storage.put(`history:${id}`, summary);
    if (this.historyCache) this.historyCache = [summary, ...this.historyCache.filter(r => r.id !== id)];
  }
  async publish(settings) {
    await rpc(this.env.ACCOUNTS, settings.account, 'job-runtime', { name: settings.name, runtime: { next_fire: settings.next_fire, paused: settings.paused, last_outcome: settings.last_outcome || null } });
  }
  async prune() {
    const records = (await this.summaries()).map(r => [`history:${r.id}`, r]).sort(([, a], [, b]) => b.created_at - a.created_at);
    for (const [index, [key, run]] of records.entries()) if (index >= 1000 || run.created_at < Date.now() - 30 * DAY) { await this.storage.delete(`run:${run.id}`); await this.storage.delete(key); this.historyCache = this.historyCache.filter(r => r.id !== run.id); }
  }
  async alarm() {
    return this.ctx.blockConcurrencyWhile(async () => {
      let settings = await this.storage.get('settings'); if (!settings) return;
      const pending = await Promise.all((await this.summaries()).filter(r => ['queued', 'running'].includes(r.status)).map(r => this.storage.get(`run:${r.id}`)));
      for (const run of pending.filter(Boolean)) {
        if (!['queued', 'running'].includes(run.status)) continue;
        if (run.expires_at <= Date.now()) await this.result({ id: run.id, result: { status: 'expired', error: 'Result was not received before the deadline' } });
        else if (!run.enqueued) await this.send(run, settings);
      }
      // Expiry reporting can update the outcome or pause a refused retry.
      settings = await this.storage.get('settings');
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
        await this.storage.put('settings', settings); await this.publish(settings);
      }
      await this.prune(); await this.arm();
    });
  }
}
