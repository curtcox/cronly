import { assert, errorResponse } from '../utils/errors.js';

const stale = report => !report || !Number.isFinite(report.checked_at) || Date.now() - report.checked_at > 36 * 3600000;
const braked = report => stale(report) || report.brake !== false;

/** Small platform registry and a fail-closed cost brake, isolated from account authority. */
export class SafetyDO {
  constructor(ctx, env) { this.storage = ctx.storage; this.env = env; }
  async fetch(request) {
    try {
      const args = await request.json();
      return Response.json(await this.storage.transaction(async tx => {
        if (args.op === 'register') { await tx.put(`account:${args.account}`, { account: args.account }); return {}; }
        if (args.op === 'accounts') return { items: [...(await tx.list({ prefix: 'account:', limit: 1000 })).values()] };
        if (args.op === 'record') {
          const prior = await tx.get('report');
          if (braked(prior) && !braked(args.report)) {
            const version = crypto.randomUUID();
            // The healthy report and recovery work commit together. A monitor
            // failure after this point must not strand any cost-paused jobs.
            for (const { account } of (await tx.list({ prefix: 'account:', limit: 1000 })).values()) await tx.put(`resume:${account}`, { account, version });
          }
          await tx.put('report', args.report); return args.report;
        }
        if (args.op === 'resume-accounts') return { items: [...(await tx.list({ prefix: 'resume:', limit: 1000 })).values()] };
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
