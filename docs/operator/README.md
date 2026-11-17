# Operator profile snapshot (D7, L13)

The owner approved placeholders on 2026-11-16. `profile.json` is the offline snapshot
for cronly's marked legal-page fields. Unknown facts and the shared repository's
location/revision remain `null`; the generated pages display bracketed placeholders.
Do not substitute example businesses, suggested jurisdictions or guessed mailboxes.
The owner-confirmed `support@cronly.org` address was provisioned on 2026-11-17;
its [routing configuration](../ops/support-email.md) is tracked separately. The
privacy contact and common operator facts remain unknown.

`profile.schema_version` is 1. `profile.operator` contains the common legal name,
postal address, governing jurisdiction and dispute venue with no per-app overrides.
`profile.apps` contains separate support/privacy email addresses for each app.
The script validates the supported fields and rejects additional operator/contact
fields. Include only facts approved for publication, never credentials, private
financial identifiers or private addresses.

When the shared repository is selected, copy its `operator.json` into the snapshot's
`profile` field and record its HTTPS repository URL and exact 40-character commit in
`source.repository` and `source.revision`. Both provenance fields are unknown together
or pinned together. Review that the profile exactly matches that source revision;
the offline validator checks shape and pin format, not the remote contents. No build,
deployment or page rendering retrieves mutable remote data. Automated remote sync
and hashbin adoption remain pending selection of the shared repository.

Run `npm run legal:generate` after updating the snapshot. The command escapes facts
before inserting them into marked spans in Terms and Privacy. It does not alter the
policy text, effective dates, legal-review notes or draft markers. `npm run legal:check`
checks drift offline; the same drift check runs in the test suite. Commit the snapshot
and generated pages together.

`node scripts/operator-profile.mjs --require-complete` also requires pinned provenance
and all six cronly facts. Unknown hashbin email contacts do not block cronly. The
production deployment runs this check when `CRONLY_LAUNCH_APPROVED=true`; local work
and prelaunch acceptance deployments can retain placeholders. Passing this check
does not establish legal approval: the owner still approves service-specific policy
text and replaces the draft markers and effective dates separately.
