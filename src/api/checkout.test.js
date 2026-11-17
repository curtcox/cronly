import { afterEach, it, expect, vi } from 'vitest';
import { checkout } from './payments.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { grossUp } from '../utils/cost-policy.js';

afterEach(() => vi.unstubAllGlobals());

async function setup(settings = {}) {
  const env = { ENVIRONMENT: 'production', LAUNCH_APPROVED: 'true', APP_ORIGIN: 'https://cronly.org', STRIPE_SECRET_KEY: 'rk_live_fake', STRIPE_CREDIT_PRODUCT_ID: 'prod_credit', STRIPE_CARD_COST_PRODUCT_ID: 'prod_cardcost', ...settings };
  env.ACCOUNTS = namespace(AccountDO, env);
  await rpc(env.ACCOUNTS, 'alice', 'init', { account: 'alice' });
  const send = vi.fn(async () => Response.json({ id: 'cs_fake', url: 'https://checkout.stripe.com/fake' }));
  vi.stubGlobal('fetch', send);
  const call = (credit = 500, dryRun = false) => checkout(new Request('https://cronly.org/api/payments/checkout', { method: 'POST', headers: { 'Idempotency-Key': 'deposit-1' }, body: JSON.stringify({ credit_cents: credit }) }), env, { account: 'alice' }, dryRun);
  return { env, send, call };
}

it('creates card-only one-time Checkout with reusable cronly products and exact itemized amounts', async () => {
  const { env, send, call } = await setup();
  const result = await call(1000);
  expect(result).toMatchObject({ credit_cents: 1000, card_cost_cents: grossUp(1000) - 1000, total_cents: grossUp(1000), cost_microdollars: 0 });
  expect(send).toHaveBeenCalledOnce();
  const [url, request] = send.mock.calls[0]; const body = new URLSearchParams(request.body);
  expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
  expect(body.get('mode')).toBe('payment');
  expect(body.get('payment_method_types[0]')).toBe('card');
  expect(body.get('client_reference_id')).toBe('alice');
  expect(body.get('metadata[account]')).toBe('alice');
  expect(body.get('metadata[product]')).toBe('cronly');
  expect(body.get('metadata[credit_cents]')).toBe('1000');
  expect(body.get('success_url')).toBe('https://cronly.org/app.html#account');
  expect(body.get('cancel_url')).toBe('https://cronly.org/app.html#account');
  for (const [index, amount, product] of [[0, 1000, env.STRIPE_CREDIT_PRODUCT_ID], [1, grossUp(1000) - 1000, env.STRIPE_CARD_COST_PRODUCT_ID]]) {
    expect(body.get(`line_items[${index}][price_data][product]`)).toBe(product);
    expect(body.get(`line_items[${index}][price_data][unit_amount]`)).toBe(String(amount));
    expect(body.get(`line_items[${index}][price_data][currency]`)).toBe('usd');
    expect(body.get(`line_items[${index}][quantity]`)).toBe('1');
  }
  expect([...body.keys()].some(key => /product_data|recurring/.test(key))).toBe(false);
  expect((await rpc(env.ACCOUNTS, 'alice', 'account')).balance_microdollars).toBe(0);
});

it('refuses a missing, malformed or shared production product before contacting Stripe', async () => {
  for (const settings of [
    { STRIPE_CREDIT_PRODUCT_ID: undefined }, { STRIPE_CARD_COST_PRODUCT_ID: '' },
    { STRIPE_CREDIT_PRODUCT_ID: 'price_wrong' }, { STRIPE_CARD_COST_PRODUCT_ID: 'prod_bad/value' },
    { STRIPE_CARD_COST_PRODUCT_ID: 'prod_credit' }
  ]) {
    const { send, call } = await setup(settings);
    await expect(call()).rejects.toMatchObject({ code: 'payments_unavailable', status: 503 });
    expect(send).not.toHaveBeenCalled();
  }
});

it('keeps free quotes available before launch or payment catalog setup', async () => {
  const { send, call } = await setup({ LAUNCH_APPROVED: 'false', STRIPE_SECRET_KEY: undefined, STRIPE_CREDIT_PRODUCT_ID: undefined, STRIPE_CARD_COST_PRODUCT_ID: undefined });
  expect(await call(500, true)).toEqual({ credit_cents: 500, card_cost_cents: grossUp(500) - 500, total_cents: grossUp(500), cost_microdollars: 0 });
  await expect(call()).rejects.toMatchObject({ code: 'launch_pending', status: 503 });
  expect(send).not.toHaveBeenCalled();
});

it('enforces the new-account deposit cap before creating a Checkout session', async () => {
  const { send, call } = await setup();
  await expect(call(2001)).rejects.toMatchObject({ code: 'deposit_cap' });
  await expect(call(499)).rejects.toMatchObject({ code: 'invalid_deposit' });
  expect(send).not.toHaveBeenCalled();
});

it('keeps local Stripe tests compatible with inline products', async () => {
  const { send, call } = await setup({ ENVIRONMENT: 'local', STRIPE_CREDIT_PRODUCT_ID: undefined, STRIPE_CARD_COST_PRODUCT_ID: undefined });
  await call();
  const body = new URLSearchParams(send.mock.calls[0][1].body);
  expect(body.get('line_items[0][price_data][product_data][name]')).toBe('cronly prepaid credit');
  expect(body.get('line_items[1][price_data][product_data][name]')).toBe('Card payment cost (non-refundable)');
});
