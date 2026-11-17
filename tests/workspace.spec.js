import { test, expect } from '@playwright/test';
import { PRICES } from '../src/utils/pricing.js';
async function login(page) {
  await page.goto('/app.html'); await page.getByLabel('Local account name').fill(`browser-${crypto.randomUUID()}`);
  await page.getByRole('button', { name: 'Use local account' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
}
async function apply(page) { await expect(page.getByRole('dialog')).toBeVisible(); await page.locator('#review-apply').click(); await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page.locator('body')).not.toHaveAttribute('data-applying', 'true'); }
test('serves every public page at its linked URL without redirects', async ({ request }) => {
  for (const path of ['/', '/index.html', '/app.html', '/pricing.html', '/docs/', '/docs/index.html', '/docs/agents.html', '/terms.html', '/privacy.html']) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(200);
    expect(response.headers()['content-type'], path).toContain('text/html');
  }
});
test('allows the blob workers required by Clerk without relaxing script policy', async ({ page }) => {
  await page.goto('/app.html');
  expect(await page.evaluate(() => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob(['postMessage("ready")'], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const timer = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(url); reject(new Error('Worker did not start')); }, 2000);
    worker.onmessage = event => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); };
  }))).toBe('ready');
});
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

test('pages run history with the stable cursor and keeps the active filters visible', async ({ page }) => {
  await login(page);
  const time = Date.parse('2026-11-16T12:00:00Z'); const cursor = 'stable-position';
  const runs = Array.from({ length: 102 }, (_, index) => ({ id: `retry-${String(101 - index).padStart(3, '0')}`, job: 'pinger', status: 'failure', created_at: time, cost_microdollars: PRICES.run }));
  const queries = [];
  await page.route(/\/api\/runs(?:\?.*)?$/, async route => {
    const params = new URL(route.request().url()).searchParams;
    if (!params.get('job')) return route.fulfill({ json: { items: [], summary: true, note: 'Filter by job to page complete retained logs.' } });
    queries.push(Object.fromEntries(params));
    const next = params.get('cursor') === cursor;
    return route.fulfill({ json: { items: next ? runs.slice(100) : runs.slice(0, 100), summary: false, next_cursor: next ? null : cursor, next_before: next ? null : time } });
  });
  await page.getByRole('link', { name: 'Runs', exact: true }).click();
  await page.getByLabel('Job', { exact: true }).fill('pinger');
  await page.getByRole('combobox', { name: 'Outcome', exact: true }).selectOption('failure');
  await page.getByLabel('From', { exact: true }).fill('2026-11-01');
  await page.getByLabel('To', { exact: true }).fill('2026-11-16');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page.locator('[data-run-detail]')).toHaveCount(100);
  await expect(page.getByRole('button', { name: 'Older runs' })).toHaveAttribute('data-runs-cursor', cursor);
  await page.getByRole('button', { name: 'Older runs' }).click();
  await expect(page.locator('[data-run-detail]')).toHaveCount(2);
  await expect(page.locator('[data-run-detail]').first()).toHaveAttribute('data-run-detail', 'retry-001');
  await expect(page.getByRole('button', { name: 'Older runs' })).toHaveCount(0);
  await expect(page.getByLabel('Job', { exact: true })).toHaveValue('pinger');
  await expect(page.getByRole('combobox', { name: 'Outcome', exact: true })).toHaveValue('failure');
  await expect(page.getByLabel('From', { exact: true })).toHaveValue('2026-11-01');
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('2026-11-16');
  expect(queries).toEqual([
    { job: 'pinger', status: 'failure', from: '2026-11-01', to: '2026-11-16' },
    { job: 'pinger', status: 'failure', from: '2026-11-01', to: '2026-11-16', cursor }
  ]);
});
