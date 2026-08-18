# Bankr Tools

Reference for the Bankr stack used in Blue Agent: LLM client, Agent actions, and x402 payments.

---

## Bankr LLM

### Endpoint

```
POST https://llm.bankr.bot/v1/messages
```

Auth: `x-api-key: $BANKR_API_KEY`

### Available models

| Model | Use case |
|---|---|
| `claude-haiku-4-5` | Fast, cheap — default for most commands |
| `claude-sonnet-4-6` | Higher quality — use for `blue audit`, `blue raise` |
| `claude-opus-4-6` | Max quality — reserved for premium compute |

### How to call `callBankrLLM()`

Import from `packages/bankr`:

```ts
import { callBankrLLM } from "@blue-agent/bankr";

const result = await callBankrLLM({
  model: "claude-haiku-4-5",       // optional, defaults to haiku
  system: "You are a Base builder assistant.",
  messages: [
    { role: "user", content: "Give me a build plan for a USDC streaming app on Base." }
  ],
  temperature: 0.7,                 // optional, default 0.7
  maxTokens: 800,                   // optional, default 800
});
```

Returns a `string` — the assistant's reply text.

### Extracting JSON from LLM output

```ts
import { extractJsonObject } from "@blue-agent/bankr";

const json = extractJsonObject(result); // safely strips prose around the JSON block
```

### Rules

- Never call OpenAI, Anthropic, or any other LLM directly — always go through `callBankrLLM()`.
- API key is `process.env.BANKR_API_KEY` — never hardcode it.
- All AI calls in the x402 handlers (`apps/web/src/app/api/x402/_handlers/`) go through
  `callLLM` from `apps/web/src/app/api/_lib/llm.ts`, which reaches Virtuals. `callBankrLLM`
  still exists there as a compatibility shim but does not call Bankr.

---

## Bankr Agent

The Bankr Agent (`bankr-agent` skill) handles on-chain actions on Base and Polygon via natural language.

### What it can do

| Action | Example prompt |
|---|---|
| Check portfolio | "What tokens do I hold on Base?" |
| Swap tokens | "Swap 10 USDC for ETH on Base" |
| Send tokens | "Send 5 USDC to 0x…" |
| Check token price | "What's the price of BLUEAGENT?" |
| Polymarket | "What are the odds for X?" |
| Limit orders / DCA | "Buy $50 of ETH if price drops below $3000" |

### How to invoke

Use the `bankr-agent` skill in Claude Code or call via MCP:

```ts
// Via MCP tool (in agentic context)
mcp__plugin_bankr-agent_bankr-agent-api__bankr_agent_submit_prompt({
  prompt: "Swap 10 USDC for ETH on Base"
})
```

### Rules

- Bankr Agent is Base + Polygon only. Never suggest Ethereum mainnet swaps.
- All token addresses passed to Bankr Agent must be verified (see `skills/base-addresses.md`).
- Never execute trades or transfers without explicit user confirmation.

---

## x402 Payments

x402 is a micropayment protocol for HTTP APIs. Blue Agent exposes paid endpoints from `apps/web` at
`https://blueagent.dev/api/x402/<tool-id>`, self-hosted and settled through the Coinbase CDP facilitator.

### How it works

1. Client calls an x402 endpoint without payment → receives `402 Payment Required` with a price header.
2. Client pays the required amount in USDC on Base.
3. Client retries with a payment proof header → gets the response.

### Price format

Prices are defined in `packages/core/src/schemas.ts`:

```ts
export const BLUE_AGENT_PRICING = {
  idea:  0.05,  // $0.05 USDC
  build: 0.50,
  audit: 1.00,
  ship:  0.10,
  raise: 0.20,
};
```

Prices are in USD, paid in USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) on Base.

### Adding a new paid endpoint

1. Create the handler in `apps/web/src/app/api/x402/_handlers/<tool-id>.ts`.
2. Register it in BOTH `_handlers/index.ts` (the `HANDLERS` map) and
   `apps/web/src/lib/agent-tools.ts` (`AGENT_TOOLS`) — a tool is only live if it is in both,
   and the two counts must stay equal.
3. Set price in `BLUE_AGENT_PRICING` if it's a core command, or define inline for one-off tools.
4. Use `packages/payments/src/x402.ts` helpers for payment verification.

### Calling a paid endpoint (client side)

```ts
import { pay } from "@blue-agent/payments";

const result = await pay({
  url: "https://api.bankr.bot/x402/deep-analysis",
  body: { token: "0x…" },
  maxPrice: 1.00, // USDC
});
```
