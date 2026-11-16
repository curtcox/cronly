import { expect, it, vi } from 'vitest';
import { SafetyDO } from './safety-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';

async function setup(count) {
  const env = { ENVIRONMENT: 'production' }; env.SAFETY = namespace(SafetyDO, env);
  const object = env.SAFETY.get('global');
  const names = Array.from({ length: count }, (_, index) => `a${String(index).padStart(4, '0')}`);
  for (const account of names) await object.storage.put(`account:${account}`, { account });
  const call = (op, args) => rpc(env.SAFETY, 'global', op, args);
  return { env, object, names, call };
}

for (const count of [100, 1005]) {
  it(`paginates all ${count} registered accounts without truncation`, async () => {
    const { call, names } = await setup(count);
    let cursor; const seen = [];
    do {
      const page = await call('accounts', { cursor });
      expect(page.items.length).toBeLessThanOrEqual(100);
      seen.push(...page.items.map(item => item.account)); cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toEqual(names);
  });
}

it('persists bounded recovery pages and their cursor atomically across a cold restart', async () => {
  const { env, object, names, call } = await setup(205);
  const list = vi.spyOn(object.storage, 'list');
  await call('record', { report: { checked_at: Date.now(), brake: false } });
  expect(list).not.toHaveBeenCalled(); list.mockRestore();
  const initial = await object.storage.get('recovery');
  const put = object.storage.put.bind(object.storage);
  const fault = vi.spyOn(object.storage, 'put').mockImplementation(async (key, value) => {
    if (key === 'resume:a0050') throw new Error('outbox write failed');
    return put(key, value);
  });
  await expect(call('resume-accounts')).rejects.toMatchObject({ status: 500 });
  expect(await object.storage.get('recovery')).toEqual(initial);
  expect((await object.storage.list({ prefix: 'resume:' })).size).toBe(0);
  fault.mockRestore();
  const seen = []; let page;
  do {
    env.SAFETY.objects.set('global', new SafetyDO({ storage: object.storage }, env));
    page = await call('resume-accounts');
    expect(page.items.length).toBeLessThanOrEqual(100);
    for (const item of page.items) {
      expect(item.version).toBe(initial.version);
      seen.push(item.account); await call('resumed-account', item);
    }
    // A healthy monitor restart preserves the unfinished recovery generation.
    await call('record', { report: { checked_at: Date.now(), brake: false } });
  } while (page.more);
  expect(seen).toEqual(names);
  expect(await object.storage.get('recovery')).toBeUndefined();
  expect((await call('resume-accounts')).items).toEqual([]);
});

it('retains legacy outboxes while a newer generation scans beyond its first page', async () => {
  const { names, object, call } = await setup(205);
  // Accept the standalone outboxes written before paginated recovery existed.
  await object.storage.put('resume:a0204', { account: 'a0204', version: 'legacy' });
  await call('record', { report: { checked_at: Date.now(), brake: false } });
  const first = await call('resume-accounts');
  expect(first.items.map(item => item.account)).toEqual(names.slice(0, 100));
  for (const item of first.items) await call('resumed-account', item);
  const second = await call('resume-accounts');
  expect(second.items.map(item => item.account)).toEqual(names.slice(100, 200));
  for (const item of second.items) await call('resumed-account', item);
  const third = await call('resume-accounts');
  expect(third.items.map(item => item.account)).toEqual(names.slice(200));
  const newest = third.items.at(-1);
  expect(newest.version).not.toBe('legacy');
  await call('resumed-account', { account: 'a0204', version: 'legacy' });
  expect(await object.storage.get('resume:a0204')).toEqual(newest);
});
