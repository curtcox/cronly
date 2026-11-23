import { assert } from '../utils/errors.js';
import { charge } from './ledger.js';
import { price } from '../utils/pricing.js';

/** OIDC link requests expire quickly; the user is waiting at devicebasedauth.org meanwhile. */
export const DBA_STATE_TTL_MS = 10 * 60000;
const MAX_PENDING_STATES = 10;
const MAX_CREDENTIALS = 1000;

/** True for a DBA credential id used as a key id; cronly API-key ids are hex digests. */
export function isDbaKeyId(id) { return typeof id === 'string' && id.startsWith('crd_'); }

/** The per-key budget for a DBA credential: its grant's monthly cap, in µ$ per UTC month. */
export async function dbaKeyBudget(tx, id) {
  const key = await tx.get(`dba-key:${id}`);
  // Unlinking deletes the row, and a revocation seen before a retry marks it, so queued work
  // started by the credential is refused too.
  assert(key && key.expires_at > Date.now(), 'invalid_auth', 'devicebasedauth.org credential expired or account unlinked', 401);
  assert(!key.revoked, 'invalid_auth', 'devicebasedauth.org credential revoked', 401);
  return { key_id: id, key_budget: key.monthly_spend_microdollars === null ? {} : { month: key.monthly_spend_microdollars } };
}

/**
 * The account half of a devicebasedauth.org link, run inside the AccountDO transaction.
 * Rows: `dba-link` (the confirmed link), `dba-oidc:<state>` (pending OIDC requests),
 * `dba-key:<credential id>` (DBA credentials seen on this account).
 */
export async function dbaAccountOp(tx, args) {
  const now = Date.now();
  switch (args.op) {
    case 'dba-link-begin': {
      // The PKCE verifier and nonce stay server-side; only `state` travels in the URL.
      let pending = 0;
      for (const [key, row] of await tx.list({ prefix: 'dba-oidc:' })) { if (row.expires_at <= now) await tx.delete(key); else pending++; }
      assert(pending < MAX_PENDING_STATES, 'rate_limited', 'Too many pending devicebasedauth.org link requests; finish one or wait 10 minutes', 429);
      // DBA bills cronly.org for the sign-in this starts, so the link is charged as a change
      // first; finishing (or abandoning) it costs nothing more.
      const receipt = await charge(tx, { id: `dba-link:${args.oidc.state}`, amount: price('dba_link'), kind: 'change' });
      const expires_at = now + DBA_STATE_TTL_MS;
      await tx.put(`dba-oidc:${args.oidc.state}`, { oidc: args.oidc, expires_at });
      return { expires_at, cost_microdollars: receipt.charged };
    }
    case 'dba-link-take': {
      // Single use: a replayed callback cannot redeem the same state twice.
      const key = `dba-oidc:${args.state}`; const row = await tx.get(key);
      if (row) await tx.delete(key);
      assert(row && row.expires_at > now, 'invalid_state', 'This link request expired or is unknown; start again', 400);
      return { oidc: row.oidc };
    }
    case 'dba-link-set': {
      const prior = await tx.get('dba-link');
      await tx.put('dba-link', { dba_account: args.dba_account, subject: args.subject, issuer: args.issuer, linked_at: prior?.dba_account === args.dba_account ? prior.linked_at : now });
      if (prior?.dba_account !== args.dba_account) {
        await deleteCredentials(tx);
        await tx.put(`audit:${now}:dba-link`, { kind: 'link_dba', dba_account: args.dba_account, previous: prior?.dba_account || null, created_at: now });
      }
      return { previous: prior?.dba_account || null };
    }
    case 'dba-unlink': {
      const prior = await tx.get('dba-link');
      if (prior) {
        await tx.delete('dba-link'); await deleteCredentials(tx);
        await tx.put(`audit:${now}:dba-unlink`, { kind: 'unlink_dba', dba_account: prior.dba_account, created_at: now });
      }
      return { previous: prior?.dba_account || null };
    }
    case 'dba-link-status': {
      const link = await tx.get('dba-link');
      const credentials = [...(await tx.list({ prefix: 'dba-key:' })).values()].filter(row => row.expires_at > now);
      return { linked: Boolean(link), dba_account: link?.dba_account || null, linked_at: link?.linked_at || null, credentials };
    }
    case 'dba-authenticate': {
      const link = await tx.get('dba-link');
      assert(link?.dba_account === args.dba_account, 'account_not_linked', `Link devicebasedauth.org account ${args.dba_account} to your cronly account first`, 403, { dba_account: args.dba_account });
      const key = `dba-key:${args.credential_id}`; const prior = await tx.get(key);
      if (!prior) assert((await tx.list({ prefix: 'dba-key:', limit: MAX_CREDENTIALS })).size < MAX_CREDENTIALS, 'dba_credential_limit', `At most ${MAX_CREDENTIALS} devicebasedauth.org credentials per account`, 403);
      // Renewals share the credential id; keep the latest expiry, the presented cap and status
      // entry. The verifier just found this version unrevoked, so it clears an earlier mark.
      const record = { id: args.credential_id, dba_account: args.dba_account, device_id: args.device_id, device_name: args.device_name, monthly_spend_microdollars: args.monthly_spend_microdollars, expires_at: Math.max(prior?.expires_at || 0, args.expires_at), first_used_at: prior?.first_used_at || now, status: args.status || null };
      // Write only when something changed: this runs on every DBA-authenticated request.
      if (JSON.stringify(prior) !== JSON.stringify(record)) await tx.put(key, record);
      return {};
    }
    case 'dba-key-status': {
      // What a queued retry needs to re-check the credential at DBA before it is reserved.
      const key = await tx.get(`dba-key:${args.credential_id}`);
      return key ? { found: true, status: key.status || null, expires_at: key.expires_at, revoked: Boolean(key.revoked) } : { found: false };
    }
    case 'dba-key-revoked': {
      const key = `dba-key:${args.credential_id}`; const row = await tx.get(key);
      if (row && !row.revoked) await tx.put(key, { ...row, revoked: true, revoked_at: now });
      return {};
    }
    default: assert(false, 'unknown_operation', 'Unknown internal operation', 404);
  }
}

// Credentials belong to the DBA account; a different (or no) link must not inherit them.
async function deleteCredentials(tx) {
  for (const key of (await tx.list({ prefix: 'dba-key:' })).keys()) await tx.delete(key);
}
