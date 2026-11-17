import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PRICES } from '../src/utils/pricing.js';
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
