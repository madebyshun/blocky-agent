import TelegramBot from 'node-telegram-bot-api'
import axios from 'axios'
import * as dotenv from 'dotenv'
import { execSync, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { ethers } from 'ethers'
import { parseSwapIntent, parseSendIntent, sendToken, swapTokens } from './lib/walletActions'
// import { createCanvas } from 'canvas' // Reserved for Phase 2 card generation
dotenv.config()

// ── Global error handlers — prevent crashes from unhandled rejections ──
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message, err.stack)
})
process.on('unhandledRejection', (reason: any) => {
  console.error('[UNHANDLED REJECTION]', reason?.message || reason)
})

// ── Load config ──
const CONFIG_FILE = path.join(__dirname, '..', 'config.json')
const CFG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
const TOKEN_SYMBOL = CFG.token.symbol          // e.g. BLUEAGENT
const TOKEN_NAME   = CFG.token.name            // e.g. $BLUEAGENT
const TOKEN_CONTRACT = CFG.token.contract
const TOKEN_POOL   = CFG.token.pool
const BOT_USERNAME = CFG.telegram.bot_username
const THREADS      = CFG.telegram.threads
const REWARDS      = CFG.rewards
const PROJECT      = CFG.project

const FEATURES     = CFG.features || {}
const TIER         = CFG.tier || 'free'

// Feature gate helper
function featureEnabled(feature: string): boolean {
  return FEATURES[feature] === true
}

// Upgrade prompt
function upgradeMsg(feature: string): string {
  const tierMap: Record<string, string> = {
    trade_tracker: 'Seed', whale_alert: 'Seed', price_alerts: 'Seed',
    gem_signals: 'Seed', mini_games: 'Seed', raffle: 'Seed', scheduled_posts: 'Seed',
    builder_score: 'Growth', bounties: 'Growth', proposal_voting: 'Growth', x_quests: 'Growth',
    token_claim: 'Pro', broadcast_dm: 'Pro', flash_quests: 'Pro', analytics_export: 'Pro',
    token_gate: 'Scale'
  }
  const needed = tierMap[feature] || 'Pro'
  return `⬆️ This feature requires <b>Community Kit ${needed}</b>\n\nUpgrade at blueagent.xyz/community-kit`
}

const DATA_DIR = path.join(__dirname, '..', 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const REFERRALS_FILE = path.join(DATA_DIR, 'referrals.json')
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json')

interface User { id: number; telegramUsername?: string; telegramName?: string; bankrApiToken?: string; evmAddress?: string; privateKey?: string; score?: number; tier?: string; points?: number; referredBy?: number; walletConnected?: boolean; joinedAt?: number; xHandle?: string; claimedPoints?: number; lastCheckin?: number; checkinStreak?: number; lastClaim?: number; completedQuests?: string[] }
interface Referral { referrerId: number; referredId: number; timestamp: number }
interface Project { id: string; name: string; description: string; url: string; twitter?: string; submitterId: number; submitterUsername?: string; timestamp: number; votes: number; voters: number[]; approved?: boolean; buildersMsgId?: number; reactionVotes?: number }

function loadUsers(): Record<string, User> { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) } catch { return {} } }
function saveUsers(d: Record<string, User>) { fs.writeFileSync(USERS_FILE, JSON.stringify(d, null, 2)) }
function loadReferrals(): Referral[] { try { return JSON.parse(fs.readFileSync(REFERRALS_FILE, 'utf8')) } catch { return [] } }
function saveReferrals(d: Referral[]) { fs.writeFileSync(REFERRALS_FILE, JSON.stringify(d, null, 2)) }
function loadProjects(): Project[] { try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')) } catch { return [] } }
function saveProjects(d: Project[]) { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(d, null, 2)) }


// =======================
// CONFIG
// =======================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const BANKR_LLM_KEY = process.env.BANKR_LLM_KEY || 'bk_9PCM8TGTL5RALEEY7WEKUXY3DQRJ2FVN'
const BANKR_API_KEY = process.env.BANKR_API_KEY || 'bk_9PCM8TGTL5RALEEY7WEKUXY3DQRJ2FVN'
const REWARD_WALLET_PRIVATE_KEY = process.env.REWARD_WALLET_PRIVATE_KEY || ''
const REWARD_WALLET_ADDRESS = process.env.REWARD_WALLET_ADDRESS || ''
const TALENT_API_KEY = process.env.TALENT_API_KEY || ''
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || ''
const BASESCAN_API = process.env.BASESCAN_API_KEY || ''

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true })

// =======================
// REWARD WALLET — direct ERC20 transfer (bypass Bankr whitelist)
// =======================
const BASE_RPC = 'https://mainnet.base.org'
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]

// Fee config — 5% to agent rewards pool (contract or treasury)
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '0xf31f59e7b8b58555f7871f71973a394c8f1bffe5'
const AGENT_REWARDS_CONTRACT = process.env.AGENT_REWARDS_CONTRACT || '' // deploy later
const FEE_PERCENT = 5 // 5% to treasury/contract

async function sendTokenReward(toAddress: string, amount: number, tokenContract: string): Promise<{ success: boolean; txHash?: string; txHashFee?: string; error?: string }> {
  if (!REWARD_WALLET_PRIVATE_KEY) return { success: false, error: 'No reward wallet configured' }
  try {
    const provider = new ethers.JsonRpcProvider(BASE_RPC)
    const wallet = new ethers.Wallet(REWARD_WALLET_PRIVATE_KEY, provider)
    const token = new ethers.Contract(tokenContract, ERC20_ABI, wallet)

    const decimals = await token.decimals()
    const balance = await token.balanceOf(wallet.address)

    // Calculate split: 95% user / 5% treasury
    const totalWei = ethers.parseUnits(amount.toString(), decimals)
    const feeWei = (totalWei * BigInt(FEE_PERCENT)) / 100n
    const userWei = totalWei - feeWei

    if (balance < totalWei) {
      return { success: false, error: `Insufficient reward wallet balance: ${ethers.formatUnits(balance, decimals)}` }
    }

    // Get current nonce before any tx
    const startNonce = await provider.getTransactionCount(wallet.address, 'pending')

    // Send to user (95%) with explicit nonce
    const tx = await token.transfer(toAddress, userWei, { nonce: startNonce })
    console.log(`[Reward] Sending ${ethers.formatUnits(userWei, decimals)} tokens to ${toAddress} | tx: ${tx.hash}`)
    await tx.wait(1)

    // Send fee to agent rewards contract or treasury (5%)
    const feeTarget = AGENT_REWARDS_CONTRACT || TREASURY_ADDRESS
    let txHashFee = ''
    if (feeWei > 0n) {
      // If contract deployed — transfer tokens then call receiveFee()
      if (AGENT_REWARDS_CONTRACT) {
        const NOTIFY_FEE_ABI = ['function notifyFee(uint256 amount) external']
        const rewardContract = new ethers.Contract(AGENT_REWARDS_CONTRACT, NOTIFY_FEE_ABI, wallet)
        // Step 1: transfer fee to contract (nonce startNonce+1)
        const transferTx = await token.transfer(AGENT_REWARDS_CONTRACT, feeWei, { nonce: startNonce + 1 })
        await transferTx.wait(1)
        // Step 2: notify contract (nonce startNonce+2)
        const feeTx = await rewardContract.notifyFee(feeWei, { nonce: startNonce + 2 })
        await feeTx.wait(1)
        txHashFee = feeTx.hash
      } else {
        const feeTx = await token.transfer(TREASURY_ADDRESS, feeWei, { nonce: startNonce + 1 })
        await feeTx.wait(1)
        txHashFee = feeTx.hash
      }
      console.log(`[Reward] Fee ${ethers.formatUnits(feeWei, decimals)} tokens to ${feeTarget} | tx: ${txHashFee}`)
    }

    return { success: true, txHash: tx.hash, txHashFee }
  } catch (e: any) {
    console.error('[Reward] Transfer error:', e.message)
    return { success: false, error: e.message }
  }
}

// =======================
// BLUE AGENT SYSTEM PROMPT
// =======================
const SYSTEM_PROMPT = `You are Blue Agent 🟦 — an AI community manager and builder's sidekick on Base.

## Identity
Built by Blocky Studio. Running 24/7 to help the community.
Part assistant, part community manager, part onchain navigator.

## Personality
- Concise and direct — no filler phrases
- Sharp, slightly witty, builder-native
- Friendly in community chat, precise in technical answers
- Never say "I'm just an AI" — just help

## Community Role
When in group chat: answer questions clearly, guide users to right commands, keep energy positive.
When 1:1: go deeper, more detail, full onchain capabilities.

## Expertise
- Base ecosystem: DeFi, NFTs, AI agents, builders, launchpads
- On-chain actions: swap, send, check balance, check prices, transfer tokens
- Token trading: spot buy/sell, limit orders, portfolio tracking
- Leverage trading: long/short positions on Base/Ethereum via Avantis
- Hyperliquid: perp futures + spot trading — BTC, ETH, SOL, TSLA, GOLD and more. Up to 50x leverage. TP/SL inline. Partial close. Bridge to/from HL.
- NFT operations: mint, transfer, check ownership, floor prices
- Polymarket: prediction market bets, check odds, open positions
- Token deployment: launch ERC-20 on Base with custom params
- TWAP: time-weighted average price orders to split large trades
- DCA: dollar-cost averaging strategies
- Builder discovery: who's building on Base, notable projects, AI agents on-chain
- Blue Agent Ecosystem: $BLUEAGENT token on Base

## Blue Agent Ecosystem

- **$BLUEAGENT** — Blue Agent AI token — 0xf895783b2931c919955e18b5e3343e7c7c456ba3 (Base, Uniswap v4)
- Blue Agent Treasury (NOT user wallet): 0xf31f59e7b8b58555f7871f71973a394c8f1bffe5
- IMPORTANT: When user asks "my wallet" or "check my balance" — ask them to provide their wallet address. Never assume the treasury address is the user's wallet.
- Twitter: @blocky_agent
- Telegram: https://t.me/blueagent_hub
- Token: $BLUEAGENT on Base

## Bankr Facts (IMPORTANT — never hallucinate these)
- Bankr = crypto trading agent + LLM gateway at bankr.bot
- Bankr Twitter: @bankrbot (NOT @bankrfi)
- Bankr website: bankr.bot (NOT bankr.fi)
- $BNKR = Bankr's token on Base: 0x22af33fe49fd1fa80c7149773dde5890d3c76f3b
- If you don't have live Bankr data, say so and offer to check via Bankr Agent
- Never invent Bankr features, links, or social handles

## Response Format
- Max 300 words
- NO markdown: no **, no *, no _, no #, no backticks, no ---
- Use plain text only — bullet points with •, numbered lists
- Keep it clean and readable in Telegram chat
- End with 💡 tip when relevant`


// =======================
// FORMAT AGENT REPLY (markdown → Telegram HTML)
// =======================
function formatAgentReply(text: string): string {
  return text
    // Strip code fences (```...```)
    .replace(/```[\s\S]*?```/g, '')
    // Inline code `code` → just text (no backtick)
    .replace(/`([^`]+)`/g, '$1')
    // Headers ### ## # → bold
    .replace(/^#{1,3}\s*(.+)$/gm, '\n<b>$1</b>')
    // **bold** → <b>bold</b>
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    // __bold__ → <b>bold</b>
    .replace(/__(.*?)__/g, '<b>$1</b>')
    // *italic* or _italic_ → <i>italic</i>
    .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
    .replace(/_([^_\n]+)_/g, '<i>$1</i>')
    // Remaining stray * or _ characters
    .replace(/\*/g, '')
    .replace(/(?<![a-zA-Z0-9])_(?![a-zA-Z0-9])/g, '')
    // Numbered lists → keep as-is but clean
    .replace(/^\s*(\d+)\.\s+/gm, '$1. ')
    // Bullet points - * • → •
    .replace(/^\s*[-•]\s+/gm, '• ')
    // Horizontal rules ---
    .replace(/^[-]{3,}$/gm, '')
    // Positive % → up arrow
    .replace(/(\+[\d.]+%)/g, '↑$1')
    // Negative % → down arrow
    .replace(/(−[\d.]+%|-[\d.]+%)/g, '↓$1')
    // Clean up extra blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// =======================
// WELCOME MESSAGE
// =======================
const WELCOME_MESSAGE = `<b>Blue Agent 🟦</b>
Your AI sidekick for building on Base.

<b>For builders:</b>

🗺️ <b>Explore Base</b> — discover projects, protocols, agents, and builders shipping on Base
📊 <b>Builder Score</b> — score any builder (0–100) across 4 dimensions
📝 <b>Submit project</b> — showcase what you're building to the community
👥 <b>Find builders</b> — who's building what on Base right now
⭐ <b>Earn rewards</b> — earn pts for activity → claim $BLUEAGENT onchain

<b>Also available:</b>

🔑 <b>Wallet</b> — auto wallet on Base, no setup
💱 <b>Trade</b> — swap, bridge, DCA, limit orders
🔱 <b>Perps</b> — Hyperliquid up to 50x leverage
🚀 <b>Launch token</b> — deploy ERC20, no code needed

<b>Quick start:</b>
/score @handle — check any builder's rank
/submit — showcase your project (+20 pts)
/refer — invite builders, earn pts
/wallet — view wallet + trade

<i>Powered by Bankr · Base 🟦</i>`

// =======================
// BANKR AGENT
// Handles ALL data queries + on-chain actions
// Has real tools: prices, trending, on-chain data, swaps, balances
// =======================
async function askBankrAgent(prompt: string, maxPolls = 15): Promise<string> {
  try {
    const submitRes = await axios.post(
      'https://api.bankr.bot/agent/prompt',
      { prompt },
      {
        headers: {
          'X-API-Key': BANKR_API_KEY,
          'content-type': 'application/json'
        },
        timeout: 10000
      }
    )

    const jobId = submitRes.data?.jobId
    if (!jobId) {
      return submitRes.data?.response || submitRes.data?.result || ''
    }

    // Poll for result — up to ~60s
    for (let i = 0; i < maxPolls; i++) {
      const delay = i < 5 ? 500 : 1500
      await new Promise(r => setTimeout(r, delay))
      const pollRes = await axios.get(`https://api.bankr.bot/agent/job/${jobId}`, {
        headers: { 'X-API-Key': BANKR_API_KEY },
        timeout: 10000
      })
      const status = pollRes.data?.status
      console.log(`[Agent poll ${i+1}] status=${status} jobId=${jobId}`)
      if (status === 'completed' || status === 'done') {
        return pollRes.data?.response || pollRes.data?.result || ''
      }
      if (status === 'failed') {
        console.error(`[Agent] Job failed: ${jobId}`)
        return ''
      }
    }
    console.error(`[Agent] Polling timeout for jobId=${jobId}`)
    return ''
  } catch (e: any) {
    console.error('Agent error:', e.response?.status, e.message)
    return ''
  }
}

// =======================
// BANKR LLM
// Fallback brain with Blue Agent personality
// Multi-model fallback: claude-sonnet → gemini-flash → gpt-mini
// =======================
// Model tiers by cost/quality
// Smart model tiers — optimized for Blue Agent use cases
const MODELS_LIGHT = [
  'gemini-3.1-flash-lite',  // Google ultra-fast, best for casual
  'gpt-5-nano',             // GPT fastest
  'gpt-5.4-nano',           // GPT nano latest
  'qwen3.5-flash',          // Fast, good for Asian content
  'gpt-5.4-mini',           // Mini latest
  'gpt-5-mini',             // Mini stable
]
const MODELS_MID = [
  'gemini-3-flash',         // Google balanced ⭐
  'claude-haiku-4.5',       // Anthropic fast + smart
  'grok-4.1-fast',          // xAI fast
  'minimax-m2.7',           // Chinese model strong
  'gemini-2.5-flash',       // Google stable
  'kimi-k2.5',              // Moonshot balanced
  'gpt-5.4',                // GPT standard
]
const MODELS_FULL = [
  'claude-sonnet-4.6',      // Best overall ⭐ primary
  'claude-sonnet-4.5',      // Sonnet stable
  'gemini-3-pro',           // Google best
  'gemini-3.1-pro',         // Google newest pro
  'deepseek-v3.2',          // Powerhouse
  'gpt-5.2',                // GPT powerful
  'gemini-2.5-pro',         // Google pro stable
  'qwen3.5-plus',           // Qwen best
  'claude-haiku-4.5',       // Fallback fast
  'gpt-5.4',                // Final fallback
]

// Coding-specific models (for /launch and technical queries)
const MODELS_CODE = [
  'qwen3-coder',            // Code specialist ⭐
  'gpt-5.2-codex',          // Codex
  'claude-sonnet-4.6',      // Claude good at code
  'deepseek-v3.2',          // Strong coder
  'gpt-5.2',                // GPT code
]

// Smart model selection based on query complexity
function selectModels(text: string): string[] {
  // Code/technical queries → coding models
  if (/code|deploy|contract|solidity|typescript|javascript|python|function|bug|error|implement|build|script/i.test(text)) {
    return MODELS_CODE
  }
  // Deep analysis → full models
  if (/score|analyze|explain|compare|research|what is|how does|tell me about|deep|detail|strategy|evaluate|assess/i.test(text)) {
    return MODELS_FULL
  }
  // Community / chatbot queries → mid models (good balance of speed + quality)
  if (/how|what|where|when|why|can i|help|support|claim|reward|earn|point|quest|refer|submit|wallet|token|price|buy|sell|gm|gn|hello|hi|hey|thx|thanks/i.test(text)) {
    return MODELS_MID
  }
  // Base/crypto ecosystem → mid models
  if (/builder|base|defi|nft|agent|protocol|project|ecosystem|trend|market|crypto|blockchain/i.test(text)) {
    return MODELS_MID
  }
  // Short casual chat → light (fast, cheap)
  if (text.length < 60) {
    return MODELS_LIGHT
  }
  // Default → light
  return MODELS_LIGHT
}

const LLM_MODELS = MODELS_FULL // for /model command display

async function askLLM(messages: Array<{ role: string; content: string }>): Promise<string> {
  const lastMsg = messages[messages.length - 1]?.content || ''
  const modelsToTry = selectModels(lastMsg)

  for (const model of modelsToTry) {
    try {
      const res = await axios.post(
        'https://llm.bankr.bot/v1/messages',
        {
          model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages
        },
        {
          headers: {
            'x-api-key': BANKR_LLM_KEY,
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01'
          },
          timeout: 30000
        }
      )
      const text = res.data?.content?.[0]?.text?.trim()
      if (text) {
        console.log(`[LLM] Responded with model: ${model}`)
        return text
      }
    } catch (e: any) {
      const status = e.response?.status
      console.error(`[LLM] ${model} failed (${status}): ${e.message}`)
      if (status === 529 || status === 503 || status === 429) {
        // overloaded/rate-limited → try next model
        continue
      }
      // other errors (4xx) → skip to next
      continue
    }
  }
  console.error('[LLM] All models failed')
  return ''
}

// =======================
// KEY BUILDERS/ACCOUNTS TO TRACK ON X
// =======================
const TRACKED_X_ACCOUNTS = [
  '@jessepollak',      // Base lead
  '@base',             // Official Base
  '@baseapp',          // Base App
  '@buildonbase',      // Build on Base
  '@coinbase',         // Coinbase
  '@brian_armstrong',  // Coinbase CEO
  '@bankrbot',         // Bankr
  '@0xDeployer',       // Builder
  '@synthesis_md',     // Builder
  '@devfolio',         // Devfolio
  '@TalentProtocol',   // Talent Protocol
  '@faircaster',       // Faircaster
  '@virtuals_io',      // Virtuals
]

// =======================
// NEEDS REAL-TIME DATA?
// Route to Bankr Agent for live data + actions
// =======================
function needsAgent(text: string): boolean {
  // Route to Bankr Agent for: actions needing real tools + real-time onchain/market data
  return /swap|send|transfer|bridge|buy\s+\$?\w+|sell\s+\$?\w+|balance|portfolio|my\s+wallet|my\s+position|leverage|long|short|margin|open\s+position|limit\s+order|polymarket\s+bet|place\s+bet|deploy\s+token|mint\s+nft|check\s+wallet|hyperliquid|hl\s+position|perp|twap|dca|avantis|latest.*from\s+@|what.*@\w+.*said|price\s+of\s+\$?\w+|\$\w+\s+price|twitter|tweet|news.*today|update.*today|latest.*today|trending.*bankr|bankr.*trending|top.*bankr|bankr.*top|on\s+bankr|bankr\s+data|bankr\s+onchain|bankr\s+token|bankr\s+volume|bankr\s+launch/i.test(text)
}

function isTrendingQuery(text: string): boolean {
  return /trending|top token|hot|what.*(on|in)\s*base|top.*base|base.*top/i.test(text)
}

// DexScreener price lookup + LLM commentary
async function fetchTokenPrice(symbol: string): Promise<string> {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/search?q=${symbol}+base`,
      { timeout: 8000 }
    )
    const pairs = (res.data?.pairs || [])
      .filter((p: any) => p.chainId === 'base')
      .filter((p: any) => p.baseToken?.symbol?.toLowerCase() === symbol.toLowerCase())
      .sort((a: any, b: any) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))

    if (!pairs.length) return ''

    const p = pairs[0]
    const price = p.priceUsd ? `$${parseFloat(p.priceUsd).toPrecision(4)}` : 'N/A'
    const change24 = p.priceChange?.h24 != null
      ? (p.priceChange.h24 >= 0 ? `↑ +${p.priceChange.h24.toFixed(2)}%` : `↓ ${p.priceChange.h24.toFixed(2)}%`)
      : ''
    const change1h = p.priceChange?.h1 != null
      ? ` | 1h: ${p.priceChange.h1 >= 0 ? '+' : ''}${p.priceChange.h1.toFixed(2)}%`
      : ''
    const vol = p.volume?.h24 ? `$${(p.volume.h24 / 1000).toFixed(1)}K` : 'N/A'
    const liq = p.liquidity?.usd ? `$${(p.liquidity.usd / 1000).toFixed(1)}K` : 'N/A'
    const dex = p.dexId || 'dex'

    // Build data block
    const dataBlock = `<b>${p.baseToken.name} (${p.baseToken.symbol.toUpperCase()})</b> 🟦\n\n` +
      `💰 Price: <b>${price}</b>\n` +
      `📈 24h: ${change24}${change1h}\n` +
      `📊 Volume 24h: ${vol}\n` +
      `💧 Liquidity: ${liq}\n` +
      `🔁 DEX: ${dex}`

    // LLM commentary — short, Blue Agent personality
    const commentary = await askLLM([{
      role: 'user',
      content: `You are Blue Agent 🟦 — an onchain AI on Base. Give a SHORT 1-2 sentence commentary on this token data. Be direct, insightful, no hype. No emojis except 🟦 if needed:\n\nToken: ${p.baseToken.name} (${symbol.toUpperCase()})\nPrice: ${price}\n24h change: ${p.priceChange?.h24?.toFixed(2) ?? 'N/A'}%\n1h change: ${p.priceChange?.h1?.toFixed(2) ?? 'N/A'}%\nVolume 24h: ${vol}\nLiquidity: ${liq}`
    }])

    return `${dataBlock}\n\n<i>${commentary}</i>\n\n<i>Source: DexScreener · Base</i>`
  } catch (e) {
    return ''
  }
}

// DexScreener fallback for trending when Bankr Agent fails
async function fetchTrendingFallback(): Promise<string> {
  try {
    const res = await axios.get(
      'https://api.dexscreener.com/latest/dex/search?q=USDC+base&rankBy=volume&order=desc',
      { timeout: 8000 }
    )
    const EXCLUDE = ['WETH','cbETH','cbBTC','USDC','USDbC','DAI','USDT']
    const pairs = (res.data?.pairs || [])
      .filter((p: any) => p.chainId === 'base')
      .filter((p: any) => !EXCLUDE.includes(p.baseToken?.symbol))
      .filter((p: any) => (p.volume?.h24 || 0) > 50000)
      .sort((a: any, b: any) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
      .slice(0, 8)

    if (!pairs.length) return ''

    const lines = pairs.map((p: any) => {
      const price = p.priceUsd ? `$${parseFloat(p.priceUsd).toFixed(6)}` : 'N/A'
      const change = p.priceChange?.h24 != null
        ? (p.priceChange.h24 >= 0 ? `↑${p.priceChange.h24.toFixed(1)}%` : `↓${Math.abs(p.priceChange.h24).toFixed(1)}%`)
        : ''
      const vol = p.volume?.h24 ? `Vol: $${(p.volume.h24/1000).toFixed(1)}K` : ''
      return `• <b>${p.baseToken.name} (${p.baseToken.symbol})</b>: ${price} ${change} ${vol}`.trim()
    }).join('\n')

    return `<b>Trending on Base 🔥</b>\n\n${lines}\n\n<i>Source: DexScreener</i>`
  } catch (e) {
    return ''
  }
}

// =======================
// IS X/TWITTER QUERY?
// Enrich prompt with tracked accounts
// =======================
function isXQuery(text: string): boolean {
  return /twitter|tweet|x\.com|@\w+|news|update|latest|what.*said|who.*building|builder.*post|post.*builder/i.test(text)
}

function buildXPrompt(userText: string): string {
  const accounts = TRACKED_X_ACCOUNTS.join(', ')
  return `${userText}\n\nKey accounts to check: ${accounts}. Focus on Base ecosystem builders and latest onchain activity.`
}

// =======================
// LAUNCH WIZARD STATE (per user)
// =======================
interface LaunchState {
  step: 'name' | 'symbol' | 'description' | 'image' | 'fee' | 'fee_value' | 'confirm'
  name?: string
  symbol?: string
  description?: string
  image?: string
  feeType?: 'x' | 'farcaster' | 'ens' | 'wallet' | 'skip'
  feeValue?: string
}

const launchSessions = new Map<number, LaunchState>()
const SESSION_TIMEOUT_MS = 5 * 60 * 1000 // 5 min timeout
const sessionTimers = new Map<number, ReturnType<typeof setTimeout>>()

function clearSessionTimer(userId: number) {
  const t = sessionTimers.get(userId)
  if (t) { clearTimeout(t); sessionTimers.delete(userId) }
}

function startSessionTimer(userId: number, chatId: number) {
  clearSessionTimer(userId)
  const t = setTimeout(async () => {
    if (walletSessions.has(userId) || submitSessions.has(userId) || launchSessions.has(userId) || xHandleSessions.has(userId) || walletConvSessions.has(userId)) {
      walletSessions.delete(userId)
      submitSessions.delete(userId)
      launchSessions.delete(userId)
      xHandleSessions.delete(userId)
      walletConvSessions.delete(userId)
      await bot.sendMessage(chatId, '⏱ Session expired. Start again when ready.').catch(() => {})
    }
    sessionTimers.delete(userId)
  }, SESSION_TIMEOUT_MS)
  sessionTimers.set(userId, t)
}

const walletSessions = new Map<number, { step: string; email?: string }>()
const submitSessions = new Map<number, { step: number; name?: string; description?: string; url?: string; twitter?: string }>()
const scoreSessions = new Map<number, boolean>()
const xHandleSessions = new Map<number, boolean>() // waiting for X handle input
const walletConvSessions = new Map<number, { action: string; addr: string }>() // waiting for wallet action details


async function handleLaunchWizard(chatId: number, userId: number, text: string) {
  const state = launchSessions.get(userId)!

  if (state.step === 'name') {
    state.name = text
    state.step = 'symbol'
    launchSessions.set(userId, state)
    await bot.sendMessage(chatId,
      `✅ Token name: <b>${text}</b>\n\n🔤 Enter <b>Symbol</b> (e.g. BLUE, BLUEAGENT):`,
      { parse_mode: 'HTML' } as any
    )
    return
  }

  if (state.step === 'symbol') {
    state.symbol = text.toUpperCase().replace(/[^A-Z0-9]/g, '')
    state.step = 'description'
    launchSessions.set(userId, state)
    await bot.sendMessage(chatId,
      `✅ Symbol: <b>$${state.symbol}</b>\n\n📝 Enter <b>Description</b> for your token (or type <i>skip</i>):`,
      { parse_mode: 'HTML' } as any
    )
    return
  }

  if (state.step === 'description') {
    state.description = text.toLowerCase() === 'skip' ? '' : text
    state.step = 'image'
    launchSessions.set(userId, state)
    await bot.sendMessage(chatId,
      `✅ Description: <i>${state.description || '(none)'}</i>\n\n🖼 Enter <b>image URL</b> for your token (or type <i>skip</i>):`,
      { parse_mode: 'HTML' } as any
    )
    return
  }

  if (state.step === 'image') {
    state.image = text.toLowerCase() === 'skip' ? '' : text
    state.step = 'fee'
    launchSessions.set(userId, state)
    await bot.sendMessage(chatId,
      `✅ Image: ${state.image ? `<a href="${state.image}">link</a>` : '(none)'}\n\n` +
      `💰 <b>Fee recipient</b> — who receives trading fees?\n\nChoose type or type <b>skip</b>:`,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '𝕏 X handle', callback_data: 'fee_x' },
              { text: '🟣 Farcaster', callback_data: 'fee_farcaster' }
            ],
            [
              { text: '🔷 ENS name', callback_data: 'fee_ens' },
              { text: '👛 Wallet 0x', callback_data: 'fee_wallet' }
            ],
            [
              { text: '⏭ Skip', callback_data: 'fee_skip' }
            ]
          ]
        }
      } as any
    )
    return
  }

  if (state.step === 'fee_value') {
    state.feeValue = text
    state.step = 'confirm'
    launchSessions.set(userId, state)
    const feeDisplay = state.feeType === 'skip' || !state.feeValue ? '(default)' : `${state.feeValue} (${state.feeType})`
    const summary = `🚀 <b>Confirm Token Launch</b>\n\n` +
      `• Name: <b>${state.name}</b>\n` +
      `• Symbol: <b>$${state.symbol}</b>\n` +
      `• Description: <i>${state.description || '(none)'}</i>\n` +
      `• Image: ${state.image ? `<a href="${state.image}">link</a>` : '(none)'}\n` +
      `• Fee recipient: <code>${feeDisplay}</code>\n\n` +
      `Type <b>confirm</b> to deploy or <b>cancel</b> to abort:`
    await bot.sendMessage(chatId, summary, { parse_mode: 'HTML', disable_web_page_preview: true } as any)
    return
  }

  if (state.step === 'confirm') {
    if (text.toLowerCase() === 'cancel') {
      launchSessions.delete(userId)
      await bot.sendMessage(chatId, 'Type /launch to start over.')
      return
    }

    if (text.toLowerCase() !== 'confirm') {
      await bot.sendMessage(chatId, 'Type <b>confirm</b> to deploy or <b>cancel</b> to abort.', { parse_mode: 'HTML' } as any)
      return
    }

    // Deploy!
    launchSessions.delete(userId)
    await bot.sendMessage(chatId, '🟦 Deploying token to Base... ⏳', { parse_mode: 'HTML' } as any)
    bot.sendChatAction(chatId, 'typing').catch(() => {})

    try {
      const args = ['launch']
      if (state.name) args.push('--name', state.name)
      if (state.symbol) args.push('--symbol', state.symbol)
      if (state.image) args.push('--image', state.image)
      if (state.feeValue && state.feeType && state.feeType !== 'skip') {
        args.push('--fee', state.feeValue, '--fee-type', state.feeType)
      }

      console.log(`[Launch] Running: bankr ${args.join(' ')}`)

      const output = await new Promise<string>((resolve, reject) => {
        const proc = spawn('bankr', args, {
          env: { ...process.env },
          timeout: 120000
        })

        let stdout = ''
        let stderr = ''

        proc.stdout.on('data', (d: Buffer) => {
          const chunk = d.toString()
          stdout += chunk
          // Auto-answer any remaining prompts with Enter (empty = skip)
          if (chunk.includes('?') || chunk.includes(':')) {
            proc.stdin.write('\n')
          }
        })

        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

        proc.on('close', (code: number) => {
          if (code === 0 || stdout.includes('deployed') || stdout.includes('contract')) {
            resolve(stdout || stderr)
          } else {
            reject(new Error(stderr || stdout || `Exit code ${code}`))
          }
        })

        proc.on('error', reject)

        // Close stdin after 2s to unblock any waiting prompts
        setTimeout(() => { try { proc.stdin.end() } catch {} }, 2000)
      })

      const reply = `✅ <b>Token deployed!</b>\n\n<pre>${output.slice(0, 3000)}</pre>`
      await bot.sendMessage(chatId, reply, { parse_mode: 'HTML' } as any)
    } catch (e: any) {
      const errMsg = e.message || 'Unknown error'
      console.error('[Launch] Error:', errMsg)
      await bot.sendMessage(chatId,
        `❌ <b>Deploy failed!</b>\n\n<pre>${errMsg.slice(0, 1000)}</pre>`,
        { parse_mode: 'HTML' } as any
      )
    }
    return
  }
}

// =======================
// CONVERSATION HISTORY (per user)
// =======================
const userHistory = new Map<number, Array<{ role: string; content: string }>>()
const MAX_HISTORY = 6

function getHistory(userId: number) {
  if (!userHistory.has(userId)) userHistory.set(userId, [])
  return userHistory.get(userId)!
}

function addToHistory(userId: number, role: string, content: string) {
  const history = getHistory(userId)
  history.push({ role, content })
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY)
  }
}

// Fetch all agents from Bankr via Agent prompt (only working endpoint)
async function fetchBankrAgents(): Promise<any[]> {
  try {
    // Use Bankr Agent to get leaderboard data
    const result = await askBankrAgent('List top 10 AI agents on Bankr by market cap. For each show: name, market cap in USD, weekly revenue in ETH, token symbol.', 20)
    if (result) return [{ raw: result }] // return raw for display
    return []
  } catch {
    return []
  }
}

async function sendAgentsLeaderboard(chatId: number, sort: string = 'mcap') {
  bot.sendChatAction(chatId, 'typing').catch(() => {})
  try {
    const apiSort = sort === 'newest' ? 'newest' : 'marketCap'
    const res = await axios.get(`https://api.bankr.bot/agent-profiles?sort=${apiSort}&limit=10`, {
      timeout: 10000
    })
    const profiles = res.data?.profiles || []
    if (!profiles.length) throw new Error('No profiles')

    // Client-side sort by revenue if requested
    let sorted = [...profiles]
    if (sort === 'revenue') {
      sorted = sorted.sort((a: any, b: any) =>
        parseFloat(b.weeklyRevenueWeth || '0') - parseFloat(a.weeklyRevenueWeth || '0')
      )
    }

    const sortEmoji = sort === 'revenue' ? '💰 Revenue' : sort === 'newest' ? '🆕 Newest' : '📊 MCap'
    const lines = sorted.map((a: any, i: number) => {
      const mcap = a.marketCapUsd ? `$${(a.marketCapUsd / 1000).toFixed(0)}K` : 'N/A'
      const rev = a.weeklyRevenueWeth ? `${parseFloat(a.weeklyRevenueWeth).toFixed(3)} ETH` : 'N/A'
      const symbol = a.tokenSymbol ? `$${a.tokenSymbol.toUpperCase()}` : ''
      return `${i + 1}. <b>${a.projectName}</b> ${symbol}\n   MCap: ${mcap} | Rev/wk: ${rev}`
    })

    await bot.sendMessage(chatId,
      `<b>🤖 Bankr Agent Leaderboard</b> — ${sortEmoji}\n\n${lines.join('\n\n')}`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[
          { text: '📊 By MCap', callback_data: 'agents_mcap' },
          { text: '💰 By Revenue', callback_data: 'agents_revenue' },
          { text: '🆕 Newest', callback_data: 'agents_newest' }
        ]]}
      } as any
    )
  } catch {
    await bot.sendMessage(chatId, '🤖 Could not fetch agent leaderboard. Try again later.')
  }
}

