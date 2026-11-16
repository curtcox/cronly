let localUser = sessionStorage.getItem('cronly-local-user');
let clerk;
/** Fetch the public deployment settings; never exposes Worker secrets. */
export async function settings() { return (await fetch('/api/public/config')).json(); }
/** Bind Clerk or the explicitly local-only development credential. */
export function setAuth(value) { if (typeof value === 'string') { localUser = value; sessionStorage.setItem('cronly-local-user', value); } else clerk = value; }
/** Read the current local development identity. */
export function getLocalUser() { return localUser; }
/** Clear local auth; production sessions are revoked through Clerk. */
export async function signOut() { sessionStorage.removeItem('cronly-local-user'); localUser = null; if (clerk) await clerk.signOut(); location.reload(); }
/** JSON transport with fresh Clerk tokens and bounded idempotency keys. */
export async function api(path, method = 'GET', body, idempotency) {
  const token = clerk ? await clerk.session?.getToken() : null;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`; else if (localUser) headers.Authorization = `LocalDev ${localUser}`;
  if (method !== 'GET') headers['Idempotency-Key'] = idempotency || crypto.randomUUID();
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(`${data.error} (${data.code})`); return data;
}
/** Escape every dynamic string inserted into HTML. */
export function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
/** Keep integer accounting internal while displaying readable USD. */
export function dollars(value) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format((value || 0) / 1000000); }
