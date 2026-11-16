import { rpc } from '../utils/rpc.js';
import { assert, readJson } from '../utils/errors.js';
import { price } from '../utils/pricing.js';
/** On-demand runs use the same JobDO reservation path as scheduled runs. */
export async function runJob(route, request, env, auth) {
  const name = route.params.name; const config = await rpc(env.ACCOUNTS, auth.account, 'config');
  const job = config.jobs[name]; assert(job, 'not_found', 'Job not found', 404);
  const quote = price('run', config.actions[job.action]);
  if (new URL(request.url).searchParams.get('dry_run') === '1') return { quote_microdollars: quote, cost_microdollars: 0 };
  const body = await readJson(request, 8192);
  const id = `${auth.account}:${name}:manual:${auth.key_id || 'session'}:${request.headers.get('Idempotency-Key') || crypto.randomUUID()}`;
  return rpc(env.JOBS, `${auth.account}:${name}`, 'start', { id, trigger: 'manual', scheduled_at: new Date().toISOString(), input: body.input || {}, key_id: auth.key_id });
}
