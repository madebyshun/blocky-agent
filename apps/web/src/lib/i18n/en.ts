// English dictionary — the SOURCE OF TRUTH for the i18n key shape.
// `zh.ts` must mirror this exact structure (typed against `Dict`).
// Keys are grouped by surface: marketing (home / nav_marketing) and app
// (nav / chat / scanner / registry / activity / manage / launch / bank /
//  launches / feed / balance_card / common).

export const en = {
  // ─── Marketing (blueagent.dev) ──────────────────────────────────────────────
  home: {
    badge: "Built on Base · x402 native",
    hero_title: "The onchain Agent OS",
    hero_subtitle:
      "Chat with an agent that reads the chain — live Base data, {{TOOLS}} real tools, and onchain actions right in the conversation. Idea → build → audit → ship → raise.",
    cta_open_chat: "Open Blue Chat →",
    cta_browse_hub: "Browse Hub",
    cta_token: "$BLUEAGENT ↗",

    // 0 · Models strip
    s_models_kicker: "Models",
    s_models_title: "One chat. Every frontier model.",
    s_models_sub:
      "Switch models mid-conversation — frontier and open, fast and private. No new key, no new tab.",

    // 1 · One stack (product suite)
    s_stack_kicker: "The stack",
    s_stack_title: "One agent runtime on Base. Every surface shares it.",
    s_stack_sub:
      "Chat, tools, MCP, connectors — one brain, one wallet, one set of live Base data. Reach for whichever surface fits.",
    stack_chat_label: "Blue Chat",
    stack_chat_desc: "Talk to it — no wallet to start. Multi-model: Kimi K2, DeepSeek, Claude, Grok.",
    stack_hub_label: "Blue Hub",
    stack_hub_desc: "{{TOOLS}} x402 tools any agent can call. Pay-per-call in USDC on Base.",
    stack_mcp_label: "Blue MCP",
    stack_mcp_desc: "Run the whole toolset inside Claude Code, Cursor & Claude Desktop.",
    stack_conn_label: "Blue Connector",
    stack_conn_desc: "Attach any external MCP server and use its tools right in chat.",
    stack_hood_label: "Blue Hood",
    stack_hood_desc: "24/7 non-custodial copilot for Robinhood Chain — Chainlink vs DEX drift, arrow signals, review-and-sign trading.",
    // stack_bank_* removed 2026-07-24 (Blue Bank archived; middleware
    // redirects /bank + /pay → /chat). Keys retained as comments so a
    // grep of `stack_bank_label` still finds this note.
    stack_image_label: "Blue Image",
    stack_image_desc: "Generate images from chat — onchain-native, pay-per-render.",
    stack_video_label: "Blue Video",
    stack_video_desc: "Text-to-video right in the conversation, settled on Base.",
    stack_soon: "Soon",

    // 2 · Manifesto
    s_why_kicker: "Why Blue Chat",
    s_why_title: "Most chatbots guess about crypto. Blue Chat reads it.",
    s_why_sub:
      "Generic AI hallucinates token data, can't see a wallet, and can't act. Blue Chat is wired to live Base data and {{TOOLS}} real tools — every number comes from a source, not a guess.",

    // 3 · How you use Blue (modality tabs)
    s_chat_kicker: "How to use",
    s_chat_title: "One chat. Every job.",
    s_chat_sub:
      "Chat, connect, and code — switch modality without ever leaving Blue. Image and video are coming.",
    use_chat_label: "Chat",
    use_chat_desc: "Ask anything, run /commands, read live Base data — no wallet to start.",
    use_code_label: "Code",
    use_code_desc: "/build and /audit with Kimi K2 — architecture, security review, ship checklist.",
    use_connect_label: "Connect",
    use_connect_desc: "Attach any MCP server — GitHub, Notion, Base Docs — its tools appear inline.",
    use_image_label: "Image",
    use_image_desc: "Generate images right in the chat. Coming soon.",
    use_video_label: "Video",
    use_video_desc: "Text-to-video in the conversation. Coming soon.",

    // 4 · Hub
    s_hub_kicker: "Hub",
    s_hub_title: "{{TOOLS}} tools. Called inside the chat.",
    s_hub_sub:
      "The intelligence layer for Base agents. Raw data, security checks, alpha signals — all x402 native. No API key. No subscription.",
    hub_browse_all: "Browse all {{TOOLS}} →",
    hub_browse_sub: "9 categories · live data",
    hub_pricing_line: "From $0.01/call · USDC on Base",

    // 5 · Two ways in
    s_ways_kicker: "Access",
    s_ways_title: "One agent. Two ways in.",
    s_ways_sub:
      "Chat it like a human, or call it from your own agent over x402 / MCP — same brain, same Base data.",
    ways_chat_label: "For people",
    ways_chat_desc: "Open Blue Chat in the browser. No install, no wallet to start.",
    ways_api_label: "For agents",
    ways_api_desc: "Call any tool over x402 / MCP. Pay per call in USDC on Base — no signup.",

    // 6 · Pricing — two rails (chat credits + x402 tools)
    s_pricing_kicker: "Pricing",
    s_pricing_title: "Two rails. No subscription.",
    s_pricing_sub:
      "Blue Chat runs on free daily credits. Hub tools are pay-per-call in USDC on Base. Reach for whichever fits.",
    pricing_chat_label: "Blue Chat",
    pricing_chat_price: "Free to start",
    pricing_chat_desc: "Free daily credits, no wallet needed. Connect any wallet for more, or top up with USDC.",
    pricing_hub_label: "Hub tools",
    pricing_hub_price: "$0.01–$1.00",
    pricing_hub_desc: "Pay-per-call in USDC on Base. No subscription, no API key.",
    pricing_mcp_label: "MCP server",
    pricing_mcp_price: "Free",
    pricing_mcp_desc: "The full toolset in Claude Code, Cursor & Claude Desktop. No key.",
    pricing_footnote: "x402: $0.01–$1.00 per call · USDC on Base · no signup",

    final_title: "Start building on Base today",
    final_open_chat: "Open Blue Chat →",
    final_browse_hub: "Browse {{TOOLS}} Hub Tools →",
    final_install_mcp: "Install MCP →",
    final_read_docs: "Read Docs →",

    footer_tagline: "The onchain agent",
    footer_powered: "Powered by Venice AI · x402 native · Base",
  },
  nav_marketing: {
    about: "About",
    // `soul` (was `skills`, 2026-08) — the SOUL.md identity page at /soul.
    // "Skills" now means the app's installed-skill catalog, so the marketing
    // nav no longer uses that word.
    soul: "Soul",
    docs: "Docs",
    github: "GitHub",
    launch_app: "Launch App →",
  },

  // ─── App (app.blueagent.dev) ────────────────────────────────────────────────
  nav: {
    chat: "Chat",
    hub: "Hub",
    feed: "Feed",
    bank: "Bank",
    launches: "Launches",
    hood: "Hood",
    b20: "B20",
    dashboard: "Overview",
    profile: "Profile",
    docs: "Docs",
    home: "Home",
    // AgentOS Control pages (promoted from Blue Chat tabs).
    skills: "Skills",
    connectors: "Connectors",
    cron: "Scheduled",
    usage: "Usage",
    plans: "Plans",
    // Sidebar group headers.
    group_workspace: "Workspace",
    group_control: "Control",
    group_account: "Account",
  },
  chat: {
    placeholder: "Message BlueAgent...",
    thinking: "Thinking...",
    connect_wallet: "Connect your wallet",
    empty_state: "What would you like to do?",
    suggested_1: "Check my balance",
    suggested_2: "Inspect a B20 token",
    suggested_3: "Launch a token",
    suggested_4: "Mint with memo",
  },
  scanner: {
    title: "B20 Scanner",
    placeholder: "Token address 0x...",
    inspect_btn: "Inspect",
    trust_verdict: "Trust Verdict",
    always_allow: "Always Allow",
    always_block: "Always Block ⛔",
    custom_policy: "Custom Policy",
    variant_asset: "Asset",
    variant_stablecoin: "Stablecoin",
    supply_cap: "Supply Cap",
    uncapped: "Uncapped",
    paused: "Paused",
    active: "Active",
    no_rebase: "No rebase",
    rebase_active: "Rebase active",
    manage_cta: "Manage this token →",
    you_hold_admin: "You hold admin",
    not_admin: "Not admin",
    unknown_admin: "Unknown — connect wallet",
  },
  registry: {
    title: "Registry",
    total_tokens: "tokens deployed",
    asset: "Asset",
    stablecoin: "Stablecoin",
    search_placeholder: "Search by name or symbol...",
    empty: "No tokens found",
    loading: "Loading registry...",
  },
  activity: {
    title: "Recent Activity",
    control_events: "control events",
    refresh: "Refresh",
    empty: "No activity yet",
    unavailable: "Activity unavailable",
    paused: "paused",
    policy_applied: "applied a transfer policy",
    policy_removed: "removed the transfer policy",
    cap_updated: "updated supply cap",
    cap_set: "set a supply cap",
    role_revoked: "revoked a role",
    role_granted: "granted a role",
    freeze_seize: "froze and seized tokens",
  },
  manage: {
    title: "Manage",
    common_actions: "Common actions",
    mint: "Mint",
    burn: "Burn",
    transfer: "Transfer",
    check_memo: "Check Memo",
    pause: "Pause",
    unpause: "Unpause",
    policy: "Policy",
    roles: "Roles",
    supply_cap: "Supply Cap",
    metadata: "Metadata",
    recipient: "Recipient",
    amount: "Amount",
    memo_placeholder: "INV-2026-001 (optional)",
    memo_helper: "Attached onchain — order IDs, payment refs, audit trail",
    mint_btn: "Mint →",
    burn_btn: "Burn →",
    transfer_btn: "Transfer →",
    claim_memo_btn: "Check Memo →",
    success: "Success!",
    view_tx: "View tx ↗",
    copy_hash: "Copy hash",
    check_memo_result: "Memo",
    no_memo: "No memo found",
  },
  launch: {
    title: "Launch",
    deploy_b20: "Deploy B20",
    asset_variant: "Asset",
    stablecoin_variant: "Stablecoin",
    token_name: "Token Name",
    token_symbol: "Symbol",
    decimals: "Decimals",
    deploy_btn: "Deploy →",
    not_active: "B20 isn't active on Mainnet yet",
    use_sepolia: "Use Base Sepolia",
    your_tokens: "Your Deployed Tokens",
    copy_address: "Copy address",
  },
  bank: {
    title: "Blue Bank",
    send: "Send",
    receive: "Receive",
    yield: "Yield",
    supply: "Supply",
    withdraw: "Withdraw",
    balance: "Balance",
    apy: "APY",
    memo_field: "Memo",
  },
  launches: {
    title: "Launches",
    all: "All",
    live: "Live",
    new: "New",
    hot: "Hot 🔥",
    my_tokens: "My Tokens 👤",
    trade: "Trade",
    claim_fees: "Claim Fees",
    no_tokens: "No tokens launched yet",
    unclaimed: "Unclaimed",
    search: "Search tokens...",
  },
  feed: {
    title: "Blue Feed",
    loading: "Loading feed...",
    empty: "No feed items yet",
  },
  balance_card: {
    title: "Wallet Balance",
    connect_first: "Connect your wallet first",
    view_explorer: "View on explorer ↗",
  },
  common: {
    connect_wallet: "Connect Wallet",
    disconnect: "Disconnect",
    loading: "Loading...",
    error: "Something went wrong",
    retry: "Retry",
    copy: "Copy",
    copied: "Copied! ✓",
    close: "Close",
    cancel: "Cancel",
    confirm: "Confirm",
    sign_wallet: "Sign in wallet",
    network_mainnet: "Base Mainnet",
    network_sepolia: "Base Sepolia",
    view_basescan: "View on Basescan ↗",
    coming_soon: "Coming soon",
    or: "or",
  },
} as const;

// Recursively widen the `as const` literal value types (e.g. "Live") back to
// `string`, while keeping the exact key structure intact. This lets `zh.ts`
// supply different (Chinese) strings yet still fail the build if any key is
// missing or extra.
type Widen<T> = {
  [K in keyof T]: T[K] extends string ? string : Widen<T[K]>;
};

// The dictionary shape every locale must satisfy.
export type Dict = Widen<typeof en>;
