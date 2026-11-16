import { errorResponse, assert } from '../utils/errors.js';
import { digest } from '../auth/crypto.js';
import { prepareRun, claimRun } from './runs.js';
import { loadConfig, mutate, keyBudget } from './definitions.js';
import { rpc } from '../utils/rpc.js';
import { price } from '../utils/pricing.js';
import { parseScopes } from '../auth/scopes.js';
import { funds, reserve, settle, deposit, charge } from './ledger.js';
import { beginSecretRotation, finishSecretRotation } from './secret-rotation.js';
import { accountMoney, accountMetric } from './account-money.js';
import { listLedger } from './ledger-history.js';
import { getHold, listHolds, putHold } from './hold-storage.js';
import { runActivity } from './run-activity.js';

/** Account definitions and money share one transactional, SQLite-backed object. */
export class AccountDO {
  constructor(ctx, env) { this.ctx = ctx; this.storage = ctx.storage; this.env = env; }
  async fetch(request) {
    try {
      const args = await request.json();
      if (args.op === 'sync-jobs') { await this.syncJobs(); return Response.json({}); }
      const result = await this.storage.transaction(tx => this.dispatch(tx, args));
      if (args.op === 'init' && result.needs_registration && this.env.SAFETY) {
        await rpc(this.env.SAFETY, 'global', 'register', { account: args.account });
        await this.storage.transaction(async tx => { const profile = await tx.get('profile'); await tx.put('profile', { ...profile, platform_registered: true }); });
      }
      return Response.json(result ?? {});
    } catch (error) { return errorResponse(error); }
  }
  async dispatch(tx, args) {
    switch (args.op) {
      case 'init': {
        if (!await tx.get('profile')) {
          await tx.put('profile', { id: args.account, created_at: Date.now() });
          await tx.put('balance', 0);
        }
        const profile = await tx.get('profile'); return { ...profile, needs_registration: !profile.platform_registered };
      }
      case 'account': {
        const { holds, ...balance } = await funds(tx);
        const state = await accountMoney(tx); const day = new Date().toISOString().slice(0, 10);
        const daily = await accountMetric(tx, day, state); const monthly = await accountMetric(tx, day.slice(0, 7), state);
        return { ...await tx.get('profile'), ...balance, job_runtime: Object.fromEntries([...(await tx.list({ prefix: 'runtime:' }))].map(([key, value]) => [key.slice('runtime:'.length), value])), spend_by_job: monthly?.by_job || {}, spend_today_by_job: daily?.by_job || {}, spent_today_microdollars: daily?.spent_microdollars || 0, spent_month_microdollars: monthly?.spent_microdollars || 0, holds: holds.map(({ id, amount, expires_at }) => ({ id, amount, expires_at })) };
      }
      case 'reserve': return reserve(tx, { ...args, ...await keyBudget(tx, args.key_id) });
      case 'gateway-request': {
        const hold = await getHold(tx, args.id);
        assert(hold?.claimed && hold.expires_at > Date.now() && hold.execution?.action?.type === 'javascript', 'invalid_capability', 'Run is not active', 403);
        const count = hold.gateway_count || 0;
        assert(count < hold.execution.action.subrequests, 'subrequest_limit', 'Subrequest limit reached', 429);
        let rate = await tx.get(`rate:destination:${args.host}`); const now = Date.now();
        if (!rate || rate.reset <= now) rate = { count: 0, reset: now + 60000 };
        assert(rate.count < 60, 'destination_rate_limit', 'Destination rate exceeded', 429);
        await tx.put(`rate:destination:${args.host}`, { ...rate, count: rate.count + 1 });
        await putHold(tx, { ...hold, gateway_count: count + 1 }); return { subrequests: count + 1 };
      }
      case 'job-runtime': {
        const prior = await tx.get(`runtime:${args.name}`);
        if (JSON.stringify(prior) !== JSON.stringify(args.runtime)) await tx.put(`runtime:${args.name}`, args.runtime);
        return {};
      }
      case 'metrics': return (await accountMetric(tx, args.period)) || {};
      case 'resume-cost-jobs': {
        const profile = await tx.get('profile');
        for (const [key] of await tx.list({ prefix: 'def:jobs:' })) { const name = key.slice('def:jobs:'.length); await tx.put(`sync:${name}`, { name, account: profile.id, version: crypto.randomUUID() }); }
        await tx.setAlarm(Date.now() + 1000); return {};
      }
      case 'maintenance': {
        const now = Date.now();
        for (const prefix of ['activation:', 'proposal:', 'rate:']) for (const [key, record] of await tx.list({ prefix })) if ((record.expires_at && record.expires_at < now) || (record.reset && record.reset < now) || (record.created_at && record.created_at < now - 31 * 86400000)) await tx.delete(key);
        return {};
      }
      case 'prepare-run': return prepareRun(tx, args, this.env);
      case 'retry-data': { const hold = await getHold(tx, args.id); return { input: hold?.execution?.input || {} }; }
      case 'claim-run': return claimRun(tx, args.id);
      case 'config': return loadConfig(tx, args.public_view !== false);
      case 'mutate': return mutate(tx, args, this.env);
      case 'begin-secret-rotation': return beginSecretRotation(tx, args, this.env);
      case 'finish-secret-rotation': return finishSecretRotation(tx, args, this.env);
      case 'begin-prose': {
        const prior = await tx.get(`prose:${args.id}`);
        if (prior) { assert(prior.request_hash === args.request_hash, 'idempotency_conflict', 'Idempotency key reused', 409); return { duplicate: true, response: prior.response }; }
        await reserve(tx, { id: args.id, amount: args.amount, kind: 'prose', ttl_ms: 240000, ...await keyBudget(tx, args.key_id) });
        await tx.put(`prose:${args.id}`, { request_hash: args.request_hash }); return {};
      }
      case 'finish-prose': {
        await settle(tx, args.id, args.actual); const prior = await tx.get(`prose:${args.id}`);
        await tx.put(`prose:${args.id}`, { ...prior, response: args.response }); return {};
      }
      case 'save-proposal': {
        const quote = args.operations.length ? await mutate(tx, { id: `validate:${args.id}`, operations: args.operations, dry_run: true }, this.env) : { quote_microdollars: 0 };
        const proposal = { id: args.id, operations: args.operations, quote_microdollars: quote.quote_microdollars, base_hash: args.base_hash, explanation: args.explanation, expires_at: Date.now() + 86400000 };
        await tx.put(`proposal:${args.id}`, proposal); return proposal;
      }
      case 'apply-proposal': {
        const proposal = await tx.get(`proposal:${args.id}`); assert(proposal, 'not_found', 'Proposal not found', 404);
        if (proposal.applied) return proposal.applied;
        assert(proposal.expires_at > Date.now(), 'proposal_expired', 'Proposal expired', 409);
        assert(await digest(JSON.stringify(await loadConfig(tx, true))) === proposal.base_hash, 'stale_proposal', 'Account changed; request a new proposal', 409);
        assert(args.expected_quote === undefined || args.expected_quote === proposal.quote_microdollars, 'quote_changed', 'Quote does not match proposal', 409);
        const response = proposal.operations.length ? await mutate(tx, { account: args.account, key_id: args.key_id, id: `apply:${args.id}`, operations: proposal.operations, dry_run: args.dry_run }, this.env) : { changes: [], quote_microdollars: 0, cost_microdollars: 0 };
        if (!args.dry_run) await tx.put(`proposal:${args.id}`, { ...proposal, applied: response }); return response;
      }
      case 'bill-change': {
        const amount = price('change'); if (args.dry_run) return { quote_microdollars: amount, cost_microdollars: 0 };
        const receipt = await charge(tx, { id: args.id, amount, kind: 'change', ...await keyBudget(tx, args.key_id) });
        if (!receipt.duplicate) { await tx.put(`audit:${Date.now()}:${args.id}`, { id: args.id, kind: 'trigger', created_at: Date.now() }); }
        return { cost_microdollars: receipt.duplicate ? 0 : amount };
      }
      case 'activity': {
        const counts = Object.create(null); const state = await accountMoney(tx);
        for (let offset = 0; offset < 7; offset++) { const period = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10); const metric = await accountMetric(tx, period, state); for (const [name, count] of Object.entries(metric?.run_count_by_job || {})) counts[name] = (counts[name] || 0) + count; }
        return { counts };
      }
      case 'read-plan': return { names: (await runActivity(tx)).map(([name]) => name) };
      case 'run-route': { const hold = await getHold(tx, args.id) || await tx.get(`receipt:${args.id}`); if (hold?.job) return { job: hold.job }; const profile = await tx.get('profile'); const prefix = `${profile.id}:`; assert(args.id.startsWith(prefix), 'not_found', 'Run not found', 404); const parts = args.id.slice(prefix.length).split(':'); const name = parts[0] === '_test' ? parts.slice(0, 2).join(':') : parts[0]; assert(await tx.get(`job-index:${name}`), 'not_found', 'Run not found', 404); return { job: name }; }
      case 'meter-read': {
        const names = args.resource === 'runs' ? (args.job ? [args.job] : (await runActivity(tx)).map(([name]) => name)) : [];
        const receipt = await charge(tx, { id: args.id, amount: price('read', { job_count: names.length }), read_job_count: names.length, kind: 'read', ...await keyBudget(tx, args.key_id) });
        return { cost_microdollars: receipt.charged, names };
      }
      case 'rate-limit': {
        const key = `rate:${args.id}`; const now = Date.now();
        let record = await tx.get(key);
        if (!record || record.reset <= now) record = { count: 0, reset: now + 60000 };
        assert(record.count < (args.limit || 120), 'rate_limited', 'Rate limit exceeded', 429);
        record.count++; await tx.put(key, record); return {};
      }
      case 'create-key': {
        const prior = await tx.get(`key:${args.id}`);
        if (prior) { assert(prior.request_hash === args.request_hash, 'idempotency_conflict', 'Idempotency key reused', 409); return { ...prior, hash: undefined }; }
        const scopes = parseScopes(args.scopes); assert(scopes?.length, 'invalid_scopes', 'Expected known scopes');
        assert(args.daily_spend_microdollars === null || (Number.isSafeInteger(args.daily_spend_microdollars) && args.daily_spend_microdollars >= 0), 'invalid_budget', 'Invalid daily spend cap');
        assert(args.expires_at > Date.now() && args.expires_at <= Date.now() + 366 * 86400000, 'invalid_expiry', 'Expiry must be within a year');
        const amount = price('change');
        if (args.dry_run) return { quote_microdollars: amount, cost_microdollars: 0 };
        assert((await tx.list({ prefix: 'key:' })).size < 100, 'key_limit', 'Maximum 100 API keys');
        await charge(tx, { id: `key:${args.id}`, amount, kind: 'change' });
        const record = { id: args.id, name: args.name, hash: args.hash, scopes, daily_spend_microdollars: args.daily_spend_microdollars, expires_at: args.expires_at, request_hash: args.request_hash };
        await tx.put(`key:${args.id}`, record);
        await tx.put(`audit:${Date.now()}:${args.id}`, { kind: 'create_key', id: args.id, created_at: Date.now() });
        return { ...record, hash: undefined, cost_microdollars: amount };
      }
      case 'revoke-key': {
        const key = await tx.get(`key:${args.id}`); assert(key, 'not_found', 'Key not found', 404);
        if (key.revoked) return { cost_microdollars: 0 };
        const amount = price('change'); if (args.dry_run) return { quote_microdollars: amount, cost_microdollars: 0 };
        await charge(tx, { id: `revoke:${args.id}`, amount, kind: 'change' });
        await tx.put(`key:${args.id}`, { ...key, revoked: true });
        await tx.put(`audit:${Date.now()}:revoke:${args.id}`, { kind: 'revoke_key', id: args.id, created_at: Date.now() });
        return { cost_microdollars: amount };
      }
      case 'settle': return settle(tx, args.id, args.actual);
      case 'deposit': { const result = await deposit(tx, args.id, args.amount); if (!result.duplicate) await this.nudge(tx); return result; }
      case 'dev-deposit': assert(this.env.ENVIRONMENT === 'local', 'not_found', 'Not found', 404); { const result = await deposit(tx, args.id, args.amount); if (!result.duplicate) await this.nudge(tx); return result; }
      case 'list': {
        if (args.prefix === 'ledger:') return listLedger(tx, args);
        const entries = [...await tx.list({ prefix: args.prefix, ...(args.cursor ? args.reverse ? { end: args.cursor } : { startAfter: args.cursor } : {}), limit: Math.min(args.limit || 1000, 1000), reverse: args.reverse || false })];
        return { items: entries.map(([, value]) => value), next_cursor: entries.length === Math.min(args.limit || 1000, 1000) ? entries.at(-1)[0] : null };
      }
      case 'costs': {
        const prefix = 'spent:account:self:'; const from = args.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10); const to = args.to || new Date().toISOString().slice(0, 10);
        assert(/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to)) && Date.parse(to) >= Date.parse(from) && Date.parse(to) - Date.parse(from) <= 366 * 86400000, 'invalid_window', 'Costs use UTC dates YYYY-MM-DD, at most 366 days');
        const current = (await accountMoney(tx)).summaries.day;
        const rows = [...(await tx.list({ prefix, start: `${prefix}${from}`, end: `${prefix}${to}~`, limit: 1000 })).values()].filter(metric => metric.period?.length === 10 && metric.period !== current?.period);
        if (current && current.period >= from && current.period <= to) rows.push(current);
        return { items: rows.sort((a, b) => a.period.localeCompare(b.period)), from, to };
      }
      case 'get': return (await tx.get(args.key)) || null;
      case 'authenticate-key': {
        const key = await tx.get(`key:${args.id}`);
        assert(key && !key.revoked && key.hash === args.hash && key.expires_at > Date.now(), 'invalid_auth', 'Invalid API key', 401);
        return { scopes: key.scopes };
      }
      default: assert(false, 'unknown_operation', 'Unknown internal operation', 404);
    }
  }
  async nudge(tx) {
    const profile = await tx.get('profile'); if (!profile) return;
    for (const [key] of await tx.list({ prefix: 'def:jobs:' })) { const name = key.slice('def:jobs:'.length); await tx.put(`sync:${name}`, { name, account: profile.id, version: crypto.randomUUID() }); }
    if ((await tx.list({ prefix: 'sync:' })).size) await tx.setAlarm(Date.now() + 1000);
  }
  async syncJobs() {
    for (const [key, item] of await this.storage.list({ prefix: 'sync:' })) {
      const job = await this.storage.get(`def:jobs:${item.name}`);
      await rpc(this.env.JOBS, `${item.account}:${item.name}`, 'configure', { account: item.account, name: item.name, job: job || null });
      await this.storage.transaction(async tx => { const current = await tx.get(key); if (current?.version === item.version) await tx.delete(key); });
    }
  }
  async alarm() {
    await this.storage.transaction(async tx => {
      const now = Date.now(); let next;
      for (const hold of await listHolds(tx)) {
        if (hold.expires_at <= now) await settle(tx, hold.id, hold.amount, now);
        else next = Math.min(next || Infinity, hold.expires_at);
      }
      if (next) await tx.setAlarm(next);
    });
    try { await this.syncJobs(); } catch { await this.storage.setAlarm(Date.now() + 60000); }
  }
}
