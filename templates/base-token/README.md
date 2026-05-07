# {{PROJECT_NAME}} Token — ERC-20 on Base

A minimal ERC-20 token with permit support, built with Foundry and deployable to Base (chain 8453).

## What it is

This template gives you:
- An ERC-20 token with `ERC20Permit` (gasless approvals via signatures)
- Owner-controlled minting up to a 1 billion max supply
- A TypeScript deploy script using ethers.js v6
- Foundry config targeting Base mainnet and Basescan verification

## Prerequisites

Install [Foundry](https://book.getfoundry.sh/):
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

## Setup

```bash
# 1. Install OpenZeppelin contracts
forge install OpenZeppelin/openzeppelin-contracts

# 2. Copy env and fill in your keys
cp .env.example .env

# 3. Install deploy script dependencies
npm install
```

## Build and test

```bash
# Compile contracts
forge build
# or: npm run build

# Run tests
forge test
# or: npm run test
```

## Deploy to Base

```bash
# Deploy (loads env automatically)
npm run deploy
```

The deploy script:
1. Verifies you are on Base mainnet (chain 8453) — refuses other networks
2. Loads the compiled artifact from `out/`
3. Deploys the contract and prints the address + Basescan link
4. Prints the Foundry verify command

## Verify on Basescan

```bash
forge verify-contract <deployed-address> contracts/Token.sol:{{PROJECT_NAME}}Token \
  --chain-id 8453 \
  --watch
```

Get a free Basescan API key at [basescan.org](https://basescan.org/myapikey).

## Customize

Edit `scripts/deploy.ts`:
```typescript
const TOKEN_NAME    = "My Token";
const TOKEN_SYMBOL  = "MTK";
const INITIAL_SUPPLY = ethers.parseUnits("100000000", 18); // 100M tokens
```

Edit `contracts/Token.sol` to adjust `MAX_SUPPLY` or add functionality.

## Base addresses (verified)

Only use verified addresses on Base. Do not guess or invent addresses.

| Token | Address |
|---|---|
| USDC (Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

All other addresses should be verified on [Basescan](https://basescan.org) before use.

## Built by

[Blocky Studio](https://blocky.studio) — [@blocky_agent](https://x.com/blocky_agent)

Telegram community: [t.me/blueagent_hub](https://t.me/blueagent_hub)
