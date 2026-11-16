import assert from 'node:assert/strict';
const origin = process.env.CRONLY_ORIGIN || 'http://localhost:8787';
const user = `acceptance-${crypto.randomUUID()}`;
async function api(path, method = 'GET', body, idempotency) {
  const response = await fetch(`${origin}${path}`, { method, signal: AbortSignal.timeout(15000), headers: { Authorization: `LocalDev ${user}`, 'Content-Type': 'application/json', ...(idempotency ? { 'Idempotency-Key': idempotency } : {}) }, body: body && JSON.stringify(body) });
  const data = await response.json(); assert(response.ok, `${path}: ${JSON.stringify(data)}`); return data;
}
assert.equal((await api('/health')).environment, 'local');
await api('/api/dev/deposit', 'POST', { amount_microdollars: 5000000 }, 'fund');
const before = await api('/api/account');
await api('/api/variables/token?dry_run=1', 'PUT', { value: 'test' });
assert.equal((await api('/api/account')).balance_microdollars, before.balance_microdollars);
await api('/api/secrets/token', 'PUT', { value: 'acceptance-secret' });
for (const [name, action] of Object.entries({
  http: { url: 'https://example.com' },
  js: { type: 'javascript', source: 'export default async ctx => { console.log(ctx.secrets.token); return { ok: true }; }', cpu_ms: 100, subrequests: 0 },
  blocked: { type: 'javascript', source: 'export default async () => { await fetch("https://example.com"); }', cpu_ms: 100, subrequests: 0 },
  gateway: { type: 'javascript', source: 'export default async ctx => { const result = await ctx.fetch("https://example.com"); return { status: result.status }; }', cpu_ms: 100, subrequests: 1 }
})) {
  await api(`/api/actions/${name}`, 'PUT', action); await api(`/api/jobs/${name}`, 'PUT', { action: name, cron: null });
  await api(`/api/jobs/${name}/run`, 'POST', {}, `run-${name}`);
}
const deadline = Date.now() + 60000; let runs;
while (Date.now() < deadline) {
  runs = (await api('/api/runs')).items;
  if (runs.length === 4 && runs.every(r => ['success', 'failure'].includes(r.status))) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.equal(runs.length, 4); assert(!JSON.stringify(runs).includes('acceptance-secret'));
for (const name of ['http', 'js', 'gateway']) assert.equal(runs.find(r => r.job === name).status, 'success', `${name} did not succeed`);
for (const name of ['blocked']) assert.equal(runs.find(r => r.job === name).status, 'failure', `${name} escaped sandbox limits`);
assert.equal((await api('/api/account')).held_microdollars, 0);
console.log('Local acceptance passed: deposits, dry runs, HTTP, JS, redaction, native network denial, and gateway. CPU enforcement requires live acceptance (Miniflare does not enforce production CPU limits).');
