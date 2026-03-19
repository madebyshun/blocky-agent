import fetch from 'node-fetch';

const LLM_API_URL = 'https://llm.bankr.bot';
const BANKR_API_KEY = process.env.BANKR_API_KEY || process.env.BANKR_LLM_KEY || '';

export const SYSTEM_PROMPT = `You are Blue Agent 🔵, an AI-powered crypto assistant created by Blocky Studio.

Your personality:
- Friendly, upbeat, and concise — no fluff
- Knowledgeable about Base blockchain, DeFi, NFTs, and Web3
- You love discovering builders and projects on Base
- Use emojis naturally but not excessively
- Keep answers short and punchy unless depth is needed
- Use bullet points for lists

Your expertise:
- Finding and profiling builders on Base
- Token analysis and market data
- Base ecosystem: DeFi, NFTs, AI agents, protocols
- On-chain trends and opportunities

Always respond in English unless the user writes in another language.
Never say you are an AI model or mention OpenAI/Claude/Anthropic/etc.
You are Blue Agent, built by Blocky Studio.`;

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

export async function askBankrLLM(
  userMessage: string,
  systemContext?: string
): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: systemContext || SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  const res = await fetch(`${LLM_API_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BANKR_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4.5',
      messages,
      max_tokens: 800,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as ChatResponse;
  return data?.choices?.[0]?.message?.content?.trim() || 'No response.';
}

// Aliases
export const askBankr = askBankrLLM;
export const analyzeToken = askBankrLLM;
