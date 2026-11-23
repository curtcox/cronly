import { assert, errorResponse } from '../utils/errors.js';

/**
 * Global index from one devicebasedauth.org account to the cronly account it is linked to.
 *
 * One object per DBA account (named by it): every DBA-authenticated request looks its link up,
 * so lookups must spread across objects rather than queue on a singleton such as SafetyDO, and a
 * per-DBA-account object makes "linked to at most one cronly account" an atomic claim.
 * The claim alone authorizes nothing: the named AccountDO's `dba-link` row must confirm it.
 */
export class DbaLinkDO {
  constructor(ctx, env) { this.storage = ctx.storage; this.env = env; }
  async fetch(request) {
    try {
      const args = await request.json();
      return Response.json(await this.storage.transaction(async tx => {
        const current = await tx.get('link');
        switch (args.op) {
          case 'get': return { account: current?.account || null };
          case 'claim': {
            // Take over only the holder the caller proved stale, so racing takeovers cannot both win.
            if (current && current.account !== args.account && current.account !== args.replace) return { account: current.account, claimed: false };
            if (current?.account !== args.account) await tx.put('link', { account: args.account, claimed_at: Date.now() });
            return { account: args.account, claimed: true };
          }
          case 'release': {
            // A late release from a former holder must not drop a newer claim.
            if (current?.account === args.account) await tx.delete('link');
            return {};
          }
          default: assert(false, 'unknown_operation', 'Unknown internal operation', 404);
        }
      }));
    } catch (error) { return errorResponse(error); }
  }
}