bot.onText(/\/start(?:\s+(\w+))?/, async (msg, match) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id || chatId
  const telegramUsername = msg.from?.username
  const telegramName = msg.from?.first_name + (msg.from?.last_name ? ' ' + msg.from.last_name : '')
  const referralCode = match?.[1]

  // Group chat: ignore /start silently — redirect to DM only
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') return

  const users = loadUsers()
  const referrals = loadReferrals()

  // Check if user exists
  if (!users[userId]) {
    // New user
    users[userId] = {
      id: userId,
      telegramUsername,
      telegramName,
      score: 0,
      points: 0,
      joinedAt: Date.now(),
      walletConnected: false
    }
    // Auto-generate wallet for new user
    const newWallet = ethers.Wallet.createRandom()
    users[userId].evmAddress = newWallet.address
    users[userId].privateKey = newWallet.privateKey
    users[userId].walletConnected = true
    saveUsers(users)

    // Handle referral — code is referrer's userId
    if (referralCode) {
      const referrerId = parseInt(referralCode)
      const referrer = referrerId && users[referrerId] ? users[referrerId] : null
      const alreadyReferred = referrals.some(r => r.referredId === userId)

      if (referrer && referrer.id !== userId && !alreadyReferred) {
        // Save referral record
        referrals.push({ referrerId: referrer.id, referredId: userId, timestamp: Date.now() })
        saveReferrals(referrals)

        // +50 pts for referrer
        users[referrer.id].points = (users[referrer.id].points || 0) + REWARDS.referrer_pts
        saveUsers(users)

        // +10 pts for new user
        users[userId].points = (users[userId].points || 0) + REWARDS.referred_pts
        saveUsers(users)

        // Notify referrer
        const newUserTag = telegramUsername ? `@${telegramUsername}` : telegramName || 'a new builder'
        bot.sendMessage(referrer.id,
          `🎉 <b>${newUserTag} joined via your referral!</b>\n\n⭐ +50 pts added to your account 🟦`,
          { parse_mode: 'HTML' } as any
        ).catch(console.error)

        // Welcome new user
        await bot.sendMessage(chatId,
          `👥 You were referred by @${referrer.telegramUsername || referrer.id}!\n\n⭐ +10 pts bonus added 🟦`,
          { parse_mode: 'HTML' } as any
        )
      }
    }
    // Show persistent bottom keyboard
    await bot.sendMessage(chatId, '🟦 Blue Agent activated!', {
      reply_markup: {
        keyboard: [
          [{ text: '📱 Menu' }, { text: `📊 ${TOKEN_NAME}` }],
        ],
        resize_keyboard: true,
        persistent: true,
      }
    } as any)
    await bot.sendMessage(chatId, WELCOME_MESSAGE, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: '🟦 Open Menu', callback_data: 'open_menu' }, { text: '📖 Docs', url: 'https://github.com/madebyshun/blue-agent/blob/main/INTRODUCING_BLUE_AGENT.md' }]]
      }
    } as any)
  } else {
    // Returning user — silent check-in in background
    const user = users[userId]
    const now = Date.now()
    const todayStart = new Date().setHours(0, 0, 0, 0)
    const lastCheckin = user.lastCheckin || 0
    const alreadyCheckedIn = lastCheckin >= todayStart

    if (!alreadyCheckedIn) {
      const yesterday = todayStart - 86400000
      const wasYesterday = lastCheckin >= yesterday && lastCheckin < todayStart
      const newStreak = wasYesterday ? (user.checkinStreak || 0) + 1 : 1
      const bonusPts = newStreak >= 7 ? 10 : 5
      users[userId].lastCheckin = now
      users[userId].checkinStreak = newStreak
      users[userId].points = (user.points || 0) + bonusPts
      saveUsers(users)
    }

    // Show persistent keyboard + welcome message như cũ
    await bot.sendMessage(chatId, '🟦 Welcome back!', {
      reply_markup: {
        keyboard: [
          [{ text: '📱 Menu' }, { text: `📊 ${TOKEN_NAME}` }],
        ],
        resize_keyboard: true,
        persistent: true,
      }
    } as any)
    await bot.sendMessage(chatId, WELCOME_MESSAGE, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: '🟦 Open Menu', callback_data: 'open_menu' }, { text: '📖 Docs', url: 'https://github.com/madebyshun/blue-agent/blob/main/INTRODUCING_BLUE_AGENT.md' }]]
      }
    } as any)
  }
})

// =======================
// /launch
// =======================
bot.onText(/\/launch/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id || chatId

  launchSessions.set(userId, { step: 'name' })

  await bot.sendMessage(
    chatId,
    `🚀 <b>Token Launch Wizard</b>\n\n` +
    `I'll walk you through deploying a new token on Base.\n\n` +
    `📌 Enter your <b>token name</b> (e.g. Blue Agent):`,
    { parse_mode: 'HTML' } as any
  )
})

// =======================
// /help
// =======================
bot.onText(/\/docs/, async (msg) => {
  const chatId = msg.chat.id
  await bot.sendMessage(chatId,
    `📖 <b>Blue Agent Docs</b>\n\n` +
    `Full guide: features, commands, rewards, tokenomics.\n\n` +
    `<a href="${DOCS_URL}">Read the docs →</a>`,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: false,
      reply_markup: {
        inline_keyboard: [[{ text: '📖 Open Docs', url: DOCS_URL }]]
      }
    } as any
  )
})

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `<b>Blue Agent 🟦 — What I can do</b>\n\n` +
    `📊 <b>Market Data</b>\n` +
    `• "ETH price?" / "$BLUEAGENT price?"\n` +
    `• "What's trending on Base?"\n\n` +
    `💱 <b>Trading</b>\n` +
    `• "Swap 10 USDC to ETH"\n` +
    `• "Buy $BLUEAGENT"\n` +
    `• "Long ETH with 2x leverage"\n\n` +
    `🖼 <b>NFTs</b>\n` +
    `• "Mint an NFT from Zora"\n` +
    `• "Floor price of Base NFTs"\n\n` +
    `🎯 <b>Polymarket</b>\n` +
    `• "Bet on Base getting a token"\n` +
    `• "What are the odds on ETH $5k?"\n\n` +
    `🔍 <b>Builders</b>\n` +
    `• "Who's building AI agents on Base?"\n` +
    `• "Latest from @jessepollak"\n\n` +
    `💼 <b>Portfolio</b>\n` +
    `• "Check my balance"\n` +
    `• "My open positions"\n\n` +
    `<b>Commands:</b>\n` +
    `• /score @handle — 🟦 Get Builder Score\n` +
    `• /news — Latest from Base builders on X\n` +
    `• /launch — Deploy a new token on Base\n\n` +
    `<i>No commands needed — just chat!</i>`,
    { parse_mode: 'HTML' } as any
  )
})

// =======================
// OWNER-ONLY COMMANDS
// =======================
const OWNER_ID = 6614397596

function isOwner(msg: any): boolean {
  return msg.from?.id === OWNER_ID
}

// Block commands in group — redirect to DM
async function blockInGroup(msg: any): Promise<boolean> {
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    await bot.sendMessage(msg.chat.id,
      `🟦 DM @${BOT_USERNAME} to use this command`,
      { reply_to_message_id: msg.message_id } as any
    ).catch(() => {})
    return true
  }
  return false
}

// /ping — check bot alive


// /model — show current model list
bot.onText(/\/model/, async (msg) => {
  if (!isOwner(msg)) return
  const list = LLM_MODELS.map((m, i) => `${i + 1}. ${m}`).join('\n')
  await bot.sendMessage(msg.chat.id,
    `<b>🤖 LLM Models (${LLM_MODELS.length})</b>\n\n${list}\n\n<i>Primary → fallback order</i>`,
    { parse_mode: 'HTML' } as any
  )
})

// /status — full health check (DM only)
bot.onText(/\/status/, async (msg) => {
  if (!isOwner(msg)) return
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') return
  const chatId = msg.chat.id
  await bot.sendMessage(chatId, '🔍 Running health check...', { parse_mode: 'HTML' } as any)

  // Test LLM
  let llmStatus = '❌ Failed'
  let llmModel = ''
  try {
    const res = await axios.post('https://llm.bankr.bot/v1/messages',
      { model: LLM_MODELS[0], max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] },
      { headers: { 'x-api-key': BANKR_LLM_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, timeout: 10000 }
    )
    llmModel = res.data?.model || LLM_MODELS[0]
    llmStatus = '✅ OK'
  } catch (e: any) { llmStatus = `❌ ${e.response?.status || e.message}` }

  // Test Agent
  let agentStatus = '❌ Failed'
  try {
    const res = await axios.post('https://api.bankr.bot/agent/prompt',
      { prompt: 'ping' },
      { headers: { 'X-API-Key': BANKR_API_KEY, 'content-type': 'application/json' }, timeout: 5000 }
    )
    agentStatus = res.data?.jobId ? '✅ OK' : '⚠️ No jobId'
  } catch (e: any) { agentStatus = `❌ ${e.response?.status || e.message}` }

  const uptime = process.uptime()
  const mins = Math.floor(uptime / 60)

  await bot.sendMessage(chatId,
    `<b>📊 Bot Status</b>\n\n` +
    `• Uptime: ${mins}m\n` +
    `• PID: ${process.pid}\n\n` +
    `<b>Services:</b>\n` +
    `• Bankr LLM: ${llmStatus}${llmModel ? ` (${llmModel})` : ''}\n` +
    `• Bankr Agent: ${agentStatus}\n\n` +
    `<b>Models:</b> ${LLM_MODELS.length} loaded\n` +
    `<b>X Accounts:</b> ${TRACKED_X_ACCOUNTS.length} tracked`,
    { parse_mode: 'HTML' } as any
  )
})

// =======================
// ADMIN COMMANDS
// =======================

// /pending — list projects pending review
// /admin — unified admin panel
// Helper functions for admin
async function adminApproveProject(chatId: number, id: string) {
  const projects = loadProjects()
  const idx = projects.findIndex(p => p.id === id)
  if (idx === -1) { await bot.sendMessage(chatId, `❌ Not found: ${id}`); return }
  const proj = projects[idx]
  if (proj.approved) { await bot.sendMessage(chatId, `⚠️ Already approved: ${proj.name}`); return }
  projects[idx].approved = true
  saveProjects(projects)
  const usersA = loadUsers()
  if (usersA[proj.submitterId]) {
    usersA[proj.submitterId].points = (usersA[proj.submitterId].points || 0) + 20
    saveUsers(usersA)
  }
  bot.sendMessage(proj.submitterId, `🎉 <b>Project Approved!</b>\n\n<b>${proj.name}</b> is now live.\n\n⭐ +20 pts added 🟦`, { parse_mode: 'HTML' } as any).catch(console.error)
  // Post to #builders and save message_id for reaction tracking
  try {
    const buildersMsg = await bot.sendMessage(ALPHA_CHAT_ID,
      `🆕 <b>${proj.name}</b>\n${proj.description}\n\n` +
      `🔗 <a href="${proj.url}">${proj.url}</a>\n` +
      (proj.twitter ? `🐦 @${proj.twitter}\n` : '') +
      `👤 by @${proj.submitterUsername || proj.submitterId}\n\n` +
      `👍 React to vote for this project!`,
      { parse_mode: 'HTML', message_thread_id: THREADS.builders, disable_web_page_preview: true } as any
    )
    // Save message_id for reaction tracking
    const allP = loadProjects()
    const pIdx = allP.findIndex(p => p.id === proj.id)
    if (pIdx !== -1) {
      allP[pIdx].buildersMsgId = buildersMsg.message_id
      saveProjects(allP)
    }
  } catch (e) { console.error('Failed to post to builders:', e) }
  await bot.sendMessage(chatId, `✅ Approved: <b>${proj.name}</b> · +20 pts → @${proj.submitterUsername || proj.submitterId}`, { parse_mode: 'HTML' } as any)
}

async function adminRejectProject(chatId: number, id: string) {
  const projects = loadProjects()
  const idx = projects.findIndex(p => p.id === id)
  if (idx === -1) { await bot.sendMessage(chatId, `❌ Not found: ${id}`); return }
  const proj = projects[idx]
  projects.splice(idx, 1)
  saveProjects(projects)
  bot.sendMessage(proj.submitterId, `❌ <b>Project Not Approved</b>\n\n<b>${proj.name}</b> didn't meet requirements. Feel free to revise and resubmit!`, { parse_mode: 'HTML' } as any).catch(console.error)
  await bot.sendMessage(chatId, `❌ Rejected & deleted: <b>${proj.name}</b>`, { parse_mode: 'HTML' } as any)
}

async function sendAdminPanel(chatId: number) {
  const projects = loadProjects()
  const users2 = loadUsers()
  const pending = projects.filter(p => !p.approved).length
  const approved = projects.filter(p => p.approved).length
  const totalUsers = Object.keys(users2).length
  await bot.sendMessage(chatId,
    `🛠️ <b>Admin Panel</b>\n` +
    `──────────────\n` +
    `👥 Users: <b>${totalUsers}</b>\n` +
    `📁 Projects: <b>${approved}</b> approved · <b>${pending}</b> pending`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: `⏳ Pending (${pending})`, callback_data: 'admin_list_pending' }, { text: '📁 All Projects', callback_data: 'admin_list_all' }],
          [{ text: '👥 Users & Points', callback_data: 'admin_list_users' }],
        ]
      }
    } as any
  )
}

bot.onText(/\/admin/, async (msg) => {
  if (!isOwner(msg)) return
  await sendAdminPanel(msg.chat.id)
})

// /test — send test prompt to bot


// =======================
// GENERATE BUILDER SCORE CARD (Canvas)
// =======================
// function generateScoreCard(data: {
//   handle: string
//   score: number
//   tier: string
//   consistency: number
//   technical: number
//   builderFocus: number
//   community: number
//   summary: string
// }): Buffer {
//   const W = 600, H = 380
//   const canvas = createCanvas(W, H)
//   const ctx = canvas.getContext('2d')
// 
//   // Background
//   ctx.fillStyle = '#0a0a0a'
//   ctx.fillRect(0, 0, W, H)
// 
//   // Blue border accent
//   ctx.fillStyle = '#1d4ed8'
//   ctx.fillRect(0, 0, 4, H)
//   ctx.fillRect(0, 0, W, 4)
// 
//   // Header
//   ctx.fillStyle = '#1d4ed8'
//   ctx.font = 'bold 14px sans-serif'
//   ctx.fillText('🟦 BUILDER SCORE', 24, 36)
// 
//   ctx.fillStyle = '#ffffff'
//   ctx.font = 'bold 28px sans-serif'
//   ctx.fillText(`@${data.handle}`, 24, 72)
// 
//   // Score circle area
//   ctx.fillStyle = '#111827'
//   ctx.beginPath()
//   ctx.roundRect(W - 160, 20, 130, 100, 12)
//   ctx.fill()
// 
//   ctx.fillStyle = '#60a5fa'
//   ctx.font = 'bold 42px sans-serif'
//   ctx.textAlign = 'center'
//   ctx.fillText(`${data.score}`, W - 95, 75)
//   ctx.fillStyle = '#9ca3af'
//   ctx.font = '13px sans-serif'
//   ctx.fillText('/100', W - 95, 95)
//   ctx.textAlign = 'left'
// 
//   // Tier badge
//   const tierColors: Record<string, string> = {
//     explorer: '#166534', builder: '#1e3a5f', shipper: '#4c1d95',
//     founder: '#78350f', legend: '#7c2d12'
//   }
//   const tierEmojis: Record<string, string> = {
//     explorer: '🌱', builder: '🔨', shipper: '⚡', founder: '🚀', legend: '🏆'
//   }
//   const tierKey = data.tier.toLowerCase()
//   ctx.fillStyle = tierColors[tierKey] || '#1e3a5f'
//   ctx.beginPath()
//   ctx.roundRect(24, 88, 140, 28, 6)
//   ctx.fill()
//   ctx.fillStyle = '#e2e8f0'
//   ctx.font = 'bold 13px sans-serif'
//   const tierEmoji = tierEmojis[tierKey] || '🟦'
//   ctx.fillText(`${tierEmoji} ${data.tier.toUpperCase()}`, 36, 107)
// 
//   // Divider
//   ctx.fillStyle = '#1f2937'
//   ctx.fillRect(24, 132, W - 48, 1)
// 
//   // Score bars
//   const bars = [
//     { label: 'Consistency', value: data.consistency, max: 25 },
//     { label: 'Technical', value: data.technical, max: 25 },
//     { label: 'Builder Focus', value: data.builderFocus, max: 25 },
//     { label: 'Community', value: data.community, max: 25 },
//   ]
// 
//   bars.forEach((bar, i) => {
//     const y = 155 + i * 42
//     const barW = W - 200
// 
//     ctx.fillStyle = '#9ca3af'
//     ctx.font = '13px sans-serif'
//     ctx.fillText(bar.label, 24, y)
// 
//     ctx.fillStyle = '#60a5fa'
//     ctx.font = 'bold 13px sans-serif'
//     ctx.textAlign = 'right'
//     ctx.fillText(`${bar.value}/${bar.max}`, W - 24, y)
//     ctx.textAlign = 'left'
// 
//     // Bar track
//     ctx.fillStyle = '#1f2937'
//     ctx.beginPath()
//     ctx.roundRect(24, y + 6, barW, 10, 5)
//     ctx.fill()
// 
//     // Bar fill
//     const fillW = Math.round((bar.value / bar.max) * barW)
//     ctx.fillStyle = '#3b82f6'
//     ctx.beginPath()
//     ctx.roundRect(24, y + 6, fillW, 10, 5)
//     ctx.fill()
//   })
// 
//   // Summary
//   ctx.fillStyle = '#1f2937'
//   ctx.fillRect(24, H - 80, W - 48, 1)
// 
//   ctx.fillStyle = '#d1d5db'
//   ctx.font = 'italic 12px sans-serif'
//   const words = data.summary.split(' ')
//   let line = '', lineY = H - 55
//   for (const word of words) {
//     const test = line ? `${line} ${word}` : word
//     if (ctx.measureText(test).width > W - 60) {
//       ctx.fillText(line, 24, lineY)
//       line = word
//       lineY += 18
//     } else { line = test }
//   }
//   if (line) ctx.fillText(line, 24, lineY)
// 
//   // Footer
//   ctx.fillStyle = '#374151'
//   ctx.font = '11px sans-serif'
//   ctx.fillText('🟦 Blue Agent · Blocky Studio · blockyagent_bot', 24, H - 12)
// 
//   return canvas.toBuffer('image/png')
// }

// Check if handle has a Bankr agent profile → +10 bonus
async function checkBankrProfileBonus(handle: string): Promise<boolean> {
  try {
    const h = handle.toLowerCase().replace('@', '')
    // 1. Check if handle is twitter of any approved agent
    const listRes = await axios.get(`https://api.bankr.bot/agent-profiles?limit=100`, { timeout: 5000 })
    const profiles = listRes.data?.profiles || []
    const isAgent = profiles.some((a: any) =>
      (a.twitterUsername || '').toLowerCase().replace('@', '') === h
    )
    if (isAgent) return true

    // 2. Check if handle is a team member of Blue Agent specifically
    const detailRes = await axios.get(`https://api.bankr.bot/agent-profiles/blue-agent`, { timeout: 5000 })
    const teamMembers = detailRes.data?.teamMembers || []
    return teamMembers.some((m: any) =>
      (m.links || []).some((l: any) => {
        const url = (l.url || '').toLowerCase()
        return url.includes(`/${h}`) || url.includes(`/@${h}`)
      })
    )
  } catch {
    return false
  }
}

// =======================
// IDENTITY & TALENT PROTOCOL DATA
// =======================

interface IdentityData {
  // Talent Protocol
  talentScore?: number       // Builder Rank score (0–100)
  talentRank?: number        // Global rank
  talentHuman?: boolean      // Human verified

  // Farcaster (Warpcast public)
  farcasterFollowers?: number
  farcasterFid?: number
  farcasterBio?: string
  farcasterCastCount?: number
  hasFarcaster?: boolean

  // Basescan onchain
  txCount?: number
  contractsDeployed?: number
  walletAgedays?: number
  hasBasename?: boolean

  // ENS
  hasENS?: boolean
}

async function fetchTalentData(handle: string): Promise<{ score: number | null; rank: number | null; human: boolean }> {
  if (!TALENT_API_KEY) return { score: null, rank: null, human: false }
  try {
    // Search by twitter handle
    const res = await axios.get('https://api.talentprotocol.com/score', {
      params: { id: handle, scorer_slug: 'builder' },
      headers: { 'X-API-KEY': TALENT_API_KEY },
      timeout: 8000
    })
    const score = res.data?.score?.points ?? null
    const rank = res.data?.score?.rank ?? null
    const human = res.data?.profile?.human_checkmark ?? false
    return { score, rank, human }
  } catch {
    try {
      // Fallback: search via profile endpoint
      const res2 = await axios.get('https://api.talentprotocol.com/profile', {
        params: { id: handle },
        headers: { 'X-API-KEY': TALENT_API_KEY },
        timeout: 8000
      })
      const profile = res2.data?.profile
      return {
        score: profile?.score ?? null,
        rank: profile?.rank ?? null,
        human: profile?.human_checkmark ?? false
      }
    } catch { return { score: null, rank: null, human: false } }
  }
}

async function fetchFarcasterData(handle: string): Promise<{ followers: number | null; fid: number | null; found: boolean; bio?: string; castCount?: number }> {
  try {
    // Warpcast public API — no key needed
    const res = await axios.get(`https://api.warpcast.com/v2/user-by-username?username=${handle.toLowerCase()}`, {
      timeout: 6000
    })
    const user = res.data?.result?.user
    if (!user) return { followers: null, fid: null, found: false }

    // Fetch recent casts count
    let castCount = 0
    try {
      const castRes = await axios.get(`https://api.warpcast.com/v2/casts?fid=${user.fid}&limit=25`, { timeout: 5000 })
      castCount = castRes.data?.result?.casts?.length || 0
    } catch {}

    return {
      followers: user.followerCount ?? null,
      fid: user.fid ?? null,
      found: true,
      bio: user.profile?.bio?.text,
      castCount
    }
  } catch { return { followers: null, fid: null, found: false } }
}

// Check ENS / Basename (public, no key needed)
async function checkENSBasename(handle: string): Promise<{ hasENS: boolean; hasBasename: boolean; ensDomain?: string }> {
  try {
    // Check basename: handle.base.eth
    const basenameQuery = `${handle.toLowerCase()}.base.eth`
    const ensQuery = `${handle.toLowerCase()}.eth`

    const [basenameRes, ensRes] = await Promise.allSettled([
      axios.get(`https://ensdata.net/${basenameQuery}`, { timeout: 5000 }),
      axios.get(`https://ensdata.net/${ensQuery}`, { timeout: 5000 }),
    ])

    const hasBasename = basenameRes.status === 'fulfilled' && basenameRes.value.data?.address
    const hasENS = ensRes.status === 'fulfilled' && ensRes.value.data?.address

    return {
      hasBasename: !!hasBasename,
      hasENS: !!hasENS,
      ensDomain: hasBasename ? basenameQuery : hasENS ? ensQuery : undefined
    }
  } catch { return { hasENS: false, hasBasename: false } }
}

// Check Clanker launches (public, no key needed)
async function checkClankerLaunches(handle: string): Promise<{ count: number; tokens: string[] }> {
  try {
    const res = await axios.get(
      `https://www.clanker.world/api/tokens?requestor_fid=&sort=desc&limit=100`,
      { timeout: 6000 }
    )
    const tokens = (res.data?.data || []).filter((t: any) =>
      (t.requestor_address || '').toLowerCase().includes(handle.toLowerCase()) ||
      (t.name || '').toLowerCase().includes(handle.toLowerCase()) ||
      (t.requestor_profile?.username || '').toLowerCase() === handle.toLowerCase()
    )
    return {
      count: tokens.length,
      tokens: tokens.slice(0, 3).map((t: any) => t.symbol || t.name)
    }
  } catch { return { count: 0, tokens: [] } }
}

// Check Basescan onchain activity
async function checkBasescanActivity(walletAddress?: string): Promise<{ txCount: number | null; contractsDeployed: number | null; ageDays: number | null }> {
  if (!BASESCAN_API || !walletAddress) return { txCount: null, contractsDeployed: null, ageDays: null }
  try {
    const [txRes, contractRes] = await Promise.allSettled([
      axios.get(`https://api.basescan.org/api?module=account&action=txlist&address=${walletAddress}&startblock=0&endblock=99999999&sort=asc&page=1&offset=1&apikey=${BASESCAN_API}`, { timeout: 6000 }),
      axios.get(`https://api.basescan.org/api?module=account&action=txlistinternal&address=${walletAddress}&startblock=0&endblock=99999999&sort=asc&apikey=${BASESCAN_API}`, { timeout: 6000 }),
    ])

    let txCount: number | null = null
    let ageDays: number | null = null
    if (txRes.status === 'fulfilled' && txRes.value.data?.result?.length) {
      const firstTx = txRes.value.data.result[0]
      if (firstTx?.timeStamp) {
        const firstDate = new Date(parseInt(firstTx.timeStamp) * 1000)
        ageDays = Math.floor((Date.now() - firstDate.getTime()) / 86400000)
      }
      // Get total count from separate call
      const countRes = await axios.get(
        `https://api.basescan.org/api?module=proxy&action=eth_getTransactionCount&address=${walletAddress}&tag=latest&apikey=${BASESCAN_API}`,
        { timeout: 5000 }
      ).catch(() => null)
      if (countRes?.data?.result) {
        txCount = parseInt(countRes.data.result, 16)
      }
    }

    return { txCount, contractsDeployed: null, ageDays }
  } catch { return { txCount: null, contractsDeployed: null, ageDays: null } }
}

async function fetchAllIdentity(handle: string): Promise<IdentityData> {
  const [talent, farcaster, ens, clanker] = await Promise.allSettled([
    fetchTalentData(handle),
    fetchFarcasterData(handle),
    checkENSBasename(handle),
    checkClankerLaunches(handle),
  ])

  const t = talent.status === 'fulfilled' ? talent.value : { score: null, rank: null, human: false }
  const f = farcaster.status === 'fulfilled' ? farcaster.value : { followers: null, fid: null, found: false }
  const e = ens.status === 'fulfilled' ? ens.value : { hasENS: false, hasBasename: false }

  return {
    talentScore: t.score ?? undefined,
    talentRank: t.rank ?? undefined,
    talentHuman: t.human,
    farcasterFollowers: f.followers ?? undefined,
    farcasterFid: f.fid ?? undefined,
    farcasterBio: f.bio,
    farcasterCastCount: f.castCount,
    hasFarcaster: f.found,
    hasENS: e.hasENS,
    hasBasename: e.hasBasename,
  }
}

// Recalculate tier from score
function getTier(score: number): string {
  if (score >= 86) return 'Legend'
  if (score >= 71) return 'Founder'
  if (score >= 51) return 'Shipper'
  if (score >= 31) return 'Builder'
  return 'Explorer'
}

