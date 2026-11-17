# cronly pricing and cost model

Audited 2026-11-16. D4–D6 approved the proposed launch defaults and upward corrections
required by cost floors. The implementation audit found two material planning errors:
per-read transactional ledger writes cost more than a 1 µ$ read, and prose's original
1.5× markup fails the 1.5× margin after the 8% haircut. Dynamic Workers also now charge
for distinct worker versions used each day. Indexing/retention and bounded history scans are included in the final rates. The public pricing page reads the same
constants as the API; historical numbers in the master plan are superseded here.

## Current prices

| Operation | Price | Estimated worst-case marginal cost |
|---|---|---|
| HTTP run | 85 µ$ | ceil(policy run bound), currently 52 µ$ |
| Webhook run | HTTP/JS price + 5 µ$ | run bound + 2 µ$ |
| Change: action, variable, secret (including key rotation), job, key, trigger | 100 µ$ | 20 µ$ |
| API-key read | 21 µ$ base + 2 µ$ per job scanned for aggregate history | ceil(12 µ$ base + 1.2 µ$/job) |
| Web session reads, cron explain, quotes, mutation dry runs | Free, rate-limited | Bounded fixed operating cost |
| JavaScript run | 85 µ$ + ceil(0.05 × CPU-ms limit) + 5 µ$ × allowed subrequests | base + configured CPU + counted gateway |
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
their promised maximum. UTC month rollover, refunds, settlement order, storage
rollback and cold restarts are covered for compact and standalone reservations.
Real local Worker/Queue acceptance also verifies one activation charge across
three jobs sharing a version, with matching run logs, ledger, costs and balance.

A regular hourly HTTP job is about $0.06120 per 30 days; a minutely job is $3.6720. These
are run charges only. Changes, API polling, prose and JS activation are additional.

## Units and deposits

Internal money is integer micro-dollars: $1 = 1,000,000 µ$; 1¢ = 10,000 µ$.
Round charges and costs up. A balance cannot go negative; every billable operation
reserves its maximum before external work, and settles no more than that hold.
Lost or uncertain results expire against the held maximum. Outstanding holds count
against account availability, job UTC daily/monthly budgets and key UTC daily caps.

Minimum credit: $5. The card payment cost is itemized on top, using hashbin's grossUp:
`ceil((creditCents + 30) / (1 - 0.029))`. A $5 credit costs $5.46, including $0.46 of
card cost. Full selected credit is credited exactly once from a verified paid Stripe
Checkout webhook, never a browser redirect. New accounts may deposit at most $20
per checkout in their first week. Unused credit does not expire while the account
exists; refunds are owner-operated, less non-refundable card cost, subject to the
reviewed Terms and applicable law.

## Cost assumptions

Rates live only in `src/utils/cost-policy.js`; prices only in `src/utils/pricing.js`;
model rates only in `src/utils/llm-policy.js`. Included allowances are ignored.
The HTTP bound includes 37 row writes, 27 DO requests, five Worker invocations and
3,000 compact-index row reads, six Queue operations, CPU,
awake time and 16 KB retained logs; orchestration caches compact summaries instead of loading log bodies. Read and change bounds include actual ledger,
key-budget, audit and rate-counter bookkeeping rather than just one request.
Permanent cost summaries and job/key budget counters share the account's
daily/monthly summaries. Active summaries now share the balance row, saving two
writes on ordinary settlements. At UTC rollover the previous periods are archived;
late settlements update their reserved periods. Summaries above 50,000 UTF-8 bytes
stay standalone, bounding the compact state below the storage value limit. Each
period still needs at most one separate write, so the worst-case allowance and
prices remain unchanged. Legacy scalar balances and separate summaries migrate
lazily; compact summaries take precedence over stale legacy rows in reporting. Old standalone budget counters remain readable until
each job/key first settles in a period, preserving existing caps without bulk migration.

