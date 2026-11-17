import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

/** Wait for the public release, then make at most one optional billed account read. */
export async function verifyProduction(env = process.env, { fetchImpl = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 6, delay = 2000 } = {}) {
  let origin;
  try { origin = new URL(env.CRONLY_ORIGIN || 'https://cronly.org'); }
  catch { assert(false, 'CRONLY_ORIGIN must be an HTTPS origin.'); }
  assert(origin.protocol === 'https:' && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'CRONLY_ORIGIN must be an HTTPS origin.');
  assert(Number.isInteger(attempts) && attempts >= 1 && attempts <= 10 && Number.isFinite(delay) && delay >= 0 && delay <= 10000, 'Invalid verification retry limits.');
  if (env.EXPECTED_GIT_SHA) assert(/^[a-f0-9]{40}$/.test(env.EXPECTED_GIT_SHA), 'EXPECTED_GIT_SHA must be a full release SHA.');

  async function request(path, authorization, status = 200, json = false) {
    let response;
    try {
      response = await fetchImpl(new URL(path, origin).href, {
        signal: AbortSignal.timeout(15000), redirect: 'manual', cache: 'no-store',
        headers: authorization ? { Authorization: authorization } : {}
      });
    } catch { assert(false, `${path}: request failed`); }
    if (response.status !== status) {
      await response.body?.cancel().catch(() => {});
      assert(false, `${path}: HTTP ${response.status}, expected ${status}`);
    }
    if (json) {
      try { return await response.json(); }
      catch { assert(false, `${path}: invalid JSON`); }
    }
    await response.body?.cancel().catch(() => {});
  }

  async function publicChecks() {
    const health = await request('/health', undefined, 200, true);
    assert(health?.environment === 'production', '/health: expected production environment');
    assert(/^[a-f0-9]{40}$/.test(health.git_sha), '/health: missing release SHA');
    if (env.EXPECTED_GIT_SHA) assert(health.git_sha === env.EXPECTED_GIT_SHA, '/health: release has not propagated');
    const configuration = await request('/api/public/config', undefined, 200, true);
    assert(configuration?.local === false && /^pk_live_/.test(configuration.clerk_publishable_key), '/api/public/config: live Clerk configuration has not propagated');
    const contract = await request('/openapi.json', undefined, 200, true);
    assert(contract?.openapi === '3.1.0', '/openapi.json: expected OpenAPI 3.1.0');
    for (const path of ['/', '/app.html', '/pricing.html', '/docs/index.html', '/docs/agents.html', '/llms.txt', '/sdk/v1/cronly.js', '/terms.html', '/privacy.html']) await request(path);
    await request('/api/account', undefined, 401);
    await request('/api/account', 'LocalDev production-check', 401);
  }

  for (let attempt = 1; ; attempt++) {
    try { await publicChecks(); break; }
    catch (error) {
      if (attempt >= attempts) throw error;
      await wait(delay);
    }
  }
  // A lost response may already have incurred a charge. Public propagation retries
  // must never replay this read, and redirects must never forward its credential.
  if (env.CRONLY_API_KEY) {
    const balance = await request('/api/account', `ApiKey ${env.CRONLY_API_KEY}`, 200, true);
    assert(Number.isSafeInteger(balance?.balance_microdollars) && balance.balance_microdollars >= 0, '/api/account: invalid balance');
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await verifyProduction();
    console.log('Production read-only verification passed. Real payment, signed webhooks, live JS CPU limit and prose eval remain separate acceptance steps.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
