import { assert } from '../utils/errors.js';
/** Sandbox implementation is added in L10; fail closed until configured. */
export async function executeJavaScript(_execution, _context, _env, _ctx, _secrets) {
  assert(false, 'sandbox_unavailable', 'JavaScript sandbox is not configured', 503);
}
