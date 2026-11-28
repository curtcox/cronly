# devicebasedauth.org credentials

[devicebasedauth.org](https://devicebasedauth.org) ("DBA") issues device-bound credentials:
the private key is generated on the device and never leaves it, and the credential lists what
that device may do, for which site, when and where. cronly accepts them instead of API keys,
and as a device session. Design, owner steps and open items:
[`todo/dba_integration.md`](../todo/dba_integration.md) (STATUS S5). Modeled on hashbin's
`docs/devicebasedauth.md`.

## Using one

1. Link your DBA account once, signed in to cronly: **Account → devicebasedauth.org → Link**.
   Starting a link is charged as one change (the review dialog shows the price); finishing and
   unlinking are free. One DBA account links to at most one cronly account; credentials from
   unlinked DBA accounts get `403 account_not_linked`.
2. Create a credential for audience `cronly.org` at DBA, granting the cronly scopes it needs as
   actions named `cronly:<scope>`, e.g. `dba enroll --aud cronly.org --action cronly:run`.
3. Send it with a fresh DPoP proof per request: `Authorization: DBA <credential>` and
   `DPoP: <proof>` (DBA's SDK and CLI do this). A credential with periodic confirmation also
   sends `DBA-Confirmation: <confirmation>`.

Short-lived DBA access tokens (`dba token --aud cronly.org`) are accepted as
`Authorization: Bearer <token>` (JWS `typ` `dba-access+jwt`), with the same grants and no
device binding. Any other bearer token is still a Clerk session.

## What a credential may do

- **Scopes.** Each `cronly:<scope>` action (`read`, `run`, `change`, `prose`, `secrets:write`)
  its grants allow right now (time windows, places, expiry, confirmation) is a scope it holds,
  checked against `API_ROUTES` exactly like an API key's.
- **Job resources.** A grant limited by `resources` (`["job:nightly-*"]`, `["job:backup"]`)
  applies only to routes acting on one job, decided with that job as the resource:
  `GET`/`PUT`/`DELETE /api/jobs/<name>`, `POST /api/jobs/<name>/run`, `pause`, `resume`,
  `/api/jobs/<name>/triggers…`, and `GET /api/runs?job=<name>`. Everywhere else (the account,
  unfiltered runs, actions, action tests, run details, MCP) it grants nothing. Its other
  constraints still apply; one that needs DBA online is asked with the resource, and only after
  a free offline grant and an unrestricted online one have had their turn.
- **Network rules** (`net.client`, credential vocabulary 2). Address rules match the peer
  address Cloudflare reports (`CF-Connecting-IP`): `cidrs` directly, and `dns` names after
  cronly resolves them over DNS-over-HTTPS (1.1.1.1, cached 30–300 s per isolate; `dnssec: true`
  needs a validated answer). A name that does not resolve matches nothing. Named address lists
  are not published by DBA yet, so they match nothing either. **Latency** rules (`max_rtt_ms`,
  `samples`, `reuse_s`) are timed with a challenge: when a route needs a scope only such a grant
  could allow, cronly answers `401 use_dpop_nonce` with a `DPoP-Nonce` header (also in the body
  as `dpop_nonce`), and the device retries at once with a proof carrying it; the round trip is
  the measured latency. DBA's CLI and browser SDK answer by themselves. A nonce is good for 10
  seconds, only for the key and address it was sent to; `samples` allows that many tries, the
  best counting; a pass is reused for `reuse_s` seconds from the same key and address. Each
  challenge answered adds one `dbaRequest` to the read or run that finally passes; abandoned
  challenges cost nothing. Grants scoped to `resources`, and grants that also need DBA online,
  are not challenged. Route rules need relays, so they are refused. `net.server` is the
  device's own check of cronly and is ignored here.
- **Device session.** `cronly:session` makes the credential a session: every scope, and the
  `SESSION` routes (key list, Checkout, link status). It never reaches `ACCOUNT_SESSION` routes,
  which mint credentials outliving the device or move the link: create or revoke API keys,
  start, finish or remove the DBA link. Those answer `403 insufficient_scope`.
- **Spending.** The credential id (`crd_…`) is the request's key id, so reads are metered and
  every hold and charge counts against the credential. The tightest
  `limits.spend_usd_per_month` among its `cronly:` grants becomes its UTC-month cap in µ$
  (rounded down); refusals are `402 key_budget_month`. Device sessions spend the same way.
- **Retries** a credential's runs queued re-check it before they are reserved: unlinked,
  expired or revoked (status list or webhook) credentials have their retries dropped.

## Grants that need DBA online

Grants with `require.step_up`, `require.gates`, `require.online` or `limits.uses`, and actions
whose cronly.org catalog entry requires gates (`{ action, gates: { require: true } }`), can only
be decided by DBA. When a route needs such a scope, cronly holds one `dba_decision` price under
the credential's cap, then asks DBA (`POST /api/v1/authorize`, which DBA bills to cronly.org):

| Answer | Means | Charged |
|---|---|---|
| The route runs | DBA allowed it; the response's `cost_microdollars` includes the decision | decision + route |
| `403 gate_pending` with `gate_request` | The grant's gates have not approved yet. Retry with a fresh proof (DBA's `fetchWithGates()` and `dba curl --dba-wait` do this) | decision |
| `403 dba_denied` with `dba_code` and `reasons` | DBA refused | decision |
| `401 invalid_auth` with `dba_code` | DBA refused the credential itself | decision |
| `503 dba_unavailable` | DBA could not decide (5xx, 429, other 4xx, unfunded operator account, unreachable) | nothing |
| `403 online_decision_required` | A dry run needed an online decision; dry runs never ask DBA | nothing |
| `403 online_required` | cronly has no `DBA_API_KEY`, so these grants cannot be used | nothing |
| `402 key_budget_month` | The decision would pass the credential's cap; DBA is not asked | nothing |

Only the scope the route needs is checked online; scopes allowed offline never are, and
`ACCOUNT_SESSION` routes never ask for a session.

## Revocation

cronly verifies credentials offline with DBA's keys, status lists and the cronly.org action
catalog (each cached per isolate). DBA also pushes revocations to `POST /api/dba/events`
(signed `dba-event+jwt`, spec/events.md at DBA); they are recorded in `DbaRevocationsDO` and
every isolate picks them up within 30 seconds. If DBA's keys, status lists or catalog cannot be
fetched, verification fails closed with `503`. Each DPoP proof is accepted once across all
isolates (`DbaReplayCacheDO`).

## Signing in to the workspace with a device

The workspace (`/app.html`) offers **Sign in with devicebasedauth.org** beside the regular
sign-in. It enrolls this browser for audience `cronly.org` with a `cronly:session` grant; DBA's
approval page (a popup) lets the account owner approve, narrow or extend it. The key is a
non-extractable WebCrypto key in cronly.org's IndexedDB; every page request carries a fresh
DPoP proof, answers DPoP nonce challenges and waits while gates decide (DBA's SDK
`fetchWithGates`). Later visits reuse the saved credential and renew it at two thirds of its life;
**Sign out** deletes the key. The DBA account must already be linked (Account, from a regular
sign-in).

- **It is a device session**, so the Account page leaves out what those never reach: creating or
  revoking API keys and linking or unlinking DBA. It shows the signed-in device instead.
- **It is metered like an API key**: each read the workspace makes is a read plus `dbaRequest`
  (28 µ$ today), and a page view makes several. Regular sign-ins read for free.
- **The SDK** is DBA's released v1.4.0 bundle, vendored unmodified at
  `frontend/vendor/devicebasedauth.js` and pinned by its SRI hash
  (`src/vendor/devicebasedauth.test.js`). It is served from cronly's own origin and loaded only
  when a device session is in use or offered, so the workspace never depends on
  devicebasedauth.org serving it.

## Browser apps on any site

API and `/mcp` calls carrying `Authorization: DBA` get `Access-Control-Allow-Origin: *` (no
cookies; the key cannot be exported from the page that holds it). Preflights on `/api/` and
`/mcp` that ask to send `DPoP` are allowed from any origin. Clerk sessions, API keys and DBA
bearer access tokens get no CORS.

## Routes

| Route | Access | Does |
|---|---|---|
| `GET /api/dba/link` | session | `{ linked, dba_account, linked_at, superseded, credentials }` |
| `POST /api/dba/link/start` | account session | `{ url }`: send the browser there; DBA returns it to `/auth/dba/callback`. Charged as a change; `?dry_run=1` quotes it |
| `POST /api/dba/link/finish` | account session | Body `{ code, state }` from the callback. `409 dba_account_linked` if another cronly account holds the DBA account |
| `DELETE /api/dba/link` | account session | Unlink; that DBA account's credentials stop working here at once |
| `POST /api/dba/events` | public (DBA-signed) | DBA's revocation webhook; `204` when applied, `400 invalid_event` otherwise |

"Session" is the account's own sign-in or a device session; "account session" is the
account's own sign-in only.

## Errors

| Code | Status | Means |
|---|---|---|
| `proof_required`, `invalid_proof`, `stale_proof`, `key_mismatch`, `replayed_proof` | 401 | Missing, wrong, stale or replayed DPoP proof |
| `revoked`, `expired`, `wrong_audience`, `invalid_signature` | 401 | The credential itself is not acceptable here |
| `invalid_auth` | 401 | Revoked, expired or unlinked when a hold or queued retry re-checked it |
| `account_not_linked` | 403 | The credential's DBA account (`dba_account`) is not linked |
| `jwks_unavailable`, `status_unavailable`, `catalog_unavailable`, `dba_unavailable` | 503 | DBA could not be reached; nothing was charged for verification |
| `gate_pending`, `dba_denied`, `online_required` | 403 | See "Grants that need DBA online" |
| `use_dpop_nonce` | 401 | A latency rule needs a timed retry: resend at once with a proof carrying `DPoP-Nonce` |

## Prices

See [`docs/business/pricing.md`](business/pricing.md): reads and first-attempt runs by a DBA
caller add `dbaRequest` (7 µ$) for verifying the credential, once more per timed challenge
answered (at most 5); an online decision is `dbaDecision`
(58 µ$); starting a link is a change (100 µ$).

## Operating it

- `DBA_ISSUER` (variable, optional): the issuer, default `https://devicebasedauth.org`. Local
  mode also accepts `http://localhost…`.
- `DBA_API_KEY` (secret, optional, pushed by CI): a DBA API key of the cronly.org audience owner,
  for online decisions. Without it, online-only grants answer `online_required`.
- `DBA_RTT_SECRET` (secret, optional, pushed by CI): at least 32 random characters, sealing timed
  DPoP nonces for latency rules. Without it, grants with `net.client.latency` are refused.
- At DBA, as the cronly.org audience owner: register `https://cronly.org/auth/dba/callback` for
  client `cronly.org`, and set the revocation webhook to `https://cronly.org/api/dba/events`
  (`PATCH /api/v1/audiences/cronly.org` with `{"revocation_webhook": …}`; test it with
  `POST /api/v1/audiences/cronly.org/webhook-test`). Fund the operator account: DBA bills each
  link sign-in and online decision.
- Durable Objects (migration `v4` adds the last two): `DBA_LINKS` (`DbaLinkDO`),
  `DBA_REVOCATIONS` (`DbaRevocationsDO`) and `DBA_REPLAY` (`DbaReplayCacheDO`). List all three
  in `CRONLY_DO_NAMESPACES` so the cost monitor counts them.
