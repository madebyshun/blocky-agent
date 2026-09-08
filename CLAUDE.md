# CLAUDE.md — Blue Agent

---

# Operating rules for Claude Code — READ BEFORE ANY TASK

These exist because each one prevented a real bug. Follow them even when a shortcut looks faster.
They take precedence over speed.

## Repo layout (verified)

- **Real repo:** `~/projects/blue-agent` (NOT `~/blue-agent` — that's a junk dir, ignore it).
- **Working dir:** `apps/web`. Path alias `@/` → `apps/web/src/`.
- **x402 tool handlers:** `apps/web/src/app/api/x402/_handlers/*.ts`, registered in `_handlers/index.ts` (`HANDLERS` map).
- **Tool catalog:** `apps/web/src/lib/agent-tools.ts` (`AGENT_TOOLS` — the single source of truth the hub renders).
  A tool is only live if it exists in **BOTH** `HANDLERS` and `AGENT_TOOLS` (catalog count == handler count, no orphans).
- **x402 surface:** `apps/web` is the **single source of truth and the only live surface** — the `AGENT_TOOLS` catalog `/hub` renders, served at `/api/x402/[tool]` (**111 tools** as of 2026-09-08 — `b20-launch` retired; count it, don't trust this number), where all real tool compute + data sources live. `blueagent.dev` is **self-hosted x402**: `route.ts` builds its own 402 requirements and settles USDC on Base through the **Coinbase CDP facilitator** (`cdpVerify`/`cdpSettle`, payTo `0x0295…` — see the payTo bullet below). There is **no Bankr in the payment path** — see the header comment in `apps/web/src/app/api/x402/[tool]/route.ts`.
- **`apps/api` and `apps/portal` are DELETED — do not recreate either.** `apps/api` was the Bankr x402 Cloud storefront (74 zero-compute ~20-line proxies forwarding to `blueagent.dev/api/x402/<id>` so Bankr could collect the USDC); `apps/portal` was a second Next app serving `api.blueagent.dev`. Both were abandoned before deletion: last commits **2026-06-18** and **2026-07-03**, no Vercel project for either, `api.blueagent.dev` 404s, and `apps/api` mirrored only **74 of 112** ids — missing all 30 `rh-*` tools. Its `_gen.mjs` generator, named in its own header as the source of truth, **never existed in any commit on any branch**, so "regenerate from `AGENT_TOOLS`" was never executable. Rebuilding either is pointless, not merely redundant: every `apps/api` handler proxied to `blueagent.dev`, so it would be blueagent.dev calling itself. If `api.blueagent.dev` is wanted as a public API surface (task #7), that is a **Vercel domain alias + rewrite onto this same Next app** — one codebase, two hostnames — not a second deployment. History has them if you need the old text: `git log --all -- apps/api apps/portal`.
- **LLM gateway: Virtuals, and only Virtuals.** Policy set 2026-07-25 in `_lib/llm.ts` (read its header before touching any LLM call). `callLLM` → `https://compute.virtuals.io/v1` (env `VIRTUALS_API_KEY`, optional `VIRTUALS_MODEL`); on failure it throws a typed `LLM_UNAVAILABLE` the caller degrades around, rather than silently falling back and fabricating. Two shims exist purely so ~46 legacy importers keep compiling — **both delegate to `callVirtualsLLM`, neither makes the HTTP call its name implies**: `callBankrLLM` (Bankr 403-banned 2026-07-20) and `callVeniceLLM` (no request ever reaches `api.venice.ai`). New code calls `callLLM`. `BANKR_API_KEY` and `VENICE_INFERENCE_KEY` are dead env vars. Model ids are validated against the live Virtuals catalog (`getVirtualsCatalog`), so a de-listed model hides its preset instead of 400-ing.
- **Real data sources already wired:** DexScreener/GeckoTerminal (`src/lib/market-data.ts`), DefiLlama (`src/lib/yield-rates.ts`), **Moralis + Etherscan v2 multichain** (`src/lib/moralis.ts` — on-chain transfers, native tx, verified-contract source; the Basescan→Moralis migration is **done**), GitHub (`src/lib/github.ts`), Aeon KV (`src/app/api/_lib/aeon-kv.ts`).
- **payTo wallet — changed 2026-08-18.** Every off-chain payee is now `0x02950ad38ada1d599375bd447e080cd404809205`, the same wallet that receives Blue Chat credit top-ups. The old `0xb058a1e305d9c720aa5b1bf42b6f2f6294b03b5f` (Bankr Club wallet) is **retired** — do not reintroduce it. Server `PAY_TO` (`api/_lib/x402-cdp.ts`) and client `PAY_TO_WALLET` (`hub/HubView.tsx`) **must change in lockstep**: the browser signs `authorization.to` against the client value, so any divergence fails CDP verification on *every* Hub payment. `PAYMENT_WALLET` env is referenced by 3 routes as an override but is **not set in Vercel**, so the code constants are the live values.
  ⚠️ **Two deployed contracts still pay the old wallet and cannot be redirected** — `B20HUBHook.TREASURY` (`0xe3B801B6721B0bB77AD43e5F9cAfC02780061200`) and `BlueBuyBack.payoutRecipient` (`0xBCF026857cbeF2429bf373Bc5fFFa5f8005175B4`), both Base 8453, both `immutable`; the buyback one has **no setter by deliberate design** so a hostile owner can't redirect staker yield. Only a redeploy changes them, and redeploying the V4 hook changes its address (permission bits) and would require a new pool. Editing the `.sol` source changes nothing — the deployed bytecode is what pays. Verified on-chain via `cast call`, 2026-08-18.

## NON-NEGOTIABLE: verify before claiming done

- After ANY code change, run **`npx tsc --noEmit && npm run verify:build`** (from `apps/web/`) and confirm
  both are green. **`npx tsx` running a file is NOT proof** — tsx skips TypeScript strict checks; the full
  Next build is what production runs and what catches real errors.
  *(Real bug: a bulk patch changed a function signature but not its callers — tsx ran fine, next build failed,
  production deploy broke.)*
- **Use `npm run verify:build`, NOT `npm run build`.** verify:build writes to `.next-verify/` via
  `NEXT_DIST_DIR`, so the running dev server's `.next/` never gets wiped. Running `next build` while
  `next dev` is up corrupts the shared `.next/` and turns the browser into a giant fullscreen logomark
  (real bug, seen 4 times). The `verify:build` script is defined in `apps/web/package.json`.
- **Never `rm -rf .next` while `next dev` is running.** Same fullscreen-logomark corruption as above
  via a different vector — the dev server keeps its file handles into `.next/`, and once you delete
  the dir out from under it, the browser starts getting a fallback page. If you need to clear a stale
  `.next/types/` (e.g. after a branch switch that dropped some routes), either (a) stop the dev
  server first, then `rm -rf .next && npm run dev`, or (b) `rm -rf .next/types` alone — that subfolder
  is regenerated on the next request and doesn't corrupt live handles. If `verify:build`'s type errors
  are complaining about missing `.js` companions, that's the *stale-types* case, not a real error —
  restart is the fix, not editing anything.
- When testing a handler locally via tsx, import through `index.ts` and call via `HANDLERS[id]`, not the file's
  default export — tsx wraps named exports under `.default`, so direct calls fail misleadingly.
- **Distinguish test noise from real bugs BEFORE fixing.** Half of apparent failures are wrong input fixtures
  (an address in a token field, etc.) or LLM-gateway credit exhaustion mid-run, not tool bugs. Run tools
  individually with a small delay, not all at once (batching causes rate-limit false failures). Confirm the
  input schema matches before concluding the code is wrong.

## Debugging discipline

- When something fails, **READ THE CODE before blaming infra.** Do not rotate keys, change env vars, or redeploy
  as a first move. *(Real bug: a cron returned a "warming up" placeholder; three env/key changes did nothing
  because the cause was one line — `JSON.parse(raw)` choking on markdown-wrapped LLM output and falling into a
  mock fallback. The LLM worked from call #1.)*
- Trace the failure to its exact line. State the root cause in **one sentence** before proposing a fix.
- If you're guessing, say so and add a diagnostic (log / debug field) instead of guessing again.

## Tool quality rules (this is the product's value)

Classify every tool by whether it has a REAL data source. A tool with no real source WILL fabricate, no matter
how good the prompt is. **Prompts do not prevent hallucination; data sources do.**

- **Verifiable facts** (grant amounts, token data, contract details, yield APY, on-chain metrics): data MUST come
  from a curated/onchain/API source. The LLM only interprets — it NEVER generates the numbers. Compute derived
  values (e.g. projected yield = amount × apy) in **code**, not by LLM. Validate any LLM "pick" against the real
  list; fall back to a code default if it invents one.
- **Advisory output** (strategy, GTM, roadmap, ideas): the LLM may generate, but label it "estimate" /
  "model-generated". These are frameworks, not measured facts.
- **Missing data → "unknown" / "insufficient data".** NEVER infer a negative score, risk level, or fake number
  from absent data. "Cannot assess" is the correct answer, not a fabricated value.
- **Verdicts/actions** (BUY/WATCH/PASS, EXIT/HOLD, SHIP/REVISE): hard-map from the numeric score in **code**.
  Never let the LLM choose the verdict word — that flips the same input between runs. Set `temperature: 0` on
  any step whose output must be deterministic.
- **JSON parsing from LLMs must be lenient.** LLMs wrap JSON in fences and add preamble. Never use raw
  `JSON.parse(text)` — strip fences, slice from first `{` to last `}`, then parse inside try/catch. Reuse the
  existing parse helper pattern in the x402 handlers.
- **Aeon data comes from Vercel KV** (`getAeonOutput(skill)` in `_lib/aeon-kv.ts`), written by
  `/api/cron/research-loop`. Do NOT fetch an Aeon `SKILL.md` from GitHub and ask the LLM to "synthesize
  from training knowledge" — that fabricates. Only the skills live in KV are real.
  ⚠️ That cron was **unscheduled 2026-09-05** (Upstash budget, #148 — route intact, timer removed), so
  `aeon:deep-research` is expired in production and every reader takes its `null` path. That is designed,
  not a regression: the five paid x402 readers lose Aeon context, they do not invent it. Do not "fix" an
  empty Aeon key by generating one — re-run the route with CRON_SECRET, or re-add the schedule to
  `apps/web/vercel.json` after reading the route header.

## Retiring a surface (luật chống-bỏ-rơi)

Five surfaces were built, quietly abandoned, and left live: `apps/api` (61 days between
last maintenance and deletion), `apps/portal` (46), Blue Sentinel (~100), Blue Feed, and the
microtask marketplace. **Not one was caught by a mechanism** — every one was caught by a
human eventually noticing. While abandoned, Sentinel leaked `CRON_SECRET` from an
unauthenticated route and a paid Hub tool was still selling it; the CLI still sold a
microtask ledger backed by a `Map` that never persisted; Blue Feed's published links had to
be 301'd after the fact.

The damage is never "dead code exists" — that is normal. It is the gap between **stopping
maintenance** and **stopping exposure**. Everything below exists to close that gap.

- **"Last commit date" is NOT evidence a surface is alive.** MEASURED: `api/sentinel`'s last
  feature commit was 2026-05-24, but two repo-wide mechanical sweeps (`maxDuration` across all
  tool routes, 2026-05-28; the #150 kvGet family, 2026-08-28) refreshed its timestamp. On the
  day it was deleted, git said "touched 4 days ago". **A staleness timer would have protected
  it through the entire ~100-day window it was leaking a secret.** Sweeps camouflage
  abandonment; never argue "it's still maintained" from `git log` alone.
- **Retiring is ONE commit, not a cleanup backlog.** The same commit removes the route, its
  `AGENT_TOOLS`/`HANDLERS` entry and price, every link that advertises it, and its `vercel.json`
  cron — and names the env vars that just became dead. Whatever is left behind is the part
  that bites.
- **A payment path must never outlive the product it sells.** If a surface is retired, the
  endpoint that charges for it goes in the same commit. If it cannot (it moves real USDC, or
  it holds user funds), STOP and ask ShunTr — do not retire around it and do not quietly leave
  it collecting.
- **User/KV state is evidence, not clutter.** Deleting routes does not entitle you to delete
  the data behind them. Keep it and flag it; wiping a user's subscriptions is ShunTr's call.
- **Every published URL must resolve.** Enforced by `apps/web/scripts/link-liveness-check.ts`,
  which runs in CI: every absolute `blueagent.dev` link in `src/` is resolved against the app's
  real routes, `public/`, `next.config` redirects and the middleware rewrite. It exists because
  `blueagent.dev/market` 404'd in production while two live senders kept mailing it.

## Git discipline

- **Branch from `main`, PR into `main`, delete the branch on merge.** One short-lived branch per change.
  Always **`git branch --show-current` before committing** — never commit directly to `main`.
  *(Real bug: a tool committed while accidentally on main was lost when a later merge overwrote it.)*
- **`dev` is RETIRED (2026-09-05). Do not branch from it, commit to it, or re-create it.** The rule until
  then was "always work on `dev`, PRs go dev → main", and a long-lived shared branch failed twice over:
  - **It drifted.** By the time it was drained (PR #269) `dev` was **61 files** behind `main` and carried
    three unshipped features. Only 6 files actually overlapped, so 55 of those files were pure latency —
    work sitting unshipped for no technical reason.
  - **It was silently ungated, which is the part that matters.** `.github/workflows/ci.yml` lived on `main`
    and *not* on `dev`, so the `verify` job — the repo's only universal PR gate — **never ran on a single
    `dev` commit.** #269 showed no `verify` check at all until `main` was merged in. A branch that is
    behind is visible; a branch that is behind *on its own CI config* is not, and it quietly exempts
    itself from the checks everything else passes. Short-lived branches cut from `main` inherit the
    current workflow by construction and cannot drift out of the gate.
- Ship to production via **GitHub Pull Request into `main`**, not a local merge. Local `main` is often behind
  origin; local merges create divergence and conflicts.
- After pushing, the PR triggers a Vercel preview build. **Do NOT merge until that preview is green.**
- **Stacked PRs: merging the parent does NOT retarget the child unless the parent's branch is deleted.**
  If you preserve a parent branch (`--delete-branch` omitted), GitHub leaves the child's base pointing at
  it, and merging the child then lands in the parent instead of `main`. Retarget explicitly with
  `gh pr edit <child> --base main` before merging, and verify with `gh pr view <child> --json baseRefName`.
- Commit in **small checkpoints** (one tool / one fix per commit) so a bad change is easy to isolate and revert.
  Avoid one giant "build the whole feature" commit.

## Secrets

- **Never paste real secrets** (API keys, KV tokens, Redis URLs, `CRON_SECRET`) into chat or commits.
- If a secret is exposed, rotate it at the source, then update BOTH `.env.local` and Vercel env vars (and
  redeploy — env changes only apply to new deployments).
- `.env.local` quoting: every `KEY="value"` needs matched quotes. One unmatched `"` makes the file silently skip
  all variables after that line, causing confusing "missing key" failures downstream.

## Definition of done

A change is done only when: (1) `npx next build` is green, (2) the handler returns correct output when tested via
`HANDLERS[id]`, (3) it's committed with a clear message on a branch cut from `main`, and opened as a PR into
`main`, (4) for a new tool, it's registered in BOTH `HANDLERS` and `AGENT_TOOLS` and catalog count == handler
count. **State each of these explicitly when reporting done.**

---

## What is Blue Agent

**Blue Agent** is an AI agent layer built on Base — it interacts with users, automates tasks, and generates onchain activity.

Blue Agent is the flagship AI agent of the Base ecosystem. It is not just a chatbot — it is a full economic actor: it holds a wallet, executes onchain transactions, earns and distributes tokens, and powers a growing ecosystem of tools and services.

**Two surfaces:**
- **Founder console** (this repo) — AI-native workflow for Base builders: idea → build → audit → ship → raise. MCP-native — runs inside Claude Desktop, Cursor & Claude Code (`https://blueagent.dev/api/mcp`). *Not a tool you open. A layer you build on.*
- **x402 API services** — pay-per-use AI tools (USDC on Base, EIP-3009) for agents and developers. Each of the 5 commands is backed by a cluster of hub tools (e.g. audit → risk_gate · honeypot · key_exposure · protocol_risk).
  > Note: the **Hub web catalog (`apps/web`) is 74 tools**, but the **MCP/skill surface** (`/api/mcp` + `@blueagent/skill`) is a deliberately-curated subset of **57 tools** (15 `blue_` + 42 `hub_`) — the two counts are NOT the same and should not be conflated. The 20 newer on-chain primitives (token-price, pool-scan, gas-tracker, etc.) are live on the Hub/x402 but are not all wired into MCP. There are **no quantum tools** anywhere (the only "quantum" string in the codebase is prose in the `key-exposure` description).

> Note: the Telegram bot surface is **no longer in active development** (as of 2026-06). Focus is the 5 commands + their hub tool clusters.

**Tokens:**
- `$BLUEAGENT` — `0xf895783b2931c919955e18b5e3343e7c7c456ba3` (Base, Uniswap v4)

**Links:**
- X/Twitter: [@blueagent_](https://x.com/blueagent_)
- Telegram community: [t.me/blueagent_hub](https://t.me/blueagent_hub)
- Bankr profile: [bankr.bot/agent/blue-agent](https://bankr.bot/agent/blue-agent)

---

## This repo — Founder Console

The `blue-agent` repo is the **AI-native founder console for Base builders**. It is a workflow-first product for thinking, building, auditing, shipping, and raising on Base — powered by Virtuals inference and monetized via self-hosted x402 micropayments.

---

## Tech stack

| Layer | What it is |
|---|---|
| `apps/web` | Next.js 15 frontend + **the entire live x402 surface** — founder console UI, `AGENT_TOOLS` catalog, all tool compute, self-hosted x402 via CDP |
| ~~`apps/api`~~ ~~`apps/portal`~~ | 🗑️ **DELETED 2026-08-18.** The Bankr x402 storefront and the `api.blueagent.dev` portal. Both dead before removal — no Vercel project, no importers, `api.blueagent.dev` 404s. Do not recreate; see the rule above. |
| `packages/bankr` | ☠️ **Legacy** — Bankr LLM client. Bankr 403-banned 2026-07-20; inference is Virtuals via `apps/web/src/app/api/_lib/llm.ts`. |
| `packages/core` | Shared schemas, command pricing, and tool input definitions |
| `packages/payments` | x402 payment helpers |
| Chains | **Base (8453)** — primary tokenized-stock venue (Coinbase B20) + every non-RH tool. **Robinhood Chain (4663)** — second live venue; the ~30 `rh-*` tools and the RWA registry are RH-specific. Never assume which; state it. |

---

## Repo structure

```
blue-agent/
├── apps/
│   ├── web/              # Next.js app + ALL live x402 tool handlers + compute
│   └── docs/             # Mintlify docs source (no package.json — not an npm workspace)
├── packages/
│   ├── core/             # Shared types, schemas, pricing, tool-input specs
│   ├── bankr/            # LEGACY — Bankr LLM client (Bankr 403-banned 2026-07-20)
│   └── payments/         # x402 payment flow helpers
├── agents/
│   └── blue-agent/       # Agent runtime config (agent.json, tasks.json)
├── commands/             # Command contract docs (idea.md, build.md, etc.)
├── skills/               # Bundled grounding knowledge (Base addresses, standards, tools)
├── docs/                 # Product brief, roadmap, status, quickstart
├── features/             # Feature folders
└── CLAUDE.md             # This file
```

---

## Aeon Skills (installed from BankrBot/skills)

Five Aeon skills are bundled in `skills/` and available to any command or agent session:

| Skill | File | Use when |
|---|---|---|
| `aeon-token-movers` | `skills/aeon-token-movers.md` | "what's pumping", "top movers today", pre-trade scan |
| `aeon-token-pick` | `skills/aeon-token-pick.md` | "give me a token pick", "asymmetric setup today" |
| `aeon-narrative-tracker` | `skills/aeon-narrative-tracker.md` | "what's running on CT", "narrative positions", content ideas |
| `aeon-deep-research` | `skills/aeon-deep-research.md` | "DD on X", "build me a memo", "contrarian take" |
| `aeon-distribute-tokens` | `skills/aeon-distribute-tokens.md` | Weekly $BLUEAGENT rewards payout to leaderboard |

When a user request matches a trigger phrase, load the skill file and follow its output rules. All Aeon skills are **read-to-apply** — no extra setup required except `aeon-distribute-tokens`, which needs `BANKR_API_KEY` with Wallet write scope and is 🔴 **DEAD — measured, no longer a guess.**

**MEASURED 2026-09-06** against `api.bankr.bot` with the key present:

```
POST /token-launches/deploy  → 403
{"error":"Account suspended","banned":true,"banType":"restricted",
 "reasonCode":"fraud","message":"This action is disabled while your account is
 restricted. You can still view your balances and withdraw your funds."}
```

Identical on `?chain=base` and `?chain=robinhood`. The suspension is on the **ACCOUNT**, not on one hostname — so the old hedge ("a different endpoint from the 403-banned `llm.bankr.bot`, verify before relying on a payout run") resolves in the pessimistic direction: **every Bankr WRITE is banned, including the Wallet API a payout would use.** Do not schedule or promise an `aeon-distribute-tokens` run through Bankr; it will 403 at the transfer.

**READS still work** — same day, `GET /token-launches?limit=3` → `200` with live data, exactly as the 403 body promises ("you can still view"). So `lib/bankr-usage.ts`, `/badge/[type]/[handle]`, `_handlers/b20-tracker.ts`, and the `/api/my-tokens` + `/api/claim-fees` creator-fee path are fine and **must stay** — that last one is how a creator withdraws fees they already earned, and closing it would strand their money. `BANKR_API_KEY` therefore stays SET in Vercel. **Write ≠ read: measure the specific verb before declaring either dead.**

The deploy path that this 403 killed (`/api/launch-token` + the `prepare_token_launch` chat card) was retired 2026-09-06 — see `apps/web/scripts/action-card-inventory-check.ts`, which fails if any of it comes back.

---

## Hard rules

1. **Two live stock venues — Base (8453) leads, Robinhood Chain (4663) is also covered. Never assume either; state which one, every time.** Base is the primary tokenized-stock venue (Coinbase B20 — the `*c` share tokens Blue Hood polls) and all product copy is Base-first. RH Chain is a real second venue, not a fallback or a legacy shim: the ~30 `rh-*` tools and the RWA registry are RH-specific and stay that way. **A ticker can exist on BOTH chains** (NVDA / META / GOOGL currently do), so a ticker string alone never identifies a token — chain + address does. Never suggest Ethereum mainnet. An address, RPC call, or explorer link is meaningless without its chain, and RH and Base share neither.
   *(Corrected 2026-08-24: this rule previously called Base "legacy — older non-RH tools", which was true before the Base desk went live and is now wrong in the direction that matters.)*

2. **All contract addresses must be verified on the explorer for their own chain** — Basescan for Base (8453), `robinhoodchain.blockscout.com` for RH Chain (4663). The two chains share no state: an RH contract does not exist on Basescan and a Base B20 does not exist on RH's explorer, so an explorer check only counts on the token's own chain. **Never resolve a stock token by ticker string** — for a Base B20, cross-check the address against the official `base.org/stocks` table and assert it on-chain (`isB20`, `decimals == 8`, `symbol == "<TICKER>c"`); name-matching a ticker is exactly how an impostor gets in (real bug, #280). Never invent or guess a contract address. If an address is needed and not already in the codebase, flag it for the user to supply. Format: `0x…` — always full checksum address.

3. **Use Virtuals for all AI calls.** Import `callLLM` from `apps/web/src/app/api/_lib/llm.ts`. Do NOT call OpenAI, Anthropic, Bankr, or Venice directly. The endpoint is `https://compute.virtuals.io/v1`, key `process.env.VIRTUALS_API_KEY`. **Do not write new `callBankrLLM` / `callVeniceLLM` calls** — those are compatibility shims that delegate to Virtuals, kept only so ~46 legacy importers compile; their names describe providers this repo no longer uses (Bankr 403-banned 2026-07-20, Venice removed from the fallback chain 2026-07-25). `packages/bankr` is legacy for the same reason.

4. **No hallucinated addresses, ever.** If you don't have a verified address, say so. Do not fill in placeholders that look like real addresses.

5. **Business logic lives in packages, not in the app.** Keep `apps/web` thin. Schemas, pricing, and tool definitions belong in `packages/core`.

---

## The 5 core commands

Each has a contract doc in `commands/`.

| Command | What it does | Price |
|---|---|---|
| `blue idea` | Turns a rough concept into a fundable brief — problem, why now, why Base, MVP scope, risks, 24h plan | $0.05 |
| `blue build` | Architecture, stack, folder structure, files, integrations, and test plan | $0.50 |
| `blue audit` | Security and product risk review — critical issues, suggested fixes, go/no-go | $1.00 |
| `blue ship` | Deployment checklist, verification steps, release notes, monitoring plan | $0.10 |
| `blue raise` | Pitch narrative — market framing, why this wins, traction, ask, target investors | $0.20 |

Pricing is defined in `packages/core/src/schemas.ts` → `BLUE_AGENT_PRICING`.

---

## Commit convention

```
feat:     new feature
fix:      bug fix
skill:    new skill or grounding file added
cmd:      changes to a command contract (commands/*.md)
docs:     documentation only
refactor: code restructure, no behavior change
chore:    tooling, deps, config
```

---

## Branch policy

**Cut a short-lived branch from `main`, PR it back into `main`, delete it on merge.** Never commit
directly to `main`. **`dev` is retired (2026-09-05) — do not branch from it or re-create it**; see
Git discipline above for the two measured reasons (61-file drift, and `dev` silently lacking the CI
workflow so `verify` never ran on it).

---

## Build & deploy workflow

**Build locally first, then deploy.** Never push to `main` (which auto-deploys
to production) until the change has passed a full local build. This catches
errors before they burn a Vercel deploy slot — the free plan caps at **100
deployments/day**, and a failed build wastes one.

Pipeline for every change, in order:

```
1. Edit code
2. npx tsc --noEmit -p tsconfig.json   # type errors (fast) — run from apps/web
3. npm run build                        # next build — lint, prerender, server/client import errors
4. Manual runtime test at localhost     # logic/UX bugs a build can't catch
5. Only when 2–4 PASS → open a PR (branch→main); merge only when the Vercel preview is green
```

Notes:
- `tsc --noEmit` only catches **types**. `next build` additionally catches
  **ESLint errors, prerender failures, and server/client boundary mistakes** —
  exactly the class of error that makes a Vercel build fail.
- Step 4 is **mandatory** for sensitive changes (wallet, payments, on-chain,
  credit metering) — those break at **runtime**, not build time. A clean build
  is necessary but not sufficient.
- `next build` and `next dev` share the `.next/` directory — **stop the dev
  server before running a build** or `.next` can corrupt.
- Deploy = merge the green PR into `main` (see Git discipline above — ship via PR,
  not a local merge). **Do not** create empty `chore: trigger production redeploy`
  commits — they burn deploy slots. If `main` doesn't auto-deploy, the cause is
  almost always the daily cap, not the GitHub integration.

**Deploy target:** production is the Vercel project **`blueagent-web-new`**
(`blueagent.dev`). Never deploy to or recreate the `blue-agent` project.
