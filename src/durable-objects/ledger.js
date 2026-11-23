import { worstCaseCost, COST_POLICY } from '../utils/cost-policy.js';
import { PRICES } from '../utils/pricing.js';
import { assert } from '../utils/errors.js';
import { accountMoney, accountMetric, updateAccountMetric } from './account-money.js';
import { appendLedger } from './ledger-history.js';
import { getHold, listHolds, putHold } from './hold-storage.js';
import { ownValue } from '../utils/records.js';
/** Validate all money at the boundary; never use floating balances. */
export function money(value) { assert(Number.isSafeInteger(value) && value >= 0, 'invalid_money', 'Expected nonnegative integer micro-dollars'); return value; }
/** Read the account's spendable funds inside the same storage transaction. */
export async function funds(tx) {
  const state = await accountMoney(tx); const balance = state.balance_microdollars;
  const holds = await listHolds(tx, state);
  return { balance_microdollars: balance, held_microdollars: holds.reduce((sum, h) => sum + h.amount, 0), holds };
}
// Budget counters share the two account summary writes. Keep reading old counters
// until each job/key first settles in that period; no bulk migration is needed.
async function budgetSpent(tx, metric, kind, id, period) {
  return ownValue(metric?.budget_spent?.[kind], id) ?? (await tx.get(`spent:${kind}:${id}:${period}`)) ?? 0;
}
// Both durable reservations and immediate charges enforce the same funds and caps.
async function reservation(tx, args, now) {
  money(args.amount); assert(args.amount > 0, 'invalid_money', 'Reservation must be positive');
  const prior = await getHold(tx, args.id) || await tx.get(`receipt:${args.id}`);
  if (prior) return { ...prior, duplicate: true };
  const { balance_microdollars: balance, held_microdollars: held, holds } = await funds(tx);
  assert(balance - held >= args.amount, 'insufficient_balance', 'Insufficient balance', 402, { needed_microdollars: args.amount - (balance - held) });
  const day = new Date(now).toISOString().slice(0, 10); const month = day.slice(0, 7);
  for (const [kind, id, budget] of [['job', args.job, args.budget], ['key', args.key_id, args.key_budget]]) {
    if (!id || !budget) continue;
    for (const [window, period] of [['day', day], ['month', month]]) {
      const limit = budget[window]; if (limit === undefined || limit === null) continue;
      money(limit);
      const metric = await accountMetric(tx, period);
      const spent = await budgetSpent(tx, metric, kind, id, period);
      const pending = holds.filter(h => h[kind === 'job' ? 'job' : 'key_id'] === id && h[window] === period).reduce((sum, h) => sum + h.amount, 0);
      assert(spent + pending + args.amount <= limit, `${kind === 'key' ? 'key_' : ''}budget_${window}`, `${kind} ${window} budget exceeded`, 402);
    }
  }
  return { ...args, day, month, created_at: now, expires_at: now + (args.ttl_ms || 120000), settled: false };
}
/** Reserve before any external work; budgets include every outstanding hold. */
export async function reserve(tx, args, now = Date.now(), activity) {
  const hold = await reservation(tx, args, now);
  if (hold.duplicate) return hold;
  await putHold(tx, hold, activity);
  const alarm = await tx.getAlarm();
  if (!alarm || alarm > hold.expires_at) await tx.setAlarm(hold.expires_at);
  return hold;
}
/** Settle once, releasing unused credit. Expired holds are charged in full. */
export async function settle(tx, id, actual, now = Date.now()) {
  money(actual); const hold = await getHold(tx, id) || await tx.get(`receipt:${id}`);
  assert(hold, 'unknown_hold', 'Reservation not found', 404);
  return settleReservation(tx, hold, actual, now);
}
/** Bill work completed in this transaction, without writing a transient hold or alarm. */
export async function charge(tx, args, now = Date.now()) {
  assert(['read', 'change'].includes(args.kind), 'invalid_charge', 'External work requires a durable reservation');
  const hold = await reservation(tx, args, now);
  return settleReservation(tx, hold, hold.amount, now, !hold.duplicate);
}
async function settleReservation(tx, hold, actual, now, immediate = false) {
  if (hold.settled) return hold;
  const id = hold.id;
  let maximum = hold.actual_price ?? hold.amount;
  if (hold.activation_day) {
    const activationKey = `activation:${hold.execution.version}:${hold.activation_day}`;
    // Concurrent claims each retain the full hold until one activation is paid.
    // A refunded/braked claim must not give later executions a free activation.
    if (await tx.get(activationKey)) maximum = Math.min(maximum, hold.amount - PRICES.jsActivation);
    else if (Math.min(hold.amount, actual, maximum) >= PRICES.jsActivation) await tx.put(activationKey, { created_at: now });
  }
  const amount = Math.min(hold.amount, actual, maximum);
  const state = await accountMoney(tx);
  const balance = state.balance_microdollars;
  assert(balance >= amount, 'ledger_invariant', 'Invalid ledger state', 500);
  state.balance_microdollars = balance - amount;
  const compact = state.holds?.some(item => item.id === id);
  if (compact) state.holds = state.holds.filter(item => item.id !== id);
  for (const period of [hold.day, hold.month]) {
    const existing = await accountMetric(tx, period, state); const metric = typeof existing === 'number' ? { spent_microdollars: existing } : existing || {};
    const budget_spent = { ...metric.budget_spent };
    for (const [kind, value] of [['job', hold.job], ['key', hold.key_id]]) {
      if (value) budget_spent[kind] = { ...budget_spent[kind], [value]: await budgetSpent(tx, metric, kind, value, period) + amount };
    }
    const operation = hold.kind === 'run' && hold.execution?.trigger === 'webhook' ? 'hook' : hold.kind;
    const estimate = hold.kind === 'prose' ? Math.max(0, (amount - PRICES.proseBase) / PRICES.proseMarkup) : worstCaseCost(operation, hold.execution?.action || { job_count: hold.read_job_count || 0 }, { dba: hold.dba }) - (hold.execution?.action?.type === 'javascript' && maximum < hold.amount ? COST_POLICY.dynamicWorkerDay : 0);
    const jobGroup = hold.job || hold.kind || 'other'; const actionGroup = hold.action || hold.kind || 'other';
    const by_job = { ...metric.by_job, [jobGroup]: (ownValue(metric.by_job, jobGroup) ?? 0) + amount };
    const by_action = { ...metric.by_action, [actionGroup]: (ownValue(metric.by_action, actionGroup) ?? 0) + amount };
    const run_count_by_job = { ...metric.run_count_by_job, [jobGroup]: (ownValue(metric.run_count_by_job, jobGroup) ?? 0) + (hold.kind === 'run' ? 1 : 0) };
    await updateAccountMetric(tx, state, { period, budget_spent, run_count_by_job, by_job, by_action, spent_microdollars: (metric.spent_microdollars || 0) + amount, estimated_cost_microdollars: (metric.estimated_cost_microdollars || 0) + Math.ceil(estimate) });
  }
  // The balance and active summaries always commit together, including deposits.
  await appendLedger(tx, state, { id, amount_microdollars: -amount, kind: hold.kind, job: hold.job, action: hold.action, created_at: now });
  await tx.put('balance', state);
  const { execution: _execution, ...receipt } = hold;
  const result = { ...receipt, ...(hold.activation_day ? { actual_price: maximum } : {}), settled: true, charged: amount, settled_at: now };
  // The permanent receipt is also the reservation tombstone; duplicates cannot spend twice.
  if (!immediate && !compact) await tx.delete(`hold:${id}`);
  await tx.put(`receipt:${id}`, result);
  return result;
}
/** Credit a verified payment once, even across repeated webhook deliveries. */
export async function deposit(tx, id, amount, now = Date.now()) {
  money(amount);
  if (await tx.get(`deposit:${id}`)) return { duplicate: true };
  const state = await accountMoney(tx);
  const balance = state.balance_microdollars + amount; money(balance);
  await appendLedger(tx, state, { id, kind: 'deposit', amount_microdollars: amount, created_at: now });
  await tx.put('balance', { ...state, balance_microdollars: balance }); await tx.put(`deposit:${id}`, { amount, created_at: now });
  return { balance_microdollars: balance };
}
