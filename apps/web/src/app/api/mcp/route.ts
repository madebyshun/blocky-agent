/**
 * Blue Agent — MCP HTTP Server
 *
 * Remote MCP endpoint — agents and IDEs can connect without installing anything.
 *
 * Config (claude_desktop_config.json / .claude.json):
 *   {
 *     "mcpServers": {
 *       "blue-agent": { "url": "https://blueagent.dev/api/mcp" }
 *     }
 *   }
 *
 * Protocol: JSON-RPC 2.0 over HTTP POST
 * Tools: 87 — 5 console + 65 hub_* + 8 blue_* first-party + blue_score/blue_new
 *        + 7 b20_* MCP-native tools (deploy/mint/burn/grant/payment/check_activation/read_token)
 *        (77 unique x402 hub tools fully covered; 1 narrative alias; blue_score/blue_new
 *         + the 7 b20_* tools are MCP-only — pure calldata builders + on-chain reads, no x402 payment)
 *        NOTE: verified via scripts/p4-mcp-smoke.ts. Do NOT change this count
 *        without re-running the smoke — landing copy and docs quote it.
 * Docs: https://blueagent.dev/.well-known/openapi.json
 */
import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";
import { kv } from "@/lib/kv";
import { internalX402Headers, hasInternalKey } from "@/lib/x402-internal";
import {
  buildB20Calldata,
  encodeMint,
  encodeMintWithMemo,
  encodeBurnWithMemo,
  encodeGrantMintRole,
  encodeTransferWithMemo,
  isValidMemo,
} from "@/lib/b20/encode";
import { getB20Activation } from "@/lib/b20/activation";
import { inspectB20 } from "@/lib/b20/inspect";

export const runtime = "nodejs";
// Console commands (blue_idea/build/audit/ship/raise) wait on Bankr LLM which
// can take 30-50s. Without explicit maxDuration, Vercel's default cuts the
// function before Bankr replies → 504 to Claude Desktop. 120s leaves headroom
// for the longest case (blue_audit on a complex contract).
export const maxDuration = 120;

