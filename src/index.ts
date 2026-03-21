import TelegramBot from 'node-telegram-bot-api'
import axios from 'axios'
import * as dotenv from 'dotenv'
import { execSync, spawn } from 'child_process'
// import { createCanvas } from 'canvas' // Reserved for Phase 2 card generation
dotenv.config()

// =======================
// CONFIG
// =======================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8363087451:AAHKl48E-jg_PeeU9GG0NfugpX-vnsYKYLE'
const BANKR_LLM_KEY = process.env.BANKR_LLM_KEY || 'bk_9PCM8TGTL5RALEEY7WEKUXY3DQRJ2FVN'
const BANKR_API_KEY = process.env.BANKR_API_KEY || 'bk_9PCM8TGTL5RALEEY7WEKUXY3DQRJ2FVN'

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true })

// =======================
// BLUE AGENT SYSTEM PROMPT
// =======================
const SYSTEM_PROMPT = `You are Blue Agent 🟦, employee #001 of Blocky Studio — a builder-focused AI agent on Base.

## Identity
I'm Blue Agent 🟦 — an AI built by Blocky Studio to explore the Base ecosystem.
I help builders find projects, track tokens, and navigate onchain.
Not a chatbot. A builder's sidekick.
## Personality
- Concise and direct — no filler phrases
- Sharp, slightly witty, builder-native

## Expertise
- Base ecosystem: DeFi, NFTs, AI agents, builders, launchpads
- On-chain actions: swap, send, check balance, check prices, transfer tokens
- Token trading: spot buy/sell, limit orders, portfolio tracking
- Leverage trading: long/short positions on Base/Ethereum
- NFT operations: mint, transfer, check ownership, floor prices
- Polymarket: prediction market bets, check odds, open positions
- Token deployment: launch ERC-20 on Base with custom params
- Builder discovery: who's building on Base, notable projects, AI agents on-chain
- Blocky Ecosystem: $BLUEAGENT token, Blocky Echo NFT

## Blocky Ecosystem
- **$BLOCKY** — Blocky Studio ecosystem token — 0x1E11dC42b7916621EEE1874da5664d75A0D74b07 (Base)
- **$BLUEAGENT** — Blue Agent AI token — 0xf895783b2931c919955e18b5e3343e7c7c456ba3 (Base, Uniswap v4)
- Treasury: 0xf31f59e7b8b58555f7871f71973a394c8f1bffe5
- Twitter: @blocky_agent
- Telegram: https://t.me/+1baBZgX7jd4wMGU1
- $BLOCKY = Blocky Studio ecosystem token | $BLUEAGENT = Blue Agent product token

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
const WELCOME_MESSAGE = `<b>Blue Agent 🟦🤖</b>

I'm an AI-powered crypto assistant built to explore and discover builders on the Base ecosystem. Created by Blocky.

Here's what I can help you with:

🔍 <b>Builder Discovery</b>
• Who's building on Base right now
• Notable projects and protocols
• AI agents on Base

📊 <b>Market Data</b>
• Token prices and market info
• Top tokens on Base
• Real-time crypto data via Bankr

💬 <b>AI Insights</b>
• Base ecosystem overview
• DeFi, NFTs, and Web3 concepts
• Onchain trends and opportunities

Try asking:
• "Your 5 tips give builders a real edg"
• "What builders are building on Base?"
• "AI agents on Base"
• "Analyze Base trends"

