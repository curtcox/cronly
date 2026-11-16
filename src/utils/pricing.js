import { worstCaseCost, COST_POLICY } from './cost-policy.js';
export const PRICES = Object.freeze({ run: 50, hook: 5, change: 100, read: 20, jsActivation: 3300, jsCpuMs: 0.05, jsSubrequest: 5, proseBase: 500, proseMarkup: 1.64, minimumDepositCents: 500 });
/** Quote the maximum integer charge before any billable work starts. */
export function price(op, action = {}) {
  if (op === 'run' || op === 'hook') return PRICES.run + (op === 'hook' ? PRICES.hook : 0) + (action.type === 'javascript' ? PRICES.jsActivation + Math.ceil(action.cpu_ms * PRICES.jsCpuMs) + action.subrequests * PRICES.jsSubrequest : 0);
  return PRICES[op] ?? 0;
}
/** Assert a price preserves the required margin after payment losses. */
export function passesFloor(op, action) { return price(op, action) * COST_POLICY.revenueKept >= COST_POLICY.minimumMargin * worstCaseCost(op, action); }
