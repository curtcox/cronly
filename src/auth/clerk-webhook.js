import { verifyWebhook } from '@clerk/backend/webhooks';
import { assert } from '../utils/errors.js';
import { rpc } from '../utils/rpc.js';
/** Clerk verifies Svix signatures and timestamps before creating an account. */
export async function clerkWebhook(request, env) {
  let event;
  try { event = await verifyWebhook(request, { signingSecret: env.CLERK_WEBHOOK_SECRET }); }
  catch { assert(false, 'invalid_signature', 'Invalid webhook signature', 400); }
  if (event.type === 'user.created' || event.type === 'user.updated') await rpc(env.ACCOUNTS, event.data.id, 'init', { account: event.data.id });
  return { received: true };
}
