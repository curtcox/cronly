import { worstCaseCost, COST_POLICY } from '../utils/cost-policy.js';
import { PRICES } from '../utils/pricing.js';
import { assert } from '../utils/errors.js';
/** Validate all money at the boundary; never use floating balances. */
export function money(value) { assert(Number.isSafeInteger(value) && value >= 0, 'invalid_money', 'Expected nonnegative integer micro-dollars'); return value; }
/** Read the account's spendable funds inside the same storage transaction. */
export async function funds(tx) {
  const balance = (await tx.get('balance')) || 0;
  const holds = [...(await tx.list({ prefix: 'hold:' })).values()].filter(h => !h.settled);
  return { balance_microdollars: balance, held_microdollars: holds.reduce((sum, h) => sum + h.amount, 0), holds };
}
/** Reserve before any external work; budgets include every outstanding hold. */
export async function reserve(tx, args, now = Date.now()) {
  money(args.amount); assert(args.amount > 0, 'invalid_money', 'Reservation must be positive');
  const prior = await tx.get(`hold:${args.id}`) || await tx.get(`receipt:${args.id}`);
  if (prior) return { ...prior, duplicate: true };
  const { balance_microdollars: balance, held_microdollars: held, holds } = await funds(tx);
  assert(balance - held >= args.amount, 'insufficient_balance', 'Insufficient balance', 402, { needed_microdollars: args.amount - (balance - held) });
  const day = new Date(now).toISOString().slice(0, 10); const month = day.slice(0, 7);
  for (const [kind, id, budget] of [['job', args.job, args.budget], ['key', args.key_id, args.key_budget]]) {
    if (!id || !budget) continue;
    for (const [window, period] of [['day', day], ['month', month]]) {
      const limit = budget[window]; if (limit === undefined || limit === null) continue;
      money(limit);
      const spent = (await tx.get(`spent:${kind}:${id}:${period}`)) || 0;
      const pending = holds.filter(h => h[kind === 'job' ? 'job' : 'key_id'] === id && h[window] === period).reduce((sum, h) => sum + h.amount, 0);
      assert(spent + pending + args.amount <= limit, `${kind === 'key' ? 'key_' : ''}budget_${window}`, `${kind} ${window} budget exceeded`, 402);
    }
  }
  const hold = { ...args, day, month, created_at: now, expires_at: now + (args.ttl_ms || 120000), settled: false };
  await tx.put(`hold:${args.id}`, hold);
  const alarm = await tx.getAlarm();
  if (!alarm || alarm > hold.expires_at) await tx.setAlarm(hold.expires_at);
  return hold;
}
/** Settle once, releasing unused credit. Expired holds are charged in full. */
export async function settle(tx, id, actual, now = Date.now()) {
  money(actual); const hold = await tx.get(`hold:${id}`) || await tx.get(`receipt:${id}`);
  assert(hold, 'unknown_hold', 'Reservation not found', 404);
  if (hold.settled) return hold;
  const amount = Math.min(hold.amount, actual, hold.actual_price ?? Infinity);
  const balance = (await tx.get('balance')) || 0;
  assert(balance >= amount, 'ledger_invariant', 'Invalid ledger state', 500);
  await tx.put('balance', balance - amount);
  for (const [kind, value] of [['account', 'self'], ['job', hold.job], ['key', hold.key_id]]) {
    if (!value) continue;
    for (const period of [hold.day, hold.month]) {
      const key = `spent:${kind}:${value}:${period}`;
      if (kind === 'account') {
        const existing = await tx.get(key); const metric = typeof existing === 'number' ? { spent_microdollars: existing } : existing || {};
        const estimate = hold.kind === 'prose' ? Math.max(0, (amount - PRICES.proseBase) / PRICES.proseMarkup) : worstCaseCost(hold.kind, hold.execution?.action || { job_count: hold.read_job_count || 0 }) - (hold.execution?.action?.type === 'javascript' && hold.actual_price < hold.amount ? COST_POLICY.dynamicWorkerDay : 0);
        const jobGroup = hold.job || hold.kind || 'other'; const actionGroup = hold.action || hold.kind || 'other';
        const by_job = { ...metric.by_job, [jobGroup]: ((metric.by_job || {})[jobGroup] || 0) + amount };
        const by_action = { ...metric.by_action, [actionGroup]: ((metric.by_action || {})[actionGroup] || 0) + amount };
        const run_count_by_job = { ...metric.run_count_by_job, [jobGroup]: ((metric.run_count_by_job || {})[jobGroup] || 0) + (hold.kind === 'run' ? 1 : 0) };
        await tx.put(key, { period, run_count_by_job, by_job, by_action, spent_microdollars: (metric.spent_microdollars || 0) + amount, estimated_cost_microdollars: (metric.estimated_cost_microdollars || 0) + Math.ceil(estimate) });
      } else await tx.put(key, ((await tx.get(key)) || 0) + amount);
    }
  }
  const { execution: _execution, ...receipt } = hold;
  const result = { ...receipt, settled: true, charged: amount, settled_at: now };
  // The permanent receipt is also the reservation tombstone; duplicates cannot spend twice.
  await tx.delete(`hold:${id}`);
  await tx.put(`receipt:${id}`, result);
  await tx.put(`ledger:${String(now).padStart(13, '0')}:${id}`, { id, amount_microdollars: -amount, kind: hold.kind, job: hold.job, action: hold.action, created_at: now });
  return result;
}
/** Credit a verified payment once, even across repeated webhook deliveries. */
export async function deposit(tx, id, amount, now = Date.now()) {
  money(amount);
  if (await tx.get(`deposit:${id}`)) return { duplicate: true };
  const balance = ((await tx.get('balance')) || 0) + amount; money(balance);
  await tx.put('balance', balance); await tx.put(`deposit:${id}`, { amount, created_at: now });
  await tx.put(`ledger:${now}:deposit:${id}`, { id, kind: 'deposit', amount_microdollars: amount, created_at: now });
  return { balance_microdollars: balance };
}
