# cronly pricing and cost model

Prices are set by D4–D6: each is the approved launch default, corrected upward wherever the
price-floor test required it. Constants live only in `src/utils/pricing.js` (prices),
`src/utils/cost-policy.js` (provider rates and allowances) and `src/utils/llm-policy.js` (model
rates); the public pricing page and `/api/quote` read the same constants. Numbers in the master
plan defer to this file.

## Current prices

| Operation | Price | Estimated worst-case marginal cost |
|---|---|---|
| HTTP run | 79 µ$ | ceil(policy run bound), currently 48 µ$ |
| Webhook run | HTTP/JS price + 5 µ$ | run bound + 2 µ$ |
| Change: action, variable, secret (including key rotation), job, key, trigger | 100 µ$ | 20 µ$ |
| API-key read | 21 µ$ base + 2 µ$ per job scanned for aggregate history | ceil(12 µ$ base + 1.2 µ$/job) |
| devicebasedauth.org credential: read or first-attempt run | API-key price + 7 µ$ (reads 28 µ$ base, HTTP runs 86 µ$) | API-key bound + 3.64 µ$ verification |
| devicebasedauth.org online decision | 58 µ$ per decision, allowed or not | 35 µ$ (15 µ$ DBA charge + change-sized hold) |
| devicebasedauth.org link start | 100 µ$ (a change); finish and unlink free | 35 µ$ (15 µ$ DBA sign-in charge + change) |
| Web session reads, cron explain, quotes, mutation dry runs | Free, rate-limited | Bounded fixed operating cost |
| JavaScript run | 79 µ$ + ceil(0.05 × CPU-ms limit) + 5 µ$ × allowed subrequests | base + configured CPU + counted gateway |
| JS daily activation | 3,300 µ$ on first invocation of each action version per UTC day | 2,000 µ$ provider activation |
| Prose | ceil(1.64 × actual model-token cost) + 500 µ$ | actual tokens + bookkeeping |

Every JS invocation holds the activation maximum. Later invocations of that same
account/action version/day release the activation portion. Both code and sandbox
configuration contribute to the content hash. CPU is billed at the configured limit
until per-invocation measured CPU is available (S2). Retries are separately reserved
and charged as runs. Queue redelivery never repeats a claimed outbound operation.

Activation uses the UTC day when execution is claimed, even if the reservation was
made before midnight. Job/key budgets still use the original reserved day/month.
An activation is recorded as paid in the same transaction as its settlement,
ledger and receipt. Concurrent first claims keep their full holds; settlement
charges one activation and discounts the others. A safety-braked, fully refunded
claim does not grant a free activation to a later run. Legacy claimed holds retain
their promised maximum. Tests cover UTC month rollover, refunds, settlement order, storage rollback and cold
restarts; a real local Worker/Queue run verifies one activation across three jobs sharing
a version.

### devicebasedauth.org (S5)

Verifying a DBA credential on each request costs cronly the link-index lookup, one write and
one delete in the shared DPoP replay cache, and the account's credential row: `dbaVerification`,
3.64 µ$. That pushes reads (bound 15.64 µ$, so a 21 µ$ read keeps 19.32 µ$ against a 24 µ$ floor) and runs
(bound 51.64 µ$: 72.68 µ$ kept against 78 µ$) below the floor, so D5/D6's standing approval of
upward floor corrections adds `dbaRequest` (7 µ$) to reads and to manual runs and action tests a
DBA caller starts. Retries and scheduled runs are not
re-verified, so they do not pay it. Changes (100 µ$ vs. 23.64 µ$) absorb it.
Grants with `net.client.addresses.dns` names add DNS-over-HTTPS lookups (one A and one AAAA
query per name, at most 16 names, cached per isolate for 30–300 s). Workers subrequests carry
no per-request charge and parsing the answers is well under a millisecond of CPU, so they stay
inside the CPU allowance of `dbaVerification`; DBA prices DNS checks as free (its D17).

Device sessions in the workspace (S5 Stage B) are priced like any DBA credential: each page
read is a metered read plus `dbaRequest`, because every request is verified. Regular browser
sessions stay free, since a Clerk session costs no verification.

Grants with `net.client.latency` are timed by challenging the device: each challenge is a refused
request verified like any other, so the request that finally passes carries one `dbaRequest` per
challenge it answered (counted by the sealed nonce, at most 5: `DBA_MAX_VERIFICATIONS` is 6). A
read after one challenge is 35 µ$ (bound 1.5 × 20 / 0.92 = 32.6) and passes the floor at every
count; changes (100 µ$ vs. 41.84 µ$ at six verifications) and prose absorb it. Challenges a device
abandons are unpaid, like any refused request.

DBA bills cronly.org 15 µ$ for each online decision (including denials) and each OIDC
sign-in. The owner chose to pass both on (2026-11-22): `dba_decision` (58 µ$) is held under the
credential's monthly cap before DBA is asked, charged once DBA answers and released when it
cannot (5xx, unfunded, unreachable). Starting a link charges a change before cronly asks DBA.

A regular hourly HTTP job is about $0.05688 per 30 days; a minutely job is $3.4128. These
are run charges only. Changes, API polling, prose and JS activation are additional.

## Units and deposits