// /score — Builder Score from X handle
async function runBuilderScore(chatId: number, handle: string) {
  bot.sendChatAction(chatId, 'typing').catch(() => {})
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000)

  try {
    const prompt = `Score @${handle} as a Base/crypto builder. Check their X/Twitter profile, posts, bio, and activity.
Reply in this EXACT format only (no extra text):
SCORE: X/100
TIER: Explorer|Builder|Shipper|Founder|Legend
Consistency: X/25
Technical: X/25
Builder focus: X/25
Community: X/25
SUMMARY: one sentence

Scoring guide:
- Consistency (0-25): posting frequency, regularity, showing up — how often they share work
- Technical (0-25): code quality, smart contracts, technical depth of posts, GitHub mentions
- Builder focus (0-25): projects shipped, building in public, Base/onchain activity, products launched
- Community (0-25): followers, engagement, replies, community recognition, reputation on X and Farcaster
- SUMMARY: one punchy sentence about who this builder is`

    // Retry up to 3 times via Bankr Agent
    let agentResult = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      agentResult = await askBankrAgent(prompt, 25)
      if (agentResult) break
      console.log(`[Score] Attempt ${attempt} failed, retrying...`)
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000))
    }

    // Still fetch identity for Bankr bonus check
    const [identityData, hasBankrProfile] = await Promise.all([
      fetchAllIdentity(handle),
      checkBankrProfileBonus(handle),
    ])

    const result = agentResult

    if (result) {
      // Parse 4 AI-scored dimensions
      const scoreMatch       = result.match(/SCORE:\s*(\d+)/i)
      const tierMatch        = result.match(/TIER:\s*(\w+)/i)
      const consistencyMatch = result.match(/Consistency:\s*(\d+)/i)
      const technicalMatch   = result.match(/Technical:\s*(\d+)/i)
      const builderMatch     = result.match(/Builder\s*focus:\s*(\d+)/i)
      const communityMatch   = result.match(/Community:\s*(\d+)/i)
      const summaryMatch     = result.match(/SUMMARY:\s*(.+)/i)

      const consistency  = consistencyMatch ? Math.min(25, parseInt(consistencyMatch[1])) : null
      const technical    = technicalMatch   ? Math.min(25, parseInt(technicalMatch[1]))   : null
      const builderFocus = builderMatch     ? Math.min(25, parseInt(builderMatch[1]))     : null
      const community    = communityMatch   ? Math.min(25, parseInt(communityMatch[1]))   : null
      const summary      = summaryMatch     ? summaryMatch[1].trim() : null
      const tier         = tierMatch        ? tierMatch[1] : null

      // Final score = sum of 4 dimensions
      let score: number | null = null
      if (consistency !== null && technical !== null && builderFocus !== null && community !== null) {
        score = Math.min(100, consistency + technical + builderFocus + community)
      } else if (scoreMatch) {
        score = parseInt(scoreMatch[1])
      }

      const finalTier = score !== null ? getTier(score) : (tier || 'Explorer')
      const tierEmoji: Record<string, string> = {
        explorer: '🌱', builder: '🔨', shipper: '⚡', founder: '🚀', legend: '🏆'
      }
      const emoji = tierEmoji[finalTier.toLowerCase()] || '🟦'

      // 4 scoring rows
      const subScoreLines = [
        consistency  !== null ? `Consistency: <b>${consistency}</b>/25`   : null,
        technical    !== null ? `Technical: <b>${technical}</b>/25`        : null,
        builderFocus !== null ? `Builder focus: <b>${builderFocus}</b>/25` : null,
        community    !== null ? `Community: <b>${community}</b>/25`        : null,
      ].filter(Boolean).join('\n')

      const output = score !== null
        ? `🟦 <b>Builder Score</b>\n` +
          `@${handle}\n\n` +
          `Score: <b>${score}/100</b> ${emoji}\n` +
          `Tier: <b>${finalTier}</b>\n\n` +
          subScoreLines + '\n' +
          (summary ? `\n💡 ${summary}` : '') +
          `\n\n─────────────────\n` +
          `<i>Powered by Blue Agent 🟦 · Blocky Studio</i>`
        : formatAgentReply(result)

      await bot.sendMessage(chatId, output, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      } as any)
    } else {
      await bot.sendMessage(chatId,
        `⚠️ Couldn't score @${handle} right now. Try again in a moment!`,
        { parse_mode: 'HTML' } as any
      )
    }
  } catch (e: any) {
    await bot.sendMessage(chatId, '⚠️ Something went wrong. Try again!')
  } finally {
    clearInterval(typingInterval)
  }
}

bot.onText(/\/score(?:\s+@?(\S+))?/, async (msg, match) => {
  if (await blockInGroup(msg)) return
  const chatId = msg.chat.id
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup'
  const handle = match?.[1]?.replace('@', '')

  // GROUP — /score disabled, redirect to /points
  if (isGroup) {
    await bot.sendMessage(chatId,
      `Use /points to see your rank 🟦`,
      { reply_to_message_id: msg.message_id } as any
    )
    return
  }

  // DM MODE — full detail only
  if (!handle) {
    await bot.sendMessage(chatId,
      `<b>Builder Score 🟦</b>\n\nUsage: <code>/score @handle</code>\n\nExample: <code>/score jessepollak</code>`,
      { parse_mode: 'HTML' } as any
    )
    return
  }
  await runBuilderScore(chatId, handle)
})

// /news — public X builder feed
bot.onText(/\/news/, async (msg) => {
  const chatId = msg.chat.id
  bot.sendChatAction(chatId, 'typing').catch(() => {})
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000)

  try {
    const TOP_ACCOUNTS = '@jessepollak, @base, @buildonbase, @bankrbot, @virtuals_io, @coinbase'
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    const xPrompt = `Search Twitter/X for the most recent tweets posted TODAY (${today}) from these accounts: ${TOP_ACCOUNTS}.

Rules:
- DO NOT use pinned tweets
- DO NOT use old tweets from previous days  
- Only include tweets posted in the last 24 hours
- If an account has no recent tweet today, skip them

Format your response EXACTLY like this:
• @handle: [one sentence about what they posted today]
• @handle: [one sentence about what they posted today]

key insight: [one sentence about the overall Base ecosystem trend today]`

    let result = await askBankrAgent(xPrompt, 25)
    if (!result) {
      result = await askLLM([{ role: 'user', content: `What are the latest updates from Base ecosystem builders today (${today})? Accounts: ${TOP_ACCOUNTS}. Format: • @handle: one sentence. End with key insight: one sentence.` }])
    }

    if (result) {
      const now = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      const formatted = formatAgentReply(result)

      const output =
        `<b>📡 Base Builder Feed</b>\n` +
        `<i>${now} · tracked by Blue Agent 🟦</i>\n` +
        `─────────────────\n\n` +
        formatted +
        `\n\n─────────────────\n` +
        `<i>Follow @blocky_agent for daily updates</i>`

      await bot.sendMessage(chatId, output, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      } as any)
    } else {
      await bot.sendMessage(chatId,
        '⚠️ Couldn\'t fetch builder updates right now.\nTry again in a moment!',
        { parse_mode: 'HTML' } as any
      )
    }
  } catch (e: any) {
    await bot.sendMessage(chatId, '⚠️ Something went wrong. Try again!')
  } finally {
    clearInterval(typingInterval)
  }
})

// =======================
// V2.0 COMMAND HANDLERS
// =======================

const MENU_TEXT = `🟦 <b>Blue Agent</b> — Control Panel\n\nWhat do you need?`

const DOCS_URL = 'https://github.com/madebyshun/blue-agent/blob/main/INTRODUCING_BLUE_AGENT.md'

const MENU_KEYBOARD = {
  inline_keyboard: [
    [{ text: '📰 News', callback_data: 'menu_news' }, { text: '🔍 Score', callback_data: 'menu_score' }, { text: '🚀 Launch', callback_data: 'menu_launch' }],
    [{ text: '🎯 Quests', callback_data: 'menu_quests' }, { text: '🎁 Rewards', callback_data: 'menu_rewards' }, { text: '🔗 Refer', callback_data: 'menu_refer' }],
    [{ text: '🏆 Top', callback_data: 'menu_leaderboard' }, { text: '💰 Wallet', callback_data: 'menu_wallet' }, { text: '📝 Submit', callback_data: 'menu_submit' }],
    [{ text: '📁 Projects', callback_data: 'menu_projects' }, { text: '📖 Docs', url: DOCS_URL }],
    [{ text: '👤 Profile', callback_data: 'menu_profile' }, { text: '❓ Help', callback_data: 'menu_help' }, { text: '❌ Close', callback_data: 'menu_close' }],
    [{ text: '🤖 Community Kit — Launch your own bot', callback_data: 'menu_community_kit' }],
  ]
}

// Build profile text for a user
function buildProfileText(user: User, rank: number, projectCount: number): string {
  const wallet = user.evmAddress
    ? `💳 <code>${user.evmAddress.slice(0, 6)}...${user.evmAddress.slice(-4)}</code>`
    : '💳 No wallet (restart /start)'
  const xHandle = user.xHandle ? `🐦 @${user.xHandle.replace('@', '')}` : '🐦 No X handle set'
  const points = user.points || 0
  const referrals = 0 // loaded separately
  return (
    `<b>👤 My Profile</b>\n` +
    `──────────────\n` +
    `${wallet}\n` +
    `${xHandle}\n` +
    `──────────────\n` +
    `⭐ Points: <b>${points}</b>\n` +
    `📝 Projects: <b>${projectCount}</b>\n` +
    `🏆 Rank: <b>#${rank}</b>\n` +
    `──────────────\n` +
    `<i>Joined: ${user.joinedAt ? new Date(user.joinedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown'}</i>`
  )
}

// Back + Close row to append to any sub-menu
const NAV_ROW = [{ text: '← Back', callback_data: 'nav_back' }, { text: '❌ Close', callback_data: 'menu_close' }]

// Edit existing message with new content (clean, no spam)
async function editMenu(query: any, text: string, keyboard: any) {
  try {
    await bot.editMessageText(text, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: 'HTML',
      reply_markup: keyboard
    } as any)
  } catch {
    // If can't edit (too old), send new message
    await bot.sendMessage(query.message.chat.id, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    } as any)
  }
}

bot.onText(/\/menu/, async (msg) => {
  // Menu only in DM
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') return
  const chatId = msg.chat.id
  await bot.sendMessage(chatId,
    `🟦 <b>Blue Agent</b> — Control Panel\n\nWhat do you need?`,
    { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD } as any
  )
})

const WALLET_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '📊 Portfolio', callback_data: 'wallet_portfolio' },
      { text: '📋 Tokens', callback_data: 'wallet_tokens' },
      { text: '🖼️ NFTs', callback_data: 'wallet_nfts' },
    ],
    [
      { text: '🔄 Swap', callback_data: 'trade_swap' },
      { text: '💰 Buy $BLUEAGENT', callback_data: 'trade_buy_blueagent' },
      { text: '🔱 Perps', callback_data: 'trade_perps' },
    ],
    [
      { text: '📤 Send', callback_data: 'trade_send' },
      { text: '🌉 Bridge', callback_data: 'trade_bridge' },
      { text: '⏰ Price Alert', callback_data: 'trade_alert' },
    ],
  ]
}

const WALLET_QUICK_ACTIONS =
  `\n\n⚡ <b>Quick actions</b> — just type:\n` +
  `• <code>swap 10 USDC to ETH</code>\n` +
  `• <code>send 5 USDC to 0x...</code>\n` +
  `• <code>bridge 0.01 ETH to Polygon</code>\n` +
  `• <code>buy $BLUEAGENT with 5 USDC</code>\n` +
  `• <code>DCA $10 into ETH daily</code>\n` +
  `\n🔱 <b>Hyperliquid perps:</b>\n` +
  `• <code>long $100 BTC on hyperliquid</code>\n` +
  `• <code>short ETH 10x on hyperliquid</code>\n` +
  `• <code>long TSLA with 5x leverage on hyperliquid</code>\n` +
  `• <code>show my hyperliquid positions</code>`

bot.onText(/\/profile/, async (msg) => {
  if (await blockInGroup(msg)) return
  const chatId = msg.chat.id
  const userId = msg.from?.id || chatId
  const users = loadUsers()
  const user = users[userId] || { id: userId, points: 0, joinedAt: Date.now() }

  // Calc rank by points
  const sorted = Object.values(users).sort((a: any, b: any) => (b.points || 0) - (a.points || 0))
  const rank = sorted.findIndex((u: any) => u.id === userId) + 1 || sorted.length + 1

  // Count user projects
  const projectCount = loadProjects().filter(p => p.submitterId === userId).length

  const profileText = buildProfileText(user, rank, projectCount)
  const hasWallet = !!user.evmAddress
  const points = user.points || 0
  const canClaim = points >= 100

  await bot.sendMessage(chatId, profileText, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: user.xHandle ? '✏️ Edit X Handle' : '🐦 Set X Handle', callback_data: 'profile_set_x' },
          { text: '👛 My Wallet', callback_data: 'menu_wallet' }
        ],
        [{ text: canClaim ? `🎁 Claim ${TOKEN_NAME} (${points} pts)` : `🎁 Claim (need 100 pts)`, callback_data: canClaim ? 'profile_claim' : 'profile_claim_locked' }],
      ]
    }
  } as any)
})

bot.onText(/\/wallet/, async (msg) => {
  if (await blockInGroup(msg)) return
  const chatId = msg.chat.id
  const userId = msg.from?.id || chatId
  const users2 = loadUsers()
  const user2 = users2[userId]
  const addr = user2?.evmAddress
  const statusLine = addr
    ? `<b>👛 Your Wallet</b>\n🟦 <code>${addr}</code>\n<i>Powered by Bankr · Base network</i>` + WALLET_QUICK_ACTIONS
    : `<b>👛 Wallet</b>\n⚠️ Type /start to create your wallet`
  await bot.sendMessage(chatId, statusLine, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        ...WALLET_KEYBOARD.inline_keyboard,
      ]
    }
  } as any)
})

bot.onText(/\/rewards/, async (msg) => {
  if (await blockInGroup(msg)) return
  const chatId = msg.chat.id
  const userId = msg.from?.id || chatId
  const users = loadUsers()
  const user = users[userId] || {}
  const points = user.points || 0
  const referrals = loadReferrals().filter(r => r.referrerId === userId).length

  await bot.sendMessage(chatId,
    `<b>🎁 Rewards</b>\n\n` +
    `⭐ Points: <b>${points}</b>\n` +
    `👥 Referrals: <b>${referrals}</b>\n\n` +
    `<b>How to earn:</b>\n` +
    `• Daily check-in → +5 pts (7-day streak → +10/day)\n` +
    `• Refer a builder → +50 pts\n` +
    `• Submit a project → +20 pts\n` +
    `• Get voted on → +2 pts/vote\n` +
    `• Win trivia → +25 pts\n\n` +
    `<b>Claim:</b>\n` +
    `• 100 pts min → 100,000 ${TOKEN_NAME}\n` +
    `• 1 pt = 1,000 ${TOKEN_NAME}\n` +
    `• 7-day cooldown between claims\n\n` +
    `<b>Multipliers:</b>\n` +
    `• 7-day streak → x1.5 🔥\n` +
    `• 14-day streak → x2.0 🔥🔥\n` +
    `• OG Builder (first 100 users) → x2 🌟\n` +
    `• Claim 500+ pts → +10% bonus\n` +
    `• Claim 1000+ pts → +20% bonus`,
    { parse_mode: 'HTML' } as any
  )
})

bot.onText(/\/refer/, async (msg) => {
  if (await blockInGroup(msg)) return
  const chatId = msg.chat.id
  const userId = msg.from?.id || chatId
  const referrals = loadReferrals().filter(r => r.referrerId === userId)
  const refLink = `https://t.me/${BOT_USERNAME}?start=ref_${userId}`

  await bot.sendMessage(chatId,
    `<b>👥 Referral System</b>\n\n` +
    `Your referral link:\n<code>${refLink}</code>\n\n` +
    `📊 <b>Your Stats:</b>\n` +
    `• Total referrals: <b>${referrals.length}</b>\n` +
    `• Points earned: <b>${referrals.length * 50}</b>\n\n` +
    `Share your link and earn <b>50 points</b> per referral! 🎉`,
    { parse_mode: 'HTML' } as any
  )
})

// /points — DM (private detail) + Group (public card)
bot.onText(/\/points/, async (msg) => {
  if (await blockInGroup(msg)) return
  const chatId = msg.chat.id
  const userId = msg.from?.id
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup'
  if (!userId) return

  const users = loadUsers()
  const user = users[userId]
  const pts = user?.points || 0
  const allSorted = Object.values(users).sort((a: any, b: any) => (b.points || 0) - (a.points || 0))
  const rank = allSorted.findIndex((u: any) => u.id === userId) + 1
  const rankStr = rank > 0 ? `#${rank}` : 'Unranked'
  const name = user?.xHandle ? `@${user.xHandle}` : user?.telegramUsername ? `@${user.telegramUsername}` : msg.from?.first_name || 'Builder'

  if (isGroup) {
    // Public card
    const claimable = Math.floor(pts / 100)
    await bot.sendMessage(chatId,
      `🟦 <b>${name}</b>\n\n` +
      `⭐ <b>${pts} pts</b>  ·  🏆 Rank ${rankStr}\n` +
      (claimable > 0 ? `💎 ${claimable} $BLUEAGENT claimable\n` : '') +
      `\n<i>Earn more → gm daily, /submit, vote, refer</i>`,
      { parse_mode: 'HTML', reply_to_message_id: msg.message_id } as any
    )
  } else {
    // Full detail in DM
    const claimable = Math.floor(pts / 100)
    await bot.sendMessage(chatId,
      `<b>⭐ Your Points</b>\n\n` +
      `Name: <b>${name}</b>\n` +
      `Points: <b>${pts} pts</b>\n` +
      `Rank: <b>${rankStr}</b>\n\n` +
      `<b>How to earn:</b>\n` +
      `• gm daily → +5 pts\n` +
      `• /submit project → +20 pts\n` +
      `• Vote project → +2 pts\n` +
      `• Refer a builder → +50 pts\n` +
      `• Win trivia → +25 pts\n\n` +
      `<b>Claim:</b>\n` +
      `1 pt = 1,000 ${TOKEN_NAME}\n` +
      `Min: 100 pts = 100,000 ${TOKEN_NAME}\n` +
      `Claimable: <b>${(pts * 1000).toLocaleString()} ${TOKEN_NAME}</b>\n\n` +
      `<i>Use /rewards to claim · /leaderboard to see top builders</i>`,
      { parse_mode: 'HTML' } as any
    )
  }
})

// /leaderboard — public (group + DM)
bot.onText(/\/leaderboard/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id || chatId
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup'
  const users = loadUsers()
  const sorted = Object.values(users)
    .filter((u: any) => (u.points || 0) > 0)
    .sort((a: any, b: any) => (b.points || 0) - (a.points || 0))
    .slice(0, 10)

  const medals = ['🥇', '🥈', '🥉']
  const lines = sorted.map((u: any, i: number) => {
    const medal = medals[i] || `${i + 1}.`
    const name = u.xHandle ? `@${u.xHandle}` : u.telegramUsername ? `@${u.telegramUsername}` : u.telegramName || 'Builder'
    const isMe = u.id === userId
    return `${medal} ${name} — <b>${u.points || 0} pts</b>${isMe ? ' 👈' : ''}`
  })

  const myPoints = users[userId]?.points || 0
  const myRank = Object.values(users).sort((a: any, b: any) => (b.points || 0) - (a.points || 0)).findIndex((u: any) => u.id === userId) + 1

  const footer = isGroup
    ? `\n\n<i>DM <a href="https://t.me/blockyagent_bot">@blockyagent_bot</a> to earn points</i>`
    : `\n\n──────────────\nYou: <b>#${myRank || '—'} · ${myPoints} pts</b>`

  await bot.sendMessage(chatId,
    `<b>🏆 Top Builders</b>\n\n` +
    (lines.length ? lines.join('\n') : 'No points yet. Be the first!') +
    footer,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(isGroup ? { reply_to_message_id: msg.message_id } : {})
    } as any
  )
})

bot.onText(/\/submit/, async (msg) => {
  if (await blockInGroup(msg)) return
  const chatId = msg.chat.id
  const userId = msg.from?.id || chatId
  submitSessions.set(userId, { step: 1 })
  startSessionTimer(userId, chatId)
  await bot.sendMessage(chatId,
    `<b>📝 Submit Your Project</b>\n\nStep 1/4: What is your project name?`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel_session' }]] }
    } as any
  )
})

