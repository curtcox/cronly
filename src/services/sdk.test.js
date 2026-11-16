import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { it, expect, vi } from 'vitest';
it('publishes an immutable version with matching SRI and only job-trigger authority', async () => {
  const source = readFileSync(new URL('../../frontend/sdk/v1/cronly.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../../frontend/sdk/integrity.json', import.meta.url), 'utf8'));
  expect(manifest.integrity).toBe(`sha384-${createHash('sha384').update(source).digest('base64')}`);
  const sandbox = { document: { currentScript: { src: 'https://cronly.org/sdk/v1/cronly.js' } }, URL, fetch: vi.fn(async () => Response.json({ reserved_microdollars: 55 })) };
  runInNewContext(source, sandbox);
  await sandbox.cronly.trigger('tk_abc.def', { message: 'hello' });
  expect(sandbox.fetch.mock.calls[0][0]).toBe('https://cronly.org/hook/tk_abc.def');
  expect(sandbox.fetch.mock.calls[0][1].credentials).toBe('omit');
  expect(sandbox.fetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  await expect(sandbox.cronly.trigger('crk_abc.def')).rejects.toThrow('trigger token');
});
