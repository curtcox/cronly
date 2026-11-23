import { dbaVerifier, forgetPushedDbaRevocations } from '../auth/dba.js';
import { ApiError } from '../utils/errors.js';
import { rpc } from '../utils/rpc.js';

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_STATUS_URI = 2048;

/**
 * `POST /api/dba/events`: devicebasedauth.org's revocation webhook (spec/events.md there),
 * registered on the cronly.org audience as https://cronly.org/api/dba/events. Ported from
 * hashbin's src/api/dba-events.js.
 *
 * The body is an issuer-signed `dba-event+jwt` checked against the same JWKS as credentials, so
 * the route is public: anyone may post, only DBA can sign. A `credentials.revoked` event is
 * applied to this isolate's verifier at once and recorded in DbaRevocationsDO for every other
 * isolate and for queued retries. Anything but 2xx makes DBA deliver it again.
 * Returns null for a 204 response.
 */
export async function dbaEvent(request, env) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_EVENT_BYTES) throw new ApiError(413, 'too_large', 'Event too large');
  const body = await request.text();
  if (body.length > MAX_EVENT_BYTES) throw new ApiError(413, 'too_large', 'Event too large');
  const result = await dbaVerifier(env).handleEvent(body);
  if (!result.ok) throw new ApiError(result.status, 'invalid_event', result.message || 'Invalid devicebasedauth.org event', { dba_code: result.code });
  // Recorded even when this isolate saw the event before: an earlier delivery may have failed
  // to record it, and recording the same entries again is harmless.
  if (result.type === 'credentials.revoked') {
    if (!env.DBA_REVOCATIONS) throw new ApiError(503, 'not_configured', 'DBA_REVOCATIONS is not bound');
    // DbaRevocationsDO takes 100 entries per call. A status URI longer than it stores is skipped
    // rather than failing the delivery forever; DBA's status list still revokes that credential.
    const credentials = result.payload.credentials.filter(c => c.status.uri.length <= MAX_STATUS_URI).map(({ cid, exp, status }) => ({ cid, exp, status }));
    try {
      for (let i = 0; i < credentials.length; i += 100) await rpc(env.DBA_REVOCATIONS, 'global', 'revoke', { credentials: credentials.slice(i, i + 100) });
    } catch { throw new ApiError(503, 'unavailable', 'Could not record the revocation; retry'); }
    forgetPushedDbaRevocations();
  }
  return null;
}
