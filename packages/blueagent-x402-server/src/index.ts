import 'dotenv/config'
import express from 'express'
import { paymentMiddleware } from '@x402/express'
import {
  whaleTracker, dexFlow, unlockAlert,
  honeypotCheck, amlScreen, mevShield, phishingScan,
  tokenomicsScore, narrativePulse, vcTracker, whitepaperTldr,
  yieldOptimizer, airdropCheck, lpAnalyzer, taxReport,
} from './tools.js'

const app = express()
app.use(express.json())

// Treasury wallet — receives all USDC payments
const TREASURY = process.env.TREASURY_ADDRESS ?? '0xf31f59e7b8b58555f7871f71973a394c8f1bffe5'

// Coinbase-hosted facilitator (free tier: 1,000 tx/month)
const FACILITATOR = 'https://x402.org/facilitator'

// ── x402 Payment Middleware ────────────────────────────────
app.use(paymentMiddleware(TREASURY, {
  // DATA
  'POST /whale-tracker':    { price: '$0.10', network: 'base', description: 'Whale & smart money tracker' },
  'POST /dex-flow':         { price: '$0.15', network: 'base', description: 'DEX trading flow & market data' },
  'POST /unlock-alert':     { price: '$0.20', network: 'base', description: 'Token unlock schedule alerts' },
  // SECURITY
  'POST /honeypot-check':   { price: '$0.05', network: 'base', description: 'Honeypot & contract safety check' },
  'POST /aml-screen':       { price: '$0.25', network: 'base', description: 'AML compliance screening' },
  'POST /mev-shield':       { price: '$0.30', network: 'base', description: 'MEV sandwich attack analysis' },
  'POST /phishing-scan':    { price: '$0.10', network: 'base', description: 'Phishing & scam detection' },
  // RESEARCH
  'POST /tokenomics-score': { price: '$0.50', network: 'base', description: 'Tokenomics deep analysis' },
  'POST /narrative-pulse':  { price: '$0.40', network: 'base', description: 'Narrative trend momentum' },
  'POST /vc-tracker':       { price: '$1.00', network: 'base', description: 'VC investment signals' },
  'POST /whitepaper-tldr':  { price: '$0.20', network: 'base', description: 'Whitepaper 5-bullet summary' },
  // EARN
  'POST /yield-optimizer':  { price: '$0.15', network: 'base', description: 'Best yield on Base' },
  'POST /airdrop-check':    { price: '$0.10', network: 'base', description: 'Airdrop eligibility checker' },
  'POST /lp-analyzer':      { price: '$0.30', network: 'base', description: 'LP position & IL analysis' },
  'POST /tax-report':       { price: '$2.00', network: 'base', description: 'Crypto tax summary' },
}, { facilitatorUrl: FACILITATOR }))

// ── Routes ─────────────────────────────────────────────────
// DATA
app.post('/whale-tracker',    whaleTracker)
app.post('/dex-flow',         dexFlow)
app.post('/unlock-alert',     unlockAlert)
// SECURITY
app.post('/honeypot-check',   honeypotCheck)
app.post('/aml-screen',       amlScreen)
app.post('/mev-shield',       mevShield)
app.post('/phishing-scan',    phishingScan)
// RESEARCH
app.post('/tokenomics-score', tokenomicsScore)
app.post('/narrative-pulse',  narrativePulse)
app.post('/vc-tracker',       vcTracker)
app.post('/whitepaper-tldr',  whitepaperTldr)
// EARN
app.post('/yield-optimizer',  yieldOptimizer)
app.post('/airdrop-check',    airdropCheck)
app.post('/lp-analyzer',      lpAnalyzer)
app.post('/tax-report',       taxReport)

// ── Discovery endpoint (no payment required) ───────────────
app.get('/', (_, res) => {
  res.json({
    name: 'BlueAgent x402 Server',
    version: '1.0.0',
    description: '15 AI-powered DeFi tools on Base — pay-per-use USDC',
    treasury: TREASURY,
    network: 'base',
    currency: 'USDC',
    tools: [
      { path: '/whale-tracker',    price: '$0.10', input: 'address' },
      { path: '/dex-flow',         price: '$0.15', input: 'token' },
      { path: '/unlock-alert',     price: '$0.20', input: 'token' },
      { path: '/honeypot-check',   price: '$0.05', input: 'token' },
      { path: '/aml-screen',       price: '$0.25', input: 'address' },
      { path: '/mev-shield',       price: '$0.30', input: 'action' },
      { path: '/phishing-scan',    price: '$0.10', input: 'target' },
      { path: '/tokenomics-score', price: '$0.50', input: 'token' },
      { path: '/narrative-pulse',  price: '$0.40', input: 'query' },
      { path: '/vc-tracker',       price: '$1.00', input: 'query' },
      { path: '/whitepaper-tldr',  price: '$0.20', input: 'url' },
      { path: '/yield-optimizer',  price: '$0.15', input: 'token' },
      { path: '/airdrop-check',    price: '$0.10', input: 'address' },
      { path: '/lp-analyzer',      price: '$0.30', input: 'address' },
      { path: '/tax-report',       price: '$2.00', input: 'address' },
    ],
  })
})

const PORT = Number(process.env.PORT ?? 4021)
app.listen(PORT, () => {
  console.log(`🔵 BlueAgent x402 Server running on :${PORT}`)
  console.log(`   Treasury: ${TREASURY}`)
  console.log(`   Network:  Base (USDC)`)
  console.log(`   Tools:    15 endpoints`)
})
