const required = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SECRETS_MASTER_KEY', 'TOKEN_SIGNING_KEY', 'ANTHROPIC_API_KEY'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) { console.error(`Missing deployment secrets: ${missing.join(', ')}`); process.exitCode = 1; }
else console.log('Required deployment secrets are present.');
