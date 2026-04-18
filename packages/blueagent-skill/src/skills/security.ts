import type { SkillDef } from '../types.js'

export const securitySkills: SkillDef[] = [
  {
    name: 'riskcheck',
    category: 'security',
    description: 'Pre-transaction safety check — APPROVE / WARN / BLOCK decision with risk score',
    priceUSD: 0.05,
    endpoint: 'risk-gate',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Describe the onchain action (e.g. "approve 0xABC to spend all my USDC")' }
      },
      required: ['action']
    },
    buildBody: ({ action }) => ({ action })
  },
  {
    name: 'quantum',
    category: 'security',
    description: 'Quantum-resistant security analysis for any wallet — vulnerability score, threat timeline, migration steps',
    priceUSD: 1.50,
    endpoint: 'quantum-premium',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Wallet address to analyze' },
        tier: { type: 'string', description: 'Analysis tier: lite ($0.10) | standard ($1.50) | batch ($2.50) | shield ($0.25) | timeline ($2.00) | contract ($5.00)' }
      },
      required: ['address']
    },
    buildBody: ({ address, tier = 'standard' }) => ({ address, chain: 'base', tier })
  },
  {
    name: 'honeypot-check',
    category: 'security',
    description: 'Detect honeypot, rug pull, or malicious token contract before buying',
    priceUSD: 0.05,
    endpoint: 'honeypot-check',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Token contract address to check' }
      },
      required: ['token']
    },
    buildBody: ({ token }) => ({ token, chain: 'base' })
  },
  {
    name: 'aml-screen',
    category: 'security',
    description: 'AML compliance check and sanctions screening for any wallet address',
    priceUSD: 0.25,
    endpoint: 'aml-screen',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Wallet address to screen' }
      },
      required: ['address']
    },
    buildBody: ({ address }) => ({ address, chain: 'base' })
  },
  {
    name: 'mev-shield',
    category: 'security',
    description: 'MEV risk assessment before large swaps — sandwich attack probability and protection strategies',
    priceUSD: 0.30,
    endpoint: 'mev-shield',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Describe the swap (e.g. "swap 10 ETH to USDC on Uniswap v3")' }
      },
      required: ['action']
    },
    buildBody: ({ action }) => ({ action, chain: 'base' })
  },
  {
    name: 'phishing-scan',
    category: 'security',
    description: 'Scan URL, contract address, or social handle for phishing and scam indicators',
    priceUSD: 0.10,
    endpoint: 'phishing-scan',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'URL, contract address, or @handle to scan' }
      },
      required: ['target']
    },
    buildBody: ({ target }) => ({ target })
  }
]
