# cronly Project Status

**This file is the single source of truth for project status.** If another document
disagrees with it, this file wins and the other document is stale.

- **Last audited:** 2026-11-16 (code implemented; live acceptance pending)
- **Production:** app Worker not deployed. `cronly.org` is an active Cloudflare zone; `cronly-runs` queue provisioned 2026-11-16.
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
| D2 | JavaScript sandbox: Workers for Platforms or Dynamic Worker Loader | code/ops | ✅ | Worker Loader selected: native CPU/subrequest limits verified on Cloudflare 2026-11-16 with the production executor/wrapper; daily activation pricing included. Full service acceptance remains L10. Master plan §3.4. |
| D3 | Prose model: `claude-opus-5-5` (≈1.4¢ per translation) or `claude-haiku-5-5` (≈0.1¢) | owner | 🟨 | Owner approved Opus default 2026-11-15; final model selection follows live eval; run the L9 eval on both and pick per endpoint. One constant in `src/utils/llm-policy.js`. |
| D4 | Minimum deposit | owner | ✅ | Owner approved 2026-11-15: $5, card payment cost itemized on top (hashbin L20 wording). |
| D5 | API reads billed (21 µ$ after rounded-floor audit), web UI reads free and rate-limited | owner | ✅ | Owner approved billed reads and upward floor corrections 2026-11-15; ledger write costs and rounded cost floors require a 21 µ$ base plus a 2 µ$/job aggregate-history allowance rather than the 1 µ$ planning estimate; keeps "no account costs more than it paid" true for scripted polling. |
| D6 | Starting prices in `docs/business/pricing.md` (25 µ$/run, 100 µ$/change, prose 1.5× + 500 µ$) | owner | ✅ | Owner approved 2026-11-15: accept, adjusting upward to pass floors; recalibrate after a month of production cost data (S3). |
| D7 | Shared source for operator identity across hashbin, cronly and future apps | code/owner | 🟨 | Owner requested shared entity/jurisdiction with per-app contacts and approved placeholders on 2026-11-16. Offline snapshot, escaped legal-page rendering, drift tests and launch completeness check implemented. Shared repo selection, confirmed facts and hashbin adoption remain deferred. [Adoption plan](todo/shared_operator_profile.md); [snapshot procedure](docs/operator/README.md). |

## Launch blockers

