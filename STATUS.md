# cronly Project Status

**This file is the single source of truth for project status.** If another document
disagrees with it, this file wins and the other document is stale.

- **Last audited:** 2026-11-16 (code implemented; live acceptance pending)
- **Production:** nothing deployed. `cronly.org` is not yet pointed at Cloudflare.
- **Overall:** Code implemented and locally verified on main; production/credential/legal acceptance remains. Design is in [`todo/master_plan.md`](todo/master_plan.md); pricing in
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
| D2 | JavaScript sandbox: Workers for Platforms or Dynamic Worker Loader | code/ops | ✅ | Worker Loader selected: current documented native CPU/subrequest limits and stable Wrangler binding; daily activation pricing included. Live enforcement acceptance remains L10. Master plan §3.4. Decide at the start of L10. |
| D3 | Prose model: `claude-opus-5-5` (≈1.4¢ per translation) or `claude-haiku-5-5` (≈0.1¢) | owner | 🟨 | Owner approved Opus default 2026-11-15; final model selection follows live eval; run the L9 eval on both and pick per endpoint. One constant in `src/utils/llm-policy.js`. |
| D4 | Minimum deposit | owner | ✅ | Owner approved 2026-11-15: $5, card payment cost itemized on top (hashbin L20 wording). |
| D5 | API reads billed (20 µ$ after implementation audit), web UI reads free and rate-limited | owner | ✅ | Owner approved billed reads and upward floor corrections 2026-11-15; ledger write costs require a 20 µ$ base plus a 2 µ$/job aggregate-history allowance rather than the 1 µ$ planning estimate; keeps "no account costs more than it paid" true for scripted polling. |
| D6 | Starting prices in `docs/business/pricing.md` (25 µ$/run, 100 µ$/change, prose 1.5× + 500 µ$) | owner | ✅ | Owner approved 2026-11-15: accept, adjusting upward to pass floors; recalibrate after a month of production cost data (S3). |
| D7 | Shared source for operator identity across hashbin, cronly and future apps | code/owner | ❓ | Owner requested shared entity/jurisdiction with per-app contacts on 2026-11-16. Recommend a dedicated versioned profile repo; location and actual entity details pending. Current hashbin main still has placeholders and L21 formation pending. [Adoption plan](todo/shared_operator_profile.md). |

## Launch blockers

| ID | Item | Owner | Status | Notes / reference |
|----|------|-------|--------|-------------------|
| L1 | Scaffold: wrangler (prod + local), Vitest, ESLint, `dev:local`, CI, `/health` | code | ✅ | Wrangler prod/local, pinned dependencies, lint, CI, health and gated LocalDev/deposits verified. Master plan §10.1. Copy hashbin's local mode and CI shape. |
| L2 | Accounts and auth: Clerk sessions, Clerk webhook → AccountDO, API keys with scopes and daily spend caps, `API_ROUTES` access test | code | ✅ | Clerk/LocalDev auth, signed hashed scoped keys, revocation, daily caps and Clerk webhook; access coverage tests. §4.1. Port hashbin `src/auth/`. |
| L3 | Money: µ$ ledger, reserve/settle/expire holds, Stripe deposits, history, `cost-policy.js`, `pricing.js`, price-floor tests, `/api/quote` | code | 🟨 | Transactional ledger/holds, signed Stripe webhook, itemized Checkout and quotes tested; real deposit remains L14. §6, `docs/business/pricing.md`. Needs D4, D6. |
| L4 | Definitions: variables, secrets (AES-GCM, write-only), HTTP actions, templates, change billing, audit log, dry run, idempotency | code | ✅ | Atomic billed CRUD, reference checks, AES-GCM write-only secrets, dry runs, audit and idempotency tested. §2, §3.3, §4.2. |
| L5 | Scheduler: jobs, croner, JobDO alarms, run queue, HTTP executor, redaction, settlement, pause on refusal, policies, budget windows | code | ✅ | Real local Worker/Queue HTTP path verified; retries, missed/overlap, budgets, duplicate delivery, held snapshots, refusal pause and recovery tested. §3, §3.1, §2.3. |
| L6 | Runs, costs, upcoming, projection APIs; retention pruning | code | ✅ | Retained/deleted-job history, NDJSON, permanent UTC cost aggregates, ledger cursors, bounded upcoming, fast cron/DST projections and byte/retention bounds tested. §4.3, §6, §7. |
| L7 | Triggers: run now, trigger tokens, `/hook/*`, per-token rate limits, CORS, `{{input.*}}` | code | ✅ | Manual runs, signed job-only tokens, revocation, token limits, input validation and hook-only CORS tested. §4.1. |
| L8 | Web UI with balance + runway header on every signed-in page; Playwright tests | code | ✅ | All workspace pages, runtime status/runway, direct action tests, quote dialogs and logo implemented; mobile and browser save/run/escaping/cron flows pass. §5. |
| L9 | Prose: free cron explain; Claude to-cron, ask, change proposals + apply; holds and billing; to-cron eval | code/ops | 🟨 | Structured client, held read-only conversations, usage billing, separate stale-checked proposals and 100-case two-model eval implemented. Live eval requires owner Anthropic access. §3.5. Needs D3 and an Anthropic API key (ops). |
| L10 | JavaScript actions: sandbox, outbound gateway, CPU/subrequest limits and pricing, editor | code/ops | 🟨 | Content-addressed Worker Loader, blocked native networking, counted gateway, daily activation settlement and editor implemented; real local JS succeeds. Live CPU-limit acceptance required. §2.2, §3.4. Needs D2. |
| L11 | Agent surface: OpenAPI + drift test, `llms.txt`, agent docs, MCP server, `/api/config`, browser snippet | code | ✅ | Atomic config with conflict checks, OpenAPI drift test, scoped MCP protocol tests, llms.txt/agent docs and immutable SHA-384 SRI trigger SDK verified. §4.4, §4.5. |
| L12 | Abuse and cost safety: limits, destination rules, rate-limit rules, daily cost reconciliation and brake, invite-only sign-up | code/ops | 🟨 | Account/job/destination caps, native ingress limiter, destination checks, conservative daily analytics reconciliation and stale-report brake implemented. Live schema/WAF/billing alerts and Clerk Restricted mode remain owner steps. §8. |
| L13 | Terms of Service and Privacy Policy (acceptable use, refunds, suspension) | legal | 🟨 | Service-specific drafts prepared; owner directed shared entity/jurisdiction with hashbin and separate contacts. Checked current hashbin main 2026-11-16: identity/jurisdiction still placeholders; LLC formation is L21 pending. Shared source tracked in D7; actual facts, cronly contacts and policy approval remain. Checkout is gated by launch approval. |
| L14 | Production: cronly.org DNS and custom domain, live Clerk and Stripe, secrets, end-to-end test with a real deposit, `verify:production` | ops | 🟨 | Custom-domain config, guarded CI deploy, secret upload, production verifier and live sandbox acceptance script prepared; provision credentials/DNS and perform real deposit/live acceptance per docs/ops/launch.md. §10.13. |

