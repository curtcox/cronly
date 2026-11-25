# cronly Clerk application

A separate Clerk application from hashbin (D1), in the owner's Personal workspace.

| Resource | ID / setting |
|----------|--------------|
| Application | `app_3MEi0XGTZX7J6dgu6ezcHdRwyHA` |
| Development instance | `ins_3MEi0Uv30CGJmEgEWZFaiWzYq4V` |
| Production instance | `ins_3MEi8pmakrxmN0ExfJI0UhhAicJ` |
| Production domain | `cronly.org` |
| Frontend API | `https://clerk.cronly.org` |
| Account portal | `https://accounts.cronly.org` |
| Sign-in methods | Email verification code and Google |
| Access mode | Invite-only, saved in development and cloned into production |
| Google Cloud project | `cronly-515013` (display name `cronly`) |
| Google Cloud project number | `173186686444` |
| Production webhook | `ep_3MEtJpRdXFzpw97bEJqu8Ilr0aU` |

[Production dashboard](https://dashboard.clerk.com/apps/app_3MEi0XGTZX7J6dgu6ezcHdRwyHA/instances/ins_3MEi8pmakrxmN0ExfJI0UhhAicJ).

## Configuration

**DNS.** These CNAMEs under cronly.org are **DNS only** (one-hour TTL); Clerk reports the
Frontend API, account portal and email records verified and SSL certificates issued.

| Name under cronly.org | Target |
|----------------------|--------|
| `clerk` | `frontend-api.clerk.services` |
| `accounts` | `accounts.clerk.services` |
| `clkmail` | `mail.z21oo75092ul.clerk.services` |
| `clk._domainkey` | `dkim1.z21oo75092ul.clerk.services` |
| `clk2._domainkey` | `dkim2.z21oo75092ul.clerk.services` |

**Credentials.** `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` and `CLERK_WEBHOOK_SECRET` (the
production webhook's signing secret) are in the `curtcox/cronly` GitHub `production`
environment; CI pushes them to the Worker. None are in this repository or shared with hashbin.

**Webhook.** `ep_3MEtJpRdXFzpw97bEJqu8Ilr0aU` posts `user.created` and `user.updated` to
`https://cronly.org/webhooks/clerk`. The handler verifies the Svix signature before
initializing the AccountDO. No delivery has happened yet (nobody has signed in).

**Google.** Dedicated Google Cloud project `cronly-515013`, separate from hashbin, with OAuth
configuration `cronly` (support and developer contact `support@cronly.org`; see
[support email](support-email.md)) and web client **cronly production Clerk** (origin
`https://cronly.org`, callback `https://clerk.cronly.org/v1/oauth_callback`). Its client ID and
secret live only in Clerk's production Google connection, which keeps only `openid`, email and
profile scopes. The audience is **External / Testing** with no test users; **Publish app** stays
disabled until branding has the home page, approved policy links and authorized domains. The
support identity holds only OAuth Config Editor on the project; no further IAM roles were granted.

**Server.** Sessions are verified with `authorizedParties` restricted to `APP_ORIGIN`
(`https://cronly.org` in production).

**Browser.** `frontend/js/app.js` loads `@clerk/clerk-js@6` and its separate sign-in UI
`@clerk/ui@1` from the Clerk frontend domain and passes the UI constructor to `Clerk.load()`
(Clerk refuses sign-in from clerk-js v5). The modal uses `fallbackRedirectUrl`. The CSP allows
`worker-src 'self' blob:` as [Clerk's CSP guide](https://clerk.com/docs/guides/secure/best-practices/csp-headers)
requires, and the deploy's browser check fails on any CSP violation while it opens the
sign-in form (email field and Google option), without submitting credentials.

## Remaining

1. Complete Google branding with the live home page and approved policies, verify `cronly.org`
   as Google requires and publish the consent screen. Until then, authorize the owner's test
   identity explicitly to test Google sign-in.
2. Invite the owner in the production instance, sign in with email and with Google, and record
   the Clerk user ID as GitHub secret `JS_ACCEPTANCE_ACCOUNT`.
3. Confirm signed `user.created` / `user.updated` deliveries and AccountDO initialization.
4. Keep Invite-only until launch approval.
