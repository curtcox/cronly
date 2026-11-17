import assert from 'node:assert/strict';
import { price, PRICES } from '../src/utils/pricing.js';
const origin = process.env.CRONLY_ORIGIN || 'http://localhost:8787';
function localClient(user) {
  return async function api(path, method = 'GET', body, idempotency, expectedStatus = 200) {
    const response = await fetch(`${origin}${path}`, { method, signal: AbortSignal.timeout(15000), headers: { Authorization: `LocalDev ${user}`, 'Content-Type': 'application/json', ...(idempotency ? { 'Idempotency-Key': idempotency } : {}) }, body: body && JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, expectedStatus, `${path}: ${JSON.stringify(data)}`); return data;
  };
}
const api = localClient(`acceptance-${crypto.randomUUID()}`);
assert.equal((await api('/health')).environment, 'local');
await api('/api/dev/deposit', 'POST', { amount_microdollars: 5000000 }, 'fund');
const before = await api('/api/account');
await api('/api/variables/token?dry_run=1', 'PUT', { value: 'test' });
assert.equal((await api('/api/account')).balance_microdollars, before.balance_microdollars);
await api('/api/secrets/token', 'PUT', { value: 'acceptance-secret-"quoted"\\path\n\t雪' });
for (const [name, action] of Object.entries({
  http: { url: 'https://example.com' },
  constructor: { url: 'https://example.com' },
  // A UTF-8 snapshot above the compact-hold limit exercises standalone SQLite
  // reservations alongside the small HTTP, gateway and retry snapshots below.
  js: { type: 'javascript', source: 'export default async ctx => { console.log("x".repeat(5980) + ctx.secrets.token); return "y".repeat(5980) + ctx.secrets.token; }\n/*' + '😀'.repeat(2200) + '*/', cpu_ms: 100, subrequests: 0 },
  blocked: { type: 'javascript', source: 'export default async () => { await fetch("https://example.com"); }', cpu_ms: 100, subrequests: 0 },
  gateway: { type: 'javascript', source: 'export default async ctx => { console.log({ token: ctx.secrets.token }); const result = await ctx.fetch("https://example.com"); return { status: result.status }; }', cpu_ms: 100, subrequests: 1 },
  retry: { type: 'javascript', source: 'export default async ctx => { if (!ctx.run.id.endsWith(":retry")) throw new Error("retry"); return { event: ctx.input.event }; }', cpu_ms: 100, subrequests: 0 }
})) {
  await api(`/api/actions/${name}`, 'PUT', action); await api(`/api/jobs/${name}`, 'PUT', { action: name, cron: null, retries: name === 'retry' ? 1 : 0, ...(name === 'http' ? { overlap: 'allow' } : {}), ...(name === 'constructor' ? { budget: { day: PRICES.run, month: PRICES.run } } : {}) });
  await api(`/api/jobs/${name}/run`, 'POST', name === 'retry' ? { input: { event: 'acceptance-event' } } : {}, `run-${name}`);
}
// Independent jobs share an action version. Queue batches can claim both before
// either settles; real SQLite must grant only one paid activation across them.
for (const name of ['shared-left', 'shared-right']) await api(`/api/jobs/${name}`, 'PUT', { action: 'js', cron: null });
await Promise.all(['shared-left', 'shared-right'].map(name => api(`/api/jobs/${name}/run`, 'POST', {}, `run-${name}`)));
// The shared activity index must retain the HTTP cooldown after switching jobs.
// Replaying the original id stays free and cannot enqueue a second execution.
assert.equal((await api('/api/jobs/http/run', 'POST', {}, 'cooldown-http', 429)).code, 'run_rate_limit');
assert.equal((await api('/api/jobs/http/run', 'POST', {}, 'run-http')).duplicate, true);
const deadline = Date.now() + 60000; let runs;
while (Date.now() < deadline) {
  runs = (await api('/api/runs')).items;
  if (runs.length === 9 && runs.every(r => ['success', 'failure'].includes(r.status))) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.equal(runs.length, 9);
const details = await Promise.all(runs.map(run => api(`/api/runs/${encodeURIComponent(run.id)}`)));
assert(!JSON.stringify(details).includes('acceptance-secret'));
for (const { run } of details) {
  const summary = runs.find(item => item.id === run.id);
  for (const field of ['status', 'cost_microdollars', 'finished_at']) assert.equal(run[field], summary[field]);
  for (const field of ['completion', 'settlement', 'pending', 'retry', 'key_id', 'input']) assert(!Object.hasOwn(run, field));
}
assert(details.find(result => result.run.job === 'js').run.console.includes('«secret:token»'));
assert(details.find(result => result.run.job === 'js').run.return_value.includes('«secret:token»'));
assert(details.find(result => result.run.job === 'gateway').run.console.includes('«secret:token»'));
assert(details.find(result => result.run.job === 'gateway').run.return_value.includes('200'));
assert.equal(details.find(result => result.run.job === 'gateway').run.subrequests, 1);
for (const name of ['http', 'constructor', 'js', 'gateway', 'shared-left', 'shared-right']) assert.equal(runs.find(r => r.job === name).status, 'success', `${name} did not succeed`);
const sharedRuns = runs.filter(run => ['js', 'shared-left', 'shared-right'].includes(run.job));
const jsMaximum = price('run', { type: 'javascript', cpu_ms: 100, subrequests: 0 });
assert.equal(sharedRuns.reduce((sum, run) => sum + run.cost_microdollars, 0), 3 * jsMaximum - 2 * PRICES.jsActivation);
assert.equal(sharedRuns.filter(run => run.cost_microdollars === jsMaximum).length, 1);
for (const name of ['blocked']) assert.equal(runs.find(r => r.job === name).status, 'failure', `${name} escaped sandbox limits`);
const retryRuns = details.filter(result => result.run.job === 'retry').map(result => result.run);
assert.equal(retryRuns.length, 2);
assert.equal(retryRuns.find(run => !run.id.endsWith(':retry')).status, 'failure');
assert.equal(retryRuns.find(run => run.id.endsWith(':retry')).status, 'success');
assert(retryRuns.find(run => run.status === 'success').return_value.includes('acceptance-event'));
assert.equal(retryRuns.reduce((sum, run) => sum + run.cost_microdollars, 0), 2 * price('run', { type: 'javascript', cpu_ms: 100, subrequests: 0 }) - PRICES.jsActivation);
assert(retryRuns.every(run => !Object.hasOwn(run, 'retry') && !Object.hasOwn(run, 'completion')));
const account = await api('/api/account');
assert.equal(account.held_microdollars, 0);
assert.equal(account.spend_today_by_job.constructor, PRICES.run);
assert.equal(account.spend_by_job.constructor, PRICES.run);
const forecast = (await api('/api/projection')).jobs.find(job => job.job === 'constructor').monthly_microdollars;
// The current budget is spent, but a 30-day forecast can cross UTC month resets.
assert(Number.isSafeInteger(forecast) && forecast >= 0 && forecast <= 2 * PRICES.run);
const transactions = (await api('/api/transactions')).items;
const spent = -transactions.filter(row => row.kind !== 'deposit').reduce((sum, row) => sum + row.amount_microdollars, 0);
assert.equal(account.balance_microdollars, transactions.reduce((sum, row) => sum + row.amount_microdollars, 0));
assert.equal(transactions.filter(row => row.kind === 'run').length, 9);
assert.equal((await api('/api/costs')).total_microdollars, spent);
for (const group of ['job', 'action']) {
  const costs = await api(`/api/costs?group=${group}`);
  assert.equal(costs.total_microdollars, spent);
  assert.equal(costs.items.find(row => row.name === 'retry').cost_microdollars, retryRuns.reduce((sum, run) => sum + run.cost_microdollars, 0));
  assert.equal(costs.items.find(row => row.name === 'constructor').cost_microdollars, PRICES.run);
}
await api('/api/dev/deposit', 'POST', { amount_microdollars: 1000 }, 'top-up');
await api('/api/dev/deposit', 'POST', { amount_microdollars: 1000 }, 'top-up');
assert.equal((await api('/api/account')).balance_microdollars, account.balance_microdollars + 1000);
assert.equal((await api('/api/costs')).total_microdollars, spent);
// Force a ledger page to archive in real SQLite, then compare every financial row
// with the pre-archive result. No external payment or run is needed for this check.
const beforeArchive = (await api('/api/transactions')).items;
// Long, valid IDs reach the byte boundary with fewer than 120 requests/minute.
const archiveId = index => `archive-${index}`.padEnd(128, 'x');
for (let index = 0; index < 50; index++) await api('/api/dev/deposit', 'POST', { amount_microdollars: 1 }, archiveId(index));
const archived = (await api('/api/transactions')).items;
assert.equal(archived.length, beforeArchive.length + 50);
assert.deepEqual(archived.filter(row => !row.id.startsWith('archive-')), beforeArchive);
assert.equal(archived.reduce((sum, row) => sum + row.amount_microdollars, 0), account.balance_microdollars + 1050);
assert.equal((await api('/api/account')).balance_microdollars, account.balance_microdollars + 1050);
assert.equal((await api('/api/costs')).total_microdollars, spent);
await api('/api/dev/deposit', 'POST', { amount_microdollars: 1 }, archiveId(0));
assert.deepEqual((await api('/api/transactions')).items, archived);
await api('/api/jobs/no-budget', 'PUT', { action: 'http', cron: null, budget: { day: 0 } });
for (let index = 0; index < 3; index++) assert.equal((await api('/api/jobs/no-budget/run', 'POST', {}, `refused-${index}`, 402)).code, 'budget_day');
const pauses = (await api('/api/runs?job=no-budget')).items;
assert.equal(pauses.length, 1); assert.equal(pauses[0].status, 'paused'); assert.equal(pauses[0].cost_microdollars, 0);
assert.equal((await api('/api/account')).job_runtime['no-budget'].paused, 'budget_day');
await api('/api/actions/http', 'PUT', { url: 'https://example.com/edited' });
const synced = await api('/api/account');
for (const name of ['http', 'js', 'gateway']) assert.equal(synced.job_runtime[name].last_outcome, 'success');
assert.equal(synced.job_runtime.blocked.last_outcome, 'failure'); assert.equal(synced.held_microdollars, 0);
assert.equal(synced.job_runtime['no-budget'].paused, 'budget_day');
assert.deepEqual((await api('/api/runs?job=no-budget')).items, pauses);
// Exercise a real JobDO alarm, not just manual queue dispatch. Its budget bounds
// spending if acceptance fails before the final disable mutation can run. A fresh
// account keeps polling independent of the preceding ledger audit's rate window.
const scheduledApi = localClient(`schedule-${crypto.randomUUID()}`);
await scheduledApi('/api/dev/deposit', 'POST', { amount_microdollars: 10000 }, 'fund');
await scheduledApi('/api/actions/ping', 'PUT', { url: 'https://example.com' });
await scheduledApi('/api/jobs/scheduled', 'PUT', { action: 'ping', cron: '* * * * *', budget: { day: PRICES.run } });
const scheduledAt = (await scheduledApi('/api/account')).job_runtime.scheduled.next_fire;
const scheduledDeadline = scheduledAt + 30000;
let scheduled;
while (Date.now() < scheduledDeadline) {
  scheduled = (await scheduledApi('/api/runs?job=scheduled')).items;
  if (scheduled.some(run => run.status === 'success')) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.equal(scheduled.length, 1); assert.equal(scheduled[0].status, 'success');
assert.equal(scheduled[0].trigger, 'schedule'); assert.equal(Date.parse(scheduled[0].scheduled_at), scheduledAt);
assert.equal(scheduled[0].cost_microdollars, PRICES.run);
const scheduledAccount = await scheduledApi('/api/account');
assert.equal(scheduledAccount.job_runtime.scheduled.next_fire, scheduledAt + 60000);
assert.equal(scheduledAccount.job_runtime.scheduled.last_outcome, 'success');
assert.equal(scheduledAccount.held_microdollars, 0);
const scheduledLedger = (await scheduledApi('/api/transactions')).items.filter(row => row.kind === 'run' && row.job === 'scheduled');
assert.equal(scheduledLedger.length, 1); assert.equal(scheduledLedger[0].amount_microdollars, -PRICES.run);
await scheduledApi('/api/jobs/scheduled', 'PUT', { action: 'ping', cron: '* * * * *', enabled: false, budget: { day: PRICES.run } });
assert.equal((await scheduledApi('/api/account')).job_runtime.scheduled.next_fire, null);
console.log('Local acceptance passed: deposits, dry runs, HTTP, JS with large UTF-8 standalone and small compact reservations, one settled activation across three jobs sharing an action version, cross-job cooldowns and duplicate runs, constructor-named jobs/actions with numeric spend/costs and budget-capped forecasts, escaped-secret redaction before console/return truncation, native network denial, gateway, separately charged retries with preserved input, ledger/cost agreement, SQLite ledger archival and duplicate deposits across archive boundaries, one log for repeated budget refusals, preserved outcomes after configuration sync, and a real scheduled alarm with one charge, next-fire publication and final disable. CPU enforcement requires live acceptance (Miniflare does not enforce production CPU limits).');
