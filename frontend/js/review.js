/** The review dialog (every quote is shown before a separate paid apply) and the run-input dialog. */
import { api, dollars as usd } from './api.js';
import { $, state, render, notify } from './workspace.js';

let pendingApply; let pendingRun;
export function review(title, quote, detail, callback, button = 'Apply') {
  $('#review-title').textContent = title; $('#review-price').textContent = `Maximum charge: ${usd(quote)} (${quote.toLocaleString()} µ$)`;
  $('#review-detail').textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
  $('#review-apply').textContent = button; pendingApply = callback; $('#review').showModal();
}
export async function reviewed(path, method, body, callback, isCurrent = () => true) {
  const quote = await api(`${path}${path.includes('?') ? '&' : '?'}dry_run=1`, method, body);
  if (!isCurrent()) return;
  const idempotency = crypto.randomUUID();
  review('Review before applying', quote.quote_microdollars || 0, quote.changes || body || quote, async () => {
    const result = await api(path, method, body, idempotency);
    if (callback) await callback(result); else { state.editing = null; await render(); notify(`Applied. Charged ${usd(result.cost_microdollars)}.`); }
  });
}
$('#review-cancel').addEventListener('click', () => { pendingApply = null; $('#review').close(); });
export function runInput(path, label, queued = 'Run') {
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