| ID | Item | Owner | Status | Notes / reference |
|----|------|-------|--------|-------------------|
| L1 | Scaffold: wrangler (prod + local), Vitest, ESLint, `dev:local`, CI, `/health` | code | ✅ | Wrangler prod/local, pinned dependencies, lint, CI, health and gated LocalDev/deposits verified. Master plan §10.1. Copy hashbin's local mode and CI shape. |
| L2 | Accounts and auth: Clerk sessions, Clerk webhook → AccountDO, API keys with scopes and daily spend caps, `API_ROUTES` access test | code | ✅ | Clerk/LocalDev auth, signed hashed scoped keys, revocation, daily caps and Clerk webhook; access coverage tests. Key creation/revocation replay original billed responses after lost replies and restart; creation replay preserves revocation, revocation keys bind their target, and dry runs validate current requests without returning credentials. §4.1. Port hashbin `src/auth/`. |
| L3 | Money: µ$ ledger, reserve/settle/expire holds, Stripe deposits, history, `cost-policy.js`, `pricing.js`, price-floor tests, `/api/quote` | code | 🟨 | Transactional ledger/holds, signed Stripe webhook, itemized Checkout and quotes tested; S4 recovery/refused-retry audit and rounded floors set HTTP price to 85 µ$ and reads to 21 µ$ plus 2 µ$/job. Valid `constructor` names retain numeric summaries and enforce current/legacy budgets without inherited-property lookups. Existing holds keep their maximum. Signed payment fulfillment acknowledges credited payments during wake outages; durable delivery resumes balance pauses. Real deposit remains L14. §6, `docs/business/pricing.md`. Needs D4, D6. |
| L4 | Definitions: variables, secrets (AES-GCM, write-only), HTTP actions, templates, change billing, audit log, dry run, idempotency | code | ✅ | Pause/resume replay the original billed response across edits/deletion and resolve current settings transactionally. Atomic billed CRUD, reference checks, AES-GCM write-only secrets, dry runs, audit and idempotency tested. Action changes no longer rewrite/resynchronize all jobs: quotes and new reservations resolve the current action; held snapshots, pauses and schedules remain durable. Non-job edits avoid account wakeups; job edits retain earlier hold-expiry alarms. Log redaction also covers JSON-escaped secret values and unpaired surrogates. Unsupported inherited template namespaces return 400 without billing, including dry runs. §2, §3.3, §4.2. |
| L5 | Scheduler: jobs, croner, JobDO alarms, run queue, HTTP executor, redaction, settlement, pause on refusal, policies, budget windows | code | ✅ | Real local Worker/Queue HTTP path verified; retries, missed/overlap, budgets, duplicate delivery, held snapshots, refusal pause and recovery tested. Redirects preserve HEAD, remove discarded-body headers and cancel refused response bodies; exhausted subrequest allowances do not consume destination-rate attempts. Initial pending runs and recovery alarms commit atomically. Replayed starts recover original deadlines, trigger/input and key identity from the reservation after a lost response/pending/alarm write; expired reservations never enqueue. Observed results stage before settlement; Queue redelivery/alarms recover completion and private retry dispatch after restart without repeating external work or charges. Retry input/key caps survive settlement; budget, revoked/expired-key and invalid-input refusals clear the retry rather than recurring unpaid. Input-dependent HTTP schedules pause once with `missing_input`; pause publication failures retain the due schedule for alarm recovery. Configuration sync preserves last outcomes and skips unchanged settings; balance wakes publish resumed runtime and repair failed publication. Reconciliation preserves deletion of prototype-named jobs. Scheduled next-fire publication retries before durable advancement, including missed-run skips without a pending run. Account synchronization retries preserve earlier hold-expiry wakeups, including reservations arriving during synchronization. Reason-specific job wakes retain unrelated pauses and recover publication, settings and alarm failures after restart. §3, §3.1, §2.3. |
| L6 | Runs, costs, upcoming, projection APIs; retention pruning | code | ✅ | Retained/deleted-job history, NDJSON, permanent UTC cost aggregates, ledger cursors, bounded upcoming, fast cron/DST projections and byte/retention bounds tested. Activity forecasts for jobs without cron include the webhook surcharge, budget caps and conservative runway; Ask shares the same estimate. Stable timestamp/ID run cursors prevent skipped retries at page boundaries, survive retention/restarts and support NDJSON; legacy timestamp paging remains supported. Pruning preserves pending runs/retry outboxes until recovery finishes and deletes completed bodies/indexes atomically. Constructor-named jobs/actions have numeric grouped costs, seven-day activity and forecasts across UTC rollovers/restarts. §4.3, §6, §7. |
| L7 | Triggers: run now, trigger tokens, `/hook/*`, per-token rate limits, CORS, `{{input.*}}` | code | ✅ | Manual runs, signed job-only tokens, revocation, token limits, input validation and hook-only CORS tested. Webhook retries reuse their rate attempt through lost reservation replies, pending/enqueue writes and restarts; new attempts remain limited and revoked tokens cannot replay. Trigger billing binds the original rate before replying across objects, so lost replies/job writes recover once, including at an exhausted key cap. Creation/revocation replay original charges; revocation preserves rate and creation replay cannot reactivate a token. Dry runs quote current requests and unchanged replays skip job writes. Run/test/trigger/quote guards reject absent prototype-named definitions before job dispatch. §4.1. |
| L8 | Web UI with balance + runway header on every signed-in page; Playwright tests | code | ✅ | All workspace pages, runtime status/runway, direct action tests, quote dialogs and logo implemented; mobile and browser save/run/escaping/cron flows pass. Run-history paging uses stable cursors and preserves visible job/outcome/date filters. §5. |
| L9 | Prose: free cron explain; Claude to-cron, ask, change proposals + apply; holds and billing; to-cron eval | code/ops | 🟨 | Structured client, held read-only conversations, usage billing, separate stale-checked proposals and 100-case two-model eval implemented. Applied proposals retain compact permanent receipts through cleanup/restarts; dry-run application returns a free no-op and skips synchronization. Finalization is immutable and separate from provider failures: lost acknowledgements recover the saved result, status and authoritative settled charge without repeating Claude. Account snapshots share the reservation transaction, so failed reads leave no prose hold; cron translation avoids account definitions. Ask sorts recent runs across jobs, retains its history for citations, and shares permanent webhook activity with the forecast API; repeated tools reuse their reads. Live eval requires owner Anthropic access. §3.5. Needs D3 and an Anthropic API key (ops). |
| L10 | JavaScript actions: sandbox, outbound gateway, CPU/subrequest limits and pricing, editor | code/ops | 🟨 | Content-addressed Worker Loader, blocked native networking, counted gateway, daily activation settlement and editor implemented; real local JS succeeds. Activation follows the claim's UTC day and discounts only settled payments, including concurrent claims and operator/analytics safety refunds; reserved budget periods stay unchanged. Real SQLite/Queue verifies one activation across three jobs sharing a version. Shared redaction runs inside the sandbox before console/return truncation; its code participates in version/activation hashing. Eight live isolated runtime checks passed 2026-11-16, including explicit CPU/subrequest rejection, native fetch/connect denial and concurrent redacted logs; temporary Worker removed. [Evidence](docs/ops/evidence/sandbox-runtime-2026-11-16.json). Full deployed billing/Queue/gateway acceptance remains; JS_LIVE_ACCEPTED stays false. §2.2, §3.4. |
| L11 | Agent surface: OpenAPI + drift test, `llms.txt`, agent docs, MCP server, `/api/config`, browser snippet | code | ✅ | Transactional config imports replay the original receipt after lost responses, later edits and no-op imports; dry runs quote current state without consuming receipts. Exported GET/HEAD actions round-trip with empty bodies; omitted import collections remain unchanged. Atomic config with conflict checks, OpenAPI drift test, scoped MCP protocol tests, llms.txt/agent docs and immutable SHA-384 SRI trigger SDK verified. §4.4, §4.5. |
| L12 | Abuse and cost safety: limits, destination rules, rate-limit rules, daily cost reconciliation and brake, invite-only sign-up | code/ops | 🟨 | Account/job/destination caps, native ingress limiter, destination checks, conservative daily analytics reconciliation and stale-report brake implemented. HTTP and sandbox destination limits share canonical DNS-host buckets, including trailing-dot aliases and cold restarts. Registry reconciliation and recovery scan bounded pages beyond 1,000 accounts; versioned durable scan cursors/outboxes survive partial enqueue/ack failures and cold restarts. Analytics pauses publish runtime before committing settings, retaining due schedules for recovery after publication/storage/alarm outages; repeated refusals skip settings writes. Recovery wakes only cost-brake pauses, preserving unrelated budget/balance pauses. Queued HTTP/JS runs skipped by the operator hard stop refund their holds without recording a paid activation, including settlement/completion recovery. Live schema/WAF/billing alerts and Clerk Restricted mode remain owner steps. §8. |
| L13 | Terms of Service and Privacy Policy (acceptable use, refunds, suspension) | legal | 🟨 | Service-specific drafts prepared; owner directed shared entity/jurisdiction with hashbin and separate contacts, approving placeholders for now. Offline profile renders escaped facts into both drafts with drift checks; approved-launch deploys require complete pinned facts. Actual facts, cronly contacts and policy approval remain. Checkout is gated by launch approval. |
| L14 | Production: cronly.org DNS and custom domain, live Clerk and Stripe, secrets, end-to-end test with a real deposit, `verify:production` | ops | 🟨 | Cloudflare login/account access and active cronly.org zone verified; cronly-runs queue provisioned 2026-11-16. GitHub production environment created with verified CLOUDFLARE_ACCOUNT_ID; automatic deploy, launch approval and public JS flags explicitly false. Isolated live sandbox runtime suite passed and its Worker was deleted. App Worker and remaining deployment/app credentials absent. Provision credentials, custom-domain Worker and real deposit/service acceptance per docs/ops/launch.md. §10.13. |

## Soon after launch

