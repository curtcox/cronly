import { WorkerEntrypoint } from 'cloudflare:workers';
import { verifyToken } from './auth/crypto.js';
import { rpc } from './utils/rpc.js';
import { assert, errorResponse } from './utils/errors.js';
import { destinationHostname, validateDestination } from './executor/destinations.js';
export { default } from './index.js';
export { AccountDO, JobDO, SafetyDO, API_ROUTES } from './index.js';

/** Only capability passed to a sandbox; all native network access is disabled. */
export class OutboundGateway extends WorkerEntrypoint {
  async fetch(request) {
    try {
      const token = await verifyToken(request.headers.get('x-cronly-capability') || '', 'eg_', this.env.TOKEN_SIGNING_KEY);
      assert(token && token.account === this.ctx.props.account, 'invalid_capability', 'Invalid outbound capability', 403);
      assert(this.env.COST_SAFETY_HARD_STOP !== 'true', 'cost_brake', 'Runs are paused', 503);
      const url = validateDestination(request.url);
      assert(!request.headers.has('upgrade'), 'unsupported_protocol', 'Protocol upgrades are disabled');
      await rpc(this.env.ACCOUNTS, token.account, 'gateway-request', { id: token.id, host: destinationHostname(url) });
      const headers = new Headers(request.headers); headers.delete('x-cronly-capability'); headers.delete('host'); headers.delete('connection'); headers.delete('content-length');
      return fetch(new Request(request, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) }));
    } catch (error) { return errorResponse(error); }
  }
}
