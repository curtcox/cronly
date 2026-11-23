import { assert, readJson, ApiError } from '../utils/errors.js';
import { rpc } from '../utils/rpc.js';
import { dbaIssuer, dbaOidc } from '../auth/dba.js';
import { price } from '../utils/pricing.js';

const DBA_ACCOUNT = /^[A-Za-z0-9_-]{1,128}$/;
const free = { quote_microdollars: 0, cost_microdollars: 0 };

/**
 * Link, inspect and unlink the account's devicebasedauth.org account. Status is a SESSION route;
 * the rest are ACCOUNT_SESSION (never a device session). Starting a link is a 100 µ$ change,
 * charged before devicebasedauth.org bills cronly.org for the sign-in; finishing and unlinking
 * are free. All three are limited to 10 a minute per account.
 */
export async function dbaLink(route, request, env, auth) {
  const dryRun = new URL(request.url).searchParams.get('dry_run') === '1';
  switch (route.handler) {
    case 'dba-link-status': return status(env, auth.account);
    case 'dba-link-start': {
      if (dryRun) return { quote_microdollars: price('dba_link'), cost_microdollars: 0 };
      await rpc(env.ACCOUNTS, auth.account, 'rate-limit', { id: 'dba-link', limit: 10 });
      const { url, state } = await reach(() => dbaOidc(env).begin());
      const { expires_at, cost_microdollars } = await rpc(env.ACCOUNTS, auth.account, 'dba-link-begin', { oidc: state });
      return { url, expires_at, cost_microdollars };
    }
    case 'dba-link-finish': {
      const body = await readJson(request, 8192);
      assert(typeof body.code === 'string' && body.code.length > 0 && body.code.length <= 2048, 'invalid_code', 'Expected the authorization code from devicebasedauth.org');
      assert(typeof body.state === 'string' && body.state.length > 0 && body.state.length <= 256, 'invalid_state', 'Expected the state from devicebasedauth.org');
      if (dryRun) return free;
      await rpc(env.ACCOUNTS, auth.account, 'rate-limit', { id: 'dba-link', limit: 10 });
      const { oidc } = await rpc(env.ACCOUNTS, auth.account, 'dba-link-take', { state: body.state });
      const claims = await reach(() => dbaOidc(env).finish({ code: body.code, state: body.state }, oidc));
      const dbaAccount = claims.acct ?? claims.sub;
      assert(typeof dbaAccount === 'string' && DBA_ACCOUNT.test(dbaAccount), 'dba_link_failed', 'devicebasedauth.org did not name an account', 502);
      await claim(env, dbaAccount, auth.account);
      // The index claim comes first and the account row confirms it; until both agree the link
      // authorizes nothing, so an interruption here cannot let credentials in.
      const { previous } = await rpc(env.ACCOUNTS, auth.account, 'dba-link-set', { dba_account: dbaAccount, subject: claims.sub, issuer: dbaIssuer(env) });
      if (previous && previous !== dbaAccount) await rpc(env.DBA_LINKS, previous, 'release', { account: auth.account });
      return status(env, auth.account);
    }
    case 'dba-link-delete': {
      if (dryRun) return free;
      await rpc(env.ACCOUNTS, auth.account, 'rate-limit', { id: 'dba-link', limit: 10 });
      // Clear the confirming row first: credentials stop working even if the release fails.
      const { previous } = await rpc(env.ACCOUNTS, auth.account, 'dba-unlink');
      if (previous) await rpc(env.DBA_LINKS, previous, 'release', { account: auth.account });
      return status(env, auth.account);
    }
  }
}

/** Claim the DBA account for this cronly account, taking over only a claim nobody confirms. */
async function claim(env, dbaAccount, account) {
  let result = await rpc(env.DBA_LINKS, dbaAccount, 'claim', { account });
  if (result.claimed) return;
  const holder = await rpc(env.ACCOUNTS, result.account, 'dba-link-status');
  assert(holder.dba_account !== dbaAccount, 'dba_account_linked', 'This devicebasedauth.org account is already linked to another cronly account; unlink it there first', 409);
  result = await rpc(env.DBA_LINKS, dbaAccount, 'claim', { account, replace: result.account });
  assert(result.claimed, 'dba_account_linked', 'This devicebasedauth.org account is already linked to another cronly account; unlink it there first', 409);
}

/** The account's view, confirmed against the global index (a superseded link reads as unlinked). */
async function status(env, account) {
  const view = await rpc(env.ACCOUNTS, account, 'dba-link-status');
  const active = view.linked && (await rpc(env.DBA_LINKS, view.dba_account, 'get')).account === account;
  return { ...view, linked: active, superseded: view.linked && !active, issuer: dbaIssuer(env), ...free };
}

/** Call devicebasedauth.org; its failures become stable public errors without its prose. */
async function reach(operation) {
  try { return await operation(); } catch (error) {
    if (error instanceof ApiError) throw error;
    // Library errors carry an OAuth/verification code; anything else is a network failure.
    const reason = typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : null;
    if (!reason) throw new ApiError(502, 'dba_unavailable', 'devicebasedauth.org could not be reached; try again');
    throw new ApiError(400, 'dba_link_failed', 'devicebasedauth.org did not confirm the link; start again', { reason });
  }
}