Internal money is integer micro-dollars: $1 = 1,000,000 µ$; 1¢ = 10,000 µ$.
Round charges and costs up. A balance cannot go negative; every billable operation
reserves its maximum before external work, and settles no more than that hold.
Lost or uncertain results expire against the held maximum. Outstanding holds count
against account availability, job UTC daily/monthly budgets, key UTC daily caps and
devicebasedauth.org credentials' UTC monthly caps (a grant's `spend_usd_per_month`, in µ$).

Minimum credit: $5. The card payment cost is itemized on top, using hashbin's grossUp:
`ceil((creditCents + 30) / (1 - 0.029))`. A $5 credit costs $5.46, including $0.46 of
card cost. Full selected credit is credited exactly once from a verified paid Stripe
Checkout webhook, never a browser redirect. New accounts may deposit at most $20
per checkout in their first week. Unused credit does not expire while the account
exists; refunds are owner-operated, less non-refundable card cost, subject to the
reviewed Terms and applicable law.

## Cost assumptions

Included provider allowances are ignored, so every operation pays its own way.

**HTTP run bound: 48 µ$.** `worstCaseCost('run')` allows 33 SQLite row writes, 27 DO requests,
five Worker invocations, 3,000 row reads, six Queue operations, 20 ms of Worker CPU, 0.2 s of
DO wall time and 16 KB of retained log storage, which sums to 47.86 µ$ and rounds up to 48.
At 79 µ$, `79 × 0.92 = 72.68 ≥ 1.5 × 48`. The allowance covers the whole schedule, manual,
action-test and webhook paths: up to six HTTP requests when following redirects, alarms,
retention deletes, ingress counters, production safety lookups, three Queue redeliveries
(the production retry count) with separately billed consumer batches, and the bookkeeping
of a retry refused by its budget, which has no charge of its own. Each paid retry carries
its own allowance.

**The audit.** `src/durable-objects/run-cost.test.js` counts real storage operations over 456
paths: every trigger with compact and standalone reservations, compact and oversized money
summaries, UTC day/month rollovers, full ledger buffers, recent-activity eviction, refused and
successful retries, and injected failures of settlement, completion, runtime publication and
lost responses. It fails if any path exceeds the policy's row, request or invocation
allowance. Batching separate keys into one storage call would not reduce billed rows, so the
savings come from sharing rows:

- Small reservations, active daily/monthly summaries (which double as job and key budget
  counters), the recent ledger buffer, recent-job activity and run cooldowns all share the
  account's balance row, bounded so it stays below the 128 KiB value limit. Larger or legacy
  records stay standalone and are still counted.
- Pending-run metadata shares the job's compact history row; finalization commits only the
  history index and billing metadata beside the durably staged result.
- Completion publishes the job's runtime row inside the settlement transaction; scheduled
  dispatch leaves publishing its advancement to that settlement and rearms once per turn.
- Retries are reserved before their failed parent finalizes, so no retry outbox is written.
- Unchanged alarms, settings and repeated refusal pauses are not rewritten.

**Reads and changes.** A read is bounded at 12 µ$ plus 1.2 µ$ per job scanned for aggregate
history (priced 21 µ$ + 2 µ$/job, checked for every job count from 0 to 100); a change at
20 µ$, including ledger, key budget, audit and rate-counter writes. Transactional reads and
changes enforce balance and budgets without durable holds; action, variable and secret
edits do not rewrite or resynchronize jobs. Deposits and cost-brake recovery wake jobs through
one bounded batch per cause (five account writes for a deposit with 100 jobs).

**Prose.** Markup is 1.64 because `1.64 × 0.92 ≥ 1.5` and 1.5 itself fails; the additive
500 µ$ covers orchestration. The hold uses bounded input bytes, maximum output tokens,
maximum cache-write rates and bounded read-only tool turns. Billing uses provider-reported
input, output, cache-read and cache-write usage; a failure with unknown usage keeps the
reserved maximum.

These are conservative engineering estimates, not measured costs. L12's daily monitor
compares measured Worker/DO totals plus a ledger allowance for Queue and sandbox usage, and
brakes on missing or stale analytics. S3 recalibrates from real bills; S4 continues to lower
the run bound. A price change applies to new reservations and quotes; existing holds keep
their original maximum.

## Verified provider sources

- [Workers](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Queues](https://developers.cloudflare.com/queues/platform/pricing/)
- [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/pricing/)
- [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)
- [Stripe](https://stripe.com/pricing)

Workers: 0.30 µ$/request, 0.02 µ$/CPU-ms. DO: 0.15 µ$/request, 1 µ$/row written,
0.001 µ$/row read, approximately 0.2 µ$/KB-month, 1.5625 µ$/second at 128 MB.
Queues: 0.40 µ$/operation per 64 KB chunk. Dynamic Worker activation: 2,000 µ$/day
per distinct worker. Opus 5.5: 4 µ$/input token, 20 µ$/output, 0.2 µ$/cache read,
5 µ$/five-minute cache write (hold permits 8). Haiku 5.5 eval rates are centralized
beside these. Model choice remains Opus pending the owner-run 100-case comparison.

Fixed costs are the shared Workers Paid plan, domain, invite-only account overhead
and bounded public/free traffic. No Workers for Platforms monthly plan is required.
Verify actual domain/account bills and analytics schema during L14.