The S4 audit counts the entire schedule/manual/action-test/webhook path, including
six HTTP requests when following redirects, cold retained-history scans, retention
deletes, alarm writes, ingress counters and production safety lookups. Integration
tests fail if these paths exceed the policy's row/request allowances. Merely batching
separate keys into one storage call would not reduce billed SQLite rows.
All four paths also include three Queue redeliveries, using the configured production
retry count. Consumers repair committed outcome publication after settlement without
repeating outbound work or charging twice. Redelivery does not rescan retained history;
the existing pending-run alarm still guarantees cleanup. The invocation allowance
includes one ingress request and four separately billed consumer batches, without
assuming messages share a batch. Cloudflare documents [consumer request/CPU billing](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)
separately from [Queue operation charges](https://developers.cloudflare.com/queues/platform/pricing/).

The audit also injects failed settlement, completion writes, retry dispatch and retry
outbox cleanup, plus the pause when a retry exceeds its budget. Results are staged
durably before settlement; recovery completes the same outcome and charges once.
A failed run's retry context stays private until its
deterministic child is reserved/enqueued or refused by its job/key budget. The 144 checks repeat these paths with compact and standalone reservations, compact summaries, UTC day/month rollovers
and oversized standalone summaries. The current
37-write/27-DO-request/five-invocation allowance covers these tested paths; separately
billed retries each contribute their own allowance. Refused retries have no separate
charge, so the paid parent includes their pause/log/cleanup overhead. The recovery audit initially raised
the 80 µ$ base to 89 µ$ to retain the approved floor after rounding costs up.

This corrects the earlier 24-write/12-request allowance, which omitted some of that
bookkeeping. The prior 60 µ$ run price fails the audited floor. Compact pending-run records
removed one write per run and initially reduced the corrected 80 µ$ default to 78 µ$.
The subsequent redelivery audit includes recovery RPCs and all consumer invocations,
which required 80 µ$. Staged-result recovery and the previously uncounted retry-refusal
path required 89 µ$ before the staged-log finalization saving below. Persisted job quotes follow the current price;
already-held runs settle within their original maximum.

Tests assert `price × 0.92 >= 1.5 × ceil(worstCaseCost)` for every operation and JS extremes.
The floor rounds cost up to integer micro-dollars just as settlement estimates do.
Read coverage checks every job count from zero to 100: the old 20 µ$ base missed the
rounded floor at small counts, so it is now 21 µ$ plus the unchanged 2 µ$/job.
Prose markup is 1.64 because `1.64 × 0.92 >= 1.5`; 1.5 itself fails. The additive
500 µ$ covers non-model orchestration. The pre-call hold uses bounded input bytes,
maximum output tokens, maximum cache-write rates and bounded read-only tool turns.
Actual billing includes provider-reported input, output, cache-read and cache-write
usage. Provider failures with unknown usage retain the reserved maximum; known usage
is used when deterministic output validation fails.

These are conservative engineering estimates, not measured production costs. L12's
monitor distinguishes measured Worker/DO totals from a conservative ledger allowance
for Queue/sandbox usage. Missing, truncated or stale analytics activates the brake.
S3 recalibrates from actual bills. S4 has removed 2–4 separate budget-counter writes
per run and avoids unchanged alarm/runtime/recent-job writes. Transactional reads
and changes also skip transient holds and their expiry alarms while enforcing the
same balance and budget checks. External work still requires durable holds.
Repeated run outcomes skip the unchanged job-settings write. Changed outcomes are
saved atomically with completed logs; the worst-case bound still includes that write.

Pending-run metadata now shares the compact history row, saving another write per
run. Completed logs and summaries commit atomically. Legacy queued records remain
readable, and cold outbox recovery is tested. Permanent receipt tombstones remain
separate so outstanding-hold scans stay bounded. Recent ledger entries now share
the balance row, saving one more ordinary settlement write. A full buffer archives
to one immutable page, bounded to 100 entries or 16,000 UTF-8 bytes; this leaves
room beside the two 50,000-byte money summaries. Transaction history merges buffered
entries, archived pages and legacy standalone rows using bounded reads in either
direction; old cursors remain valid. New cursors use a persisted sequence to order
simultaneous entries and withstand a backwards wall clock, while entries retain
their actual creation times. Receipt lookup and all accounting still commit atomically.
The 144 cost checks force a full ledger buffer alongside their money-summary and
recovery scenarios; archival needs the saved write, so the worst-case bound and
prices are unchanged.

Small durable reservations now also share the balance row. Their final settlement
removes the prepaid execution snapshot in the same balance write, saving one row
delete per run. The compact hold array is limited to 8,000 UTF-8 bytes, with 128
bytes per hold reserved for claim/activation/gateway updates; together with both
summaries and ledger it fits below the storage value limit. Large snapshots and
legacy holds remain standalone, without migration writes. Funds, budgets, account
concurrency, job overlap and expiry include both formats. Permanent receipts remain
separate and never expose execution snapshots. The full-path audit checks both
formats and requires compact runs to use one fewer write; standalone runs retained
the then-current 38-write bound and 89 µ$ price.

Completed runs now retain their original durable staged body. Finalization commits
only the compact history index, authoritative billing/subrequest metadata and any
changed outcome settings. Full reads combine the saved outcome with that committed
metadata; legacy completed bodies remain readable. Recovery and public privacy
checks apply to both formats. This removes a body rewrite even for large standalone
reservations, full ledger buffers, UTC rollovers and refused retries. The 144 checks
now enforce 37 writes per standalone run and 36 per compact run, with the existing
request/read allowances. The rounded HTTP cost falls from 54 to 53 µ$, reducing the
base HTTP/JS run price from 89 to 87 µ$ while preserving the approved margin. Already
reserved runs retain their original maximum. Further worst-case write reductions
remain S4 work.

Run cooldown timestamps now share the recent-job index row. Switching between jobs
updates one row instead of separate cooldown and index rows; repeatedly running the
same job still needs one write. The index retains at most 100 names, including
deleted jobs and action tests. Evicted timestamps fall back to standalone cooldown
rows so churn cannot bypass the one-run-per-minute limit. Original name arrays and
standalone timestamps remain readable; reservations and activity commit atomically.
Eviction can still need two writes, so the conservative 37-write bound and the
87 µ$ base price are unchanged.

Repeated refusals for an unchanged balance/day/month pause now write no additional
job settings, runtime, log or alarm rows. Each pause transition commits its one log,
settings and budget-reset wakeup atomically. Budget-reset alarms publish the resumed
runtime and retain the reset deadline until publication and settings succeed, so
redelivery can finish a failed reset. Configuration replay also skips unchanged
settings while retaining the last completed outcome. These reduce repeated or
administrative work; the conservative paid-run bound and 87 µ$ price are unchanged.

Recent-job activity and cooldowns now share a compact reservation's balance write,
removing one more ordinary per-run write. Activity is bounded to 100 names and
10,000 UTF-8 bytes. With activity present, compact holds use at most 4,000 bytes,
leaving room for both 50,000-byte summaries, the 16,000-byte ledger and metadata
inside one 128 KiB value. Larger snapshots stay standalone; existing compact hold
arrays retain the old layout until there is room for activity and claim-update
headroom. Legacy activity/cooldown rows remain readable, and evicted cooldowns
remain authoritative across restarts and backwards clocks. The expanded 288-path
audit also forces index eviction, alongside the existing archival and recovery
scenarios. Standalone holds and eviction can still use the saved write, so the
conservative 37-write bound and 87 µ$ base price are unchanged.

Scheduled runs rearm once after advancing their next-fire time. The pending outbox
still commits with a recovery alarm before queue dispatch; failed dispatch,
advancement or final rearming recovers after restart without a second hold or
execution. This skips a redundant history scan and avoids moving the intermediate
alarm forward during dispatch. Manual runs and retries retain immediate rearming.
Next-fire publication happens before durable advancement, so a failed publication
retries even when a missed run was skipped without creating an outbox. A scheduled
budget/balance refusal also reuses its existing committed pause instead of writing
settings and publishing runtime a second time. The conservative bound and prices
are unchanged.

Completion runtime publication now shares the account settlement transaction.
The runtime row is written before ledger changes, so a failed runtime write avoids
repeating ledger pages and period archives. A later billing failure rolls runtime
back with the charge. New completed runs retain a private publication marker in
their existing history index and skip runtime RPCs on Queue redelivery; legacy
completions retain publication repair. Lost settlement responses and failed job
finalization recover the staged outcome without another execution or charge.

The expanded 456-path audit includes runtime-write and settlement-response failures,
including when the recovered run's retry is refused by its budget. Those cases
need a conservative 27 DO requests rather than 30, with the existing 37-write,
five-invocation and 3,000-read allowances. The rounded HTTP cost falls from 53 to
52 µ$, reducing the base HTTP/JS run price from 87 to 85 µ$. Existing reservations
keep their original maximum; persisted job quotes use the current price. Further
S4 reductions and live/owner launch acceptance remain open.

Action changes no longer fan out into writes and scheduling synchronization for
every job in the account. Quotes and reservations resolve the current action
without persisting derived price changes on each job. A single action create,
edit or deletion stays within the existing change allowance even with 100 jobs;
only explicitly edited/deleted jobs need durable scheduling outboxes. Existing
execution holds and job pauses retain their original state.
Action, variable and secret mutations also skip the account alarm write: they
create no scheduling outbox. Explicit job edits schedule a recovery wakeup only
when an existing alarm will not already run soon enough, retaining earlier hold
expiry deadlines. Deposits and cost-brake recovery follow the same earliest-wakeup rule, skipping
redundant alarms or accounts with no synchronization work. A failed synchronization
retries within a minute without postponing an earlier hold expiry, including holds
reserved while the cross-object call was in flight. The retry's alarm comparison is
transactional with any concurrent reservations. These administrative savings leave
paid-run prices unchanged.

Deposit and cost-brake recovery now persist one bounded wake batch per cause
instead of writing and acknowledging a synchronization row for every job. An
ordinary deposit with 100 healthy jobs needs five account row/alarm writes,
including its ledger/balance, receipt, batch, wakeup and acknowledgement; recovery
without a deposit needs three. Healthy jobs preserve settings and schedules.
Balance recovery leaves budget/cost pauses intact; cost recovery leaves
budget/balance pauses intact. Explicit definition edits and deletions retain their
separate synchronization outboxes. Version checks prevent an older batch from
acknowledging a newer deposit; partial delivery and acknowledgement failures replay
after restart. Signed Stripe fulfillment acknowledges durable credit even when
immediate wake delivery fails. Configuration replay also ignores property order
rather than rewriting identical settings after completion. These are administrative
savings; the conservative run bound and 85 µ$ price are unchanged.

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
