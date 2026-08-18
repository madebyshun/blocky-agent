# Blue Hub — Base MCP Custom Plugin

> Source of truth: https://blueagent.dev/plugin.md
> Hub UI: https://blueagent.dev/hub · Catalog (machine-readable): https://blueagent.dev/api/catalog

30+ AI tools for Base builders and autonomous agents — audits, token signals,
market-fit analysis, deep due diligence, launch readiness, ecosystem intel and
more. Every tool is a paid HTTP endpoint that speaks **x402 v2** natively, so
Base MCP can call any tool and settle the USDC payment without extra wiring.

- **Network:** Base mainnet (`eip155:8453`)
- **Asset:** USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- **Payment:** x402 v2 · pay-per-call · no API key · no subscription
- **Settlement:** Coinbase CDP facilitator (on-chain transferWithAuthorization)
- **Receives:** Blue Agent treasury `0x02950ad38ada1d599375bd447e080cd404809205`

---

## 1. STOP — COMPLETE ONBOARDING FIRST

> [!IMPORTANT]
> Before invoking any Blue Hub tool:
>
> 1. Call `get_wallets` and confirm a Base mainnet wallet is connected.
> 2. Confirm USDC balance ≥ the tool's price (most are $0.05–$1.00).
> 3. Surface the tool's description and price to the user; obtain explicit
>    approval for the spend before paying.
>
> Every Blue Hub call charges USDC on-chain. Never auto-pay without consent.

---

## 2. Read endpoints

### `GET https://blueagent.dev/api/catalog`

The single source of truth for the tool list — machine-readable, CORS-open,
no auth. Returns:

```json
{
  "name": "Blue Hub",
  "protocol": "x402",
  "x402Version": 2,
  "network": "eip155:8453",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "payTo": "0x02950ad38ada1d599375bd447e080cd404809205",
  "count": 34,
  "tools": [
    {
      "id": "token-pick-signal",
      "name": "Token Pick Signal",
      "description": "Actionable token pick + kill criterion …",
      "price": "$0.20",
      "priceUsdcUnits": 200000,
      "endpoint": "https://blueagent.dev/api/x402/token-pick-signal",
      "method": "POST",
      "input": { "type": "object", "properties": { ... }, "required": [...] }
    }
    // … one entry per tool
  ]
}
```

Use this to enumerate tools, prices, categories and per-tool input schemas
on demand. No caching required by the client — the endpoint sets
`Cache-Control: s-maxage=3600`.

### Discovery alternatives

- **MCP server (remote, no install):** `https://blueagent.dev/api/mcp`
- **Manifest:** `https://blueagent.dev/.well-known/agent.json`
- **Agent crawler hint:** `https://blueagent.dev/llms.txt`

---

## 3. Prepare endpoints (tool invocation)

Blue Hub uses x402 v2 for payment, so the "prepare" and "execute" steps are
both performed by Base MCP's built-in x402 client. The pattern is identical
for every tool:

### `POST https://blueagent.dev/api/x402/{tool-id}`

Body: JSON matching the tool's input schema (see `/api/catalog`).

#### Without `X-Payment` header → HTTP 402

The endpoint is self-describing — the 402 response carries everything a
client needs to sign and retry:

```json
{
  "x402Version": 2,
  "error": "Payment Required",
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "asset":   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "amount":  "200000",
    "payTo":   "0x02950ad38ada1d599375bd447e080cd404809205",
    "maxTimeoutSeconds": 120,
    "extra":   { "name": "USD Coin", "version": "2" }
  }],
  "tool": {
    "id": "token-pick-signal",
    "name": "Token Pick Signal",
    "description": "…",
    "price": "$0.20",
    "input": { "type": "object", "properties": { ... }, "required": [...] }
  }
}
```

#### With a valid `X-Payment` header → HTTP 200

Base MCP signs an EIP-3009 `TransferWithAuthorization` for the user's
wallet (after explicit approval) and retries the request with the
base64-encoded x402 payload in `X-Payment`. The server then:

1. **Verifies** the payment via the Coinbase CDP facilitator (no charge).
2. **Runs** the tool — 3-agent consensus (Blue · Aeon · MiroShark) over
   live Base data.
3. **Settles** the USDC transfer on-chain via CDP (the user is charged
   only on success).

The 200 response carries the result and the settlement receipt:

```json
{
  "tool": "token-pick-signal",
  "headline": "…",
  "pick": { "token": "…", "thesis": "…", "entry": "…", "kill_criterion": "…" },
  "blue_verdict": "BUY",
  "confidence": 76,
  "timestamp": "2026-05-30T…",
  "_settle": {
    "ok": true,
    "status": 200,
    "tx":  "0x… (Basescan link)"
  }
}
```

The Basescan transaction confirms USDC moved on-chain. No off-chain
ledger, no custodial credits — every call is a verifiable settlement.

### Failure semantics

The route is ordered **verify → run → settle**, so:

- **Verify fails** (signature / amount / expiry) → HTTP 402 with the CDP
  error in `detail`. User is **not charged**.
- **Tool fails after verify** (LLM error, timeout) → HTTP 502 with
  `"Tool failed — you were not charged"`. **Not charged.**
- **Verify + tool succeed** → settle runs. If settle errors on-chain after
  a successful tool run, the result is still returned with `_settle.ok =
  false` so the user can see what happened.

> A failed tool **never** results in a debited wallet. Surface this to the
> user.

