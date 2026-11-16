import { rpc } from '../utils/rpc.js';
import { assert } from '../utils/errors.js';
import { upcoming, projection, filterRuns } from '../services/reporting.js';
/** Merge per-job histories within account bounds; job names are never trusted as account IDs. */
export async function retainedRuns(env, account, config) {
  const index = await rpc(env.ACCOUNTS, account, 'list', { prefix: 'job-index:', limit: 1000 });
  const names = [...new Set([...Object.keys(config.jobs), ...index.items.map(item => item.name)])];
  const results = await Promise.all(names.map(name => rpc(env.JOBS, `${account}:${name}`, 'runs')));
  return results.flatMap(result => result.items);
}
/** Reporting endpoints share filters, integer units and bounded windows. */
export async function reports(route, request, env, auth) {
  const params = new URL(request.url).searchParams;
  const config = await rpc(env.ACCOUNTS, auth.account, 'config');
  switch (route.handler) {
    case 'config-read': return { config };
    case 'upcoming': return upcoming(config, params.get('from') ? Date.parse(params.get('from')) : Date.now(), params.get('to') ? Date.parse(params.get('to')) : Date.now() + 86400000, Math.min(1000, Math.max(1, Number(params.get('limit')) || 100)));
    case 'projection': return projection(config, await rpc(env.ACCOUNTS, auth.account, 'account'), await retainedRuns(env, auth.account, config));
    case 'costs': {
      const group = params.get('group') || 'day'; assert(['day', 'job', 'action'].includes(group), 'invalid_group', 'Invalid cost grouping');
      const metrics = await rpc(env.ACCOUNTS, auth.account, 'costs', { from: params.get('from'), to: params.get('to') }); const buckets = {};
      for (const metric of metrics.items) {
        const values = group === 'day' ? { [metric.period]: metric.spent_microdollars } : metric[`by_${group}`] || {};
        for (const [name, amount] of Object.entries(values)) buckets[name] = (buckets[name] || 0) + amount;
      }
      return { group, from: metrics.from, to: metrics.to, items: Object.entries(buckets).map(([name, cost_microdollars]) => ({ name, cost_microdollars })), total_microdollars: Object.values(buckets).reduce((sum, amount) => sum + amount, 0) };
    }
    case 'runs': return { items: filterRuns(await retainedRuns(env, auth.account, config), params).slice(0, 1000) };
    case 'run-detail': {
      const runs = await retainedRuns(env, auth.account, config); const run = runs.find(r => r.id === route.params.id);
      assert(run, 'not_found', 'Run not found', 404); return { run };
    }
  }
}