## Soon after launch

| ID | Item | Owner | Status | Notes / reference |
|----|------|-------|--------|-------------------|
| S1 | Secret master-key rotation (versioned keys, re-encrypt) | code | ✅ | Atomic versioned keyring, legacy reads, held per-secret re-encryption, edit/delete conflict protection, audit, scoped CLI and CI wiring verified. Persisted local Worker migrated v1 → v2 and executed a redacted JS run with v1 retired. [Operator procedure](docs/ops/secret-rotation.md). §3.3. |
| S2 | Charge measured JS CPU instead of the configured limit | code | ⬜ | §3.4; needs per-invocation CPU data. |
| S3 | Recalibrate prices from a month of real Cloudflare and Anthropic bills | ops/code | ⬜ | `docs/business/pricing.md`. |
| S4 | Lower per-run row writes (merge hold + ledger, batch next-fire updates) and pass the saving into the price | code | ⬜ | pricing.md "Ways to lower the cost". |

## Backlog

| ID | Item | Owner | Status | Notes / reference |
|----|------|-------|--------|-------------------|
| B1 | Anything in master plan §11 that customers ask for | — | ⬜ | Add a row per request. |

## Acceptance record — 2026-11-15

- Lint and 38 unit/integration tests pass; real local Worker/Queue verifies HTTP and
  JavaScript, secret redaction, native network denial and counted gateway access.
- Three Playwright flows pass: responsive layout/logo and quote-before-deposit/save,
  XSS escaping, deterministic cron preview run submission, all-page balance visibility and direct action testing.
- Production Worker dry-run bundles with all DO, Queue, rate-limit and Loader bindings.
- No production deploy, live payment, Anthropic eval or Cloudflare CPU enforcement
  acceptance has been claimed. Follow [launch handoff](docs/ops/launch.md).
- Owner approved Opus as initial default pending the live comparison. Entity name,
  support/privacy contact and legal jurisdiction remain requested owner input.
- Master plan remains in todo because L9/L10/L12/L13/L14 have live or owner work.

Final audit corrections: 60 µ$/HTTP run covers indexed retention and orchestration;
API reads are 20 µ$ plus 2 µ$ per job scanned for aggregate history. Histories return
compact summaries globally and full per-job pages (100 records) to bound memory and
cost. Monthly projections handle calendar resets; webhook forecasts use seven UTC
calendar days of billed counts rather than sampling retained logs.

## S1 acceptance — 2026-11-16

- Lint and 50 unit/integration tests pass, including legacy ciphertext reads,
  key-version tampering, scoped/capped rotation, idempotency, concurrent edit/delete
  conflicts, failed decryption refunds and old-key queued snapshots.
- All three browser regression flows and the production Worker dry-run build pass.
- Real local Worker with persisted SQLite storage: wrote a v1 secret, switched active
  key to v2, quoted and re-encrypted through the scoped CLI at exactly 100 µ$ plus
  ordinary reads, retired v1 from the keyring, and successfully executed a queued JS
  action using the rotated secret with redacted logs and no remaining hold.
- No production keys were provisioned, rotated or removed. Live launch acceptance
  and legal entity/contact/jurisdiction inputs remain owner steps under L9–L14.
