/** Upcoming windows, run history and its export, and historical costs. */
import { api, escapeHtml as e, dollars as usd } from './api.js';
import { $, content, state, currentPage, date, notify, clearNotice, empty, table, runRows, upcomingTable, download } from './workspace.js';

function upcomingResults(result, from, to) {
  return `<p class="note">${e(date(from))} to ${e(date(to))} (end excluded).</p>${result.items.length ? upcomingTable(result.items) : empty('No scheduled starts in this window.')}<p class="note">Window maximum ${e(usd(result.window_total_microdollars))} · Shown subtotal ${e(usd(result.subtotal_microdollars))}${result.truncated ? ' · First 100 starts shown. The window maximum includes all starts; narrow the window to see more detail.' : ''}</p>`;
}
function localDateTime(time) {
  const value = new Date(time);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}T${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}
export async function upcomingPage() {
  const version = state.renderVersion;
  const from = Math.floor(Date.now() / 60000) * 60000; const to = from + 86400000;
  const query = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit: '100' });
  const result = await api(`/api/upcoming?${query}`);
  if (version !== state.renderVersion || currentPage() !== 'upcoming') return;
  content.innerHTML = `<h1 class="app-title">Upcoming</h1><p class="muted">Scheduled starts and maximum prices. Budgets may pause a job before it fires. Times use ${e(Intl.DateTimeFormat().resolvedOptions().timeZone)}. Choose a window of at most 31 days.</p><form id="upcoming-filter" class="inline"><label>From<input name="from" type="datetime-local" value="${e(localDateTime(from))}" required></label><label>To<input name="to" type="datetime-local" value="${e(localDateTime(to))}" required></label><button>Show window</button></form><section class="panel" id="upcoming-results" aria-live="polite">${upcomingResults(result, from, to)}</section>`;
}
export async function filterUpcoming(form, data) {
  const results = $('#upcoming-results'); const button = form.querySelector('button');
  if (button.disabled) return;
  button.disabled = true; clearNotice();
  try {
    const from = new Date(data.get('from')).getTime(); const to = new Date(data.get('to')).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 31 * 86400000) throw new Error('Choose an end after the start and a window of at most 31 days.');
    const query = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit: '100' });
    const result = await api(`/api/upcoming?${query}`);
    if (results.isConnected) results.innerHTML = upcomingResults(result, from, to);
  } catch (error) { if (results.isConnected) throw error; }
  finally { button.disabled = false; }
}
export async function runsPage(query = '') {
  state.runsQuery = query; const filters = new URLSearchParams(query);
  const result = await api(`/api/runs${query}`);
  if (currentPage() !== 'runs') return;
  content.innerHTML = `<h1 class="app-title">Runs</h1><p class="muted">30 days or 1,000 runs per job, whichever is fewer. Every excerpt is displayed as text. Date filters include the whole selected UTC day.</p><form id="runs-filter" class="inline"><label>Job<input name="job" placeholder="Any job" value="${e(filters.get('job') || '')}"></label><label>Outcome<select name="status"><option value="">Any outcome</option>${['success', 'failure', 'paused', 'expired', 'queued'].map(s => `<option ${filters.get('status') === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label><label>From<input name="from" type="date" value="${e((filters.get('from') || '').slice(0, 10))}"></label><label>To<input name="to" type="date" value="${e((filters.get('to') || '').slice(0, 10))}"></label><button>Filter</button><button type="button" id="export-runs" class="secondary">${result.summary ? 'Export shown summaries' : 'Export job NDJSON'}</button></form><section class="panel">${result.items.length ? table(['Job / time', 'Outcome', 'Charge'], runRows(result.items)) : empty('No matching runs.')}<p class="note">${result.summary ? e(result.note) : 'Full log page, at most 100 runs.'}</p>${result.next_cursor ? `<button class="secondary" data-runs-cursor="${e(result.next_cursor)}">Older runs →</button>` : ''}</section>`;
}
export async function costsPage() {
  const result = await api('/api/costs?group=day');
  if (currentPage() !== 'costs') return;
  content.innerHTML = `<h1 class="app-title">Costs</h1><p class="muted">Integer micro-dollars. Forecasts use maximum configured prices.</p><div class="cards"><div class="card"><p>Daily burn</p><div class="metric">${e(usd(state.forecast.daily_microdollars))}</div></div><div class="card"><p>Next 30 days</p><div class="metric">${e(usd(state.forecast.monthly_microdollars))}</div></div><div class="card"><p>Available credit</p><div class="metric">${e(usd(state.account.balance_microdollars - state.account.held_microdollars))}</div></div></div><div class="grid"><section class="panel"><h2>Past spend</h2><form id="costs-filter" class="inline"><label>Group<select name="group"><option>day</option><option>job</option><option>action</option></select></label><label>From / UTC<input name="from" type="date" value="${e(result.from)}" required></label><label>To / UTC<input name="to" type="date" value="${e(result.to)}" required></label><button>Show spend</button></form><div id="costs-results">${costTable(result)}</div></section><section class="panel"><h2>Projection by job</h2>${table(['Job', 'Runs / 30 days', 'Daily max', '30-day max'], state.forecast.jobs.map(j => `<tr><td>${e(j.job)}</td><td>${e(j.runs_30_days)}</td><td>${e(usd(j.daily_microdollars))}</td><td>${e(usd(j.monthly_microdollars))}</td></tr>`))}<p class="note">${e(state.forecast.estimate)}</p></section></div>`;
}
function costTable(result) {
  return `<p class="note">${e(result.from)} through ${e(result.to)}, including both UTC days. Total ${e(usd(result.total_microdollars))}.</p>${result.items.length ? table([result.group, 'Spend'], result.items.map(i => `<tr><td>${e(i.name)}</td><td>${e(usd(i.cost_microdollars))}</td></tr>`)) : empty('No spend in this date range.')}`;
}
export async function filterCosts(form, data) {
  const results = $('#costs-results'); const button = form.querySelector('button');
  if (button.disabled) return;
  button.disabled = true; clearNotice();
  try {
    const result = await api(`/api/costs?${new URLSearchParams(data)}`);
    if (results.isConnected) results.innerHTML = costTable(result);
  } catch (error) { if (results.isConnected) throw error; }
  finally { button.disabled = false; }
}
export async function exportRuns(button) {
  button.disabled = true;
  try {
    const query = new URLSearchParams(state.runsQuery);
    // Export the matching job history from its beginning, even from an older
    // visible page. Global history remains an explicitly labelled summary.
    query.delete('cursor'); query.delete('before');
    const lines = []; const cursors = new Set(); let summary;
    for (;;) {
      const result = await api(`/api/runs?${query}`);
      lines.push(...result.items.map(run => JSON.stringify(run)));
      summary = result.summary;
      if (summary || !result.next_cursor) break;
      if (cursors.has(result.next_cursor)) throw new Error('Export could not advance through run history. Please try again.');
      cursors.add(result.next_cursor); query.set('cursor', result.next_cursor);
    }
    download('cronly-runs.ndjson', lines.length ? lines.join('\n') + '\n' : '', 'application/x-ndjson');
    notify(`Exported ${lines.length} ${summary ? 'run summaries' : 'runs'}.`);
  } finally { button.disabled = false; }
}
