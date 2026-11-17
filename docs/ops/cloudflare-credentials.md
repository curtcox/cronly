# Cloudflare production credentials

The owner approved two independent user API tokens on 2026-11-17 and their
storage in `curtcox/cronly`'s GitHub `production` environment. Neither token
reuses hashbin credentials. Both tokens verified as active through Cloudflare's
API and are listed as active in the dashboard.

| Token name | GitHub secret | Permissions / scope |
|------------|---------------|---------------------|
| cronly production deploy | `CLOUDFLARE_API_TOKEN` | Workers Scripts Edit, Queues Edit and Account Settings Read on account `3fe46716ab4b27b1a21590ed3a0a7477`; Workers Routes Edit and Zone Read only on `cronly.org` (`d8a630794aadb447bc892168d5f6819a`) |
| cronly cost monitoring | `CLOUDFLARE_ANALYTICS_TOKEN` | Account Analytics Read on the same account |

Both expire **February 15, 2027 at 23:59:59 America/Chicago**
(`2027-02-16T05:59:59Z`). Rotate before expiration and update the corresponding
GitHub environment secret. The analytics token is deployed to the app Worker by
CI; rotate that binding by redeploying as well. Expired or missing analytics
credentials cause the cost monitor to keep the execution brake active.

The approved account permissions cover other Workers/Queues or analytics in this
shared account, including hashbin. Zone permissions are limited to cronly.org.
The default template's KV/R2 and user-level permissions were removed. Do not use
these tokens to modify sibling applications.

Values were transferred privately through stdin to `gh secret set`; GitHub entry
names/update timestamps were verified and private temporary files were removed.
Only credential metadata belongs in the repository. The deployment token passed
read checks for the exact cronly zone and existing `cronly-runs` queue; write
permissions still need the real deployment acceptance.

## Analytics acceptance

A live request using the production cost-monitor query and only the `cronly`
script plus a synthetic namespace filter reached Cloudflare's GraphQL API, but
it was rejected: `durableObjectsStorageGroups` does not accept `namespaceId_in`.
No other application's usage was requested. Live introspection identified
`durableObjectsSqlStorageGroups` for cronly's SQLite-backed namespaces, with the
required `namespaceId_in` filter. The production query now uses that dataset and
groups by `namespaceId` before adding each namespace's peak bytes. The corrected
query returned HTTP 200 with no GraphQL errors and empty datasets on 2026-11-17.
Invocation/periodic namespace filters, prices and the fail-closed brake are unchanged.
See [sanitized schema and query evidence](evidence/cloudflare-analytics-schema-2026-11-17.json).

The app Worker and its three SQLite Durable Object namespaces were deployed on
2026-11-17. Their IDs are recorded in GitHub's `CRONLY_DO_NAMESPACES` variable and
must be bound on the next deployment. Schema validation alone cannot verify actual
usage measurements or cost reconciliation; the first live monitor remains pending.
See [launch procedure](launch.md) and STATUS L12/L14.

References: [Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/),
[Analytics token permissions](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/).
