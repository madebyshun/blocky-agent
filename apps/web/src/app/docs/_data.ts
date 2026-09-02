// Shared data for the Blue Agent docs. Single source of truth so each docs page
// stays thin and the numbers don't drift across pages.

import { TOOL_COUNT } from "@/lib/agent-tools";

export const STATS = [
  // Hub-tool count is dynamic (TOOL_COUNT). Every Hub tool is now x402, so the old
  // "x402 Tools" subset stat collapsed into Hub Tools — replaced with Commands (5)
  // to keep four distinct, non-redundant numbers.
  { value: String(TOOL_COUNT), label: "Hub Tools", color: "#4FC3F7" },
  { value: "5",                label: "Commands",  color: "#34D399" },
  { value: "57",               label: "MCP Tools", color: "#A78BFA" },
  { value: "3",                label: "Agents",    color: "#fbbf24" },
];

export const PRODUCTS = [
  { name: "Blue Hood", color: "#34D399", desc: "Oracle-vs-DEX drift · tokenized stocks on Base + RH · graded in public",  link: "/app/hood", label: "Open Hood →" },
  { name: "Blue Chat", color: "#A78BFA", desc: "AI agent chat · multi-model · skill-based · Built for RH + Base",         link: "/app/chat", label: "Open Chat →" },
  { name: "Blue Hub",  color: "#4FC3F7", desc: `${TOOL_COUNT} AI tools · live on-chain data · x402 pay-per-call · no API key`, link: "/app/hub",  label: "Open Hub →" },
];

export const FOUNDATION = [
  // Venice was removed from the fallback chain 2026-07-25 and Bankr was
  // 403-banned 2026-07-20; every LLM call now goes to Virtuals via
  // api/_lib/llm.ts → callLLM. This list used to name Venice as primary.
  { label: "Virtuals",   desc: "The LLM gateway — every x402 handler and chat call", color: "#22C55E" },
  { label: "x402",       desc: "Pay per call in USDC on Base — EIP-3009 via CDP",  color: "#34D399" },
  { label: "RH Chain",   desc: "Robinhood Chain (chain ID 4663) — RWA trading",    color: "#22C55E" },
  { label: "Base",       desc: "Base (chain ID 8453) — builder + token surface",   color: "#2563EB" },
  { label: "Moralis",    desc: "Wallet data, token holdings, tx history",          color: "#fbbf24" },
];

// One preset per use-case — kept 1:1 with VIRTUALS_PRESETS_V1 in
// app/chat/components/ChatInput.tsx (the authoritative picker). All inference
// runs on Virtuals; update both sites together.
export const CHAT_MODELS = [
  { icon: "💬", label: "Balanced", model: "Claude Sonnet 5",    note: "Default for most work · 200K ctx", cr: "50 cr",  color: "#4FC3F7" },
  { icon: "⚡", label: "Fast",     model: "DeepSeek V4 Flash",  note: "Cheapest · snappy · 1M ctx",       cr: "10 cr",  color: "#34D399" },
  { icon: "🔬", label: "Deep",     model: "Claude Opus 4.8",    note: "Heavy reasoning · 200K ctx",       cr: "200 cr", color: "#A78BFA" },
  { icon: "🔍", label: "Grok",     model: "Grok 4",             note: "Live web · 2M ctx",                cr: "60 cr",  color: "#E879F9" },
  { icon: "🔒", label: "Private",  model: "E2EE DeepSeek V4",   note: "E2EE · no logs · 1M ctx",          cr: "30 cr",  color: "#6EE7B7" },
];

export const CHAT_CAPABILITIES = [
  { t: "Slash commands", d: "/idea /build /audit /ship /raise · /pick /scan /wallet — same power as the CLI, inline." },
  { t: "Hub tools",      d: "Live token prices, whale flow, risk gate, wallet PnL — the Hub tools the model calls for you." },
  { t: "Personas",       d: "Swap the agent's expert role (Trader · Cipher · Oracle · Custom) without changing the model." },
  { t: "Web search",     d: "Toggle on to let the model pull live web data and cite sources (the Grok preset is built for live web)." },
];

export const TIERS = [
  { tier: "Guest",  need: "No wallet",    perk: "100 cr/day · ~10 messages",       color: "#64748b" },
  { tier: "Member", need: "Any wallet",   perk: "500 cr/day · no token needed",    color: "#4FC3F7" },
  { tier: "Packs",  need: "USDC on Base", perk: "Top up anytime · pay-per-credit", color: "#F59E0B" },
];

