# cronly pricing model

Written 2026-11-15. Cloudflare and Stripe rates are the list prices hashbin reviewed on
2026-10-24 (`hashbin.org/src/utils/cost-policy.js`); Queues, Workers for Platforms and the
Anthropic rates are noted where they come from. **Re-check every rate against the providers'
pricing pages before L3 lands**, then keep them only in `src/utils/cost-policy.js` and
`src/utils/llm-policy.js`. This is a planning model, not financial advice.

## Goals

1. **No account can cost more than it paid.** Every billable operation is priced at or above
   1.5× its *worst-case* marginal cost after payment-processing losses, and its maximum price
   is held from the balance before it runs.
2. **Profit grows with volume.** Every unit has a positive margin; fixed costs are small.
3. **Thin margin.** Aim for 1.5–2× worst-case cost, not 10×.

## Units

- Internal money is integer **micro-dollars** (µ$). 1¢ = 10,000 µ$. $1 = 1,000,000 µ$.
- All cost and price math rounds up to the next µ$.
- Revenue haircut: assume we keep 92% of credited deposits (refunds, chargebacks, rounding),
  as hashbin's `revenueKept` does. A price must satisfy
  `price × 0.92 ≥ 1.5 × worst_case_cost`.

## Marginal rates used

| Resource | Rate | µ$ per unit | Source |
|----------|------|-------------|--------|
| Worker request | $0.30 / M | 0.30 | hashbin cost-policy |
| Worker CPU | $0.02 / M ms | 0.02 per ms | hashbin cost-policy |
| Durable Object request | $0.15 / M | 0.15 | hashbin cost-policy |
| DO duration (128 MB) | $12.50 / M GB-s | 1.5625 per second awake | hashbin cost-policy |
| DO SQLite row written | $1.00 / M | 1.00 | hashbin cost-policy |
| DO SQLite row read | $0.001 / M | 0.001 | hashbin cost-policy |
| DO storage | $0.20 / GB-month | 0.2 per KB-month | hashbin cost-policy |
| Queue operation | $0.40 / M (send, receive, ack = 3 per message) | 1.20 per message | Cloudflare Queues pricing — verify |
| Anthropic `claude-opus-5-5` | $4 / M in, $20 / M out, $0.20 / M cache read | 4 / 20 / 0.2 per token | Anthropic pricing, 2026-11 |
| Anthropic `claude-haiku-5-5` | $0.10 / M in, $0.50 / M out | 0.1 / 0.5 per token | Anthropic pricing, 2026-11 |
| Stripe | 2.9% + 30¢ per deposit | — | passed through, itemized (hashbin L20) |

Included monthly usage on Workers Paid is ignored, so estimates err high.

## Worst-case cost of one HTTP run

| Step | Cost (µ$) |
|------|-----------|
| JobDO alarm: request + ~50 ms awake | 0.15 + 0.08 |
| Reserve in AccountDO: request + 2 rows written (hold, balance) | 0.15 + 2.00 |
| Queue message | 1.20 |
| Executor Worker: request + 10 ms CPU (fetch wait is not billed) | 0.30 + 0.20 |
| Result to JobDO: request + 2 rows written (run, index) | 0.15 + 2.00 |
| Settle in AccountDO: request + 2 rows written (ledger, balance) | 0.15 + 2.00 |
| Next-fire update in AccountDO's job row | 1.00 |
| Store up to 16 KB of log for one month | 3.20 |
| Delete the run row at prune time | 1.00 |
| **Total** | **≈ 13.6** |

Rows written dominate. Price **25 µ$**: 25 × 0.92 = 23 ≥ 1.5 × 13.6 = 20.4 ✓.
Net margin ≈ 9–11 µ$ per run.

Ways to lower the cost later (and then the price): fold the hold and the ledger row into one
write, keep log excerpts smaller by default, batch next-fire updates.

## Other operations

