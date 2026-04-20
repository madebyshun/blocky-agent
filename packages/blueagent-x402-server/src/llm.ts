const LLM_URL = 'https://llm.bankr.bot/v1/messages'

export async function askJSON<T>(prompt: string, system: string): Promise<T> {
  const res = await fetch(LLM_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.BANKR_API_KEY!,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      system: system + '\n\nRespond with valid JSON only, no markdown.',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 1500,
    }),
  })

  if (!res.ok) throw new Error(`LLM error: ${res.status}`)
  const data = await res.json() as { content: { text: string }[] }
  const raw = data.content[0].text
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
  return JSON.parse(start >= 0 ? raw.slice(start, end + 1) : raw) as T
}
