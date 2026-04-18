# BlueAgent Skill

**name:** blueagent
**emoji:** 🔵
**homepage:** https://t.me/BlueAgentBot
**token:** $BLUEAGENT · `0xf895783b2931c919955e18b5e3343e7c7c456ba3` (Base)
**payment:** x402 · USDC on Base · Pay-per-Use

---

BlueAgent is an onchain AI agent on Telegram built on Base. This skill exposes **21 x402 pay-per-use tools** across four categories: **Data**, **Security**, **Research**, and **Earn** — all callable via MCP or the Bankr CLI.

Each tool triggers a micropayment in USDC on Base via the x402 protocol. No subscription, no signup — just pay for what you use.

---

## Installation

```
install the blueagent skill from https://github.com/madebyshun/blue-agent/tree/claude/blueagent-skill-package-OE93s/packages/blueagent-skill
```

**Requirements:**
- Bankr CLI: `npm install -g @bankr/cli`
- Bankr account with USDC on Base: `bankr login`
- Node.js 20+

**Run the MCP server:**

```bash
npx @blueagent/skill
```

**Or add to your MCP client config:**

```json
{
  "mcpServers": {
    "blueagent": {
      "command": "npx",
      "args": ["@blueagent/skill"],
      "env": {
        "BLUEAGENT_TREASURY": "0xf31f59e7b8b58555f7871f71973a394c8f1bffe5",
        "BANKR_API_KEY": "your_bankr_api_key"
      }
    }
  }
}
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BANKR_API_KEY` | Yes | — | Your Bankr API key (`bankr login`) |
| `BLUEAGENT_TREASURY` | No | `0xf31f5...` | Treasury address for x402 payments |
| `BANKR_BIN` | No | `/usr/local/bin/bankr` | Path to bankr CLI binary |

---

## How Payments Work

Each tool call:
1. Sends a POST request to `https://x402.bankr.bot/{treasury}/{endpoint}`
2. Server responds with HTTP 402 + payment requirements
3. Bankr CLI automatically signs and submits USDC payment on Base
4. Service executes and returns JSON result

