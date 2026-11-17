import { CronPattern } from 'croner';
import { cron } from './cron.js';
import { price, PRICES } from '../utils/pricing.js';
import { assert } from '../utils/errors.js';
import { ownValue } from '../utils/records.js';
import { compareRuns } from './run-pagination.js';
const offsetCache = new Map();
function zoneOffset(zone, time) {
  const key = `${zone}:${time}`;
  if (offsetCache.has(key)) return offsetCache.get(key);
  const label = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date(time)).find(p => p.type === 'timeZoneName').value;
  const match = label.match(/GMT([+-])(\d{2}):(\d{2})/);
  const value = match ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1) * 60000 : 0;
  if (offsetCache.size > 4096) offsetCache.clear();
  offsetCache.set(key, value); return value;
}
function countUtc(pattern, from, to) {
  const slots = [];
  for (let hour = 0; hour < 24; hour++) if (pattern.hour[hour]) for (let minute = 0; minute < 60; minute++) if (pattern.minute[minute]) slots.push(hour * 60 + minute);
  let count = 0;
  for (let day = Math.floor(from / 86400000) * 86400000; day < to; day += 86400000) {
    const date = new Date(day); const dom = Boolean(pattern.day[date.getUTCDate() - 1]); const dow = Boolean(pattern.dayOfWeek[date.getUTCDay()]);
    const matches = pattern.starDOM ? dow : pattern.starDOW ? dom : dom || dow;
    if (!pattern.month[date.getUTCMonth()] || !matches) continue;
    if (from <= day && to >= day + 86400000) count += slots.length;
    else { const first = Math.ceil((from - day) / 60000); const last = Math.ceil((to - day) / 60000); count += slots.filter(slot => slot >= first && slot < last).length; }
  }
  return count;
}
/** Count numeric cron by calendar days; use croner itself on offset-transition days. */
export function countFires(expression, timezone, from, to) {
  const schedule = cron(expression, timezone);
  if (/^[0-9*/,\-\s]+$/.test(expression)) {
    const pattern = new CronPattern(expression, timezone);
    if (timezone === 'UTC') return countUtc(pattern, from, to);
    let count = 0;
    for (let day = Math.floor(from / 86400000) * 86400000; day < to; day += 86400000) {
      const start = Math.max(from, day); const end = Math.min(to, day + 86400000);
      const offset = zoneOffset(timezone, start); const lastOffset = zoneOffset(timezone, end - 1);
      if (offset === lastOffset) count += countUtc(pattern, start + offset, end + offset);
      else {
        let cursor = new Date(start - 1);
        for (;;) { const next = schedule.nextRun(cursor); if (!next || +next >= end) break; count++; cursor = next; }
      }
    }
    return count;
  }
  let count = 0; let cursor = new Date(from - 1);
  while (count <= 50000) { const next = schedule.nextRun(cursor); if (!next || +next >= to) return count; count++; cursor = next; }
  assert(false, 'projection_limit', 'Projection window is too large');
}
/** Enumerate only a requested page of upcoming runs; the subtotal is explicitly bounded. */
export function upcoming(config, from, to, limit = 100) {
  assert(Number.isFinite(from) && Number.isFinite(to) && to > from && to - from <= 31 * 86400000, 'invalid_window', 'Choose a window of at most 31 days');
  const cursors = Object.entries(config.jobs).filter(([, j]) => j.enabled && j.cron).map(([name, job]) => {
    const schedule = cron(job.cron, job.timezone); return { name, job, schedule, next: schedule.nextRun(new Date(from - 1)) };
  });
  const windowTotal = cursors.reduce((sum, c) => sum + countFires(c.job.cron, c.job.timezone, from, to) * price('run', config.actions[c.job.action]), 0);
  const items = [];
  while (items.length < limit) {
    const next = cursors.filter(c => c.next && +c.next < to).sort((a, b) => +a.next - +b.next || a.name.localeCompare(b.name))[0];
    if (!next) break;
    items.push({ job: next.name, action: next.job.action, scheduled_at: next.next.toISOString(), price_microdollars: price('run', config.actions[next.job.action]) });
    next.next = next.schedule.nextRun(next.next);
  }
  const truncated = cursors.some(c => c.next && +c.next < to);
  return { items, truncated, window_total_microdollars: windowTotal, subtotal_microdollars: items.reduce((sum, r) => sum + r.price_microdollars, 0) };
}
/** Forecast scheduled maximum spend, capped by each job's UTC budget. */
export function projection(config, balance, webhookRuns = [], now = Date.now()) {
  const from = now; const to = now + 30 * 86400000; const jobs = [];
  for (const [name, job] of Object.entries(config.jobs)) {
    if (!job.enabled) continue;
    const action = config.actions[job.action];
    const runPrice = price('run', action) - (action.type === 'javascript' ? PRICES.jsActivation : 0);
    const months = {}; let count = 0;
    for (let day = Math.floor(from / 86400000) * 86400000; day < to; day += 86400000) {
      const start = Math.max(day, from); const end = Math.min(day + 86400000, to);
      const dayCount = job.cron ? countFires(job.cron, job.timezone, start, end) : (Array.isArray(webhookRuns) ? webhookRuns.filter(r => r.job === name && r.created_at >= now - 7 * 86400000).length : ownValue(webhookRuns, name) ?? 0) / 7 * (end - start) / 86400000;
      count += dayCount;
      let amount = Math.ceil(dayCount * runPrice) + (dayCount > 0 && action.type === 'javascript' ? PRICES.jsActivation : 0);
      if (job.budget.day != null) amount = Math.min(amount, Math.max(0, job.budget.day - (day === Math.floor(now / 86400000) * 86400000 ? ownValue(balance.spend_today_by_job, name) ?? 0 : 0)));
      const month = new Date(day).toISOString().slice(0, 7);
      months[month] = (months[month] || 0) + amount;
    }
    let monthly = 0;
    for (const [month, amount] of Object.entries(months)) {
      const spent = month === new Date(now).toISOString().slice(0, 7) ? ownValue(balance.spend_by_job, name) ?? 0 : 0;
      monthly += job.budget.month == null ? amount : Math.min(amount, Math.max(0, job.budget.month - spent));
    }
    jobs.push({ job: name, runs_30_days: Math.ceil(count), monthly_microdollars: monthly, daily_microdollars: Math.ceil(monthly / 30) });
  }
  const monthly = jobs.reduce((sum, j) => sum + j.monthly_microdollars, 0); const daily = Math.ceil(monthly / 30);
  const available = balance.balance_microdollars - balance.held_microdollars;
  const days = daily ? available / daily : null;
  return { jobs, daily_microdollars: daily, monthly_microdollars: monthly, runway_days: days, runs_until: days === null || days > 36500 ? null : new Date(now + days * 86400000).toISOString(), more_than_a_year: days === null || days > 365, estimate: '30-day maximum with UTC budget resets; JS includes one activation allowance per active job/day (shared versions may cost less); webhook-only jobs use seven UTC calendar days of billed activity' };
}
/** Filter retained logs without ever treating response excerpts as markup. */
export function filterRuns(runs, params) {
  const from = params.get('from') ? Date.parse(params.get('from')) : 0;
  const to = params.get('to') ? Date.parse(params.get('to')) : Infinity;
  assert(Number.isFinite(from) && (to === Infinity || Number.isFinite(to)), 'invalid_window', 'Invalid date range');
  return runs.filter(run => (!params.get('job') || run.job === params.get('job')) && (!params.get('status') || run.status === params.get('status')) && run.created_at >= from && run.created_at <= to).sort(compareRuns);
}
/** Group permanent run charges by job, action or UTC day. */
export function costGroups(entries, params) {
  const group = params.get('group') || 'day'; assert(['day', 'job', 'action'].includes(group), 'invalid_group', 'Group must be day, job or action');
  const buckets = Object.create(null);
  for (const entry of filterRuns(entries, params)) {
    if (entry.amount_microdollars >= 0) continue;
    const key = group === 'day' ? new Date(entry.created_at).toISOString().slice(0, 10) : entry[group] || entry.kind;
    buckets[key] = (buckets[key] || 0) - entry.amount_microdollars;
  }
  return { group, items: Object.entries(buckets).map(([name, cost_microdollars]) => ({ name, cost_microdollars })), total_microdollars: Object.values(buckets).reduce((sum, v) => sum + v, 0) };
}
