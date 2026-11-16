import { secretKeyring } from '../src/executor/secret-keys.js';
const required = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'TOKEN_SIGNING_KEY', 'ANTHROPIC_API_KEY'];
const missing = required.filter(name => !process.env[name]);
if (process.env.TOKEN_SIGNING_KEY && new TextEncoder().encode(process.env.TOKEN_SIGNING_KEY).length < 32) missing.push('TOKEN_SIGNING_KEY (requires at least 32 random bytes)');
try { secretKeyring({ ...process.env, ENVIRONMENT: 'production' }); }
catch { missing.push('SECRETS_MASTER_KEY or valid SECRETS_KEYRING (each key requires at least 32 random bytes)'); }
if (missing.length) { console.error(`Missing deployment secrets: ${missing.join(', ')}`); process.exitCode = 1; }
else console.log('Required deployment secrets are present.');
