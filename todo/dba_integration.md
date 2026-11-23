# devicebasedauth.org integration (S5)

Written to be picked up cold. Status lives in [`STATUS.md`](../STATUS.md) row S5; the
user-facing reference is [`docs/devicebasedauth.md`](../docs/devicebasedauth.md).

## Progress

All code steps are done and tested (acceptance records
[2026-11-18](../docs/acceptance/2026-11-18.md) and [2026-11-22](../docs/acceptance/2026-11-22.md)),
at parity with hashbin S24/S25. The owner steps below and the remaining follow-ups are left.
When both are done, `git mv` this file to `done/`.

## Intent

[devicebasedauth.org](https://devicebasedauth.org) ("DBA") issues revocable, device-bound
credentials: an ES256 JWS listing what one device may do, for which site, when and where. Its
master plan §9 makes cronly the first relying party after DBA itself. cronly gains:

1. **Device-bound API keys.** A device enrolled at DBA for audience `cronly.org` calls the cronly
   API with `Authorization: DBA <credential>` plus a `DPoP: <proof>` header signed by its own key
   (the private key never leaves the device), or with a ≤ 10-minute DBA access token
   `Authorization: Bearer <token>` whose JWS header `typ` is `dba-access+jwt`.
2. **Device sessions.** `cronly:session` lets a device use the workspace's session routes.
3. **Account linking.** A signed-in cronly user links their DBA account once with an OpenID
   Connect round trip. Credentials from DBA accounts that are not linked are refused.

Existing Clerk sessions, `crk_` API keys and trigger tokens are unchanged.

## Action mapping

DBA publishes cronly's catalog from cronly's own scope list (DBA
`src/services/first-party.js`): `cronly:read`, `cronly:run`, `cronly:change`, `cronly:prose`,
`cronly:secrets:write`, plus `cronly:session`. A credential's allowed `cronly:<scope>` actions
become the request's scopes and go through the same `API_ROUTES` access checks as API keys.

**`cronly:session` is a device session** (as hashbin S25 decided): every user scope and
`SESSION` routes, but never `ACCOUNT_SESSION` ones, which mint credentials outliving the device
or move the link (`POST`/`DELETE /api/keys`, DBA link start/finish/delete). `canAccess` refuses
`ACCOUNT_SESSION` to any auth with `device_session`. It still spends as the credential.

Actions DBA must decide (step-up, gates, `limits.uses`, `require.online`, or a catalog entry
that requires gates) are `dba.online_scopes`; a route that needs one asks DBA online
(`src/auth/dba-online.js`). Grants restricted by `resources` grant nothing at authentication;
routes acting on one job decide them again with resource `job:<name>` (`dbaResource`), offline
first and online (with the resource) only when nothing cheaper allowed the route.

## Design

| Piece | Where | Notes |
|-------|-------|-------|
| Verifier | `src/vendor/devicebasedauth/` | Unmodified copy of DBA `packages/verify/src` at `829d033` (hashbin: `60aa3c3`), pinned by SHA-256 (`src/vendor/devicebasedauth.test.js`). Never edit locally. |
| Network rules | `src/auth/dba.js` | `net.client` addresses: CIDRs against `CF-Connecting-IP` inside `decide`; `dns` names of `cronly:` grants resolved first (`createDohResolver`, per issuer, per isolate) and passed as `resolved`. Latency: `DBA_RTT_SECRET` seals timed DPoP nonces (vendored `rtt.js`); `authorizeDba` answers `401 use_dpop_nonce` only when the route needs a scope a timed grant could allow, and the passing request pays one `dbaRequest` per challenge (`dba` holds a verification count). Route rules refuse. |
| Request auth | `src/auth/dba.js`, `src/auth/middleware.js` | One `createVerifier({ audience: 'cronly.org', catalog: true, replay, online })` per issuer/configuration at module scope, so JWKS, status lists and the catalog persist per isolate. `decide` sorts each `cronly:<scope>` into offline or online. DBA is tried before Clerk for `DBA …` and for `Bearer …` whose JWS header says `dba-access+jwt`. |
| Online decisions, job resources | `src/auth/dba-online.js` | `authorizeDba` tries a grant restricted to the route's `job:<name>` offline (free) before any online decision. Holds `dba_decision` (key id = credential, 60 s TTL) before `verifyOnline`; settles in full when DBA decided (status < 500), else releases. Needs `DBA_API_KEY`. |
| Replay | `DbaReplayCacheDO` (vendored `ReplayCacheDO`), binding `DBA_REPLAY` | 16 shards; each DPoP proof claimed once across isolates. |
| Revocations | `DbaRevocationsDO`, binding `DBA_REVOCATIONS`; `src/api/dba-events.js` | `POST /api/dba/events` verifies the signed event, applies it to this isolate's verifier and records each status entry until the credential expires (recorded again on redelivery: an earlier write may have failed). Isolates re-read the set every 30 s. |
| Link index | `DbaLinkDO`, binding `DBA_LINKS` | One object per DBA account: `{ account }`. Hot path of every DBA request, so per-DBA-account rather than a singleton; makes "one DBA account → at most one cronly account" an atomic claim. |
| Reverse link | `AccountDO` row `dba-link` | The confirming half: a request is accepted only when the index names the account *and* this row names the same DBA account, so an interrupted link/unlink authorizes nothing. |
| OIDC state | `AccountDO` rows `dba-oidc:<state>` | `{ state, nonce, verifier }`, 10-minute TTL, single use, at most 10 outstanding. |
| Credential rows | `AccountDO` rows `dba-key:<cid>` | DBA account, device, expiry, monthly cap, status entry, `revoked`. At most 1,000 per account; deleted on unlink or relink. |
| Budgets | `dbaKeyBudget` | The credential id is the key id: reads are metered, holds carry it, `spend_usd_per_month` is a UTC-month key budget in µ$ (rounded down). Expired, unlinked or revoked rows refuse holds (401). |
| Retries | `JobDO.checkDbaCredential` | Before a queued retry is reserved, re-check pushed revocations and the status list; a revoked credential is marked and the retry dropped. |
| CORS | `src/auth/dba-cors.js` | Any origin for `Authorization: DBA` and DPoP preflights on `/api/*` and `/mcp`; nothing for other credentials. |
| MCP | `src/index.js` | A DPoP proof is single-use and bound to `/mcp`, so the verified identity is forwarded on the in-process `Request` (`forwardAuth`, with no online scopes). |
| Routes | `API_ROUTES` | `GET /api/dba/link` (`SESSION`); link start/finish/delete (`ACCOUNT_SESSION`), rate-limited to 10 a minute; `POST /api/dba/events` (`PUBLIC`, DBA-signed). |
| UI | `frontend/js/dba.js` | Account page section; Link goes through the review dialog; `/auth/dba/callback` moves `code`/`state` out of the URL at once and posts them after sign-in. |
| Device sign-in (Stage B) | `frontend/js/device.js`, `frontend/vendor/devicebasedauth.js` | The workspace enrolls this browser for `cronly:session` with DBA's SDK v1.4.0 (vendored, SRI-pinned by test, own 64 KiB size rule) and sends every page request through `fetchWithGates`; a localStorage flag means visits without a device session never load it. The Account page hides ACCOUNT_SESSION controls. `tests/device.spec.js` stubs the SDK to check the page wiring and loads the real bundle under the CSP. |

### Prices

DBA bills cronly.org 14 µ$ per online decision and per OIDC sign-in, and verifying a credential
costs cronly 3.64 µ$. Owner decisions 2026-11-22: pass decisions on (`dbaDecision`, 56 µ$, held
first) and charge a change when a link starts. D5/D6 cover the `dbaRequest` surcharge (7 µ$)
that keeps DBA reads and runs above the floor. Details: `docs/business/pricing.md`.

## Owner steps (ops)

1. Deploy: migrations `v3` (`DbaLinkDO`) and `v4` (`DbaRevocationsDO`, `DbaReplayCacheDO`) are in
   both wrangler configs. Add all three namespaces' IDs to `CRONLY_DO_NAMESPACES` (CI variable,
   deployed as `COST_SAFETY_DO_NAMESPACES`) so the cost monitor counts them.