| ID | Item | Owner | Status | Notes / reference |
|----|------|-------|--------|-------------------|
| S1 | Secret master-key rotation (versioned keys, re-encrypt) | code | ✅ | Atomic versioned keyring, legacy reads, held per-secret re-encryption, edit/delete conflict protection, audit, scoped CLI and CI wiring verified. Interrupted rotations resume their original hold through lost replies, failed receipt writes and restarts; concurrent retries settle once. Recovery conflicts refund without overwriting edits; permanent no-op receipts preserve their original result across later key activations. CLI retries transient write failures with the same identity, bounds attempts and omits private transport details. Persisted local Worker migrated v1 → v2 and executed a redacted JS run with v1 retired. [Operator procedure](docs/ops/secret-rotation.md). §3.3. |
| S2 | Charge measured JS CPU instead of the configured limit | code | ⬜ | §3.4; needs per-invocation CPU data. |
| S3 | Recalibrate prices from a month of real Cloudflare and Anthropic bills | ops/code | ⬜ | `docs/business/pricing.md`. |
| S4 | Lower per-run row writes (merge hold + ledger, batch next-fire updates) and pass the saving into the price | code | 🚧 | Shared transactional budgets, active money summaries and ledger buffering reduce ordinary writes; unchanged alarms/runtime indexes and completion settings skip writes. Transactional reads/changes skip transient holds. Ledger pages retain legacy cursors and permanent receipts. Small durable reservations share the balance row; large/legacy snapshots stay standalone. Finalization reuses the durable staged log. Cooldowns/recent-job activity now share the reservation balance write, saving another ordinary compact-run write; evicted cooldowns remain standalone and larger legacy hold arrays migrate after draining. Repeated balance/budget refusals skip writes after one atomic pause/log/reset-wakeup transition; unchanged configuration replay skips settings writes. The 456-path audit includes activity eviction, ledger archival, compact/rollover/large-period summaries, unfunded-retry pauses, runtime-write failures and lost settlement responses: conservative 37 writes, 27 DO requests/five Worker invocations at 85 µ$/run after rounded floors. Scheduled dispatch rearms once after schedule advancement, retaining its atomic pending wakeup; advancement publication survives failures and refusal pauses skip duplicate writes. Completion runtime publication now shares settlement’s account transaction; new completed deliveries skip publication calls while legacy completions retain recovery. Deposits and cost-brake recovery use one versioned wake batch per cause (100 healthy jobs: five deposit/account writes including acknowledgement), preserving unrelated pauses and earlier holds. Terminal credential/input refusals clear retry outboxes, and input-dependent schedules pause once instead of recurring unpaid. Repeated action tests reuse their permanent history index, saving one account write after the first reservation while retaining recency and deleted-action logs. Test setup/start share one JobDO request, saving a request per action test with the same recovery steps. Completed Queue redelivery now uses one compact index read without loading full logs or settings; staged outcomes, private retries and legacy publication still recover. Further worst-case reductions remain. [Cost audit](docs/business/pricing.md). |

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

## L4/L5 serialized-secret redaction — 2026-11-16

- Redaction recognizes JSON-escaped secrets in HTTP request/response fields and JS
  object output, alongside raw, URL and base64 forms. Unpaired UTF-16 surrogates
  no longer abort redaction. Outbound requests retain their original credentials.
- Lint and all 290 unit/integration tests pass, including serialized quotes,
  backslashes, control characters, Unicode and HTTP log capture. JS truncation
  before redaction is a separate follow-up; prices and live acceptance are unchanged.

## L5/L10 redaction before JS truncation — 2026-11-16

- A shared pure redactor now runs inside the sandbox before console and return-value
  cutoffs, including serialized object values. Long secrets and secrets crossing
  the remaining console budget cannot leave their prefixes in retained excerpts.
  Each invocation keeps its own secret set, including failure logs.
- The sandbox receives the redactor as an isolated ES module. Its source participates
  in the content hash used by both reservations/activation billing and Worker Loader.
  No encryption or master-key dependencies are supplied to the sandbox.
- Lint, all 296 unit/integration tests, all three browser flows and the production
  dry-run build pass. Real local SQLite/Queue acceptance verifies escaped object
  output, console/return boundary redaction, native network denial, counted gateway,
  compact/standalone reservations, retry billing, ledger archival and cost totals.
- Prices and existing reservation maxima are unchanged. L9–L14 live/owner/legal
  acceptance and S4 reductions remain open; nothing was deployed to production.

## L12 paginated cost reconciliation and recovery — 2026-11-16

- Registry reads and brake-recovery staging use 100-account pages, removing the
  old reconciliation refusal at 1,000 accounts. Every page contributes its revenue,
  cost estimate and maintenance before a healthy report can be published.
- A healthy report commits its versioned recovery scan atomically. Each staged
  outbox page commits with the scan cursor; cold restarts retain unfinished work.
  Legacy outboxes remain readable and late acknowledgements cannot delete newer
  recovery work. Account failures on later reconciliation pages still fail closed.
- Lint, all 350 unit/integration tests and the production Worker dry-run build pass.
  Coverage includes 1,001-account reconciliation/recovery, exact page boundaries,
  staging rollback, second-page enqueue/ack failures and cold restarts.
- Published prices are unchanged. S4 reductions and L9–L14 live/owner/legal
  acceptance remain open; no production deployment or credentials changed.

## L3/L5/L6/L7/L8 customer-name correctness — 2026-11-16

- The valid name `constructor` no longer reads inherited properties in budget,
  spend, run-count or reporting maps. Current and legacy budgets, numeric grouped
  costs and seven-day activity survive UTC rollovers and restarts. Missing spend
  and activity count as zero in forecasts and the browser.
- Run, action-test, trigger and quote endpoints return 404 for absent
  prototype-named definitions before dispatching to a JobDO. Reconciliation keeps
  a deleted `constructor` job deleted; existing jobs retain pause/resume support.
- Lint, all 303 unit/integration tests (including the 144 cost checks), all four
  browser flows and the production dry-run build pass. Real local SQLite/Queue
  acceptance executes a budgeted constructor-named HTTP job/action and verifies
  numeric spend, grouped costs, bounded forecasts and ledger agreement, alongside
  the existing JS, redaction, gateway, retry and ledger-archival checks.
- Prices and storage-operation allowances are unchanged. L9–L14 live/owner/legal
  acceptance and further S4 reductions remain open; nothing was deployed.

## L3/L10 paid activation settlement — 2026-11-16

- JS activation follows the execution claim's UTC day instead of the reservation
  day. A delayed Queue delivery across midnight/month-end still consumes its
  original job/key budget periods while paying activation for the new day.
- Activation payment commits atomically with settlement, ledger and receipt.
  Concurrent claims retain full reservations until one payment settles; the others
  release the activation portion. A fully refunded safety-braked claim grants no
  activation discount. Legacy claimed holds keep their promised maximum.
