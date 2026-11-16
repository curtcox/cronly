const encoder = new TextEncoder();
/** Encode bytes without URL-unsafe characters. */
export function base64url(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
/** Decode bounded URL-safe base64. */
export function unbase64url(value) { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
/** Hash credentials before persistence, as in hashbin. */
export async function digest(value) { return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
async function hmacKey(secret) { return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
/** Sign a self-routing credential; only its digest is stored. */
export async function signToken(prefix, payload, secret) {
  if (!secret) throw new Error('Missing signing key');
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const tag = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`${prefix}${body}`));
  return `${prefix}${body}.${base64url(new Uint8Array(tag))}`;
}
/** Verify signatures before trusting a credential's account route. */
export async function verifyToken(token, prefix, secret) {
  try {
    if (!secret || token.length > 2048 || !token.startsWith(prefix)) return null;
    const [body, tag, extra] = token.slice(prefix.length).split('.');
    if (extra || !await crypto.subtle.verify('HMAC', await hmacKey(secret), unbase64url(tag), encoder.encode(`${prefix}${body}`))) return null;
    const payload = JSON.parse(new TextDecoder().decode(unbase64url(body)));
    return typeof payload.account === 'string' && typeof payload.id === 'string' ? payload : null;
  } catch { return null; }
}
