import { test, expect } from '@playwright/test';
import { PRICES } from '../src/utils/pricing.js';
async function login(page) {
  await page.goto('/app.html'); await page.getByLabel('Local account name').fill(`browser-${crypto.randomUUID()}`);
  await page.getByRole('button', { name: 'Use local account' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
}
async function apply(page) { await expect(page.getByRole('dialog')).toBeVisible(); await page.locator('#review-apply').click(); await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page.locator('body')).not.toHaveAttribute('data-applying', 'true'); }
test('public site uses the logo and the workspace stays usable on mobile', async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Small actions. Right on time.' })).toBeVisible();
  await expect(page.locator('header img')).toHaveAttribute('src', '/logo.jpeg');
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  await expect(page.locator('#account-strip')).toContainText('Balance $0.00');
  await expect(page.locator('#workspace-nav')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('quotes before depositing or saving, escapes definitions and previews cron', async ({ page }) => {
  await login(page); await page.getByRole('link', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Review deposit' }).click();
  await expect(page.locator('#account-strip')).toContainText('Balance $0.00');
  await apply(page); await expect(page.locator('#account-strip')).toContainText('Balance $5.00');
  await page.getByRole('link', { name: 'Variables', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('greeting');
  await page.getByLabel('Value', { exact: true }).fill('<img src=x onerror="window.pwned=true">');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('greeting');
  expect(await page.locator('#definition-form').evaluate(form => ({ valid: form.checkValidity(), fields: [...form.elements].filter(el => !el.validity.valid).map(el => ({name:el.name, message:el.validationMessage, value:el.value})) }))).toEqual({valid:true, fields:[]});
  await page.getByRole('button', { name: /Review save/ }).click(); await expect(page.locator('#review-price')).toContainText('100 µ$');
  await apply(page); await expect(page.locator('.list')).toContainText('<img src=x');
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  await page.getByRole('link', { name: 'Actions', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('ping'); await page.getByLabel('URL', { exact: true }).fill('https://example.com');
  await page.getByRole('button', { name: /Review save/ }).click(); await apply(page); await expect(page.locator('.list')).toContainText('ping');
  await page.getByRole('link', { name: 'Jobs', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('pinger');
  await page.getByLabel('Cron (blank for on demand only)').fill('*/5 * * * *'); await expect(page.locator('#cron-preview')).toContainText('Every 5 minutes');
  await page.getByLabel('Cron (blank for on demand only)').fill('');
  await page.getByRole('button', { name: /Review save/ }).click(); await apply(page); await expect(page.locator('.list')).toContainText('pinger');
  await page.getByRole('button', { name: 'Run', exact: true }).click(); await apply(page); await expect(page.locator('#notice')).toContainText('Run queued');
  await page.getByRole('link', { name: 'Runs', exact: true }).click(); await expect(page.locator('table')).toContainText('pinger');
  await page.screenshot({ path: '/tmp/cronly-workspace.png', fullPage: true });
});

test('keeps balance visible across workspace pages and tests an action without a job', async ({ page }) => {
  await login(page);
  const user = await page.evaluate(() => sessionStorage.getItem('cronly-local-user'));
  const headers = { Authorization: `LocalDev ${user}` };
  await page.request.post('/api/dev/deposit', { headers, data: { amount_microdollars: 5000000 } });
  await page.request.put('/api/actions/ping', { headers, data: { url: 'https://example.com' } });
  for (const [link, heading] of [['Jobs', 'Jobs'], ['Actions', 'Actions'], ['Variables', 'Variables'], ['Secrets', 'Secrets'], ['Upcoming', 'Upcoming'], ['Runs', 'Runs'], ['Costs', 'Costs'], ['Ask', 'Ask cronly'], ['Account', 'Account'], ['Dashboard', 'Dashboard']]) {
    await page.getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.locator('#account-strip')).toBeVisible();
  }
  await page.getByRole('link', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Review test run', exact: true }).click();
  await expect(page.locator('#review-price')).toContainText(`${PRICES.run} µ$`); await apply(page);
  await expect(page.locator('#notice')).toContainText('Test queued');
});

test('shows zero spend and reviews changes for a constructor-named job', async ({ page }) => {
  await login(page);
  const user = await page.evaluate(() => sessionStorage.getItem('cronly-local-user'));
  const headers = { Authorization: `LocalDev ${user}` };
  expect((await page.request.post('/api/dev/deposit', { headers, data: { amount_microdollars: 5000000 } })).ok()).toBe(true);
  expect((await page.request.put('/api/actions/constructor', { headers, data: { url: 'https://example.com' } })).ok()).toBe(true);
  expect((await page.request.put('/api/jobs/constructor', { headers, data: { action: 'constructor', cron: null, budget: { day: 100 } } })).ok()).toBe(true);
  await page.getByRole('link', { name: 'Jobs', exact: true }).click();
  await expect(page.locator('.list')).toContainText('constructor');
  await expect(page.locator('.list')).toContainText('Today: $0.00 / $0.0001');
  await expect(page.locator('.list')).not.toContainText('NaN');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('#review-price')).toContainText('100 µ$'); await apply(page);
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume', exact: true }).click(); await apply(page);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
});
