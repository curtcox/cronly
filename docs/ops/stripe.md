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

## Restricted runtime key (prepared, not created)

The staged key is named **cronly production checkout**. It has only:

- Checkout Sessions: Write (includes Read).
- Products: Read.
- Prices: Read.

All other resources remain None, including Charges and Refunds, Payment Intents,
Customers, Payouts and Webhook Endpoints. Stripe's restricted keys apply to the
selected resource types across the shared account; they are not restricted to
cronly's product IDs. See [restricted key configuration](https://docs.stripe.com/keys/restricted-api-keys).

Creation requires the owner's action-time approval. Store the resulting
`rk_live_…` value as `STRIPE_SECRET_KEY` in GitHub's **production** environment
through stdin, without displaying it or committing a local credential file.
Keep refunds owner-operated in Stripe. Validate Checkout creation and inspect
permission errors before adding any broader access; no real payment is needed
to validate an unpaid session.

## Webhook (prepared, not created)

The draft destination is **cronly production payments**:

- URL: `https://cronly.org/webhooks/stripe`.
- Scope: Your account, snapshot payloads.
- API version: `2026-10-28.endive` (endpoint-specific; account default unchanged).
- Events: `checkout.session.completed` and
  `checkout.session.async_payment_succeeded`, and no others.

Enabling this destination transmits matching Checkout event payloads from the
entire shared Stripe account, including sibling-app sessions, to cronly. The
handler ignores non-cronly metadata and unpaid sessions before creating an
account or granting credit. Creating the destination requires owner approval.
Save its signing secret as `STRIPE_WEBHOOK_SECRET` in GitHub's production
environment through stdin. The existing hashbin destination stays unchanged.

The app Worker is not deployed, so signed delivery and balance fulfillment cannot
be accepted yet. Events could fail delivery until that endpoint exists.

## Acceptance still required

1. Approve/create the restricted key and webhook; securely store both secrets.
2. Validate the restricted key's exact Checkout request, product selection and
   itemized amounts. A $5 credit quotes $5.46 total under the current gross-up.
3. Complete the remaining app credentials, production deployment and legal
   approval; keep invite-only and do not open payments early.
4. Have the owner complete a real $5 credit purchase in the deployed UI. Verify
   the full $5 credit, one ledger deposit, signed delivery, repeated event
   deduplication and balance-paused job recovery. Confirm both completed and
   async-success delivery for the same session cannot credit it twice.
5. Verify the refund procedure with the owner and record deployment SHA and
   sanitized evidence in STATUS.md. No live charge or refund is claimed here.