- Lint and all 314 unit/integration tests pass, including compact/standalone holds,
  concurrent settlement orders, refunds, UTC rollover, rollback and cold restarts.
  Compact-hold headroom also covers the additional activation-day metadata.
- All four browser flows and the production dry-run build pass. Real local
  SQLite/Queue acceptance executes nine runs, checking one activation charge across
  three jobs sharing a version, funded retries, gateway/network restrictions,
  redaction, released holds, ledger archival and matching balance/cost totals.
- Prices and HTTP storage-operation allowances remain unchanged. L9–L14 live,
  owner and legal acceptance remain open; nothing was deployed to production.

## L5 runtime synchronization — 2026-11-16

- Action edits, deposits and configuration replay preserve the last completed job
  outcome. An unchanged configuration replay writes no settings or account runtime.
- Balance wakes read configuration before clearing the durable pause, discard stale
  reset deadlines and publish the resumed runtime immediately. Repeated wakes repair
  a failed runtime publication without losing the last outcome.
- Lint and all 317 tests pass, including cold replay, failed configuration lookup and
  failed runtime publication. Live launch acceptance remains under L9–L14.

## L5/S4 refusal pauses and budget resets — 2026-11-16

- Each balance/day/month pause transition writes one log; repeated refusals with the
  same reason/window write no settings, runtime, log or alarm rows, including after
  a cold restart. Budget pauses commit their settings, log and reset wakeup together.
- Budget-reset alarms publish the resumed runtime. Failed publication or settings
  writes retain the reset deadline for alarm redelivery; repeated refusal also
  repairs a failed initial pause publication. Changed reasons/windows get a new log.
- Regression coverage includes rollback at each pause write, restart, changed pause
  reasons, UTC resets and publication failures. Conservative run bounds and prices
  remain unchanged; further S4 reductions and live/owner launch steps remain open.
- Lint, all 327 unit/integration tests, all four browser flows and the production
  dry-run build pass. Real local SQLite/Queue acceptance verifies one pause log for
  repeated budget refusals and preserves completed outcomes after an action edit.
  No production deployment or live acceptance was performed.

## L5/L6 recovery-safe retention — 2026-11-16

- Pending runs and retry dispatch outboxes survive the 30-day/1,000-record limits
  until recovery finishes. Completed log bodies and indexes are deleted in one
  transaction; a failed delete preserves both storage and the history cache.
- Lint, all 335 unit/integration tests (including the 144 cost checks) and the
  production dry-run build pass. Coverage includes cold recovery beyond both
  retention limits and a staged failure/retry after a 31-day outage, preserving
  original input and one charge per attempt. Prices and cost bounds are unchanged.
- No production deployment or live acceptance was performed; L9–L14 owner steps
  and further S4 reductions remain open.

## L5/L12 durable cost-brake recovery — 2026-11-16

- A healthy safety report atomically creates versioned account-resume outboxes.
  Later reconciliation retries unfinished accounts after failed enqueue or
  acknowledgement, including cold restarts. Old acknowledgements cannot erase a
  newer recovery, and already acknowledged accounts are not enqueued again.
- Analytics pauses publish the cost-brake reason to account runtime, remove stale
  budget-reset deadlines and avoid repeated settings/alarm writes. Replayed
  refusals repair failed publication. The operator hard stop remains stateless so
  removing it permits schedules to continue. Malformed timestamps fail closed.
- Lint, all 342 unit/integration tests, all four browser flows, the production
  dry-run build and real local SQLite/Queue acceptance pass. HTTP prices and cost
  bounds are unchanged. No production deployment or live acceptance was performed;
  L9–L14 live/owner/legal steps and further S4 reductions remain open.

## S4 reservation activity compaction — 2026-11-16

- Recent-job activity and cooldowns share compact reservations' balance writes,
  saving one more ordinary per-run write. Standalone holds retain one activity
  write; large legacy compact hold arrays migrate after sufficient space frees.
- Shared storage partitions bound activity, claim-update headroom, two money
  summaries and ledger buffering below the 128 KiB value limit. Legacy indexes,
  evicted cooldowns, backwards clocks and cold restarts preserve rate limits.
- Lint, all 497 unit/integration tests, all four browser flows and the production
  dry-run build pass. The expanded 288-path cost audit includes activity eviction
  alongside archival, rollovers, oversized summaries and failed recovery writes.
- Real local SQLite/Queue acceptance passes with compact and standalone HTTP/JS
  reservations, shared activation, separately charged retries, cooldowns across
  jobs, duplicate runs, ledger archival and matching costs/balance with no holds.
- Conservative cost bounds and the 87 µ$ price remain unchanged. Further S4
  reductions and L9–L14 live/owner/legal steps remain open; nothing was deployed.

## S4 scheduled wakeup coalescing — 2026-11-16

- Scheduled dispatch leaves rearming to its enclosing alarm after next-fire
  advancement, avoiding a redundant history scan and an intermediate alarm write
  when queue dispatch crosses a clock tick. Manual runs and retries still rearm
  immediately. The initial pending outbox keeps its atomic recovery wakeup.
- All 288 full-path cost checks and four new scheduled-wakeup regressions pass,
  including cold recovery from failed enqueue, schedule advancement and final
  rearming with one reservation and one queued execution. Lint passes.
- Prices and conservative allowances are unchanged. Further S4 work and L9–L14
  live/owner/legal acceptance remain open; nothing was deployed to production.

## L5/S4 retryable schedule advancement — 2026-11-16

- Next-fire runtime publication precedes the durable schedule advance. A failed
  publication leaves the old due time available for alarm retry, including
  missed-run skips with no pending run to repair runtime later. Failed settings
  writes replay the same deterministic run without another reservation or enqueue.
- Scheduled refusals retain the pause already committed/published by dispatch,
  avoiding another settings write and runtime request in the enclosing alarm.
- Lint, all 505 unit/integration tests (including 288 cost checks and eight
  scheduled-wakeup/recovery tests), all four browser flows and the production
  dry-run build pass. Prices and conservative allowances remain unchanged.
- Real local SQLite/Queue acceptance passes, now including an actual cron alarm:
  one successful scheduled run, one ledger charge, released hold, published next
  fire and final disable. Scheduler polling uses a fresh account so the preceding
  ledger audit cannot exhaust its API rate window.
- L9–L14 live/owner/legal acceptance and further S4 reductions remain open;
  nothing was deployed to production and no live credentials changed.

## L5/S4 atomic completion publication — 2026-11-16

