import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Reject generic action failures: only explicit native-limit diagnostics pass. */
export function verifyProbe(name, data) {
  assert.equal(data.case, name);
  if (name === 'cpu-limit' || name === 'subrequest-limit') {
    const diagnostic = data.runtime_error?.message || (data.result?.status === 'success' ? JSON.parse(data.result.return_value)?.native_error : '') || '';
    assert.match(diagnostic, name === 'cpu-limit' ? /CPU|exceeded.*(?:time|resource).*limit/i : /subrequest|too many.*requests/i, `${name}: native limit rejection missing`);
    return;
  }
  const results = name === 'isolation' ? data.result : [data.result];
  assert.equal(results?.length, name === 'isolation' ? 2 : 1);
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 'success', `${name}: control did not succeed`);
    const value = JSON.parse(result.return_value);
    if (name === 'smoke') assert.equal(value, 'sandbox-ready');
    if (name === 'cpu-control') assert(Number.isFinite(value) && value > 0);
    if (name.startsWith('native-')) assert.equal(value, true, `${name}: native networking escaped`);
    if (name === 'subrequest-control') assert.equal(value, 200);
    if (name === 'isolation') {
      const marker = index === 0 ? 'left' : 'right'; const other = index === 0 ? 'right' : 'left';
      assert.equal(value, marker); assert(result.console.includes(marker)); assert(!result.console.includes(other));
      assert(result.console.includes('«secret:token»')); assert(!JSON.stringify(result).includes('probe-private-marker'));
    }
  }
}

/** Retry only pre-execution auth refusals while the secret deployment propagates. */
export async function requestProbe(origin, name, token) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${origin}/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(90000) });
    if (response.status !== 401 || attempt === 7) return response;
    await response.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

async function wrangler(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--no-install', 'wrangler', ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || resolvePath('wrangler.log') } });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`Wrangler ${args[0]} failed:\n${output}`)));
    child.stdin.end(input);
  });
}
let directory;
const resolvePath = name => resolve(directory, name);

/** Deploy and remove an isolated runtime probe using the existing Wrangler login. */
export async function probeSandbox() {
  assert.equal(process.env.CRONLY_LIVE_ACCEPTANCE, '1', 'Set CRONLY_LIVE_ACCEPTANCE=1 to authorize a temporary Cloudflare runtime probe (estimated maximum $0.10).');
  const name = `cronly-sandbox-probe-${crypto.randomUUID().slice(0, 8)}`;
  directory = await mkdtemp(resolve(tmpdir(), 'cronly-sandbox-probe-'));
  const config = resolvePath('wrangler.toml');
  const main = fileURLToPath(new URL('./sandbox-probe-worker.js', import.meta.url));
  const expires = Date.now() + 10 * 60000;
  await writeFile(config, `name = ${JSON.stringify(name)}\nmain = ${JSON.stringify(main)}\ncompatibility_date = "2026-10-30"\ncompatibility_flags = ["nodejs_compat"]\nworkers_dev = true\npreview_urls = false\n[vars]\nPROBE_EXPIRES_AT = "${expires}"\n[limits]\ncpu_ms = 1000\n[[worker_loaders]]\nbinding = "LOADER"\n[[ratelimits]]\nname = "PROBE_LIMITER"\nnamespace_id = "${parseInt(crypto.randomUUID().slice(0, 8), 16)}"\nsimple = { limit = 12, period = 60 }\n[observability]\nenabled = false\n`);
  const token = crypto.randomUUID() + crypto.randomUUID();
  const sources = ['scripts/sandbox-probe-worker.js', 'src/executor/javascript.js', 'src/executor/redaction.js'];
  const source_sha256 = Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex')])));
  const report = { worker: name, checked_at: new Date().toISOString(), source_sha256, cases: [], errors: [], cleaned_up: false };
  let deployed = false;
  try {
    // Delete the unique name even if deploy creates the Worker and then loses its reply.
    deployed = true;
    const deployment = await wrangler(['deploy', '--config', config]);
    const origin = deployment.match(new RegExp(`https://${name}\\.[a-z0-9-]+\\.workers\\.dev`))?.[0];
    assert(origin, 'Wrangler did not return a workers.dev endpoint');
    await wrangler(['secret', 'bulk', '--config', config], JSON.stringify({ PROBE_TOKEN: token, TOKEN_SIGNING_KEY: crypto.randomUUID() + crypto.randomUUID() }));
    const denied = await fetch(`${origin}/smoke`, { method: 'POST', signal: AbortSignal.timeout(15000) });
    assert.equal(denied.status, 401);
    for (const name of ['smoke', 'cpu-control', 'cpu-limit', 'native-fetch', 'native-connect', 'subrequest-control', 'subrequest-limit', 'isolation']) {
      try {
        const response = await requestProbe(origin, name, token);
        assert.equal(response.status, 200, `${name}: unexpected response status`);
        const data = await response.json(); report.cases.push(data);
        verifyProbe(name, data); console.log(`Passed: ${name}`);
      } catch (error) { report.errors.push({ case: name, message: error.message }); console.log(`Failed: ${name}`); }
    }
    assert.equal(report.errors.length, 0, report.errors.map(error => error.message).join('\n'));
  } finally {
    try { if (deployed) { await wrangler(['delete', '--config', config, '--force']); report.cleaned_up = true; console.log(`Removed temporary Worker ${name}`); } }
    finally { await writeFile(resolvePath('report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(`Probe evidence: ${resolvePath('report.json')}`); }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await probeSandbox(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
