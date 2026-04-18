import type { SkillDef } from '../types.js'

export const researchSkills: SkillDef[] = [
  {
    name: 'analyze',
    category: 'research',
    description: 'Deep token and project due diligence — risk score, strengths, red flags, recommendation',
    priceUSD: 0.35,
    endpoint: 'deep-analysis',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: { type: 'string', description: 'Token name, ticker ($SYMBOL), or contract address' }
      },
      required: ['projectName']
    },
    buildBody: ({ projectName }) => ({ projectName })
  },
  {
    name: 'advisor',
    category: 'research',
    description: 'Full token launch playbook — strategy, timing, community growth, go-to-market plan',
    priceUSD: 3.00,
    endpoint: 'launch-advisor',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Describe your project and launch goals' },
        projectName: { type: 'string', description: 'Project name (optional)' }
      },
      required: ['description']
    },
    buildBody: ({ description, projectName }) => ({
      description,
      projectName: projectName ?? description.split(' ').slice(0, 3).join(' ')
    })
  },
  {
    name: 'grant',
    category: 'research',
    description: 'Base ecosystem grant scoring — overall score, suggested grant size, strengths and concerns',
    priceUSD: 5.00,
    endpoint: 'grant-evaluator',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Project description for grant evaluation' },
        projectName: { type: 'string', description: 'Project name' }
      },
      required: ['description']
    },
    buildBody: ({ description, projectName }) => ({
      description,
      projectName: projectName ?? description.split('—')[0]?.trim() ?? description
    })
  },
  {
    name: 'tokenomics-score',
    category: 'research',
    description: 'Tokenomics deep dive — supply structure, inflation rate, unlock cliff, sustainability score',
    priceUSD: 0.50,
    endpoint: 'tokenomics-score',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Token name, ticker, or contract address' }
      },
      required: ['token']
    },
    buildBody: ({ token }) => ({ token })
  },
  {
    name: 'narrative-pulse',
    category: 'research',
    description: 'Trending narratives in crypto right now — AI, RWA, DeFi, memes, Base ecosystem themes',
    priceUSD: 0.40,
    endpoint: 'narrative-pulse',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or sector to explore (e.g. "AI agents", "Base DeFi", "RWA")' }
      },
      required: ['query']
    },
    buildBody: ({ query }) => ({ query })
  },
  {
    name: 'vc-tracker',
    category: 'research',
    description: 'Track VC investments and thesis — who is backing what in crypto and Base ecosystem',
    priceUSD: 1.00,
    endpoint: 'vc-tracker',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'VC firm name, sector, or investment theme (e.g. "a16z crypto", "AI x DeFi")' }
      },
      required: ['query']
    },
    buildBody: ({ query }) => ({ query })
  },
  {
    name: 'whitepaper-tldr',
    category: 'research',
    description: 'Summarize any whitepaper or project docs into 5 key bullets in under 30 seconds',
    priceUSD: 0.20,
    endpoint: 'whitepaper-tldr',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to the whitepaper or project documentation' },
        projectName: { type: 'string', description: 'Project name (optional, improves context)' }
      },
      required: ['url']
    },
    buildBody: ({ url, projectName }) => ({ url, projectName: projectName ?? '' })
  }
]
