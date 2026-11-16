import { cron } from './cron.js';
import { price } from '../utils/pricing.js';
import { assert } from '../utils/errors.js';
/** Exact bounded-window count; dense uniform schedules avoid enumerating every minute. */
export function countFires(expression, timezone, from, to) {
  const schedule = cron(expression, timezone);
  const [minute, hour, dom, month, dow] = expression.trim().split(/\s+/);
  const uniform = /^\*(?:\/\d+)?$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*';
  if (uniform) {
    // UTC boundaries are also minute boundaries in supported contemporary IANA zones.
    const step = minute === '*' ? 1 : Number(minute.slice(2));
    if (60 % step === 0) {
      const first = schedule.nextRun(new Date(from - 1));
      if (!first || +first >= to) return 0;
      return Math.ceil((to - +first) / (step * 60000));
    }
  }
  let count = 0; let cursor = new Date(from - 1);
  while (count <= 50000) {
    const next = schedule.nextRun(cursor); if (!next || +next >= to) return count;
    count++; cursor = next;
  }
  assert(false, 'projection_limit', 'Projection window is too large');
}
/** Enumerate only a requested page of upcoming runs; the subtotal is explicitly bounded. */
export function upcoming(config, from, to, limit = 100) {
  assert(Number.isFinite(from) && Number.isFinite(to) && to > from && to - from <= 31 * 86400000, 'invalid_window', 'Choose a window of at most 31 days');
  const cursors = Object.entries(config.jobs).filter(([, j]) => j.enabled && j.cron).map(([name, job]) => {
    const schedule = cron(job.cron, job.timezone); return { name, job, schedule, next: schedule.nextRun(new Date(from - 1)) };
  });
  const items = [];
  while (items.length < limit) {
    const next = cursors.filter(c => c.next && +c.next < to).sort((a, b) => +a.next - +b.next || a.name.localeCompare(b.name))[0];
    if (!next) break;
    items.push({ job: next.name, action: next.job.action, scheduled_at: next.next.toISOString(), price_microdollars: price('run', config.actions[next.job.action]) });
    next.next = next.schedule.nextRun(next.next);
  }
  const truncated = cursors.some(c => c.next && +c.next < to);
  return { items, truncated, next_from: truncated ? items.at(-1).scheduled_at : null, subtotal_microdollars: items.reduce((sum, r) => sum + r.price_microdollars, 0) };
}
/** Forecast scheduled maximum spend, capped by each job's UTC budget. */
export function projection(config, balance, webhookRuns = [], now = Date.now()) {
  const from = Date.parse(new Date(now).toISOString().slice(0, 10));
  const to = from + 30 * 86400000; const jobs = [];
  for (const [name, job] of Object.entries(config.jobs)) {
    if (!job.enabled) continue;
    const runPrice = price('run', config.actions[job.action]);
    const count = job.cron ? countFires(job.cron, job.timezone, from, to) : webhookRuns.filter(r => r.job === name && r.created_at >= now - 7 * 86400000).length / 7 * 30;
    let monthly = Math.ceil(count * runPrice);
    if (job.budget.day != null) monthly = Math.min(monthly, job.budget.day * 30);
    if (job.budget.month != null) monthly = Math.min(monthly, job.budget.month);
    jobs.push({ job: name, runs_30_days: count, monthly_microdollars: monthly, daily_microdollars: Math.ceil(monthly / 30) });
  }
  const monthly = jobs.reduce((sum, j) => sum + j.monthly_microdollars, 0); const daily = Math.ceil(monthly / 30);
  const available = balance.balance_microdollars - balance.held_microdollars;
  const days = daily ? available / daily : null;
  return { jobs, daily_microdollars: daily, monthly_microdollars: monthly, runway_days: days, runs_until: days === null || days > 36500 ? null : new Date(now + days * 86400000).toISOString(), more_than_a_year: days === null || days > 365, estimate: '30-day maximum at current schedules; webhook-only jobs use trailing 7-day activity' };
}
/** Filter retained logs without ever treating response excerpts as markup. */
export function filterRuns(runs, params) {
  const from = params.get('from') ? Date.parse(params.get('from')) : 0;
  const to = params.get('to') ? Date.parse(params.get('to')) : Infinity;
  assert(Number.isFinite(from) && (to === Infinity || Number.isFinite(to)), 'invalid_window', 'Invalid date range');
  return runs.filter(run => (!params.get('job') || run.job === params.get('job')) && (!params.get('status') || run.status === params.get('status')) && run.created_at >= from && run.created_at <= to).sort((a, b) => b.created_at - a.created_at);
}
/** Group permanent run charges by job, action or UTC day. */
export function costGroups(entries, params) {
  const group = params.get('group') || 'day'; assert(['day', 'job', 'action'].includes(group), 'invalid_group', 'Group must be day, job or action');
  const buckets = {};
  for (const entry of filterRuns(entries, params)) {
    if (entry.amount_microdollars >= 0) continue;
    const key = group === 'day' ? new Date(entry.created_at).toISOString().slice(0, 10) : entry[group] || entry.kind;
    buckets[key] = (buckets[key] || 0) - entry.amount_microdollars;
  }
  return { group, items: Object.entries(buckets).map(([name, cost_microdollars]) => ({ name, cost_microdollars })), total_microdollars: Object.values(buckets).reduce((sum, v) => sum + v, 0) };
}
