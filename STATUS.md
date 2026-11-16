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
| D5 | API reads billed (21 µ$ after rounded-floor audit), web UI reads free and rate-limited | owner | ✅ | Owner approved billed reads and upward floor corrections 2026-11-15; ledger write costs and rounded cost floors require a 21 µ$ base plus a 2 µ$/job aggregate-history allowance rather than the 1 µ$ planning estimate; keeps "no account costs more than it paid" true for scripted polling. |
| D6 | Starting prices in `docs/business/pricing.md` (25 µ$/run, 100 µ$/change, prose 1.5× + 500 µ$) | owner | ✅ | Owner approved 2026-11-15: accept, adjusting upward to pass floors; recalibrate after a month of production cost data (S3). |
| D7 | Shared source for operator identity across hashbin, cronly and future apps | code/owner | 🟨 | Owner requested shared entity/jurisdiction with per-app contacts and approved placeholders on 2026-11-16. Offline snapshot, escaped legal-page rendering, drift tests and launch completeness check implemented. Shared repo selection, confirmed facts and hashbin adoption remain deferred. [Adoption plan](todo/shared_operator_profile.md); [snapshot procedure](docs/operator/README.md). |

## Launch blockers

| ID | Item | Owner | Status | Notes / reference |
|----|------|-------|--------|-------------------|
| L1 | Scaffold: wrangler (prod + local), Vitest, ESLint, `dev:local`, CI, `/health` | code | ✅ | Wrangler prod/local, pinned dependencies, lint, CI, health and gated LocalDev/deposits verified. Master plan §10.1. Copy hashbin's local mode and CI shape. |
| L2 | Accounts and auth: Clerk sessions, Clerk webhook → AccountDO, API keys with scopes and daily spend caps, `API_ROUTES` access test | code | ✅ | Clerk/LocalDev auth, signed hashed scoped keys, revocation, daily caps and Clerk webhook; access coverage tests. §4.1. Port hashbin `src/auth/`. |
| L3 | Money: µ$ ledger, reserve/settle/expire holds, Stripe deposits, history, `cost-policy.js`, `pricing.js`, price-floor tests, `/api/quote` | code | 🟨 | Transactional ledger/holds, signed Stripe webhook, itemized Checkout and quotes tested; S4 recovery/refused-retry audit and rounded floors set HTTP price to 87 µ$ and reads to 21 µ$ plus 2 µ$/job. Existing holds keep their maximum. Real deposit remains L14. §6, `docs/business/pricing.md`. Needs D4, D6. |
| L4 | Definitions: variables, secrets (AES-GCM, write-only), HTTP actions, templates, change billing, audit log, dry run, idempotency | code | ✅ | Atomic billed CRUD, reference checks, AES-GCM write-only secrets, dry runs, audit and idempotency tested. §2, §3.3, §4.2. |
| L5 | Scheduler: jobs, croner, JobDO alarms, run queue, HTTP executor, redaction, settlement, pause on refusal, policies, budget windows | code | ✅ | Real local Worker/Queue HTTP path verified; retries, missed/overlap, budgets, duplicate delivery, held snapshots, refusal pause and recovery tested. Initial pending runs and recovery alarms commit atomically. Replayed starts recover original deadlines, trigger/input and key identity from the reservation after a lost response/pending/alarm write; expired reservations never enqueue. Observed results stage before settlement; Queue redelivery/alarms recover completion and private retry dispatch after restart without repeating external work or charges. Retry input/key caps survive settlement; budget refusals clear the retry. §3, §3.1, §2.3. |
| L6 | Runs, costs, upcoming, projection APIs; retention pruning | code | ✅ | Retained/deleted-job history, NDJSON, permanent UTC cost aggregates, ledger cursors, bounded upcoming, fast cron/DST projections and byte/retention bounds tested. §4.3, §6, §7. |
| L7 | Triggers: run now, trigger tokens, `/hook/*`, per-token rate limits, CORS, `{{input.*}}` | code | ✅ | Manual runs, signed job-only tokens, revocation, token limits, input validation and hook-only CORS tested. §4.1. |
| L8 | Web UI with balance + runway header on every signed-in page; Playwright tests | code | ✅ | All workspace pages, runtime status/runway, direct action tests, quote dialogs and logo implemented; mobile and browser save/run/escaping/cron flows pass. §5. |
| L9 | Prose: free cron explain; Claude to-cron, ask, change proposals + apply; holds and billing; to-cron eval | code/ops | 🟨 | Structured client, held read-only conversations, usage billing, separate stale-checked proposals and 100-case two-model eval implemented. Live eval requires owner Anthropic access. §3.5. Needs D3 and an Anthropic API key (ops). |
| L10 | JavaScript actions: sandbox, outbound gateway, CPU/subrequest limits and pricing, editor | code/ops | 🟨 | Content-addressed Worker Loader, blocked native networking, counted gateway, daily activation settlement and editor implemented; real local JS succeeds. Live CPU-limit acceptance required. §2.2, §3.4. Needs D2. |
| L11 | Agent surface: OpenAPI + drift test, `llms.txt`, agent docs, MCP server, `/api/config`, browser snippet | code | ✅ | Atomic config with conflict checks, OpenAPI drift test, scoped MCP protocol tests, llms.txt/agent docs and immutable SHA-384 SRI trigger SDK verified. §4.4, §4.5. |
| L12 | Abuse and cost safety: limits, destination rules, rate-limit rules, daily cost reconciliation and brake, invite-only sign-up | code/ops | 🟨 | Account/job/destination caps, native ingress limiter, destination checks, conservative daily analytics reconciliation and stale-report brake implemented. Live schema/WAF/billing alerts and Clerk Restricted mode remain owner steps. §8. |
| L13 | Terms of Service and Privacy Policy (acceptable use, refunds, suspension) | legal | 🟨 | Service-specific drafts prepared; owner directed shared entity/jurisdiction with hashbin and separate contacts, approving placeholders for now. Offline profile renders escaped facts into both drafts with drift checks; approved-launch deploys require complete pinned facts. Actual facts, cronly contacts and policy approval remain. Checkout is gated by launch approval. |
| L14 | Production: cronly.org DNS and custom domain, live Clerk and Stripe, secrets, end-to-end test with a real deposit, `verify:production` | ops | 🟨 | Custom-domain config, guarded CI deploy, secret upload, production verifier and live sandbox acceptance script prepared; provision credentials/DNS and perform real deposit/live acceptance per docs/ops/launch.md. §10.13. |

