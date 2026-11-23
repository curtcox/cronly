/** devicebasedauth.org account linking and device-bound keys on the Account page (S5). */
import { api, escapeHtml as e, dollars as usd } from './api.js';
import { date, notify, render } from './workspace.js';
import { review } from './review.js';

// devicebasedauth.org redirects back to /auth/dba/callback (which serves the workspace). Move the
// one-time code out of the address bar and history at once; it is redeemed after sign-in.
const DBA_CALLBACK = 'cronly-dba-callback';
if (location.pathname === '/auth/dba/callback') {
  const query = new URLSearchParams(location.search);
  sessionStorage.setItem(DBA_CALLBACK, JSON.stringify({ code: query.get('code'), state: query.get('state'), error: query.get('error') }));
  history.replaceState(null, '', '/app.html#account');
}
const DBA_SDK_SNIPPET = `import { DBA } from 'https://devicebasedauth.org/sdk/dba.js';

const dba = new DBA();
button.onclick = async () => {
  if (!await dba.ready()) {
    await dba.enroll({ aud: ['cronly.org'], grants: [{ actions: ['cronly:read', 'cronly:run'], limits: { spend_usd_per_month: 1 } }] });
  }
  const response = await dba.fetch('https://cronly.org/api/jobs/nightly/run', { method: 'POST', body: '{}' });
};`;

/** Fetches the link status shown on the Account page. */
export const dbaLink = () => api('/api/dba/link');

/** Renders the devicebasedauth.org section; every dynamic value is escaped. */
export function dbaSection(link, { device = false } = {}) {
  // A device session cannot move the link it signed in through (ACCOUNT_SESSION routes).
  const status = link.linked
    ? `<p>Linked to devicebasedauth.org account <strong>${e(link.dba_account)}</strong> since ${e(date(link.linked_at))}. Device credentials it issues for <code>cronly.org</code> can use this account with the scopes their grants allow.</p>${device ? '' : '<button class="secondary" id="dba-unlink">Unlink devicebasedauth.org</button>'}`
    : `<p>${link.superseded ? 'This devicebasedauth.org account is now linked to another cronly account. ' : ''}Not linked. Link once to let device-bound keys from your devicebasedauth.org account call this account. One devicebasedauth.org account links to one cronly account. Starting a link is charged like one change (shown before you continue); finishing and unlinking are free.</p>${device ? '' : '<button id="dba-link">Link devicebasedauth.org</button>'}`;
  const credentials = link.credentials.length
    ? `<ul class="list">${link.credentials.map(c => `<li><div><strong>${e(c.device_name || c.device_id)}</strong><br><span class="small">${e(c.id)} · ${c.monthly_spend_microdollars === null ? 'no monthly cap' : `${e(usd(c.monthly_spend_microdollars))} per UTC month`} · expires ${e(date(c.expires_at))}</span></div></li>`).join('')}</ul><p class="note">Revoke a device at devicebasedauth.org; cronly refuses it within a minute, along with any retries it queued.</p>`
    : '<p class="note">No device credentials have been used with this account yet.</p>';
  return `<section class="section" id="dba"><h2>devicebasedauth.org</h2>${status}<h3>Device-bound keys</h3><p class="note">A device key never leaves its device and every request carries a fresh signed proof, so a copied credential is useless. Grants map to cronly scopes (<code>cronly:read</code>, <code>cronly:run</code>, <code>cronly:change</code>, <code>cronly:prose</code>, <code>cronly:secrets:write</code>); <code>spend_usd_per_month</code> becomes the credential's monthly cap. A grant for <code>cronly:session</code> also opens this workspace's session routes, such as payments, but never API keys or this link. Grants that only devicebasedauth.org can decide (step-up, gates, use limits, <code>require.online</code>) are billed one decision each time they are checked, allowed or not. Requests and reads by a device key cost slightly more than an API key's, for verifying the credential; see <a href="/pricing.html">pricing</a>.</p><p>From a terminal, scripts or agents:</p><pre>${e('dba enroll --aud cronly.org --action cronly:run\ndba curl -X POST https://cronly.org/api/jobs/nightly/run -d {}\ncurl -H "Authorization: Bearer $(dba token --aud cronly.org)" https://cronly.org/api/runs')}</pre><p>From a browser (the key is non-extractable WebCrypto):</p><pre>${e(DBA_SDK_SNIPPET)}</pre><h3>Credentials used here</h3>${credentials}</section>`;
}

/** Handles the section's buttons; returns true when the click was one of them. */
export async function dbaClick(button) {
  if (button.id === 'dba-link') {
    const { quote_microdollars: quote } = await api('/api/dba/link/start?dry_run=1', 'POST', {});
    const idempotency = crypto.randomUUID();
    review('Link devicebasedauth.org', quote, 'You will sign in at devicebasedauth.org and approve the link, then return here. DBA charges cronly.org for that sign-in, so starting a link is billed even if you do not finish it.', async () => {
      const { url } = await api('/api/dba/link/start', 'POST', {}, idempotency);
      const target = new URL(url); if (!['https:', 'http:'].includes(target.protocol)) throw new Error('Unexpected devicebasedauth.org address');
      location.assign(target.href);
    }, 'Continue to devicebasedauth.org');
    return true;
  }
  if (button.id === 'dba-unlink') {
    if (confirm('Unlink devicebasedauth.org? Device keys from that account stop working here immediately.')) { await api('/api/dba/link', 'DELETE'); await render(); notify('devicebasedauth.org unlinked.'); }
    return true;
  }
  return false;
}

/** Redeems a code saved by the callback page, once the visitor is signed in. */
export async function finishDbaLink() {
  const pending = sessionStorage.getItem(DBA_CALLBACK); if (!pending) return;
  sessionStorage.removeItem(DBA_CALLBACK);
  const { code, state, error } = JSON.parse(pending);
  if (error || !code || !state) { notify(`devicebasedauth.org did not link your account${error ? ` (${error})` : ''}.`, true); return; }
  const result = await api('/api/dba/link/finish', 'POST', { code, state });
  if (location.hash !== '#account') location.hash = 'account'; else await render();
  notify(`Linked devicebasedauth.org account ${result.dba_account}.`);
}
