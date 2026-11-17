import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, expect, vi } from 'vitest';

// Run the actual CLI body with isolated credentials and HTTP, retaining its
// assertions and finally blocks without importing a paid top-level command.
const source = readFileSync(new URL('./verify-sandbox-live.mjs', import.meta.url), 'utf8').replace("import assert from 'node:assert/strict';", '');
const execute = new (Object.getPrototypeOf(async function () {}).constructor)('assert', 'process', 'fetch', 'crypto', 'console', source);

for (const failure of ['none', 'polling', 'job-cleanup', 'cpu-escaped']) {
  it(`cleans up service acceptance definitions after ${failure}`, async () => {
    const deleted = []; const log = vi.fn();
    const fetch = vi.fn(async (value, options) => {
      const url = new URL(value);
      if (options.method === 'DELETE') {
        deleted.push(url.pathname);
        if (failure === 'job-cleanup' && url.pathname.includes('/jobs/')) return Response.json({ code: 'unavailable' }, { status: 503 });
      }
      if (url.pathname === '/api/runs') {
        if (failure === 'polling') throw new Error('Polling unavailable');
        return Response.json({ items: [{ status: failure === 'cpu-escaped' ? 'success' : 'failure' }] });
      }
      return Response.json({ quote_microdollars: 100 });
    });
    const result = execute(assert, { env: { CRONLY_API_KEY: 'synthetic-key', CRONLY_LIVE_ACCEPTANCE: '1' } }, fetch, { randomUUID: () => 'fixed-identity' }, { log });
    if (failure === 'none') await result;
    else await expect(result).rejects.toThrow();
    expect(deleted).toEqual(['/api/jobs/acceptance-fixed-id', '/api/actions/acceptance-fixed-id']);
    expect(log).toHaveBeenCalledTimes(failure === 'none' ? 1 : 0);
  });
}