- Run settlement and account runtime publication commit in one AccountDO transaction.
  A failed runtime write rolls back billing; lost responses and failed JobDO
  finalization recover the staged outcome without repeating execution or charges.
- New completed runs remember that publication committed and avoid publication RPCs
  on Queue redelivery. Legacy completions retain publication repair. Internal
  publication metadata stays out of run responses, including after cold restart.
- Lint, all 506 unit/integration tests (including 288 full-path cost checks) and
  all four browser flows and the production dry-run build pass. Cost allowances
  and prices remain unchanged pending the next tightened audit. Live/owner launch acceptance remains open.

## S4 completion cost audit and price reduction — 2026-11-16

- Expanded the cost audit from 288 to 456 paths, including failed runtime writes
  and lost settlement responses with budget-refused retries. Publishing runtime
  first inside the billing transaction avoids repeating ledger/rollover writes
  after a runtime failure; a later receipt failure rolls back both runtime and money.
- Conservative bounds are 37 row writes, 27 DO requests, five Worker invocations
  and 3,000 row reads. Rounded HTTP cost falls from 53 to 52 µ$; the base HTTP/JS
  price falls from 87 to 85 µ$ with the approved margin. Existing holds keep their
  original maximum and current job quotes follow the new price.
- Lint, all 675 unit/integration tests, all four browser flows, the production
  dry-run build and real local SQLite/Queue acceptance pass, including shared JS
  activation, separately charged retries and an actual scheduled alarm. Further S4
  reductions and L9–L14 live/owner/legal steps remain open; no production deploy.

## L6 stable run-history cursors — 2026-11-16

- Per-job history orders equal timestamps by run ID and returns `next_cursor`.
  Paging uses that position even after retention removes the boundary record.
  NDJSON exports return `X-Next-Cursor`; legacy timestamp paging remains supported.
- Regression coverage pages 205 tied records across restarts and boundary deletion,
  verifies JSON/NDJSON ordering and rejects malformed or unsupported cursors.
- Lint, all 688 unit/integration tests (including 456 cost checks) and the production
  dry-run build pass. Prices and cost allowances are unchanged. The web UI cursor
  switch and browser acceptance follow separately; live/owner launch steps remain.

## L6/L8 run-history browser acceptance — 2026-11-16

- The Older runs button sends the stable cursor and preserves the active job,
  outcome and date filters, both in requests and in the visible form.
- All five browser flows and lint pass. The new browser regression pages tied
  records, verifies the exact filtered requests and reaches the final page.
  Backend acceptance remains 688 passing unit/integration tests and the production
  dry-run build. Prices, cost bounds and live/owner launch steps are unchanged.

## L4/S4 bounded action changes — 2026-11-16

- Creating, editing or deleting an action no longer rewrites every job or creates
  scheduling outboxes for unrelated jobs. The previous fan-out could exceed a
  single change's cost allowance and clear existing budget pauses.
- Public job quotes and new reservations resolve the current action. Already-held
  execution snapshots retain their original action and maximum. Mixed batches
  still durably synchronize explicitly edited/deleted jobs after restart.
- Lint, all 693 unit/integration tests, all five browser flows and the production
  dry-run build pass. New coverage includes 100-job accounts, write bounds,
  preserved pauses/deadlines and HTTP-to-JS action changes. Prices and paid-run
  allowances remain unchanged; S4 and live/owner launch acceptance remain open.

## L4/S4 definition wakeup acceptance — 2026-11-16

- Action, variable and secret mutations no longer write an unnecessary account
  alarm. Explicit job mutations retain any earlier wakeup (including prepaid hold
  expiry), and schedule recovery only when the current alarm is absent or later.
- Job definitions, charges, outboxes and required wakeups still commit atomically.
  Failed alarm writes roll back the change and charge; cold alarm delivery drains
  the committed outbox. Earlier, later and absent alarm cases are covered.
- Lint, all 700 unit/integration tests, all five browser flows, the production
  dry-run build and real local SQLite/Queue acceptance pass. The local suite now
  also verifies that action edits preserve budget pauses and their single refusal
  log. Prices and paid-run cost allowances remain unchanged; live/owner launch
  steps and further S4 work remain open.

## L3/L5 account recovery deadlines — 2026-11-16

- A failed account job synchronization schedules its retry transactionally without
  postponing an earlier reservation expiry, including a hold created while the
  cross-object synchronization was in flight.
- Cold-restart regressions cover existing and arriving holds before and after the
  retry deadline, successful outbox recovery and exactly-once expiry charging.
- Lint and all 704 unit/integration tests pass. Prices and paid-run cost allowances
  are unchanged; live/owner launch acceptance remains open.

## L3/L12/S4 coalesced account wakeups — 2026-11-16

- Deposits and cost-brake recovery reuse an earlier account wakeup and skip
  redundant alarm writes. Recovery without jobs or pending synchronization work
  leaves an idle account asleep.
- Deposits, recovery outboxes and required alarms remain transactional. Regression
  coverage verifies rollback on failed alarm writes, idempotent deposit retries,
  earlier/later/absent wakeups and successful synchronization after cold restart.
- Lint, all 719 unit/integration tests, all five browser flows and the production
  dry-run build pass. Prices and paid-run cost bounds are unchanged; further S4
  reductions and live/owner/legal launch acceptance remain open.

## L5 reason-specific wake recovery — 2026-11-16

- Job wakes can target balance or cost-brake pauses, preserving unrelated pauses
  and their budget-reset deadlines. Publication succeeds before the resumed
  settings replace a pause; repeated wakes repair a failed scheduling alarm.
- Lint and all 729 unit/integration tests pass, including cold recovery after
  publication, settings and alarm failures and the 456 full-path cost checks.
- Run prices and existing reservations are unchanged. L9–L14 live acceptance and
  owner steps remain outstanding; nothing was deployed to production.

## L3/L5/L12/S4 compact recovery wake acceptance — 2026-11-16

- Deposits and cost-brake recovery each persist one bounded, versioned wake batch
  instead of one synchronization row per job. With 100 healthy jobs, an ordinary
  deposit uses five account row/alarm writes including acknowledgement; recovery
  without a deposit uses three. Healthy jobs keep settings and schedule alarms.
- Wakes resume only their own pause reason. Budget pauses/reset deadlines, other
  pauses, completed outcomes, explicit definition edits/deletions and earlier hold
  expiries survive. Outbox/alarm rollback, partial delivery, failed acknowledgement,
  concurrent newer deposits and cold recovery are covered. Identical configuration
  replay ignores object property order rather than rewriting settings.