## Soon after launch

| ID | Item | Owner | Status | Notes / reference |
|----|------|-------|--------|-------------------|
| S1 | Secret master-key rotation (versioned keys, re-encrypt) | code | ✅ | Atomic versioned keyring, legacy reads, held per-secret re-encryption, edit/delete conflict protection, audit, scoped CLI and CI wiring verified. Persisted local Worker migrated v1 → v2 and executed a redacted JS run with v1 retired. [Operator procedure](docs/ops/secret-rotation.md). §3.3. |
| S2 | Charge measured JS CPU instead of the configured limit | code | ⬜ | §3.4; needs per-invocation CPU data. |
| S3 | Recalibrate prices from a month of real Cloudflare and Anthropic bills | ops/code | ⬜ | `docs/business/pricing.md`. |
| S4 | Lower per-run row writes (merge hold + ledger, batch next-fire updates) and pass the saving into the price | code | 🚧 | Shared transactional budgets, active money summaries and ledger buffering reduce ordinary writes; unchanged alarms/runtime indexes and completion settings skip writes. Transactional reads/changes skip transient holds. Ledger pages retain legacy cursors and permanent receipts. Small durable reservations share the balance row; large/legacy snapshots stay standalone. Finalization reuses the durable staged log. Cooldowns now share the bounded recent-job index, saving a write when switching jobs; evicted cooldowns remain standalone. The 144-path audit includes ledger archival, compact/rollover/large-period summaries and unfunded-retry pauses: conservative 37 writes, 30 DO requests/five Worker invocations at 87 µ$/run after rounded floors. Further worst-case reductions remain. [Cost audit](docs/business/pricing.md). |

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

