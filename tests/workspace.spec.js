import { test, expect, login, apply } from './helpers.js';
import { PRICES } from '../src/utils/pricing.js';

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

test('links devicebasedauth.org from the account page and escapes credential details (S5)', async ({ page }) => {
  await login(page);
  await page.goto('/app.html#account');
  const section = page.locator('#dba');
  await expect(section.getByRole('heading', { name: 'devicebasedauth.org' })).toBeVisible();
  await expect(section).toContainText('Not linked');
  await expect(section).toContainText('dba enroll --aud cronly.org --action cronly:run');
  await expect(section).toContainText("import { DBA } from 'https://devicebasedauth.org/sdk/dba.js'");

  // Starting a link is quoted (one change) before cronly pays DBA for the sign-in.
  const started = [];
  await page.route('**/api/dba/link/start', async route => {
    if (new URL(route.request().url()).searchParams.get('dry_run') === '1') return route.continue();
    started.push(route.request().headers()['idempotency-key']);
    await route.fulfill({ json: { url: 'https://devicebasedauth.org/oauth/authorize?client_id=cronly.org', cost_microdollars: PRICES.change } });
  });
  await page.route('https://devicebasedauth.org/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>devicebasedauth.org sign-in</h1>' }));
  await section.getByRole('button', { name: 'Link devicebasedauth.org' }).click();
  await expect(page.locator('#review-price')).toContainText(`${PRICES.change} µ$`);
  expect(started).toEqual([]);
  await page.locator('#review-apply').click();
  await expect(page.getByRole('heading', { name: 'devicebasedauth.org sign-in' })).toBeVisible();
  expect(started).toHaveLength(1);

  // The callback page posts code + state once signed in, and removes them from the address bar.
  const posted = [];
  await page.route('**/api/dba/link/finish', async route => { posted.push(route.request().postDataJSON()); await route.fulfill({ json: { linked: true, dba_account: 'dba_<b>x</b>', linked_at: Date.parse('2026-11-18T12:00Z'), credentials: [], cost_microdollars: 0 } }); });
  await page.route('**/api/dba/link', route => route.fulfill({ json: { linked: true, superseded: false, dba_account: 'dba_<b>x</b>', linked_at: Date.parse('2026-11-18T12:00Z'), cost_microdollars: 0,
    credentials: [{ id: 'crd_TESTTESTTEST', device_id: 'dev_TESTTESTTEST', device_name: '<img src=x onerror="window.pwned=true">', monthly_spend_microdollars: 5000000, expires_at: Date.parse('2026-12-18T12:00Z') }] } }));
  await page.goto('/auth/dba/callback?code=one-time-code&state=the-state');
  await expect(page.locator('#notice')).toContainText('Linked devicebasedauth.org account dba_<b>x</b>.');
  expect(posted).toEqual([{ code: 'one-time-code', state: 'the-state' }]);
  expect(new URL(page.url()).pathname).toBe('/app.html');
  expect(new URL(page.url()).search).toBe('');
  await expect(section).toContainText('Linked to devicebasedauth.org account dba_<b>x</b>');
  await expect(section).toContainText('<img src=x onerror="window.pwned=true">');
  await expect(section).toContainText('$5.00 per UTC month');
  await expect(section.getByRole('button', { name: 'Unlink devicebasedauth.org' })).toBeVisible();
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});