- Signed Stripe events credit once and acknowledge fulfillment during an immediate
  wake outage; the durable account alarm finishes resumption after restart.
- Lint, all 752 unit/integration tests (`npm test -- --maxWorkers=4`), all five
  browser flows and the production dry-run bundle pass. Real local SQLite/Queue
  acceptance also verifies deposit-driven balance resumption while a budget pause
  remains intact, plus HTTP/JS, redaction, sandbox/gateway, funded retries, ledger
  totals and a real scheduled alarm.
- These administrative savings leave the conservative 85 µ$ run price unchanged.
  Further S4 reductions and L9–L14 live/owner acceptance remain outstanding;
  nothing was deployed to production.

## L2/L5/S4 terminal retry refusals — 2026-11-16

- A revoked or expired API key ends an unreserved retry instead of retaining an
  outbox that wakes every second. Invalid retry input after an action edit also
  ends the retry. Infrastructure failures still retain their recovery outbox.
- Twelve regressions cover compact/standalone reservations, both credential
  refusals, changed input requirements, failed cleanup and cold restart. The
  original run executes and charges once; retry cleanup preserves the job's
  schedule without pausing it or exposing private input.
- Lint and all 764 unit/integration tests pass, including the 456 full-path cost
  checks. Prices and conservative cost allowances are unchanged; further S4 work
  and L9–L14 live/owner/legal acceptance remain open.

## L5/S4 input-dependent schedule pauses — 2026-11-16

- An HTTP cron schedule that requires webhook input pauses with `missing_input`
  and one unpaid history entry instead of repeatedly failing its alarm. Manual
  runs can supply input while the schedule stays paused. Deposits and cost-brake
  recovery preserve that pause; correcting the action and saving its job resumes.
- Pause publication now precedes the durable pause. A publication outage leaves
  the due schedule available for retry without a paid hold; settings, history and
  alarm failures also recover after restart. Eighteen new regressions cover these
  paths for input, balance, daily-budget and monthly-budget refusals.
- Lint, all 782 unit/integration tests (including 456 full-path cost checks), all
  five browser flows and the production dry-run bundle pass. Real local
  SQLite/Queue acceptance verifies the actual missing-input alarm, its single
  free log, no run charge, preservation after deposit and correction/resumption,
  alongside the existing HTTP/JS, retry, redaction, accounting and schedule checks.
- Public docs and the master plan describe recovery. Conservative cost allowances
  and the 85 µ$ run price are unchanged. Further S4 reductions and L9–L14
  live/owner/legal acceptance remain open; no production deployment occurred.


## L10/L12 queued hard-stop refunds — 2026-11-16

- The operator hard stop and analytics brake both refund queued work skipped
  before execution. The operator stop is checked before analytics or secret
  decryption, so it also works when analytics is unavailable. Skipped JavaScript
  runs do not grant a paid daily activation to later work.
- Refund reporting shares normal staged-result recovery outside the execution
  catch, keeping reporting failures separate from generic billable action failures.
- Twenty-four regressions cover HTTP/JavaScript, compact/standalone holds, both
  brake sources, failed settlement/completion, cold restart, duplicate delivery,
  retry cleanup, unchanged balances/spend and the next actual activation.
- Lint, all 806 unit/integration tests (including the 456 full-path cost checks),
  all five browser flows and the production dry-run bundle pass. Prices and paid-run
  cost allowances are unchanged; live/owner/legal launch acceptance remains open.

## L5/L12 cost-pause recovery — 2026-11-16

- Analytics refusals publish their cost-brake pause before storing it locally or
  rearming. Publication failure preserves the due schedule for alarm redelivery;
  a failed alarm write can no longer leave the account showing an active job.
- Three scheduled outage regressions cover publication, settings and alarms,
  cold restart, unchanged balance/history, repeated refusal and recovery wakes.
  The existing manual-refusal test also verifies that publication failure retains
  its prior pause and reset deadline until retry succeeds.
- Lint, all 809 unit/integration tests (including 456 full-path cost checks), all
  five browser flows, the production dry-run build and real local SQLite/Queue
  acceptance pass. Prices are unchanged. The master plan now reflects the selected
  Loader, audited prices and separate L13 legal/L14 production steps.
  L9–L14 live/owner/legal acceptance remains open.

## L9 prose finalization recovery — 2026-11-16

- Finalization errors no longer overwrite successful translations, answers or
  proposals with provider failures. Completed prose responses are immutable;
  idempotent replay after a lost acknowledgement recovers the original result.
- Responses use the actual ledger charge, including when an expiry settled the
  hold before finalization. Failed response writes roll back settlement and keep
  the reservation; replay never calls the provider a second time.
- Lint and all 817 unit/integration tests pass, including eight new regressions
  covering success/failure recovery across all three endpoints, cold restart,
  contradictory late completions, expiry and transactional rollback. Prices and
  paid-run cost bounds are unchanged. Live Anthropic eval and L10–L14 owner/live
  acceptance remain open; nothing was deployed to production.

## L9 atomic prose preparation — 2026-11-16

- Questions and change proposals read their account snapshot in the reservation
  transaction, before holding funds. A failed snapshot read leaves neither a hold
  nor an in-progress request, so the same id can retry safely after restart.
- Cron translation skips account definition reads. Change proposals retain the
  snapshot's hash and refuse application after concurrent edits. Failed requests
  replay their original HTTP status as well as their original charge.
- Lint, all 822 unit/integration tests, all five browser flows and the production
  dry-run bundle pass. Five additional regressions cover snapshot outages, cron
  independence, concurrent changes and validation-error replay. Prices and paid-run
  cost allowances are unchanged. L9–L14 live/owner/legal acceptance remains open;
  no production deployment or credential changes occurred.


## L4/L11 config import recovery acceptance — 2026-11-16

- Config diffing, receipt lookup, scope checks and billing now share one account
  transaction. Identical imports recover the original response after lost replies,
  concurrent delivery, later account edits or a cold restart. Successful no-op
  imports retain their identity so a retry cannot delete definitions added later.
- Changed import documents reject reused keys. Imports have separate receipt and
  billing identities from named-definition changes. Secret deletion scopes and key
  spend caps remain transactional; failed receipt writes roll back the whole import.
