/**
 * CORS for devicebasedauth.org device credentials from any origin (hashbin S24, owner decision
 * 2026-11-22). A request with `Authorization: DBA` carries no cookies, and its key cannot be
 * exported from the page that holds it, so another site's page can only act as a device its
 * owner enrolled. Other credentials (Clerk sessions, API keys, DBA bearer access tokens) get
 * no CORS: they are exportable and must not be used from browsers on other sites.
 */
const ALLOW_HEADERS = 'Authorization, Content-Type, DPoP, DBA-Confirmation, Idempotency-Key';
const isDbaPath = path => path.startsWith('/api/') || path === '/mcp';

/** A preflight that could be for a device credential: an API path, asking to send DPoP. */
export function dbaPreflight(request, path) {
  if (request.method !== 'OPTIONS' || !isDbaPath(path)) return null;
  const requested = (request.headers.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map(h => h.trim());
  if (!requested.includes('dpop')) return null;
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': ALLOW_HEADERS, 'Access-Control-Max-Age': '600' } });
}

/** Adds any-origin CORS to a response for a request carrying a device credential. */
export function withDbaCors(request, path, response) {
  if (isDbaPath(path) && /^dba /i.test((request.headers.get('Authorization') || '').trim())) {
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Expose-Headers', 'X-Next-Before');
  }
  return response;
}
