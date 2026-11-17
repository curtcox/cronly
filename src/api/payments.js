import Stripe from 'stripe';
import { assert, readJson, readText } from '../utils/errors.js';
import { rpc } from '../utils/rpc.js';
import { grossUp, COST_POLICY } from '../utils/cost-policy.js';
import { PRICES } from '../utils/pricing.js';
/** Create an itemized Checkout; no credit is granted on browser redirects. */
export async function checkout(request, env, auth, dryRun) {
  const body = await readJson(request); const credit = body.credit_cents;
  assert(Number.isSafeInteger(credit) && credit >= PRICES.minimumDepositCents && credit <= 100000, 'invalid_deposit', 'Deposit must be $5–$1,000');
  const account = await rpc(env.ACCOUNTS, auth.account, 'account');
  if (Date.now() - account.created_at < 7 * 86400000) assert(credit <= COST_POLICY.newAccountDepositCapCents, 'deposit_cap', 'New accounts may deposit at most $20 per payment');
  const total = grossUp(credit);
  if (dryRun) return { credit_cents: credit, card_cost_cents: total - credit, total_cents: total, cost_microdollars: 0 };
  assert(env.ENVIRONMENT !== 'production' || env.LAUNCH_APPROVED === 'true', 'launch_pending', 'Payments open after owner and legal launch approval', 503);
  assert(env.STRIPE_SECRET_KEY, 'payments_unavailable', 'Payments are not configured', 503);
  const products = [env.STRIPE_CREDIT_PRODUCT_ID, env.STRIPE_CARD_COST_PRODUCT_ID];
  if (env.ENVIRONMENT === 'production' || products.some(Boolean)) assert(products.every(id => typeof id === 'string' && /^prod_[a-zA-Z0-9]+$/.test(id)) && products[0] !== products[1], 'payments_unavailable', 'Payment catalog is not configured', 503);
  // Reuse cronly's catalog in the shared Stripe account instead of creating
  // products for every deposit. Local tests can still use inline products.
  const product = (id, name) => id ? { product: id } : { product_data: { name } };
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  const session = await stripe.checkout.sessions.create({
    mode: 'payment', payment_method_types: ['card'], client_reference_id: auth.account,
    metadata: { account: auth.account, credit_cents: String(credit), product: 'cronly' },
    line_items: [
      { price_data: { currency: 'usd', unit_amount: credit, ...product(products[0], 'cronly prepaid credit') }, quantity: 1 },
      { price_data: { currency: 'usd', unit_amount: total - credit, ...product(products[1], 'Card payment cost (non-refundable)') }, quantity: 1 }
    ],
    success_url: `${env.APP_ORIGIN}/app.html#account`, cancel_url: `${env.APP_ORIGIN}/app.html#account`
  }, { idempotencyKey: `cronly:${auth.account}:${request.headers.get('Idempotency-Key') || crypto.randomUUID()}` });
  return { url: session.url, credit_cents: credit, card_cost_cents: total - credit, total_cents: total, cost_microdollars: 0 };
}
/** Credit only signed paid Checkout events, with payment-level deduplication. */
export async function stripeWebhook(request, env) {
  assert(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET, 'payments_unavailable', 'Payments are not configured', 503);
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  let event; const payload = await readText(request);
  try { event = await stripe.webhooks.constructEventAsync(payload, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider()); }
  catch { assert(false, 'invalid_signature', 'Invalid webhook signature', 400); }
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) return { received: true };
  const session = event.data.object;
  if (session.metadata?.product !== 'cronly' || session.payment_status !== 'paid') return { received: true };
  const credit = Number(session.metadata.credit_cents);
  assert(session.mode === 'payment' && session.currency === 'usd' && session.client_reference_id === session.metadata.account && Number.isSafeInteger(credit) && credit >= PRICES.minimumDepositCents && credit <= 100000 && session.amount_total === grossUp(credit), 'invalid_payment', 'Payment does not match credited amount');
  await rpc(env.ACCOUNTS, session.client_reference_id, 'init', { account: session.client_reference_id });
  const deposit = await rpc(env.ACCOUNTS, session.client_reference_id, 'deposit', { id: session.id, amount: credit * 10000 });
  if (deposit.duplicate) return { received: true };
  // The credited transaction already persisted its wakeup. Fast-path delivery
  // can fail without rejecting a fulfilled payment; the account alarm retries.
  try { await rpc(env.ACCOUNTS, session.client_reference_id, 'sync-jobs'); } catch { /* Durable outbox retries. */ }
  return { received: true };
}
