// Agent Skills — the raw capabilities Blue Agent has access to.
// Skills = prompt-grounded abilities backed by the Virtuals LLM + Blue's own
// x402 hub tools. These are NOT hub tools themselves (those are productized
// Tools with pricing) — a skill is a curated trigger plus whatever backend runs it.

export type SkillProvider = "Blue Agent" | "Base MCP" | "Bundled";
export type SkillStatus   = "active" | "available" | "soon";

/** Who actually operates the backend a skill runs on.
 *
 *  Only set this where the attribution is TRUE — i.e. we really do call that
 *  party's service. Putting "by X" on a skill whose backend is never contacted
 *  is the same class of error as printing a number we never measured, and it
 *  puts someone else's name on our guess. Skills with no wired backend leave
 *  this unset and the UI shows no author line. */
export interface SkillAuthor {
  name:   string;   // display, e.g. "Blue Agent"
  brand?: string;   // key into BRANDS (components/BrandMark.tsx)
  href?:  string;   // where that backend actually lives
}

export const BLUE_AUTHOR: SkillAuthor = {
  name:  "Blue Agent",
  brand: "blue-agent",
  href:  "https://blueagent.dev/hub",
};

export interface AgentSkill {
  id:          string;
  name:        string;
  description: string;
  provider:    SkillProvider;
  status:      SkillStatus;
  trigger?:    string;    // example prompt to invoke
  badge?:      string;    // e.g. "free", "x402", "Base MCP"
  tools?:      string[];  // Hub tool IDs bundled by this skill
  author?:     SkillAuthor;
  /** Ids whose `usage:<id>` KV counters sum to this skill's run count.
   *  Unset = no instrumented backend, so the run count is UNKNOWN and the UI
   *  renders nothing — not a zero, which would read as "nobody uses this" when
   *  the truth is "we don't measure this". */
  meterIds?:   string[];
}

