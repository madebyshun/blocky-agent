export interface SkillDef {
  name: string
  category: 'data' | 'security' | 'research' | 'earn'
  description: string
  priceUSD: number
  endpoint: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
  buildBody: (params: Record<string, string>) => Record<string, unknown>
}

export interface X402Result {
  skill: string
  category: string
  priceUSD: number
  data: Record<string, unknown>
}
