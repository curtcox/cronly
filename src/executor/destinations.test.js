import { expect, it } from 'vitest';
import { destinationHostname, validateDestination } from './destinations.js';

it('canonicalizes destination buckets without changing request origins or ports', () => {
  const url = validateDestination('https://EXAMPLE.com.:8443/path?q=value');
  expect(destinationHostname(url)).toBe('example.com');
  expect(url.href).toBe('https://example.com.:8443/path?q=value');
  expect(destinationHostname(validateDestination('http://example.com/'))).toBe('example.com');
  expect(destinationHostname(validateDestination('https://[2606:4700:4700::1111]/'))).toBe('[2606:4700:4700::1111]');
});

for (const host of ['cronly.org', 'hooks.cronly.org', 'localhost', 'metadata.google.internal', 'tenant.workers.dev']) {
  it(`keeps ${host} blocked with the DNS root-label dot`, () => {
    expect(() => validateDestination(`https://${host}./`)).toThrow(expect.objectContaining({ code: 'blocked_destination' }));
  });
}
