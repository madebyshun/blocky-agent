import { Context } from 'telegraf';

const WELCOME_MESSAGE = `Blue Agent 🔵🤖

I'm an AI-powered crypto assistant built to explore and discover builders on the Base ecosystem. Created by Blocky.

Here's what I can help you with:

🔍 Builder Discovery
• Who's building on Base right now
• Notable projects and protocols
• AI agents on Base

📊 Market Data
• Token prices and market info
• Top tokens on Base
• Real-time crypto data via Bankr

💬 AI Insights
• Base ecosystem overview
• DeFi, NFTs, and Web3 concepts
• Onchain trends and opportunities

Try asking:
• "Top tokens on Base"
• "What builders are building on Base?"
• "AI agents on Base"
• "What is Base?"

Built by Blocky. https://t.me/+1baBZgX7jd4wMGU1`;

export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(WELCOME_MESSAGE, {
    link_preview_options: { is_disabled: true },
  });
}
