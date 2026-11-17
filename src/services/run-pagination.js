import { base64url, unbase64url } from '../auth/crypto.js';
import { assert } from '../utils/errors.js';

/** Newest first, with a stable tie breaker for immediate retries. */
export function compareRuns(a, b) {
  return b.created_at - a.created_at || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1);
}

/** Encode a position so paging still works after retention removes its anchor. */
export function runCursor(run) {
  return base64url(new TextEncoder().encode(JSON.stringify([1, run.created_at, run.id])));
}

/** Treat cursors as bounded, untrusted positions within the caller's job history. */
export function parseRunCursor(value) {
  if (value === undefined || value === null) return null;
  let position;
  try {
    if (typeof value === 'string' && value.length <= 4096 && /^[a-zA-Z0-9_-]+$/.test(value)) position = JSON.parse(new TextDecoder().decode(unbase64url(value)));
  } catch { /* Malformed cursors use the same structured error as invalid positions. */ }
  assert(Array.isArray(position) && position.length === 3 && position[0] === 1 && Number.isSafeInteger(position[1]) && position[1] >= 0 && typeof position[2] === 'string' && position[2].length > 0 && position[2].length <= 1024, 'invalid_cursor', 'Invalid run cursor');
  return { created_at: position[1], id: position[2] };
}