// Free-tier internal bypass — MCP calls don't require x402 payment.
// Set INTERNAL_SERVICE_KEY in Vercel; the /api/x402/[tool] route accepts it
// via X-Blue-Internal and skips the USDC settlement step.
const INTERNAL_KEY = process.env.INTERNAL_SERVICE_KEY ?? "";

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  // ── Console commands ──────────────────────────────────────────────────────
  {
    name: "blue_idea",
    description: "Turn a rough concept into a fundable brief — problem, why now, why Base, MVP scope, risks, 24h plan.",
    inputSchema: { type: "object", properties: { prompt: { type: "string", description: "Your idea or concept" } }, required: ["prompt"] },
  },
  {
    name: "blue_build",
    description: "Architecture, stack, folder structure, integrations, and test plan for a Base project.",
    inputSchema: { type: "object", properties: { prompt: { type: "string", description: "What to build — brief or requirements" } }, required: ["prompt"] },
  },
  {
    name: "blue_audit",
    description: "Security review — 500+ checks, 13 categories. Critical issues, suggested fixes, go/no-go.",
    inputSchema: { type: "object", properties: { prompt: { type: "string", description: "Code, contract, or system to audit" } }, required: ["prompt"] },
  },
  {
    name: "blue_ship",
    description: "Deployment checklist, verification steps, release notes, and monitoring plan.",
    inputSchema: { type: "object", properties: { prompt: { type: "string", description: "What you're shipping" } }, required: ["prompt"] },
  },
  {
    name: "blue_raise",
    description: "Pitch narrative — market framing, why this wins, traction, ask, target investors.",
    inputSchema: { type: "object", properties: { prompt: { type: "string", description: "Project and raise context" } }, required: ["prompt"] },
  },
  // ── Builder & Research Hub tools ─────────────────────────────────────────
  {
    name: "hub_agent_score",
    description: "Agent Score (0-100) — anchored in REAL GitHub repo activity and/or on-chain wallet activity when supplied; XP/community is a labelled estimate.",
    inputSchema: { type: "object", properties: { handle: { type: "string", description: "Agent handle or name" }, repo: { type: "string", description: "GitHub repo for real dev-activity signal" }, address: { type: "string", description: "Base wallet 0x... for real on-chain activity" } }, required: ["handle"] },
  },
  {
    name: "hub_market_fit",
    description: "Market fit analysis — problem clarity, timing, competition, demand signals for a Base project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project description" },
        url: { type: "string", description: "Project URL (optional)" },
      },
      required: ["project"],
    },
  },
  {
    name: "hub_token_pick",
    description: "AI token pick — falsifiable thesis, entry, sizing, kill criterion. Returns NO_PICK when nothing clears the bar.",
    inputSchema: { type: "object", properties: { context: { type: "string", description: "Market context (optional)" } } },
  },
  {
    name: "hub_narrative",
    description: "Narrative map — mindshare scores, velocity, phase (Emerging/Rising/Peak/Fading), position calls.",
    inputSchema: { type: "object", properties: { focus: { type: "string", description: "Narratives to focus on (optional)" } } },
  },
  {
    name: "hub_ecosystem",
    description: "Daily Base ecosystem digest — top launches, protocol updates, builder activity.",
    inputSchema: { type: "object", properties: { focus: { type: "string", description: "Area to focus on (optional)" } } },
  },
  {
    name: "hub_competitor_scan",
    description: "Competitor analysis — named competitors are grounded in REAL DefiLlama Base TVL/change when they match a protocol; reasons about defensible edge on top.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Your project description" },
        competitors: { type: "array", items: { type: "string" }, description: "Competitor names (resolved against DefiLlama Base protocols for live TVL)" },
        description: { type: "string", description: "What your project does" },
      },
      required: ["project"],
    },
  },
  {
    name: "hub_investor_memo",
    description: "Full investor memo — thesis, market, moat, risks, ask. Ready to send.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        description: { type: "string", description: "Description and traction" },
        ask: { type: "string", description: "Raise ask e.g. $500k pre-seed" },
      },
      required: ["project", "description"],
    },
  },
  {
    name: "hub_repo_health",
    description: "GitHub repo health — commit velocity, test coverage, dependency risk, bus factor.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "GitHub repository URL" } }, required: ["url"] },
  },
  {
    name: "hub_base_grant",
    description: "Find active grants and funding opportunities for your Base project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project description" },
        stage: { type: "string", description: "idea | build | live" },
      },
      required: ["project"],
    },
  },
  {
    name: "hub_risk_gate",
    description: "Screen any transaction before execution — rug check, AML, malicious contract patterns.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "transfer | swap | approve | call" },
        to: { type: "string", description: "Target address 0x..." },
        value: { type: "string", description: "Amount in Wei (optional)" },
      },
      required: ["action", "to"],
    },
  },
  {
    name: "hub_honeypot",
    description: "Detect honeypot tokens that cannot be sold after purchase.",
    inputSchema: { type: "object", properties: { token: { type: "string", description: "Token contract address on Base" } }, required: ["token"] },
  },
  {
    name: "hub_deep_analysis",
    description: "Comprehensive token fundamentals — on-chain activity, holder distribution, risk signals.",
    inputSchema: { type: "object", properties: { token: { type: "string", description: "Token contract address" } }, required: ["token"] },
  },
  {
    name: "hub_whale_signal",
    description: "Whale wallet copy-trade signals — track large moves for a token on Base.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Token address to track" },
        min_usd: { type: "number", description: "Min trade size in USD (default: 10000)" },
      },
      required: ["token"],
    },
  },
  {
    name: "hub_fundraise_timing",
    description: "Is now the right time to raise? Market conditions, stage readiness, investor appetite.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project description" },
        stage: { type: "string", description: "Stage and key metrics" },
      },
      required: ["project"],
    },
  },
  // ── Security (extended) ──────────────────────────────────────────────────
  {
    name: "hub_contract_trust",
    description: "Trust score for any smart contract — code quality, upgrade risk, ownership, audit history.",
    inputSchema: { type: "object", properties: { contract: { type: "string", description: "Contract address 0x..." } }, required: ["contract"] },
  },
  {
    name: "hub_aml_screen",
    description: "AML screening for a wallet address — sanctions, mixer exposure, illicit flow patterns.",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "Wallet address 0x..." } }, required: ["address"] },
  },
  {
    name: "hub_key_exposure",
    description: "Check if a wallet's public key is exposed on-chain (quantum vulnerability risk).",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "Wallet address 0x..." } }, required: ["address"] },
  },
  // ── Research (extended) ───────────────────────────────────────────────────
  {
    name: "hub_token_momentum",
    description: "Token momentum scanner — price velocity, volume spikes, social acceleration for Base tokens.",
    inputSchema: { type: "object", properties: { token: { type: "string", description: "Token address or symbol" }, limit: { type: "number", description: "Number of tokens to scan (default 10)" } } },
  },
  {
    name: "hub_whale_tracker",
    description: "Whale/large-transfer tracker for a Base token or wallet — real Basescan transfer data. Pass a 0x address.",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "Base token or wallet address (0x…) to track" } }, required: ["address"] },
  },
  {
    name: "hub_community_sentiment",
    description: "Community sentiment for a token or project — CT mindshare, Farcaster buzz, Telegram signals.",
    inputSchema: { type: "object", properties: { target: { type: "string", description: "Token symbol, project name, or contract address" } }, required: ["target"] },
  },
  // ── Builder (extended) ────────────────────────────────────────────────────
  {
    name: "hub_launch_simulator",
    description: "Simulate a token or product launch — model price action, liquidity, community growth scenarios.",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "Project/token description" }, supply: { type: "string", description: "Token supply (optional)" } }, required: ["project"] },
  },
  {
    name: "hub_token_launch",
    description: "Token launch readiness — market TIMING grounded in REAL Base data (live chain TVL + trending pools); if a token address is given its live DexScreener market grounds momentum. Returns GO/WAIT + action items.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, ticker: { type: "string" }, description: { type: "string" }, address: { type: "string", description: "Optional: existing token contract 0x... to ground in live market data" } }, required: ["name", "ticker", "description"] },
  },
  {
    name: "hub_builder_dd",
    description: "Deep due diligence on a builder — onchain history, shipped projects, GitHub activity, reputation signals.",
    inputSchema: { type: "object", properties: { handle: { type: "string", description: "X handle, GitHub handle, or wallet" } }, required: ["handle"] },
  },
  {
    name: "hub_roadmap",
    description: "Validate a product roadmap — feasibility, sequencing, market timing, missing milestones.",
    inputSchema: { type: "object", properties: { roadmap: { type: "string", description: "Roadmap or milestones" }, stage: { type: "string" } }, required: ["roadmap"] },
  },
  {
    name: "hub_gtm",
    description: "Go-to-market brief — distribution channels, launch sequence, community strategy for a Base project.",
    inputSchema: { type: "object", properties: { project: { type: "string" }, target: { type: "string", description: "Target audience (optional)" } }, required: ["project"] },
  },
  {
    name: "hub_pitch_intel",
    description: "Pitch intelligence — analyze and strengthen a pitch deck or fundraising narrative with investor-lens feedback.",
    inputSchema: { type: "object", properties: { pitch: { type: "string", description: "Pitch text or deck outline" } }, required: ["pitch"] },
  },
  // ── Premium ───────────────────────────────────────────────────────────────
  {
    name: "hub_defi_opportunity",
    description: "Best DeFi yield opportunities on Base — APY rankings, risk-adjusted returns, protocol safety.",
    inputSchema: { type: "object", properties: { amount: { type: "string", description: "Amount in USD (optional)" }, risk: { type: "string" } } },
  },
  {
    name: "hub_protocol_risk",
    description: "Real-time risk monitor for a Base DeFi protocol — TVL changes, exploit signals, governance risks.",
    inputSchema: { type: "object", properties: { protocol: { type: "string", description: "Protocol name or contract address" } }, required: ["protocol"] },
  },
  // ── Multi-agent ───────────────────────────────────────────────────────────
  {
    name: "hub_multi_agent",
    description: "Orchestrate a multi-agent workflow — route tasks across Blue Agent + Aeon + MiroShark for complex analysis.",
    inputSchema: { type: "object", properties: { task: { type: "string", description: "Task for the agent collective" } }, required: ["task"] },
  },
  {
    name: "hub_agent_match",
    description: "Find the best collaborator agent for a task — match your project with Base agents by capability.",
    inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
  },
  {
    name: "hub_agent_perf",
    description: "Performance report for an AI agent — grounded in REAL GitHub activity (stars/commits/recency) when a repo is supplied; otherwise a labelled estimate.",
    inputSchema: { type: "object", properties: { agent: { type: "string", description: "Agent handle or name" }, repo: { type: "string", description: "GitHub repo (owner/name or URL) to ground the report in real activity" } }, required: ["agent"] },
  },
  // ── Community ─────────────────────────────────────────────────────────────
  {
    name: "hub_community_growth",
    description: "Community growth playbook — channels, content strategy, retention loops, milestones for a Base project.",
    inputSchema: { type: "object", properties: { project: { type: "string" }, current_size: { type: "string", description: "Current size (optional)" } }, required: ["project"] },
  },
  {
    name: "hub_thread_intel",
    description: "Thread intelligence — analyze a CT thread or topic for signal vs noise, key takes, actionable insights.",
    inputSchema: { type: "object", properties: { thread: { type: "string", description: "Thread URL or topic" } }, required: ["thread"] },
  },
  {
    name: "hub_narrative_pulse",
    description: "Real-time narrative pulse — what's being talked about right now on Base CT, velocity and sentiment.",
    inputSchema: { type: "object", properties: { focus: { type: "string", description: "Topic or token to focus on (optional)" } } },
  },
  // ── Catalog parity — Builder & Base ecosystem (extended) ──────────────────
  {
    name: "hub_stack",
    description: "Stack Recommender — optimal tech stack for a Base build: infra, tooling, protocols, integrations.",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "Project type, e.g. DeFi protocol, AI agent, consumer app" }, description: { type: "string", description: "What you're building (optional)" }, team_size: { type: "string", description: "Team size (optional)" }, timeline: { type: "string", description: "Constraints / timeline (optional)" } }, required: ["project"] },
  },
  {
    name: "hub_protocol_compare",
    description: "Base Protocol Comparison — side-by-side of two Base protocols for integrations/partnerships; grounded in DefiLlama TVL where matched.",
    inputSchema: { type: "object", properties: { protocol_a: { type: "string", description: "First protocol, e.g. Aerodrome" }, protocol_b: { type: "string", description: "Second protocol, e.g. Morpho" }, use_case: { type: "string", description: "Your use case (optional)" } }, required: ["protocol_a", "protocol_b"] },
  },
  // ── Catalog parity — On-chain & Earn (extended) ───────────────────────────
  {
    name: "hub_airdrop",
    description: "Airdrop Check — Base airdrop eligibility for a wallet: which protocols, activity score, estimated value.",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "Wallet address 0x..." } }, required: ["address"] },
  },
  {
    name: "hub_dex_flow",
    description: "DEX Flow — volume, buy/sell pressure and liquidity flow for a Base token. Live DexScreener data.",
    inputSchema: { type: "object", properties: { token: { type: "string", description: "Token contract address 0x... or ticker" } }, required: ["token"] },
  },
  {
    name: "hub_lp_analyzer",
    description: "LP Analyzer — impermanent loss, fee income and rebalance recommendation for a liquidity position.",
    inputSchema: { type: "object", properties: { token0: { type: "string", description: "Token 0, e.g. ETH or 0x..." }, token1: { type: "string", description: "Token 1, e.g. USDC or 0x... (optional)" }, entryPrice: { type: "string", description: "Entry price (optional)" }, investedAmount: { type: "string", description: "Invested amount in USD (optional)" } }, required: ["token0"] },
  },
  // ── Catalog parity — Alerts (extended) ────────────────────────────────────
  // ── Catalog parity — Launch & grants (extended) ───────────────────────────
  {
    name: "hub_launch_sim_tier2",
    description: "Launch Simulator (Tier 2) — deep launch simulation with live DexScreener market data: price, volume, liquidity.",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "Project name" }, description: { type: "string", description: "What it does, audience, stage (optional)" }, ticker: { type: "string", description: "Token ticker (optional)" }, contract: { type: "string", description: "Contract 0x... for live data (optional)" } }, required: ["project"] },
  },
  {
    name: "hub_launch_sim_tier3",
    description: "Launch Simulator (Tier 3) — full multi-agent launch report with risk matrix and timeline recommendation.",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "Project name" }, description: { type: "string", description: "What it does, audience, stage (optional)" }, ticker: { type: "string", description: "Token ticker (optional)" }, contract: { type: "string", description: "Contract 0x... for live data (optional)" } }, required: ["project"] },
  },
  {
    name: "hub_grant_eval",
    description: "Grant Evaluator — Base ecosystem grant scoring: innovation, feasibility, impact, team quality.",
    inputSchema: { type: "object", properties: { projectName: { type: "string", description: "Project name" }, description: { type: "string", description: "What you're building and why it matters for Base" }, teamBackground: { type: "string", description: "Team background (optional)" }, requestedAmount: { type: "string", description: "Requested grant amount (optional)" }, milestones: { type: "string", description: "Milestones (optional)" }, githubUrl: { type: "string", description: "GitHub URL (optional)" } }, required: ["projectName", "description"] },
  },
  // ── B20 / Beryl ───────────────────────────────────────────────────────────
  {
    name: "hub_b20_analyze",
    description: "B20 (Base Native Token Standard) guide — variants, roles, policies, integration tips. Powered by Beryl upgrade docs. Optionally analyze a specific contract address.",
    inputSchema: { type: "object", properties: { action: { type: "string", description: "guide | roles | policy | analyze | compare (default: guide)" }, address: { type: "string", description: "Token contract address 0x... (optional)" }, context: { type: "string", description: "Your use case or question (optional)" } } },
  },
  {
    name: "hub_b20_tracker",
    description: "Live B20 activity on Base — B20-related token launches and Beryl activation status. Distinguishes B20-themed tokens from the native B20 standard.",
    inputSchema: { type: "object", properties: {} },
  },
  // ── On-chain primitives & data (new batch) ────────────────────────────────
  {
    name: "hub_token_price",
    description: "Live price, market cap, volume and liquidity for any Base token (DexScreener).",
    inputSchema: { type: "object", properties: { token: { type: "string", description: "Token contract address 0x... or ticker" } }, required: ["token"] },
  },
  {
    name: "hub_pool_scan",
    description: "Trending + newly-active Base pools with the chain TVL snapshot.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "Number of pools to return (default 10)" } } },
  },
  {
    name: "hub_wallet_holdings",
    description: "Live ERC-20 and ETH holdings with USD values for a Base wallet (Moralis).",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "Wallet address 0x..." } }, required: ["address"] },
  },
  {
    name: "hub_new_pools",
    description: "Freshly-created Base pools with thin-liquidity honeypot flags.",
    inputSchema: { type: "object", properties: { hours: { type: "number", description: "Window in hours (default 24)" } } },
  },
  {
    name: "hub_gas_tracker",
    description: "Live Base gas price and USD cost estimates for common actions (transfer, swap, deploy).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hub_quick_safety",
    description: "Fast contract safety check — liquidity, Basescan verification, and risk verdict.",
    inputSchema: { type: "object", properties: { contract: { type: "string", description: "Contract address 0x..." } }, required: ["contract"] },
  },
  {
    name: "hub_wallet_risk",
    description: "AML / risk screen for a Base wallet from real on-chain flow (Moralis).",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "Wallet address 0x..." } }, required: ["address"] },
  },
  {
    name: "hub_b20_check",
    description: "ERC-20 compliance (B20) role and policy detection from verified contract source.",
    inputSchema: { type: "object", properties: { contract: { type: "string", description: "Contract address 0x..." } }, required: ["contract"] },
  },
  {
    name: "hub_b20_launch",
    description: "Generate complete B20 token deployment package — foundry.toml, Solidity deploy script, setup + deploy + mint commands. Supports asset and stablecoin variants.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Token name" }, symbol: { type: "string", description: "Token symbol, e.g. MTK" }, variant: { type: "string", enum: ["asset", "stablecoin"], description: "B20 variant" }, decimals: { type: "number", description: "Decimals (default 18)" }, supply_cap: { type: "number", description: "Max supply (optional)" }, currency_code: { type: "string", description: "Currency code for stablecoin variant, e.g. USD" } }, required: ["name", "symbol", "variant"] },
  },
  // ── B20 calldata builders (MCP-native, free — pure encoders, non-custodial) ──
  // Return { to, data, value } ready for an EIP-5792 send_calls / Base MCP wallet
  // call. The user signs in their own wallet; we never hold keys. No x402 payment.
  {
    name: "b20_encode_deploy",
    description: "Encode a B20 token deployment (createB20). Returns { to, data, value } for the admin wallet to sign via EIP-5792 send_calls / Base MCP — after deploy the admin owns the token and holds MINT_ROLE. Pure calldata builder: no keys, no payment. Run b20_check_activation first — createB20 reverts until B20 is active on the target chain.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Token name" },
      symbol: { type: "string", description: "Token symbol, e.g. MTK" },
      variant: { type: "string", enum: ["asset", "stablecoin"], description: "asset = configurable decimals 6-18; stablecoin = fixed 6 decimals + currency" },
      admin: { type: "string", description: "0x wallet that signs the deploy and owns the token" },
      decimals: { type: "number", description: "Decimals 6-18 (asset only, default 18)" },
      currency_code: { type: "string", description: "3-letter currency, e.g. USD (stablecoin only)" },
      supply_cap: { type: "string", description: "Max total supply in whole tokens (optional, omit for no cap)" },
      initial_supply: { type: "string", description: "Seed-mint to admin at deploy, in whole tokens (optional)" },
      chainId: { type: "number", description: "8453 = Base Mainnet (default), 84532 = Base Sepolia" },
    }, required: ["name", "symbol", "variant", "admin"] },
  },
  {
    name: "b20_encode_mint",
    description: "Encode a mint on an existing B20 token. Returns { to, data, value } for a wallet holding MINT_ROLE to sign. Optional onchain memo (mintWithMemo). Pure calldata builder — no keys, no payment.",
    inputSchema: { type: "object", properties: {
      tokenAddress: { type: "string", description: "B20 token contract 0x..." },
      to: { type: "string", description: "Recipient 0x..." },
      amount: { type: "string", description: "Amount in whole tokens, e.g. '1000'" },
      decimals: { type: "number", description: "Token decimals" },
      memo: { type: "string", description: "Optional onchain memo, max 31 chars (uses mintWithMemo)" },
    }, required: ["tokenAddress", "to", "amount", "decimals"] },
  },
  {
    name: "b20_encode_grant_mint_role",
    description: "Encode grantRole(MINT_ROLE, account) on a B20 token. Returns { to, data, value } for the DEFAULT_ADMIN_ROLE holder to sign. Pure calldata builder — no keys, no payment.",
    inputSchema: { type: "object", properties: {
      tokenAddress: { type: "string", description: "B20 token contract 0x..." },
      account: { type: "string", description: "0x address to grant MINT_ROLE" },
    }, required: ["tokenAddress", "account"] },
  },
  {
    name: "b20_encode_payment",
    description: "Encode transferWithMemo — send B20 tokens with an onchain memo (order id) for reconciliation. Returns { to, data, value } for the sender to sign. Pure calldata builder — no keys, no payment.",
    inputSchema: { type: "object", properties: {
      tokenAddress: { type: "string", description: "B20 token contract 0x..." },
      to: { type: "string", description: "Recipient 0x..." },
      amount: { type: "string", description: "Amount in whole tokens" },
      decimals: { type: "number", description: "Token decimals (default 6)" },
      memo: { type: "string", description: "Onchain memo / order id, max 31 chars" },
    }, required: ["tokenAddress", "to", "amount", "memo"] },
  },
  {
    name: "b20_check_activation",
    description: "Check whether the B20 ASSET and STABLECOIN standards are activated on Base mainnet or Sepolia — read live from the on-chain ActivationRegistry (isActivated). No wallet, no payment.",
    inputSchema: { type: "object", properties: {
      chainId: { type: "number", description: "8453 = Base Mainnet (default), 84532 = Base Sepolia" },
    } },
  },
  {
    name: "b20_read_token",
    description: "Inspect a B20 token live from Base RPC via multicall — isB20 check, name/symbol/decimals, total supply, supply cap, variant, per-feature pause status, and per-scope policy gating. Deterministic on-chain read (zero LLM). No wallet, no payment.",
    inputSchema: { type: "object", properties: {
      tokenAddress: { type: "string", description: "Token contract 0x..." },
      chainId: { type: "number", description: "8453 = Base Mainnet (default), 84532 = Base Sepolia" },
      account: { type: "string", description: "Optional wallet 0x... — checks whether it holds DEFAULT_ADMIN_ROLE" },
    }, required: ["tokenAddress"] },
  },
  {
    name: "b20_encode_burn",
    description: "Encode burnWithMemo — burn B20 tokens from the caller's own balance with an on-chain memo. Returns { to, data, value } for a wallet holding BURN_ROLE to sign. Pure calldata builder — no keys, no payment.",
    inputSchema: { type: "object", properties: {
      tokenAddress: { type: "string", description: "B20 token contract 0x..." },
      amount: { type: "string", description: "Amount in whole tokens" },
      decimals: { type: "number", description: "Token decimals" },
      memo: { type: "string", description: "On-chain memo, max 31 chars" },
    }, required: ["tokenAddress", "amount", "decimals", "memo"] },
  },
  {
    name: "hub_liquidity_depth",
    description: "Liquidity depth, slippage estimate and exit risk for a Base token.",
    inputSchema: { type: "object", properties: { token: { type: "string", description: "Token contract address 0x... or ticker" } }, required: ["token"] },
  },
  {
    name: "hub_token_distribution",
    description: "Holder concentration and rug-risk distribution score for a Base token (Moralis holders).",
    inputSchema: { type: "object", properties: { contract: { type: "string", description: "Token contract address 0x..." } }, required: ["contract"] },
  },
  {
    name: "hub_base_alpha",
    description: "Base market alpha — narratives, momentum picks, divergence signals. No inputs needed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hub_token_alpha",
    description: "Token trade signal — entry, whale confirmation, momentum and risk for a specific Base token.",
    inputSchema: { type: "object", properties: { token: { type: "string", description: "Token contract address 0x... or ticker" } }, required: ["token"] },
  },
  {
    name: "hub_protocol_health",
    description: "Protocol TVL health, trend and risk signals from DefiLlama.",
    inputSchema: { type: "object", properties: { protocol: { type: "string", description: "Protocol name, e.g. Aerodrome" } }, required: ["protocol"] },
  },
  {
    name: "hub_founder_check",
    description: "GitHub-based founder trust score — repos, stars, commit activity.",
    inputSchema: { type: "object", properties: { handle: { type: "string", description: "GitHub handle" } }, required: ["handle"] },
  },
  {
    name: "hub_narrative_live",
    description: "Live Base narrative phases, velocity and entry windows — real-time tracking of what's building vs peaking.",
    inputSchema: { type: "object", properties: { focus: { type: "string", description: "Narrative focus (optional), e.g. AI agents, RWA, DeFi" } } },
  },
  {
    name: "hub_base_activity",
    description: "Onchain activity score and tier for a Base wallet (Moralis).",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "Wallet address 0x..." } }, required: ["address"] },
  },
  {
    name: "hub_scam_detector",
    description: "Detect honeypot, rug and fake-token patterns on a Base contract.",
    inputSchema: { type: "object", properties: { contract: { type: "string", description: "Contract address 0x..." } }, required: ["contract"] },
  },
  {
    name: "hub_cross_yield",
    description: "Best Base yield for a token across protocols (DefiLlama) with risk-adjusted ranking.",
    inputSchema: { type: "object", properties: { token: { type: "string", description: "Token address 0x... or ticker" }, risk_tolerance: { type: "string", enum: ["low", "medium", "high"], description: "Risk tolerance (default medium)" } }, required: ["token"] },
  },
  {
    name: "hub_agent_readiness",
    description: "x402 and MCP readiness probe for an agent endpoint — checks payment support, protocol compliance, and integration.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "Agent endpoint URL https://..." } }, required: ["url"] },
  },
  {
    name: "hub_base_pulse",
    description: "Base chain market pulse — TVL, DEX volume, sentiment, pulse score. No inputs needed.",
    inputSchema: { type: "object", properties: {} },
  },
  // ── Utility ───────────────────────────────────────────────────────────────
  {
    name: "blue_score",
    description: "Builder Score for a GitHub/Farcaster handle or wallet address on Base (0-100).",
    inputSchema: { type: "object", properties: { handle: { type: "string", description: "Handle or wallet address" } }, required: ["handle"] },
  },
  {
    name: "blue_new",
    description: "Scaffold a new Base project. Templates: base-agent | base-x402 | base-token.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project directory name" },
        type: { type: "string", enum: ["base-agent", "base-x402", "base-token"] },
      },
      required: ["name", "type"],
    },
  },
  {
    name: "blue_monitor",
    description: "On-demand health + risk snapshot for a Base token/contract — live price, liquidity, Basescan verification, risk signals + a watch plan with alert thresholds.",
    inputSchema: { type: "object", properties: { target: { type: "string", description: "Base token/contract address (0x…) or a protocol/token name" }, focus: { type: "string", description: "Optional focus, e.g. liquidity or exit risk" } }, required: ["target"] },
  },
  {
    name: "blue_registry",
    description: "Discover the Blue Hub tool catalog — every callable x402 tool (first-party + community), filterable by query/category, with prices and how-to-call.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Optional search term" }, category: { type: "string", description: "Optional category filter" } } },
  },
  {
    name: "blue_research",
    description: "Deep DD memo on a Base project, narrative, or token — thesis, bull/bear, risks, contrarian take, verdict. Grounds in live DexScreener data when a token address is given.",
    inputSchema: { type: "object", properties: { topic: { type: "string", description: "Project, narrative, or token to research" }, target: { type: "string", description: "Optional 0x token address to ground in live market data" } }, required: ["topic"] },
  },
  {
    name: "blue_compose",
    description: "Turn a goal into a runnable chain of Blue Hub tools — picks from the real catalog, orders the steps, suggests inputs, and estimates cost.",
    inputSchema: { type: "object", properties: { goal: { type: "string", description: "What you want to accomplish on Base" } }, required: ["goal"] },
  },
  {
    name: "blue_deploy",
    description: "Technical deploy mechanics for Base mainnet — deploy scripts, Basescan verify commands, env vars, gas notes, post-deploy checks. Never invents addresses.",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "What you're deploying (contract/app + stack)" }, stack: { type: "string", description: "Optional: Foundry, Hardhat, viem…" } }, required: ["project"] },
  },
  {
    name: "blue_analytics",
    description: "Performance/metrics read on a Base token — live price, momentum, liquidity health, volume/liquidity ratio, growth signals. Real DexScreener data.",
    inputSchema: { type: "object", properties: { target: { type: "string", description: "Base token contract address (0x…)" }, focus: { type: "string", description: "Optional focus" } }, required: ["target"] },
  },
  {
    name: "blue_simulate",
    description: "Bull/base/bear scenario modeling for a Base decision — tokenomics, fee model, growth, runway — with assumptions, projections, and sensitivities.",
    inputSchema: { type: "object", properties: { scenario: { type: "string", description: "The decision/model to simulate" }, params: { type: "string", description: "Optional parameters/values" } }, required: ["scenario"] },
  },
  {
    name: "blue_stream",
    description: "Live snapshot feed of Base onchain activity — trending & new pools, TVL, real price/volume/liquidity. Pure real data; poll for a near-real-time feed.",
    inputSchema: { type: "object", properties: { feed: { type: "string", description: "movers | new | all (default movers)" } } },
  },
];

