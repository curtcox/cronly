// Provider list prices checked 2026-11-15; source links in docs/business/pricing.md.
export const COST_POLICY = Object.freeze({
  workerRequest: 0.30, workerCpuMs: 0.02, doRequest: 0.15,
  doSecond: 1.5625, rowWritten: 1, rowRead: 0.001, storageKBMonth: 0.2,
  queueOperation: 0.40, dynamicWorkerDay: 2000, stripeRate: 0.029, stripeFixedCents: 30,
  revenueKept: 0.92, minimumMargin: 1.5, newAccountDepositCapCents: 2000,
  maxJobs: 100, newAccountMaxJobs: 10, concurrency: 10,
  destinationRequestsPerMinute: 60, projectionBrakeCents: 5000,
  // Includes redirects, test-job setup, alarms, pruning, refused retries and redelivery.
  runRowWrites: 35, runDoRequests: 27, runWorkerRequests: 5,
  // devicebasedauth.org (its docs/business/pricing.md): online decisions and OIDC sign-ins are
  // billed to cronly as the cronly.org audience owner, including denials.
  dbaDecision: 14, dbaLogin: 14,
  // Verifying one DBA-authenticated request beyond an API key's cost: the DbaLinkDO lookup, the
  // shared DPoP replay claim (DO request, row write and its later delete), the account's
  // credential row (a write when it changes), the pushed-revocations read and ECDSA CPU.
  dbaVerification: 3.64
});
/** Gross up the credit to itemize payment costs, ported from hashbin. */
export function grossUp(creditCents) {
  if (!Number.isSafeInteger(creditCents) || creditCents < 0) throw new Error('Invalid credit');
  return Math.ceil((creditCents + COST_POLICY.stripeFixedCents) / (1 - COST_POLICY.stripeRate));
}
/**
 * Conservative bounds; queue retries and bookkeeping have explicit allowances. `dba` adds the
 * cost of verifying a devicebasedauth.org credential on the request that started the work.
 */
export function worstCaseCost(op, action = {}, { dba = false } = {}) {
  return operationCost(op, action) + (dba ? COST_POLICY.dbaVerification : 0);
}
function operationCost(op, action) {
  const c = COST_POLICY;
  const base = c.runDoRequests * c.doRequest + c.runRowWrites * c.rowWritten + 6 * c.queueOperation + c.runWorkerRequests * c.workerRequest + 20 * c.workerCpuMs + 16 * c.storageKBMonth + c.doSecond * 0.2 + 3000 * c.rowRead;
  if (op === 'run' || op === 'hook') return base + (op === 'hook' ? 2 : 0) + (action.type === 'javascript' ? c.dynamicWorkerDay + c.workerRequest + action.cpu_ms * c.workerCpuMs + action.subrequests * 2.3 : 0);
  // A DBA link charges a change before cronly pays DBA for the OIDC sign-in; an online decision
  // is a durable hold settled after DBA answers (change-sized bookkeeping plus DBA's price).
  if (op === 'dba_link') return 20 + c.dbaLogin;
  if (op === 'dba_decision') return 20 + c.dbaDecision;
  return op === 'change' ? 20 : op === 'read' ? 12 + (action.job_count || 0) * 1.2 : 0;
}
