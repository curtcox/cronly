import { isIP } from 'node:net';
import { assert } from '../utils/errors.js';
/** Deny local/private literals, internal hosts and cronly loops on every redirect. */
export function validateDestination(value) {
  let url; try { url = new URL(value); } catch { assert(false, 'invalid_destination', 'Expected an absolute HTTP URL'); }
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'invalid_destination', 'Only HTTP(S) URLs without credentials are allowed');
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  assert(!['localhost', 'cronly.org', 'cloudflare', 'metadata.google.internal'].includes(host) && !['.cronly.org', '.localhost', '.local', '.internal', '.cloudflare.com', '.workers.dev'].some(suffix => host.endsWith(suffix)), 'blocked_destination', 'Destination is blocked');
  const ip = isIP(host);
  if (ip === 4) {
    const [a, b] = host.split('.').map(Number);
    assert(!(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19].includes(b))), 'blocked_destination', 'Private or reserved address is blocked');
  } else if (ip === 6) {
    assert(/^[23][0-9a-f]{3}:/.test(host) && !host.startsWith('2001:db8:'), 'blocked_destination', 'Private or reserved address is blocked');
  } else assert(host.includes('.') && !host.includes(':'), 'blocked_destination', 'Public destination required');
  return url;
}