---

## 4. send_calls mapping

Blue Hub tools execute fully via HTTP + x402; they do **not** return
unsigned EVM calldata to be relayed through `send_calls`. The payment is the
action, and Base MCP's native x402 support handles it end-to-end.

That said, Blue Hub composes cleanly with execution plugins:

- **Blue analyzes, another plugin executes.** A typical pattern: call
  `token-pick-signal` (Blue Hub) → if verdict is `BUY`, prepare an
  Aerodrome / Uniswap swap via that plugin's `send_calls`. Blue Hub
  supplies the *decision*; the execution plugin supplies the *action*.
- **Audit-then-act.** Run `contract-trust` (Blue Hub) before any
  user-initiated `send_calls` against an unknown contract; abort if the
  verdict is `RED_FLAG`.
- **No send_calls is emitted by Blue Hub itself.** Anything Base MCP needs
  to sign for a Blue Hub call is the EIP-3009 USDC payment, which the
  built-in x402 client handles.

---

## Popular tools (excerpt — full list via `/api/catalog`)

| Tool ID                   | Price  | What it returns                                              |
|---------------------------|--------|--------------------------------------------------------------|
| `contract-trust`          | $0.15  | SAFE / CAUTION / RED_FLAG verdict before swapping            |
| `ecosystem-digest`        | $0.20  | Weekly Base pulse — movers, narratives, what to watch        |
| `token-pick-signal`       | $0.20  | One actionable pick + entry, sizing, kill criterion          |
| `narrative-position`      | $0.25  | Narrative map · FRONT-RUN / RIDE / FADE / IGNORE             |
| `market-fit`              | $0.35  | GO / WAIT / PIVOT verdict for a Base project                 |
| `token-launch-readiness`  | $0.50  | Score 0–100 + GO/WAIT verdict + checklist                    |
| `builder-deep-dd`         | $1.00  | STRONG_BUY → RED_FLAG due diligence verdict                  |
| `competitor-scan`         | $0.75  | Competitive landscape · STRONG / COMPETITIVE / WEAK          |
| `investor-memo`           | $0.75  | Full investor memo (market / thesis / traction / ask)        |
| `base-grant-finder`       | $0.35  | Matching grants for a Base project (Coinbase, OP RetroPGF)   |
| `whale-copy-signal`       | $0.35  | Smart-money flows + copy-trade signal                        |
| `protocol-risk-monitor`   | $0.35  | Real-time protocol risk · smart-contract, liquidity, oracle  |
| `wallet-strategy-analyzer`| $0.50  | Decode on-chain strategy of a wallet · replicable plays      |
| `blue-idea`               | $0.05  | Rough concept → fundable brief (programmatic only)           |
| `blue-build`              | $0.50  | Architecture, stack, folder structure, integrations          |
| `blue-audit`              | $1.00  | 500+ security checks · 13 categories · Base-native           |
| `blue-ship`               | $0.10  | Deploy checklist + verification + monitoring                 |
| `blue-raise`              | $0.20  | Fundraising narrative + investor map                         |

---

## Workflow examples

**Pre-trade audit**
> User: *"Before I swap into $TOKEN, audit the contract."*
>
> 1. `POST /api/x402/contract-trust` with `{ "address": "0x…" }`
> 2. Base MCP signs $0.15 USDC, retries → result returned.
> 3. If verdict is `RED_FLAG`, surface to user and *do not* prepare the swap.

**Token research**
> User: *"Find me an asymmetric Base setup right now."*
>
> 1. `POST /api/x402/token-pick-signal` with `{ "context": "…" }`
> 2. Returns pick + thesis + entry + kill criterion.

**Builder DD before investing**
> User: *"Should I invest in this project?"*
>
> 1. `POST /api/x402/builder-deep-dd` with `{ "name": "…", "description": "…" }`
> 2. Returns STRONG_BUY / BUY / WATCH / PASS / RED_FLAG with rationale.

**Launch readiness**
> User: *"Is my token ready to launch?"*
>
> 1. `POST /api/x402/token-launch-readiness` with project context.
> 2. Returns 0–100 score, GO/WAIT verdict, missing-items checklist.

---

## Authentication

There is no API key, no signup, no per-user account. The only auth Blue Hub
requires is the EIP-3009 USDC payment for each call. Any Base mainnet wallet
with sufficient USDC balance works.

For Base App / Base Account users: pay flows are presented as normal
approval prompts via Base MCP's built-in x402 handler.

---

## Mode of failure & error codes

| HTTP | Meaning                                | Charged? |
|------|----------------------------------------|----------|
| 200  | Tool ran, USDC settled                 | Yes      |
| 402  | Missing or invalid payment             | No       |
| 400  | Malformed body (input did not validate)| No       |
| 502  | Tool failed after successful verify    | **No**   |
| 503  | Tool not in handler registry yet       | No       |

`_settle.tx` on a 200 response is the on-chain proof (Basescan).

---

## License & ownership

Open for any Base MCP integration. Wallet `0x02950ad38ada1d599375bd447e080cd404809205`
receives all settlements. Built by Blocky Studio. Powered by `$BLUEAGENT`.

For questions, manifest details, or to suggest tools:
[blueagent.dev](https://blueagent.dev) · [github.com/madebyshun/blue-agent](https://github.com/madebyshun/blue-agent) · [@blueagent_](https://x.com/blueagent_)