## S4 partial acceptance — 2026-11-16

- Lint and 62 unit/integration tests pass, including lazy legacy-budget migration,
  pending holds, UTC resets, duplicate settlement and transactional rollback.
- Four full-path cost checks exercise scheduled/manual/action-test/webhook HTTP runs
  with all five redirects, 1,000 cold history entries, pruning and safety lookups.
  Policy allowances are 34 row writes, 24 DO requests and 3,000 row reads per run;
  webhook ingress has an additional allowance. Every price still passes its floor.
- Unchanged alarms/runtime/recent-job indexes avoid writes. Outbox recovery and expiry
  outcome preservation during schedule advancement have regression coverage.
- All three browser flows and the production Worker dry-run build pass. Persisted job
  quotes use the new 80 µ$ base; old holds retain their original maximum.
- Hold/ledger compaction and further safe price reductions remain S4 work. No production
  deployment or live acceptance is claimed; L9–L14 owner steps remain unchanged.

## S4 transactional billing acceptance — 2026-11-16

- Reads and changes completed inside one AccountDO transaction use the same funds,
  outstanding-hold and budget checks without writing/deleting a transient hold or
  scheduling its expiry alarm. External work retains durable reservations.
- Lint and 65 tests pass, including duplicate protection, pending holds and key caps,
  insufficient balance, transaction rollback and existing reservation compatibility.
- Permanent receipts, sortable ledger entries and published prices are preserved.

## S4 compact run acceptance — 2026-11-16

- Pending runs share one durable history/outbox row instead of duplicating a full run
  row. Final log bodies and summaries commit atomically; cache updates follow commit.
- Cold restart, legacy outbox recovery, duplicate starts, expiry and failed final-index
  writes are covered. Retried settlement charges once and preserves the outcome.
- Full-path schedule/manual/action-test/webhook cost checks pass at 33 row writes,
  24 DO requests and 3,000 row reads (webhook ingress has its separate allowance).
  The base run price is reduced from 80 to 78 µ$; all price floors pass. Existing
  holds preserve their original maximum, including holds above the new price.
- Lint, 68 unit/integration tests, all three browser flows and the production dry-run
  build pass. Real local Worker/Queue acceptance verifies HTTP, JavaScript, secret
  redaction, native network denial, counted gateway access and released holds.
- Further durable hold/ledger compaction remains S4 work. L9–L14 live acceptance and
  owner/legal inputs are unchanged; nothing was deployed to production.

## S4 completion settings acceptance — 2026-11-16

- Repeated completion outcomes skip the redundant job-settings write. Changed
  outcomes commit in the same transaction as the completed log and compact index.
- Storage-failure rollback, cold restart, single-charge recovery and replay after a
  failed cross-object outcome publication are tested. Replaying an older completion
  publishes the current settings rather than overwriting a newer outcome.
- Lint, 70 unit/integration tests, all three browser flows and the production dry-run
  build pass. The worst-case write bound and 78 µ$ price
  are unchanged because a changed outcome still needs its settings write.

## D7/L13 placeholder profile acceptance — 2026-11-16

- Owner approved placeholders while the shared profile repository and actual facts
  remain unavailable. Public facts and source provenance are explicit nulls in an
  offline snapshot, rendered as visible placeholders in Terms and Privacy.
- Escaped generation and offline drift checks preserve draft notices, policy text,
  legal-review notes and effective-date placeholders. Contacts remain app-specific.
- Approved-launch deployments require complete cronly facts and pinned provenance;
  prelaunch deployments and local development can retain the placeholder snapshot.
