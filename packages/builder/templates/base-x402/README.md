# {{PROJECT_NAME}} — Paid x402 API Template

A production-ready paid API service on Base using x402 micropayments. Mirrors the pattern from Blue Agent's own x402 surface (`apps/web/src/app/api/x402/`).

## What it is

This template gives you a paid API endpoint that:
- Accepts POST requests and processes them with Bankr LLM
- Defines payment requirements in `bankr.x402.json` (USDC on Base, chain 8453)
- Follows the same handler pattern as Blue Agent's x402 tools
- Is ready to register on Bankr for discovery by other agents

## Setup

```bash
# 1. Copy env and fill in your key
cp .env.example .env

# 2. Install dependencies
npm install

# 3. Run the server
npm run dev
```

## Project structure

```
base-x402/
├── bankr.x402.json        # Payment config: price, currency, schema
├── x402/
│   └── my-tool/
│       └── index.ts       # Tool handler: parse → LLM → respond
└── src/
    └── index.ts           # HTTP server with routing
```

## How to add new tools

1. Copy `x402/my-tool/` to `x402/your-tool/`
2. Edit the handler logic in `x402/your-tool/index.ts`
3. Add a route in `src/index.ts`:
   ```typescript
   if (req.method === "POST" && url.pathname === "/api/tools/your-tool") {
     res = await yourTool(req);
   }
   ```
4. Add the service definition to `bankr.x402.json`

## Payment config (`bankr.x402.json`)

The `bankr.x402.json` file defines your services and their prices:
- `network`: always `"base"` — Blue Agent is Base-only
- `currency`: always `"USDC"`
- `services`: map of tool name → price and schema

## How to register on bankr.bot

1. Deploy your API to a public URL (Vercel, Railway, Fly.io, etc.)
2. Visit [bankr.bot](https://bankr.bot) and register your `bankr.x402.json`
3. Other agents and users can then discover and pay for your tools

## Deploy notes

- **Vercel**: works with `npm run start` as the start command
- **Railway**: auto-detects Node.js, set `PORT` env var
- **Fly.io**: works with the provided server setup

## Built by

[Blocky Studio](https://blocky.studio) — [@blueagent_](https://x.com/blueagent_)

Telegram community: [t.me/blueagent_hub](https://t.me/blueagent_hub)
