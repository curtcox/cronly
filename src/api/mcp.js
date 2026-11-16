import { assert, readJson } from '../utils/errors.js';
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
export const MCP_TOOLS = [
  { name: 'list_jobs', description: 'Read jobs and account configuration.', inputSchema: object(), path: '/api/config' },
  { name: 'upcoming', description: 'Read the next scheduled runs and maximum prices.', inputSchema: object({ from: string, to: string }), path: '/api/upcoming' },
  { name: 'recent_runs', description: 'Read retained run history.', inputSchema: object({ job: string, status: string }), path: '/api/runs' },
  { name: 'get_run', description: 'Read one run by ID.', inputSchema: object({ id: string }, ['id']), path: '/api/runs/:id' },
  { name: 'explain_cron', description: 'Explain five-field cron deterministically for free.', inputSchema: object({ cron: string, timezone: string }, ['cron']), path: '/api/cron/explain', method: 'POST' },
  { name: 'prose_to_cron', description: 'Translate prose; reserve and bill the maximum model price.', inputSchema: object({ text: string, timezone: string }, ['text']), path: '/api/prose/to-cron', method: 'POST' },
  { name: 'quote', description: 'Get a maximum operation price before spending.', inputSchema: object({ op: string, job: string }, ['op']), path: '/api/quote' },
  { name: 'apply_change', description: 'Quote a stored proposal, verify the supplied quote, then apply it.', inputSchema: object({ id: string, quote_microdollars: { type: 'integer' } }, ['id', 'quote_microdollars']), path: '/api/changes/:id/apply', method: 'POST', quoteFirst: true },
  { name: 'run_job', description: 'Start a job with prepaid credit and its budgets.', inputSchema: object({ name: string }, ['name']), path: '/api/jobs/:name/run', method: 'POST' },
  { name: 'balance', description: 'Read prepaid balance and holds.', inputSchema: object(), path: '/api/account' }
];
/** Stateless Streamable HTTP MCP; each tool reuses the ordinary scoped API. */
export async function mcp(request, env, auth, invoke) {
  assert(!auth.session, 'api_key_required', 'MCP requires an API key', 403);
  const origin = request.headers.get('Origin'); assert(!origin || origin === env.APP_ORIGIN, 'invalid_origin', 'Origin is not allowed', 403);
  if (request.method === 'GET') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const message = await readJson(request, 32768);
  assert(message.jsonrpc === '2.0' && typeof message.method === 'string', 'invalid_rpc', 'Invalid JSON-RPC message');
  if (message.id === undefined) return new Response(null, { status: 202 });
  const reply = result => Response.json({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'cronly', version: '0.1.0' } });
  if (message.method === 'ping') return reply({});
  if (message.method === 'tools/list') return reply({ tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (message.method !== 'tools/call') return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  const tool = MCP_TOOLS.find(t => t.name === message.params?.name);
  if (!tool) return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool' } });
  try {
    const args = message.params.arguments || {};
    for (const field of tool.inputSchema.required) assert(args[field] !== undefined, 'invalid_arguments', `Missing ${field}`);
    let path = tool.path.replace(/:([a-z_]+)/g, (_, key) => encodeURIComponent(args[key]));
    if (!tool.method) { const query = new URLSearchParams(args); if (query.size) path += `?${query}`; }
    if (tool.quoteFirst) {
      const quote = await invoke(`${path}?dry_run=1`, tool.method, args);
      assert(quote.ok && (await quote.json()).quote_microdollars === args.quote_microdollars, 'quote_changed', 'Quote changed; review the new price', 409);
    }
    const response = await invoke(path, tool.method || 'GET', args); const result = await response.json();
    return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: !response.ok });
  } catch (error) { return reply({ content: [{ type: 'text', text: JSON.stringify({ error: error.message, code: error.code }) }], isError: true }); }
}
