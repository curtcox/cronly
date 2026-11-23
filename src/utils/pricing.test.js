import { it, expect } from 'vitest';
import { price, passesFloor, PRICES } from './pricing.js';
import { grossUp, COST_POLICY, worstCaseCost, DBA_MAX_VERIFICATIONS, dbaVerifications } from './cost-policy.js';
it('keeps every price above the cost floor, including JS extremes', () => {
  for (const op of ['run', 'hook', 'change', 'read']) {
    for (const action of [{ type: 'http' }, { type: 'javascript', cpu_ms: 10, subrequests: 0 }, { type: 'javascript', cpu_ms: 30000, subrequests: 50 }]) {
      expect(Number.isSafeInteger(price(op, action))).toBe(true);
      expect(passesFloor(op, action), `${op}: ${JSON.stringify(action)}`).toBe(true);
    }
  }
  for (let job_count = 0; job_count <= COST_POLICY.maxJobs; job_count++) {
    expect(passesFloor('read', { job_count }), `read: ${job_count} jobs`).toBe(true);
    expect(price('read', { job_count }) * COST_POLICY.revenueKept).toBeGreaterThanOrEqual(COST_POLICY.minimumMargin * Math.ceil(worstCaseCost('read', { job_count })));
  }
  expect(PRICES.proseMarkup * COST_POLICY.revenueKept).toBeGreaterThanOrEqual(1.5);
});
it('keeps prices above the floor for work started by a devicebasedauth.org credential (S5)', () => {
  // Hooks are public (trigger tokens), so no DBA credential is verified for them.
  for (const op of ['run', 'change', 'read']) {
    for (const action of [{ type: 'http' }, { type: 'javascript', cpu_ms: 10, subrequests: 0 }, { type: 'javascript', cpu_ms: 30000, subrequests: 50 }]) {
      expect(passesFloor(op, action, { dba: true }), `${op} via DBA: ${JSON.stringify(action)}`).toBe(true);
    }
  }
  for (let job_count = 0; job_count <= COST_POLICY.maxJobs; job_count++) expect(passesFloor('read', { job_count }, { dba: true }), `read via DBA: ${job_count} jobs`).toBe(true);
  // Prose's fixed base dwarfs one verification.
  expect(PRICES.proseBase * COST_POLICY.revenueKept).toBeGreaterThanOrEqual(COST_POLICY.minimumMargin * Math.ceil(COST_POLICY.dbaVerification));
  expect(price('read', {}, { dba: true })).toBe(PRICES.read + PRICES.dbaRequest);
  expect(price('run', { type: 'http' }, { dba: true })).toBe(PRICES.run + PRICES.dbaRequest);
  expect(price('change', {}, { dba: true })).toBe(PRICES.change);
  // Linking pays DBA's sign-in; online decisions pay DBA's decision. Both are held first.
  expect(price('dba_link')).toBe(PRICES.change);
  expect(passesFloor('dba_link')).toBe(true);
  // The decision's request is verified once, and its route's own charge pays for that.
  expect(passesFloor('dba_decision')).toBe(true);
});
it('charges one dbaRequest per verification after timed challenges, within the floor (S5)', () => {
  expect([true, 1, 2, DBA_MAX_VERIFICATIONS, DBA_MAX_VERIFICATIONS + 3, false, 0, -1, 1.5, '2', undefined].map(dbaVerifications)).toEqual([1, 1, 2, 6, 6, 0, 0, 0, 0, 0, 0]);
  for (let dba = 1; dba <= DBA_MAX_VERIFICATIONS; dba++) {
    for (const op of ['run', 'change', 'read']) {
      for (const action of [{ type: 'http' }, { type: 'javascript', cpu_ms: 30000, subrequests: 50 }]) expect(passesFloor(op, action, { dba }), `${op} with ${dba} verifications`).toBe(true);
    }
    for (let job_count = 0; job_count <= COST_POLICY.maxJobs; job_count++) expect(passesFloor('read', { job_count }, { dba }), `read: ${job_count} jobs, ${dba} verifications`).toBe(true);
    expect(price('read', {}, { dba })).toBe(PRICES.read + dba * PRICES.dbaRequest);
    expect(price('change', {}, { dba })).toBe(PRICES.change);
  }
  // Prose's fixed base covers the most verifications a request can carry.
  expect(PRICES.proseBase * COST_POLICY.revenueKept).toBeGreaterThanOrEqual(COST_POLICY.minimumMargin * Math.ceil(DBA_MAX_VERIFICATIONS * COST_POLICY.dbaVerification));
});
it('passes payment costs through without reducing the credited deposit', () => {
  for (const credit of [500, 2000, 100000]) expect(grossUp(credit) * (1 - COST_POLICY.stripeRate) - COST_POLICY.stripeFixedCents).toBeGreaterThanOrEqual(credit);
});
