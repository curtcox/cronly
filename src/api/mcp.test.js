import { it, expect } from 'vitest';
import { mcp } from './mcp.js';
it('initializes stateless MCP, lists tools and denies foreign origins', async () => {
  const request = (body, origin) => new Request('https://cronly.org/mcp', { method: 'POST', headers: origin ? { Origin: origin } : {}, body: JSON.stringify(body) });
  const env = { APP_ORIGIN: 'https://cronly.org' }; const auth = { account: 'a', session: false, scopes: ['run'] };
  const response = await mcp(request({ jsonrpc: '2.0', id: 1, method: 'initialize' }), env, auth);
  expect(await response.json()).toMatchObject({ result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } });
  const tools = await mcp(request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), env, auth); expect((await tools.json()).result.tools).toHaveLength(10);
  await expect(mcp(request({ jsonrpc: '2.0', id: 3, method: 'ping' }, 'https://evil.example'), env, auth)).rejects.toMatchObject({ status: 403 });
  expect((await mcp(request({ jsonrpc: '2.0', method: 'notifications/initialized' }), env, auth)).status).toBe(202);
});
it('never applies a proposal when its reviewed quote changed', async () => {
  let calls = 0;
  const response = await mcp(new Request('https://cronly.org/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'apply_change', arguments: { id: 'p', quote_microdollars: 100 } } }) }), { APP_ORIGIN: 'https://cronly.org' }, { session: false }, async () => { calls++; return Response.json({ quote_microdollars: 200 }); });
  expect(calls).toBe(1); expect((await response.json()).result.isError).toBe(true);
});