export const CORE_COMMANDS = [
  { cmd: "idea",  price: "$0.05", color: "#4FC3F7", desc: "Fundable brief" },
  { cmd: "build", price: "$0.50", color: "#A78BFA", desc: "Full architecture" },
  { cmd: "audit", price: "$1.00", color: "#f87171", desc: "Security review" },
  { cmd: "ship",  price: "$0.10", color: "#34D399", desc: "Deploy checklist" },
  { cmd: "raise", price: "$0.20", color: "#fbbf24", desc: "Pitch narrative" },
];

// Derived from packages/builder/src/cli.ts (the `blue` binary) + the CLI TUI.
export const COMMANDS_DOCS = [
  { group: "WORKFLOW", items: [
    { cmd: "blue idea [prompt]",  desc: "Concept → fundable brief (problem, why Base, MVP, risks, 24h plan)", example: 'blue idea "NFT marketplace for Base agents"' },
    { cmd: "blue build [prompt]", desc: "Brief → architecture + stack, folder structure, integrations",       example: 'blue build "Base-native staking protocol"' },
    { cmd: "blue audit [prompt]", desc: "Code → security review (reentrancy, oracle, MEV, go/no-go)",          example: 'blue audit "my Solidity contract"' },
    { cmd: "blue ship [prompt]",  desc: "Project → deploy checklist, verification, release notes, monitoring", example: 'blue ship "launch on Base mainnet"' },
    { cmd: "blue raise [prompt]", desc: "Idea → fundraising narrative, investor map, competitive landscape",   example: 'blue raise "Base DeFi protocol"' },
  ]},
  { group: "SETUP", items: [
    { cmd: "blue init",           desc: "Install skill files to ~/.blue-agent/skills/ for local grounding",    example: "blue init" },
    { cmd: "blue new <name>",     desc: "Scaffold a new Base project — base-agent | base-x402 | base-token",   example: "blue new my-token --template base-token" },
    { cmd: "blue doctor",         desc: "Check environment health — Node, skills, API key, config",            example: "blue doctor" },
    { cmd: "blue validate [dir]", desc: "Validate project structure — package.json, tsconfig, env, src/, git", example: "blue validate ./my-project" },
  ]},
  { group: "CHAT", items: [
    { cmd: "blue chat [prompt]",  desc: "Interactive chat with the Blue Agent LLM (Venice) in the terminal",  example: 'blue chat "how do I add x402 to my API?"' },
  ]},
  { group: "REPUTATION", items: [
    { cmd: "blue score [handle]",       desc: "Builder Score for a wallet or X handle",                        example: "blue score @blueagent_" },
    { cmd: "blue agent-score [input]",  desc: "Evaluate an agent's reliability score",                         example: "blue agent-score 0x…" },
    { cmd: "blue compare [a] [b]",      desc: "Compare two builders or agents side by side",                   example: "blue compare @a @b" },
  ]},
  { group: "DISCOVERY", items: [
    { cmd: "blue search [query]",   desc: "Search builders, agents, projects, tokens",                         example: 'blue search "base lending"' },
    { cmd: "blue trending [filter]", desc: "What's trending on Base right now",                                example: "blue trending tokens" },
    { cmd: "blue watch [target]",   desc: "Watch a wallet, handle, or token",                                  example: "blue watch 0x…" },
    { cmd: "blue alert [subcommand]", desc: "Configure threshold alerts",                                      example: "blue alert add" },
    { cmd: "blue history [input]",  desc: "Activity history for a builder or agent",                           example: "blue history @blueagent_" },
  ]},
  { group: "LAUNCH", items: [
    { cmd: "blue launch [mode]",      desc: "Launch a token or project on Base",                               example: "blue launch token" },
    { cmd: "blue market [subcommand]", desc: "Market intelligence for the Base ecosystem",                     example: "blue market movers" },
  ]},
  { group: "TASKS", items: [
    { cmd: "blue tasks",                       desc: "Browse open tasks on the Work Hub",                      example: "blue tasks" },
    { cmd: "blue post-task [handle]",          desc: "Post a task + escrow USDC",                              example: "blue post-task @myhandle" },
    { cmd: "blue accept [taskId] [handle]",    desc: "Accept an open task",                                    example: "blue accept task_abc123 @me" },
    { cmd: "blue submit [taskId] [h] [proof]", desc: "Submit proof of work and earn XP + USDC",                example: "blue submit task_abc123 @me https://github.com/…" },
  ]},
];

