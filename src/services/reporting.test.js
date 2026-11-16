import { it, expect } from 'vitest';
import { upcoming, projection, countFires } from './reporting.js';
import { explainCron, nextFires } from './cron.js';
const config = { actions: { ping: { type: 'http' } }, jobs: { hourly: { action: 'ping', cron: '0 * * * *', timezone: 'UTC', enabled: true, budget: {} } } };
it('enumerates exact ordered upcoming fires and marks bounded subtotals', () => {
  const from = Date.parse('2026-11-15T00:00Z');
  expect(upcoming(config, from, from + 86400000, 10)).toMatchObject({ truncated: true, subtotal_microdollars: 300 });
  expect(countFires('* * * * *', 'UTC', from, from + 30 * 86400000)).toBe(43200);
  expect(countFires('*/5 * * * *', 'UTC', from, from + 30 * 86400000)).toBe(8640);
});
it('projects schedules, caps budgets, and computes runway from spendable balance', () => {
  const result = projection(config, { balance_microdollars: 10000, held_microdollars: 1000 }, [], Date.parse('2026-11-15T00:00Z'));
  expect(result.monthly_microdollars).toBe(21600); expect(result.runway_days).toBe(12.5);
  const capped = structuredClone(config); capped.jobs.hourly.budget = { day: 100, month: 2000 };
  expect(projection(capped, { balance_microdollars: 100, held_microdollars: 0 }).monthly_microdollars).toBe(2000);
});
it('rejects seconds, invalid zones, and handles the DST spring gap deterministically', () => {
  expect(() => explainCron('* * * * * *')).toThrow(); expect(() => explainCron('* * * * *', 'bad/zone')).toThrow();
  expect(nextFires('0 9 * * *', 'America/Chicago', 2, new Date('2026-03-07T00:00Z'))).toEqual(['2026-03-07T15:00:00.000Z', '2026-03-08T14:00:00.000Z']);
});
