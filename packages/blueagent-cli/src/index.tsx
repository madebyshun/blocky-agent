#!/usr/bin/env node
import React, { useState, useCallback } from 'react'
import { render, Box, Text, useApp, useInput } from 'ink'
import SelectInput from 'ink-select-input'
import TextInput from 'ink-text-input'
import Spinner from 'ink-spinner'
import figlet from 'figlet'
import { exec } from 'child_process'

// ── Config ──────────────────────────────────────────────────────────
const TREASURY = process.env.BLUEAGENT_TREASURY ?? '0xf31f59e7b8b58555f7871f71973a394c8f1bffe5'
const BANKR_BIN = process.env.BANKR_BIN ?? '/usr/local/bin/bankr'
const DEMO_MODE = process.env.DEMO_MODE === 'true'

// ── Terminal tab title ───────────────────────────────────────────────
process.title = 'blueagent'
process.stdout.write('\x1b]0;blueagent\x07')

// ── ASCII Title ──────────────────────────────────────────────────────
const TITLE = figlet.textSync('BLUEAGENT', { font: 'Banner3' })

// ── Skills Data ──────────────────────────────────────────────────────
interface Skill {
  name: string
  endpoint: string
  priceUSD: number
  inputKey: string
  prompt: string
  chain?: string
}

const SKILLS: Record<string, Skill[]> = {
  Security: [
    { name: 'riskcheck',      endpoint: 'risk-gate',       priceUSD: 0.05, inputKey: 'action',  prompt: 'Describe the action to check:' },
    { name: 'honeypot-check', endpoint: 'honeypot-check',  priceUSD: 0.05, inputKey: 'token',   prompt: 'Token contract address:', chain: 'base' },
    { name: 'phishing-scan',  endpoint: 'phishing-scan',   priceUSD: 0.10, inputKey: 'target',  prompt: 'URL, contract, or @handle:' },
    { name: 'aml-screen',     endpoint: 'aml-screen',      priceUSD: 0.25, inputKey: 'address', prompt: 'Wallet address:', chain: 'base' },
    { name: 'mev-shield',     endpoint: 'mev-shield',      priceUSD: 0.30, inputKey: 'action',  prompt: 'Describe the swap:', chain: 'base' },
    { name: 'quantum',        endpoint: 'quantum-premium', priceUSD: 1.50, inputKey: 'address', prompt: 'Wallet address:', chain: 'base' },
  ],
  Data: [
    { name: 'pnl',           endpoint: 'wallet-pnl',    priceUSD: 1.00, inputKey: 'address', prompt: 'Wallet address:', chain: 'base' },
    { name: 'whale-tracker', endpoint: 'whale-tracker', priceUSD: 0.10, inputKey: 'address', prompt: 'Wallet or token address:', chain: 'base' },
    { name: 'dex-flow',      endpoint: 'dex-flow',      priceUSD: 0.15, inputKey: 'token',   prompt: 'Token address or ticker:', chain: 'base' },
    { name: 'unlock-alert',  endpoint: 'unlock-alert',  priceUSD: 0.20, inputKey: 'token',   prompt: 'Token name or address:' },
  ],
  Research: [
    { name: 'analyze',          endpoint: 'deep-analysis',   priceUSD: 0.35, inputKey: 'projectName', prompt: 'Token name, ticker, or address:' },
    { name: 'whitepaper-tldr',  endpoint: 'whitepaper-tldr', priceUSD: 0.20, inputKey: 'url',         prompt: 'Whitepaper URL:' },
    { name: 'tokenomics-score', endpoint: 'tokenomics-score',priceUSD: 0.50, inputKey: 'token',       prompt: 'Token name or address:' },
    { name: 'narrative-pulse',  endpoint: 'narrative-pulse', priceUSD: 0.40, inputKey: 'query',       prompt: 'Topic (e.g. AI agents, RWA):' },
    { name: 'vc-tracker',       endpoint: 'vc-tracker',      priceUSD: 1.00, inputKey: 'query',       prompt: 'VC name or theme:' },
    { name: 'advisor',          endpoint: 'launch-advisor',  priceUSD: 3.00, inputKey: 'description', prompt: 'Describe your project:' },
    { name: 'grant',            endpoint: 'grant-evaluator', priceUSD: 5.00, inputKey: 'description', prompt: 'Project description:' },
  ],
  Earn: [
    { name: 'airdrop-check',   endpoint: 'airdrop-check',  priceUSD: 0.10, inputKey: 'address', prompt: 'Wallet address:', chain: 'base' },
    { name: 'yield-optimizer', endpoint: 'yield-optimizer',priceUSD: 0.15, inputKey: 'token',   prompt: 'Token (USDC, ETH...):', chain: 'base' },
    { name: 'lp-analyzer',     endpoint: 'lp-analyzer',    priceUSD: 0.30, inputKey: 'address', prompt: 'Wallet address:', chain: 'base' },
    { name: 'tax-report',      endpoint: 'tax-report',     priceUSD: 2.00, inputKey: 'address', prompt: 'Wallet address:', chain: 'base' },
  ],
}

