# cronly support email

`support@cronly.org` forwards to the owner's verified Gmail destination, kept private in
Cloudflare's account settings.

## Provisioned configuration

- Provider: Cloudflare Email Routing for `cronly.org`.
- Rule: `0f8f8ad954a040079de4d18c907b373b`, named `cronly support forwarding`.
- Matcher: exact `to` address `support@cronly.org`; enabled forward action.
- The existing disabled catch-all rule was preserved.
- Cloudflare reports routing enabled, `ready` and synchronized.
- Authoritative DNS confirms these MX records:

| Priority | Mail exchange |
|----------|---------------|
| 25 | `route1.mx.cloudflare.net` |
| 49 | `route3.mx.cloudflare.net` |
| 94 | `route2.mx.cloudflare.net` |

The root SPF record is `v=spf1 include:_spf.mx.cloudflare.net ~all`.
Cloudflare installed its email-authentication records; Clerk's email CNAMEs are separate.

It is incoming forwarding only: there is no outbound SMTP identity, Gmail "Send mail as" or
separate mailbox. End-to-end delivery is unverified; send a message from another account and
confirm it arrives.

The address is in the offline operator snapshot and the generated Terms draft. The privacy
contact is still unset (STATUS D7, L13).

## Google OAuth support identity

Google's OAuth support-email selector only offers the signed-in Google account or a Google Group
it manages, so `support@cronly.org` is registered as a Google account on this existing address
(no Gmail mailbox). That identity holds `OAuth Config Editor` (`roles/oauthconfig.editor`) on
project `cronly-515013`, which permits OAuth configuration and client management; the original
project owner keeps Owner. OAuth branding uses it for user support and developer notices. See
[Clerk](clerk.md) for the Google client and what publication still needs.

References: [Google's support-email requirements](https://support.google.com/cloud/answer/15549049?hl=en),
[using an existing address for a Google account](https://support.google.com/accounts/answer/27441?hl=en#existingemail),
[Cloudflare routing setup](https://developers.cloudflare.com/email-service/get-started/route-emails/).
