import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const sha = process.env.GITHUB_SHA; assert(/^[a-f0-9]{40}$/.test(sha || ''), 'A full deployment GITHUB_SHA is required.');
const variables = { GIT_SHA: sha, COST_SAFETY_DO_NAMESPACES: process.env.COST_SAFETY_DO_NAMESPACES || '', LAUNCH_APPROVED: process.env.LAUNCH_APPROVED === 'true' ? 'true' : 'false', JS_LIVE_ACCEPTED: process.env.JS_LIVE_ACCEPTED === 'true' ? 'true' : 'false' };
const args = ['wrangler', 'deploy']; for (const [name, value] of Object.entries(variables)) args.push('--var', `${name}:${value}`);
const child = spawn('npx', args, { stdio: 'inherit', env: process.env }); child.on('exit', code => { process.exitCode = code ?? 1; });
