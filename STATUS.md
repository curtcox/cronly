# cronly Project Status

**This file is the single source of truth for project status.** If another document
disagrees with it, this file wins and the other document is stale.

- **Last audited:** 2026-11-15 (implementation underway)
- **Production:** nothing deployed. `cronly.org` is not yet pointed at Cloudflare.
- **Overall:** Building on main. Design is in [`todo/master_plan.md`](todo/master_plan.md); pricing in
  [`docs/business/pricing.md`](docs/business/pricing.md).

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
3. Detailed design lives in `todo/<plan>.md`. When a plan is fully done, `git mv` it to `done/`
   and update its row here.

---

## Decisions needed

| ID | Decision | Owner | Status | Recommendation |
|----|----------|-------|--------|----------------|
| D1 | Operating entity: run cronly inside the same LLC (and Cloudflare, Stripe, Clerk accounts) as hashbin, or separately? | legal/ops | ✅ | Owner approved 2026-11-15: same LLC, separate Stripe product and Clerk application, same Cloudflare account (Workers Paid plan is then already paid). |
| D2 | JavaScript sandbox: Workers for Platforms or Dynamic Worker Loader | code/ops | ❓ | Worker Loader if GA with enforced CPU limits; else WfP (+$25/month fixed). Master plan §3.4. Decide at the start of L10. |
| D3 | Prose model: `claude-opus-5-5` (≈1.4¢ per translation) or `claude-haiku-5-5` (≈0.1¢) | owner | ❓ | Build with Opus 5.5 at low effort; run the L9 eval on both and pick per endpoint. One constant in `src/utils/llm-policy.js`. |
| D4 | Minimum deposit | owner | ✅ | Owner approved 2026-11-15: $5, card payment cost itemized on top (hashbin L20 wording). |
| D5 | API reads billed at 1 µ$ each, web UI reads free and rate-limited | owner | ✅ | Owner approved 2026-11-15: yes; keeps "no account costs more than it paid" true for scripted polling. |
| D6 | Starting prices in `docs/business/pricing.md` (25 µ$/run, 100 µ$/change, prose 1.5× + 500 µ$) | owner | ✅ | Owner approved 2026-11-15: accept, adjusting upward to pass floors; recalibrate after a month of production cost data (S3). |

## Launch blockers

| ID | Item | Owner | Status | Notes / reference |
|----|------|-------|--------|-------------------|
| L1 | Scaffold: wrangler (prod + local), Vitest, ESLint, `dev:local`, CI, `/health` | code | ✅ | Wrangler prod/local, pinned dependencies, lint, CI, health and gated LocalDev/deposits verified. Master plan §10.1. Copy hashbin's local mode and CI shape. |
| L2 | Accounts and auth: Clerk sessions, Clerk webhook → AccountDO, API keys with scopes and daily spend caps, `API_ROUTES` access test | code | ✅ | Clerk/LocalDev auth, signed hashed scoped keys, revocation, daily caps and Clerk webhook; access coverage tests. §4.1. Port hashbin `src/auth/`. |
| L3 | Money: µ$ ledger, reserve/settle/expire holds, Stripe deposits, history, `cost-policy.js`, `pricing.js`, price-floor tests, `/api/quote` | code | 🟨 | Transactional ledger/holds, signed Stripe webhook, itemized Checkout and quotes tested; real deposit remains L14. §6, `docs/business/pricing.md`. Needs D4, D6. |
| L4 | Definitions: variables, secrets (AES-GCM, write-only), HTTP actions, templates, change billing, audit log, dry run, idempotency | code | ✅ | Atomic billed CRUD, reference checks, AES-GCM write-only secrets, dry runs, audit and idempotency tested. §2, §3.3, §4.2. |
| L5 | Scheduler: jobs, croner, JobDO alarms, run queue, HTTP executor, redaction, settlement, pause on refusal, policies, budget windows | code | 🚧 | HTTP path verified in real local Worker/Queue; deterministic IDs, holds and redaction tested. Final policy/recovery audit underway. §3, §3.1, §2.3. |
| L6 | Runs, costs, upcoming, projection APIs; retention pruning | code | 🚧 | Retained runs, NDJSON, costs, bounded upcoming and schedule projections implemented; final pagination/retention audit underway. §4.3, §6, §7. |
| L7 | Triggers: run now, trigger tokens, `/hook/*`, per-token rate limits, CORS, `{{input.*}}` | code | ✅ | Manual runs, signed job-only tokens, revocation, token limits, input validation and hook-only CORS tested. §4.1. |
| L8 | Web UI with balance + runway header on every signed-in page; Playwright tests | code | ⬜ | §5. |
| L9 | Prose: free cron explain; Claude to-cron, ask, change proposals + apply; holds and billing; to-cron eval | code/ops | 🚧 | Structured Anthropic client, held conversations, read-only tools and separate stale-checked proposals implemented/tested with mock provider; live eval pending. §3.5. Needs D3 and an Anthropic API key (ops). |
| L10 | JavaScript actions: sandbox, outbound gateway, CPU/subrequest limits and pricing, editor | code/ops | ⬜ | §2.2, §3.4. Needs D2. |
| L11 | Agent surface: OpenAPI + drift test, `llms.txt`, agent docs, MCP server, `/api/config`, browser snippet | code | 🚧 | Atomic config diff, generated OpenAPI with drift test, stateless scoped MCP implemented; docs/SDK and protocol tests next. §4.4, §4.5. |
| L12 | Abuse and cost safety: limits, destination rules, rate-limit rules, daily cost reconciliation and brake, invite-only sign-up | code/ops | ⬜ | §8. |
| L13 | Terms of Service and Privacy Policy (acceptable use, refunds, suspension) | legal | ⬜ | Start from hashbin's drafts. Needs D1. |
| L14 | Production: cronly.org DNS and custom domain, live Clerk and Stripe, secrets, end-to-end test with a real deposit, `verify:production` | ops | ⬜ | §10.13. |

## Soon after launch

| ID | Item | Owner | Status | Notes / reference |
|----|------|-------|--------|-------------------|
| S1 | Secret master-key rotation (versioned keys, re-encrypt) | code | ⬜ | §3.3. |
| S2 | Charge measured JS CPU instead of the configured limit | code | ⬜ | §3.4; needs per-invocation CPU data. |
| S3 | Recalibrate prices from a month of real Cloudflare and Anthropic bills | ops/code | ⬜ | `docs/business/pricing.md`. |
| S4 | Lower per-run row writes (merge hold + ledger, batch next-fire updates) and pass the saving into the price | code | ⬜ | pricing.md "Ways to lower the cost". |

## Backlog

| ID | Item | Owner | Status | Notes / reference |
|----|------|-------|--------|-------------------|
| B1 | Anything in master plan §11 that customers ask for | — | ⬜ | Add a row per request. |
