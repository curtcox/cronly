import { test, expect } from './helpers.js';
import { PRICES } from '../src/utils/pricing.js';

// S5 Stage B: the workspace signed in with a devicebasedauth.org device session. A stub stands in
// for the vendored SDK (same exports and the methods the workspace uses), so this checks the
// page wiring without a DBA issuer; the server side of device sessions is covered by
// src/auth/dba-session.test.js. The stub authenticates as a local account and records each call.
const stub = account => `
const KEY = 'stub-dba-state';
const load = () => JSON.parse(localStorage.getItem(KEY) || 'null');
window.__dba = window.__dba || { requests: [], enrolled: [], forgotten: 0, renewing: 0 };
export class DBA {
  constructor(options) { this.options = options; this.state = null; }
  async ready() { this.state = load(); return !!this.state; }
  get payload() { return this.state && { acct: 'dba_stub', cid: 'crd_stub0001', exp: Math.floor(Date.now() / 1000) + 3600, device: { name: 'Stub browser' }, grants: this.state.grants }; }
  async enroll(request) {
    window.__dba.enrolled.push({ request, options: this.options });
    this.state = { grants: request.grants }; localStorage.setItem(KEY, JSON.stringify(this.state));
    return 'credential';
  }
  autoRenew() { window.__dba.renewing += 1; }
  async forget() { window.__dba.forgotten += 1; this.state = null; localStorage.removeItem(KEY); }
  async fetchWithGates(input, init = {}) {
    window.__dba.requests.push(String(input));
    return fetch(input, { ...init, headers: { ...init.headers, Authorization: 'LocalDev ${account}' } });
  }
}
export class DBAError extends Error {}
export const VERSION = 'stub';
export const describeGrant = () => '';
`;

test('signs in with a devicebasedauth.org device, keeps it across visits and deletes it on sign out', async ({ page }) => {
  const account = `device-${crypto.randomUUID()}`;
  await page.route('**/vendor/devicebasedauth.js', route => route.fulfill({ contentType: 'text/javascript', body: stub(account) }));
  await page.goto('/app.html');
  await expect(page.getByRole('heading', { name: 'Use a device key' })).toBeVisible();
  await expect(page.locator('#content')).toContainText(`each read the workspace makes costs ${PRICES.read + PRICES.dbaRequest} µ$`);
  await page.getByRole('button', { name: 'Sign in with devicebasedauth.org' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  const enrolled = await page.evaluate(() => window.__dba.enrolled);
  expect(enrolled).toEqual([{ request: { aud: ['cronly.org'], grants: [{ actions: ['cronly:session'] }] }, options: { origin: 'https://devicebasedauth.org', name: 'cronly-workspace' } }]);
  // Every workspace request went through the device client.
  expect((await page.evaluate(() => window.__dba.requests)).length).toBeGreaterThanOrEqual(3);

  // The Account page leaves out what a device session cannot do (ACCOUNT_SESSION routes).
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'This device' })).toBeVisible();
  await expect(page.locator('#this-device')).toContainText('Stub browser');
  await expect(page.locator('#content')).toContainText('create and revoke API keys');
  await expect(page.locator('#key-form')).toHaveCount(0);
  await expect(page.locator('#dba-link')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review deposit' })).toBeVisible();

  // A later visit signs in with the saved device, without asking.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
  await expect(page.locator('#local-login')).toHaveCount(0);
  expect(await page.evaluate(() => window.__dba.enrolled.length)).toBe(0);

  // Signing out deletes the key; the next visit shows the sign-in choices without loading the SDK.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#local-login')).toBeVisible();
  expect(await page.evaluate(() => [localStorage.getItem('stub-dba-state'), localStorage.getItem('cronly-device-session')])).toEqual([null, null]);
});

test('forgets a device session whose credential is gone and shows the sign-in choices', async ({ page }) => {
  await page.route('**/vendor/devicebasedauth.js', route => route.fulfill({ contentType: 'text/javascript', body: stub('unused') }));
  await page.goto('/app.html'); await expect(page.locator('#local-login')).toBeVisible();
  await page.evaluate(() => localStorage.setItem('cronly-device-session', '1'));
  await page.reload();
  await expect(page.locator('#local-login')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cronly-device-session'))).toBeNull();
});

test('loads the real vendored SDK from cronly\'s own origin under the workspace CSP', async ({ page }) => {
  await page.goto('/app.html'); await expect(page.locator('#local-login')).toBeVisible();
  const loaded = await page.evaluate(async () => {
    const sdk = await import('/vendor/devicebasedauth.js');
    const dba = new sdk.DBA({ origin: 'https://devicebasedauth.org', name: 'e2e-probe' });
    return { version: sdk.VERSION, ready: await dba.ready(), methods: ['enroll', 'fetchWithGates', 'autoRenew', 'forget'].every(name => typeof dba[name] === 'function') };
  });
  expect(loaded).toEqual({ version: '1.4.0', ready: false, methods: true });
});
