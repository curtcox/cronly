import { destinationHostname, validateDestination } from './destinations.js';
import { render } from './templates.js';
import { redact } from './secrets.js';
import { rpc } from '../utils/rpc.js';
import { assert } from '../utils/errors.js';
/** Read a capped stream; include lookahead so truncation cannot expose a secret prefix. */
export async function readExcerpt(response, secrets, max = 8192) {
  if (!response.body) return '';
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ''; let bytes = 0;
  try {
    while (bytes < 131072) {
      const { value, done } = await reader.read(); if (done) break;
      const chunk = value.subarray(0, 131072 - bytes); bytes += chunk.length; text += decoder.decode(chunk, { stream: true });
    }
  } finally { await reader.cancel(); }
  return redact(text + decoder.decode(), secrets).slice(0, max);
}
/** Every redirect is checked and counted; credentials do not follow cross-origin redirects. */
export async function guardedFetch(request, env, account, signal, redirects = 0, maxRequests = 6) {
  let current = request;
  for (let index = 0; ; index++) {
    const url = validateDestination(current.url);
    await rpc(env.ACCOUNTS, account, 'rate-limit', { id: `destination:${destinationHostname(url)}`, limit: 60 });
    assert(index < maxRequests, 'subrequest_limit', 'Subrequest limit reached');
    const replayBody = ['GET', 'HEAD'].includes(current.method) ? undefined : await current.clone().arrayBuffer();
    const response = await (env.OUTBOUND_FETCH || fetch)(current, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.has('location') || index >= redirects) return { response, subrequests: index + 1 };
    const destination = validateDestination(new URL(response.headers.get('location'), current.url).href);
    const headers = new Headers(current.headers);
    if (destination.origin !== url.origin) for (const name of [...headers.keys()]) headers.delete(name);
    const method = response.status === 303 || ((response.status === 301 || response.status === 302) && current.method === 'POST') ? 'GET' : current.method;
    await response.body?.cancel();
    current = new Request(destination, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : replayBody });
  }
}
/** Render, execute and redact an HTTP action within a wall-clock deadline. */
export async function executeHttp(execution, context, env, secrets) {
  const { action } = execution;
  const url = render(action.url, context); const headers = Object.fromEntries(Object.entries(action.headers).map(([name, value]) => [name, render(value, context)]));
  const body = render(action.body, context);
  const request = new Request(url, { method: action.method, headers, body: ['GET', 'HEAD'].includes(action.method) ? undefined : body });
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), action.timeout_seconds * 1000);
  const started = Date.now();
  try {
    const { response, subrequests } = await guardedFetch(request, env, context.account.id, controller.signal, action.follow_redirects ? 5 : 0);
    const excerpt = await readExcerpt(response, secrets);
    return { status: action.success_status.some(([min, max]) => response.status >= min && response.status <= max) ? 'success' : 'failure', http_status: response.status, subrequests, duration_ms: Date.now() - started,
      request: redact(JSON.stringify({ url, method: action.method, headers, body }), secrets).slice(0, 4096), response_headers: redact(JSON.stringify(Object.fromEntries(response.headers)), secrets).slice(0, 2048), response_excerpt: excerpt };
  } finally { clearTimeout(timeout); }
}
