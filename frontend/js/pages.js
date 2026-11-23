/** Dashboard, Ask and Account pages. */
import { api, getDevice, escapeHtml as e, dollars as usd } from './api.js';
import { $, content, state, currentPage, date, json, clearNotice, empty, table, runRows, upcomingTable, refreshHeader } from './workspace.js';
import { reviewed } from './review.js';
import { dbaLink, dbaSection } from './dba.js';
import { deviceSummary } from './device.js';

export async function dashboard() {
  const [upcoming, runs] = await Promise.all([api('/api/upcoming?limit=10'), api('/api/runs')]);
  if (currentPage() !== 'dashboard') return;
  content.innerHTML = `<div class="row-header"><div><p class="eyebrow">Your schedules, at a glance</p><h1 class="app-title">Dashboard</h1></div><a href="#jobs" class="button">Create a job</a></div><div class="cards"><div class="card"><p class="note">Spent today</p><div class="metric">${e(usd(state.account.spent_today_microdollars))}</div></div><div class="card"><p class="note">Spent this month</p><div class="metric">${e(usd(state.account.spent_month_microdollars))}</div></div><div class="card"><p class="note">Projected / 30 days</p><div class="metric">${e(usd(state.forecast.monthly_microdollars))}</div></div></div><div class="grid"><section class="panel"><h2>Next on the schedule</h2>${upcoming.items.length ? upcomingTable(upcoming.items) : empty('No scheduled jobs yet. Create an action, then give it a schedule.')}<a href="#upcoming">See upcoming →</a></section><section class="panel"><h2>Recent runs</h2>${runs.items.length ? table(['Job / time', 'Outcome', 'Charge'], runRows(runs.items.slice(0, 10))) : empty('Your run history will appear here.')}<a href="#runs">All runs →</a></section></div><section class="section"><h2>Paused & disabled</h2>${Object.entries(state.config.jobs).filter(([name, j]) => !j.enabled || state.account.job_runtime?.[name]?.paused).map(([name]) => `<p><span class="tag paused">${e(state.account.job_runtime?.[name]?.paused || 'disabled')}</span> ${e(name)}</p>`).join('') || '<p class="muted">No disabled jobs. Balance and budget refusals appear in run history.</p>'}</section>`;
}
export async function askPage() {
  content.innerHTML = `<h1 class="app-title">Ask cronly</h1><p class="muted">Questions are read-only. Changes become a proposal for a separate, billed application.</p><section class="panel"><form id="ask-form"><label>What would you like to do?<textarea name="text" rows="5" required maxlength="4096" placeholder="What runs tonight? Or: move the report to 7am weekdays."></textarea></label><label>Mode<select name="mode"><option value="ask">Ask about this account</option><option value="change">Propose changes</option><option value="to-cron">Translate prose to cron</option></select></label><label>Time zone<input name="timezone" value="UTC"></label><button>Review maximum price</button></form><div id="ask-result" aria-live="polite"></div></section>`;
}
function proposalResult(result) {
  const value = definition => definition === null ? '<p class="muted">Not present</p>' : `<pre>${json(definition)}</pre>`;
  const changes = result.diff ? result.diff.map(change => `<section class="proposal-change"><h3>${e(change.operation[0].toUpperCase() + change.operation.slice(1))} ${e(change.kind)}/${e(change.name)}</h3>${table(['Before', 'After'], [`<tr><td>${value(change.before)}</td><td>${value(change.after)}</td></tr>`])}</section>`).join('') : `<pre>${json(result.operations)}</pre>`;
  return `<h2>Proposed changes</h2><p>${e(result.explanation)}</p>${result.operations.length ? changes : empty('No changes proposed.')}<p class="note">Prose charged ${e(usd(result.cost_microdollars))}. Application is a separate charge of ${e(usd(result.quote_microdollars))}.</p>${result.expires_at ? `<p class="note">Expires ${e(date(result.expires_at))}. Any account configuration change requires a new proposal.</p>` : ''}${result.operations.length ? `<button id="apply-proposal" data-proposal="${e(JSON.stringify({ id: result.id, quote_microdollars: result.quote_microdollars }))}">Review application · ${e(usd(result.quote_microdollars))}</button>` : ''}`;
}
export async function ask(form, fields) {
  const target = $('#ask-result'); const button = form.querySelector('button');
  if (button.disabled) return;
  button.disabled = true;
  try {
    await reviewed(`/api/prose/${fields.mode}`, 'POST', { text: fields.text, timezone: fields.timezone }, async result => {
      // Paid responses can arrive after navigation, including another Ask visit.
      if (target.isConnected) target.innerHTML = result.operations ? proposalResult(result) : `<h2>Response</h2><pre>${json(result.answer || result)}</pre><p class="note">Charged ${e(usd(result.cost_microdollars))}</p>`;
      await refreshHeader();
    }, () => form.isConnected);
  } catch (error) { if (form.isConnected) throw error; }
  finally { button.disabled = false; }
}
function transactionHistory(result, older = false) {
  return `${table(['When', 'Operation / reference', 'Amount'], result.items.map(t => `<tr><td>${e(date(t.created_at))}</td><td>${e(t.kind)}<br><span class="small mono">${e(t.id)}</span></td><td>${e(usd(t.amount_microdollars))}</td></tr>`))}${!result.items.length ? empty('No transactions on this page.') : ''}<div class="inline">${result.next_cursor ? `<button class="secondary" data-transactions-cursor="${e(result.next_cursor)}">Older transactions →</button>` : ''}${older ? '<button class="secondary" id="latest-transactions">Newest transactions</button>' : ''}</div>`;
}
export async function pageTransactions(button, cursor) {
  const history = $('#transaction-history');
  if (button.disabled || !history) return;
  const controls = [...history.querySelectorAll('button')];
  for (const control of controls) control.disabled = true;
  clearNotice();
  try {
    const result = await api(`/api/transactions${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`);
    // A late reply must not replace a new Account visit or another page.
    if (history.isConnected) history.innerHTML = transactionHistory(result, Boolean(cursor));
  } catch (error) { if (history.isConnected) throw error; }
  finally { for (const control of controls) control.disabled = false; }
}
// What a device session (cronly:session) never reaches: ACCOUNT_SESSION routes.
const ACCOUNT_SESSION_NOTE = 'Signed in with a device key: create and revoke API keys, and change the devicebasedauth.org link, from a regular sign-in.';
export async function accountPage() {
  const device = getDevice();
  const [transactions, keys, dba] = await Promise.all([api('/api/transactions'), api('/api/keys'), dbaLink()]);
  if (currentPage() !== 'account') return;
  content.innerHTML = `<h1 class="app-title">Account</h1><p class="muted">${e(state.account.id)}</p><div class="grid"><section class="panel"><h2>Add credit</h2><p>Credit never expires while your account exists. Card payment costs are itemized on top.</p><form id="deposit-form"><label>Credit / USD<input name="amount" type="number" min="5" max="1000" step="1" value="5" required></label><button>Review deposit</button></form>${state.deployment.local ? '<p class="note">Local mode: this adds development credit without a payment.</p>' : ''}<h2>Account as code</h2><button id="export-config" class="secondary">Export config JSON</button><form id="config-form"><label>Import config JSON<textarea name="config" rows="6" required placeholder="Paste an exported account configuration"></textarea></label><button>Review import diff</button></form></section><section class="panel"><h2>API keys</h2><p class="note">Shown only when created. Never put an API key in a public web page; use a job trigger token.</p><ul class="list">${keys.items.map(k => `<li><div><strong>${e(k.name || k.id)}</strong><br><span class="small">${e(k.scopes.join(', '))} · ${k.revoked ? 'revoked' : `expires ${e(date(k.expires_at))}`}</span></div>${k.revoked || device ? '' : `<button class="secondary" data-revoke-key="${e(k.id)}">Revoke</button>`}</li>`).join('')}</ul>${device ? `<p class="note">${ACCOUNT_SESSION_NOTE}</p>` : `<form id="key-form"><label>Name<input name="name" maxlength="64" required></label><label>Scopes<select name="scopes" multiple size="5">${['read', 'run', 'change', 'prose', 'secrets:write'].map(s => `<option value="${s}" ${s === 'read' ? 'selected' : ''}>${s}</option>`).join('')}</select></label><label>Daily spend cap / µ$<input name="daily_spend_microdollars" type="number" min="0" placeholder="No additional cap"></label><button>Review new key</button></form><div id="new-key-result"></div>`}</section></div>${device ? `<section class="section" id="this-device"><h2>This device</h2><p>${deviceSummary(device)}</p><p class="note">Signing out deletes this browser's key. To stop it everywhere at once, revoke the device at devicebasedauth.org.</p></section>` : ''}${dbaSection(dba, { device: !!device })}<section class="section"><h2>Transactions</h2><div id="transaction-history">${transactionHistory(transactions)}</div></section>`;
}
