import { assert, errorResponse } from '../utils/errors.js';
/** Small platform registry and a fail-closed cost brake, isolated from account authority. */
export class SafetyDO {
  constructor(ctx, env) { this.storage = ctx.storage; this.env = env; }
  async fetch(request) {
    try {
      const args = await request.json();
      return Response.json(await this.storage.transaction(async tx => {
        if (args.op === 'register') { await tx.put(`account:${args.account}`, { account: args.account }); return {}; }
        if (args.op === 'accounts') return { items: [...(await tx.list({ prefix: 'account:', limit: 1000 })).values()] };
        if (args.op === 'record') { await tx.put('report', args.report); return args.report; }
        assert(args.op === 'status', 'unknown_operation', 'Unknown safety operation');
        if (this.env.ENVIRONMENT === 'local') return { brake: false, local: true };
        const report = await tx.get('report');
        return { ...report, brake: !report || report.brake || Date.now() - report.checked_at > 36 * 3600000, stale: !report || Date.now() - report.checked_at > 36 * 3600000 };
      }));
    } catch (error) { return errorResponse(error); }
  }
}