// The 35 core skill files in skills/ (the 5 aeon-*.md skills are documented
// separately on /docs/aeon-skills; 35 + 5 = the 40 total).
export const SKILLS_DOCS = [
  { file: "base-security.md",                 desc: "500+ security checks across 13 categories. Loaded for blue audit." },
  { file: "base-addresses.md",                desc: "Verified contract addresses on Base — USDC, WETH, Uniswap, Aave." },
  { file: "base-standards.md",                desc: "ERC standards, Base patterns, x402 protocol spec." },
  { file: "base-ecosystem.md",                desc: "Base ecosystem overview — key protocols, teams, infrastructure." },
  { file: "base-account-integration.md",      desc: "Coinbase Smart Wallet — ERC-4337, passkeys, sponsored txs." },
  { file: "account-abstraction-deep-dive.md", desc: "ERC-4337 deep dive — UserOps, bundlers, paymasters, EntryPoint." },
  { file: "x402-tools.md",                    desc: `The full ${TOOL_COUNT}-tool x402 hub — pricing, inputs, and how agents call each one.` },
  { file: "blue-agent-identity.md",           desc: "Blue Agent mission, product voice, do/don't rules." },
  { file: "design-system.md",                 desc: "Visual language, colors, card patterns, spacing." },
  { file: "x402-patterns.md",                 desc: "x402 payment patterns — pay-per-call APIs, pricing, flow." },
  { file: "x402-escrow-patterns.md",          desc: "x402 escrow — conditional payments, dispute resolution, release." },
  { file: "agent-wallet-security.md",         desc: "Security patterns for agent-controlled wallets." },
  { file: "agent-transaction-verification.md", desc: "Verify agent transactions before signing — simulation, intent checks." },
  { file: "wallet-guardrails.md",             desc: "Wallet guardrails for AI agents — spend limits, allowlists, approvals." },
  { file: "aerodrome-dex-guide.md",           desc: "Aerodrome DEX — pools, voting, bribes, LP strategy on Base." },
  { file: "aave-lending-patterns.md",         desc: "Aave v3 lending and borrowing patterns on Base." },
  { file: "uniswap-v4-hooks-guide.md",        desc: "Uniswap v4 hooks — lifecycle, pool manager, custom logic." },
  { file: "flashloan-patterns.md",            desc: "Flashloan fundamentals — callback structure, use cases." },
  { file: "flashloan-patterns-advanced.md",   desc: "Advanced flashloan strategies and attack vectors." },
  { file: "staking-yield-farming.md",         desc: "Staking and yield farming — vaults, rewards, compounding." },
  { file: "token-launch-guide.md",            desc: "Token launch — contract, Uniswap pool, liquidity, listing on Base." },
  { file: "solidity-security-patterns.md",    desc: "Solidity security — access control, overflow, reentrancy." },
  { file: "oracle-design-guide.md",           desc: "Oracle design — Chainlink, TWAP, price feed validation." },
  { file: "mev-protection-guide.md",          desc: "MEV protection — frontrun defense, slippage, commit-reveal." },
  { file: "mev-protection-advanced.md",       desc: "Advanced MEV protection — private orderflow, bundle strategies." },
  { file: "gas-optimization-guide.md",        desc: "Gas optimization — storage packing, calldata, assembly." },
  { file: "cross-chain-bridge-security.md",   desc: "Cross-chain bridge security — validation, trust assumptions, exploits." },
  { file: "governance-dao-patterns.md",       desc: "DAO governance — Governor, timelock, voting, quorum." },
  { file: "multi-sig-wallet-security.md",     desc: "Multi-sig — Safe, threshold signing, timelock, key rotation." },
  { file: "veil-privacy-transactions.md",     desc: "Privacy transactions — shielded transfers and ZK patterns on Base." },
  { file: "frames-miniapps.md",               desc: "Farcaster Frames and Base mini app development." },
  { file: "telegram-bot-patterns.md",         desc: "Telegram bot patterns — commands, webhooks, wallet linking." },
  { file: "gig-marketplace-guide.md",         desc: "On-chain gig/work marketplace — escrow, reputation, payouts." },
  { file: "postgres-for-agents.md",           desc: "Postgres for agents — schema design, indexing, pgvector." },
  { file: "reputation-engine.md",             desc: "Reputation engine — Builder Score, Agent Score, onchain signals." },
];

