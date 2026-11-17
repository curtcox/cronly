import { rpc } from '../utils/rpc.js';
import { assert } from '../utils/errors.js';
import { upcoming, projection, filterRuns } from '../services/reporting.js';
/** Merge per-job histories within account bounds; job names are never trusted as account IDs. */
export async function retainedRuns(env, account, _config, options = {}) {
  const names = options.names || (options.job ? [options.job] : (await rpc(env.ACCOUNTS, account, 'read-plan')).names);
  const results = await Promise.all(names.slice(0, 100).map(name => rpc(env.JOBS, `${account}:${name}`, 'runs', { summary: true, limit: options.job ? 100 : 20, status: options.status, from: options.from, to: options.to, before: options.before })));
  return results.flatMap(result => result.items);
}
/** Reporting endpoints share filters, integer units and bounded windows. */
export async function reports(route, request, env, auth) {
  const params = new URL(request.url).searchParams;
  const config = await rpc(env.ACCOUNTS, auth.account, 'config');
  switch (route.handler) {
    case 'config-read': return { config };
    case 'upcoming': return upcoming(config, params.get('from') ? Date.parse(params.get('from')) : Date.now(), params.get('to') ? Date.parse(params.get('to')) : Date.now() + 86400000, Math.min(1000, Math.max(1, Number(params.get('limit')) || 100)));
    case 'projection': return projection(config, await rpc(env.ACCOUNTS, auth.account, 'account'), (await rpc(env.ACCOUNTS, auth.account, 'activity')).counts);
    case 'costs': {
      const group = params.get('group') || 'day'; assert(['day', 'job', 'action'].includes(group), 'invalid_group', 'Invalid cost grouping');
      const metrics = await rpc(env.ACCOUNTS, auth.account, 'costs', { from: params.get('from'), to: params.get('to') }); const buckets = Object.create(null);
      for (const metric of metrics.items) {
        const values = group === 'day' ? { [metric.period]: metric.spent_microdollars } : metric[`by_${group}`] || {};
        for (const [name, amount] of Object.entries(values)) buckets[name] = (buckets[name] || 0) + amount;
      }
      return { group, from: metrics.from, to: metrics.to, items: Object.entries(buckets).map(([name, cost_microdollars]) => ({ name, cost_microdollars })), total_microdollars: Object.values(buckets).reduce((sum, amount) => sum + amount, 0) };
    }
    case 'runs': {
      const options = { job: params.get('job'), names: auth.read_names, status: params.get('status'), from: params.get('from') ? Date.parse(params.get('from')) : undefined, to: params.get('to') ? Date.parse(params.get('to')) : undefined, before: params.get('before') ? Number(params.get('before')) : undefined, cursor: params.get('cursor') };
      assert(options.job || options.cursor === null, 'invalid_cursor', 'Filter by job to page retained runs');
      if (options.job) {
        assert(/^(?:_test:)?[a-z0-9-]{1,64}$/.test(options.job), 'invalid_name', 'Invalid job filter');
        const index = await rpc(env.ACCOUNTS, auth.account, 'get', { key: `job-index:${options.job}` }); assert(index.name, 'not_found', 'Job history not found', 404);
        const page = await rpc(env.JOBS, `${auth.account}:${options.job}`, 'runs', { ...options, summary: false, limit: 100 });
        return { ...page, items: filterRuns(page.items, params), summary: false };
      }
      return { items: filterRuns(await retainedRuns(env, auth.account, config, options), params).slice(0, 20), summary: true, note: 'Latest 20 matching summaries across the 100 most recently run jobs. Filter by job to page complete retained logs.' };
    }
    case 'run-detail': {
      const location = await rpc(env.ACCOUNTS, auth.account, 'run-route', { id: route.params.id });
      const run = await rpc(env.JOBS, `${auth.account}:${location.job}`, 'run', { id: route.params.id });
      assert(run.id, 'not_found', 'Run not found', 404); return { run };
    }
  }
}