// ── Mock Results for Demo Mode ────────────────────────────────────────
const MOCK: Record<string, unknown> = {
  'riskcheck':      { decision: 'BLOCK', riskScore: 94, riskLevel: 'CRITICAL', recommendation: 'Do not approve unlimited spend. Use exact amount instead.', reasons: ['Unlimited approval is a common phishing vector', 'Contract unverified on Basescan'] },
  'honeypot-check': { isHoneypot: false, canSell: true, buyTax: '0%', sellTax: '0%', verdict: 'SAFE', token: '$BLUEAGENT', note: 'Contract verified, liquidity locked' },
  'analyze':        { overallScore: 78, riskScore: 35, recommendation: 'BUY', summary: 'Strong community + real x402 revenue. Native Base ecosystem play.', keyStrengths: ['Active builder community', 'Real x402 revenue model', 'Base ecosystem native'], keyRisks: ['Small float', 'Telegram-dependent distribution'] },
  'pnl':            { estimatedPnL: '+$42,300', winRate: '68%', tradingStyle: 'Swing Trader', riskProfile: 'Moderate', smartMoneyScore: 82, summary: 'Strong performer. Consistent gains on ETH and Base memecoins.' },
  'airdrop-check':  { eligible: ['Aerodrome Season 3', 'Base Name Service', 'Zora Network'], estimatedValue: '$340–$820 USDC', topOpportunity: 'Aerodrome — 2,400 AERO (~$180)', deadline: '2025-05-15' },
  'yield-optimizer':{ topOpportunities: [{ protocol: 'Aerodrome', pair: 'USDC/ETH', apy: '18.4%' }, { protocol: 'Moonwell', asset: 'USDC', apy: '9.2%' }, { protocol: 'Aave v3', asset: 'USDC', apy: '6.8%' }] },
  'whale-tracker':  { recentMoves: [{ wallet: '0xd8dA...045', action: 'BUY 250k BLUEAGENT', value: '$8,500', time: '12m ago' }, { wallet: '0x47ac...01c8', action: 'ADD LP ETH/USDC', value: '$120,000', time: '1h ago' }] },
  'narrative-pulse':{ trending: ['AI Agents on Base', 'RWA tokenization', 'x402 pay-per-use'], heatScore: 92, summary: 'AI agents + micropayments narrative is accelerating. Base ecosystem getting major VC attention.' },
}

function getMockResult(skillName: string): unknown {
  return MOCK[skillName] ?? { status: 'ok', message: `${skillName} completed successfully`, timestamp: new Date().toISOString() }
}

// ── x402 Call ────────────────────────────────────────────────────────
function callX402(skill: Skill, inputValue: string): Promise<unknown> {
  if (DEMO_MODE) {
    return new Promise(resolve => setTimeout(() => resolve(getMockResult(skill.name)), 1500))
  }

  const url = `https://x402.bankr.bot/${TREASURY}/${skill.endpoint}`
  const body: Record<string, string> = { [skill.inputKey]: inputValue }
  if (skill.chain) body['chain'] = skill.chain
  const bodyStr = JSON.stringify(body).replace(/'/g, "'\\''")
  const maxPayment = Math.ceil(skill.priceUSD * 2)
  const cmd = `${BANKR_BIN} x402 call "${url}" -X POST -d '${bodyStr}' -y --max-payment ${maxPayment} --raw`

  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 60000 }, (err, stdout) => {
      if (err && !stdout) { reject(err); return }
      try {
        const match = stdout.match(/"response"\s*:\s*(\{[\s\S]*?\})\s*,\s*"paymentMade"/)
        if (match) { resolve(JSON.parse(match[1])); return }
        const jsonStart = stdout.indexOf('{')
        const parsed = JSON.parse((jsonStart >= 0 ? stdout.slice(jsonStart) : stdout).trim()) as Record<string, unknown>
        resolve(parsed['response'] ?? parsed)
      } catch { reject(new Error('Invalid response from x402')) }
    })
  })
}

