import assert from 'node:assert/strict';
assert(process.env.CRONLY_API_KEY, 'Set a capped read/run/change CRONLY_API_KEY through your secret manager.');
assert(process.env.CRONLY_LIVE_ACCEPTANCE === '1', 'Set CRONLY_LIVE_ACCEPTANCE=1 to authorize the paid, bounded live sandbox test (maximum $0.10).');
const origin = process.env.CRONLY_ORIGIN || 'https://cronly.org';
const name = `acceptance-${crypto.randomUUID().slice(0, 8)}`;
const headers = { Authorization: `ApiKey ${process.env.CRONLY_API_KEY}`, 'Content-Type': 'application/json' };
async function api(path, method = 'GET', body) {
  const response = await fetch(`${origin}${path}`, { method, headers: { ...headers, 'Idempotency-Key': `${name}:${method}:${path}`.slice(0, 128) }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await response.json(); assert(response.ok, `${path}: ${data.code || response.status}`); return data;
}
const action = { type: 'javascript', source: 'export default async function run() { let n=0; for(let i=0;i<100000000;i++) n+=Math.sqrt(i); return n; }', cpu_ms: 10, subrequests: 0 };
const quote = await api(`/api/actions/${name}?dry_run=1`, 'PUT', action); assert(quote.quote_microdollars <= 10000);
await api(`/api/actions/${name}`, 'PUT', action); await api(`/api/jobs/${name}`, 'PUT', { action: name, cron: null });
const runQuote = await api(`/api/jobs/${name}/run?dry_run=1`, 'POST', {}); assert(runQuote.quote_microdollars <= 10000);
await api(`/api/jobs/${name}/run`, 'POST', {});
let result; const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  result = (await api(`/api/runs?job=${name}`)).items[0];
  if (result && ['success', 'failure', 'expired'].includes(result.status)) break;
  await new Promise(resolve => setTimeout(resolve, 2000));
}
await api(`/api/jobs/${name}`, 'DELETE'); await api(`/api/actions/${name}`, 'DELETE');
assert.equal(result?.status, 'failure', 'CPU rejection was not observed; keep JS_LIVE_ACCEPTED disabled and investigate.');
console.log('Live configured CPU rejection observed. Confirm Cloudflare limit telemetry, gateway limits and isolation before enabling JS_LIVE_ACCEPTED.');
