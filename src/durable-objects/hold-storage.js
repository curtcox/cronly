import { accountMoney } from './account-money.js';
import { assert } from '../utils/errors.js';

const MAX_BYTES = 8000;
const UPDATE_HEADROOM = 128;
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
export async function putHold(tx, hold) {
  const state = await accountMoney(tx); const holds = state.holds || [];
  const index = holds.findIndex(item => item.id === hold.id);
  if (index >= 0) {
    holds[index] = hold;
    // Claim/activation/gateway counters are the only growing fields. Reserve space
    // for those updates up front so claiming never needs an extra migration write.
    assert(bytes(holds) <= MAX_BYTES, 'hold_size_limit', 'Compact reservation exceeded its update allowance', 500);
    await tx.put('balance', { ...state, holds });
  } else if (!await tx.get(`hold:${hold.id}`) && bytes([...holds, hold]) + UPDATE_HEADROOM * (holds.length + 1) <= MAX_BYTES) {
    await tx.put('balance', { ...state, holds: [...holds, hold] });
  } else await tx.put(`hold:${hold.id}`, hold);
}
