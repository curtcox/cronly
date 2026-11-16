import { it, expect, vi } from 'vitest';
import worker from '../index.js';
import { AccountDO } from '../durable-objects/account-do.js';
import { JobDO } from '../durable-objects/job-do.js';
import { namespace } from '../../test-utils/storage.js';
import { rpc } from '../utils/rpc.js';
import { consume } from './consumer.js';
async function setup(balance = 2000) {
  const messages = [];
  const env = { ENVIRONMENT: 'local', SECRETS_MASTER_KEY: 'test', RUN_QUEUE: { send: async body => messages.push(body) }, OUTBOUND_FETCH: vi.fn(async () => new Response('secret-token', { status: 200 })) };
  env.ACCOUNTS = namespace(AccountDO, env); env.JOBS = namespace(JobDO, env);
  const api = async (path, method = 'GET', body, headers) => {
    const response = await worker.fetch(new Request(`https://cronly.org${path}`, { method, body: body && JSON.stringify(body), headers: { Authorization: 'LocalDev a', ...headers } }), env);
    return { status: response.status, ...await response.json() };
  };
  await api('/api/dev/deposit', 'POST', { amount_microdollars: balance });
  await api('/api/secrets/token', 'PUT', { value: 'secret-token' });
  await api('/api/actions/ping', 'PUT', { url: 'https://example.com', headers: { Authorization: 'Bearer {{secret.token}}' } });
  await api('/api/jobs/pinger', 'PUT', { action: 'ping', cron: '* * * * *' });
  return { env, api, messages };
}
it('queues only after holding funds, redacts output, and deduplicates delivery', async () => {
  const { api, messages, env } = await setup();
  const first = await api('/api/jobs/pinger/run', 'POST', {}, { 'Idempotency-Key': 'r1' });
  expect(first.status).toBe(200); expect(messages).toHaveLength(1);
  expect((await api('/api/account')).held_microdollars).toBe(30);
  const ack = vi.fn(); const message = { body: messages[0], ack };
  await consume(message, env, {}); await consume(message, env, {});
  expect(env.OUTBOUND_FETCH).toHaveBeenCalledTimes(1);
  const runs = await rpc(env.JOBS, 'a:pinger', 'runs');
  expect(runs.items[0]).toMatchObject({ status: 'success', cost_microdollars: 30 });
  expect(JSON.stringify(runs)).not.toContain('secret-token');
  expect((await api('/api/account')).held_microdollars).toBe(0);
  await api('/api/jobs/pinger/run', 'POST', {}, { 'Idempotency-Key': 'r1' }); expect(messages).toHaveLength(1);
});
it('pauses an unfunded schedule with no recurring alarm and never sends it', async () => {
  const { api, messages, env } = await setup(300);
  expect((await api('/api/jobs/pinger/run', 'POST', {})).status).toBe(402);
  expect(messages).toHaveLength(0);
  const settings = await rpc(env.JOBS, 'a:pinger', 'status'); expect(settings.paused).toBe('insufficient_balance');
  expect(env.JOBS.get('a:pinger').storage.alarm).toBeGreaterThan(Date.now() + 86400000);
});
it('freezes definitions at reservation and blocks concurrent overlap', async () => {
  const { api, messages, env } = await setup();
  await api('/api/jobs/pinger/run', 'POST', {});
  expect((await api('/api/jobs/pinger/run', 'POST', {})).status).toBe(409);
  await api('/api/actions/ping', 'PUT', { url: 'https://other.example.com' });
  await consume({ body: messages[0], ack() {} }, env, {});
  expect(env.OUTBOUND_FETCH.mock.calls[0][0].url).toBe('https://example.com/');
});
