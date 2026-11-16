// Provider list prices checked 2026-11-15; source links in docs/business/pricing.md.
export const COST_POLICY = Object.freeze({
  workerRequest: 0.30, workerCpuMs: 0.02, doRequest: 0.15,
  doSecond: 1.5625, rowWritten: 1, rowRead: 0.001, storageKBMonth: 0.2,
  queueOperation: 0.40, stripeRate: 0.029, stripeFixedCents: 30,
  revenueKept: 0.92, minimumMargin: 1.5, newAccountDepositCapCents: 2000,
  maxJobs: 100, newAccountMaxJobs: 10, concurrency: 10,
  destinationRequestsPerMinute: 60, projectionBrakeCents: 5000
});
/** Gross up the credit to itemize payment costs, ported from hashbin. */
export function grossUp(creditCents) {
  if (!Number.isSafeInteger(creditCents) || creditCents < 0) throw new Error('Invalid credit');
  return Math.ceil((creditCents + COST_POLICY.stripeFixedCents) / (1 - COST_POLICY.stripeRate));
}
/** Conservative bounds; queue retries and bookkeeping have explicit allowances. */
export function worstCaseCost(op, action = {}) {
  const c = COST_POLICY;
  const base = 8 * c.doRequest + 8 * c.rowWritten + 6 * c.queueOperation + c.workerRequest + 10 * c.workerCpuMs + 16 * c.storageKBMonth + c.doSecond * 0.2;
  if (op === 'run' || op === 'hook') return base + (op === 'hook' ? 1 : 0) + (action.type === 'javascript' ? c.workerRequest + action.cpu_ms * c.workerCpuMs + action.subrequests * 0.32 : 0);
  return op === 'change' ? 6 : op === 'read' ? 0.5 : 0;
}
