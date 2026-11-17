import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PRICES, price } from '../src/utils/pricing.js';
// Keep each browser's local ingress bucket independent, as separate visitors are
// in production. Running the whole suite through one localhost IP exhausts it.
test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders({ 'CF-Connecting-IP': `2001:db8::${(testInfo.workerIndex + 1).toString(16)}:${(testInfo.line + 1).toString(16)}` });
});
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
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Review run price', exact: true }).click();
  await apply(page); await expect(page.locator('#notice')).toContainText('Run queued');
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
  await page.getByRole('button', { name: 'Review run price', exact: true }).click();
  await expect(page.locator('#review-price')).toContainText(`${PRICES.run} µ$`); await apply(page);
  await expect(page.locator('#notice')).toContainText('Test queued');
});

test('validates manual and action-test input before quoting and applies the reviewed input', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const user = await page.evaluate(() => sessionStorage.getItem('cronly-local-user'));
  const headers = { Authorization: `LocalDev ${user}` };
  expect((await page.request.post('/api/dev/deposit', { headers, data: { amount_microdollars: 5000000 } })).ok()).toBe(true);
  expect((await page.request.put('/api/actions/message', { headers, data: { url: 'https://example.com', method: 'POST', body: '{{input.message}}' } })).ok()).toBe(true);
  expect((await page.request.put('/api/jobs/messenger', { headers, data: { action: 'message', cron: null } })).ok()).toBe(true);
  const balance = async () => (await (await page.request.get('/api/account', { headers })).json()).balance_microdollars;
  const initialBalance = await balance();
  const calls = [];
  await page.route(/\/api\/(?:jobs\/messenger\/run|actions\/message\/test)(?:\?.*)?$/, async route => {
    const request = route.request(); const dry = new URL(request.url()).searchParams.has('dry_run');
    calls.push({ path: new URL(request.url()).pathname, dry, body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
    // Real reservation previews validate required fields; a stub prevents outbound
    // work so this browser test can inspect the exact confirmed dispatch payload.
    if (dry) await route.continue();
    else await route.fulfill({ json: { reserved_microdollars: PRICES.run } });
  });
  for (const kind of ['jobs', 'actions']) {
    await page.getByRole('link', { name: kind === 'jobs' ? 'Jobs' : 'Actions', exact: true }).click();
    if (kind === 'actions') await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const start = page.getByRole('button', { name: kind === 'jobs' ? 'Run' : 'Review test run', exact: true });
    const previousCalls = calls.length;
    await start.click();
    await page.locator('#run-input-cancel').click();
    expect(calls).toHaveLength(previousCalls);
    await start.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel('Input / JSON').fill('{');
    await page.getByRole('button', { name: 'Review run price', exact: true }).click();
    await expect(page.locator('#run-input-error')).toBeVisible();
    for (const input of [null, { message: 42 }, {}]) {
      await page.getByLabel('Input / JSON').fill(JSON.stringify(input));
      await page.getByRole('button', { name: 'Review run price', exact: true }).click();
      await expect(page.locator('#run-input-error')).toContainText(input === null || input.message === 42 ? 'invalid_input' : 'missing_input');
    }
    const input = { message: '<img src=x onerror="window.pwned=true">' };
    await page.getByLabel('Input / JSON').fill(JSON.stringify(input));
    await page.getByRole('button', { name: 'Review run price', exact: true }).click();
    await expect(page.locator('#review-price')).toContainText(`${PRICES.run} µ$`);
    await expect(page.locator('#review-detail')).toHaveText(JSON.stringify({ input }, null, 2));
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
    expect(await balance()).toBe(initialBalance);
    await apply(page);
    await expect(page.locator('#notice')).toContainText(kind === 'jobs' ? 'Run queued' : 'Test queued');
    const [preview, dispatch] = calls.slice(-2);
    expect(preview.dry).toBe(true); expect(dispatch.dry).toBe(false);
    expect(dispatch.body).toEqual({ input }); expect(preview.body).toEqual(dispatch.body);
    expect(dispatch.path).toBe(kind === 'jobs' ? '/api/jobs/messenger/run' : '/api/actions/message/test');
    expect(dispatch.key).toBeTruthy();
  }
  expect(calls.filter(call => !call.dry)).toHaveLength(2);
});

test('cancelling a pending run preview does not reopen confirmation', async ({ page }) => {
  await login(page);
  const user = await page.evaluate(() => sessionStorage.getItem('cronly-local-user'));
  const headers = { Authorization: `LocalDev ${user}` };
  await page.request.post('/api/dev/deposit', { headers, data: { amount_microdollars: 5000000 } });
  await page.request.put('/api/actions/ping', { headers, data: { url: 'https://example.com' } });
  await page.request.put('/api/jobs/pinger', { headers, data: { action: 'ping', cron: null } });
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  await page.route('**/api/jobs/pinger/run?dry_run=1', async route => {
    await ready;
    await route.fulfill({ json: { quote_microdollars: PRICES.run } });
  });
  await page.getByRole('link', { name: 'Jobs', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const request = page.waitForRequest('**/api/jobs/pinger/run?dry_run=1');
  await page.getByRole('button', { name: 'Review run price', exact: true }).click();
  await request;
  await page.locator('#run-input-cancel').click();
  release();
  await expect(page.locator('#run-input-quote')).toBeEnabled();
  await expect(page.locator('#review')).not.toBeVisible();
  await expect(page.locator('#run-input')).not.toBeVisible();
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

test('pages and exports complete job history with inclusive UTC dates and stable cursors', async ({ page }) => {
  await login(page);
  const time = Date.parse('2026-11-16T23:59:59.999Z'); const cursor = 'stable-position';
  const runs = Array.from({ length: 102 }, (_, index) => ({ id: `retry-${String(101 - index).padStart(3, '0')}`, job: 'pinger', status: 'failure', created_at: time, cost_microdollars: PRICES.run }));
  const queries = [];
  await page.route(/\/api\/runs(?:\?.*)?$/, async route => {
    const params = new URL(route.request().url()).searchParams;
    if (!params.get('job')) return route.fulfill({ json: { items: [], summary: true, note: 'Filter by job to page complete retained logs.' } });
    queries.push(Object.fromEntries(params));
    const next = params.get('cursor') === cursor;
    const matching = runs.filter(run => run.created_at >= Date.parse(params.get('from')) && run.created_at <= Date.parse(params.get('to')));
    return route.fulfill({ json: { items: next ? matching.slice(100) : matching.slice(0, 100), summary: false, next_cursor: next ? null : cursor, next_before: next ? null : time } });
  });
  await page.getByRole('link', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export shown summaries', exact: true })).toBeVisible();
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
  const filters = { job: 'pinger', status: 'failure', from: '2026-11-01T00:00:00.000Z', to: '2026-11-16T23:59:59.999Z' };
  expect(queries).toEqual([filters, { ...filters, cursor }]);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export job NDJSON', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('cronly-runs.ndjson');
  const exported = (await readFile(await download.path(), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(exported).toEqual(runs);
  expect(queries).toEqual([filters, { ...filters, cursor }, filters, { ...filters, cursor }]);
  await expect(page.locator('#notice')).toContainText('Exported 102 runs.');
  await expect(page.getByRole('button', { name: 'Export job NDJSON', exact: true })).toBeEnabled();
  await expect(page.locator('[data-run-detail]')).toHaveCount(2);
});

test('refuses partial run exports when an older page fails or repeats its cursor', async ({ page }) => {
  await login(page);
  const downloads = []; page.on('download', download => downloads.push(download));
  let failOlder = true;
  await page.route(/\/api\/runs(?:\?.*)?$/, async route => {
    const params = new URL(route.request().url()).searchParams;
    if (!params.get('job')) return route.fulfill({ json: { items: [], summary: true } });
    if (params.get('cursor') && failOlder) return route.fulfill({ status: 503, json: { error: 'History is temporarily unavailable', code: 'unavailable' } });
    return route.fulfill({ json: { items: [{ id: 'first', job: 'pinger', status: 'success' }], summary: false, next_cursor: 'stuck' } });
  });
  await page.getByRole('link', { name: 'Runs', exact: true }).click();
  await page.getByLabel('Job', { exact: true }).fill('pinger');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('button', { name: 'Export job NDJSON', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('History is temporarily unavailable');
  await expect(page.getByRole('button', { name: 'Export job NDJSON', exact: true })).toBeEnabled();
  expect(downloads).toHaveLength(0);
  failOlder = false;
  await page.getByRole('button', { name: 'Export job NDJSON', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('Export could not advance');
  await expect(page.getByRole('button', { name: 'Export job NDJSON', exact: true })).toBeEnabled();
  expect(downloads).toHaveLength(0);
});

test('pages permanent transactions without replacing account forms and retries failed pages', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const cursor = 'ledger:1794916800000:~0000000000000001:read:&"<older>';
  const queries = []; let fail = true;
  await page.route('**/api/transactions*', async route => {
    const position = new URL(route.request().url()).searchParams.get('cursor');
    queries.push(position);
    if (position && fail) return route.fulfill({ status: 503, json: { error: 'History temporarily unavailable', code: 'unavailable' } });
    return route.fulfill({ json: {
      items: [{ id: position ? '<img src=x onerror="window.pwned=true">' : 'newest-reference', kind: position ? 'read' : 'deposit', created_at: Date.parse('2026-11-17T12:00Z'), amount_microdollars: position ? -21 : 5000000 }],
      next_cursor: position ? null : cursor
    } });
  });
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page.locator('#transaction-history')).toContainText('newest-reference');
  await page.getByLabel('Name', { exact: true }).fill('unsaved-key');
  const older = page.getByRole('button', { name: 'Older transactions', exact: false });
  await older.click();
  await expect(page.locator('#notice')).toContainText('History temporarily unavailable');
  await expect(older).toBeEnabled();
  await expect(page.locator('#transaction-history')).toContainText('newest-reference');
  fail = false;
  await older.click();
  await expect(page.locator('#transaction-history')).toContainText('<img src=x onerror="window.pwned=true">');
  await expect(page.locator('#transaction-history')).toContainText('-$0.000021');
  await expect(older).toHaveCount(0);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('unsaved-key');
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  await page.getByRole('button', { name: 'Newest transactions', exact: true }).click();
  await expect(page.locator('#transaction-history')).toContainText('newest-reference');
  await expect(page.getByRole('button', { name: 'Newest transactions', exact: true })).toHaveCount(0);
  expect(queries).toEqual([null, cursor, cursor, null]);
});

for (const failed of [false, true]) test(`ignores a ${failed ? 'failed' : 'successful'} transaction page response after leaving and returning to Account`, async ({ page }) => {
  await login(page);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/transactions*', async route => {
    const older = new URL(route.request().url()).searchParams.has('cursor');
    if (older) await pending;
    if (older && failed) return route.fulfill({ status: 503, json: { error: 'Stale failure', code: 'unavailable' } });
    await route.fulfill({ json: { items: [{ id: older ? 'stale-reference' : 'current-reference', kind: 'deposit', amount_microdollars: 1000 }], next_cursor: older ? null : 'older' } });
  });
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page.locator('#transaction-history')).toContainText('current-reference');
  const oldButton = await page.getByRole('button', { name: 'Older transactions' }).elementHandle();
  const request = page.waitForRequest('**/api/transactions?cursor=older');
  await page.getByRole('button', { name: 'Older transactions' }).click();
  await request;
  await expect(page.getByRole('button', { name: 'Older transactions' })).toBeDisabled();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page.locator('#transaction-history')).toContainText('current-reference');
  const response = page.waitForResponse('**/api/transactions?cursor=older');
  release(); await response;
  await expect.poll(() => oldButton.evaluate(button => button.disabled)).toBe(false);
  await expect(page.locator('#transaction-history')).toContainText('current-reference');
  await expect(page.locator('#transaction-history')).not.toContainText('stale-reference');
  await expect(page.locator('#notice')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Older transactions' })).toBeEnabled();
});

test('filters historical costs by inclusive UTC dates and displays applied totals', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const queries = [];
  await page.route('**/api/costs*', async route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    queries.push(query);
    if (query.from > query.to) return route.fulfill({ status: 400, json: { error: 'Choose a valid UTC range', code: 'invalid_window' } });
    const from = query.from || '2026-10-18'; const to = query.to || '2026-11-17';
    const items = query.group === 'day' ? [{ name: '2026-11-17', cost_microdollars: 100 }] : query.group === 'job' ? [] : [{ name: '<img src=x onerror="window.pwned=true">', cost_microdollars: 450 }];
    await route.fulfill({ json: { group: query.group, from, to, items, total_microdollars: items.reduce((sum, item) => sum + item.cost_microdollars, 0) } });
  });
  await page.getByRole('link', { name: 'Costs', exact: true }).click();
  const from = page.getByLabel('From / UTC', { exact: true });
  const to = page.getByLabel('To / UTC', { exact: true });
  await expect(from).toHaveValue('2026-10-18'); await expect(to).toHaveValue('2026-11-17');
  await expect(page.locator('#costs-results')).toContainText('2026-10-18 through 2026-11-17');
  await expect(page.locator('#costs-results')).toContainText('Total $0.0001');
  await from.fill('2026-01-01'); await to.fill('2026-06-30');
  await page.getByRole('combobox', { name: 'Group', exact: true }).selectOption('action');
  await page.getByRole('button', { name: 'Show spend', exact: true }).click();
  await expect(page.locator('#costs-results')).toContainText('2026-01-01 through 2026-06-30, including both UTC days. Total $0.00045.');
  await expect(page.locator('#costs-results')).toContainText('<img src=x onerror="window.pwned=true">');
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  await from.fill('2026-07-01');
  await page.getByRole('button', { name: 'Show spend', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('Choose a valid UTC range');
  await expect(page.locator('#costs-results')).toContainText('2026-01-01 through 2026-06-30');
  await expect(page.getByRole('button', { name: 'Show spend', exact: true })).toBeEnabled();
  await from.fill('2026-01-01');
  await page.getByRole('combobox', { name: 'Group', exact: true }).selectOption('job');
  await page.getByRole('button', { name: 'Show spend', exact: true }).click();
  await expect(page.locator('#costs-results')).toContainText('No spend in this date range.');
  await expect(page.locator('#costs-results')).toContainText('Total $0.00');
  await expect(page.locator('#notice')).not.toBeVisible();
  expect(queries).toEqual([
    { group: 'day' },
    { group: 'action', from: '2026-01-01', to: '2026-06-30' },
    { group: 'action', from: '2026-07-01', to: '2026-06-30' },
    { group: 'job', from: '2026-01-01', to: '2026-06-30' }
  ]);
});

test.describe('upcoming windows in a non-UTC browser', () => {
  test.use({ timezoneId: 'America/Chicago' });

  test('shows local upcoming windows, complete totals and recoverable filter errors', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.setFixedTime(new Date('2026-11-17T12:34:56Z'));
    await login(page);
    const queries = []; let fail = false;
    await page.route('**/api/upcoming?*', async route => {
      const query = Object.fromEntries(new URL(route.request().url()).searchParams); queries.push(query);
      if (fail) return route.fulfill({ status: 503, json: { error: 'Schedule temporarily unavailable', code: 'unavailable' } });
      const filtered = query.from.startsWith('2026-11-18');
      await route.fulfill({ json: { items: filtered ? [] : [{ job: '<img src=x onerror="window.pwned=true">', scheduled_at: query.from, price_microdollars: 85 }], truncated: !filtered, window_total_microdollars: filtered ? 0 : 850, subtotal_microdollars: filtered ? 0 : 85 } });
    });
    await page.getByRole('link', { name: 'Upcoming', exact: true }).click();
    await expect(page.locator('#upcoming-results')).toContainText('Window maximum $0.00085');
    await expect(page.locator('#upcoming-results')).toContainText('Shown subtotal $0.000085');
    await expect(page.locator('#upcoming-results')).toContainText('The window maximum includes all starts');
    await expect(page.locator('#upcoming-results')).toContainText('<img src=x onerror="window.pwned=true">');
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
    const from = page.getByLabel('From', { exact: true }); const to = page.getByLabel('To', { exact: true });
    const initial = await from.inputValue();
    expect(queries[0].from).toBe(await from.evaluate(input => new Date(input.value).toISOString()));
    expect(queries[0].to).toBe(await to.evaluate(input => new Date(input.value).toISOString()));
    const submit = page.getByRole('button', { name: 'Show window', exact: true });
    await from.fill('2026-11-18T09:00'); await to.fill('2026-11-18T08:00');
    await submit.click(); await expect(page.locator('#notice')).toContainText('Choose an end after the start');
    expect(queries).toHaveLength(1);
    await to.fill('2027-01-01T10:00'); await submit.click();
    await expect(page.locator('#notice')).toContainText('at most 31 days'); expect(queries).toHaveLength(1);
    await to.fill('2026-11-18T10:00'); fail = true;
    await submit.click(); await expect(page.locator('#notice')).toContainText('Schedule temporarily unavailable');
    await expect(submit).toBeEnabled(); await expect(from).toHaveValue('2026-11-18T09:00');
    await expect(page.locator('#upcoming-results')).toContainText('Window maximum $0.00085');
    fail = false; await submit.click();
    await expect(page.locator('#upcoming-results')).toContainText('No scheduled starts in this window.');
    await expect(page.locator('#upcoming-results')).toContainText('Window maximum $0.00');
    await expect(page.locator('#upcoming-results')).toContainText('(end excluded)');
    await expect(page.locator('#notice')).not.toBeVisible();
    expect(queries[2]).toEqual({ from: '2026-11-18T15:00:00.000Z', to: '2026-11-18T16:00:00.000Z', limit: '100' });
    expect(initial).not.toBe('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  for (const failed of [false, true]) test(`ignores a ${failed ? 'failed' : 'successful'} upcoming filter response from an earlier visit`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-11-17T12:34:56Z'));
    await login(page);
    let release; const pending = new Promise(resolve => { release = resolve; });
    await page.route('**/api/upcoming?*', async route => {
      const old = new URL(route.request().url()).searchParams.get('from')?.startsWith('2026-11-18');
      if (old) await pending;
      if (old && failed) return route.fulfill({ status: 503, json: { error: 'Stale schedule failure', code: 'unavailable' } });
      await route.fulfill({ json: { items: [{ job: old ? 'stale-schedule' : 'current-schedule', scheduled_at: '2026-11-18T10:00:00Z', price_microdollars: 85 }], truncated: false, window_total_microdollars: 85, subtotal_microdollars: 85 } });
    });
    await page.getByRole('link', { name: 'Upcoming', exact: true }).click();
    await expect(page.locator('#upcoming-results')).toContainText('current-schedule');
    await page.getByLabel('From', { exact: true }).fill('2026-11-18T09:00');
    await page.getByLabel('To', { exact: true }).fill('2026-11-18T10:00');
    const button = await page.getByRole('button', { name: 'Show window' }).elementHandle();
    const request = page.waitForRequest(request => new URL(request.url()).searchParams.get('from')?.startsWith('2026-11-18'));
    await page.getByRole('button', { name: 'Show window' }).click(); await request;
    await expect(page.getByRole('button', { name: 'Show window' })).toBeDisabled();
    await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Upcoming', exact: true }).click();
    await expect(page.locator('#upcoming-results')).toContainText('current-schedule');
    release(); await expect.poll(() => button.evaluate(button => button.disabled)).toBe(false);
    await expect(page.locator('#upcoming-results')).not.toContainText('stale-schedule');
    await expect(page.locator('#notice')).not.toBeVisible();
  });

});

test('shows job pause reasons and settled UTC budget usage on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const jobs = Object.fromEntries(['constructor', 'scheduled', 'disabled', 'balance', 'day', 'month', 'safety', 'input', 'unknown'].map(name => [name, {
    action: 'ping', cron: name === 'constructor' ? null : '0 * * * *', timezone: 'UTC', enabled: name !== 'disabled',
    budget: name === 'constructor' ? {} : { day: 1000, month: 20000 }
  }]));
  jobs.month.budget.month = 0;
  let spent = false;
  const pauses = { balance: 'insufficient_balance', day: 'budget_day', month: 'budget_month', safety: 'cost_brake', input: 'missing_input', unknown: '<b>unsafe</b>' };
  await page.route('**/api/config', route => route.fulfill({ json: { config: { jobs, actions: {}, variables: {}, secrets: {} } } }));
  await page.route('**/api/account', route => route.fulfill({ json: {
    id: 'budget-browser', balance_microdollars: 5000000, held_microdollars: 85,
    spend_today_by_job: spent ? { constructor: 85, day: 900 } : {}, spend_by_job: spent ? { constructor: 170, day: 1900 } : {},
    job_runtime: Object.fromEntries(Object.entries(pauses).map(([name, paused]) => [name, { paused, next_fire: '2026-11-18T12:00:00Z', last_outcome: 'failure' }]))
  } }));
  await page.route('**/api/projection', route => route.fulfill({ json: { daily_microdollars: 0, monthly_microdollars: 0, runway_days: null, jobs: [] } }));
  await page.getByRole('link', { name: 'Jobs', exact: true }).click();
  const row = name => page.locator('.list li').filter({ has: page.locator('.list-title', { hasText: new RegExp(`^${name}$`) }) });
  await expect(row('constructor')).toContainText('On demand / webhook only');
  await expect(row('constructor')).toContainText('Today: $0.00 / no daily cap');
  await expect(row('constructor')).toContainText('This month: $0.00 / no monthly cap');
  await expect(row('scheduled').locator('.tag')).toHaveText('Scheduled');
  await expect(row('disabled').locator('.tag')).toHaveText('Disabled');
  for (const [name, pause] of Object.entries(pauses)) {
    await expect(row(name).locator('.tag')).toHaveText(`Paused: ${pause.replaceAll('_', ' ')}`);
    await expect(row(name)).toContainText('Next: — · Last: failure');
  }
  await expect(row('unknown').locator('b')).toHaveCount(0);
  await expect(row('month')).toContainText('This month: $0.00 / $0.00');
  await expect(page.locator('#content')).toContainText('Spend uses UTC days and months. Pending holds also count toward budget enforcement.');
  spent = true;
  await page.getByRole('link', { name: 'Variables', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Variables', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Jobs', exact: true }).click();
  await expect(row('constructor')).toContainText('Today: $0.000085 / no daily cap');
  await expect(row('constructor')).toContainText('This month: $0.00017 / no monthly cap');
  await expect(row('day')).toContainText('Today: $0.0009 / $0.001');
  await expect(row('day')).toContainText('This month: $0.0019 / $0.02');
  await expect(page.locator('.list')).not.toContainText('NaN');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('reviews escaped proposal diffs and the server application quote before a separate paid apply', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const calls = [];
  const unsafe = '<img src=x onerror="window.pwned=true">';
  const proposal = {
    id: 'prose:session:review', explanation: `Update greeting ${unsafe}`, expires_at: Date.now() + 86400000,
    cost_microdollars: 450, quote_microdollars: 700,
    operations: [{ kind: 'variables', name: 'greeting', value: { value: unsafe } }, { kind: 'variables', name: 'old', delete: true }],
    diff: [
      { kind: 'variables', name: 'greeting', operation: 'create', before: null, after: unsafe },
      { kind: 'variables', name: 'old', operation: 'delete', before: 'previous value', after: null }
    ]
  };
  await page.route('**/api/prose/change*', async route => {
    const dry = new URL(route.request().url()).searchParams.has('dry_run');
    calls.push({ type: 'prose', dry, body: route.request().postDataJSON() });
    await route.fulfill({ json: dry ? { quote_microdollars: 12345 } : proposal });
  });
  await page.route('**/api/changes/*/apply*', async route => {
    const request = route.request(); const dry = new URL(request.url()).searchParams.has('dry_run');
    calls.push({ type: 'apply', dry, body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
    await route.fulfill({ json: { quote_microdollars: 700, cost_microdollars: dry ? 0 : 700, changes: [{ kind: 'variables', name: 'greeting', operation: 'put' }, { kind: 'variables', name: 'old', operation: 'delete' }] } });
  });
  await page.getByRole('link', { name: 'Ask', exact: true }).click();
  await page.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('change');
  await page.getByLabel('What would you like to do?').fill('Update my greeting');
  await page.getByRole('button', { name: 'Review maximum price', exact: true }).click();
  await expect(page.locator('#review-price')).toContainText('12,345 µ$');
  expect(calls.filter(call => !call.dry)).toHaveLength(0);
  await apply(page);
  const result = page.locator('#ask-result');
  await expect(result).toContainText(`Update greeting ${unsafe}`);
  await expect(result.getByRole('heading', { name: 'Create variables/greeting' })).toBeVisible();
  await expect(result.getByRole('heading', { name: 'Delete variables/old' })).toBeVisible();
  await expect(result.locator('table').first().locator('td').nth(0)).toHaveText('Not present');
  await expect(result.locator('table').first().locator('td').nth(1)).toHaveText(JSON.stringify(unsafe));
  await expect(result.locator('table').last().locator('td').nth(0)).toHaveText('"previous value"');
  await expect(result.locator('table').last().locator('td').nth(1)).toHaveText('Not present');
  await expect(result).toContainText('Prose charged $0.00045. Application is a separate charge of $0.0007.');
  await expect(result).toContainText('Any account configuration change requires a new proposal.');
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(calls.filter(call => call.type === 'apply')).toHaveLength(0);
  await page.getByRole('button', { name: 'Review application · $0.0007', exact: true }).click();
  await expect(page.locator('#review-price')).toContainText('700 µ$');
  await page.locator('#review-cancel').click();
  await expect(result).toContainText('Proposed changes');
  expect(calls.filter(call => call.type === 'apply' && !call.dry)).toHaveLength(0);
  await page.getByRole('button', { name: 'Review application · $0.0007', exact: true }).click();
  await apply(page);
  await expect(page.locator('#notice')).toContainText('Applied. Charged $0.0007.');
  const applications = calls.filter(call => call.type === 'apply');
  expect(applications).toHaveLength(3);
  expect(applications.map(call => call.dry)).toEqual([true, true, false]);
  expect(applications.every(call => call.body.quote_microdollars === 700)).toBe(true);
  expect(applications[2].key).toBeTruthy();
});

test('shows a no-op proposal without an application button and preserves stale proposals on refusal', async ({ page }) => {
  await login(page);
  let empty = true;
  await page.route('**/api/prose/change*', async route => {
    const dry = new URL(route.request().url()).searchParams.has('dry_run');
    await route.fulfill({ json: dry ? { quote_microdollars: 1000 } : {
      id: 'proposal', explanation: empty ? 'Nothing needs changing.' : 'Set greeting.', cost_microdollars: 500,
      quote_microdollars: empty ? 0 : 100,
      operations: empty ? [] : [{ kind: 'variables', name: 'greeting', value: { value: 'hello' } }],
      diff: empty ? [] : [{ kind: 'variables', name: 'greeting', operation: 'create', before: null, after: 'hello' }]
    } });
  });
  const applications = [];
  await page.route('**/api/changes/proposal/apply*', async route => {
    applications.push(new URL(route.request().url()).searchParams.get('dry_run'));
    await route.fulfill({ status: 409, json: { error: 'Account changed; request a new proposal', code: 'stale_proposal' } });
  });
  await page.getByRole('link', { name: 'Ask', exact: true }).click();
  await page.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('change');
  await page.getByLabel('What would you like to do?').fill('Set greeting');
  await page.getByRole('button', { name: 'Review maximum price', exact: true }).click(); await apply(page);
  await expect(page.locator('#ask-result')).toContainText('No changes proposed.');
  await expect(page.locator('#apply-proposal')).toHaveCount(0);
  empty = false;
  await page.getByRole('button', { name: 'Review maximum price', exact: true }).click(); await apply(page);
  await page.getByRole('button', { name: 'Review application · $0.0001', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('stale_proposal');
  await expect(page.locator('#ask-result')).toContainText('Set greeting.');
  await expect(page.locator('#review')).not.toBeVisible();
  expect(applications).toEqual(['1']);
});

test('ignores prose previews and paid replies from an earlier Ask visit', async ({ page }) => {
  await login(page);
  let releasePreview; const previewReady = new Promise(resolve => { releasePreview = resolve; });
  let releasePaid; const paidReady = new Promise(resolve => { releasePaid = resolve; });
  let blockPreview = true;
  await page.route('**/api/prose/ask*', async route => {
    const dry = new URL(route.request().url()).searchParams.has('dry_run');
    if (dry && blockPreview) await previewReady;
    if (!dry) await paidReady;
    await route.fulfill({ json: dry ? { quote_microdollars: 1000 } : { answer: 'Earlier answer', citations: [], cost_microdollars: 500 } });
  });
  const visitAsk = async text => {
    await page.getByRole('link', { name: 'Ask', exact: true }).click();
    await page.getByLabel('What would you like to do?').fill(text);
  };
  await visitAsk('First question');
  const previewSent = page.waitForRequest('**/api/prose/ask?dry_run=1');
  await page.getByRole('button', { name: 'Review maximum price', exact: true }).click(); await previewSent;
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await visitAsk('Second question');
  const previewDone = page.waitForResponse('**/api/prose/ask?dry_run=1');
  releasePreview(); await previewDone;
  await expect(page.locator('#review')).not.toBeVisible();
  await expect(page.getByLabel('What would you like to do?')).toHaveValue('Second question');
  blockPreview = false;
  await page.getByRole('button', { name: 'Review maximum price', exact: true }).click();
  const paidSent = page.waitForRequest(request => new URL(request.url()).pathname === '/api/prose/ask' && !new URL(request.url()).search);
  await page.locator('#review-apply').click(); await paidSent;
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await visitAsk('Third question');
  releasePaid();
  await expect(page.locator('body')).not.toHaveAttribute('data-applying', 'true');
  await expect(page.locator('#ask-result')).toBeEmpty();
  await expect(page.getByLabel('What would you like to do?')).toHaveValue('Third question');
  await expect(page.locator('#notice')).not.toBeVisible();
});

async function translationJobs(page) {
  await login(page);
  const jobs = Object.fromEntries(['first', 'second'].map(name => [name, { action: 'ping', cron: null, timezone: 'UTC', enabled: true, overlap: 'skip', missed: 'skip', retries: 0, budget: {} }]));
  await page.route('**/api/config', route => route.fulfill({ json: { config: { jobs, actions: { ping: { type: 'http' } }, variables: {}, secrets: {} } } }));
  await page.route('**/api/jobs/*/triggers', route => route.fulfill({ json: { items: [] } }));
  await page.getByRole('link', { name: 'Jobs', exact: true }).click();
  await page.locator('[data-edit="first"]').click();
  await page.locator('#job-prose').fill('Weekdays at 7am');
  await page.getByLabel('Time zone', { exact: true }).fill('America/Chicago');
}
const translatedSchedule = {
  cron: '0 7 * * 1-5', timezone: 'America/Chicago', explanation: 'At 07:00 AM, Monday through Friday', confidence: 0.65,
  alternatives: ['Consider holidays too'], next_fires: ['2026-11-18T13:00:00Z', '2026-11-19T13:00:00Z', '2026-11-20T13:00:00Z', '2026-11-23T13:00:00Z', '2026-11-24T13:00:00Z'], cost_microdollars: 450
};

test('reviews translated cron, ambiguity, time zone and fires before explicitly updating and saving a draft', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await translationJobs(page);
  const calls = []; const unsafe = '<img src=x onerror="window.pwned=true">';
  await page.route('**/api/prose/to-cron*', async route => {
    const request = route.request(); const dry = new URL(request.url()).searchParams.has('dry_run');
    calls.push({ dry, body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
    await route.fulfill({ json: dry ? { quote_microdollars: 12345 } : { ...translatedSchedule, alternatives: [unsafe] } });
  });
  const saves = [];
  await page.route('**/api/jobs/first*', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    saves.push({ dry: new URL(route.request().url()).searchParams.has('dry_run'), body: route.request().postDataJSON() });
    await route.fulfill({ json: { quote_microdollars: 100, cost_microdollars: 100 } });
  });
  await page.getByRole('button', { name: 'Quote prose translation' }).click();
  await expect(page.locator('#review-price')).toContainText('12,345 µ$');
  await expect(page.locator('#review-detail')).toContainText('America/Chicago');
  await page.locator('#review-cancel').click();
  expect(calls.filter(call => !call.dry)).toHaveLength(0);
  await expect(page.locator('#job-cron')).toHaveValue('');
  await page.getByRole('button', { name: 'Quote prose translation' }).click(); await apply(page);
  const result = page.locator('#job-translation');
  await expect(result).toContainText('0 7 * * 1-5');
  await expect(result).toContainText('At 07:00 AM, Monday through Friday · America/Chicago');
  await expect(result).toContainText('Model confidence: 65%');
  await expect(result).toContainText(unsafe);
  await expect(result.locator('img')).toHaveCount(0);
  await expect(result.locator('ul').last().locator('li')).toHaveCount(5);
  await expect(result.locator('ul').last().locator('li').first()).toContainText('7:00:00 AM');
  await expect(result).toContainText('Translation charged $0.00045');
  await expect(page.locator('#job-cron')).toHaveValue('');
  expect(saves).toHaveLength(0);
  expect(calls.filter(call => !call.dry)).toHaveLength(1);
  expect(calls.at(-1).body).toEqual({ text: 'Weekdays at 7am', timezone: 'America/Chicago' });
  expect(calls.at(-1).key).toBeTruthy();
  await page.getByLabel('Time zone', { exact: true }).fill('UTC');
  await page.getByRole('button', { name: 'Use this schedule in the draft' }).click();
  await expect(page.locator('#job-cron')).toHaveValue(translatedSchedule.cron);
  await expect(page.locator('#job-timezone')).toHaveValue('America/Chicago');
  await expect(page.locator('#cron-preview')).toContainText('Monday through Friday');
  expect(saves).toHaveLength(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: /Review save/ }).click();
  await expect(page.locator('#review-price')).toContainText('100 µ$');
  await apply(page);
  expect(saves.map(save => save.dry)).toEqual([true, false]);
  expect(saves[1].body.cron).toBe(translatedSchedule.cron);
  expect(saves[1].body.timezone).toBe('America/Chicago');
});

for (const phase of ['preview', 'paid']) test(`ignores a translation ${phase} from an earlier job editor`, async ({ page }) => {
  await translationJobs(page);
  let release; const ready = new Promise(resolve => { release = resolve; });
  let finished; const done = new Promise(resolve => { finished = resolve; });
  await page.route('**/api/prose/to-cron*', async route => {
    const dry = new URL(route.request().url()).searchParams.has('dry_run');
    if (dry === (phase === 'preview')) await ready;
    await route.fulfill({ json: dry ? { quote_microdollars: 1000 } : translatedSchedule });
    if (dry === (phase === 'preview')) finished();
  });
  const oldButton = await page.getByRole('button', { name: 'Quote prose translation' }).elementHandle();
  const sent = page.waitForRequest(request => new URL(request.url()).pathname === '/api/prose/to-cron' && new URL(request.url()).searchParams.has('dry_run') === (phase === 'preview'));
  await page.getByRole('button', { name: 'Quote prose translation' }).click();
  if (phase === 'paid') { await expect(page.locator('#review')).toBeVisible(); await page.locator('#review-apply').click(); }
  await sent;
  await page.locator('[data-edit="second"]').click();
  await expect(page.getByRole('heading', { name: 'Edit second', exact: true })).toBeVisible();
  await page.locator('#job-cron').fill('15 9 * * *');
  release(); await done;
  await expect(page.locator('body')).not.toHaveAttribute('data-applying', 'true');
  await expect.poll(() => oldButton.evaluate(button => button.disabled)).toBe(false);
  await expect(page.locator('#review')).not.toBeVisible();
  await expect(page.locator('#job-translation')).toBeEmpty();
  await expect(page.locator('#job-cron')).toHaveValue('15 9 * * *');
  await expect(page.locator('#job-timezone')).toHaveValue('UTC');
  await expect(page.locator('#notice')).not.toBeVisible();
});

test('discards a translation quote when its prose changes and lets a failed quote be retried', async ({ page }) => {
  await translationJobs(page);
  let release; const ready = new Promise(resolve => { release = resolve; });
  let attempts = 0;
  await page.route('**/api/prose/to-cron*', async route => {
    attempts++;
    if (attempts === 1) await ready;
    if (attempts === 2) return route.fulfill({ status: 503, json: { error: 'Translation temporarily unavailable', code: 'unavailable' } });
    await route.fulfill({ json: { quote_microdollars: 1000 } });
  });
  const button = page.getByRole('button', { name: 'Quote prose translation' });
  const sent = page.waitForRequest('**/api/prose/to-cron?dry_run=1');
  await button.click(); await sent;
  await expect(button).toBeDisabled();
  await page.locator('#job-prose').fill('Every hour');
  release(); await expect(button).toBeEnabled();
  await expect(page.locator('#review')).not.toBeVisible();
  await button.click(); await expect(page.locator('#notice')).toContainText('Translation temporarily unavailable');
  await expect(button).toBeEnabled();
  await expect(page.locator('#job-prose')).toHaveValue('Every hour');
  await button.click(); await expect(page.locator('#review')).toBeVisible();
  await expect(page.locator('#review-detail')).toContainText('Every hour');
  expect(attempts).toBe(3);
});


test('derives read-only job run maxima from the selected action before saving budgets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const actions = {
    constructor: { type: 'http', url: 'https://example.com' },
    small: { type: 'javascript', cpu_ms: 11, subrequests: 0, source: 'export default async function run() {}' },
    large: { type: 'javascript', cpu_ms: 30000, subrequests: 50, source: 'export default async function run() {}' }
  };
  const job = { action: 'large', cron: null, timezone: 'UTC', enabled: true, overlap: 'skip', missed: 'skip', retries: 0, budget: { day: 10000, month: 100000 }, max_run_microdollars: 42 };
  await page.route('**/api/config', route => route.fulfill({ json: { config: { actions, jobs: { saved: job }, variables: {}, secrets: {} } } }));
  await page.route('**/api/jobs/saved/triggers', route => route.fulfill({ json: { items: [] } }));
  await page.getByRole('link', { name: 'Jobs', exact: true }).click();
  const maximum = page.getByRole('status', { name: 'Scheduled / manual run maximum', exact: true });
  const hook = page.getByRole('status', { name: 'Webhook run maximum', exact: true });
  const action = page.getByRole('combobox', { name: 'Action', exact: true });
  const expected = amount => `${amount.toLocaleString('en-US')} µ$ (${(amount / 1000000).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 })})`;
  await expect(maximum).toHaveText(expected(price('run', actions.constructor)));
  await expect(hook).toHaveText(expected(price('hook', actions.constructor)));
  await expect(maximum).toHaveJSProperty('tagName', 'OUTPUT');
  await page.getByLabel('Daily budget / µ$').fill('4000');
  await page.getByLabel('Monthly budget / µ$').fill('90000');
  for (const name of ['small', 'large', 'constructor']) {
    await action.selectOption(name);
    await expect(maximum).toHaveText(expected(price('run', actions[name])));
    await expect(hook).toHaveText(expected(price('hook', actions[name])));
    await expect(page.getByLabel('Daily budget / µ$')).toHaveValue('4000');
    await expect(page.getByLabel('Monthly budget / µ$')).toHaveValue('90000');
    if (name !== 'constructor') await expect(page.locator('#job-run-price-note')).toContainText('3,300 µ$ daily activation, held each run');
    else await expect(page.locator('#job-run-price-note')).not.toContainText('activation');
  }
  await page.locator('[data-edit="saved"]').click();
  await expect(maximum).toHaveText(expected(price('run', actions.large)));
  await expect(page.locator('#job-run-price-note')).toContainText('each retry needs its own hold and is billed separately');
  await action.selectOption('small');
  const saves = [];
  await page.route('**/api/jobs/saved*', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    saves.push(route.request().postDataJSON());
    await route.fulfill({ json: { quote_microdollars: 100, cost_microdollars: 100 } });
  });
  await page.getByRole('button', { name: /Review save/ }).click();
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ action: 'small', budget: { day: 10000, month: 100000 } });
  expect(saves[0]).not.toHaveProperty('max_run_microdollars');
  expect(saves[0]).not.toHaveProperty('job-run-price');
  await page.locator('#review-cancel').click();
  await page.getByRole('link', { name: 'Actions', exact: true }).click();
  await page.locator('[data-edit="small"]').click();
  await expect(page.locator('#js-price')).toContainText('$0.003386');
  await page.getByLabel('CPU limit / milliseconds').fill('12');
  await page.getByLabel('Allowed subrequests').fill('1');
  const updated = price('run', { type: 'javascript', cpu_ms: 12, subrequests: 1 });
  await expect(page.locator('#js-price')).toContainText(`$${(updated / 1000000).toFixed(6)}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('explains the missing action when no job run maximum can be derived', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Jobs', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Scheduled / manual run maximum', exact: true })).toHaveText('Choose an action');
  await expect(page.getByRole('status', { name: 'Webhook run maximum', exact: true })).toHaveText('Choose an action');
  await expect(page.locator('#job-run-price-note')).toHaveText('Create an action before configuring a job.');
  await expect(page.locator('#content')).not.toContainText('NaN');
});