- Shared-source selection/sync, hashbin adoption, confirmed public facts and policy
  approval remain outstanding. No hashbin files or live services were changed.
- Lint, 73 unit/integration tests, all three browser flows and the production dry-run
  build pass, including escaping, schema/provenance checks and incomplete-launch refusal.

## L5/S4 Queue completion recovery acceptance — 2026-11-16

- A removed/expired hold now takes the Queue consumer through a bounded JobDO
  recovery check before acknowledgment. Committed outcomes republish current runtime
  after restart; pending or unknown runs are left for their existing expiry alarm.
- The end-to-end test injects two publication outages and a cold restart. Delivery
  stays unacknowledged until recovery succeeds; outbound execution and billing occur
  once. Recovery skips retained-history scans and leaves cleanup to the existing alarm.
  A configured action retry is still reserved and dispatched if publication fails.
- Four full-path cost checks now include all three configured Queue redeliveries.
  Bounds are 33 writes, 30 DO requests, five Worker invocations and 3,000 row reads,
  plus webhook ingress. Six Queue operations cover send, four reads and delete.
- Consumer invocation fees were missing from the old bound. The HTTP base is now
  80 µ$ to preserve the floor; JS includes the same base. Existing holds retain
  their original maximum. Lint and all 76 unit/integration tests pass.
- All three browser flows, the production dry-run build and real local SQLite/Queue
  acceptance pass: HTTP, JS, redaction, native networking denial, counted gateway and
  released holds. No production deployment or live acceptance is claimed.

## L5/S4 staged completion and retry recovery acceptance — 2026-11-16

- Observed outcomes persist before settlement removes the execution snapshot.
  Failed settlement/final-log writes recover after restart through Queue redelivery
  or the pending alarm, preserving the known outcome and charging/executing once.
- Failed-run retries retain private input, key identity and a deterministic child
  id until dispatch succeeds or a budget/policy refusal ends the attempt. Dispatch
  and cleanup outages survive restart; retries retain job/key caps and do not leak
  private context through full or compact run APIs.
- All 104 unit/integration tests and lint pass. The 24 full-path cost checks inject
  settlement, completion, retry dispatch and retry cleanup failures in addition to
  redirects, cold history, pruning and three Queue redeliveries. Retry budget
  refusals expose a previously uncounted pause/log/cleanup path. The
  38-write/30-DO-request/five-invocation bound requires an 89 µ$ base after rounding
  costs up. Rounded floors also raise the read base to 21 µ$ plus 2 µ$/job; every
  job count from zero to 100 is checked. Existing holds keep their original maximum.
- All three browser flows and the production Worker dry-run build pass. Real local
  SQLite/Queue acceptance verifies HTTP, JavaScript, redaction, network denial and
  gateway access, plus a failed JS run and successful separately funded retry with
  preserved input, one daily activation charge and no outstanding holds.
- S4 hold/ledger compaction and L9–L14 owner/live acceptance remain outstanding.
  No production deployment or credential changes were performed.

## S4 compact money summaries acceptance — 2026-11-16

- Active UTC day/month summaries share the balance row. Ordinary settlements and
  immediate charges use three writes instead of five, preserving durable holds,
  permanent receipts, transaction history and job/key budget enforcement.
- Legacy scalar balances and summary rows migrate lazily. UTC rollovers archive
  old periods; late settlements update their reserved periods. Oversized summaries
  remain standalone, keeping compact state below the storage value limit without
  exceeding the previous two-summary write allowance.
- Lint and all 159 unit/integration tests pass, including migration, budget caps,
  deposit preservation, rollback after archive/receipt failures, cold reporting,
  seven-day activity and all 72 full-path recovery cost checks (compact, UTC rollover
  and oversized periods across schedule/manual/action-test/webhook recovery).