bot.onText(/\/projects/, async (msg) => {
  const chatId = msg.chat.id
  const projects = loadProjects()

  if (!projects.length) {
    await bot.sendMessage(chatId, '📁 No projects yet. Be the first to /submit!')
    return
  }

  for (const proj of projects.slice(0, 5)) {
    const submitter = proj.submitterUsername ? `@${proj.submitterUsername}` : 'Anonymous'
    await bot.sendMessage(chatId,
      `<b>${proj.name}</b>\n${proj.description}\n🔗 ${proj.url}\n👤 by ${submitter} | 👍 ${proj.votes} votes`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: `👍 Vote (${proj.votes})`, callback_data: `vote_${proj.id}` }]] }
      } as any
    )
  }
})

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id
  bot.sendChatAction(chatId, 'typing').catch(() => {})

  try {
    const res = await axios.get('https://api.bankr.bot/agent/profile', {
      headers: { 'x-api-key': BANKR_API_KEY },
      timeout: 8000
    })
    const d = res.data

    const mcap = d.marketCapUsd
      ? `$${Number(d.marketCapUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : 'N/A'
    const rev = d.weeklyRevenueWeth
      ? `${parseFloat(d.weeklyRevenueWeth).toFixed(4)} ETH`
      : 'N/A'
    const token = d.tokenSymbol ? `$${d.tokenSymbol.toUpperCase()}` : '$BLUEAGENT'
    const products = (d.products || []).map((p: any) => `• ${p.name}`).join('\n')
    const team = (d.teamMembers || []).map((m: any) => `• ${m.name} — ${m.role}`).join('\n')
    const latestUpdate = d.projectUpdates?.[0]

    await bot.sendMessage(chatId,
      `<b>📈 ${d.projectName || 'Blue Agent'}</b>\n` +
      `<i>${d.description || ''}</i>\n` +
      `──────────────\n` +
      `💎 Token: <b>${token}</b>\n` +
      `📊 MCap: <b>${mcap}</b>\n` +
      `💰 Weekly Revenue: <b>${rev}</b>\n` +
      `──────────────\n` +
      `🛠 Products:\n${products}\n` +
      `──────────────\n` +
      `👥 Team:\n${team}\n` +
      (latestUpdate ? `──────────────\n📣 Latest: <b>${latestUpdate.title}</b>\n<i>${latestUpdate.content.slice(0, 120)}...</i>\n` : '') +
      `──────────────\n` +
      `<i>Powered by Bankr 🟦 · bankr.bot/agents/blue-agent</i>`,
      { parse_mode: 'HTML', disable_web_page_preview: true } as any
    )
  } catch {
    await bot.sendMessage(chatId, '⚠️ Could not fetch stats. Try again!')
  }
})

bot.onText(/\/agents(?:\s+(\S+))?/, async (msg, match) => {
  const chatId = msg.chat.id
  const sort = match?.[1]?.trim() || 'mcap'
  await sendAgentsLeaderboard(chatId, sort)
})

// =======================
// CALLBACK QUERY HANDLER (for inline buttons)
// =======================
bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat.id
  const data = query.data
  if (!chatId || !data) return
  await bot.answerCallbackQuery(query.id).catch(() => {})

  const userId = query.from?.id || 0

  if (data === 'noop') { return }

  // ── Admin callbacks (owner only) ──
  if (data.startsWith('admin_')) {
    if (userId !== OWNER_ID) {
      await bot.answerCallbackQuery(query.id, { text: '⛔ Admin only', show_alert: true })
      return
    }

    if (data.startsWith('admin_approve_')) {
      const projId = data.replace('admin_approve_', '')
      await adminApproveProject(chatId, projId)
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message?.message_id } as any).catch(() => {})
      await bot.answerCallbackQuery(query.id, { text: '✅ Approved!' })
      return
    }

    if (data.startsWith('admin_reject_')) {
      const projId = data.replace('admin_reject_', '')
      await adminRejectProject(chatId, projId)
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message?.message_id } as any).catch(() => {})
      await bot.answerCallbackQuery(query.id, { text: '❌ Rejected' })
      return
    }

    if (data.startsWith('admin_delete_')) {
      const projId = data.replace('admin_delete_', '')
      const allProjects = loadProjects()
      const idx = allProjects.findIndex(p => p.id === projId)
      if (idx === -1) { await bot.answerCallbackQuery(query.id, { text: '❌ Not found', show_alert: true }); return }
      const name = allProjects[idx].name
      allProjects.splice(idx, 1)
      saveProjects(allProjects)
      await bot.editMessageText(`🗑️ <b>Deleted:</b> ${name}`, { chat_id: chatId, message_id: query.message?.message_id, parse_mode: 'HTML' } as any).catch(() => {})
      await bot.answerCallbackQuery(query.id, { text: '🗑️ Deleted' })
      return
    }

    if (data === 'admin_list_pending') {
      const pendingProjects = loadProjects().filter(p => !p.approved)
      if (!pendingProjects.length) { await bot.answerCallbackQuery(query.id, { text: '✅ No pending projects', show_alert: true }); return }
      await bot.answerCallbackQuery(query.id)
      await bot.sendMessage(chatId, `📋 <b>Pending Projects (${pendingProjects.length})</b>`, { parse_mode: 'HTML' } as any)
      for (const p of pendingProjects) {
        const submitter = p.submitterUsername ? `@${p.submitterUsername}` : `ID:${p.submitterId}`
        await bot.sendMessage(chatId,
          `📝 <b>${p.name}</b>\n${p.description}\n🔗 ${p.url}\n👤 ${submitter}`,
          { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `admin_approve_${p.id}` }, { text: '❌ Reject', callback_data: `admin_reject_${p.id}` }]] } } as any
        )
      }
      return
    }

    if (data === 'admin_list_all') {
      const allProjects = loadProjects()
      await bot.answerCallbackQuery(query.id)
      if (!allProjects.length) { await bot.sendMessage(chatId, '📭 No projects yet.'); return }
      await bot.sendMessage(chatId, `📁 <b>All Projects (${allProjects.length})</b>`, { parse_mode: 'HTML' } as any)
      for (const p of allProjects) {
        const status = p.approved ? '✅' : '⏳'
        const submitter = p.submitterUsername ? `@${p.submitterUsername}` : `ID:${p.submitterId}`
        const buttons = p.approved
          ? [[{ text: '🗑️ Delete', callback_data: `admin_delete_${p.id}` }]]
          : [[{ text: '✅ Approve', callback_data: `admin_approve_${p.id}` }, { text: '❌ Reject', callback_data: `admin_reject_${p.id}` }]]
        await bot.sendMessage(chatId,
          `${status} <b>${p.name}</b>\n👤 ${submitter}\n🔗 ${p.url}`,
          { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: buttons } } as any
        )
      }
      return
    }

    if (data === 'admin_list_users') {
      const allUsers = loadUsers()
      const sorted = Object.values(allUsers).sort((a: any, b: any) => (b.points || 0) - (a.points || 0)).slice(0, 15)
      const lines = sorted.map((u: any, i: number) => {
        const name = u.telegramUsername ? `@${u.telegramUsername}` : u.telegramName || `ID:${u.id}`
        return `${i + 1}. ${name} — <b>${u.points || 0} pts</b> · 🔥${u.checkinStreak || 0}d`
      })
      await bot.answerCallbackQuery(query.id)
      await bot.sendMessage(chatId,
        `👥 <b>Users (${Object.keys(allUsers).length} total)</b>\n\n` + lines.join('\n'),
        { parse_mode: 'HTML' } as any
      )
      return
    }

    await bot.answerCallbackQuery(query.id)
    return
  }

  // Any button press clears active sessions  // Any button press clears active sessions (user navigated away)
  const sessionBreakers = ['menu_', 'wallet_', 'menu_back', 'menu_close', 'cancel_session', 'nav_back', 'nav_']
  if (sessionBreakers.some(prefix => data.startsWith(prefix))) {
    clearSessionTimer(userId)
    walletSessions.delete(userId)
    submitSessions.delete(userId)
    launchSessions.delete(userId)
    xHandleSessions.delete(userId)
  }

  if (data === 'cancel_session') {
    await bot.deleteMessage(chatId, query.message?.message_id!).catch(() => {})
    return
  }

  // Close — delete the menu message
  if (data === 'menu_close') {
    try { await bot.deleteMessage(chatId, query.message?.message_id!) } catch {}
    return
  }

  // Back — return to main menu
  if (data === 'nav_back') {
    await editMenu(query, MENU_TEXT, MENU_KEYBOARD)
    return
  }

  // Open menu from /start button
  if (data === 'open_menu') {
    // Menu only in DM
    const chatType = query.message?.chat?.type
    if (chatType === 'group' || chatType === 'supergroup') {
      await bot.answerCallbackQuery(query.id, { text: 'Please use the bot in DM for menu 🟦', show_alert: true })
      return
    }
    await bot.sendMessage(chatId, MENU_TEXT, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD } as any)
    return
  }

  // MENU callbacks — execute directly
  // PROFILE callbacks
  if (data === 'menu_profile') {
    const users2 = loadUsers()
    const user2 = users2[userId] || { id: userId, points: 0, joinedAt: Date.now() }
    const sorted2 = Object.values(users2).sort((a: any, b: any) => (b.points || 0) - (a.points || 0))
    const rank2 = sorted2.findIndex((u: any) => u.id === userId) + 1 || sorted2.length + 1
    const projectCount2 = loadProjects().filter(p => p.submitterId === userId).length
    const profileText2 = buildProfileText(user2, rank2, projectCount2)
    const hasWallet2 = !!user2.evmAddress
    const points2 = user2.points || 0
    const canClaim2 = points2 >= 100
    await editMenu(query, profileText2, {
      inline_keyboard: [
        [
          { text: user2.xHandle ? '✏️ Edit X Handle' : '🐦 Set X Handle', callback_data: 'profile_set_x' },
          { text: '👛 My Wallet', callback_data: 'menu_wallet' }
        ],
        [{ text: canClaim2 ? `🎁 Claim ${TOKEN_NAME} (${points2} pts)` : `🎁 Claim (need 100 pts)`, callback_data: canClaim2 ? 'profile_claim' : 'profile_claim_locked' }],
        NAV_ROW
      ]
    })
    return
  }
  if (data === 'profile_set_x') {
    xHandleSessions.set(userId, true)
    await editMenu(query,
      `<b>🐦 Set X Handle</b>\n\nEnter your X/Twitter handle:\n<i>(e.g. madebyshun)</i>`,
      { inline_keyboard: [NAV_ROW] }
    )
    return
  }
  if (data === 'profile_claim_locked') {
    await bot.answerCallbackQuery(query.id, { text: '⚠️ Cần ít nhất 100 pts để claim!', show_alert: true })
    return
  }
  if (data === 'profile_claim') {
    const users2 = loadUsers()
    const user2 = users2[userId]
    const points2 = user2?.points || 0
    const streak2 = user2?.checkinStreak || 0
    const lastClaim = user2?.lastClaim || 0
    const joinedAt = user2?.joinedAt || Date.now()
    const now = Date.now()
    const cooldownMs = 7 * 24 * 60 * 60 * 1000 // 7 days
    const cooldownBase = lastClaim > 0 ? lastClaim : joinedAt
    const cooldownLeft = cooldownBase + cooldownMs - now

    // Check cooldown
    if (cooldownLeft > 0) {
      const daysLeft = Math.ceil(cooldownLeft / 86400000)
      await bot.answerCallbackQuery(query.id, { text: `⏳ Cooldown! ${daysLeft} days left.`, show_alert: true })
      return
    }

    // Check min points
    if (points2 < 100) {
      await bot.answerCallbackQuery(query.id, { text: '⚠️ Cần ít nhất 100 pts để claim!', show_alert: true })
      return
    }

    // Activity Tier — based on days active + total points accumulated
    const activityTiers = CFG.token.activity_tiers || [
      { name: 'Builder', min_days: 0,  min_pts: 0,    multiplier: 1.0 },
      { name: 'Shipper', min_days: 30, min_pts: 500,  multiplier: 1.3 },
      { name: 'Founder', min_days: 60, min_pts: 1500, multiplier: 1.5 },
      { name: 'Legend',  min_days: 90, min_pts: 3000, multiplier: 2.0 },
    ]
    const daysActive = user2.joinedAt ? Math.floor((Date.now() - user2.joinedAt) / 86400000) : 0
    const totalPtsEver = (user2.claimedPoints || 0) + points2
    const currentTier = [...activityTiers].reverse().find((t: any) =>
      daysActive >= t.min_days && totalPtsEver >= t.min_pts
    ) || activityTiers[0]
    const multiplier = currentTier.multiplier
    const multiplierLabel = `x${currentTier.multiplier} ${currentTier.name}`

    // OG Badge (first 100) — bonus pts only, not × multiplier
    const allUsersForOG = loadUsers()
    const sortedByJoin = Object.values(allUsersForOG)
      .filter((u: any) => u.joinedAt)
      .sort((a: any, b: any) => a.joinedAt - b.joinedAt)
      .slice(0, CFG.token.early_adopter_limit || 100)
    const isOG = sortedByJoin.some((u: any) => u.id === userId)
    const earlyLabel = isOG ? ` · 🌟 OG` : ''

    const TOKENS_PER_PT = CFG.token.tokens_per_point
    const baseAmount = Math.floor(points2 * multiplier * TOKENS_PER_PT)
    const claimAmount = baseAmount
    const bonusAmount = 0
    const tierBonusLabel = ''

    // Save claim first — reset points
    users2[userId].points = 0
    users2[userId].claimedPoints = (user2.claimedPoints || 0) + claimAmount
    users2[userId].lastClaim = now
    saveUsers(users2)

    // Show processing
    await editMenu(query,
      `<b>🎁 Claim ${TOKEN_NAME}</b>\n` +
      `──────────────\n` +
      `⭐ Points: <b>${points2} pts</b>\n` +
      `🏆 Tier: <b>${currentTier.name}</b> → ${multiplierLabel}${earlyLabel}\n` +
      `──────────────\n` +
      `💰 Claim amount: <b>${claimAmount.toLocaleString()} ${TOKEN_NAME}</b>\n` +
      (bonusAmount > 0 ? `🎁 Tier bonus: <b>+${bonusAmount.toLocaleString()}</b>\n` : '') +
      `──────────────\n` +
      `⏳ <i>Processing onchain transfer...</i>\n` +
      `→ <code>${user2.evmAddress?.slice(0, 6)}...${user2.evmAddress?.slice(-4)}</code>`,
      { inline_keyboard: [] }
    )

    // Execute onchain transfer via reward wallet (ethers.js direct)
    const result = await sendTokenReward(user2.evmAddress!, claimAmount, TOKEN_CONTRACT)

    if (result.success && result.txHash) {
      await bot.sendMessage(chatId,
        `✅ <b>Claim Successful!</b>\n\n` +
        `💰 <b>${claimAmount.toLocaleString()} ${TOKEN_NAME}</b> sent!\n` +
        `📬 To: <code>${user2.evmAddress?.slice(0, 6)}...${user2.evmAddress?.slice(-4)}</code>\n\n` +
        `🔗 <a href="https://basescan.org/tx/${result.txHash}">View on Basescan</a>\n\n` +
        `<i>Next claim in 7 days 🟦</i>`,
        { parse_mode: 'HTML', disable_web_page_preview: false, reply_markup: { inline_keyboard: [NAV_ROW] } } as any
      )
    } else {
      // Rollback points on failure
      const usersRollback = loadUsers()
      usersRollback[userId].points = points2
      usersRollback[userId].claimedPoints = user2.claimedPoints || 0
      usersRollback[userId].lastClaim = lastClaim
      saveUsers(usersRollback)

      await bot.sendMessage(chatId,
        `❌ <b>Transfer failed</b>\n\nYour points have been restored.\n<i>${result.error || 'Unknown error'}</i>\n\nContact @madebyshun if issue persists.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [NAV_ROW] } } as any
      )
    }
    return
  }

  if (data === 'menu_quests') {
    await bot.answerCallbackQuery(query.id)
    await sendQuestMenu(chatId, userId)
    return
  }

  if (data === 'menu_score') {
    scoreSessions.set(userId, true)
    await editMenu(query,
      `<b>📊 Builder Score</b>\n\nEnter your X/Twitter handle:\n<i>(e.g. jessepollak or @jessepollak)</i>`,
      { inline_keyboard: [NAV_ROW] }
    )
    return
  }
  if (data === 'menu_wallet') {
    const users2 = loadUsers()
    if (!users2[userId]) users2[userId] = { id: userId, points: 0, joinedAt: Date.now() }
    // Auto-create wallet if missing
    if (!users2[userId].evmAddress) {
      const newWallet = ethers.Wallet.createRandom()
      users2[userId].evmAddress = newWallet.address
      users2[userId].privateKey = newWallet.privateKey
      users2[userId].walletConnected = true
      saveUsers(users2)
      console.log(`[Wallet] Auto-created for userId=${userId}`)
    }
    const user2 = users2[userId]
    const addr = user2?.evmAddress
    const statusLine = addr
      ? `<b>👛 Your Wallet</b>\n🟦 <code>${addr}</code>\n<i>Powered by Bankr · Base network</i>` + WALLET_QUICK_ACTIONS
      : `<b>👛 Wallet</b>\n⚠️ Could not create wallet. Try /start again.`
      const walletKeyboard = {
      inline_keyboard: [
        [{ text: '📊 Portfolio', callback_data: 'wallet_portfolio' }, { text: '📋 Tokens', callback_data: 'wallet_tokens' }, { text: '🖼️ NFTs', callback_data: 'wallet_nfts' }],
        NAV_ROW
      ]
    }
    await editMenu(query, statusLine, walletKeyboard)
    return
  }
  if (data === 'menu_rewards') {
    const users2 = loadUsers()
    const user2 = users2[userId] || {}
    const points = user2.points || 0
    const streak = user2.checkinStreak || 0
    const refCount = loadReferrals().filter(r => r.referrerId === userId).length
    const projCount = loadProjects().filter(p => p.submitterId === userId).length
    const projVotes = loadProjects().filter(p => p.submitterId === userId).reduce((sum, p) => sum + p.votes, 0)
    const lastClaim = user2.lastClaim || 0
    const cooldownMs = 7 * 24 * 60 * 60 * 1000
    const inCooldown = lastClaim > 0 && (Date.now() - lastClaim) < cooldownMs
    const daysLeft = inCooldown ? Math.ceil((lastClaim + cooldownMs - Date.now()) / 86400000) : 0
    const canClaim = points >= 100 && !inCooldown

    // Streak multiplier
    let multiplier = 1, multiplierLabel = 'x1'
    if (streak >= 14) { multiplier = 2; multiplierLabel = 'x2 🔥🔥' }
    else if (streak >= 7) { multiplier = 1.5; multiplierLabel = 'x1.5 🔥' }
    // Early adopter check
    const allUsersPreview = loadUsers()
    const sortedPreview = Object.values(allUsersPreview).filter((u: any) => u.joinedAt).sort((a: any, b: any) => a.joinedAt - b.joinedAt).slice(0, CFG.token.early_adopter_limit || 100)
    const isEarlyPreview = sortedPreview.some((u: any) => u.id === userId)
    const earlyMultPreview = isEarlyPreview ? (CFG.token.early_adopter_multiplier || 2.0) : 1
    // Claim tier bonus
    const claimTiersPreview = CFG.token.claim_tiers || []
    const tierBonusPreview = claimTiersPreview.reduce((b: number, t: any) => points >= t.min_pts ? t.bonus_pct : b, 0)
    const TOKENS_PER_PT_PREVIEW = CFG.token.tokens_per_point
    const basePreview = Math.floor(points * multiplier * earlyMultPreview * TOKENS_PER_PT_PREVIEW)
    const claimPreview = basePreview + Math.floor(basePreview * tierBonusPreview / 100)

    const streakLine = streak > 0
      ? `• Daily check-in: 🔥 <b>${streak} day streak</b> ${streak >= 7 ? '(+10 pts/day)' : '(+5 pts/day)'}\n`
      : `• Daily check-in: not started — type /start every day\n`

    const earlyBadge = isEarlyPreview ? `\n🌟 <b>OG Builder</b> — Early adopter x${earlyMultPreview} claim bonus` : ''

    await editMenu(query,
      `<b>🎁 Rewards</b>\n` +
      `──────────────\n` +
      `⭐ Points: <b>${points}</b>${earlyBadge}\n` +
      (inCooldown
        ? `⏳ Cooldown: <b>${daysLeft} days</b> left\n`
        : canClaim
        ? `✅ Ready to claim! → <b>${claimPreview.toLocaleString()} ${TOKEN_NAME}</b>\n`
        : `⏳ Need <b>${100 - points} more pts</b> to claim\n`) +
      `──────────────\n` +
      `<b>How to earn:</b>\n` +
      streakLine +
      `• Referrals (${refCount}): +${refCount * 50} pts earned\n` +
      `• Projects submitted (${projCount}): +${projCount * 20} pts earned\n` +
      `• Votes received (${projVotes}): +${projVotes * 2} pts earned\n` +
      `──────────────\n` +
      `<b>Earn more:</b>\n` +
      `• /start daily → +5 pts (7-day streak → +10/day)\n` +
      `• Refer a builder → +50 pts\n` +
      `• Submit a project → +20 pts\n` +
      `• Get voted → +2 pts/vote\n` +
      `• Win trivia → +25 pts\n` +
      `──────────────\n` +
      `<b>Claim multipliers:</b>\n` +
      `• 7-day streak → x1.5 🔥\n` +
      `• 14-day streak → x2.0 🔥🔥\n` +
      `• OG Builder (first 100) → x2 🌟\n` +
      `• 500+ pts claim → +10% bonus\n` +
      `• 1000+ pts claim → +20% bonus\n` +
      `──────────────\n` +
      `<i>100 pts min · 7-day cooldown · 1 pt = 1,000 ${TOKEN_NAME}</i>`,
      {
        inline_keyboard: [
          [{ text: inCooldown ? `⏳ Cooldown (${daysLeft}d)` : canClaim ? `🎁 Claim ${claimPreview} ${TOKEN_NAME}` : `🎁 Claim (${points}/100 pts)`, callback_data: inCooldown ? 'profile_claim_locked' : canClaim ? 'profile_claim' : 'profile_claim_locked' }],
          NAV_ROW
        ]
      }
    )
    return
  }
  if (data === 'menu_refer') {
    const refCount = loadReferrals().filter(r => r.referrerId === userId).length
    const refLink = `https://t.me/${BOT_USERNAME}?start=ref_${userId}`
    await editMenu(query,
      `<b>👥 Referral System</b>\n\nYour referral link:\n<code>${refLink}</code>\n\n📊 <b>Your Stats:</b>\n• Total referrals: <b>${refCount}</b>\n• Points earned: <b>${refCount * 50}</b>\n\nShare your link and earn <b>50 points</b> per referral! 🎉`,
      { inline_keyboard: [NAV_ROW] }
    )
    return
  }
  if (data === 'menu_leaderboard') {
    const users2 = loadUsers()
    const allSorted = Object.values(users2).sort((a: any, b: any) => (b.points || 0) - (a.points || 0))
    const top10 = allSorted.slice(0, 10)
    const medals = ['🥇', '🥈', '🥉']
    const userRank = allSorted.findIndex((u: any) => u.id === userId) + 1
    const lines = top10.map((u: any, i: number) => {
      const medal = medals[i] || `${i + 1}.`
      const name = u.xHandle ? `@${u.xHandle}` : u.telegramUsername ? `@${u.telegramUsername}` : u.telegramName || `Builder`
      const isMe = u.id === userId ? ' 👈' : ''
      return `${medal} ${name} — <b>${u.points || 0} pts</b>${isMe}`
    })
    const myPoints = users2[userId]?.points || 0
    await editMenu(query,
      `<b>🏆 Top Builders</b>\n` +
      `──────────────\n` +
      (lines.length ? lines.join('\n') : 'No points yet. Be the first!') +
      `\n──────────────\n` +
      `You: <b>#${userRank || '—'} · ${myPoints} pts</b>\n\n` +
      `<i>Earn pts: refer (+50), submit (+20), get voted (+2)</i>`,
      {
        inline_keyboard: [
          [{ text: '🔗 Refer & Earn', callback_data: 'menu_refer' }, { text: '📝 Submit Project', callback_data: 'menu_submit' }],
          NAV_ROW
        ]
      }
    )
    return
  }
  if (data === 'menu_submit') {
    submitSessions.set(userId, { step: 1 })
    await editMenu(query,
      `<b>📝 Submit Your Project</b>\n\n` +
      `Share what you're building on Base!\n` +
      `+20 pts when submitted ⭐\n\n` +
      `Step 1/4: What is your <b>project name</b>?`,
      { inline_keyboard: [NAV_ROW] }
    )
    return
  }
  if (data === 'menu_projects' || data === 'projects_newest' || data === 'projects_top' || data === 'projects_mine') {
    const projects2 = loadProjects()
    if (!projects2.length) {
      await editMenu(query,
        `<b>📁 Builder Directory</b>\n\nNo projects yet. Be the first to build!`,
        { inline_keyboard: [[{ text: '📝 Submit Project', callback_data: 'menu_submit' }], NAV_ROW] }
      )
      return
    }
    // Sort projects — chỉ show approved, trừ "Mine" (show cả pending của chính mình)
    let sorted2 = [...projects2]
    let sortLabel = '🆕 Newest'
    if (data === 'projects_top') {
      sorted2 = sorted2.filter(p => p.approved).sort((a, b) => b.votes - a.votes)
      sortLabel = '🔥 Most Voted'
    } else if (data === 'projects_mine') {
      sorted2 = sorted2.filter(p => p.submitterId === userId) // show cả pending của mình
      sortLabel = '👤 My Projects'
    } else {
      sorted2 = sorted2.filter(p => p.approved).sort((a, b) => b.timestamp - a.timestamp)
    }

    await editMenu(query,
      `<b>📁 Builder Directory</b>\n${sortLabel} · ${sorted2.length} project${sorted2.length !== 1 ? 's' : ''}`,
      {
        inline_keyboard: [
          [{ text: '🆕 Newest', callback_data: 'projects_newest' }, { text: '🔥 Most Voted', callback_data: 'projects_top' }, { text: '👤 Mine', callback_data: 'projects_mine' }],
          NAV_ROW
        ]
      }
    )
    // Send project cards separately
    for (const proj of sorted2.slice(0, 5)) {
      const submitter = proj.submitterUsername ? `@${proj.submitterUsername}` : 'Anonymous'
      const alreadyVoted = proj.voters.includes(userId)
      const pendingLabel = !proj.approved ? '\n⏳ <i>Pending review by admin</i>' : ''
      await bot.sendMessage(chatId,
        `<b>${proj.name}</b>${pendingLabel}\n${proj.description}\n🔗 ${proj.url}\n👤 ${submitter} | 👍 ${proj.votes}`,
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [[
            { text: alreadyVoted ? `✅ Voted (${proj.votes})` : `👍 Vote (${proj.votes})`, callback_data: alreadyVoted ? 'noop' : `vote_${proj.id}` }
          ]]}
        } as any
      )
    }
    return
  }
  if (data === 'menu_agents') { await sendAgentsLeaderboard(chatId, 'mcap'); return }
  if (data === 'menu_news') {
    await editMenu(query, `<b>📡 Base Builder Feed</b>\n\n⏳ Fetching latest updates...`, { inline_keyboard: [NAV_ROW] })
    bot.sendChatAction(chatId, 'typing').catch(() => {})
    const typingInterval2 = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000)
    try {
      const TOP_ACCOUNTS2 = '@jessepollak, @base, @buildonbase, @bankrbot, @virtuals_io, @coinbase'
      const today2 = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      const xPrompt2 = `Search Twitter/X for the most recent tweets posted TODAY (${today2}) from: ${TOP_ACCOUNTS2}.\n\nRules:\n- DO NOT use pinned tweets\n- Only tweets from last 24 hours\n- Skip accounts with no recent tweet\n\nFormat:\n• @handle: one sentence\n\nkey insight: one sentence about Base ecosystem today`

      let result = await askBankrAgent(xPrompt2, 25)
      if (!result) result = await askLLM([{ role: 'user', content: `Latest updates from Base builders today (${today2}): ${TOP_ACCOUNTS2}. Format: • @handle: one sentence. End with key insight:` }])

      if (result) {
        const now = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        const output = `<b>📡 Base Builder Feed</b>\n<i>${now} · tracked by Blue Agent 🟦</i>\n─────────────────\n\n${result}\n\n─────────────────\n<i>Follow @blocky_agent for daily updates</i>`
        await bot.sendMessage(chatId, output, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [NAV_ROW] } } as any)
      } else {
        await bot.sendMessage(chatId, '⚠️ Couldn\'t fetch updates. Try again!', { reply_markup: { inline_keyboard: [NAV_ROW] } } as any)
      }
    } catch { await bot.sendMessage(chatId, '⚠️ Something went wrong. Try again!') }
    finally { clearInterval(typingInterval2) }
    return
  }
  if (data === 'menu_community_kit') {
    await editMenu(query,
      `🤖 <b>Blue Agent Community Kit</b>\n\n` +
      `<i>Launch your own AI-powered Telegram community in 5 minutes.</i>\n\n` +
      `✅ Points & Leaderboard\n` +
      `✅ Referrals & Auto-onboarding\n` +
      `✅ Project Directory\n` +
      `✅ Token Rewards\n` +
      `✅ AI Chat + Gem Signals\n` +
      `✅ Raffle, Quests, Proposals\n\n` +
      `<code>npx blueagent init</code> — live in 5 min`,
      { inline_keyboard: [
        [{ text: '💳 Subscribe', callback_data: 'ck_subscribe' }, { text: '📊 Pricing', callback_data: 'ck_pricing' }],
        [{ text: '📖 Docs & Quick Start', callback_data: 'ck_docs' }],
        [{ text: '⭐ GitHub', url: 'https://github.com/madebyshun/community-kit' }, { text: '💬 DM @blockyagent_bot', url: 'https://t.me/blockyagent_bot' }],
        NAV_ROW
      ]}
    )
    return
  }

  // Community Kit submenus
  if (data === 'ck_pricing') {
    await editMenu(query,
      `📊 <b>Community Kit — Pricing</b>\n\n` +
      `🆓 <b>Free</b> — $0\n` +
      `Points, Leaderboard, Referrals, Onboarding, Projects\n\n` +
      `🌱 <b>Seed</b> — $49/mo\n` +
      `+ Price Alerts, Gem Signals, Raffle, Scheduled Posts\n\n` +
      `⚡ <b>Pro</b> — $199/mo\n` +
      `+ Token Claim, Broadcast DM, Flash Quests, Bounties, Proposals\n\n` +
      `🚀 <b>Scale</b> — $499/mo\n` +
      `+ Analytics Export, Token Gate, Custom Branding\n\n` +
      `💰 Pay <b>USDC</b> or <b>$BLUEAGENT</b> (-20%) on Base\n` +
      `📊 Multi-month: 3mo -10% · 6mo -15% · 12mo -20%`,
      { inline_keyboard: [
        [{ text: '💳 Subscribe Now', callback_data: 'start_subscribe' }],
        [{ text: '← Back', callback_data: 'menu_community_kit' }]
      ]}
    )
    return
  }

  if (data === 'ck_subscribe') {
    subSessions.set(userId, { tier: '', months: 1, currency: 'usdc', step: 'tier' })
    await editMenu(query,
      `💳 <b>Community Kit — Subscribe</b>\n\nChoose your plan:`,
      { inline_keyboard: [
        [{ text: '🌱 Seed — $49/mo', callback_data: 'sub_tier_seed' }],
        [{ text: '⚡ Pro — $199/mo', callback_data: 'sub_tier_pro' }],
        [{ text: '🚀 Scale — $499/mo', callback_data: 'sub_tier_scale' }],
        [{ text: '← Back', callback_data: 'menu_community_kit' }]
      ]}
    )
    return
  }

  if (data === 'ck_docs') {
    await editMenu(query,
      `📖 <b>Quick Start</b>\n\n` +
      `<b>1.</b> Create bot via @BotFather\n` +
      `<b>2.</b> Run setup wizard:\n` +
      `<code>npx blueagent init</code>\n\n` +
      `<b>3.</b> Choose template:\n` +
      `�ꪙ Token Community\n` +
      `🎮 Gaming Guild\n` +
      `🏗️ Builder DAO\n` +
      `🤖 AI Agent\n\n` +
      `<b>4.</b> Paste bot token → bot goes live\n\n` +
      `📘 Full docs on GitHub`,
      { inline_keyboard: [
        [{ text: '📘 Full README', url: 'https://github.com/madebyshun/community-kit#readme' }],
        [{ text: '💳 Subscribe', callback_data: 'ck_subscribe' }],
        [{ text: '← Back', callback_data: 'menu_community_kit' }]
      ]}
    )
    return
  }

  if (data === 'menu_pricing') {
    await editMenu(query,
      `💳 <b>Community Kit — Pricing</b>\n\n` +
      `🆓 <b>Free</b> — $0\nPoints, Leaderboard, Referrals, Onboarding, Projects\n\n` +
      `🌱 <b>Seed</b> — $49/mo\n+ Price Alerts, Gem Signals, Raffle, Scheduled Posts\n\n` +
      `⚡ <b>Pro</b> — $199/mo\n+ Token Claim, Broadcast DM, Flash Quests, Bounties, Proposals\n\n` +
      `🚀 <b>Scale</b> — $499/mo\n+ Analytics Export, Token Gate, Custom Branding\n\n` +
      `💰 Pay USDC or $BLUEAGENT (-20%) on Base\n📊 Multi-month: 3mo -10% | 6mo -15% | 12mo -20%`,
      { inline_keyboard: [
        [{ text: '💳 Subscribe Now', callback_data: 'start_subscribe' }],
        [{ text: '🌐 blueagent.xyz/community-kit', url: 'https://blueagent.xyz/community-kit' }],
        NAV_ROW
      ]}
    )
    return
  }

  if (data === 'menu_help') {
    await editMenu(query,
      `<b>Blue Agent 🟦 — What I can do</b>\n\n` +
      `📊 <b>Market Data</b>\n• "ETH price?" / "$BLUEAGENT price?"\n• "What's trending on Base?"\n\n` +
      `💱 <b>Trading</b>\n• "Swap 10 USDC to ETH"\n• "Buy $BLUEAGENT"\n\n` +
      `🔍 <b>Builders</b>\n• "Who's building AI agents on Base?"\n• "Latest from @jessepollak"\n\n` +
      `<b>Commands:</b> /score /news /launch /wallet /refer /leaderboard /submit /projects /stats /agents\n\n` +
      `<i>No commands needed — just chat!</i>`,
      { inline_keyboard: [NAV_ROW] }
    )
    return
  }
  if (data === 'menu_launch') {
    launchSessions.set(userId, { step: 'name' })
    await editMenu(query,
      `🚀 <b>Token Launch Wizard</b>\n\nI'll walk you through deploying a new token on Base.\n\n📌 Enter your <b>token name</b> (e.g. Blue Agent):`,
      { inline_keyboard: [NAV_ROW] }
    )
    return
  }

  // AGENTS sort callbacks
  if (data === 'agents_mcap') { await sendAgentsLeaderboard(chatId, 'mcap'); return }
  if (data === 'agents_revenue') { await sendAgentsLeaderboard(chatId, 'revenue'); return }
  if (data === 'agents_newest') { await sendAgentsLeaderboard(chatId, 'newest'); return }

  // VOTE callbacks
  if (data.startsWith('vote_')) {
    const projId = data.replace('vote_', '')
    const projects = loadProjects()
    const proj = projects.find(p => p.id === projId)
    if (!proj) { await bot.answerCallbackQuery(query.id, { text: 'Project not found' }); return }
    if (proj.voters.includes(userId)) { await bot.answerCallbackQuery(query.id, { text: '✅ Already voted!' }); return }
    proj.votes++
    proj.voters.push(userId)
    saveProjects(projects)
    await bot.answerCallbackQuery(query.id, { text: `👍 Voted! Total: ${proj.votes}` })
    return
  }

  // WALLET action callbacks
  // Wallet action prompts — inject user wallet address for context
  const walletActionPrompts: Record<string, (addr: string) => string> = {
    wallet_portfolio:  (addr) => `Check the portfolio and token balances for wallet address ${addr} on Base chain.`,
    wallet_tokens:     (addr) => `Show all token balances and any claimable fees for wallet ${addr} on Base.`,
    wallet_nfts:       (addr) => `Show all NFTs owned by wallet ${addr} on Base chain.`,
    wallet_swap:       (_)    => `I want to swap tokens on Base. What tokens would you like to swap and how much?`,
    wallet_send:       (_)    => `I want to send crypto on Base. What token, how much, and to which address?`,
    wallet_dca:        (_)    => `I want to set up a recurring DCA buy on Base. What token, amount, and frequency?`,
    wallet_limit:      (_)    => `I want to set a limit order on Base. What token, target price, and amount?`,
    wallet_stoploss:   (_)    => `I want to set a stop loss on Base. What token and at what price?`,
    wallet_polymarket: (_)    => `I want to bet on Polymarket. What market or topic are you interested in?`,
    wallet_bridge:     (_)    => `I want to bridge assets to Base. From which chain and what token/amount?`,
  }

  // Wallet info actions — need address, run via Bankr Agent
  const walletInfoActions = ['wallet_portfolio', 'wallet_tokens', 'wallet_nfts']

  // wallet_portfolio → same as /portfolio command (direct RPC, not Bankr LLM)
  if (data === 'wallet_portfolio') {
    await bot.answerCallbackQuery(query.id)
    const usersP = loadUsers()
    const addrP = usersP[userId]?.evmAddress
    if (!addrP) {
      await bot.sendMessage(chatId, '⚠️ No wallet found. Type /start to create one.')
      return
    }
    await bot.sendChatAction(chatId, 'typing')
    const agentPrompt = `Check portfolio and token balances for wallet address ${addrP} on Base chain. Do NOT use any other wallet. Wallet: ${addrP}`
    const result = await askBankrAgent(agentPrompt, 20)
    if (result) {
      await bot.sendMessage(chatId, formatAgentReply(result), {
        parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [
          [{ text: '🔄 Swap', callback_data: 'trade_swap' }, { text: '💰 Buy $BLUEAGENT', callback_data: 'trade_buy_blueagent' }],
          [{ text: '📤 Send', callback_data: 'trade_send' }, { text: '🌉 Bridge', callback_data: 'trade_bridge' }],
        ]}
      } as any)
    } else {
      await bot.sendMessage(chatId, '⚠️ Could not fetch portfolio. Try again.')
    }
    return
  }

  if (data in walletActionPrompts) {
    const usersWallet = loadUsers()
    const userWallet = usersWallet[userId]
    const addr = userWallet?.evmAddress || ''

    if (walletInfoActions.includes(data)) {
      // Auto-execute with wallet address
      if (!addr) {
        await bot.sendMessage(chatId, '⚠️ No wallet found. Please restart with /start.')
        return
      }
      await bot.sendMessage(chatId, `🔍 Checking your wallet... ⏳`)
      const result = await askBankrAgent(walletActionPrompts[data](addr), 20)
      await bot.sendMessage(chatId, result || '⚠️ Could not fetch wallet data. Try again.', {
        parse_mode: 'HTML', disable_web_page_preview: true
      } as any)
    } else {
      // Conversational actions — ask for details, track session
      walletConvSessions.set(userId, { action: data, addr })
      startSessionTimer(userId, chatId)
      const question = walletActionPrompts[data](addr)
      await bot.sendMessage(chatId, `💬 ${question}`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel_session' }]] }
      } as any)
    }
    return
  }

  // Fee type selection for /launch
  if (['fee_x', 'fee_farcaster', 'fee_ens', 'fee_wallet', 'fee_skip'].includes(data)) {
    const userId2 = query.from?.id
    if (!userId2) return
    const state = launchSessions.get(userId2)
    if (!state) return

    if (data === 'fee_skip') {
      state.feeType = 'skip'
      state.feeValue = ''
      state.step = 'confirm'
      launchSessions.set(userId2, state)
      const summary = `🚀 <b>Confirm Token Launch</b>\n\n` +
        `• Name: <b>${state.name}</b>\n• Symbol: <b>$${state.symbol}</b>\n` +
        `• Description: <i>${state.description || '(none)'}</i>\n` +
        `• Image: ${state.image ? `<a href="${state.image}">link</a>` : '(none)'}\n` +
        `• Fee recipient: (default)\n\nType <b>confirm</b> to deploy or <b>cancel</b> to abort:`
      await bot.sendMessage(chatId, summary, { parse_mode: 'HTML', disable_web_page_preview: true } as any)
    } else {
      const feeTypeMap: Record<string, string> = {
        fee_x: 'x', fee_farcaster: 'farcaster', fee_ens: 'ens', fee_wallet: 'wallet'
      }
      const promptMap: Record<string, string> = {
        fee_x: 'Enter your <b>X/Twitter handle</b> (e.g. @blocky_agent):',
        fee_farcaster: 'Enter your <b>Farcaster handle</b> (e.g. @shun):',
        fee_ens: 'Enter your <b>ENS name</b> (e.g. shun.eth):',
        fee_wallet: 'Enter your <b>wallet address</b> (0x...):'
      }
      state.feeType = feeTypeMap[data] as any
      state.step = 'fee_value'
      launchSessions.set(userId2, state)
      await bot.sendMessage(chatId, promptMap[data], { parse_mode: 'HTML' } as any)
    }
    return
  }
})