export const X402_SUITE = [
  { id: "blue-research",  price: "$1.00", color: "#60a5fa", desc: "Deep DD memo — grounds in live market data" },
  { id: "blue-compose",   price: "$0.10", color: "#34D399", desc: "Plan a runnable chain of Blue Hub tools" },
  { id: "blue-monitor",   price: "$0.20", color: "#f87171", desc: "Health + risk snapshot for a token/contract" },
  { id: "blue-deploy",    price: "$0.10", color: "#34D399", desc: "Base deploy mechanics — scripts, verify" },
  { id: "blue-analytics", price: "$0.25", color: "#60a5fa", desc: "Live token metrics + interpretation" },
  { id: "blue-simulate",  price: "$0.15", color: "#A78BFA", desc: "Bull/base/bear scenario modeling" },
  { id: "blue-stream",    price: "$0.05", color: "#34D399", desc: "Live Base onchain activity feed" },
  { id: "blue-registry",  price: "$0.05", color: "#fbbf24", desc: "Discover the full tool catalog" },
];

export const AEON_SKILLS = [
  { file: "aeon-token-movers",      color: "#34D399", trigger: '"what\'s pumping" · "top movers today" · pre-trade scan', desc: "Scans Base for the biggest movers right now — a fast pre-trade radar of what's running." },
  { file: "aeon-token-pick",        color: "#4FC3F7", trigger: '"give me a token pick" · "asymmetric setup today"',       desc: "Surfaces one asymmetric setup with a thesis — entry logic, why now, and the risk." },
  { file: "aeon-narrative-tracker", color: "#A78BFA", trigger: '"what\'s running on CT" · narrative positions · content', desc: "Tracks live crypto-Twitter narratives and the tokens positioned under each one." },
  { file: "aeon-deep-research",     color: "#fbbf24", trigger: '"DD on X" · "build me a memo" · contrarian take',         desc: "Full due-diligence memo on a token or project, with a contrarian angle." },
  { file: "aeon-distribute-tokens", color: "#f87171", trigger: "Weekly $BLUEAGENT rewards payout to the leaderboard",     desc: "Distributes $BLUEAGENT rewards to top contributors. Needs BANKR_API_KEY with Wallet write scope." },
];

export const PACKAGES = [
  { label: "SURFACE — what users install", color: "#4FC3F7", items: [
    { pkg: "@blueagent/cli",  desc: "TUI + CLI · blueagent (interactive) · blue (direct commands)" },
    { pkg: "@blueagent/x402", desc: "x402 client SDK · auto payment · createX402Client()" },
  ]},
  { label: "CORE — runtime & data", color: "#A78BFA", items: [
    { pkg: "@blueagent/core",       desc: "Runtime · skill loading · Venice LLM gateway · schemas" },
    { pkg: "@blueagent/reputation", desc: "Builder Score · Agent Score · Work Hub reputation" },
  ]},
  { label: "INTEGRATIONS", color: "#34D399", items: [
    { pkg: "@blueagent/skill",    desc: "MCP server · Claude Code · Cursor · Claude Desktop" },
    { pkg: "@blueagent/agentkit", desc: "Coinbase AgentKit plugin · 32 x402 actions" },
    { pkg: "@blueagent/sdk",      desc: "Unified SDK · ba.builder.idea() etc." },
  ]},
];

