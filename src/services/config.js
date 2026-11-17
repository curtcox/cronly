import { assert } from '../utils/errors.js';
import { normalize, COLLECTIONS } from './definitions.js';
import { ownValue } from '../utils/records.js';
/** Build a concrete diff; secrets export as metadata and must be set separately. */
export function configDiff(current, desired) {
  assert(desired && typeof desired === 'object' && !Array.isArray(desired), 'invalid_config', 'Expected a config object');
  const changes = [];
  for (const kind of COLLECTIONS) {
    // Omitted collections are preserved, so they cannot contribute mutations.
    if (desired[kind] == null) continue;
    const collection = desired[kind];
    assert(collection && typeof collection === 'object' && !Array.isArray(collection), 'invalid_config', `Expected ${kind} object`);
    for (const name of Object.keys(current[kind])) if (!Object.hasOwn(collection, name)) changes.push({ kind, name, delete: true });
    for (const [name, value] of Object.entries(collection)) {
      if (kind === 'secrets') { assert(Object.hasOwn(current.secrets, name), 'write_only_secret', 'Set new secret values through /api/secrets/{name}'); continue; }
      const normalized = normalize(kind, kind === 'variables' ? { value } : value);
      const stored = ownValue(current[kind], name);
      const prior = kind === 'jobs' && stored ? { ...stored } : stored;
      if (kind === 'jobs' && prior) delete prior.max_run_microdollars;
      if (JSON.stringify(prior) !== JSON.stringify(normalized)) changes.push({ kind, name, value: kind === 'variables' ? { value } : value });
    }
  }
  return changes;
}
