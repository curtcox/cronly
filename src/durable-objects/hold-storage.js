import { accountMoney } from './account-money.js';
import { assert } from '../utils/errors.js';
import { recordRun } from './run-activity.js';
import { ACCOUNT_STATE_LIMITS } from './account-state-limits.js';

const UPDATE_HEADROOM = ACCOUNT_STATE_LIMITS.holdUpdateHeadroom;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Read active reservations without scanning permanent receipt tombstones. */
export async function listHolds(tx, state) {
  state ||= await accountMoney(tx);
  return [...(state.holds || []), ...(await tx.list({ prefix: 'hold:' })).values()].filter(hold => !hold.settled);
}

/** Accept compact reservations and the original standalone storage format. */
export async function getHold(tx, id) {
  const state = await accountMoney(tx);
  return state.holds?.find(hold => hold.id === id) || await tx.get(`hold:${id}`);
}

/** Small snapshots share the balance row; large or legacy holds stay standalone. */
export async function putHold(tx, hold, activity) {
  const state = await accountMoney(tx); const holds = state.holds || [];
  const activityChanged = activity && await recordRun(tx, activity.name, activity.now, activity.items, state);
  const maxBytes = state.run_activity ? ACCOUNT_STATE_LIMITS.holdsWithActivityBytes : ACCOUNT_STATE_LIMITS.holdBytes;
  const index = holds.findIndex(item => item.id === hold.id);
  if (index >= 0) {
    holds[index] = hold;
    // Claim/activation/gateway counters are the only growing fields. Reserve space
    // for those updates up front so claiming never needs an extra migration write.
    assert(bytes(holds) <= maxBytes, 'hold_size_limit', 'Compact reservation exceeded its update allowance', 500);
    await tx.put('balance', { ...state, holds });
  } else if (!await tx.get(`hold:${hold.id}`) && bytes([...holds, hold]) + UPDATE_HEADROOM * (holds.length + 1) <= maxBytes) {
    await tx.put('balance', { ...state, holds: [...holds, hold] });
  } else {
    await tx.put(`hold:${hold.id}`, hold);
    if (activityChanged) await tx.put('balance', state);
  }
}
