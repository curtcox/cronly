import assert from 'node:assert/strict';
const origin = process.env.CRONLY_ORIGIN || 'https://cronly.org';
async function get(path, authenticated = false) {
  const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(15000), headers: authenticated ? { Authorization: `ApiKey ${process.env.CRONLY_API_KEY}` } : {} });
  assert(response.ok, `${path}: HTTP ${response.status}`); return response;
}
const health = await (await get('/health')).json(); assert.equal(health.environment, 'production'); assert.match(health.git_sha, /^[a-f0-9]{40}$/);
if (process.env.EXPECTED_GIT_SHA) assert.equal(health.git_sha, process.env.EXPECTED_GIT_SHA);
const configuration = await (await get('/api/public/config')).json(); assert.equal(configuration.local, false); assert.match(configuration.clerk_publishable_key, /^pk_live_/);
const contract = await (await get('/openapi.json')).json(); assert.equal(contract.openapi, '3.1.0');
for (const path of ['/', '/app.html', '/pricing.html', '/docs/index.html', '/docs/agents.html', '/llms.txt', '/sdk/v1/cronly.js', '/terms.html', '/privacy.html']) await get(path);
const unauthorized = await fetch(`${origin}/api/account`, { signal: AbortSignal.timeout(15000) }); assert.equal(unauthorized.status, 401);
const local = await fetch(`${origin}/api/account`, { headers: { Authorization: 'LocalDev production-check' }, signal: AbortSignal.timeout(15000) }); assert.equal(local.status, 401);
if (process.env.CRONLY_API_KEY) { const balance = await (await get('/api/account', true)).json(); assert(Number.isSafeInteger(balance.balance_microdollars) && balance.balance_microdollars >= 0); }
console.log('Production read-only verification passed. Real payment, signed webhooks, live JS CPU limit and prose eval remain separate acceptance steps.');
