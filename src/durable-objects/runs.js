import { digest } from '../auth/crypto.js';
import { SANDBOX_WRAPPER } from '../executor/javascript.js';
import { PRICES } from '../utils/pricing.js';
import { assert } from '../utils/errors.js';
import { reserve } from './ledger.js';
import { keyBudget } from './definitions.js';
import { references } from '../executor/templates.js';
import { price } from '../utils/pricing.js';
import { COST_POLICY } from '../utils/cost-policy.js';
/** Freeze the action and only the referenced credentials inside the prepaid hold. */
export async function prepareRun(tx, args) {
  assert(args.input && typeof args.input === 'object' && !Array.isArray(args.input) && Object.keys(args.input).length <= 32 && Object.entries(args.input).every(([k, v]) => /^[a-zA-Z0-9_-]{1,64}$/.test(k) && typeof v === 'string' && v.length <= 2048), 'invalid_input', 'Webhook input must be a small object of strings');
  const prior = await tx.get(`hold:${args.id}`) || await tx.get(`receipt:${args.id}`);
  if (prior) return { id: args.id, duplicate: true, amount: prior.amount };
  const job = await tx.get(`def:jobs:${args.name}`);
  assert(job, 'not_found', 'Job not found', 404); assert(job.enabled, 'job_disabled', 'Job is disabled', 409);
  const action = await tx.get(`def:actions:${job.action}`); assert(action, 'unknown_action', 'Action missing', 409);
  const holds = [...(await tx.list({ prefix: 'hold:' })).values()];
  assert(holds.filter(h => h.kind === 'run').length < COST_POLICY.concurrency, 'concurrency_limit', 'Maximum concurrent account runs reached', 429);
  if (job.overlap === 'skip') assert(!holds.some(h => h.job === args.name), 'overlap', 'Previous run is unfinished', 409);
  const now = Date.now(); const last = await tx.get(`last-run:${args.name}`);
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
  const hold = await reserve(tx, { id: args.id, amount, job: args.name, action: job.action, kind: 'run', budget: job.budget, ...await keyBudget(tx, args.key_id), execution: { version: action.type === 'javascript' ? await digest(JSON.stringify([SANDBOX_WRAPPER, action])) : null, action, vars, secrets, job, input: args.input, trigger: args.trigger, scheduled_at: args.scheduled_at }, ttl_ms: 120000 });
  await tx.put(`last-run:${args.name}`, now);
  return { id: hold.id, amount, job };
}
/** A queue redelivery cannot re-execute an already claimed external request. */
export async function claimRun(tx, id) {
  const hold = await tx.get(`hold:${id}`);
  assert(hold && hold.expires_at > Date.now(), 'expired_run', 'Run hold expired', 409);
  if (hold.claimed) return { duplicate: true };
  let actual_price = hold.amount;
  if (hold.execution.action.type === 'javascript') {
    const activationKey = `activation:${hold.execution.version}:${hold.day}`;
    if (await tx.get(activationKey)) actual_price -= PRICES.jsActivation;
    else await tx.put(activationKey, { created_at: Date.now() });
  }
  await tx.put(`hold:${id}`, { ...hold, claimed: true, actual_price });
  return { ...hold.execution, amount: hold.amount, actual_price };
}
