import { spawn } from 'node:child_process';
const names = ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SECRETS_MASTER_KEY', 'SECRETS_KEYRING', 'TOKEN_SIGNING_KEY', 'ANTHROPIC_API_KEY', 'CLOUDFLARE_ANALYTICS_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'ALERT_WEBHOOK_URL', 'JS_ACCEPTANCE_ACCOUNT', 'DBA_API_KEY'];
const secrets = Object.fromEntries(names.filter(name => process.env[name]).map(name => [name, process.env[name]]));
const child = spawn('npx', ['wrangler', 'secret', 'bulk'], { stdio: ['pipe', 'inherit', 'inherit'], env: process.env });
child.stdin.end(JSON.stringify(secrets));
child.on('exit', code => { process.exitCode = code ?? 1; });
