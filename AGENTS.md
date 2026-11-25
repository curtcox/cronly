# Working in this repository

Guide for coding agents and new contributors. `CLAUDE.md` points here, so keep this file
current instead of copying it.

cronly.org ("cron only") is a pay-as-you-go scheduling service. Customers define named actions
(HTTP requests or JavaScript), the variables and secrets they use, and when they run (cron,
on demand, or webhook). It runs on Cloudflare Workers, Durable Objects and Queues, with Clerk
for sign-in, Stripe for deposits into a prepaid balance, and Claude for prose ↔ cron.

It is a sibling of hashbin.org (`../hashbin.org` on the owner's machine). When in doubt about a
convention, do what hashbin does, and port its code (auth, scopes, payments, local mode)
rather than rewriting it.

## Start here

| Question | Answer lives in |
|----------|-----------------|
| What is done, what blocks launch, what's next? | [`STATUS.md`](STATUS.md) (the only source of truth for status) |
| Design | [`todo/master_plan.md`](todo/master_plan.md) |
| Prices, costs and why | [`docs/business/pricing.md`](docs/business/pricing.md) |
| Why something finished was built the way it was | `done/<plan>.md` |
| Evidence that a row was accepted (dated records) | [`docs/acceptance/`](docs/acceptance/README.md) |

## Conventions

- **JavaScript:** ES modules, async/await, JSDoc on exported functions. Files kebab-case,
  classes PascalCase. Comments explain *why*.
- **Tests sit beside the code** as `name.test.js` (Vitest). Durable Objects are tested by
  constructing the class with an in-memory storage stub.
- **Every API route declares its access** in `API_ROUTES` (`src/index.js`): `PUBLIC`,
  `SESSION`, or scopes. A test fails for any undeclared route.
- **Money is integer micro-dollars (µ$).** Rates live only in `src/utils/cost-policy.js`,
  prices only in `src/utils/pricing.js`, model rates only in `src/utils/llm-policy.js`. Round
  costs up. Never let an operation that costs cronly money run before its maximum price is
  held from the balance.
- **Every price must pass the price-floor test** (`price × revenueKept ≥ 1.5 × worst-case cost`).
- **Secrets** never appear in logs, responses or the repo. Customer secrets are encrypted at
  rest and decrypted only in the executor. Worker secrets are listed in `wrangler.toml`'s
  comment block and pushed by CI.
- **Prose never applies changes by itself.** LLM output becomes a proposal; applying it is a
  separate, billed API call.
- **Frontend:** no framework, no bundler. Escape anything dynamic before `innerHTML`.
- **File sizes** have per-type limits (source code 32 KiB, HTML/CSS 64 KiB, prose 48 KiB, data
  64 KiB, raster images 256 KiB, and 256 KiB for the generated `frontend/openapi.json`; the full
  list is `RULES` in `scripts/check-file-sizes.mjs`). When a file outgrows its limit, split it.
  `scripts/file-size-baseline.json` is empty; it only grandfathers files when a new or tighter
  rule arrives (`--write-baseline`), and those may not grow. After shrinking one, run
  `npm run check:file-sizes -- --update-baseline`.
  Never raise or add baseline entries to make a check pass. `npm install` enables the pre-push
  hook in `.githooks/`, which also rejects big files committed and deleted again before a push.
- **Errors** are JSON `{ error, code, ... }` with the right HTTP status; `402` for balance or
  budget refusals.

## Plans and status

- STATUS rows have stable IDs: `D…` decisions, `L…` launch blockers, `S…` soon after launch,
  `B…` backlog. Reference them in commits.
- A change that finishes, starts or discovers an item updates its STATUS row in the same commit.
- `todo/<plan>.md` files are written to be picked up cold. When a plan is fully done, `git mv`
  it to `done/`.
- Items owned by `ops` or `legal` need the project owner. Prepare everything that can be
  prepared in code, then say what's left for them.
