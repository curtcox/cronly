/**
 * Shared workspace state and helpers for the workspace modules. Values that pages read and
 * replace (the loaded config, account, forecast and deployment settings, the definition being
 * edited) live on one exported object, because importers cannot reassign a module's `let`.
 */
import { api, escapeHtml as e, dollars as usd } from './api.js';

export const $ = selector => document.querySelector(selector);
export const content = $('#content');
export const state = { config: undefined, account: undefined, forecast: undefined, deployment: undefined, editing: null, runsQuery: '', renderVersion: 0 };
export const currentPage = () => location.hash.slice(1) || 'dashboard';
let renderer = async () => {};
/** Registers the page renderer, so modules can re-render without importing app.js (no cycle). */
export function setRenderer(fn) { renderer = fn; }
/** Re-renders the current workspace page. */
export const render = () => renderer();
export const date = value => value ? new Date(value).toLocaleString() : '—';
export const json = value => e(JSON.stringify(value, null, 2));
export function notify(message, error = false) { $('#notice').hidden = false; $('#notice').className = `notice${error ? ' error' : ''}`; $('#notice').textContent = message; }
export function clearNotice() { $('#notice').hidden = true; }
export function empty(message) { return `<p class="empty">${e(message)}</p>`; }
export function table(headers, rows) { return `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`; }
export function runRows(runs) { return runs.map(run => `<tr><td><button class="secondary" data-run-detail="${e(run.id)}">${e(run.job)}</button><br><span class="small muted">${e(date(run.created_at))}</span></td><td><span class="tag ${e(run.status)}">${e(run.status)}</span></td><td>${e(usd(run.cost_microdollars || 0))}</td></tr>`); }
export function upcomingTable(items) { return table(['Job', 'Scheduled for', 'Maximum price'], items.map(item => `<tr><td>${e(item.job)}</td><td>${e(date(item.scheduled_at))}</td><td>${e(usd(item.price_microdollars))}</td></tr>`)); }
export async function refreshHeader() {
  [state.account, state.forecast, { config: state.config }] = await Promise.all([api('/api/account'), api('/api/projection'), api('/api/config')]);
  const days = state.forecast.runway_days; const balancePaused = Object.values(state.account.job_runtime || {}).some(j => j.paused === 'insufficient_balance');
  const runway = !state.forecast.daily_microdollars ? 'No scheduled spend at the current settings' : state.forecast.more_than_a_year ? 'Actions run for more than a year' : `Actions run until ${new Date(state.forecast.runs_until).toLocaleDateString()}`;
  $('#account-strip').hidden = false;
  $('#account-strip').className = `account-strip${balancePaused || (days !== null && days < 1) ? ' red' : days !== null && days < 7 ? ' amber' : ''}`;
  $('#account-strip').innerHTML = `<strong>Balance ${e(usd(state.account.balance_microdollars))}</strong><span>${e(runway)}${balancePaused ? ' · A job is paused for balance' : ''}</span><span class="small">Held ${e(usd(state.account.held_microdollars))}</span><a href="#account">Add credit →</a>`;
}
export function download(name, text, type = 'application/json') { const url = URL.createObjectURL(new Blob([text], { type })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
