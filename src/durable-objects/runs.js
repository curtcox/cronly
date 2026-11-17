import { javascriptVersion } from '../executor/javascript.js';
import { PRICES } from '../utils/pricing.js';
import { assert } from '../utils/errors.js';
import { reserve } from './ledger.js';
import { keyBudget } from './definitions.js';
import { references } from '../executor/templates.js';
import { price } from '../utils/pricing.js';
import { COST_POLICY } from '../utils/cost-policy.js';
import { getHold, listHolds, putHold } from './hold-storage.js';
import { runActivity, lastRun } from './run-activity.js';

// Recovery must use the original reservation, even if a response or JobDO write
// was lost. Return only orchestration data, never the frozen credentials/code.
function prepared(hold) {
  const execution = hold.execution;
  return {
    id: hold.id, amount: hold.amount, settled: hold.settled, job: execution?.job,
    pending: { created_at: hold.created_at, expires_at: hold.expires_at, key_id: hold.key_id, trigger: execution?.trigger, scheduled_at: execution?.scheduled_at, attempt: execution?.attempt || 0 },
    retry: execution?.job.retries ? { input: execution.input || {} } : undefined
  };
}
/** Freeze the action and only the referenced credentials inside the prepaid hold. */
export async function prepareRun(tx, args, env = {}) {
  assert(args.input && typeof args.input === 'object' && !Array.isArray(args.input) && Object.keys(args.input).length <= 32 && Object.entries(args.input).every(([k, v]) => /^[a-zA-Z0-9_-]{1,64}$/.test(k) && typeof v === 'string' && v.length <= 2048), 'invalid_input', 'Webhook input must be a small object of strings');
  const prior = await getHold(tx, args.id) || await tx.get(`receipt:${args.id}`);
  if (prior) return { ...prepared(prior), duplicate: true };
  const job = args.test_action ? { action: args.test_action, enabled: true, overlap: 'allow', retries: 0, budget: {}, cron: null } : await tx.get(`def:jobs:${args.name}`);
  assert(job, 'not_found', 'Job not found', 404); assert(job.enabled, 'job_disabled', 'Job is disabled', 409);
  const action = await tx.get(`def:actions:${job.action}`); assert(action, 'unknown_action', 'Action missing', 409);
  if (action.type === 'javascript' && env.ENVIRONMENT === 'production') assert(env.JS_LIVE_ACCEPTED === 'true' || (await tx.get('profile')).id === env.JS_ACCEPTANCE_ACCOUNT, 'sandbox_acceptance_required', 'JavaScript requires live sandbox acceptance', 503);
  const holds = await listHolds(tx);
  assert(holds.filter(h => h.kind === 'run').length < COST_POLICY.concurrency, 'concurrency_limit', 'Maximum concurrent account runs reached', 429);
  if (job.overlap === 'skip') assert(!holds.some(h => h.job === args.name), 'overlap', 'Previous run is unfinished', 409);
  const now = Date.now(); const activity = await runActivity(tx); const last = await lastRun(tx, args.name, activity);
  if (!args.retry) assert(!last || now - last >= 60000, 'run_rate_limit', 'Maximum one run per minute per job', 429);
  const vars = {}; const secrets = {};
  if (action.type === 'javascript') {
    for (const [key, value] of await tx.list({ prefix: 'def:variables:' })) vars[key.slice('def:variables:'.length)] = value;
    for (const [key, value] of await tx.list({ prefix: 'def:secrets:' })) secrets[key.slice('def:secrets:'.length)] = value;
  } else {
    for (const { type, name } of references([action.url, action.headers, action.body])) {
      if (type === 'var') vars[name] = await tx.get(`def:variables:${name}`);
      if (type === 'secret') secrets[name] = await tx.get(`def:secrets:${name}`);
      if (type === 'input') assert(Object.hasOwn(args.input, name), 'missing_input', `Missing webhook input: ${name}`);
    }
  }
  const amount = price(args.trigger === 'webhook' ? 'hook' : 'run', action);
  if (args.dry_run) return { quote_microdollars: amount, cost_microdollars: 0 };
  // This permanent index routes retained test logs, including after action
  // deletion. Activity already tracks recency in the reservation's balance row.
  if (args.test_action && !await tx.get(`job-index:${args.name}`)) await tx.put(`job-index:${args.name}`, { name: args.name, account: args.account, updated_at: now });
  const hold = await reserve(tx, { id: args.id, amount, job: args.name, action: job.action, kind: 'run', budget: job.budget, ...await keyBudget(tx, args.key_id), execution: { version: action.type === 'javascript' ? await javascriptVersion(action) : null, action, vars, secrets, job, input: args.input, trigger: args.trigger, scheduled_at: args.scheduled_at, attempt: args.attempt || 0 }, ttl_ms: 120000 }, now, { name: args.name, now, items: activity });
  return prepared(hold);
}
/** A queue redelivery cannot re-execute an already claimed external request. */
export async function claimRun(tx, id) {
  const hold = await getHold(tx, id);
  assert(hold && hold.expires_at > Date.now(), 'expired_run', 'Run hold expired', 409);
  if (hold.claimed) return { duplicate: true };
  let actual_price = hold.amount;
  let activation_day;
  if (hold.execution.action.type === 'javascript') {
    // Queue delay can cross UTC midnight. Budgets keep the reservation period,
    // while activation follows execution and only recognizes settled payments.
    activation_day = new Date().toISOString().slice(0, 10);
    const activationKey = `activation:${hold.execution.version}:${activation_day}`;
    if (await tx.get(activationKey)) actual_price -= PRICES.jsActivation;
  }
  await putHold(tx, { ...hold, claimed: true, actual_price, ...(activation_day ? { activation_day } : {}) });
  return { ...hold.execution, amount: hold.amount, actual_price };
}
