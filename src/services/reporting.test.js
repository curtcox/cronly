import { it, expect } from 'vitest';
import { upcoming, projection, countFires } from './reporting.js';
import { explainCron, nextFires, cron } from './cron.js';
import { PRICES } from '../utils/pricing.js';
const config = { actions: { ping: { type: 'http' } }, jobs: { hourly: { action: 'ping', cron: '0 * * * *', timezone: 'UTC', enabled: true, budget: {} } } };
it('enumerates exact ordered upcoming fires and marks bounded subtotals', () => {
  const from = Date.parse('2026-11-15T00:00Z');
  expect(upcoming(config, from, from + 86400000, 10)).toMatchObject({ truncated: true, subtotal_microdollars: 10 * PRICES.run });
  expect(countFires('* * * * *', 'UTC', from, from + 30 * 86400000)).toBe(43200);
  expect(countFires('*/5 * * * *', 'UTC', from, from + 30 * 86400000)).toBe(8640);
});
it('projects schedules, caps budgets, and computes runway from spendable balance', () => {
  const result = projection(config, { balance_microdollars: 10000, held_microdollars: 1000 }, [], Date.parse('2026-11-15T00:00Z'));
  expect(result.monthly_microdollars).toBe(30 * 24 * PRICES.run); expect(result.runway_days).toBe(9000 / (24 * PRICES.run));
  const capped = structuredClone(config); capped.jobs.hourly.budget = { day: 100, month: 2000 };
  expect(projection(capped, { balance_microdollars: 100, held_microdollars: 0 }, [], Date.parse('2026-11-01T00:00Z')).monthly_microdollars).toBe(2000);
});
it('rejects seconds, invalid zones, and handles the DST spring gap deterministically', () => {
  expect(() => explainCron('* * * * * *')).toThrow(); expect(() => explainCron('* * * * *', 'bad/zone')).toThrow();
  expect(nextFires('0 9 * * *', 'America/Chicago', 2, new Date('2026-03-07T00:00Z'))).toEqual(['2026-03-07T15:00:00.000Z', '2026-03-08T14:00:00.000Z']);
});

it('matches croner across DST changes and DOM/DOW OR schedules', () => {
  const from = Date.parse('2026-10-31T00:00Z'); const to = Date.parse('2026-11-03T00:00Z');
  for (const [expression, zone] of [['* * * * *', 'America/Chicago'], ['*/7 9-17 * * 1-5', 'Asia/Kathmandu'], ['0 9 1 * 1', 'UTC']]) {
    const schedule = cron(expression, zone); let cursor = new Date(from - 1); let expected = 0;
    for (;;) { const next = schedule.nextRun(cursor); if (!next || +next >= to) break; expected++; cursor = next; }
    expect(countFires(expression, zone, from, to)).toBe(expected);
  }
});

it('applies each calendar-month budget separately when a forecast crosses its reset', () => {
  const capped = structuredClone(config); capped.jobs.hourly.budget = { month: 2000 };
  expect(projection(capped, { balance_microdollars: 10000, held_microdollars: 0 }, [], Date.parse('2026-11-15T00:00Z')).monthly_microdollars).toBe(4000);
});