// ─── Tool → hub ID map ────────────────────────────────────────────────────────

const HUB_MAP: Record<string, string> = {
  hub_agent_score:      "agent-score",
  hub_market_fit:       "market-fit",
  hub_token_pick:       "token-pick-signal",
  hub_narrative:        "narrative-position",
  hub_ecosystem:        "ecosystem-digest",
  hub_competitor_scan:  "competitor-scan",
  hub_investor_memo:    "investor-memo",
  hub_repo_health:      "repo-health",
  hub_base_grant:       "base-grant-finder",
  hub_risk_gate:        "risk-gate",
  hub_honeypot:         "honeypot-check",
  hub_deep_analysis:    "deep-analysis",
  hub_whale_signal:     "whale-copy-signal",
  hub_fundraise_timing: "fundraise-timing",
  // Security (extended)
  hub_contract_trust:       "contract-trust",
  hub_aml_screen:           "aml-screen",
  hub_key_exposure:         "key-exposure",
  // Research (extended)
  hub_token_momentum:       "token-momentum-scanner",
  hub_whale_tracker:        "whale-tracker",
  hub_community_sentiment:  "community-sentiment",
  // Builder (extended)
  hub_launch_simulator:     "launch-simulator-1",
  hub_token_launch:         "token-launch-readiness",
  hub_builder_dd:           "builder-deep-dd",
  hub_roadmap:              "roadmap-validator",
  hub_gtm:                  "gtm-brief",
  hub_pitch_intel:          "pitch-intelligence",
  // Premium
  hub_defi_opportunity:     "defi-opportunity",
  hub_protocol_risk:        "protocol-risk-monitor",
  // Multi-agent
  hub_multi_agent:          "multi-agent-workflow",
  hub_agent_match:          "agent-collab-match",
  hub_agent_perf:           "agent-performance",
  // Community
  hub_community_growth:     "community-growth-playbook",
  hub_thread_intel:         "thread-intelligence",
  hub_narrative_pulse:      "narrative-position",
  // Blue first-party (extended)
  blue_monitor:             "blue-monitor",
  blue_registry:            "blue-registry",
  blue_research:            "blue-research",
  blue_compose:             "blue-compose",
  blue_deploy:              "blue-deploy",
  blue_analytics:           "blue-analytics",
  blue_simulate:            "blue-simulate",
  blue_stream:              "blue-stream",
  // Catalog parity (extended) — every remaining first-party catalog tool
  hub_stack:                "stack-recommender",
  hub_protocol_compare:     "base-protocol-comparison",
  hub_airdrop:              "airdrop-check",
  hub_dex_flow:             "dex-flow",
  hub_lp_analyzer:          "lp-analyzer",
  hub_launch_sim_tier2:     "launch-simulator-2",
  hub_launch_sim_tier3:     "launch-simulator-3",
  hub_grant_eval:           "grant-evaluator",
  // B20 / Beryl
  hub_b20_analyze:          "b20-analyze",
  hub_b20_tracker:          "b20-tracker",
  // On-chain primitives & data (new batch)
  hub_token_price:          "token-price",
  hub_pool_scan:            "pool-scan",
  hub_wallet_holdings:      "wallet-holdings",
  hub_new_pools:            "new-pools",
  hub_gas_tracker:          "gas-tracker",
  hub_quick_safety:         "quick-safety",
  hub_wallet_risk:          "wallet-risk",
  hub_b20_check:            "b20-check",
  hub_b20_launch:           "b20-launch",
  hub_liquidity_depth:      "liquidity-depth",
  hub_token_distribution:   "token-distribution",
  hub_base_alpha:           "base-alpha",
  hub_token_alpha:          "token-alpha",
  hub_protocol_health:      "protocol-health",
  hub_founder_check:        "founder-check",
  hub_narrative_live:       "narrative-pulse",
  hub_base_activity:        "base-activity-score",
  hub_scam_detector:        "scam-detector",
  hub_cross_yield:          "cross-protocol-yield",
  hub_agent_readiness:      "agent-readiness",
  hub_base_pulse:           "base-pulse",
};

