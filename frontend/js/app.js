import { api, settings, setAuth, getLocalUser, signOut, escapeHtml as e, dollars as usd } from './api.js';
import { Cron } from '../vendor/croner.js';
const $ = selector => document.querySelector(selector);
const content = $('#content');
let runsQuery = '';
let renderVersion = 0;
const currentPage = () => location.hash.slice(1) || 'dashboard';
let config; let account; let forecast; let deployment; let pendingApply; let editing = null;
let pendingRun;
const date = value => value ? new Date(value).toLocaleString() : '—';
const json = value => e(JSON.stringify(value, null, 2));
function notify(message, error = false) { $('#notice').hidden = false; $('#notice').className = `notice${error ? ' error' : ''}`; $('#notice').textContent = message; }
function clearNotice() { $('#notice').hidden = true; }
function empty(message) { return `<p class="empty">${e(message)}</p>`; }
function table(headers, rows) { return `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`; }
function runRows(runs) { return runs.map(run => `<tr><td><button class="secondary" data-run-detail="${e(run.id)}">${e(run.job)}</button><br><span class="small muted">${e(date(run.created_at))}</span></td><td><span class="tag ${e(run.status)}">${e(run.status)}</span></td><td>${e(usd(run.cost_microdollars || 0))}</td></tr>`); }
function upcomingTable(items) { return table(['Job', 'Scheduled for', 'Maximum price'], items.map(item => `<tr><td>${e(item.job)}</td><td>${e(date(item.scheduled_at))}</td><td>${e(usd(item.price_microdollars))}</td></tr>`)); }
function review(title, quote, detail, callback, button = 'Apply') {
  $('#review-title').textContent = title; $('#review-price').textContent = `Maximum charge: ${usd(quote)} (${quote.toLocaleString()} µ$)`;
  $('#review-detail').textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
  $('#review-apply').textContent = button; pendingApply = callback; $('#review').showModal();
}
async function reviewed(path, method, body, callback, isCurrent = () => true) {
  const quote = await api(`${path}${path.includes('?') ? '&' : '?'}dry_run=1`, method, body);
  if (!isCurrent()) return;
  const idempotency = crypto.randomUUID();
  review('Review before applying', quote.quote_microdollars || 0, quote.changes || body || quote, async () => {
    const result = await api(path, method, body, idempotency);
    if (callback) await callback(result); else { editing = null; await render(); notify(`Applied. Charged ${usd(result.cost_microdollars)}.`); }
  });
}
$('#review-cancel').addEventListener('click', () => { pendingApply = null; $('#review').close(); });
function runInput(path, label, queued = 'Run') {
  pendingRun = { path, queued };
  $('#run-input-title').textContent = label;
  $('#run-input-value').value = '{}';
  $('#run-input-error').hidden = true;
  $('#run-input').showModal();
}
$('#run-input-cancel').addEventListener('click', () => $('#run-input').close());
$('#run-input').addEventListener('close', () => { pendingRun = null; });
$('#run-input-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!pendingRun || $('#run-input-quote').disabled) return;
  const run = pendingRun; const { path, queued } = run;
  $('#run-input-quote').disabled = true;
  $('#run-input-error').hidden = true;
  try {
    const input = JSON.parse($('#run-input-value').value);
    await reviewed(path, 'POST', { input }, async result => {
      await render(); notify(`${queued} queued; held ${usd(result.reserved_microdollars)}.`);
    }, () => pendingRun === run && $('#run-input').open);
    if (pendingRun === run) $('#run-input').close();
  } catch (error) {
    if (pendingRun === run && $('#run-input').open) {
      $('#run-input-error').textContent = error.message;
      $('#run-input-error').hidden = false;
    }
  } finally { $('#run-input-quote').disabled = false; }
});
$('#review-apply').addEventListener('click', async () => {
  const callback = pendingApply; if (!callback) return;
  document.body.dataset.applying = 'true';
  $('#review-apply').disabled = true;
  try { $('#review').close(); pendingApply = null; await callback(); }
  catch (error) { notify(error.message, true); }
  finally { $('#review-apply').disabled = false; delete document.body.dataset.applying; }
});
$('#sign-out').addEventListener('click', signOut);
async function refreshHeader() {
  [account, forecast, { config }] = await Promise.all([api('/api/account'), api('/api/projection'), api('/api/config')]);
  const days = forecast.runway_days; const balancePaused = Object.values(account.job_runtime || {}).some(j => j.paused === 'insufficient_balance');
  const runway = !forecast.daily_microdollars ? 'No scheduled spend at the current settings' : forecast.more_than_a_year ? 'Actions run for more than a year' : `Actions run until ${new Date(forecast.runs_until).toLocaleDateString()}`;
  $('#account-strip').hidden = false;
  $('#account-strip').className = `account-strip${balancePaused || (days !== null && days < 1) ? ' red' : days !== null && days < 7 ? ' amber' : ''}`;
  $('#account-strip').innerHTML = `<strong>Balance ${e(usd(account.balance_microdollars))}</strong><span>${e(runway)}${balancePaused ? ' · A job is paused for balance' : ''}</span><span class="small">Held ${e(usd(account.held_microdollars))}</span><a href="#account">Add credit →</a>`;
}
async function dashboard() {
  const [upcoming, runs] = await Promise.all([api('/api/upcoming?limit=10'), api('/api/runs')]);
  if (currentPage() !== 'dashboard') return;
  content.innerHTML = `<div class="row-header"><div><p class="eyebrow">Your schedules, at a glance</p><h1 class="app-title">Dashboard</h1></div><a href="#jobs" class="button">Create a job</a></div><div class="cards"><div class="card"><p class="note">Spent today</p><div class="metric">${e(usd(account.spent_today_microdollars))}</div></div><div class="card"><p class="note">Spent this month</p><div class="metric">${e(usd(account.spent_month_microdollars))}</div></div><div class="card"><p class="note">Projected / 30 days</p><div class="metric">${e(usd(forecast.monthly_microdollars))}</div></div></div><div class="grid"><section class="panel"><h2>Next on the schedule</h2>${upcoming.items.length ? upcomingTable(upcoming.items) : empty('No scheduled jobs yet. Create an action, then give it a schedule.')}<a href="#upcoming">See upcoming →</a></section><section class="panel"><h2>Recent runs</h2>${runs.items.length ? table(['Job / time', 'Outcome', 'Charge'], runRows(runs.items.slice(0, 10))) : empty('Your run history will appear here.')}<a href="#runs">All runs →</a></section></div><section class="section"><h2>Paused & disabled</h2>${Object.entries(config.jobs).filter(([name, j]) => !j.enabled || account.job_runtime?.[name]?.paused).map(([name]) => `<p><span class="tag paused">${e(account.job_runtime?.[name]?.paused || 'disabled')}</span> ${e(name)}</p>`).join('') || '<p class="muted">No disabled jobs. Balance and budget refusals appear in run history.</p>'}</section>`;
}
function definitionList(kind) {
  const items = Object.entries(config[kind]);
  return items.length ? `<ul class="list">${items.map(([name, value]) => `<li><div><span class="list-title">${e(name)}</span><br><span class="small muted">${e(kind === 'secrets' ? `Fingerprint ${value.fingerprint}` : kind === 'variables' ? value : kind === 'actions' ? value.type : value.cron || 'On demand / webhook only')}</span>${kind === 'jobs' ? `<p class="small">${e(value.cron ? window.cronstrue.toString(value.cron) : 'Manual and webhook only')} · ${e(value.timezone)}<br>Next: ${e(date(account.job_runtime?.[name]?.next_fire))} · Last: ${e(account.job_runtime?.[name]?.last_outcome || '—')}<br>30-day max: ${e(usd(forecast.jobs.find(j => j.job === name)?.monthly_microdollars || 0))} · Today: ${e(usd((Object.hasOwn(account.spend_today_by_job || {}, name) ? account.spend_today_by_job[name] : 0)))} / ${value.budget.day == null ? 'no daily cap' : e(usd(value.budget.day))}</p>` : ''}</div><div class="inline"><button class="secondary" data-edit="${e(name)}">Edit</button>${kind === 'jobs' ? `<button data-run="${e(name)}">Run</button><button class="secondary" data-toggle="${e(name)}">${value.enabled ? 'Pause' : 'Resume'}</button>` : ''}<button class="secondary" data-delete="${e(name)}">Delete</button></div></li>`).join('')}</ul>` : empty(`No ${kind} yet.`);
}
function definitionForm(kind) {
  const value = editing ? config[kind][editing] : undefined;
  const name = `<label>Name<input name="name" pattern="[a-z0-9\\-]{1,64}" maxlength="64" required value="${e(editing || '')}" ${editing ? 'readonly' : ''}></label>`;
  let fields;
  if (kind === 'variables' || kind === 'secrets') fields = `${name}<label>${kind === 'secrets' ? 'New secret value (write-only)' : 'Value'}<${kind === 'secrets' ? 'input type="password" autocomplete="new-password"' : 'textarea rows="4"'} name="value" required>${kind === 'variables' ? e(value || '') + '</textarea>' : ''}${kind === 'secrets' ? '' : ''}</label><p class="note">${kind === 'secrets' ? 'Existing values cannot be read. Saving replaces the encrypted value.' : 'Available in actions as {{var.NAME}}.'}</p>`;
  if (kind === 'actions') {
    const action = value || { type: 'http', method: 'GET', timeout_seconds: 10, cpu_ms: 100, subrequests: 5 };
    fields = `${name}<label>Type<select name="type" id="action-type"><option value="http" ${action.type === 'http' ? 'selected' : ''}>HTTP request</option><option value="javascript" ${action.type === 'javascript' ? 'selected' : ''}>JavaScript module</option></select></label><div id="http-fields" ${action.type === 'javascript' ? 'hidden' : ''}><div class="fields"><label>Method<select name="method">${['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map(m => `<option ${action.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label><label>Timeout / seconds<input type="number" name="timeout_seconds" min="1" max="30" value="${e(action.timeout_seconds || 10)}"></label><label class="wide">URL<input name="url" placeholder="https://api.example.com/health" value="${e(action.url || '')}"></label><label class="wide">Headers / JSON<textarea name="headers" rows="3">${json(action.headers || {})}</textarea></label><label class="wide">Body<textarea name="body" rows="4">${e(action.body || '')}</textarea></label><label class="wide">Success status ranges / JSON<textarea name="success_status" rows="2">${json(action.success_status || [[200, 299]])}</textarea></label></div><label class="check"><input type="checkbox" name="follow_redirects" ${action.follow_redirects ? 'checked' : ''}>Follow redirects (up to five; destinations checked)</label></div><div id="js-fields" ${action.type !== 'javascript' ? 'hidden' : ''}><div class="fields"><label>CPU limit / milliseconds<input name="cpu_ms" type="number" min="10" max="30000" value="${e(action.cpu_ms || 100)}"></label><label>Allowed subrequests<input name="subrequests" type="number" min="0" max="50" value="${e(action.subrequests ?? 5)}"></label></div><label>Module source<textarea class="code-editor" name="source" rows="12" spellcheck="false">${e(action.source || 'export default async function run(ctx) {\n  console.log(ctx.run.id);\n  return { ok: true };\n}')}</textarea></label><details><summary class="note">Syntax preview</summary><pre id="source-highlight"></pre></details><p class="note" id="js-price"></p><p class="note">No npm resolution. Native networking is blocked; use ctx.fetch. Console output is captured and redacted.</p></div>`;
  }
  if (kind === 'jobs') {
    const job = value || { timezone: 'UTC', cron: '0 * * * *', enabled: true, overlap: 'skip', missed: 'skip', retries: 0, budget: {} };
    fields = `${name}<label>Action<select name="action" required>${Object.keys(config.actions).map(a => `<option ${job.action === a ? 'selected' : ''}>${e(a)}</option>`).join('')}</select></label><div class="fields"><label>Cron (blank for on demand only)<input name="cron" id="job-cron" value="${e(job.cron || '')}" placeholder="0 * * * *"></label><label>Time zone<input name="timezone" id="job-timezone" value="${e(job.timezone)}" required></label></div><div id="cron-preview" class="schedule-preview" aria-live="polite"></div><label>Describe the schedule<textarea id="job-prose" rows="2" placeholder="Weekdays at 7am"></textarea></label><button type="button" id="translate-job" class="secondary">Quote prose translation</button><div class="fields"><label>Overlap<select name="overlap"><option ${job.overlap === 'skip' ? 'selected' : ''}>skip</option><option ${job.overlap === 'allow' ? 'selected' : ''}>allow</option></select></label><label>Missed run<select name="missed"><option ${job.missed === 'skip' ? 'selected' : ''}>skip</option><option ${job.missed === 'run_once' ? 'selected' : ''}>run_once</option></select></label><label>Immediate retries<input name="retries" type="number" min="0" max="3" value="${e(job.retries)}"></label><label>Daily budget / µ$<input name="budget_day" type="number" min="0" value="${e(job.budget.day ?? '')}" placeholder="No limit beyond balance"></label><label>Monthly budget / µ$<input name="budget_month" type="number" min="0" value="${e(job.budget.month ?? '')}"></label></div><label class="check"><input type="checkbox" name="enabled" ${job.enabled ? 'checked' : ''}>Enabled</label>`;
  }
  return `<form id="definition-form" data-kind="${kind}">${fields}<div class="form-actions"><button type="submit">Review save · ${deployment.prices.change} µ$</button><button type="button" id="new-definition" class="secondary">Clear / new</button></div></form>`;
}
function cronPreview() {
  if (!$('#job-cron')) return;
  try {
    const expression = $('#job-cron').value.trim(); const zone = $('#job-timezone').value;
    if (!expression) { $('#cron-preview').textContent = 'On demand and webhook triggers only.'; return; }
    if (expression.split(/\s+/).length !== 5) throw new Error('Use a five-field cron expression.');
    const cron = new Cron(expression, { timezone: zone, paused: true });
    $('#cron-preview').innerHTML = `<strong>${e(window.cronstrue.toString(expression))}</strong><ul>${cron.nextRuns(5).map(d => `<li>${e(d.toLocaleString(undefined, { timeZone: zone, timeZoneName: 'short' }))}</li>`).join('')}</ul>`;
  } catch (error) { $('#cron-preview').textContent = error.message; }
}
function updateJsPrice() {
  if (!$('#js-price')) return;
  const form = $('#definition-form'); const cpu = Number(form.elements.cpu_ms.value); const sub = Number(form.elements.subrequests.value); const p = deployment.prices;
  if ($('#source-highlight')) $('#source-highlight').innerHTML = e(form.elements.source.value).replace(/\b(export|default|async|function|return|const|let|await|if|throw|new)\b/g, '<span class="highlight">$1</span>');
  $('#js-price').textContent = `Maximum per run: ${usd(p.run + p.jsActivation + Math.ceil(cpu * p.jsCpuMs) + sub * p.jsSubrequest)}. Includes ${usd(p.jsActivation)} activation, charged only on the first use of this version per UTC day.`;
}
async function definitionsPage(kind) {
  content.innerHTML = `<div class="row-header"><div><h1 class="app-title">${e(kind[0].toUpperCase() + kind.slice(1))}</h1><p class="muted">Named, reusable pieces of your schedule.</p></div></div><div class="grid"><section class="panel"><h2>Your ${e(kind)}</h2>${definitionList(kind)}${kind === 'jobs' ? `<p class="note">Projected monthly spend and budgets are on <a href="#costs">Costs</a>. Runs start within a few seconds of the scheduled minute.</p>` : ''}</section><section class="panel"><h2>${editing ? `Edit ${e(editing)}` : `New ${e(kind.slice(0, -1))}`}</h2>${definitionForm(kind)}${editing && kind === 'jobs' ? '<div class="section"><h3>Trigger tokens</h3><button id="create-trigger" class="secondary">Review new trigger</button><div id="triggers"></div></div>' : ''}${editing && ['actions', 'jobs'].includes(kind) ? `<h3>Use from a script</h3><pre>curl -X ${kind === 'jobs' ? 'POST' : 'GET'} https://cronly.org/api/${kind}/${e(editing)}${kind === 'jobs' ? '/run' : ''} \\\n  -H 'Authorization: ApiKey YOUR_KEY'

fetch('https://cronly.org/api/${kind}/${e(editing)}${kind === 'jobs' ? '/run' : ''}', {
  method: '${kind === 'jobs' ? 'POST' : 'GET'}',
  headers: { Authorization: 'ApiKey YOUR_KEY' }
});</pre>${kind === 'actions' ? '<button id="test-action" class="secondary">Review test run</button>' : ''}` : ''}</section></div>`;
  cronPreview(); updateJsPrice();
  if (editing && kind === 'jobs') {
    const result = await api(`/api/jobs/${editing}/triggers`);
    if (!$('#triggers')) return;
    $('#triggers').innerHTML = result.items.length ? `<ul class="list">${result.items.map(t => `<li><span class="small mono">${e(t.id)} · ${t.revoked ? 'revoked' : `${t.rate_per_minute}/min`}</span>${t.revoked ? '' : `<button class="secondary" data-revoke-trigger="${e(t.id)}">Revoke</button>`}</li>`).join('')}</ul>` : empty('No trigger tokens.');
  }
}
async function upcomingPage() {
  const result = await api('/api/upcoming?limit=100');
  if (currentPage() !== 'upcoming') return;
  content.innerHTML = `<h1 class="app-title">Upcoming</h1><p class="muted">Scheduled starts and maximum prices. Budgets may pause a job before it fires.</p><form id="upcoming-filter" class="inline"><label>From<input name="from" type="datetime-local"></label><label>To<input name="to" type="datetime-local"></label><button>Show window</button></form><section class="panel" id="upcoming-results">${upcomingTable(result.items)}<p class="note">Window maximum ${e(usd(result.window_total_microdollars))} · Shown subtotal ${e(usd(result.subtotal_microdollars))}${result.truncated ? ' · First 100 shown; narrow the window for the full total.' : ''}</p></section>`;
}
async function runsPage(query = '') {
  runsQuery = query; const filters = new URLSearchParams(query);
  const result = await api(`/api/runs${query}`);
  if (currentPage() !== 'runs') return;
  content.innerHTML = `<h1 class="app-title">Runs</h1><p class="muted">30 days or 1,000 runs per job, whichever is fewer. Every excerpt is displayed as text.</p><form id="runs-filter" class="inline"><label>Job<input name="job" placeholder="Any job" value="${e(filters.get('job') || '')}"></label><label>Outcome<select name="status"><option value="">Any outcome</option>${['success', 'failure', 'paused', 'expired', 'queued'].map(s => `<option ${filters.get('status') === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label><label>From<input name="from" type="date" value="${e(filters.get('from') || '')}"></label><label>To<input name="to" type="date" value="${e(filters.get('to') || '')}"></label><button>Filter</button><button type="button" id="export-runs" class="secondary">Export NDJSON</button></form><section class="panel">${result.items.length ? table(['Job / time', 'Outcome', 'Charge'], runRows(result.items)) : empty('No matching runs.')}<p class="note">${result.summary ? e(result.note) : 'Full log page, at most 100 runs.'}</p>${result.next_cursor ? `<button class="secondary" data-runs-cursor="${e(result.next_cursor)}">Older runs →</button>` : ''}</section>`;
}
async function costsPage() {
  const result = await api('/api/costs?group=day');
  if (currentPage() !== 'costs') return;
  content.innerHTML = `<h1 class="app-title">Costs</h1><p class="muted">Integer micro-dollars. Forecasts use maximum configured prices.</p><div class="cards"><div class="card"><p>Daily burn</p><div class="metric">${e(usd(forecast.daily_microdollars))}</div></div><div class="card"><p>Next 30 days</p><div class="metric">${e(usd(forecast.monthly_microdollars))}</div></div><div class="card"><p>Available credit</p><div class="metric">${e(usd(account.balance_microdollars - account.held_microdollars))}</div></div></div><div class="grid"><section class="panel"><h2>Past spend</h2><form id="costs-filter" class="inline"><label>Group<select name="group"><option>day</option><option>job</option><option>action</option></select></label><button>Group</button></form><div id="costs-results">${costTable(result)}</div></section><section class="panel"><h2>Projection by job</h2>${table(['Job', 'Runs / 30 days', 'Daily max', '30-day max'], forecast.jobs.map(j => `<tr><td>${e(j.job)}</td><td>${e(j.runs_30_days)}</td><td>${e(usd(j.daily_microdollars))}</td><td>${e(usd(j.monthly_microdollars))}</td></tr>`))}<p class="note">${e(forecast.estimate)}</p></section></div>`;
}
function costTable(result) { return table([result.group, 'Spend'], result.items.map(i => `<tr><td>${e(i.name)}</td><td>${e(usd(i.cost_microdollars))}</td></tr>`)) + (result.truncated ? '<p class="note">Only the most recent 1,000 ledger entries are included.</p>' : ''); }
async function askPage() {
  content.innerHTML = `<h1 class="app-title">Ask cronly</h1><p class="muted">Questions are read-only. Changes become a proposal for a separate, billed application.</p><section class="panel"><form id="ask-form"><label>What would you like to do?<textarea name="text" rows="5" required maxlength="4096" placeholder="What runs tonight? Or: move the report to 7am weekdays."></textarea></label><label>Mode<select name="mode"><option value="ask">Ask about this account</option><option value="change">Propose changes</option><option value="to-cron">Translate prose to cron</option></select></label><label>Time zone<input name="timezone" value="UTC"></label><button>Review maximum price</button></form><div id="ask-result" aria-live="polite"></div></section>`;
}
async function accountPage() {
  const [transactions, keys] = await Promise.all([api('/api/transactions'), api('/api/keys')]);
  if (currentPage() !== 'account') return;
  content.innerHTML = `<h1 class="app-title">Account</h1><p class="muted">${e(account.id)}</p><div class="grid"><section class="panel"><h2>Add credit</h2><p>Credit never expires while your account exists. Card payment costs are itemized on top.</p><form id="deposit-form"><label>Credit / USD<input name="amount" type="number" min="5" max="1000" step="1" value="5" required></label><button>Review deposit</button></form>${deployment.local ? '<p class="note">Local mode: this adds development credit without a payment.</p>' : ''}<h2>Account as code</h2><button id="export-config" class="secondary">Export config JSON</button><form id="config-form"><label>Import config JSON<textarea name="config" rows="6" required placeholder="Paste an exported account configuration"></textarea></label><button>Review import diff</button></form></section><section class="panel"><h2>API keys</h2><p class="note">Shown only when created. Never put an API key in a public web page; use a job trigger token.</p><ul class="list">${keys.items.map(k => `<li><div><strong>${e(k.name || k.id)}</strong><br><span class="small">${e(k.scopes.join(', '))} · ${k.revoked ? 'revoked' : `expires ${e(date(k.expires_at))}`}</span></div>${k.revoked ? '' : `<button class="secondary" data-revoke-key="${e(k.id)}">Revoke</button>`}</li>`).join('')}</ul><form id="key-form"><label>Name<input name="name" maxlength="64" required></label><label>Scopes<select name="scopes" multiple size="5">${['read', 'run', 'change', 'prose', 'secrets:write'].map(s => `<option value="${s}" ${s === 'read' ? 'selected' : ''}>${s}</option>`).join('')}</select></label><label>Daily spend cap / µ$<input name="daily_spend_microdollars" type="number" min="0" placeholder="No additional cap"></label><button>Review new key</button></form><div id="new-key-result"></div></section></div><section class="section"><h2>Transactions</h2>${table(['When', 'Operation', 'Amount'], transactions.items.map(t => `<tr><td>${e(date(t.created_at))}</td><td>${e(t.kind)}</td><td>${e(usd(t.amount_microdollars))}</td></tr>`))}</section>`;
}
async function render() {
  const version = ++renderVersion; content.setAttribute('aria-busy', 'true');
  content.innerHTML = '<p class="muted">Loading workspace…</p>';
  clearNotice(); const page = location.hash.slice(1) || 'dashboard';
  for (const link of $('#workspace-nav').querySelectorAll('a')) if (link.hash === `#${page}`) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  try {
    await refreshHeader();
    if (version !== renderVersion || page !== currentPage()) return;
    if (['jobs', 'actions', 'variables', 'secrets'].includes(page)) await definitionsPage(page);
    else if (page === 'dashboard') await dashboard();
    else if (page === 'upcoming') await upcomingPage();
    else if (page === 'runs') await runsPage();
    else if (page === 'costs') await costsPage();
    else if (page === 'ask') await askPage();
    else if (page === 'account') await accountPage();
    else { location.hash = 'dashboard'; }
    document.title = `${page[0].toUpperCase() + page.slice(1)} — cronly`;
  } catch (error) { notify(error.message, true); }
  finally { if (version === renderVersion) content.setAttribute('aria-busy', 'false'); }
}
function download(name, text, type = 'application/json') { const url = URL.createObjectURL(new Blob([text], { type })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
content.addEventListener('input', () => { cronPreview(); updateJsPrice(); });
content.addEventListener('change', event => { if (event.target.id === 'action-type') { $('#http-fields').hidden = event.target.value !== 'http'; $('#js-fields').hidden = event.target.value !== 'javascript'; } });
content.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  const page = location.hash.slice(1) || 'dashboard';
  try {
    if (button.dataset.runsCursor) { const query = new URLSearchParams(runsQuery); query.delete('before'); query.set('cursor', button.dataset.runsCursor); await runsPage(`?${query}`); }
    if (button.dataset.edit) { editing = button.dataset.edit; await definitionsPage(page); }
    if (button.id === 'new-definition') { editing = null; await definitionsPage(page); }
    if (button.dataset.delete) await reviewed(`/api/${page}/${button.dataset.delete}`, 'DELETE');
    if (button.dataset.run) runInput(`/api/jobs/${button.dataset.run}/run`, `Run ${button.dataset.run}`);
    if (button.dataset.toggle) await reviewed(`/api/jobs/${button.dataset.toggle}/${config.jobs[button.dataset.toggle].enabled ? 'pause' : 'resume'}`, 'POST', {});
    if (button.dataset.runDetail) { const result = await api(`/api/runs/${encodeURIComponent(button.dataset.runDetail)}`); review('Run detail', result.run.cost_microdollars || 0, result.run, async () => {}, 'Close'); }
    if (button.id === 'create-trigger') await reviewed(`/api/jobs/${editing}/triggers`, 'POST', {}, async result => { await render(); notify('Trigger created. Copy its URL now.'); review('Trigger URL — keep it private', 0, result.url, async () => {}, 'Close'); });
    if (button.dataset.revokeTrigger) await reviewed(`/api/jobs/${editing}/triggers/${button.dataset.revokeTrigger}`, 'DELETE');
    if (button.dataset.revokeKey) await reviewed(`/api/keys/${button.dataset.revokeKey}`, 'DELETE');
    if (button.id === 'test-action') {
      runInput(`/api/actions/${editing}/test`, `Test ${editing}`, 'Test');
    }
    if (button.id === 'export-config') download('cronly.json', JSON.stringify(config, null, 2));
    if (button.id === 'export-runs') { const result = await api(`/api/runs${runsQuery}`); download('cronly-runs.ndjson', result.items.map(r => JSON.stringify(r)).join('\n'), 'application/x-ndjson'); }
    if (button.id === 'translate-job') {
      const input = { text: $('#job-prose').value, timezone: $('#job-timezone').value };
      await reviewed('/api/prose/to-cron', 'POST', input, async result => { $('#job-cron').value = result.cron; cronPreview(); notify(`Translation cost ${usd(result.cost_microdollars)}. Review the cron and save separately.`); });
    }
    if (button.id === 'apply-proposal') {
      const proposal = JSON.parse(button.dataset.proposal);
      await reviewed(`/api/changes/${encodeURIComponent(proposal.id)}/apply`, 'POST', { quote_microdollars: proposal.quote_microdollars });
    }
  } catch (error) { notify(error.message, true); }
});
content.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target; const data = new FormData(form); const fields = Object.fromEntries(data);
  try {
    if (form.id === 'definition-form') {
      const kind = form.dataset.kind; let body;
      if (['variables', 'secrets'].includes(kind)) body = { value: fields.value };
      else if (kind === 'actions') body = fields.type === 'javascript' ? { type: 'javascript', source: fields.source, cpu_ms: Number(fields.cpu_ms), subrequests: Number(fields.subrequests) } : { type: 'http', method: fields.method, url: fields.url, headers: JSON.parse(fields.headers), body: fields.body || undefined, timeout_seconds: Number(fields.timeout_seconds), follow_redirects: data.has('follow_redirects'), success_status: JSON.parse(fields.success_status) };
      else body = { action: fields.action, cron: fields.cron.trim() || null, timezone: fields.timezone, overlap: fields.overlap, missed: fields.missed, retries: Number(fields.retries), enabled: data.has('enabled'), budget: { day: fields.budget_day === '' ? undefined : Number(fields.budget_day), month: fields.budget_month === '' ? undefined : Number(fields.budget_month) } };
      await reviewed(`/api/${kind}/${fields.name}`, 'PUT', body);
    }
    if (form.id === 'upcoming-filter') { const query = new URLSearchParams(); for (const [k, v] of data) if (v) query.set(k, new Date(v).toISOString()); const result = await api(`/api/upcoming?${query}`); $('#upcoming-results').innerHTML = `${upcomingTable(result.items)}<p>Window maximum ${e(usd(result.window_total_microdollars))} · Shown subtotal ${e(usd(result.subtotal_microdollars))}${result.truncated ? ' · Results truncated; narrow the window.' : ''}</p>`; }
    if (form.id === 'runs-filter') { const query = new URLSearchParams(); for (const [k, v] of data) if (v) query.set(k, v); await runsPage(`?${query}`); }
    if (form.id === 'costs-filter') $('#costs-results').innerHTML = costTable(await api(`/api/costs?group=${fields.group}`));
    if (form.id === 'key-form') await reviewed('/api/keys', 'POST', { name: fields.name, scopes: data.getAll('scopes'), daily_spend_microdollars: fields.daily_spend_microdollars === '' ? null : Number(fields.daily_spend_microdollars) }, async result => { await render(); $('#new-key-result').innerHTML = `<p>Copy your key now:</p><pre>${e(result.token)}</pre>`; });
    if (form.id === 'config-form') await reviewed('/api/config', 'PUT', JSON.parse(fields.config));
    if (form.id === 'deposit-form') {
      if (deployment.local) await reviewed('/api/dev/deposit', 'POST', { amount_microdollars: Number(fields.amount) * 1000000 });
      else await reviewed('/api/payments/checkout', 'POST', { credit_cents: Number(fields.amount) * 100 }, result => { location.href = result.url; });
    }
    if (form.id === 'ask-form') await reviewed(`/api/prose/${fields.mode}`, 'POST', { text: fields.text, timezone: fields.timezone }, async result => {
      $('#ask-result').innerHTML = `<h2>${result.operations ? 'Proposed changes' : 'Response'}</h2><pre>${json(result.operations || result.answer || result)}</pre><p class="note">Charged ${e(usd(result.cost_microdollars))}</p>${result.operations?.length ? `<button id="apply-proposal" data-proposal="${e(JSON.stringify({ id: result.id, quote_microdollars: result.operations.length * deployment.prices.change }))}">Review application · ${e(usd(result.operations.length * deployment.prices.change))}</button>` : ''}`;
      await refreshHeader();
    });
  } catch (error) { notify(error.message, true); }
});
$('#workspace-nav').addEventListener('click', event => { const link = event.target.closest('a'); if (link && link.hash !== location.hash) { content.innerHTML = '<p class="muted">Loading workspace…</p>'; content.setAttribute('aria-busy', 'true'); } });
window.addEventListener('hashchange', () => { editing = null; render(); });
async function signedIn() { $('#workspace-nav').hidden = false; $('#sign-out').hidden = false; await render(); }
async function boot() {
  deployment = await settings();
  if (deployment.local) {
    if (getLocalUser()) return signedIn();
    content.innerHTML = '<section class="signed-out panel"><h1 class="app-title">Your local workspace</h1><p class="muted">Development accounts use local storage and development credit.</p><form id="local-login"><label>Local account name<input name="user" value="developer" pattern="[a-zA-Z0-9_\\-]{1,128}" required></label><button>Use local account</button></form></section>';
    $('#local-login').addEventListener('submit', event => { event.preventDefault(); setAuth(new FormData(event.target).get('user')); signedIn(); });
    return;
  }
  if (!deployment.clerk_publishable_key) { content.innerHTML = '<section class="signed-out"><h1 class="app-title">Sign-in is being configured</h1><p>cronly is preparing for its invite-only launch.</p></section>'; return; }
  const encoded = deployment.clerk_publishable_key.split('_').at(-1); const domain = atob(encoded).replace(/\$$/, '');
  if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error('Invalid Clerk frontend domain');
  const script = document.createElement('script'); script.crossOrigin = 'anonymous'; script.dataset.clerkPublishableKey = deployment.clerk_publishable_key; script.src = `https://${domain}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;
  await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; document.head.append(script); });
  await window.Clerk.load(); setAuth(window.Clerk);
  if (window.Clerk.user) await signedIn();
  else { content.innerHTML = '<section class="signed-out panel"><h1 class="app-title">Welcome to cronly</h1><p>Sign in to manage your actions and schedules.</p><button id="clerk-login">Sign in</button><p class="note">Launch is invite-only.</p></section>'; $('#clerk-login').addEventListener('click', () => window.Clerk.openSignIn({ fallbackRedirectUrl: '/app.html' })); window.Clerk.addListener(({ user }) => { if (user) signedIn(); }); }
}
boot().catch(error => notify(error.message, true));
