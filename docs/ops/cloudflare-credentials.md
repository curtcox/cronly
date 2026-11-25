# Cloudflare production credentials

Two independent user API tokens, stored in `curtcox/cronly`'s GitHub `production`
environment. Neither is shared with hashbin.

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

Only credential metadata belongs in the repository; set values with `gh secret set`
through stdin. The deploy token has deployed the Worker, its custom domain and its
Durable Object migrations.

## Cost-monitor query

The monitor reads SQLite Durable Object storage from `durableObjectsSqlStorageGroups`
(`durableObjectsStorageGroups` rejects `namespaceId_in`), grouped by `namespaceId` before
adding each namespace's peak bytes, plus invocation and periodic datasets filtered to the
`cronly` script and its namespaces. The query was validated against the live schema
(HTTP 200, no GraphQL errors): [evidence](evidence/cloudflare-analytics-schema-2026-11-17.json).

The namespaces come from GitHub variable `CRONLY_DO_NAMESPACES`, deployed as
`COST_SAFETY_DO_NAMESPACES`. It must list all six cronly namespaces; today it holds the three
original ones (`AccountDO`, `JobDO`, `SafetyDO`) and the three DBA namespaces still need adding
(STATUS S5). A first monitor run on real usage is still pending (STATUS L12); see
[launch](launch.md#live-acceptance-before-opening-to-others).

References: [Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/),
[Analytics token permissions](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/).
