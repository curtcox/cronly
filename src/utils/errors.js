/** A safe, public API error. */
export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
/** Reject an invalid request without leaking internal details. */
export function assert(condition, code, message, status = 400, details) {
  if (!condition) throw new ApiError(status, code, message, details);
}
/** Serialize only explicitly public error messages. */
export function errorResponse(error) {
  return Response.json({ error: error instanceof ApiError ? error.message : 'Internal error', code: error.code || 'internal_error', ...(error.details || {}) }, { status: error.status || 500 });
}
/** Parse bounded JSON, including requests without a Content-Length header. */
export async function readJson(request, maxBytes = 300000) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  let size = 0; const chunks = [];
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); throw new ApiError(413, 'body_too_large', 'Request body too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError(400, 'invalid_json', 'Invalid JSON'); }
}
