import { WorkerEntrypoint } from 'cloudflare:workers';
import { executeJavaScript } from '../src/executor/javascript.js';
import { verifyToken } from '../src/auth/crypto.js';

const burn = 'export default () => { let n=0; for(let i=0;i<100000000;i++) n+=Math.sqrt(i); return n; }';
const isolation = 'export default async ctx => { console.log(ctx.input.marker, { token: ctx.secrets.token }); await ctx.fetch("https://fixture.example/"); return ctx.input.marker; }';
export const PROBE_CASES = Object.freeze({
  smoke: { source: 'export default () => "sandbox-ready";', cpu_ms: 100, subrequests: 0 },
  'cpu-control': { source: burn, cpu_ms: 1000, subrequests: 0 },
  'cpu-limit': { source: 'export default () => { for(;;) Math.sqrt(Math.random()); }', cpu_ms: 10, subrequests: 0 },
  'native-fetch': { source: 'export default async () => { try { await fetch("https://example.com"); return false; } catch { return true; } }', cpu_ms: 100, subrequests: 0 },
  'native-connect': { source: 'import { connect } from "cloudflare:sockets"; export default async () => { try { const socket=connect({ hostname:"example.com", port:443 }); await socket.opened; await socket.close(); return false; } catch { return true; } }', cpu_ms: 100, subrequests: 0 },
  'subrequest-control': { source: 'export default async ctx => { return (await ctx.fetch("https://fixture.example/")).status; }', cpu_ms: 100, subrequests: 1 },
  'subrequest-limit': { source: 'export default async ctx => { try { for(let i=0;i<3;i++) await ctx.fetch("https://fixture.example/"); return "escaped"; } catch(error) { return { native_error: error.message }; } }', cpu_ms: 100, subrequests: 1 },
  isolation: { source: isolation, cpu_ms: 100, subrequests: 1 }
});

// A fixture binding exercises real native service subrequests without internet
// traffic or a second implementation of production's account/gateway policies.
export class ProbeGateway extends WorkerEntrypoint {
  async fetch(request) {
    const token = await verifyToken(request.headers.get('x-cronly-capability') || '', 'eg_', this.env.TOKEN_SIGNING_KEY);
    if (token?.account !== 'sandbox-probe' || new URL(request.url).hostname !== 'fixture.example') return new Response(null, { status: 403 });
    await new Promise(resolve => setTimeout(resolve, 25));
    return new Response(null, { status: 200 });
  }
}

async function execute(name, env, ctx, marker = name) {
  const action = { type: 'javascript', ...PROBE_CASES[name] };
  const context = { account: { id: 'sandbox-probe' }, job: { name }, run: { id: marker, trigger: 'manual', scheduled_at: new Date().toISOString() } };
  // The only supplied secret is a synthetic marker used to check redaction.
  return executeJavaScript({ action, vars: {}, input: { marker } }, context, env,
    { exports: { OutboundGateway: options => ctx.exports.ProbeGateway(options) } }, { token: 'probe-private-marker' });
}

/** Fixed, authenticated, short-lived runtime checks; never accepts customer code. */
export default {
  async fetch(request, env, ctx) {
    const expiry = Number(env.PROBE_EXPIRES_AT);
    if (!env.PROBE_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.PROBE_TOKEN}` || !Number.isFinite(expiry) || Date.now() >= expiry) return new Response(null, { status: 401 });
    const name = new URL(request.url).pathname.slice(1);
    if (request.method !== 'POST' || !Object.hasOwn(PROBE_CASES, name)) return new Response(null, { status: 404 });
    if (!(await env.PROBE_LIMITER.limit({ key: 'probe' })).success) return new Response(null, { status: 429 });
    try {
      const result = name === 'isolation' ? await Promise.all(['left', 'right'].map(marker => execute(name, env, ctx, marker))) : await execute(name, env, ctx);
      return Response.json({ case: name, result });
    } catch (error) {
      // Only fixed probe code runs here. Preserve runtime diagnostics so a
      // compile/binding failure cannot masquerade as successful CPU enforcement.
      return Response.json({ case: name, runtime_error: { name: error.name, message: error.message } });
    }
  }
};
