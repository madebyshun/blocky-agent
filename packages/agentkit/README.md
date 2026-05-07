# @blueagent/agentkit

Coinbase AgentKit plugin for [Blue Agent](https://blueagent.xyz) — 32 x402-powered AI tools on Base.

Built by [Blocky Studio](https://blocky.studio).

## Install

```bash
npm install @blueagent/agentkit
```

## Setup

Set environment variables:

```bash
BLUEAGENT_API_URL=https://api.blueagent.xyz
BLUEAGENT_API_KEY=your_api_key   # optional, for pre-authorized access
```

## Usage with AgentKit

```typescript
import { createBlueAgentProvider } from "@blueagent/agentkit";
import { AgentKit } from "@coinbase/agentkit";

// Create the Blue Agent provider
const blueAgentProvider = createBlueAgentProvider({
  baseUrl: process.env.BLUEAGENT_API_URL,
  apiKey: process.env.BLUEAGENT_API_KEY,
  // Optional: provide a signPayment function for automatic x402 payments
  signPayment: async (requirement) => {
    // Implement x402 payment signing with your wallet
    // Returns base64-encoded X-Payment header value
    throw new Error("Implement signPayment to enable automatic x402 payments");
  },
});

// Add to AgentKit
const agentKit = new AgentKit({
  cdpApiKeyName: process.env.CDP_API_KEY_NAME,
  cdpApiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY,
  actionProviders: [blueAgentProvider],
});
```

### x402 Payment Signing

Blue Agent tools use the [x402 payment protocol](https://x402.org) for micropayments on Base. To enable automatic payment handling, implement the `signPayment` callback:

```typescript
import { buildExactPayment, encodeX402Header } from "@blueagent/payments";

const blueAgentProvider = createBlueAgentProvider({
  signPayment: async (requirement) => {
    const payment = await buildExactPayment(wallet, requirement);
    return encodeX402Header(payment);
  },
});
```

## Available Tools

| Tool | Description | Price |
|------|-------------|-------|
| `risk_gate` | Screen a transaction before execution — flags high-risk actions on Base | $0.05 |
| `honeypot_check` | Detect honeypot tokens — checks if a token can be sold after purchase | $0.10 |
| `allowance_audit` | Audit all active ERC-20 token allowances for a wallet | $0.10 |
| `phishing_scan` | Scan a URL, contract, or handle for phishing indicators | $0.10 |
| `mev_shield` | Analyze a swap for MEV sandwich attack risk | $0.10 |
| `contract_trust` | Score a smart contract's trustworthiness | $0.10 |
| `circuit_breaker` | Evaluate whether an agent action should be paused | $0.10 |
| `key_exposure` | Check if a wallet has been flagged for key compromise | $0.10 |
| `quantum_premium` | Deep quantum-readiness analysis for a single wallet | $1.50 |
| `quantum_batch` | Batch quantum-readiness check for up to 10 wallets | $2.50 |
| `quantum_migrate` | Generate a quantum-safe migration plan for a wallet | $0.10 |
| `quantum_timeline` | Get projected quantum threat timeline for Ethereum wallets | $0.10 |
| `deep_analysis` | Comprehensive token analysis — fundamentals, tokenomics, risk score | $0.35 |
| `token_launch` | Launch a new token on Base | $1.00 |
| `launch_advisor` | AI-powered launch strategy for your project | $3.00 |
| `grant_evaluator` | Evaluate project eligibility for Base ecosystem grants | $5.00 |
| `x402_readiness` | Audit an API for x402 payment protocol compliance | $0.10 |
| `base_deploy_check` | Verify a deployed contract on Base | $0.10 |
| `tokenomics_score` | Score a token's economic model and sustainability | $0.10 |
| `whitepaper_tldr` | Summarize a whitepaper into a concise TL;DR | $0.10 |
| `vc_tracker` | Track recent VC investments in a sector | $0.10 |
| `wallet_pnl` | Calculate realized and unrealized PnL for a wallet | $1.00 |
| `whale_tracker` | Track large wallet movements for a token | $0.10 |
| `aml_screen` | AML screening against sanctions and flagged addresses | $0.10 |
| `airdrop_check` | Check a wallet's eligibility for active airdrops | $0.10 |
| `narrative_pulse` | Get current narrative trends and sentiment in crypto | $0.10 |
| `dex_flow` | Analyze DEX trading flow and order book depth | $0.10 |
| `yield_optimizer` | Find best yield opportunities across Base DeFi | $0.10 |
| `lp_analyzer` | Analyze LP positions — impermanent loss, fees, rebalancing | $0.10 |
| `tax_report` | Generate a tax report for a wallet for a specific year | $0.10 |
| `alert_subscribe` | Subscribe to real-time on-chain alerts for a wallet | $0.10 |
| `alert_check` | Check the status of active alerts for a wallet | $0.10 |

All payments are in USDC on Base (chain ID 8453).

## Links

- [Blue Agent](https://blueagent.xyz)
- [Blocky Studio](https://blocky.studio)
- [Twitter/X](https://x.com/blocky_agent)
- [Telegram](https://t.me/blueagent_hub)
