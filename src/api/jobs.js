import { rpc } from '../utils/rpc.js';
import { assert, readJson } from '../utils/errors.js';
/** On-demand runs use the same JobDO reservation path as scheduled runs. */
export async function runJob(route, request, env, auth) {
  const name = route.params.name; const config = await rpc(env.ACCOUNTS, auth.account, 'config');
  assert(Object.hasOwn(config.jobs, name), 'not_found', 'Job not found', 404);
  const body = await readJson(request, 8192);
  if (new URL(request.url).searchParams.get('dry_run') === '1') return rpc(env.ACCOUNTS, auth.account, 'prepare-run', { id: 'preview', name, dry_run: true, input: body.input || {}, trigger: 'manual' });
  const id = `${auth.account}:${name}:manual:${auth.key_id || 'session'}:${request.headers.get('Idempotency-Key') || crypto.randomUUID()}`;
  return rpc(env.JOBS, `${auth.account}:${name}`, 'start', { id, trigger: 'manual', scheduled_at: new Date().toISOString(), input: body.input || {}, key_id: auth.key_id });
}

/** Pause/resume are ordinary quoted and billed definition changes. */
export async function toggleJob(route, request, env, auth) {
  const dry_run = new URL(request.url).searchParams.get('dry_run') === '1';
  const result = await rpc(env.ACCOUNTS, auth.account, 'toggle-job', {
    account: auth.account, key_id: auth.key_id, id: request.headers.get('Idempotency-Key') || crypto.randomUUID(),
    name: route.params.name, enabled: route.handler === 'resume-job', dry_run
  });
  if (!dry_run) {
    try { await rpc(env.ACCOUNTS, auth.account, 'sync-jobs'); } catch { /* Durable outbox retries. */ }
  }
  return result;
}

/** Test a saved action without requiring a customer-created job or a definition change. */
export async function testAction(route, request, env, auth) {
  const config = await rpc(env.ACCOUNTS, auth.account, 'config');
  assert(Object.hasOwn(config.actions, route.params.name), 'not_found', 'Action not found', 404);
  const name = `_test:${route.params.name}`; const body = await readJson(request, 8192);
  if (new URL(request.url).searchParams.get('dry_run') === '1') return rpc(env.ACCOUNTS, auth.account, 'prepare-run', { id: 'preview', name, test_action: route.params.name, dry_run: true, input: body.input || {}, trigger: 'manual' });
  return rpc(env.JOBS, `${auth.account}:${name}`, 'test-action', { account: auth.account, test_action: route.params.name, id: `${auth.account}:${name}:${auth.key_id || 'session'}:${request.headers.get('Idempotency-Key') || crypto.randomUUID()}`, input: body.input || {}, trigger: 'manual', scheduled_at: new Date().toISOString(), key_id: auth.key_id });
}
