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
| Production webhook | `ep_3MEtJpRdXFzpw97bEJqu8Ilr0aU` |

[Production dashboard](https://dashboard.clerk.com/apps/app_3MEi0XGTZX7J6dgu6ezcHdRwyHA/instances/ins_3MEi8pmakrxmN0ExfJI0UhhAicJ).
The owner explicitly selected Email and Google. The production Google connection
now has its dedicated OAuth credentials saved and Clerk lists it as **Used for
sign-in**, without the previous setup warning. Google publication and an actual
sign-in remain unverified.

## Completed configuration

The owner approved Cloudflare's one-time Domain Connect authorization. All five
CNAME records below were added as **DNS only**, with a one-hour TTL, and Clerk
reported the Frontend API, account portal and all three email records **Verified**.
Clerk subsequently reported **SSL Certificates Issued** on 2026-11-17.
Both subdomains passed normal HTTPS certificate verification again after webhook
setup; the Frontend API root returned 200 and the account portal root returned
403. Successful portal/sign-in acceptance has not been claimed.

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

With explicit owner approval, created the production webhook
`ep_3MEtJpRdXFzpw97bEJqu8Ilr0aU` for
`https://cronly.org/webhooks/clerk`, subscribing only to `user.created` and
`user.updated`. Its description is `cronly production account synchronization`.
The endpoint is persisted in Clerk's webhook list. Its independent signing secret
was transferred privately through stdin into `CLERK_WEBHOOK_SECRET` in GitHub's
`production` environment; the secret entry's name and update timestamp were
verified and the private temporary file was deleted. No delivery attempts exist
yet. The app Worker must be deployed before testing signed delivery and AccountDO
initialization; webhook creation alone does not verify that integration.

The owner requested a dedicated Google Cloud project and separately approved its
link to the selected existing billing account. Project `cronly-515013` was created
on 2026-11-17. The owner requested `support@cronly.org`, now provisioned as an
incoming forwarding address, and completed its Google account registration.
The authenticated support identity was verified in the browser. The owner approved
and saved its OAuth Config Editor role grant on the dedicated project, then
completed fresh Google Cloud password verification directly.

With explicit owner approval of Google's API Services User Data Policy, created
the OAuth configuration named `cronly`, using `support@cronly.org` for both
user support and developer notices. Created the web client **cronly production
Clerk** with origin `https://cronly.org` and callback
`https://clerk.cronly.org/v1/oauth_callback`. Its client ID and secret were
transferred privately into Clerk's production Google connection and saved;
the connection list confirms **Used for sign-in**. Clerk retains only `openid`,
email and profile scopes. Credentials are not recorded in this repository.

The support identity's OAuth Config Editor role does not provide the console's
additional `serviceusage.quotas.get` or `iam.serviceAccounts.list` permissions.
Branding was configured as the support identity; the existing project owner
created the client. No additional IAM roles were granted to work around the
console's permission checks.

Google's audience is **External / Testing**, with no test users. **Publish app**
is disabled until branding configuration is complete. The home page, privacy
policy, Terms links and authorized domains are still empty; the app Worker and
approved legal pages must be available before completing public launch branding.
No OAuth publication, brand/domain verification or successful sign-in is claimed.
See [support email and Google identity](support-email.md).
The project is separate from hashbin.

## Remaining integration

1. Complete Google branding with the live home page and approved public policies,
   register/verify `cronly.org` as required, and confirm consent-screen publication
   in the selected Google project. If testing before publication, authorize the
   owner's test identity explicitly. Retain only the identity scopes Clerk requests
   (`openid`, email, profile); the dedicated client credentials are already saved
   only in Clerk's Google connection settings.
2. Deploy the app Worker, then verify signed `user.created` / `user.updated`
   delivery and AccountDO initialization using the registered production webhook.
3. Invite the owner to the production application when ready to sign in. No
   application user or invitation has been created by this setup. Record the
   resulting Clerk user ID as `JS_ACCEPTANCE_ACCOUNT` for full service acceptance.
4. Deploy the app with live credentials, run `npm run verify:production` and test
   both email and Google sign-in. Keep Invite-only access until launch approval.

The server already verifies Clerk sessions with `authorizedParties` restricted to
`APP_ORIGIN` (`https://cronly.org` in production). The webhook handler verifies
Svix signatures before initializing an AccountDO. Creating this application and
verifying its DNS do not complete these deployed-service acceptance checks.
