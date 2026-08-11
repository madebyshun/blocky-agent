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
- **x402 surface:** `apps/web` is the **single source of truth** — the `AGENT_TOOLS` catalog `/hub` renders, served at `/api/x402/[tool]` (**74 tools** at last audit), where all real tool compute + data sources live. `blueagent.dev` is the canonical self-hosted x402 endpoint (CDP facilitator, payTo `0xb058`). **`apps/api` (`@blue-agent/api`) is the Bankr x402 Cloud surface** — as of 2026-06 it was revived as a **pure proxy layer**: every `apps/api/x402/<id>/index.ts` is an identical thin proxy that forwards to `blueagent.dev/api/x402/<id>` using the **`X-Blue-Internal: INTERNAL_SERVICE_KEY`** bypass (so blueagent.dev runs the tool free while Bankr collects the USDC payment → `0xb058`). No business logic / no data-source secrets in `apps/api`; it mirrors `apps/web`'s 74 ids exactly (regenerate from `AGENT_TOOLS`, never hand-edit). **Deploy:** `cd apps/api && bankr x402 deploy`. **Critical:** the Bankr env `INTERNAL_SERVICE_KEY` (`bankr x402 env add`) MUST equal blueagent.dev **prod (Vercel `blueagent-web-new`)**'s value — the local `.env.local` value does NOT match prod (verified: a proxy call with it returns 402). All web docs / Hub / MCP counts still come from `apps/web` — never from `apps/api`.
- **LLM gateways:** Two paths in `_lib/llm.ts`. `callBankrLLM` → Bankr at `https://llm.bankr.bot/v1/messages` (env `BANKR_API_KEY`) — the default; NOT Anthropic direct (that key is usually out of credit). `callVeniceLLM` → Venice at `https://api.venice.ai` with `venice_parameters.enable_web_search` (env `VENICE_INFERENCE_KEY`) — **the only path that can web-search**; it falls back to Bankr if Venice errors (local key is often stale/401, so web search only truly works in prod). Models: `claude-haiku-4-5` (cheap), `claude-sonnet-4-5` (synthesis).
- **Real data sources already wired:** DexScreener/GeckoTerminal (`src/lib/market-data.ts`), DefiLlama (`src/lib/yield-rates.ts`), **Moralis + Etherscan v2 multichain** (`src/lib/moralis.ts` — on-chain transfers, native tx, verified-contract source; the Basescan→Moralis migration is **done**), GitHub (`src/lib/github.ts`), Aeon KV (`src/app/api/_lib/aeon-kv.ts`).

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
- **Aeon data comes from Vercel KV** (`getAeonOutput(skill)` in `_lib/aeon-kv.ts`), fed by the research-loop cron.
  Do NOT fetch an Aeon `SKILL.md` from GitHub and ask the LLM to "synthesize from training knowledge" — that
  fabricates. Only the skills live in KV are real.

## Git discipline

- Always **`git branch --show-current` before committing.** Work and commit on `dev`, never on `main`.
  *(Real bug: a tool committed while accidentally on main was lost when a later dev→main merge overwrote it.)*
- Ship to production via **GitHub Pull Request (dev → main)**, not a local merge. Local `main` is often behind
  origin; local merges create divergence and conflicts.
- After pushing, the PR triggers a Vercel preview build. **Do NOT merge until that preview is green.**
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
`HANDLERS[id]`, (3) it's committed on `dev` with a clear message, (4) for a new tool, it's registered in BOTH
`HANDLERS` and `AGENT_TOOLS` and catalog count == handler count. **State each of these explicitly when reporting done.**

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

The `blue-agent` repo is the **AI-native founder console for Base builders**. It is a workflow-first product for thinking, building, auditing, shipping, and raising on Base — powered by Bankr LLM and monetized via x402 micropayments.

---

## Tech stack

| Layer | What it is |
|---|---|
| `apps/web` | Next.js 15 frontend — founder console UI |
| `apps/api` | **Bankr x402 Cloud surface** — a pure **proxy layer** mirroring `apps/web`'s 74 tool ids. Each `x402/<id>/index.ts` forwards to `blueagent.dev/api/x402/<id>` via the `X-Blue-Internal` bypass; Bankr collects USDC, `blueagent.dev` does the compute. Regenerate from `AGENT_TOOLS`, deploy with `bankr x402 deploy`. Still don't conflate counts — `apps/web` is the source of truth. |
| `packages/bankr` | Bankr LLM client — wraps `https://llm.bankr.bot/v1/messages` |
| `packages/core` | Shared schemas, command pricing, and tool input definitions |
| `packages/payments` | x402 payment helpers |
| Base chain | All on-chain actions are Base only (chain ID 8453) |

---

## Repo structure

```
blue-agent/
├── apps/
│   ├── web/              # Next.js app — /code, /chat, /launch, /market, /rewards
│   └── api/              # x402 paid endpoints (TypeScript)
│       └── x402/         # Individual paid tool handlers
├── packages/
│   ├── core/             # Shared types, schemas, pricing, tool-input specs
│   ├── bankr/            # Bankr LLM client (callBankrLLM, extractJsonObject)
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

When a user request matches a trigger phrase, load the skill file and follow its output rules. All Aeon skills are **read-to-apply** — no extra setup required except `aeon-distribute-tokens` which needs `BANKR_API_KEY` with Wallet write scope.

---

## Hard rules

1. **Base chain only.** Never suggest Ethereum mainnet. All contract addresses, RPC calls, and on-chain actions target Base (chain ID 8453). Mention Base explicitly in every on-chain context.

2. **All contract addresses must be verified on Basescan.** Never invent or guess a contract address. If an address is needed and not already in the codebase, flag it for the user to supply. Format: `0x…` — always full checksum address.

3. **Use Bankr LLM for all AI calls.** Import from `packages/bankr` and call `callBankrLLM()`. Do NOT call OpenAI, Anthropic, or any other LLM API directly. The endpoint is `https://llm.bankr.bot/v1/messages`. API key is `process.env.BANKR_API_KEY`.

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

**Always work on `dev`.** Never commit directly to `main`. PRs go `dev → main`.

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
5. Only when 2–4 PASS → open a PR (dev→main); merge only when the Vercel preview is green
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
