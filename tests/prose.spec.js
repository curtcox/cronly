import { test, expect, login, apply } from './helpers.js';

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
