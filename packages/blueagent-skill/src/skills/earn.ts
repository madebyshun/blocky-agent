import type { SkillDef } from '../types.js'

export const earnSkills: SkillDef[] = [
  {
    name: 'yield-optimizer',
    category: 'earn',
    description: 'Find best APY opportunities on Base DeFi protocols — compare lending, LPing, and staking',
    priceUSD: 0.15,
    endpoint: 'yield-optimizer',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Token to optimize yield for (e.g. USDC, ETH, BLUEAGENT)' }
      },
      required: ['token']
    },
    buildBody: ({ token }) => ({ token, chain: 'base' })
  },
  {
    name: 'airdrop-check',
    category: 'earn',
    description: 'Check wallet eligibility for upcoming airdrops and estimate potential value',
    priceUSD: 0.10,
    endpoint: 'airdrop-check',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Wallet address to check for airdrop eligibility' }
      },
      required: ['address']
    },
    buildBody: ({ address }) => ({ address, chain: 'base' })
  },
  {
    name: 'lp-analyzer',
    category: 'earn',
    description: 'LP position health check — impermanent loss, fee income earned, rebalance recommendation',
    priceUSD: 0.30,
    endpoint: 'lp-analyzer',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Wallet address holding LP positions' },
        pool: { type: 'string', description: 'Pool address or pair name (optional, e.g. ETH/USDC)' }
      },
      required: ['address']
    },
    buildBody: ({ address, pool }) => ({ address, pool: pool ?? '', chain: 'base' })
  },
  {
    name: 'tax-report',
    category: 'earn',
    description: 'Generate on-chain tax report — realized gains/losses, income events, DeFi transactions',
    priceUSD: 2.00,
    endpoint: 'tax-report',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Wallet address for tax report' },
        year: { type: 'string', description: 'Tax year (e.g. 2025, defaults to previous year)' }
      },
      required: ['address']
    },
    buildBody: ({ address, year }) => ({
      address,
      year: year ?? String(new Date().getFullYear() - 1),
      chain: 'base'
    })
  }
]
