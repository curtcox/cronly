# Shared operator profile (D7, L13)

## Intent

The owner said on 2026-11-16 to reuse hashbin.org's legal entity and jurisdiction for
cronly, with separate email contacts, and suggested a shared home for this information
as more apps are added. Prefer a small dedicated repository containing public business
facts. The repository location and outstanding facts are pending owner input.

## What has been verified

Checked both the sibling checkout and current GitHub `main` on 2026-11-16. The local
checkout is behind its remote-tracking branch, so use current remote sources when
resolving the remaining details:

- [Hashbin STATUS L21](https://github.com/curtcox/hashbin.org/blob/main/STATUS.md)
  still marks entity formation as not started. Its recommendation is a Missouri
  single-member LLC, not a confirmed registered entity.
- [Terms](https://github.com/curtcox/hashbin.org/blob/main/frontend/terms.html)
  still contain `[LEGAL ENTITY NAME]`, `[POSTAL ADDRESS]`, `[JURISDICTION]` and `[VENUE]`.
  No exact entity name or selected governing law/venue can be copied yet.
- [Privacy](https://github.com/curtcox/hashbin.org/blob/main/frontend/privacy.html)
  and the [legal checklist](https://github.com/curtcox/hashbin.org/blob/main/docs/legal-review.md)
  also retain identity and contact placeholders.
- The business notes' example name “HashBin LLC” is not evidence of registration.
  Do not turn that example or the Missouri recommendation into confirmed legal facts.

Keep cronly's corresponding placeholders until the shared facts are supplied. Existing
approval to use the same operating entity (D1) does not establish that entity's name.

## Proposed source format

Keep only intended public facts in `operator.json`. Use explicit nulls for unknowns:

```json
{
  "schema_version": 1,
  "operator": {
    "legal_name": null,
    "postal_address": null,
    "governing_jurisdiction": null,
    "dispute_venue": null
  },
  "apps": {
    "hashbin.org": { "support_email": null, "privacy_email": null },
    "cronly.org": { "support_email": null, "privacy_email": null }
  }
}
```

The operator fields have no per-app overrides: changing them changes the common
identity for every consumer. Email addresses are app-specific. Do not invent working
mailboxes by substituting the domain in an existing address.

Credentials, account IDs, EINs, private addresses not approved for publication and
financial records do not belong here. Service behavior, refund rules, liability terms,
policy approvals and effective dates stay in each app's own repo.

## Adoption steps

1. Confirm the source repository and populate only owner-confirmed facts. Add a small
   schema and usage instructions so subsequent apps can use the same profile.
2. Each app pins an exact source commit and checks in a snapshot with its provenance.
   Updates are explicit reviewed commits; deployment and page rendering must not depend
   on fetching a mutable branch or a live shared service.
3. A maintenance script inserts escaped profile values into marked sections of static
   legal HTML. It preserves draft markers and unresolved placeholders and does not
   change policy approval or the production launch gate.
4. CI checks that generated sections match the pinned snapshot. The ordinary check is
   offline; an explicit sync command retrieves a newer profile. Missing required facts
   remain visible in launch checks without preventing local development of drafts.
5. Adopt it in both hashbin and cronly. Prepare hashbin changes separately: its `main`
   deploys automatically, so cronly's push authorization must not trigger an unrelated
   hashbin production deployment.

## Completion criteria

Both apps render shared identity fields from the same pinned profile revision; app
contacts remain separate; a profile update has a repeatable sync/review path; unknown
facts cannot silently become effective policies. L13 still needs the actual identity,
working cronly contacts and owner approval of its service-specific legal drafts.
