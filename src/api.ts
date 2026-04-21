import * as http from 'http'
import { execSync } from 'child_process'

const TREASURY = process.env.BLUEAGENT_TREASURY ?? '0xf31f59e7b8b58555f7871f71973a394c8f1bffe5'
const BASE_URL = `https://x402.bankr.bot/${TREASURY}`
const BANKR_BIN = process.env.BANKR_BIN ?? '/usr/local/bin/bankr'
const API_KEY = process.env.ESP32_API_KEY ?? 'esp32-blueagent-key'
const PORT = parseInt(process.env.API_PORT ?? '3402')

interface SkillMeta {
  endpoint: string
  price: number
  category: 'security' | 'data' | 'research' | 'earn'
  inputKey: string
  description: string
}

const SKILLS: Record<string, SkillMeta> = {
  // Security
  'risk-gate':       { endpoint: 'risk-gate',       price: 0.05, category: 'security', inputKey: 'action',      description: 'Pre-tx safety check' },
  'honeypot-check':  { endpoint: 'honeypot-check',  price: 0.05, category: 'security', inputKey: 'token',       description: 'Honeypot / rug detector' },
  'phishing-scan':   { endpoint: 'phishing-scan',   price: 0.10, category: 'security', inputKey: 'target',      description: 'Phishing URL/handle scan' },
  'aml-screen':      { endpoint: 'aml-screen',      price: 0.25, category: 'security', inputKey: 'address',     description: 'AML wallet screening' },
  'mev-shield':      { endpoint: 'mev-shield',      price: 0.30, category: 'security', inputKey: 'action',      description: 'MEV attack risk check' },
  'quantum-premium': { endpoint: 'quantum-premium', price: 1.50, category: 'security', inputKey: 'address',     description: 'Quantum vulnerability scan' },
  // Data
  'wallet-pnl':      { endpoint: 'wallet-pnl',      price: 1.00, category: 'data',     inputKey: 'address',     description: 'Wallet PnL report' },
  'whale-tracker':   { endpoint: 'whale-tracker',   price: 0.10, category: 'data',     inputKey: 'address',     description: 'Smart money flows' },
  'dex-flow':        { endpoint: 'dex-flow',        price: 0.15, category: 'data',     inputKey: 'token',       description: 'DEX buy/sell pressure' },
  'unlock-alert':    { endpoint: 'unlock-alert',    price: 0.20, category: 'data',     inputKey: 'token',       description: 'Token unlock schedule' },
  'airdrop-check':   { endpoint: 'airdrop-check',   price: 0.10, category: 'data',     inputKey: 'address',     description: 'Airdrop eligibility' },
  // Research
  'deep-analysis':   { endpoint: 'deep-analysis',   price: 0.35, category: 'research', inputKey: 'projectName', description: 'Deep token due diligence' },
  'whitepaper-tldr': { endpoint: 'whitepaper-tldr', price: 0.20, category: 'research', inputKey: 'url',         description: 'Whitepaper TL;DR' },
  'tokenomics-score':{ endpoint: 'tokenomics-score',price: 0.50, category: 'research', inputKey: 'token',       description: 'Tokenomics score' },
  'narrative-pulse': { endpoint: 'narrative-pulse', price: 0.40, category: 'research', inputKey: 'query',       description: 'Narrative trend analysis' },
  'vc-tracker':      { endpoint: 'vc-tracker',      price: 1.00, category: 'research', inputKey: 'query',       description: 'VC funding tracker' },
  'launch-advisor':  { endpoint: 'launch-advisor',  price: 3.00, category: 'research', inputKey: 'description', description: 'Token launch advisor' },
  'grant-evaluator': { endpoint: 'grant-evaluator', price: 5.00, category: 'research', inputKey: 'description', description: 'Grant proposal evaluator' },
  // Earn
  'yield-optimizer': { endpoint: 'yield-optimizer', price: 0.15, category: 'earn',     inputKey: 'token',       description: 'Best yield opportunities' },
  'lp-analyzer':     { endpoint: 'lp-analyzer',     price: 0.30, category: 'earn',     inputKey: 'address',     description: 'LP position analysis' },
  'tax-report':      { endpoint: 'tax-report',      price: 2.00, category: 'earn',     inputKey: 'address',     description: 'Onchain tax report' },
}

function callX402(endpoint: string, body: Record<string, unknown>, priceUSD: number): unknown {
  const url = `${BASE_URL}/${endpoint}`
  const bodyStr = JSON.stringify(body).replace(/'/g, "'\\''")
  const maxPayment = Math.ceil(priceUSD * 2)
  const cmd = `${BANKR_BIN} x402 call "${url}" -X POST -d '${bodyStr}' -y --max-payment ${maxPayment} --raw`

  const stdout = execSync(cmd, {
    timeout: 60000,
    env: { ...process.env, PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}` },
    encoding: 'utf8'
  })

  const match = stdout.match(/"response"\s*:\s*(\{[\s\S]*?\})\s*,\s*"paymentMade"/)
  if (match) return JSON.parse(match[1])

  const jsonStart = stdout.indexOf('{')
  const parsed = JSON.parse((jsonStart >= 0 ? stdout.slice(jsonStart) : stdout).trim()) as Record<string, unknown>
  return parsed['response'] ?? parsed
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(data))
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'X-API-Key,Content-Type', 'Access-Control-Allow-Methods': 'GET,POST' })
    res.end()
    return
  }

  const apiKey = req.headers['x-api-key']
  if (apiKey !== API_KEY) {
    sendJson(res, 401, { error: 'Unauthorized' })
    return
  }

  // GET /api/skills — ESP32 fetches menu on boot
  if (req.method === 'GET' && req.url === '/api/skills') {
    const list = Object.entries(SKILLS).map(([name, s]) => ({
      name, endpoint: s.endpoint, price: s.price,
      category: s.category, inputKey: s.inputKey, description: s.description
    }))
    sendJson(res, 200, { skills: list })
    return
  }

  // POST /api/x402/:skill
  const routeMatch = req.url?.match(/^\/api\/x402\/([a-z0-9-]+)$/)
  if (!routeMatch || req.method !== 'POST') {
    sendJson(res, 404, { error: 'Not found' })
    return
  }

  const skillName = routeMatch[1]
  const skill = SKILLS[skillName]
  if (!skill) {
    sendJson(res, 400, { error: `Unknown skill: ${skillName}`, available: Object.keys(SKILLS) })
    return
  }

  let rawBody = ''
  req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
  req.on('end', () => {
    let params: Record<string, unknown> = {}
    try {
      params = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {}
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return
    }

    // Inject chain default for address-based skills
    if (params['address'] && !params['chain']) params['chain'] = 'base'
    if (params['token'] && !params['chain']) params['chain'] = 'base'

    console.log(`[x402 API] ${skillName} → $${skill.price}`, params)
    try {
      const result = callX402(skill.endpoint, params, skill.price)
      sendJson(res, 200, { skill: skillName, price: skill.price, category: skill.category, result })
    } catch (err: any) {
      console.error(`[x402 API] Error calling ${skillName}:`, err.message)
      sendJson(res, 500, { error: err.message?.slice(0, 300) ?? 'x402 call failed' })
    }
  })
}

export function startApiServer(): void {
  const server = http.createServer(handleRequest)
  server.listen(PORT, () => {
    console.log(`[x402 API] BlueAgent terminal proxy listening on port ${PORT}`)
    console.log(`[x402 API] Skills available: ${Object.keys(SKILLS).length}`)
  })
}
