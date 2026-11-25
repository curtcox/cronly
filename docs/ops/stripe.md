# Stripe setup and payment acceptance (L3/L14)

Use the existing Stripe account used by hashbin, with dedicated cronly products,
restricted runtime credentials and a separate webhook. Never reuse or rotate
hashbin's key or webhook secret for cronly. Public payments remain gated by
`LAUNCH_APPROVED`; provisioning Stripe does not grant legal launch approval.

## Catalog

Live mode:

| Product | ID | One-off default price |
|---------|----|-----------------------|
| cronly prepaid credit | `prod_Ve6uXTm3GrWYo5` | $5.00 USD |
| cronly card payment cost (non-refundable) | `prod_Ve6v9xj8VFn2eB` | $0.46 USD |

The default prices are catalog examples. Checkout supplies the chosen credit and
its calculated card cost through `price_data.unit_amount`, referencing the two
existing products. It does not use their default prices, create subscriptions or
create new products on each deposit. See [Stripe's Checkout contract](https://docs.stripe.com/api/checkout/sessions/create).

Set repository variables `CRONLY_STRIPE_CREDIT_PRODUCT_ID` and
`CRONLY_STRIPE_CARD_COST_PRODUCT_ID` to the IDs above. CI deploys them as
`STRIPE_CREDIT_PRODUCT_ID` and `STRIPE_CARD_COST_PRODUCT_ID`. Deployment preflight
and production Checkout reject missing, malformed or identical IDs. Free quotes
remain available before payment setup or launch approval. Local Stripe tests can
retain inline products if neither catalog ID is configured.

The products use the account's preset General — Electronically Supplied Services
tax category. That is not tax or legal acceptance: review tax obligations and the
itemized card-cost wording before opening payments. Automatic tax and the shared
account's business and branding settings are untouched.

## Restricted runtime key

**cronly production checkout** (`rk_live_…`, stored as `STRIPE_SECRET_KEY` in GitHub's
`production` environment) has only:

- Checkout Sessions: Write (includes Read).
- Products: Read.
- Prices: Read.

Everything else is None, including Charges, Refunds, Payment Intents, Customers, Payouts and
Webhook Endpoints. Restricted keys apply to resource types across the shared account, not to
cronly's product IDs ([restricted keys](https://docs.stripe.com/keys/restricted-api-keys)).
Refunds stay owner-operated in the Stripe dashboard.

## Webhook

**cronly production payments**, `we_0Ucox4TWAgyTrTqTgzY8njcH`, active:

- URL: `https://cronly.org/webhooks/stripe`.
- Scope: Your account, snapshot payloads.
- API version: `2026-10-28.endive` (endpoint-specific; account default unchanged).
- Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded` only.

Its signing secret is `STRIPE_WEBHOOK_SECRET` in GitHub's `production` environment. The
destination receives Checkout events from the whole shared account, including hashbin's; the
handler ignores sessions without cronly metadata and unpaid sessions before creating an
account or granting credit. hashbin's key and destination are separate and must not be reused.

## Verified so far

The restricted key created a card-only live Checkout session with the app's catalog and
amounts ($5.00 credit + $0.46 card cost = $5.46), read back both line items with the exact
product IDs, then expired it unpaid. That was a direct SDK check, not a Worker or ledger test;
no charge or refund has happened. [Evidence](evidence/stripe-catalog-2026-11-17.json).

## Acceptance still required

1. Complete legal approval and set `CRONLY_LAUNCH_APPROVED=true` (see
   [launch](launch.md)); keep sign-up invite-only.
2. Have the owner complete a real $5 credit purchase in the deployed UI. Verify
   the full $5 credit, one ledger deposit, signed delivery, repeated event
   deduplication and balance-paused job recovery. Confirm both completed and
   async-success delivery for the same session cannot credit it twice.
3. Verify the refund procedure with the owner and record deployment SHA and
   sanitized evidence in `docs/acceptance/`. No live charge or refund is claimed here.