2. `DBA_ISSUER` is a plain `[vars]` entry (`https://devicebasedauth.org`, also the default). For
   local work, run DBA's `dev:local` on another port and set it in `wrangler.local.toml`; DBA's
   local issuer must register `http://localhost:8787/auth/dba/callback` for client `cronly.org`.
3. At devicebasedauth.org, as the cronly.org audience owner: confirm audience `cronly.org`,
   namespace `cronly`, redirect URI `https://cronly.org/auth/dba/callback`; set the revocation
   webhook to `https://cronly.org/api/dba/events` and send a test event.
4. Optional: set the `DBA_RTT_SECRET` GitHub secret (`openssl rand -hex 32`; CI pushes it) so
   grants with latency rules can be timed; without it they are refused.
5. Fund the cronly operator account at DBA (link sign-ins and online decisions are billed).
6. Optional: create a DBA API key for the cronly.org audience and set the `DBA_API_KEY` GitHub
   secret (CI pushes it) to enable online-only grants; without it they answer `online_required`.
7. Optional "Stage A" sign-in: register devicebasedauth.org as a custom OIDC provider in the
   cronly Clerk application (discovery `https://devicebasedauth.org/.well-known/openid-configuration`,
   client `cronly.org`, PKCE, scopes `openid profile`). The result is an ordinary Clerk session;
   it needs a Clerk plan with custom providers (DBA decision D7).
8. Live acceptance: link a real DBA account (100 µ$), `dba enroll --aud cronly.org --action
   cronly:read`, `dba curl https://cronly.org/api/account` and check the 28 µ$ read; revoke the
   device at DBA and confirm 401 within 30 seconds (webhook) or a minute (status list).

## Follow-ups

- Timed challenges for grants scoped to `resources` and for latency grants DBA decides online
  (verifyOnline sends no `rtt_ms`); both are refused today.
- Upstream (devicebasedauth.org `frontend/_headers`): `/sdk/:version/*` repeats the
  `Access-Control-Allow-Origin: *` that `/sdk/*` already sets, so versioned SDK files are served
  with `*, *` and browsers refuse them as cross-origin module scripts. cronly vendors the SDK, so
  it is unaffected; other sites pinning `/sdk/v1.4.0/dba.js` are not.
- Named address lists (DBA B10 N3) and relay routes: refresh the vendored verifier once DBA ships
  them, and pass `address_lists` / `route` into `decide`.
- Done since 2026-11-18: Stage B device sign-in in the workspace (2026-11-23); verifier refreshed to `829d033` with `net.client` address rules (CIDR and
  DNS, and latency by timed DPoP challenges, 2026-11-23); resource-scoped grants (`job:<name>`, 2026-11-23); retries stop for
  revoked credentials; online authorization; device sessions; webhook and shared replay cache;
  upstream fixes (OIDC caches only successful responses, per-namespace caps now computed here,
  `inflate` bounds while streaming).
