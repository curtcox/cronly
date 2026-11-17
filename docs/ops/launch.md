# Production launch handoff (L9–L14)

Work is on main. The app Worker has not been deployed. Deploying is an
owner operation; credentials are not copied from hashbin. Use the same operating entity
and Cloudflare account, with a separate Clerk application and Stripe product, as approved
2026-11-15. STATUS.md is authoritative for acceptance status.

## Provision and deploy

1. Cloudflare Workers Paid: provision queue `cronly-runs`, add cronly.org to Cloudflare,
   and configure the custom domain. The Wrangler file provisions SQLite DO namespaces
   AccountDO, JobDO and SafetyDO plus the Worker Loader binding.
2. Create a separate Clerk application. Enable **Restricted** sign-up and invite the
   owner first. Use live publishable/secret keys; allow only https://cronly.org as the
   authorized party. Point its signed user.created/user.updated webhook to
   https://cronly.org/webhooks/clerk. Do not enable public sign-up.
   The separate application, production instance, Invite-only mode, verified DNS
   records, GitHub live key storage and dedicated Google OAuth client/Clerk
   connection were completed on 2026-11-17. Clerk certificates are issued, and
   the production user webhook and its GitHub signing-secret storage are configured.
   Google publication/branding, signed webhook delivery and owner sign-in remain tracked in
   [Clerk setup](clerk.md).
3. Configure Stripe Checkout for USD cards and a separate cronly product. Point signed
   checkout.session.completed/async_payment_succeeded webhooks to /webhooks/stripe.
   Payments itemize credit and non-refundable card cost. Verify tax obligations with
   the owner/legal reviewer before launch. Refunds are owner-operated through Stripe.
   The dedicated live catalog, restricted runtime key, active two-event webhook
   and GitHub production secret storage are provisioned. An unpaid live Checkout
   session verified the catalog and permissions and was expired. Signed delivery,
   deployed balance fulfillment and a real purchase remain. Follow
   [Stripe setup and acceptance](stripe.md).
4. Generate independent 32-byte-or-longer random TOKEN_SIGNING_KEY and
   SECRETS_MASTER_KEY through a secret manager. Keep master-key backups securely;
   follow [secret-key rotation](secret-rotation.md) when replacing a master. Versioned
   `SECRETS_KEYRING` can replace the legacy binding; never overwrite a key still in use.
5. Put the required secrets listed in wrangler.toml into GitHub's production environment.
   Add CLOUDFLARE_API_TOKEN with scoped deployment permissions and
   CLOUDFLARE_ACCOUNT_ID. Add the read-only analytics token separately. No .dev.vars
   or plaintext credentials belong in git. CI uploads secrets through stdin.
   The independent deployment and analytics tokens were created and stored on
   2026-11-17; see [scopes, expiration and live schema checks](cloudflare-credentials.md).
6. Run the manual Deploy production workflow. Automatic main deployments are opt-in via
   repository variable CRONLY_DEPLOY_ENABLED=true after initial setup. CI verifies lint,
   unit/cost-floor/drift tests, browser flows and the Worker build before deploy.
7. Record the three actual cronly namespace IDs in GitHub repository variable
   CRONLY_DO_NAMESPACES, comma-separated (deployed as COST_SAFETY_DO_NAMESPACES). Do not include hashbin namespaces.
   Use the local scheduled endpoint or Cloudflare's dashboard to invoke the first daily
   monitor, and inspect the private SafetyDO report. Missing/unsupported analytics
   fields or stale reports keep the brake on. Verify the GraphQL namespace filters and
   total CPU/row/duration/storage fields against the actual account schema; adapt if
   needed. The report explicitly distinguishes observed Worker/DO cost from the
   conservative ledger allowance covering Queue and Dynamic Worker activation.
8. Add Cloudflare billing notifications and edge rate-limit/WAF rules for anonymous,
   invalid API-key and bad-hook traffic. Native PUBLIC_LIMITER is already configured.
   Keep observability/request logging disabled for hook paths and credentials; never
   log full trigger URLs, Authorization, request bodies or secret values. Alert webhook
   configuration is optional and owner-controlled.

## Live acceptance before opening payments

Before Clerk/Stripe credentials are available, the sandbox runtime itself can be
checked independently with the existing Wrangler login:

```sh
CRONLY_LIVE_ACCEPTANCE=1 npm run test:sandbox:runtime
```

