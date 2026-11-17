import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

/** Preserve operator controls while applying the reviewed release configuration. */
export function deploymentArgs(env) {
  const sha = env.GITHUB_SHA; assert(/^[a-f0-9]{40}$/.test(sha || ''), 'A full deployment GITHUB_SHA is required.');
  const variables = { GIT_SHA: sha, COST_SAFETY_DO_NAMESPACES: env.COST_SAFETY_DO_NAMESPACES || '', LAUNCH_APPROVED: env.LAUNCH_APPROVED === 'true' ? 'true' : 'false', JS_LIVE_ACCEPTED: env.JS_LIVE_ACCEPTED === 'true' ? 'true' : 'false' };
  for (const name of ['STRIPE_CREDIT_PRODUCT_ID', 'STRIPE_CARD_COST_PRODUCT_ID']) variables[name] = env[name] || '';
  // An unset CI control must preserve a stop set directly during an incident.
  // Clearing it requires the explicit string "false"; typos cannot clear it.
  if (env.COST_SAFETY_HARD_STOP) {
    assert(['true', 'false'].includes(env.COST_SAFETY_HARD_STOP), 'COST_SAFETY_HARD_STOP must be true, false or unset.');
    variables.COST_SAFETY_HARD_STOP = env.COST_SAFETY_HARD_STOP;
  }
  const args = ['wrangler', 'deploy', '--keep-vars'];
  for (const [name, value] of Object.entries(variables)) args.push('--var', `${name}:${value}`);
  return args;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const child = spawn('npx', deploymentArgs(process.env), { stdio: 'inherit', env: process.env });
    child.on('error', () => { console.error('Unable to start Wrangler deployment.'); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
