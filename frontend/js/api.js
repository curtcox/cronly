let localUser = sessionStorage.getItem('cronly-local-user');
let clerk; let device; let onGate = () => {};
/** Fetch the public deployment settings; never exposes Worker secrets. */
export async function settings() { return (await fetch('/api/public/config')).json(); }
/** Bind Clerk, a devicebasedauth.org device session (an SDK client), or the local-only development credential. */
export function setAuth(value) { if (typeof value === 'string') { localUser = value; sessionStorage.setItem('cronly-local-user', value); } else if (typeof value?.fetchWithGates === 'function') device = value; else clerk = value; }
/** The device session in use, if the workspace signed in with devicebasedauth.org. */
export function getDevice() { return device || null; }
/** Called once per request whose devicebasedauth.org gates are still deciding. */
export function onGatePending(callback) { onGate = callback; }
/** Read the current local development identity. */
export function getLocalUser() { return localUser; }
/** Clear local auth; production sessions are revoked through Clerk; device sessions delete their key. */
export async function signOut() {
  sessionStorage.removeItem('cronly-local-user'); localUser = null;
  if (device) { const { forgetDevice } = await import('./device.js'); await forgetDevice(device); device = null; }
  if (clerk) await clerk.signOut();
  location.reload();
}
/**
 * JSON transport with fresh Clerk tokens (or a device's signed proofs) and bounded idempotency
 * keys. Device requests answer DPoP nonce challenges and wait while gates decide (DBA's SDK).
 */
export async function api(path, method = 'GET', body, idempotency) {
  const token = clerk && !device ? await clerk.session?.getToken() : null;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`; else if (localUser && !device) headers.Authorization = `LocalDev ${localUser}`;
  if (method !== 'GET') headers['Idempotency-Key'] = idempotency || crypto.randomUUID();
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
  const response = device ? await device.fetchWithGates(path, init, { onPending: gate => onGate(gate) }) : await fetch(path, init);
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.error} (${data.code})${device && response.status === 401 && data.code !== 'use_dpop_nonce' ? '. This device can no longer sign in here; sign out and enroll it again.' : ''}`);
  return data;
}
/** Escape every dynamic string inserted into HTML. */
export function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
/** Keep integer accounting internal while displaying readable USD. */
export function dollars(value) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format((value || 0) / 1000000); }
