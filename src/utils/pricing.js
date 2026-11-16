import { worstCaseCost, COST_POLICY } from './cost-policy.js';
export const PRICES = Object.freeze({ run: 30, hook: 5, change: 100, read: 1, proseBase: 500, proseMarkup: 1.64, minimumDepositCents: 500 });
/** Quote the maximum integer charge before any billable work starts. */
export function price(op, action = {}) {
  if (op === 'run' || op === 'hook') return PRICES.run + (op === 'hook' ? PRICES.hook : 0) + (action.type === 'javascript' ? Math.ceil(action.cpu_ms * 0.05) + action.subrequests : 0);
  return PRICES[op] ?? 0;
}
/** Assert a price preserves the required margin after payment losses. */
export function passesFloor(op, action) { return price(op, action) * COST_POLICY.revenueKept >= COST_POLICY.minimumMargin * worstCaseCost(op, action); }