- All three browser flows, production dry-run bundle and real local SQLite/Queue
  acceptance pass (HTTP, JS, redaction, network denial, gateway and funded retry).
  The local acceptance script now checks ledger/cost totals and each retry's
  grouped cost, plus balance and spend preservation across duplicate deposits.
- The 38-write worst-case bound and 89 µ$ price stay unchanged: rollover, late or
  oversized periods still need standalone writes. Durable hold/ledger compaction
  and L9–L14 owner/live acceptance remain outstanding.

## L5 reservation replay acceptance — 2026-11-16

- A reservation response lost after commit, or a failed initial JobDO pending write,
  can be replayed with the same run id after restart. Orchestration restores the
  original creation time, expiry, trigger, scheduled time, attempt and key identity
  from the prepaid snapshot rather than trusting new replay arguments.
- Retry input is recovered privately from that same snapshot. Tests verify funded
  retries use the original input and capped keys still refuse further spending.
  Expired reservations settle once without enqueueing an unexecutable run.
- Lint and all 165 unit/integration tests pass, including the existing 72 full-path
  cost checks. No extra ordinary-path row writes or requests were introduced;
  published prices and existing holds are unchanged. Live acceptance remains L9–L14.

## L5/S4 atomic pending wakeup acceptance — 2026-11-16

- Initial pending-run metadata and its recovery alarm now commit in one JobDO
  transaction before sending to the Queue. An alarm failure rolls back the pending
  row and leaves the original reservation available for replay after restart.
  The in-memory history cache updates only after the transaction commits.
- This replaces the separate initial rearming step, preserving the existing
  row-write allowance while avoiding an extra history scan before enqueue.
- Lint and all 168 unit/integration tests pass, including nine initial-reservation
  outage tests and all 72 full-path cost checks. All three browser flows, production
  dry-run bundle and real local SQLite/Queue acceptance pass (HTTP, JavaScript,
  redaction, native networking denial, gateway, funded retry and ledger/cost totals).
- S4 durable hold/ledger compaction and L9–L14 owner/live acceptance remain open.
  Nothing was deployed to production; published prices are unchanged.

## S4 buffered ledger acceptance — 2026-11-16

- Recent ledger entries share the transactional balance write. A full buffer archives
  into one permanent page, bounded to 100 entries or 16,000 UTF-8 bytes; both active
  money summaries and history fit within the compact storage value limit.
- Ordinary settlement/immediate billing uses two puts instead of three. Permanent
  receipt tombstones remain separate, so duplicate checks and active-hold scans stay
  bounded. Legacy standalone history and cursors remain readable in both directions.
- Lint and all 181 unit/integration tests pass, covering mixed-history pagination,
  byte bounds, simultaneous entries, backwards clocks, cold restart, duplicate charges
  and transactional rollback at archive/balance/receipt failures. All 72 full-path
  cost checks now force ledger archival as well as their existing recovery states.
- All three browser flows, the production dry-run bundle and real local SQLite/Queue
  acceptance pass: HTTP, JavaScript, redaction, blocked native networking, counted
  gateway and funded retry. Fifty small deposits with long valid IDs force the byte
  boundary; history, balances, cost totals and duplicate protection survive archival.
- Archival retains the previous worst-case allowance, so the 89 µ$ price is unchanged.
  Further durable hold compaction and L9–L14 live acceptance/owner steps remain open;
  nothing was deployed to production.

## S4 compact durable reservations acceptance — 2026-11-16

- Small prepaid snapshots share the balance row, removing one row deletion per
  completed run without adding a reservation/claim write. Compact holds use at most
  8,000 UTF-8 bytes, including headroom for claim and gateway counters; larger or
  legacy snapshots retain their standalone rows. Permanent receipts stay separate.
- Funds, job/key budgets, concurrency, overlap, routing, expiry, rotation and private
  retry recovery read both formats. Deposits preserve active reservations. Settlement
  removes compact snapshots atomically with balance, summaries, history and receipt.
