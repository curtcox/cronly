import { assert, errorResponse } from '../utils/errors.js';

const stale = report => !report || !Number.isFinite(report.checked_at) || Date.now() - report.checked_at > 36 * 3600000;
const braked = report => stale(report) || report.brake !== false;
const PAGE_SIZE = 100;

/** Small platform registry and a fail-closed cost brake, isolated from account authority. */
export class SafetyDO {
  constructor(ctx, env) { this.storage = ctx.storage; this.env = env; }
  async fetch(request) {
    try {
      const args = await request.json();
      return Response.json(await this.storage.transaction(async tx => {
        if (args.op === 'register') { await tx.put(`account:${args.account}`, { account: args.account }); return {}; }
        if (args.op === 'accounts') {
          const entries = [...await tx.list({ prefix: 'account:', limit: PAGE_SIZE, ...(args.cursor ? { startAfter: args.cursor } : {}) })];
          return { items: entries.map(([, item]) => item), next_cursor: entries.length === PAGE_SIZE ? entries.at(-1)[0] : null };
        }
        if (args.op === 'record') {
          const prior = await tx.get('report');
          if (braked(prior) && !braked(args.report)) {
            // Commit the recovery scan with the report, then materialize bounded
            // pages. A restart must retain both its generation and its position.
            await tx.put('recovery', { version: crypto.randomUUID(), cursor: null });
          }
          await tx.put('report', args.report); return args.report;
        }
        if (args.op === 'resume-accounts') {
          const recovery = await tx.get('recovery');
          if (recovery) {
            const entries = [...await tx.list({ prefix: 'account:', limit: PAGE_SIZE, ...(recovery.cursor ? { startAfter: recovery.cursor } : {}) })];
            const items = entries.map(([, { account }]) => ({ account, version: recovery.version }));
            for (const item of items) await tx.put(`resume:${item.account}`, item);
            if (entries.length === PAGE_SIZE) await tx.put('recovery', { ...recovery, cursor: entries.at(-1)[0] });
            else await tx.delete('recovery');
          }
          // Outboxes from an older scan remain compatible. A later generation
          // overwrites each account before its new acknowledgement can remove it.
          const items = [...(await tx.list({ prefix: 'resume:', limit: PAGE_SIZE })).values()];
          return { items, more: !!await tx.get('recovery') || items.length === PAGE_SIZE };
        }
        if (args.op === 'resumed-account') {
          const key = `resume:${args.account}`; const item = await tx.get(key);
          // An older monitor must not acknowledge a newer brake recovery.
          if (item?.version === args.version) await tx.delete(key);
          return {};
        }
        assert(args.op === 'status', 'unknown_operation', 'Unknown safety operation');
        if (this.env.ENVIRONMENT === 'local') return { brake: false, local: true };
        const report = await tx.get('report');
        return { ...report, brake: braked(report), stale: stale(report) };
      }));
    } catch (error) { return errorResponse(error); }
  }
}
