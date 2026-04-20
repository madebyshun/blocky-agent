#!/bin/bash
# Run this script inside blueagent-x402-services/ directory
# Creates 15 new x402 service folders + updates bankr.x402.json

set -e
echo "🔵 Setting up 15 new BlueAgent x402 services..."

LLM_HELPER='async function callLLM(system: string, userContent: string): Promise<string> {
  const response = await fetch("https://llm.bankr.bot/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.BANKR_API_KEY!,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      system,
      messages: [{ role: "user", content: userContent }],
      temperature: 0.5,
      max_tokens: 1200,
    }),
  });
  if (!response.ok) throw new Error(`LLM error: ${response.status}`);
  const data = await response.json();
  if (data.content && Array.isArray(data.content)) return data.content[0].text;
  throw new Error("Invalid LLM response");
}

function parseJSON(raw: string): any {
  const start = raw.indexOf("{"); const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error("No JSON found");
}'

create_service() {
  local name=$1
  local content=$2
  mkdir -p "x402/${name}"
  echo "$content" > "x402/${name}/index.ts"
  echo "  ✅ ${name}"
}

# ── whale-tracker ──────────────────────────────────────────
create_service "whale-tracker" "// x402/whale-tracker/index.ts — \$0.10 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { address = '' } = text ? JSON.parse(text) : {};
    if (!address) return Response.json({ error: 'address required' }, { status: 400 });

    const system = 'You are an onchain analyst tracking whale wallets and smart money flows on Base. Return ONLY valid JSON.';
    const prompt = \`Analyze whale and smart money activity for: \${address} on Base.
Return JSON: { address, recentMoves: [{ wallet, action, value, time }] (up to 5), smartMoneyScore (0-100), summary }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── dex-flow ───────────────────────────────────────────────
create_service "dex-flow" "// x402/dex-flow/index.ts — \$0.15 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { token = '' } = text ? JSON.parse(text) : {};
    if (!token) return Response.json({ error: 'token required' }, { status: 400 });

    const system = 'You are a DEX market analyst on Base. Be specific about Aerodrome, Uniswap v3, BaseSwap. Return ONLY valid JSON.';
    const prompt = \`Analyze DEX trading flow for token: \${token} on Base.
Return JSON: { token, priceUSD, volume24h, liquidity, priceChange24h, buyPressure: \"STRONG BUY\"|\"MILD BUY\"|\"MILD SELL\"|\"STRONG SELL\", verdict }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── unlock-alert ───────────────────────────────────────────
create_service "unlock-alert" "// x402/unlock-alert/index.ts — \$0.20 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { token = '' } = text ? JSON.parse(text) : {};
    if (!token) return Response.json({ error: 'token required' }, { status: 400 });

    const system = 'You are a tokenomics analyst specializing in vesting and unlock schedules. Return ONLY valid JSON.';
    const prompt = \`Research token unlock schedule for: \${token}.
Return JSON: { token, nextUnlock: { date, amount, recipient, percentSupply }, totalLocked, unlockSchedule: [{ date, amount, category }] (up to 5), riskLevel: \"LOW\"|\"MEDIUM\"|\"HIGH\"|\"CRITICAL\", summary }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── honeypot-check ─────────────────────────────────────────
create_service "honeypot-check" "// x402/honeypot-check/index.ts — \$0.05 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { token = '' } = text ? JSON.parse(text) : {};
    if (!token) return Response.json({ error: 'token required' }, { status: 400 });

    const system = 'You are a smart contract security auditor specializing in honeypot detection on Base. Return ONLY valid JSON.';
    const prompt = \`Honeypot and security check for token: \${token} on Base.
Return JSON: { token, isHoneypot (bool), canSell (bool), buyTax, sellTax, isVerified (bool), hasBlacklist (bool), hasMint (bool), verdict: \"SAFE\"|\"WARNING\"|\"DANGER\", reasons (array) }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── aml-screen ─────────────────────────────────────────────
create_service "aml-screen" "// x402/aml-screen/index.ts — \$0.25 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { address = '' } = text ? JSON.parse(text) : {};
    if (!address) return Response.json({ error: 'address required' }, { status: 400 });

    const system = 'You are a blockchain AML compliance analyst. Return ONLY valid JSON.';
    const prompt = \`AML compliance check for wallet: \${address} on Base.
Return JSON: { address, riskLevel: \"LOW\"|\"MEDIUM\"|\"HIGH\"|\"CRITICAL\", complianceScore (0-100), flags (array), sanctioned (bool), mixerUsed (bool), darknetLinked (bool), recommendation }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── mev-shield ─────────────────────────────────────────────
create_service "mev-shield" "// x402/mev-shield/index.ts — \$0.30 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { action = '' } = text ? JSON.parse(text) : {};
    if (!action) return Response.json({ error: 'action required' }, { status: 400 });

    const system = 'You are an MEV protection expert on Base. Be specific and practical. Return ONLY valid JSON.';
    const prompt = \`Analyze MEV risk for transaction: "\${action}" on Base.
Return JSON: { action, mevRisk: \"LOW\"|\"MEDIUM\"|\"HIGH\"|\"CRITICAL\", sandwichProbability, estimatedLoss, recommendations (array), safeSlippage, preferredRouter }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── phishing-scan ──────────────────────────────────────────
create_service "phishing-scan" "// x402/phishing-scan/index.ts — \$0.10 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { target = '' } = text ? JSON.parse(text) : {};
    if (!target) return Response.json({ error: 'target required' }, { status: 400 });

    const isAddress = /^0x[0-9a-fA-F]{40}$/.test(target);
    const isURL = target.startsWith('http');
    const type = isAddress ? 'contract/wallet address' : isURL ? 'URL' : 'social handle / domain';

    const system = 'You are a Web3 security expert specializing in phishing and scam detection. Return ONLY valid JSON.';
    const prompt = \`Scan for phishing/scam indicators: "\${target}" (type: \${type}).
Return JSON: { target, verdict: \"SAFE\"|\"SUSPICIOUS\"|\"PHISHING\"|\"SCAM\", riskScore (0-100), flags (array), recommendation }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── tokenomics-score ───────────────────────────────────────
create_service "tokenomics-score" "// x402/tokenomics-score/index.ts — \$0.50 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { token = '' } = text ? JSON.parse(text) : {};
    if (!token) return Response.json({ error: 'token required' }, { status: 400 });

    const system = 'You are a tokenomics expert. Be specific with numbers. Return ONLY valid JSON.';
    const prompt = \`Analyze tokenomics of: \${token}.
Return JSON: { token, score (0-100), supplyStructure: { total, circulating, locked }, inflationRate, vestingCliff, distributionHealth: \"HEALTHY\"|\"MODERATE\"|\"RISKY\", strengths (array), risks (array), verdict }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── narrative-pulse ────────────────────────────────────────
create_service "narrative-pulse" "// x402/narrative-pulse/index.ts — \$0.40 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { query = '' } = text ? JSON.parse(text) : {};
    if (!query) return Response.json({ error: 'query required' }, { status: 400 });

    const system = 'You are a crypto narrative analyst specializing in Base ecosystem trends. Return ONLY valid JSON.';
    const prompt = \`Analyze narrative momentum for: "\${query}" in Base ecosystem 2025-2026.
Return JSON: { query, heatScore (0-100), trending (top 3 related tokens), momentum: \"RISING\"|\"PEAK\"|\"FADING\"|\"EMERGING\", keyPlayers (array), catalysts (array), timeframe, summary }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── vc-tracker ─────────────────────────────────────────────
create_service "vc-tracker" "// x402/vc-tracker/index.ts — \$1.00 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { query = '' } = text ? JSON.parse(text) : {};
    if (!query) return Response.json({ error: 'query required' }, { status: 400 });

    const system = 'You are a crypto VC research analyst with deep knowledge of Web3 fundraising 2024-2026. Return ONLY valid JSON.';
    const prompt = \`Research VC activity for: "\${query}" in crypto/Web3.
Return JSON: { query, recentDeals: [{ project, vc, amount, date, stage }] (up to 5), hotThemes (array), activeVCs (array), marketSignal: \"BULLISH\"|\"NEUTRAL\"|\"BEARISH\", summary }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── whitepaper-tldr ────────────────────────────────────────
create_service "whitepaper-tldr" "// x402/whitepaper-tldr/index.ts — \$0.20 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { url = '', projectName = '' } = text ? JSON.parse(text) : {};
    if (!url) return Response.json({ error: 'url required' }, { status: 400 });

    let content = '';
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'BlueAgent/1.0' } });
      const html = await res.text();
      content = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 5000);
    } catch { content = 'Could not fetch URL'; }

    const system = 'You are a crypto research analyst. Be concise and cut through the hype. Return ONLY valid JSON.';
    const prompt = \`Summarize whitepaper for \${projectName || 'this project'}. URL: \${url}. Content: \${content}
Return JSON: { url, projectName, bullets (5 key points), techStack (array), tokenRole, verdict, readTime }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── yield-optimizer ────────────────────────────────────────
create_service "yield-optimizer" "// x402/yield-optimizer/index.ts — \$0.15 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { token = '' } = text ? JSON.parse(text) : {};
    if (!token) return Response.json({ error: 'token required' }, { status: 400 });

    const system = 'You are a DeFi yield optimization expert on Base. Focus on Aerodrome, Moonwell, Compound, ExtraFi, Beefy. Return ONLY valid JSON.';
    const prompt = \`Best yield opportunities for token: \${token} on Base.
Return JSON: { token, topOpportunities: [{ protocol, pair, apy, tvl, risk: \"LOW\"|\"MEDIUM\"|\"HIGH\" }] (up to 5), bestAPY, recommendation }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── airdrop-check ──────────────────────────────────────────
create_service "airdrop-check" "// x402/airdrop-check/index.ts — \$0.10 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { address = '' } = text ? JSON.parse(text) : {};
    if (!address) return Response.json({ error: 'address required' }, { status: 400 });

    const system = 'You are an airdrop research expert specializing in Base ecosystem 2025-2026. Return ONLY valid JSON.';
    const prompt = \`Check airdrop eligibility for wallet: \${address} on Base and Ethereum.
Return JSON: { address, eligible: [{ project, amount, valueUSD, deadline, claimUrl }], totalEstimatedValue, missedAirdrops (array), tip }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── lp-analyzer ────────────────────────────────────────────
create_service "lp-analyzer" "// x402/lp-analyzer/index.ts — \$0.30 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { address = '', pool = '' } = text ? JSON.parse(text) : {};
    if (!address) return Response.json({ error: 'address required' }, { status: 400 });

    const system = 'You are a DeFi LP strategy expert on Base. Be specific about Aerodrome, Uniswap v3. Return ONLY valid JSON.';
    const prompt = \`Analyze LP positions for wallet: \${address} on Base. \${pool ? 'Focus on pool: ' + pool : 'Check all LP positions.'}
Return JSON: { address, positions: [{ pool, value, feesEarned, impermanentLoss, daysActive, health: \"GOOD\"|\"OK\"|\"REBALANCE\" }], totalValue, totalIL, totalFees, recommendation }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── tax-report ─────────────────────────────────────────────
create_service "tax-report" "// x402/tax-report/index.ts — \$2.00 USDC
${LLM_HELPER}

export default async function handler(req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const { address = '', year = '' } = text ? JSON.parse(text) : {};
    if (!address) return Response.json({ error: 'address required' }, { status: 400 });
    const taxYear = year || String(new Date().getFullYear() - 1);

    const system = 'You are a crypto tax expert. Be clear this is an estimate. Return ONLY valid JSON.';
    const prompt = \`Tax summary for wallet: \${address} for tax year \${taxYear} on Base.
Return JSON: { address, year: "\${taxYear}", totalTrades, realizedGains, realizedLosses, netPnL, incomeEvents: [{ type, amount, date }], taxableEvents, estimatedTaxLiability, recommendation }\`;

    const result = parseJSON(await callLLM(system, prompt));
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}"

# ── Update bankr.x402.json ─────────────────────────────────
echo ""
echo "📝 Updating bankr.x402.json..."

node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('bankr.x402.json', 'utf8'));

const newServices = {
  'whale-tracker': { price: 0.10, description: 'Whale & smart money tracker on Base', inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] } },
  'dex-flow': { price: 0.15, description: 'DEX trading flow & market data for any token on Base', inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } },
  'unlock-alert': { price: 0.20, description: 'Token unlock schedule & vesting cliff alerts', inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } },
  'honeypot-check': { price: 0.05, description: 'Honeypot & smart contract safety check', inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } },
  'aml-screen': { price: 0.25, description: 'AML compliance screening for wallet addresses', inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] } },
  'mev-shield': { price: 0.30, description: 'MEV & sandwich attack risk analysis', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
  'phishing-scan': { price: 0.10, description: 'Phishing & scam detection for addresses, URLs, domains', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
  'tokenomics-score': { price: 0.50, description: 'Deep tokenomics analysis & health score', inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } },
  'narrative-pulse': { price: 0.40, description: 'Crypto narrative & trend momentum on Base', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  'vc-tracker': { price: 1.00, description: 'VC investment activity & fundraising signals', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  'whitepaper-tldr': { price: 0.20, description: 'Whitepaper & docs summarizer — 5 bullets', inputSchema: { type: 'object', properties: { url: { type: 'string' }, projectName: { type: 'string' } }, required: ['url'] } },
  'yield-optimizer': { price: 0.15, description: 'Best yield farming opportunities on Base', inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } },
  'airdrop-check': { price: 0.10, description: 'Airdrop eligibility checker for Base & Ethereum', inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] } },
  'lp-analyzer': { price: 0.30, description: 'LP position health & impermanent loss analysis', inputSchema: { type: 'object', properties: { address: { type: 'string' }, pool: { type: 'string' } }, required: ['address'] } },
  'tax-report': { price: 2.00, description: 'Crypto tax summary & estimated liability', inputSchema: { type: 'object', properties: { address: { type: 'string' }, year: { type: 'string' } }, required: ['address'] } },
};

config.services = { ...config.services, ...newServices };
fs.writeFileSync('bankr.x402.json', JSON.stringify(config, null, 2));
console.log('Done! Total services:', Object.keys(config.services).length);
"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ 15 services created in x402/"
echo "📋 bankr.x402.json updated"
echo ""
echo "Next steps:"
echo "  git add . && git commit -m 'feat: add 15 new x402 services'"
echo "  git push"
echo "  bankr x402 deploy"
