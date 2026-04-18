import type { SkillDef } from '../types.js'

export const dataSkills: SkillDef[] = [
  {
    name: 'pnl',
    category: 'data',
    description: 'Trading PnL report for any wallet — win rate, trading style, smart money score',
    priceUSD: 1.00,
    endpoint: 'wallet-pnl',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'EVM wallet address (0x...)' }
      },
      required: ['address']
    },
    buildBody: ({ address }) => ({ address, chain: 'base' })
  },
  {
    name: 'whale-tracker',
    category: 'data',
    description: 'Track smart money and whale wallet flows in real-time on Base',
    priceUSD: 0.10,
    endpoint: 'whale-tracker',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Wallet or token address to monitor' }
      },
      required: ['address']
    },
    buildBody: ({ address }) => ({ address, chain: 'base' })
  },
  {
    name: 'dex-flow',
    category: 'data',
    description: 'DEX volume, liquidity flow, and buy/sell pressure for any token on Base',
    priceUSD: 0.15,
    endpoint: 'dex-flow',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Token contract address or ticker symbol' }
      },
      required: ['token']
    },
    buildBody: ({ token }) => ({ token, chain: 'base' })
  },
  {
    name: 'unlock-alert',
    category: 'data',
    description: 'Token unlock schedule and vesting cliff analysis — when and how much unlocks',
    priceUSD: 0.20,
    endpoint: 'unlock-alert',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Token name, contract address, or ticker' }
      },
      required: ['token']
    },
    buildBody: ({ token }) => ({ token })
  }
]
