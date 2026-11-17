/** Read only stored entries; valid customer names can also be prototype properties. */
export function ownValue(record, key) {
  return record != null && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Compare stored JSON values without treating object property order as a change. */
export function sameRecord(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameRecord(left[key], right[key]));
}