- Dry runs quote the current account without consuming or replaying a paid receipt,
  including named-definition saves. Paid imports keep the existing write allowance.
- Lint and all 831 unit/integration tests pass, including eight import regressions
  and the definition dry-run regression. All five browser
  flows and the production dry-run build pass. Live/owner launch work remains open.


## L4/L5 pause/resume recovery acceptance — 2026-11-16

- Pause/resume bind receipts to the requested job and enabled state, with receipt
  lookup, current-setting resolution, billing and scheduling outbox in one account
  transaction. Replays after lost replies, edits, deletion and restart preserve the
  original response without overwriting or charging for later changes.
- Opposite toggles with the same key conflict; dry runs still quote current state
  without applying or consuming a receipt. Import, toggle and named-definition
  billing identities remain separate. Existing change prices and write bounds hold.
- Lint and all 837 unit/integration tests pass (two test workers to avoid
  contention timeouts); the production dry-run build passes. Six regressions cover
  pause/resume replay, changed settings, deletion,
  conflicting intents, dry-run quotes, outbox publication recovery and atomic
  rollback when a receipt fails. Production/owner acceptance remains outstanding.


## L4/L11 config round-trip acceptance — 2026-11-16

- Saved GET/HEAD actions include an empty body. Validation now accepts that
  normalized form while still rejecting nonempty GET/HEAD bodies, so exported
  account configs import without spurious edits or charges. Partial imports skip
  omitted collections and preserve their definitions.
- Two regressions cover full GET/HEAD export round-trips, partial imports and
  rejection before billing. Lint and all 839 unit/integration tests pass with two
  test workers; all five browser flows and the production dry-run build pass.
- Expanded real local SQLite/Queue acceptance verifies config import and no-op
  receipt replay after later edits, exported-config round-trips, pause/resume replay,
  current dry-run quotes and conflicting-intent refusal. Existing HTTP/JS execution,
  secret redaction, network denial, gateway, funded retries, ledger/cost totals,
  scheduled alarms and deposit recovery also pass. Prices are unchanged; live
  acceptance, credentials, DNS and legal approval remain owner work.


## L2 API-key recovery acceptance — 2026-11-16

- Key creation retains its original public response in the key's existing write,
  recovering the token, expiry, charge and balance after a lost reply or restart.
  Replaying creation after revocation does not reactivate the credential. Legacy
  records recover charges from their permanent billing receipts. Hashes and stored
  response metadata stay off the public key-list surface.
- Revocation binds idempotency keys to the requested key, commits its response
  with the revocation and charge, and rolls everything back if persistence fails.
  Dry runs validate current creation requests or quote current revocation state
  without consuming receipts or returning a token.
- Six regressions cover lost replies, concurrent creation, revocation, legacy
  records, changed requests, dry runs and transactional rollback. Lint, all 845
  unit/integration tests and the production dry-run build pass. Prices and paid-run
  allowances are unchanged. Live/owner/legal launch acceptance remains open.


## L7 trigger credential recovery acceptance — 2026-11-16

- Trigger changes bind their intended settings and original public billing response
  in the account's existing permanent charge receipt. Lost account replies and
  failed JobDO writes recover without charging again or accepting a different
  creation rate, including after restart and at an exhausted API-key daily cap.
- Revocation preserves the creation rate. Replaying creation after revocation
  returns the original token/charge without reactivating it, and unchanged
  creation/revocation replays skip JobDO writes. Dry runs quote changed valid
  requests without consuming receipts or exposing a token.
- Nine regressions cover both cross-object failure points, revocation, rollback,
  key caps, dry runs and existing change-write bounds. Lint, all 854 unit/integration
  tests (including the 456 paid-run cost paths), all five browser flows and the
  production dry-run build pass. Expanded real local SQLite/Queue acceptance
  verifies key and trigger replay, original charges/balances, preserved revocation
  and rates, private key metadata, dry-run quotes and conflicting intent refusal.
  Existing HTTP/JS, scheduled alarms, redaction, retries and deposit recovery pass.
- Prices and paid-run allowances are unchanged. Live production acceptance,
  credentials, DNS, model selection and legal approval remain owner work.


## S4 action-test history index — 2026-11-16

- Action tests create their permanent history-routing index in the first prepaid
  reservation and reuse it thereafter, saving one account row write per later
  test. The reservation activity still tracks recency; retained history and run
  details survive object restarts and action deletion.
- Dry runs create no index. Failed reservation writes roll the initial index back
  with the hold, and the same request can retry successfully. Two regressions,
  lint and the current 871-test suite (including the paid-run cost audit) pass.
- The first-run worst case, prices and launch acceptance requirements are unchanged.


## S1 interrupted rotation recovery — 2026-11-16

- Retrying an unfinished secret rotation reuses its existing reservation and
  authenticated ciphertext snapshot. Lost begin/finalization replies, rolled-back
  receipt writes and restarts recover at an exhausted API-key cap without another
  hold or charge; concurrent executors share one final receipt and audit entry.
- Recovery after a secret edit/deletion or active target-key change refunds the
  hold and preserves the failure receipt. Expired holds remain closed to execution.
  No-op receipts also replay unchanged across later key activations and deletion;
  dry runs continue to quote current state. No plaintext enters the AccountDO.
- Nine new regressions, lint, all 880 unit/integration tests and the production
  dry-run build pass. The operator procedure describes same-key recovery. Prices
  are unchanged; production keys, activation and retirement remain owner work.


## S1 rotation CLI recovery — 2026-11-16

- The rotation CLI retries interrupted writes and temporary server outages with
  the same idempotency key, up to three attempts with short backoff. It stops on
  definitive refusals/refunded failures and does not retry a lost billed config
  read. Transport exceptions and response bodies never enter error output.
- Thirteen regressions cover transport/JSON/server failures, bounded retries,
  private error handling and real API/AccountDO recovery after lost begin/finish
  replies or receipt-write failure. Cold restart at an exhausted key cap still
  produces one rotation charge, the correct total and no remaining hold.
- Lint, all 893 unit/integration tests and the production dry-run bundle pass.
  Operator documentation and the S1 row reflect automatic same-key recovery.
  Prices and live/owner/legal launch requirements remain unchanged.


## L9 read-only tool consistency — 2026-11-16

- Ask returns the newest ten retained runs across jobs, rather than the first
  job's history. Repeated history calls and citation validation reuse the same
  read, so concurrent pruning or new deliveries cannot invalidate a run the
  model just saw. Job-only answers avoid history fanout; unknown citations fail.
