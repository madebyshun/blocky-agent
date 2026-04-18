import { execSync } from 'child_process'

const TREASURY = process.env.BLUEAGENT_TREASURY ?? '0xf31f59e7b8b58555f7871f71973a394c8f1bffe5'
const BASE_URL = `https://x402.bankr.bot/${TREASURY}`
const BANKR_BIN = process.env.BANKR_BIN ?? '/usr/local/bin/bankr'

export function callX402(endpoint: string, body: Record<string, unknown>, priceUSD: number): unknown {
  const url = `${BASE_URL}/${endpoint}`
  const bodyStr = JSON.stringify(body).replace(/'/g, "'\\''")
  const maxPayment = Math.ceil(priceUSD * 2)
  const cmd = `${BANKR_BIN} x402 call "${url}" -X POST -d '${bodyStr}' -y --max-payment ${maxPayment} --raw`

  const stdout = execSync(cmd, {
    timeout: 60000,
    env: { ...process.env, PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}` },
    encoding: 'utf8'
  })

  // bankr CLI stdout includes metadata — extract "response" field directly
  const match = stdout.match(/"response"\s*:\s*(\{[\s\S]*?\})\s*,\s*"paymentMade"/)
  if (match) return JSON.parse(match[1])

  const jsonStart = stdout.indexOf('{')
  const parsed = JSON.parse((jsonStart >= 0 ? stdout.slice(jsonStart) : stdout).trim()) as Record<string, unknown>
  return parsed['response'] ?? parsed
}
