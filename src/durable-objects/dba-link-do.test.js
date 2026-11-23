import { it, expect } from 'vitest';
import { DbaLinkDO } from './dba-link-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';

it('claims a DBA account once, replaces only the named stale holder and ignores late releases', async () => {
  const links = namespace(DbaLinkDO, {}); const call = (op, args) => rpc(links, 'dba_x', op, args);
  expect(await call('get')).toEqual({ account: null });
  expect(await call('claim', { account: 'a' })).toEqual({ account: 'a', claimed: true });
  expect(await call('claim', { account: 'a' })).toEqual({ account: 'a', claimed: true });
  expect(await call('claim', { account: 'b' })).toEqual({ account: 'a', claimed: false });
  expect(await call('claim', { account: 'b', replace: 'c' })).toEqual({ account: 'a', claimed: false });
  expect(await call('claim', { account: 'b', replace: 'a' })).toEqual({ account: 'b', claimed: true });
  await call('release', { account: 'a' });
  expect(await call('get')).toEqual({ account: 'b' });
  await call('release', { account: 'b' });
  expect(await call('get')).toEqual({ account: null });
  await expect(call('other')).rejects.toMatchObject({ status: 404, code: 'unknown_operation' });
});
