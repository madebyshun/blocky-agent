# 🔵 Blocky Agent Bot

Telegram bot for Blocky Studio — search builders and analyze data on Base blockchain.

## Features

- `/start` — Welcome message
- `/search [query]` — Search builders on Farcaster + tokens on Base
- `/token [symbol/address]` — Token info + AI analysis
- `/trending` — Trending tokens on Base
- **Free text** — Ask anything → Bankr LLM answers with Base context

## Setup

```bash
# Install dependencies
npm install

# Build
npm run build

# Start
npm start

# Development (with ts-node)
npm run dev
```

## Environment Variables

Copy `.env.example` to `.env` and fill in your keys:

```
TELEGRAM_BOT_TOKEN=your_token_here
BASESCAN_API_KEY=your_key_here
NEYNAR_API_KEY=your_key_here
BANKR_API_URL=https://api.bankr.bot
```

## Tech Stack

- **Node.js + TypeScript**
- **Telegraf** — Telegram bot framework
- **Bankr LLM** — AI analysis
- **Neynar** — Farcaster builder profiles
- **DexScreener** — Token data
- **BaseScan** — On-chain activity

## Built by

[Blocky Studio](https://x.com/blockyonbase) 🔵
