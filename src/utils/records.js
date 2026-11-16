/** Read only stored entries; valid customer names can also be prototype properties. */
export function ownValue(record, key) {
  return record != null && Object.hasOwn(record, key) ? record[key] : undefined;
}
