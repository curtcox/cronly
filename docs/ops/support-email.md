# cronly support email

The owner requested `support@cronly.org` on 2026-11-17 and explicitly selected
forwarding to the owner's already verified Gmail destination in Cloudflare.
The private forwarding destination is maintained in Cloudflare's account settings.

## Provisioned configuration

- Provider: Cloudflare Email Routing for `cronly.org`.
- Rule: `0f8f8ad954a040079de4d18c907b373b`, named `cronly support forwarding`.
- Matcher: exact `to` address `support@cronly.org`; enabled forward action.
- The existing disabled catch-all rule was preserved.
- Cloudflare reports routing enabled, `ready` and synchronized. The destination
  was already verified; no new destination-verification message was necessary.
- Authoritative DNS confirms these MX records:

| Priority | Mail exchange |
|----------|---------------|
| 25 | `route1.mx.cloudflare.net` |
| 49 | `route3.mx.cloudflare.net` |
| 94 | `route2.mx.cloudflare.net` |

The root SPF record is `v=spf1 include:_spf.mx.cloudflare.net ~all`.
Cloudflare installed its email-authentication records. The earlier Clerk
authentication/email CNAME records remain separate.

This is an incoming forwarding address. An outbound SMTP identity, Gmail
"Send mail as" configuration and a separate mailbox login were not provisioned.
No test email was sent. Send a message from another account and confirm receipt
at the destination before claiming end-to-end delivery acceptance.

The owner-confirmed public address is included in the offline operator snapshot
and generated Terms draft. The privacy contact, common operator facts, source
provenance and policy approval remain unresolved.

## Google OAuth support identity

Google's OAuth support-email selector requires either the currently signed-in
Google account address or a Google Group managed by that user. A standalone
forwarding address does not appear automatically.

To use `support@cronly.org`, the owner can register a Google account **using this
existing email address**, without creating a Gmail mailbox. The owner must
complete personal details, email verification, password and terms steps. Then
arrange the necessary access to `cronly-515013` and configure OAuth while signed
in with that account. No Google account or project access grant was created by
this email provisioning step.

References: [Google's support-email requirements](https://support.google.com/cloud/answer/15549049?hl=en),
[using an existing address for a Google account](https://support.google.com/accounts/answer/27441?hl=en#existingemail),
[Cloudflare routing setup](https://developers.cloudflare.com/email-service/get-started/route-emails/).
