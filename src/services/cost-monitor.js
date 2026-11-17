import { COST_POLICY as C } from '../utils/cost-policy.js';
import { rpc } from '../utils/rpc.js';
import { assert } from '../utils/errors.js';
// Ported from hashbin's monitor: query total CPU, never percentiles; reject missing
// or truncated datasets. Namespace filters are required in a shared Cloudflare account.
// cronly uses SQLite DOs. The legacy storage dataset groups namespace ID arrays;
// SQL storage exposes individual namespaces, which must stay separate before summing maxima.
export const USAGE_QUERY = `query Costs($account: string!, $start: Time!, $end: Time!, $scripts: [string!], $namespaces: [string!]) {
 viewer { accounts(filter: {accountTag: $account}) {
  workers: workersInvocationsAdaptive(limit: 10, filter: {datetime_geq: $start, datetime_lt: $end, scriptName_in: $scripts}) { sum { requests cpuTimeUs } }
  invocations: durableObjectsInvocationsAdaptiveGroups(limit: 10, filter: {datetime_geq: $start, datetime_lt: $end, namespaceId_in: $namespaces}) { sum { requests } }
  periodic: durableObjectsPeriodicGroups(limit: 10, filter: {datetime_geq: $start, datetime_lt: $end, namespaceId_in: $namespaces}) { sum { duration rowsRead rowsWritten } }
  storage: durableObjectsSqlStorageGroups(limit: 1000, filter: {datetime_geq: $start, datetime_lt: $end, namespaceId_in: $namespaces}) { max { storedBytes } dimensions { namespaceId } }
 } }
}`;
/** Reject missing metrics rather than quietly substituting zero cost (hashbin convention). */
export function measuredCost(account) {
  const sum = (rows, field, group = 'sum') => {
    assert(Array.isArray(rows) && rows.length < (group === 'max' ? 1000 : 10), 'analytics_incomplete', 'Analytics dataset missing or truncated', 503);
    return rows.reduce((total, row) => { const value = row[group]?.[field]; assert(Number.isFinite(value) && value >= 0, 'analytics_incomplete', 'Billing metric is unavailable', 503); return total + value; }, 0);
  };
  return Math.ceil(sum(account.workers, 'requests') * C.workerRequest + sum(account.workers, 'cpuTimeUs') / 1000 * C.workerCpuMs + sum(account.invocations, 'requests') * C.doRequest + sum(account.periodic, 'duration') * C.doSecond * 8 + sum(account.periodic, 'rowsRead') * C.rowRead + sum(account.periodic, 'rowsWritten') * C.rowWritten + sum(account.storage, 'storedBytes', 'max') / 1000 * C.storageKBMonth / 30);
}
/** Reconcile daily infrastructure against prepaid revenue; stale/missing analytics stops runs. */
export async function runCostMonitor(env, now = Date.now()) {
  if (env.ENVIRONMENT === 'local') return { local: true };
  let report;
  try {
    assert(env.CLOUDFLARE_ANALYTICS_TOKEN && env.CLOUDFLARE_ACCOUNT_ID && env.COST_SAFETY_DO_NAMESPACES, 'analytics_unconfigured', 'Analytics token, account and cronly namespace IDs are required', 503);
    const midnight = Date.parse(new Date(now).toISOString().slice(0, 10));
    const end = new Date(midnight).toISOString(); const start = new Date(midnight - 86400000).toISOString();
    const response = await (env.ANALYTICS_FETCH || fetch)('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: USAGE_QUERY, variables: { account: env.CLOUDFLARE_ACCOUNT_ID, start, end, scripts: ['cronly'], namespaces: env.COST_SAFETY_DO_NAMESPACES.split(',') } }), signal: AbortSignal.timeout(15000) });
    const data = await response.json(); assert(response.ok && !data.errors?.length && data.data?.viewer?.accounts?.[0], 'analytics_unavailable', 'Cloudflare analytics unavailable', 503);
    const observed = measuredCost(data.data.viewer.accounts[0]);
    let revenue = 0; let estimated = 0;
    const day = new Date(now - 86400000).toISOString().slice(0, 10);
    let cursor;
    do {
      const page = await rpc(env.SAFETY, 'global', 'accounts', { cursor });
      for (const { account } of page.items) {
        const metric = await rpc(env.ACCOUNTS, account, 'metrics', { period: day });
        revenue += metric.spent_microdollars || 0; estimated += metric.estimated_cost_microdollars || 0;
        await rpc(env.ACCOUNTS, account, 'maintenance');
      }
      cursor = page.next_cursor;
    } while (cursor);
    // The ledger estimate includes Queue operations and sandbox activation; take the
    // higher total until all billable datasets are available in the operator account.
    const cost = Math.max(observed, estimated); const projectedLoss = Math.max(0, (cost - revenue * C.revenueKept) * 30);
    report = { checked_at: now, observed_microdollars: observed, estimated_microdollars: estimated, revenue_microdollars: revenue, projected_loss_microdollars: Math.ceil(projectedLoss), brake: projectedLoss > C.projectionBrakeCents * 10000, method: 'Cloudflare Worker/DO observations with conservative ledger allowance for Queue/sandbox costs' };
  } catch { report = { checked_at: now, brake: true, reason: 'Analytics missing, incomplete or unavailable; operator must investigate' }; }
  await rpc(env.SAFETY, 'global', 'record', { report });
  if (!report.brake) {
    let pending;
    do {
      pending = await rpc(env.SAFETY, 'global', 'resume-accounts');
      for (const { account, version } of pending.items) {
        await rpc(env.ACCOUNTS, account, 'resume-cost-jobs');
        await rpc(env.SAFETY, 'global', 'resumed-account', { account, version });
      }
    } while (pending.more);
  }
  if (report.brake && env.ALERT_WEBHOOK_URL) await fetch(env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'cronly cost safety brake is active. Inspect the private safety report.' }), signal: AbortSignal.timeout(10000) });
  return report;
}
