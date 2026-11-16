import { Cron } from 'croner';
import cronstrue from 'cronstrue';
import { assert } from '../utils/errors.js';
/** Validate standard minute cron and IANA time zone without registering a timer. */
export function cron(expression, timezone = 'UTC') {
  assert(typeof expression === 'string' && expression.length <= 256 && typeof timezone === 'string' && !/^[-+]/.test(timezone) && expression.trim().split(/\s+/).length === 5, 'invalid_cron', 'Use a five-field cron expression (minimum interval one minute)');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); return new Cron(expression, { timezone, paused: true }); }
  catch { assert(false, 'invalid_cron', 'Invalid cron expression or time zone'); }
}
/** Compute deterministic future fires with a bounded count. */
export function nextFires(expression, timezone = 'UTC', count = 5, from = new Date()) { return cron(expression, timezone).nextRuns(count, from).map(date => date.toISOString()); }
/** Describe cron deterministically, never using an LLM. */
export function explainCron(expression, timezone = 'UTC', from = new Date()) {
  cron(expression, timezone);
  return { cron: expression, timezone, explanation: cronstrue.toString(expression), next_fires: nextFires(expression, timezone, 5, from) };
}