<i>Built by Blocky.</i>`

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
const LLM_MODELS = [
  // Primary — best quality/speed balance
  'claude-sonnet-4-5',
  'claude-sonnet-4.6',
  // Fast fallbacks
  'gemini-2.5-flash',
  'gemini-3-flash',
  'gemini-3.1-pro',
  'qwen3.5-flash',      // fast + cheap
  // Light models
  'claude-haiku-4.5',
  'gpt-5-mini',
  'gpt-5-nano',
  'minimax-m2.5',       // long context
  'minimax-m2.7',
]

async function askLLM(messages: Array<{ role: string; content: string }>): Promise<string> {
  for (const model of LLM_MODELS) {
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
  return /swap|send|transfer|bridge|buy\s+\$?\w+|sell\s+\$?\w+|balance|portfolio|my\s+wallet|my\s+position|leverage|long|short|margin|open\s+position|limit\s+order|polymarket\s+bet|place\s+bet|deploy\s+token|mint\s+nft|check\s+wallet|latest.*from\s+@|what.*@\w+.*said|price\s+of\s+\$?\w+|\$\w+\s+price|twitter|tweet|news.*today|update.*today|latest.*today|trending.*bankr|bankr.*trending|top.*bankr|bankr.*top|on\s+bankr|bankr\s+data|bankr\s+onchain|bankr\s+token|bankr\s+volume|bankr\s+launch/i.test(text)
}

function isTrendingQuery(text: string): boolean {
  return /trending|top token|hot|what.*(on|in)\s*base|top.*base|base.*top/i.test(text)
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
  step: 'name' | 'symbol' | 'description' | 'image' | 'wallet' | 'confirm'
  name?: string
  symbol?: string
  description?: string
  image?: string
  wallet?: string
}

const launchSessions = new Map<number, LaunchState>()

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
    state.step = 'wallet'
    launchSessions.set(userId, state)
    await bot.sendMessage(chatId,
      `✅ Image: ${state.image ? `<a href="${state.image}">link</a>` : '(none)'}\n\n` +
      `💰 Enter <b>wallet address</b> to receive fees (0x...):\n` +
      `<i>or type <b>skip</b> to use default</i>`,
      { parse_mode: 'HTML', disable_web_page_preview: true } as any
    )
    return
  }

  if (state.step === 'wallet') {
    const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(text)
    if (text.toLowerCase() === 'skip') {
      state.wallet = ''
    } else if (isValidAddress) {
      state.wallet = text
    } else {
      await bot.sendMessage(chatId,
        `⚠️ Invalid wallet address. Enter a valid <b>0x...</b> address or type <b>skip</b>:`,
        { parse_mode: 'HTML' } as any
      )
      return
    }

    state.step = 'confirm'
    launchSessions.set(userId, state)

    const summary = `🚀 <b>Confirm Token Launch</b>\n\n` +
      `• Name: <b>${state.name}</b>\n` +
      `• Symbol: <b>$${state.symbol}</b>\n` +
      `• Description: <i>${state.description || '(none)'}</i>\n` +
      `• Image: ${state.image ? `<a href="${state.image}">link</a>` : '(none)'}\n` +
      `• Fee wallet: <code>${state.wallet || '(default)'}</code>\n\n` +
      `Type <b>confirm</b> to deploy or <b>cancel</b> to abort:`

    await bot.sendMessage(chatId, summary, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    } as any)
    return
  }

  if (state.step === 'confirm') {
    if (text.toLowerCase() === 'cancel') {
      launchSessions.delete(userId)
      await bot.sendMessage(chatId, '❌ Cancelled. Type /launch to start over.')
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
      if (state.wallet) args.push('--fee-recipient', state.wallet)

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
const MAX_HISTORY = 10

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

// =======================
// /start
// =======================
bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id, WELCOME_MESSAGE, {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  } as any)
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
    `• "Floor price of Blocky Echo"\n\n` +
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

// /status — full health check
bot.onText(/\/status/, async (msg) => {
  if (!isOwner(msg)) return
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

// /score — Builder Score from X handle
bot.onText(/\/score(?:\s+@?(\S+))?/, async (msg, match) => {
  const chatId = msg.chat.id
  const handle = match?.[1]?.replace('@', '')

  if (!handle) {
    await bot.sendMessage(chatId,
      `<b>Builder Score 🟦</b>\n\nUsage: <code>/score @handle</code>\n\nExample: <code>/score jessepollak</code>`,
      { parse_mode: 'HTML' } as any
    )
    return
  }

  bot.sendChatAction(chatId, 'typing').catch(() => {})
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000)

  try {
    const prompt = `Score @${handle} as a Base builder (0-100). Check their X posts.