Payment is deducted from your Bankr wallet balance. Fund it at [bankr.bot](https://bankr.bot).

---

## Tools

### Data · Track the market

| Tool | Price | Description |
|------|-------|-------------|
| `pnl` | $1.00 | Trading PnL report — win rate, style, smart money score |
| `whale-tracker` | $0.10 | Smart money and whale flow monitoring on Base |
| `dex-flow` | $0.15 | DEX volume, liquidity, buy/sell pressure for any token |
| `unlock-alert` | $0.20 | Token unlock schedule and vesting cliff analysis |

**Example — wallet PnL:**

```
use the pnl tool with address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

```json
{
  "skill": "pnl",
  "category": "data",
  "priceUSD": 1.00,
  "data": {
    "estimatedPnL": "+$42,300",
    "winRate": "68%",
    "tradingStyle": "Swing Trader",
    "riskProfile": "Moderate",
    "smartMoneyScore": 82,
    "summary": "Strong performer with consistent gains on ETH and Base memecoins."
  }
}
```

---

### Security · Protect every move

| Tool | Price | Description |
|------|-------|-------------|
| `riskcheck` | $0.05 | Pre-tx safety check — APPROVE / WARN / BLOCK |
| `honeypot-check` | $0.05 | Detect honeypot or rug pull before buying |
| `phishing-scan` | $0.10 | Scan URL, contract, or handle for scam indicators |
| `aml-screen` | $0.25 | AML compliance and sanctions screening |
| `mev-shield` | $0.30 | MEV sandwich attack risk before large swaps |
| `quantum` | $1.50 | Quantum vulnerability score and migration steps |

**Example — risk check before approve:**

```
use the riskcheck tool with action "approve 0xABC123 to spend unlimited USDC from my wallet"
```

```json
{
  "skill": "riskcheck",
  "category": "security",
  "priceUSD": 0.05,
  "data": {
    "decision": "BLOCK",
    "riskScore": 94,
    "riskLevel": "CRITICAL",
    "recommendation": "Do not approve unlimited spend. Use exact amount instead.",
    "reasons": ["Unlimited approval is a common phishing vector", "Contract unverified"]
  }
}
```

**Quantum tiers:**

| Tier | Price | Use case |
|------|-------|---------|
| `lite` | $0.10 | Quick exposure check |
| `standard` | $1.50 | Full vulnerability report |
| `shield` | $0.25 | Mitigation recommendations only |
| `timeline` | $2.00 | Threat timeline projection |
| `batch` | $2.50 | Multiple wallets |
| `contract` | $5.00 | Smart contract quantum audit |

---

### Research · Know before you invest

| Tool | Price | Description |
|------|-------|-------------|
| `analyze` | $0.35 | Deep due diligence — risk score, strengths, red flags |
| `whitepaper-tldr` | $0.20 | 5-bullet whitepaper summary in 30 seconds |
| `tokenomics-score` | $0.50 | Supply, inflation, unlock cliff, sustainability |
| `narrative-pulse` | $0.40 | Trending narratives and hot themes in crypto |
| `vc-tracker` | $1.00 | Who is backing what — VC investment tracking |
| `advisor` | $3.00 | Full token launch playbook |
| `grant` | $5.00 | Base ecosystem grant scoring and feedback |

**Example — analyze a token:**

```
use the analyze tool with projectName "$BLUEAGENT"
```

```json
{
  "skill": "analyze",
  "category": "research",
  "priceUSD": 0.35,
  "data": {
    "overallScore": 78,
    "riskScore": 35,
    "recommendation": "BUY — Strong community, active dev, Base ecosystem alignment",
    "summary": "BlueAgent is a Telegram-native AI agent with real revenue from x402 services.",
    "keyStrengths": ["Active builder community", "Real x402 revenue model", "Base ecosystem native"],
    "keyRisks": ["Small float", "Telegram-dependent distribution"]
  }
}
```

---

### Earn · Find yield and opportunities

| Tool | Price | Description |
|------|-------|-------------|
| `airdrop-check` | $0.10 | Airdrop eligibility and estimated value |
| `yield-optimizer` | $0.15 | Best APY on Base DeFi for any token |
| `lp-analyzer` | $0.30 | LP health — IL, fees earned, rebalance tips |
| `tax-report` | $2.00 | On-chain tax report with gains/losses |

**Example — check airdrops:**

```
use the airdrop-check tool with address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

```json
{
  "skill": "airdrop-check",
  "category": "earn",
  "priceUSD": 0.10,
  "data": {
    "eligible": ["Aerodrome Season 3", "Base Name Service", "Zora Network"],
    "estimatedValue": "$340–$820 USDC",
    "topOpportunity": "Aerodrome — 2,400 AERO (~$180)"
  }
}
```

---

## Using via Bankr CLI directly

```bash
# Risk check
bankr x402 call "https://x402.bankr.bot/0xf31f59e7b8b58555f7871f71973a394c8f1bffe5/risk-gate" \
  -X POST \
  -d '{"action":"swap 1 ETH to USDC on Uniswap"}' \
  -y --max-payment 1 --raw

# Analyze a token
bankr x402 call "https://x402.bankr.bot/0xf31f59e7b8b58555f7871f71973a394c8f1bffe5/deep-analysis" \
  -X POST \
  -d '{"projectName":"BLUEAGENT"}' \
  -y --max-payment 1 --raw

# Wallet PnL
bankr x402 call "https://x402.bankr.bot/0xf31f59e7b8b58555f7871f71973a394c8f1bffe5/wallet-pnl" \
  -X POST \
  -d '{"address":"0xYOUR_WALLET","chain":"base"}' \
  -y --max-payment 3 --raw
```

---

## Pricing Summary

| Category | Tools | Price Range |
|----------|-------|-------------|
| Data | 4 tools | $0.10 – $1.00 |
| Security | 6 tools | $0.05 – $1.50 |
| Research | 7 tools | $0.20 – $5.00 |
| Earn | 4 tools | $0.10 – $2.00 |

All payments in **USDC on Base** via x402 protocol.

---

## Links

- **Telegram Bot:** https://t.me/BlueAgentBot
- **Token:** `0xf895783b2931c919955e18b5e3343e7c7c456ba3` on Base
- **MCP Schema:** `packages/blueagent-skill/schemas/tools.json`
- **Source:** https://github.com/madebyshun/blue-agent