This deploys a uniquely named `cronly-sandbox-probe-*` Worker on workers.dev using
the production `executeJavaScript` and log wrapper. It accepts only eight fixed
cases, authenticates with an ephemeral secret sent through stdin, expires after
ten minutes and rate-limits requests. The fixture gateway makes no internet
requests. Controls must succeed before explicit CPU/subrequest rejections count;
the other checks cover native fetch/connect denial, concurrent log isolation and
synthetic-secret redaction. Estimated provider cost is below $0.10 per suite at
[current rates](https://developers.cloudflare.com/dynamic-workers/pricing/).
The runner removes its Worker in `finally` and writes a sanitized JSON report to
the printed temporary path, including source hashes and cleanup status. If interrupted, remove
only the unique Worker named in that report/config with `wrangler delete`.

The probe does not provision app credentials or customer credit, exercise the
production billing/Queue/gateway path, or enable `JS_LIVE_ACCEPTED`. Complete the
service acceptance below before enabling JavaScript for customers.

Live runtime checks passed on 2026-11-16: [recorded evidence](evidence/sandbox-runtime-2026-11-16.json).
The finite arithmetic test also succeeded at 10 ms, so the CPU rejection probe
uses a nonterminating loop and requires the explicit native CPU-limit exception.
The cronly.org zone is active and the `cronly-runs` queue exists. GitHub's production
environment contains the verified Cloudflare account ID, deployment/analytics
tokens and live Clerk keypair/webhook secret. Other application credentials and
the app Worker remain unconfigured. The analytics query now passes live schema
validation; actual usage/cost-monitor acceptance requires deployed namespaces.
Automatic deployments, launch approval
and public JavaScript remain disabled.

- Set GitHub secret JS_ACCEPTANCE_ACCOUNT to the invited owner's Clerk ID. Other accounts cannot
  invoke JS until JS_LIVE_ACCEPTED=true. Keep a daily cap on the owner's test API key.
- `npm run verify:production` checks public pages, release SHA, live Clerk configuration,
  access denial and LocalDev rejection. Optional CRONLY_API_KEY adds one billed read.
- Run a real $5 deposit on Account. Confirm the card fee is itemized, full credit is
  credited once, repeated signed webhooks do not add credit twice, and refunds are
  operationally possible. Set repository variable CRONLY_LAUNCH_APPROVED=true only after reviewing
  the legal drafts and payment wording; keep the service invite-only throughout.
- Exercise HTTP schedule/manual/hook runs, token revocation, missing inputs, rate caps,
  key scope/day cap, budget day/month pauses/resumption, empty balance/deposit resumption,
  redirects/destination blocks, redaction and retention/export.
- Run `CRONLY_LIVE_ACCEPTANCE=1 npm run test:sandbox:live` with a capped CRONLY_API_KEY.
  The test is finite, reserves before running and cleans up its definitions. Verify
  CPU rejection in Cloudflare telemetry, blocked native fetch/connect, counted gateway
  traffic and concurrent run log separation. Local Miniflare does not enforce production
  CPU limits. Then set repository variable CRONLY_JS_LIVE_ACCEPTED=true and redeploy.
- Run the 100-case prose eval for both models using an Anthropic key from your secret
  manager: `CRONLY_EVAL_CONFIRMED=1 npm run eval:prose`. Inspect ambiguous and DST cases,
  accuracy, tokens and spend, then decide D3. Opus remains the approved initial default.
- Complete entity/contact/jurisdiction placeholders and obtain legal approval of Terms
  and Privacy. Follow the [operator snapshot procedure](../operator/README.md), run
  `npm run legal:generate` and `npm run legal:check`, and pin the shared source revision.
  Approved-launch deploys also require `node scripts/operator-profile.mjs --require-complete`.
  Replace draft markers with effective dates before public availability.
- Record evidence and deployment SHA in STATUS.md, then enable automatic deploys if desired.

A global emergency stop is Worker variable COST_SAFETY_HARD_STOP=true. Set it
directly in the Worker dashboard for an immediate stop. Deployments preserve
dashboard variables, so a routine release cannot remove this stop. To manage it
through CI, set repository variable CRONLY_COST_SAFETY_HARD_STOP=true and run
Deploy production. Clearing the stop through CI requires the explicit value false
and another deployment; leaving the repository variable empty preserves the
deployed setting. Invalid values refuse deployment. If the repository variable
is set, it takes precedence over the dashboard on the next deployment; keep it
aligned with the intended incident response.

The stop is checked by
JobDO, executor and gateway. Queued runs skipped before execution by this stop or
the analytics brake release their holds with a zero charge; skipped JavaScript
runs do not record a paid daily activation. The persisted daily cost brake also pauses schedules;
missing/stale analytics fails closed. Clear the cause, rerun reconciliation and verify
resumption. Registry reconciliation reads 100 accounts per page. A healthy report
atomically records a versioned recovery scan; each subsequent page commits account
resume outboxes with its scan cursor. If staging, a resume request or acknowledgement
fails, rerun reconciliation to finish the durable scan and queue after a restart.
New brake cycles supersede older acknowledgements. Each monitor
starts a durable generation, and superseded results neither replace the current
report nor start recovery or send alerts. This ordering survives a SafetyDO restart.
Analytics refusals
publish the job's cost-brake pause to the account runtime without recurring settings
writes. Do not defeat the brake to get a green launch check.

## Important operational limits

This is an initial implementation, not a production acceptance certificate. Cloudflare
analytics datasets and sandbox CPU rejection need the live account. Queue redelivery
never repeats a claimed external call; uncertain outcomes expire at the held maximum.
Use downstream idempotency too. The legal drafts are not effective policies. Keep
invite-only until every L14 acceptance check is documented.
