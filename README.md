# cronly — cron only

Named HTTP/JavaScript actions, variables and encrypted secrets, cron/manual/webhook
triggers, and a prepaid micro-dollar ledger on Cloudflare Workers, SQLite Durable
Objects and Queues. Vanilla frontend; Clerk auth, Stripe deposits, Anthropic prose.

## Local development

```sh
npm ci
npm run dev:local
# Open http://localhost:8787/app.html, choose a local account, add development credit.
```

LocalDev credentials and fake deposits only work with ENVIRONMENT=local. No external
credentials are required for the local HTTP/JS workspace. Use only trusted test code in
local JS: Miniflare does not enforce production resource limits.

```sh
npm run lint
npm test
npm run test:e2e
npm run test:local       # with the local server running
npm run check:file-sizes
npm run docs:generate   # after changing routes or releasing the SDK
```

Deployment and live acceptance: [docs/ops/launch.md](docs/ops/launch.md).
Status and remaining owner steps: [STATUS.md](STATUS.md).
Design: [todo/master_plan.md](todo/master_plan.md).
Prices and model: [docs/business/pricing.md](docs/business/pricing.md).

Besides Clerk sessions and `crk_` API keys, cronly accepts device-bound credentials from
[devicebasedauth.org](https://devicebasedauth.org) (`Authorization: DBA` + DPoP, or a
short-lived DBA bearer token) once the account is linked on the Account page; the verifier
is vendored unmodified in `src/vendor/devicebasedauth/`. Reference:
[docs/devicebasedauth.md](docs/devicebasedauth.md); plan and owner steps:
[todo/dba_integration.md](todo/dba_integration.md) (STATUS S5).

Money is integer micro-dollars. Billable work reserves its maximum first; proposals
never apply themselves. Every route declares authority in API_ROUTES. Tests cover
ledger concurrency/idempotency, scopes, secrets, queues, cron/DST, proposals, cost
floors, safety brakes, OpenAPI drift and browser quote/escape flows.