Reply in this format only:
SCORE: X/100
TIER: Explorer|Builder|Shipper|Founder|Legend
Consistency: X/25
Technical: X/25
Builder focus: X/25
Community: X/25
SUMMARY: one sentence`

    // Retry up to 3 times for /score
    let result = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      result = await askBankrAgent(prompt, 25)
      if (result) break
      console.log(`[Score] Attempt ${attempt} failed, retrying...`)
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000))
    }

    if (result) {
      // Parse score from response
      const scoreMatch = result.match(/SCORE:\s*(\d+)\/100/i)
      const tierMatch = result.match(/TIER:\s*(\w+)/i)
      const summaryMatch = result.match(/SUMMARY:\s*(.+)/i)

      const score = scoreMatch ? parseInt(scoreMatch[1]) : null
      const tier = tierMatch ? tierMatch[1] : null
      const summary = summaryMatch ? summaryMatch[1].trim() : null

      const tierEmoji: Record<string, string> = {
        explorer: '🌱', builder: '🔨', shipper: '⚡', founder: '🚀', legend: '🏆'
      }
      const emoji = tier ? (tierEmoji[tier.toLowerCase()] || '🟦') : '🟦'

      const output = score !== null
        ? `<b>🟦 Builder Score</b>\n` +
          `<b>@${handle}</b>\n` +
          `──────────────\n` +
          `Score: <b>${score}/100</b> ${emoji}\n` +
          `Tier: <b>${tier || 'Unknown'}</b>\n\n` +
          formatAgentReply(result
            .replace(/SCORE:.*\n?/i, '')
            .replace(/TIER:.*\n?/i, '')
            .replace(/SUMMARY:.*\n?/i, '')
            .trim()) +
          (summary ? `\n\n💡 ${summary}` : '') +
          `\n──────────────\n` +
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
})

// /news — public X builder feed
bot.onText(/\/news/, async (msg) => {
  const chatId = msg.chat.id
  bot.sendChatAction(chatId, 'typing').catch(() => {})
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000)

  try {
    // Use LLM with web search context instead of slow Agent
    // Use top accounts for /news — focused list for speed
    const TOP_ACCOUNTS = '@jessepollak, @base, @buildonbase, @bankrbot, @virtuals_io, @coinbase, @brian_armstrong'
    const xPrompt = `Latest updates from Base builders today. Check: ${TOP_ACCOUNTS}. Show all notable updates, one line each. End with one key insight about the trend.`
    let result = await askBankrAgent(xPrompt, 25)

    // Fallback to LLM if Agent too slow
    if (!result) {
      result = await askLLM([{ role: 'user', content: `Latest updates from Base builders today: ${TOP_ACCOUNTS}. List top 5 highlights, one line each.` }])
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
// MAIN MESSAGE HANDLER
// Flow: Bankr Agent (real-time data) → LLM fallback (personality)
// =======================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id || chatId
  const text = msg.text?.trim()

  if (!text || text.startsWith('/')) return

  // Launch wizard takes priority
  if (launchSessions.has(userId)) {
    await handleLaunchWizard(chatId, userId, text)
    return
  }

  // Typing indicator
  bot.sendChatAction(chatId, 'typing').catch(() => {})
  const typingInterval = setInterval(() => {
    bot.sendChatAction(chatId, 'typing').catch(() => {})
  }, 4000)

  try {
    let reply = ''

    if (needsAgent(text)) {
      // Bankr Agent: real-time data + on-chain actions + X search
      const agentPrompt = isXQuery(text) ? buildXPrompt(text) : text
      // X + Bankr queries are slower — give more time
      const maxPolls = (isXQuery(text) || /bankr/i.test(text)) ? 25 : 15
      console.log(`[Agent] ${isXQuery(text) ? '[X-enriched]' : ''} ${text}`)
      const agentRaw = await askBankrAgent(agentPrompt, maxPolls)
      if (agentRaw) {
        reply = formatAgentReply(agentRaw)
      }

      // Agent failed → fall through to LLM below
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
// Public commands
// Public commands
bot.setMyCommands([
  { command: 'start', description: 'Start' },
  { command: 'help', description: 'Help' },
  { command: 'score', description: 'Builder Score (@handle)' },
  { command: 'news', description: 'Base builder feed' },
  { command: 'launch', description: 'Deploy token on Base' }
]).catch(() => {})

// Owner-only commands
bot.setMyCommands([
  { command: 'start', description: 'Start' },
  { command: 'help', description: 'Help' },
  { command: 'score', description: 'Builder Score (@handle)' },
  { command: 'news', description: 'Base builder feed' },
  { command: 'launch', description: 'Deploy token on Base' },
  { command: 'model', description: 'AI models' },
  { command: 'status', description: 'Health check' }
], { scope: { type: 'chat', chat_id: OWNER_ID } } as any).catch(() => {})

bot.getMe().then((me) => {
  console.log(`🟦 Blue Agent started: @${me.username}`)
  console.log(`LLM key: ${BANKR_LLM_KEY ? 'loaded' : 'MISSING'}`)
  console.log(`Agent key: ${BANKR_API_KEY ? 'loaded' : 'MISSING'}`)
}).catch(console.error)