- Forecast tools use permanent seven-day activity counters, matching the direct
  projection API for webhook-only jobs even when retained logs have expired.
  Repeated forecast calls reuse their first result.
- Three regressions, lint and all 896 unit/integration tests pass. Prose usage
  billing, run cost allowances and prices are unchanged. Live model eval and
  L10–L14 owner/credential/legal acceptance remain open.


## S4 action-test request consolidation — 2026-11-16

- Action-test configuration and reservation/start now share one serialized JobDO
  request instead of two. Existing durable steps remain independently retryable;
  first and subsequent tests save one DO request without increasing row writes.
- Three additional fault regressions cover settings failure, a pending-history
  failure after reservation, lost replies and cold restart. Queue redelivery and
  request replay still perform one outbound execution and one charge.
- All 899 unit/integration tests, lint, all five browser flows and the production
  dry-run build pass. The 456-path cost audit requires the reduced request count
  for action tests; other paths still set the shared 85 µ$ run price.
- Local acceptance now checks action-test previews, queued/completed replay,
  history, ledger and final balance. Its clients pace requests below the real
  ingress allowance instead of exceeding it as acceptance coverage grows.
- Expanded real local SQLite/Queue acceptance passes, including HTTP/JS,
  scheduling, redaction, retry billing, deposits and the new action-test checks.
  Live model/sandbox/payment acceptance and owner/legal launch work remain open;
  nothing was deployed to production.


## S4 compact completion recovery — 2026-11-16

- Completed Queue redelivery and explicit result replay use one compact history
  read instead of repeatedly loading the retained body and job settings. They
  perform no job writes or history scans and keep later outcomes intact.
- Staged outcomes still settle and finalize after interruption; claimed work
  without an outcome stays pending. Legacy completions still repair publication,
  including standalone bodies without a compact index; private retries recover.
- Five new regressions, all 904 unit/integration tests (including the 456-path cost
  audit), lint and the production dry-run build pass. Prices and conservative
  paid-run allowances are unchanged; live/owner launch requirements remain open.


## L4 template namespace validation — 2026-11-16

- Unsupported inherited namespaces such as `{{constructor.name}}` return the
  documented `400 unknown_template` instead of throwing an internal server error.
  Only explicitly declared built-in namespaces participate in validation.
- Both real mutations and dry runs leave the balance, audit and definitions
  unchanged on refusal. Two regressions reproduce the previous 500 response.
- All 906 unit/integration tests and lint pass. Launch acceptance remains open.


## L12 canonical destination limits — 2026-11-16

- HTTP actions and JavaScript gateway egress now share the same destination
  bucket for dotted and undotted DNS names. The outbound URL and origin remain
  intact, preserving TLS/Host behavior and cross-origin credential stripping.
- Eight new regressions cover aliases, blocked hosts, shared HTTP/JS limits,
  cold restart and refusal without consuming a paid sandbox subrequest. Lint,
  all 914 unit/integration tests (including the paid-run cost audit) and the
  production dry-run bundle pass. Prices and write allowances are unchanged.
- Live production, credentials, DNS and owner/legal acceptance remain open.


## L5 HTTP redirect execution — 2026-11-16

- Redirect method/body rewrites preserve HEAD on 303 and remove representation
  headers when switching to GET. Same-origin headers and 307/308 bodies remain
  intact; cross-origin credentials cannot reappear after redirecting back.
- Redirect response bodies are canceled even when the next destination is blocked
  or malformed. Exhausted subrequest allowances fail before consuming another
  destination-rate attempt. Seventeen regressions cover these behaviors; eleven
  reproduced failures in the prior implementation.
- Lint, all 931 unit/integration tests (including the 456-path paid-run audit),
  all five browser flows and the production dry-run build pass. Full real local
  SQLite/Queue acceptance also passes, covering HTTP/JS execution, gateway access,
  redaction, retries, billing recovery, scheduled alarms and deposit resumption.
- Prices and cost allowances are unchanged. Live model/sandbox/payment acceptance,
  production credentials/DNS and owner/legal launch work remain open.


## L6 webhook forecast pricing — 2026-11-16

- Jobs without a cron schedule now forecast recent activity at the webhook
  maximum, including its surcharge. This corrects understated HTTP/JavaScript
  spend and overstated balance runway; manual-only activity may cost less.
- JavaScript activation allowances and UTC daily/monthly budget caps still apply.
  Ask's forecast tool and the direct projection API return the same estimate.
  Regression checks reproduce the old shortfall for both action types.
- Lint, all 933 unit/integration tests (including the 456-path paid-run audit),
  all five browser flows and the production dry-run bundle pass. Billing prices
  and write allowances are unchanged. Live model/sandbox/payment acceptance,
  credentials, DNS and owner/legal approval remain open.

## L10/L14 Cloudflare runtime acceptance — 2026-11-16

- Verified the existing Cloudflare account and active cronly.org zone; provisioned
  `cronly-runs` (no producers/consumers until the app Worker is deployed). Created
  GitHub's production environment and stored the verified Cloudflare account ID.
  Automatic deploy, launch approval and public JavaScript flags remain false.
- Eight fixed checks ran on Cloudflare through the production JavaScript executor
  and log wrapper. Controls passed; a nonterminating 10 ms action produced the
  explicit native CPU-time exception, excess service calls produced the native
  subrequest exception, native fetch/connect were blocked, and concurrent logs
  remained separate and redacted. [Sanitized report and source hashes](docs/ops/evidence/sandbox-runtime-2026-11-16.json).
- The original finite arithmetic workload also succeeded at 10 ms, so it cannot
  establish CPU rejection. Both acceptance scripts now use the nonterminating
  probe. The runtime runner checks specific native diagnostics, tolerates bounded
  pre-execution auth propagation delays and collects all case results. The service
  runner attempts job/action cleanup even after failures.
- Lint, all 941 unit/integration tests (including cost floors and the 456-path
  paid-run audit) and the isolated Worker dry-run bundle pass. New CLI regressions
  cover auth propagation, explicit native-limit evidence, failed controls, log
  isolation and cleanup after polling/deletion failures or an escaped CPU probe.
- All three temporary Workers were deleted; a final account inventory found no
  cronly Workers. No customer credit or production application secrets were created.
  Full authenticated Queue/billing/gateway acceptance, telemetry review, deployment
  credentials, Clerk/Stripe setup, real deposit and legal approval remain open.
