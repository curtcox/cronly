/** Jobs, actions, variables and secrets: lists, edit forms, cron previews and derived run maxima. */
import { api, escapeHtml as e, dollars as usd } from './api.js';
import { Cron } from '../vendor/croner.js';
import { $, content, state, date, json, empty, refreshHeader } from './workspace.js';
import { reviewed } from './review.js';

function jobSummary(name, job) {
  const runtime = Object.hasOwn(state.account.job_runtime || {}, name) ? state.account.job_runtime[name] : {};
  const daily = Object.hasOwn(state.account.spend_today_by_job || {}, name) ? state.account.spend_today_by_job[name] : 0;
  const monthly = Object.hasOwn(state.account.spend_by_job || {}, name) ? state.account.spend_by_job[name] : 0;
  const status = !job.enabled ? 'Disabled' : runtime.paused ? `Paused: ${runtime.paused.replaceAll('_', ' ')}` : job.cron ? 'Scheduled' : 'On demand / webhook only';
  const next = job.enabled && !runtime.paused ? runtime.next_fire : null;
  return `<p class="small"><span class="tag ${!job.enabled || runtime.paused ? 'paused' : ''}">${e(status)}</span><br>${e(job.cron ? window.cronstrue.toString(job.cron) : 'Manual and webhook only')} · ${e(job.timezone)}<br>Next: ${e(date(next))} · Last: ${e(runtime.last_outcome || '—')}<br>30-day max: ${e(usd(state.forecast.jobs.find(j => j.job === name)?.monthly_microdollars || 0))}<br>Today: ${e(usd(daily))} / ${job.budget.day == null ? 'no daily cap' : e(usd(job.budget.day))}<br>This month: ${e(usd(monthly))} / ${job.budget.month == null ? 'no monthly cap' : e(usd(job.budget.month))}</p>`;
}
function definitionList(kind) {
  const items = Object.entries(state.config[kind]);
  return items.length ? `<ul class="list">${items.map(([name, value]) => `<li><div><span class="list-title">${e(name)}</span><br><span class="small muted">${e(kind === 'secrets' ? `Fingerprint ${value.fingerprint}` : kind === 'variables' ? value : kind === 'actions' ? value.type : value.cron || 'On demand / webhook only')}</span>${kind === 'jobs' ? jobSummary(name, value) : ''}</div><div class="inline"><button class="secondary" data-edit="${e(name)}">Edit</button>${kind === 'jobs' ? `<button data-run="${e(name)}">Run</button><button class="secondary" data-toggle="${e(name)}">${value.enabled ? 'Pause' : 'Resume'}</button>` : ''}<button class="secondary" data-delete="${e(name)}">Delete</button></div></li>`).join('')}</ul>` : empty(`No ${kind} yet.`);
}
function definitionForm(kind) {
  const value = state.editing ? state.config[kind][state.editing] : undefined;
  const name = `<label>Name<input name="name" pattern="[a-z0-9\\-]{1,64}" maxlength="64" required value="${e(state.editing || '')}" ${state.editing ? 'readonly' : ''}></label>`;
  let fields;
  if (kind === 'variables' || kind === 'secrets') fields = `${name}<label>${kind === 'secrets' ? 'New secret value (write-only)' : 'Value'}<${kind === 'secrets' ? 'input type="password" autocomplete="new-password"' : 'textarea rows="4"'} name="value" required>${kind === 'variables' ? e(value || '') + '</textarea>' : ''}${kind === 'secrets' ? '' : ''}</label><p class="note">${kind === 'secrets' ? 'Existing values cannot be read. Saving replaces the encrypted value.' : 'Available in actions as {{var.NAME}}.'}</p>`;
  if (kind === 'actions') {
    const action = value || { type: 'http', method: 'GET', timeout_seconds: 10, cpu_ms: 100, subrequests: 5 };
    fields = `${name}<label>Type<select name="type" id="action-type"><option value="http" ${action.type === 'http' ? 'selected' : ''}>HTTP request</option><option value="javascript" ${action.type === 'javascript' ? 'selected' : ''}>JavaScript module</option></select></label><div id="http-fields" ${action.type === 'javascript' ? 'hidden' : ''}><div class="fields"><label>Method<select name="method">${['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map(m => `<option ${action.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label><label>Timeout / seconds<input type="number" name="timeout_seconds" min="1" max="30" value="${e(action.timeout_seconds || 10)}"></label><label class="wide">URL<input name="url" placeholder="https://api.example.com/health" value="${e(action.url || '')}"></label><label class="wide">Headers / JSON<textarea name="headers" rows="3">${json(action.headers || {})}</textarea></label><label class="wide">Body<textarea name="body" rows="4">${e(action.body || '')}</textarea></label><label class="wide">Success status ranges / JSON<textarea name="success_status" rows="2">${json(action.success_status || [[200, 299]])}</textarea></label></div><label class="check"><input type="checkbox" name="follow_redirects" ${action.follow_redirects ? 'checked' : ''}>Follow redirects (up to five; destinations checked)</label></div><div id="js-fields" ${action.type !== 'javascript' ? 'hidden' : ''}><div class="fields"><label>CPU limit / milliseconds<input name="cpu_ms" type="number" min="10" max="30000" value="${e(action.cpu_ms || 100)}"></label><label>Allowed subrequests<input name="subrequests" type="number" min="0" max="50" value="${e(action.subrequests ?? 5)}"></label></div><label>Module source<textarea class="code-editor" name="source" rows="12" spellcheck="false">${e(action.source || 'export default async function run(ctx) {\n  console.log(ctx.run.id);\n  return { ok: true };\n}')}</textarea></label><details><summary class="note">Syntax preview</summary><pre id="source-highlight"></pre></details><p class="note" id="js-price"></p><p class="note">No npm resolution. Native networking is blocked; use ctx.fetch. Console output is captured and redacted.</p></div>`;
  }
  if (kind === 'jobs') {
    const job = value || { timezone: 'UTC', cron: '0 * * * *', enabled: true, overlap: 'skip', missed: 'skip', retries: 0, budget: {} };
    fields = `${name}<label>Action<select name="action" id="job-action" required>${Object.keys(state.config.actions).map(a => `<option ${job.action === a ? 'selected' : ''}>${e(a)}</option>`).join('')}</select></label><div class="fields"><label>Cron (blank for on demand only)<input name="cron" id="job-cron" value="${e(job.cron || '')}" placeholder="0 * * * *"></label><label>Time zone<input name="timezone" id="job-timezone" value="${e(job.timezone)}" required></label></div><div id="cron-preview" class="schedule-preview" aria-live="polite"></div><label>Describe the schedule<textarea id="job-prose" rows="2" maxlength="4096" placeholder="Weekdays at 7am"></textarea></label><button type="button" id="translate-job" class="secondary">Quote prose translation</button><div id="job-translation" aria-live="polite"></div><div class="fields"><label>Scheduled / manual run maximum<output id="job-run-price" for="job-action"></output></label><label>Webhook run maximum<output id="job-hook-price" for="job-action"></output></label></div><p class="note" id="job-run-price-note"></p><div class="fields"><label>Overlap<select name="overlap"><option ${job.overlap === 'skip' ? 'selected' : ''}>skip</option><option ${job.overlap === 'allow' ? 'selected' : ''}>allow</option></select></label><label>Missed run<select name="missed"><option ${job.missed === 'skip' ? 'selected' : ''}>skip</option><option ${job.missed === 'run_once' ? 'selected' : ''}>run_once</option></select></label><label>Immediate retries<input name="retries" type="number" min="0" max="3" value="${e(job.retries)}"></label><label>Daily budget / µ$<input name="budget_day" type="number" min="0" value="${e(job.budget.day ?? '')}" placeholder="No limit beyond balance"></label><label>Monthly budget / µ$<input name="budget_month" type="number" min="0" value="${e(job.budget.month ?? '')}"></label></div><label class="check"><input type="checkbox" name="enabled" ${job.enabled ? 'checked' : ''}>Enabled</label>`;
  }
  return `<form id="definition-form" data-kind="${kind}">${fields}<div class="form-actions"><button type="submit">Review save · ${state.deployment.prices.change} µ$</button><button type="button" id="new-definition" class="secondary">Clear / new</button></div></form>`;
}
export function cronPreview() {
  if (!$('#job-cron')) return;
  try {
    const expression = $('#job-cron').value.trim(); const zone = $('#job-timezone').value;
    if (!expression) { $('#cron-preview').textContent = 'On demand and webhook triggers only.'; return; }
    if (expression.split(/\s+/).length !== 5) throw new Error('Use a five-field cron expression.');
    const cron = new Cron(expression, { timezone: zone, paused: true });
    $('#cron-preview').innerHTML = `<strong>${e(window.cronstrue.toString(expression))}</strong><ul>${cron.nextRuns(5).map(d => `<li>${e(d.toLocaleString(undefined, { timeZone: zone, timeZoneName: 'short' }))}</li>`).join('')}</ul>`;
  } catch (error) { $('#cron-preview').textContent = error.message; }
}
export async function translateJob(button) {
  const form = button.closest('form'); const target = form.querySelector('#job-translation');
  if (button.disabled) return;
  const input = { text: form.querySelector('#job-prose').value, timezone: form.elements.timezone.value };
  button.disabled = true;
  try {
    await reviewed('/api/prose/to-cron', 'POST', input, async result => {
      // A translation belongs to the editor that requested it, even if a different
      // job is open when the paid reply arrives. Never overwrite a draft implicitly.
      if (target.isConnected) target.innerHTML = `<h3>Translated schedule</h3><p>${e(input.text)}</p><pre>${e(result.cron)}</pre><p>${e(result.explanation)} · ${e(result.timezone)}</p><p class="note">Model confidence: ${e(Math.round(result.confidence * 100))}%. Review any ambiguity before using this schedule.</p>${result.alternatives.length ? `<h4>Alternatives</h4><ul>${result.alternatives.map(alternative => `<li>${e(alternative)}</li>`).join('')}</ul>` : ''}<h4>Next five fires / ${e(result.timezone)}</h4><ul>${result.next_fires.map(time => `<li>${e(new Date(time).toLocaleString(undefined, { timeZone: result.timezone, timeZoneName: 'short' }))}</li>`).join('')}</ul><p class="note">Translation charged ${e(usd(result.cost_microdollars))}. Using this schedule only updates the draft; saving is a separate billed change.</p><button type="button" id="use-job-translation" class="secondary" data-translation="${e(JSON.stringify({ cron: result.cron, timezone: result.timezone }))}">Use this schedule in the draft</button>`;
      await refreshHeader();
    }, () => form.isConnected && form.querySelector('#job-prose').value === input.text && form.elements.timezone.value === input.timezone);
  } catch (error) { if (form.isConnected) throw error; }
  finally { button.disabled = false; }
}
function maximumRunPrice(action) {
  const p = state.deployment.prices;
  return p.run + (action.type === 'javascript' ? p.jsActivation + Math.ceil(action.cpu_ms * p.jsCpuMs) + action.subrequests * p.jsSubrequest : 0);
}
export function updateJobPrice() {
  const output = $('#job-run-price'); if (!output) return;
  const name = $('#definition-form').elements.action.value;
  const action = Object.hasOwn(state.config.actions, name) ? state.config.actions[name] : null;
  if (!action) {
    output.textContent = 'Choose an action'; $('#job-hook-price').textContent = 'Choose an action';
    $('#job-run-price-note').textContent = 'Create an action before configuring a job.';
    return;
  }
  const maximum = maximumRunPrice(action); const hook = maximum + state.deployment.prices.hook;
  output.textContent = `${maximum.toLocaleString()} µ$ (${usd(maximum)})`;
  $('#job-hook-price').textContent = `${hook.toLocaleString()} µ$ (${usd(hook)})`;
  $('#job-run-price-note').textContent = `Derived from the selected action's limits. The maximum is held before each run; each retry needs its own hold and is billed separately.${action.type === 'javascript' ? ` Includes ${state.deployment.prices.jsActivation.toLocaleString()} µ$ daily activation, held each run and released if this account/action version is already covered for that UTC day.` : ''}`;
}
export function updateJsPrice() {
  if (!$('#js-price')) return;
  const form = $('#definition-form'); const cpu = Number(form.elements.cpu_ms.value); const sub = Number(form.elements.subrequests.value); const p = state.deployment.prices;
  if ($('#source-highlight')) $('#source-highlight').innerHTML = e(form.elements.source.value).replace(/\b(export|default|async|function|return|const|let|await|if|throw|new)\b/g, '<span class="highlight">$1</span>');
  $('#js-price').textContent = `Maximum per run: ${usd(maximumRunPrice({ type: 'javascript', cpu_ms: cpu, subrequests: sub }))}. Includes ${usd(p.jsActivation)} activation, charged only on the first use of this version per UTC day.`;
}
export async function definitionsPage(kind) {
  content.innerHTML = `<div class="row-header"><div><h1 class="app-title">${e(kind[0].toUpperCase() + kind.slice(1))}</h1><p class="muted">Named, reusable pieces of your schedule.</p></div></div><div class="grid"><section class="panel"><h2>Your ${e(kind)}</h2>${definitionList(kind)}${kind === 'jobs' ? `<p class="note">Spend uses UTC days and months. Pending holds also count toward budget enforcement. Projections are on <a href="#costs">Costs</a>. Runs start within a few seconds of the scheduled minute.</p>` : ''}</section><section class="panel"><h2>${state.editing ? `Edit ${e(state.editing)}` : `New ${e(kind.slice(0, -1))}`}</h2>${definitionForm(kind)}${state.editing && kind === 'jobs' ? '<div class="section"><h3>Trigger tokens</h3><button id="create-trigger" class="secondary">Review new trigger</button><div id="triggers"></div></div>' : ''}${state.editing && ['actions', 'jobs'].includes(kind) ? `<h3>Use from a script</h3><pre>curl -X ${kind === 'jobs' ? 'POST' : 'GET'} https://cronly.org/api/${kind}/${e(state.editing)}${kind === 'jobs' ? '/run' : ''} \\\n  -H 'Authorization: ApiKey YOUR_KEY'

fetch('https://cronly.org/api/${kind}/${e(state.editing)}${kind === 'jobs' ? '/run' : ''}', {
  method: '${kind === 'jobs' ? 'POST' : 'GET'}',
  headers: { Authorization: 'ApiKey YOUR_KEY' }
});</pre>${kind === 'actions' ? '<button id="test-action" class="secondary">Review test run</button>' : ''}` : ''}</section></div>`;
  cronPreview(); updateJsPrice(); updateJobPrice();
  if (state.editing && kind === 'jobs') {
    const result = await api(`/api/jobs/${state.editing}/triggers`);
    if (!$('#triggers')) return;
    $('#triggers').innerHTML = result.items.length ? `<ul class="list">${result.items.map(t => `<li><span class="small mono">${e(t.id)} · ${t.revoked ? 'revoked' : `${t.rate_per_minute}/min`}</span>${t.revoked ? '' : `<button class="secondary" data-revoke-trigger="${e(t.id)}">Revoke</button>`}</li>`).join('')}</ul>` : empty('No trigger tokens.');
  }
}
