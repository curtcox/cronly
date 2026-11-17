import { assert, errorResponse } from '../utils/errors.js';
import { rpc } from '../utils/rpc.js';
import { price } from '../utils/pricing.js';
import { nextFires } from '../services/cron.js';
import { compareRuns, runCursor, parseRunCursor } from '../services/run-pagination.js';

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
        const settings = { account: args.account, name: args.name, job: args.job, paused: null, ...(prior?.last_outcome ? { last_outcome: prior.last_outcome } : {}) };
        settings.next_fire = args.job?.enabled && args.job.cron ? (prior?.job?.cron === args.job.cron && prior?.job?.timezone === args.job.timezone && prior.next_fire > Date.now() ? prior.next_fire : Date.parse(nextFires(args.job.cron, args.job.timezone, 1)[0])) : null;
        if (JSON.stringify(prior) !== JSON.stringify(settings)) await this.storage.put('settings', settings);
        await this.publish(settings); await this.arm(); return settings;
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
      case 'recover-result': {
        const run = await this.readRun(args.id);
        const staged = await this.storage.get(`run:${args.id}`);
        if (run && (staged?.completion || ['success', 'failure', 'expired'].includes(run.status))) return this.result({ id: args.id });
        return {};
      }
      case 'wake': {
        const settings = await this.storage.get('settings'); if (!settings?.job) return {};
        if (settings.paused === 'insufficient_balance' || args.force) await this.reconcile();
        else await this.publish(settings);
        return {};
      }
      case 'runs': {
        const limit = Math.min(args.limit || 100, 100); const before = args.before || Infinity;
        const cursor = parseRunCursor(args.cursor);
        const entries = (await this.summaries()).filter(r => r.created_at < before && (!cursor || compareRuns(r, cursor) > 0) && (!args.status || r.status === args.status) && (!args.from || r.created_at >= args.from) && (!args.to || r.created_at <= args.to)).sort(compareRuns);
        const page = entries.slice(0, limit); const items = args.summary ? page.map(({ pending: _pending, retry: _retry, settlement: _settlement, ...summary }) => summary) : await Promise.all(page.map(r => this.record(r)));
        return { items: items.filter(Boolean), next_before: entries.length > limit ? page.at(-1).created_at : null, next_cursor: entries.length > limit ? runCursor(page.at(-1)) : null };
      }
      case 'run': return (await this.readRun(args.id)) || {};
      default: assert(false, 'unknown_operation', 'Unknown job operation', 404);
    }
  }
  async arm() {
    const settings = await this.storage.get('settings');
    const summaries = (await this.summaries());
    const pending = await Promise.all(summaries.filter(r => r.status === 'queued' || r.status === 'running').map(r => this.record(r)));
    const timers = pending.map(r => r.enqueued ? r.expires_at : Date.now() + 1000);
    if (summaries.some(r => r.retry?.dispatch)) timers.push(Date.now() + 1000);
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
    settings.paused = null; delete settings.resume_at;
    settings.job = Object.hasOwn(config.jobs, settings.name) ? config.jobs[settings.name] : null;
    if (!settings.job) { settings.next_fire = null; settings.paused = 'deleted'; }
    if (settings.job?.enabled && settings.job.cron && !settings.paused) settings.next_fire = Date.parse(nextFires(settings.job.cron, settings.job.timezone, 1)[0]);
    await this.storage.put('settings', settings); await this.publish(settings); await this.arm();
  }
  async start(args, rearm = true) {
    assert(this.env.COST_SAFETY_HARD_STOP !== 'true', 'cost_brake', 'Runs are paused by the operator', 503);
    if (this.env.SAFETY && (await rpc(this.env.SAFETY, 'global', 'status')).brake) {
      const prior = await this.storage.get('settings');
      if (prior) {
        const settings = { ...prior, paused: 'cost_brake' }; delete settings.resume_at;
        if (JSON.stringify(settings) !== JSON.stringify(prior)) await this.storage.put('settings', settings);
        await this.arm(); await this.publish(settings);
      }
      assert(false, 'cost_brake', 'Runs are paused pending cost reconciliation', 503);
    }
    const settings = await this.storage.get('settings'); assert(settings?.job, 'not_found', 'Job not found', 404);
    const prior = await this.readRun(args.id); if (prior) return { run: prior, duplicate: true, cost_microdollars: 0 };
    let reservation;
    try {
      reservation = await rpc(this.env.ACCOUNTS, settings.account, 'prepare-run', { ...args, name: settings.name, account: settings.account, test_action: settings.job.test_action });
    } catch (error) {
      if (error.status === 402 && ['insufficient_balance', 'budget_day', 'budget_month'].includes(error.code)) {
        const prior = JSON.stringify(settings);
        settings.paused = error.code;
        delete settings.resume_at;
        if (error.code === 'budget_day') settings.resume_at = Date.parse(new Date(Date.now() + DAY).toISOString().slice(0, 10));
        if (error.code === 'budget_month') { const date = new Date(); settings.resume_at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1); }
        // One durable log records each pause transition. Repeated unfunded
        // attempts must not keep writing history for an account that cannot pay.
        if (JSON.stringify(settings) !== prior) {
          const pausedRun = { id: args.id, status: 'paused', reason: error.code, created_at: Date.now(), cost_microdollars: 0, job: settings.name };
          await this.history(pausedRun, false, settings);
        }
        await this.arm();
        await this.publish(settings);
      }
      throw error;
    }
    if (reservation.duplicate && reservation.settled) return { id: args.id, duplicate: true, cost_microdollars: 0 };
    const run = { id: args.id, job: settings.name, status: 'queued', reserved_microdollars: reservation.amount, ...reservation.pending };
    await this.history(run, false, null, reservation.retry);
    if (run.expires_at <= Date.now()) {
      const expired = await this.result({ id: run.id, result: { status: 'expired', error: 'Result was not received before the deadline' } });
      return { run: expired, cost_microdollars: 0 };
    }
    // A failed enqueue is retried from the durable pending row, without a second hold.
    await this.send(run, settings);
    // The scheduled alarm advances next_fire and rearms once after dispatch. Its
    // pending outbox already has a durable wakeup if that outer turn fails.
    if (rearm) await this.arm();
    return { run, cost_microdollars: 0, reserved_microdollars: reservation.amount };
  }
  async send(run, settings) {
    await this.env.RUN_QUEUE.send({ account: settings.account, name: settings.name, id: run.id });
    const retry = (await this.storage.get(`history:${run.id}`))?.retry;
    await this.history({ ...run, enqueued: true }, false, null, retry);
  }
  async result(args) {
    const run = await this.readRun(args.id); assert(run, 'not_found', 'Run not found', 404);
    const settings = await this.storage.get('settings');
    if (run.status === 'success' || run.status === 'failure' || run.status === 'expired') {
      // Older completions may still need publication. New completions publish
      // atomically with settlement, including when its response was lost.
      const summary = await this.storage.get(`history:${args.id}`);
      try { if (!summary?.settlement?.runtime_published) await this.publish(settings); }
      finally { await this.dispatchRetry(args.id); }
      return { duplicate: true };
    }
    const staged = await this.storage.get(`run:${args.id}`);
    const outcome = staged?.completion || args.result;
    assert(outcome, 'missing_result', 'Run result is missing', 409);
    // Persist the observed result before settlement can remove its execution hold.
    // Redelivery and the existing pending alarm can now finish the same outcome.
    if (!staged?.completion) await this.storage.put(`run:${args.id}`, { ...run, completion: outcome });
    // Keep new runs' retry input with the pending outbox: settlement removes the
    // account's execution snapshot before this object's completion can commit.
    const shouldRetry = outcome.status === 'failure' && run.attempt < (settings.job?.retries || 0);
    const retryData = shouldRetry ? (await this.storage.get(`history:${args.id}`))?.retry || await rpc(this.env.ACCOUNTS, settings.account, 'retry-data', { id: args.id }) : {};
    const receipt = await rpc(this.env.ACCOUNTS, settings.account, 'settle', { id: args.id, actual: outcome.charge_microdollars ?? run.reserved_microdollars, runtime: this.runtime({ ...settings, last_outcome: outcome.status }) });
    const result = { ...run, ...outcome, id: run.id, job: run.job, cost_microdollars: receipt.charged, subrequests: receipt.gateway_count ?? outcome.subrequests ?? 0, finished_at: Date.now() };
    delete result.input; delete result.key_id;
    const changed = settings.last_outcome !== result.status;
    settings.last_outcome = result.status;
    const retry = shouldRetry ? { dispatch: true, input: retryData.input || {}, key_id: run.key_id, attempt: run.attempt + 1, trigger: run.trigger, scheduled_at: run.scheduled_at } : undefined;
    await this.history(result, true, changed ? settings : null, retry);
    await this.dispatchRetry(args.id);
    await this.prune(); await this.arm(); return result;
  }
  async dispatchRetry(id) {
    const summary = await this.storage.get(`history:${id}`);
    if (!summary?.retry?.dispatch) return;
    const { retry, ...completed } = summary;
    try { await this.start({ ...retry, id: `${id}:retry`, retry: true }); }
    catch (error) {
      // Refusals end this retry. Infrastructure failures retain the outbox for
      // Queue redelivery or the pending run's already-funded recovery alarm.
      if (![402, 403, 404, 409, 429].includes(error.status) && !['cost_brake', 'sandbox_acceptance_required'].includes(error.code)) throw error;
    }
    await this.storage.put(`history:${id}`, completed);
    if (this.historyCache) this.historyCache = this.historyCache.map(r => r.id === id ? completed : r);
  }
  async summaries() {
    if (!this.historyCache) this.historyCache = [...(await this.storage.list({ prefix: 'history:' })).values()];
    return this.historyCache;
  }
  async readRun(id) {
    const summary = await this.storage.get(`history:${id}`);
    return summary ? this.record(summary) : this.storage.get(`run:${id}`);
  }
  async record(summary) {
    const { pending, retry: _retry, settlement, ...publicSummary } = summary;
    // Older pending records kept their full metadata in a separate run row.
    if (pending) return { ...publicSummary, ...pending };
    const { completion, ...body } = (await this.storage.get(`run:${summary.id}`)) || publicSummary;
    // Finalization commits only the compact index. The immutable staged body is
    // already durable before billing; overlay the committed settlement metadata.
    if (settlement && completion) {
      const { input: _input, key_id: _key, ...result } = { ...body, ...completion, ...publicSummary, ...settlement };
      delete result.runtime_published;
      return result;
    }
    return body;
  }
  async history(run, finalized = false, settings = null, retry) {
    const { id, job, status, created_at, trigger, scheduled_at, finished_at, cost_microdollars, http_status, reason } = run;
    const summary = { id, job, status, created_at, trigger, scheduled_at, finished_at, cost_microdollars, http_status, reason };
    if (retry) summary.retry = retry;
    if (finalized) summary.settlement = { subrequests: run.subrequests, runtime_published: true };
    // Pending metadata fits in the compact index; only completed logs need a body row.
    if (status === 'queued' || status === 'running') {
      const { expires_at, reserved_microdollars, attempt, key_id, enqueued } = run;
      summary.pending = { expires_at, reserved_microdollars, attempt, key_id, enqueued };
    }
    const wake = summary.pending && !summary.pending.enqueued;
    if (finalized || wake || settings) await this.storage.transaction(async tx => {
      await tx.put(`history:${id}`, summary);
      if (settings) await tx.put('settings', settings);
      // Pending outboxes and budget pauses commit with their wakeups, so a failed
      // enqueue or restart cannot strand dispatch or the next budget window.
      const next = wake ? Date.now() + 1000 : settings?.resume_at;
      if (next) {
        const alarm = await tx.getAlarm();
        if (alarm === null || alarm > next) await tx.setAlarm(next);
      }
    });
    else await this.storage.put(`history:${id}`, summary);
    if (this.historyCache) this.historyCache = [summary, ...this.historyCache.filter(r => r.id !== id)];
  }
  async publish(settings) {
    await rpc(this.env.ACCOUNTS, settings.account, 'job-runtime', { name: settings.name, runtime: this.runtime(settings) });
  }
  runtime(settings) { return { next_fire: settings.next_fire, paused: settings.paused, last_outcome: settings.last_outcome || null }; }
  async prune() {
    const records = (await this.summaries()).map(r => [`history:${r.id}`, r]).sort(([, a], [, b]) => b.created_at - a.created_at);
    for (const [index, [key, run]] of records.entries()) {
      // These rows are also recovery outboxes. Retention must not discard paid
      // work or a retry that has not yet been reserved, even after a long outage.
      if (['queued', 'running'].includes(run.status) || run.retry?.dispatch) continue;
      if (index < 1000 && run.created_at >= Date.now() - 30 * DAY) continue;
      await this.storage.transaction(async tx => {
        await tx.delete(`run:${run.id}`); await tx.delete(key);
      });
      this.historyCache = this.historyCache.filter(r => r.id !== run.id);
    }
  }
  async alarm() {
    return this.ctx.blockConcurrencyWhile(async () => {
      let settings = await this.storage.get('settings'); if (!settings) return;
      const pending = await Promise.all((await this.summaries()).filter(r => ['queued', 'running'].includes(r.status)).map(r => this.record(r)));
      for (const run of pending.filter(Boolean)) {
        if (!['queued', 'running'].includes(run.status)) continue;
        if (run.expires_at <= Date.now()) await this.result({ id: run.id, result: { status: 'expired', error: 'Result was not received before the deadline' } });
        else if (!run.enqueued) await this.send(run, settings);
      }
      for (const summary of await this.summaries()) if (summary.retry?.dispatch) await this.dispatchRetry(summary.id);
      // Expiry reporting can update the outcome or pause a refused retry.
      settings = await this.storage.get('settings');
      if (settings.resume_at && settings.resume_at <= Date.now()) {
        // Publish first: a failed cross-object update must leave the deadline
        // durable so alarm redelivery can retry the transition.
        const resumed = { ...settings, paused: null, resume_at: null };
        await this.publish(resumed); await this.storage.put('settings', resumed); settings = resumed;
      }
      const due = settings.next_fire;
      if (!settings.paused && settings.job?.enabled && due && due <= Date.now()) {
        // Persist advancement after reserving/enqueuing; deterministic IDs survive alarm retries.
        const late = Date.now() - due > 60000;
        if (!late || settings.job.missed === 'run_once') {
          try { await this.start({ id: `${settings.account}:${settings.name}:${due}`, trigger: 'schedule', scheduled_at: new Date(due).toISOString(), input: {} }, false); }
          catch (error) { if (![402, 409, 429, 503].includes(error.status)) throw error; }
        }
        settings = await this.storage.get('settings');
        // Refusal handling already committed and published any pause. Otherwise
        // publish before advancing durably: the old due time makes a failed
        // publication retryable, including skipped runs with no pending outbox.
        if (!settings.paused) {
          settings.next_fire = Date.parse(nextFires(settings.job.cron, settings.job.timezone, 1)[0]);
          await this.publish(settings); await this.storage.put('settings', settings);
        }
      }
      await this.prune(); await this.arm();
    });
  }
}
