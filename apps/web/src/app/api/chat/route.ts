import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const BANKR_LLM = "https://llm.bankr.bot/v1/messages";

export const MODELS: Record<string, { id: string; label: string; price: string; maxTokens: number }> = {
  fast: { id: "claude-haiku-4-5", label: "Fast", price: "$0.01/msg", maxTokens: 1024 },
  pro:  { id: "claude-sonnet-4-6", label: "Pro",  price: "$0.05/msg", maxTokens: 2048 },
  max:  { id: "claude-opus-4-7",   label: "Max",  price: "$0.20/msg", maxTokens: 4096 },
};

const SYSTEM = `You are Blue Agent — the Base-native AI assistant for builders.

You help founders and developers on Base with:
- Idea generation and product strategy
- Smart contract architecture and Solidity
- DeFi protocol design and tokenomics
- Agent development and x402 integrations
- Launch strategy, GTM, and fundraising

You are direct, technical, and builder-minded. No fluff. Every response should be actionable.
You are Base-first: prefer Base, USDC, Coinbase tools, Uniswap v4, and the Bankr ecosystem.`;

export async function POST(req: NextRequest) {
  const apiKey = process.env.BANKR_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "BANKR_API_KEY not configured." }, { status: 500 });
  }

  let body: { messages?: { role: string; content: string }[]; tier?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { messages, tier = "pro" } = body;
  if (!messages?.length) {
    return NextResponse.json({ error: "messages array required." }, { status: 400 });
  }

  const model = MODELS[tier] ?? MODELS.pro;

  const upstream = await fetch(BANKR_LLM, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model.id,
      system: SYSTEM,
      messages,
      max_tokens: model.maxTokens,
      stream: true,
    }),
  });

  if (!upstream.ok) {
    const err = await upstream.text();
    return NextResponse.json({ error: `Bankr LLM error: ${upstream.status}`, detail: err }, { status: upstream.status });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
