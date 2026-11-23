import { api, settings, setAuth, getLocalUser, signOut, escapeHtml as e } from './api.js';
import { $, content, state, currentPage, setRenderer, notify, clearNotice, download, refreshHeader } from './workspace.js';
import { review, reviewed, runInput } from './review.js';
import { definitionsPage, cronPreview, updateJsPrice, updateJobPrice, translateJob } from './definitions.js';
import { upcomingPage, runsPage, costsPage, filterUpcoming, filterCosts, exportRuns } from './history.js';
import { dashboard, askPage, accountPage, ask, pageTransactions } from './pages.js';
import { dbaClick, finishDbaLink } from './dba.js';

$('#sign-out').addEventListener('click', signOut);
async function render() {
  const version = ++state.renderVersion; content.setAttribute('aria-busy', 'true');
  content.innerHTML = '<p class="muted">Loading workspace…</p>';
  clearNotice(); const page = location.hash.slice(1) || 'dashboard';
  for (const link of $('#workspace-nav').querySelectorAll('a')) if (link.hash === `#${page}`) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  try {
    await refreshHeader();
    if (version !== state.renderVersion || page !== currentPage()) return;
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
  finally { if (version === state.renderVersion) content.setAttribute('aria-busy', 'false'); }
}
setRenderer(render);
content.addEventListener('input', () => { cronPreview(); updateJsPrice(); updateJobPrice(); });
content.addEventListener('change', event => { if (event.target.id === 'action-type') { $('#http-fields').hidden = event.target.value !== 'http'; $('#js-fields').hidden = event.target.value !== 'javascript'; } });
content.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  const page = location.hash.slice(1) || 'dashboard';
  try {
    if (button.dataset.transactionsCursor || button.id === 'latest-transactions') await pageTransactions(button, button.dataset.transactionsCursor);
    if (button.dataset.runsCursor) { const query = new URLSearchParams(state.runsQuery); query.delete('before'); query.set('cursor', button.dataset.runsCursor); await runsPage(`?${query}`); }
    if (button.dataset.edit) { state.editing = button.dataset.edit; await definitionsPage(page); }
    if (button.id === 'new-definition') { state.editing = null; await definitionsPage(page); }
    if (button.dataset.delete) await reviewed(`/api/${page}/${button.dataset.delete}`, 'DELETE');
    if (button.dataset.run) runInput(`/api/jobs/${button.dataset.run}/run`, `Run ${button.dataset.run}`);
    if (button.dataset.toggle) await reviewed(`/api/jobs/${button.dataset.toggle}/${state.config.jobs[button.dataset.toggle].enabled ? 'pause' : 'resume'}`, 'POST', {});
    if (button.dataset.runDetail) { const result = await api(`/api/runs/${encodeURIComponent(button.dataset.runDetail)}`); review('Run detail', result.run.cost_microdollars || 0, result.run, async () => {}, 'Close'); }
    if (button.id === 'create-trigger') await reviewed(`/api/jobs/${state.editing}/triggers`, 'POST', {}, async result => { await render(); notify('Trigger created. Copy its URL now.'); review('Trigger URL — keep it private', 0, result.url, async () => {}, 'Close'); });
    if (button.dataset.revokeTrigger) await reviewed(`/api/jobs/${state.editing}/triggers/${button.dataset.revokeTrigger}`, 'DELETE');
    if (button.dataset.revokeKey) await reviewed(`/api/keys/${button.dataset.revokeKey}`, 'DELETE');
    if (await dbaClick(button)) return;
    if (button.id === 'test-action') {
      runInput(`/api/actions/${state.editing}/test`, `Test ${state.editing}`, 'Test');
    }
    if (button.id === 'export-config') download('cronly.json', JSON.stringify(state.config, null, 2));
    if (button.id === 'export-runs') await exportRuns(button);
    if (button.id === 'translate-job') await translateJob(button);
    if (button.id === 'use-job-translation') {
      const translation = JSON.parse(button.dataset.translation);
      $('#job-cron').value = translation.cron; $('#job-timezone').value = translation.timezone;
      cronPreview(); notify('Translation added to this draft. Review the next fires and save separately.');
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
    if (form.id === 'upcoming-filter') await filterUpcoming(form, data);
    if (form.id === 'runs-filter') { const query = new URLSearchParams(); for (const [k, v] of data) if (v) query.set(k, k === 'from' ? `${v}T00:00:00.000Z` : k === 'to' ? `${v}T23:59:59.999Z` : v); await runsPage(`?${query}`); }
    if (form.id === 'costs-filter') await filterCosts(form, data);
    if (form.id === 'key-form') await reviewed('/api/keys', 'POST', { name: fields.name, scopes: data.getAll('scopes'), daily_spend_microdollars: fields.daily_spend_microdollars === '' ? null : Number(fields.daily_spend_microdollars) }, async result => { await render(); $('#new-key-result').innerHTML = `<p>Copy your key now:</p><pre>${e(result.token)}</pre>`; });
    if (form.id === 'config-form') await reviewed('/api/config', 'PUT', JSON.parse(fields.config));
    if (form.id === 'deposit-form') {
      if (state.deployment.local) await reviewed('/api/dev/deposit', 'POST', { amount_microdollars: Number(fields.amount) * 1000000 });
      else await reviewed('/api/payments/checkout', 'POST', { credit_cents: Number(fields.amount) * 100 }, result => { location.href = result.url; });
    }
    if (form.id === 'ask-form') await ask(form, fields);
  } catch (error) { notify(error.message, true); }
});
$('#workspace-nav').addEventListener('click', event => { const link = event.target.closest('a'); if (link && link.hash !== location.hash) { content.innerHTML = '<p class="muted">Loading workspace…</p>'; content.setAttribute('aria-busy', 'true'); } });
window.addEventListener('hashchange', () => { state.editing = null; render(); });
async function signedIn() {
  $('#workspace-nav').hidden = false; $('#sign-out').hidden = false; await render();
  try { await finishDbaLink(); } catch (error) { notify(error.message, true); }
}
async function boot() {
  state.deployment = await settings();
  if (state.deployment.local) {
    if (getLocalUser()) return signedIn();
    content.innerHTML = '<section class="signed-out panel"><h1 class="app-title">Your local workspace</h1><p class="muted">Development accounts use local storage and development credit.</p><form id="local-login"><label>Local account name<input name="user" value="developer" pattern="[a-zA-Z0-9_\\-]{1,128}" required></label><button>Use local account</button></form></section>';
    $('#local-login').addEventListener('submit', event => { event.preventDefault(); setAuth(new FormData(event.target).get('user')); signedIn(); });
    return;
  }
  if (!state.deployment.clerk_publishable_key) { content.innerHTML = '<section class="signed-out"><h1 class="app-title">Sign-in is being configured</h1><p>cronly is preparing for its invite-only launch.</p></section>'; return; }
  const encoded = state.deployment.clerk_publishable_key.split('_').at(-1); const domain = atob(encoded).replace(/\$$/, '');
  if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error('Invalid Clerk frontend domain');
  const script = document.createElement('script'); script.crossOrigin = 'anonymous'; script.dataset.clerkPublishableKey = state.deployment.clerk_publishable_key; script.src = `https://${domain}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;
  await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; document.head.append(script); });
  await window.Clerk.load(); setAuth(window.Clerk);
  if (window.Clerk.user) await signedIn();
  else { content.innerHTML = '<section class="signed-out panel"><h1 class="app-title">Welcome to cronly</h1><p>Sign in to manage your actions and schedules.</p><button id="clerk-login">Sign in</button><p class="note">Launch is invite-only.</p></section>'; $('#clerk-login').addEventListener('click', () => window.Clerk.openSignIn({ fallbackRedirectUrl: '/app.html' })); window.Clerk.addListener(({ user }) => { if (user) signedIn(); }); }
}
boot().catch(error => notify(error.message, true));
