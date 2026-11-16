# cronly pricing and cost model

Audited 2026-11-15. D4–D6 approved the proposed launch defaults and upward corrections
required by cost floors. The implementation audit found two material planning errors:
per-read transactional ledger writes cost more than a 1 µ$ read, and prose's original
1.5× markup fails the 1.5× margin after the 8% haircut. Dynamic Workers also now charge
for distinct worker versions used each day. The public pricing page reads the same
constants as the API; historical numbers in the master plan are superseded here.

## Current prices

| Operation | Price | Estimated worst-case marginal cost |
|---|---|---|
| HTTP run | 50 µ$ | ceil(policy run bound), currently 29 µ$ |
| Webhook run | HTTP/JS price + 5 µ$ | run bound + 1 µ$ |
| Change: action, variable, secret, job, key, trigger | 100 µ$ | 20 µ$ |
| API-key read | 20 µ$ | 12 µ$ including reservation/settlement and key counters |
| Web session reads, cron explain, quotes, mutation dry runs | Free, rate-limited | Bounded fixed operating cost |
| JavaScript run | 50 µ$ + ceil(0.05 × CPU-ms limit) + 5 µ$ × allowed subrequests | base + configured CPU + counted gateway |
| JS daily activation | 3,300 µ$ on first invocation of each action version per UTC day | 2,000 µ$ provider activation |
| Prose | ceil(1.64 × actual model-token cost) + 500 µ$ | actual tokens + bookkeeping |

Every JS invocation holds the activation maximum. Later invocations of that same
account/action version/day release the activation portion. Both code and sandbox
configuration contribute to the content hash. CPU is billed at the configured limit
until per-invocation measured CPU is available (S2). Retries are separately reserved
and charged as runs. Queue redelivery never repeats a claimed outbound operation.

A regular hourly HTTP job is about $0.036 per 30 days; a minutely job is $2.16. These
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
The HTTP bound includes 20 row writes, 12 DO requests, queue retry allowance, CPU,
awake time and 16 KB retained logs. Read and change bounds include actual ledger,
key-budget, audit and rate-counter bookkeeping rather than just one request.
Permanent cost summaries share the account's existing daily/monthly counter writes.

Tests assert `price × 0.92 >= 1.5 × worstCaseCost` for every operation and JS extremes.
Prose markup is 1.64 because `1.64 × 0.92 >= 1.5`; 1.5 itself fails. The additive
500 µ$ covers non-model orchestration. The pre-call hold uses bounded input bytes,
maximum output tokens, maximum cache-write rates and bounded read-only tool turns.
Actual billing includes provider-reported input, output, cache-read and cache-write
usage. Provider failures with unknown usage retain the reserved maximum; known usage
is used when deterministic output validation fails.

These are conservative engineering estimates, not measured production costs. L12's
monitor distinguishes measured Worker/DO totals from a conservative ledger allowance
for Queue/sandbox usage. Missing, truncated or stale analytics activates the brake.
S3 recalibrates from actual bills; S4 reduces reservation/ledger row writes before
passing savings into lower prices.

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
