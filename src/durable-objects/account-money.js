import { ACCOUNT_STATE_LIMITS } from './account-state-limits.js';

/** Read compact money state while accepting the original scalar balance. */
export async function accountMoney(tx) {
  const value = await tx.get('balance');
  return typeof value === 'object' && value !== null ? value : { balance_microdollars: value || 0, summaries: {} };
}

/** Resolve a period from the compact state or permanent/legacy summary rows. */
export async function accountMetric(tx, period, state) {
  state ||= await accountMoney(tx);
  const current = state.summaries[period.length === 10 ? 'day' : 'month'];
  return current?.period === period ? current : await tx.get(`spent:account:self:${period}`);
}

/** Archive only on a UTC rollover; late settlements update their original period. */
export async function updateAccountMetric(tx, state, metric) {
  const slot = metric.period.length === 10 ? 'day' : 'month';
  const current = state.summaries[slot];
  // Two summaries must fit comfortably inside a single 128 KiB storage value.
  // A large new period stays standalone: retaining the older compact period avoids
  // paying to archive it AND write the new period during the same settlement.
  const oversized = new TextEncoder().encode(JSON.stringify(metric)).byteLength > ACCOUNT_STATE_LIMITS.summaryBytes;
  if (oversized || (current && current.period > metric.period)) {
    await tx.put(`spent:account:self:${metric.period}`, metric);
    if (current?.period === metric.period) delete state.summaries[slot];
    return;
  }
  if (current && current.period < metric.period) await tx.put(`spent:account:self:${current.period}`, current);
  state.summaries[slot] = metric;
}
