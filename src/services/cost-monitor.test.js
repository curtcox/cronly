import { it, expect } from 'vitest';
import { SafetyDO } from '../durable-objects/safety-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { measuredCost, runCostMonitor } from './cost-monitor.js';
it('fails closed on missing or stale analytics and missing credentials', async () => {
  const env = { ENVIRONMENT: 'production' }; env.SAFETY = namespace(SafetyDO, env);
  expect((await rpc(env.SAFETY, 'global', 'status')).brake).toBe(true);
  await rpc(env.SAFETY, 'global', 'record', { report: { checked_at: Date.now() - 48 * 3600000, brake: false } });
  expect((await rpc(env.SAFETY, 'global', 'status')).brake).toBe(true);
  expect((await runCostMonitor(env)).brake).toBe(true);
  expect(() => measuredCost({ workers: [] })).toThrow();
});
it('computes actual billable totals and rejects truncated datasets', () => {
  const account = { workers: [{ sum: { requests: 100, cpuTimeUs: 100000 } }], invocations: [{ sum: { requests: 100 } }], periodic: [{ sum: { duration: 1, rowsRead: 1000, rowsWritten: 10 } }], storage: [{ max: { storedBytes: 1000000 } }] };
  expect(measuredCost(account)).toBeGreaterThan(50);
  account.workers = Array(10).fill(account.workers[0]); expect(() => measuredCost(account)).toThrow();
});
