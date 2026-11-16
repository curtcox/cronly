import { pathToFileURL } from 'node:url';

/** Quote or rotate one account's secrets; the API key and plaintext never enter output. */
export async function rotateAccountSecrets({ origin, token, apply = false, request = fetch, log = console.log, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const url = new URL(origin);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use an HTTPS origin, or HTTP localhost for local testing');
  if (!token) throw new Error('CRONLY_API_KEY is required (read and secrets:write scopes)');
  async function api(path, method = 'GET', id) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await request(new URL(path, url), { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `ApiKey ${token}`, ...(id ? { 'Idempotency-Key': id } : {}) } });
      const data = await response.json();
      if (response.status === 429 && data.code === 'rate_limited' && attempt < 2) { log('Account request limit reached; waiting one minute before retrying.'); await pause(60000); continue; }
      if (!response.ok) throw new Error(`Rotation request refused (${response.status}, ${data.code || 'unknown_error'})`);
      return data;
    }
  }
  const config = await api('/api/config');
  let quote = 0; let cost = config.cost_microdollars || 0; let rotated = 0;
  const pending = [];
  for (const name of Object.keys(config.config.secrets)) {
    const result = await api(`/api/secrets/${encodeURIComponent(name)}/rotate?dry_run=1`, 'POST');
    quote += result.quote_microdollars;
    if (result.needs_rotation) pending.push(name);
  }
  log(`${pending.length} secrets need rotation; quoted changes: ${quote} micro-dollars. Config read: ${cost} micro-dollars.`);
  if (apply) for (const name of pending) {
    const result = await api(`/api/secrets/${encodeURIComponent(name)}/rotate`, 'POST', crypto.randomUUID());
    cost += result.cost_microdollars;
    if (result.rotated) rotated++;
  }
  if (apply) log(`Rotated ${rotated} secrets; total charged: ${cost} micro-dollars.`);
  else log('Quote only. Run with --apply to re-encrypt; each change reserves funds first.');
  return { pending: pending.length, rotated, quote_microdollars: quote, cost_microdollars: cost };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Usage: npm run secrets:rotate -- [--apply]');
    await rotateAccountSecrets({ origin: process.env.CRONLY_ORIGIN || 'https://cronly.org', token: process.env.CRONLY_API_KEY, apply: process.argv.includes('--apply') });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