// ── Components ───────────────────────────────────────────────────────
function Header({ breadcrumb }: { breadcrumb: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="blue" bold>{TITLE}</Text>
      {breadcrumb && (
        <Box>
          <Text color="cyan">{breadcrumb}</Text>
          <Text color="gray">{'─'.repeat(Math.max(0, 50 - breadcrumb.length))}</Text>
        </Box>
      )}
    </Box>
  )
}

function Footer() {
  return (
    <Box marginTop={1}>
      <Text color="gray" dimColor>esc back{'  '}ctrl+c quit</Text>
      {DEMO_MODE && <Text color="yellow" dimColor>{'  '}[DEMO MODE]</Text>}
    </Box>
  )
}

// ── Main App ─────────────────────────────────────────────────────────
type Screen = 'menu' | 'tools' | 'input' | 'loading' | 'result'

function App() {
  const { exit } = useApp()
  const [screen, setScreen]       = useState<Screen>('menu')
  const [category, setCategory]   = useState('')
  const [skill, setSkill]         = useState<Skill | null>(null)
  const [inputVal, setInputVal]   = useState('')
  const [result, setResult]       = useState<unknown>(null)
  const [error, setError]         = useState<string | null>(null)

  const breadcrumb = [category, skill?.name].filter(Boolean).join(' > ')

  const goBack = useCallback(() => {
    if (screen === 'menu')    exit()
    if (screen === 'tools')   { setScreen('menu');  setCategory('') }
    if (screen === 'input')     setScreen('tools')
    if (screen === 'result')    setScreen('tools')
  }, [screen, exit])

  useInput((_input, key) => {
    if (key.escape) goBack()
  })

  const handleCategorySelect = useCallback((item: { value: string }) => {
    setCategory(item.value)
    setScreen('tools')
  }, [])

  const handleToolSelect = useCallback((item: { label: string; value: string }) => {
    const found = SKILLS[category]?.find(s => s.name === item.value)
    if (!found) return
    setSkill(found)
    setInputVal('')
    setScreen('input')
  }, [category])

  const handleSubmit = useCallback(async (value: string) => {
    if (!skill || !value.trim()) return
    setScreen('loading')
    try {
      const data = await callX402(skill, value.trim())
      setResult(data)
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setResult(null)
    }
    setScreen('result')
  }, [skill])

  const categoryItems = Object.keys(SKILLS).map(c => ({ label: c, value: c }))
  const toolItems = category
    ? SKILLS[category].map(s => ({ label: `${s.name.padEnd(22)}$${s.priceUSD.toFixed(2)}`, value: s.name }))
    : []

  return (
    <Box flexDirection="column" paddingX={2} paddingTop={1}>
      <Header breadcrumb={breadcrumb} />

      {screen === 'menu' && (
        <SelectInput items={categoryItems} onSelect={handleCategorySelect} />
      )}

      {screen === 'tools' && (
        <SelectInput items={toolItems} onSelect={handleToolSelect} />
      )}

      {screen === 'input' && skill && (
        <Box flexDirection="column">
          <Text color="yellow">{skill.prompt}</Text>
          <Box marginTop={1}>
            <Text color="blue">❯ </Text>
            <TextInput value={inputVal} onChange={setInputVal} onSubmit={handleSubmit} />
          </Box>
        </Box>
      )}

      {screen === 'loading' && (
        <Box gap={1}>
          <Text color="green"><Spinner type="dots" /></Text>
          <Text color="gray">Calling {skill?.name}  (${skill?.priceUSD.toFixed(2)} USDC)...</Text>
        </Box>
      )}

      {screen === 'result' && (
        <Box flexDirection="column">
          {error
            ? <Text color="red">✖  {error}</Text>
            : <Text color="green">{JSON.stringify(result, null, 2)}</Text>
          }
          <Box marginTop={1}>
            <Text color="gray" dimColor>esc to go back</Text>
          </Box>
        </Box>
      )}

      <Footer />
    </Box>
  )
}

render(<App />)