export const AGENT_SKILLS: AgentSkill[] = [
  // ── Blue Agent Core ─────────────────────────────────────────────────────────
  {
    id:          "blue-idea",
    name:        "Idea → Brief",
    description: "Turn a rough concept into a fundable brief — problem, why Base, MVP, risks, 24h plan",
    provider:    "Blue Agent",
    status:      "active",
    trigger:     "blue idea ",
    badge:       "free",
    author:      BLUE_AUTHOR,
    meterIds:    ["blue_idea"],
  },
  {
    id:          "blue-build",
    name:        "Build → Architecture",
    description: "Architecture, stack, folder structure, integrations, and test plan for Base projects",
    provider:    "Blue Agent",
    status:      "active",
    trigger:     "blue build ",
    badge:       "free",
    author:      BLUE_AUTHOR,
    meterIds:    ["blue_build"],
  },
  {
    id:          "blue-audit",
    name:        "Audit → Security",
    description: "500+ security checks · reentrancy, oracle, MEV, x402, Coinbase Smart Wallet",
    provider:    "Blue Agent",
    status:      "active",
    trigger:     "blue audit ",
    badge:       "free",
    author:      BLUE_AUTHOR,
    meterIds:    ["blue_audit"],
  },
  {
    id:          "blue-ship",
    name:        "Ship → Deploy",
    description: "Deployment checklist, verification steps, release notes, monitoring plan",
    provider:    "Blue Agent",
    status:      "active",
    trigger:     "blue ship ",
    badge:       "free",
    author:      BLUE_AUTHOR,
    meterIds:    ["blue_ship"],
  },
  {
    id:          "blue-raise",
    name:        "Raise → Pitch",
    description: "Fundraising narrative, investor deck, smart money map, competitive landscape",
    provider:    "Blue Agent",
    status:      "active",
    trigger:     "blue raise ",
    badge:       "free",
    author:      BLUE_AUTHOR,
    meterIds:    ["blue_raise"],
  },

  // ── Base MCP ─────────────────────────────────────────────────────────────────
  // NOT WIRED. These are held at "soon" on purpose. Enabling the Base MCP
  // integration only appends a prompt section (api/chat/route.ts) describing
  // get_wallets/send/swap/sign/... — no tool schema is ever registered, so the
  // model is told it has tools it does not have and will invent results rather
  // than call anything. Listing them as "active" sold a capability that does not
  // exist; they flip back to active only once mcp.base.org is attached for real
  // (the connector plumbing in /api/mcp-client + /api/chat already supports it).
  // For the same reason none of them carry an `author` — we do not contact Base,
  // so we do not put Base's name on them.
  {
    id:          "base-gas-oracle",
    name:        "Gas Oracle",
    description: "Current Base L2 gas prices and fee estimation for transactions",
    provider:    "Base MCP",
    status:      "soon",
    trigger:     "What are current Base gas prices?",
    badge:       "Base MCP",
  },
  {
    id:          "base-block-info",
    name:        "Block Info",
    description: "Latest Base block height, timestamp, and network health",
    provider:    "Base MCP",
    status:      "soon",
    trigger:     "Show latest Base block information",
    badge:       "Base MCP",
  },
  {
    id:          "base-read-contract",
    name:        "Read Contract",
    description: "Read public state from any verified contract on Base",
    provider:    "Base MCP",
    status:      "soon",
    trigger:     "Read the state of Base contract ",
    badge:       "Base MCP",
  },
  {
    id:          "base-basename",
    name:        "Basename Lookup",
    description: "Resolve a .base.eth or Basename to an address",
    provider:    "Base MCP",
    status:      "soon",
    trigger:     "Resolve this basename: ",
    badge:       "Base MCP",
  },
  {
    id:          "base-bridge",
    name:        "Base Bridge",
    description: "L1→L2 bridge status, estimate time and cost",
    provider:    "Base MCP",
    status:      "soon",
    trigger:     "What's the current Base bridge status?",
    badge:       "Base MCP",
  },
  {
    id:          "base-smart-wallet",
    name:        "Smart Wallet",
    description: "Set up or analyze a Coinbase Smart Wallet on Base",
    provider:    "Base MCP",
    status:      "soon",
    trigger:     "Help me set up a Coinbase Smart Wallet",
    badge:       "Base MCP",
  },
  {
    id:          "base-paymaster",
    name:        "Paymaster Check",
    description: "Check if a contract qualifies for Base gas sponsorship",
    provider:    "Base MCP",
    status:      "soon",
    trigger:     "Is this contract eligible for Base Paymaster? ",
    badge:       "Base MCP",
  },
  {
    id:          "base-deploy",
    name:        "Deploy to Base",
    description: "Step-by-step deployment guide with Hardhat or Foundry",
    provider:    "Base MCP",
    status:      "soon",
    trigger:     "Help me deploy a contract to Base",
    badge:       "Base MCP",
  },
  // ── Bundled Skills — curated tool groups that run together ──────────────────
  {
    id:          "bundle-token-safety",
    name:        "Token Safety",
    description: "Full safety sweep — risk score, honeypot, contract trust, key exposure — run all four together",
    provider:    "Bundled",
    status:      "active",
    trigger:     "Check if this token/contract is safe: ",
    badge:       "Bundle · 4 tools",
    tools:       ["hub_risk_gate", "hub_honeypot", "hub_contract_trust", "hub_key_exposure"],
    author:      BLUE_AUTHOR,
    meterIds:    ["hub_risk_gate", "hub_honeypot", "hub_contract_trust", "hub_key_exposure"],
  },
  {
    id:          "bundle-base-builder",
    name:        "Base Builder",
    description: "Builder intelligence — repo health, builder score, grant eligibility, deep due diligence",
    provider:    "Bundled",
    status:      "active",
    trigger:     "Evaluate this Base builder/project: ",
    badge:       "Bundle · 4 tools",
    tools:       ["hub_repo_health", "hub_builder_score", "hub_base_grant", "hub_builder_dd"],
    author:      BLUE_AUTHOR,
    meterIds:    ["hub_repo_health", "hub_builder_score", "hub_base_grant", "hub_builder_dd"],
  },
  {
    id:          "bundle-trader-intel",
    name:        "Trader Intel",
    description: "Market edge — token pick, whale signals, narrative pulse, momentum, DEX flow",
    provider:    "Bundled",
    status:      "active",
    trigger:     "Give me full trader intel on: ",
    badge:       "Bundle · 5 tools",
    tools:       ["hub_token_pick", "hub_whale_signal", "hub_narrative_pulse", "hub_token_momentum", "hub_dex_flow"],
    author:      BLUE_AUTHOR,
    meterIds:    ["hub_token_pick", "hub_whale_signal", "hub_narrative_pulse", "hub_token_momentum", "hub_dex_flow"],
  },

  {
    id:          "base-erc4337",
    name:        "Account Abstraction",
    description: "ERC-4337 smart accounts on Base with Coinbase Bundler",
    provider:    "Base MCP",
    status:      "soon",
    trigger:     "/build ERC-4337 account abstraction on Base",
    badge:       "Base MCP",
  },
  {
    id:          "base-token-launch",
    name:        "Token Launch Pipeline",
    description: "Full token launch — contract, Uniswap pool, launch, list",
    provider:    "Base MCP",
    status:      "soon",
    trigger:     "Help me launch a token on Base",
    badge:       "Base MCP",
  },
];

export const SKILL_PROVIDERS: SkillProvider[] = ["Blue Agent", "Base MCP", "Bundled"];

/** The one accent. Reserved for things the user can ACT on — the install
 *  button, focus rings, the "use →" affordance, an enabled toggle.
 *
 *  There is deliberately no provider→colour map any more. Each provider used to
 *  own a hue (blue / green / amber), which meant a screen of ~20 skills carried
 *  three decorative hues plus three more for status — and the hue was pure
 *  redundancy, because every badge prints the provider's NAME right beside it.
 *  Colour that repeats the adjacent label is noise; colour that says something
 *  the label doesn't (danger, a destructive action) stays. */
export const SKILL_ACCENT = "#4FC3F7";

export const PROVIDER_ICONS: Record<SkillProvider, string> = {
  "Blue Agent": "⚡",
  "Base MCP":   "🔵",
  "Bundled":    "📦",
};

/** BrandMark keys for providers that are an actual third-party brand. "Bundled"
 *  has no owner (it's our own grouping), so it keeps the semantic emoji — only
 *  real brands get a real logo. Consumed by the provider cards, which are large
 *  enough for a mark to read; the 8px inline badges keep the emoji. */
export const PROVIDER_BRANDS: Partial<Record<SkillProvider, string>> = {
  "Blue Agent": "blue-agent",
  "Base MCP":   "base",
};
