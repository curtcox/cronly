import { assert } from '../utils/errors.js';
import { validateTemplates, references } from '../executor/templates.js';
import { validateDestination } from '../executor/destinations.js';
import { cron } from './cron.js';
import { price } from '../utils/pricing.js';
import { money } from '../durable-objects/ledger.js';
import { COST_POLICY } from '../utils/cost-policy.js';
export const COLLECTIONS = ['variables', 'secrets', 'actions', 'jobs'];
/** Keep the same addressable name grammar across every definition. */
export function validateName(name) { assert(typeof name === 'string' && /^[a-z0-9-]{1,64}$/.test(name), 'invalid_name', 'Names must contain 1–64 lowercase letters, numbers or hyphens'); return name; }
/** Normalize definitions before atomic reference validation. */
export function normalize(kind, value) {
  if (kind === 'variables' || kind === 'secrets') {
    assert(typeof value?.value === 'string' && value.value.length <= 8192 && (kind !== 'secrets' || value.value.length > 0), 'invalid_value', 'Expected a string value up to 8192 characters');
    return value.value;
  }
  assert(value && typeof value === 'object' && !Array.isArray(value), 'invalid_definition', 'Expected an object');
  if (kind === 'actions') {
    if (value.type === 'javascript') {
      assert(typeof value.source === 'string' && new TextEncoder().encode(value.source).length <= 262144, 'invalid_source', 'Source must be at most 256 KB');
      assert(Number.isInteger(value.cpu_ms) && value.cpu_ms >= 10 && value.cpu_ms <= 30000, 'invalid_limits', 'CPU limit must be 10–30000 ms');
      assert(Number.isInteger(value.subrequests) && value.subrequests >= 0 && value.subrequests <= 50, 'invalid_limits', 'Subrequest limit must be 0–50');
      return { type: 'javascript', source: value.source, cpu_ms: value.cpu_ms, subrequests: value.subrequests };
    }
    assert(value.type === undefined || value.type === 'http', 'invalid_type', 'Expected http or javascript action');
    const method = value.method || 'GET'; const timeout = value.timeout_seconds ?? 10;
    assert(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method), 'invalid_method', 'Invalid HTTP method');
    assert(Number.isInteger(timeout) && timeout >= 1 && timeout <= 30, 'invalid_timeout', 'Timeout must be 1–30 seconds');
    assert(typeof value.url === 'string' && value.url.length <= 8192, 'invalid_url', 'Expected a URL');
    // Resolve variable-only URLs during cross-reference validation; secrets cannot choose hosts.
    const hostTemplate = value.url.split('/').slice(0, 3).join('/');
    assert(!references(hostTemplate).some(r => ['secret', 'input'].includes(r.type)), 'invalid_url', 'Secrets and webhook input cannot choose a destination host');
    assert(value.headers === undefined || (value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers) && Object.entries(value.headers).every(([k, v]) => /^[a-zA-Z0-9-]+$/.test(k) && !['host', 'connection', 'upgrade', 'content-length', 'transfer-encoding'].includes(k.toLowerCase()) && typeof v === 'string' && !/[\r\n]/.test(v))), 'invalid_headers', 'Invalid headers');
    // Saved GET/HEAD actions include an empty body; exports must remain valid input.
    assert(value.body === undefined || (typeof value.body === 'string' && value.body.length <= 32768 && (value.body.length === 0 || !['GET', 'HEAD'].includes(method))), 'invalid_body', 'Invalid HTTP body');
    const success = value.success_status || [[200, 299]];
    assert(Array.isArray(success) && success.length > 0 && success.length <= 10 && success.every(r => Array.isArray(r) && r.length === 2 && r.every(Number.isInteger) && r[0] >= 100 && r[1] <= 599 && r[0] <= r[1]), 'invalid_success_rule', 'Expected status ranges');
    return { type: 'http', method, url: value.url, headers: value.headers || {}, body: value.body || '', timeout_seconds: timeout, follow_redirects: value.follow_redirects === true, success_status: success };
  }
  assert(kind === 'jobs', 'invalid_kind', 'Unknown collection');
  validateName(value.action); const timezone = value.timezone || 'UTC';
  if (value.cron !== null) assert(cron(value.cron, timezone).nextRun(), 'invalid_cron', 'Cron expression has no future fire');
  const overlap = value.overlap || 'skip'; const missed = value.missed || 'skip'; const retries = value.retries ?? 0;
  assert(['skip', 'allow'].includes(overlap) && ['skip', 'run_once'].includes(missed) && Number.isInteger(retries) && retries >= 0 && retries <= 3, 'invalid_policy', 'Invalid job policies');
  assert(value.enabled === undefined || typeof value.enabled === 'boolean', 'invalid_enabled', 'enabled must be boolean');
  const budget = {};
  for (const window of ['day', 'month']) if (value.budget?.[window] != null) budget[window] = money(value.budget[window]);
  return { action: value.action, cron: value.cron, timezone, overlap, missed, retries, enabled: value.enabled !== false, budget };
}
/** Validate the resulting whole graph so deletions cannot strand active definitions. */
export function validateConfig(config, profile, now = Date.now()) {
  assert(new TextEncoder().encode(JSON.stringify(config)).length <= 1048576, 'config_size_limit', 'Total account definitions must fit within 1 MB', 413);
  const limit = now - profile.created_at < 7 * 86400000 ? COST_POLICY.newAccountMaxJobs : COST_POLICY.maxJobs;
  assert(Object.keys(config.jobs).length <= limit, 'job_limit', `Account job limit is ${limit}`);
  for (const action of Object.values(config.actions)) {
    if (action.type === 'javascript') continue;
    validateTemplates(action, config);
    const url = action.url.replace(/\{\{\s*var\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_, name) => config.variables[name]);
    validateDestination(url.replace(/\{\{[^}]+\}\}/g, 'preview'));
  }
  for (const job of Object.values(config.jobs)) {
    assert(Object.hasOwn(config.actions, job.action), 'unknown_action', `Unknown action: ${job.action}`);
    job.max_run_microdollars = price('run', config.actions[job.action]);
  }
}
