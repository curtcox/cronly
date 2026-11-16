import assert from 'node:assert/strict';
import { price, PRICES } from '../src/utils/pricing.js';
const origin = process.env.CRONLY_ORIGIN || 'http://localhost:8787';
const user = `acceptance-${crypto.randomUUID()}`;
async function api(path, method = 'GET', body, idempotency, expectedStatus = 200) {
  const response = await fetch(`${origin}${path}`, { method, signal: AbortSignal.timeout(15000), headers: { Authorization: `LocalDev ${user}`, 'Content-Type': 'application/json', ...(idempotency ? { 'Idempotency-Key': idempotency } : {}) }, body: body && JSON.stringify(body) });
  const data = await response.json(); assert.equal(response.status, expectedStatus, `${path}: ${JSON.stringify(data)}`); return data;
}
assert.equal((await api('/health')).environment, 'local');
await api('/api/dev/deposit', 'POST', { amount_microdollars: 5000000 }, 'fund');
const before = await api('/api/account');
await api('/api/variables/token?dry_run=1', 'PUT', { value: 'test' });
assert.equal((await api('/api/account')).balance_microdollars, before.balance_microdollars);
await api('/api/secrets/token', 'PUT', { value: 'acceptance-secret-"quoted"\\path\n\t雪' });
for (const [name, action] of Object.entries({
  http: { url: 'https://example.com' },
  // A UTF-8 snapshot above the compact-hold limit exercises standalone SQLite
  // reservations alongside the small HTTP, gateway and retry snapshots below.
  js: { type: 'javascript', source: 'export default async ctx => { console.log("x".repeat(5980) + ctx.secrets.token); return "y".repeat(5980) + ctx.secrets.token; }\n/*' + '😀'.repeat(2200) + '*/', cpu_ms: 100, subrequests: 0 },
  blocked: { type: 'javascript', source: 'export default async () => { await fetch("https://example.com"); }', cpu_ms: 100, subrequests: 0 },
  gateway: { type: 'javascript', source: 'export default async ctx => { console.log({ token: ctx.secrets.token }); const result = await ctx.fetch("https://example.com"); return { status: result.status }; }', cpu_ms: 100, subrequests: 1 },
  retry: { type: 'javascript', source: 'export default async ctx => { if (!ctx.run.id.endsWith(":retry")) throw new Error("retry"); return { event: ctx.input.event }; }', cpu_ms: 100, subrequests: 0 }
})) {
  await api(`/api/actions/${name}`, 'PUT', action); await api(`/api/jobs/${name}`, 'PUT', { action: name, cron: null, retries: name === 'retry' ? 1 : 0, ...(name === 'http' ? { overlap: 'allow' } : {}) });
  await api(`/api/jobs/${name}/run`, 'POST', name === 'retry' ? { input: { event: 'acceptance-event' } } : {}, `run-${name}`);
}
// The shared activity index must retain the HTTP cooldown after switching jobs.
// Replaying the original id stays free and cannot enqueue a second execution.
assert.equal((await api('/api/jobs/http/run', 'POST', {}, 'cooldown-http', 429)).code, 'run_rate_limit');
assert.equal((await api('/api/jobs/http/run', 'POST', {}, 'run-http')).duplicate, true);
const deadline = Date.now() + 60000; let runs;
while (Date.now() < deadline) {
  runs = (await api('/api/runs')).items;
  if (runs.length === 6 && runs.every(r => ['success', 'failure'].includes(r.status))) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.equal(runs.length, 6);
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
for (const name of ['http', 'js', 'gateway']) assert.equal(runs.find(r => r.job === name).status, 'success', `${name} did not succeed`);
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
const transactions = (await api('/api/transactions')).items;
const spent = -transactions.filter(row => row.kind !== 'deposit').reduce((sum, row) => sum + row.amount_microdollars, 0);
assert.equal(account.balance_microdollars, transactions.reduce((sum, row) => sum + row.amount_microdollars, 0));
assert.equal(transactions.filter(row => row.kind === 'run').length, 6);
assert.equal((await api('/api/costs')).total_microdollars, spent);
for (const group of ['job', 'action']) {
  const costs = await api(`/api/costs?group=${group}`);
  assert.equal(costs.total_microdollars, spent);
  assert.equal(costs.items.find(row => row.name === 'retry').cost_microdollars, retryRuns.reduce((sum, run) => sum + run.cost_microdollars, 0));
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
console.log('Local acceptance passed: deposits, dry runs, HTTP, JS with large UTF-8 standalone and small compact reservations, cross-job cooldowns and duplicate runs, escaped-secret redaction before console/return truncation, native network denial, gateway, separately charged retries with preserved input, ledger/cost agreement, SQLite ledger archival and duplicate deposits across archive boundaries. CPU enforcement requires live acceptance (Miniflare does not enforce production CPU limits).');
