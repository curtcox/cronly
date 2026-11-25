# cronly Project Status

**This file is the single source of truth for project status.** If another document
disagrees with it, this file wins and the other document is stale.

- **Last audited:** 2026-11-25
- **Production:** https://cronly.org is live, prelaunch, on release `8ca0a5b` (manual deploy
  2026-11-23). Public checks and the live Clerk sign-in form pass; nobody has signed in or paid
  yet. Six SQLite Durable Object namespaces and the `cronly-runs` queue are deployed. Payments
  (`CRONLY_LAUNCH_APPROVED`), automatic deployments (`CRONLY_DEPLOY_ENABLED`) and customer
  JavaScript (`CRONLY_JS_LIVE_ACCEPTED`) are off; prose returns 503 because no Anthropic key is set.
- **Overall:** all launch code is implemented and tested on main. What remains is owner work:
  sign-in, a real deposit, live service acceptance, the prose eval, operator facts and legal approval.

Design: [`todo/master_plan.md`](todo/master_plan.md). Prices: [`docs/business/pricing.md`](docs/business/pricing.md).
Deployment and acceptance steps: [`docs/ops/launch.md`](docs/ops/launch.md).

---

## How this file works

| Symbol | Meaning |
|--------|---------|
| ✅ | Done and verified |
| 🚧 | In progress |
| 🟨 | Implemented; live acceptance or an owner step remains (see notes) |
| ⬜ | Not started |
| ❓ | Needs a decision or information from the project owner |

**Owner** says who can move an item forward:

- `code` — can be done entirely in this repo (by a contributor or an agent)
- `ops` — needs dashboard or credential access (Cloudflare, Clerk, Stripe, Anthropic, DNS); project owner only
- `legal` — needs legal input or a decision only the owner can make

**Rules for keeping it current**

1. A change that finishes, starts, or discovers an item updates its row here **in the same commit**.
2. Each row has a stable ID (`D…` decision, `L…` launch blocker, `S…` soon after launch,
   `B…` backlog). Reference IDs in commits (e.g. `L5: pause jobs on insufficient balance`).
3. Rows say what is true now and what is left. History is in git; evidence goes in
   [`docs/acceptance/`](docs/acceptance/README.md).
4. Detailed design lives in `todo/<plan>.md`. When a plan is fully done, `git mv` it to `done/`
   and update its row here.

---

## Decisions

| ID | Decision | Owner | Status | Outcome / remaining |
|----|----------|-------|--------|---------------------|
| D1 | Operating entity and provider accounts | legal/ops | ✅ | Same LLC and Cloudflare account as hashbin; separate Stripe product and Clerk application (2026-11-15). |
| D2 | JavaScript sandbox | code/ops | ✅ | Dynamic Worker Loader; native CPU/subrequest limits verified on Cloudflare 2026-11-16. Master plan §3.4. |
| D3 | Prose model: `claude-opus-5-5` or `claude-haiku-5-5` | owner | 🟨 | Opus is the approved default. Final choice per endpoint after the owner runs the 100-case eval on both (L9). One constant in `src/utils/llm-policy.js`. |
| D4 | Minimum deposit | owner | ✅ | $5, card payment cost itemized on top (hashbin L20 wording). |
| D5 | API reads billed, web UI reads free and rate-limited | owner | ✅ | Reads 21 µ$ + 2 µ$ per job scanned for aggregate history. Upward corrections needed to pass price floors are pre-approved. |
| D6 | Starting prices | owner | ✅ | Approved 2026-11-15, adjusted upward to pass floors; current prices in `docs/business/pricing.md`. Recalibrate from real bills (S3). |
| D7 | Shared source for operator identity across hashbin, cronly and future apps | code/owner | 🟨 | Offline snapshot, escaped legal-page rendering, drift tests and launch completeness check are in place; support@cronly.org works. Remaining: choose the shared repository, supply operator facts and privacy contact, adopt in hashbin. [Plan](todo/shared_operator_profile.md), [procedure](docs/operator/README.md). |

## Launch blockers

