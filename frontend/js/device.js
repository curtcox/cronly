/**
 * Device sessions in the workspace (S5 Stage B): the pages call the API with a devicebasedauth.org
 * device credential granting `cronly:session` instead of a Clerk session. The key is a
 * non-extractable WebCrypto key in this origin's IndexedDB, so it never leaves this browser.
 *
 * The SDK is DBA's released v1.4.0 bundle, served from cronly's own origin and pinned by hash
 * (src/vendor/devicebasedauth.test.js), loaded only when a device session is in use or offered.
 */
import { escapeHtml as e } from './api.js';

export const DEVICE_AUDIENCE = 'cronly.org';
/** Everything a workspace needs; DBA's approval page lets the owner narrow or extend it. */
export const DEVICE_GRANTS = Object.freeze([{ actions: ['cronly:session'] }]);
// Set while this browser holds a device session, so other visits never load the SDK.
const FLAG = 'cronly-device-session';
const SLOT = 'cronly-workspace';

const flag = {
  get() { try { return localStorage.getItem(FLAG) === '1'; } catch { return false; } },
  set(on) { try { if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch { /* storage blocked: sign in each visit */ } }
};

let sdk;
/** Load the SDK module once (same origin, so the page's CSP and no third party are involved). */
export function loadSdk() { sdk ||= import('../vendor/devicebasedauth.js'); return sdk; }

/** A client for this workspace's slot at the deployment's DBA issuer. */
async function client(deployment) {
  const { DBA } = await loadSdk();
  return new DBA({ origin: deployment.dba_issuer, name: SLOT });
}

/**
 * The device session this browser already holds, or null. Expired or forgotten credentials clear
 * the flag, so the next visit goes straight to the sign-in choices.
 */
export async function savedDevice(deployment) {
  if (!deployment.dba_issuer || !flag.get()) return null;
  const dba = await client(deployment);
  if (await dba.ready()) return started(dba);
  flag.set(false); return null;
}

/**
 * Enroll this browser at devicebasedauth.org for a `cronly:session` credential. Call from a click:
 * DBA's approval page opens in a popup (or, if blocked, `onApprovalUrl` gets its address).
 */
export async function enrollDevice(deployment, { onApprovalUrl } = {}) {
  const dba = await client(deployment);
  if (!await dba.ready()) await dba.enroll({ aud: [DEVICE_AUDIENCE], grants: DEVICE_GRANTS }, { onApprovalUrl });
  return started(dba);
}

function started(dba) {
  flag.set(true);
  // Renew at two thirds of the credential's life; a failure surfaces on the next request.
  dba.autoRenew({ onError: () => {} });
  return dba;
}

/** Sign out: delete the key (a credential without its key is useless) and the flag. */
export async function forgetDevice(dba) {
  flag.set(false);
  await dba?.forget();
}

/** Does the credential name cronly:session (directly or as cronly:*)? A hint; the server decides. */
export function grantsSession(dba) {
  return (dba?.payload?.grants || []).some(grant => (grant.actions || []).some(action => action === 'cronly:session' || action === 'cronly:*'));
}

/** One line about the signed-in device, for the account strip and the Account page. */
export function deviceSummary(dba) {
  const p = dba?.payload || {};
  const name = typeof p.device?.name === 'string' ? p.device.name : 'this browser';
  const expires = p.exp ? new Date(p.exp * 1000).toLocaleString() : 'unknown';
  return `Signed in with devicebasedauth.org device <strong>${e(name)}</strong> (account ${e(p.acct || '?')}, credential ${e(p.cid || '?')}, expires ${e(expires)} unless renewed).`;
}
