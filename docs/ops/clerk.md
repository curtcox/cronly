# cronly Clerk application

Created in the owner's existing Personal workspace on 2026-11-17. This is a
separate application from hashbin, as approved in STATUS D1.

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

[Production dashboard](https://dashboard.clerk.com/apps/app_3MEi0XGTZX7J6dgu6ezcHdRwyHA/instances/ins_3MEi8pmakrxmN0ExfJI0UhhAicJ).
The owner explicitly selected Email and Google. Google's production connection
is enabled but still requires custom OAuth credentials; enabling the provider
alone does not establish a working production Google sign-in.

## Completed configuration

The owner approved Cloudflare's one-time Domain Connect authorization. All five
CNAME records below were added as **DNS only**, with a one-hour TTL, and Clerk
reported the Frontend API, account portal and all three email records **Verified**.
Certificate issuance follows DNS verification and must be checked before live use.
Both subdomains passed normal HTTPS certificate verification during setup; the
Frontend API root returned 200 and the account portal root returned 403. Clerk's
dashboard still showed certificate issuance in progress. Successful portal/sign-in
acceptance has not been claimed.

| Name under cronly.org | Target |
|----------------------|--------|
| `clerk` | `frontend-api.clerk.services` |
| `accounts` | `accounts.clerk.services` |
| `clkmail` | `mail.z21oo75092ul.clerk.services` |
| `clk._domainkey` | `dkim1.z21oo75092ul.clerk.services` |
| `clk2._domainkey` | `dkim2.z21oo75092ul.clerk.services` |

With the owner's explicit approval, the production `CLERK_SECRET_KEY` and
`CLERK_PUBLISHABLE_KEY` were stored in the `curtcox/cronly` GitHub `production`
environment. Secret values were passed through stdin and the private temporary
file was deleted. Keys are not checked into this repository. No hashbin
credentials were reused. Deployments and launch approval remain disabled.

The owner requested a dedicated Google Cloud project and separately approved its
link to the selected existing billing account. Project `cronly-515013` was created
on 2026-11-17. Google Auth Platform configuration is in progress; its required
support/developer contacts and consent configuration need owner input before an
OAuth client can be created. The project is separate from hashbin.

## Remaining integration

1. Configure the production Google connection with a Google Cloud OAuth web
   client. Use authorized origin `https://cronly.org` and the exact callback
   `https://clerk.cronly.org/v1/oauth_callback`; retain only the identity scopes
   Clerk requests (`openid`, email, profile). Confirm consent-screen publication
   and domain verification in the selected Google project. Store its client secret
   only in Clerk's Google connection settings.
2. Verify issued certificates and HTTPS on both Clerk subdomains.
3. Register `https://cronly.org/webhooks/clerk` for `user.created` and `user.updated`.
   Store its signing secret as `CLERK_WEBHOOK_SECRET` in GitHub's production
   environment, then verify a signed delivery after deploying the app Worker.
4. Invite the owner to the production application when ready to sign in. No
   application user or invitation has been created by this setup. Record the
   resulting Clerk user ID as `JS_ACCEPTANCE_ACCOUNT` for full service acceptance.
5. Deploy the app with live credentials, run `npm run verify:production` and test
   both email and Google sign-in. Keep Invite-only access until launch approval.

The server already verifies Clerk sessions with `authorizedParties` restricted to
`APP_ORIGIN` (`https://cronly.org` in production). The webhook handler verifies
Svix signatures before initializing an AccountDO. Creating this application and
verifying its DNS do not complete these deployed-service acceptance checks.
