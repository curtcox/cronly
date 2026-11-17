import { afterEach, expect, it, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { base64url } from '../auth/crypto.js';

afterEach(() => vi.useRealTimers());

async function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const env = { ENVIRONMENT: 'local' };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  await rpc(env.ACCOUNTS, 'a', 'init', { account: 'a' });
  await env.ACCOUNTS.get('a').storage.put('job-index:j', { name: 'j', account: 'a' });
  const job = env.JOBS.get('a:j');
  // Retry chains share their parent's timestamp. Insert in a different order
  // from the cursor's tie breaker so storage/cache order cannot hide omissions.
  const runs = Array.from({ length: 205 }, (_, index) => ({ id: `a:j:${String(index).padStart(3, '0')}`, job: 'j', status: 'failure', created_at: Date.now(), response_excerpt: `output-${index}` }));
  for (const run of [...runs].reverse()) { await job.storage.put(`run:${run.id}`, run); await job.history(run); }
  const older = { id: 'a:j:older', job: 'j', status: 'success', created_at: Date.now() - 1000 };
  await job.storage.put(`run:${older.id}`, older); await job.history(older);
  const request = query => worker.fetch(new Request(`https://cronly.org/api/runs?${new URLSearchParams({ job: 'j', ...query })}`, { headers: { Authorization: 'LocalDev a' } }), env);
  return { env, job, request, runs, older };
}

it('pages all tied timestamps after restart and removal of the cursor anchor', async () => {
  const { env, job, request, runs } = await setup();
  let page = await (await request({ status: 'failure' })).json();
  expect(page.items).toHaveLength(100); expect(page.next_cursor).toEqual(expect.any(String));
  const ids = page.items.map(run => run.id);
  // A cursor is a position, not a lookup of a row which retention may remove.
  await job.storage.delete(`history:${ids.at(-1)}`); await job.storage.delete(`run:${ids.at(-1)}`);
  env.JOBS.objects.set('a:j', new JobDO({ storage: job.storage, blockConcurrencyWhile: fn => fn() }, env));
  while (page.next_cursor) {
    page = await (await request({ status: 'failure', cursor: page.next_cursor })).json();
    ids.push(...page.items.map(run => run.id));
  }
  expect(ids).toEqual(runs.map(run => run.id).sort().reverse());
  expect(new Set(ids).size).toBe(205); expect(page.next_cursor).toBeNull();
});

it('exports tied runs as NDJSON with a usable cursor header and preserves legacy before paging', async () => {
  const { request, older } = await setup();
  const first = await request({ format: 'ndjson' });
  expect(first.status).toBe(200);
  const read = async response => (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  const a = await read(first); const cursor = first.headers.get('X-Next-Cursor');
  expect(a).toHaveLength(100); expect(cursor).toBeTruthy();
  const second = await request({ format: 'ndjson', cursor }); const b = await read(second);
  expect(b).toHaveLength(100); expect(b[0].id < a.at(-1).id).toBe(true);
  const third = await request({ format: 'ndjson', cursor: second.headers.get('X-Next-Cursor') });
  expect(await read(third)).toHaveLength(6); expect(third.headers.get('X-Next-Cursor')).toBe('');
  const legacy = await (await request({ before: first.headers.get('X-Next-Before') })).json();
  expect(legacy.items).toEqual([older]);
});

const encoded = value => base64url(new TextEncoder().encode(JSON.stringify(value)));
for (const cursor of ['', 'not a cursor', 'x'.repeat(4097), encoded(null), encoded([2, 1000, 'id']), encoded([1, -1, 'id']), encoded([1, 1.5, 'id']), encoded([1, 1000, '']), encoded([1, 1000, 42]), encoded([1, 1000, 'id', 'extra'])]) {
  it(`rejects an invalid run cursor ${cursor.slice(0, 50)}`, async () => {
    const { request } = await setup();
    const response = await request({ cursor });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'invalid_cursor' });
  });
}

it('rejects cursors on the unpaginated account feed', async () => {
  const { env } = await setup();
  const response = await worker.fetch(new Request(`https://cronly.org/api/runs?cursor=${encoded([1, Date.now(), 'a:j:100'])}`, { headers: { Authorization: 'LocalDev a' } }), env);
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'invalid_cursor' });
});
