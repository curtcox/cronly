import { errorResponse, assert } from '../utils/errors.js';
import { funds, reserve, settle, deposit } from './ledger.js';

/** Account definitions and money share one transactional, SQLite-backed object. */
export class AccountDO {
  constructor(ctx, env) { this.ctx = ctx; this.storage = ctx.storage; this.env = env; }
  async fetch(request) {
    try {
      const args = await request.json();
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
      case 'reserve': return reserve(tx, args);
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
  }
}
