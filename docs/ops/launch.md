# Production launch (L9–L14)

How cronly.org is provisioned and deployed, and the owner's remaining acceptance steps.
[`STATUS.md`](../../STATUS.md) says what is done; evidence goes in
[`docs/acceptance/`](../acceptance/README.md). cronly shares hashbin's operating entity and
Cloudflare account but has its own Clerk application and Stripe product (D1); no credentials
are copied from hashbin.

## What production consists of

| Piece | Where | Setup guide |
|-------|-------|-------------|
| Worker `cronly`, custom domain cronly.org, queue `cronly-runs`, Worker Loader | Cloudflare (Workers Paid) | [Cloudflare credentials](cloudflare-credentials.md) |
| SQLite DO namespaces `AccountDO`, `JobDO`, `SafetyDO`, `DbaLinkDO`, `DbaRevocationsDO`, `DbaReplayCacheDO` | `wrangler.toml` migrations `v1`–`v4` | — |
| Sign-in: invite-only, email code and Google | Clerk production instance | [Clerk](clerk.md) |
| Deposits: dedicated credit and card-cost products, restricted key, signed webhook | Stripe | [Stripe](stripe.md) |
| support@cronly.org | Cloudflare Email Routing | [Support email](support-email.md) |
| Device credentials | devicebasedauth.org | [DBA reference](../devicebasedauth.md#operating-it) |
| Secrets (`TOKEN_SIGNING_KEY`, `SECRETS_MASTER_KEY`, Clerk, Stripe, Cloudflare, `DBA_RTT_SECRET`) | GitHub environment `production`; CI uploads them through stdin | [Secret rotation](secret-rotation.md) |

The full list of Worker secrets is the comment block in `wrangler.toml`. Signing and master
keys are independent random values; recoverable copies are in the owner's macOS Keychain under
service `cronly.org.production` (accounts `TOKEN_SIGNING_KEY`, `SECRETS_MASTER_KEY`). Never
print them into a chat, terminal log or repository, and never overwrite a master key still in
use: rotate through `SECRETS_KEYRING`.

`ANTHROPIC_API_KEY` may be absent while `CRONLY_LAUNCH_APPROVED=false`: prose answers
`503 prose_unavailable` before any hold or provider call. Launch-approved deploys require it.

## Repository variables

| Variable | Now | Meaning |
|----------|-----|---------|
| `CRONLY_DEPLOY_ENABLED` | `false` | `true` deploys every push to main; otherwise deploy with the manual **Deploy production** workflow |
| `CRONLY_LAUNCH_APPROVED` | `false` | Opens Checkout; requires complete operator facts, legal approval and Anthropic |
| `CRONLY_JS_LIVE_ACCEPTED` | `false` | Lets accounts other than `JS_ACCEPTANCE_ACCOUNT` run JavaScript |
| `CRONLY_DO_NAMESPACES` | three IDs | Comma-separated cronly namespace IDs the cost monitor counts (deployed as `COST_SAFETY_DO_NAMESPACES`). Must list all six; the three DBA namespaces are still missing (S5). Never include hashbin's |
| `CRONLY_COST_SAFETY_HARD_STOP` | unset | Optional CI control of the emergency stop (below) |
| `CRONLY_STRIPE_CREDIT_PRODUCT_ID`, `CRONLY_STRIPE_CARD_COST_PRODUCT_ID` | set | Distinct dedicated Stripe products, checked by preflight |

## Deploying

Run **Deploy production** (only main can deploy; runs are serialized and never cancel an active
one). It runs the dependency audit, lint, unit and browser tests, the operator-profile check,
deployment preflight (`scripts/check-deployment-secrets.mjs`), the Worker deploy, secret upload,
`npm run verify:production` and `npm run verify:production:browser`.

`verify:production` checks public pages, the release SHA in `/health`, live Clerk configuration,
access denial and LocalDev rejection. Public checks retry six times, two seconds apart, while code
and secrets propagate. With `CRONLY_API_KEY` set it adds one billed read, only after the public
checks pass and never retried. `CRONLY_ORIGIN` must be an HTTPS origin; redirects fail.
Failures name the path and status without printing credentials or bodies.

`verify:production:browser` opens the live Clerk email/Google form in a fresh browser without
signing in; screenshots are kept seven days as artifact `production-signed-out-browser`. It
proves the form loads, not that sign-in works.

## First single-user validation

1. Invite your own email in the [Clerk production
   dashboard](https://dashboard.clerk.com/apps/app_3MEi0XGTZX7J6dgu6ezcHdRwyHA/instances/ins_3MEi8pmakrxmN0ExfJI0UhhAicJ)
   and sign in at https://cronly.org/app.html with an email code. Google stays External /
   Testing until published, so only authorized test identities can use it.
2. Confirm the empty dashboard and zero-balance header, visit every workspace page and preview a
   cron expression in Jobs without saving. Check the signed `user.created` delivery in Clerk and
   record your Clerk user ID as GitHub secret `JS_ACCEPTANCE_ACCOUNT`. None of this needs a
   deposit or API key.
3. Before any paid run: approve the policies (L13), add Anthropic (L9), and get a first healthy
   cost-monitor report (below). Then set `CRONLY_LAUNCH_APPROVED=true`, redeploy, make one real
   $5 deposit and check fulfillment. Sign-up stays invite-only throughout.
4. Use the same account for the live acceptance below, and a capped API key for the sandbox.
   Record each result in `docs/acceptance/` and update its STATUS row.

## Live acceptance before opening to others

- **Deposit.** The card cost is itemized, the full credit arrives once, a repeated signed webhook
  does not add it twice, and a refund is operationally possible from Stripe.
- **HTTP service.** Scheduled, manual and webhook runs; token revocation; missing input; rate
  caps; key scope and daily cap; budget day/month pauses and resumption; empty balance and
  resumption on deposit; redirects and destination blocks; redaction; retention and export.
- **Cost monitor.** With all six namespace IDs in `CRONLY_DO_NAMESPACES`, invoke the daily
  monitor (Cloudflare dashboard or the scheduled endpoint) and inspect the private SafetyDO
  report. Missing or unsupported analytics fields and stale reports keep the brake on. The
  report separates measured Worker/DO cost from the ledger allowance for Queue and Dynamic
  Worker activation.
- **JavaScript.** `CRONLY_LIVE_ACCEPTANCE=1 npm run test:sandbox:live` with a capped
  `CRONLY_API_KEY`. It reserves before running and removes its definitions. Check CPU rejection
  in Cloudflare telemetry, blocked native fetch/connect, counted gateway traffic and separate
  concurrent logs (local Miniflare enforces none of these limits). Then set
  `CRONLY_JS_LIVE_ACCEPTED=true` and redeploy.
- **Prose.** `CRONLY_EVAL_CONFIRMED=1 npm run eval:prose` runs the 100-case to-cron eval on both
  models with an Anthropic key from your secret manager. Inspect ambiguous and DST cases,
  accuracy, tokens and spend, then decide D3.
- **Legal.** Fill the operator snapshot ([procedure](../operator/README.md)), run
  `npm run legal:generate` and `npm run legal:check`, get Terms and Privacy approved and replace
  the draft markers with effective dates. Launch-approved deploys also run
  `node scripts/operator-profile.mjs --require-complete`.
- **Edge protection.** Add Cloudflare billing notifications and WAF/rate-limit rules for
  anonymous, invalid-key and bad-hook traffic (the native `PUBLIC_LIMITER` is already bound).
  Keep request logging off for hook paths and credentials; never log full trigger URLs,
  `Authorization`, request bodies or secret values.
- **devicebasedauth.org.** The owner steps in [the S5 plan](../../todo/dba_integration.md#owner-steps-ops).

Then record the evidence and release SHA, update STATUS, and enable automatic deploys if wanted.

### Sandbox runtime probe

Independently of app credentials, the sandbox runtime can be checked with a Wrangler login:

```sh
CRONLY_LIVE_ACCEPTANCE=1 npm run test:sandbox:runtime
```

It deploys a uniquely named `cronly-sandbox-probe-*` Worker on workers.dev with the production
`executeJavaScript` and log wrapper, runs eight fixed cases (controls, explicit CPU and
subrequest rejection, native fetch/connect denial, concurrent log isolation, synthetic-secret
redaction) behind an ephemeral secret, and removes the Worker in `finally`. It costs under $0.10
and writes a sanitized JSON report to a printed temporary path. If interrupted, delete only the
Worker named in that report with `wrangler delete`. It does not exercise billing, the Queue or
the gateway, so it does not replace the JavaScript acceptance above. Last passed 2026-11-16:
[evidence](evidence/sandbox-runtime-2026-11-16.json).

## Emergency stop and cost brake

Worker variable `COST_SAFETY_HARD_STOP=true` stops all runs; JobDO, the executor and the gateway
check it. Set it in the Worker dashboard for an immediate stop; deployments preserve dashboard
variables. To manage it through CI, set `CRONLY_COST_SAFETY_HARD_STOP` to `true` or `false` and
deploy; when set, it overrides the dashboard on the next deploy, and an invalid value refuses
deployment. Leave it unset to keep the deployed setting.

The daily cost monitor persists a brake that pauses schedules; missing or stale analytics fail
closed. Queued runs skipped by the stop or the brake release their holds with no charge (and no
paid JavaScript activation). To recover, clear the cause and rerun reconciliation: a healthy
report resumes cost-brake pauses (and only those) through a durable, paged scan that survives
restarts, so rerunning finishes an interrupted one. Do not defeat the brake to get a green check.

## Operational limits

Queue redelivery never repeats a claimed external call; uncertain outcomes expire at the held
maximum, so customers should still make their endpoints idempotent. The legal drafts are not
effective policies. Keep sign-up invite-only until every L14 acceptance check is recorded.