// 56 MCP tools — snapshot mirrored from apps/web/src/app/api/mcp/route.ts (TOOLS).
export const MCP_TOOLS: { name: string; desc: string }[] = [
  { name: "blue_idea", desc: "Turn a rough concept into a fundable brief — problem, why now, why Base, MVP scope, risks, 24h plan." },
  { name: "blue_build", desc: "Architecture, stack, folder structure, integrations, and test plan for a Base project." },
  { name: "blue_audit", desc: "Security review — 500+ checks, 13 categories. Critical issues, suggested fixes, go/no-go." },
  { name: "blue_ship", desc: "Deployment checklist, verification steps, release notes, and monitoring plan." },
  { name: "blue_raise", desc: "Pitch narrative — market framing, why this wins, traction, ask, target investors." },
  { name: "hub_builder_score", desc: "Builder Score (0-100) — anchored in REAL GitHub repo activity and/or on-chain wallet activity when supplied; the X/CT community part is a labelled estimate." },
  { name: "hub_agent_score", desc: "Agent Score (0-100) — anchored in REAL GitHub repo activity and/or on-chain wallet activity when supplied; XP/community is a labelled estimate." },
  { name: "hub_market_fit", desc: "Market fit analysis — problem clarity, timing, competition, demand signals for a Base project." },
  { name: "hub_token_pick", desc: "AI token pick — falsifiable thesis, entry, sizing, kill criterion. Returns NO_PICK when nothing clears the bar." },
  { name: "hub_narrative", desc: "Narrative map — mindshare scores, velocity, phase (Emerging/Rising/Peak/Fading), position calls." },
  { name: "hub_ecosystem", desc: "Daily Base ecosystem digest — top launches, protocol updates, builder activity." },
  { name: "hub_competitor_scan", desc: "Competitor analysis — named competitors are grounded in REAL DefiLlama Base TVL/change when they match a protocol; reasons about defensible edge on top." },
  { name: "hub_investor_memo", desc: "Full investor memo — thesis, market, moat, risks, ask. Ready to send." },
  { name: "hub_repo_health", desc: "GitHub repo health — commit velocity, test coverage, dependency risk, bus factor." },
  { name: "hub_base_grant", desc: "Find active grants and funding opportunities for your Base project." },
  { name: "hub_risk_gate", desc: "Screen any transaction before execution — rug check, AML, malicious contract patterns." },
  { name: "hub_honeypot", desc: "Detect honeypot tokens that cannot be sold after purchase." },
  { name: "hub_deep_analysis", desc: "Comprehensive token fundamentals — on-chain activity, holder distribution, risk signals." },
  { name: "hub_whale_signal", desc: "Whale wallet copy-trade signals — track large moves for a token on Base." },
  { name: "hub_fundraise_timing", desc: "Is now the right time to raise? Market conditions, stage readiness, investor appetite." },
  { name: "hub_contract_trust", desc: "Trust score for any smart contract — code quality, upgrade risk, ownership, audit history." },
  { name: "hub_aml_screen", desc: "AML screening for a wallet address — sanctions, mixer exposure, illicit flow patterns." },
  { name: "hub_key_exposure", desc: "Check if a wallet's public key is exposed on-chain (quantum vulnerability risk)." },
  { name: "hub_token_momentum", desc: "Token momentum scanner — price velocity, volume spikes, social acceleration for Base tokens." },
  { name: "hub_whale_tracker", desc: "Whale/large-transfer tracker for a Base token or wallet — real Basescan transfer data. Pass a 0x address." },
  { name: "hub_community_sentiment", desc: "Community sentiment for a token or project — CT mindshare, Farcaster buzz, Telegram signals." },
  { name: "hub_launch_simulator", desc: "Simulate a token or product launch — model price action, liquidity, community growth scenarios." },
  { name: "hub_token_launch", desc: "Token launch readiness — market TIMING grounded in REAL Base data (live chain TVL + trending pools); if a token address is given its live DexScreener market grounds momentum. Returns GO/WAIT + action items." },
  { name: "hub_builder_dd", desc: "Deep due diligence on a builder — onchain history, shipped projects, GitHub activity, reputation signals." },
  { name: "hub_brand_score", desc: "Brand score for a Base project — visibility/narrative/community (AI estimate, no live social feed); credibility is anchored in REAL GitHub activity when a repo is supplied." },
  { name: "hub_roadmap", desc: "Validate a product roadmap — feasibility, sequencing, market timing, missing milestones." },
  { name: "hub_gtm", desc: "Go-to-market brief — distribution channels, launch sequence, community strategy for a Base project." },
  { name: "hub_pitch_intel", desc: "Pitch intelligence — analyze and strengthen a pitch deck or fundraising narrative with investor-lens feedback." },
  { name: "hub_wallet_pnl", desc: "Full PnL report for a wallet — realized/unrealized gains, win rate, best/worst trades on Base." },
  { name: "hub_wallet_strategy", desc: "Decode a Base wallet's trading strategy from REAL on-chain activity (live ETH balance, tx count, ERC-20 transfer patterns, current priced holdings)." },
  { name: "hub_portfolio", desc: "Portfolio rebalancer — grounds in a wallet's REAL current holdings (live balances + USD prices) when an address is given; recommends target allocation by risk + goal." },
  { name: "hub_defi_opportunity", desc: "Best DeFi yield opportunities on Base — APY rankings, risk-adjusted returns, protocol safety." },
  { name: "hub_protocol_risk", desc: "Real-time risk monitor for a Base DeFi protocol — TVL changes, exploit signals, governance risks." },
  { name: "hub_multi_agent", desc: "Orchestrate a multi-agent workflow — route tasks across Blue Agent + Aeon + MiroShark for complex analysis." },
  { name: "hub_agent_match", desc: "Find the best collaborator agent for a task — match your project with Base agents by capability." },
  { name: "hub_agent_perf", desc: "Performance report for an AI agent — grounded in REAL GitHub activity (stars/commits/recency) when a repo is supplied; otherwise a labelled estimate." },
  { name: "hub_agent_revenue", desc: "Revenue optimizer for an AI agent — pricing strategy, tool monetization, x402 fee recommendations." },
  { name: "hub_agent_token", desc: "Token strategy for an AI agent — should you launch, how to structure it, timing on Base." },
  { name: "hub_community_growth", desc: "Community growth playbook — channels, content strategy, retention loops, milestones for a Base project." },
  { name: "hub_thread_intel", desc: "Thread intelligence — analyze a CT thread or topic for signal vs noise, key takes, actionable insights." },
  { name: "hub_narrative_pulse", desc: "Real-time narrative pulse — what's being talked about right now on Base CT, velocity and sentiment." },
  { name: "blue_score", desc: "Builder Score for a GitHub/Farcaster handle or wallet address on Base (0-100)." },
  { name: "blue_new", desc: "Scaffold a new Base project. Templates: base-agent | base-x402 | base-token." },
  { name: "blue_monitor", desc: "On-demand health + risk snapshot for a Base token/contract — live price, liquidity, Basescan verification, risk signals + a watch plan with alert thresholds." },
  { name: "blue_registry", desc: "Discover the Blue Hub tool catalog — every callable x402 tool (first-party + community), filterable by query/category, with prices and how-to-call." },
  { name: "blue_research", desc: "Deep DD memo on a Base project, narrative, or token — thesis, bull/bear, risks, contrarian take, verdict. Grounds in live DexScreener data when a token address is given." },
  { name: "blue_compose", desc: "Turn a goal into a runnable chain of Blue Hub tools — picks from the real catalog, orders the steps, suggests inputs, and estimates cost." },
  { name: "blue_deploy", desc: "Technical deploy mechanics for Base mainnet — deploy scripts, Basescan verify commands, env vars, gas notes, post-deploy checks. Never invents addresses." },
  { name: "blue_analytics", desc: "Performance/metrics read on a Base token — live price, momentum, liquidity health, volume/liquidity ratio, growth signals. Real DexScreener data." },
  { name: "blue_simulate", desc: "Bull/base/bear scenario modeling for a Base decision — tokenomics, fee model, growth, runway — with assumptions, projections, and sensitivities." },
  { name: "blue_stream", desc: "Live snapshot feed of Base onchain activity — trending & new pools, TVL, real price/volume/liquidity. Pure real data; poll for a near-real-time feed." },
  { name: "b20_check_activation", desc: "Check whether B20 ASSET / STABLECOIN are activated on Base mainnet or Sepolia — read live from the on-chain ActivationRegistry (isActivated). No wallet, no payment." },
  { name: "b20_read_token", desc: "Inspect a B20 token live via multicall — isB20, name/symbol/decimals, supply, cap, variant, per-feature pause, per-scope policy gating. Deterministic on-chain read (zero LLM). No wallet, no payment." },
  { name: "b20_encode_deploy", desc: "Encode a B20 token deployment (createB20). Returns { to, data, value } for your own wallet to sign via EIP-5792 send_calls / Base MCP. Non-custodial — no keys, no payment." },
  { name: "b20_encode_mint", desc: "Encode a mint on an existing B20 token (mint or mintWithMemo). Returns { to, data, value } for a MINT_ROLE holder to sign. Non-custodial calldata builder." },
  { name: "b20_encode_burn", desc: "Encode burnWithMemo — burn B20 tokens from the caller's balance with an on-chain memo. Returns { to, data, value } for a BURN_ROLE holder to sign." },
  { name: "b20_encode_grant_mint_role", desc: "Encode grantRole(MINT_ROLE, account) on a B20 token. Returns { to, data, value } for the DEFAULT_ADMIN_ROLE holder to sign." },
  { name: "b20_encode_payment", desc: "Encode transferWithMemo — send B20 tokens with an on-chain memo (order id) for reconciliation. Returns { to, data, value } for the sender to sign." },
];
