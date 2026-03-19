import TelegramBot from 'node-telegram-bot-api'
import axios from 'axios'
import * as dotenv from 'dotenv'
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
const SYSTEM_PROMPT = `You are Blue Agent 🔵, employee #001 of Blocky Studio — a builder-focused AI agent on Base.

## Identity
I'm Blue Agent 🔵 — an AI built by Blocky Studio to explore the Base ecosystem.
I help builders find projects, track tokens, and navigate onchain.
Not a chatbot. A builder's sidekick.
## Personality
- Concise and direct — no filler phrases
- Sharp, slightly witty, builder-native

## Expertise
- Base ecosystem: DeFi, NFTs, AI agents, builders, launchpads
- On-chain actions: swap, send, check balance, check prices
- Builder discovery: who's building on Base, notable projects, AI agents on-chain
- Blocky Ecosytem: $BLOCKY token, Blocky Echo NFT, BLOCKY meme

## Blue Agent Context
- Token: $BLUEAGENT — 0xf895783b2931c919955e18b5e3343e7c7c456ba3 (Base, Uniswap v4)
- Treasury: 0xf31f59e7b8b58555f7871f71973a394c8f1bffe5
- Twitter: @blocky_agent
- Telegram: https://t.me/+1baBZgX7jd4wMGU1

## Response Format
- Max 300 words
- Use <b>bold</b> and <i>italic</i> for Telegram HTML
- Bullet points, no tables
- End with 💡 tip when relevant`


// =======================
// FORMAT AGENT REPLY (markdown → Telegram HTML)
// =======================
function formatAgentReply(text: string): string {
  return text
    // Section headers (## or **word**:) → bold with emoji spacing
    .replace(/^#{1,3}\s*(.+)$/gm, '\n<b>$1</b>')
    // **bold** → <b>bold</b>
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    // *italic* → <i>italic</i>
    .replace(/\*(.*?)\*/g, '<i>$1</i>')
    // bullet points
    .replace(/^\s*[-*•]\s+/gm, '• ')
    // positive % → green-ish indicator
    .replace(/(\+[\d.]+%)/g, '📈 $1')
    // negative % → red-ish indicator
    .replace(/(−[\d.]+%|-[\d.]+%)/g, '📉 $1')
    // clean up extra blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// =======================
// WELCOME MESSAGE
// =======================
const WELCOME_MESSAGE = `<b>Blue Agent 🔵🤖</b>

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
• "Top tokens on Base"
• "What builders are building on Base?"
• "AI agents on Base"
• "What is Base?"

<i>Built by Blocky.</i>`

// =======================
// BANKR AGENT
// Handles ALL data queries + on-chain actions
// Has real tools: prices, trending, on-chain data, swaps, balances
// =======================
async function askBankrAgent(prompt: string): Promise<string> {
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
    for (let i = 0; i < 30; i++) {
      const delay = i < 6 ? 500 : i < 15 ? 1500 : 3000
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
// =======================
async function askLLM(messages: Array<{ role: string; content: string }>): Promise<string> {
  try {
    const res = await axios.post(
      'https://llm.bankr.bot/v1/messages',
      {
        model: 'claude-sonnet-4-5',
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
    return res.data?.content?.[0]?.text?.trim() || ''
  } catch (e: any) {
    console.error('LLM error:', e.response?.status, e.message)
    return ''
  }
}

// =======================
// NEEDS REAL-TIME DATA?
// Route to Bankr Agent for live data + actions
// =======================
function needsAgent(text: string): boolean {
  return /price|prices|trending|trend|top token|hot|popular|swap|send|buy|sell|transfer|bridge|balance|portfolio|market|volume|liquidity|airdrop|launch/i.test(text)
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
// /help
// =======================
bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `<b>Blue Agent 🔵 — What I can do</b>\n\n` +
    `• <b>Trending</b> — "What's hot on Base?"\n` +
    `• <b>Prices</b> — "ETH price?" / "$BLUEAGENT price?"\n` +
    `• <b>Builders</b> — "Who's building AI agents on Base?"\n` +
    `• <b>Projects</b> — "Tell me about Aerodrome"\n` +
    `• <b>On-chain</b> — "Swap 10 USDC to ETH"\n` +
    `• <b>Portfolio</b> — "Check my balance"\n` +
    `• <b>Blocky</b> — "What is $BLUEAGENT?"\n\n` +
    `<i>No commands needed — just chat!</i>`,
    { parse_mode: 'HTML' } as any
  )
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

  // Typing indicator
  bot.sendChatAction(chatId, 'typing').catch(() => {})
  const typingInterval = setInterval(() => {
    bot.sendChatAction(chatId, 'typing').catch(() => {})
  }, 4000)

  try {
    let reply = ''

    if (needsAgent(text)) {
      // Bankr Agent: real-time data + on-chain actions
      console.log(`[Agent] ${text}`)
      const agentRaw = await askBankrAgent(text)
      if (agentRaw) {
        reply = formatAgentReply(agentRaw)
      } else {
        // Agent failed — tell user honestly instead of hallucinating
        reply = "⚠️ Couldn't fetch live data right now. Bankr Agent might be slow.\n\nTry again in a moment! 🔵"
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
bot.setMyCommands([
  { command: 'start', description: 'Start chatting with Blue Agent 🔵' },
  { command: 'help', description: 'What can Blue Agent do?' }
]).catch(() => {})

bot.getMe().then((me) => {
  console.log(`🔵 Blue Agent started: @${me.username}`)
  console.log(`LLM key: ${BANKR_LLM_KEY ? 'loaded' : 'MISSING'}`)
  console.log(`Agent key: ${BANKR_API_KEY ? 'loaded' : 'MISSING'}`)
}).catch(console.error)