const CONSOLE_MAP: Record<string, string> = {
  blue_idea:  "idea",
  blue_build: "build",
  blue_audit: "audit",
  blue_ship:  "ship",
  blue_raise: "raise",
};

// ─── Internal API callers ─────────────────────────────────────────────────────

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "https://blueagent.dev";

// Some MCP tool schemas use agent-friendly field names (task, agent, pitch,
// target, handle) that differ from the handler's expected body fields. Map them
// here, keyed by handler id, so the MCP path doesn't 400. The Hub-UI path
// already sends the correct fields, so this only touches MCP calls.
const ARG_REMAP: Record<string, (a: Record<string, unknown>) => Record<string, unknown>> = {
  "repo-health":          (a) => ({ ...a, repo: a.repo ?? a.url }),
  "community-sentiment":  (a) => ({ ...a, project: a.project ?? a.target }),
  "builder-deep-dd":      (a) => ({ ...a, target: a.target ?? a.handle }),
  "roadmap-validator":    (a) => ({ ...a, project: a.project ?? "this project", roadmap: a.roadmap }),
  "gtm-brief":            (a) => ({ ...a, project: a.project, description: a.description ?? a.target ?? a.project }),
  "pitch-intelligence":   (a) => ({ ...a, project: a.project ?? a.pitch, description: a.description ?? a.pitch }),
  "multi-agent-workflow": (a) => ({ ...a, goal: a.goal ?? a.task }),
  "agent-collab-match":   (a) => ({ ...a, agent_a: a.agent_a ?? a.task, agent_b: a.agent_b ?? "best-fit Base ecosystem agent", collab_goal: a.collab_goal ?? a.task }),
  "agent-performance":    (a) => ({ ...a, handle: a.handle ?? a.agent }),
  // Catalog parity (extended) — mirror each tool's x402Body so MCP calls match
  // the handler's expected body exactly (same contract the Hub UI sends).
  "stack-recommender":        (a) => ({ ...a, description: a.description ?? a.project, team_size: a.team_size ?? "1", timeline: a.timeline ?? "" }),
  "base-protocol-comparison": (a) => ({ ...a, category: a.category ?? "Base DeFi", use_case: a.use_case ?? "" }),
  "lp-analyzer":              (a) => ({ ...a, token1: a.token1 ?? "", entryPrice: a.entryPrice ?? "", investedAmount: a.investedAmount ?? "" }),
  "launch-simulator-2":       (a) => ({ ...a, description: a.description ?? "", ticker: a.ticker ?? "", contract: a.contract ?? "" }),
  "launch-simulator-3":       (a) => ({ ...a, description: a.description ?? "", ticker: a.ticker ?? "", contract: a.contract ?? "" }),
  "grant-evaluator":          (a) => ({ ...a, teamBackground: a.teamBackground ?? "", requestedAmount: a.requestedAmount ?? "", milestones: a.milestones ?? "", githubUrl: a.githubUrl ?? "" }),
  // On-chain primitives & data (new batch) — numeric coercions + defaults
  "pool-scan":               (a) => ({ ...a, limit: a.limit !== undefined ? Number(a.limit) : 10 }),
  "new-pools":               (a) => ({ ...a, hours: a.hours !== undefined ? Number(a.hours) : 24 }),
  "b20-launch":              (a) => ({ ...a, decimals: a.decimals !== undefined ? Number(a.decimals) : undefined, supply_cap: a.supply_cap !== undefined ? Number(a.supply_cap) : undefined }),
  "cross-protocol-yield":    (a) => ({ ...a, risk_tolerance: a.risk_tolerance ?? "medium" }),
  "narrative-pulse":         (a) => ({ ...a, focus: a.focus ?? "" }),
  "base-alpha":              (a) => a,
  "base-pulse":              (a) => a,
};

