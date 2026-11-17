import { spawnSync } from 'node:child_process';
import { it, expect } from 'vitest';

const configuration = {
  CLOUDFLARE_API_TOKEN: 'fake-cloudflare-token', CLOUDFLARE_ACCOUNT_ID: 'fake-account', CLOUDFLARE_ANALYTICS_TOKEN: 'fake-analytics-token',
  CLERK_SECRET_KEY: 'fake-clerk-key', CLERK_PUBLISHABLE_KEY: 'fake-clerk-public', CLERK_WEBHOOK_SECRET: 'fake-clerk-webhook',
  STRIPE_SECRET_KEY: 'rk_live_fake', STRIPE_WEBHOOK_SECRET: 'fake-stripe-webhook',
  TOKEN_SIGNING_KEY: 'test-signing-key-with-at-least-32-bytes', SECRETS_MASTER_KEY: 'test-master-key-with-at-least-32-bytes', ANTHROPIC_API_KEY: 'fake-anthropic-key',
  STRIPE_CREDIT_PRODUCT_ID: 'prod_credit', STRIPE_CARD_COST_PRODUCT_ID: 'prod_cardcost'
};
const check = overrides => spawnSync(process.execPath, ['scripts/check-deployment-secrets.mjs'], { encoding: 'utf8', env: { ...configuration, ...overrides } });

it('accepts a complete deployment with a dedicated credit and card-cost catalog', () => {
  expect(check({}).status).toBe(0);
});

it('allows prelaunch deployment without prose but requires it before opening payments', () => {
  for (const LAUNCH_APPROVED of [undefined, '', 'false']) {
    expect(check({ ANTHROPIC_API_KEY: '', LAUNCH_APPROVED }).status).toBe(0);
  }
  const result = check({ ANTHROPIC_API_KEY: '', LAUNCH_APPROVED: 'true' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ANTHROPIC_API_KEY');
  expect(check({ LAUNCH_APPROVED: 'true' }).status).toBe(0);
});

it('requires the independent analytics token before deploying a service that would remain braked', () => {
  const result = check({ CLOUDFLARE_ANALYTICS_TOKEN: '' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('CLOUDFLARE_ANALYTICS_TOKEN');
  expect(result.stderr).not.toContain(configuration.CLOUDFLARE_API_TOKEN);
  expect(result.stderr).not.toContain(configuration.STRIPE_SECRET_KEY);
});

it('blocks deployment with missing or malformed catalog IDs without disclosing their values', () => {
  for (const name of ['STRIPE_CREDIT_PRODUCT_ID', 'STRIPE_CARD_COST_PRODUCT_ID']) {
    for (const value of ['', 'private-invalid-product']) {
      const result = check({ [name]: value });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(name);
      expect(result.stderr).not.toContain('private-invalid-product');
      expect(result.stderr).not.toContain(configuration.STRIPE_SECRET_KEY);
    }
  }
});

it('blocks a deployment that uses one product for both credit and non-refundable cost', () => {
  const result = check({ STRIPE_CARD_COST_PRODUCT_ID: configuration.STRIPE_CREDIT_PRODUCT_ID });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Stripe credit and card cost products must be distinct');
});
