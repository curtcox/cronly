/** Read recent jobs while accepting the original array of plain job names. */
export async function runActivity(tx) {
  const stored = await tx.get('recent-jobs');
  return Array.isArray(stored) ? stored.map(name => [name, null]) : stored?.items || [];
}

/** A compact timestamp overrides any older standalone cooldown for that name. */
export async function lastRun(tx, name, activity) {
  const entry = activity.find(([job]) => job === name);
  return entry?.[1] ?? await tx.get(`last-run:${name}`);
}

/** Share the cooldown and recent-job index write without losing evicted cooldowns. */
export async function recordRun(tx, name, now, activity) {
  const items = [[name, now], ...activity.filter(([job]) => job !== name)];
  for (const [job, started] of items.slice(100)) {
    // Deleted jobs and action tests can push a still-rate-limited name out of the
    // history index. Persist its authoritative timestamp before dropping it;
    // even an expired timestamp must override a stale legacy row after a retry.
    if (started !== null) await tx.put(`last-run:${job}`, started);
  }
  await tx.put('recent-jobs', { items: items.slice(0, 100) });
}
