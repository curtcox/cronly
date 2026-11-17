import { afterEach, it, expect, vi } from 'vitest';
import Stripe from 'stripe';
import { stripeWebhook } from './payments.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { grossUp } from '../utils/cost-policy.js';
afterEach(() => vi.useRealTimers());
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

it('acknowledges a credited payment during a wake outage and resumes only balance-paused jobs after restart', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const env = { ENVIRONMENT: 'local', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', RUN_QUEUE: { send: vi.fn() } };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const account = (op, args) => rpc(env.ACCOUNTS, 'alice', op, args);
  await account('init', { account: 'alice' }); await account('deposit', { id: 'fund', amount: 1000 });
  await account('mutate', { account: 'alice', id: 'defs', operations: [
    { kind: 'actions', name: 'ping', value: { url: 'https://example.com' } },
    { kind: 'jobs', name: 'j', value: { action: 'ping', cron: '0 * * * *' } },
    { kind: 'jobs', name: 'limited', value: { action: 'ping', cron: '0 * * * *', budget: { day: 0 } } }
  ] });
  await account('sync-jobs');
  await expect(rpc(env.JOBS, 'alice:limited', 'start', { id: 'budget-pause', input: {}, trigger: 'manual' })).rejects.toMatchObject({ code: 'budget_day' });
  await account('reserve', { id: 'held', kind: 'prose', amount: 700 });
  await expect(rpc(env.JOBS, 'alice:j', 'start', { id: 'balance-pause', input: {}, trigger: 'manual' })).rejects.toMatchObject({ code: 'insufficient_balance' });
  const budgetPause = await rpc(env.JOBS, 'alice:limited', 'status');
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const event = { type: 'checkout.session.completed', data: { object: { id: 'cs1', mode: 'payment', payment_status: 'paid', currency: 'usd', amount_total: grossUp(500), client_reference_id: 'alice', metadata: { account: 'alice', product: 'cronly', credit_cents: '500' } } } };
  const request = () => { const payload = JSON.stringify(event); return new Request('https://cronly.org/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: env.STRIPE_WEBHOOK_SECRET }) }, body: payload }); };
  const fault = vi.spyOn(env.JOBS.get('alice:j'), 'fetch').mockRejectedValueOnce(new Error('wake unavailable'));
  expect(await stripeWebhook(request(), env)).toEqual({ received: true }); fault.mockRestore();
  expect(await stripeWebhook(request(), env)).toEqual({ received: true });
  const storage = env.ACCOUNTS.get('alice').storage;
  expect(await storage.get('wake:insufficient_balance')).toBeDefined();
  expect(await account('account')).toMatchObject({ balance_microdollars: 5000700, held_microdollars: 700 });
  vi.setSystemTime(await storage.getAlarm()); await storage.deleteAlarm();
  env.ACCOUNTS.objects.set('alice', new AccountDO({ storage }, env));
  await env.ACCOUNTS.get('alice').alarm();
  expect(await storage.get('wake:insufficient_balance')).toBeUndefined();
  expect(await rpc(env.JOBS, 'alice:j', 'status')).toMatchObject({ paused: null, next_fire: Date.parse('2026-11-16T13:00:00Z') });
  expect(await rpc(env.JOBS, 'alice:limited', 'status')).toEqual(budgetPause);
  expect(await account('account')).toMatchObject({ balance_microdollars: 5000700, held_microdollars: 700 });
  expect((await account('list', { prefix: 'ledger:' })).items.filter(row => row.id === 'cs1')).toHaveLength(1);
  expect(env.RUN_QUEUE.send).not.toHaveBeenCalled();
});