| ID | Item | Owner | Status | Notes / reference |
|----|------|-------|--------|-------------------|
| L1 | Scaffold: wrangler (prod + local), Vitest, ESLint, `dev:local`, CI, `/health` | code | ✅ | Master plan §10. |
| L2 | Accounts and auth: Clerk sessions, Clerk webhook → AccountDO, scoped API keys with daily caps, `API_ROUTES` access test | code | ✅ | Billed key creation/revocation replay their original responses. §4.1. |
| L3 | Money: µ$ ledger, holds, Stripe deposits, history, `cost-policy.js`, `pricing.js`, price-floor tests, `/api/quote` | code | 🟨 | Transactional ledger and holds, signed Stripe webhook, itemized Checkout, deposit caps and quotes are tested. Live: dedicated Stripe catalog and restricted key verified with an unpaid $5.46 Checkout. Remaining: a real deposit and signed fulfillment (L14). §6. |
| L4 | Definitions: variables, AES-GCM write-only secrets, HTTP actions, templates, change billing, audit log, dry run, idempotency | code | ✅ | §2, §3.3, §4.2. |
| L5 | Scheduler: jobs, croner, JobDO alarms, run queue, HTTP executor, redaction, settlement, pause on refusal, policies, budget windows | code | ✅ | Retries, missed/overlap policies, budgets, refusal pauses and crash/redelivery recovery (no repeated external call or charge) are tested; real local Worker/Queue path verified. §3, §3.1, §2.3. |
| L6 | Runs, costs, upcoming, projection APIs; retention pruning | code | ✅ | Stable run cursors, NDJSON export, permanent UTC cost aggregates, cron/DST projections. §4.3, §6, §7. |
| L7 | Triggers: run now, trigger tokens, `/hook/*`, per-token rate limits, CORS, `{{input.*}}` | code | ✅ | Input validated before dispatch; webhook retries reuse one rate attempt; hook-only CORS. §4.1. |
| L8 | Web UI with balance + runway header on every signed-in page; Playwright tests | code | ✅ | Every §5 page, review/quote dialogs before every paid action, run/cost/transaction paging, job budgets and pause reasons, mobile layout. Specs in `tests/`. |
| L9 | Prose: free cron explain; Claude to-cron, ask, change proposals + apply; holds and billing; to-cron eval | code/ops | 🟨 | Implemented and tested with a fake provider, including stale-checked proposals with before/after diffs and recovery of lost acknowledgements. Remaining (owner): Anthropic API key, run `npm run eval:prose` on both models, decide D3. §3.5. |
| L10 | JavaScript actions: sandbox, outbound gateway, CPU/subrequest limits and pricing, editor | code/ops | 🟨 | Worker Loader sandbox, counted gateway, daily activation billing and editor implemented; runtime limits verified live 2026-11-16 ([evidence](docs/ops/evidence/sandbox-runtime-2026-11-16.json)). Remaining: deployed billing/Queue/gateway acceptance (`npm run test:sandbox:live`), then set `CRONLY_JS_LIVE_ACCEPTED`. §2.2, §3.4. |
| L11 | Agent surface: OpenAPI + drift test, `llms.txt`, agent docs, MCP server, `/api/config`, browser snippet | code | ✅ | §4.4, §4.5. |
| L12 | Abuse and cost safety: limits, destination rules, rate limits, daily cost reconciliation and brake, invite-only sign-up | code/ops | 🟨 | Caps, destination rules, native ingress limiter, daily analytics reconciliation with a fail-closed brake and CI-managed emergency stop implemented; live analytics schema verified; Clerk is invite-only. Remaining (owner): first healthy monitor report on real usage, Cloudflare WAF/rate-limit rules and billing alerts. §8. |
| L13 | Terms of Service and Privacy Policy | legal | 🟨 | Service-specific drafts render operator facts from the D7 snapshot; support@cronly.org is in the Terms. Remaining: operator facts, privacy contact, owner/legal approval, effective dates. Checkout stays gated by launch approval. |
| L14 | Production: DNS and custom domain, live Clerk and Stripe, secrets, end-to-end test with a real deposit, `verify:production` | ops | 🟨 | Done: domain, queue and namespaces deployed; production secrets in GitHub's `production` environment (keys backed up in the owner's Keychain); Clerk production instance invite-only with email and Google; Stripe catalog, restricted key and webhook; Deploy production runs `verify:production` and opens the live sign-in form ([2026-11-17 evidence](docs/ops/evidence/production-prelaunch-2026-11-17.json)). Remaining (owner): invite and sign in, publish the Google OAuth app (External / Testing today), signed webhook deliveries, real $5 deposit, paid HTTP/JS runs, first healthy monitor, L9/L12/L13 items. [Procedure](docs/ops/launch.md#first-single-user-validation). |

## Soon after launch

| ID | Item | Owner | Status | Notes / reference |
|----|------|-------|--------|-------------------|
| S1 | Secret master-key rotation (versioned keys, re-encrypt) | code | ✅ | Versioned `SECRETS_KEYRING`, resumable held rotation, scoped CLI. [Procedure](docs/ops/secret-rotation.md). §3.3. |
| S2 | Charge measured JS CPU instead of the configured limit | code | ⬜ | §3.4; needs per-invocation CPU data. |
| S3 | Recalibrate prices from a month of real Cloudflare and Anthropic bills | ops/code | ⬜ | `docs/business/pricing.md`. |
| S4 | Lower per-run row writes and pass the saving into the price | code | 🚧 | Worst-case HTTP run is now 33 row writes, 27 DO requests and five Worker invocations, checked by a 456-path audit; run price 79 µ$. Further reductions remain. [Cost model](docs/business/pricing.md#cost-assumptions). |
| S5 | devicebasedauth.org integration: device-bound API keys, device sessions, online decisions, account linking over OIDC | code/ops | 🟨 | Code done, tested against a fake issuer and deployed (migrations `v3`/`v4`, `DBA_RTT_SECRET` set; DBA's audience record names namespace `cronly` and the callback). Remaining (owner): add the three DBA namespace IDs to `CRONLY_DO_NAMESPACES` and redeploy, register the revocation webhook, fund the operator account at DBA, optional `DBA_API_KEY` and Stage A, live acceptance. [Reference](docs/devicebasedauth.md), [plan](todo/dba_integration.md). |

## Backlog

| ID | Item | Owner | Status | Notes / reference |
|----|------|-------|--------|-------------------|
| B1 | Anything in master plan §11 that customers ask for | — | ⬜ | Add a row per request. |
| B2 | Work down the file size ratchet | code | ✅ | Per-type limits enforced by the pre-push hook, unit tests and CI (`scripts/check-file-sizes.mjs`); baseline is empty. |