// MAIN MESSAGE HANDLER
// Flow: Bankr Agent (real-time data) → LLM fallback (personality)
// =======================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id || chatId
  const text = msg.text?.trim()

  if (!text || text.startsWith('/')) return

  // Handle persistent Reply keyboard buttons
  if (text === '📱 Menu') {
    await bot.sendMessage(chatId, MENU_TEXT, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD } as any)
    return
  }
  if (text === 'Profile') {
    const users = loadUsers()
    const user = users[userId] || { id: userId, points: 0, joinedAt: Date.now() }
    const allSorted = Object.values(users).sort((a: any, b: any) => (b.points || 0) - (a.points || 0))
    const rank = allSorted.findIndex((u: any) => u.id === userId) + 1
    const projCount = loadProjects().filter(p => p.submitterId === userId).length
    const profileText = buildProfileText(user, rank, projCount)
    const hasWallet = !!user.evmAddress
    await bot.sendMessage(chatId, profileText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👛 My Wallet', callback_data: 'menu_wallet' }],
          [{ text: '← Back to Menu', callback_data: 'nav_back' }]
        ]
      }
    } as any)
    return
  }
  if (text === '📊 $BLUEAGENT') {
    bot.sendChatAction(chatId, 'typing').catch(() => {})
    try {
      // Cache price data — only fetch every 60s to avoid rate limits
      const now = Date.now()
      let dexData: any = null
      let poolData: any = null

      if (!priceCache.data || now - priceCache.ts > 60000) {
        const res = await axios.get(
          `https://api.dexscreener.com/latest/dex/tokens/${BLUEAGENT_CONTRACT}`,
          { timeout: 8000 }
        )
        priceCache = { ts: now, data: res.data }
      }

      const pairs = priceCache.data?.pairs || []
      const pair = pairs.find((p: any) => p.chainId === 'base') || pairs[0]

      if (!pair) throw new Error('No pair data')

      const rawPrice = parseFloat(pair.priceUsd || '0')
      const price = rawPrice === 0 ? 'N/A'
        : rawPrice >= 0.0001 ? `$${rawPrice.toFixed(6)}`
        : `$${rawPrice.toFixed(10).replace(/0+$/, '')}`

      const change24 = pair.priceChange?.h24 != null
        ? `${pair.priceChange.h24 >= 0 ? '↑' : '↓'}${Math.abs(pair.priceChange.h24).toFixed(2)}%`
        : 'N/A'
      const change1h = pair.priceChange?.h1 != null
        ? `${pair.priceChange.h1 >= 0 ? '↑' : '↓'}${Math.abs(pair.priceChange.h1).toFixed(2)}%`
        : 'N/A'
      const mcap = pair.marketCap
        ? `$${(pair.marketCap / 1000).toFixed(1)}K`
        : pair.fdv ? `$${(pair.fdv / 1000).toFixed(1)}K` : 'N/A'
      const vol = pair.volume?.h24
        ? `$${(pair.volume.h24 / 1000).toFixed(1)}K`
        : 'N/A'
      const liq = pair.liquidity?.usd
        ? `$${(pair.liquidity.usd / 1000).toFixed(1)}K`
        : 'N/A'
      const buys = pair.txns?.h24?.buys || 0
      const sells = pair.txns?.h24?.sells || 0
      const pairUrl = pair.url || `https://dexscreener.com/base/${BLUEAGENT_CONTRACT}`

      await bot.sendMessage(chatId,
        `🟦 <b>$BLUEAGENT</b>\n\n` +
        `💰 <b>${price}</b>\n` +
        `📈 24h: ${change24}  1h: ${change1h}\n` +
        `🏦 MCap: ${mcap}  💧 Liq: ${liq}\n` +
        `📊 Vol 24h: ${vol}\n` +
        `🛒 ${buys} buys  📤 ${sells} sells\n\n` +
        `<a href="${pairUrl}">📊 Chart</a> · <a href="https://basescan.org/token/${BLUEAGENT_CONTRACT}">Basescan</a>`,
        { parse_mode: 'HTML', disable_web_page_preview: true } as any
      )
    } catch {
      await bot.sendMessage(chatId, '⚠️ Could not fetch price right now.', { parse_mode: 'HTML' } as any)
    }
    return
  }
  if (text === '🔥 Trending') {
    const reply = await fetchTrendingFallback()
    await bot.sendMessage(chatId, reply || '⚠️ No trending data right now.', { parse_mode: 'HTML', disable_web_page_preview: true } as any)
    return
  }

  // Group mode — only respond when mentioned or replied to, and only in General (blue-chat)
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup'
  if (isGroup) {
    const msgThreadId = (msg as any).message_thread_id
    // Only respond in General topic (thread 1 or no thread)
    if (msgThreadId && msgThreadId !== 1) return
    const botInfo = await bot.getMe()
    const mentioned = text.toLowerCase().includes(`@${botInfo.username?.toLowerCase()}`)
    const isReplyToBot = msg.reply_to_message?.from?.id === botInfo.id
    if (!mentioned && !isReplyToBot) return
    // In group context, clear any active DM sessions to avoid flow conflicts
    launchSessions.delete(userId)
    submitSessions.delete(userId)
    walletSessions.delete(userId)
    xHandleSessions.delete(userId)
    // Strip the @botname mention from text for clean processing
    const botUsername = botInfo.username || ''
    const cleanText = text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim()
    if (!cleanText) {
      await bot.sendMessage(chatId, "Hey! 🟦 I'm Blue Agent. What do you need?")
      return
    }
    // Route group mentions through same logic as DM (needsAgent + LLM fallback)
    try {
      let reply = ''
      // In group: $TOKEN mention → DexScreener price (fast, no timeout)
      const tokenMatch = cleanText.match(/^\$(\w+)$/) || cleanText.match(/\$(\w+)\s+price/i)
      if (tokenMatch) {
        reply = await fetchTokenPrice(tokenMatch[1])
      }
      if (!reply && isTrendingQuery(cleanText)) {
        reply = await fetchTrendingFallback()
      }
      // For other agent queries (swap, balance, etc.) → Bankr Agent
      if (!reply && needsAgent(cleanText)) {
        const agentPrompt = isXQuery(cleanText) ? buildXPrompt(cleanText) : cleanText
        const maxPolls = (isXQuery(cleanText) || /bankr/i.test(cleanText)) ? 25 : 15
        const agentRaw = await askBankrAgent(agentPrompt, maxPolls)
        if (agentRaw) reply = formatAgentReply(agentRaw)
      }
      if (!reply) {
        addToHistory(userId, 'user', cleanText)
        reply = await askLLM(getHistory(userId))
        if (reply) addToHistory(userId, 'assistant', reply)
      }
      if (!reply) reply = "Couldn't process that right now. Try again! 🔄"
      const sendOpts: any = {
        parse_mode: 'HTML',
        reply_to_message_id: msg.message_id,
        disable_web_page_preview: true,
      }
      // Preserve topic thread so reply stays in the correct topic
      const replyThreadId = (msg as any).message_thread_id
      if (replyThreadId) sendOpts.message_thread_id = replyThreadId
      await bot.sendMessage(chatId, reply, sendOpts)
    } catch (err) {
      await bot.sendMessage(chatId, "Something went wrong. Try again! 🔄")
    }
    return
  }

  // Launch wizard takes priority
  if (launchSessions.has(userId)) {
    await handleLaunchWizard(chatId, userId, text)
    return
  }

  // X Handle session
  if (xHandleSessions.has(userId)) {
    xHandleSessions.delete(userId)
    const handle = text.replace('@', '').trim()
    if (!handle) {
      await bot.sendMessage(chatId, '⚠️ Invalid handle. Try again with /profile')
      return
    }
    const users2 = loadUsers()
    if (!users2[userId]) users2[userId] = { id: userId, points: 0, joinedAt: Date.now() }
    users2[userId].xHandle = handle
    users2[userId].telegramUsername = msg.from?.username
    users2[userId].telegramName = msg.from?.first_name
    saveUsers(users2)
    autoCompleteQuest(userId, 'set_x_handle', chatId)
    await bot.sendMessage(chatId,
      `✅ X handle set: <b>@${handle}</b>\n\nUse /profile to view your profile.`,
      { parse_mode: 'HTML' } as any
    )
    return
  }

  // Score session — waiting for handle
  if (scoreSessions.has(userId)) {
    scoreSessions.delete(userId)
    const handle = text.replace('@', '').trim()
    if (!handle) {
      await bot.sendMessage(chatId, '⚠️ Invalid handle. Try again!')
      return
    }
    await runBuilderScore(chatId, handle)
    return
  }

  // Wallet conversational flow — user provided details for swap/send/etc
  if (walletConvSessions.has(userId)) {
    const session = walletConvSessions.get(userId)!
    walletConvSessions.delete(userId)
    clearSessionTimer(userId)

    const actionLabels: Record<string, string> = {
      wallet_swap: 'swap', wallet_send: 'send', wallet_dca: 'DCA',
      wallet_limit: 'limit order', wallet_stoploss: 'stop loss',
      wallet_polymarket: 'Polymarket bet', wallet_bridge: 'bridge',
    }
    const label = actionLabels[session.action] || 'action'

    bot.sendChatAction(chatId, 'typing').catch(() => {})

    // ── Native swap ──
    if (session.action === 'wallet_swap') {
      const parsed = parseSwapIntent(text)
      if (!parsed) {
        await bot.sendMessage(chatId,
          `⚠️ Couldn't parse swap. Try:\n<code>swap 10 USDC to ETH</code>\n<code>buy $BLUEAGENT with 5 USDC</code>`,
          { parse_mode: 'HTML' } as any
        )
        return
      }
      const usersForSwap = loadUsers()
      const pk = usersForSwap[userId]?.privateKey
      if (!pk) { await bot.sendMessage(chatId, '⚠️ Wallet not found. Type /start.'); return }

      await bot.sendMessage(chatId, `⏳ Swapping ${parsed.amount} ${parsed.fromToken} → ${parsed.toToken}...\n<i>~15-30s</i>`, { parse_mode: 'HTML' } as any)
      const swapResult = await swapTokens(pk, parsed.fromToken, parsed.toToken, parsed.amount)
      if ('error' in swapResult) {
        await bot.sendMessage(chatId, `❌ Swap failed: ${swapResult.error}`)
      } else {
        await bot.sendMessage(chatId,
          `✅ <b>Swap complete!</b>\n\n` +
          `${parsed.amount} ${parsed.fromToken.toUpperCase()} → <b>${swapResult.amountOut}</b>\n\n` +
          `🔗 <a href="${swapResult.explorerUrl}">View on Basescan</a>`,
          { parse_mode: 'HTML', disable_web_page_preview: true } as any
        )
      }
      return
    }

    // ── Native send ──
    if (session.action === 'wallet_send') {
      const parsed = parseSendIntent(text)
      if (!parsed) {
        await bot.sendMessage(chatId,
          `⚠️ Couldn't parse. Try:\n<code>send 5 USDC to 0x...</code>\n<code>send 0.01 ETH to 0x...</code>`,
          { parse_mode: 'HTML' } as any
        )
        return
      }
      const usersForSend = loadUsers()
      const pk = usersForSend[userId]?.privateKey
      if (!pk) { await bot.sendMessage(chatId, '⚠️ Wallet not found. Type /start.'); return }

      await bot.sendMessage(chatId, `⏳ Sending ${parsed.amount} ${parsed.token}...\n<i>~15-30s</i>`, { parse_mode: 'HTML' } as any)
      const sendResult = await sendToken(pk, parsed.toAddress, parsed.token, parsed.amount)
      if ('error' in sendResult) {
        await bot.sendMessage(chatId, `❌ Send failed: ${sendResult.error}`)
      } else {
        await bot.sendMessage(chatId,
          `✅ <b>Sent!</b>\n\n` +
          `${parsed.amount} ${parsed.token.toUpperCase()} → <code>${parsed.toAddress.slice(0,6)}...${parsed.toAddress.slice(-4)}</code>\n\n` +
          `🔗 <a href="${sendResult.explorerUrl}">View on Basescan</a>`,
          { parse_mode: 'HTML', disable_web_page_preview: true } as any
        )
      }
      return
    }

    // ── Bridge / DCA / Limit / Perps → redirect to bankr.bot ──
    if (['wallet_bridge', 'wallet_dca', 'wallet_limit', 'wallet_stoploss'].includes(session.action)) {
      await bot.sendMessage(chatId,
        `🌉 <b>${label.charAt(0).toUpperCase() + label.slice(1)}</b> requires Bankr directly.\n\n` +
        `👉 <a href="https://bankr.bot">bankr.bot</a> — connect your wallet there to use bridge, DCA, and limit orders.`,
        { parse_mode: 'HTML', disable_web_page_preview: true } as any
      )
      return
    }

    await bot.sendMessage(chatId, `⏳ Processing your ${label}...`)

    // Build enriched prompt with wallet context
    const enrichedPrompt = `${text}\n\nUser wallet address on Base: ${session.addr}`
    const result = await askBankrAgent(enrichedPrompt, 25)

    await bot.sendMessage(chatId,
      result || '⚠️ Could not process. Try again.',
      { parse_mode: 'HTML', disable_web_page_preview: true } as any
    )
    return
  }

  // (Wallet OTP flow removed — wallet auto-created on /start)

  // Submit project flow
  if (submitSessions.has(userId)) {
    const session = submitSessions.get(userId)!
    switch (session.step) {
      case 1: // Name — validate max 50 chars
        if (text.length > 50) {
          await bot.sendMessage(chatId, '⚠️ Name too long (max 50 chars). Try again:')
          return
        }
        session.name = text
        session.step = 2
        await bot.sendMessage(chatId,
          `✅ <b>${text}</b>\n\nStep 2/4: Short description <i>(max 200 chars)</i>:`,
          { parse_mode: 'HTML' } as any
        )
        break
      case 2: // Description — validate max 200 chars
        if (text.length > 200) {
          await bot.sendMessage(chatId, `⚠️ Too long (${text.length}/200 chars). Shorten it:`)
          return
        }
        session.description = text
        session.step = 3
        await bot.sendMessage(chatId, `Step 3/4: Project URL <i>(must start with http)</i>:`, { parse_mode: 'HTML' } as any)
        break
      case 3: // URL — validate format
        if (!text.startsWith('http')) {
          await bot.sendMessage(chatId, '⚠️ Must start with http:// or https://. Try again:')
          return
        }
        // Check duplicate URL
        const existingProjects = loadProjects()
        const duplicate = existingProjects.find(p => p.url === text)
        if (duplicate) {
          await bot.sendMessage(chatId, `⚠️ Project with this URL already exists: <b>${duplicate.name}</b>`, { parse_mode: 'HTML' } as any)
          submitSessions.delete(userId)
          return
        }
        session.url = text
        session.step = 4
        await bot.sendMessage(chatId, `Step 4/4: X/Twitter handle <i>(optional — type "skip")</i>:`, { parse_mode: 'HTML' } as any)
        break
      case 4: // Twitter + save
        session.twitter = text.toLowerCase() === 'skip' ? undefined : text.replace('@', '')
        const projects2 = loadProjects()
        const newProject: Project = {
          id: `proj_${Date.now()}`,
          name: session.name!,
          description: session.description!,
          url: session.url!,
          twitter: session.twitter,
          submitterId: userId,
          submitterUsername: msg.from?.username,
          timestamp: Date.now(),
          votes: 0,
          voters: [],
          approved: false  // chờ admin duyệt
        }
        projects2.push(newProject)
        saveProjects(projects2)
        submitSessions.delete(userId)

        // Auto-complete quests
        autoCompleteQuest(userId, 'first_submit', chatId)
        autoCompleteQuest(userId, 'weekly_submit', chatId)
        autoCompleteQuest(userId, 'daily_vote', chatId)

        // Notify user — pending review, no pts yet
        await bot.sendMessage(chatId,
          `✅ <b>Project Submitted!</b>\n\n` +
          `<b>${newProject.name}</b>\n` +
          `${newProject.description}\n` +
          `🔗 ${newProject.url}\n` +
          (newProject.twitter ? `🐦 @${newProject.twitter}\n` : '') +
          `\n⏳ <i>Under review. You'll receive +20 pts once approved!</i>`,
          { parse_mode: 'HTML', disable_web_page_preview: true } as any
        )

        // Notify admin (OWNER_ID) with Approve/Reject buttons
        const submitterTag = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'Builder'
        bot.sendMessage(OWNER_ID,
          `📝 <b>New Project — Pending Review</b>\n\n` +
          `<b>${newProject.name}</b>\n` +
          `${newProject.description}\n\n` +
          `🔗 <a href="${newProject.url}">${newProject.url}</a>\n` +
          (newProject.twitter ? `🐦 @${newProject.twitter}\n` : '') +
          `\n👤 Submitted by ${submitterTag}`,
          {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Approve', callback_data: `admin_approve_${newProject.id}` },
                { text: '❌ Reject', callback_data: `admin_reject_${newProject.id}` }
              ]]
            }
          } as any
        ).catch(console.error)

        break
    }
    submitSessions.set(userId, session)
    return
  }

  // Typing indicator
  bot.sendChatAction(chatId, 'typing').catch(() => {})
  const typingInterval = setInterval(() => {
    bot.sendChatAction(chatId, 'typing').catch(() => {})
  }, 4000)


  try {
    let reply = ''

    // ── Native swap intercept (natural language) ──
    const swapParsed = parseSwapIntent(text)
    if (swapParsed) {
      const usersNative = loadUsers()
      const pk = usersNative[userId]?.privateKey
      if (pk) {
        await bot.sendMessage(chatId,
          `⏳ Swapping ${swapParsed.amount} ${swapParsed.fromToken} → ${swapParsed.toToken}...\n<i>~15-30s</i>`,
          { parse_mode: 'HTML' } as any
        )
        const swapRes = await swapTokens(pk, swapParsed.fromToken, swapParsed.toToken, swapParsed.amount)
        if ('error' in swapRes) {
          await bot.sendMessage(chatId, `❌ Swap failed: ${swapRes.error}`)
        } else {
          await bot.sendMessage(chatId,
            `✅ <b>Swap complete!</b>\n\n` +
            `${swapParsed.amount} ${swapParsed.fromToken.toUpperCase()} → <b>${swapRes.amountOut}</b>\n\n` +
            `🔗 <a href="${swapRes.explorerUrl}">View on Basescan</a>`,
            { parse_mode: 'HTML', disable_web_page_preview: true } as any
          )
        }
        clearInterval(typingInterval)
        return
      }
    }

    // ── Native send intercept (natural language) ──
    const sendParsed = parseSendIntent(text)
    if (sendParsed) {
      const usersNative = loadUsers()
      const pk = usersNative[userId]?.privateKey
      if (pk) {
        await bot.sendMessage(chatId,
          `⏳ Sending ${sendParsed.amount} ${sendParsed.token}...\n<i>~15-30s</i>`,
          { parse_mode: 'HTML' } as any
        )
        const sendRes = await sendToken(pk, sendParsed.toAddress, sendParsed.token, sendParsed.amount)
        if ('error' in sendRes) {
          await bot.sendMessage(chatId, `❌ Send failed: ${sendRes.error}`)
        } else {
          await bot.sendMessage(chatId,
            `✅ <b>Sent!</b>\n\n` +
            `${sendParsed.amount} ${sendParsed.token.toUpperCase()} → <code>${sendParsed.toAddress.slice(0,6)}...${sendParsed.toAddress.slice(-4)}</code>\n\n` +
            `🔗 <a href="${sendRes.explorerUrl}">View on Basescan</a>`,
            { parse_mode: 'HTML', disable_web_page_preview: true } as any
          )
        }
        clearInterval(typingInterval)
        return
      }
    }

    if (needsAgent(text)) {
      // Inject user wallet address when query is about their wallet/portfolio
      const isWalletQuery = /my\s+(wallet|portfolio|balance|token|nft|position)|check\s+(my|wallet|balance)/i.test(text)
      const usersMap = loadUsers()
      const currentUser = usersMap[userId]
      const userAddr = currentUser?.evmAddress

      let agentPrompt = isXQuery(text) ? buildXPrompt(text) : text

      if (isWalletQuery && userAddr) {
        agentPrompt = `Check portfolio and token balances for wallet address ${userAddr} on Base chain. Do NOT use any other wallet. Wallet: ${userAddr}`
        console.log(`[Agent] [wallet-enriched] addr=${userAddr}`)
      }

      const maxPolls = (isXQuery(text) || /bankr/i.test(text)) ? 25 : 15
      console.log(`[Agent] ${isXQuery(text) ? '[X-enriched]' : ''} ${text}`)
      const agentRaw = await askBankrAgent(agentPrompt, maxPolls)
      if (agentRaw) {
        reply = formatAgentReply(agentRaw)
      }
    }

    if (!reply) {
      // LLM fallback: Blue Agent personality for general questions
      console.log(`[LLM] ${text}`)
      addToHistory(userId, 'user', text)
      reply = await askLLM(getHistory(userId))
      if (reply) addToHistory(userId, 'assistant', reply)
    }

    if (!reply) {
      reply = "Couldn't process that right now. Try again in a moment! 🔄"
    }

    await bot.sendMessage(chatId, reply, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    } as any)

  } catch (e: any) {
    console.error('Handler error:', e.message)
    await bot.sendMessage(chatId, 'Something went wrong. Please try again!')
  } finally {
    clearInterval(typingInterval)
  }
})

// =======================
// STARTUP
// =======================
// DM commands (default)
bot.setMyCommands([
  { command: 'start', description: '🟦 Start Blue Agent' },
  { command: 'menu', description: '📱 Control Panel' },
  { command: 'score', description: '📊 Builder Score (@handle)' },
  { command: 'points', description: '⭐ My Points & Rank' },
  { command: 'wallet', description: '💰 Wallet & Trade' },
  { command: 'profile', description: '👤 My Profile' },
  { command: 'rewards', description: '🎁 Rewards & Claim' },
  { command: 'refer', description: '🔗 Referral Link' },
  { command: 'leaderboard', description: '🏆 Top Builders' },
  { command: 'submit', description: '📝 Submit Project' },
  { command: 'projects', description: '📁 Builder Directory' },
  { command: 'news', description: '📰 Base Builder Feed' },
  { command: 'launch', description: '🚀 Deploy Token on Base' },
  { command: 'stats', description: '📈 Blue Agent Stats' },
  { command: 'agents', description: '🤖 Bankr Agent Leaderboard' },
  { command: 'help', description: '❓ Help' },
]).catch(() => {})

// Group commands — only what makes sense in group context
bot.setMyCommands([
  { command: 'points', description: '⭐ My Points & Rank' },
  { command: 'leaderboard', description: '🏆 Top Builders' },
  { command: 'news', description: '📰 Base Builder Feed' },
  { command: 'stats', description: '📈 Blue Agent Stats' },
], { scope: { type: 'all_group_chats' } } as any).catch(() => {})

// Owner-only commands
bot.setMyCommands([
  { command: 'start', description: '🟦 Start Blue Agent' },
  { command: 'menu', description: '📱 Control Panel' },
  { command: 'score', description: '📊 Builder Score (@handle)' },
  { command: 'wallet', description: '💰 Wallet & Trade' },
  { command: 'profile', description: '👤 My Profile' },
  { command: 'rewards', description: '🎁 Rewards Hub' },
  { command: 'refer', description: '🔗 Referral Link' },
  { command: 'leaderboard', description: '🏆 Top Builders' },
  { command: 'submit', description: '📝 Submit Project' },
  { command: 'projects', description: '📁 Builder Directory' },
  { command: 'news', description: '📰 Base Builder Feed' },
  { command: 'launch', description: '🚀 Deploy Token on Base' },
  { command: 'stats', description: '📈 Blue Agent Stats' },
  { command: 'agents', description: '🤖 Bankr Agent Leaderboard' },
  { command: 'help', description: '❓ Help' },
  { command: 'model', description: '🤖 AI Models' },
  { command: 'status', description: '🔍 Health Check' },
], { scope: { type: 'chat', chat_id: OWNER_ID } } as any).catch(() => {})

bot.getMe().then((me) => {
  console.log(`🟦 Blue Agent started: @${me.username}`)
  console.log(`LLM key: ${BANKR_LLM_KEY ? 'loaded' : 'MISSING'}`)
  console.log(`Agent key: ${BANKR_API_KEY ? 'loaded' : 'MISSING'}`)
}).catch(console.error)

// =======================
// BLUE-ALPHA AUTO SIGNALS
// =======================
const ALPHA_CHAT_ID = CFG.telegram.group_id
const ALPHA_THREAD_ID = 15
const SIGNAL_INTERVAL_MS = 45 * 60 * 1000 // every 45 minutes
let signalCounter = 0

// Persist posted signals to file to survive restarts
const SIGNALS_FILE = path.join(DATA_DIR, 'posted_signals.json')
function loadPostedSignals(): Set<string> {
  try {
    const data = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8'))
    // Only keep signals from last 24h to avoid growing forever
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const fresh = (data.entries || []).filter((e: any) => e.ts > cutoff)
    return new Set(fresh.map((e: any) => e.id))
  } catch { return new Set() }
}
function savePostedSignal(id: string) {
  try {
    const data = fs.existsSync(SIGNALS_FILE)
      ? JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8'))
      : { entries: [] }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    data.entries = (data.entries || []).filter((e: any) => e.ts > cutoff)
    data.entries.push({ id, ts: Date.now() })
    fs.writeFileSync(SIGNALS_FILE, JSON.stringify(data))
  } catch {}
}

const postedSignalUrls: Set<string> = loadPostedSignals()
console.log(`[Alpha] Loaded ${postedSignalUrls.size} previously posted signals`)

async function postAlphaSignal() {
  try {
    // Use GeckoTerminal trending pools on Base — more reliable data
    const res = await axios.get(
      'https://api.geckoterminal.com/api/v2/networks/base/trending_pools?page=1',
      { timeout: 8000 }
    )
    const EXCLUDE = ['WETH','cbETH','cbBTC','USDC','USDbC','DAI','USDT','WBTC','ETH']
    const pools = (res.data?.data || [])
    const candidates = pools
      .filter((p: any) => {
        const name: string = p.attributes?.name || ''
        const baseSymbol = name.split(' / ')[0].trim()
        return !EXCLUDE.includes(baseSymbol)
      })
      .filter((p: any) => {
        const vol = parseFloat(p.attributes?.volume_usd?.h24 || '0')
        const change24 = parseFloat(p.attributes?.price_change_percentage?.h24 || '0')
        const change1h = parseFloat(p.attributes?.price_change_percentage?.h1 || '0')
        const fdv = parseFloat(p.attributes?.fdv_usd || '0')
        const mcap = parseFloat(p.attributes?.market_cap_usd || p.attributes?.fdv_usd || '0') // MCap real, fallback to FDV
        const liq = parseFloat(p.attributes?.reserve_in_usd || '0')
        const buys = p.attributes?.transactions?.h24?.buys || 0
        const sells = p.attributes?.transactions?.h24?.sells || 0
        const buyers = p.attributes?.transactions?.h24?.buyers || 0
        const ageMs = p.attributes?.pool_created_at
          ? Date.now() - new Date(p.attributes.pool_created_at).getTime()
          : 999 * 24 * 60 * 60 * 1000
        const ageDays = ageMs / (1000 * 60 * 60 * 24)

        const buysSellsRatio = sells > 0 ? buys / sells : buys
        const volLiqRatio = liq > 0 ? vol / liq : 0

        return (
          // MCap range — prefer real mcap, fallback FDV
          mcap >= 20_000 && mcap <= 5_000_000 &&
          // Liquidity — enough to trade
          liq >= 10_000 &&
          // Vol/Liq ratio — activity signal (cap wash trading)
          volLiqRatio >= 0.3 && volLiqRatio <= 30 &&
          // Buy pressure
          buys > sells &&
          buysSellsRatio >= 1.2 &&
          // Enough activity
          buys >= 30 &&
          buyers >= 15 &&
          // Age — not a brand new rug, not dead
          ageDays >= 0.01 &&                          // > 15 min
          ageDays <= 30 &&
          // Momentum — at least positive 24h
          change24 > 3
        )
      })
      .filter((p: any) => !postedSignalUrls.has(p.id))
      .slice(0, 3)

    // Also scan Clanker new launches
    const clankerSignals: any[] = []
    try {
      const clankerRes = await axios.get(
        'https://www.clanker.world/api/tokens?sort=desc&limit=20',
        { timeout: 6000 }
      )
      const newTokens = (clankerRes.data?.data || []).filter((t: any) => {
        const created = new Date(t.created_at).getTime()
        const ageH = (Date.now() - created) / (1000 * 60 * 60)
        return ageH <= 6 // only last 6h — truly new
      })

      for (const token of newTokens.slice(0, 5)) {
        const ca = token.contract_address
        if (!ca || postedSignalUrls.has(`clanker_${ca}`)) continue
        try {
          const gRes = await axios.get(
            `https://api.geckoterminal.com/api/v2/networks/base/tokens/${ca}/pools?page=1`,
            { timeout: 5000 }
          )
          const pool = gRes.data?.data?.[0]
          if (!pool) continue
          const attr = pool.attributes
          const fdv = parseFloat(attr?.fdv_usd || '0')
          const liq = parseFloat(attr?.reserve_in_usd || '0')
          const vol = parseFloat(attr?.volume_usd?.h24 || '0')
          const buys = attr?.transactions?.h24?.buys || 0
          const sells = attr?.transactions?.h24?.sells || 0
          const change24 = parseFloat(attr?.price_change_percentage?.h24 || '0')

          if (liq >= 10_000 && buys > 20) { // New launch: just need liq + early buys
            clankerSignals.push({ token, pool, attr, ca })
          }
        } catch {}
        await new Promise(r => setTimeout(r, 500))
      }
    } catch {}

    const allCandidates = [...candidates.slice(0, 4), ...clankerSignals.slice(0, 1)]

    if (!allCandidates.length && !candidates.length) {
      console.log('[Alpha] No strong signals this round')
      return
    }

    // Post Clanker signals
    for (const { token, attr, ca } of clankerSignals.slice(0, 1)) {
      signalCounter++
      const rawPrice = parseFloat(attr?.base_token_price_usd || '0')
      const price = rawPrice === 0 ? 'N/A' : rawPrice >= 0.0001 ? `$${rawPrice.toFixed(6)}` : `$${rawPrice.toFixed(10).replace(/0+$/, '')}`
      const change24 = attr?.price_change_percentage?.h24 != null ? `${parseFloat(attr.price_change_percentage.h24) >= 0 ? '+' : ''}${parseFloat(attr.price_change_percentage.h24).toFixed(1)}%` : 'N/A'
      const vol = attr?.volume_usd?.h24 ? `$${(parseFloat(attr.volume_usd.h24)/1000).toFixed(1)}K` : 'N/A'
      const liq = attr?.reserve_in_usd ? `$${(parseFloat(attr.reserve_in_usd)/1000).toFixed(1)}K` : 'N/A'
      const mcap = attr?.fdv_usd ? `$${(parseFloat(attr.fdv_usd)/1000).toFixed(1)}K` : 'N/A'
      const buys = attr?.transactions?.h24?.buys || 0
      const sells = attr?.transactions?.h24?.sells || 0

      const commentary = await askLLM([{
        role: 'user',
        content: `You are Blue Agent 🟦 — onchain AI on Base. Write EXACTLY 1-2 short sentences for traders. Just the key signal read:\n\nToken: ${token.name} (${token.symbol}) — Clanker launch\nPrice: ${price}\n24h: ${change24}\nVol: ${vol}  Liq: ${liq}  MCap: ${mcap}\nBuys/Sells: ${buys}/${sells}`
      }])

      const msg =
        `🟡 <b>Blue Agent Early #${signalCounter}</b>  <i>New Launch · Clanker</i>\n\n` +
        `<b>$${token.symbol}</b>  ·  Base\n` +
        `━━━━━━━━━━━━━━\n` +
        `💰 ${price}  📈 ${change24} (24h)\n` +
        `🏦 MCap: ${mcap}  💧 Liq: ${liq}\n` +
        `📊 Vol: ${vol}  ⏱ <24h\n` +
        `🛒 ${buys} buys  📤 ${sells} sells\n` +
        `━━━━━━━━━━━━━━\n` +
        `🧠 <i>${commentary}</i>\n\n` +
        `<a href="https://dexscreener.com/base/${ca}">📊 Chart</a>  ·  ` +
        `<a href="https://www.clanker.world/clanker/${ca}">🔵 Clanker</a>  ·  ` +
        `<a href="https://t.me/blueagent_hub/1">💬 Discuss</a>`

      await bot.sendMessage(ALPHA_CHAT_ID, msg, {
        parse_mode: 'HTML',
        message_thread_id: ALPHA_THREAD_ID,
        disable_web_page_preview: true,
      } as any)

      postedSignalUrls.add(`clanker_${ca}`); savePostedSignal(`clanker_${ca}`)
      console.log(`[Alpha] Clanker signal #${signalCounter}: ${token.symbol}`)
      await new Promise(r => setTimeout(r, 3000))
    }

    for (const p of candidates) {
      signalCounter++
      const attr = p.attributes
      const name: string = attr?.name || 'Unknown'
      const baseSymbol = name.split(' / ')[0].trim()
      const poolAddress = p.id.split('_')[1] || ''

      // Price
      const rawPrice = parseFloat(attr?.base_token_price_usd || '0')
      const price = rawPrice === 0 ? 'N/A'
        : rawPrice >= 1 ? `$${rawPrice.toFixed(4)}`
        : rawPrice >= 0.0001 ? `$${rawPrice.toFixed(6)}`
        : `$${rawPrice.toFixed(10).replace(/0+$/, '')}`

      const change24 = attr?.price_change_percentage?.h24 != null
        ? `${parseFloat(attr.price_change_percentage.h24) >= 0 ? '+' : ''}${parseFloat(attr.price_change_percentage.h24).toFixed(1)}%`
        : 'N/A'
      const change1h = attr?.price_change_percentage?.h1 != null
        ? `${parseFloat(attr.price_change_percentage.h1) >= 0 ? '+' : ''}${parseFloat(attr.price_change_percentage.h1).toFixed(1)}%`
        : 'N/A'
      const vol = attr?.volume_usd?.h24
        ? `$${(parseFloat(attr.volume_usd.h24) / 1000).toFixed(1)}K`
        : 'N/A'
      const liq = attr?.reserve_in_usd
        ? `$${(parseFloat(attr.reserve_in_usd) / 1000).toFixed(1)}K`
        : 'N/A'
      const mcap = attr?.market_cap_usd || attr?.fdv_usd
        ? `$${(parseFloat(attr.market_cap_usd || attr.fdv_usd) / 1000).toFixed(1)}K`
        : 'N/A'
      const buys = attr?.transactions?.h24?.buys || 0
      const sells = attr?.transactions?.h24?.sells || 0
      const buyers = attr?.transactions?.h24?.buyers || 0
      const age = attr?.pool_created_at
        ? `${Math.floor((Date.now() - new Date(attr.pool_created_at).getTime()) / (1000 * 60 * 60 * 24))}d`
        : 'N/A'

      // Get token contract address for DexScreener social lookup
      const tokenAddr = p.relationships?.base_token?.data?.id?.split('_')[1] || ''
      let twitter = '', telegram = '', website = ''
      if (tokenAddr) {
        try {
          const dexRes = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`,
            { timeout: 5000 }
          )
          const dexPair = (dexRes.data?.pairs || [])[0]
          const socials = dexPair?.info?.socials || []
          const sites = dexPair?.info?.websites || []
          twitter = socials.find((s: any) => s.type === 'twitter')?.url || ''
          telegram = socials.find((s: any) => s.type === 'telegram')?.url || ''
          website = sites[0]?.url || ''
        } catch {}
      }

      const socialLine = [
        twitter ? `<a href="${twitter}">𝕏</a>` : '',
        telegram ? `<a href="${telegram}">TG</a>` : '',
        website ? `<a href="${website}">Web</a>` : '',
      ].filter(Boolean).join(' · ')

      const dexUrl = `https://www.geckoterminal.com/base/pools/${poolAddress}`
      const dexScreenerUrl = tokenAddr ? `https://dexscreener.com/base/${tokenAddr}` : dexUrl

      // LLM commentary
      const commentary = await askLLM([{
        role: 'user',
        content: `You are Blue Agent 🟦 — onchain AI on Base. Write EXACTLY 1-2 short sentences for traders. NO tips, NO extra advice, NO line breaks. Just the key signal read:\n\nToken: ${name}\n24h: ${change24}  1h: ${change1h}\nVol: ${vol}  Liq: ${liq}  MCap: ${mcap}\nBuys/Sells: ${buys}/${sells}  Buyers: ${buyers}  Age: ${age}`
      }])

      // Buy/sell ratio
      const bsRatio = sells > 0 ? (buys / sells).toFixed(1) : buys.toString()

      const msg =
        `🟢 <b>Base Gem Signal #${signalCounter}</b>\n\n` +
        `<b>$${baseSymbol}</b>  ·  Base chain\n` +
        `━━━━━━━━━━━━━━\n` +
        `💰 ${price}\n` +
        `📈 24h: ${change24}  ·  1h: ${change1h}\n` +
        `🏦 MCap: ${mcap}  ·  💧 Liq: ${liq}\n` +
        `📊 Vol: ${vol}  ·  ⏱ Age: ${age}\n` +
        `🛒 ${buys} buys  📤 ${sells} sells\n` +
        `👥 ${buyers} unique buyers  ·  B/S ratio: ${bsRatio}x\n` +
        `━━━━━━━━━━━━━━\n` +
        `🧠 <i>${commentary}</i>\n\n` +
        (socialLine ? `${socialLine}  ·  ` : '') +
        `<a href="${dexScreenerUrl}">📊 Chart</a>  ·  ` +
        `<a href="https://t.me/blueagent_hub/1">💬 Discuss</a>`

      await bot.sendMessage(ALPHA_CHAT_ID, msg, {
        parse_mode: 'HTML',
        message_thread_id: ALPHA_THREAD_ID,
        disable_web_page_preview: true,
      } as any)

      postedSignalUrls.add(p.id); savePostedSignal(p.id)
      console.log(`[Alpha] Signal #${signalCounter} posted: ${baseSymbol} | id=${p.id}`)
      await new Promise(r => setTimeout(r, 3000))
    }
  } catch (err) {
    console.error('[Alpha] Signal error:', err)
  }
}

// Post Bankr trending summary to blue-alpha
async function postBankrTrending() {
  try {
    const result = await askBankrAgent(
      'Give me the current trending tokens on Base from Bankr. Include top 5 tokens with price, 24h change, and volume. Format as a clean list.',
      20
    )
    if (!result) return

    const msg = `📡 <b>Bankr Trending — Base</b>\n\n` +
      `${formatAgentReply(result)}\n\n` +
      `💬 <a href="https://t.me/blueagent_hub/1">Discuss in #blue-chat</a>\n` +
      `🔗 <a href="https://bankr.bot">bankr.bot</a>`

    await bot.sendMessage(ALPHA_CHAT_ID, msg, {
      parse_mode: 'HTML',
      message_thread_id: ALPHA_THREAD_ID,
      disable_web_page_preview: true,
    } as any)
    console.log('[Alpha] Bankr trending posted')
  } catch (err) {
    console.error('[Alpha] Bankr trending error:', err)
  }
}

// =======================
// DAILY LEADERBOARD AUTO-POST
// =======================
function scheduleDailyLeaderboard() {
  const now = new Date()
  const nextMidnightUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0))
  const msUntilMidnight = nextMidnightUTC.getTime() - now.getTime()

  setTimeout(async () => {
    await postDailyLeaderboard()
    setInterval(postDailyLeaderboard, 24 * 60 * 60 * 1000)
  }, msUntilMidnight)
}

