# Stripe setup and payment acceptance (L3/L14)

Use the existing Stripe account used by hashbin, with dedicated cronly products,
restricted runtime credentials and a separate webhook. Never reuse or rotate
hashbin's key or webhook secret for cronly. Public payments remain gated by
`LAUNCH_APPROVED`; provisioning Stripe does not grant legal launch approval.

## Catalog

Created and verified in live mode on 2026-11-17:

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

The catalog retained the account's preset General — Electronically Supplied
Services category. This is not tax/legal acceptance; review tax obligations and
the itemized card-cost wording before opening payments. No automatic tax setting
or shared Stripe business/branding settings were changed.

## Restricted runtime key (created and verified)

Created on 2026-11-17 after explicit owner approval and owner-completed Stripe
identity verification. The key is named **cronly production checkout** and has only:

- Checkout Sessions: Write (includes Read).
- Products: Read.
- Prices: Read.

All other resources remain None, including Charges and Refunds, Payment Intents,
Customers, Payouts and Webhook Endpoints. Stripe's restricted keys apply to the
selected resource types across the shared account; they are not restricted to
cronly's product IDs. See [restricted key configuration](https://docs.stripe.com/keys/restricted-api-keys).

Stored the resulting `rk_live_…` value as `STRIPE_SECRET_KEY` in GitHub's
**production** environment through stdin. Verified its entry name/update time
without reading the value back. The private temporary credential file was
removed; no credential value was displayed or committed. Keep refunds
owner-operated in Stripe; broader runtime access is not needed for Checkout.

## Webhook (created and verified)

Created the owner-approved **cronly production payments** destination on
2026-11-17, ID `we_0Ucox4TWAgyTrTqTgzY8njcH`, and verified its Active status:

- URL: `https://cronly.org/webhooks/stripe`.
- Scope: Your account, snapshot payloads.
- API version: `2026-10-28.endive` (endpoint-specific; account default unchanged).
- Events: `checkout.session.completed` and
  `checkout.session.async_payment_succeeded`, and no others.

Enabling this destination transmits matching Checkout event payloads from the
entire shared Stripe account, including sibling-app sessions, to cronly. The
handler ignores non-cronly metadata and unpaid sessions before creating an
account or granting credit. Stored its signing secret as `STRIPE_WEBHOOK_SECRET`
in GitHub's production environment through stdin and verified the entry name and
update time. The private temporary file was removed. The existing hashbin
destination and key were not modified.

The app Worker is not deployed, so signed delivery and balance fulfillment cannot
be accepted yet. Events could fail delivery until that endpoint exists.

## Unpaid live Checkout acceptance — 2026-11-17

The restricted key successfully created a card-only, one-time live session with
the same catalog/amount fields used by the app: $5.00 credit plus $0.46 card cost,
$5.46 total. Reading its line items with expanded products confirmed both exact
product IDs, names, USD amounts and quantity one. The key then expired the
session, which remained unpaid. No card details, charge or refund were submitted.

This was a direct Stripe SDK check, not a deployed Worker or ledger test. It
confirms the current permissions support session creation, item reads and expiry
without broader write grants. [Sanitized acceptance evidence](evidence/stripe-catalog-2026-11-17.json).

## Acceptance still required

1. Complete the remaining app credentials, production deployment and legal
   approval; keep invite-only and do not open payments early.
2. Have the owner complete a real $5 credit purchase in the deployed UI. Verify
   the full $5 credit, one ledger deposit, signed delivery, repeated event
   deduplication and balance-paused job recovery. Confirm both completed and
   async-success delivery for the same session cannot credit it twice.
3. Verify the refund procedure with the owner and record deployment SHA and
   sanitized evidence in `docs/acceptance/`. No live charge or refund is claimed here.
