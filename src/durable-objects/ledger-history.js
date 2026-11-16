import { accountMoney } from './account-money.js';

const PAGE_PREFIX = 'ledger-page:';
const MAX_ENTRIES = 100;
const MAX_BYTES = 16000;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Append history to the balance write; archive a bounded page only when full. */
export async function appendLedger(tx, state, value) {
  const prior = state.ledger;
  // A sequence orders simultaneous entries and survives a backwards wall clock.
  // Cursors are opaque; the entry still reports its actual creation time.
  const timestamp = Math.max(value.created_at, prior?.timestamp || 0);
  const sequence = timestamp === prior?.timestamp ? prior.sequence + 1 : 0;
  const key = `ledger:${String(timestamp).padStart(13, '0')}:~${String(sequence).padStart(16, '0')}:${value.id}`;
  const entry = [key, value]; const items = prior?.items || [];
  if (items.length && (items.length >= MAX_ENTRIES || new TextEncoder().encode(JSON.stringify([...items, entry])).byteLength > MAX_BYTES)) {
    await tx.put(`${PAGE_PREFIX}${items.at(-1)[0]}`, items);
    state.ledger = { timestamp, sequence, items: [entry] };
  } else state.ledger = { timestamp, sequence, items: [...items, entry] };
}

/** Merge compact pages, the active buffer and legacy rows using stable cursors. */
export async function listLedger(tx, { cursor, reverse = false, limit = 1000 } = {}) {
  limit = Math.min(limit || 1000, 1000);
  const eligible = ([key]) => !cursor || (reverse ? key < cursor : key > cursor);
  const state = await accountMoney(tx);
  const entries = (state.ledger?.items || []).filter(eligible);
  const legacy = await tx.list({ prefix: 'ledger:', ...(cursor ? reverse ? { end: cursor } : { startAfter: cursor } : {}), limit, reverse });
  entries.push(...legacy);
  let boundary = cursor && `${PAGE_PREFIX}${cursor}`;
  if (reverse && cursor) {
    // A page is keyed by its final entry. The cursor can be inside that page.
    const containing = await tx.list({ prefix: PAGE_PREFIX, start: boundary, limit: 1 });
    for (const [key, page] of containing) { entries.push(...page.filter(eligible)); boundary = key; }
  }
  // Read at most one bounded page at a time. Stop once the compact stream alone
  // supplies a page; merging legacy rows can only displace those entries.
  let compactCount = reverse ? (state.ledger?.items || []).filter(eligible).length : 0;
  if (reverse && cursor) compactCount = entries.length - legacy.size;
  while (compactCount < limit) {
    const pages = await tx.list({ prefix: PAGE_PREFIX, ...(boundary ? reverse ? { end: boundary } : { startAfter: boundary } : {}), limit: 1, reverse });
    if (!pages.size) break;
    const [key, page] = [...pages][0];
    const matching = page.filter(eligible); entries.push(...matching); compactCount += matching.length;
    boundary = key;
  }
  entries.sort(([a], [b]) => (reverse ? -1 : 1) * compare(a, b));
  const page = entries.slice(0, limit);
  return { items: page.map(([, value]) => value), next_cursor: page.length === limit ? page.at(-1)[0] : null };
}
