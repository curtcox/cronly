import { it, expect } from 'vitest';
import Stripe from 'stripe';
import { stripeWebhook } from './payments.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { grossUp } from '../utils/cost-policy.js';
it('accepts only signed paid cronly events and deduplicates Checkout fulfillment', async () => {
  const env = { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake' }; env.ACCOUNTS = namespace(AccountDO, env);
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const event = { id: 'evt1', type: 'checkout.session.completed', data: { object: { id: 'cs1', mode: 'payment', payment_status: 'paid', currency: 'usd', amount_total: grossUp(500), client_reference_id: 'alice', metadata: { account: 'alice', product: 'cronly', credit_cents: '500' } } } };
  const request = () => { const payload = JSON.stringify(event); return new Request('https://cronly.org/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: env.STRIPE_WEBHOOK_SECRET }) }, body: payload }); };
  await stripeWebhook(request(), env); await stripeWebhook(request(), env);
  expect(await rpc(env.ACCOUNTS, 'alice', 'account')).toHaveProperty('balance_microdollars', 5000000);
  event.data.object.amount_total = 500;
  await expect(stripeWebhook(request(), env)).rejects.toMatchObject({ code: 'invalid_payment' });
  await expect(stripeWebhook(new Request('https://cronly.org', { method: 'POST', body: '{}' }), env)).rejects.toMatchObject({ code: 'invalid_signature' });
});
