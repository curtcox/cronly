import { ApiError, assert, readJson } from '../utils/errors.js';
import { rpc } from '../utils/rpc.js';
import { callProse, proseQuote } from '../services/llm.js';
import { explainCron } from '../services/cron.js';
import { PRICES } from '../utils/pricing.js';
import { digest } from '../auth/crypto.js';
import { retainedRuns } from './reporting.js';
import { projection } from '../services/reporting.js';
import { compareRuns } from '../services/run-pagination.js';
/** Reserve the whole conversation before a provider call; retries never repeat a billed call. */
export async function prose(route, request, env, auth) {
  const mode = route.params.mode; assert(['to-cron', 'ask', 'change'].includes(mode), 'not_found', 'Unknown prose endpoint', 404);
  const input = await readJson(request, 8192); assert(typeof input.text === 'string' && input.text.length > 0 && input.text.length <= 4096, 'invalid_text', 'Text must be 1–4096 characters');
  const quote = proseQuote(mode);
  if (new URL(request.url).searchParams.get('dry_run') === '1') return { quote_microdollars: quote, cost_microdollars: 0 };
  assert(env.ANTHROPIC_API_KEY, 'prose_unavailable', 'Prose is not configured', 503);
  const id = `prose:${auth.key_id || 'session'}:${request.headers.get('Idempotency-Key') || crypto.randomUUID()}`;
  const started = await rpc(env.ACCOUNTS, auth.account, 'begin-prose', { id, mode, amount: quote, request_hash: await digest(JSON.stringify({ mode, input })), key_id: auth.key_id });
  if (started.duplicate) { if (started.response?.failed) throw new ApiError(started.response.failure_status || 502, started.response.code, started.response.error, { cost_microdollars: started.response.cost_microdollars }); assert(started.response, 'request_in_progress', 'Request already started; retry later or inspect transactions', 409); return started.response; }
  const { config, base_hash } = started;
  // Reuse the history the model saw: retention or newer runs must not invalidate
  // a citation while it is answering. Repeated tools also avoid another fanout.
  let runs; let forecast;
  const readRuns = () => runs ||= retainedRuns(env, auth.account, config).then(items => items.sort(compareRuns));
  const readTool = async name => {
    if (name === 'list_jobs') return config.jobs;
    if (name === 'recent_runs') return (await readRuns()).slice(0, 10);
    return forecast ||= Promise.all([rpc(env.ACCOUNTS, auth.account, 'account'), rpc(env.ACCOUNTS, auth.account, 'activity')])
      .then(([balance, activity]) => projection(config, balance, activity.counts));
  };
  let knownCharge; let response;
  try {
    const modelInput = mode === 'change' ? { ...input, jobs: config.jobs, actions: Object.keys(config.actions), variables: config.variables } : input;
    const result = await callProse(mode, modelInput, env, readTool); knownCharge = Math.min(quote, result.cost_microdollars); let value = result.value;
    if (mode === 'to-cron') {
      assert(Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1 && Array.isArray(value.alternatives) && value.alternatives.every(v => typeof v === 'string'), 'invalid_prose_response', 'Invalid cron response', 502);
      value = { ...value, ...explainCron(value.cron, input.timezone || 'UTC') };
    }
    if (mode === 'ask') {
      assert(typeof value.answer === 'string' && Array.isArray(value.citations), 'invalid_prose_response', 'Invalid answer', 502);
      const allowed = new Set(Object.keys(config.jobs));
      if (value.citations.some(c => !allowed.has(c))) for (const run of await readRuns()) allowed.add(run.id);
      assert(value.citations.every(c => allowed.has(c)), 'invalid_citation', 'Model cited an unknown job or run', 502);
    }
    if (mode === 'change') {
      assert(Array.isArray(value.operations), 'invalid_proposal', 'Invalid change proposal', 502);
      const operations = value.operations.map(op => { assert(['variables', 'actions', 'jobs'].includes(op.kind), 'invalid_proposal', 'Unsupported proposed change'); return { kind: op.kind, name: op.name, delete: op.delete, value: op.delete ? undefined : JSON.parse(op.value_json) }; });
      const proposal = await rpc(env.ACCOUNTS, auth.account, 'save-proposal', { id, operations, base_hash, explanation: value.explanation });
      value = { ...proposal, explanation: value.explanation };
    }
    response = { ...value, quote_microdollars: mode === 'change' ? value.quote_microdollars : quote, maximum_prose_microdollars: quote, token_cost_microdollars: result.token_cost_microdollars, cost_microdollars: Math.min(quote, result.cost_microdollars) };
  } catch (error) {
    // The provider may have done billable work even if the response was lost or invalid.
    const failure = error instanceof ApiError ? error : new ApiError(502, 'invalid_prose_response', 'Invalid prose provider response');
    const knownTokens = error.details?.known_token_cost_microdollars;
    const cost = knownCharge ?? (knownTokens === undefined ? quote : Math.min(quote, Math.ceil(knownTokens * PRICES.proseMarkup) + PRICES.proseBase));
    response = { failed: true, failure_status: failure.status, error: failure.message, code: failure.code, cost_microdollars: cost };
  }
  // Finalization failures must not reinterpret a successful provider result. Its
  // transaction may have committed even when the acknowledgement was lost.
  const saved = await rpc(env.ACCOUNTS, auth.account, 'finish-prose', { id, actual: response.cost_microdollars, response });
  if (saved.failed) throw new ApiError(saved.failure_status || 502, saved.code, saved.error, { cost_microdollars: saved.cost_microdollars });
  return saved;
}
/** Applying a proposal is a separate billed transaction against its original config revision. */
export async function applyProposal(route, request, env, auth) {
  const input = await readJson(request);
  const dry_run = new URL(request.url).searchParams.get('dry_run') === '1';
  const result = await rpc(env.ACCOUNTS, auth.account, 'apply-proposal', { id: route.params.id, account: auth.account, key_id: auth.key_id, expected_quote: input.quote_microdollars, dry_run });
  if (!dry_run) {
    try { await rpc(env.ACCOUNTS, auth.account, 'sync-jobs'); } catch { /* Durable outbox retries. */ }
  }
  return result;
}