/**
 * Typed error thrown from callHubTool → caught by tools/call → surfaced with
 * `isError: true`. Existed as a plain text stub before; a naive MCP client
 * would hand the stub back to the LLM as if it were tool output, so the LLM
 * "answered" with instructions to set env vars. isError kills that path.
 *
 * `code` categories:
 *   WALLET_REQUIRED       — bypass headers correct, but no user connected +
 *                           tool costs credits. Real fix is server-side
 *                           (this is what MCP tripped on Jul → now).
 *   INSUFFICIENT_CREDITS  — user connected via chat has empty ledger.
 *   MISSING_KEY           — INTERNAL_SERVICE_KEY unset in this deploy; free
 *                           bypass impossible; user should pay via /hub.
 *   PAYMENT_REQUIRED      — generic 402 fallback.
 *   UPSTREAM              — non-402 non-2xx from x402 route.
 */
class HubToolError extends Error {
  code: "WALLET_REQUIRED" | "INSUFFICIENT_CREDITS" | "MISSING_KEY" | "PAYMENT_REQUIRED" | "UPSTREAM";
  constructor(code: HubToolError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

async function callHubTool(toolId: string, rawArgs: Record<string, unknown>): Promise<string> {
  const args = ARG_REMAP[toolId] ? ARG_REMAP[toolId](rawArgs) : rawArgs;

  // Single source of truth for server-to-server x402 bypass headers. Ships
  // BOTH X-Blue-Internal AND X-Blue-Service:internal — the x402 route's
  // WALLET_REQUIRED guard needs the second header even when the first is
  // correct. See apps/web/src/lib/x402-internal.ts.
  const res = await fetch(`${BASE}/api/x402/${toolId}`, {
    method: "POST",
    headers: internalX402Headers(),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();

  if (res.status === 402) {
    // Parse the x402 route's structured error so a specific message reaches
    // the LLM instead of the misleading "set INTERNAL_SERVICE_KEY" stub the
    // old code returned for every 402.
    let parsed: { code?: string; error?: string } = {};
    try { parsed = JSON.parse(text) as typeof parsed; } catch {}
    const code = parsed.code ?? "";
    if (code === "WALLET_REQUIRED") {
      throw new HubToolError(
        "WALLET_REQUIRED",
        `Tool "${toolId}" is a paid tool. Server-side config gap: MCP call reached the internal bypass but was blocked by the wallet guard. If you're an operator, verify both X-Blue-Internal and X-Blue-Service:internal are attached (see @/lib/x402-internal). If you're an agent, pay via https://blueagent.dev/hub.`,
      );
    }
    if (code === "INSUFFICIENT_CREDITS") {
      throw new HubToolError(
        "INSUFFICIENT_CREDITS",
        `Insufficient credits to call "${toolId}". Top up at https://blueagent.dev/chat or stake more BLUE for a bigger daily accrual.`,
      );
    }
    if (!hasInternalKey()) {
      throw new HubToolError(
        "MISSING_KEY",
        `Tool "${toolId}" requires payment (x402). Free MCP bypass is unavailable in this deployment (INTERNAL_SERVICE_KEY unset). Pay via https://blueagent.dev/hub.`,
      );
    }
    throw new HubToolError(
      "PAYMENT_REQUIRED",
      `Tool "${toolId}" returned 402 Payment Required. ${parsed.error ?? "Pay via https://blueagent.dev/hub."}`,
    );
  }
  if (res.status === 429) {
    throw new HubToolError("UPSTREAM", `Tool "${toolId}" rate-limited (429). Back off and retry.`);
  }
  if (!res.ok) {
    throw new HubToolError("UPSTREAM", `Tool "${toolId}" returned ${res.status}.`);
  }
  // Track MCP usage (paid path tracks via x402 route; internal path doesn't, so track here)
  try { await kv.incr(`usage:${toolId}`); } catch {}
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

async function callConsole(command: string, prompt: string): Promise<string> {
  const res = await fetch(`${BASE}/api/console`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, prompt }),
    // Stay under the route's maxDuration (120s) so a slow Bankr LLM aborts
    // cleanly and surfaces as a JSON-RPC error envelope, instead of the whole
    // function being killed at 120s → hard 504 → client retry storm.
    signal: AbortSignal.timeout(100_000),
  });
  if (!res.ok) throw new Error(`console/${command} returned ${res.status}`);
  const data = await res.json() as { result?: string; text?: string };
  return data.result ?? data.text ?? JSON.stringify(data);
}

async function callBuilderScore(handle: string): Promise<string> {
  const res = await fetch(`https://blueagent.dev/api/builder-score?handle=${encodeURIComponent(handle)}`);
  if (!res.ok) throw new Error(`Builder Score API: ${res.status}`);
  return JSON.stringify(await res.json(), null, 2);
}

// ─── B20 MCP-native calldata builders ─────────────────────────────────────────
// Pure encoders — no keys, no x402 payment, no INTERNAL_SERVICE_KEY needed. Each
// returns { to, data, value } for the user's own wallet to sign via EIP-5792
// send_calls / Base MCP. This is why they work FREE even when the paid hub_*
// tools are gated behind the payment bypass.

const B20_ENCODE_TOOLS = new Set([
  "b20_encode_deploy",
  "b20_encode_mint",
  "b20_encode_burn",
  "b20_encode_grant_mint_role",
  "b20_encode_payment",
  "b20_check_activation",
  "b20_read_token",
]);

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
function reqAddr(v: unknown, field: string): string {
  const s = String(v ?? "").trim();
  if (!ADDR_RE.test(s)) throw new Error(`${field} must be a 0x-prefixed 40-hex address`);
  return s;
}
function chainIdToNetwork(c: unknown): "mainnet" | "sepolia" {
  return Number(c) === 84532 ? "sepolia" : "mainnet";
}

async function callB20Native(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "b20_encode_deploy": {
      const variant = args.variant === "stablecoin" ? "stablecoin" : "asset";
      const admin = reqAddr(args.admin, "admin");
      const symbol = String(args.symbol ?? "").trim();
      const tokenName = String(args.name ?? "").trim();
      if (!tokenName) throw new Error("name is required");
      if (!symbol) throw new Error("symbol is required");
      const chainId = args.chainId !== undefined ? Number(args.chainId) : 8453;
      const built = buildB20Calldata({
        name: tokenName,
        symbol,
        variant,
        admin,
        decimals: args.decimals !== undefined ? Number(args.decimals) : undefined,
        currency_code: args.currency_code ? String(args.currency_code) : undefined,
        supply_cap: args.supply_cap ? String(args.supply_cap) : undefined,
        initial_supply: args.initial_supply ? String(args.initial_supply) : undefined,
      });
      return JSON.stringify({
        to: built.factory,
        data: built.data,
        value: "0x0",
        chainId,
        salt: built.salt,
        decimals: built.decimals,
        variant,
        note: "Sign with the admin wallet via EIP-5792 send_calls / Base MCP. Run b20_check_activation first — createB20 reverts until B20 is active on this chain.",
      }, null, 2);
    }
    case "b20_encode_mint": {
      const tokenAddress = reqAddr(args.tokenAddress, "tokenAddress");
      const to = reqAddr(args.to, "to");
      const amount = String(args.amount ?? "").trim();
      if (!amount) throw new Error("amount is required");
      const decimals = Number(args.decimals);
      if (!Number.isFinite(decimals)) throw new Error("decimals is required");
      const memo = args.memo ? String(args.memo) : "";
      if (memo && !isValidMemo(memo)) throw new Error("memo must be non-empty and fit in 32 bytes (≤31 chars)");
      const data = memo
        ? encodeMintWithMemo({ to, amount, decimals, memo })
        : encodeMint({ to, amount, decimals });
      return JSON.stringify({
        to: tokenAddress,
        data,
        value: "0x0",
        note: `Sign with a wallet holding MINT_ROLE.${memo ? " Uses mintWithMemo." : ""}`,
      }, null, 2);
    }
    case "b20_encode_burn": {
      const tokenAddress = reqAddr(args.tokenAddress, "tokenAddress");
      const amount = String(args.amount ?? "").trim();
      if (!amount) throw new Error("amount is required");
      const decimals = Number(args.decimals);
      if (!Number.isFinite(decimals)) throw new Error("decimals is required");
      const memo = String(args.memo ?? "").trim();
      if (!isValidMemo(memo)) throw new Error("memo must be non-empty and fit in 32 bytes (≤31 chars)");
      return JSON.stringify({
        to: tokenAddress,
        data: encodeBurnWithMemo({ amount, decimals, memo }),
        value: "0x0",
        note: "Sign with a wallet holding BURN_ROLE. Burns from the caller's own balance.",
      }, null, 2);
    }
    case "b20_encode_grant_mint_role": {
      const tokenAddress = reqAddr(args.tokenAddress, "tokenAddress");
      const account = reqAddr(args.account, "account");
      return JSON.stringify({
        to: tokenAddress,
        data: encodeGrantMintRole(account),
        value: "0x0",
        note: "Sign with the DEFAULT_ADMIN_ROLE holder. Grants MINT_ROLE to the account.",
      }, null, 2);
    }
    case "b20_encode_payment": {
      const tokenAddress = reqAddr(args.tokenAddress, "tokenAddress");
      const to = reqAddr(args.to, "to");
      const amount = String(args.amount ?? "").trim();
      if (!amount) throw new Error("amount is required");
      const memo = String(args.memo ?? "").trim();
      if (!isValidMemo(memo)) throw new Error("memo must be non-empty and fit in 32 bytes (≤31 chars)");
      const decimals = args.decimals !== undefined ? Number(args.decimals) : 6;
      return JSON.stringify({
        to: tokenAddress,
        data: encodeTransferWithMemo({ to, amount, decimals, memo }),
        value: "0x0",
        note: "Sign with the sender wallet. Emits a Memo event indexed by the order id for reconciliation.",
      }, null, 2);
    }
    case "b20_check_activation": {
      const network = chainIdToNetwork(args.chainId);
      const act = await getB20Activation(network);
      // act.ok === false ⟹ registry read failed → status UNKNOWN, never claim active.
      const known = act.ok;
      const asset = known ? act.asset : null;
      const stablecoin = known ? act.stablecoin : null;
      const live = known ? (act.asset || act.stablecoin) : null;
      return JSON.stringify({
        network,
        chainId: network === "sepolia" ? 84532 : 8453,
        known,
        live,
        asset,
        stablecoin,
        source: "on-chain ActivationRegistry 0x8453…0001 · isActivated",
        note: known
          ? (live ? "B20 is active — deploys will succeed." : "B20 is NOT yet active on this chain — createB20 will revert.")
          : "Could not read the ActivationRegistry right now — status unknown. Retry shortly.",
      }, null, 2);
    }
    case "b20_read_token": {
      const tokenAddress = reqAddr(args.tokenAddress, "tokenAddress");
      const network = chainIdToNetwork(args.chainId);
      const account = args.account ? reqAddr(args.account, "account") : undefined;
      const result = await inspectB20(tokenAddress, network, account);
      return JSON.stringify(result, null, 2);
    }
    default:
      throw new Error(`Unknown B20 tool: ${name}`);
  }
}

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

const JSON_HEADERS = {
  "Content-Type":                 "application/json",
  "Access-Control-Allow-Origin":  "*",
  "Cache-Control":                "no-store",
};

const SSE_HEADERS = {
  "Content-Type":                 "text/event-stream",
  "Cache-Control":                "no-cache, no-transform",
  "Connection":                   "keep-alive",
  "Access-Control-Allow-Origin":  "*",
  "X-Accel-Buffering":            "no", // disable nginx buffering
};

/** Wrap a JSON-RPC envelope as a single SSE `message` event. */
function sseEnvelope(envelope: object): string {
  return `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/** True if the client prefers SSE (Streamable HTTP per MCP 2025-03-26). */
function wantsSse(req: NextRequest): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/event-stream");
}

function respond(envelope: object, useSse: boolean): NextResponse {
  if (useSse) {
    return new NextResponse(sseEnvelope(envelope), { headers: SSE_HEADERS });
  }
  return new NextResponse(JSON.stringify(envelope), { headers: JSON_HEADERS });
}

function ok(id: unknown, result: unknown, useSse = false) {
  return respond({ jsonrpc: "2.0", id, result }, useSse);
}

function err(id: unknown, code: number, message: string, useSse = false) {
  return respond({ jsonrpc: "2.0", id, error: { code, message } }, useSse);
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { success } = await rateLimit(getIdentifier(req), "api");
  if (!success) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  const useSse = wantsSse(req);

  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
  try { body = await req.json(); }
  catch { return err(null, -32700, "Parse error", useSse); }

  const { id, method, params } = body;
  const p = (params ?? {}) as Record<string, unknown>;

  // ── initialize ──────────────────────────────────────────────────────────────
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "blue-agent", version: "1.0.0" },
      instructions: `Blue Agent MCP server — ${TOOLS.length} tools for Base builders. Docs: https://blueagent.dev/.well-known/openapi.json`,
    }, useSse);
  }

  if (method === "notifications/initialized") {
    return new NextResponse(null, { status: 202, headers: { "Access-Control-Allow-Origin": "*" } });
  }

  // ── ping ────────────────────────────────────────────────────────────────────
  if (method === "ping") {
    return ok(id, {}, useSse);
  }

  // ── tools/list ──────────────────────────────────────────────────────────────
  if (method === "tools/list") {
    return ok(id, { tools: TOOLS }, useSse);
  }

  // ── tools/call ──────────────────────────────────────────────────────────────
  if (method === "tools/call") {
    const name = p.name as string;
    const args = (p.arguments ?? {}) as Record<string, unknown>;

    if (!name) return err(id, -32602, "tools/call requires name", useSse);

    try {
      // Console tools
      const consoleCmd = CONSOLE_MAP[name];
      if (consoleCmd) {
        const prompt = args.prompt as string;
        if (!prompt) return err(id, -32602, "prompt is required", useSse);
        const text = await callConsole(consoleCmd, prompt);
        return ok(id, { content: [{ type: "text", text }] }, useSse);
      }

      // Hub tools
      const hubId = HUB_MAP[name];
      if (hubId) {
        const text = await callHubTool(hubId, args);
        return ok(id, { content: [{ type: "text", text }] }, useSse);
      }

      // blue_score
      if (name === "blue_score") {
        const handle = args.handle as string;
        if (!handle) return err(id, -32602, "handle is required", useSse);
        const text = await callBuilderScore(handle);
        return ok(id, { content: [{ type: "text", text }] }, useSse);
      }

      // blue_new — can't scaffold files server-side, explain how to use locally
      if (name === "blue_new") {
        const projectName = args.name as string;
        const type = args.type as string;
        return ok(id, {
          content: [{
            type: "text",
            text: [
              `To scaffold a ${type} project named "${projectName}", run locally:`,
              ``,
              `  npx @blueagent/skill`,
              `  # Then use blue_new tool in your local MCP session`,
              ``,
              `Or use the CLI:`,
              `  npm install -g @blueagent/cli`,
              `  blue new ${projectName} --template ${type}`,
            ].join("\n"),
          }],
        }, useSse);
      }

      // B20 MCP-native calldata builders (free — no x402, no bypass key)
      if (B20_ENCODE_TOOLS.has(name)) {
        const text = await callB20Native(name, args);
        return ok(id, { content: [{ type: "text", text }] }, useSse);
      }

      return err(id, -32601, `Unknown tool: ${name}`, useSse);

    } catch (e) {
      const err = e as Error & { code?: string };
      // HubToolError carries a machine-readable code (WALLET_REQUIRED,
      // INSUFFICIENT_CREDITS, MISSING_KEY, PAYMENT_REQUIRED, UPSTREAM); prefix
      // it so agents can dispatch on the code without regex-scraping the msg.
      const prefix = err.code ? `[${err.code}] ` : "Error: ";
      return ok(id, { content: [{ type: "text", text: `${prefix}${err.message}` }], isError: true }, useSse);
    }
  }

  return err(id, -32601, `Method not found: ${method}`, useSse);
}

// CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    },
  });
}

// GET — discovery + Streamable HTTP server→client stream
//
// When invoked by a browser / curl with `Accept: application/json`, returns
// discovery JSON for humans.
//
// When invoked with `Accept: text/event-stream` (MCP 2025-03-26 Streamable
// HTTP), the client is opening the server→client notification stream. We do
// NOT emit any server-initiated messages (no notifications/sampling), so per
// the spec we MUST return 405 — this tells the client "no server stream here"
// and it proceeds without holding a connection open.
//
// Previously we returned a never-closing SSE ReadableStream here. On serverless
// that kept the function alive until maxDuration (120s) for EVERY connected
// client, producing a ~2m P75 and a timeout/504 + retry storm on /api/mcp.
// Returning 405 is instant and loop-free.
export async function GET(req: NextRequest) {
  if (wantsSse(req)) {
    return new NextResponse(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Server-initiated SSE stream not supported" } }),
      { status: 405, headers: { ...JSON_HEADERS, Allow: "POST, OPTIONS" } },
    );
  }

  return NextResponse.json({
    name:        "Blue Agent MCP Server",
    version:     "1.0.0",
    protocol:    "MCP JSON-RPC 2.0 (Streamable HTTP, spec 2025-03-26)",
    tools:       TOOLS.length,
    tool_names:  TOOLS.map((t) => t.name),
    config: {
      claude_desktop: {
        mcpServers: {
          "blue-agent": { url: "https://blueagent.dev/api/mcp" },
        },
      },
      claude_code: "claude mcp add blue-agent --transport http https://blueagent.dev/api/mcp",
      mcp_remote: {
        mcpServers: {
          "blue-agent": {
            command: "npx",
            args:    ["-y", "mcp-remote", "https://blueagent.dev/api/mcp"],
          },
        },
      },
      cursor: "https://blueagent.dev/api/mcp",
    },
    docs: "https://blueagent.dev/.well-known/openapi.json",
  }, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