- Lint and all 275 unit/integration tests pass, including mixed-format budgets,
  concurrent reservations, UTF-8/storage limits, cold claim/gateway recovery and
  rollback of reservation/alarm/receipt/activation/rate writes. The 144 full-path
  recovery cost checks enforce one fewer write per compact run and retain the
  existing worst-case allowance for standalone snapshots.
- All three browser flows and the production Worker dry-run build pass. Real local
  SQLite/Queue acceptance covers small compact snapshots and a large UTF-8 JS
  snapshot on the standalone path: HTTP, JavaScript, redaction, blocked native
  networking, counted gateway, funded retries, ledger/cost totals, archived history
  and duplicate deposits pass with no outstanding holds. The verifier keeps this
  mixed-format case for future regressions.
- The worst-case 38-write allowance and 89 µ$ price are unchanged. Further S4
  worst-case reductions and L9–L14 owner/live acceptance remain open. Nothing was
  deployed to production and no live credentials were changed.

## S4 immutable staged logs — 2026-11-16

- Finalization commits billing metadata, the compact history index and changed job
  settings without rewriting the already-durable observed result. Full run reads
  reconstruct that body with authoritative charged amounts and gateway counts.
- Legacy completed bodies and pending outboxes remain readable. Staged outcomes,
  private retry context and key identity stay out of public run responses.
- Lint and all 279 unit/integration tests pass, including pre-settlement log failure,
  completion/settings rollback, cold restart, duplicate delivery, JS activation
  discounts and gateway counts, plus the existing 144 full-path cost checks.
- Price recalibration and local Worker/Queue acceptance for this reduction follow;
  the conservative 38-write allowance and 89 µ$ price are unchanged at this point.
  L9–L14 live acceptance and owner/legal work remain open.

## S4 staged-log price reduction acceptance — 2026-11-16

- All 144 full-path cost checks pass with a 37-write standalone / 36-write compact
  reservation allowance, including full ledger archival, UTC rollovers, oversized
  summaries, redirects, Queue redelivery, recovery and refused-retry pauses.
- The rounded worst-case HTTP cost is 53 µ$. The base HTTP/JS run price falls from
  89 to 87 µ$, preserving the approved revenue haircut and 1.5× cost floor. Existing
  reservations keep their original maximum; current job quotes use the new price.
- Lint, all 279 unit/integration tests, all three browser flows and the production
  Worker dry-run build pass. Real local SQLite/Queue acceptance verifies HTTP,
  small/large JS snapshots, secret redaction, native network denial, counted gateway,
  funded retries, ledger/cost agreement, archival and duplicate deposits. The verifier
  now also checks summary/detail billing agreement and private-field filtering for
  every completed run.
- Further S4 reductions remain; L9–L14 live acceptance and owner/legal work are still
  outstanding. Nothing was deployed to production and no live credentials changed.

## S4 shared run activity — 2026-11-16

- Per-job cooldowns and the recent-job index now share one bounded row, saving a
  write when switching jobs. Original name arrays and standalone cooldowns remain
  readable. Evicting a name preserves its authoritative cooldown in a standalone
  row, including deleted/test jobs and retry overrides after backwards clocks.
- Lint and all 287 unit/integration tests pass, including eight new migration,
  restart, eviction, rollback, billing and cooldown tests plus all 144 full-path
  cost checks. Dry runs, duplicate reservations and refusals do not alter activity.
- All three browser flows and the production Worker dry-run build pass. Real local
  SQLite/Queue acceptance verifies cross-job cooldowns and free duplicate runs,
  HTTP, small/large JS snapshots, redaction, native network denial, counted gateway,
  funded retries, ledger/cost agreement, archival and duplicate deposits. The HTTP
  fixture allows overlap so its repeated-run assertion reaches the cooldown guard.
- The conservative 37-write allowance and 87 µ$ price stay unchanged because
  eviction can still require a standalone write. S4 and L9–L14 owner/live acceptance
  remain open; nothing was deployed to production.