async function postDailyLeaderboard() {
  try {
    const users = loadUsers()
    const sorted = Object.values(users)
      .filter((u: any) => (u.points || 0) > 0)
      .sort((a: any, b: any) => (b.points || 0) - (a.points || 0))
      .slice(0, 5)

    if (sorted.length === 0) return

    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣']
    const lines = sorted.map((u: any, i: number) => {
      const name = u.xHandle ? `@${u.xHandle}` : u.telegramUsername ? `@${u.telegramUsername}` : u.telegramName || 'Builder'
      return `${medals[i]} ${name} — <b>${(u.points || 0).toLocaleString()} pts</b>`
    })

    const msg = `🏆 <b>Daily Leaderboard</b> 🟦\n\n${lines.join('\n')}\n\n` +
      `Keep earning! /points · /rewards\n` +
      `<i>Check in daily → earn ${TOKEN_NAME}</i>`

    await bot.sendMessage(ALPHA_CHAT_ID, msg, {
      parse_mode: 'HTML',
      message_thread_id: 1,
    } as any)
  } catch (e) {
    console.error('[daily-leaderboard] error:', e)
  }
}

scheduleDailyLeaderboard()

// Start signal loop — gated by feature flag
if (featureEnabled('gem_signals')) {
  setTimeout(() => {
    postAlphaSignal()
    setInterval(postAlphaSignal, SIGNAL_INTERVAL_MS)
  }, 60 * 1000)

  setTimeout(() => {
    postBankrTrending()
    setInterval(postBankrTrending, 4 * 60 * 60 * 1000)
  }, 2 * 60 * 60 * 1000)
}

// =======================
// $BLUEAGENT TRADE TRACKER
// =======================
const TRADES_THREAD_ID = 60
const BLUEAGENT_CONTRACT = TOKEN_CONTRACT

// Price cache — avoid GeckoTerminal rate limits
let priceCache: { ts: number; data: any } = { ts: 0, data: null }
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY || ''
let lastProcessedTxHash = ''
const TRADE_POLL_MS = 60 * 1000 // check every 60s

const BLUEAGENT_POOL = TOKEN_POOL
const BLUEAGENT_LOGO = 'https://coin-images.coingecko.com/coins/images/102172586/large/blueagent.jpg?1774079652'
let lastProcessedTradeId = ''

async function checkBlueAgentTrades() {
  try {
    // Fetch trades + token info in parallel
    const [tradesRes, tokenRes] = await Promise.all([
      axios.get(`https://api.geckoterminal.com/api/v2/networks/base/pools/${BLUEAGENT_POOL}/trades`, { timeout: 8000 }),
      axios.get(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${BLUEAGENT_CONTRACT}`, { timeout: 5000 }).catch(() => null)
    ])

    const trades = tradesRes.data?.data || []
    if (!trades.length) return

    // Current price + 24h vol from token info
    const tokenAttr = tokenRes?.data?.data?.attributes || {}
    const currentPrice = tokenAttr.price_usd ? (() => {
      const p = parseFloat(tokenAttr.price_usd)
      if (p >= 1) return `$${p.toFixed(4)}`
      if (p >= 0.0001) return `$${p.toFixed(6)}`
      // Show as $0.00000072 format
      const fixed = p.toFixed(10).replace(/0+$/, '')
      return `$${fixed}`
    })() : 'N/A'
    const vol24h = tokenAttr.volume_usd?.h24
      ? `$${(parseFloat(tokenAttr.volume_usd.h24) / 1000).toFixed(1)}K`
      : 'N/A'
    const mcap = tokenAttr.market_cap_usd
      ? `$${(parseFloat(tokenAttr.market_cap_usd) / 1000).toFixed(1)}K`
      : tokenAttr.fdv_usd
        ? `$${(parseFloat(tokenAttr.fdv_usd) / 1000).toFixed(1)}K`
        : 'N/A'

    // Find new trades since last check
    const newTrades: any[] = []
    for (const t of trades) {
      if (t.id === lastProcessedTradeId) break
      newTrades.push(t)
    }
    if (!newTrades.length) return
    lastProcessedTradeId = trades[0].id

    // Post each significant trade (skip dust < $5)
    for (const t of newTrades.slice(0, 5)) {
      const attr = t.attributes || {}
      const usdValue = parseFloat(attr.volume_in_usd || '0')
      if (usdValue < 5) continue

      const isBuy = attr.kind === 'buy'
      const emoji = isBuy ? '🟢' : '🔴'
      const action = isBuy ? 'BUY' : 'SELL'
      const txHash = attr.tx_hash || ''
      const walletAddr = isBuy
        ? (attr.to_token_amount ? attr.tx_from_address : '')
        : ''

      // Time ago
      const tradeTime = attr.block_timestamp ? new Date(attr.block_timestamp) : new Date()
      const minsAgo = Math.floor((Date.now() - tradeTime.getTime()) / 60000)
      const timeStr = minsAgo < 1 ? 'just now' : `${minsAgo}m ago`

      const caption =
        `${emoji} <b>${action} $BLUEAGENT</b>\n\n` +
        `💰 <b>$${usdValue.toFixed(2)}</b>\n` +
        `📈 Price: <b>${currentPrice}</b>\n` +
        `📊 MCap: ${mcap}  Vol: ${vol24h}\n` +
        (txHash ? `👤 <a href="https://basescan.org/tx/${txHash}">${txHash.slice(0,6)}...${txHash.slice(-4)}</a>\n` : '') +
        `⏱ ${timeStr}\n\n` +
        `🔗 <a href="https://basescan.org/tx/${txHash}">Tx</a> · <a href="https://www.geckoterminal.com/base/pools/${BLUEAGENT_POOL}">Chart</a> · <a href="https://dexscreener.com/base/${BLUEAGENT_CONTRACT}">DEX</a>`

      await bot.sendPhoto(ALPHA_CHAT_ID, BLUEAGENT_LOGO, {
        caption,
        parse_mode: 'HTML',
        message_thread_id: TRADES_THREAD_ID,
      } as any)

      console.log(`[Trades] ${action} $${usdValue.toFixed(2)} tx:${txHash.slice(0, 10)}`)
      await new Promise(r => setTimeout(r, 2000))
    }
  } catch (err) {
    console.error('[Trades] Error:', err)
  }
}

// Start trade tracker — gated by feature flag
if (featureEnabled('trade_tracker')) {
  setTimeout(() => {
    checkBlueAgentTrades()
    setInterval(checkBlueAgentTrades, TRADE_POLL_MS)
  }, 30 * 1000)
}

// =======================
// ENGAGEMENT LOOP — blue-chat
// =======================
const TOPIC_MAP: Record<string, { thread: number; label: string; emoji: string }> = {
  alpha:    { thread: THREADS.alpha,    label: 'blue-alpha',    emoji: '🧠' },
  trades:   { thread: THREADS.trades,   label: 'blue-trades',   emoji: '📊' },
  feed:     { thread: THREADS.feed,     label: 'blue-feed',     emoji: '📰' },
  meme:     { thread: THREADS.meme,     label: 'blue-meme',     emoji: '😂' },
  builders: { thread: THREADS.builders, label: 'blue-builders', emoji: '👨‍💻' },
}

const GM_PATTERNS = /^\s*(gm|gn|hello|hi|hey|sup|wen|wagmi|ser|fren|ngm|good morning|good night)\s*[!🫡🟦🫶💙]*\s*$/i
const checkinToday = new Map<number, number>() // userId → last checkin date (YYYYMMDD)

function todayKey() {
  const d = new Date()
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
}

function buildEngagementReply(userId: number, firstName: string): string {
  const today = todayKey()
  const lastCheckin = checkinToday.get(userId)
  const isFirstToday = lastCheckin !== today

  if (isFirstToday) {
    // Award daily checkin points
    checkinToday.set(userId, today)
    const users = loadUsers()
    if (!users[userId]) users[userId] = { id: userId, points: 0, joinedAt: Date.now() }

    // Update streak
    const todayStart = new Date().setHours(0, 0, 0, 0)
    const yesterday = todayStart - 86400000
    const lastCheckin = users[userId].lastCheckin || 0
    const wasYesterday = lastCheckin >= yesterday && lastCheckin < todayStart
    const newStreak = wasYesterday ? (users[userId].checkinStreak || 0) + 1 : 1
    users[userId].checkinStreak = newStreak
    users[userId].lastCheckin = Date.now()

    const basePoints = 5
    const streakBonus = newStreak >= 3 ? 3 : 0
    users[userId].points = (users[userId].points || 0) + basePoints + streakBonus
    saveUsers(users)
  }

  const users = loadUsers()
  const streak = users[userId]?.checkinStreak || 0
  const streakBonus = isFirstToday && streak >= 3 ? 3 : 0
  const pointsMsg = isFirstToday
    ? `\n✅ Daily check-in: <b>+5 pts</b>` + (streakBonus > 0 ? `\n🔥 Streak bonus (${streak}d): <b>+${streakBonus} pts</b>` : '')
    : ''

  return `gm ${firstName}! 🟦${pointsMsg}\n\n` +
    `What's on today?\n\n` +
    `${TOPIC_MAP.alpha.emoji} <a href="https://t.me/blueagent_hub/15">Alpha & Signals</a> — latest gems on Base\n` +
    `${TOPIC_MAP.trades.emoji} <a href="https://t.me/blueagent_hub/60">$BLUEAGENT Trades</a> — live buy/sell tracker\n` +
    `${TOPIC_MAP.builders.emoji} <a href="https://t.me/blueagent_hub/5">Builders</a> — who's shipping today?\n` +
    `${TOPIC_MAP.feed.emoji} <a href="https://t.me/blueagent_hub/18">Feed</a> — Base ecosystem news\n` +
    `${TOPIC_MAP.meme.emoji} <a href="https://t.me/blueagent_hub/9">Memes</a> — you know why\n\n` +
    `<i>Use /score to check your builder rank · /leaderboard to see who's on top</i>`
}

// Listen for gm/casual in blue-chat (General topic only)
bot.on('message', async (msg) => {
  if (!msg.chat || msg.chat.id !== ALPHA_CHAT_ID) return
  const text = msg.text?.trim() || ''
  const threadId = (msg as any).message_thread_id

  // Only respond in General (thread 1 or undefined)
  if (threadId && threadId !== 1) return
  if (!GM_PATTERNS.test(text)) return

  const userId = msg.from?.id
  if (!userId) return
  const firstName = msg.from?.first_name || 'builder'

  const reply = buildEngagementReply(userId, firstName)
  await bot.sendMessage(ALPHA_CHAT_ID, reply, {
    parse_mode: 'HTML',
    reply_to_message_id: msg.message_id,
    disable_web_page_preview: true,
  } as any)
})


// =======================
// 1. AUTO-ONBOARDING — DM user khi join group
// =======================
bot.on('new_chat_members', async (msg) => {
  if (msg.chat.id !== ALPHA_CHAT_ID) return

  for (const newMember of msg.new_chat_members || []) {
    if (newMember.is_bot) continue
    const userId = newMember.id
    const firstName = newMember.first_name || 'builder'
    const username = newMember.username ? `@${newMember.username}` : firstName

    // Auto-create user record if not exists
    const users = loadUsers()
    if (!users[userId]) {
      const wallet = require('ethers').Wallet.createRandom()
      users[userId] = {
        id: userId,
        telegramUsername: newMember.username,
        telegramName: firstName,
        points: 5, // join bonus
        joinedAt: Date.now(),
        walletConnected: true,
        evmAddress: wallet.address,
        privateKey: wallet.privateKey,
      }
      saveUsers(users)
    }

    // Say hi in group General
    try {
      await bot.sendMessage(ALPHA_CHAT_ID,
        `👋 Welcome <b>${username}</b>! 🟦\n\n` +
        `Blue Agent is your onchain AI agent on Base — wallet, trading, builder score, and $BLUEAGENT rewards. All in Telegram.\n\n` +
        `DM @blockyagent_bot to get started:\n` +
        `• /score — check your builder rank\n` +
        `• /points — see your earnings\n` +
        `• /rewards — claim $BLUEAGENT\n\n` +
        `🌟 First 100 = OG Builder × 2x bonus. Spots filling up.`,
        { parse_mode: 'HTML' } as any
      )
    } catch {}

    // Send welcome DM
    try {
      await bot.sendMessage(userId,
        `🟦 <b>Hey ${firstName}, welcome to Blue Agent!</b>\n\n` +
        `You just joined a community of builders on Base.\n\n` +
        `<b>What Blue Agent can do:</b>\n` +
        `🔑 Auto wallet on Base — no setup needed\n` +
        `📊 Builder Score — rank any builder (0–100)\n` +
        `💱 Swap · Bridge · DCA · Limit orders\n` +
        `🔱 Hyperliquid perps up to 50x\n` +
        `🚀 Launch tokens — no code needed\n` +
        `⭐ Earn points → claim ${TOKEN_NAME}\n\n` +
        `<b>Get started:</b>\n` +
        `1️⃣ /start → activate wallet\n` +
        `2️⃣ /score @yourXhandle → check your rank\n` +
        `3️⃣ /rewards → see how to earn ${TOKEN_NAME}\n` +
        `4️⃣ /refer → invite builders, earn ${REWARDS.referrer_pts} pts each\n\n` +
        `🌟 <b>OG Builder slots open</b> — first 100 get 2x claim bonus forever.\n\n` +
        `<i>See you in the group 🟦</i>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🟦 Get Started', callback_data: 'open_menu' }]] } } as any
      )
    } catch {
      // User may have DMs disabled — silently ignore
    }
  }
})

// =======================
// 2. WEEKLY RECAP — Every Monday 9:00 AM
// =======================
function getNextMondayMs(): number {
  const now = new Date()
  const day = now.getDay() // 0=Sun, 1=Mon...
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7
  const next = new Date(now)
  next.setDate(now.getDate() + daysUntilMonday)
  next.setHours(9, 0, 0, 0)
  return next.getTime() - now.getTime()
}

async function postWeeklyRecap() {
  const users = loadUsers()
  const projects = loadProjects()
  const referrals = loadReferrals()

  const totalUsers = Object.keys(users).length
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const newUsers = Object.values(users).filter((u: any) => u.joinedAt > weekAgo).length
  const weeklyProjects = projects.filter(p => p.approved && p.timestamp > weekAgo).length
  const weeklyRefs = referrals.filter(r => r.timestamp > weekAgo).length

  // Top 3 builders by points
  const top3 = Object.values(users)
    .sort((a: any, b: any) => (b.points || 0) - (a.points || 0))
    .slice(0, 3)
    .map((u: any, i: number) => {
      const medal = ['🥇', '🥈', '🥉'][i]
      const name = u.telegramUsername ? `@${u.telegramUsername}` : u.telegramName || 'Builder'
      return `${medal} ${name} — <b>${u.points || 0} pts</b>`
    })

  const recap =
    `📊 <b>Weekly Builder Recap</b> 🟦\n` +
    `──────────────\n` +
    `👥 Total builders: <b>${totalUsers}</b> (+${newUsers} this week)\n` +
    `📁 Projects approved: <b>${weeklyProjects}</b>\n` +
    `🔗 Referrals made: <b>${weeklyRefs}</b>\n` +
    `──────────────\n` +
    `<b>🏆 Top Builders This Week:</b>\n` +
    top3.join('\n') +
    `\n──────────────\n` +
    `<i>Keep building. See you next week 🟦</i>`

  await bot.sendMessage(ALPHA_CHAT_ID, recap, {
    parse_mode: 'HTML',
    message_thread_id: THREADS.builders
  } as any).catch(console.error)
}

// Schedule weekly recap
setTimeout(() => {
  postWeeklyRecap()
  setInterval(postWeeklyRecap, 7 * 24 * 60 * 60 * 1000)
}, getNextMondayMs())

console.log(`📅 Weekly recap scheduled in ${Math.round(getNextMondayMs() / 3600000)}h`)

// =======================
// 3. MILESTONE ANNOUNCEMENTS
// =======================
const MILESTONES = [10, 25, 50, 100, 250, 500, 1000]

async function checkMilestones() {
  const users = loadUsers()
  const count = Object.keys(users).length
  const hit = MILESTONES.find(m => m === count)
  if (!hit) return

  await bot.sendMessage(ALPHA_CHAT_ID,
    `🎉 <b>Milestone reached!</b>\n\n` +
    `We just hit <b>${hit} builders</b> in the community! 🟦\n\n` +
    `Thank you for building with us. More builders = more signal. Keep shipping! 🔨`,
    { parse_mode: 'HTML', message_thread_id: THREADS.builders } as any
  ).catch(console.error)
}

// Check milestone on every new_chat_members
// (already handled above — add checkMilestones call after saving user)


// =======================
// REACTION VOTE TRACKING — Daily check 👍
// =======================
async function updateReactionVotes() {
  const projects = loadProjects()
  let updated = false

  for (const proj of projects) {
    if (!proj.approved || !proj.buildersMsgId) continue

    try {
      // Get message reactions via Telegram API
      const res = await axios.get(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMessageReactionCount`,
        { params: { chat_id: ALPHA_CHAT_ID, message_id: proj.buildersMsgId } }
      )

      if (res.data?.ok && res.data?.result?.reactions) {
        // Count 👍 reactions
        const thumbsUp = res.data.result.reactions.find(
          (r: any) => r.type?.emoji === '👍' || r.type?.type === 'emoji' && r.type?.emoji === '👍'
        )
        const count = thumbsUp?.total_count || 0

        const idx = projects.findIndex(p => p.id === proj.id)
        if (idx !== -1 && projects[idx].reactionVotes !== count) {
          projects[idx].reactionVotes = count
          // Merge reaction votes with button votes
          projects[idx].votes = (projects[idx].voters?.length || 0) + count
          updated = true
        }
      }
    } catch {
      // API may not support this — silently skip
    }
  }

  if (updated) saveProjects(projects)
  console.log(`[Reactions] Updated vote counts`)
}

// Check reactions every 6 hours
setInterval(updateReactionVotes, 6 * 60 * 60 * 1000)
setTimeout(updateReactionVotes, 30 * 1000) // initial check after 30s

// =======================
// WEEKLY COMMUNITY PICK — Monday with weekly recap
// =======================
async function postCommunityPick() {
  const projects = loadProjects()
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

  // Get approved projects with votes, sort by total votes
  const sorted = projects
    .filter(p => p.approved)
    .sort((a, b) => (b.votes || 0) - (a.votes || 0))
    .slice(0, 5)

  if (!sorted.length) return

  const winner = sorted[0]
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣']

  const lines = sorted.map((p, i) => {
    const submitter = p.submitterUsername ? `@${p.submitterUsername}` : 'Anonymous'
    const reactions = p.reactionVotes ? ` (${p.reactionVotes} 👍)` : ''
    return `${medals[i]} <b>${p.name}</b> — ${p.votes || 0} votes${reactions}\n   👤 ${submitter}`
  })

  // Announce winner + bonus pts
  const winnerUser = Object.values(loadUsers()).find((u: any) => u.telegramUsername === winner.submitterUsername)
  if (winnerUser) {
    const users = loadUsers()
    users[winnerUser.id].points = (users[winnerUser.id].points || 0) + 50
    saveUsers(users)

    // Notify winner
    bot.sendMessage(winnerUser.id,
      `🏆 <b>Your project won Community Pick this week!</b>\n\n` +
      `<b>${winner.name}</b> got the most votes from the community.\n\n` +
      `⭐ +50 pts bonus added to your account 🟦`,
      { parse_mode: 'HTML' } as any
    ).catch(console.error)
  }

  await bot.sendMessage(ALPHA_CHAT_ID,
    `🏆 <b>Community Pick — This Week</b>\n` +
    `──────────────\n` +
    lines.join('\n\n') +
    `\n──────────────\n` +
    `Congrats to <b>${winner.name}</b>! 🎉\n` +
    `${winnerUser ? `+50 pts bonus → @${winner.submitterUsername} 🟦` : ''}\n\n` +
    `<i>Vote for your favorite projects → /projects</i>`,
    { parse_mode: 'HTML', message_thread_id: THREADS.builders } as any
  ).catch(console.error)
}

// Community Pick runs with weekly recap (already scheduled)
// Patch postWeeklyRecap to also call postCommunityPick
const _originalWeeklyRecap = postWeeklyRecap
async function postWeeklyRecapWithPick() {
  await _originalWeeklyRecap()
  await postCommunityPick()
}
// Community Pick runs every Monday with weekly recap


// =======================
// QUEST SYSTEM
// =======================

interface Quest {
  id: string
  title: string
  description: string
  pts: number
  type: 'one_time' | 'daily' | 'weekly'
  category: 'social' | 'community' | 'onchain' | 'content'
  action?: string // callback_data to trigger
}

const QUESTS: Quest[] = [
  // One-time quests
  { id: 'set_x_handle',    title: 'Connect X Account',      description: 'Set your X/Twitter handle',              pts: 10,  type: 'one_time', category: 'social',    action: 'profile_set_x' },
  { id: 'first_submit',    title: 'Ship Something',          description: 'Submit your first project',              pts: 30,  type: 'one_time', category: 'community', action: 'menu_submit' },
  { id: 'first_refer',     title: 'First Referral',          description: 'Refer your first builder',               pts: 25,  type: 'one_time', category: 'community' },
  { id: 'follow_x',        title: 'Follow on X',             description: `Follow ${PROJECT.twitter} on X`,         pts: 20,  type: 'one_time', category: 'social',    action: 'quest_follow_x' },
  { id: 'like_pin_tweet',  title: 'Like Pinned Tweet',       description: 'Like the pinned tweet on our X account', pts: 10,  type: 'one_time', category: 'social',    action: 'quest_like_tweet' },
  { id: 'share_score',     title: 'Share Your Score',        description: 'Share your Builder Score on X',          pts: 15,  type: 'one_time', category: 'content',   action: 'quest_share_score' },

  // Daily quests (reset every 24h)
  { id: 'daily_checkin',   title: 'Daily Check-in',          description: 'Open the bot today',                     pts: 5,   type: 'daily',    category: 'community' },
  { id: 'daily_vote',      title: 'Vote a Project',          description: 'Vote for 1 project today',               pts: 5,   type: 'daily',    category: 'community', action: 'menu_projects' },

  // Weekly quests (reset every Monday)
  { id: 'weekly_refer',    title: 'Weekly Referral',         description: 'Refer 1 builder this week',              pts: 50,  type: 'weekly',   category: 'community' },
  { id: 'weekly_submit',   title: 'Build Something',         description: 'Submit a project this week',             pts: 40,  type: 'weekly',   category: 'community', action: 'menu_submit' },
  { id: 'weekly_active',   title: '5-Day Streak',            description: 'Check in 5 days this week',              pts: 30,  type: 'weekly',   category: 'community' },
]

function getUserCompletedQuests(userId: number): string[] {
  const users = loadUsers()
  return users[userId]?.completedQuests || []
}

function markQuestComplete(userId: number, questId: string): boolean {
  const users = loadUsers()
  if (!users[userId]) return false
  if (!users[userId].completedQuests) users[userId].completedQuests = []

  const quest = QUESTS.find(q => q.id === questId)
  if (!quest) return false

  // Check if already completed (for one_time quests)
  if (quest.type === 'one_time' && users[userId].completedQuests!.includes(questId)) return false

  // For daily: check if completed today
  if (quest.type === 'daily') {
    const todayKey = `${questId}_${new Date().toDateString()}`
    if (users[userId].completedQuests!.includes(todayKey)) return false
    users[userId].completedQuests!.push(todayKey)
  } else if (quest.type === 'weekly') {
    const weekKey = `${questId}_w${Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))}`
    if (users[userId].completedQuests!.includes(weekKey)) return false
    users[userId].completedQuests!.push(weekKey)
  } else {
    users[userId].completedQuests!.push(questId)
  }

  // Award pts
  users[userId].points = (users[userId].points || 0) + quest.pts
  saveUsers(users)
  return true
}

function isQuestDone(userId: number, quest: Quest): boolean {
  const completed = getUserCompletedQuests(userId)
  if (quest.type === 'one_time') return completed.includes(quest.id)
  if (quest.type === 'daily') return completed.includes(`${quest.id}_${new Date().toDateString()}`)
  if (quest.type === 'weekly') return completed.includes(`${quest.id}_w${Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))}`)
  return false
}

// /quests command
bot.onText(/\/quests/, async (msg) => {
  if (await blockInGroup(msg)) return
  const chatId = msg.chat.id
  const userId = msg.from?.id || chatId
  await sendQuestMenu(chatId, userId)
})

async function sendQuestMenu(chatId: number, userId: number) {
  const users = loadUsers()
  const user = users[userId] || {}
  const totalPts = user.points || 0

  // Count completed vs total
  const doneCount = QUESTS.filter(q => isQuestDone(userId, q)).length

  // Build quest list — group by type
  const oneTime = QUESTS.filter(q => q.type === 'one_time')
  const daily   = QUESTS.filter(q => q.type === 'daily')
  const weekly  = QUESTS.filter(q => q.type === 'weekly')

  const formatQuest = (q: Quest) => {
    const done = isQuestDone(userId, q)
    const status = done ? '✅' : '⭕'
    return `${status} <b>${q.title}</b> — +${q.pts} pts\n   <i>${q.description}</i>`
  }

  const text =
    `🎯 <b>Quests</b>\n` +
    `⭐ Your points: <b>${totalPts}</b> · Completed: <b>${doneCount}/${QUESTS.length}</b>\n` +
    `──────────────\n` +
    `<b>📅 Daily</b>\n` +
    daily.map(formatQuest).join('\n') +
    `\n\n<b>📆 Weekly</b>\n` +
    weekly.map(formatQuest).join('\n') +
    `\n\n<b>🏅 One-time</b>\n` +
    oneTime.map(formatQuest).join('\n')

  // Build action buttons for incomplete quests
  const actionButtons = QUESTS
    .filter(q => !isQuestDone(userId, q) && q.action)
    .slice(0, 4)
    .map(q => [{ text: `${q.title} → +${q.pts} pts`, callback_data: q.action! }])

  await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        ...actionButtons,
        [{ text: '🏠 Menu', callback_data: 'open_menu' }]
      ]
    }
  } as any)
}

// Quest callbacks
bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat.id
  const userId = query.from?.id
  if (!chatId || !userId) return

  const data = query.data || ''

  if (data === 'quest_follow_x') {
    const done = markQuestComplete(userId, 'follow_x')
    if (done) {
      await bot.answerCallbackQuery(query.id, { text: `✅ +20 pts! Thanks for following ${PROJECT.twitter}`, show_alert: true })
    } else {
      await bot.answerCallbackQuery(query.id, { text: '✅ Already completed!', show_alert: true })
    }
    return
  }

  if (data === 'quest_like_tweet') {
    const done = markQuestComplete(userId, 'like_pin_tweet')
    if (done) {
      await bot.answerCallbackQuery(query.id, { text: '✅ +10 pts! Thanks for the like 🔥', show_alert: true })
    } else {
      await bot.answerCallbackQuery(query.id, { text: '✅ Already completed!', show_alert: true })
    }
    return
  }

  if (data === 'quest_share_score') {
    const users = loadUsers()
    const user = users[userId]
    const handle = user?.xHandle || 'yourhandle'
    const done = markQuestComplete(userId, 'share_score')
    if (done) {
      const tweetText = encodeURIComponent(`My Builder Score on Base 🟦\n\nCheck yours: blueagent.xyz/score`)
      await bot.answerCallbackQuery(query.id)
      await bot.sendMessage(chatId,
        `✅ <b>+15 pts!</b>\n\nShare your score on X:\n` +
        `<a href="https://twitter.com/intent/tweet?text=${tweetText}">→ Tweet your score</a>`,
        { parse_mode: 'HTML' } as any
      )
    } else {
      await bot.answerCallbackQuery(query.id, { text: '✅ Already completed!', show_alert: true })
    }
    return
  }

  await bot.answerCallbackQuery(query.id).catch(() => {})
})