| Operation | Worst-case cost | Price | Check (price × 0.92 ≥ 1.5 × cost) |
|-----------|-----------------|-------|-------|
| Webhook-triggered run (extra inbound Worker request + token check + CPU) | run + ~1 | run + 5 | ✓ |
| JS run base (as HTTP run, plus sandbox invocation 0.30) | ~14 | 25 | ✓ |
| JS CPU, per ms of the configured limit | 0.02 | 0.05 | 0.046 ≥ 0.03 ✓ |
| JS subrequest through the gateway (Worker request + ~1 ms CPU) | 0.32 | 1 | ✓ |
| Change (Worker + DO request, ~5 rows written incl. permanent audit row, alarm reset) | ~6 | 100 | ✓ (deliberately higher; changes are rare and the audit row is kept forever) |
| API read with an API key (Worker + DO request, reads) | ~0.5 | 1 | ✓ |
| Prose request | actual tokens × rate | 1.5 × token cost + 500 | ✓ by construction; the 500 µ$ covers the Worker/DO side and rounding |

Free operations — web UI reads, `/api/cron/explain`, `/api/quote`, `?dry_run=1` — cost about
0.5 µ$ each and are rate-limited per account (e.g. 120/minute). An account that deposited
nothing can sign in and look but cannot create API keys, change anything or run anything, so its
worst-case cost is bounded by that rate limit and by invite-only sign-up at launch. That residue
is counted as fixed cost, not as a customer cost.

### Prose request examples

`to-cron`: ~1,500-token cached system prompt, ~100 tokens from the user, ~400 output tokens
(including low-effort thinking):

| Model | Token cost | Price (1.5× + 500 µ$) |
|-------|-----------|-----------------------|
| `claude-opus-5-5` | 1,500×0.2 + 100×4 + 400×20 ≈ 8,700 µ$ | ≈ 13,550 µ$ ≈ **1.4¢** |
| `claude-haiku-5-5` | 1,500×0.1 + 100×0.1 + 400×0.5 ≈ 360 µ$ | ≈ 1,040 µ$ ≈ **0.1¢** |

The first call after a cache expiry pays a cache write; billing from the response's actual
`usage` covers it. `ask` and `change` may take several tool turns; their hold is
`max_turns × (max input + max_tokens)` at model rates, and the UI shows that maximum.

## Example customer bills

| Setup | Runs / month | Monthly cost |
|-------|--------------|--------------|
| 1 job hourly | 720 | 1.8¢ |
| 5 jobs every 15 min | 14,400 | 36¢ |
| 1 job every minute | 43,200 | $1.08 |
| 20 jobs every minute | 864,000 | $21.60 |
| JS job, 100 ms CPU limit, 5 subrequests, every 5 min | 8,640 | 8,640 × (25 + 5 + 5) µ$ = 30¢ |

A $5 deposit runs an hourly job for ~23 years, or an every-minute job for ~4.6 months.

## Fixed costs

| Item | Monthly |
|------|---------|
| Workers Paid | $5.00 |
| cronly.org domain | ~$1 (verify registrar price) |
| Clerk | $0 under its free monthly-retained-user allowance |
| Workers for Platforms (only if chosen for JS actions, STATUS D2) | $25.00 |
| **Total** | **≈ $6, or ≈ $31 with WfP** |

If cronly lives in the same LLC and Cloudflare account as hashbin, the Workers Paid plan is
already paid and cronly's true fixed cost is the domain.

## Break-even

At ~10 µ$ net margin per run, ignoring changes and prose:

- $6/month fixed → 600,000 runs/month (≈ 14 jobs running every minute).
- $31/month fixed → 3.1 M runs/month.

Below break-even the loss is the fixed cost minus margin, at most ~$31/month. Above it, profit
rises linearly with runs.

## Tests that keep this true

`src/utils/pricing.test.js` (L3) asserts, for every operation in `pricing.js`, that
`price × revenueKept ≥ 1.5 × worstCaseCost(operation)` using only `cost-policy.js` constants,
and that every price and hold is a positive integer. Changing a rate or a price without
keeping the inequality fails the build.

## Implementation audit (2026-11-15)

Owner accepted D4–D6. The HTTP base is **30 µ$** to include queue redelivery and
bookkeeping allowances; prose uses **1.64× token cost + 500 µ$**, because 1.5×
after a 0.92 revenue factor fails the required floor. Earlier tables are the original
planning estimates; the constants in `src/utils/pricing.js` are authoritative.

Verified provider sources:
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/queues/platform/pricing/
- https://developers.cloudflare.com/dynamic-workers/pricing/
- https://platform.claude.com/docs/en/about-claude/pricing
- https://stripe.com/pricing

Dynamic Workers now charge for each distinct worker used per day. L10 must cover
that charge rather than relying on the included allowance.
