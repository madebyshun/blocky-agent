#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { callX402 } from './x402Client.js'
import { dataSkills } from './skills/data.js'
import { securitySkills } from './skills/security.js'
import { researchSkills } from './skills/research.js'
import { earnSkills } from './skills/earn.js'
import type { SkillDef } from './types.js'

const ALL_SKILLS: SkillDef[] = [
  ...dataSkills,
  ...securitySkills,
  ...researchSkills,
  ...earnSkills,
]

const skillMap = new Map(ALL_SKILLS.map(s => [s.name, s]))

const CATEGORY_LABEL: Record<string, string> = {
  data: 'DATA',
  security: 'SECURITY',
  research: 'RESEARCH',
  earn: 'EARN',
}

const server = new Server(
  { name: 'blueagent-skill', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_SKILLS.map(skill => ({
    name: skill.name,
    description: `[${CATEGORY_LABEL[skill.category]} · $${skill.priceUSD.toFixed(2)} USDC] ${skill.description}`,
    inputSchema: skill.inputSchema,
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  const skill = skillMap.get(name)

  if (!skill) {
    return {
      content: [{ type: 'text', text: `Unknown skill: ${name}. Available: ${ALL_SKILLS.map(s => s.name).join(', ')}` }],
      isError: true,
    }
  }

  try {
    const body = skill.buildBody(args as Record<string, string>)
    const data = callX402(skill.endpoint, body, skill.priceUSD)
    const result = {
      skill: skill.name,
      category: skill.category,
      priceUSD: skill.priceUSD,
      data,
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `Error calling ${name}: ${msg}` }],
      isError: true,
    }
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[BlueAgent Skill] MCP server running on stdio')
  console.error(`[BlueAgent Skill] ${ALL_SKILLS.length} skills loaded:`, ALL_SKILLS.map(s => s.name).join(', '))
}

main().catch(console.error)
