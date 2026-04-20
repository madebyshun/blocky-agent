import { askJSON } from './llm.js'
import type { Request, Response } from 'express'

// ── Helpers ────────────────────────────────────────────────
async function body(req: Request): Promise<Record<string, string>> {
  return req.body ?? {}
}

function ok(res: Response, data: unknown) {
  res.json(data)
}

function err(res: Response, msg: string, status = 400) {
  res.status(status).json({ error: msg })
}

// ── DATA ───────────────────────────────────────────────────
export async function whaleTracker(req: Request, res: Response) {
  const { address } = await body(req)
  if (!address) return err(res, 'address required')
  ok(res, await askJSON(
    `Analyze whale and smart money activity for: ${address} on Base.
     Return JSON: { address, recentMoves: [{ wallet, action, value, time }] (up to 5), smartMoneyScore (0-100), summary }`,
    'You are an onchain analyst tracking whale wallets and smart money flows on Base.'
  ))
}

export async function dexFlow(req: Request, res: Response) {
  const { token } = await body(req)
  if (!token) return err(res, 'token required')
  ok(res, await askJSON(
    `Analyze DEX trading flow for token: ${token} on Base.
     Return JSON: { token, priceUSD, volume24h, liquidity, priceChange24h, buyPressure: "STRONG BUY"|"MILD BUY"|"MILD SELL"|"STRONG SELL", verdict }`,
    'You are a DEX market analyst on Base covering Aerodrome, Uniswap v3, BaseSwap.'
  ))
}

export async function unlockAlert(req: Request, res: Response) {
  const { token } = await body(req)
  if (!token) return err(res, 'token required')
  ok(res, await askJSON(
    `Research token unlock schedule for: ${token}.
     Return JSON: { token, nextUnlock: { date, amount, recipient, percentSupply }, totalLocked, unlockSchedule: [{ date, amount, category }], riskLevel: "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", summary }`,
    'You are a tokenomics analyst specializing in vesting and unlock schedules.'
  ))
}

// ── SECURITY ───────────────────────────────────────────────
export async function honeypotCheck(req: Request, res: Response) {
  const { token } = await body(req)
  if (!token) return err(res, 'token required')
  ok(res, await askJSON(
    `Honeypot and security check for token: ${token} on Base.
     Return JSON: { token, isHoneypot, canSell, buyTax, sellTax, isVerified, hasBlacklist, hasMint, verdict: "SAFE"|"WARNING"|"DANGER", reasons }`,
    'You are a smart contract security auditor specializing in honeypot detection on Base.'
  ))
}

export async function amlScreen(req: Request, res: Response) {
  const { address } = await body(req)
  if (!address) return err(res, 'address required')
  ok(res, await askJSON(
    `AML compliance check for wallet: ${address} on Base.
     Return JSON: { address, riskLevel: "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", complianceScore (0-100), flags, sanctioned, mixerUsed, darknetLinked, recommendation }`,
    'You are a blockchain AML compliance analyst.'
  ))
}

export async function mevShield(req: Request, res: Response) {
  const { action } = await body(req)
  if (!action) return err(res, 'action required')
  ok(res, await askJSON(
    `Analyze MEV risk for transaction: "${action}" on Base.
     Return JSON: { action, mevRisk: "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", sandwichProbability, estimatedLoss, recommendations, safeSlippage, preferredRouter }`,
    'You are an MEV protection expert on Base.'
  ))
}

export async function phishingScan(req: Request, res: Response) {
  const { target } = await body(req)
  if (!target) return err(res, 'target required')
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(target)
  const isURL = target.startsWith('http')
  const type = isAddress ? 'contract/wallet' : isURL ? 'URL' : 'domain/handle'
  ok(res, await askJSON(
    `Scan for phishing/scam: "${target}" (type: ${type}).
     Return JSON: { target, verdict: "SAFE"|"SUSPICIOUS"|"PHISHING"|"SCAM", riskScore (0-100), flags, recommendation }`,
    'You are a Web3 security expert specializing in phishing and scam detection.'
  ))
}

// ── RESEARCH ───────────────────────────────────────────────
export async function tokenomicsScore(req: Request, res: Response) {
  const { token } = await body(req)
  if (!token) return err(res, 'token required')
  ok(res, await askJSON(
    `Analyze tokenomics of: ${token}.
     Return JSON: { token, score (0-100), supplyStructure: { total, circulating, locked }, inflationRate, vestingCliff, distributionHealth: "HEALTHY"|"MODERATE"|"RISKY", strengths, risks, verdict }`,
    'You are a tokenomics expert. Be specific with numbers.'
  ))
}

