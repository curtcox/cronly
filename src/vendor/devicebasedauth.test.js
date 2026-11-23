import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { it, expect } from 'vitest';

const dir = new URL('./devicebasedauth/', import.meta.url);
// The README records the upstream hash of every file; a local edit would fork the single
// devicebasedauth.org evaluator, so it must fail here instead of shipping silently.
it('keeps the vendored devicebasedauth.org verifier byte-identical to its recorded upstream copy', () => {
  const readme = readFileSync(new URL('README.md', dir), 'utf8');
  const recorded = Object.fromEntries([...readme.matchAll(/^\| ([a-z-]+\.js) \| `([0-9a-f]{64})` \|$/gm)].map(([, name, hash]) => [name, hash]));
  const files = readdirSync(dir).filter(name => name.endsWith('.js')).sort();
  expect(Object.keys(recorded).sort()).toEqual(files);
  for (const name of files) expect(createHash('sha256').update(readFileSync(new URL(name, dir))).digest('hex'), name).toBe(recorded[name]);
});
