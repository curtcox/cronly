import { errorResponse, assert } from '../utils/errors.js';
import { prepareRun, claimRun } from './runs.js';
import { loadConfig, mutate, keyBudget } from './definitions.js';
import { rpc } from '../utils/rpc.js';
import { price } from '../utils/pricing.js';
import { parseScopes } from '../auth/scopes.js';
import { funds, reserve, settle, deposit } from './ledger.js';

/** Account definitions and money share one transactional, SQLite-backed object. */
export class AccountDO {
  constructor(ctx, env) { this.ctx = ctx; this.storage = ctx.storage; this.env = env; }
  async fetch(request) {
    try {
      const args = await request.json();
      if (args.op === 'sync-jobs') { await this.syncJobs(); return Response.json({}); }
      const result = await this.storage.transaction(tx => this.dispatch(tx, args));
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
        return tx.get('profile');
      }
      case 'account': { const { holds, ...balance } = await funds(tx); return { ...await tx.get('profile'), ...balance, holds: holds.map(({ id, amount, expires_at }) => ({ id, amount, expires_at })) }; }
      case 'reserve': return reserve(tx, { ...args, ...await keyBudget(tx, args.key_id) });
      case 'prepare-run': return prepareRun(tx, args);
      case 'claim-run': return claimRun(tx, args.id);
      case 'config': return loadConfig(tx, args.public_view !== false);
      case 'mutate': return mutate(tx, args, this.env);
      case 'meter-read': {
        const hold = await reserve(tx, { id: args.id, amount: price('read'), kind: 'read', ...await keyBudget(tx, args.key_id) });
        await settle(tx, hold.id, hold.amount); return { cost_microdollars: hold.amount };
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
        const hold = await reserve(tx, { id: `key:${args.id}`, amount, kind: 'change' });
        const record = { id: args.id, name: args.name, hash: args.hash, scopes, daily_spend_microdollars: args.daily_spend_microdollars, expires_at: args.expires_at, request_hash: args.request_hash };
        await tx.put(`key:${args.id}`, record); await settle(tx, hold.id, amount);
        await tx.put(`audit:${Date.now()}:${args.id}`, { kind: 'create_key', id: args.id, created_at: Date.now() });
        return { ...record, hash: undefined, cost_microdollars: amount };
      }
      case 'revoke-key': {
        const key = await tx.get(`key:${args.id}`); assert(key, 'not_found', 'Key not found', 404);
        if (key.revoked) return { cost_microdollars: 0 };
        const amount = price('change'); if (args.dry_run) return { quote_microdollars: amount, cost_microdollars: 0 };
        const hold = await reserve(tx, { id: `revoke:${args.id}`, amount, kind: 'change' });
        await tx.put(`key:${args.id}`, { ...key, revoked: true }); await settle(tx, hold.id, amount);
        await tx.put(`audit:${Date.now()}:revoke:${args.id}`, { kind: 'revoke_key', id: args.id, created_at: Date.now() });
        return { cost_microdollars: amount };
      }
      case 'settle': return settle(tx, args.id, args.actual);
      case 'deposit': return deposit(tx, args.id, args.amount);
      case 'dev-deposit': assert(this.env.ENVIRONMENT === 'local', 'not_found', 'Not found', 404); return deposit(tx, args.id, args.amount);
      case 'list': return { items: [...(await tx.list({ prefix: args.prefix, limit: args.limit || 1000, reverse: args.reverse || false })).values()] };
      case 'get': return (await tx.get(args.key)) || null;
      case 'authenticate-key': {
        const key = await tx.get(`key:${args.id}`);
        assert(key && !key.revoked && key.hash === args.hash && key.expires_at > Date.now(), 'invalid_auth', 'Invalid API key', 401);
        return { scopes: key.scopes };
      }
      default: assert(false, 'unknown_operation', 'Unknown internal operation', 404);
    }
  }
  async syncJobs() {
    for (const [key, item] of await this.storage.list({ prefix: 'sync:' })) {
      const job = await this.storage.get(`def:jobs:${item.name}`);
      await rpc(this.env.JOBS, `${item.account}:${item.name}`, 'configure', { account: item.account, name: item.name, job: job || null });
      await this.storage.delete(key);
    }
  }
  async alarm() {
    await this.storage.transaction(async tx => {
      const now = Date.now(); let next;
      for (const hold of (await tx.list({ prefix: 'hold:' })).values()) {
        if (hold.settled) continue;
        if (hold.expires_at <= now) await settle(tx, hold.id, hold.amount, now);
        else next = Math.min(next || Infinity, hold.expires_at);
      }
      if (next) await tx.setAlarm(next);
    });
    try { await this.syncJobs(); } catch { await this.storage.setAlarm(Date.now() + 60000); }
  }
}
