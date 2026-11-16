import { it, expect } from 'vitest';
import { price, passesFloor, PRICES } from './pricing.js';
import { grossUp, COST_POLICY } from './cost-policy.js';
it('keeps every price above the cost floor, including JS extremes', () => {
  for (const op of ['run', 'hook', 'change', 'read']) {
    for (const action of [{ type: 'http' }, { type: 'javascript', cpu_ms: 10, subrequests: 0 }, { type: 'javascript', cpu_ms: 30000, subrequests: 50 }]) {
      expect(Number.isSafeInteger(price(op, action))).toBe(true);
      expect(passesFloor(op, action), `${op}: ${JSON.stringify(action)}`).toBe(true);
    }
  }
  expect(passesFloor('read', { job_count: 100 })).toBe(true);
  expect(PRICES.proseMarkup * COST_POLICY.revenueKept).toBeGreaterThanOrEqual(1.5);
});
it('passes payment costs through without reducing the credited deposit', () => {
  for (const credit of [500, 2000, 100000]) expect(grossUp(credit) * (1 - COST_POLICY.stripeRate) - COST_POLICY.stripeFixedCents).toBeGreaterThanOrEqual(credit);
});
