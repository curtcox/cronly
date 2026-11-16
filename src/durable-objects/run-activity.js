import { accountMoney } from './account-money.js';
import { ACCOUNT_STATE_LIMITS } from './account-state-limits.js';

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Read recent jobs while accepting the original array of plain job names. */
export async function runActivity(tx) {
  const state = await accountMoney(tx);
  if (state.run_activity) return state.run_activity;
  const stored = await tx.get('recent-jobs');
  return Array.isArray(stored) ? stored.map(name => [name, null]) : stored?.items || [];
}

/** A compact timestamp overrides any older standalone cooldown for that name. */
export async function lastRun(tx, name, activity) {
  const entry = activity.find(([job]) => job === name);
  return entry?.[1] ?? await tx.get(`last-run:${name}`);
}

/** Share activity with a reservation's balance write when its bounded state fits. */
export async function recordRun(tx, name, now, activity, state) {
  const persist = !state;
  state ||= await accountMoney(tx);
  const items = [[name, now], ...activity.filter(([job]) => job !== name)];
  for (const [job, started] of items.slice(100)) {
    // Deleted jobs and action tests can push a still-rate-limited name out of the
    // history index. Persist its authoritative timestamp before dropping it;
    // even an expired timestamp must override a stale legacy row after a retry.
    if (started !== null) await tx.put(`last-run:${job}`, started);
  }
  const recent = items.slice(0, 100);
  // Leave room for both 50 KB summaries, the 16 KB ledger and 4 KB of holds.
  // Existing larger hold arrays keep their old layout until reservations drain.
  const limits = ACCOUNT_STATE_LIMITS;
  const canCompact = bytes(recent) <= limits.activityBytes && (state.run_activity || bytes(state.holds || []) + limits.holdUpdateHeadroom * (state.holds?.length || 0) <= limits.holdsWithActivityBytes);
  if (canCompact) {
    state.run_activity = recent;
    if (persist) await tx.put('balance', state);
    return true;
  }
  await tx.put('recent-jobs', { items: recent });
  if (state.run_activity) {
    delete state.run_activity;
    if (persist) await tx.put('balance', state);
    return true;
  }
  return false;
}
