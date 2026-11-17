# cronly master plan

cronly ("cron only") is a pay-as-you-go scheduling service at `https://cronly.org`. A customer
defines **named actions**, the **variables** and **secrets** those actions use, and **when**
they run: on a cron schedule, on demand from the web UI, or from a webhook. cronly runs them,
logs what happened, and charges the customer's prepaid balance a few micro-dollars per run.

It is a sibling of [hashbin.org](https://hashbin.org) and copies its shape: Cloudflare Workers
and Durable Objects, Clerk for sign-in, Stripe for deposits into a prepaid balance (no
subscription), integer money, and an API built for scripts and agents. Where hashbin decided
something already (deposits, card fee wording, local mode, route access table), cronly reuses
the decision and the code rather than reopening it.

Written 2026-11-15. Status of every item lives in [`STATUS.md`](../STATUS.md); this file holds
the design. Pricing numbers and their derivation live in
[`docs/business/pricing.md`](../docs/business/pricing.md).

---

## 1. Principles

1. **Cron plus the least that makes it a service.** Actions, variables, secrets, schedules,
   logs, budgets, a balance. No workflows, no DAGs, no chaining, no retries-with-backoff
   language, no templates gallery. Anything else a customer wants they can build as an action.
2. **No account can cost more than it paid.** Every operation that costs cronly money is
   priced above its worst-case marginal cost and is **reserved from the balance before it
   runs**. A balance can never go negative. Unattributable traffic (anonymous requests, bad
   webhook tokens) is bounded by rate limits and counted as fixed cost.
3. **Profit grows with volume.** Every metered unit (run, CPU-ms, change, prose request) has
   a positive margin. Fixed costs are small, so total profit = volume × unit margin − fixed.
4. **Thin margins, shown openly.** Target roughly 1.5–2× worst-case marginal cost, not 10×.
   The pricing page shows our cost estimate beside the price.
5. **Agents and scripts are first-class users.** Everything the web UI does is a JSON API
   call; every mutating call can be quoted first; every response says what it cost.
6. **Prose is a convenience, never an authority.** An LLM can translate prose to cron and
   propose changes, but a person (or the calling agent) confirms every change, and the
   deterministic cron engine is the only thing that decides when a job fires.

## 2. Concepts

| Concept | What it is | Example |
|---------|------------|---------|
| **Variable** | Named plain value, readable through the API, usable in templates | `base_url = https://api.example.com` |
| **Secret** | Named value, write-only after creation, encrypted at rest, redacted from logs | `api_token` |
| **Action** | Named thing to do: an HTTP request template or a JavaScript module | `ping-health`, `nightly-report` |
| **Job** | An action plus *when*: a cron expression and time zone, plus policies and a budget. One action can have several jobs. | `ping-health` every 5 min, `America/Chicago` |
| **Trigger** | A way to run a job now: "Run now" in the UI, `POST /api/jobs/{name}/run`, or a webhook URL with a trigger token | `https://cronly.org/hook/tk_…` |
| **Run** | One execution of a job, with its log, outcome and cost | run `r_01J…` at 2026-11-16T09:00Z, 200 OK, 25 µ$ |
| **Budget** | Limits on what a job may spend: per run, per day, per month | max 1,000 µ$/day |
| **Balance** | Prepaid credit in micro-dollars, topped up with Stripe | $4.81 |

Names are `[a-z0-9-]{1,64}`, unique per account. The API addresses things by name so scripts
and agents don't have to track IDs; stable IDs exist too.

### 2.1 Templates

Variables and secrets reach actions through one tiny substitution syntax, with no logic:

- `{{var.NAME}}`, `{{secret.NAME}}`
- built-ins: `{{run.id}}`, `{{run.scheduled_at}}` (ISO 8601), `{{run.trigger}}`
  (`schedule` | `manual` | `webhook`), `{{job.name}}`, `{{account.id}}`
- `{{input.FIELD}}` for webhook-triggered runs: top-level fields of a JSON body sent to the
  hook (size-capped, strings only), so a web page can pass a value through

Unknown names are an error when the action is saved, not when it runs.

### 2.2 Action types

**HTTP action** (launch): method, URL, headers, body, timeout (1–30 s), success rule (status
ranges, default 2xx), and `follow_redirects`. Templates allowed in URL, headers and body.

**JavaScript action** (launch, after HTTP): an ES module whose default export is
`async run(ctx)`. `ctx` holds `vars`, `secrets`, `run`, `input`, and a `fetch` routed through
cronly's outbound gateway. The return value (JSON, size-capped) and `console.log` output go into
the run log. Each action declares a **CPU limit** (10 ms–30 s) and a **subrequest limit**
(0–50); both are priced. Source size cap 256 KB, no npm resolution (bundle it yourself).

No other action types (email, SMS, queues) at launch. Customers call those services over HTTP.

### 2.3 Job policies (the only knobs)

| Policy | Values | Default |
|--------|--------|---------|
| `timezone` | IANA zone; DST handled by the cron library | `UTC` |
| `overlap` | `skip` (don't start if the previous run is unfinished) or `allow` | `skip` |
| `missed` | `skip` or `run_once` after an outage longer than one interval | `skip` |
| `retries` | 0–3 immediate retries on failure; each retry is billed as a run | 0 |
| `enabled` | on / off | on |
| `budget` | max per run (derived, read-only), per day, per month, in µ$ | none beyond balance |

Minimum interval is one minute (standard 5-field cron). 6-field (seconds) cron is rejected.
Runs start within a few seconds of the scheduled minute; the docs say so plainly.

## 3. Architecture

```
            ┌──────────── cronly.org (main Worker) ────────────┐
 browser ──▶│ static frontend · /api/* · /hook/* · /mcp · Stripe │
 scripts    │ & Clerk webhooks · route access table              │
 agents     └──────┬──────────────────────┬──────────────────────┘
                   │                      │
           ┌───────▼────────┐     ┌───────▼────────┐
           │ AccountDO      │◀───▶│ JobDO (1/job)  │── alarm at next fire
           │ (1/account)    │     │ run history    │
           │ balance+ledger │     └───────┬────────┘
           │ holds          │             │ enqueue run (reservation id)
           │ actions/vars/  │     ┌───────▼────────┐
           │ secrets/jobs   │     │ Queue: runs    │
           │ API keys       │     └───────┬────────┘
           │ audit log      │     ┌───────▼────────────────┐
           └────────────────┘     │ executor Worker        │
                                  │ HTTP: fetch directly   │
                                  │ JS: sandboxed isolate ─┼──▶ outbound gateway ──▶ internet
                                  └────────────────────────┘
```

- **AccountDO** (one per account, SQLite-backed) is the source of truth for definitions and
  money: balance, holds, ledger, actions, variables, encrypted secrets, jobs (with their
  computed next fire time for the "upcoming" view), API keys and the change audit log. It is
  the only place that moves money, so reservation and settlement are transactional.
- **JobDO** (one per job) owns the job's **alarm** and its **run history**. Splitting per job
  keeps a busy account from making one object hot and keeps each job's log storage separate
  (Durable Object storage is capped per object).
- **Runs go through a Queue** so no Durable Object stays awake while an outbound request
  waits. Durable Objects bill wall-clock duration; Workers bill CPU. A 30 s fetch held in a DO
  would cost ~47 µ$ — more than the price of a run.
- **Executor Worker** consumes the queue, renders the template (secrets decrypted only here,
  only for this run), performs the action, redacts secrets from what it logs, and reports the
  result to the JobDO, which asks the AccountDO to settle.
- **Cron Triggers are not used for customer schedules** (Cloudflare allows only a few per
  Worker). Each JobDO's alarm is the schedule. One platform Cron Trigger runs daily
  housekeeping: cost reconciliation, log pruning checks, Stripe reconciliation.

### 3.1 Life of a scheduled run

1. JobDO alarm fires for scheduled time `T`. Run id = `job_id:T` (stable, so an alarm that
   fires twice cannot run or charge twice).
2. JobDO asks AccountDO to **reserve** the job's max run price (§6). AccountDO checks, in one
   transaction: balance − holds ≥ price, job's daily and monthly budget not exceeded, reservation
   id not already used. On success it records a hold.
3. On refusal the JobDO **pauses the job** (`paused: insufficient_balance` or
   `paused: budget_day` / `budget_month`), writes one log entry, and stops scheduling runs while paused.
   A deposit resumes a balance pause; a budget change or the next budget window
   (daily/monthly reset alarm) resumes a budget pause. Deposits and cost-brake recovery
   each persist one bounded, versioned account wake batch, separate from definition
   edits. Delivery targets its own pause reason, preserves other pauses/schedules and
   retries safely after partial delivery or restart without delaying hold expiry.
   Pausing instead of logging every skipped run keeps a broke account from costing anything.
   HTTP schedules that require `{{input.FIELD}}` also pause (`missing_input`) with
   one unpaid log, since cron cannot supply webhook input. Correct the action and
   save its job to resume, or leave cron blank for manual/webhook-only use. Manual
   runs with supplied input remain available while the schedule is paused.
   Publish the pause before committing it in JobDO so a failed publication leaves
   the due schedule available for alarm redelivery without requiring a paid hold.
4. JobDO computes the next fire time, sets its alarm, and enqueues the run.
5. Executor runs the action and posts the result (status, timing, excerpts, CPU used,
   subrequests) to the JobDO.
6. JobDO stores the run record and asks AccountDO to **settle**: charge actual cost (never more
   than the hold), release the rest, append a ledger row. The observed result is durable
   before settlement; Queue redelivery or the pending alarm can finish a staged completion
   after an outage without repeating external work. Configured retries use a private durable
   outbox with the original input and key cap, a deterministic child run id and a separate
   reservation. Budget, revoked/expired-key and invalid-input refusals end that
   retry; transient dispatch failures remain recoverable.
7. A hold older than the maximum run time + margin is settled at the full held amount by an
   AccountDO alarm (the run's result was lost; we did the work, or may have).

On-demand runs (UI, API, webhook) enter at step 2 with a fresh run id.

### 3.2 Time and cron

- Library: [`croner`](https://github.com/hexagon/croner) in the Worker for next-fire
  computation with IANA time zones; [`cronstrue`](https://github.com/bradymholt/cRonstrue) for
  deterministic, free cron → English in both the UI and API. Pin versions; both are small,
  dependency-free and run in Workers (verify during L6).
- Upcoming runs and projections are computed from the cron expression, not stored per run.

### 3.3 Secrets

- Encrypted with AES-256-GCM. Key per account derived with HKDF from a Worker secret
  (`SECRETS_MASTER_KEY`) and the account id. Ciphertext lives in AccountDO.
- Write-only: the API returns name, created/updated time and a fingerprint, never the value.
- Decrypted only inside the executor for the run that needs it or a separately reserved
  key-rotation operation.
- Redaction: before anything is logged, every secret value used by the run (and its URL- and
  base64-encoded forms, including JSON escapes) is replaced with `«secret:NAME»`.
  Scrub complete values before excerpt/size limits; JS console and return-value
  capture apply the same redactor inside the sandbox before truncating output.
- Key rotation is S1 (re-encrypt under a new master key version), not launch. The
  implementation uses an atomic `SECRETS_KEYRING` binding and a separately held,
  `secrets:write`-scoped rotation endpoint. See [operator procedure](../docs/ops/secret-rotation.md).

### 3.4 JavaScript sandbox

User code must run in an isolate that has **no bindings** except the values cronly passes,
with **enforced CPU and subrequest limits**, and whose outbound traffic goes through a
cronly-controlled gateway Worker that counts subrequests, enforces the destination rules in §8,
and strips cronly's own hosts.

Two Cloudflare options; decide in L12 after checking current docs and pricing:

| | Workers for Platforms (dispatch namespace) | Dynamic Worker Loader |
|---|---|---|
| Per-invocation limits | `cpuMs` and `subRequests` on dispatch (documented) | verify |
| Outbound control | Outbound Worker | `globalOutbound` |
| Fixed cost | ~$25/month plan; per-script fee past included scripts | verify; no per-script upload |
| Upload | Script uploaded per action version via API | Code passed at load time, cached by id |

Recommendation: prefer the Worker Loader if it is generally available with enforced CPU
limits, because it has no per-script fee and no extra fixed cost; otherwise Workers for
Platforms. Either way, cronly passes a content hash as the isolate id so unchanged code is not
re-uploaded. Pricing (§6) charges the **configured** CPU limit per run until measured CPU is
available per invocation (Tail Worker `cpuTime` or equivalent), then charges measured CPU with
the configured limit as the hold.

Dynamic Worker activation is held on every run and charged once per account/action
version and UTC execution-claim day. Record paid activation atomically with
settlement so concurrent runs share one charge and a fully refunded safety-braked
claim cannot discount later execution. Queue delay across midnight changes the
activation day while preserving the reservation's job/key budget day and month.

### 3.5 Prose (Claude)

Three endpoints, all metered and all reserved before the call (§6):

| Endpoint | In | Out | Side effects |
|----------|----|-----|--------------|
| `POST /api/prose/to-cron` | text, time zone | cron, explanation (deterministic, from cronstrue), next 5 fires, confidence, alternatives | none |
| `POST /api/prose/ask` | a question ("what runs tonight?", "what will next month cost?") | answer with cited jobs/runs | none (read-only tools over the account) |
| `POST /api/prose/change` | an instruction ("move the report to 7am weekdays and pause the pinger") | a **change proposal**: a list of concrete API mutations with a quote | none until applied |
| `POST /api/changes/{id}/apply` | proposal id | applied changes | charged as normal changes |

- Translation is checked deterministically: the returned cron must parse, and the server
  regenerates the English explanation from the cron itself so the user sees what the cron
  says, not what the model claims it says.
- Cron → English is free and needs no LLM.
- Calls use the Anthropic Messages API with structured outputs (`output_config.format`), a
  frozen cached system prompt, and read-only tools for `ask`. Model id is one constant in
  `src/utils/llm-policy.js`. **Default `claude-opus-5-5` at low effort**; `claude-haiku-5-5`
  costs ~40× less per token and may be accurate enough for translation — the owner decides
  (STATUS D3) after an eval of ~100 prose/cron pairs.
- Bill actual `usage` tokens × model rate × markup, with a minimum (§6). Prompt text from the
  user is data; tools only read the caller's own account.

## 4. API and agent surface

Everything is JSON over HTTPS under `/api/`. Access is declared per route in an `API_ROUTES`
table (`PUBLIC`, `SESSION`, or scopes) exactly as in hashbin, and a test fails for an
undeclared route.

### 4.1 Credentials

| Credential | Header | For |
|------------|--------|-----|
| Clerk session | `Authorization: Bearer <clerk-jwt>` | web UI |
| API key | `Authorization: ApiKey crk_…` | scripts, agents, CI |
| Trigger token | in the hook URL: `/hook/tk_…` | webhooks and web pages; can only run one job |
| Local dev | `Authorization: LocalDev <user>` | local mode only |

API keys have **scopes** (`read`, `run`, `change`, `prose`, `secrets:write`) and an optional
**spend cap** per day, so an agent can be handed a key that can run jobs and ask questions but
spend at most $0.50/day. Port hashbin's `src/auth/scopes.js` and key storage.

Trigger tokens are stateless: `tk_` + base64url(account, job, token id) + HMAC. Revocation is
a token-id check in the JobDO. Each has its own rate limit (default 10/min) and counts against
the job budget, so one embedded in a public web page can at worst spend the job's budget.

### 4.2 Conventions every endpoint follows

- Mutations accept `?dry_run=1` → returns the quote and validation result, costs nothing.
- Mutations accept `Idempotency-Key`.
- Responses carry `cost_microdollars` and `balance_microdollars`.
- Errors are `{ error, code, ... }` with the right status; `402` for insufficient balance
  or budget, with the amount needed.
- Plain names in paths: `PUT /api/jobs/nightly-report`.

### 4.3 Endpoints (sketch)

```
GET  /api/account                      balance, holds, runway, monthly spend
GET  /api/quote?op=...                 price of any operation, free
GET|PUT|DELETE /api/variables/{name}
GET|PUT|DELETE /api/secrets/{name}     GET returns metadata only
GET|PUT|DELETE /api/actions/{name}
GET|PUT|DELETE /api/jobs/{name}
POST /api/jobs/{name}/run              run now
POST /api/jobs/{name}/pause|resume
POST /api/jobs/{name}/triggers         create trigger token; DELETE to revoke
GET  /api/upcoming?from&to             scheduled runs with per-run price and totals
GET  /api/runs?job&status&from&to      recent runs
GET  /api/runs/{id}                    full run log
GET  /api/costs?from&to&group=job|action|day   past spend
GET  /api/projection                   daily/monthly burn, date the balance runs out
GET|PUT /api/config                    whole account as one document (§4.4)
POST /api/cron/explain                 cron → English + next fires, free
POST /api/prose/to-cron|ask|change     §3.5
POST /api/changes/{id}/apply
POST /api/payments/checkout            Stripe deposit
POST /hook/{trigger-token}             webhook trigger (also accepts GET for dumb clients)
```

### 4.4 Account as code

`GET /api/config` returns actions, variables, jobs and secret *names* as one JSON (or YAML)
document. `PUT /api/config?dry_run=1` returns the diff and its price; `PUT` applies it
atomically. This lets developers keep their cronly setup in git and lets an agent make a
reviewed batch of changes. Each created/updated/deleted item is billed as one change.

### 4.5 For agents and web pages

- `GET /openapi.json` (OpenAPI 3.1) generated from `API_ROUTES` plus schemas; a test fails on
  drift.
- `GET /llms.txt` and `/docs/agents.html`: what cronly is, auth, pricing, the dry-run/quote
  pattern, curl examples.
- **Remote MCP server** at `/mcp` (Streamable HTTP, API-key auth): tools `list_jobs`,
  `upcoming`, `recent_runs`, `get_run`, `explain_cron`, `prose_to_cron`, `quote`, `apply_change`
  (always quote first), `run_job`, `balance`. Same scopes and spend caps as the key.
- Tiny browser snippet `/sdk/cronly.js` (immutable versioned releases with SRI, like hashbin's
  SDK) with `trigger(token, input)`; CORS open on `/hook/*` only.
- Copy-paste curl and `fetch` examples on every action/job page in the UI.

## 5. Web UI

Vanilla HTML/CSS/JS ES modules, no build step, served by the main Worker (hashbin's frontend
conventions, including `escapeHtml`).

- **Header on every signed-in page:** balance, and "Actions run until **Dec 3** at the current
  schedule" (or "for more than a year"). Turns amber under 7 days, red under 1 day or when any
  job is paused for balance. Link to deposit.
- **Dashboard:** next 10 upcoming runs with price; last 10 runs with outcome; spend today /
  this month; projected spend this month; paused jobs and why.
- **Jobs:** list with cron, plain-English schedule, next run, last outcome, monthly projected
  cost, budget use. Editor with a cron field, live English and next-5 preview (free, local),
  a "describe it in words" box (prose, metered — shows the price before the call), policies,
  budget, triggers. Save shows the change price.
- **Actions / Variables / Secrets:** editors; HTTP action editor with "test run" (billed as a
  run); JS editor (textarea + basic highlighting) with CPU/subrequest limits and the per-run
  price they imply.
- **Upcoming:** calendar-ish list for a chosen window with per-run and total cost.
- **Runs:** filterable history; run detail shows rendered request (secrets redacted),
  response excerpt, console output, timing, cost breakdown.
  (Log excerpts total at most 16 KB per run; see §7.)
- **Costs:** past spend by day/job/action; projection by job.
- **Ask:** one prose box for questions and change requests; change proposals render as a
  diff with a price and an Apply button.
- **Account:** deposits (Stripe Checkout), transaction history, API keys (scopes, spend caps),
  trigger tokens, data export.
- Public pages: home, pricing (with our cost beside each price), docs, API, agents, terms,
  privacy.

## 6. Pricing and money

Detailed derivation in [`docs/business/pricing.md`](../docs/business/pricing.md). Summary:

- **Unit:** integer micro-dollars (µ$, $0.000001) everywhere internally. Stripe amounts are
  cents (1¢ = 10,000 µ$). Every cost computation rounds **up**.
- **Deposits:** Stripe Checkout, minimum $5, no subscription. The card payment cost is
  itemized on top, as hashbin decided in its L20 (same wording and Terms language; reuse
  `grossUp`). Credit never expires while the account exists; refunds of unused balance on
  request minus the non-refundable card cost.
- **Starting prices** (to be confirmed by the cost model and price-floor tests):

| Operation | Price | Worst-case marginal cost (est.) |
|-----------|-------|----------------------|
| HTTP run (scheduled, manual, or retry) | 25 µ$ | ~14 µ$ |
| Webhook-triggered run | run price + 5 µ$ | ~1 µ$ for the inbound request |
| JS run | 25 µ$ + 0.05 µ$ per CPU-ms of limit + 1 µ$ per allowed subrequest | ~14 µ$ + 0.02 µ$/ms + ~0.3 µ$/subrequest |
| Change (create/update/delete action, variable, secret, job, key, trigger) | 100 µ$ | ~6 µ$ plus a permanent audit row |
| Prose request | 1.5 × actual Anthropic token cost + 500 µ$ | token cost |
| API reads with an API key | 1 µ$ each | ~0.5 µ$ |
| Web UI reads, cron explain, quotes, dry runs | free, rate-limited | ~0.5 µ$ |

  So a job every hour costs ~1.8¢/month; every minute, ~$1.08/month.
- **Reservation rule:** an operation runs only after its maximum price is held. Max price is
  computable up front for every operation (runs: from the action's limits; prose: from
  `max_tokens` and input size). Settlement charges `min(actual, held)`.
- **Budgets:** per job per day and per month, enforced in the same transaction as the
  reservation. Per API key per day. Account balance is the final budget.
- **Projection:** for each enabled job, expected runs in the next 30 days (from cron) × max
  run price, capped by its budget; sum per day; runway = (balance − holds) / daily burn,
  shown as a date. Webhook-only jobs use their trailing 7-day average.
- **Fixed costs:** Workers Paid ($5/mo) + domain + (Workers for Platforms $25/mo if chosen) +
  Clerk (free tier). Roughly $6–31/month. Break-even with HTTP runs alone at ~10 µ$ net margin:
  ~0.6M runs/month without WfP. Price-floor tests assert every price ≥ 1.5 × worst-case cost
  after Stripe's cut and an 8% revenue haircut (refunds, disputes), using constants in
  `src/utils/cost-policy.js`.

## 7. Logs and retention

- Per run: trigger, scheduled/started/finished times, outcome, HTTP status, rendered request
  (redacted), response headers and the first 8 KB of the body (redacted), JS return value and
  console output (8 KB), CPU ms, subrequests, cost.
- Kept 30 days or the last 1,000 runs per job, whichever is fewer; pruned by the JobDO alarm.
  Pending runs and retry outboxes survive these limits until recovery finishes;
  completed log bodies and indexes are then pruned atomically.
  The run price includes this storage. Ledger rows and the change audit log are kept for the
  life of the account (they are small and needed for billing disputes).
- Export: `GET /api/runs?format=ndjson`.

## 8. Abuse and safety

cronly makes outbound requests on a schedule, so it can be pointed at someone else. Limits:

- Per account: max jobs (100 to start; raise on request), max 1 run/minute/job, max
  concurrent runs (10).
- Per destination host per account: max 60 requests/minute across all jobs.
- New accounts: first deposit cap (like hashbin's `newAccountDepositCapCents`), job limit 10
  for the first week.
- Blocked destinations: cronly's own hosts (no loops through hooks; use "run now"),
  link-local/private address literals, Cloudflare internal hosts. JS outbound goes through the
  gateway, which applies the same rules.
- Response bodies are never executed or rendered as HTML in the UI.
- Cloudflare rate-limiting rules on `/hook/*` and `/api/*` for anonymous and bad-token traffic;
  Cloudflare billing notifications; daily cost reconciliation against Cloudflare analytics
  with an alert and a brake (pause all runs) like hashbin's `projectionBrakeCents`.
- Sign-up starts invite-only (Clerk Restricted mode), as hashbin's L23 decided.
- Terms: acceptable use (no unsolicited load, no attacks, no scraping against robots/ToS),
  suspension policy, refunds.

## 9. Repository layout (planned)

```
src/
  index.js              fetch/queue/scheduled handlers, API_ROUTES, DO exports
  api/                  account, actions, variables, secrets, jobs, runs, costs, prose, payments, hooks, mcp
  auth/                 clerk, api keys, scopes, trigger tokens, local auth (ported from hashbin)
  durable-objects/      account-do.js, job-do.js
  executor/             queue consumer, http action, js action, template render, redaction
  services/             cron (croner/cronstrue wrappers), projection, llm client
  utils/                cost-policy.js, pricing.js, llm-policy.js, money.js
workers/
  outbound-gateway/     egress for JS actions
frontend/               static site, no build
  js/ css/ docs/ sdk/
docs/                   operator and developer guides; docs/business/ for pricing and risk
todo/ done/             plans
scripts/                operator CLIs, doc generators, API tests
```

## 10. Build order

Each step has a STATUS row. Later steps depend on earlier ones unless noted.

1. **L1 Scaffold:** wrangler config (prod + local), Vitest, ESLint, `dev:local` with LocalDev
   auth and dev deposits, CI running lint and unit tests, `/health`.
2. **L2 Accounts and auth:** Clerk session auth, Clerk webhook creates AccountDO, API keys with
   scopes and spend caps, `API_ROUTES` with access declarations and its test.
3. **L3 Money:** µ$ ledger in AccountDO, reserve/settle/expire holds, Stripe Checkout deposit
   with itemized card cost and webhook, transaction history, `cost-policy.js`, `pricing.js`,
   price-floor tests, `/api/quote`.
4. **L4 Definitions:** variables, secrets (encryption, write-only, fingerprints), HTTP actions,
   template validation, change billing, audit log, `?dry_run`, `Idempotency-Key`.
5. **L5 Scheduler:** jobs, croner, JobDO alarms, queue, executor for HTTP actions, redaction,
   settlement, pause-on-refusal, overlap/missed/retries policies, budget windows.
6. **L6 Runs and costs:** run history, retention pruning, `/api/runs`, `/api/costs`,
   `/api/upcoming`, `/api/projection`.
7. **L7 Triggers:** run now, trigger tokens, `/hook/*`, per-token rate limit, CORS, `{{input.*}}`.
8. **L8 Web UI:** every page in §5, balance/runway header, Playwright tests.
9. **L9 Prose:** cron explain (free), Anthropic client, to-cron, ask (read-only tools), change
   proposals and apply, reservation and billing, eval set for to-cron.
10. **L10 JavaScript actions:** sandbox decision (§3.4), outbound gateway, limits, pricing,
    editor. Can start in parallel with L8/L9 once L5 is done.
11. **L11 Agent surface:** OpenAPI generation and drift test, `llms.txt`, agent docs, MCP
    server, `/api/config` import/export, browser snippet.
12. **L12 Safety:** limits in §8, rate-limit rules, reconciliation and brake, invite-only.
13. **L13 Launch:** cronly.org DNS and Workers custom domain, production Clerk and Stripe,
    Terms/Privacy, end-to-end production test with a real deposit, `verify:production`.

## 11. What is deliberately left out

Job chaining or dependencies; conditional logic in templates; per-second schedules; built-in
email/SMS; teams and shared accounts; subscriptions; free tier; log search beyond filters;
custom domains for hooks; outbound result notifications (make a second action that calls
your own endpoint, or poll `/api/runs`). Each can be a backlog row if customers ask.