// Auto-complete quests on relevant actions
// Called from other handlers
function autoCompleteQuest(userId: number, questId: string, chatId?: number) {
  const done = markQuestComplete(userId, questId)
  if (done && chatId) {
    const quest = QUESTS.find(q => q.id === questId)
    if (quest) {
      bot.sendMessage(chatId,
        `🎯 <b>Quest Complete!</b> ${quest.title}\n⭐ +${quest.pts} pts`,
        { parse_mode: 'HTML' } as any
      ).catch(() => {})
    }
  }
}


// =======================
// SMART NOTIFICATIONS
// =======================

// Price drop/pump alert — check every 10 min
let lastNotifiedPrice = 0
let lastNotifiedTime = 0
const PRICE_ALERT_COOLDOWN = 60 * 60 * 1000 // 1h cooldown between alerts

async function checkPriceAlert() {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_CONTRACT}`, { timeout: 8000 })
    const pair = res.data?.pairs?.[0]
    if (!pair) return

    const price = parseFloat(pair.priceUsd || '0')
    const change1h = parseFloat(pair.priceChange?.h1 || '0')
    const change24h = parseFloat(pair.priceChange?.h24 || '0')
    const now = Date.now()

    if (now - lastNotifiedTime < PRICE_ALERT_COOLDOWN) return

    // Pump alert: +20% in 1h
    if (change1h >= 20) {
      lastNotifiedTime = now
      await bot.sendMessage(ALPHA_CHAT_ID,
        `🚀 <b>Price Alert — ${TOKEN_NAME} Pumping!</b>\n\n` +
        `📈 +${change1h.toFixed(1)}% in 1h\n` +
        `💰 Price: $${parseFloat(price.toString()).toExponential(2)}\n` +
        `📊 24h: ${change24h >= 0 ? '+' : ''}${change24h.toFixed(1)}%\n\n` +
        `<a href="https://dexscreener.com/base/${TOKEN_POOL}">→ View Chart</a>`,
        { parse_mode: 'HTML', message_thread_id: THREADS.trades, disable_web_page_preview: true } as any
      ).catch(console.error)
    }

    // Dump alert: -20% in 1h
    if (change1h <= -20) {
      lastNotifiedTime = now
      await bot.sendMessage(ALPHA_CHAT_ID,
        `⚠️ <b>Price Alert — ${TOKEN_NAME} Dropping</b>\n\n` +
        `📉 ${change1h.toFixed(1)}% in 1h\n` +
        `💰 Price: $${parseFloat(price.toString()).toExponential(2)}\n` +
        `📊 24h: ${change24h >= 0 ? '+' : ''}${change24h.toFixed(1)}%\n\n` +
        `<i>Stay calm. Zoom out. 🟦</i>\n` +
        `<a href="https://dexscreener.com/base/${TOKEN_POOL}">→ View Chart</a>`,
        { parse_mode: 'HTML', message_thread_id: THREADS.trades, disable_web_page_preview: true } as any
      ).catch(console.error)
    }

    lastNotifiedPrice = price
  } catch {}
}

// Check price every 10 minutes
if (featureEnabled("price_alerts")) setInterval(checkPriceAlert, 10 * 60 * 1000)

// =======================
// MINI-GAMES
// =======================

// Game 1: Builder Trivia — multiple choice A/B/C/D
interface TriviaQuestion {
  q: string
  choices: [string, string, string, string]  // A, B, C, D
  answer: 'a' | 'b' | 'c' | 'd'
  hint: string
}

const TRIVIA_QUESTIONS: TriviaQuestion[] = [
  {
    q: 'What chain is Blue Agent built on?',
    choices: ['Ethereum', 'Base', 'Solana', 'Polygon'],
    answer: 'b',
    hint: 'It\'s a Coinbase L2 🔵'
  },
  {
    q: 'What does DeFi stand for?',
    choices: ['Digital Finance', 'Decentralized Finance', 'Deferred Finance', 'Direct Finance'],
    answer: 'b',
    hint: 'Think: finance without banks'
  },
  {
    q: 'What is the Blue Agent token symbol?',
    choices: ['$BLUE', '$AGENT', '$BLUEAGENT', '$BASE'],
    answer: 'c',
    hint: 'It\'s the name of the AI 🟦'
  },
  {
    q: 'What L2 is built by Coinbase?',
    choices: ['Arbitrum', 'Optimism', 'Base', 'zkSync'],
    answer: 'c',
    hint: 'Same as the Blue Agent chain'
  },
  {
    q: 'What does NFT stand for?',
    choices: ['New Financial Token', 'Non-Fungible Token', 'Network File Transfer', 'Native Form Token'],
    answer: 'b',
    hint: 'Each one is unique'
  },
  {
    q: 'What protocol powers Blue Agent\'s LLM and trading?',
    choices: ['OpenAI', 'Anthropic', 'Bankr', 'Ollama'],
    answer: 'c',
    hint: 'Our LLM gateway partner 🤖'
  },
  {
    q: 'What chain is $BLUEAGENT deployed on?',
    choices: ['Ethereum', 'Solana', 'Base', 'Arbitrum'],
    answer: 'c',
    hint: 'Same chain as Blue Agent'
  },
  {
    q: 'How many points do you earn for a daily check-in?',
    choices: ['1 pt', '3 pts', '5 pts', '10 pts'],
    answer: 'c',
    hint: 'Enough to build a streak 🔥'
  },
  {
    q: 'What is the Blue Agent community hub?',
    choices: ['A DEX', 'A Telegram community for builders', 'A trading bot', 'A wallet'],
    answer: 'b',
    hint: 't.me/blueagent_hub 🟦'
  },
  {
    q: 'What is the minimum points needed to claim $BLUEAGENT?',
    choices: ['50 pts', '75 pts', '100 pts', '200 pts'],
    answer: 'c',
    hint: 'Check /rewards for details'
  },
]

interface TriviaSession {
  question: TriviaQuestion
  messageId: number
  startTime: number
  answered: boolean
  threadId?: number
  winners: { userId: number | undefined; username: string }[]
}

let activeTrivia: TriviaSession | null = null

async function postTriviaQuestion() {
  const q = TRIVIA_QUESTIONS[Math.floor(Math.random() * TRIVIA_QUESTIONS.length)]
  try {
    const choiceLabels = ['A', 'B', 'C', 'D']
    const choicesText = q.choices.map((c, i) => `${choiceLabels[i]}. ${c}`).join('\n')
    const correctLabel = choiceLabels[['a','b','c','d'].indexOf(q.answer)]

    // Post to General (blue-chat) — no thread so anyone can reply
    const msg = await bot.sendMessage(ALPHA_CHAT_ID,
      `🧠 <b>Builder Trivia!</b>\n\n` +
      `❓ <b>${q.q}</b>\n\n` +
      `${choicesText}\n\n` +
      `Reply <b>A</b>, <b>B</b>, <b>C</b> or <b>D</b> — first correct wins <b>+25 pts</b>! 🎯`,
      { parse_mode: 'HTML' } as any
    )
    activeTrivia = {
      question: q,
      messageId: msg.message_id,
      startTime: Date.now(),
      answered: false,
      threadId: undefined,
      winners: []
    }

    // Post hint after 60s
    setTimeout(async () => {
      if (activeTrivia && activeTrivia.winners.length === 0) {
        await bot.sendMessage(ALPHA_CHAT_ID,
          `💡 <b>Hint:</b> ${q.hint}`,
          { parse_mode: 'HTML' } as any
        ).catch(console.error)
      }
    }, 60 * 1000)

    // Reveal results after 3 min
    setTimeout(async () => {
      if (!activeTrivia) return
      const choiceLabels = ['A', 'B', 'C', 'D']
      const correctLabel = choiceLabels[['a','b','c','d'].indexOf(q.answer)]
      const correctText = q.choices[['a','b','c','d'].indexOf(q.answer)]
      const winners = activeTrivia.winners

      if (winners.length === 0) {
        await bot.sendMessage(ALPHA_CHAT_ID,
          `⏰ <b>Time's up!</b>\n\n` +
          `✅ Answer: <b>${correctLabel}. ${correctText}</b>\n\n` +
          `No one got it this time 😅`,
          { parse_mode: 'HTML' } as any
        ).catch(console.error)
      } else {
        const winnerList = winners.map((w: any, i: number) => `${i + 1}. <b>${w.username}</b>`).join('\n')
        await bot.sendMessage(ALPHA_CHAT_ID,
          `⏰ <b>Trivia Results!</b>\n\n` +
          `✅ Answer: <b>${correctLabel}. ${correctText}</b>\n\n` +
          `🏆 <b>Winners (+25 pts each):</b>\n${winnerList}`,
          { parse_mode: 'HTML' } as any
        ).catch(console.error)
      }
      activeTrivia = null
    }, 3 * 60 * 1000)

  } catch (e) { console.error('Trivia error:', e) }
}

// Check trivia answers in group
bot.on('message', async (msg) => {
  if (!activeTrivia || activeTrivia.answered) return
  if (msg.chat.id !== ALPHA_CHAT_ID) return
  const threadId = (msg as any).message_thread_id
  if (threadId && activeTrivia.threadId && threadId !== activeTrivia.threadId) return

  const text = msg.text?.toLowerCase().trim() || ''
  // Accept single letter a/b/c/d
  if (!['a', 'b', 'c', 'd'].includes(text)) return

  const correct = text === activeTrivia.question.answer
  const userId = msg.from?.id
  const username = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'Builder'

  if (!correct) {
    await bot.sendMessage(ALPHA_CHAT_ID,
      `❌ Wrong answer, ${username}! Keep trying...`,
      { parse_mode: 'HTML', reply_to_message_id: msg.message_id } as any
    ).catch(console.error)
    return
  }

  // Check if user already answered correctly
  if (activeTrivia.winners.some((w: any) => w.userId === userId)) return

  // Add to winners list (max 5)
  if (activeTrivia.winners.length < 5) {
    activeTrivia.winners.push({ userId, username })

    // Award points
    if (userId) {
      const users = loadUsers()
      if (!users[userId]) users[userId] = { id: userId, points: 0, joinedAt: Date.now() }
      users[userId].points = (users[userId].points || 0) + 25
      saveUsers(users)
    }

    // React to confirm (silent)
    await bot.sendMessage(ALPHA_CHAT_ID,
      `✅ <b>${username}</b> answered correctly! (${activeTrivia.winners.length}/5)`,
      { parse_mode: 'HTML', reply_to_message_id: msg.message_id } as any
    ).catch(console.error)
  }
})

// Game 2: /predict — simple prediction game
const predictionSessions = new Map<number, { prediction: string; userId: number; username: string }>()

bot.onText(/\/predict(?:\s+(.+))?/, async (msg) => {
  const chatId = msg.chat.id
  if (chatId !== ALPHA_CHAT_ID) return
  const text = (msg.text || "").split(" ").slice(1).join(" ").trim()
  if (!text) {
    await bot.sendMessage(chatId,
      `🔮 <b>Make a prediction!</b>\n\nUsage: /predict [your prediction]\n\nExample:\n<code>/predict ETH will hit $5K this week</code>\n\n<i>Community votes on it — winners earn pts!</i>`,
      { parse_mode: 'HTML', message_thread_id: (msg as any).message_thread_id } as any
    )
    return
  }

  const userId = msg.from?.id || 0
  const username = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'Builder'

  const sentMsg = await bot.sendMessage(chatId,
    `🔮 <b>Prediction by ${username}:</b>\n\n"${text}"\n\n` +
    `Vote: Will this happen?`,
    {
      parse_mode: 'HTML',
      message_thread_id: (msg as any).message_thread_id,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Yes', callback_data: `predict_yes_${userId}` },
          { text: '❌ No', callback_data: `predict_no_${userId}` }
        ]]
      }
    } as any
  )
})

// Trivia runs every 6h (staggered with other posts)
setTimeout(() => {
  postTriviaQuestion()
  if (featureEnabled('mini_games')) setInterval(postTriviaQuestion, 6 * 60 * 60 * 1000)
}, 3 * 60 * 60 * 1000) // start 3h after launch

console.log('🎮 Mini-games initialized')
console.log('🔔 Smart notifications initialized')

// =======================
// AI COMMUNITY MANAGER — LLM powered, real-time
// =======================

// Rate limit: 1 auto-reply per 2 minutes in group
let lastAiManagerReply = 0
const AI_MANAGER_COOLDOWN = 2 * 60 * 1000

// Community context injected into every LLM prompt
function buildCommunityContext(): string {
  const projects = loadProjects().filter(p => p.approved).slice(0, 3)
  const users = loadUsers()
  const totalUsers = Object.keys(users).length
  const topBuilders = Object.values(users)
    .sort((a: any, b: any) => (b.points || 0) - (a.points || 0))
    .slice(0, 3)
    .map((u: any) => u.telegramUsername || u.telegramName || 'Builder')

  return `
Community Context:
- Token: ${TOKEN_NAME} (${TOKEN_CONTRACT}) on Base
- Community: ${totalUsers} builders, top: ${topBuilders.join(', ')}
- Recent projects: ${projects.map(p => p.name).join(', ') || 'none yet'}
- Commands: /start (wallet), /quests, /rewards, /score, /submit, /projects, /refer, /leaderboard
- Claim: earn 100+ pts → /rewards → claim ${TOKEN_NAME}
- Points: daily check-in +5, referral +50, submit project +20
`
}

// Smart auto-reply — detect questions in group, reply with LLM
bot.on('message', async (msg) => {
  if (msg.chat.id !== ALPHA_CHAT_ID) return
  const text = msg.text?.trim() || ''
  const textLower = text.toLowerCase()
  const threadId = (msg as any).message_thread_id

  // Only respond in General (thread 1 or undefined)
  if (threadId && threadId !== 1) return

  // Skip commands, short messages, bot messages
  if (text.startsWith('/')) return
  if (text.length < 12) return
  if (msg.from?.is_bot) return

  // Skip if bot was mentioned (handled by @mention handler)
  const botUsername = BOT_USERNAME.toLowerCase()
  if (textLower.includes(`@${botUsername}`)) return

  // Rate limit
  if (Date.now() - lastAiManagerReply < AI_MANAGER_COOLDOWN) return

  // Detect question
  const isQuestion = text.includes('?') ||
    /^(how|what|where|when|why|can i|is there|do you|does|will|who|which)/i.test(text)

  if (!isQuestion) return

  // Only answer if relevant to community/project
  const isRelevant = /token|price|buy|sell|point|pts|quest|reward|claim|wallet|score|project|bot|refer|leaderboard|contract|ca|address|earn|airdrop|how to|how do/i.test(text)

  if (!isRelevant) return

  lastAiManagerReply = Date.now()

  // Show typing
  bot.sendChatAction(ALPHA_CHAT_ID, 'typing').catch(() => {})

  try {
    const context = buildCommunityContext()
    const prompt = `You are the ${PROJECT.name} community bot assistant. Answer this community question helpfully and concisely (max 3 sentences). Use the context below.

${context}

Question: ${text}

Rules:
- Be friendly and helpful
- Reference specific commands (/quests, /rewards etc) when relevant  
- Keep it short — this is a group chat
- End with an emoji relevant to the answer`

    const reply = await askLLM([{ role: 'user', content: prompt }])
    if (!reply) return

    await bot.sendMessage(ALPHA_CHAT_ID, reply, {
      parse_mode: 'HTML',
      reply_to_message_id: msg.message_id,
      message_thread_id: threadId
    } as any).catch(console.error)
  } catch (e) {
    console.error('[AI Manager] Error:', e)
  }
})

console.log('🤖 AI Community Manager initialized (LLM-powered)')


// =======================
// ANTI-SPAM / FLOOD CONTROL
// =======================

const messageCount = new Map<number, { count: number; resetAt: number; warned: boolean }>()
const SPAM_LIMIT = 5        // max messages per window
const SPAM_WINDOW = 10000   // 10 seconds
const MUTE_DURATION = 60    // mute 60 seconds

// Link pattern
const LINK_PATTERN = /https?:\/\/|t\.me\/|@\w{5,}/i

// Check if user is admin/owner in group
async function isGroupAdmin(chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await bot.getChatMember(chatId, userId)
    return ['administrator', 'creator'].includes(member.status)
  } catch {
    return false
  }
}

bot.on('message', async (msg) => {
  if (msg.chat.id !== ALPHA_CHAT_ID) return
  if (msg.from?.is_bot) return
  const userId = msg.from?.id
  if (!userId || userId === OWNER_ID) return

  // Link protection — only admins can share links
  const text = msg.text || msg.caption || ''
  if (LINK_PATTERN.test(text)) {
    const isAdmin = await isGroupAdmin(ALPHA_CHAT_ID, userId)
    if (!isAdmin) {
      try {
        await bot.deleteMessage(ALPHA_CHAT_ID, msg.message_id)
        await bot.sendMessage(ALPHA_CHAT_ID,
          `⚠️ @${msg.from?.username || msg.from?.first_name} — only admins can share links in this group.`,
          { parse_mode: 'HTML' } as any
        )
      } catch {}
      return
    }
  }

  const now = Date.now()
  const userMsg = messageCount.get(userId) || { count: 0, resetAt: now + SPAM_WINDOW, warned: false }

  // Reset window
  if (now > userMsg.resetAt) {
    userMsg.count = 0
    userMsg.resetAt = now + SPAM_WINDOW
    userMsg.warned = false
  }

  userMsg.count++
  messageCount.set(userId, userMsg)

  // Warning at limit - 1
  if (userMsg.count === SPAM_LIMIT && !userMsg.warned) {
    userMsg.warned = true
    await bot.sendMessage(ALPHA_CHAT_ID,
      `⚠️ @${msg.from?.username || msg.from?.first_name} — please slow down!`,
      { parse_mode: 'HTML', reply_to_message_id: msg.message_id } as any
    ).catch(console.error)
  }

  // Mute at limit + 2
  if (userMsg.count >= SPAM_LIMIT + 2) {
    try {
      const until = Math.floor(Date.now() / 1000) + MUTE_DURATION
      await (bot as any).restrictChatMember(ALPHA_CHAT_ID, userId, {
        permissions: { can_send_messages: false },
        until_date: until
      })
      await bot.sendMessage(ALPHA_CHAT_ID,
        `🔇 @${msg.from?.username || msg.from?.first_name} muted for ${MUTE_DURATION}s (flood detected)`,
        { parse_mode: 'HTML' } as any
      ).catch(console.error)
      messageCount.delete(userId)
    } catch {}
  }
})

console.log('🛡️ Anti-spam initialized')

// =======================
// SCHEDULED ANNOUNCEMENTS
// =======================

interface ScheduledAnnouncement {
  id: string
  text: string
  threadId?: number
  scheduledAt: number
  createdBy: number
  sent: boolean
}

const SCHEDULE_FILE = path.join(DATA_DIR, 'scheduled.json')
function loadScheduled(): ScheduledAnnouncement[] { try { return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')) } catch { return [] } }
function saveScheduled(d: ScheduledAnnouncement[]) { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(d, null, 2)) }

// Check & send scheduled announcements every minute
setInterval(async () => {
  const scheduled = loadScheduled()
  const now = Date.now()
  let updated = false

  for (const item of scheduled) {
    if (item.sent || item.scheduledAt > now) continue
    try {
      await bot.sendMessage(ALPHA_CHAT_ID, item.text, {
        parse_mode: 'HTML',
        message_thread_id: item.threadId,
        disable_web_page_preview: true
      } as any)
      item.sent = true
      updated = true
      console.log(`[Schedule] Sent: ${item.id}`)
    } catch (e) { console.error('[Schedule] Failed:', e) }
  }

  if (updated) saveScheduled(scheduled)
}, 60 * 1000)

// /schedule command — owner only
bot.onText(/\/schedule(?:\s+(.+))?/, async (msg) => {
  if (!isOwner(msg)) return
  const chatId = msg.chat.id
  const input = msg.text?.split('\n').slice(1).join('\n').trim() || ''

  if (!input) {
    await bot.sendMessage(chatId,
      `📅 <b>Schedule Announcement</b>\n\n` +
      `Format:\n<code>/schedule\n` +
      `time: 2026-03-28 09:00\n` +
      `topic: builders\n` +
      `Your announcement text here</code>\n\n` +
      `Topics: builders, alpha, trades, feed, meme\n\n` +
      `<b>Upcoming:</b>\n` +
      loadScheduled().filter(s => !s.sent).map(s =>
        `• ${new Date(s.scheduledAt).toLocaleString()} — ${s.text.slice(0, 40)}...`
      ).join('\n') || 'None scheduled',
      { parse_mode: 'HTML' } as any
    )
    return
  }

  // Parse input
  const lines = input.split('\n')
  let timeStr = '', topicStr = '', text = ''
  const textLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('time:')) timeStr = line.replace('time:', '').trim()
    else if (line.startsWith('topic:')) topicStr = line.replace('topic:', '').trim()
    else textLines.push(line)
  }
  text = textLines.join('\n').trim()

  if (!timeStr || !text) {
    await bot.sendMessage(chatId, '❌ Need: time: and message text')
    return
  }

  const scheduledAt = new Date(timeStr).getTime()
  if (isNaN(scheduledAt)) {
    await bot.sendMessage(chatId, '❌ Invalid time format. Use: 2026-03-28 09:00')
    return
  }

  const threadId = topicStr ? (THREADS as any)[topicStr] : undefined
  const id = `sched_${Date.now()}`
  const scheduled = loadScheduled()
  scheduled.push({ id, text, threadId, scheduledAt, createdBy: msg.from?.id || 0, sent: false })
  saveScheduled(scheduled)

  await bot.sendMessage(chatId,
    `✅ <b>Scheduled!</b>\n\n` +
    `📅 ${new Date(scheduledAt).toLocaleString()}\n` +
    `📍 Topic: ${topicStr || 'General'}\n\n` +
    `${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`,
    { parse_mode: 'HTML' } as any
  )
})

// /unschedule <id>
bot.onText(/\/unschedule(?:\s+(\S+))?/, async (msg, match) => {
  if (!isOwner(msg)) return
  const id = match?.[1]?.trim()
  if (!id) { await bot.sendMessage(msg.chat.id, 'Usage: /unschedule <id>'); return }
  const scheduled = loadScheduled()
  const idx = scheduled.findIndex(s => s.id === id)
  if (idx === -1) { await bot.sendMessage(msg.chat.id, '❌ Not found'); return }
  scheduled.splice(idx, 1)
  saveScheduled(scheduled)
  await bot.sendMessage(msg.chat.id, '✅ Removed from schedule')
})

console.log('📅 Scheduled announcements initialized')

// =======================
// RAFFLE / GIVEAWAY
// =======================

interface Raffle {
  id: string
  title: string
  prize: string
  pts: number           // pts reward for winner
  endAt: number
  participants: number[]
  winners: number[]
  announced: boolean
  createdBy: number
  threadId?: number
}

const RAFFLE_FILE = path.join(DATA_DIR, 'raffles.json')
function loadRaffles(): Raffle[] { try { return JSON.parse(fs.readFileSync(RAFFLE_FILE, 'utf8')) } catch { return [] } }
function saveRaffles(d: Raffle[]) { fs.writeFileSync(RAFFLE_FILE, JSON.stringify(d, null, 2)) }

// /raffle command — owner creates raffle
bot.onText(/\/raffle(?:\s+(.+))?/, async (msg) => {
  if (!isOwner(msg)) return
  const chatId = msg.chat.id
  const input = msg.text?.split('\n').slice(1).join('\n').trim() || ''

  if (!input) {
    const active = loadRaffles().filter(r => !r.announced && Date.now() < r.endAt)
    await bot.sendMessage(chatId,
      `🎁 <b>Raffle Manager</b>\n\n` +
      `Format:\n<code>/raffle\n` +
      `title: Win 500 $BLUEAGENT!\n` +
      `prize: 500 $BLUEAGENT\n` +
      `pts: 500\n` +
      `hours: 24\n` +
      `winners: 1\n` +
      `topic: builders</code>\n\n` +
      `<b>Active raffles:</b> ${active.length}`,
      { parse_mode: 'HTML' } as any
    )
    return
  }

  const lines = input.split('\n')
  let title = '', prize = '', pts = 100, hours = 24, winnersCount = 1, topicStr = ''

  for (const line of lines) {
    if (line.startsWith('title:')) title = line.replace('title:', '').trim()
    else if (line.startsWith('prize:')) prize = line.replace('prize:', '').trim()
    else if (line.startsWith('pts:')) pts = parseInt(line.replace('pts:', '').trim()) || 100
    else if (line.startsWith('hours:')) hours = parseInt(line.replace('hours:', '').trim()) || 24
    else if (line.startsWith('winners:')) winnersCount = parseInt(line.replace('winners:', '').trim()) || 1
    else if (line.startsWith('topic:')) topicStr = line.replace('topic:', '').trim()
  }

  if (!title || !prize) { await bot.sendMessage(chatId, '❌ Need: title: and prize:'); return }

  const endAt = Date.now() + hours * 60 * 60 * 1000
  const threadId = topicStr ? (THREADS as any)[topicStr] : THREADS.builders
  const raffle: Raffle = {
    id: `raffle_${Date.now()}`,
    title, prize, pts,
    endAt,
    participants: [],
    winners: [],
    announced: false,
    createdBy: msg.from?.id || 0,
    threadId
  }

  const raffles = loadRaffles()
  raffles.push(raffle)
  saveRaffles(raffles)

  // Announce in group
  await bot.sendMessage(ALPHA_CHAT_ID,
    `🎁 <b>GIVEAWAY!</b>\n\n` +
    `<b>${title}</b>\n` +
    `🏆 Prize: <b>${prize}</b>\n` +
    `⭐ Also: +${pts} pts to winner(s)\n` +
    `⏰ Ends: ${new Date(endAt).toLocaleString()}\n\n` +
    `👇 <b>Click to enter!</b>`,
    {
      parse_mode: 'HTML',
      message_thread_id: threadId,
      reply_markup: { inline_keyboard: [[{ text: '🎟️ Enter Raffle!', callback_data: `raffle_enter_${raffle.id}` }]] }
    } as any
  ).catch(console.error)

  await bot.sendMessage(chatId, `✅ Raffle created! ID: <code>${raffle.id}</code>`, { parse_mode: 'HTML' } as any)
})

// Handle raffle entry
bot.on('callback_query', async (query) => {
  const data = query.data || ''
  const chatId = query.message?.chat.id
  const userId = query.from?.id
  if (!chatId || !userId) return

  if (data.startsWith('raffle_enter_')) {
    const raffleId = data.replace('raffle_enter_', '')
    const raffles = loadRaffles()
    const idx = raffles.findIndex(r => r.id === raffleId)

    if (idx === -1) { await bot.answerCallbackQuery(query.id, { text: '❌ Raffle not found', show_alert: true }); return }
    const raffle = raffles[idx]

    if (Date.now() > raffle.endAt) { await bot.answerCallbackQuery(query.id, { text: '⏰ Raffle has ended!', show_alert: true }); return }
    if (raffle.participants.includes(userId)) { await bot.answerCallbackQuery(query.id, { text: `✅ You're already entered! (${raffle.participants.length} total)`, show_alert: true }); return }

    raffles[idx].participants.push(userId)
    saveRaffles(raffles)

    await bot.answerCallbackQuery(query.id, { text: `🎟️ Entered! ${raffles[idx].participants.length} participants so far`, show_alert: true })
    return
  }

  await bot.answerCallbackQuery(query.id).catch(() => {})
})

// Draw raffle winners — check every minute
setInterval(async () => {
  const raffles = loadRaffles()
  const now = Date.now()
  let updated = false

  for (const raffle of raffles) {
    if (raffle.announced || now < raffle.endAt) continue
    if (raffle.participants.length === 0) {
      raffle.announced = true
      updated = true
      await bot.sendMessage(ALPHA_CHAT_ID,
        `🎁 Raffle ended with no participants: <b>${raffle.title}</b>`,
        { parse_mode: 'HTML', message_thread_id: raffle.threadId } as any
      ).catch(console.error)
      continue
    }

    // Draw winners
    const shuffled = [...raffle.participants].sort(() => Math.random() - 0.5)
    const winnerIds = shuffled.slice(0, Math.min(1, raffle.participants.length))
    raffle.winners = winnerIds
    raffle.announced = true
    updated = true

    // Award pts to winners
    const users = loadUsers()
    const winnerTags: string[] = []
    for (const wId of winnerIds) {
      if (users[wId]) {
        users[wId].points = (users[wId].points || 0) + raffle.pts
        winnerTags.push(users[wId].telegramUsername ? `@${users[wId].telegramUsername}` : `User ${wId}`)
        // DM winner
        bot.sendMessage(wId,
          `🎉 <b>You won the raffle!</b>\n\n` +
          `<b>${raffle.title}</b>\n` +
          `🏆 Prize: ${raffle.prize}\n` +
          `⭐ +${raffle.pts} pts added!\n\n` +
          `Contact admin to claim your prize 🟦`,
          { parse_mode: 'HTML' } as any
        ).catch(console.error)
      }
    }
    saveUsers(users)

    await bot.sendMessage(ALPHA_CHAT_ID,
      `🎉 <b>Raffle Results!</b>\n\n` +
      `<b>${raffle.title}</b>\n` +
      `🏆 Prize: ${raffle.prize}\n\n` +
      `🥇 Winner${winnerIds.length > 1 ? 's' : ''}: ${winnerTags.join(', ')}\n` +
      `⭐ +${raffle.pts} pts awarded!\n\n` +
      `(${raffle.participants.length} participants total)`,
      { parse_mode: 'HTML', message_thread_id: raffle.threadId } as any
    ).catch(console.error)
  }

  if (updated) saveRaffles(raffles)
}, 60 * 1000)

