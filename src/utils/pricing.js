import { worstCaseCost, COST_POLICY } from './cost-policy.js';
export const PRICES = Object.freeze({ run: 79, hook: 5, change: 100, read: 21, readJob: 2, jsActivation: 3300, jsCpuMs: 0.05, jsSubrequest: 5, proseBase: 500, proseMarkup: 1.64, minimumDepositCents: 500, dbaRequest: 7, dbaDecision: 56 });
/**
 * Quote the maximum integer charge before any billable work starts. `dba` is a request
 * authenticated by a devicebasedauth.org credential: its reads and the first attempt of the runs
 * it starts carry `dbaRequest` for verifying it. Other operations' margins already cover that.
 */
export function price(op, action = {}, { dba = false } = {}) {
  return operationPrice(op, action) + (dba && ['read', 'run'].includes(op) ? PRICES.dbaRequest : 0);
}
function operationPrice(op, action) {
  if (op === 'dba_link') return PRICES.change;
  if (op === 'dba_decision') return PRICES.dbaDecision;
  if (op === 'run' || op === 'hook') return PRICES.run + (op === 'hook' ? PRICES.hook : 0) + (action.type === 'javascript' ? PRICES.jsActivation + Math.ceil(action.cpu_ms * PRICES.jsCpuMs) + action.subrequests * PRICES.jsSubrequest : 0);
  if (op === 'read') return PRICES.read + PRICES.readJob * (action.job_count || 0);
  return PRICES[op] ?? 0;
}
/** Assert a price preserves the required margin after payment losses. */
export function passesFloor(op, action, options) { return price(op, action, options) * COST_POLICY.revenueKept >= COST_POLICY.minimumMargin * Math.ceil(worstCaseCost(op, action, options)); }
