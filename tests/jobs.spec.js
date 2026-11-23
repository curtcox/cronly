import { test, expect, login } from './helpers.js';
import { price } from '../src/utils/pricing.js';
// The workspace's own formatting (frontend/js/api.js dollars), so prices are not hardcoded.
const usd = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value / 1000000);

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
  await expect(page.locator('#js-price')).toContainText(usd(price('run', actions.small)));
  await page.getByLabel('CPU limit / milliseconds').fill('12');
  await page.getByLabel('Allowed subrequests').fill('1');
  const updated = price('run', { type: 'javascript', cpu_ms: 12, subrequests: 1 });
  await expect(page.locator('#js-price')).toContainText(usd(updated));
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