console.log('🎁 Raffle system initialized')


// =======================
// BROADCAST DM — Pro feature
// =======================
bot.onText(/\/broadcast(?:\s+(.+))?/, async (msg) => {
  if (!isOwner(msg)) return
  if (!featureEnabled('broadcast_dm')) {
    await bot.sendMessage(msg.chat.id, upgradeMsg('broadcast_dm'), { parse_mode: 'HTML' } as any)
    return
  }
  const chatId = msg.chat.id
  const text = msg.text?.split('\n').slice(1).join('\n').trim()

  if (!text) {
    await bot.sendMessage(chatId,
      `📣 <b>Broadcast DM</b>\n\nFormat:\n<code>/broadcast\nYour message here\n\nCan be multi-line!</code>\n\n⚠️ Will DM all users who have interacted with the bot.`,
      { parse_mode: 'HTML' } as any
    )
    return
  }

  // Confirm first
  await bot.sendMessage(chatId,
    `📣 <b>Confirm Broadcast</b>\n\n${text}\n\n──────────────\nSend to all users?`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Send to all', callback_data: `broadcast_confirm_${Buffer.from(text).toString('base64').slice(0, 50)}` },
        { text: '❌ Cancel', callback_data: 'broadcast_cancel' }
      ]]}
    } as any
  )
})

// Store pending broadcast
const pendingBroadcasts = new Map<string, string>()

bot.on('callback_query', async (query) => {
  const data = query.data || ''
  const chatId = query.message?.chat.id
  const userId = query.from?.id
  if (!chatId || !userId) return

  if (data === 'broadcast_cancel') {
    await bot.editMessageText('❌ Broadcast cancelled', { chat_id: chatId, message_id: query.message?.message_id } as any)
    await bot.answerCallbackQuery(query.id)
    return
  }

  if (data.startsWith('broadcast_confirm_')) {
    const key = data.replace('broadcast_confirm_', '')
    const text = pendingBroadcasts.get(key) || ''
    await bot.answerCallbackQuery(query.id, { text: '📤 Sending...' })

    const users = loadUsers()
    const userIds = Object.keys(users)
    let sent = 0, failed = 0

    await bot.editMessageText(`📤 Broadcasting to ${userIds.length} users...`, { chat_id: chatId, message_id: query.message?.message_id } as any).catch(() => {})

    for (const uid of userIds) {
      try {
        await bot.sendMessage(parseInt(uid), `📣 <b>Announcement from ${PROJECT.name}</b>\n\n${text}`, { parse_mode: 'HTML' } as any)
        sent++
        await new Promise(r => setTimeout(r, 50)) // rate limit
      } catch { failed++ }
    }

    await bot.sendMessage(chatId, `✅ <b>Broadcast complete</b>\n\n✉️ Sent: ${sent}\n❌ Failed: ${failed}`, { parse_mode: 'HTML' } as any)
    return
  }
  await bot.answerCallbackQuery(query.id).catch(() => {})
})

// =======================
// PROPOSAL VOTING — Growth feature
// =======================
interface Proposal {
  id: string
  title: string
  description: string
  options: string[]
  votes: Record<string, number>  // userId → option index
  endAt: number
  createdBy: number
  announced: boolean
  threadId?: number
}

const PROPOSAL_FILE = path.join(DATA_DIR, 'proposals.json')
function loadProposals(): Proposal[] { try { return JSON.parse(fs.readFileSync(PROPOSAL_FILE, 'utf8')) } catch { return [] } }
function saveProposals(d: Proposal[]) { fs.writeFileSync(PROPOSAL_FILE, JSON.stringify(d, null, 2)) }

bot.onText(/\/propose(?:\s+(.+))?/, async (msg) => {
  if (!isOwner(msg)) return
  if (!featureEnabled('proposal_voting')) {
    await bot.sendMessage(msg.chat.id, upgradeMsg('proposal_voting'), { parse_mode: 'HTML' } as any)
    return
  }
  const chatId = msg.chat.id
  const input = msg.text?.split('\n').slice(1).join('\n').trim() || ''

  if (!input) {
    await bot.sendMessage(chatId,
      `🗳️ <b>Create Proposal</b>\n\nFormat:\n<code>/propose\ntitle: Should we launch v2?\ndescription: We have 2 options for the next release\noption: Option A — Focus on UX\noption: Option B — Focus on performance\nhours: 48\ntopic: builders</code>`,
      { parse_mode: 'HTML' } as any
    )
    return
  }

  const lines = input.split('\n')
  let title = '', description = '', hours = 48, topicStr = ''
  const options: string[] = []

  for (const line of lines) {
    if (line.startsWith('title:')) title = line.replace('title:', '').trim()
    else if (line.startsWith('description:')) description = line.replace('description:', '').trim()
    else if (line.startsWith('option:')) options.push(line.replace('option:', '').trim())
    else if (line.startsWith('hours:')) hours = parseInt(line.replace('hours:', '').trim()) || 48
    else if (line.startsWith('topic:')) topicStr = line.replace('topic:', '').trim()
  }

  if (!title || options.length < 2) {
    await bot.sendMessage(chatId, '❌ Need: title: and at least 2 option:')
    return
  }

  const endAt = Date.now() + hours * 60 * 60 * 1000
  const threadId = topicStr ? (THREADS as any)[topicStr] : THREADS.builders
  const proposal: Proposal = {
    id: `prop_${Date.now()}`,
    title, description, options,
    votes: {},
    endAt, announced: false,
    createdBy: msg.from?.id || 0,
    threadId
  }

  const proposals = loadProposals()
  proposals.push(proposal)
  saveProposals(proposals)

  // Post to group
  const optionButtons = options.map((opt, i) => ([{ text: `${['🅰️','🅱️','🅲️','🅳️'][i] || `${i+1}.`} ${opt}`, callback_data: `vote_prop_${proposal.id}_${i}` }]))

  await bot.sendMessage(ALPHA_CHAT_ID,
    `🗳️ <b>Community Proposal</b>\n\n` +
    `<b>${title}</b>\n${description ? description + '\n' : ''}\n` +
    `${options.map((o, i) => `${['🅰️','🅱️','🅲️','🅳️'][i] || `${i+1}.`} ${o}`).join('\n')}\n\n` +
    `⏰ Voting ends: ${new Date(endAt).toLocaleString()}\n` +
    `⭐ +5 pts for voting!`,
    {
      parse_mode: 'HTML',
      message_thread_id: threadId,
      reply_markup: { inline_keyboard: [...optionButtons, [{ text: '📊 Results', callback_data: `prop_results_${proposal.id}` }]] }
    } as any
  ).catch(console.error)

  await bot.sendMessage(chatId, `✅ Proposal created! ID: <code>${proposal.id}</code>`, { parse_mode: 'HTML' } as any)
})

// Handle proposal votes
bot.on('callback_query', async (query) => {
  const data = query.data || ''
  const chatId = query.message?.chat.id
  const userId = query.from?.id
  if (!chatId || !userId) return

  if (data.startsWith('vote_prop_')) {
    const parts = data.replace('vote_prop_', '').split('_')
    const optIdx = parseInt(parts.pop() || '0')
    const propId = parts.join('_')

    const proposals = loadProposals()
    const idx = proposals.findIndex(p => p.id === propId)
    if (idx === -1) { await bot.answerCallbackQuery(query.id, { text: '❌ Proposal not found', show_alert: true }); return }

    const prop = proposals[idx]
    if (Date.now() > prop.endAt) { await bot.answerCallbackQuery(query.id, { text: '⏰ Voting has ended!', show_alert: true }); return }

    const alreadyVoted = String(userId) in prop.votes
    proposals[idx].votes[String(userId)] = optIdx
    saveProposals(proposals)

    // Award pts for first vote
    if (!alreadyVoted) {
      autoCompleteQuest(userId, 'daily_vote', undefined)
      const users = loadUsers()
      if (users[userId]) { users[userId].points = (users[userId].points || 0) + 5; saveUsers(users) }
    }

    const choice = prop.options[optIdx]
    const total = Object.keys(prop.votes).length
    await bot.answerCallbackQuery(query.id, { text: `✅ Voted: ${choice}\n${total} votes total`, show_alert: true })
    return
  }

  if (data.startsWith('prop_results_')) {
    const propId = data.replace('prop_results_', '')
    const proposals = loadProposals()
    const prop = proposals.find(p => p.id === propId)
    if (!prop) { await bot.answerCallbackQuery(query.id, { text: '❌ Not found', show_alert: true }); return }

    const total = Object.keys(prop.votes).length
    const counts = prop.options.map((_, i) => Object.values(prop.votes).filter(v => v === i).length)
    const results = prop.options.map((opt, i) => {
      const pct = total ? Math.round(counts[i] / total * 100) : 0
      const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10))
      return `${['🅰️','🅱️','🅲️','🅳️'][i] || `${i+1}.`} ${opt}\n${bar} ${pct}% (${counts[i]})`
    }).join('\n\n')

    await bot.answerCallbackQuery(query.id)
    await bot.sendMessage(chatId,
      `📊 <b>${prop.title} — Results</b>\n\n${results}\n\n👥 Total votes: ${total}`,
      { parse_mode: 'HTML', message_thread_id: (query.message as any)?.message_thread_id } as any
    ).catch(console.error)
    return
  }

  await bot.answerCallbackQuery(query.id).catch(() => {})
})

console.log('🗳️ Proposal voting initialized')
console.log('📣 Broadcast DM initialized')

// =======================
// USDC PAYMENT — Subscription tracking
// =======================
interface Subscription {
  userId?: number
  projectName: string
  tier: string
  address: string      // buyer's wallet
  amount: number       // USDC amount
  txHash?: string
  startAt: number
  expiresAt: number
  active: boolean
}

const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json')
function loadSubs(): Subscription[] { try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')) } catch { return [] } }
function saveSubs(d: Subscription[]) { fs.writeFileSync(SUBS_FILE, JSON.stringify(d, null, 2)) }

// Payment wallet (treasury)
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS || '0xf31f59e7b8b58555f7871f71973a394c8f1bffe5'

// Tier pricing in USDC
const TIER_PRICE: Record<string, number> = {
  seed:  49,
  pro:   199,
  scale: 499
}

// Multi-month discount
const MONTH_DISCOUNT: Record<number, number> = { 1: 0, 3: 0.10, 6: 0.15, 12: 0.20 }
const BLUEAGENT_DISCOUNT = 0.20

function calcPrice(tier: string, months: number, currency: 'usdc' | 'blueagent' = 'usdc'): number {
  const base = TIER_PRICE[tier] || 0
  const discount = MONTH_DISCOUNT[months] || 0
  const total = base * months * (1 - discount)
  if (currency === 'blueagent') return Math.round(total * (1 - BLUEAGENT_DISCOUNT) * 100) / 100
  return Math.round(total * 100) / 100
}

const subSessions = new Map<number, { tier: string; months: number; currency: 'usdc' | 'blueagent'; step: string }>()

// =======================
// PORTFOLIO
// =======================
bot.onText(/\/portfolio/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id || chatId
  const users = loadUsers()
  const user = users[userId]
  const addr = user?.evmAddress

  if (!addr) {
    await bot.sendMessage(chatId, '⚠️ No wallet found. Type /start to create one.')
    return
  }

  await bot.sendChatAction(chatId, 'typing')

  // Use Bankr Agent — same as "my portfolio" prompt
  const agentPrompt = `Check portfolio and token balances for wallet address ${addr} on Base chain. Do NOT use any other wallet. Wallet: ${addr}`
  const result = await askBankrAgent(agentPrompt, 20)
  if (result) {
    await bot.sendMessage(chatId, formatAgentReply(result), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Swap', callback_data: 'trade_swap' }, { text: '💰 Buy $BLUEAGENT', callback_data: 'trade_buy_blueagent' }],
          [{ text: '📤 Send', callback_data: 'trade_send' }, { text: '🌉 Bridge', callback_data: 'trade_bridge' }],
        ]
      }
    } as any)
  } else {
    await bot.sendMessage(chatId, '⚠️ Could not fetch portfolio. Try again.')
  }
})

// =======================
// PRICE ALERT
// =======================
interface PriceAlert { userId: number; chatId: number; targetPrice: number; direction: 'above' | 'below'; createdAt: number }
const priceAlerts: PriceAlert[] = []

bot.onText(/\/alert(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id || chatId
  const input = match?.[1]?.trim()

  if (!input) {
    await bot.sendMessage(chatId,
      `<b>⏰ Price Alert</b>\n\n` +
      `Set an alert when $BLUEAGENT reaches a target price.\n\n` +
      `<b>Usage:</b>\n` +
      `<code>/alert 0.000001</code> — alert when price hits this\n\n` +
      `<b>Active alerts:</b> ${priceAlerts.filter(a => a.userId === userId).length}`,
      { parse_mode: 'HTML' } as any
    )
    return
  }

  const targetPrice = parseFloat(input)
  if (isNaN(targetPrice) || targetPrice <= 0) {
    await bot.sendMessage(chatId, '❌ Invalid price. Example: <code>/alert 0.000001</code>', { parse_mode: 'HTML' } as any)
    return
  }

  // Get current price to determine direction
  let currentPrice = 0
  try {
    const res = await axios.get(`https://api.geckoterminal.com/api/v2/networks/base/pools/${TOKEN_POOL}`, { timeout: 6000 })
    currentPrice = parseFloat(res.data?.data?.attributes?.base_token_price_usd || '0')
  } catch {}

  const direction: 'above' | 'below' = targetPrice > currentPrice ? 'above' : 'below'
  priceAlerts.push({ userId, chatId, targetPrice, direction, createdAt: Date.now() })

  const dirText = direction === 'above' ? '📈 rises above' : '📉 drops below'
  await bot.sendMessage(chatId,
    `✅ <b>Alert set!</b>\n\n` +
    `I'll notify you when $BLUEAGENT ${dirText}\n` +
    `<b>$${targetPrice.toFixed(10).replace(/0+$/, '')}</b>\n\n` +
    `Current price: $${currentPrice.toFixed(10).replace(/0+$/, '')}\n` +
    `<i>Alert stays active until triggered.</i>`,
    { parse_mode: 'HTML' } as any
  )
})

// Price alert checker — runs every 2 minutes
setInterval(async () => {
  if (priceAlerts.length === 0) return
  try {
    const res = await axios.get(`https://api.geckoterminal.com/api/v2/networks/base/pools/${TOKEN_POOL}`, { timeout: 6000 })
    const currentPrice = parseFloat(res.data?.data?.attributes?.base_token_price_usd || '0')
    if (currentPrice === 0) return

    const triggered: number[] = []
    for (let i = 0; i < priceAlerts.length; i++) {
      const alert = priceAlerts[i]
      const hit = alert.direction === 'above'
        ? currentPrice >= alert.targetPrice
        : currentPrice <= alert.targetPrice

      if (hit) {
        const dirText = alert.direction === 'above' ? '📈 risen above' : '📉 dropped below'
        await bot.sendMessage(alert.chatId,
          `🔔 <b>Price Alert Triggered!</b>\n\n` +
          `$BLUEAGENT has ${dirText} your target!\n\n` +
          `🎯 Target: $${alert.targetPrice.toFixed(10).replace(/0+$/, '')}\n` +
          `💰 Current: $${currentPrice.toFixed(10).replace(/0+$/, '')}\n\n` +
          `<i>Use /wallet to trade now</i>`,
          { parse_mode: 'HTML' } as any
        ).catch(console.error)
        triggered.push(i)
      }
    }
    // Remove triggered alerts (reverse order)
    for (let i = triggered.length - 1; i >= 0; i--) {
      priceAlerts.splice(triggered[i], 1)
    }
  } catch {}
}, 2 * 60 * 1000)

// =======================
// TRADE BUTTON HANDLERS
// =======================

bot.on('callback_query', async (query) => {
  const data = query.data || ''
  const chatId = query.message?.chat.id
  const userId = query.from.id
  if (!chatId) return

  if (data === 'trade_swap') {
    await bot.answerCallbackQuery(query.id)
    await bot.sendMessage(chatId,
      `🔄 <b>Swap Tokens</b>\n\nJust type what you want to swap:\n\n` +
      `• <code>swap 10 USDC to ETH</code>\n` +
      `• <code>swap 0.01 ETH to USDC</code>\n` +
      `• <code>swap 100 USDC to $BLUEAGENT</code>`,
      { parse_mode: 'HTML' } as any
    )
    return
  }

  if (data === 'trade_buy_blueagent') {
    await bot.answerCallbackQuery(query.id)
    await bot.sendMessage(chatId,
      `💰 <b>Buy $BLUEAGENT</b>\n\nJust type:\n\n` +
      `• <code>buy $BLUEAGENT with 10 USDC</code>\n` +
      `• <code>buy $BLUEAGENT with 0.005 ETH</code>\n\n` +
      `Contract: <code>${TOKEN_CONTRACT}</code>\n` +
      `Chain: Base · Uniswap v4`,
      { parse_mode: 'HTML' } as any
    )
    return
  }

  if (data === 'trade_perps') {
    await bot.answerCallbackQuery(query.id)
    await bot.sendMessage(chatId,
      `🔱 <b>Hyperliquid Perps</b>\n\nJust type:\n\n` +
      `• <code>long $100 BTC on hyperliquid</code>\n` +
      `• <code>short ETH 10x on hyperliquid</code>\n` +
      `• <code>show my hyperliquid positions</code>\n` +
      `• <code>close all hyperliquid positions</code>`,
      { parse_mode: 'HTML' } as any
    )
    return
  }

  if (data === 'trade_send') {
    await bot.answerCallbackQuery(query.id)
    await bot.sendMessage(chatId,
      `📤 <b>Send Tokens</b>\n\nJust type:\n\n` +
      `• <code>send 5 USDC to 0x...</code>\n` +
      `• <code>send 0.01 ETH to 0x...</code>\n` +
      `• <code>send 1000 $BLUEAGENT to 0x...</code>`,
      { parse_mode: 'HTML' } as any
    )
    return
  }

  if (data === 'trade_bridge') {
    await bot.answerCallbackQuery(query.id)
    await bot.sendMessage(chatId,
      `🌉 <b>Bridge Tokens</b>\n\nJust type:\n\n` +
      `• <code>bridge 0.01 ETH to Polygon</code>\n` +
      `• <code>bridge 10 USDC to Arbitrum</code>\n` +
      `• <code>bridge 0.005 ETH to Base</code>`,
      { parse_mode: 'HTML' } as any
    )
    return
  }

  if (data === 'trade_alert') {
    await bot.answerCallbackQuery(query.id)
    await bot.sendMessage(chatId,
      `⏰ <b>Price Alert</b>\n\nSet an alert for $BLUEAGENT:\n\n` +
      `<code>/alert 0.000001</code>\n\n` +
      `I'll DM you when price hits your target 🔔`,
      { parse_mode: 'HTML' } as any
    )
    return
  }
})

bot.onText(/\/pricing/, async (msg) => {
  const chatId = msg.chat.id
  await bot.sendMessage(chatId,
    `💳 <b>Community Kit — Pricing</b>\n\n` +
    `🆓 <b>Free</b> — $0\nPoints, Leaderboard, Referrals, Onboarding, Projects\n\n` +
    `🌱 <b>Seed</b> — $49/month\n+ Price Alerts, Gem Signals, Raffle, Scheduled Posts\n\n` +
    `⚡ <b>Pro</b> — $199/month\n+ Token Claim, Broadcast DM, Flash Quests, Bounties, Proposals\n\n` +
    `🚀 <b>Scale</b> — $499/month\n+ Analytics Export, Token Gate, Custom Branding\n\n` +
    `──────────────\n` +
    `💰 Pay <b>USDC</b> or <b>$BLUEAGENT</b> (-20%) on Base\n` +
    `📊 Multi-month: 3mo -10% | 6mo -15% | 12mo -20%\n\n` +
    `<i>Use /subscribe to get started</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '💳 Subscribe Now', callback_data: 'start_subscribe' }],
        [{ text: '🌐 blueagent.xyz/community-kit', url: 'https://blueagent.xyz/community-kit' }]
      ]}
    } as any
  )
})

// /subscribe — self-service payment flow
bot.onText(/\/subscribe/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id || chatId
  if (msg.chat.type !== 'private') {
    await bot.sendMessage(chatId, '🔒 Please DM me to subscribe: @' + BOT_USERNAME)
    return
  }
  subSessions.set(userId, { tier: '', months: 1, currency: 'usdc', step: 'tier' })
  await bot.sendMessage(chatId,
    `💳 <b>Community Kit — Subscribe</b>\n\nChoose your plan:`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [{ text: '🌱 Seed — $49/mo', callback_data: 'sub_tier_seed' }],
      [{ text: '⚡ Pro — $199/mo', callback_data: 'sub_tier_pro' }],
      [{ text: '🚀 Scale — $499/mo', callback_data: 'sub_tier_scale' }],
      [{ text: '💰 View pricing details', callback_data: 'sub_pricing' }]
    ]}} as any
  )
})

// /subscribe_admin — owner manually records
bot.onText(/\/subscribe_admin(?:\s+(.+))?/, async (msg) => {
  if (!isOwner(msg)) return
  const chatId = msg.chat.id
  const input = msg.text?.split('\n').slice(1).join('\n').trim() || ''
  if (!input) {
    await bot.sendMessage(chatId,
      `💳 <b>Record Subscription (Admin)</b>\n\nFormat:\n<code>/subscribe_admin\nproject: My Project\ntier: seed\nmonths: 3\naddress: 0x...\ntx: 0x...\n</code>`,
      { parse_mode: 'HTML' } as any)
    return
  }
  const lines = input.split('\n')
  let project = '', tier = '', address = '', tx = '', months = 1
  for (const line of lines) {
    if (line.startsWith('project:')) project = line.replace('project:', '').trim()
    else if (line.startsWith('tier:')) tier = line.replace('tier:', '').trim().toLowerCase()
    else if (line.startsWith('months:')) months = parseInt(line.replace('months:', '').trim()) || 1
    else if (line.startsWith('address:')) address = line.replace('address:', '').trim()
    else if (line.startsWith('tx:')) tx = line.replace('tx:', '').trim()
  }
  if (!project || !tier || !address) { await bot.sendMessage(chatId, '❌ Need: project, tier, address'); return }
  if (!TIER_PRICE[tier]) { await bot.sendMessage(chatId, `❌ Invalid tier: ${Object.keys(TIER_PRICE).join(', ')}`); return }
  const amount = calcPrice(tier, months)
  const sub: Subscription = { userId: undefined, projectName: project, tier, address, txHash: tx||undefined, amount, startAt: Date.now(), expiresAt: Date.now() + months*30*24*60*60*1000, active: true }
  const subs = loadSubs(); subs.push(sub); saveSubs(subs)
  await bot.sendMessage(chatId, `✅ Recorded: ${project} | ${tier} | ${months}mo | $${amount}${tx?`\nTX: <code>${tx.slice(0,20)}...</code>`:''}`, { parse_mode: 'HTML' } as any)
})

// /subs — list subscriptions
bot.onText(/\/subs/, async (msg) => {
  if (!isOwner(msg)) return
  const subs = loadSubs()
  if (!subs.length) { await bot.sendMessage(msg.chat.id, '📭 No subscriptions yet'); return }

  const lines = subs.map(s => {
    const status = s.active && Date.now() < s.expiresAt ? '✅' : '❌'
    const expires = new Date(s.expiresAt).toLocaleDateString()
    return `${status} <b>${s.projectName}</b> — ${s.tier} · expires ${expires}`
  })

  await bot.sendMessage(msg.chat.id,
    `💳 <b>Subscriptions (${subs.length})</b>\n\n` + lines.join('\n'),
    { parse_mode: 'HTML' } as any
  )
})

console.log('💳 USDC Payment & subscription tracking initialized')

// =======================
// SUBSCRIPTION CALLBACKS
// =======================
bot.on('callback_query', async (query) => {
  const data = query.data || ''
  if (!data.startsWith('sub_')) return
  const chatId = query.message?.chat.id
  const msgId = query.message?.message_id
  const userId = query.from.id
  if (!chatId) return
  await bot.answerCallbackQuery(query.id)
  const session = subSessions.get(userId) || { tier: '', months: 1, currency: 'usdc' as const, step: 'tier' }

  if (data === 'start_subscribe') {
    subSessions.set(userId, { tier: '', months: 1, currency: 'usdc', step: 'tier' })
    await bot.sendMessage(chatId,
      `💳 <b>Community Kit — Subscribe</b>\n\nChoose your plan:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [{ text: '🌱 Seed — $49/mo', callback_data: 'sub_tier_seed' }],
        [{ text: '⚡ Pro — $199/mo', callback_data: 'sub_tier_pro' }],
        [{ text: '🚀 Scale — $499/mo', callback_data: 'sub_tier_scale' }]
      ]}} as any)
    return
  }

  if (data.startsWith('sub_tier_')) {
    const tier = data.replace('sub_tier_', '')
    session.tier = tier; session.step = 'months'; subSessions.set(userId, session)
    const p1=calcPrice(tier,1), p3=calcPrice(tier,3), p6=calcPrice(tier,6), p12=calcPrice(tier,12)
    await bot.editMessageText(
      `📅 <b>Choose duration</b> (${tier.toUpperCase()})\n\n1 month — <b>$${p1}</b>\n3 months — <b>$${p3}</b> <i>(-10%)</i>\n6 months — <b>$${p6}</b> <i>(-15%)</i>\n12 months — <b>$${p12}</b> <i>(-20%)</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [{ text: `1 month — $${p1}`, callback_data: 'sub_months_1' }, { text: `3 months — $${p3}`, callback_data: 'sub_months_3' }],
        [{ text: `6 months — $${p6}`, callback_data: 'sub_months_6' }, { text: `12 months — $${p12}`, callback_data: 'sub_months_12' }],
        [{ text: '← Back', callback_data: 'sub_back_tier' }]
      ]}} as any)
  }
  else if (data === 'sub_back_tier') {
    session.step = 'tier'; subSessions.set(userId, session)
    await bot.editMessageText(`💳 <b>Community Kit — Subscribe</b>\n\nChoose your plan:`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [{ text: '🌱 Seed — $49/mo', callback_data: 'sub_tier_seed' }],
        [{ text: '⚡ Pro — $199/mo', callback_data: 'sub_tier_pro' }],
        [{ text: '🚀 Scale — $499/mo', callback_data: 'sub_tier_scale' }]
      ]}} as any)
  }
  else if (data.startsWith('sub_months_')) {
    const months = parseInt(data.replace('sub_months_', ''))
    session.months = months; session.step = 'currency'; subSessions.set(userId, session)
    const uAmt=calcPrice(session.tier,months,'usdc'), bAmt=calcPrice(session.tier,months,'blueagent')
    await bot.editMessageText(
      `💰 <b>Choose payment</b>\n\nPlan: <b>${session.tier.toUpperCase()}</b> · ${months} month${months>1?'s':''}\n\n💵 USDC — <b>$${uAmt}</b>\n🟦 $BLUEAGENT — <b>$${bAmt}</b> <i>(-20%)</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [{ text: `💵 Pay $${uAmt} USDC`, callback_data: 'sub_pay_usdc' }],
        [{ text: `🟦 Pay $${bAmt} $BLUEAGENT (-20%)`, callback_data: 'sub_pay_blueagent' }],
        [{ text: '← Back', callback_data: `sub_tier_${session.tier}` }]
      ]}} as any)
  }
  else if (data.startsWith('sub_pay_')) {
    const currency = data.replace('sub_pay_', '') as 'usdc' | 'blueagent'
    session.currency = currency; session.step = 'awaiting_tx'; subSessions.set(userId, session)
    const amount = calcPrice(session.tier, session.months, currency)
    const isBA = currency === 'blueagent'
    const tokenAddr = isBA ? TOKEN_CONTRACT : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    const tokenName = isBA ? '$BLUEAGENT' : 'USDC'
    await bot.editMessageText(
      `💳 <b>Payment Instructions</b>\n\nPlan: <b>${session.tier.toUpperCase()}</b> · ${session.months} month${session.months>1?'s':''}\nAmount: <b>$${amount} ${tokenName}</b>\n\nSend to treasury on <b>Base</b>:\n<code>${PAYMENT_ADDRESS}</code>\n\nToken: <code>${tokenAddr}</code>\n\n⚠️ After sending, paste your <b>tx hash</b> (0x...) here.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [{ text: '🔗 View treasury on Basescan', url: `https://basescan.org/address/${PAYMENT_ADDRESS}` }],
        [{ text: '← Back', callback_data: `sub_months_${session.months}` }]
      ]}} as any)
  }
  else if (data === 'sub_pricing') {
    await bot.sendMessage(chatId,
      `💳 <b>Community Kit Pricing</b>\n\n🆓 <b>Free</b> — $0\nPoints, Leaderboard, Referrals, Onboarding, Projects\n\n🌱 <b>Seed</b> — $49/mo\n+ Price Alerts, Gem Signals, Raffle, Scheduled Posts\n\n⚡ <b>Pro</b> — $199/mo\n+ Token Claim, Broadcast DM, Flash Quests, Bounties, Proposals\n\n🚀 <b>Scale</b> — $499/mo\n+ Analytics Export, Token Gate, Custom Branding\n\n💰 USDC or $BLUEAGENT (-20%) on Base\n📊 Multi-month: 3mo -10% | 6mo -15% | 12mo -20%`,
      { parse_mode: 'HTML' } as any)
  }
})

// TX hash verification for subscription
bot.on('message', async (msg) => {
  if (msg.chat.type !== 'private') return
  const userId = msg.from?.id; if (!userId) return
  const session = subSessions.get(userId)
  if (!session || session.step !== 'awaiting_tx') return
  const text = msg.text?.trim() || ''
  if (!text.startsWith('0x') || text.length < 60) return
  const chatId = msg.chat.id
  await bot.sendMessage(chatId, '⏳ Verifying on Base...')
  try {
    const res = await axios.get(`https://api.basescan.org/api?module=transaction&action=gettxreceiptstatus&txhash=${text}&apikey=${BASESCAN_API}`, { timeout: 10000 })
    const status = res.data?.result?.status
    if (status === '1') {
      const amount = calcPrice(session.tier, session.months, session.currency)
      const sub: Subscription = { userId, projectName: `User ${userId}`, tier: session.tier, address: '', txHash: text, amount, startAt: Date.now(), expiresAt: Date.now() + session.months*30*24*60*60*1000, active: true }
      const subs = loadSubs(); subs.push(sub); saveSubs(subs)
      subSessions.delete(userId)
      await bot.sendMessage(chatId, `✅ <b>Payment verified!</b>\n\n🏷️ <b>${session.tier.toUpperCase()}</b> · ${session.months}mo\n💰 $${amount} ${session.currency.toUpperCase()}\n⏰ Expires: ${new Date(sub.expiresAt).toLocaleDateString()}\n\n📩 Tier will be activated within 24h. Contact @blockyagent_bot if needed.`, { parse_mode: 'HTML' } as any)
      await bot.sendMessage(OWNER_ID, `💰 <b>New Sub!</b>\nUser: @${msg.from?.username||userId}\nTier: ${session.tier} · ${session.months}mo | $${amount} ${session.currency}\nTX: <code>${text}</code>`, { parse_mode: 'HTML' } as any)
    } else if (status === '0') {
      await bot.sendMessage(chatId, '❌ Transaction failed on-chain. Please try again.')
    } else {
      await bot.sendMessage(chatId, '⚠️ Cannot verify yet — may be pending. Wait 1 min and paste again.')
    }
  } catch {
    await bot.sendMessage(chatId, '⚠️ Verification error. Contact @blockyagent_bot with your TX hash.')
  }
})
