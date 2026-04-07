# 🟦 Blue Agent Bot

AI-powered Telegram community bot for Base builders. Built by [Blocky Studio](https://blocky.studio).

- **Bot:** [@blockyagent_bot](https://t.me/blockyagent_bot)
- **Community:** [t.me/blueagent_hub](https://t.me/blueagent_hub)
- **Token:** [$BLUEAGENT](https://dexscreener.com/base/0xf895783b2931c919955e18b5e3343e7c7c456ba3)
- **X:** [@blocky_agent](https://x.com/blocky_agent)

---

## Features

### 👤 User
| Command | Description |
|---|---|
| `/start` | Onboarding — auto-create wallet, join community |
| `/menu` | Main menu |
| `/profile` | Your profile — tier, points, streak, wallet |
| `/wallet` | Wallet address + ETH balance |
| `/points` | Points balance + rank |
| `/leaderboard` | Top builders this week |
| `/refer` | Referral link — earn 50 pts per referral |
| `/rewards` | Claim $BLUEAGENT from your points |

### 🏗️ Builder
| Command | Description |
|---|---|
| `/score @handle` | AI Builder Score (0–100) for any X/Twitter handle |
| `/submit` | Submit your project to the directory |
| `/projects` | Browse submitted projects |
| `/quests` | Active quests — earn bonus points |

### 💱 Wallet & Trading
| Command/Action | Description |
|---|---|
| `/wallet` | View wallet address + ETH gas balance |
| `swap 10 USDC to ETH` | Swap tokens via Uniswap v3 on Base |
| `swap 0.01 ETH to USDC` | Natural language swap |
| `send 5 USDC to 0x...` | Send ERC20 tokens |
| `send 0.01 ETH to 0x...` | Send native ETH |
| `buy $BLUEAGENT with 5 USDC` | Opens Uniswap v4 for $BLUEAGENT |

> **Note:** Deposit ETH (Base) to your wallet to pay gas. Min ~0.001 ETH.

### 📊 Token & Portfolio
| Command | Description |
|---|---|
| `/portfolio` | View onchain portfolio |
| `/alert` | Set price alerts for $BLUEAGENT |
| `/pricing` | Current $BLUEAGENT price + stats |
| `/news` | Latest from top Base builders on X |

### 🎮 Community
| Command | Description |
|---|---|
| `/predict` | Prediction market — vote on outcomes |
| `/raffle` | Participate in active raffles |
| `/propose` | Submit a community proposal |
| `/stats` | Community stats |

### 🚀 Token Launch
| Command | Description |
|---|---|
| `/launch` | Deploy ERC-20 token on Base (no code, gas-free via Clanker) |

### 🛠️ Admin Only
| Command | Description |
|---|---|
| `/admin` | Admin panel |
| `/broadcast` | DM blast to all users |
| `/schedule` | Schedule an announcement |
| `/unschedule` | Cancel a scheduled post |
| `/subscribe` | Manage project subscriptions |
| `/subs` | List all subscriptions |

---

## Points System

| Action | Points |
|---|---|
| Daily check-in (gm) | +5 pts |
| Streak bonus (≥3 days) | +3 pts/day |
| Refer a builder | +50 pts |
| Being referred | +10 pts |
| Submit a project | +20 pts |
| Win trivia | +25 pts |
| Top 3 weekly | +100 pts |

**Claim:** Min 100 pts · Cooldown 7 days · 1 pt = 1,000 $BLUEAGENT

**Activity Tiers:**
| Tier | Requirement | Multiplier |
|---|---|---|
| Builder | Default | ×1.0 |
| Shipper | 30 days + 500 pts | ×1.3 |
| Founder | 60 days + 1,500 pts | ×1.5 |
| Legend | 90 days + 3,000 pts | ×2.0 |

---

## Auto Features

- **Trade tracker** — alerts on significant $BLUEAGENT buys/sells
- **Whale alert** — large transaction notifications
- **Gem signals** — trending tokens on Base
- **AI community manager** — auto-moderation + engagement
- **Anti-spam** — automatic spam detection
- **Scheduled posts** — timed announcements to group threads

---

## x402 AI Services

Pay-per-use AI services — no API key needed. Pay USDC on Base, get results instantly.

| Service | Price | Description |
|---|---|---|
| **Builder Score** | $0.001/req | AI score (0–100) for any builder on Base |
| **Deep Analysis** | $0.35/req | Token/project due diligence — risk, tokenomics, rug probability |
| **Wallet PnL** | $1.00/req | Wallet analysis — PnL, trading style, smart money score |
| **Launch Advisor** | $3.00/req | Full token launch playbook — tokenomics, timeline, marketing |
| **Grant Evaluator** | $5.00/req | Base grant application scoring against Coinbase criteria |
| **Risk Gate** | $0.05/req | Safety check before onchain tx — APPROVE / WARN / BLOCK |

```
Base URL: https://x402.bankr.bot/{treasury_address}/{service}
Payment: x402 · USDC on Base
Revenue: → treasury wallet
```

---

## Community Kit

White-label community bot for Base token projects.

| Tier | Price | Users |
|---|---|---|
| Free | $0 | 100 |
| Seed | $49/mo | 1,000 |
| Growth | $99/mo | 10,000 |
| Pro | $199/mo | Unlimited |
| Scale | $499/mo | White label + managed |

Contact: [@madebyshun](https://t.me/madebyshun)

---

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Bot:** node-telegram-bot-api
- **LLM:** Bankr LLM Gateway — multi-model routing (Claude, Gemini, GPT)
- **Agent:** Bankr Agent — real-time onchain + X data
- **Swap:** ethers.js + Uniswap v3 Router on Base
- **Chain:** Base (EVM)
- **Wallet:** ethers.js — auto-generated per user on `/start`
- **Process manager:** PM2

---

## Setup

```bash
npm install
npm run build
npm start
```

### Environment Variables

```env
TELEGRAM_BOT_TOKEN=your_token
BANKR_API_KEY=your_bankr_key
BANKR_LLM_KEY=your_bankr_key
BASESCAN_API_KEY=your_basescan_key        # optional
NEYNAR_API_KEY=your_neynar_key            # optional, Farcaster data
REWARD_WALLET_PRIVATE_KEY=0x...           # reward distribution wallet
REWARD_WALLET_ADDRESS=0x...
TREASURY_ADDRESS=0x...
AGENT_REWARDS_CONTRACT=0x...
```

### Config (`config.json`)

```json
{
  "token": {
    "symbol": "BLUEAGENT",
    "contract": "0xf895783b2931c919955e18b5e3343e7c7c456ba3",
    "tokens_per_point": 1000
  },
  "telegram": {
    "group_id": -100xxxxxxxxx,
    "bot_username": "blockyagent_bot",
    "threads": {
      "alpha": 15,
      "trades": 60,
      "feed": 18,
      "meme": 9,
      "builders": 5
    }
  }
}
```

---

## Ecosystem

| | |
|---|---|
| **$BLUEAGENT** | `0xf895783b2931c919955e18b5e3343e7c7c456ba3` (Base) |
| **$BLOCKY** | `0x1E11dC42b7916621EEE1874da5664d75A0D74b07` (Base) |
| **Treasury** | `0xf31f59e7b8b58555f7871f71973a394c8f1bffe5` |

---

## Links

- Bot: [@blockyagent_bot](https://t.me/blockyagent_bot)
- Community: [t.me/blueagent_hub](https://t.me/blueagent_hub)
- X/Twitter: [@blocky_agent](https://x.com/blocky_agent)
- Bankr profile: [bankr.bot/agent/blue-agent](https://bankr.bot/agent/blue-agent)
