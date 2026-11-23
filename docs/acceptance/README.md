# Acceptance records

Dated evidence that STATUS rows were built and verified: what was tested, against what, and what
was deliberately not claimed. [`STATUS.md`](../../STATUS.md) stays the source of truth for
status; these files hold the detail behind it.

| File | Covers |
|------|--------|
| [2026-11-15](2026-11-15.md) | First full acceptance record |
| [2026-11-16, part 1](2026-11-16-part-1.md) | S1, S4 billing and run-cost work, L4–L10 recovery and redaction, up to atomic completion publication |
| [2026-11-16, part 2](2026-11-16-part-2.md) | S4 completion cost audit onward: run history, action changes, account wakeups, retries, config and credential recovery, Cloudflare runtime |
| [2026-11-17](2026-11-17.md) | Production setup: Clerk, Google OAuth, support email, Cloudflare tokens, Stripe, deployment and proposal review |
| [2026-11-18](2026-11-18.md) | S5 devicebasedauth.org integration (device-bound keys, account linking) |
| [2026-11-22](2026-11-22.md) | S5 devicebasedauth.org: hashbin parity, device sessions, online decisions |
| [2026-11-23](2026-11-23.md) | S5 resource-scoped DBA grants; S4 scheduled advancement via settlement, one rearm per turn, retries before finalization (85 → 79 µ$) |

**Adding a record:** append a `## <IDs> <what> — <date>` section to that day's file (create
`YYYY-MM-DD.md` and add it to the table if it is new). Link evidence under `docs/ops/evidence/`
with paths relative to this folder. Files share the 48 KiB prose limit; when a day's file
would pass it, start `YYYY-MM-DD-part-N.md`.