export async function narrativePulse(req: Request, res: Response) {
  const { query } = await body(req)
  if (!query) return err(res, 'query required')
  ok(res, await askJSON(
    `Analyze narrative momentum for: "${query}" in Base ecosystem.
     Return JSON: { query, heatScore (0-100), trending (top 3), momentum: "RISING"|"PEAK"|"FADING"|"EMERGING", keyPlayers, catalysts, timeframe, summary }`,
    'You are a crypto narrative analyst specializing in Base ecosystem trends.'
  ))
}

export async function vcTracker(req: Request, res: Response) {
  const { query } = await body(req)
  if (!query) return err(res, 'query required')
  ok(res, await askJSON(
    `Research VC activity for: "${query}" in crypto/Web3 2024-2026.
     Return JSON: { query, recentDeals: [{ project, vc, amount, date, stage }] (up to 5), hotThemes, activeVCs, marketSignal: "BULLISH"|"NEUTRAL"|"BEARISH", summary }`,
    'You are a crypto VC research analyst with deep knowledge of Web3 fundraising.'
  ))
}

export async function whitepaperTldr(req: Request, res: Response) {
  const { url, projectName = '' } = await body(req)
  if (!url) return err(res, 'url required')
  let content = ''
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'BlueAgent/1.0' } })
    const html = await r.text()
    content = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 5000)
  } catch { content = 'Could not fetch URL' }
  ok(res, await askJSON(
    `Summarize whitepaper for ${projectName || 'this project'}. URL: ${url}. Content: ${content}
     Return JSON: { url, projectName, bullets (5 key points), techStack, tokenRole, verdict, readTime }`,
    'You are a crypto research analyst. Cut through the hype.'
  ))
}

// ── EARN ───────────────────────────────────────────────────
export async function yieldOptimizer(req: Request, res: Response) {
  const { token } = await body(req)
  if (!token) return err(res, 'token required')
  ok(res, await askJSON(
    `Best yield opportunities for: ${token} on Base.
     Return JSON: { token, topOpportunities: [{ protocol, pair, apy, tvl, risk: "LOW"|"MEDIUM"|"HIGH" }] (up to 5), bestAPY, recommendation }`,
    'You are a DeFi yield optimization expert on Base. Focus on Aerodrome, Moonwell, Compound, ExtraFi.'
  ))
}

export async function airdropCheck(req: Request, res: Response) {
  const { address } = await body(req)
  if (!address) return err(res, 'address required')
  ok(res, await askJSON(
    `Airdrop eligibility for wallet: ${address} on Base and Ethereum.
     Return JSON: { address, eligible: [{ project, amount, valueUSD, deadline, claimUrl }], totalEstimatedValue, missedAirdrops, tip }`,
    'You are an airdrop research expert specializing in Base ecosystem 2025-2026.'
  ))
}

export async function lpAnalyzer(req: Request, res: Response) {
  const { address, pool = '' } = await body(req)
  if (!address) return err(res, 'address required')
  ok(res, await askJSON(
    `Analyze LP positions for wallet: ${address} on Base. ${pool ? 'Focus pool: ' + pool : ''}
     Return JSON: { address, positions: [{ pool, value, feesEarned, impermanentLoss, daysActive, health: "GOOD"|"OK"|"REBALANCE" }], totalValue, totalIL, totalFees, recommendation }`,
    'You are a DeFi LP strategy expert on Base covering Aerodrome, Uniswap v3.'
  ))
}

export async function taxReport(req: Request, res: Response) {
  const { address, year = '' } = await body(req)
  if (!address) return err(res, 'address required')
  const taxYear = year || String(new Date().getFullYear() - 1)
  ok(res, await askJSON(
    `Tax summary for wallet: ${address} for tax year ${taxYear} on Base.
     Return JSON: { address, year: "${taxYear}", totalTrades, realizedGains, realizedLosses, netPnL, incomeEvents: [{ type, amount, date }], taxableEvents, estimatedTaxLiability, recommendation }`,
    'You are a crypto tax expert. Clarify this is an estimate.'
  ))
}
