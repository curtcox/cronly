import { assert, errorResponse } from '../utils/errors.js';

const PRUNE_EVERY_MS = 3600 * 1000;

/**
 * devicebasedauth.org credentials DBA told cronly were revoked, through its revocation webhook
 * (`POST /api/dba/events`, spec/events.md at DBA). One object, named "global"; ported from
 * hashbin's DbaRevocations.
 *
 * Each revoked status entry (`<status list uri>#<idx>`) is kept until that credential expires.
 * Isolates read the whole set at most every 30 seconds (src/auth/dba.js), so a revocation takes
 * effect well before the status list's cache runs out. The status lists stay authoritative:
 * this only ever adds revocations.
 */
export class DbaRevocationsDO {
  constructor(ctx, env) { this.storage = ctx.storage; this.env = env; }
  async fetch(request) {
    try {
      const args = await request.json();
      const now = Math.floor(Date.now() / 1000);
      switch (args.op) {
        case 'revoked': {
          // Every entry: a truncated set would quietly let revoked credentials back in. Entries
          // only live until their credential expires, and the alarm prunes the rest.
          const rows = await this.storage.list({ prefix: 'r:' });
          return Response.json({ revoked: [...rows].filter(([, entry]) => entry.exp >= now).map(([key]) => key.slice(2)) });
        }
        case 'revoke': {
          const credentials = Array.isArray(args.credentials) ? args.credentials : [];
          assert(credentials.length > 0 && credentials.length <= 100, 'invalid_request', 'Expected 1–100 revoked credentials');
          let recorded = 0;
          for (const credential of credentials) {
            const { uri, idx } = credential?.status || {};
            assert(typeof uri === 'string' && uri.length <= 2048 && Number.isSafeInteger(idx) && Number.isSafeInteger(credential.exp), 'invalid_request', 'Each credential needs status { uri, idx } and exp');
            if (credential.exp < now) continue;
            await this.storage.put(`r:${uri}#${idx}`, { exp: credential.exp, cid: typeof credential.cid === 'string' ? credential.cid : null, recorded_at: now });
            recorded++;
          }
          if (!(await this.storage.getAlarm())) await this.storage.setAlarm(Date.now() + PRUNE_EVERY_MS);
          return Response.json({ recorded });
        }
        default: assert(false, 'unknown_operation', 'Unknown internal operation', 404);
      }
    } catch (error) { return errorResponse(error); }
  }
  /** Forget entries whose credential has expired: an expired credential is refused anyway. */
  async alarm() {
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.storage.list({ prefix: 'r:' });
    const expired = [...rows].filter(([, entry]) => entry.exp < now).map(([key]) => key);
    for (const key of expired) await this.storage.delete(key);
    if (rows.size > expired.length) await this.storage.setAlarm(Date.now() + PRUNE_EVERY_MS);
  }
}
